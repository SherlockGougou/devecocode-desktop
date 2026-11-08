import type { FileDiff } from "./types";

const COLLATOR = new Intl.Collator("zh-Hans", {
  numeric: true,
  sensitivity: "base",
});

export interface ChangeEntry {
  entry: FileDiff;
  path: string;
}

export interface ChangeDirNode {
  type: "dir";
  name: string;
  path: string;
  children: ChangeTreeNode[];
  additions: number;
  deletions: number;
  fileCount: number;
}

export interface ChangeFileNode {
  type: "file";
  name: string;
  path: string;
  entry: FileDiff;
  additions: number;
  deletions: number;
}

export type ChangeTreeNode = ChangeDirNode | ChangeFileNode;

function createDir(name: string, path: string): ChangeDirNode {
  return {
    type: "dir",
    name,
    path,
    children: [],
    additions: 0,
    deletions: 0,
    fileCount: 0,
  };
}

function sortTree(nodes: ChangeTreeNode[]) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return COLLATOR.compare(a.name, b.name);
  });
  for (const node of nodes) {
    if (node.type === "dir") sortTree(node.children);
  }
}

function aggregate(node: ChangeDirNode): { additions: number; deletions: number; count: number } {
  let additions = 0;
  let deletions = 0;
  let count = 0;
  for (const child of node.children) {
    if (child.type === "file") {
      additions += child.additions;
      deletions += child.deletions;
      count += 1;
    } else {
      const nested = aggregate(child);
      child.additions = nested.additions;
      child.deletions = nested.deletions;
      child.fileCount = nested.count;
      additions += nested.additions;
      deletions += nested.deletions;
      count += nested.count;
    }
  }
  return { additions, deletions, count };
}

/** 把扁平变更列表整理成目录树；目录和文件都按自然顺序排序。 */
export function buildChangeTree(entries: ChangeEntry[]): ChangeDirNode {
  const root = createDir("", "");
  const dirs = new Map<string, ChangeDirNode>();

  for (const item of entries) {
    const parts = item.path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let current = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const path = parts.slice(0, index + 1).join("/");
      let dir = dirs.get(path);
      if (!dir) {
        dir = createDir(parts[index], path);
        dirs.set(path, dir);
        current.children.push(dir);
      }
      current = dir;
    }
    current.children.push({
      type: "file",
      name: parts[parts.length - 1],
      path: item.path,
      entry: item.entry,
      additions: item.entry.additions ?? 0,
      deletions: item.entry.deletions ?? 0,
    });
  }

  sortTree(root.children);
  const totals = aggregate(root);
  root.additions = totals.additions;
  root.deletions = totals.deletions;
  root.fileCount = totals.count;
  return root;
}

export function collectChangeDirs(node: ChangeDirNode, output: string[] = []): string[] {
  for (const child of node.children) {
    if (child.type !== "dir") continue;
    output.push(child.path);
    collectChangeDirs(child, output);
  }
  return output;
}

export function filterChangeEntries(entries: ChangeEntry[], query: string): ChangeEntry[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return entries;
  return entries
    .filter((entry) => entry.path.toLowerCase().includes(keyword))
    .sort((a, b) => COLLATOR.compare(a.path, b.path));
}
