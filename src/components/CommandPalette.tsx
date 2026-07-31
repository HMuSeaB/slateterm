import { useEffect, useMemo, useRef, useState } from "react";

export type PaletteCommand = {
  id: string;
  label: string;
  description: string;
  shortcut?: string;
  keywords?: string;
  run: () => void;
};

type Props = {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
};

export default function CommandPalette({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) => `${command.label} ${command.description} ${command.keywords || ""}`.toLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  const execute = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  return (
    <div className="command-overlay" onMouseDown={onClose}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Commands" onMouseDown={(event) => event.stopPropagation()}>
        <div className="command-input-row">
          <span>›</span>
          <input
            ref={inputRef}
            value={query}
            placeholder="Search commands, profiles, and workspaces"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((current) => Math.min(current + 1, filtered.length - 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => Math.max(current - 1, 0)); }
              if (event.key === "Enter") { event.preventDefault(); execute(filtered[activeIndex]); }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="command-results">
          {filtered.length === 0 ? <div className="command-empty">No matching commands</div> : filtered.map((command, index) => (
            <button key={command.id} type="button" className={index === activeIndex ? "is-active" : ""} onMouseEnter={() => setActiveIndex(index)} onClick={() => execute(command)}>
              <span><strong>{command.label}</strong><small>{command.description}</small></span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
