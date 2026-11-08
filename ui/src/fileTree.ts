import type { FileNode } from "./types";

const COLLATOR = new Intl.Collator("zh-Hans", {
  numeric: true,
  sensitivity: "base",
});

/** 统一目录 key：去掉首尾斜杠，根目录为空字符串。 */
export function normalizeTreePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized === "." ? "" : normalized;
}

export function sortFileNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return COLLATOR.compare(a.name, b.name);
  });
}

export function parentTreePath(path: string): string {
  const normalized = normalizeTreePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

export function ancestorTreePaths(path: string): string[] {
  const normalized = normalizeTreePath(path);
  if (!normalized) return [];
  const parts = normalized.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function fileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 判断 watcher 事件是否属于当前工作区；相对路径按当前工作区处理。 */
export function isPathInsideDirectory(directory: string, path: string): boolean {
  const candidate = path.replace(/\\/g, "/");
  if (!candidate.startsWith("/")) return true;
  const base = directory.replace(/\/+$/, "");
  return candidate === base || candidate.startsWith(`${base}/`);
}
