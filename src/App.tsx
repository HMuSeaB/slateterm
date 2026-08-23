import { useEffect, useMemo, useRef, useState } from "react";
import CommandPalette, { type PaletteCommand } from "./components/CommandPalette";
import FilePreview from "./components/FilePreview";
import HistoryPanel from "./components/HistoryPanel";
import SettingsPanel from "./components/SettingsPanel";
import TabBar from "./components/TabBar";
import TerminalPane from "./components/TerminalPane";
import TitleBar from "./components/TitleBar";
import WorkspacePanel from "./components/WorkspacePanel";
import WorkspaceSwitcher from "./components/WorkspaceSwitcher";
import {
  closeSession,
  createSession,
  listProfiles,
  loadSettings,
  readTextFile,
  saveSettings,
  selectWorkspaceFolder,
} from "./lib/tauri";
import type {
  FilePreview as FilePreviewData,
  Pane,
  Profile,
  ProxySettings,
  Settings,
  StartupLayout,
  Tab,
  WorkspaceState,
} from "./lib/types";

const DEFAULT_STARTUP_LAYOUT: StartupLayout = {
  paneCount: 1,
  splitRatio: 0.5,
};

const DEFAULT_SETTINGS: Settings = {
  theme: "graphite",
  fontFamily: "JetBrainsMono Nerd Font, Cascadia Mono, Consolas, monospace",
  fontSize: 14,
  lineHeight: 1.28,
  cursorStyle: "block",
  defaultProfileId: "pwsh",
  rememberLayout: true,
  startupLayout: DEFAULT_STARTUP_LAYOUT,
  workspaceRoot: null,
  namedWorkspaces: [],
  proxy: { enabled: false, host: "127.0.0.1", port: 7890 },
};

const PANE_SPLITTER_WIDTH = 10;

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeProxy(candidate: ProxySettings | null | undefined): ProxySettings {
  if (!candidate || typeof candidate !== "object") {
    return DEFAULT_SETTINGS.proxy!;
  }
  const port = Number(candidate.port);
  return {
    enabled: candidate.enabled === true,
    host: (candidate.host || "127.0.0.1").trim(),
    port: Number.isFinite(port) && port > 0 && port < 65536 ? Math.floor(port) : 7890,
  };
}

function proxyTargetLabel(proxy: ProxySettings) {
  return `${proxy.host}:${proxy.port}`;
}

function clampFontSize(value: number) {
  return Math.min(28, Math.max(11, value));
}

function clampLineHeight(value: number) {
  return Math.min(2, Math.max(1, value));
}

function normalizeSplitRatio(candidate: number | null | undefined) {
  if (typeof candidate !== "number" || Number.isNaN(candidate)) {
    return DEFAULT_STARTUP_LAYOUT.splitRatio;
  }

  return Math.min(0.78, Math.max(0.22, candidate));
}

function resolveStartupLayout(candidate: StartupLayout | null | undefined): StartupLayout {
  return {
    paneCount: candidate?.paneCount === 2 ? 2 : 1,
    splitRatio: normalizeSplitRatio(candidate?.splitRatio),
  };
}

function normalizeSettings(candidate: Settings): Settings {
  return {
    theme: candidate.theme === "paper" ? "paper" : DEFAULT_SETTINGS.theme,
    fontFamily: candidate.fontFamily || DEFAULT_SETTINGS.fontFamily,
    fontSize: clampFontSize(candidate.fontSize),
    lineHeight: clampLineHeight(candidate.lineHeight),
    cursorStyle:
      candidate.cursorStyle === "underline" || candidate.cursorStyle === "bar"
        ? candidate.cursorStyle
        : DEFAULT_SETTINGS.cursorStyle,
    defaultProfileId: candidate.defaultProfileId || DEFAULT_SETTINGS.defaultProfileId,
    rememberLayout: candidate.rememberLayout !== false,
    startupLayout: resolveStartupLayout(candidate.startupLayout),
    lastCwd: candidate.lastCwd || null,
    workspaceRoot: candidate.workspaceRoot || null,
    savedState: candidate.savedState || null,
    namedWorkspaces: Array.isArray(candidate.namedWorkspaces) ? candidate.namedWorkspaces : [],
    proxy: normalizeProxy(candidate.proxy),
  };
}

function resolveProfileId(candidate: string | null | undefined, sourceProfiles: Profile[]) {
  return sourceProfiles.find((profile) => profile.id === candidate)?.id ?? sourceProfiles[0]?.id ?? "pwsh";
}

function resolveStartupProfileId(candidate: string | null | undefined, sourceProfiles: Profile[]) {
  const shellProfiles = sourceProfiles.filter((profile) => profile.category === "shell");
  return shellProfiles.find((profile) => profile.id === candidate)?.id ?? shellProfiles[0]?.id ?? resolveProfileId(candidate, sourceProfiles);
}

