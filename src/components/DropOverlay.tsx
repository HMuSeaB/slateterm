import { pathBaseName } from "../lib/paths";

type Props = {
  visible: boolean;
  claudeLike: boolean;
  paths: string[];
};

export function DropOverlay({ visible, claudeLike, paths }: Props) {
  if (!visible) {
    return null;
  }
  return (
    <div className="drag-drop-overlay">
      <div className="drop-badge">
        <strong>{claudeLike ? "附加到 Claude" : "插入到终端"}</strong>
        {paths.length > 0 && (
          <div className="drop-badge-files">
            {paths.slice(0, 3).map((path) => (
              <span key={path} title={path}>{pathBaseName(path)}</span>
            ))}
            {paths.length > 3 && <span className="drop-badge-more">+{paths.length - 3}</span>}
          </div>
        )}
        <span className="drop-badge-hint">
          {claudeLike
            ? "图片转为图片附件，其他文件与文件夹作为路径附件"
            : "插入自动加引号的绝对路径，不会回车执行"}
        </span>
      </div>
    </div>
  );
}
