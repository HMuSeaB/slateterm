import { useEffect, useState } from "react";
import type { Profile, RemoteStatus, Settings } from "../lib/types";
import ToggleSwitch from "./ToggleSwitch";

type Props = {
  profiles: Profile[];
  settings: Settings;
  open: boolean;
  remoteStatus: RemoteStatus;
  remoteError: string | null;
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
  remoteStatus,
  remoteError,
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

  const [copiedAttachCommand, setCopiedAttachCommand] = useState(false);

  useEffect(() => {
    if (!copiedAttachCommand) return;
    const timer = window.setTimeout(() => setCopiedAttachCommand(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedAttachCommand]);

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
            <p>改动保存在本地，立即生效。</p>
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

        <div className="settings-pair">
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
        </div>

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

        <ToggleSwitch
          checked={settings.rememberLayout}
          onChange={(value) => update("rememberLayout", value)}
          label="记住当前布局，下次启动时按它恢复"
        />

        <ToggleSwitch
          checked={settings.completionSound !== false}
          onChange={(value) => update("completionSound", value)}
          label="Claude Code 回复结束时播放提示音"
        />

        <div className="settings-proxy-section">
          <div className="settings-proxy-heading">
            <strong>Remote attach</strong>
            <span>把正在运行的 Claude 会话共享给本机另一个终端（例如 UU 远程开的那个窗口），那边能看输出、能打字。只有你当前这个 Windows 账户能连。</span>
          </div>
          <ToggleSwitch
            checked={settings.remoteAttach === true}
            onChange={(value) => update("remoteAttach", value)}
            label="允许 slateterm-attach 查看并输入 Claude 会话"
          />
          {remoteError && <p className="settings-remote-error" role="alert">{remoteError}</p>}
          {remoteStatus.enabled &&
            (remoteStatus.clientReady ? (
              <div className="settings-remote-command">
                <button
                  type="button"
                  className="settings-remote-copy"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(remoteStatus.attachCommand ?? "");
                    } catch {
                      // 剪贴板权限被拒时不算错误，命令还是明文显示着，可以手动选
                    }
                    setCopiedAttachCommand(true);
                  }}
                >
                  {copiedAttachCommand ? "已复制" : "复制连接命令"}
                </button>
                <code>{remoteStatus.attachCommand}</code>
              </div>
            ) : (
              <p className="settings-remote-warning" role="alert">
                没找到 slateterm-attach 客户端。dev 下重跑一次 <code>pnpm tauri dev</code> 就会编出来；
                打包版本出现这个提示则说明 sidecar 没随包分发。详细步骤见命令面板里的「Remote attach 使用说明」。
              </p>
            ))}
        </div>

        <div className="settings-proxy-section">
          <div className="settings-proxy-heading">
            <strong>Network proxy</strong>
            <span>只影响新建的会话，已经开着的会话保持原环境。</span>
          </div>
          <ToggleSwitch
            checked={proxy.enabled}
            onChange={(value) => updateProxy({ ...proxy, enabled: value })}
            label="给新会话加上本地代理环境变量（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY）"
          />
          <div className="settings-pair">
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
