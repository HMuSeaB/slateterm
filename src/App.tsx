import { useEffect, useRef, useState } from "react";
import SettingsPanel from "./components/SettingsPanel";
import TabBar from "./components/TabBar";
import TerminalPane from "./components/TerminalPane";
import TitleBar from "./components/TitleBar";
import { closeSession, createSession, listProfiles, listShellProfiles, loadSettings, saveSettings } from "./lib/tauri";
import type { Pane, Profile, Settings, StartupLayout, Tab } from "./lib/types";

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
};

const PANE_SPLITTER_WIDTH = 10;

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
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
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const paneDeckRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ tabId: string } | null>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeProfile = profiles.find((profile) => profile.id === activeTab?.profileId) ?? null;

  useEffect(() => {
    let cancelled = false;

    async function hydrateProfiles() {
      try {
        const loadedProfiles = await listProfiles();
        if (cancelled) {
          return;
        }

        setProfiles(loadedProfiles);
        setSelectedProfileId((current) => resolveProfileId(current, loadedProfiles));
        setSettings((current) => {
          const startupId = resolveStartupProfileId(current.defaultProfileId, loadedProfiles);
          return current.defaultProfileId === startupId ? current : { ...current, defaultProfileId: startupId };
        });
      } catch (error) {
        console.error("Failed to hydrate full profile list", error);
      }
    }

    async function bootstrap() {
      try {
        const [loadedShells, loadedSettings] = await Promise.all([
          listShellProfiles(),
          loadSettings().catch(() => DEFAULT_SETTINGS),
        ]);

        if (cancelled) {
          return;
        }

        const normalizedSettings = normalizeSettings(loadedSettings);
        const startupProfileId = resolveStartupProfileId(normalizedSettings.defaultProfileId, loadedShells);
        const resolvedSettings =
          startupProfileId === normalizedSettings.defaultProfileId
            ? normalizedSettings
            : {
                ...normalizedSettings,
                defaultProfileId: startupProfileId,
              };

        setProfiles(loadedShells);
        setSettings(resolvedSettings);
        setSelectedProfileId(startupProfileId);
        await openStartupTab(startupProfileId, loadedShells, resolvedSettings);
        void hydrateProfiles();
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

    const settingsToPersist: Settings = settings.rememberLayout
      ? {
          ...settings,
          startupLayout: layoutPreferenceFromTab(activeTab),
        }
      : {
          ...settings,
          startupLayout: { ...DEFAULT_STARTUP_LAYOUT },
        };

    const timer = window.setTimeout(() => {
      void saveSettings(settingsToPersist).catch((error) => {
        console.error("Failed to save settings", error);
      });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [activeTab, booting, settings]);

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

      if (event.ctrlKey && event.key === ",") {
        event.preventDefault();
        setSettingsOpen((current) => !current);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabId, selectedProfileId]);

  async function createTab(profileId: string, sourceProfiles: Profile[], layout = DEFAULT_STARTUP_LAYOUT) {
    const resolvedProfileId = resolveProfileId(profileId, sourceProfiles);
    const profileName = profileLabel(resolvedProfileId, sourceProfiles);
    const primarySession = await createSession(resolvedProfileId, 120, 32);
    const primaryPane: Pane = {
      id: makeId("pane"),
      sessionId: primarySession.sessionId,
      sizeRatio: 1,
      title: profileName,
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

    const secondarySession = await createSession(resolvedProfileId, 120, 32);
    const splitRatio = normalizeSplitRatio(layout.splitRatio);
    const secondaryPane: Pane = {
      id: makeId("pane"),
      sessionId: secondarySession.sessionId,
      sizeRatio: 1 - splitRatio,
      title: profileName,
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
    const { resolvedProfileId, nextTab } = await createTab(profileId, sourceProfiles, startupLayout);

    setTabs([nextTab]);
    setActiveTabId(nextTab.id);
    setSelectedProfileId(resolvedProfileId);
    setBootError(null);
  }

  async function openTab(profileId = selectedProfileId, sourceProfiles = profiles) {
    try {
      const { resolvedProfileId, nextTab } = await createTab(profileId, sourceProfiles);

      setTabs((current) => [...current, nextTab]);
      setActiveTabId(nextTab.id);
      setSelectedProfileId(resolvedProfileId);
      setBootError(null);
    } catch (error) {
      console.error("Failed to open tab", error);
      setBootError(error instanceof Error ? error.message : String(error));
    }
  }

  async function splitActiveTab() {
    if (!activeTab || activeTab.panes.length > 1) {
      return;
    }

    try {
      const result = await createSession(activeTab.profileId, 120, 32);
      const profileName = profileLabel(activeTab.profileId, profiles);
      const nextPane: Pane = {
        id: makeId("pane"),
        sessionId: result.sessionId,
        sizeRatio: 0.5,
        title: profileName,
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
        onLaunchProfile={(profileId) => void openTab(profileId)}
        onNewTab={() => void openTab(selectedProfileId)}
        onSplit={() => void splitActiveTab()}
        onToggleSettings={() => setSettingsOpen((current) => !current)}
      />

      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={setActiveTabId}
        onClose={(tabId) => void closeTab(tabId)}
      />

      <section className="workspace-frame">
        {bootError && (
          <div className="boot-error-banner">
            <strong>Startup issue</strong>
            <span>{bootError}</span>
          </div>
        )}

        <div className="workspace-topline workspace-topline-compact">
          <div>
            <strong>{activeProfile?.name ?? "Shell"}</strong>
            <span>{activeProfile?.description ?? (activeTab?.panes.length === 2 ? "Dual pane workspace" : "Single focused pane")}</span>
          </div>
          <div className="workspace-hints">
            <span>Ctrl+T new tab</span>
            <span>Ctrl+Shift+D split</span>
            <span>Ctrl+Shift+F search</span>
          </div>
        </div>

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
                <div className="pane-caption">
                  <div>
                    <strong>{pane.title ?? "Shell"}</strong>
                    <span>{pane.sessionId.slice(0, 8)}</span>
                  </div>
                  {activeTab.panes.length > 1 && (
                    <button type="button" className="ghost-button" onClick={() => void closePane(activeTab.id, pane.id)}>
                      Close Pane
                    </button>
                  )}
                </div>

                <TerminalPane
                  sessionId={pane.sessionId}
                  settings={settings}
                  active={activeTab.activePaneId === pane.id}
                  onActivate={() => focusPane(activeTab.id, pane.id)}
                  onTitleChange={(title) => updatePaneTitle(pane.sessionId, title)}
                  onFontDelta={fontDeltaHandler}
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
            <strong>No terminal session is active.</strong>
            <span>Use one of the shell buttons above, or open Claude Code when you need it.</span>
          </div>
        )}
      </section>

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
