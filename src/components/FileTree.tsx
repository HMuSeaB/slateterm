import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { listDirectory, revealInFileExplorer } from "../lib/tauri";
import type { FileEntry } from "../lib/types";

type Props = {
  root: string;
  selectedPath?: string | null;
  onSelectFile: (path: string) => void;
  onSelectDirectory: (path: string) => void;
  onOpenTerminal: (path: string) => void;
};

type NodeProps = Props & {
  entry: FileEntry;
  depth: number;
  onOpenContextMenu: (entry: FileEntry, x: number, y: number) => void;
};

type ContextMenuState = {
  entry: FileEntry;
  x: number;
  y: number;
};

function parentDirectory(path: string) {
  const normalized = path.replace(/[\\/]+$/, "");
  const separator = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return separator > 2 ? normalized.slice(0, separator) : normalized.slice(0, separator + 1);
}

type FileIconKind = "folder" | "code" | "data" | "document" | "image" | "archive" | "config" | "file";

function fileIconKind(entry: FileEntry): FileIconKind {
  if (entry.isDirectory) return "folder";
  const name = entry.name.toLowerCase();
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
  if (["ts", "tsx", "js", "jsx", "rs", "py", "go", "java", "c", "cpp", "h", "css", "html", "vue", "svelte"].includes(extension)) return "code";
  if (["json", "jsonc", "csv", "tsv", "xml", "sql"].includes(extension)) return "data";
  if (["md", "mdx", "txt", "pdf", "doc", "docx", "rtf"].includes(extension)) return "document";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"].includes(extension)) return "image";
  if (["zip", "7z", "rar", "tar", "gz", "bz2"].includes(extension)) return "archive";
  if (["toml", "yaml", "yml", "ini", "env", "lock"].includes(extension) || name.startsWith(".")) return "config";
  return "file";
}

