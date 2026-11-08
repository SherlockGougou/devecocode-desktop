import type { FileDiff } from "./types";

export type DiffLineKind = "hunk" | "add" | "del" | "context" | "meta" | "skip";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** 折叠的未修改行数；仅 skip 行使用。 */
  hidden?: number;
}

export interface ParsedPatch {
  lines: DiffLine[];
  total: number;
  folded: number;
  truncated: boolean;
}

export const MAX_DIFF_LINES = 4000;
const CONTEXT_LINES = 3;

const FILE_HEADER_PREFIXES = [
  "diff --git ",
  "index ",
  "--- ",
  "+++ ",
  "new file mode ",
  "deleted file mode ",
  "old mode ",
  "new mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
];

function headerNumbers(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 折叠大段未修改内容，只保留改动附近各 3 行上下文。 */
function foldContext(lines: DiffLine[]): { lines: DiffLine[]; folded: number } {
  const output: DiffLine[] = [];
  let context: DiffLine[] = [];
  let folded = 0;

  const flush = () => {
    if (context.length === 0) return;
    if (context.length > CONTEXT_LINES * 2) {
      const head = context.slice(0, CONTEXT_LINES);
      const tail = context.slice(-CONTEXT_LINES);
      const hidden = context.length - head.length - tail.length;
      // 只隐藏足够长的片段；为了 2~5 行弹一个省略条反而打断阅读。
      if (hidden < 6) {
        output.push(...context);
        context = [];
        return;
      }
      output.push(...head);
      if (hidden > 0) {
        output.push({
          kind: "skip",
          text: `… 省略 ${hidden} 行未修改内容 …`,
          oldNo: null,
          newNo: null,
          hidden,
        });
        folded += hidden;
      }
      output.push(...tail);
    } else {
      output.push(...context);
    }
    context = [];
  };

  for (const line of lines) {
    if (line.kind === "context") {
      context.push(line);
      continue;
    }
    flush();
    output.push(line);
  }
  flush();
  return { lines: output, folded };
}

/** 把 git 补丁拆成可渲染的行，并计算旧/新行号。 */
export function parsePatch(patch: string | undefined): ParsedPatch {
  if (!patch) return { lines: [], total: 0, folded: 0, truncated: false };

  const source = patch.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const raw = source ? source.split("\n") : [];
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const line of raw) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (match) {
        oldNo = headerNumbers(match[1], oldNo);
        newNo = headerNumbers(match[3], newNo);
        inHunk = true;
        lines.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
        continue;
      }
    }

    if (!inHunk) {
      if (FILE_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
      if (!line) continue;
      lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      continue;
    }

    if (line.startsWith("+")) {
      lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo });
      newNo += 1;
    } else if (line.startsWith("-")) {
      lines.push({ kind: "del", text: line.slice(1), oldNo, newNo: null });
      oldNo += 1;
    } else if (line.startsWith(" ")) {
      lines.push({ kind: "context", text: line.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    } else if (line.startsWith("\\")) {
      lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    } else {
      lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    }
  }

  const folded = foldContext(lines);
  return {
    lines: folded.lines.slice(0, MAX_DIFF_LINES),
    total: lines.length,
    folded: folded.folded,
    truncated: folded.lines.length > MAX_DIFF_LINES,
  };
}

export type ChangeStatus = "added" | "deleted" | "modified";

export function changeStatus(entry: FileDiff): ChangeStatus {
  if (entry.status === "added" || entry.status === "deleted") return entry.status;
  return "modified";
}

export function statusLetter(status: ChangeStatus): string {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  return "M";
}

export function statusLabel(status: ChangeStatus): string {
  if (status === "added") return "新增";
  if (status === "deleted") return "删除";
  return "修改";
}
