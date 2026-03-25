import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { resizeSession, writeInput } from "../lib/tauri";
import type { ErrorEvent, ExitEvent, OutputEvent, Settings, TitleEvent } from "../lib/types";

type Props = {
  sessionId: string;
  settings: Settings;
  active: boolean;
  onActivate: () => void;
  onTitleChange: (title: string) => void;
  onFontDelta: (delta: number) => void;
};

type TerminalBinding = {
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  lastCols: number;
  lastRows: number;
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
  onFontDelta,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<TerminalBinding | null>(null);
  const fitRafRef = useRef<number | null>(null);
  const onFontDeltaRef = useRef(onFontDelta);
  const onTitleChangeRef = useRef(onTitleChange);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    onFontDeltaRef.current = onFontDelta;
  }, [onFontDelta]);

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

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
    const webLinksAddon = new WebLinksAddon();

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
      void writeInput(sessionId, data);
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }

      const key = event.key.toLowerCase();
      const hasSelection = terminal.hasSelection();

      if (event.ctrlKey && !event.shiftKey && key === "c" && hasSelection) {
        const selectedText = terminal.getSelection();
        if (selectedText) {
          void navigator.clipboard.writeText(selectedText);
          terminal.clearSelection();
          return false;
        }
      }

      if (event.ctrlKey && event.shiftKey && key === "c") {
        const selectedText = terminal.getSelection();
        if (selectedText) {
          void navigator.clipboard.writeText(selectedText);
          terminal.clearSelection();
          return false;
        }
      }

      if (event.ctrlKey && event.shiftKey && key === "v") {
        void navigator.clipboard.readText().then((text) => {
          if (text) {
            void writeInput(sessionId, text);
          }
        });
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
    if (active) {
      bindingRef.current?.terminal.focus();
    }
  }, [active]);

  useEffect(() => {
    let mounted = true;

    const unlistenOutput = listen<OutputEvent>("terminal/output", (event) => {
      if (!mounted || event.payload.sessionId !== sessionId) {
        return;
      }
      bindingRef.current?.terminal.write(event.payload.chunk);
    });

    const unlistenExit = listen<ExitEvent>("terminal/exit", (event) => {
      if (!mounted || event.payload.sessionId !== sessionId) {
        return;
      }
      setStatus(`Session exited (${event.payload.exitCode})`);
    });

    const unlistenError = listen<ErrorEvent>("terminal/error", (event) => {
      if (!mounted || event.payload.sessionId !== sessionId) {
        return;
      }
      setStatus(event.payload.message);
    });

    const unlistenTitle = listen<TitleEvent>("terminal/title", (event) => {
      if (!mounted || event.payload.sessionId !== sessionId || !event.payload.title) {
        return;
      }
      onTitleChangeRef.current(event.payload.title);
    });

    return () => {
      mounted = false;
      void unlistenOutput.then((fn) => fn());
      void unlistenExit.then((fn) => fn());
      void unlistenError.then((fn) => fn());
      void unlistenTitle.then((fn) => fn());
    };
  }, [sessionId]);

  useEffect(() => {
    if (!searchOpen) {
      setQuery("");
    }
  }, [searchOpen]);

  return (
    <section className={`terminal-shell ${active ? "is-active" : ""}`} onMouseDown={onActivate}>
      <div className="terminal-surface">
        {searchOpen && (
          <div className="search-strip">
            <input
              autoFocus
              value={query}
              placeholder="Search scrollback"
              onChange={(event) => {
                const nextQuery = event.target.value;
                setQuery(nextQuery);
                bindingRef.current?.searchAddon.findNext(nextQuery);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  bindingRef.current?.searchAddon.findNext(query, {
                    incremental: true,
                    caseSensitive: false,
                  });
                }
                if (event.key === "Escape") {
                  setSearchOpen(false);
                }
              }}
            />
            <button
              type="button"
              className="ghost-button"
              onClick={() => bindingRef.current?.searchAddon.findPrevious(query)}
            >
              Prev
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => bindingRef.current?.searchAddon.findNext(query)}
            >
              Next
            </button>
          </div>
        )}

        <div
          ref={containerRef}
          className="terminal-host"
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (text) {
              event.preventDefault();
              void writeInput(sessionId, text);
            }
          }}
        />
      </div>

      {status && <div className="terminal-status">{status}</div>}
    </section>
  );
}