function profileLabel(profileId: string, sourceProfiles: Profile[]) {
  return sourceProfiles.find((profile) => profile.id === profileId)?.name ?? profileId;
}

function layoutPreferenceFromTab(tab: Tab | null): StartupLayout {
  if (!tab || tab.panes.length !== 2) {
    return { ...DEFAULT_STARTUP_LAYOUT };
  }

  return {
    paneCount: 2,
    splitRatio: normalizeSplitRatio(tab.panes[0]?.sizeRatio),
  };
}

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("pwsh");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedExplorerPath, setSelectedExplorerPath] = useState<string | null>(null);
  const [terminalCwd, setTerminalCwd] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreviewData | null>(null);
  const [filePreviewError, setFilePreviewError] = useState<string | null>(null);
  const [queuedCommand, setQueuedCommand] = useState<{ id: string; value: string; sessionId: string } | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [activeNamedWorkspaceId, setActiveNamedWorkspaceId] = useState<string | null>(null);
  const [switcherAnchor, setSwitcherAnchor] = useState<{ x: number; y: number } | null>(null);
  const paneDeckRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ tabId: string } | null>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activePane = activeTab?.panes.find((pane) => pane.id === activeTab.activePaneId) ?? activeTab?.panes[0] ?? null;
  const claudeProfile = profiles.find((profile) => profile.id === "claude") ?? null;

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [loadedProfiles, loadedSettings] = await Promise.all([
          listProfiles(),
          loadSettings().catch(() => DEFAULT_SETTINGS),
        ]);

        if (cancelled) {
          return;
        }

        const normalizedSettings = normalizeSettings(loadedSettings);
        const startupProfileId = resolveStartupProfileId(normalizedSettings.defaultProfileId, loadedProfiles);
        const resolvedSettings =
          startupProfileId === normalizedSettings.defaultProfileId
            ? normalizedSettings
            : {
                ...normalizedSettings,
                defaultProfileId: startupProfileId,
              };

        setProfiles(loadedProfiles);
        setSettings(resolvedSettings);
        setSelectedProfileId(startupProfileId);
        const restored = await restoreWorkspaceState(loadedProfiles, resolvedSettings);
        if (!restored) {
          await openStartupTab(startupProfileId, loadedProfiles, resolvedSettings);
        }
        setBooting(false);
      } catch (error) {
        console.error("SlateTerm bootstrap failed", error);
        if (cancelled) {
          return;
        }
        setBootError(error instanceof Error ? error.message : String(error));
        setBooting(false);
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (booting) {
      return;
    }

    const savedState: Settings["savedState"] =
      settings.rememberLayout && tabs.length > 0
        ? {
            activeTabIndex: Math.max(0, tabs.findIndex((t) => t.id === activeTabId)),
            tabs: tabs.map((t) => ({
              profileId: t.profileId,
              title: t.title,
              panes: t.panes.map((p) => ({
                profileId: p.profileId,
                cwd: p.cwd || null,
                sizeRatio: p.sizeRatio,
                title: p.title,
              })),
              activePaneIndex: Math.max(0, t.panes.findIndex((pane) => pane.id === t.activePaneId)),
            })),
          }
        : null;

    const settingsToPersist: Settings = {
      ...settings,
      startupLayout: layoutPreferenceFromTab(activeTab),
      savedState,
    };

    const timer = window.setTimeout(() => {
      void saveSettings(settingsToPersist).catch((error) => {
        console.error("Failed to save settings", error);
      });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [activeTab, activeTabId, booting, settings, tabs]);

  async function restoreWorkspaceState(sourceProfiles: Profile[], startupSettings: Settings) {
    const state = startupSettings.savedState;
    if (!startupSettings.rememberLayout || !state || !state.tabs || state.tabs.length === 0) {
      return false;
    }
    return restoreWorkspaceSnapshot(state, sourceProfiles, startupSettings);
  }

  async function restoreWorkspaceSnapshot(state: WorkspaceState, sourceProfiles = profiles, sourceSettings = settings) {
    const createdSessionIds: string[] = [];
    try {
      const restoredTabs: Tab[] = [];
      for (const savedTab of state.tabs) {
        const resolvedProfileId = resolveProfileId(savedTab.profileId, sourceProfiles);
        const tabTitle = savedTab.title || profileLabel(resolvedProfileId, sourceProfiles);

        const restoredPanes: Pane[] = [];
        for (const savedPane of savedTab.panes) {
          const paneProfileId = resolveProfileId(savedPane.profileId || resolvedProfileId, sourceProfiles);
          const paneCwd = savedPane.cwd || sourceSettings.lastCwd || null;
          const session = await createSession(paneProfileId, 120, 32, paneCwd, normalizeProxy(sourceSettings.proxy));
          createdSessionIds.push(session.sessionId);
          restoredPanes.push({
            id: makeId("pane"),
            sessionId: session.sessionId,
            profileId: paneProfileId,
            sizeRatio: savedPane.sizeRatio ?? 1,
            title: savedPane.title || profileLabel(paneProfileId, sourceProfiles),
            cwd: session.cwd || paneCwd || undefined,
            runtimeMode:
              sourceProfiles.find((profile) => profile.id === paneProfileId)?.category === "ai"
                ? "claude"
                : "shell",
            sessionState: "running",
          });
        }

        if (restoredPanes.length > 0) {
          restoredTabs.push({
            id: makeId("tab"),
            profileId: resolvedProfileId,
            title: tabTitle,
            panes: restoredPanes,
            activePaneId:
              restoredPanes[Math.min(
                Math.max(0, savedTab.activePaneIndex ?? 0),
                restoredPanes.length - 1,
              )].id,
          });
        }
      }

      if (restoredTabs.length > 0) {
        const activeIdx = Math.min(Math.max(0, state.activeTabIndex || 0), restoredTabs.length - 1);
        setTabs(restoredTabs);
        setActiveTabId(restoredTabs[activeIdx].id);
        setSelectedProfileId(restoredTabs[activeIdx].profileId);
        setBootError(null);
        return true;
      }
    } catch (error) {
      await Promise.all(createdSessionIds.map((sessionId) => closeSession(sessionId).catch(() => undefined)));
      console.warn("Failed to restore saved workspace state", error);
    }
    return false;
  }

  function snapshotWorkspace(): WorkspaceState | null {
    if (tabs.length === 0) {
      return null;
    }
    return {
      activeTabIndex: Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId)),
      tabs: tabs.map((tab) => ({
        profileId: tab.profileId,
        title: tab.title,
        panes: tab.panes.map((pane) => ({
          profileId: pane.profileId,
          cwd: pane.cwd || null,
          sizeRatio: pane.sizeRatio,
          title: pane.title,
        })),
        activePaneIndex: Math.max(0, tab.panes.findIndex((pane) => pane.id === tab.activePaneId)),
      })),
    };
  }

  function saveNamedWorkspace() {
    const state = snapshotWorkspace();
    if (!state) {
      return;
    }
    const proposed = window.prompt("Workspace name", activeTab?.title || "My Workspace")?.trim();
    if (!proposed) {
      return;
    }
    const newId = makeId("workspace");
    setSettings((current) => ({
      ...current,
      namedWorkspaces: [
        { id: newId, name: proposed, state, updatedAt: new Date().toISOString() },
        ...(current.namedWorkspaces || []),
      ],
    }));
    setActiveNamedWorkspaceId(newId);
  }

  async function loadNamedWorkspace(workspaceId: string) {
    setSwitcherAnchor(null);
    const workspace = settings.namedWorkspaces?.find((item) => item.id === workspaceId);
    if (!workspace || workspaceId === activeNamedWorkspaceId) {
      return;
    }

    const sourceTabs = tabs;
    const leavingState = snapshotWorkspace();
    const restored = await restoreWorkspaceSnapshot(workspace.state);
    if (!restored) {
      setBootError(`Could not open workspace: ${workspace.name}`);
      return;
    }

    // 离开前把当前布局写回源工作区，下次切回来时原样恢复
    if (activeNamedWorkspaceId && leavingState) {
      setSettings((current) => ({
        ...current,
        namedWorkspaces: (current.namedWorkspaces || []).map((item) =>
          item.id === activeNamedWorkspaceId
            ? { ...item, state: leavingState, updatedAt: new Date().toISOString() }
            : item,
        ),
      }));
    }

    await Promise.all(
      sourceTabs.flatMap((tab) => tab.panes).map((pane) => closeSession(pane.sessionId).catch(() => undefined)),
    );
    setActiveNamedWorkspaceId(workspaceId);
    setWorkspaceOpen(false);
  }

  function cycleNamedWorkspace(direction: 1 | -1) {
    const workspaces = settings.namedWorkspaces || [];
    if (workspaces.length === 0) {
      return;
    }
    const currentIndex = workspaces.findIndex((item) => item.id === activeNamedWorkspaceId);
    const nextIndex = currentIndex < 0
      ? (direction === 1 ? 0 : workspaces.length - 1)
      : (currentIndex + direction + workspaces.length) % workspaces.length;
    if (nextIndex === currentIndex) {
      return;
    }
    void loadNamedWorkspace(workspaces[nextIndex].id);
  }

  function toggleProxy() {
    setSettings((current) => {
      const proxy = normalizeProxy(current.proxy);
      return { ...current, proxy: { ...proxy, enabled: !proxy.enabled } };
    });
  }

  function deleteNamedWorkspace(workspaceId: string) {
    setSettings((current) => ({
      ...current,
      namedWorkspaces: (current.namedWorkspaces || []).filter((item) => item.id !== workspaceId),
    }));
    if (workspaceId === activeNamedWorkspaceId) {
      setActiveNamedWorkspaceId(null);
    }
  }

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || !paneDeckRef.current) {
        return;
      }

      const rect = paneDeckRef.current.getBoundingClientRect();
      const rawRatio = (event.clientX - rect.left - PANE_SPLITTER_WIDTH / 2) / (rect.width - PANE_SPLITTER_WIDTH);
      const clampedRatio = normalizeSplitRatio(rawRatio);

      setTabs((current) =>
        current.map((tab) => {
          if (tab.id !== dragState.tabId || tab.panes.length !== 2) {
            return tab;
          }
          return {
            ...tab,
            panes: [
              { ...tab.panes[0], sizeRatio: clampedRatio },
              { ...tab.panes[1], sizeRatio: 1 - clampedRatio },
            ],
          };
        }),
      );
    };

    const onMouseUp = () => {
      dragStateRef.current = null;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        void openTab(selectedProfileId);
      }

      if (event.ctrlKey && event.key.toLowerCase() === "w" && activeTabId) {
        event.preventDefault();
        void closeTab(activeTabId);
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        void splitActiveTab();
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        setHistoryOpen((current) => !current);
      }

      if (event.ctrlKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setWorkspaceOpen((current) => !current);
      }

      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        toggleProxy();
      }

      if (event.ctrlKey && event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        cycleNamedWorkspace(event.key === "ArrowRight" ? 1 : -1);
      }

      if (event.ctrlKey && event.key === ",") {
        event.preventDefault();
        setSettingsOpen((current) => !current);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeTabId, selectedProfileId, settings.namedWorkspaces, activeNamedWorkspaceId, tabs, profiles]);

  async function createTab(
    profileId: string,
    sourceProfiles: Profile[],
    layout = DEFAULT_STARTUP_LAYOUT,
    initialCwd?: string | null,
    proxy?: ProxySettings | null,
  ) {
    const resolvedProfileId = resolveProfileId(profileId, sourceProfiles);
    const profileName = profileLabel(resolvedProfileId, sourceProfiles);
    const primarySession = await createSession(resolvedProfileId, 120, 32, initialCwd, proxy);
    const initialRuntimeMode = sourceProfiles.find((profile) => profile.id === resolvedProfileId)?.category === "ai" ? "claude" : "shell";
    const primaryPane: Pane = {
      id: makeId("pane"),
      sessionId: primarySession.sessionId,
      profileId: resolvedProfileId,
      sizeRatio: 1,
      title: profileName,
      cwd: primarySession.cwd || initialCwd || undefined,
      runtimeMode: initialRuntimeMode,
      sessionState: "running",
    };

    if (layout.paneCount !== 2) {
      return {
        resolvedProfileId,
        nextTab: {
          id: makeId("tab"),
          profileId: resolvedProfileId,
          title: profileName,
          panes: [primaryPane],
          activePaneId: primaryPane.id,
        } satisfies Tab,
      };
    }

    const secondarySession = await createSession(resolvedProfileId, 120, 32, initialCwd, proxy);
    const splitRatio = normalizeSplitRatio(layout.splitRatio);
    const secondaryPane: Pane = {
      id: makeId("pane"),
      sessionId: secondarySession.sessionId,
      profileId: resolvedProfileId,
      sizeRatio: 1 - splitRatio,
      title: profileName,
      cwd: secondarySession.cwd || initialCwd || undefined,
      runtimeMode: initialRuntimeMode,
      sessionState: "running",
    };

    return {
      resolvedProfileId,
      nextTab: {
        id: makeId("tab"),
        profileId: resolvedProfileId,
        title: profileName,
        panes: [{ ...primaryPane, sizeRatio: splitRatio }, secondaryPane],
        activePaneId: primaryPane.id,
      } satisfies Tab,
    };
  }

  async function openStartupTab(profileId: string, sourceProfiles: Profile[], startupSettings: Settings) {
    const startupLayout = startupSettings.rememberLayout
      ? resolveStartupLayout(startupSettings.startupLayout)
      : { ...DEFAULT_STARTUP_LAYOUT };
    const { resolvedProfileId, nextTab } = await createTab(
      profileId,
      sourceProfiles,
      startupLayout,
      startupSettings.lastCwd,
      normalizeProxy(startupSettings.proxy),
    );

    setTabs([nextTab]);
    setActiveTabId(nextTab.id);
    setSelectedProfileId(resolvedProfileId);
    setBootError(null);
  }

  async function openTab(profileId = selectedProfileId, sourceProfiles = profiles, explicitCwd?: string | null) {
    try {
      const activePane = activeTab?.panes.find((pane) => pane.id === activeTab.activePaneId);
      const targetCwd = explicitCwd ?? settings.workspaceRoot ?? activePane?.cwd ?? settings.lastCwd ?? null;
      const { resolvedProfileId, nextTab } = await createTab(profileId, sourceProfiles, DEFAULT_STARTUP_LAYOUT, targetCwd, normalizeProxy(settings.proxy));

      setTabs((current) => [...current, nextTab]);
      setActiveTabId(nextTab.id);
      setSelectedProfileId(resolvedProfileId);
      setBootError(null);
    } catch (error) {
      console.error("Failed to open tab", error);
      setBootError(error instanceof Error ? error.message : String(error));
    }
  }

  async function chooseWorkspaceFolder() {
    try {
      const folder = await selectWorkspaceFolder();
      if (!folder) return;
      setSettings((current) => ({ ...current, workspaceRoot: folder, lastCwd: folder }));
      setSelectedExplorerPath(folder);
      setTerminalCwd(folder);
      setFilePreview(null);
      setFilePreviewError(null);
      setWorkspaceOpen(true);
    } catch (error) {
      setBootError(`Could not open workspace folder: ${String(error)}`);
    }
  }

  async function previewWorkspaceFile(path: string) {
    setSelectedExplorerPath(path);
    try {
      const preview = await readTextFile(path);
      setFilePreview(preview);
      setFilePreviewError(null);
    } catch (error) {
      setFilePreview(null);
      setFilePreviewError(String(error));
    }
  }

  function selectWorkspaceDirectory(path: string) {
    setSelectedExplorerPath(path);
    setTerminalCwd(path);
    setFilePreview(null);
    setFilePreviewError(null);
  }

  async function openWorkspaceTerminal(profileId = selectedProfileId) {
    const workspaceCwd = terminalCwd || settings.workspaceRoot || null;
    if (!workspaceCwd) {
      setBootError("Choose a workspace folder before opening a workspace terminal.");
      return;
    }
    await openTab(profileId, profiles, workspaceCwd);
  }

  async function splitActiveTab() {
    if (!activeTab || activeTab.panes.length > 1) {
      return;
    }

    try {
      const activePane = activeTab.panes.find((pane) => pane.id === activeTab.activePaneId);
      const targetCwd = activePane?.cwd || settings.lastCwd || null;
      const result = await createSession(activeTab.profileId, 120, 32, targetCwd, normalizeProxy(settings.proxy));
      const profileName = profileLabel(activeTab.profileId, profiles);
      const nextPane: Pane = {
        id: makeId("pane"),
        sessionId: result.sessionId,
        profileId: activeTab.profileId,
        sizeRatio: 0.5,
        title: profileName,
        cwd: result.cwd || targetCwd || undefined,
        runtimeMode: profiles.find((profile) => profile.id === activeTab.profileId)?.category === "ai" ? "claude" : "shell",
        sessionState: "running",
      };

      setTabs((current) =>
        current.map((tab) => {
          if (tab.id !== activeTab.id) {
            return tab;
          }
          return {
            ...tab,
            activePaneId: nextPane.id,
            panes: [{ ...tab.panes[0], sizeRatio: 0.5 }, nextPane],
          };
        }),
      );
    } catch (error) {
      console.error("Failed to split pane", error);
      setBootError(error instanceof Error ? error.message : String(error));
    }
  }

  async function closePane(tabId: string, paneId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    const pane = tab?.panes.find((item) => item.id === paneId);

    if (!tab || !pane) {
      return;
    }

    await closeSession(pane.sessionId).catch((error) => {
      console.error("Failed to close pane session", error);
    });

    if (tab.panes.length === 1) {
      await closeTab(tabId, false);
      return;
    }

    setTabs((current) =>
      current.map((item) => {
        if (item.id !== tabId) {
          return item;
        }

        const remainingPane = item.panes.find((candidate) => candidate.id !== paneId);
        if (!remainingPane) {
          return item;
        }

        return {
          ...item,
          activePaneId: remainingPane.id,
          panes: [{ ...remainingPane, sizeRatio: 1 }],
        };
      }),
    );
  }

  function reorderTabs(draggedTabId: string, targetTabId: string, placement: "before" | "after") {
    if (draggedTabId === targetTabId) {
      return;
    }

    setTabs((current) => {
      const draggedIndex = current.findIndex((tab) => tab.id === draggedTabId);
      const targetIndex = current.findIndex((tab) => tab.id === targetTabId);
      if (draggedIndex < 0 || targetIndex < 0) {
        return current;
      }

      const reordered = [...current];
      const [draggedTab] = reordered.splice(draggedIndex, 1);
      const adjustedTargetIndex = reordered.findIndex((tab) => tab.id === targetTabId);
      const insertionIndex = placement === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex;
      reordered.splice(insertionIndex, 0, draggedTab);
      return reordered;
    });
  }

  async function closeTab(tabId: string, closeSessions = true) {
    const targetTab = tabs.find((tab) => tab.id === tabId);
    if (!targetTab) {
      return;
    }

    if (closeSessions) {
      await Promise.all(
        targetTab.panes.map((pane) =>
          closeSession(pane.sessionId).catch((error) => {
            console.error("Failed to close tab session", error);
            return undefined;
          }),
        ),
      );
    }

    const remainingTabs = tabs.filter((tab) => tab.id !== tabId);
    const nextActiveTab = remainingTabs.length > 0 ? remainingTabs[remainingTabs.length - 1] : null;
    setTabs(remainingTabs);
    setActiveTabId(nextActiveTab?.id ?? null);

    if (remainingTabs.length === 0) {
      await openTab(selectedProfileId, profiles);
    }
  }

  function updatePaneTitle(sessionId: string, nextTitle: string) {
    const normalized = nextTitle.trim();
    if (!normalized) {
      return;
    }

    setTabs((current) =>
      current.map((tab) => {
        const matchesPane = tab.panes.some((pane) => pane.sessionId === sessionId);
        if (!matchesPane) {
          return tab;
        }

        const updatedPanes = tab.panes.map((pane) =>
          pane.sessionId === sessionId ? { ...pane, title: normalized } : pane,
        );
        const activePane = updatedPanes.find((pane) => pane.id === tab.activePaneId) ?? updatedPanes[0];
        return {
          ...tab,
          panes: updatedPanes,
          title: activePane?.title ?? tab.title,
        };
      }),
    );
  }

  function updatePaneCwd(sessionId: string, nextCwd: string) {
    const normalized = nextCwd.trim();
    if (!normalized) {
      return;
    }

    setSettings((current) => ({
      ...current,
      lastCwd: normalized,
    }));

    setTabs((current) =>
      current.map((tab) => {
        const matchesPane = tab.panes.some((pane) => pane.sessionId === sessionId);
        if (!matchesPane) {
          return tab;
        }

        const updatedPanes = tab.panes.map((pane) =>
          pane.sessionId === sessionId ? { ...pane, cwd: normalized } : pane,
        );
        return {
          ...tab,
          panes: updatedPanes,
        };
      }),
    );
  }

  function updatePaneRuntime(sessionId: string, runtimeMode: Pane["runtimeMode"]) {
    setTabs((current) =>
      current.map((tab) => ({
        ...tab,
        panes: tab.panes.map((pane) =>
          pane.sessionId === sessionId && pane.runtimeMode !== runtimeMode ? { ...pane, runtimeMode } : pane,
        ),
      })),
    );
  }

  function updatePaneSessionState(sessionId: string, sessionState: Pane["sessionState"]) {
    setTabs((current) =>
      current.map((tab) => ({
        ...tab,
        panes: tab.panes.map((pane) =>
          pane.sessionId === sessionId && pane.sessionState !== sessionState ? { ...pane, sessionState } : pane,
        ),
      })),
    );
  }

  function focusPane(tabId: string, paneId: string) {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              activePaneId: paneId,
            }
          : tab,
      ),
    );
    setActiveTabId(tabId);
  }

  function runCommandFromHistory(command: string) {
    const targetPane = activeTab?.panes.find((pane) => pane.id === activeTab.activePaneId);
    if (!targetPane) {
      setBootError("Open a terminal before running a history command.");
      return;
    }
    setQueuedCommand({ id: makeId("command"), value: command, sessionId: targetPane.sessionId });
  }

  const proxy = normalizeProxy(settings.proxy);
  const activeWorkspace = (settings.namedWorkspaces || []).find((item) => item.id === activeNamedWorkspaceId) ?? null;
  const activeWorkspaceLabel =
    activeWorkspace?.name
    || settings.workspaceRoot?.split(/[\\/]/).filter(Boolean).slice(-1)[0]
    || "No workspace";

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const base: PaletteCommand[] = [
      { id: "new-tab", label: "New terminal tab", description: "Open the selected shell profile", shortcut: "Ctrl T", keywords: "shell terminal", run: () => void openTab(selectedProfileId) },
      { id: "split", label: "Split active pane", description: "Create a second terminal pane", shortcut: "Ctrl Shift D", run: () => void splitActiveTab() },
      { id: "save-workspace", label: "Save current workspace", description: "Store tabs, panes, and directories", keywords: "session layout", run: saveNamedWorkspace },
      { id: "switch-workspace", label: "Switch saved workspace…", description: "Pick from your saved workspaces", shortcut: "Ctrl Alt ←/→", keywords: "workspace switch session layout", run: () => setSwitcherAnchor({ x: Math.max(24, window.innerWidth / 2 - 130), y: 96 }) },
      { id: "toggle-proxy", label: proxy.enabled ? "Disable local proxy" : "Enable local proxy", description: `${proxyTargetLabel(proxy)} · applies to new sessions`, shortcut: "Ctrl Alt P", keywords: "proxy network http clash direct", run: toggleProxy },
      { id: "history", label: "Open command history", description: "Search, copy, or rerun commands", shortcut: "Ctrl Shift R", run: () => setHistoryOpen(true) },
      { id: "sidebar", label: workspaceOpen ? "Hide workspace sidebar" : "Show workspace sidebar", description: "Toggle workspace and tab navigation", shortcut: "Ctrl B", run: () => setWorkspaceOpen((current) => !current) },
      { id: "settings", label: "Open settings", description: "Theme, font, cursor, and startup shell", shortcut: "Ctrl ,", run: () => setSettingsOpen(true) },
    ];
    const profileCommands = profiles.map((profile) => ({
      id: `profile-${profile.id}`,
      label: `Open ${profile.name}`,
      description: profile.description,
      keywords: `${profile.category} profile claude shell`,
      run: () => void openTab(profile.id),
    }));
    const workspaceCommands = (settings.namedWorkspaces || []).map((workspace) => ({
      id: `workspace-${workspace.id}`,
      label: `Switch to ${workspace.name}`,
      description: `${workspace.state.tabs.length} saved tabs`,
      keywords: "workspace session layout",
      run: () => void loadNamedWorkspace(workspace.id),
    }));
    return [...base, ...profileCommands, ...workspaceCommands];
  }, [profiles, selectedProfileId, settings.namedWorkspaces, workspaceOpen, activeTabId, tabs, proxy, activeNamedWorkspaceId]);

  const paneGridStyle =
    activeTab && activeTab.panes.length === 2
      ? {
          gridTemplateColumns: `${activeTab.panes[0].sizeRatio}fr ${PANE_SPLITTER_WIDTH}px ${activeTab.panes[1].sizeRatio}fr`,
        }
      : undefined;

  const fontDeltaHandler = (delta: number) => {
    setSettings((current) => ({
      ...current,
      fontSize: clampFontSize(current.fontSize + delta),
    }));
  };

  if (booting) {
    return <div className="boot-screen">Opening your default shell...</div>;
  }

  return (
    <main className={`app-shell theme-${settings.theme}`}>
      <TitleBar
        profiles={profiles}
        selectedProfileId={selectedProfileId}
        onSelectedProfileChange={setSelectedProfileId}
        proxyEnabled={proxy.enabled}
        proxyTarget={proxyTargetLabel(proxy)}
        onToggleProxy={toggleProxy}
        onNewTab={() => void openTab(selectedProfileId, profiles, settings.workspaceRoot || null)}
        onOpenPalette={() => setPaletteOpen(true)}
        onSplit={() => void splitActiveTab()}
        onToggleWorkspaces={() => setWorkspaceOpen((current) => !current)}
        onToggleSettings={() => setSettingsOpen((current) => !current)}
      />

      <div className={`app-body ${workspaceOpen ? "has-sidebar" : ""}`}>
        <WorkspacePanel
          open={workspaceOpen}
          workspaces={settings.namedWorkspaces || []}
          workspaceRoot={settings.workspaceRoot}
          selectedPath={selectedExplorerPath}
          onClose={() => setWorkspaceOpen(false)}
          onChooseFolder={() => void chooseWorkspaceFolder()}
          onSelectFile={(path) => void previewWorkspaceFile(path)}
          onSelectDirectory={selectWorkspaceDirectory}
          onOpenTerminal={(path) => void openTab(selectedProfileId, profiles, path)}
          onSaveCurrent={saveNamedWorkspace}
          onLoad={(workspaceId) => void loadNamedWorkspace(workspaceId)}
          onDelete={deleteNamedWorkspace}
        />

        <div className={`app-main-content ${filePreview || filePreviewError ? "has-context-preview" : ""}`}>
          <div className="terminal-context-bar">
            <div>
              <button
                type="button"
                className="context-workspace-button"
                title="Switch saved workspace · Ctrl+Alt+←/→ to cycle"
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setSwitcherAnchor({ x: bounds.left, y: bounds.bottom + 6 });
                }}
              >
                <span className={`context-status-dot is-${activePane?.sessionState || "idle"}`} />
                <strong>{activeWorkspaceLabel}</strong>
                <span className="context-workspace-caret" aria-hidden="true">▾</span>
              </button>
              {activePane && <span className={`runtime-context-badge is-${activePane.runtimeMode}`}>{activePane.runtimeMode === "claude" ? "Claude active" : "Shell"}</span>}
              <span>{activePane?.cwd || settings.workspaceRoot || "Choose a folder to give AI sessions project context"}</span>
            </div>
            <div>
              <button type="button" className="context-folder-button" title={settings.workspaceRoot ? "Change project folder" : "Open project folder"} onClick={() => void chooseWorkspaceFolder()}>{settings.workspaceRoot ? "Change" : "Open folder"}</button>
              <button type="button" className="context-primary-action" disabled={!settings.workspaceRoot || !claudeProfile} onClick={() => void openWorkspaceTerminal("claude")}>Start Claude</button>
              <button type="button" className="context-more-action" title="Open shell in project" aria-label="Open shell in project" disabled={!settings.workspaceRoot} onClick={() => void openWorkspaceTerminal(selectedProfileId)}>Shell</button>
            </div>
          </div>

          <section className="terminal-panel">
            <TabBar
              tabs={tabs}
              activeTabId={activeTabId}
              onSelect={setActiveTabId}
              onClose={(tabId) => void closeTab(tabId)}
              onReorder={reorderTabs}
            />

            <section className="workspace-frame">
              {bootError && (
                <div className="boot-error-banner">
                  <strong>Terminal issue</strong>
                  <span>{bootError}</span>
                </div>
              )}

              {activeTab ? (
                <div ref={paneDeckRef} className={`pane-deck panes-${activeTab.panes.length}`} style={paneGridStyle}>
                  {activeTab.panes.map((pane, index) => (
                    <div
                      key={pane.id}
                      className="pane-slot"
                      style={
                        activeTab.panes.length === 2
                          ? { gridColumn: index === 0 ? 1 : 3, gridRow: 1 }
                          : undefined
                      }
                    >
                      <TerminalPane
                        sessionId={pane.sessionId}
                        settings={settings}
                        profileCategory={profiles.find((profile) => profile.id === pane.profileId)?.category ?? "shell"}
                        runtimeMode={pane.runtimeMode}
                        paneTitle={pane.title ?? `Pane ${index + 1}`}
                        cwd={pane.cwd}
                        sessionState={pane.sessionState}
                        active={activeTab.activePaneId === pane.id}
                        canClose={activeTab.panes.length > 1}
                        onActivate={() => focusPane(activeTab.id, pane.id)}
                        onClose={() => void closePane(activeTab.id, pane.id)}
                        onTitleChange={(title) => updatePaneTitle(pane.sessionId, title)}
                        onCwdChange={(cwd) => updatePaneCwd(pane.sessionId, cwd)}
                        onRuntimeModeChange={(mode) => updatePaneRuntime(pane.sessionId, mode)}
                        onSessionStateChange={(state) => updatePaneSessionState(pane.sessionId, state)}
                        onFontDelta={fontDeltaHandler}
                        queuedCommand={queuedCommand}
                      />
                    </div>
                  ))}

                  {activeTab.panes.length === 2 && (
                    <div
                      className="splitter"
                      style={{ gridColumn: 2, gridRow: 1 }}
                      onMouseDown={() => {
                        dragStateRef.current = { tabId: activeTab.id };
                      }}
                    />
                  )}
                </div>
              ) : (
                <div className="empty-state">
                  <strong>No AI terminal session is active.</strong>
                  <span>Open a workspace and start Claude Code, or create a shell tab.</span>
                </div>
              )}
            </section>
          </section>

          {(filePreview || filePreviewError) && (
            <aside className="context-preview-panel">
              <button type="button" className="context-preview-close" onClick={() => { setFilePreview(null); setFilePreviewError(null); }}>×</button>
              <FilePreview
                workspaceRoot={settings.workspaceRoot}
                preview={filePreview}
                error={filePreviewError}
                onChooseFolder={() => void chooseWorkspaceFolder()}
                onOpenTerminal={() => void openWorkspaceTerminal()}
              />
            </aside>
          )}
        </div>
      </div>

      <CommandPalette open={paletteOpen} commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
      {switcherAnchor && (
        <WorkspaceSwitcher
          anchor={switcherAnchor}
          workspaces={settings.namedWorkspaces || []}
          activeWorkspaceId={activeNamedWorkspaceId}
          onSelect={(workspaceId) => void loadNamedWorkspace(workspaceId)}
          onSaveCurrent={() => {
            setSwitcherAnchor(null);
            saveNamedWorkspace();
          }}
          onClose={() => setSwitcherAnchor(null)}
        />
      )}
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} onRun={runCommandFromHistory} />

      <SettingsPanel
        profiles={profiles}
        settings={settings}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onChange={setSettings}
      />
    </main>
  );
}
