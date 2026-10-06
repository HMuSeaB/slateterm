import { useEffect, useState } from "react";

type Props = {
  open: boolean;
  enabled: boolean;
  clientReady: boolean;
  attachCommand: string | null | undefined;
  onClose: () => void;
};

// 远程 attach 的三步引导。放在命令面板里而不是设置面板：设置那边只留开关和
// 命令本身，步骤说明一旦常驻会把整个设置面板撑出屏幕。
export default function RemoteAttachGuide({
  open,
  enabled,
  clientReady,
  attachCommand,
  onClose,
}: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setCopied(false);
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!open) return null;

  return (
    <div className="remote-guide-overlay" onMouseDown={onClose}>
      <aside
        className="remote-guide"
        role="dialog"
        aria-modal="true"
        aria-label="Remote attach 使用说明"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="remote-guide-header">
          <div>
            <strong>Remote attach</strong>
            <p>把正在跑的 Claude 会话共享给本机另一个终端，比如 UU 远程开的那个窗口。</p>
          </div>
          <button type="button" className="overlay-close-button" aria-label="关闭说明" onClick={onClose}>×</button>
        </div>

        {!enabled ? (
          <p className="remote-guide-warning">
            还没打开。去 <strong>设置 → Remote attach</strong> 把开关打开，这里才会出现连接命令。
          </p>
        ) : !clientReady ? (
          <p className="remote-guide-warning">
            没找到 <code>slateterm-attach.exe</code>。dev 下 <code>cargo build</code> 会自动编它，出现这个提示说明当前构建目录里没有——重新跑一次
            <code className="remote-guide-build">pnpm tauri dev</code>
            即可；如果是打包后的安装版本，则说明 sidecar 没有随包分发。
          </p>
        ) : (
          <>
            <ol>
              <li>开一个 Claude 会话。只有 Claude 标签页会被共享，普通 shell 不行。</li>
              <li>复制下面的命令，粘进 UU 远程那个终端窗口，回车。</li>
              <li>多个会话会列序号让你选。连上后 <kbd>Ctrl</kbd>+<kbd>]</kbd> 断开，<kbd>Ctrl</kbd>+<kbd>C</kbd> 会照原样交给 Claude。</li>
            </ol>
            <button
              type="button"
              className="settings-remote-copy"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(attachCommand ?? "");
                } catch {
                  // 剪贴板被拒时命令仍显示在下面，可以手动框选
                }
                setCopied(true);
              }}
            >
              {copied ? "已复制" : "复制连接命令"}
            </button>
            <code className="remote-guide-command">{attachCommand}</code>
            <p className="remote-guide-note">
              连上后那边的按键会直接进入 SlateTerm 的会话。备用屏没有回滚缓冲，所以远程窗口上滚不了，历史请回 SlateTerm 看。
            </p>
          </>
        )}
      </aside>
    </div>
  );
}
