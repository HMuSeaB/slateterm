import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { getSuggestion, recordCommand, type SuggestionResult } from "../lib/completionEngine";
import {
  clipboardHasImage,
  openExternalUrl,
  readClipboardImage,
  readClipboardText,
  readImageFile,
  resizeSession,
  saveTempImage,
  writeClipboardImageFile,
  writeClipboardText,
  writeInput,
} from "../lib/tauri";
import type {
  CommandBlock,
  CommandBlockEvent,
  CwdEvent,
  ErrorEvent,
  ExitEvent,
  OutputEvent,
  PaneRuntimeMode,
  PaneSessionState,
  Settings,
  TitleEvent,
} from "../lib/types";

type Props = {
  sessionId: string;
  settings: Settings;
  profileCategory: "shell" | "ai";
  paneTitle?: string;
  cwd?: string;
  sessionState: PaneSessionState;
  active: boolean;
  canClose?: boolean;
  onActivate: () => void;
  onClose?: () => void;
  onTitleChange: (title: string) => void;
  onCwdChange?: (cwd: string) => void;
  onRuntimeModeChange?: (mode: PaneRuntimeMode) => void;
  onSessionStateChange?: (state: PaneSessionState) => void;
  onFontDelta: (delta: number) => void;
  queuedCommand?: { id: string; value: string; sessionId: string } | null;
};

type TerminalBinding = {
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  lastCols: number;
  lastRows: number;
};

type StatusBanner = {
  tone: "info" | "error";
  message: string;
};

const CLAUDE_IMAGE_ATTACH_SEQUENCE = "\x1bv";
const ATTACHABLE_IMAGE_EXTENSIONS = new Set(["png", "bmp", "jpg", "jpeg", "gif", "webp"]);
const IMAGE_PATH_EXTENSIONS = ATTACHABLE_IMAGE_EXTENSIONS;
const MAX_COMMAND_BLOCK_OUTPUT = 1_000_000;

function imageExtension(path: string) {
  const normalized = path.split(/[?#]/, 1)[0];
  const filename = normalized.split(/[\\/]/).slice(-1)[0] ?? "";
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex + 1).toLowerCase() : "";
}

function isAttachableImagePath(path: string) {
  return ATTACHABLE_IMAGE_EXTENSIONS.has(imageExtension(path));
}

function isImagePath(path: string) {
  return IMAGE_PATH_EXTENSIONS.has(imageExtension(path));
}

function formatTerminalPaths(paths: string[]) {
  return paths.map((path) => (path.includes(" ") ? `"${path}"` : path)).join(" ");
}

function isClaudeCommand(command: string) {
  const normalized = command.trim().toLowerCase();
  return /(?:^|[;&|]\s*)(?:&\s*)?(?:claude(?:\.cmd|\.exe)?|["'][^"']*[\\/]claude(?:\.cmd|\.exe)?["'])(?:\s|$)/.test(
    normalized,
  );
}

async function imageBlobToPngBytes(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas image conversion is unavailable");
    }
    context.drawImage(bitmap, 0, 0);
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((converted) => {
        if (converted) resolve(converted);
        else reject(new Error("Could not convert the image to PNG"));
      }, "image/png");
    });
    return new Uint8Array(await pngBlob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function imageMimeType(path: string) {
  const extension = imageExtension(path);
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "bmp") return "image/bmp";
  return "image/png";
}

