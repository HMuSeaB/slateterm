import FileTree from "./FileTree";
import type { NamedWorkspace } from "../lib/types";

type Props = {
  open: boolean;
  workspaces: NamedWorkspace[];
  workspaceRoot?: string | null;
  selectedPath?: string | null;
  onClose: () => void;
  onChooseFolder: () => void;
  onSelectFile: (path: string) => void;
  onSelectDirectory: (path: string) => void;
  onOpenTerminal: () => void;
  onSaveCurrent: () => void;
  onLoad: (workspaceId: string) => void;
  onDelete: (workspaceId: string) => void;
  onOpenPalette: () => void;
  onOpenHistory: () => void;
};

export default function WorkspacePanel({
  open,
  workspaces,
  workspaceRoot,
  selectedPath,
  onClose,
  onChooseFolder,
  onSelectFile,
  onSelectDirectory,
  onOpenTerminal,
  onSaveCurrent,
  onLoad,
  onDelete,
  onOpenPalette,
  onOpenHistory,
}: Props) {
  if (!open) {
    return null;
  }

  return (
    <aside className="workspace-panel">
      <div className="workspace-panel-header">
        <div>
          <strong>Project context</strong>
          <p>Files available to AI sessions</p>
        </div>
        <button type="button" className="sidebar-collapse" title="Collapse sidebar" onClick={onClose}>‹</button>
      </div>

      <div className="workspace-root-card">
        <div>
          <strong>{workspaceRoot ? workspaceRoot.split(/[\\/]/).filter(Boolean).slice(-1)[0] : "No folder open"}</strong>
          <span>{workspaceRoot || "Choose a folder to browse files"}</span>
        </div>
        <button type="button" onClick={onChooseFolder}>{workspaceRoot ? "Change" : "Open folder"}</button>
      </div>

      <div className="sidebar-actions">
        <button type="button" onClick={onOpenTerminal}><span>Open terminal here</span><kbd>Ctrl T</kbd></button>
        <button type="button" onClick={onOpenPalette}><span>Commands</span><kbd>Ctrl Shift P</kbd></button>
        <button type="button" onClick={onOpenHistory}><span>History</span><kbd>Ctrl Shift R</kbd></button>
      </div>

      <div className="sidebar-section-heading"><span>Explorer</span></div>
      {workspaceRoot ? (
        <FileTree
          root={workspaceRoot}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          onSelectDirectory={onSelectDirectory}
        />
      ) : (
        <div className="workspace-empty">Open a folder to show its files.</div>
      )}

      <div className="sidebar-section-heading"><span>Saved workspaces</span><button type="button" onClick={onSaveCurrent}>Save</button></div>
      <div className="workspace-list">
        {workspaces.length === 0 ? (
          <div className="workspace-empty">还没有保存的工作区。</div>
        ) : (
          workspaces.map((workspace) => (
            <div key={workspace.id} className="workspace-card">
              <button type="button" className="workspace-card-main" onClick={() => onLoad(workspace.id)}>
                <strong>{workspace.name}</strong>
                <span>{workspace.state.tabs.length} tabs · {new Date(workspace.updatedAt).toLocaleDateString()}</span>
              </button>
              <button type="button" className="workspace-delete" onClick={() => onDelete(workspace.id)}>Delete</button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
