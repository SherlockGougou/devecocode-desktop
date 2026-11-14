//! 语音输入的纯文本逻辑：只负责把最终转写插入草稿，并保留一次可验证的撤销快照。

export interface VoiceSelection {
  start: number;
  end: number;
}

export interface VoiceInsertion {
  beforeText: string;
  beforeStart: number;
  beforeEnd: number;
  afterText: string;
  insertedStart: number;
  insertedEnd: number;
  caret: number;
}

const CJK =
  /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const NO_SPACE_BEFORE = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  "%",
  ")",
  "]",
  "}",
  "，",
  "。",
  "；",
  "：",
  "！",
  "？",
  "、",
  "）",
  "》",
  "」",
  "』",
  "】",
]);
const NO_SPACE_AFTER = new Set(["(", "[", "{", "（", "《", "「", "『", "【"]);

function needsSpace(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (/\s/.test(left) || /\s/.test(right)) return false;
  if (CJK.test(left) || CJK.test(right)) return false;
  if (NO_SPACE_BEFORE.has(right) || NO_SPACE_AFTER.has(left)) return false;
  return true;
}

/** 识别结果保持原始标点，只把换行、制表符等不可控空白压成单个空格。 */
export function normalizeVoiceTranscript(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function clampSelection(length: number, selection: VoiceSelection): VoiceSelection {
  const start = Math.max(0, Math.min(length, selection.start));
  const end = Math.max(start, Math.min(length, selection.end));
  return { start, end };
}

/**
 * 在冻结的选区插入最终转写。已有选区会被替换；空结果返回 null，不修改草稿。
 * 中英文边界补一个空格，中文和中文标点旁不补，避免形成不自然的排版。
 */
export function insertVoiceTranscript(
  text: string,
  transcript: string,
  selection: VoiceSelection,
): VoiceInsertion | null {
  const value = normalizeVoiceTranscript(transcript);
  if (!value) return null;
  const { start, end } = clampSelection(text.length, selection);
  const prefix = needsSpace(text[start - 1] ?? "", value[0] ?? "") ? " " : "";
  const suffix = needsSpace(value[value.length - 1] ?? "", text[end] ?? "")
    ? " "
    : "";
  const insertedStart = start + prefix.length;
  const insertedEnd = insertedStart + value.length;
  const afterText =
    text.slice(0, start) + prefix + value + suffix + text.slice(end);
  return {
    beforeText: text,
    beforeStart: start,
    beforeEnd: end,
    afterText,
    insertedStart,
    insertedEnd,
    caret: insertedEnd,
  };
}

/** 只有正文仍等于插入后的快照时才允许撤销，避免覆盖用户后续输入。 */
export function canUndoVoice(insertion: VoiceInsertion, currentText: string): boolean {
  return insertion.afterText === currentText;
}

export function undoVoiceInsertion(insertion: VoiceInsertion): {
  text: string;
  start: number;
  end: number;
} {
  return {
    text: insertion.beforeText,
    start: insertion.beforeStart,
    end: insertion.beforeEnd,
  };
}
