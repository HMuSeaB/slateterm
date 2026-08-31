export type PendingPathAttachment = {
  id: string;
  path: string;
  name: string;
  badge: string;
};

// 常规字符（含中文等非 ASCII）直接裸写；其余一律加引号，兼容 PowerShell 与 cmd。
// 含 $ 或反引号的路径在 PowerShell 双引号里会被展开，改用单引号（cmd 下极罕见，接受损失）
const SHELL_SAFE_PATH = /^[\p{L}\p{N}_.:\\/-]+$/u;
const SHELL_EXPANDS_IN_QUOTES = /[$`]/;

export function formatTerminalPaths(paths: string[]) {
  return paths
    .map((path) => {
      if (SHELL_SAFE_PATH.test(path)) {
        return path;
      }
      if (SHELL_EXPANDS_IN_QUOTES.test(path)) {
        return `'${path.replace(/'/g, "''")}'`;
      }
      return `"${path}"`;
    })
    .join(" ");
}

export function pathBaseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function pathBadge(path: string) {
  const name = pathBaseName(path);
  const extension = name.includes(".") ? name.split(".").pop()?.toUpperCase() : undefined;
  if (!extension || extension.length > 4) {
    return "DIR";
  }
  return extension;
}

export function createPathAttachment(path: string): PendingPathAttachment {
  return {
    id: `${path.toLowerCase()}-${crypto.randomUUID()}`,
    path,
    name: pathBaseName(path),
    badge: pathBadge(path),
  };
}
