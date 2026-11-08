import type {
  Message,
  Part,
  Session,
  SessionStatus,
  SubagentTask,
  TodoItem,
  TodoPriority,
  TodoStatus,
} from "./types";

const MAX_ACTIVITY_PREVIEW = 1200;
const TODO_STATUSES = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);
const TODO_PRIORITIES = new Set<TodoPriority>(["high", "medium", "low"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value || undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["message", "name", "code", "type"]) {
    const found = text(record[key]);
    if (found) return found;
  }
  const data = asRecord(record.data);
  if (data) {
    const found = errorText(data);
    if (found) return found;
  }
  return undefined;
}

/** `todo.updated`、工具输入和 `/todo` 都走同一个归一化入口。 */
export function normalizeTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const result: TodoItem[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const content = text(record.content).trim();
    if (!content) continue;
    const rawStatus = text(record.status);
    const rawPriority = text(record.priority);
    result.push({
      content,
      status: TODO_STATUSES.has(rawStatus as TodoStatus)
        ? (rawStatus as TodoStatus)
        : "pending",
      priority: TODO_PRIORITIES.has(rawPriority as TodoPriority)
        ? (rawPriority as TodoPriority)
        : "medium",
    });
  }
  return result;
}

/** `/session/status` 只返回忙/重试会话；其余情况都按空闲处理。 */
export function isBusyStatus(status: SessionStatus | undefined): boolean {
  return status?.type === "busy" || status?.type === "retry";
}

/**
 * CLI 进程被异常结束时，持久化的 tool part 可能停在 running/pending。
 * 会话快照已经确认空闲后，只在展示层改成 interrupted，不能回写 CLI 存储。
 */
export function markInterruptedMessages(
  messages: Message[],
  sessionActive: boolean,
): Message[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.info.role !== "assistant") return message;
    // 已完成的助手消息不会再有活动 part；未完成消息只在本轮仍在运行时保留 running。
    const messageActive = sessionActive && !message.info.time?.completed;
    if (messageActive) return message;
    let messageChanged = false;
    const parts = message.parts.map((part) => {
      if (part.synthetic) return part;
      if (part.type === "tool") {
        const status = part.state?.status;
        if (status === "running" || status === "pending") {
          messageChanged = true;
          return {
            ...part,
            state: { ...(part.state ?? {}), status: "interrupted" as const },
          };
        }
        return part;
      }
      if (part.type === "reasoning") {
        if (!part.time?.end && !part.interrupted) {
          messageChanged = true;
          return { ...part, interrupted: true };
        }
      }
      return part;
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, parts };
  });
  return changed ? next : messages;
}

function taskStatus(value: unknown): SubagentTask["status"] {
  if (
    value === "running" ||
    value === "completed" ||
    value === "error" ||
    value === "interrupted"
  ) {
    return value;
  }
  return "pending";
}

function childStatus(
  sessionID: string | null,
  statuses: Record<string, SessionStatus>,
): SubagentTask["status"] | null {
  if (!sessionID) return null;
  const status = statuses[sessionID];
  if (!status) return null;
  return status.type === "busy" || status.type === "retry" ? "running" : "completed";
}

function parseTaskSessionID(part: Part): string | null {
  const state = asRecord(part.state);
  const metadata = asRecord(state?.metadata);
  const fromMetadata =
    text(metadata?.sessionId) ||
    text(metadata?.session_id) ||
    text(metadata?.childSessionId) ||
    text(metadata?.childSessionID);
  if (fromMetadata) return fromMetadata;
  const output = text(state?.output);
  return output.match(/<task\s+id="(ses_[^"]+)"/)?.[1] ?? null;
}

function fromTaskTool(part: Part, parentSessionID: string, fallbackTime?: number): SubagentTask | null {
  if (part.type !== "tool" || part.tool !== "task") return null;
  const state = asRecord(part.state);
  const input = asRecord(state?.input);
  const metadata = asRecord(state?.metadata);
  const time = asRecord(state?.time);
  const sessionID = parseTaskSessionID(part);
  const agent =
    text(input?.subagent_type) ||
    text(input?.agent) ||
    text(metadata?.agent) ||
    "subagent";
  const description =
    text(input?.description) ||
    text(state?.title) ||
    text(part.title) ||
    agent;
  return {
    id: part.id,
    parentSessionID: text(metadata?.parentSessionId) || parentSessionID,
    sessionID,
    agent,
    description,
    prompt: text(input?.prompt),
    status: taskStatus(state?.status),
    startedAt: numberValue(time?.start) ?? fallbackTime,
    endedAt: numberValue(time?.end),
    error: errorText(state?.error),
  };
}

function fromSubtaskPart(
  part: Part,
  parentSessionID: string,
  fallbackTime?: number,
): SubagentTask | null {
  if (part.type !== "subtask") return null;
  return {
    id: part.id,
    parentSessionID,
    sessionID: null,
    agent: text(part.agent) || "subagent",
    description: text(part.description) || text(part.agent) || "子代理任务",
    prompt: text(part.prompt),
    status: "pending",
    startedAt: fallbackTime,
  };
}

export function taskFromPart(
  part: Part,
  parentSessionID: string | null,
  children: Session[],
  statuses: Record<string, SessionStatus>,
  fallbackTime?: number,
): SubagentTask | null {
  if (!parentSessionID) return null;
  const task =
    fromTaskTool(part, parentSessionID, fallbackTime) ??
    fromSubtaskPart(part, parentSessionID, fallbackTime);
  if (!task) return null;
  const child = task.sessionID
    ? children.find((item) => item.id === task.sessionID)
    : children.find((item) => childMatchesTask(item, task));
  return child ? attachChild(task, child, statuses) : task;
}

