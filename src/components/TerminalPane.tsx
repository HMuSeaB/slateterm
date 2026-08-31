import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { recordCommand } from "../lib/completionEngine";
import {
  clipboardHasImage,
  listDirectory,
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
  FileEntry,
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
  runtimeMode: PaneRuntimeMode;
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

type PathCompletion = {
  basePath: string;
  typedPath: string;
  quote: string;
  directoryOnly: boolean;
  entries: FileEntry[];
};

type PendingPathAttachment = {
  id: string;
  path: string;
  name: string;
  badge: string;
};

const CLAUDE_IMAGE_ATTACH_SEQUENCE = "\x1bv";
const MAX_COMMAND_BLOCK_OUTPUT = 1_000_000;

// 常规字符（含中文等非 ASCII）直接裸写；其余一律加引号，兼容 PowerShell 与 cmd。
// 含 $ 或反引号的路径在 PowerShell 双引号里会被展开，改用单引号（cmd 下极罕见，接受损失）
const SHELL_SAFE_PATH = /^[\p{L}\p{N}_.:\\/-]+$/u;
const SHELL_EXPANDS_IN_QUOTES = /[$`]/;

function formatTerminalPaths(paths: string[]) {
  return paths
    .map((path) => {
      if (SHELL_SAFE_PATH.test(path)) {
        return path;
      }
      if (SHELL_EXPANDS_IN_QUOTES.test(path)) {
        return `'${path.replace(/'/g, "''")}'`;
      }
      return `"${path}"`;
    })
    .join(" ");
}

function pathBaseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function pathBadge(path: string) {
  const name = pathBaseName(path);
  const extension = name.includes(".") ? name.split(".").pop()?.toUpperCase() : undefined;
  if (!extension || extension.length > 4) {
    return "DIR";
  }
  return extension;
}

function createPathAttachment(path: string): PendingPathAttachment {
  return {
    id: `${path.toLowerCase()}-${crypto.randomUUID()}`,
    path,
    name: pathBaseName(path),
    badge: pathBadge(path),
  };
}

function detectedImageExtension(bytes: Uint8Array) {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") {
      return "gif";
    }
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    if (riff === "RIFF" && webp === "WEBP") {
      return "webp";
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "bmp";
  }
  return null;
}

function imageMimeType(extension: string) {
  if (extension === "jpeg") return "image/jpeg";
  return `image/${extension}`;
}

function isClaudeCommand(command: string) {
  const normalized = command.trim().toLowerCase();
  return /(?:^|[;&|]\s*)(?:&\s*)?(?:claude(?:\.cmd|\.exe)?|["'][^"']*[\\/]claude(?:\.cmd|\.exe)?["'])(?:\s|$)/.test(
    normalized,
  );
}