function themeForMode(theme: Settings["theme"]) {
  if (theme === "paper") {
    return {
      background: "#f7f3e8",
      foreground: "#2f2b22",
      cursor: "#145f5c",
      cursorAccent: "#f7f3e8",
      selectionBackground: "rgba(20, 95, 92, 0.22)",
      black: "#26211d",
      red: "#a04237",
      green: "#4c7a53",
      yellow: "#92662b",
      blue: "#3f6392",
      magenta: "#874667",
      cyan: "#1c6a67",
      white: "#d7cfbc",
      brightBlack: "#6d6657",
      brightRed: "#d55b4e",
      brightGreen: "#5f9667",
      brightYellow: "#b78536",
      brightBlue: "#5983be",
      brightMagenta: "#ad5b87",
      brightCyan: "#2d918c",
      brightWhite: "#fffaf0",
    };
  }

  return {
    background: "#11141a",
    foreground: "#e8e1cf",
    cursor: "#f59e0b",
    cursorAccent: "#11141a",
    selectionBackground: "rgba(245, 158, 11, 0.25)",
    black: "#1d232b",
    red: "#ef6b61",
    green: "#88b56f",
    yellow: "#e0ab4f",
    blue: "#6ca0dc",
    magenta: "#cb7bbf",
    cyan: "#54b5b0",
    white: "#d7d4ca",
    brightBlack: "#6e7682",
    brightRed: "#ff8b80",
    brightGreen: "#a1cd85",
    brightYellow: "#f6c766",
    brightBlue: "#87b9f0",
    brightMagenta: "#df97d0",
    brightCyan: "#78d7d1",
    brightWhite: "#fbfaf7",
  };
}

