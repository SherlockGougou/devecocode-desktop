import type {
  Part,
  QuestionInfo,
  QuestionOption,
  QuestionRequest,
  QuestionResult,
} from "./types";

export interface QuestionDraft {
  selected: string[];
  custom: string;
  customActive: boolean;
}

export type QuestionChange =
  | { sequence: number; kind: "upsert"; request: QuestionRequest }
  | { sequence: number; kind: "remove"; id: string }
  | { sequence: number; kind: "session"; sessionID: string };

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeQuestionOption(value: unknown): QuestionOption | null {
  const record = recordValue(value);
  if (!record) return null;
  const label = textValue(record.label);
  if (!label) return null;
  const description = textValue(record.description);
  return { label, ...(description ? { description } : {}) };
}

export function normalizeQuestionInfo(value: unknown): QuestionInfo | null {
  const record = recordValue(value);
  if (!record) return null;
  const question = textValue(record.question);
  if (!question) return null;
  const header = textValue(record.header) || "确认";
  const rawOptions = Array.isArray(record.options) ? record.options : [];
  const options = rawOptions.flatMap((option) => {
    const normalized = normalizeQuestionOption(option);
    return normalized ? [normalized] : [];
  });
  return {
    question,
    header,
    options,
    ...(record.multiple === true ? { multiple: true } : {}),
    ...(record.custom === false ? { custom: false } : {}),
  };
}

/** 把工具入参、SSE 或 /question 返回值收敛成同一种展示数据。 */
export function normalizeQuestionList(value: unknown): QuestionInfo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const normalized = normalizeQuestionInfo(entry);
    return normalized ? [normalized] : [];
  });
}

export function questionInputQuestions(input: unknown): QuestionInfo[] {
  const record = recordValue(input);
  if (record) return normalizeQuestionList(record.questions);
  return normalizeQuestionList(input);
}

export function normalizeQuestionRequest(value: unknown): QuestionRequest | null {
  const record = recordValue(value);
  if (!record) return null;
  const id = textValue(record.id);
  const sessionID = textValue(record.sessionID);
  const questions = normalizeQuestionList(record.questions);
  if (!id || !sessionID || questions.length === 0) return null;

  const tool = recordValue(record.tool);
  const messageID = tool ? textValue(tool.messageID) : "";
  const callID = tool ? textValue(tool.callID) : "";
  return {
    id,
    sessionID,
    questions,
    ...(messageID
      ? { tool: { messageID, ...(callID ? { callID } : {}) } }
      : {}),
  };
}

/** 仅接受字符串数组组成的矩阵，避免旧版本或异常事件把任意 JSON 当答案。 */
export function normalizeQuestionAnswers(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.map((answer) =>
    Array.isArray(answer)
      ? answer.flatMap((item) => {
          const text = typeof item === "string" ? item.trim() : "";
          return text ? [text] : [];
        })
      : [],
  );
}

export function questionAnswersFromMetadata(metadata: unknown): string[][] {
  const record = recordValue(metadata);
  return record ? normalizeQuestionAnswers(record.answers) : [];
}

export function questionResultAnswers(
  result: QuestionResult | undefined,
  metadata: unknown,
): string[][] {
  if (result?.answers?.length) return result.answers;
  return questionAnswersFromMetadata(metadata);
}

export function questionRequestMatchesPart(
  request: QuestionRequest,
  part: Pick<Part, "sessionID" | "messageID" | "callID">,
): boolean {
  if (!request.tool || request.sessionID !== part.sessionID) return false;
  if (request.tool.messageID !== part.messageID) return false;
  return !request.tool.callID || !part.callID || request.tool.callID === part.callID;
}

export function allowsCustomQuestionAnswer(question: QuestionInfo): boolean {
  return question.custom !== false;
}

export function emptyQuestionDrafts(questions: QuestionInfo[]): QuestionDraft[] {
  return questions.map(() => ({
    selected: [],
    custom: "",
    customActive: false,
  }));
}

export function answerForDraft(
  question: QuestionInfo,
  draft: QuestionDraft | undefined,
): string[] {
  if (!draft) return [];
  const selected = question.multiple ? [...draft.selected] : draft.selected.slice(0, 1);
  const custom = draft.custom.trim();
  return Array.from(new Set(custom ? [...selected, custom] : selected));
}

export function buildQuestionAnswers(
  questions: QuestionInfo[],
  drafts: QuestionDraft[],
): string[][] {
  return questions.map((question, index) => answerForDraft(question, drafts[index]));
}

export function questionAnswersWithNoPreference(
  questions: QuestionInfo[],
  drafts: QuestionDraft[],
): string[][] {
  return buildQuestionAnswers(questions, drafts).map((answer) =>
    answer.length > 0 ? answer : ["无偏好"],
  );
}

export function questionDraftsComplete(
  questions: QuestionInfo[],
  drafts: QuestionDraft[],
): boolean {
  return questions.every(
    (question, index) => answerForDraft(question, drafts[index]).length > 0,
  );
}

/**
 * 用请求期间发生的实时变更校正快照。
 *
 * `/question` 与 SSE 是两条独立通道，慢快照既可能缺少刚出现的问题，也可能
 * 重新带回已经回答或跳过的请求。快照作为基线，只重放标记之后的变更。
 */
export function mergeQuestionChanges(
  snapshot: QuestionRequest[],
  changes: Iterable<QuestionChange>,
  since: number,
): QuestionRequest[] {
  const merged = new Map(
    snapshot.map((request) => [request.id, request] as const),
  );
  for (const change of changes) {
    if (change.sequence <= since) continue;
    if (change.kind === "upsert") {
      merged.set(change.request.id, change.request);
      continue;
    }
    if (change.kind === "remove") {
      merged.delete(change.id);
      continue;
    }
    if (!change.sessionID) continue;
    for (const [id, request] of merged) {
      if (request.sessionID === change.sessionID) merged.delete(id);
    }
  }
  return Array.from(merged.values());
}
