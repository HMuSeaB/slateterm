import { useEffect, useRef, useState } from "react";
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
  const [error, setError] = useState<string | null>(null);

  async function toggleDirectory() {
    if (!entry.isDirectory) {
      onSelectFile(entry.path);
      return;
    }
    onSelectDirectory(entry.path);
    if (!open && children.length === 0) {
      try {
        setChildren(await listDirectory(entry.path));
        setError(null);
      } catch (reason) {
        setError(String(reason));
      }
    }
    setOpen((current) => !current);
  }

  return (
    <div className="file-tree-node">
      <button
        type="button"
        className={`file-tree-row ${selectedPath === entry.path ? "is-selected" : ""}`}
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        title={entry.path}
        onClick={() => void toggleDirectory()}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenContextMenu(entry, event.clientX, event.clientY);
        }}
      >
        <span className="file-tree-chevron">{entry.isDirectory ? (open ? "⌄" : "›") : ""}</span>
        <span className={entry.isDirectory ? "file-tree-folder" : "file-tree-file"}>{entry.name}</span>
      </button>
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
      {error && <div className="file-tree-error" style={{ paddingLeft: `${24 + depth * 14}px` }}>{error}</div>}
    </div>
  );
}

export default function FileTree({ root, selectedPath, onSelectFile, onSelectDirectory, onOpenTerminal }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listDirectory(root)
      .then((items) => {
        if (!cancelled) {
          setEntries(items);
          setError(null);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

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

  useEffect(() => {
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

  if (error) return <div className="file-tree-empty">Could not read this folder: {error}</div>;
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
      {contextMenu && (
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
        </div>
      )}
    </>
  );
}