export default function TerminalPane({
  sessionId,
  settings,
  profileCategory,
  paneTitle,
  cwd,
  sessionState,
  active,
  canClose = false,
  onActivate,
  onClose,
  onTitleChange,
  onCwdChange,
  onRuntimeModeChange,
  onSessionStateChange,
  onFontDelta,
  queuedCommand,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<TerminalBinding | null>(null);
  const fitRafRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const onFontDeltaRef = useRef(onFontDelta);
  const onTitleChangeRef = useRef(onTitleChange);
  const onCwdChangeRef = useRef(onCwdChange);
  const onRuntimeModeChangeRef = useRef(onRuntimeModeChange);
  const onSessionStateChangeRef = useRef(onSessionStateChange);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<StatusBanner | null>(null);
  const [blocksOpen, setBlocksOpen] = useState(false);
  const [commandBlocks, setCommandBlocks] = useState<CommandBlock[]>([]);
  const [collapsedBlocks, setCollapsedBlocks] = useState<Record<string, boolean>>({});

  const [inputBuffer, setInputBuffer] = useState("");
  const [suggestion, setSuggestion] = useState<SuggestionResult | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<"shell" | "claude">(
    profileCategory === "ai" ? "claude" : "shell",
  );
  const suggestionRef = useRef<SuggestionResult | null>(null);
  const inputBufferRef = useRef("");
  const activeRef = useRef(active);
  const profileCategoryRef = useRef(profileCategory);
  const runtimeModeRef = useRef<"shell" | "claude">(profileCategory === "ai" ? "claude" : "shell");
  const nativeDragActiveRef = useRef(false);
  const lastNativeDropRef = useRef(0);

  useEffect(() => {
    onFontDeltaRef.current = onFontDelta;
  }, [onFontDelta]);

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  useEffect(() => {
    onCwdChangeRef.current = onCwdChange;
  }, [onCwdChange]);

  useEffect(() => {
    onRuntimeModeChangeRef.current = onRuntimeModeChange;
  }, [onRuntimeModeChange]);

  useEffect(() => {
    onSessionStateChangeRef.current = onSessionStateChange;
  }, [onSessionStateChange]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    profileCategoryRef.current = profileCategory;
    if (profileCategory === "ai") {
      setPaneRuntimeMode("claude");
    }
  }, [profileCategory]);

  function setPaneRuntimeMode(mode: PaneRuntimeMode) {
    runtimeModeRef.current = mode;
    setRuntimeMode(mode);
    onRuntimeModeChangeRef.current?.(mode);
  }

  function isClaudeRuntime() {
    return profileCategoryRef.current === "ai" || runtimeModeRef.current === "claude";
  }

  function focusTerminal() {
    bindingRef.current?.terminal.focus();
  }

  function copyBlockText(text: string, label: string) {
    if (!text) {
      return;
    }
    void writeClipboardText(text)
      .then(() => setSessionStatus({ tone: "info", message: `${label} copied.` }))
      .catch((error) => setSessionStatus({ tone: "error", message: `Copy failed: ${String(error)}` }));
  }

  function rerunBlock(command: string) {
    const normalized = command.trim();
    if (!normalized) {
      return;
    }
    updateBuffer("");
    recordCommand(normalized);
    void writeInput(sessionId, `${normalized}\r`);
    focusTerminal();
  }

  function updateBuffer(nextVal: string) {
    inputBufferRef.current = nextVal;
    setInputBuffer(nextVal);
    const nextSugg = getSuggestion(nextVal);
    suggestionRef.current = nextSugg;
    setSuggestion(nextSugg);
  }

  async function attachClipboardImageToClaude(message = "Attaching image to Claude Code...") {
    setSessionStatus({ tone: "info", message });
    await writeInput(sessionId, CLAUDE_IMAGE_ATTACH_SEQUENCE);
  }

  async function attachImageFileToClaude(path: string) {
    setSessionStatus({ tone: "info", message: "Preparing dropped image for Claude Code..." });
    const extension = imageExtension(path);
    let attachmentPath = path;
    if (extension !== "png" && extension !== "bmp") {
      const sourceBytes = await readImageFile(path);
      const pngBytes = await imageBlobToPngBytes(new Blob([sourceBytes], { type: imageMimeType(path) }));
      attachmentPath = await saveTempImage(pngBytes, "png");
    }
    await writeClipboardImageFile(attachmentPath);
    await attachClipboardImageToClaude("Attaching dropped image to Claude Code...");
  }

  async function handleDroppedPaths(paths: string[]) {
    if (paths.length === 0) {
      return;
    }

    if (paths.length === 1 && isAttachableImagePath(paths[0])) {
      if (!isClaudeRuntime()) {
        throw new Error("Start Claude Code before dropping an image attachment.");
      }
      await attachImageFileToClaude(paths[0]);
      return;
    }
    const imagePaths = paths.filter(isImagePath);
    if (imagePaths.length > 0) {
      throw new Error(
        isAttachableImagePath(imagePaths[0])
          ? "Drop one image at a time to attach it to Claude Code."
          : "This image format is not supported for attachment.",
      );
    }

    const formattedPaths = formatTerminalPaths(paths);
    setSessionStatus({ tone: "info", message: `Pasted path: ${formattedPaths}` });
    updateBuffer(inputBufferRef.current + formattedPaths);
    await writeInput(sessionId, formattedPaths);
  }

  function handlePasteCapture(event: React.ClipboardEvent<HTMLDivElement>) {
    const eventText = event.clipboardData.getData("text/plain");
    const imageFile = Array.from(event.clipboardData.items)
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile();
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
      if (await clipboardHasImage()) {
        if (!isClaudeRuntime()) {
          throw new Error("Start Claude Code before attaching a clipboard image.");
        }
        await attachClipboardImageToClaude("Attaching clipboard history image to Claude Code...");
        return;
      }
      if (imageFile) {
        if (!isClaudeRuntime()) {
          throw new Error("Start Claude Code before attaching a clipboard image.");
        }
        const pngBytes = await imageBlobToPngBytes(imageFile);
        const imagePath = await saveTempImage(pngBytes, "png");
        await attachImageFileToClaude(imagePath);
        return;
      }
      const text = eventText || (await readClipboardText());
      if (text) {
        setSessionStatus(null);
        updateBuffer(inputBufferRef.current + text.replace(/[\x00-\x1F\x7F-\x9F]/g, ""));
        await writeInput(sessionId, text);
      }
    })().catch((error) =>
      setSessionStatus({ tone: "error", message: `Paste failed: ${String(error)}` }),
    );
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!isDragging) setIsDragging(true);
  }

  function handleDragLeave() {
    if (!nativeDragActiveRef.current) {
      setIsDragging(false);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (nativeDragActiveRef.current || performance.now() - lastNativeDropRef.current < 500) {
      return;
    }
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((path): path is string => Boolean(path));
    void handleDroppedPaths(paths).catch((error) =>
      setSessionStatus({ tone: "error", message: `Drop failed: ${String(error)}` }),
    );
  }

  function fitTerminal(reason: string) {
    const binding = bindingRef.current;
    const container = containerRef.current;
    if (!binding || !container) {
      return;
    }

    const proposed = binding.fitAddon.proposeDimensions();
    if (!proposed) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const safeCols = Math.max(proposed.cols, 20);
    const safeRows = Math.max(proposed.rows - 1, 2);

    if (rect.width > 420 && safeCols < 20) {
      console.warn("Ignoring suspicious fit result", { reason, cols: safeCols, rows: safeRows, width: rect.width, height: rect.height });
      return;
    }

    if (rect.height > 220 && safeRows < 6) {
      console.warn("Ignoring suspicious fit result", { reason, cols: safeCols, rows: safeRows, width: rect.width, height: rect.height });
      return;
    }

    if (binding.lastCols === safeCols && binding.lastRows === safeRows) {
      return;
    }

    binding.terminal.resize(safeCols, safeRows);
    binding.lastCols = safeCols;
    binding.lastRows = safeRows;
    void resizeSession(sessionId, safeCols, safeRows);
  }

  function scheduleFit(reason: string) {
    if (fitRafRef.current !== null) {
      cancelAnimationFrame(fitRafRef.current);
    }

    fitRafRef.current = requestAnimationFrame(() => {
      fitRafRef.current = null;
      fitTerminal(reason);
    });
  }

  function runSearch(term: string, direction: "next" | "previous" = "next", incremental = false) {
    const binding = bindingRef.current;
    const normalized = term.trim();
    if (!binding) {
      return false;
    }

    if (!normalized) {
      binding.searchAddon.clearDecorations();
      setSearchStatus(null);
      return false;
    }

    const found =
      direction === "previous"
        ? binding.searchAddon.findPrevious(normalized, { incremental, caseSensitive: false })
        : binding.searchAddon.findNext(normalized, { incremental, caseSensitive: false });

    setSearchStatus(found ? null : `No matches for "${normalized}"`);
    return found;
  }

  function closeSearch() {
    setSearchOpen(false);
  }

  useEffect(() => {
    if (!containerRef.current || bindingRef.current) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: settings.cursorStyle,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      scrollback: 20000,
      theme: themeForMode(settings.theme),
      windowsPty: {
        backend: "conpty",
        buildNumber: 19045,
      },
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      if (!event.ctrlKey) {
        setSessionStatus({ tone: "info", message: "Hold Ctrl and click to open links." });
        return;
      }
      void openExternalUrl(uri).catch((error) => {
        setSessionStatus({ tone: "error", message: `Could not open link: ${String(error)}` });
      });
    });

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);
    bindingRef.current = {
      terminal,
      fitAddon,
      searchAddon,
      lastCols: 0,
      lastRows: 0,
    };

    const dataDispose = terminal.onData((data) => {
      setSessionStatus(null);
      void writeInput(sessionId, data);

      if (data === "\r" || data === "\n") {
        if (inputBufferRef.current.trim()) {
          recordCommand(inputBufferRef.current);
        }
        updateBuffer("");
      } else if (data === "\x7f" || data === "\x08") {
        updateBuffer(inputBufferRef.current.slice(0, -1));
      } else if (data === "\x03" || data === "\x15") {
        updateBuffer("");
      } else if (!data.startsWith("\x1b")) {
        const printable = data.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
        if (printable) {
          updateBuffer(inputBufferRef.current + printable);
        }
      } else {
        updateBuffer("");
      }
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }

      const key = event.key.toLowerCase();
      const hasSelection = terminal.hasSelection();
      const activeSugg = suggestionRef.current;

      if ((event.key === "Tab" || event.key === "ArrowRight" || (event.ctrlKey && event.code === "Space")) && activeSugg) {
        event.preventDefault();
        const suffix = activeSugg.completionSuffix;
        void writeInput(sessionId, suffix);
        updateBuffer(activeSugg.fullCommand);
        return false;
      }

      if (event.ctrlKey && !event.shiftKey && key === "c" && hasSelection) {
        const selectedText = terminal.getSelection();
        if (selectedText) {
          void writeClipboardText(selectedText)
            .then(() => setSessionStatus({ tone: "info", message: "Copied selection." }))
            .catch((error) => setSessionStatus({ tone: "error", message: `Copy failed: ${String(error)}` }));
          terminal.clearSelection();
          return false;
        }
      }

      if (event.ctrlKey && event.shiftKey && key === "c") {
        const selectedText = terminal.getSelection();
        if (selectedText) {
          void writeClipboardText(selectedText)
            .then(() => setSessionStatus({ tone: "info", message: "Copied selection." }))
            .catch((error) => setSessionStatus({ tone: "error", message: `Copy failed: ${String(error)}` }));
          terminal.clearSelection();
          return false;
        }
      }

      if (event.ctrlKey && !event.shiftKey && !event.altKey && key === "v") {
        event.preventDefault();
        void clipboardHasImage()
          .then(async (hasImage) => {
            if (hasImage) {
              if (!isClaudeRuntime()) {
                setSessionStatus({
                  tone: "error",
                  message: "Clipboard contains an image. Start Claude Code first, or use Ctrl+Shift+V to paste its path.",
                });
                return;
              }
              await attachClipboardImageToClaude("Attaching clipboard image to Claude Code...");
              return;
            }
            const text = await readClipboardText();
            if (text) {
              setSessionStatus(null);
              updateBuffer(inputBufferRef.current + text.replace(/[\x00-\x1F\x7F-\x9F]/g, ""));
              await writeInput(sessionId, text);
            }
          })
          .catch((error) => setSessionStatus({ tone: "error", message: `Paste failed: ${String(error)}` }));
        return false;
      }

      // Explicit paste-as-path mode for ordinary shells and CLIs. AI sessions
      // use Ctrl+V above to distinguish text paste from Claude's Windows
      // image-attachment shortcut.
      if ((event.ctrlKey && event.shiftKey && key === "v") || (event.shiftKey && event.key === "Insert")) {
        event.preventDefault();
        void readClipboardImage()
          .then(async (imagePath) => {
            if (imagePath) {
              const formatted = imagePath.includes(" ") ? `"${imagePath}"` : imagePath;
              setSessionStatus({ tone: "info", message: `Pasted clipboard image: ${formatted}` });
              updateBuffer(inputBufferRef.current + formatted);
              await writeInput(sessionId, formatted);
              return;
            }
            const text = await readClipboardText();
            if (text) {
              setSessionStatus(null);
              updateBuffer(inputBufferRef.current + text.replace(/[\x00-\x1F\x7F-\x9F]/g, ""));
              await writeInput(sessionId, text);
            }
          })
          .catch((error) => setSessionStatus({ tone: "error", message: `Paste failed: ${String(error)}` }));
        return false;
      }

      if (event.ctrlKey && event.shiftKey && key === "f") {
        setSearchOpen((current) => !current);
        return false;
      }

      if (event.ctrlKey && (event.key === "=" || event.key === "+")) {
        onFontDeltaRef.current(1);
        return false;
      }

      if (event.ctrlKey && event.key === "-") {
        onFontDeltaRef.current(-1);
        return false;
      }

      return true;
    });

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit("resize-observer");
    });
    resizeObserver.observe(containerRef.current);

    scheduleFit("initial-open");
    terminal.focus();

    return () => {
      dataDispose.dispose();
      resizeObserver.disconnect();
      if (fitRafRef.current !== null) {
        cancelAnimationFrame(fitRafRef.current);
        fitRafRef.current = null;
      }
      bindingRef.current?.terminal.dispose();
      bindingRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    const binding = bindingRef.current;
    if (!binding) {
      return;
    }

    binding.terminal.options.cursorStyle = settings.cursorStyle;
    binding.terminal.options.fontFamily = settings.fontFamily;
    binding.terminal.options.fontSize = settings.fontSize;
    binding.terminal.options.lineHeight = settings.lineHeight;
    binding.terminal.options.theme = themeForMode(settings.theme);
    scheduleFit("settings-update");
  }, [sessionId, settings.cursorStyle, settings.fontFamily, settings.fontSize, settings.lineHeight, settings.theme]);

  useEffect(() => {
    if (active && !searchOpen) {
      focusTerminal();
    }
  }, [active, searchOpen]);

  useEffect(() => {
    if (!active || !queuedCommand?.value || queuedCommand.sessionId !== sessionId) {
      return;
    }
    const command = `${queuedCommand.value}\r`;
    updateBuffer("");
    recordCommand(queuedCommand.value);
    void writeInput(sessionId, command);
    focusTerminal();
  }, [active, queuedCommand?.id, sessionId]);

  useEffect(() => {
    if (searchOpen) {
      const frame = requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });

      return () => cancelAnimationFrame(frame);
    }

    bindingRef.current?.searchAddon.clearDecorations();
    setQuery("");
    setSearchStatus(null);
    if (active) {
      focusTerminal();
    }
  }, [active, searchOpen]);

  useEffect(() => {
    let mounted = true;

    const unlistenOutput = listen<OutputEvent>("terminal/output", (event) => {
      if (!mounted || event.payload.sessionId !== sessionId) {
        return;
      }
      setSessionStatus(null);
      bindingRef.current?.terminal.write(event.payload.chunk);
    });

    const unlistenExit = listen<ExitEvent>("terminal/exit", (event) => {
      if (!mounted || event.payload.sessionId !== sessionId) {
        return;
      }
      onSessionStateChangeRef.current?.("exited");
      setSessionStatus(
        event.payload.exitCode === 0
          ? { tone: "info", message: "Session ended cleanly." }
          : { tone: "error", message: `Session ended with exit code ${event.payload.exitCode}.` },
      );
    });

    const unlistenError = listen<ErrorEvent>("terminal/error", (event) => {
      if (!mounted || event.payload.sessionId !== sessionId) {
        return;
      }
      onSessionStateChangeRef.current?.("error");
      setSessionStatus({ tone: "error", message: `Session error: ${event.payload.message}` });
    });

    const unlistenTitle = listen<TitleEvent>("terminal/title", (event) => {
      if (!mounted || event.payload.sessionId !== sessionId || !event.payload.title) {
        return;
      }
      onTitleChangeRef.current(event.payload.title);
    });

    const unlistenCwd = listen<CwdEvent>("terminal/cwd", (event) => {
      if (!mounted || event.payload.sessionId !== sessionId || !event.payload.cwd) {
        return;
      }
      onCwdChangeRef.current?.(event.payload.cwd);
    });

    const unlistenBlock = listen<CommandBlockEvent>("terminal/block", (event) => {
      if (!mounted || event.payload.sessionId !== sessionId) {
        return;
      }
      const blockEvent = event.payload;
      if (blockEvent.phase === "started" && blockEvent.command && isClaudeCommand(blockEvent.command)) {
        setPaneRuntimeMode("claude");
      }
      if (
        blockEvent.phase === "finished" &&
        runtimeModeRef.current === "claude" &&
        profileCategoryRef.current !== "ai"
      ) {
        setPaneRuntimeMode("shell");
      }
      setCommandBlocks((current) => {
        if (blockEvent.phase === "started") {
          const next = [
            ...current,
            {
              id: blockEvent.blockId,
              command: blockEvent.command ?? "",
              output: "",
              cwd: blockEvent.cwd ?? undefined,
              exitCode: null,
              status: "running" as const,
            },
          ];
          return next.slice(-100);
        }
        return current.map((block) => {
          if (block.id !== blockEvent.blockId) {
            return block;
          }
          if (blockEvent.phase === "output") {
            if (block.outputTruncated) {
              return block;
            }
            const nextOutput = block.output + (blockEvent.output ?? "");
            if (nextOutput.length > MAX_COMMAND_BLOCK_OUTPUT) {
              return {
                ...block,
                output: nextOutput.slice(0, MAX_COMMAND_BLOCK_OUTPUT),
                outputTruncated: true,
              };
            }
            return { ...block, output: nextOutput };
          }
          return {
            ...block,
            status: "finished" as const,
            exitCode: blockEvent.exitCode ?? null,
          };
        });
      });
    });

    const unlistenDrop = getCurrentWebview().onDragDropEvent((event) => {
      if (!mounted || !activeRef.current) {
        return;
      }
      if (event.payload.type === "enter" || event.payload.type === "over") {
        nativeDragActiveRef.current = true;
        setIsDragging(true);
        return;
      }
      if (event.payload.type === "leave") {
        nativeDragActiveRef.current = false;
        setIsDragging(false);
        return;
      }
      nativeDragActiveRef.current = false;
      lastNativeDropRef.current = performance.now();
      setIsDragging(false);
      void handleDroppedPaths(event.payload.paths).catch((error) =>
        setSessionStatus({ tone: "error", message: `Drop failed: ${String(error)}` }),
      );
    });

    return () => {
      mounted = false;
      void unlistenOutput.then((fn) => fn());
      void unlistenExit.then((fn) => fn());
      void unlistenError.then((fn) => fn());
      void unlistenTitle.then((fn) => fn());
      void unlistenCwd.then((fn) => fn());
      void unlistenBlock.then((fn) => fn());
      void unlistenDrop.then((fn) => fn());
    };
  }, [sessionId]);

  return (
    <section
      className={`terminal-shell ${active ? "is-active" : ""}`}
      onMouseDown={onActivate}
      onPasteCapture={handlePasteCapture}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="terminal-pane-header">
        <div className="terminal-pane-identity">
          <span className={`terminal-runtime-indicator is-${runtimeMode}`} aria-hidden="true" />
          <strong>{runtimeMode === "claude" ? "Claude" : "Shell"}</strong>
          <span className={`terminal-session-state is-${sessionState}`}>{sessionState}</span>
          <span className="terminal-pane-title" title={paneTitle}>{paneTitle || "Terminal"}</span>
          {cwd && <span className="terminal-pane-cwd" title={cwd}>{cwd}</span>}
        </div>
        <div className="terminal-pane-actions">
          <button
            type="button"
            className={`pane-header-button ${blocksOpen ? "is-active" : ""}`}
            disabled={commandBlocks.length === 0}
            aria-expanded={blocksOpen}
            onClick={() => setBlocksOpen((current) => !current)}
          >
            Blocks <span>{commandBlocks.length}</span>
          </button>
          {canClose && onClose && <button type="button" className="pane-header-close" aria-label={`Close ${paneTitle || "terminal pane"}`} onClick={onClose}>×</button>}
        </div>
      </header>

      <div className={`terminal-pane-body ${blocksOpen && commandBlocks.length > 0 ? "has-blocks-drawer" : ""}`}>
        <div className="terminal-surface">
        {isDragging && (
          <div className="drag-drop-overlay">
            <div className="drop-badge">
              <strong>{runtimeMode === "claude" ? "DROP IMAGE FOR CLAUDE" : "DROP FILE INTO TERMINAL"}</strong>
              <span>
                {runtimeMode === "claude"
                  ? "Drop one PNG, JPG, WebP, GIF, or BMP image to attach it"
                  : "Start Claude Code before dropping an image attachment"}
              </span>
            </div>
          </div>
        )}

        {searchOpen && (
          <>
            <div className="search-strip">
              <input
                ref={searchInputRef}
                value={query}
                placeholder="Search scrollback"
                onChange={(event) => {
                  const nextQuery = event.target.value;
                  setQuery(nextQuery);
                  void runSearch(nextQuery, "next", true);
                }}
                onBlur={() => bindingRef.current?.searchAddon.clearActiveDecoration()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void runSearch(query, event.shiftKey ? "previous" : "next");
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeSearch();
                  }
                }}
              />
              <button
                type="button"
                className="ghost-button"
                disabled={!query.trim()}
                onClick={() => void runSearch(query, "previous")}
              >
                Prev
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={!query.trim()}
                onClick={() => void runSearch(query, "next")}
              >
                Next
              </button>
              <button type="button" className="ghost-button" onClick={closeSearch}>
                Done
              </button>
            </div>

            {searchStatus && <div className="search-feedback">{searchStatus}</div>}
          </>
        )}

        {suggestion && (
          <div className="autosuggest-hint">
            <span className="hint-label">SLATE SUGGESTION</span>
            <span className="hint-matched">{inputBuffer}</span>
            <span className="hint-suffix">{suggestion.completionSuffix}</span>
            <span className="hint-kbd">Press Tab / → to complete</span>
          </div>
        )}

          <div ref={containerRef} className="terminal-host" />
        </div>

        {blocksOpen && commandBlocks.length > 0 && (
          <aside className="command-block-drawer">
            <header className="command-block-drawer-header">
              <div><strong>Command blocks</strong><span>{commandBlocks.length} captured</span></div>
              <button type="button" aria-label="Close command blocks" onClick={() => setBlocksOpen(false)}>×</button>
            </header>
            <div className="command-block-list">
              {[...commandBlocks].reverse().map((block) => {
                const collapsed = collapsedBlocks[block.id] ?? block.status === "finished";
                const cleanOutput = block.output.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "").trim();
                return (
                  <article key={block.id} className={`command-block is-${block.status}`}>
                    <header>
                      <button
                        type="button"
                        className="command-block-collapse"
                        onClick={() => setCollapsedBlocks((current) => ({ ...current, [block.id]: !collapsed }))}
                        aria-label={collapsed ? "Expand command output" : "Collapse command output"}
                      >
                        {collapsed ? "+" : "−"}
                      </button>
                      <code>{block.command || "Command"}</code>
                      <span className={`command-block-result ${block.exitCode === 0 ? "is-success" : block.status === "running" ? "is-running" : "is-error"}`}>
                        {block.status === "running" ? "running" : block.exitCode === null ? "done" : `exit ${block.exitCode}`}
                      </span>
                    </header>
                    {!collapsed && (
                      <>
                        {block.cwd && <div className="command-block-cwd">{block.cwd}</div>}
                        <pre>{cleanOutput || "No output"}</pre>
                        {block.outputTruncated && <div className="command-block-truncated">Output limited to 1,000,000 characters. Full output remains in the terminal scrollback.</div>}
                      </>
                    )}
                    <footer>
                      <button type="button" onClick={() => copyBlockText(block.command, "Command")}>Copy command</button>
                      <button type="button" disabled={!cleanOutput} onClick={() => copyBlockText(cleanOutput, "Output")}>Copy output</button>
                      <button type="button" onClick={() => rerunBlock(block.command)}>Run again</button>
                    </footer>
                  </article>
                );
              })}
            </div>
          </aside>
        )}
      </div>

      {sessionStatus && <div className={`terminal-status is-${sessionStatus.tone}`}><span>{sessionStatus.message}</span><button type="button" aria-label="Dismiss message" onClick={() => setSessionStatus(null)}>×</button></div>}
    </section>
  );
}
