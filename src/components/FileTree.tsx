import { useEffect, useState } from "react";
import { listDirectory } from "../lib/tauri";
import type { FileEntry } from "../lib/types";

type Props = {
  root: string;
  selectedPath?: string | null;
  onSelectFile: (path: string) => void;
  onSelectDirectory: (path: string) => void;
};

type NodeProps = Props & {
  entry: FileEntry;
  depth: number;
};

function FileNode({ entry, depth, selectedPath, onSelectFile, onSelectDirectory }: NodeProps) {
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
        />
      ))}
      {error && <div className="file-tree-error" style={{ paddingLeft: `${24 + depth * 14}px` }}>{error}</div>}
    </div>
  );
}

export default function FileTree({ root, selectedPath, onSelectFile, onSelectDirectory }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  if (error) return <div className="file-tree-empty">Could not read this folder: {error}</div>;
  if (entries.length === 0) return <div className="file-tree-empty">This folder is empty.</div>;

  return (
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
        />
      ))}
    </div>
  );
}
