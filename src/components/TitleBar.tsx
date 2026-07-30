import clsx from "clsx";
import type { Profile } from "../lib/types";

type Props = {
  profiles: Profile[];
  selectedProfileId: string;
  onSelectedProfileChange: (profileId: string) => void;
  onLaunchProfile: (profileId: string) => void;
  onNewTab: () => void;
  onSplit: () => void;
  onToggleWorkspaces: () => void;
  onToggleSettings: () => void;
};

export default function TitleBar({
  profiles,
  selectedProfileId,
  onSelectedProfileChange,
  onLaunchProfile,
  onNewTab,
  onSplit,
  onToggleWorkspaces,
  onToggleSettings,
}: Props) {
  const shellProfiles = profiles.filter((profile) => profile.category === "shell" && profile.featured);
  const claudeProfiles = profiles.filter((profile) => profile.id === "claude");

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

          {claudeProfiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              title={profile.description}
              className={clsx("profile-chip", selectedProfileId === profile.id && "is-active", "is-ai")}
              onClick={() => {
                onSelectedProfileChange(profile.id);
                onLaunchProfile(profile.id);
              }}
            >
              <strong>{profile.name}</strong>
              <span>{profile.id === "claude" ? "New chat" : profile.id === "claude-continue" ? "Latest chat" : "Chat picker"}</span>
            </button>
          ))}
        </div>

        <div className="action-cluster action-cluster-compact">
          <button type="button" className="ghost-button" onClick={onNewTab}>
            New Tab
          </button>
          <button type="button" className="ghost-button" onClick={onSplit}>
            Split
          </button>
          <button type="button" className="ghost-button" onClick={onToggleWorkspaces}>
            Workspaces
          </button>
          <button type="button" className="ghost-button" onClick={onToggleSettings}>
            Settings
          </button>
        </div>
      </div>
    </header>
  );
}

