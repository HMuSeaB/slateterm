import type { NamedWorkspace, Tab } from "../lib/types";

type Props = {
  open: boolean;
  workspaces: NamedWorkspace[];
  tabs: Tab[];
  activeTabId: string | null;
  onClose: () => void;
  onSaveCurrent: () => void;
  onLoad: (workspaceId: string) => void;
  onDelete: (workspaceId: string) => void;
  onSelectTab: (tabId: string) => void;
  onOpenPalette: () => void;
  onOpenHistory: () => void;
};

export default function WorkspacePanel({ open, workspaces, tabs, activeTabId, onClose, onSaveCurrent, onLoad, onDelete, onSelectTab, onOpenPalette, onOpenHistory }: Props) {
  if (!open) {
    return null;
  }

  return (
    <aside className="workspace-panel">
      <div className="workspace-panel-header">
        <div>
          <strong>SlateTerm</strong>
          <p>工作区与会话导航</p>
        </div>
        <button type="button" className="sidebar-collapse" title="Collapse sidebar" onClick={onClose}>‹</button>
      </div>

      <div className="sidebar-actions">
        <button type="button" onClick={onOpenPalette}><span>Command palette</span><kbd>Ctrl Shift P</kbd></button>
        <button type="button" onClick={onOpenHistory}><span>Command history</span><kbd>Ctrl Shift R</kbd></button>
      </div>

      <div className="sidebar-section-heading"><span>Open tabs</span><span>{tabs.length}</span></div>
      <div className="sidebar-tab-list">
        {tabs.map((tab) => (
          <button key={tab.id} type="button" className={tab.id === activeTabId ? "is-active" : ""} onClick={() => onSelectTab(tab.id)}>
            <span>{tab.title}</span><small>{tab.panes.length === 2 ? "Split" : "Shell"}</small>
          </button>
        ))}
      </div>

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
