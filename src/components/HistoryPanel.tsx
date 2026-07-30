import { useEffect, useMemo, useRef, useState } from "react";
import { clearHistory, getHistory, searchHistory } from "../lib/completionEngine";
import { writeClipboardText } from "../lib/tauri";

type Props = {
  open: boolean;
  onClose: () => void;
  onRun: (command: string) => void;
};

export default function HistoryPanel({ open, onClose, onRun }: Props) {
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const commands = useMemo(() => searchHistory(query), [query, revision]);

  useEffect(() => {
    const update = () => setRevision((current) => current + 1);
    window.addEventListener("slateterm:history-change", update);
    return () => window.removeEventListener("slateterm:history-change", update);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setRevision(getHistory().length);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  return (
    <div className="command-overlay" onMouseDown={onClose}>
      <section className="history-panel" onMouseDown={(event) => event.stopPropagation()}>
        <div className="history-header">
          <div><strong>Command history</strong><span>{commands.length} commands</span></div>
          <div><button type="button" onClick={() => clearHistory()}>Clear</button><button type="button" onClick={onClose}>Close</button></div>
        </div>
        <input ref={inputRef} value={query} placeholder="Search command history" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} />
        <div className="history-list">
          {commands.length === 0 ? <div className="command-empty">No command history yet</div> : commands.map((command, index) => (
            <div key={`${command}-${index}`} className="history-row">
              <code>{command}</code>
              <div><button type="button" onClick={() => void writeClipboardText(command)}>Copy</button><button type="button" onClick={() => { onClose(); onRun(command); }}>Run</button></div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
