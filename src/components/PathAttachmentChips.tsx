import type { PendingPathAttachment } from "../lib/paths";

type Props = {
  attachments: PendingPathAttachment[];
  onRemove: (id: string) => void;
};

export function PathAttachmentChips({ attachments, onRemove }: Props) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div className="claude-path-attachments" aria-label="等待随下一条消息发送的路径附件">
      <div className="claude-path-attachment-list">
        {attachments.map((attachment) => (
          <div key={attachment.id} className="claude-path-attachment" title={attachment.path}>
            <span className="claude-path-attachment-icon" aria-hidden="true">{attachment.badge}</span>
            <span className="claude-path-attachment-copy">
              <strong>{attachment.name}</strong>
              <small>{attachment.path}</small>
            </span>
            <button
              type="button"
              aria-label={`移除 ${attachment.name}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onRemove(attachment.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="claude-path-attachment-hint">
        <span>已附加 {attachments.length} 个</span>
        <span>回车随消息发送 · 空输入时 Backspace 撤销一个 · Ctrl+C 清空</span>
      </div>
    </div>
  );
}