function buildPathQuery(typedPath: string, quote: string, cwd?: string) {
  const normalized = typedPath.replace(/\//g, "\\");
  const separator = normalized.lastIndexOf("\\");
  const directoryPart = separator >= 0 ? normalized.slice(0, separator + 1) : "";
  const namePart = separator >= 0 ? normalized.slice(separator + 1) : normalized;
  const absolute = /^[a-zA-Z]:\\/.test(normalized) || normalized.startsWith("\\\\");
  const baseRoot = absolute ? "" : `${cwd || ""}${cwd && directoryPart ? "\\" : ""}`;
  const basePath = `${baseRoot}${directoryPart}`.replace(/[\\]+$/, "") || (absolute ? normalized.slice(0, 3) : cwd || "");
  if (!basePath) return null;
  return { basePath, namePart, quote, typedPath };
}

function parsePathArgument(command: string, cwd?: string) {
  // cd 只接受目录，保持原有行为
  const cdMatch = command.match(/^\s*cd(?:\s+|$)(["']?)([^"']*)$/i);
  if (cdMatch) {
    const parsed = buildPathQuery(cdMatch[2], cdMatch[1], cwd);
    return parsed ? { ...parsed, directoryOnly: true } : null;
  }

  // 其他命令：最后一个词是带路径分隔符的裸 token 时才补全，文件与目录都列出；
  // 含引号的 token 交给 shell 原生补全处理，避免影子缓冲对不上
  const tokens = command.split(/\s+/);
  if (tokens.length < 2) return null;
  const token = tokens[tokens.length - 1];
  if (!/[\\/]/.test(token) || /["']/.test(token)) return null;
  const parsed = buildPathQuery(token, "", cwd);
  return parsed ? { ...parsed, directoryOnly: false } : null;
}

function completionValue(entry: FileEntry, completion: PathCompletion) {
  const separator = Math.max(completion.typedPath.lastIndexOf("\\"), completion.typedPath.lastIndexOf("/"));
  const prefix = separator >= 0 ? completion.typedPath.slice(0, separator + 1) : "";
  const value = `${prefix}${entry.name}${entry.isDirectory ? "\\" : ""}`;
  return `${completion.quote}${value}`;
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
  runtimeMode: persistedRuntimeMode,
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
  const [sessionStatus, setSessionStatusState] = useState<StatusBanner | null>(null);
  const [blocksOpen, setBlocksOpen] = useState(false);
  const [commandBlocks, setCommandBlocks] = useState<CommandBlock[]>([]);
  const [collapsedBlocks, setCollapsedBlocks] = useState<Record<string, boolean>>({});
  const [pathCompletion, setPathCompletion] = useState<PathCompletion | null>(null);
  const [pathCompletionIndex, setPathCompletionIndex] = useState(0);
  const [pendingPathAttachments, setPendingPathAttachments] = useState<PendingPathAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [dragPaths, setDragPaths] = useState<string[]>([]);
  const [runtimeMode, setRuntimeMode] = useState<PaneRuntimeMode>(persistedRuntimeMode);
  const pathCompletionRef = useRef<PathCompletion | null>(null);
  const pathCompletionIndexRef = useRef(0);
  const pathCompletionRequestRef = useRef(0);
  const inputBufferRef = useRef("");
  const pendingPathAttachmentsRef = useRef<PendingPathAttachment[]>([]);
  const cwdRef = useRef(cwd);
  const activeRef = useRef(active);
  const pointerInsideRef = useRef(false);
  const nativeDragTargetRef = useRef(false);
  const profileCategoryRef = useRef(profileCategory);
  const runtimeModeRef = useRef<PaneRuntimeMode>(persistedRuntimeMode);
  const nativeDragActiveRef = useRef(false);
  const lastNativeDropRef = useRef(0);
  const sessionStatusTimerRef = useRef<number | null>(null);

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
    cwdRef.current = cwd;
  }, [cwd]);

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
  }, [profileCategory]);

  useEffect(() => {
    runtimeModeRef.current = persistedRuntimeMode;
    setRuntimeMode(persistedRuntimeMode);
  }, [persistedRuntimeMode]);

  function setPaneRuntimeMode(mode: PaneRuntimeMode) {
    runtimeModeRef.current = mode;
    setRuntimeMode(mode);
    onRuntimeModeChangeRef.current?.(mode);
  }

  function setSessionStatus(status: StatusBanner | null) {
    if (sessionStatusTimerRef.current !== null) {
      window.clearTimeout(sessionStatusTimerRef.current);
      sessionStatusTimerRef.current = null;
    }

    setSessionStatusState(status);
    if (!status) {
      return;
    }

    const duration = status.tone === "error" ? 10_000 : 3_000;
    sessionStatusTimerRef.current = window.setTimeout(() => {
      sessionStatusTimerRef.current = null;
      setSessionStatusState((current) => (
        current === status ? null : current
      ));
    }, duration);
  }

  function clearTransientStatus() {
    setSessionStatusState((current) => (
      current?.tone === "info" ? null : current
    ));
  }

  function isClaudeRuntime() {
    return profileCategoryRef.current === "ai" || runtimeModeRef.current === "claude";
  }

  function focusTerminal() {
    bindingRef.current?.terminal.focus();
  }

  function updatePendingPathAttachments(nextAttachments: PendingPathAttachment[]) {
    pendingPathAttachmentsRef.current = nextAttachments;
    setPendingPathAttachments(nextAttachments);
  }

  function queueClaudePathAttachments(paths: string[]) {
    const current = pendingPathAttachmentsRef.current;
    const existingPaths = new Set(current.map((attachment) => attachment.path.toLowerCase()));
    const additions = paths
      .filter((path) => !existingPaths.has(path.toLowerCase()))
      .map(createPathAttachment);
    if (additions.length === 0) {
      setSessionStatus({ tone: "info", message: "这些路径已经在附件里了。" });
      return;
    }
    updatePendingPathAttachments([...current, ...additions]);
    setSessionStatus({
      tone: "info",
      message: `已附加 ${additions.length} 个路径，回车随消息发送给 Claude。`,
    });
  }

  function removePendingPathAttachment(id: string) {
    updatePendingPathAttachments(
      pendingPathAttachmentsRef.current.filter((attachment) => attachment.id !== id),
    );
    focusTerminal();
  }

  function clearPendingPathAttachments() {
    updatePendingPathAttachments([]);
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

  function setCompletion(completion: PathCompletion | null, index = 0) {
    pathCompletionRef.current = completion;
    pathCompletionIndexRef.current = index;
    setPathCompletion(completion);
    setPathCompletionIndex(index);
  }

  function updateBuffer(nextVal: string) {
    inputBufferRef.current = nextVal;

    const requestId = ++pathCompletionRequestRef.current;
    if (isClaudeRuntime()) {
      setCompletion(null);
      return;
    }
    const parsed = parsePathArgument(nextVal, cwdRef.current);
    if (!parsed) {
      setCompletion(null);
      return;
    }
    void listDirectory(parsed.basePath)
      .then((items) => {
        if (requestId !== pathCompletionRequestRef.current) return;
        const namePrefix = parsed.namePart.toLowerCase();
        const matching = items.filter((entry) =>
          parsed.directoryOnly
            ? entry.isDirectory && entry.name.toLowerCase().startsWith(namePrefix)
            : entry.name.toLowerCase().startsWith(namePrefix),
        );
        matching.sort((a, b) =>
          Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
        );
        const entries = matching.slice(0, 8);
        setCompletion(
          entries.length > 0
            ? { basePath: parsed.basePath, typedPath: parsed.typedPath, quote: parsed.quote, directoryOnly: parsed.directoryOnly, entries }
            : null,
        );
      })
      .catch(() => {
        if (requestId === pathCompletionRequestRef.current) setCompletion(null);
      });
  }

  function acceptPathCompletion(entry: FileEntry) {
    const completion = pathCompletionRef.current;
    if (!completion) return;
    const currentArgument = `${completion.quote}${completion.typedPath}`;
    const nextArgument = completionValue(entry, completion);
    const suffix = nextArgument.slice(currentArgument.length);
    void writeInput(sessionId, suffix);
    updateBuffer(inputBufferRef.current + suffix);
    focusTerminal();
  }

  async function attachClipboardImageToClaude(message = "正在把图片附加给 Claude Code...") {
    setSessionStatus({ tone: "info", message });
    await writeInput(sessionId, CLAUDE_IMAGE_ATTACH_SEQUENCE);
    await new Promise((resolve) => window.setTimeout(resolve, 160));
  }

  async function prepareDroppedImage(path: string) {
    let bytes: Uint8Array;
    try {
      bytes = await readImageFile(path);
    } catch {
      return false;
    }
    const extension = detectedImageExtension(bytes);
    if (!extension) {
      return false;
    }
    try {
      const sourceBytes = new Uint8Array(bytes.byteLength);
      sourceBytes.set(bytes);
      const sourceBlob = new Blob([sourceBytes.buffer], { type: imageMimeType(extension) });
      const pngBytes = await imageBlobToPngBytes(sourceBlob);
      const imagePath = await saveTempImage(pngBytes, "png");
      await writeClipboardImageFile(imagePath);
      return true;
    } catch (error) {
      throw new Error(`Could not decode ${pathBaseName(path)} as an image: ${String(error)}`);
    }
  }

  async function handleDroppedPaths(paths: string[]) {
    if (paths.length === 0) {
      return;
    }

    if (isClaudeRuntime()) {
      const regularPaths: string[] = [];
      for (const path of paths) {
        let attachedAsImage = false;
        try {
          attachedAsImage = await prepareDroppedImage(path);
        } catch (error) {
          setSessionStatus({ tone: "error", message: `图片附加失败：${String(error)}` });
          continue;
        }
        if (attachedAsImage) {
          await attachClipboardImageToClaude(`正在把 ${pathBaseName(path)} 附加给 Claude Code...`);
          continue;
        }
        regularPaths.push(path);
      }
      if (regularPaths.length > 0) {
        queueClaudePathAttachments(regularPaths);
      }
      focusTerminal();
      return;
    }

    const formattedPaths = formatTerminalPaths(paths);
    setSessionStatus({ tone: "info", message: `已插入路径：${formattedPaths}` });
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
        await attachClipboardImageToClaude("正在把剪贴板图片附加给 Claude Code...");
        return;
      }
      if (imageFile) {
        if (!isClaudeRuntime()) {
          throw new Error("Start Claude Code before attaching a clipboard image.");
        }
        const pngBytes = await imageBlobToPngBytes(imageFile);
        const imagePath = await saveTempImage(pngBytes, "png");
        await writeClipboardImageFile(imagePath);
        await attachClipboardImageToClaude("正在把粘贴的图片附加给 Claude Code...");
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
    setDragPaths([]);
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
      setSessionStatus({ tone: "error", message: `拖放失败：${String(error)}` }),
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
      clearTransientStatus();

      if ((data === "\r" || data === "\n") && isClaudeRuntime() && pendingPathAttachmentsRef.current.length > 0) {
        const attachmentText = formatTerminalPaths(
          pendingPathAttachmentsRef.current.map((attachment) => attachment.path),
        );
        const separator = inputBufferRef.current.trim() ? " " : "";
        void writeInput(sessionId, `${separator}${attachmentText}\r`);
        clearPendingPathAttachments();
        updateBuffer("");
        return;
      }

      if (
        (data === "\x7f" || data === "\x08")
        && !inputBufferRef.current
        && pendingPathAttachmentsRef.current.length > 0
      ) {
        updatePendingPathAttachments(pendingPathAttachmentsRef.current.slice(0, -1));
        return;
      }

      void writeInput(sessionId, data);

      if (data === "\r" || data === "\n") {
        // 只把 shell 会话的输入记进命令历史；Claude 对话内容不算命令
        if (inputBufferRef.current.trim() && !isClaudeRuntime()) {
          recordCommand(inputBufferRef.current);
        }
        updateBuffer("");
      } else if (data === "\x7f" || data === "\x08") {
        updateBuffer(inputBufferRef.current.slice(0, -1));
      } else if (data === "\x03" || data === "\x15") {
        clearPendingPathAttachments();
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
      const activePathCompletion = pathCompletionRef.current;

      if (activePathCompletion) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          const nextIndex = (pathCompletionIndexRef.current + direction + activePathCompletion.entries.length) % activePathCompletion.entries.length;
          pathCompletionIndexRef.current = nextIndex;
          setPathCompletionIndex(nextIndex);
          return false;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          acceptPathCompletion(activePathCompletion.entries[pathCompletionIndexRef.current]);
          return false;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setCompletion(null);
          return false;
        }
      }

      if ((event.ctrlKey && !event.shiftKey && key === "c" && hasSelection) || (event.ctrlKey && event.shiftKey && key === "c")) {
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
      if (sessionStatusTimerRef.current !== null) {
        window.clearTimeout(sessionStatusTimerRef.current);
        sessionStatusTimerRef.current = null;
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
      clearTransientStatus();
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

    const webview = getCurrentWebview();

    function isNativeDragTarget(position: { x: number; y: number }) {
      const container = containerRef.current?.closest<HTMLElement>(".terminal-shell");
      if (!container) {
        return activeRef.current;
      }
      // 实时读取：devicePixelRatio 会随窗口所在显示器更新，跨屏拖拽不会用到过期的缩放比
      const scaleFactor = window.devicePixelRatio || 1;
      const logicalPosition = {
        x: position.x / scaleFactor,
        y: position.y / scaleFactor,
      };
      const rect = container.getBoundingClientRect();
      return (
        logicalPosition.x >= rect.left
        && logicalPosition.x <= rect.right
        && logicalPosition.y >= rect.top
        && logicalPosition.y <= rect.bottom
      );
    }

    const unlistenDrop = webview.onDragDropEvent((event) => {
      if (!mounted) {
        return;
      }
      if (event.payload.type === "enter" || event.payload.type === "over") {
        if (event.payload.type === "enter") {
          setDragPaths(event.payload.paths);
        }
        const isTarget = isNativeDragTarget(event.payload.position);
        nativeDragTargetRef.current = isTarget;
        nativeDragActiveRef.current = isTarget;
        setIsDragging(isTarget);
        return;
      }
      if (event.payload.type === "leave") {
        nativeDragTargetRef.current = false;
        nativeDragActiveRef.current = false;
        setIsDragging(false);
        setDragPaths([]);
        return;
      }

      const isTarget = isNativeDragTarget(event.payload.position)
        || nativeDragTargetRef.current
        || (activeRef.current && pointerInsideRef.current);
      nativeDragTargetRef.current = false;
      nativeDragActiveRef.current = false;
      setIsDragging(false);
      setDragPaths([]);
      if (!isTarget) {
        return;
      }
      lastNativeDropRef.current = performance.now();
      onActivate();
      void handleDroppedPaths(event.payload.paths).catch((error) =>
        setSessionStatus({ tone: "error", message: `拖放失败：${String(error)}` }),
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

  const claudeLikeDrop = runtimeMode === "claude" || profileCategory === "ai";

  return (
    <section
      className={`terminal-shell ${active ? "is-active" : ""}`}
      onMouseDown={onActivate}
      onPointerEnter={() => {
        pointerInsideRef.current = true;
      }}
      onPointerLeave={() => {
        pointerInsideRef.current = false;
      }}
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
        <div className={`terminal-surface ${pendingPathAttachments.length > 0 ? "has-path-attachments" : ""}`}>
        {isDragging && (
          <div className="drag-drop-overlay">
            <div className="drop-badge">
              <strong>{claudeLikeDrop ? "附加到 Claude" : "插入到终端"}</strong>
              {dragPaths.length > 0 && (
                <div className="drop-badge-files">
                  {dragPaths.slice(0, 3).map((path) => (
                    <span key={path} title={path}>{pathBaseName(path)}</span>
                  ))}
                  {dragPaths.length > 3 && <span className="drop-badge-more">+{dragPaths.length - 3}</span>}
                </div>
              )}
              <span className="drop-badge-hint">
                {claudeLikeDrop
                  ? "图片转为图片附件，其他文件与文件夹作为路径附件"
                  : "插入自动加引号的绝对路径，不会回车执行"}
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

        {pathCompletion && (
          <div className="path-completion-popover">
            <header><span>PATHS</span><small>↑↓ choose · Tab insert · Esc close</small></header>
            <div className="path-completion-list">
              {pathCompletion.entries.map((entry, index) => (
                <button
                  key={entry.path}
                  type="button"
                  className={index === pathCompletionIndex ? "is-active" : ""}
                  title={entry.path}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => acceptPathCompletion(entry)}
                  onMouseEnter={() => {
                    pathCompletionIndexRef.current = index;
                    setPathCompletionIndex(index);
                  }}
                >
                  <span>›</span><strong>{entry.name}</strong><small>{entry.path}</small>
                </button>
              ))}
            </div>
          </div>
        )}

          <div ref={containerRef} className="terminal-host" />

          {pendingPathAttachments.length > 0 && (
            <div className="claude-path-attachments" aria-label="等待随下一条消息发送的路径附件">
              <div className="claude-path-attachment-list">
                {pendingPathAttachments.map((attachment) => (
                  <div key={attachment.id} className="claude-path-attachment" title={attachment.path}>
                    <span className="claude-path-attachment-icon" aria-hidden="true">{attachment.badge}</span>
                    <span className="claude-path-attachment-copy">
                      <strong>{attachment.name}</strong>
                      <small>{attachment.path}</small>
                    </span>
                    <button
                      type="button"
                      aria-label={`移除 ${attachment.name}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => removePendingPathAttachment(attachment.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <div className="claude-path-attachment-hint">
                <span>已附加 {pendingPathAttachments.length} 个</span>
                <span>回车随消息发送 · 空输入时 Backspace 撤销一个 · Ctrl+C 清空</span>
              </div>
            </div>
          )}
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
