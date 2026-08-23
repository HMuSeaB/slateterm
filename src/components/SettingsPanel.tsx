import { useEffect } from "react";
import type { Profile, Settings } from "../lib/types";

type Props = {
  profiles: Profile[];
  settings: Settings;
  open: boolean;
  onClose: () => void;
  onChange: (settings: Settings) => void;
};

function profileOptionLabel(profile: Profile) {
  return `${profile.name} · ${profile.category === "ai" ? "AI CLI" : "Shell"}`;
}

export default function SettingsPanel({
  profiles,
  settings,
  open,
  onClose,
  onChange,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const shellProfiles = profiles.filter((profile) => profile.category === "shell");
  const proxy = settings.proxy ?? { enabled: false, host: "127.0.0.1", port: 7890 };

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    onChange({
      ...settings,
      [key]: value,
    });
  };

  const updateProxy = (nextProxy: typeof proxy) => {
    onChange({ ...settings, proxy: nextProxy });
  };

  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <aside className="settings-panel" role="dialog" aria-modal="true" aria-label="Terminal settings" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-panel-header">
          <div>
            <strong>Terminal settings</strong>
            <p>Saved locally and applied immediately.</p>
          </div>
          <button type="button" className="overlay-close-button" aria-label="Close settings" onClick={onClose}>×</button>
        </div>

      <div className="settings-grid">
        <label>
          <span>Theme</span>
          <select value={settings.theme} onChange={(e) => update("theme", e.target.value as Settings["theme"])}>
            <option value="graphite">Graphite</option>
            <option value="paper">Paper</option>
          </select>
        </label>

        <label>
          <span>Font</span>
          <input
            value={settings.fontFamily}
            onChange={(e) => update("fontFamily", e.target.value)}
            placeholder="JetBrainsMono Nerd Font, Cascadia Mono"
          />
        </label>

        <label>
          <span>Font Size</span>
          <input
            type="number"
            min={11}
            max={28}
            value={settings.fontSize}
            onChange={(e) => update("fontSize", Number(e.target.value))}
          />
        </label>

        <label>
          <span>Line Height</span>
          <input
            type="number"
            min={1}
            max={2}
            step={0.05}
            value={settings.lineHeight}
            onChange={(e) => update("lineHeight", Number(e.target.value))}
          />
        </label>

        <label>
          <span>Cursor</span>
          <select
            value={settings.cursorStyle}
            onChange={(e) => update("cursorStyle", e.target.value as Settings["cursorStyle"])}
          >
            <option value="block">Block</option>
            <option value="underline">Underline</option>
            <option value="bar">Bar</option>
          </select>
        </label>

        <label>
          <span>Startup Shell</span>
          <select
            value={settings.defaultProfileId}
            onChange={(e) => update("defaultProfileId", e.target.value)}
          >
            {shellProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profileOptionLabel(profile)}
              </option>
            ))}
          </select>
        </label>
      </div>

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={settings.rememberLayout}
            onChange={(e) => update("rememberLayout", e.target.checked)}
          />
          <span>Remember current layout preference for the next launch</span>
        </label>

        <div className="settings-proxy-section">
          <div className="settings-proxy-heading">
            <strong>Network proxy</strong>
            <span>New terminal sessions only — already-open sessions keep their environment.</span>
          </div>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={proxy.enabled}
              onChange={(e) => updateProxy({ ...proxy, enabled: e.target.checked })}
            />
            <span>Route new sessions through the local proxy (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY)</span>
          </label>
          <div className="settings-grid">
            <label>
              <span>Proxy host</span>
              <input
                value={proxy.host}
                placeholder="127.0.0.1"
                onChange={(e) => updateProxy({ ...proxy, host: e.target.value })}
              />
            </label>
            <label>
              <span>Proxy port</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={proxy.port}
                onChange={(e) => updateProxy({ ...proxy, port: Number(e.target.value) })}
              />
            </label>
          </div>
        </div>
      </aside>
    </div>
  );
}
