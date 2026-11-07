/** 工作区相对路径 → 绝对路径；已经是绝对路径时原样返回。 */
export function absoluteWorkspacePath(directory: string, path: string): string {
  if (path.startsWith("/")) return path;
  const base = directory.replace(/\/+$/, "");
  const relative = path.replace(/^\/+/, "");
  return `${base}/${relative}`;
}

/** 统一比较工作区文件时使用的分隔符与前缀。 */
export function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Finder 定位或引用时使用的工作区相对路径。 */
export function relativeWorkspacePath(directory: string, path: string): string {
  if (!path.startsWith("/")) return normalizeWorkspacePath(path);
  const base = directory.replace(/\/+$/, "");
  if (path === base) return "";
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return normalizeWorkspacePath(path);
}
