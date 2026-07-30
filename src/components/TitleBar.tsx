import type { Profile } from "../lib/types";

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
            <span>Local-first Windows terminal</span>
          </div>
        </div>
        <span className="brand-badge">Local</span>
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
        <button type="button" className="icon-button" title="Command palette (Ctrl+Shift+P)" onClick={onOpenPalette}>⌘</button>
        <button type="button" className="icon-button" title="Split active tab" onClick={onSplit}>◫</button>
        <button type="button" className="icon-button" title="Toggle workspace sidebar" onClick={onToggleWorkspaces}>☰</button>
        <button type="button" className="icon-button" title="Settings" onClick={onToggleSettings}>⚙</button>
      </div>
    </header>
  );
}

