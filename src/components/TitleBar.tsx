import clsx from "clsx";
import type { Profile } from "../lib/types";

type Props = {
  profiles: Profile[];
  selectedProfileId: string;
  onSelectedProfileChange: (profileId: string) => void;
  onLaunchProfile: (profileId: string) => void;
  onNewTab: () => void;
  onSplit: () => void;
  onToggleSettings: () => void;
};

export default function TitleBar({
  profiles,
  selectedProfileId,
  onSelectedProfileChange,
  onLaunchProfile,
  onNewTab,
  onSplit,
  onToggleSettings,
}: Props) {
  const shellProfiles = profiles.filter((profile) => profile.category === "shell");
  const claudeProfile = profiles.find((profile) => profile.id === "claude") ?? null;

  return (
    <header className="titlebar titlebar-compact">
      <div className="titlebar-brand-cluster">
        <div className="brand">
          <div className="brand-mark" />
          <div className="brand-copy">
            <strong>Termin</strong>
            <span>Local-first Windows terminal</span>
          </div>
        </div>
        <span className="brand-badge">Local</span>
      </div>

      <div className="toolbar-shell toolbar-shell-compact">
        <div className="profile-rail shell-rail">
          {shellProfiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              title={profile.description}
              className={clsx("profile-chip", selectedProfileId === profile.id && "is-active", "is-shell")}
              onClick={() => {
                onSelectedProfileChange(profile.id);
                onLaunchProfile(profile.id);
              }}
            >
              <strong>{profile.name}</strong>
              <span>Shell</span>
            </button>
          ))}

          {claudeProfile && (
            <button
              type="button"
              title={claudeProfile.description}
              className={clsx("profile-chip", selectedProfileId === claudeProfile.id && "is-active", "is-ai")}
              onClick={() => {
                onSelectedProfileChange(claudeProfile.id);
                onLaunchProfile(claudeProfile.id);
              }}
            >
              <strong>Claude Code</strong>
              <span>AI CLI</span>
            </button>
          )}
        </div>

        <div className="action-cluster action-cluster-compact">
          <button type="button" className="ghost-button" onClick={onNewTab}>
            New Tab
          </button>
          <button type="button" className="ghost-button" onClick={onSplit}>
            Split
          </button>
          <button type="button" className="ghost-button" onClick={onToggleSettings}>
            Settings
          </button>
        </div>
      </div>
    </header>
  );
}
