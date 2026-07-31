import type { Profile } from "../lib/types";

type IconName = "commands" | "split" | "project" | "settings";

function ToolbarIcon({ name }: { name: IconName }) {
  if (name === "commands") {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5.5h12M4 10h8M4 14.5h10" /></svg>;
  }
  if (name === "split") {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4" width="13" height="12" rx="2" /><path d="M10 4v12" /></svg>;
  }
  if (name === "project") {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 6.5h5l1.5 2h6.5v7.5h-13z" /><path d="M3.5 6.5V4.5h5l1.5 2" /></svg>;
  }
  return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" /><path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" /></svg>;
}

type Props = {
  profiles: Profile[];
  selectedProfileId: string;
  onSelectedProfileChange: (profileId: string) => void;
  onNewTab: () => void;
  onOpenPalette: () => void;
  onSplit: () => void;
  onToggleWorkspaces: () => void;
  onToggleSettings: () => void;
};

export default function TitleBar({
  profiles,
  selectedProfileId,
  onSelectedProfileChange,
  onNewTab,
  onOpenPalette,
  onSplit,
  onToggleWorkspaces,
  onToggleSettings,
}: Props) {
  const launchProfiles = profiles.filter((profile) => profile.featured && (profile.category === "shell" || profile.id === "claude"));

  return (
    <header className="titlebar titlebar-compact">
      <div className="titlebar-brand-cluster">
        <div className="brand">
          <div className="brand-mark" />
          <div className="brand-copy">
            <strong>SlateTerm</strong>
            <span>Workspace-aware AI terminal</span>
          </div>
        </div>
      </div>

      <div className="titlebar-controls">
        <select
          className="profile-select"
          aria-label="Profile for new tabs"
          value={selectedProfileId}
          onChange={(event) => onSelectedProfileChange(event.target.value)}
        >
          {launchProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>{profile.name}</option>
          ))}
        </select>
        <button type="button" className="primary-button" onClick={onNewTab}>New tab</button>
        <button type="button" className="icon-button" title="Commands (Ctrl+Shift+P)" aria-label="Open commands" onClick={onOpenPalette}><ToolbarIcon name="commands" /></button>
        <button type="button" className="icon-button" title="Split active tab" aria-label="Split active tab" onClick={onSplit}><ToolbarIcon name="split" /></button>
        <button type="button" className="icon-button" title="Toggle project context (Ctrl+B)" aria-label="Toggle project context" onClick={onToggleWorkspaces}><ToolbarIcon name="project" /></button>
        <button type="button" className="icon-button" title="Settings (Ctrl+,)" aria-label="Open settings" onClick={onToggleSettings}><ToolbarIcon name="settings" /></button>
      </div>
    </header>
  );
}

