import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { getSuggestion, recordCommand, type SuggestionResult } from "../lib/completionEngine";
import { openExternalUrl, readClipboardText, resizeSession, saveTempImage, writeClipboardText, writeInput } from "../lib/tauri";
import type {
  CommandBlock,
  CommandBlockEvent,
  CwdEvent,
  ErrorEvent,
  ExitEvent,
  OutputEvent,
  Settings,
  TitleEvent,
} from "../lib/types";

type Props = {
  sessionId: string;
  settings: Settings;
  active: boolean;
  onActivate: () => void;
  onTitleChange: (title: string) => void;
  onCwdChange?: (cwd: string) => void;
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
  active,
  onActivate,
  onTitleChange,
  onCwdChange,
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

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<StatusBanner | null>(null);
  const [blocksOpen, setBlocksOpen] = useState(true);
  const [commandBlocks, setCommandBlocks] = useState<CommandBlock[]>([]);
  const [collapsedBlocks, setCollapsedBlocks] = useState<Record<string, boolean>>({});

  const [inputBuffer, setInputBuffer] = useState("");
  const [suggestion, setSuggestion] = useState<SuggestionResult | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const suggestionRef = useRef<SuggestionResult | null>(null);
  const inputBufferRef = useRef("");

  useEffect(() => {
    onFontDeltaRef.current = onFontDelta;
  }, [onFontDelta]);

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  useEffect(() => {
    onCwdChangeRef.current = onCwdChange;
  }, [onCwdChange]);

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

  async function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    const items = event.clipboardData.items;
    let imageItem: DataTransferItem | null = null;

    if (items && items.length > 0) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          imageItem = items[i];
          break;
        }
      }
    }

    if (imageItem) {
      event.preventDefault();
      const blob = imageItem.getAsFile();
      if (blob) {
        try {
          const arrayBuffer = await blob.arrayBuffer();
          const savedPath = await saveTempImage(new Uint8Array(arrayBuffer));
          const formatted = savedPath.includes(" ") ? `"${savedPath}"` : savedPath;
          setSessionStatus({ tone: "info", message: `Pasted image path: ${formatted}` });
          updateBuffer(inputBufferRef.current + formatted);
          void writeInput(sessionId, formatted);
          return;
        } catch (err) {
          console.error("Failed to save pasted image", err);
        }
      }
    }

    const text = event.clipboardData.getData("text");
    if (text) {
      event.preventDefault();
      setSessionStatus(null);
      const printable = text.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
      if (printable) {
        updateBuffer(inputBufferRef.current + printable);
      }
      void writeInput(sessionId, text);
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!isDragging) setIsDragging(true);
  }

  function handleDragLeave() {
    setIsDragging(false);
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      const paths = files
        .map((f) => {
          const path = (f as any).path || f.name;
          return path.includes(" ") ? `"${path}"` : path;
        })
        .join(" ");
      setSessionStatus({ tone: "info", message: `Pasted path: ${paths}` });
      updateBuffer(inputBufferRef.current + paths);
      void writeInput(sessionId, paths);
    }
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

      if ((event.ctrlKey && event.shiftKey && key === "v") || (event.shiftKey && event.key === "Insert")) {
        void readClipboardText()
          .then((text) => {
            if (text) {
              setSessionStatus(null);
              updateBuffer(inputBufferRef.current + text.replace(/[\x00-\x1F\x7F-\x9F]/g, ""));
              void writeInput(sessionId, text);
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
            return { ...block, output: block.output + (blockEvent.output ?? "") };
          }
          return {
            ...block,
            status: "finished" as const,
            exitCode: blockEvent.exitCode ?? null,
          };
        });
      });
    });

    const unlistenDrop = listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
      if (!mounted || !event.payload.paths || event.payload.paths.length === 0) {
        return;
      }
      setIsDragging(false);
      const formattedPaths = event.payload.paths
        .map((p) => (p.includes(" ") ? `"${p}"` : p))
        .join(" ");
      setSessionStatus({ tone: "info", message: `Pasted path: ${formattedPaths}` });
      updateBuffer(inputBufferRef.current + formattedPaths);
      void writeInput(sessionId, formattedPaths);
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
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="terminal-surface" onPaste={handlePaste}>
        {isDragging && (
          <div className="drag-drop-overlay">
            <div className="drop-badge">
              <strong>DROP FILE OR IMAGE HERE</strong>
              <span>Path will be pasted into terminal</span>
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
            <span className="hint-label">WARP AUTO-COMPLETION</span>
            <span className="hint-matched">{inputBuffer}</span>
            <span className="hint-suffix">{suggestion.completionSuffix}</span>
            <span className="hint-kbd">Press Tab / → to complete</span>
          </div>
        )}

        {commandBlocks.length > 0 && (
          <aside className={`command-block-drawer ${blocksOpen ? "is-open" : ""}`}>
            <button type="button" className="command-block-toggle" onClick={() => setBlocksOpen((current) => !current)}>
              <span>Blocks</span>
              <strong>{commandBlocks.length}</strong>
            </button>
            {blocksOpen && (
              <div className="command-block-list">
                {commandBlocks.map((block) => {
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
            )}
          </aside>
        )}

        <div ref={containerRef} className="terminal-host" />
      </div>

      {sessionStatus && <div className={`terminal-status is-${sessionStatus.tone}`}>{sessionStatus.message}</div>}
    </section>
  );
}