function FileTypeIcon({ entry, open }: { entry: FileEntry; open: boolean }) {
  const kind = fileIconKind(entry);
  return (
    <span className={`file-tree-entry-icon is-${kind} ${open ? "is-open" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 18 18" focusable="false">
        {kind === "folder" && <path d="M2.5 5.2c0-.9.7-1.6 1.6-1.6h3l1.45 1.7h5.35c.9 0 1.6.7 1.6 1.6v6.2c0 .9-.7 1.6-1.6 1.6H4.1c-.9 0-1.6-.7-1.6-1.6Z" />}
        {kind === "code" && <><path d="M6.6 5.2 3.3 9l3.3 3.8M11.4 5.2 14.7 9l-3.3 3.8" /><path d="m10.2 3.8-2.4 10.4" /></>}
        {kind === "data" && <><ellipse cx="9" cy="4.8" rx="5.2" ry="2.1" /><path d="M3.8 4.8v4.1C3.8 10.1 6.1 11 9 11s5.2-.9 5.2-2.1V4.8M3.8 8.9V13c0 1.2 2.3 2.1 5.2 2.1s5.2-.9 5.2-2.1V8.9" /></>}
        {kind === "document" && <><path d="M4.2 2.7h6l3.6 3.6v9H4.2Z" /><path d="M10.2 2.7v3.6h3.6M6.5 9.3h5M6.5 12h4" /></>}
        {kind === "image" && <><rect x="2.8" y="3.1" width="12.4" height="11.8" rx="2" /><circle cx="6.4" cy="6.8" r="1.2" /><path d="m4.4 13 3.2-3.4 2.2 2 1.7-1.8 2.1 3.2" /></>}
        {kind === "archive" && <><path d="M4.2 2.7h9.6v12.6H4.2Z" /><path d="M7.1 2.7v2.1h2V6.9h-2V9h2v2.1h-2v2.2" /></>}
        {kind === "config" && <><circle cx="9" cy="9" r="2.3" /><path d="M9 2.7v1.5M9 13.8v1.5M2.7 9h1.5M13.8 9h1.5M4.55 4.55l1.1 1.1M12.35 12.35l1.1 1.1M13.45 4.55l-1.1 1.1M5.65 12.35l-1.1 1.1" /></>}
        {kind === "file" && <><path d="M4.2 2.7h6l3.6 3.6v9H4.2Z" /><path d="M10.2 2.7v3.6h3.6" /></>}
      </svg>
    </span>
  );
}

function FileNode({
  entry,
  depth,
  selectedPath,
  onSelectFile,
  onSelectDirectory,
  onOpenTerminal,
  onOpenContextMenu,
}: NodeProps) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadChildren() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      setChildren(await listDirectory(entry.path));
      setLoaded(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }

  async function toggleDirectory() {
    if (!entry.isDirectory) {
      onSelectFile(entry.path);
      return;
    }
    onSelectDirectory(entry.path);
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!loaded) {
      await loadChildren();
    }
  }

  return (
    <div className={`file-tree-node ${depth > 0 ? "is-nested" : ""}`} style={{ "--tree-depth": depth } as CSSProperties}>
      <button
        type="button"
        className={`file-tree-row ${selectedPath === entry.path ? "is-selected" : ""}`}
        style={{ paddingLeft: `${10 + depth * 16}px` }}
        title={entry.path}
        onClick={() => void toggleDirectory()}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenContextMenu(entry, event.clientX, event.clientY);
        }}
      >
        <span
          className={`file-tree-chevron ${entry.isDirectory ? "is-directory" : "is-placeholder"} ${open ? "is-open" : ""} ${loading ? "is-loading" : ""}`}
          aria-hidden="true"
        >
          {entry.isDirectory && (
            <svg viewBox="0 0 16 16" focusable="false">
              <path d="M5.75 3.75 10 8l-4.25 4.25" />
            </svg>
          )}
        </span>
        <FileTypeIcon entry={entry} open={open} />
        <span className={entry.isDirectory ? "file-tree-folder" : "file-tree-file"}>{entry.name}</span>
      </button>
      {open && loading && (
        <div className="file-tree-loading" style={{ paddingLeft: `${46 + depth * 16}px` }}>
          Reading folder…
        </div>
      )}
      {open && !loading && loaded && children.length === 0 && (
        <div className="file-tree-empty-node" style={{ paddingLeft: `${46 + depth * 16}px` }}>
          Empty folder
        </div>
      )}
      {open && children.map((child) => (
        <FileNode
          key={child.path}
          root={entry.path}
          entry={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          onSelectDirectory={onSelectDirectory}
          onOpenTerminal={onOpenTerminal}
          onOpenContextMenu={onOpenContextMenu}
        />
      ))}
      {open && error && (
        <div className="file-tree-error" style={{ paddingLeft: `${46 + depth * 16}px` }}>
          <span>Could not read folder</span>
          <button type="button" onClick={() => void loadChildren()}>Retry</button>
        </div>
      )}
    </div>
  );
}

export default function FileTree({ root, selectedPath, onSelectFile, onSelectDirectory, onOpenTerminal }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listDirectory(root)
      .then((items) => {
        if (!cancelled) {
          setEntries(items);
          setError(null);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, reloadToken]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !contextMenu) return;
    const rect = menu.getBoundingClientRect();
    const x = Math.min(contextMenu.x, window.innerWidth - rect.width - 8);
    const y = Math.min(contextMenu.y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
  }, [contextMenu]);

  function openContextMenu(entry: FileEntry, x: number, y: number) {
    setContextMenu({ entry, x, y });
  }

  if (loading) {
    return (
      <div className="file-tree-root-state is-loading">
        <span className="file-tree-spinner" aria-hidden="true" />
        <span>Reading workspace…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="file-tree-root-state is-error">
        <span>Could not read this folder.</span>
        <button type="button" onClick={() => setReloadToken((current) => current + 1)}>Retry</button>
      </div>
    );
  }
  if (entries.length === 0) return <div className="file-tree-empty">This folder is empty.</div>;

  return (
    <>
      <div className="file-tree" role="tree">
        {entries.map((entry) => (
          <FileNode
            key={entry.path}
            root={root}
            entry={entry}
            depth={0}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            onSelectDirectory={onSelectDirectory}
            onOpenTerminal={onOpenTerminal}
            onOpenContextMenu={openContextMenu}
          />
        ))}
      </div>
      {contextMenu && createPortal(
        <div
          ref={menuRef}
          className="file-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="file-context-menu-path" title={contextMenu.entry.path}>{contextMenu.entry.name}</div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void revealInFileExplorer(contextMenu.entry.path);
              setContextMenu(null);
            }}
          >
            <span>↗</span>
            <div><strong>{contextMenu.entry.isDirectory ? "Open in File Explorer" : "Show in File Explorer"}</strong><small>Use the Windows shell</small></div>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenTerminal(contextMenu.entry.isDirectory ? contextMenu.entry.path : parentDirectory(contextMenu.entry.path));
              setContextMenu(null);
            }}
          >
            <span>›_</span>
            <div><strong>Open terminal here</strong><small>Start a new tab in this folder</small></div>
          </button>
        </div>,
        document.querySelector<HTMLElement>(".app-shell") ?? document.body,
      )}
    </>
  );
}