function normalized(value: string) {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function childMatchesTask(child: Session, task: SubagentTask) {
  if (child.id === task.sessionID) return true;
  if (task.sessionID) return false;
  if (task.agent && child.agent && task.agent !== child.agent) return false;
  const title = normalized(child.title ?? "");
  const description = normalized(task.description);
  return Boolean(description) && title.includes(description);
}

function attachChild(task: SubagentTask, child: Session, statuses: Record<string, SessionStatus>): SubagentTask {
  const next: SubagentTask = {
    ...task,
    sessionID: child.id,
    child,
    startedAt: task.startedAt ?? child.time?.created,
    endedAt: task.endedAt ?? (statuses[child.id]?.type === "idle" ? child.time?.updated : undefined),
  };
  if (next.status === "pending") {
    next.status = childStatus(child.id, statuses) ?? "completed";
  }
  return next;
}

function orphanTask(child: Session, parentSessionID: string, statuses: Record<string, SessionStatus>): SubagentTask {
  const status = childStatus(child.id, statuses) ?? "completed";
  return {
    id: `session:${child.id}`,
    parentSessionID: child.parentID ?? parentSessionID,
    sessionID: child.id,
    agent: child.agent ?? "subagent",
    description: stripSubagentTitle(child.title ?? child.id),
    prompt: "",
    status,
    startedAt: child.time?.created,
    endedAt: status === "running" ? undefined : child.time?.updated,
    child,
  };
}

export function stripSubagentTitle(title: string) {
  return title.replace(/\s*\(@[^)]+\s+subagent\)\s*$/i, "").trim();
}

function isSubagentSession(child: Session) {
  return /\(@[^)]+\s+subagent\)/i.test(child.title ?? "");
}

/**
 * 从当前会话的消息与 children 列表推导子代理任务。
 * task 工具是主路径；subtask part 和没有 part 的子会话作为兼容兜底。
 */
export function buildSubagentTasks(
  messages: Message[],
  parentSessionID: string | null,
  children: Session[],
  statuses: Record<string, SessionStatus>,
): SubagentTask[] {
  if (!parentSessionID) return [];
  const tasks: SubagentTask[] = [];
  const seenParts = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      const task =
        fromTaskTool(part, parentSessionID, message.info.time?.created) ??
        fromSubtaskPart(part, parentSessionID, message.info.time?.created);
      if (!task || seenParts.has(task.id)) continue;
      seenParts.add(task.id);
      tasks.push(task);
    }
  }

  const usedChildren = new Set<string>();
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    let child = task.sessionID
      ? children.find((item) => item.id === task.sessionID)
      : children.find((item) => !usedChildren.has(item.id) && childMatchesTask(item, task));
    if (!child) continue;
    usedChildren.add(child.id);
    tasks[index] = attachChild(task, child, statuses);
  }

  for (const child of children) {
    if (usedChildren.has(child.id)) continue;
    if (tasks.some((task) => task.sessionID === child.id)) continue;
    if (!isSubagentSession(child)) continue;
    usedChildren.add(child.id);
    tasks.push(orphanTask(child, parentSessionID, statuses));
  }

  // 没拿到 children 时仍保留 task part 自身的信息。
  return tasks.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
}

export interface TodoProgress {
  total: number;
  completed: number;
  cancelled: number;
  resolved: number;
  open: number;
  percent: number;
  active?: TodoItem;
}

export function todoProgress(todos: TodoItem[]): TodoProgress {
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const cancelled = todos.filter((todo) => todo.status === "cancelled").length;
  const resolved = completed + cancelled;
  const active =
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending");
  return {
    total: todos.length,
    completed,
    cancelled,
    resolved,
    open: todos.length - resolved,
    percent: todos.length === 0 ? 0 : Math.round((resolved / todos.length) * 100),
    active,
  };
}

export type TaskActivityKind = "text" | "reasoning" | "tool";

export interface TaskActivityItem {
  id: string;
  kind: TaskActivityKind;
  title: string;
  detail: string;
  status?: string;
  time?: number;
}

function clip(value: string) {
  const trimmed = value.trim();
  return trimmed.length > MAX_ACTIVITY_PREVIEW
    ? `${trimmed.slice(0, MAX_ACTIVITY_PREVIEW)}…`
    : trimmed;
}

/** 子会话最近的活动；工具标题、思考摘录和正文都保留有限长度，避免侧栏被长报告撑爆。 */
export function taskActivities(messages: Message[], limit = 24): TaskActivityItem[] {
  const result: TaskActivityItem[] = [];
  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.synthetic) continue;
      if (part.type === "tool") {
        const state = asRecord(part.state);
        const time = asRecord(state?.time);
        result.push({
          id: part.id,
          kind: "tool",
          title: text(state?.title) || text(part.tool) || "工具调用",
          detail: "",
          status: text(state?.status) || "pending",
          time: numberValue(time?.end) ?? numberValue(time?.start),
        });
        continue;
      }
      if (part.type === "reasoning") {
        const detail = clip(text(part.text));
        if (!detail) continue;
        const time = asRecord(part.time);
        result.push({
          id: part.id,
          kind: "reasoning",
          title: "思考",
          detail,
          time: numberValue(time?.end) ?? numberValue(time?.start),
        });
        continue;
      }
      if (part.type === "text") {
        const detail = clip(text(part.text));
        if (!detail) continue;
        result.push({
          id: part.id,
          kind: "text",
          title: "输出",
          detail,
          time: message.info.time?.completed ?? message.info.time?.created,
        });
      }
    }
  }
  return result.slice(-limit);
}

export function latestTaskActivity(messages: Message[]): TaskActivityItem | undefined {
  const items = taskActivities(messages, 12);
  return items[items.length - 1];
}
