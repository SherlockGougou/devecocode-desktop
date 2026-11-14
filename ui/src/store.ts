import { create } from "zustand";
import { api } from "./api";
import { reconcileSessionMessages, SessionCache } from "./sessionCache";
import {
  MAX_QUEUE_ATTACHMENT_BYTES,
  MAX_QUEUE_ITEMS,
  newQueueItemID,
  queueAttachmentBytes,
  type PendingSteer,
  type PromptSelection,
  type QueuedMessage,
  type SteerDelivery,
} from "./delivery";
import {
  classifyPreview,
  mimeForPath,
  quickLookFirst,
  type FilePreview,
} from "./filePreview";
import {
  ancestorTreePaths,
  isPathInsideDirectory,
  normalizeTreePath,
  sortFileNodes,
} from "./fileTree";
import { absoluteWorkspacePath } from "./paths";
import { matchMentionFiles, parseMentions } from "./mentions";
import type {
  AgentInfo,
  Attachment,
  BackendPhase,
  CommandInfo,
  FileDiff,
  FileNode,
  GitRepoState,
  MentionRef,
  Message,
  ModelInfo,
  Part,
  PermissionRequest,
  PermissionMode,
  PermissionRule,
  Project,
  QuestionRequest,
  QuestionResult,
  Session,
  SettingsPage,
  SessionStatus,
  TodoItem,
  VcsFileStatus,
} from "./types";
import { newMessageID } from "./ids";
import {
  buildSubagentTasks,
  isBusyStatus,
  markInterruptedMessages,
  normalizeTodos,
} from "./tasks";
import {
  highestModelVariant,
  isModelAvailable,
  modelKey,
  readHiddenModels,
  writeHiddenModels,
} from "./models";
import {
  PERMISSION_MODE_LABELS,
  canControlPermission,
  hardPermissionRules,
  hasCustomSessionPermission,
  ownedPermissionMode,
  rulesForMode,
} from "./sessionPermission";
import {
  awaitPermissionPatch,
  type PermissionPatchResult,
} from "./permissionGate";
import {
  mergeQuestionChanges,
  normalizeQuestionAnswers,
  normalizeQuestionRequest,
  type QuestionChange,
} from "./questions";

export type RightTab = "changes" | "files" | "device" | "tasks";
export type ChangeSource = "workspace" | "session";
export type MessageEditPhase = "idle" | "reverting" | "reverted" | "prompting";

export interface MessageEditModel {
  providerID: string;
  modelID: string;
  variant?: string;
}

/** 编辑期间保存完整的初始草稿，避免消息快照刷新导致编辑器卸载或丢附件。 */
export interface MessageEditTarget {
  sessionID: string;
  messageID: string;
  text: string;
  uploads: Part[];
  agent?: string;
  model?: MessageEditModel;
}

export interface EditedMessageInput {
  messageID: string;
  text: string;
  uploads: Part[];
  agent?: string;
  model?: MessageEditModel;
}

/** 没有当前会话时视觉上回退到工作区，但保留用户上次的来源偏好。 */
export function resolvedChangeSource(
  source: ChangeSource,
  sessionID: string | null,
): ChangeSource {
  return source === "session" && !sessionID ? "workspace" : source;
}

const LAST_DIR = "deveco.desktop.dir";
const LAST_SESSION = "deveco.desktop.session";
const LOCAL_WORKSPACES = "deveco.desktop.workspaces";
// CLI 的 /project 没有删除接口，移除只能由桌面端持久化为“不展示”。
const REMOVED_WORKSPACES = "deveco.desktop.removedWorkspaces";
const WORKSPACE_ORDER = "deveco.desktop.workspaceOrder";
const SESSION_SORT = "deveco.desktop.sessionSort";
const SESSION_PREVIEW = "deveco.desktop.sessionPreview";
const UNREAD_SESSIONS = "deveco.desktop.unreadSessions";
const SIDEBAR_OPEN = "deveco.desktop.sidebarOpen";
const RIGHT_WIDTH = "deveco.desktop.rightWidth";
const TERMINAL_OPEN = "deveco.desktop.terminalOpen";
const TERMINAL_HEIGHT = "deveco.desktop.terminalHeight";
const RIGHT_TAB_ORDER = "deveco.desktop.rightTabOrder";
const OVERVIEW_PINNED = "deveco.desktop.overviewPinned";
const CHANGE_SOURCE = "deveco.desktop.changeSource";
const FILE_SHOW_IGNORED = "deveco.desktop.fileShowIgnored";
export const RIGHT_PANEL_MIN_WIDTH = 320;
export const TERMINAL_MIN_HEIGHT = 160;
export const TERMINAL_DEFAULT_HEIGHT = 280;
const DEFAULT_RIGHT_TAB_ORDER: readonly RightTab[] = [
  "changes",
  "files",
  "tasks",
  "device",
];
/** 启动阶段读取工作区可能被 macOS 文件夹授权弹窗阻塞，给用户留足处理时间。 */
const BOOT_LOAD_TIMEOUT_MS = 5 * 60 * 1000;
const BTW_TIMEOUT_MS = 90_000;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let previewRequest = 0;
let sessionOpenRequest = 0;
const sessionCache = new SessionCache();

function rememberCurrentSession(state: AppState): void {
  const { directory, sessionID, sessionLoading, messages } = state;
  if (!directory || !sessionID || sessionLoading) return;
  // 只有已成功读取过的快照可以复用，避免把失败请求的部分事件当成完整历史。
  if (sessionCache.get(directory, sessionID) !== undefined) {
    sessionCache.set(directory, sessionID, messages);
  }
}
let permissionWatchTimer: ReturnType<typeof setTimeout> | null = null;
let permissionWatchToken = 0;
let tasksRequest = 0;
let overviewRequest = 0;
let changesRequest = 0;
let fileStatusRequest = 0;
let fileSearchRequest = 0;
let panelRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const fileDirRequests = new Map<string, number>();

type BtwPending = {
  sessionID: string;
  directory: string;
  text: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const btwPending = new Map<string, BtwPending>();

function newAsideID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `btw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function takeBtw(asideID: string): BtwPending | undefined {
  const pending = btwPending.get(asideID);
  if (!pending) return undefined;
  btwPending.delete(asideID);
  clearTimeout(pending.timer);
  return pending;
}

function cancelBtwPending() {
  for (const [asideID, pending] of btwPending) {
    btwPending.delete(asideID);
    clearTimeout(pending.timer);
    pending.reject(new Error("提交信息生成已取消"));
  }
}

/** Agent 偶尔会把提交信息包在代码块或标题里，提交前只做保守清理。 */
function normalizeCommitMessage(value: string): string {
  let text = value.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();
  }
  text = text.replace(/^(?:提交信息|commit message)\s*[:：]\s*/i, "");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text.slice(0, 4000);
}

function buildCommitPrompt(
  git: GitRepoState,
  diff: FileDiff[],
  todos: TodoItem[],
  title: string,
) {
  const files = git.files
    .slice(0, 80)
    .map(
      (file) =>
        `- [${file.status}] ${file.path}${file.staged ? "（已暂存）" : ""}${file.unstaged ? "（工作区）" : ""}`,
    )
    .join("\n");
  const todo = todos
    .filter((item) => item.status === "completed" || item.status === "in_progress")
    .slice(-12)
    .map((item) => `- [${item.status}] ${item.content}`)
    .join("\n");
  let patch = "";
  for (const entry of diff.slice(0, 32)) {
    if (!entry.patch) continue;
    const next = `### ${entry.file}\n${entry.patch}\n\n`;
    if (patch.length + next.length > 60_000) break;
    patch += next;
  }
  return [
    "请为当前工作区即将提交的改动生成一条 Git 提交信息。",
    "只输出提交信息本身，不要解释、不要使用代码块、不要执行工具。",
    "语言跟随当前会话；无法判断时使用中文。标题尽量简洁，必要时可以附带一行正文。",
    title ? `会话：${title}` : "",
    todo ? `最近任务上下文：\n${todo}` : "",
    `变更文件：\n${files || "（工作区状态未返回文件列表）"}`,
    `变更统计：${git.files.length} 个文件，+${git.additions} −${git.deletions}`,
    patch ? `变更内容（可能截断）：\n${patch}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function hasRunningAgent(state: Pick<AppState, "streaming" | "sessionStatuses">) {
  return (
    state.streaming ||
    Object.values(state.sessionStatuses).some(
      (status) => status.type === "busy" || status.type === "retry",
    )
  );
}

const stopTimers = new Map<string, ReturnType<typeof setTimeout>>();
const deliveryReconciling = new Set<string>();
const idleDuringSend = new Set<string>();
/** 引导消息从 prompt_async 返回到异步落库之间的观察窗口。 */
const STEER_PERSIST_GRACE_MS = 1500;
/** 等待引导消息落库后再重新对账，避免与仍在途的 prompt 重复执行。 */
const steerWakeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 当前会话是否正在执行；排队/引导的判断都走这一个口径。 */
function isSessionBusy(
  state: Pick<AppState, "sessionID" | "streaming" | "busySessions" | "stoppingSessions">,
  sessionID: string | null,
): boolean {
  if (!sessionID) return false;
  return (
    state.busySessions[sessionID] === true ||
    state.stoppingSessions[sessionID] === true ||
    (state.sessionID === sessionID && state.streaming)
  );
}

/** 新发出的引导可能还没落库；等过观察窗口再唤醒，避免并发起第二轮。 */
function scheduleSteerRecheck(sessionID: string, pending: PendingSteer[]): void {
  const newest = pending.reduce(
    (latest, item) => Math.max(latest, item.createdAt),
    0,
  );
  const delay = Math.max(
    200,
    STEER_PERSIST_GRACE_MS - (Date.now() - newest) + 100,
  );
  const existing = steerWakeTimers.get(sessionID);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    steerWakeTimers.delete(sessionID);
    const state = useApp.getState();
    if ((state.pendingSteers[sessionID]?.length ?? 0) === 0) return;
    if (isSessionBusy(state, sessionID)) return;
    void state.handleDeliveryIdle(sessionID);
  }, delay);
  steerWakeTimers.set(sessionID, timer);
}

function currentSelection(
  state: Pick<AppState, "selectedModel" | "selectedAgent" | "selectedVariant">,
): PromptSelection {
  return {
    model: state.selectedModel,
    agent: state.selectedAgent,
    variant: state.selectedVariant,
  };
}

function messageText(parts: Part[]): string {
  return parts
    .filter((part) => part.type === "text" && !part.synthetic)
    .map((part) => part.text ?? "")
    .join("\n");
}

function messageModel(info: Message["info"]): MessageEditModel | undefined {
  const nested = info.model;
  if (nested?.providerID && nested.modelID) {
    return {
      providerID: nested.providerID,
      modelID: nested.modelID,
      ...(nested.variant ? { variant: nested.variant } : {}),
    };
  }
  if (info.providerID && info.modelID) {
    return {
      providerID: info.providerID,
      modelID: info.modelID,
      ...(info.variant ? { variant: info.variant } : {}),
    };
  }
  return undefined;
}

/** 返回不可编辑的原因；null 表示可以编辑。 */
export function messageEditProblem(message: Message): string | null {
  if (message.info.role !== "user") return "只有用户消息可以编辑";
  const parts = message.parts.filter((part) => !part.synthetic);
  if (
    parts.some((part) => part.type !== "text" && part.type !== "file")
  ) {
    return "这条消息包含内联命令，暂不支持编辑";
  }
  if (!messageText(message.parts).trim() && !parts.some((part) => part.type === "file")) {
    return "这条消息没有可编辑内容";
  }
  return null;
}

function editSeed(message: Message, sessionID: string): MessageEditTarget {
  const text = messageText(message.parts);
  const files = message.parts.filter((part) => part.type === "file" && !part.synthetic);
  const used = matchMentionFiles(text, files).used;
  const seed: MessageEditTarget = {
    sessionID,
    messageID: message.info.id,
    text,
    uploads: files.filter((part) => !used.has(part.id)),
  };
  if (message.info.agent) seed.agent = message.info.agent;
  const model = messageModel(message.info);
  if (model) seed.model = model;
  return seed;
}

function messageIndex(messages: Message[], messageID: string): number {
  return messages.findIndex((message) => message.info.id === messageID);
}

/** 截断时按 ID 删除旧后缀，而不是按长度切片；prompt 期间可能已有新消息通过 SSE 到达。 */
function messageSuffixIDs(
  messages: Message[],
  messageID: string,
): Set<string> {
  const index = messageIndex(messages, messageID);
  return new Set(
    index === -1
      ? []
      : messages.slice(index).map((message) => message.info.id),
  );
}

function isAtOrAfterMessage(
  messages: Message[],
  messageID: string,
  boundaryID: string,
): boolean {
  const index = messageIndex(messages, messageID);
  const boundary = messageIndex(messages, boundaryID);
  return index !== -1 && boundary !== -1 && index >= boundary;
}

export function revertedCount(
  messages: Message[],
  revert: Session["revert"],
): number {
  if (!revert?.messageID) return 0;
  const index = messageIndex(messages, revert.messageID);
  return index === -1 ? 0 : messages.length - index;
}

function editFailureMessage(error: unknown, suffix = ""): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/SessionBusy|busy/i.test(text)) {
    return "当前会话正在执行，请先停止回复再编辑";
  }
  if (/NotFound|404/i.test(text)) {
    return "消息或会话已不存在，已刷新列表";
  }
  return `重新发送失败：${text}${suffix}`;
}

function hasPausedPendingSteers(
  state: Pick<AppState, "pendingSteers">,
  sessionID: string,
): boolean {
  return (state.pendingSteers[sessionID] ?? []).some(
    (item) => item.status === "paused" || item.status === "failed",
  );
}

/** 用一次状态快照重算某工作区的侧栏执行指示，避免旧会话残留转圈。 */
function mergeBusySessions(
  current: Record<string, boolean>,
  sessions: Session[],
  statuses: Record<string, SessionStatus>,
) {
  const next = { ...current };
  for (const session of sessions) delete next[session.id];
  for (const [id, status] of Object.entries(statuses)) {
    if (isBusyStatus(status)) next[id] = true;
  }
  return next;
}

function normalizeWorkspace(path: string) {
  const trimmed = path.trim();
  return trimmed === "/" ? trimmed : trimmed.replace(/\/+$/, "");
}

function readChangeSource(): ChangeSource {
  return localStorage.getItem(CHANGE_SOURCE) === "session" ? "session" : "workspace";
}

function readShowIgnored(): boolean {
  return localStorage.getItem(FILE_SHOW_IGNORED) === "1";
}

function normalizeDiff(entries: FileDiff[] | undefined): FileDiff[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (entry): entry is FileDiff => Boolean(entry && typeof entry.file === "string" && entry.file),
  );
}

/** CLI 从 Finder 启动时的中性工作目录，不属于用户工作区，不能出现在侧栏。 */
function isInternalWorkspace(path: string) {
  return normalizeWorkspace(path).endsWith(
    "/Library/Application Support/DevEco Code Desktop/server-cwd",
  );
}

/** 右栏固定下限，上限随窗口宽度变化：始终不超过窗口总宽度的一半。 */
export function clampRightPanelWidth(width: number, viewportWidth = window.innerWidth) {
  const max = Math.max(1, Math.floor(viewportWidth / 2));
  const min = Math.min(RIGHT_PANEL_MIN_WIDTH, max);
  return Math.min(max, Math.max(min, Math.round(width)));
}

/** 终端高度上限跟随窗口：小窗口下不能把聊天区完全挤没。 */
export function clampTerminalHeight(height: number, viewportHeight = window.innerHeight) {
  const max = Math.max(
    TERMINAL_MIN_HEIGHT,
    Math.min(640, Math.round(viewportHeight * 0.65)),
  );
  return Math.min(max, Math.max(TERMINAL_MIN_HEIGHT, Math.round(height)));
}

export type SessionSort = "updated" | "created" | "title";
export type SessionPreview = 5 | 10 | 20 | "all";

function readSessionSort(): SessionSort {
  const value = localStorage.getItem(SESSION_SORT);
  return value === "created" || value === "title" ? value : "updated";
}

function readSessionPreview(): SessionPreview {
  const value = localStorage.getItem(SESSION_PREVIEW);
  if (value === "all") return "all";
  const count = Number(value);
  return count === 10 || count === 20 ? count : 5;
}

function readUnreadSessions(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(UNREAD_SESSIONS) ?? "[]");
    if (!Array.isArray(parsed)) return {};
    const result: Record<string, boolean> = {};
    for (const value of parsed) {
      if (typeof value === "string" && value) result[value] = true;
    }
    return result;
  } catch {
    return {};
  }
}

function rememberUnreadSessions(sessions: Record<string, boolean>) {
  const ids = Object.keys(sessions).filter((id) => sessions[id]);
  if (ids.length === 0) localStorage.removeItem(UNREAD_SESSIONS);
  else localStorage.setItem(UNREAD_SESSIONS, JSON.stringify(ids));
}

/** 会话被删除或工作区被移除后，未读标记不能继续留在 Dock 角标里。 */
function withoutUnread(
  sessions: Record<string, boolean>,
  ids: Iterable<string>,
): Record<string, boolean> {
  let next: Record<string, boolean> | null = null;
  for (const id of ids) {
    if (!sessions[id]) continue;
    next ??= { ...sessions };
    delete next[id];
  }
  return next ?? sessions;
}

function removedSessionIds(
  previous: Session[] | undefined,
  next: Session[],
): string[] {
  if (!previous || previous.length === 0) return [];
  const keep = new Set(next.map((session) => session.id));
  return previous
    .filter((session) => !keep.has(session.id))
    .map((session) => session.id);
}

function readRightTabOrder(): RightTab[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RIGHT_TAB_ORDER) ?? "[]");
    const seen = new Set<RightTab>();
    const order: RightTab[] = [];
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        if (
          !DEFAULT_RIGHT_TAB_ORDER.includes(value as RightTab) ||
          seen.has(value as RightTab)
        ) {
          continue;
        }
        seen.add(value as RightTab);
        order.push(value as RightTab);
      }
    }
    // 存储损坏或未来新增标签时，补齐缺失项并保持默认顺序。
    for (const tab of DEFAULT_RIGHT_TAB_ORDER) {
      if (!seen.has(tab)) order.push(tab);
    }
    return order;
  } catch {
    return [...DEFAULT_RIGHT_TAB_ORDER];
  }
}

function rememberRightTabOrder(order: RightTab[]) {
  localStorage.setItem(RIGHT_TAB_ORDER, JSON.stringify(order));
}

function readPathList(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string") continue;
      const path = normalizeWorkspace(value);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
    return paths;
  } catch {
    return [];
  }
}

function readLocalWorkspaces(): string[] {
  return readPathList(LOCAL_WORKSPACES);
}

function readRemovedWorkspaces(): string[] {
  return readPathList(REMOVED_WORKSPACES);
}

function readWorkspaceOrder(): string[] {
  return readPathList(WORKSPACE_ORDER);
}

function rememberWorkspaceOrder(projects: Project[]) {
  const order = projects
    .map((project) => normalizeWorkspace(project.worktree))
    .filter(Boolean);
  localStorage.setItem(WORKSPACE_ORDER, JSON.stringify(order));
}

function applyWorkspaceOrder(projects: Project[]) {
  const order = readWorkspaceOrder();
  if (order.length === 0) return projects;
  const rank = new Map(order.map((path, index) => [path, index]));
  projects.sort(
    (a, b) =>
      (rank.get(normalizeWorkspace(a.worktree)) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(normalizeWorkspace(b.worktree)) ?? Number.MAX_SAFE_INTEGER),
  );
  return projects;
}

function rememberLocalWorkspace(path: string) {
  const normalized = normalizeWorkspace(path);
  if (!normalized) return;
  const next = [
    normalized,
    ...readLocalWorkspaces().filter((item) => item !== normalized),
  ];
  localStorage.setItem(LOCAL_WORKSPACES, JSON.stringify(next));
}

function forgetLocalWorkspace(path: string) {
  const normalized = normalizeWorkspace(path);
  if (!normalized) return;
  const next = readLocalWorkspaces().filter((item) => item !== normalized);
  localStorage.setItem(LOCAL_WORKSPACES, JSON.stringify(next));
}

function rememberRemovedWorkspace(path: string) {
  const normalized = normalizeWorkspace(path);
  if (!normalized) return;
  const next = [
    normalized,
    ...readRemovedWorkspaces().filter((item) => item !== normalized),
  ];
  localStorage.setItem(REMOVED_WORKSPACES, JSON.stringify(next));
}

function forgetRemovedWorkspace(path: string) {
  const normalized = normalizeWorkspace(path);
  if (!normalized) return;
  const next = readRemovedWorkspaces().filter((item) => item !== normalized);
  localStorage.setItem(REMOVED_WORKSPACES, JSON.stringify(next));
}

function workspaceLabel(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function isPermissionError(error: unknown) {
  return /DirectoryUnreadableError|Operation not permitted|PermissionDenied|EPERM|EACCES|权限/i.test(
    String(error),
  );
}

function isRetryableWorkspaceError(error: unknown, patient: boolean) {
  return isPermissionError(error) || (patient && String(error).includes("未响应"));
}

function workspaceLoadError(error: unknown, patient: boolean, prefix = "读取会话失败") {
  const text = String(error);
  if (isPermissionError(error)) {
    return "无法读取工作区：请在「系统设置 → 隐私与安全性 → 文件与文件夹」中允许 DevEco Code 访问「文稿」，恢复后会自动重载。";
  }
  if (text.includes("未响应")) {
    return patient
      ? "等待文件夹访问授权超时。请先允许 macOS 的文件夹访问请求，恢复后会自动重载。"
      : `${text}。若 macOS 正在请求文件夹访问权限，请先允许后再重试。`;
  }
  return `${prefix}：${text}`;
}

function stopPermissionWatch() {
  permissionWatchToken += 1;
  if (permissionWatchTimer) {
    clearTimeout(permissionWatchTimer);
    permissionWatchTimer = null;
  }
}

/**
 * 权限被拒/超时后，旧请求已经结束；macOS 授权变化不会主动通知 WebView。
 * 用一个很轻的路径探测轮询，等用户从系统设置回来并恢复权限后自动重载工作区。
 */
function watchPermission(directory: string) {
  stopPermissionWatch();
  const token = permissionWatchToken;
  const tick = async () => {
    if (token !== permissionWatchToken) return;
    if (useApp.getState().directory !== directory) return;

    let exists: boolean | null = null;
    try {
      exists = await api.pathExists(directory);
    } catch {
      // 探测失败本身不代表权限恢复，继续等下一轮
    }
    if (token !== permissionWatchToken) return;

    if (exists === false) {
      // 目录确实不存在，不再轮询；保留原错误让用户看到结果。
      permissionWatchTimer = null;
      return;
    }
    if (exists === true) {
      permissionWatchTimer = null;
      stopPermissionWatch();
      await useApp.getState().selectProject(directory, { retry: true });
      return;
    }
    permissionWatchTimer = setTimeout(tick, 2000);
  };
  permissionWatchTimer = setTimeout(tick, 2000);
}

function upsertSession(list: Session[], session: Session): Session[] {
  const index = list.findIndex((item) => item.id === session.id);
  if (index === -1) return [session, ...list];
  const next = list.slice();
  // revert 是可选字段：CLI 在 unrevert/cleanup 后直接省略它。
  // 若仍按普通 spread 合并，旧边界会永久残留并把新消息误判为已回滚。
  next[index] = { ...next[index], ...session, revert: session.revert };
  return next;
}

function upsertQuestion(
  list: QuestionRequest[],
  request: QuestionRequest,
): QuestionRequest[] {
  const index = list.findIndex((item) => item.id === request.id);
  if (index === -1) return [...list, request];
  const next = list.slice();
  next[index] = request;
  return next;
}

let questionChangeSequence = 0;
const questionChanges: QuestionChange[] = [];

function noteQuestionUpsert(request: QuestionRequest): void {
  questionChangeSequence += 1;
  questionChanges.push({
    sequence: questionChangeSequence,
    kind: "upsert",
    request,
  });
}

function noteQuestionRemove(id: string): void {
  if (!id) return;
  questionChangeSequence += 1;
  questionChanges.push({
    sequence: questionChangeSequence,
    kind: "remove",
    id,
  });
}

function noteQuestionSessionClear(sessionID: string): void {
  if (!sessionID) return;
  questionChangeSequence += 1;
  questionChanges.push({
    sequence: questionChangeSequence,
    kind: "session",
    sessionID,
  });
}

/** 快照只覆盖发起请求那一刻的状态，之后的 SSE/本地变更必须重新应用。 */
function mergeQuestionSnapshot(
  snapshot: QuestionRequest[],
  since: number,
): QuestionRequest[] {
  return mergeQuestionChanges(snapshot, questionChanges, since);
}

/** 权限写入在途时，后续 prompt 必须等它完成，避免用旧规则启动新一轮。 */
let permissionPatch: Promise<PermissionPatchResult> = Promise.resolve("ok");
let permissionPatchToken = 0;

function applySessionPermission(
  directory: string,
  sessionID: string,
  permission: PermissionRule[],
  previous: PermissionRule[] | undefined,
  options?: { notice?: string; errorPrefix?: string },
): Promise<PermissionPatchResult> {
  const token = ++permissionPatchToken;
  const task = (async (): Promise<PermissionPatchResult> => {
    try {
      const updated = await api.updateSessionPermission(
        directory,
        sessionID,
        permission,
      );
      if (token !== permissionPatchToken) return "superseded";
      permissionPatch = Promise.resolve("ok");
      const current = useApp.getState();
      const list = current.sessions[directory] ?? [];
      useApp.setState({
        sessions: {
          ...current.sessions,
          [directory]: upsertSession(list, updated),
        },
        permissionUpdating: false,
      });
      if (options?.notice) current.showNotice(options.notice);
      return "ok";
    } catch (error) {
      if (token !== permissionPatchToken) return "superseded";
      // 已在途的发送会从旧 Promise 读到 failed 并中止；之后的新发送使用
      // 已回滚后的真实权限，不应被一次失败永久阻塞。
      permissionPatch = Promise.resolve("ok");
      const current = useApp.getState();
      const list = current.sessions[directory] ?? [];
      const session = list.find((item) => item.id === sessionID);
      useApp.setState({
        ...(session
          ? {
              sessions: {
                ...current.sessions,
                [directory]: upsertSession(list, {
                  ...session,
                  permission: previous,
                }),
              },
            }
          : {}),
        permissionUpdating: false,
        error: `${options?.errorPrefix ?? "切换会话权限失败"}：${String(error)}`,
      });
      return "failed";
    }
  })();
  permissionPatch = task;
  return task;
}

function upsertMessage(list: Message[], info: Message["info"]): Message[] {
  const index = list.findIndex((m) => m.info.id === info.id);
  if (index === -1) return [...list, { info, parts: [] }];
  const next = list.slice();
  next[index] = { ...next[index], info: { ...next[index].info, ...info } };
  return next;
}

function upsertPart(list: Message[], part: Part, observedAt?: number): Message[] {
  const withObservedAt = (current?: Part): Part => {
    if (observedAt === undefined) return part;
    if (current?.streamedAt !== undefined) return part;
    if (part.streamedAt !== undefined) return part;
    return { ...part, streamedAt: observedAt };
  };
  const messageIndex = list.findIndex((m) => m.info.id === part.messageID);
  if (messageIndex === -1) {
    // 事件先到、消息后到：先建占位，等 message.updated 补齐信息
    return [
      ...list,
      {
        info: { id: part.messageID, sessionID: part.sessionID, role: "assistant" },
        parts: [withObservedAt()],
      },
    ];
  }
  const next = list.slice();
  const message = next[messageIndex];
  const partIndex = message.parts.findIndex((p) => p.id === part.id);
  const parts = message.parts.slice();
  if (partIndex === -1) parts.push(withObservedAt());
  else parts[partIndex] = { ...parts[partIndex], ...withObservedAt(parts[partIndex]) };
  next[messageIndex] = { ...message, parts };
  return next;
}

/** 用事件流里的增量覆盖快照，同一条消息按 part id 合并，避免刷新时丢掉刚到的活动。 */
function mergeMessages(base: Message[], overlay: Message[]): Message[] {
  const merged = base.slice();
  const indices = new Map(merged.map((message, index) => [message.info.id, index]));
  for (const message of overlay) {
    const index = indices.get(message.info.id);
    if (index === undefined) {
      indices.set(message.info.id, merged.length);
      merged.push(message);
      continue;
    }
    const current = merged[index];
    const parts = current.parts.slice();
    const partIndices = new Map(parts.map((part, i) => [part.id, i]));
    for (const part of message.parts) {
      const partIndex = partIndices.get(part.id);
      if (partIndex === undefined) {
        partIndices.set(part.id, parts.length);
        parts.push(part);
      }
      else parts[partIndex] = { ...parts[partIndex], ...part };
    }
    merged[index] = {
      info: { ...current.info, ...message.info },
      parts,
    };
  }
  return merged;
}

/** 从已有会话切回新会话草稿时，清掉只属于上一个会话的瞬时数据。 */
function emptyConversationPatch() {
  return {
    sessionID: null,
    sessionLoading: false,
    messages: [],
    todos: [],
    sessionChildren: [],
    childMessages: {},
    childTodos: {},
    sessionStatuses: {},
    selectedTaskID: null,
    tasksLoading: false,
    streaming: false,
    sessionDiff: [],
    diffPath: null,
    overviewGit: null,
    overviewLoading: false,
    overviewError: null,
    commitMessage: "",
    commitMessageGenerating: false,
    commitMessageError: null,
    committing: false,
    pushing: false,
    draftPermissionMode: null as PermissionMode | null,
    failedText: null,
    findOpen: false,
    findQuery: "",
    findIndex: 0,
    editing: null,
    editPhase: "idle" as MessageEditPhase,
  };
}

function emptyFileTreePatch() {
  return {
    fileTree: {},
    expandedDirs: {},
    fileLoading: {},
    fileErrors: {},
    fileSearchResults: [] as string[],
    fileSearching: false,
    fileSearchError: null,
    fileStatuses: {} as Record<string, VcsFileStatus>,
    fileQuery: "",
    fileFocusPath: null,
  };
}

export interface AppState {
  booting: boolean;
  bootMessage: string;
  error: string | null;
  projects: Project[];
  expanded: Record<string, boolean>;
  sessions: Record<string, Session[]>;
  loadedDirs: Record<string, boolean>;
  searchResults: Record<string, Session[]>;
  searching: boolean;
  models: ModelInfo[];
  hiddenModels: string[];
  modelsLoading: boolean;
  modelsError: string | null;
  agents: AgentInfo[];
  selectedAgent: string;
  commands: CommandInfo[];
  mcpCount: number;
  selectedVariant: string | null;
  selectedModel: { providerID: string; modelID: string } | null;
  preview: FilePreview | null;
  directory: string | null;
  sessionID: string | null;
  sessionLoading: boolean;
  messages: Message[];
  permissions: PermissionRequest[];
  /** 当前工作区所有待回答请求，按会话自行筛选展示 */
  questions: QuestionRequest[];
  /** 已回答/已跳过结果，客户端先于工具快照更新时保持卡片稳定 */
  questionResults: Record<string, QuestionResult>;
  /** 正在提交回答或跳过的请求，防止重复点击 */
  questionBusy: Record<string, "reply" | "reject">;
  todos: TodoItem[];
  sessionChildren: Session[];
  childMessages: Record<string, Message[]>;
  childTodos: Record<string, TodoItem[]>;
  sessionStatuses: Record<string, SessionStatus>;
  /** 所有工作区里正在执行的会话（跨目录），仅用于侧栏标题前的加载指示 */
  busySessions: Record<string, boolean>;
  /** 执行已结束、但用户还没打开查看的会话（跨目录），侧栏标题前显示未读圆点 */
  unreadSessions: Record<string, boolean>;
  /** 每个会话待发送的消息，按 FIFO 保存；只在内存中，不跨应用重启 */
  queuedMessages: Record<string, QueuedMessage[]>;
  /** 停止当前轮后暂停自动发送，保留队列 */
  queuePaused: Record<string, boolean>;
  /** 正在把某条排队消息交给 CLI，避免 idle 重复触发 */
  queueSending: Record<string, boolean>;
  /** 已发送但还没有被当前轮消费的引导消息 */
  pendingSteers: Record<string, PendingSteer[]>;
  /** 引导消息 ID，用于在对话流里显示“引导”标记 */
  steerMessageIDs: Record<string, string[]>;
  /** 正在停止的会话；停止确认前仍按忙碌处理 */
  stoppingSessions: Record<string, boolean>;
  /** 首条消息正在创建会话，阻止并发创建第二个会话 */
  creatingSession: boolean;
  /** 新会话草稿的权限选择；null 表示跟随 Agent 默认 */
  draftPermissionMode: PermissionMode | null;
  /** 会话权限正在写入 CLI，期间禁用选择器并阻止重复提交 */
  permissionUpdating: boolean;
  /** 正在内联编辑的历史用户消息；为空表示不在编辑态 */
  editing: MessageEditTarget | null;
  /** 编辑提交阶段：idle → reverting → reverted → prompting */
  editPhase: MessageEditPhase;
  selectedTaskID: string | null;
  tasksLoading: boolean;
  streaming: boolean;
  sseOk: boolean;
  sseCount: number;
  /** 后端（本机 deveco serve）状态：自愈过程对用户可见 */
  backend: BackendPhase;
  rightOpen: boolean;
  rightWidth: number;
  terminalOpen: boolean;
  terminalHeight: number;
  overviewOpen: boolean;
  overviewPinned: boolean;
  overviewGit: GitRepoState | null;
  overviewLoading: boolean;
  overviewError: string | null;
  commitMessage: string;
  commitMessageGenerating: boolean;
  commitMessageError: string | null;
  committing: boolean;
  pushing: boolean;
  settingsOpen: boolean;
  settingsPage: SettingsPage;
  shortcutsOpen: boolean;
  rightTab: RightTab;
  rightTabOrder: RightTab[];
  changeSource: ChangeSource;
  workspaceDiff: FileDiff[];
  sessionDiff: FileDiff[];
  changesLoading: boolean;
  changesError: string | null;
  changesRepo: boolean | null;
  changeQuery: string;
  collapsedChangeDirs: string[];
  diffPath: string | null;
  fileTree: Record<string, FileNode[]>;
  expandedDirs: Record<string, boolean>;
  fileLoading: Record<string, boolean>;
  fileErrors: Record<string, string | null>;
  fileSearchResults: string[];
  fileSearching: boolean;
  fileSearchError: string | null;
  fileStatuses: Record<string, VcsFileStatus>;
  fileQuery: string;
  fileFocusPath: string | null;
  showIgnored: boolean;
  filter: string;
  showArchived: boolean;
  sessionSort: SessionSort;
  sessionPreview: SessionPreview;
  failedText: string | null;
  notice: string | null;
  findOpen: boolean;
  findQuery: string;
  findIndex: number;
  sidebarWidth: number;
  sidebarOpen: boolean;
  clearFailedText(): void;
  showNotice(message: string, duration?: number): void;
  openFind(): void;
  closeFind(): void;
  setFindQuery(query: string): void;
  stepFind(delta: number): void;
  setSidebarWidth(width: number): void;
  setRightWidth(width: number): void;
  setTerminalHeight(height: number): void;
  toggleSidebar(): void;

  boot(): Promise<void>;
  selectProject(
    directory: string,
    options?: { patient?: boolean; retry?: boolean; openRecent?: boolean },
  ): Promise<void>;
  openSession(id: string, options?: { patient?: boolean; retry?: boolean }): Promise<void>;
  newSession(): Promise<void>;
  newSessionIn(directory: string): Promise<void>;
  /** 新会话草稿态切换已有工作区；会话一旦开始就不能再改。 */
  changeDraftWorkspace(directory: string): Promise<void>;
  /** 把用户从本机选择的目录加入工作区并切过去，仍保持新会话草稿态。 */
  addWorkspace(directory: string): Promise<void>;
  /** 从侧栏隐藏工作区；不删除目录、CLI 注册表或历史会话。 */
  removeWorkspace(directory: string): Promise<void>;
  /** 清理指向已不存在会话的未读标记 */
  reconcileUnreadSessions(): Promise<void>;
  /** 把工作区拖到 target 的前/后，并持久化自定义顺序。 */
  moveWorkspace(source: string, target: string, after: boolean): void;
  pickWorkspaceFolder(): Promise<void>;
  /** refs 是 Composer 里 @ 引用的工作区文件；不传时行为与之前完全一致 */
  send(text: string, attachments?: Attachment[], refs?: MentionRef[]): Promise<void>;
  beginEditMessage(messageID: string): void;
  cancelEditMessage(): void;
  /** 先 revert 再 prompt，成功后本地截断；失败时按 CLI 状态回滚或保留可重试状态 */
  resendEditedMessage(input: EditedMessageInput): Promise<void>;
  /** 恢复外部 revert 留下的回滚消息与文件 */
  restoreRevertedMessages(): Promise<void>;
  /** 根据当前忙碌状态决定排队或引导；返回 false 表示草稿不应被清空 */
  submitMessage(
    text: string,
    attachments: Attachment[] | undefined,
    refs: MentionRef[] | undefined,
    delivery: "queue" | "steer",
  ): boolean;
  enqueueMessage(text: string, attachments?: Attachment[], refs?: MentionRef[]): boolean;
  steerMessage(text: string, attachments?: Attachment[], refs?: MentionRef[]): Promise<void>;
  /** 内部：真正发送一条引导消息，供输入框和队列共用 */
  deliverSteer(input: SteerDelivery): Promise<boolean>;
  steerQueuedMessage(sessionID: string, itemID: string): Promise<void>;
  removeQueuedMessage(sessionID: string, itemID: string): void;
  restoreQueuedMessage(sessionID: string, itemID: string): QueuedMessage | null;
  retryQueuedMessage(sessionID: string, itemID: string): void;
  resumeDelivery(sessionID: string): void;
  retryPendingSteer(sessionID: string, messageID?: string): Promise<void>;
  dismissPendingSteer(sessionID: string, messageID?: string): void;
  drainQueue(sessionID: string): Promise<void>;
  handleDeliveryIdle(sessionID: string): Promise<void>;
  handleDeliveryError(sessionID: string): void;
  reconcilePendingSteers(
    sessionID: string,
  ): Promise<{ remaining: number; failed: number }>;
  wakePendingSteers(sessionID: string): Promise<boolean>;
  supersedePendingSteers(sessionID: string): void;
  clearSessionDelivery(sessionID: string): void;
  finishStopping(sessionID: string): void;
  resumeAllDelivery(): Promise<void>;
  stop(): Promise<void>;
  replyPermission(id: string, reply: "once" | "always" | "reject"): Promise<void>;
  replyQuestion(id: string, answers: string[][]): Promise<boolean>;
  rejectQuestion(id: string): Promise<boolean>;
  /** 停止当前生成，并关闭仍挂起的 question 请求。 */
  stopQuestion(id: string): Promise<void>;
  onSse(raw: string): void;
  onBackend(phase: BackendPhase): void;
  retryBackend(): Promise<void>;
  refreshAfterReconnect(): Promise<void>;
  toggleRight(): void;
  toggleTerminal(): void;
  toggleOverview(): void;
  closeOverview(): void;
  setOverviewPinned(pinned: boolean): void;
  refreshOverview(): Promise<void>;
  setCommitMessage(value: string): void;
  generateCommitMessage(): Promise<string | null>;
  commitChanges(): Promise<void>;
  pushChanges(): Promise<void>;
  openRightTab(tab: RightTab): void;
  openSettings(page?: SettingsPage): void;
  setSettingsPage(page: SettingsPage): void;
  closeSettings(): void;
  openShortcuts(): void;
  closeShortcuts(): void;
  setRightTab(tab: RightTab): void;
  moveRightTab(source: RightTab, target: RightTab, after: boolean): void;
  /** taskID 为空时打开任务列表；传入后直接打开该子代理详情。 */
  openTasks(taskID?: string | null): void;
  closeTaskDetail(): void;
  refreshTasks(): Promise<void>;
  setFilter(value: string): void;
  runSearch(query: string): Promise<void>;
  openSessionIn(directory: string, id: string): Promise<void>;
  toggleProject(directory: string): Promise<void>;
  /** 读取某工作区所有会话的执行状态，补齐侧栏加载指示（不依赖用户先打开会话） */
  refreshBusySessions(directory: string): Promise<void>;
  loadModels(force?: boolean): Promise<void>;
  setModelVisible(model: { providerID: string; modelID: string }, visible: boolean): void;
  loadMeta(): Promise<void>;
  selectAgent(name: string): void;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** 新会话草稿恢复为跟随 Agent 默认；已有会话无对应操作 */
  resetPermissionMode(): void;
  selectVariant(variant: string | null): void;
  selectModel(model: { providerID: string; modelID: string }): void;
  renameSession(directory: string, id: string, title: string): Promise<void>;
  archiveSession(directory: string, id: string, archived: boolean): Promise<void>;
  toggleArchivedView(): void;
  setSessionSort(sort: SessionSort): void;
  setSessionPreview(count: SessionPreview): void;
  /** 全部收起；若有工作区未展开则全部展开并补齐会话列表。 */
  toggleAllProjects(): Promise<void>;
  deleteSession(directory: string, id: string): Promise<void>;
  setChangeSource(source: ChangeSource): void;
  refreshChanges(options?: { silent?: boolean }): Promise<void>;
  setChangeQuery(value: string): void;
  toggleChangeDir(path: string): void;
  setCollapsedChangeDirs(paths: string[]): void;
  openDiff(path: string): void;
  closeDiff(): void;
  openPreview(path: string): Promise<void>;
  refreshFileTree(options?: { silent?: boolean }): Promise<void>;
  loadFileDir(path: string): Promise<void>;
  toggleFileDir(path: string): void;
  revealFileDir(path: string): Promise<void>;
  runFileSearch(query: string): Promise<void>;
  refreshFileStatuses(): Promise<void>;
  setFileQuery(value: string): void;
  setShowIgnored(value: boolean): void;
  setFileFocusPath(path: string | null): void;
  closePreview(): void;
  /** 打开右栏文件页并预览当前工作区内的相对路径 */
  openFile(path: string): Promise<void>;
  dismissError(): void;
}

export const useApp = create<AppState>()((set, get) => ({
  booting: true,
  bootMessage: "正在连接本机 DevEco Code 服务…",
  error: null,
  projects: [],
  expanded: {},
  sessions: {},
  loadedDirs: {},
  searchResults: {},
  searching: false,
  models: [],
  hiddenModels: readHiddenModels(),
  modelsLoading: false,
  modelsError: null,
  agents: [],
  selectedAgent: "build",
  commands: [],
  mcpCount: 0,
  selectedVariant: null,
  selectedModel: null,
  preview: null,
  directory: null,
  sessionID: null,
  sessionLoading: false,
  messages: [],
  permissions: [],
  questions: [],
  questionResults: {},
  questionBusy: {},
  todos: [],
  sessionChildren: [],
  childMessages: {},
  childTodos: {},
  sessionStatuses: {},
  busySessions: {},
  unreadSessions: readUnreadSessions(),
  queuedMessages: {},
  queuePaused: {},
  queueSending: {},
  pendingSteers: {},
  steerMessageIDs: {},
  stoppingSessions: {},
  creatingSession: false,
  draftPermissionMode: null,
  permissionUpdating: false,
  editing: null,
  editPhase: "idle",
  selectedTaskID: null,
  tasksLoading: false,
  streaming: false,
  sseOk: false,
  sseCount: 0,
  backend: { state: "starting", attempt: 0, detail: null },
  rightOpen: false,
  // 窗口变窄时由 App 的 resize 监听重新夹紧，避免恢复旧偏好后超过一半宽度。
  rightWidth: clampRightPanelWidth(
    Number(localStorage.getItem(RIGHT_WIDTH)) || RIGHT_PANEL_MIN_WIDTH,
  ),
  terminalOpen: localStorage.getItem(TERMINAL_OPEN) === "1",
  terminalHeight: clampTerminalHeight(
    Number(localStorage.getItem(TERMINAL_HEIGHT)) || TERMINAL_DEFAULT_HEIGHT,
  ),
  overviewOpen: false,
  overviewPinned: localStorage.getItem(OVERVIEW_PINNED) === "1",
  overviewGit: null,
  overviewLoading: false,
  overviewError: null,
  commitMessage: "",
  commitMessageGenerating: false,
  commitMessageError: null,
  committing: false,
  pushing: false,
  settingsOpen: false,
  settingsPage: "appearance",
  shortcutsOpen: false,
  rightTab: "changes",
  rightTabOrder: readRightTabOrder(),
  changeSource: readChangeSource(),
  workspaceDiff: [],
  sessionDiff: [],
  changesLoading: false,
  changesError: null,
  changesRepo: null,
  changeQuery: "",
  collapsedChangeDirs: [],
  diffPath: null,
  fileTree: {},
  expandedDirs: {},
  fileLoading: {},
  fileErrors: {},
  fileSearchResults: [],
  fileSearching: false,
  fileSearchError: null,
  fileStatuses: {},
  fileQuery: "",
  fileFocusPath: null,
  showIgnored: readShowIgnored(),
  filter: "",
  showArchived: localStorage.getItem("deveco.desktop.showArchived") === "1",
  sessionSort: readSessionSort(),
  sessionPreview: readSessionPreview(),
  failedText: null,
  notice: null,
  findOpen: false,
  findQuery: "",
  findIndex: 0,
  // 读出来的值也要夹紧，避免一条坏数据把三栏挤成竖排
  sidebarWidth: Math.min(
    460,
    Math.max(220, Number(localStorage.getItem("deveco.desktop.sidebarWidth")) || 296),
  ),
  sidebarOpen: localStorage.getItem(SIDEBAR_OPEN) !== "0",

  async boot() {
    const earlyHint = setTimeout(() => {
      if (get().booting) {
        set({
          bootMessage:
            "正在启动本机服务…如果 macOS 正在请求文件夹访问权限，请先允许。",
        });
      }
    }, 4000);
    try {
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          await api.health();
          break;
        } catch (error) {
          if (attempt === 149) {
            set({ booting: false, error: `无法连接本地服务：${String(error)}` });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
    } finally {
      clearTimeout(earlyHint);
    }
    try {
      // 首次启动的路径探测也可能撞上 macOS 的文件夹授权弹窗。用户不点之前
      // 文件访问会一直阻塞，这里不改报“30 秒未响应”，而是继续等并说明原因。
      const hintTimer = setTimeout(() => {
        if (get().booting) {
          set({
            bootMessage:
              "正在等待文件夹访问授权…如果 macOS 正在询问访问「文稿」，请先允许。",
          });
        }
      }, 4000);
      try {
        const all = await api.projects(BOOT_LOAD_TIMEOUT_MS);
        // 工作区注册表里会残留已删除/临时目录，先过滤掉不存在的路径。
        // `null` 表示权限未就绪、无法判断，不能当成目录已删除。
        const existence = await Promise.all(
          all.map((project) => api.pathExists(project.worktree).catch(() => null)),
        );
        const removed = new Set(readRemovedWorkspaces());
        // CLI 的 /project 可能对同一路径返回多条不同 id 的记录，按 worktree 去重
        const seen = new Set<string>();
        const projects = all.filter((project, index) => {
          if (existence[index] === false) return false;
          const key = normalizeWorkspace(project.worktree);
          if (
            !key ||
            isInternalWorkspace(key) ||
            removed.has(key) ||
            seen.has(key)
          ) {
            return false;
          }
          seen.add(key);
          return true;
        });
        // 最近使用的项目排前面
        projects.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
        // 用户通过「新建工作区」选中的目录可能还没有会话，CLI 的 /project
        // 未必会立刻登记；本地保留一份路径，重启后仍然可见。
        const local = readLocalWorkspaces();
        const localExistence = await Promise.all(
          local.map((path) => api.pathExists(path).catch(() => null)),
        );
        const known = new Set(projects.map((project) => normalizeWorkspace(project.worktree)));
        for (let index = 0; index < local.length; index += 1) {
          const path = local[index];
          if (
            localExistence[index] === false ||
            isInternalWorkspace(path) ||
            removed.has(path) ||
            known.has(path)
          ) {
            continue;
          }
          known.add(path);
          projects.push({ id: path, worktree: path });
        }
        // 用户拖出的自定义顺序优先；新出现的工作区排在已知顺序之后。
        applyWorkspaceOrder(projects);
        const saved = localStorage.getItem(LAST_DIR);
        const hint = await api.startupDirectory().catch((err) => {
          // 不要吞掉：命令缺失/权限问题要在界面上看得见
          set({ error: `startup_directory 调用失败：${String(err)}` });
          return null;
        });
        const pick = (candidate: string | null | undefined) =>
          candidate && projects.some((p) => p.worktree === candidate) ? candidate : null;
        const directory = pick(hint) ?? pick(saved) ?? (projects[0]?.worktree ?? null);
        set({
          projects,
          expanded: directory ? { [directory]: true } : {},
          bootMessage: directory ? "正在读取工作区…" : "",
        });
        if (directory) {
          await get().selectProject(directory, { patient: true });
        }
        set({
          booting: false,
          bootMessage: "",
          ...(get().overviewPinned && get().sessionID ? { overviewOpen: true } : {}),
        });
        void get().reconcileUnreadSessions();
        if (get().overviewOpen) void get().refreshOverview();
      } finally {
        clearTimeout(hintTimer);
      }
    } catch (error) {
      set({ booting: false, error: workspaceLoadError(error, true, "读取项目列表失败") });
    }
  },

  async selectProject(directory, options) {
    const patient = options?.patient ?? false;
    const retry = options?.retry ?? false;
    const openRecent = options?.openRecent ?? true;
    const timeout = patient ? BOOT_LOAD_TIMEOUT_MS : undefined;
    localStorage.setItem(LAST_DIR, directory);
    if (!retry) stopPermissionWatch();
    if (retry && get().directory === directory) {
      set({ expanded: { ...get().expanded, [directory]: true } });
    } else {
      rememberCurrentSession(get());
      previewRequest += 1;
      changesRequest += 1;
      fileStatusRequest += 1;
      fileSearchRequest += 1;
      fileDirRequests.clear();
      if (panelRefreshTimer) {
        clearTimeout(panelRefreshTimer);
        panelRefreshTimer = null;
      }
      cancelBtwPending();
      set({
        directory,
        expanded: { ...get().expanded, [directory]: true },
        sessionID: null,
        sessionLoading: false,
        messages: [],
        editing: null,
        editPhase: "idle",
        permissions: [],
        questions: [],
        questionResults: {},
        questionBusy: {},
        todos: [],
        sessionChildren: [],
        childMessages: {},
        childTodos: {},
        sessionStatuses: {},
        selectedTaskID: null,
        tasksLoading: false,
        workspaceDiff: [],
        sessionDiff: [],
        changesLoading: false,
        changesError: null,
        changesRepo: null,
        diffPath: null,
        overviewGit: null,
        overviewLoading: false,
        overviewError: null,
        commitMessage: "",
        commitMessageGenerating: false,
        commitMessageError: null,
        committing: false,
        pushing: false,
        preview: null,
        ...emptyFileTreePatch(),
        error: null,
      });
    }
    try {
      const previousSessions = get().sessions[directory] ?? [];
      const sessions = await api.sessions(directory, timeout);
      sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      const unreadSessions = withoutUnread(
        get().unreadSessions,
        removedSessionIds(previousSessions, sessions),
      );
      if (unreadSessions !== get().unreadSessions) {
        rememberUnreadSessions(unreadSessions);
      }
      set({
        sessions: { ...get().sessions, [directory]: sessions },
        loadedDirs: { ...get().loadedDirs, [directory]: true },
        unreadSessions,
        error: null,
      });
      // 启动/切换工作区时补一次执行状态，已在跑的会话不必等下一次事件才显示
      void get().refreshBusySessions(directory);
      stopPermissionWatch();
      const questionMarker = questionChangeSequence;
      const [permissions, questions] = await Promise.all([
        api.permissions(directory, timeout).catch(() => []),
        api.questions(directory, timeout).catch(() => null),
      ]);
      set({
        permissions,
        ...(questions
          ? { questions: mergeQuestionSnapshot(questions, questionMarker) }
          : {}),
      });
      void get().loadMeta();
      if (!openRecent) {
        // 新会话草稿只加载工作区元数据，不能自动打开最近会话把它顶掉。
        // 如果加载期间用户已经发出首条消息，保留刚创建的会话，不能被迟到的空态覆盖。
        if (get().directory === directory && !get().sessionID) {
          set({ sessionID: null, messages: [], streaming: false });
        }
        return;
      }
      // 和 DSH 一致：切换工作区时直接打开最近（或上次）的会话，而不是停在空白页
      const last = localStorage.getItem(`${LAST_SESSION}.${directory}`);
      const target = sessions.find((item) => item.id === last) ?? sessions[0];
      if (target) await get().openSession(target.id, { patient, retry });
    } catch (error) {
      set({ error: workspaceLoadError(error, patient) });
      if (isRetryableWorkspaceError(error, patient || retry)) watchPermission(directory);
    }
  },

  async openSessionIn(directory, id) {
    if (get().directory !== directory) {
      // 直接打开目标会话，避免 selectProject 先自动打开最近会话、
      // 把另一个还没看的会话误标为已读。
      await get().selectProject(directory, { openRecent: false });
    }
    await get().openSession(id);
  },

  async openSession(id, options) {
    const patient = options?.patient ?? false;
    const retry = options?.retry ?? false;
    const timeout = patient ? BOOT_LOAD_TIMEOUT_MS : undefined;
    const directory = get().directory;
    if (!directory) return;
    const request = ++sessionOpenRequest;
    rememberCurrentSession(get());
    const cached = sessionCache.get(directory, id);
    // 打开会话即视为已读：清掉侧栏的未读圆点。
    if (get().unreadSessions[id]) {
      const unreadSessions = { ...get().unreadSessions };
      delete unreadSessions[id];
      rememberUnreadSessions(unreadSessions);
      set({ unreadSessions });
    }
    localStorage.setItem(`${LAST_SESSION}.${directory}`, id);
    if (!retry) stopPermissionWatch();
    if (retry && get().sessionID === id) {
      set({ sessionLoading: cached === undefined });
    } else {
      cancelBtwPending();
      changesRequest += 1;
      set({
        sessionID: id,
        sessionLoading: cached === undefined,
        messages: cached ?? [],
        todos: [],
        sessionChildren: [],
        childMessages: {},
        childTodos: {},
        sessionStatuses: {},
        selectedTaskID: null,
        tasksLoading: true,
        streaming: get().busySessions[id] === true,
        editing: null,
        editPhase: "idle",
        sessionDiff: [],
        diffPath: null,
        overviewGit: null,
        overviewLoading: false,
        overviewError: null,
        commitMessage: "",
        commitMessageGenerating: false,
        commitMessageError: null,
        committing: false,
        pushing: false,
        ...(get().overviewPinned ? { overviewOpen: true } : {}),
        ...(retry ? {} : { error: null }),
      });
    }
    const baseline = get().messages;
    const baselineStreaming = get().streaming;
    try {
      const questionMarker = questionChangeSequence;
      const [messages, statuses, detail, questions] = await Promise.all([
        api.messages(directory, id, timeout),
        api.sessionStatus(directory, timeout).catch(() => null),
        api.session(directory, id, timeout).catch(() => null),
        api.questions(directory, timeout).catch(() => null),
      ]);
      if (request !== sessionOpenRequest || get().directory !== directory || get().sessionID !== id) return;
      // 只保留请求期间发生的变化，避免旧缓存覆盖服务端的更新或删除。
      const currentMessages = get().messages;
      const merged = reconcileSessionMessages(messages, baseline, currentMessages);
      // 进程被异常结束时 CLI 不会补写工具终态；以 /session/status 为准校正展示。
      const active = get().streaming !== baselineStreaming
        ? get().streaming
        : statuses
          ? isBusyStatus(statuses[id])
          : get().busySessions[id] === true || get().streaming;
      stopPermissionWatch();
      const refreshed = markInterruptedMessages(merged, active);
      sessionCache.set(directory, id, refreshed);
      set({
        sessionLoading: false,
        messages: refreshed,
        streaming: active,
        error: null,
        ...(questions
          ? { questions: mergeQuestionSnapshot(questions, questionMarker) }
          : {}),
        ...(detail
          ? {
              sessions: {
                ...get().sessions,
                [directory]: upsertSession(
                  get().sessions[directory] ?? [],
                  detail,
                ),
              },
            }
          : {}),
        ...(statuses && get().streaming === baselineStreaming
          ? {
              sessionStatuses: statuses,
              busySessions: mergeBusySessions(
                get().busySessions,
                get().sessions[directory] ?? [],
                statuses,
              ),
            }
          : {}),
      });
      if (currentMessages !== baseline) {
        // 流式增量可能从旧缓存继续追加；等消息安静后再读取权威快照补齐缺口。
        const reconcileWhenQuiet = (expected: Message[]) => {
          window.setTimeout(() => {
            if (request !== sessionOpenRequest || get().directory !== directory || get().sessionID !== id) return;
            if (get().editing) return;
            if (get().messages !== expected) {
              reconcileWhenQuiet(get().messages);
              return;
            }
            void api.messages(directory, id).then((latest) => {
              if (request !== sessionOpenRequest || get().directory !== directory || get().sessionID !== id) return;
              if (get().editing) return;
              if (get().messages !== expected) {
                reconcileWhenQuiet(get().messages);
                return;
              }
              const reconciled = markInterruptedMessages(latest, get().streaming || get().busySessions[id] === true);
              sessionCache.set(directory, id, reconciled);
              set({ messages: reconciled });
            }).catch((error) => console.warn("会话后台校对失败", error));
          }, 1500);
        };
        reconcileWhenQuiet(refreshed);
      }
      if (
        !isSessionBusy(get(), id) &&
        ((get().queuedMessages[id]?.length ?? 0) > 0 ||
          (get().pendingSteers[id]?.length ?? 0) > 0)
      ) {
        void get().handleDeliveryIdle(id);
      }
      void get().refreshTasks();
      if (get().overviewOpen) void get().refreshOverview();
      if (get().rightOpen && get().rightTab === "changes") {
        void get().refreshChanges();
      }
    } catch (error) {
      if (request !== sessionOpenRequest || get().directory !== directory || get().sessionID !== id) return;
      set({ sessionLoading: false });
      set({ tasksLoading: false });
      set({ error: cached === undefined ? workspaceLoadError(error, patient) : `刷新会话失败，当前显示缓存：${String(error)}` });
      if (isRetryableWorkspaceError(error, patient || retry)) watchPermission(directory);
    }
  },

  async newSession() {
    const directory = get().directory;
    rememberCurrentSession(get());
    cancelBtwPending();
    set({
      ...emptyConversationPatch(),
      error: null,
      ...(directory
        ? { expanded: { ...get().expanded, [directory]: true } }
        : {}),
    });
    if (get().rightOpen && get().rightTab === "changes") {
      void get().refreshChanges();
    }
  },

  async newSessionIn(directory) {
    if (!directory) return;
    const target = normalizeWorkspace(directory);
    rememberCurrentSession(get());
    if (get().directory !== target) {
      await get().selectProject(target, { openRecent: false });
    }
    set({
      ...emptyConversationPatch(),
      expanded: { ...get().expanded, [target]: true },
      error: null,
    });
    if (get().rightOpen && get().rightTab === "changes") {
      void get().refreshChanges();
    }
  },

  async changeDraftWorkspace(directory) {
    const target = normalizeWorkspace(directory);
    if (!target) return;
    if (get().sessionID || get().messages.length > 0) {
      set({ error: "会话已经包含内容，不能再切换工作区" });
      return;
    }
    if (get().directory === target) {
      set({ expanded: { ...get().expanded, [target]: true } });
      return;
    }
    await get().selectProject(target, { openRecent: false });
  },

  async addWorkspace(directory) {
    const target = normalizeWorkspace(directory);
    if (!target) return;
    if (get().sessionID || get().messages.length > 0) {
      set({ error: "会话已经包含内容，不能再切换工作区" });
      return;
    }
    try {
      const exists = await api.pathExists(target);
      if (exists === false) {
        set({ error: `目录不存在或无法访问：${target}` });
        return;
      }
      // 之前从侧栏移除过的目录，重新选择时应当恢复显示。
      forgetRemovedWorkspace(target);
      const projects = get().projects;
      if (!projects.some((project) => normalizeWorkspace(project.worktree) === target)) {
        const next = [{ id: target, worktree: target }, ...projects];
        set({ projects: next, error: null });
        rememberLocalWorkspace(target);
        rememberWorkspaceOrder(next);
      }
      await get().selectProject(target, { openRecent: false });
    } catch (error) {
      set({ error: `添加工作区失败：${String(error)}` });
    }
  },

  async pickWorkspaceFolder() {
    try {
      const directory = await api.pickWorkspaceFolder();
      if (directory) await get().addWorkspace(directory);
    } catch (error) {
      set({ error: `选择工作区失败：${String(error)}` });
    }
  },

  async removeWorkspace(directory) {
    const target = normalizeWorkspace(directory);
    if (!target) return;
    const state = get();
    const remaining = state.projects.filter(
      (project) => normalizeWorkspace(project.worktree) !== target,
    );
    const sessions = { ...state.sessions };
    const loadedDirs = { ...state.loadedDirs };
    const searchResults = { ...state.searchResults };
    const expanded = { ...state.expanded };
    const deliveryIds = new Set<string>([
      ...(state.sessions[target] ?? []).map((session) => session.id),
      ...Object.entries(state.queuedMessages)
        .filter(([, items]) => items[0]?.directory === target)
        .map(([id]) => id),
      ...Object.entries(state.pendingSteers)
        .filter(([, items]) => items[0]?.directory === target)
        .map(([id]) => id),
    ]);
    for (const id of deliveryIds) get().clearSessionDelivery(id);
    const unreadSessions = withoutUnread(state.unreadSessions, deliveryIds);
    if (unreadSessions !== state.unreadSessions) {
      rememberUnreadSessions(unreadSessions);
    }
    delete sessions[target];
    delete loadedDirs[target];
    delete searchResults[target];
    delete expanded[target];

    rememberRemovedWorkspace(target);
    forgetLocalWorkspace(target);
    set({
      projects: remaining,
      sessions,
      loadedDirs,
      searchResults,
      expanded,
      unreadSessions,
      error: null,
    });
    rememberWorkspaceOrder(remaining);
    void get().reconcileUnreadSessions();

    const label = workspaceLabel(target);
    if (state.directory !== target) {
      get().showNotice(`已从侧栏移除「${label}」；文件夹与历史会话未删除`, 6000);
      return;
    }

    // 移除的是当前工作区：优先切到剩下的第一个；没有则回到“选择工作区”空态。
    stopPermissionWatch();
    localStorage.removeItem(LAST_DIR);
    const next = remaining[0]?.worktree ?? null;
    if (next) {
      await get().selectProject(next);
    } else {
      previewRequest += 1;
      changesRequest += 1;
      fileStatusRequest += 1;
      fileSearchRequest += 1;
      fileDirRequests.clear();
      set({
        directory: null,
        ...emptyConversationPatch(),
        permissions: [],
        questions: [],
        questionResults: {},
        questionBusy: {},
        preview: null,
        workspaceDiff: [],
        sessionDiff: [],
        changesLoading: false,
        changesError: null,
        changesRepo: null,
        ...emptyFileTreePatch(),
        error: null,
      });
    }
    get().showNotice(`已从侧栏移除「${label}」；文件夹与历史会话未删除`, 6000);
  },

  moveWorkspace(source, target, after) {
    const from = normalizeWorkspace(source);
    const to = normalizeWorkspace(target);
    if (!from || !to || from === to) return;
    const projects = get().projects;
    const moved = projects.find(
      (project) => normalizeWorkspace(project.worktree) === from,
    );
    if (!moved) return;
    const next = projects.filter(
      (project) => normalizeWorkspace(project.worktree) !== from,
    );
    const targetIndex = next.findIndex(
      (project) => normalizeWorkspace(project.worktree) === to,
    );
    if (targetIndex === -1) return;
    next.splice(targetIndex + (after ? 1 : 0), 0, moved);
    set({ projects: next });
    rememberWorkspaceOrder(next);
  },

  async send(text, attachments, refs) {
    if (get().editing) {
      get().showNotice("正在编辑历史消息，请先完成或取消编辑");
      return;
    }
    const directory = get().directory;
    const files = attachments ?? [];
    const mentions = refs ?? [];
    if (!directory || (!text.trim() && files.length === 0 && mentions.length === 0)) return;
    let sessionID = get().sessionID;
    if (!sessionID) set({ creatingSession: true });
    try {
      if (!sessionID) {
        const current = get();
        const agent = current.agents.find(
          (item) => item.name === current.selectedAgent,
        );
        // 未显式选择时不下发 permission，让会话继承 Agent/全局配置。
        const permission =
          current.draftPermissionMode &&
          agent &&
          canControlPermission(agent)
            ? rulesForMode(current.draftPermissionMode, agent)
            : [];
        const session = await api.createSession(
          directory,
          permission.length > 0 ? { permission } : undefined,
        );
        sessionID = session.id;
        sessionCache.set(directory, sessionID, []);
        const list = get().sessions[directory] ?? [];
        set({
          sessions: { ...get().sessions, [directory]: upsertSession(list, session) },
          sessionID,
          expanded: { ...get().expanded, [directory]: true },
          todos: [],
          sessionChildren: [],
          childMessages: {},
          childTodos: {},
          sessionStatuses: {},
          selectedTaskID: null,
          creatingSession: false,
        });
        void get().refreshTasks();
      }
      // 手动开启新一轮时，之前暂停的引导会随新消息一起进入模型上下文，
      // 不再单独唤醒；否则同一段内容会被处理两次。
      if (
        sessionID &&
        !isSessionBusy(get(), sessionID) &&
        (get().pendingSteers[sessionID]?.length ?? 0) > 0
      ) {
        get().supersedePendingSteers(sessionID);
      }
      const active = (get().sessions[directory] ?? []).find(
        (item) => item.id === sessionID,
      );
      const revertSuffix =
        active?.revert?.messageID
          ? messageSuffixIDs(get().messages, active.revert.messageID)
          : null;
      set({ streaming: true, error: null });
      const selection = currentSelection(get());
      const parts = buildPromptParts(directory, text, mentions, files);
      await awaitPermissionPatch(permissionPatch);
      await api.prompt(directory, sessionID, parts, {
        ...(selection.model ? { model: selection.model } : {}),
        agent: selection.agent,
        ...(selection.variant ? { variant: selection.variant } : {}),
      });
      if (revertSuffix && revertSuffix.size > 0) {
        const current = get();
        const list = current.sessions[directory] ?? [];
        const session = list.find((item) => item.id === sessionID);
        const nextMessages = current.messages.filter(
          (message) => !revertSuffix.has(message.info.id),
        );
        const steerMessageIDs = {
          ...current.steerMessageIDs,
          [sessionID]: (current.steerMessageIDs[sessionID] ?? []).filter((id) =>
            nextMessages.some((message) => message.info.id === id),
          ),
        };
        if (steerMessageIDs[sessionID].length === 0) {
          delete steerMessageIDs[sessionID];
        }
        set({
          messages: nextMessages,
          steerMessageIDs,
          ...(session
            ? {
                sessions: {
                  ...current.sessions,
                  [directory]: upsertSession(list, { ...session, revert: undefined }),
                },
              }
            : {}),
        });
        void (async () => {
          const detail = await api.session(directory, sessionID).catch(() => null);
          if (!detail) return;
          const latest = get();
          set({
            sessions: {
              ...latest.sessions,
              [directory]: upsertSession(latest.sessions[directory] ?? [], detail),
            },
          });
        })();
      }
    } catch (error) {
      // 失败的原文还回输入框，用户不用重新打一遍
      set({
        creatingSession: false,
        streaming: false,
        error: `发送失败：${String(error)}`,
        failedText: text,
      });
      // revert 下的普通发送可能已经触发 cleanup 后又失败；重读一次，
      // 避免本地为了显示编辑器保留的旧后缀在 revert 清除后重新出现。
      if (sessionID) {
        void (async () => {
          const [detail, messages] = await Promise.all([
            api.session(directory, sessionID).catch(() => null),
            api.messages(directory, sessionID).catch(() => null),
          ]);
          if (get().directory !== directory || get().sessionID !== sessionID) {
            return;
          }
          const list = get().sessions[directory] ?? [];
          set({
            ...(detail
              ? {
                  sessions: {
                    ...get().sessions,
                    [directory]: upsertSession(list, detail),
                  },
                }
              : {}),
            ...(messages ? { messages } : {}),
          });
        })();
      }
    }
  },

  beginEditMessage(messageID) {
    const state = get();
    const { directory, sessionID } = state;
    if (!directory || !sessionID) return;
    const message = state.messages.find((item) => item.info.id === messageID);
    if (!message) {
      get().showNotice("消息已不存在，请刷新后重试");
      return;
    }
    const problem = messageEditProblem(message);
    if (problem) {
      get().showNotice(problem);
      return;
    }
    if (isSessionBusy(state, sessionID)) {
      get().showNotice("当前会话正在执行，请先停止回复再编辑");
      return;
    }
    if (
      (state.queuedMessages[sessionID]?.length ?? 0) > 0 ||
      (state.pendingSteers[sessionID]?.length ?? 0) > 0
    ) {
      get().showNotice("请先处理排队或待确认的消息，再编辑历史消息");
      return;
    }
    set({
      editing: editSeed(message, sessionID),
      editPhase: "idle",
      findOpen: false,
      findQuery: "",
      findIndex: 0,
    });
  },

  cancelEditMessage() {
    const editing = get().editing;
    const phase = get().editPhase;
    if (!editing) return;
    if (phase === "reverting" || phase === "prompting") {
      get().showNotice("正在重新发送，请稍候");
      return;
    }
    const directory = get().directory;
    set({ editing: null, editPhase: "idle" });
    if (phase !== "reverted" || !directory) return;
    // 取消可能发生在 cleanup 已经删除旧消息之后；以服务器快照为准刷新，
    // 避免本地为了保持编辑器而保留的旧后缀继续显示。
    void (async () => {
      const [detail, messages] = await Promise.all([
        api.session(directory, editing.sessionID).catch(() => null),
        api.messages(directory, editing.sessionID).catch(() => null),
      ]);
      if (
        get().directory !== directory ||
        get().sessionID !== editing.sessionID
      ) {
        return;
      }
      const list = get().sessions[directory] ?? [];
      set({
        ...(detail
          ? { sessions: { ...get().sessions, [directory]: upsertSession(list, detail) } }
          : {}),
        ...(messages ? { messages } : {}),
      });
      void get().refreshTasks();
      if (get().rightOpen) void refreshPanel(get, set);
      void get().refreshFileStatuses();
    })();
  },

  async resendEditedMessage(input) {
    const state = get();
    const editing = state.editing;
    const directory = state.directory;
    const sessionID = state.sessionID;
    if (
      !editing ||
      !directory ||
      !sessionID ||
      editing.sessionID !== sessionID ||
      editing.messageID !== input.messageID
    ) {
      throw new Error("编辑状态已失效，请重新打开消息");
    }
    if (state.editPhase === "reverting" || state.editPhase === "prompting") {
      throw new Error("正在重新发送，请稍候");
    }
    if (isSessionBusy(state, sessionID)) {
      throw new Error("当前会话正在执行，请先停止回复再编辑");
    }
    if (
      (state.queuedMessages[sessionID]?.length ?? 0) > 0 ||
      (state.pendingSteers[sessionID]?.length ?? 0) > 0
    ) {
      throw new Error("请先处理排队或待确认的消息，再重新发送");
    }

    const parts = buildEditedPromptParts(directory, input.text, input.uploads);
    if (parts.length === 0) {
      throw new Error("消息内容不能为空");
    }
    const suffixIDs = messageSuffixIDs(state.messages, input.messageID);
    if (
      state.editPhase === "idle" &&
      messageIndex(state.messages, input.messageID) === -1
    ) {
      set({ editing: null, editPhase: "idle" });
      throw new Error("消息已不存在，已刷新列表");
    }

    const model = input.model ?? state.selectedModel ?? undefined;
    const agent = input.agent ?? state.selectedAgent;
    const variant =
      input.model?.variant ??
      (input.model ? undefined : state.selectedVariant ?? undefined);
    // 消息编辑是长请求；切换会话/工作区后编辑状态会被重置，迟到的结果
    // 只能回写目标目录的会话表，不能再改当前界面的消息或运行态。
    const editTarget = editing;
    const sameSession = () => {
      const current = get();
      return current.directory === directory && current.sessionID === sessionID;
    };
    const stillEditing = () => {
      const current = get();
      return sameSession() && current.editing === editTarget;
    };

    if (state.editPhase === "idle") {
      set({ editPhase: "reverting", error: null });
      try {
        const session = await api.revert(directory, sessionID, input.messageID);
        const current = get();
        const sessions = {
          ...current.sessions,
          [directory]: upsertSession(current.sessions[directory] ?? [], session),
        };
        if (stillEditing()) set({ editPhase: "reverted", sessions });
        else set({ sessions });
      } catch (error) {
        if (stillEditing()) set({ editPhase: "idle" });
        throw new Error(editFailureMessage(error));
      }
    }

    if (stillEditing()) set({ editPhase: "prompting", error: null });
    try {
      await awaitPermissionPatch(permissionPatch);
      await api.prompt(directory, sessionID, parts, {
        ...(model
          ? { model: { providerID: model.providerID, modelID: model.modelID } }
          : {}),
        agent,
        ...(variant ? { variant } : {}),
      });
    } catch (error) {
      // prompt 失败时 cleanup 可能已经执行：先尝试 unrevert，再用服务器消息
      // 判断旧消息是否真的恢复，避免误报“已恢复”。
      let unrevertError: unknown = null;
      await api.unrevert(directory, sessionID).catch((rollback) => {
        unrevertError = rollback;
      });
      const [detail, serverMessages] = await Promise.all([
        api.session(directory, sessionID).catch(() => null),
        api.messages(directory, sessionID).catch(() => null),
      ]);
      const current = get();
      const list = current.sessions[directory] ?? [];
      const targetRestored =
        serverMessages?.some((message) => message.info.id === input.messageID) ??
        false;
      if (detail) {
        set({
          sessions: {
            ...current.sessions,
            [directory]: upsertSession(list, detail),
          },
        });
      }
      if (targetRestored && serverMessages) {
        if (stillEditing()) {
          set({
            messages: serverMessages,
            editPhase: "idle",
          });
        }
        throw new Error(
          editFailureMessage(error, "。已恢复原消息，可修改后重试。"),
        );
      }
      // cleanup 已发生，或 unrevert 也失败：保留本地快照与编辑器，
      // 重试时直接 prompt；取消时再按服务器状态刷新。
      if (stillEditing()) set({ editPhase: "reverted" });
      const suffix = unrevertError
        ? "。自动恢复失败，取消编辑后可在会话底部恢复回滚消息。"
        : "。原消息已回滚，可重试发送；取消将接受当前截断状态。";
      throw new Error(editFailureMessage(error, suffix));
    }

    const current = get();
    const list = current.sessions[directory] ?? [];
    const session = list.find((item) => item.id === sessionID);
    const sessions = session
      ? {
          ...current.sessions,
          [directory]: upsertSession(list, { ...session, revert: undefined }),
        }
      : current.sessions;
    if (!stillEditing()) {
      if (sessions !== current.sessions) set({ sessions });
      return;
    }
    const nextMessages =
      suffixIDs.size > 0
        ? current.messages.filter((message) => !suffixIDs.has(message.info.id))
        : current.messages;
    const steerMessageIDs = {
      ...current.steerMessageIDs,
      [sessionID]: (current.steerMessageIDs[sessionID] ?? []).filter((id) =>
        nextMessages.some((message) => message.info.id === id),
      ),
    };
    if (steerMessageIDs[sessionID].length === 0) {
      delete steerMessageIDs[sessionID];
    }
    set({
      messages: nextMessages,
      sessions,
      steerMessageIDs,
      streaming: true,
      editing: null,
      editPhase: "idle",
      error: null,
    });
    void (async () => {
      const detail = await api.session(directory, sessionID).catch(() => null);
      if (detail) {
        const latest = get();
        set({
          sessions: {
            ...latest.sessions,
            [directory]: upsertSession(latest.sessions[directory] ?? [], detail),
          },
        });
      }
      if (!sameSession()) return;
      const permissions = await api.permissions(directory).catch(() => null);
      if (permissions && sameSession()) set({ permissions });
      if (!sameSession()) return;
      void get().refreshTasks();
      if (get().rightOpen) void refreshPanel(get, set);
      void get().refreshFileStatuses();
    })();
  },

  async restoreRevertedMessages() {
    const state = get();
    const { directory, sessionID } = state;
    if (!directory || !sessionID || state.editing) return;
    if (isSessionBusy(state, sessionID)) {
      get().showNotice("当前会话正在执行，请先停止后再恢复消息");
      return;
    }
    try {
      const restored = await api.unrevert(directory, sessionID);
      const messages = await api.messages(directory, sessionID);
      const current = get();
      if (current.directory !== directory || current.sessionID !== sessionID) {
        return;
      }
      set({
        messages: markInterruptedMessages(
          messages,
          isSessionBusy(current, sessionID),
        ),
        sessions: {
          ...current.sessions,
          [directory]: upsertSession(
            current.sessions[directory] ?? [],
            restored,
          ),
        },
        error: null,
      });
      void get().refreshTasks();
      if (get().rightOpen) void refreshPanel(get, set);
      void get().refreshFileStatuses();
      get().showNotice("已恢复回滚的消息");
    } catch (error) {
      set({ error: `恢复回滚消息失败：${String(error)}` });
    }
  },

  submitMessage(text, attachments, refs, delivery) {
    const state = get();
    const directory = state.directory;
    const files = attachments ?? [];
    const mentions = refs ?? [];
    if (state.sessionLoading) {
      get().showNotice("会话正在加载，请稍候");
      return false;
    }
    if (!directory || (!text.trim() && files.length === 0 && mentions.length === 0)) {
      return false;
    }
    if (state.editing) {
      get().showNotice("正在编辑历史消息，请先完成或取消编辑");
      return false;
    }
    if (!state.sessionID) {
      if (state.creatingSession) {
        get().showNotice("正在创建会话，请稍候");
        return false;
      }
      void get().send(text, files, mentions);
      return true;
    }

    const sessionID = state.sessionID;
    const busy = isSessionBusy(state, sessionID);
    const stopping = state.stoppingSessions[sessionID] === true;
    if (busy) {
      if (delivery === "steer" && !stopping) {
        void get().steerMessage(text, files, mentions);
        return true;
      }
      const queued = get().enqueueMessage(text, files, mentions);
      if (queued) get().showNotice(stopping ? "正在停止，已加入排队" : "已加入排队");
      return queued;
    }

    const queuedCount = state.queuedMessages[sessionID]?.length ?? 0;
    const paused = state.queuePaused[sessionID] === true;
    if (queuedCount > 0 && !paused) {
      const queued = get().enqueueMessage(text, files, mentions);
      if (queued) {
        get().showNotice("已加入排队");
        void get().drainQueue(sessionID);
      }
      return queued;
    }
    if (paused && (state.pendingSteers[sessionID]?.length ?? 0) > 0) {
      // 新的一轮会把暂停的引导一起带进上下文，不再单独唤醒。
      get().supersedePendingSteers(sessionID);
    }
    void get().send(text, files, mentions);
    return true;
  },

  enqueueMessage(text, attachments, refs) {
    const state = get();
    const directory = state.directory;
    const sessionID = state.sessionID;
    if (!directory || !sessionID) return false;
    const files = attachments ?? [];
    const mentions = refs ?? [];
    if (!text.trim() && files.length === 0 && mentions.length === 0) return false;
    const current = state.queuedMessages[sessionID] ?? [];
    if (current.length >= MAX_QUEUE_ITEMS) {
      get().showNotice(`排队消息最多 ${MAX_QUEUE_ITEMS} 条，请先发送或删除`);
      return false;
    }
    const bytes =
      queueAttachmentBytes(current) +
      files.reduce((sum, file) => sum + file.size, 0);
    if (bytes > MAX_QUEUE_ATTACHMENT_BYTES) {
      get().showNotice("排队消息的附件总大小不能超过 64MB");
      return false;
    }
    const item: QueuedMessage = {
      id: newQueueItemID(),
      sessionID,
      directory,
      text,
      refs: [...mentions],
      attachments: [...files],
      selection: currentSelection(state),
      createdAt: Date.now(),
      status: "queued",
    };
    set({
      queuedMessages: {
        ...state.queuedMessages,
        [sessionID]: [...current, item],
      },
    });
    return true;
  },

  async steerMessage(text, attachments, refs) {
    const state = get();
    const sessionID = state.sessionID;
    const directory = state.directory;
    const files = attachments ?? [];
    const mentions = refs ?? [];
    if (!sessionID || !directory) return;
    if (!isSessionBusy(state, sessionID)) {
      await get().send(text, files, mentions);
      return;
    }
    if (state.stoppingSessions[sessionID]) {
      if (get().enqueueMessage(text, files, mentions)) {
        get().showNotice("正在停止，已加入排队");
      }
      return;
    }
    await get().deliverSteer({
      sessionID,
      directory,
      text,
      refs: mentions,
      attachments: files,
      selection: currentSelection(state),
      restoreOnFailure: true,
    });
  },

  async deliverSteer(input) {
    const state = get();
    if (state.stoppingSessions[input.sessionID]) {
      if (input.restoreOnFailure) get().showNotice("正在停止，请稍后再发送");
      return false;
    }
    const wasBusy = isSessionBusy(state, input.sessionID);
    const messageID = newMessageID();
    const pending: PendingSteer = {
      messageID,
      sessionID: input.sessionID,
      directory: input.directory,
      createdAt: Date.now(),
      selection: input.selection,
      status: "sent",
    };
    const existing = state.pendingSteers[input.sessionID] ?? [];
    const steerIDs = [
      ...(state.steerMessageIDs[input.sessionID] ?? []),
      messageID,
    ].slice(-200);
    set({
      pendingSteers: {
        ...state.pendingSteers,
        [input.sessionID]: [...existing, pending],
      },
      steerMessageIDs: {
        ...state.steerMessageIDs,
        [input.sessionID]: steerIDs,
      },
      busySessions: { ...state.busySessions, [input.sessionID]: true },
      ...(state.sessionID === input.sessionID ? { streaming: true } : {}),
    });
    try {
      await awaitPermissionPatch(permissionPatch);
      await api.prompt(
        input.directory,
        input.sessionID,
        buildPromptParts(
          input.directory,
          input.text,
          input.refs,
          input.attachments,
        ),
        {
          ...(input.selection.model ? { model: input.selection.model } : {}),
          agent: input.selection.agent,
          ...(input.selection.variant ? { variant: input.selection.variant } : {}),
          messageID,
        },
      );
      return true;
    } catch (error) {
      const current = get();
      const nextPending = (current.pendingSteers[input.sessionID] ?? []).filter(
        (item) => item.messageID !== messageID,
      );
      const pendingSteers = { ...current.pendingSteers };
      if (nextPending.length > 0) pendingSteers[input.sessionID] = nextPending;
      else delete pendingSteers[input.sessionID];
      const nextIDs = (current.steerMessageIDs[input.sessionID] ?? []).filter(
        (id) => id !== messageID,
      );
      const steerMessageIDs = { ...current.steerMessageIDs };
      if (nextIDs.length > 0) steerMessageIDs[input.sessionID] = nextIDs;
      else delete steerMessageIDs[input.sessionID];
      const busySessions = { ...current.busySessions };
      if (!wasBusy) delete busySessions[input.sessionID];
      set({
        pendingSteers,
        steerMessageIDs,
        busySessions,
        ...(current.sessionID === input.sessionID && !wasBusy
          ? { streaming: false }
          : {}),
        ...(input.restoreOnFailure
          ? { failedText: input.text, error: `引导发送失败：${String(error)}` }
          : { error: `引导发送失败：${String(error)}` }),
      });
      return false;
    }
  },

  async steerQueuedMessage(sessionID, itemID) {
    const state = get();
    const queue = state.queuedMessages[sessionID] ?? [];
    const index = queue.findIndex((item) => item.id === itemID);
    if (index === -1) return;
    const item = queue[index];
    if (item.status === "sending") return;
    if (state.stoppingSessions[sessionID]) {
      get().showNotice("正在停止当前任务，请稍后再发送引导");
      return;
    }
    const next = queue.filter((entry) => entry.id !== itemID);
    const queuedMessages = { ...state.queuedMessages };
    if (next.length > 0) queuedMessages[sessionID] = next;
    else delete queuedMessages[sessionID];
    const queuePaused = { ...state.queuePaused };
    if (next.length === 0 && !hasPausedPendingSteers(state, sessionID)) {
      delete queuePaused[sessionID];
    }
    set({ queuedMessages, queuePaused });

    const accepted = await get().deliverSteer({
      sessionID,
      directory: item.directory,
      text: item.text,
      refs: item.refs,
      attachments: item.attachments,
      selection: item.selection,
      restoreOnFailure: false,
    });
    if (accepted) return;

    const current = get();
    const currentQueue = current.queuedMessages[sessionID] ?? [];
    const insertAt = Math.min(index, currentQueue.length);
    const failed: QueuedMessage = {
      ...item,
      status: "failed",
      error: "引导发送失败",
    };
    set({
      queuedMessages: {
        ...current.queuedMessages,
        [sessionID]: [
          ...currentQueue.slice(0, insertAt),
          failed,
          ...currentQueue.slice(insertAt),
        ],
      },
      queuePaused: { ...current.queuePaused, [sessionID]: true },
    });
  },

  removeQueuedMessage(sessionID, itemID) {
    const state = get();
    const queue = state.queuedMessages[sessionID] ?? [];
    const item = queue.find((entry) => entry.id === itemID);
    if (!item || item.status === "sending") return;
    const next = queue.filter((entry) => entry.id !== itemID);
    const queuedMessages = { ...state.queuedMessages };
    if (next.length > 0) queuedMessages[sessionID] = next;
    else delete queuedMessages[sessionID];
    const queuePaused = { ...state.queuePaused };
    if (next.length === 0 && !hasPausedPendingSteers(state, sessionID)) {
      delete queuePaused[sessionID];
    }
    set({ queuedMessages, queuePaused });
  },

  restoreQueuedMessage(sessionID, itemID) {
    const state = get();
    const queue = state.queuedMessages[sessionID] ?? [];
    const item = queue.find((entry) => entry.id === itemID);
    if (!item || item.status === "sending") return null;
    get().removeQueuedMessage(sessionID, itemID);
    return item;
  },

  retryQueuedMessage(sessionID, itemID) {
    const state = get();
    const queue = state.queuedMessages[sessionID] ?? [];
    const index = queue.findIndex((entry) => entry.id === itemID);
    if (index === -1) return;
    const next = queue.map((entry, entryIndex) =>
      entryIndex === index
        ? { ...entry, status: "queued" as const, error: undefined }
        : entry,
    );
    const queuePaused = { ...state.queuePaused };
    delete queuePaused[sessionID];
    set({
      queuedMessages: { ...state.queuedMessages, [sessionID]: next },
      queuePaused,
    });
    if (!isSessionBusy(state, sessionID)) void get().drainQueue(sessionID);
  },

  resumeDelivery(sessionID) {
    const state = get();
    const queuePaused = { ...state.queuePaused };
    delete queuePaused[sessionID];
    set({ queuePaused });
    const pending = state.pendingSteers[sessionID] ?? [];
    const hasFailed = pending.some((item) => item.status === "failed");
    const hasPaused = pending.some((item) => item.status === "paused");
    if (hasFailed) {
      get().showNotice("有引导消息未送达，请先重试或忽略");
      return;
    }
    if (isSessionBusy(state, sessionID)) return;
    if (hasPaused) {
      void get().wakePendingSteers(sessionID);
      return;
    }
    void get().handleDeliveryIdle(sessionID);
  },

  async retryPendingSteer(sessionID, messageID) {
    const state = get();
    const pending = state.pendingSteers[sessionID] ?? [];
    const target = messageID
      ? pending.find((item) => item.messageID === messageID)
      : undefined;
    if (messageID && !target) return;
    const next = pending.map((item) =>
      item.status === "failed" || item.status === "paused"
        ? { ...item, status: "sent" as const, error: undefined }
        : item,
    );
    const queuePaused = { ...state.queuePaused };
    delete queuePaused[sessionID];
    set({
      pendingSteers: { ...state.pendingSteers, [sessionID]: next },
      queuePaused,
    });
    if (isSessionBusy(state, sessionID)) return;
    await get().wakePendingSteers(sessionID);
  },

  dismissPendingSteer(sessionID, messageID) {
    const state = get();
    const pending = state.pendingSteers[sessionID] ?? [];
    const next = messageID
      ? pending.filter((item) => item.messageID !== messageID)
      : pending.filter(
          (item) => item.status !== "failed" && item.status !== "paused",
        );
    const pendingSteers = { ...state.pendingSteers };
    if (next.length > 0) pendingSteers[sessionID] = next;
    else delete pendingSteers[sessionID];
    set({ pendingSteers });
    if (next.length > 0) return;
    if (get().queuePaused[sessionID] !== true) {
      void get().handleDeliveryIdle(sessionID);
    }
  },

  async drainQueue(sessionID) {
    const state = get();
    const queue = state.queuedMessages[sessionID] ?? [];
    if (queue.length === 0) {
      const queuePaused = { ...state.queuePaused };
      if (!hasPausedPendingSteers(state, sessionID)) {
        delete queuePaused[sessionID];
      }
      set({ queuePaused });
      return;
    }
    if (state.queuePaused[sessionID] === true) return;
    if (state.queueSending[sessionID] === true) return;
    if ((state.pendingSteers[sessionID]?.length ?? 0) > 0) return;
    if (isSessionBusy(state, sessionID)) return;
    const item = queue[0];
    // sending 说明已有一条消息交给 CLI；重连恢复时不能把它再发一次。
    if (item.status === "failed" || item.status === "sending") return;
    const sending: QueuedMessage = { ...item, status: "sending" };
    set({
      queuedMessages: {
        ...state.queuedMessages,
        [sessionID]: [sending, ...queue.slice(1)],
      },
      queueSending: { ...state.queueSending, [sessionID]: true },
      busySessions: { ...state.busySessions, [sessionID]: true },
      ...(state.sessionID === sessionID ? { streaming: true } : {}),
    });
    try {
      await awaitPermissionPatch(permissionPatch);
      await api.prompt(
        item.directory,
        item.sessionID,
        buildPromptParts(
          item.directory,
          item.text,
          item.refs,
          item.attachments,
        ),
        {
          ...(item.selection.model ? { model: item.selection.model } : {}),
          agent: item.selection.agent,
          ...(item.selection.variant ? { variant: item.selection.variant } : {}),
        },
      );
      const current = get();
      const next = (current.queuedMessages[sessionID] ?? []).filter(
        (entry) => entry.id !== item.id,
      );
      const queuedMessages = { ...current.queuedMessages };
      if (next.length > 0) queuedMessages[sessionID] = next;
      else delete queuedMessages[sessionID];
      const queuePaused = { ...current.queuePaused };
      if (next.length === 0 && !hasPausedPendingSteers(current, sessionID)) {
        delete queuePaused[sessionID];
      }
      set({ queuedMessages, queuePaused });
    } catch (error) {
      const current = get();
      const next = (current.queuedMessages[sessionID] ?? []).map((entry) =>
        entry.id === item.id
          ? { ...entry, status: "failed" as const, error: String(error) }
          : entry,
      );
      const busySessions = { ...current.busySessions };
      delete busySessions[sessionID];
      set({
        queuedMessages: { ...current.queuedMessages, [sessionID]: next },
        queuePaused: { ...current.queuePaused, [sessionID]: true },
        busySessions,
        ...(current.sessionID === sessionID ? { streaming: false } : {}),
        error: `排队消息发送失败：${String(error)}`,
      });
    } finally {
      const current = get();
      const queueSending = { ...current.queueSending };
      delete queueSending[sessionID];
      set({ queueSending });
      if (idleDuringSend.delete(sessionID)) {
        const busySessions = { ...get().busySessions };
        delete busySessions[sessionID];
        set({
          busySessions,
          ...(get().sessionID === sessionID ? { streaming: false } : {}),
        });
        // 给 CLI 一点时间发出新轮次的 busy；若已经忙，handleDeliveryIdle 会自然返回。
        setTimeout(() => {
          void get().handleDeliveryIdle(sessionID);
        }, 250);
      }
    }
  },

  async handleDeliveryIdle(sessionID) {
    if (deliveryReconciling.has(sessionID)) return;
    deliveryReconciling.add(sessionID);
    try {
      const state = get();
      if ((state.pendingSteers[sessionID]?.length ?? 0) > 0) {
        const result = await get().reconcilePendingSteers(sessionID);
        if (result.failed > 0) {
          set({
            queuePaused: { ...get().queuePaused, [sessionID]: true },
          });
          get().showNotice("有引导消息未送达，请重试或忽略", 6000);
          return;
        }
        const pending = get().pendingSteers[sessionID] ?? [];
        if (pending.length > 0) {
          if (get().queuePaused[sessionID] === true) {
            const next = pending.map((item) =>
              item.status === "sent"
                ? { ...item, status: "paused" as const }
                : item,
            );
            set({
              pendingSteers: { ...get().pendingSteers, [sessionID]: next },
            });
            return;
          }
          const newest = pending.reduce(
            (latest, item) => Math.max(latest, item.createdAt),
            0,
          );
          if (Date.now() - newest <= STEER_PERSIST_GRACE_MS) {
            // prompt_async 可能已经返回 204，但用户消息还没落库；等落库后再决定
            // 是 synthetic 继续，还是按未送达处理。
            scheduleSteerRecheck(sessionID, pending);
            return;
          }
          await get().wakePendingSteers(sessionID);
          return;
        }
      }
      if (get().queuePaused[sessionID] === true) return;
      if ((get().queuedMessages[sessionID]?.length ?? 0) > 0) {
        await get().drainQueue(sessionID);
      }
    } finally {
      deliveryReconciling.delete(sessionID);
    }
  },

  handleDeliveryError(sessionID) {
    const state = get();
    const pending = state.pendingSteers[sessionID] ?? [];
    const hasQueue = (state.queuedMessages[sessionID]?.length ?? 0) > 0;
    if (!hasQueue && pending.length === 0) return;
    const next = pending.map((item) =>
      item.status === "sent"
        ? { ...item, status: "failed" as const, error: "任务出错，未能确认引导" }
        : item,
    );
    const pendingSteers = { ...state.pendingSteers };
    if (next.length > 0) pendingSteers[sessionID] = next;
    else delete pendingSteers[sessionID];
    set({
      pendingSteers,
      queuePaused: { ...state.queuePaused, [sessionID]: true },
    });
    get().showNotice("任务出错，排队与引导已暂停", 6000);
  },

  async reconcilePendingSteers(sessionID) {
    const state = get();
    const pending = state.pendingSteers[sessionID] ?? [];
    if (pending.length === 0) return { remaining: 0, failed: 0 };
    const directory = pending[0].directory;
    const messages = await api.messages(directory, sessionID).catch(() => null);
    if (!messages) {
      set({ queuePaused: { ...get().queuePaused, [sessionID]: true } });
      get().showNotice("无法确认引导消息状态，已暂停队列", 6000);
      return { remaining: pending.length, failed: 0 };
    }
    if (messages.length === 0) {
      const now = Date.now();
      let failed = 0;
      const next = pending.map((item) => {
        if (item.status === "failed") {
          failed += 1;
          return item;
        }
        if (now - item.createdAt <= STEER_PERSIST_GRACE_MS) return item;
        failed += 1;
        return { ...item, status: "failed" as const, error: "引导消息未落库" };
      });
      set({ pendingSteers: { ...get().pendingSteers, [sessionID]: next } });
      return { remaining: next.length, failed };
    }

    const userIndex = new Map<string, number>();
    messages.forEach((message, index) => {
      if (message.info.role === "user") userIndex.set(message.info.id, index);
    });
    let latestAssistantParent = -1;
    for (const message of messages) {
      if (message.info.role !== "assistant" || !message.info.parentID) continue;
      const index = userIndex.get(message.info.parentID);
      if (index !== undefined && index > latestAssistantParent) {
        latestAssistantParent = index;
      }
    }
    const now = Date.now();
    let failed = 0;
    const next: PendingSteer[] = [];
    for (const item of pending) {
      const index = userIndex.get(item.messageID);
      if (index === undefined) {
        if (now - item.createdAt > STEER_PERSIST_GRACE_MS) {
          failed += 1;
          next.push({ ...item, status: "failed", error: "引导消息未落库" });
        } else {
          next.push(item);
        }
        continue;
      }
      if (index <= latestAssistantParent) continue;
      if (item.status === "failed") {
        failed += 1;
        next.push(item);
        continue;
      }
      next.push(item);
    }
    const pendingSteers = { ...get().pendingSteers };
    if (next.length > 0) pendingSteers[sessionID] = next;
    else delete pendingSteers[sessionID];
    set({ pendingSteers });
    return { remaining: next.length, failed };
  },

  async wakePendingSteers(sessionID) {
    const state = get();
    const pending = (state.pendingSteers[sessionID] ?? []).filter(
      (item) => item.status === "sent" || item.status === "paused",
    );
    if (pending.length === 0) return false;
    if (isSessionBusy(state, sessionID)) return false;
    const targetIDs = new Set(pending.map((item) => item.messageID));
    const last = pending[pending.length - 1];
    set({
      busySessions: { ...state.busySessions, [sessionID]: true },
      ...(state.sessionID === sessionID ? { streaming: true } : {}),
    });
    try {
      await awaitPermissionPatch(permissionPatch);
      await api.prompt(
        last.directory,
        sessionID,
        [
          {
            type: "text",
            text: "Continue with the latest user steering message.",
            synthetic: true,
          },
        ],
        {
          ...(last.selection.model ? { model: last.selection.model } : {}),
          agent: last.selection.agent,
          ...(last.selection.variant ? { variant: last.selection.variant } : {}),
        },
      );
      const current = get();
      const next = (current.pendingSteers[sessionID] ?? []).filter(
        (item) => !targetIDs.has(item.messageID),
      );
      const pendingSteers = { ...current.pendingSteers };
      if (next.length > 0) pendingSteers[sessionID] = next;
      else delete pendingSteers[sessionID];
      set({ pendingSteers });
      return true;
    } catch (error) {
      const current = get();
      const next = (current.pendingSteers[sessionID] ?? []).map((item) =>
        targetIDs.has(item.messageID)
          ? { ...item, status: "failed" as const, error: String(error) }
          : item,
      );
      const busySessions = { ...current.busySessions };
      delete busySessions[sessionID];
      set({
        pendingSteers: { ...current.pendingSteers, [sessionID]: next },
        queuePaused: { ...current.queuePaused, [sessionID]: true },
        busySessions,
        ...(current.sessionID === sessionID ? { streaming: false } : {}),
        error: `引导消息唤醒失败：${String(error)}`,
      });
      return false;
    }
  },

  supersedePendingSteers(sessionID) {
    const state = get();
    if ((state.pendingSteers[sessionID]?.length ?? 0) === 0) return;
    const pendingSteers = { ...state.pendingSteers };
    delete pendingSteers[sessionID];
    set({ pendingSteers });
  },

  clearSessionDelivery(sessionID) {
    const state = get();
    const timer = stopTimers.get(sessionID);
    if (timer) {
      clearTimeout(timer);
      stopTimers.delete(sessionID);
    }
    const steerTimer = steerWakeTimers.get(sessionID);
    if (steerTimer) {
      clearTimeout(steerTimer);
      steerWakeTimers.delete(sessionID);
    }
    const queuedMessages = { ...state.queuedMessages };
    const queuePaused = { ...state.queuePaused };
    const queueSending = { ...state.queueSending };
    const pendingSteers = { ...state.pendingSteers };
    const steerMessageIDs = { ...state.steerMessageIDs };
    const stoppingSessions = { ...state.stoppingSessions };
    delete queuedMessages[sessionID];
    delete queuePaused[sessionID];
    delete queueSending[sessionID];
    delete pendingSteers[sessionID];
    delete steerMessageIDs[sessionID];
    delete stoppingSessions[sessionID];
    set({
      queuedMessages,
      queuePaused,
      queueSending,
      pendingSteers,
      steerMessageIDs,
      stoppingSessions,
    });
  },

  finishStopping(sessionID) {
    const timer = stopTimers.get(sessionID);
    if (timer) {
      clearTimeout(timer);
      stopTimers.delete(sessionID);
    }
    const state = get();
    if (!state.stoppingSessions[sessionID]) return;
    const stoppingSessions = { ...state.stoppingSessions };
    delete stoppingSessions[sessionID];
    set({ stoppingSessions });
  },

  async resumeAllDelivery() {
    const state = get();
    const sessionIDs = new Set([
      ...Object.keys(state.queuedMessages),
      ...Object.keys(state.pendingSteers),
    ]);
    if (sessionIDs.size === 0) return;
    const byDirectory = new Map<string, Set<string>>();
    const sending = new Set<string>();
    for (const sessionID of sessionIDs) {
      const item =
        state.queuedMessages[sessionID]?.[0] ??
        state.pendingSteers[sessionID]?.[0];
      if (!item) continue;
      const group = byDirectory.get(item.directory) ?? new Set<string>();
      group.add(sessionID);
      byDirectory.set(item.directory, group);
      // 发送中的请求仍由 drainQueue 的 finally 收尾；这里清标记会让队首被重发。
      if (state.queueSending[sessionID]) sending.add(sessionID);
    }
    for (const [directory, ids] of byDirectory) {
      const statuses = await api.sessionStatus(directory).catch(() => null);
      if (!statuses) continue;
      set({
        busySessions: mergeBusySessions(
          get().busySessions,
          get().sessions[directory] ?? [],
          statuses,
        ),
      });
      for (const sessionID of ids) {
        if (sending.has(sessionID)) continue;
        if (isBusyStatus(statuses[sessionID])) continue;
        if (get().queuePaused[sessionID] === true) continue;
        void get().handleDeliveryIdle(sessionID);
      }
    }
  },

  async stop() {
    const { directory, sessionID } = get();
    if (!directory || !sessionID) return;
    if (get().stoppingSessions[sessionID]) return;
    const state = get();
    const hasDelivery =
      (state.queuedMessages[sessionID]?.length ?? 0) > 0 ||
      (state.pendingSteers[sessionID]?.length ?? 0) > 0;
    if (hasDelivery) {
      get().showNotice("当前任务停止后，排队消息会暂停保留", 4000);
    }
    set({
      stoppingSessions: { ...state.stoppingSessions, [sessionID]: true },
      ...(hasDelivery
        ? { queuePaused: { ...state.queuePaused, [sessionID]: true } }
        : {}),
    });
    const timer = setTimeout(() => {
      stopTimers.delete(sessionID);
      const current = get();
      const stoppingSessions = { ...current.stoppingSessions };
      delete stoppingSessions[sessionID];
      const busySessions = { ...current.busySessions };
      delete busySessions[sessionID];
      set({
        stoppingSessions,
        busySessions,
        ...(current.sessionID === sessionID ? { streaming: false } : {}),
        ...(hasDelivery
          ? { queuePaused: { ...current.queuePaused, [sessionID]: true } }
          : {}),
      });
      get().showNotice("停止超时，已按空闲处理", 5000);
    }, 5000);
    stopTimers.set(sessionID, timer);
    try {
      const aborted = await api.abort(directory, sessionID);
      if (!aborted) {
        get().finishStopping(sessionID);
        const current = get();
        const busySessions = { ...current.busySessions };
        delete busySessions[sessionID];
        set({
          busySessions,
          ...(current.sessionID === sessionID ? { streaming: false } : {}),
        });
      }
    } catch {
      // abort 失败时仍可能收到 idle/error；超时兜底会恢复输入区。
    }
  },

  async replyPermission(id, reply) {
    const { directory } = get();
    if (!directory) return;
    set({ permissions: get().permissions.filter((p) => p.id !== id) });
    try {
      await api.replyPermission(directory, id, reply);
    } catch (error) {
      set({ error: `授权回复失败：${String(error)}` });
    }
  },

  async replyQuestion(id, answers) {
    const { directory } = get();
    if (!directory || get().questionBusy[id]) return false;
    set({ questionBusy: { ...get().questionBusy, [id]: "reply" } });
    try {
      await api.replyQuestion(directory, id, answers);
      noteQuestionRemove(id);
      const questionBusy = { ...get().questionBusy };
      delete questionBusy[id];
      set({
        questions: get().questions.filter((question) => question.id !== id),
        questionResults: {
          ...get().questionResults,
          [id]: { status: "replied", answers },
        },
        questionBusy,
      });
      return true;
    } catch (error) {
      const questionBusy = { ...get().questionBusy };
      delete questionBusy[id];
      set({
        questionBusy,
        error: `提交回答失败：${String(error)}`,
      });
      return false;
    }
  },

  async rejectQuestion(id) {
    const { directory } = get();
    if (!directory || get().questionBusy[id]) return false;
    set({ questionBusy: { ...get().questionBusy, [id]: "reject" } });
    try {
      await api.rejectQuestion(directory, id);
      noteQuestionRemove(id);
      const questionBusy = { ...get().questionBusy };
      delete questionBusy[id];
      set({
        questions: get().questions.filter((question) => question.id !== id),
        questionResults: {
          ...get().questionResults,
          [id]: { status: "rejected" },
        },
        questionBusy,
      });
      return true;
    } catch (error) {
      const questionBusy = { ...get().questionBusy };
      delete questionBusy[id];
      set({
        questionBusy,
        error: `跳过问题失败：${String(error)}`,
      });
      return false;
    }
  },

  async stopQuestion(id) {
    await get().stop();
    const { directory } = get();
    if (!directory || !get().questions.some((question) => question.id === id)) {
      return;
    }
    set({ questionBusy: { ...get().questionBusy, [id]: "reject" } });
    try {
      await api.rejectQuestion(directory, id);
    } catch {
      // session.abort 可能已经替 CLI 清掉请求；这里的目标是退出等待，而不是报错。
    }
    noteQuestionRemove(id);
    const questionBusy = { ...get().questionBusy };
    delete questionBusy[id];
    set({
      questions: get().questions.filter((question) => question.id !== id),
      questionResults: {
        ...get().questionResults,
        [id]: { status: "rejected" },
      },
      questionBusy,
    });
  },

  onBackend(phase) {
    // 主进程刚启动时可能还没广播，忽略不完整载荷，保持启动态
    if (!phase || !phase.state) return;
    const previous = get().backend.state;
    set({ backend: phase });
    if (phase.state === "ready") {
      // 后端恢复后清掉「本地服务未响应/读取失败」这类已经过期的提示，
      // 避免授权完成后界面还挂着旧的红色错误。
      const stale = get().error;
      if (stale && /未响应|读取会话失败|读取消息失败|读取项目列表失败|文件夹访问授权/.test(stale)) {
        set({ error: null });
      }
      // 事件流刚恢复：重连期间事件会丢，重新拉一次当前会话的权威数据
      if (previous !== "ready" && !get().booting) {
        void get().refreshAfterReconnect();
      }
      return;
    }
    // 断线/重建期间不再宣称「已连接」，避免状态栏给出错误信息
    set({ sseOk: false });
  },

  async retryBackend() {
    // 先给即时反馈，真正结果等主进程广播
    set({ backend: { ...get().backend, state: "recovering" } });
    try {
      await api.retryBackend();
    } catch (error) {
      set({ error: `重试后端失败：${String(error)}` });
    }
  },

  async refreshTasks() {
    const { directory, sessionID } = get();
    const request = ++tasksRequest;
    if (!directory || !sessionID) {
      set({ tasksLoading: false });
      return;
    }
    const target = sessionID;
    set({ tasksLoading: true });
    try {
      const [todos, children, statuses] = await Promise.all([
        api.todos(directory, target).catch(() => []),
        api.children(directory, target).catch(() => []),
        api.sessionStatus(directory).catch(() => null),
      ]);
      const statusMap = statuses ?? get().sessionStatuses;
      const tasks = buildSubagentTasks(get().messages, target, children, statusMap);
      const childIDs = Array.from(
        new Set([
          ...children.map((child) => child.id),
          ...tasks.flatMap((task) => (task.sessionID ? [task.sessionID] : [])),
        ]),
      );
      const taskData = await Promise.all(
        childIDs.map(async (childID) => {
          const [messages, childTodos] = await Promise.all([
            api.taskMessages(directory, childID).catch(() => []),
            api.todos(directory, childID).catch(() => []),
          ]);
          return {
            childID,
            messages,
            active: statuses ? isBusyStatus(statuses[childID]) : null,
            todos: normalizeTodos(childTodos),
          };
        }),
      );
      // 请求期间可能已经切到别的会话，迟到结果不能污染当前界面
      if (request !== tasksRequest || get().sessionID !== target) return;
      const childMessages: Record<string, Message[]> = {};
      const childTodos: Record<string, TodoItem[]> = {};
      for (const entry of taskData) {
        const merged = mergeMessages(
          entry.messages,
          get().childMessages[entry.childID] ?? [],
        );
        childMessages[entry.childID] =
          entry.active === null ? merged : markInterruptedMessages(merged, entry.active);
        childTodos[entry.childID] = entry.todos;
      }
      set({
        todos: normalizeTodos(todos),
        sessionChildren: children,
        childMessages,
        childTodos,
        ...(statuses ? { sessionStatuses: statuses } : {}),
        tasksLoading: false,
      });
    } catch (error) {
      if (request === tasksRequest && get().sessionID === target) {
        set({ tasksLoading: false });
      }
      console.warn("读取任务状态失败", error);
    }
  },

  async refreshAfterReconnect() {
    const { directory, sessionID } = get();
    if (!directory) return;
    try {
      const previousSessions = get().sessions[directory] ?? [];
      const sessions = await api.sessions(directory);
      if (get().directory !== directory) return;
      sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      const unreadSessions = withoutUnread(
        get().unreadSessions,
        removedSessionIds(previousSessions, sessions),
      );
      if (unreadSessions !== get().unreadSessions) {
        rememberUnreadSessions(unreadSessions);
      }
      set({ sessions: { ...get().sessions, [directory]: sessions }, unreadSessions });
      if (sessionID) {
        const questionMarker = questionChangeSequence;
        const [messages, permissions, questions, statuses] = await Promise.all([
          api.messages(directory, sessionID),
          api.permissions(directory).catch(() => []),
          api.questions(directory).catch(() => null),
          api.sessionStatus(directory).catch(() => null),
        ]);
        if (get().directory !== directory || get().sessionID !== sessionID) return;
        // 重连期间会丢失 status/idle 事件；用快照重新确认当前会话是否仍在运行。
        const active = statuses
          ? isBusyStatus(statuses[sessionID])
          : get().streaming || get().busySessions[sessionID] === true;
        const editing = get().editing;
        const editingSnapshot =
          editing?.sessionID === sessionID
            ? mergeMessages(
                markInterruptedMessages(messages, active),
                get().messages,
              )
            : null;
        const targetGone =
          editing?.sessionID === sessionID &&
          get().editPhase === "idle" &&
          !messages.some((message) => message.info.id === editing.messageID);
        set({
          messages:
            editingSnapshot ?? markInterruptedMessages(messages, active),
          permissions,
          ...(questions
            ? { questions: mergeQuestionSnapshot(questions, questionMarker) }
            : {}),
          streaming: active,
          ...(targetGone ? { editing: null, editPhase: "idle" as MessageEditPhase } : {}),
          ...(statuses
            ? {
                sessionStatuses: statuses,
                busySessions: mergeBusySessions(get().busySessions, sessions, statuses),
              }
            : {}),
        });
        if (targetGone) {
          get().showNotice("正在编辑的消息已不存在，编辑已取消");
        }
        if (!statuses) void get().refreshBusySessions(directory);
        if (get().rightOpen) void refreshPanel(get, set);
        void get().refreshTasks();
        if (get().overviewOpen) void get().refreshOverview();
      } else {
        void get().refreshBusySessions(directory);
      }
      void get().resumeAllDelivery();
    } catch (error) {
      // 断线场景下请求失败是预期内的：提示条已经说明状态，等下一次 ready 再刷新，
      // 不要用红色 toast 打断用户（真实原因保留在控制台便于排查）。
      console.warn("重连后刷新失败", error);
    }
  },

  onSse(raw) {
    set({ sseCount: get().sseCount + 1 });
    if (raw === "[DONE]") {
      set({ sseOk: false });
      return;
    }
    let event: { type?: string; properties?: Record<string, unknown> };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const type = event.type ?? "";
    const props = (event.properties ?? {}) as Record<string, any>;
    const currentSession = get().sessionID;
    const eventSession = typeof props.sessionID === "string" ? props.sessionID : "";
    const isChildSession = (sessionID: string) =>
      Boolean(sessionID) &&
      (get().sessionChildren.some((child) => child.id === sessionID) ||
        Boolean(get().childMessages[sessionID]) ||
        Boolean(get().childTodos[sessionID]));
    const clearSessionQuestions = (sessionID: string) => {
      if (!sessionID) return {};
      noteQuestionSessionClear(sessionID);
      const pending = get().questions.filter(
        (question) => question.sessionID === sessionID,
      );
      if (pending.length === 0) return {};
      return {
        questions: get().questions.filter(
          (question) => question.sessionID !== sessionID,
        ),
      };
    };

    switch (type) {
      case "server.connected":
        set({ sseOk: true });
        break;
      case "message.updated":
        // assistant.parentID 指向它实际回应的 user 消息：匹配到某条引导时，
        // 同一轮里更早的引导也已经进入模型上下文，可以一起收口。
        if (eventSession && props.info?.parentID) {
          const pending = get().pendingSteers[eventSession];
          if (pending?.length) {
            const parentID = String(props.info.parentID);
            const index = pending.findIndex((item) => item.messageID === parentID);
            if (index !== -1) {
              const pendingSteers = { ...get().pendingSteers };
              const remaining = pending.filter((_, itemIndex) => itemIndex > index);
              if (remaining.length > 0) pendingSteers[eventSession] = remaining;
              else delete pendingSteers[eventSession];
              set({ pendingSteers });
            }
          }
        }
        if (eventSession === currentSession && props.info) {
          // 助手消息在跑 → 正在执行；不管这条任务是从哪触发的（界面/CLI）
          const streaming = props.info.role === "assistant" ? true : get().streaming;
          set({ messages: upsertMessage(get().messages, props.info), streaming });
        } else if (isChildSession(eventSession) && props.info) {
          set({
            childMessages: {
              ...get().childMessages,
              [eventSession]: upsertMessage(get().childMessages[eventSession] ?? [], props.info),
            },
          });
        }
        break;
      case "message.removed": {
        const messageID =
          typeof props.messageID === "string" ? props.messageID : "";
        if (!messageID) break;
        const editing = get().editing;
        const phase = get().editPhase;
        // 自己的 revert/cleanup 会删除编辑目标及其后缀；编辑期间保留本地快照，
        // 否则编辑器会在 prompt 返回前先被卸载。
        if (
          eventSession === currentSession &&
          editing?.sessionID === eventSession &&
          phase !== "idle" &&
          isAtOrAfterMessage(get().messages, messageID, editing.messageID)
        ) {
          break;
        }
        if (eventSession === currentSession) {
          set({
            messages: get().messages.filter(
              (message) => message.info.id !== messageID,
            ),
          });
          if (
            editing?.sessionID === eventSession &&
            editing.messageID === messageID &&
            phase === "idle"
          ) {
            set({ editing: null, editPhase: "idle" });
            get().showNotice("正在编辑的消息已被删除");
          }
        } else if (isChildSession(eventSession)) {
          set({
            childMessages: {
              ...get().childMessages,
              [eventSession]: (
                get().childMessages[eventSession] ?? []
              ).filter((message) => message.info.id !== messageID),
            },
          });
        }
        break;
      }
      case "message.part.updated": {
        const part = props.part as Part | undefined;
        if (!part) break;
        // 工具调用在真正执行前会先以 running + input 的形式流出；第一次 running
        // 的时刻是模型输出 tool call 的结束点。不能用后续的 state.time.start，
        // 否则会把排队/审批等待算进输出速度。
        const observedAt =
          part.type === "tool" && part.state?.status === "running"
            ? typeof props.time === "number"
              ? props.time
              : Date.now()
            : undefined;
        if (eventSession === currentSession) {
          set({ messages: upsertPart(get().messages, part, observedAt) });
        } else if (isChildSession(eventSession)) {
          set({
            childMessages: {
              ...get().childMessages,
              [eventSession]: upsertPart(
                get().childMessages[eventSession] ?? [],
                part,
                observedAt,
              ),
            },
          });
        }
        break;
      }
      case "message.part.removed": {
        const messageID =
          typeof props.messageID === "string" ? props.messageID : "";
        const partID = typeof props.partID === "string" ? props.partID : "";
        if (!messageID || !partID) break;
        const editing = get().editing;
        const phase = get().editPhase;
        if (
          eventSession === currentSession &&
          editing?.sessionID === eventSession &&
          phase !== "idle" &&
          isAtOrAfterMessage(get().messages, messageID, editing.messageID)
        ) {
          break;
        }
        const removePart = (list: Message[]) =>
          list.map((message) =>
            message.info.id === messageID
              ? {
                  ...message,
                  parts: message.parts.filter((part) => part.id !== partID),
                }
              : message,
          );
        if (eventSession === currentSession) {
          set({ messages: removePart(get().messages) });
          if (
            editing?.sessionID === eventSession &&
            editing.messageID === messageID &&
            phase === "idle"
          ) {
            set({ editing: null, editPhase: "idle" });
            get().showNotice("正在编辑的消息内容已变化，请重新打开");
          }
        } else if (isChildSession(eventSession)) {
          set({
            childMessages: {
              ...get().childMessages,
              [eventSession]: removePart(get().childMessages[eventSession] ?? []),
            },
          });
        }
        break;
      }
      case "message.part.delta": {
        const isCurrent = eventSession === currentSession;
        if (!isCurrent && !isChildSession(eventSession)) break;
        const messages = isCurrent
          ? get().messages
          : (get().childMessages[eventSession] ?? []);
        const message = messages.find((m) => m.info.id === props.messageID);
        const part = message?.parts.find((p) => p.id === props.partID);
        if (!part) break;
        const field = (props.field as string) ?? "text";
        const next = upsertPart(messages, {
          ...part,
          [field]: `${(part[field] as string) ?? ""}${props.delta ?? ""}`,
        });
        set({
          ...(isCurrent ? { messages: next } : {}),
          ...(!isCurrent
            ? { childMessages: { ...get().childMessages, [eventSession]: next } }
            : {}),
        });
        break;
      }
      case "session.created":
      case "session.updated": {
        const info = props.info as Session | undefined;
        if (!info) break;
        // 全局事件流里每个会话都带自己的 directory；别塞进当前工作区
        const directory = info.directory ?? get().directory;
        if (!directory) break;
        const list = get().sessions[directory] ?? [];
        const childAdded =
          info.parentID === currentSession &&
          !get().sessionChildren.some((child) => child.id === info.id);
        const editing = get().editing;
        const cancelsEditing = Boolean(
          editing &&
            editing.sessionID === info.id &&
            get().editPhase === "idle" &&
            info.revert?.messageID &&
            isAtOrAfterMessage(
              get().messages,
              editing.messageID,
              info.revert.messageID,
            ),
        );
        set({
          sessions: { ...get().sessions, [directory]: upsertSession(list, info) },
          loadedDirs: { ...get().loadedDirs, [directory]: true },
          ...(info.parentID && info.parentID === currentSession
            ? { sessionChildren: upsertSession(get().sessionChildren, info) }
            : {}),
          ...(cancelsEditing ? { editing: null, editPhase: "idle" as MessageEditPhase } : {}),
        });
        if (cancelsEditing) {
          get().showNotice("会话已被回滚，历史消息编辑已取消");
        }
        if (childAdded) void get().refreshTasks();
        break;
      }
      case "session.status": {
        if (!eventSession) break;
        // 全局事件流覆盖所有工作区：侧栏据此给任意会话的标题前显示加载指示，
        // 不能只记当前会话，否则别的工作区在跑的会话看不出来。
        const status = props.status as SessionStatus | undefined;
        if (status && typeof status.type === "string") {
          const busy = status.type === "busy" || status.type === "retry";
          // 事件可能是本应用之外启动的任务；busy 时补上本地运行态。
          // idle 仍交给 session.idle/session.error 收尾，避免步骤边界提前清掉
          // 侧栏加载指示或把仍在执行的会话当成空闲。
          if (busy) {
            if (get().busySessions[eventSession] !== true) {
              set({
                busySessions: { ...get().busySessions, [eventSession]: true },
              });
            }
            if (eventSession === currentSession && !get().streaming) {
              set({ streaming: true });
            }
          }
        }
        if (eventSession === currentSession || isChildSession(eventSession)) {
          set({
            sessionStatuses: {
              ...get().sessionStatuses,
              [eventSession]: props.status as SessionStatus,
            },
          });
        }
        break;
      }
      case "todo.updated": {
        if (!eventSession) break;
        const todos = normalizeTodos(props.todos);
        if (eventSession === currentSession) {
          set({ todos });
        } else if (isChildSession(eventSession)) {
          set({
            childTodos: { ...get().childTodos, [eventSession]: todos },
          });
        }
        break;
      }
      case "btw.start": {
        const asideID = typeof props.asideID === "string" ? props.asideID : "";
        if (asideID && btwPending.has(asideID)) {
          set({ commitMessageGenerating: true, commitMessageError: null });
        }
        break;
      }
      case "btw.delta": {
        const asideID = typeof props.asideID === "string" ? props.asideID : "";
        const pending = btwPending.get(asideID);
        if (!pending) break;
        if (
          get().sessionID !== pending.sessionID ||
          get().directory !== pending.directory
        ) {
          takeBtw(asideID)?.reject(new Error("会话已切换"));
          set({ commitMessageGenerating: false });
          break;
        }
        pending.text += typeof props.text === "string" ? props.text : "";
        set({
          commitMessage: pending.text,
          commitMessageGenerating: true,
          commitMessageError: null,
        });
        break;
      }
      case "btw.complete": {
        const asideID = typeof props.asideID === "string" ? props.asideID : "";
        const pending = takeBtw(asideID);
        if (!pending) break;
        if (
          get().sessionID !== pending.sessionID ||
          get().directory !== pending.directory
        ) {
          pending.reject(new Error("会话已切换"));
          break;
        }
        const message = normalizeCommitMessage(pending.text);
        if (!message) {
          const error = new Error("Agent 没有返回提交信息");
          set({
            commitMessageGenerating: false,
            commitMessageError: error.message,
          });
          pending.reject(error);
          break;
        }
        set({
          commitMessage: message,
          commitMessageGenerating: false,
          commitMessageError: null,
        });
        pending.resolve(message);
        break;
      }
      case "btw.error": {
        const asideID = typeof props.asideID === "string" ? props.asideID : "";
        const pending = takeBtw(asideID);
        if (!pending) break;
        const message =
          (typeof props.message === "string" && props.message) ||
          "Agent 生成提交信息失败";
        if (
          get().sessionID === pending.sessionID &&
          get().directory === pending.directory
        ) {
          set({
            commitMessageGenerating: false,
            commitMessageError: message,
          });
        } else {
          set({ commitMessageGenerating: false });
        }
        pending.reject(new Error(message));
        break;
      }
      case "session.diff":
        if (eventSession === currentSession) {
          set({ sessionDiff: normalizeDiff(props.diff as FileDiff[] | undefined) });
          // 会话快照变化通常也意味着工作区发生变化，静默更新另一来源。
          if (get().changeSource === "workspace") schedulePanelRefresh(600);
        }
        break;
      case "file.watcher.updated":
      case "file.edited": {
        const file = typeof props.file === "string" ? props.file : "";
        const directory = get().directory;
        if (!directory || !file || !isPathInsideDirectory(directory, file)) break;
        if (get().rightOpen) schedulePanelRefresh(600);
        break;
      }
      case "session.idle": {
        if (eventSession) get().finishStopping(eventSession);
        const clearedQuestions = clearSessionQuestions(eventSession);
        // session.idle 是整轮任务结束的权威事件：无论之前有没有收到 status 事件，
        // 都要清掉加载指示；非当前会话同时标记未读。
        const busySessions = { ...get().busySessions };
        delete busySessions[eventSession];
        const unreadSessions = { ...get().unreadSessions };
        const markUnread =
          Boolean(eventSession) &&
          eventSession !== currentSession &&
          !isChildSession(eventSession);
        if (markUnread) {
          unreadSessions[eventSession] = true;
          rememberUnreadSessions(unreadSessions);
        }
        set({
          busySessions,
          ...clearedQuestions,
          ...(markUnread ? { unreadSessions } : {}),
        });
        if (eventSession === currentSession) {
          set({
            streaming: false,
            messages: markInterruptedMessages(get().messages, false),
            sessionStatuses: {
              ...get().sessionStatuses,
              [eventSession]: { type: "idle" },
            },
          });
          // 执行结束后变更与文件状态才有意义，顺手刷新右面板。
          const { rightOpen, rightTab } = get();
          if (rightOpen) void get().refreshChanges({ silent: true });
          if (rightOpen && rightTab === "files") {
            void get().refreshFileTree({ silent: true });
          }
          void get().refreshTasks();
          if (get().overviewOpen) void get().refreshOverview();
        } else if (isChildSession(eventSession)) {
          set({
            childMessages: {
              ...get().childMessages,
              [eventSession]: markInterruptedMessages(
                get().childMessages[eventSession] ?? [],
                false,
              ),
            },
            sessionStatuses: {
              ...get().sessionStatuses,
              [eventSession]: { type: "idle" },
            },
          });
        }
        if (eventSession && !isChildSession(eventSession)) {
          if (get().queueSending[eventSession]) idleDuringSend.add(eventSession);
          else void get().handleDeliveryIdle(eventSession);
        }
        break;
      }
      case "session.error": {
        const wasStopping = Boolean(
          eventSession && get().stoppingSessions[eventSession],
        );
        if (eventSession) get().finishStopping(eventSession);
        const busySessions = { ...get().busySessions };
        delete busySessions[eventSession];
        set({
          busySessions,
          ...clearSessionQuestions(eventSession),
        });
        if (eventSession === currentSession) {
          const message = props.error?.data?.message ?? props.error?.name ?? "未知错误";
          set({
            streaming: false,
            ...(wasStopping ? {} : { error: `会话错误：${message}` }),
            messages: markInterruptedMessages(get().messages, false),
            sessionStatuses: {
              ...get().sessionStatuses,
              [eventSession]: { type: "idle" },
            },
          });
        } else if (isChildSession(eventSession)) {
          set({
            childMessages: {
              ...get().childMessages,
              [eventSession]: markInterruptedMessages(
                get().childMessages[eventSession] ?? [],
                false,
              ),
            },
            sessionStatuses: {
              ...get().sessionStatuses,
              [eventSession]: { type: "idle" },
            },
          });
        }
        if (eventSession && eventSession !== currentSession && !isChildSession(eventSession)) {
          const unreadSessions = { ...get().unreadSessions, [eventSession]: true };
          rememberUnreadSessions(unreadSessions);
          set({ unreadSessions });
        }
        if (eventSession && !isChildSession(eventSession) && !wasStopping) {
          get().handleDeliveryError(eventSession);
        }
        break;
      }
      case "permission.asked":
      case "permission.v2.asked": {
        const request: PermissionRequest = {
          id: props.id,
          sessionID: props.sessionID,
          permission: props.permission ?? props.action ?? "工具调用",
          patterns: props.patterns ?? props.resources ?? [],
          metadata: props.metadata,
        };
        if (!get().permissions.some((p) => p.id === request.id)) {
          set({ permissions: [...get().permissions, request] });
        }
        break;
      }
      case "question.asked": {
        const request = normalizeQuestionRequest(props);
        if (request) {
          noteQuestionUpsert(request);
          set({ questions: upsertQuestion(get().questions, request) });
        }
        break;
      }
      case "question.replied": {
        const requestID =
          typeof props.requestID === "string" ? props.requestID : "";
        if (!requestID) break;
        noteQuestionRemove(requestID);
        const answers = normalizeQuestionAnswers(props.answers);
        set({
          questions: get().questions.filter((question) => question.id !== requestID),
          questionResults: {
            ...get().questionResults,
            [requestID]: { status: "replied", answers },
          },
        });
        break;
      }
      case "question.rejected": {
        const requestID =
          typeof props.requestID === "string" ? props.requestID : "";
        if (!requestID) break;
        noteQuestionRemove(requestID);
        set({
          questions: get().questions.filter((question) => question.id !== requestID),
          questionResults: {
            ...get().questionResults,
            [requestID]: { status: "rejected" },
          },
        });
        break;
      }
      case "session.next.step.started":
        if (eventSession === currentSession) set({ streaming: true });
        else if (isChildSession(eventSession)) {
          set({
            sessionStatuses: {
              ...get().sessionStatuses,
              [eventSession]: { type: "busy" },
            },
          });
        }
        break;
      case "permission.replied":
      case "permission.v2.replied":
        set({ permissions: get().permissions.filter((p) => p.id !== props.requestID) });
        break;
      default:
        break;
    }
  },

  openSettings(page) {
    set(page ? { settingsOpen: true, settingsPage: page } : { settingsOpen: true });
  },

  setSettingsPage(settingsPage) {
    set({ settingsPage });
  },

  closeSettings() {
    set({ settingsOpen: false });
  },

  openShortcuts() {
    set({ shortcutsOpen: true });
  },

  closeShortcuts() {
    set({ shortcutsOpen: false });
  },

  clearFailedText() {
    set({ failedText: null });
  },

  showNotice(message, duration = 4000) {
    if (noticeTimer) clearTimeout(noticeTimer);
    set({ notice: message });
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      set({ notice: null });
    }, duration);
  },

  openFind() {
    if (get().editing) {
      get().showNotice("正在编辑历史消息，请先完成或取消编辑");
      return;
    }
    set({ findOpen: true, findIndex: 0 });
  },

  closeFind() {
    set({ findOpen: false, findQuery: "", findIndex: 0 });
  },

  setFindQuery(query) {
    set({ findQuery: query, findIndex: 0 });
  },

  stepFind(delta) {
    set({ findIndex: Math.max(0, get().findIndex + delta) });
  },

  setSidebarWidth(width) {
    const clamped = Math.min(460, Math.max(220, width));
    localStorage.setItem("deveco.desktop.sidebarWidth", String(Math.round(clamped)));
    set({ sidebarWidth: clamped });
  },

  setRightWidth(width) {
    const clamped = clampRightPanelWidth(width);
    localStorage.setItem(RIGHT_WIDTH, String(clamped));
    set({ rightWidth: clamped });
  },

  setTerminalHeight(height) {
    const clamped = clampTerminalHeight(height);
    localStorage.setItem(TERMINAL_HEIGHT, String(clamped));
    set({ terminalHeight: clamped });
  },

  toggleSidebar() {
    const open = !get().sidebarOpen;
    localStorage.setItem(SIDEBAR_OPEN, open ? "1" : "0");
    set({ sidebarOpen: open });
  },

  toggleRight() {
    const open = !get().rightOpen;
    set({ rightOpen: open });
    if (open) void refreshPanel(get, set);
  },

  toggleTerminal() {
    const open = !get().terminalOpen;
    localStorage.setItem(TERMINAL_OPEN, open ? "1" : "0");
    set({ terminalOpen: open });
  },

  toggleOverview() {
    const open = !get().overviewOpen;
    set({ overviewOpen: open });
    if (open) void get().refreshOverview();
  },

  closeOverview() {
    set({ overviewOpen: false });
  },

  setOverviewPinned(pinned) {
    localStorage.setItem(OVERVIEW_PINNED, pinned ? "1" : "0");
    set({ overviewPinned: pinned });
  },

  async refreshOverview() {
    const directory = get().directory;
    if (!directory) {
      overviewRequest += 1;
      set({
        overviewGit: null,
        overviewLoading: false,
        overviewError: null,
      });
      return;
    }
    const request = ++overviewRequest;
    set({ overviewLoading: true, overviewError: null });
    try {
      const git = await api.gitState(directory);
      if (request !== overviewRequest || get().directory !== directory) return;
      set({ overviewGit: git, overviewLoading: false });
    } catch (error) {
      if (request !== overviewRequest || get().directory !== directory) return;
      set({
        overviewLoading: false,
        overviewError: `读取工作区状态失败：${String(error)}`,
      });
    }
  },

  setCommitMessage(value) {
    set({ commitMessage: value, commitMessageError: null });
  },

  async generateCommitMessage() {
    const state = get();
    const { directory, sessionID } = state;
    if (!directory || !sessionID) {
      set({ commitMessageError: "请先打开一个会话再生成提交信息" });
      return null;
    }
    if (state.commitMessageGenerating || state.committing || state.pushing) {
      return null;
    }
    if (hasRunningAgent(state)) {
      set({ commitMessageError: "Agent 正在执行，结束后再生成提交信息" });
      return null;
    }

    set({
      commitMessageGenerating: true,
      commitMessageError: null,
      commitMessage: "",
    });
    try {
      const git =
        state.overviewGit ?? (await api.gitState(directory));
      if (get().sessionID !== sessionID || get().directory !== directory) return null;
      if (!git.isRepo) throw new Error("当前工作区不是 Git 仓库");
      if (git.files.length === 0) throw new Error("当前没有可提交的改动");
      const diff = await api.vcsDiff(directory).catch(() => [] as FileDiff[]);
      if (get().sessionID !== sessionID || get().directory !== directory) return null;
      const title =
        (get().sessions[directory] ?? []).find((item) => item.id === sessionID)?.title ?? "";
      const prompt = buildCommitPrompt(git, diff, get().todos, title);
      const model = get().selectedModel
        ? `${get().selectedModel!.providerID}/${get().selectedModel!.modelID}`
        : undefined;
      const asideID = newAsideID();
      const text = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = btwPending.get(asideID);
          if (!pending) return;
          btwPending.delete(asideID);
          pending.reject(new Error("生成提交信息超时"));
        }, BTW_TIMEOUT_MS);
        btwPending.set(asideID, {
          sessionID,
          directory,
          text: "",
          resolve,
          reject,
          timer,
        });
        void api
          .btw(directory, sessionID, asideID, prompt, model)
          .catch((error) => {
            takeBtw(asideID)?.reject(
              error instanceof Error ? error : new Error(String(error)),
            );
          });
      });
      if (get().sessionID !== sessionID || get().directory !== directory) return null;
      const message = normalizeCommitMessage(text);
      if (!message) throw new Error("Agent 没有返回提交信息");
      set({
        commitMessage: message,
        commitMessageGenerating: false,
        commitMessageError: null,
      });
      return message;
    } catch (error) {
      if (get().sessionID === sessionID && get().directory === directory) {
        set({
          commitMessageGenerating: false,
          commitMessageError: `生成提交信息失败：${String(error)}`,
        });
      } else {
        set({ commitMessageGenerating: false });
      }
      return null;
    }
  },

  async commitChanges() {
    const state = get();
    const { directory, sessionID } = state;
    if (!directory || !sessionID) {
      set({ commitMessageError: "请先打开一个会话再提交" });
      return;
    }
    if (state.committing || state.pushing || state.commitMessageGenerating) return;
    if (hasRunningAgent(state)) {
      set({ commitMessageError: "Agent 正在执行，结束后再提交" });
      return;
    }

    let git = state.overviewGit;
    if (!git) {
      try {
        git = await api.gitState(directory);
        if (get().sessionID !== sessionID || get().directory !== directory) return;
        set({ overviewGit: git });
      } catch (error) {
        set({ commitMessageError: `读取 Git 状态失败：${String(error)}` });
        return;
      }
    }
    if (!git.isRepo) {
      set({ commitMessageError: "当前工作区不是 Git 仓库" });
      return;
    }
    if (git.detached) {
      set({ commitMessageError: "当前处于 detached HEAD，无法提交" });
      return;
    }
    if (git.files.length === 0) {
      set({ commitMessageError: "当前没有可提交的改动" });
      return;
    }

    let message = normalizeCommitMessage(state.commitMessage);
    if (!message) {
      const generated = await get().generateCommitMessage();
      if (!generated) return;
      message = generated;
    }
    if (get().sessionID !== sessionID || get().directory !== directory) return;
    if (hasRunningAgent(get())) {
      set({ commitMessageError: "Agent 正在执行，结束后再提交" });
      return;
    }

    set({ committing: true, commitMessageError: null });
    try {
      const result = await api.gitCommit(directory, message);
      const next = await api.gitState(directory).catch(() => null);
      set({
        committing: false,
        commitMessage: "",
        commitMessageError: null,
        ...(next ? { overviewGit: next } : {}),
      });
      get().showNotice(
        result.commit ? `已提交 ${result.commit}` : "已提交",
        6000,
      );
      if (get().rightOpen) void get().refreshChanges({ silent: true });
      void get().refreshFileStatuses();
      void get().refreshTasks();
      if (!next) void get().refreshOverview();
    } catch (error) {
      set({
        committing: false,
        commitMessageError: `提交失败：${String(error)}`,
      });
    }
  },

  async pushChanges() {
    const state = get();
    const { directory, sessionID } = state;
    if (!directory || !sessionID) {
      set({ commitMessageError: "请先打开一个会话再推送" });
      return;
    }
    if (state.committing || state.pushing || state.commitMessageGenerating) return;
    if (hasRunningAgent(state)) {
      set({ commitMessageError: "Agent 正在执行，结束后再推送" });
      return;
    }

    let git = state.overviewGit;
    if (!git) {
      try {
        git = await api.gitState(directory);
        set({ overviewGit: git });
      } catch (error) {
        set({ commitMessageError: `读取 Git 状态失败：${String(error)}` });
        return;
      }
    }
    if (!git.isRepo) {
      set({ commitMessageError: "当前工作区不是 Git 仓库" });
      return;
    }
    if (git.detached || !git.branch) {
      set({ commitMessageError: "当前处于 detached HEAD，无法推送" });
      return;
    }
    if (git.upstream ? git.ahead === 0 : !git.remote) {
      set({
        commitMessageError: git.upstream
          ? "没有待推送的提交"
          : "当前分支没有 upstream，且找不到可用的 origin 远端",
      });
      return;
    }

    set({ pushing: true, commitMessageError: null });
    try {
      await api.gitPush(directory);
      const next = await api.gitState(directory).catch(() => null);
      set({
        pushing: false,
        commitMessageError: null,
        ...(next ? { overviewGit: next } : {}),
      });
      get().showNotice("已推送当前分支", 6000);
      if (!next) void get().refreshOverview();
    } catch (error) {
      set({
        pushing: false,
        commitMessageError: `推送失败：${String(error)}`,
      });
    }
  },

  openRightTab(tab) {
    set({
      rightOpen: true,
      rightTab: tab,
      ...(tab === "tasks" ? {} : { selectedTaskID: null }),
    });
    void refreshPanel(get, set);
  },

  setRightTab(tab) {
    set({
      rightTab: tab,
      ...(tab === "tasks" ? {} : { selectedTaskID: null }),
    });
    void refreshPanel(get, set);
  },

  moveRightTab(source, target, after) {
    if (source === target) return;
    const current = get().rightTabOrder;
    if (!current.includes(source) || !current.includes(target)) return;
    const next = current.filter((tab) => tab !== source);
    const targetIndex = next.indexOf(target);
    if (targetIndex === -1) return;
    next.splice(targetIndex + (after ? 1 : 0), 0, source);
    if (next.every((tab, index) => tab === current[index])) return;
    rememberRightTabOrder(next);
    set({ rightTabOrder: next });
  },

  openTasks(taskID = null) {
    set({
      rightOpen: true,
      rightTab: "tasks",
      selectedTaskID: taskID,
    });
    void get().refreshTasks();
  },

  closeTaskDetail() {
    set({ selectedTaskID: null });
  },

  setFilter(value) {
    set({ filter: value });
    if (!value.trim()) set({ searchResults: {} });
  },

  async runSearch(query) {
    const keyword = query.trim();
    if (!keyword) {
      set({ searchResults: {}, searching: false });
      return;
    }
    set({ searching: true });
    const projects = get().projects;
    const results: Record<string, Session[]> = {};
    await Promise.all(
      projects.map(async (project) => {
        try {
          const found = await api.searchSessions(project.worktree, keyword);
          if (found.length > 0) results[project.worktree] = found;
        } catch {
          // 单个工作区失败不影响其它结果
        }
      }),
    );
    // 搜索期间用户可能又改了关键字，只接受仍然是当前关键字的结果
    if (get().filter.trim() !== keyword) return;
    set({ searchResults: results, searching: false });
  },

  async toggleProject(directory) {
    const expanded = get().expanded;
    const open = !(expanded[directory] ?? false);
    const next = { ...expanded };
    if (open) next[directory] = true;
    else delete next[directory];
    set({ expanded: next });
    if (open && !get().loadedDirs[directory]) {
      try {
        const sessions = await api.sessions(directory);
        sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
        set({
          sessions: { ...get().sessions, [directory]: sessions },
          loadedDirs: { ...get().loadedDirs, [directory]: true },
        });
        void get().refreshBusySessions(directory);
      } catch (error) {
        set({ error: `读取会话失败：${String(error)}` });
      }
    }
  },

  async refreshBusySessions(directory) {
    const statuses = await api.sessionStatus(directory).catch(() => null);
    if (!statuses) return;
    // /session/status 只返回忙/重试的会话；先清掉本工作区旧记录再合并。
    set({
      busySessions: mergeBusySessions(
        get().busySessions,
        get().sessions[directory] ?? [],
        statuses,
      ),
    });
  },

  async toggleAllProjects() {
    const { projects, expanded, loadedDirs } = get();
    const allOpen =
      projects.length > 0 && projects.every((project) => expanded[project.worktree]);
    if (allOpen) {
      set({ expanded: {} });
      return;
    }
    const next = { ...expanded };
    for (const project of projects) next[project.worktree] = true;
    set({ expanded: next });
    const pending = projects.filter((project) => !loadedDirs[project.worktree]);
    await Promise.all(
      pending.map(async (project) => {
        try {
          const list = await api.sessions(project.worktree);
          list.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
          set({
            sessions: { ...get().sessions, [project.worktree]: list },
            loadedDirs: { ...get().loadedDirs, [project.worktree]: true },
          });
          void get().refreshBusySessions(project.worktree);
        } catch (error) {
          set({ error: `读取会话失败：${String(error)}` });
        }
      }),
    );
  },

  async loadModels(force = false) {
    if (get().modelsLoading) return;
    if (!force && get().models.length > 0) return;
    set({ modelsLoading: true, modelsError: null });
    try {
      const result = await api.models();
      set({
        models: (result.data ?? []).filter(isModelAvailable),
        modelsLoading: false,
      });
    } catch (error) {
      // 模型列表拿不到不影响聊天，但设置页需要显示失败并允许重试。
      set({ modelsError: `读取模型失败：${String(error)}`, modelsLoading: false });
    }
  },

  setModelVisible(model, visible) {
    const key = modelKey(model.providerID, model.modelID);
    const current = get().hiddenModels;
    const hidden = current.includes(key);
    if (visible === !hidden) return;
    const next = visible ? current.filter((item) => item !== key) : [...current, key];
    writeHiddenModels(next);
    set({ hiddenModels: next });
  },

  selectModel(model) {
    // 换模型时直接采用该模型的最高推理档，避免把上一模型档位带过去。
    const match = get().models.find(
      (item) => item.id === model.modelID && item.providerID === model.providerID,
    );
    set({ selectedModel: model, selectedVariant: highestModelVariant(match) });
  },

  selectAgent(name) {
    const state = get();
    const previousName = state.selectedAgent;
    if (name === previousName) return;
    const { directory, sessionID } = state;
    if (sessionID && isSessionBusy(state, sessionID)) {
      state.showNotice("当前轮执行中，结束后可切换 Agent");
      return;
    }
    if (state.creatingSession || state.permissionUpdating) return;
    set({ selectedAgent: name });
    if (!directory || !sessionID) return;
    const previousAgent = state.agents.find((agent) => agent.name === previousName);
    const nextAgent = state.agents.find((agent) => agent.name === name);
    if (!previousAgent || !nextAgent) return;
    const list = state.sessions[directory] ?? [];
    const session = list.find((item) => item.id === sessionID);
    if (!session) return;
    const mode = ownedPermissionMode(session, previousAgent);
    const permission = mode
      ? rulesForMode(mode, nextAgent)
      : hasCustomSessionPermission(session)
        ? hardPermissionRules(nextAgent)
        : [];
    if (permission.length === 0) return;
    set({
      permissionUpdating: true,
      error: null,
      sessions: {
        ...state.sessions,
        [directory]: upsertSession(list, {
          ...session,
          permission: [...(session.permission ?? []), ...permission],
        }),
      },
    });
    void (async () => {
      const result = await applySessionPermission(
        directory,
        sessionID,
        permission,
        session.permission,
        { errorPrefix: "切换 Agent 后同步会话权限失败" },
      );
      if (result !== "failed") return;
      const current = get();
      if (current.sessionID === sessionID && current.selectedAgent === name) {
        set({ selectedAgent: previousName });
      }
    })();
  },

  async setPermissionMode(mode) {
    const state = get();
    const { directory, sessionID } = state;
    if (!directory) return;
    if (!sessionID) {
      set({ draftPermissionMode: mode });
      state.showNotice(
        `已选择${PERMISSION_MODE_LABELS[mode]}：新会话将按此权限创建`,
      );
      return;
    }
    if (
      state.creatingSession ||
      state.permissionUpdating ||
      isSessionBusy(state, sessionID)
    ) {
      return;
    }
    const agent = state.agents.find((item) => item.name === state.selectedAgent);
    if (!agent) {
      set({ error: "Agent 信息未加载，暂时无法切换权限" });
      return;
    }
    if (!canControlPermission(agent)) {
      state.showNotice("该 Agent 已拒绝这些操作，无法切换权限");
      return;
    }
    const permission = rulesForMode(mode, agent);
    const list = state.sessions[directory] ?? [];
    const session = list.find((item) => item.id === sessionID);
    const owned = ownedPermissionMode(session, agent);
    if (owned === mode) return;
    if (
      session &&
      owned === null &&
      hasCustomSessionPermission(session)
    ) {
      if (
        !window.confirm(
          "当前会话已有自定义权限规则，切换会覆盖这些规则。继续？",
        )
      ) {
        return;
      }
    }
    const previous = session?.permission;
    set({
      permissionUpdating: true,
      error: null,
      ...(session
        ? {
            sessions: {
              ...state.sessions,
              [directory]: upsertSession(list, {
                ...session,
                permission: [...(session.permission ?? []), ...permission],
              }),
            },
          }
        : {}),
    });
    await applySessionPermission(directory, sessionID, permission, previous, {
      notice: `已切换为${PERMISSION_MODE_LABELS[mode]}`,
    });
  },

  resetPermissionMode() {
    if (get().sessionID) return;
    set({ draftPermissionMode: null });
    get().showNotice("已恢复为跟随 Agent 默认权限");
  },

  selectVariant(variant) {
    set({ selectedVariant: variant });
  },

  async loadMeta() {
    const directory = get().directory;
    if (!directory) return;
    const [agents, commands, mcp] = await Promise.all([
      api.agents(directory).catch(() => []),
      api.commands(directory).catch(() => []),
      api.mcp(directory).catch(() => ({})),
    ]);
    const primary = agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden);
    set({
      agents: primary,
      commands,
      mcpCount: Object.values(mcp).filter((item) => item?.status === "connected").length,
      selectedAgent: primary.some((agent) => agent.name === get().selectedAgent)
        ? get().selectedAgent
        : (primary.find((agent) => agent.name === "build")?.name ?? primary[0]?.name ?? "build"),
    });
  },

  async renameSession(directory, id, title) {
    const trimmed = title.trim();
    if (!directory || !trimmed) return;
    try {
      const updated = await api.renameSession(directory, id, trimmed);
      const list = get().sessions[directory] ?? [];
      set({
        sessions: {
          ...get().sessions,
          [directory]: list.map((item) =>
            item.id === id ? { ...item, ...updated, title: updated.title ?? trimmed } : item,
          ),
        },
      });
    } catch (error) {
      set({ error: `重命名失败：${String(error)}` });
    }
  },

  async archiveSession(directory, id, archived) {
    if (!directory) return;
    const snapshot = get().sessions[directory] ?? [];
    // 先本地置位，界面立即响应；失败再回滚
    set({
      sessions: {
        ...get().sessions,
        [directory]: snapshot.map((item) =>
          item.id === id
            ? { ...item, time: { ...(item.time ?? { created: 0, updated: 0 }), archived: archived ? Date.now() : 0 } }
            : item,
        ),
      },
    });
    try {
      const updated = await api.archiveSession(directory, id, archived);
      set({
        sessions: {
          ...get().sessions,
          [directory]: (get().sessions[directory] ?? []).map((item) =>
            item.id === id ? { ...item, ...updated } : item,
          ),
        },
      });
    } catch (error) {
      set({ sessions: { ...get().sessions, [directory]: snapshot }, error: `归档失败：${String(error)}` });
    }
  },

  toggleArchivedView() {
    const next = !get().showArchived;
    localStorage.setItem("deveco.desktop.showArchived", next ? "1" : "0");
    set({ showArchived: next });
  },

  setSessionSort(sessionSort) {
    localStorage.setItem(SESSION_SORT, sessionSort);
    set({ sessionSort });
  },

  setSessionPreview(sessionPreview) {
    localStorage.setItem(SESSION_PREVIEW, String(sessionPreview));
    set({ sessionPreview });
  },

  async reconcileUnreadSessions() {
    const unread = get().unreadSessions;
    const ids = Object.keys(unread).filter((id) => unread[id]);
    const projects = get().projects;
    if (ids.length === 0 || projects.length === 0) return;
    try {
      // 任一路径读取失败就无法证明会话不存在，整体放弃，避免误删未读标记。
      const lists = await Promise.all(
        projects.map((project) => api.sessions(project.worktree)),
      );
      const existing = new Set(lists.flat().map((session) => session.id));
      const stale = ids.filter((id) => !existing.has(id));
      if (stale.length === 0) return;
      const unreadSessions = { ...get().unreadSessions };
      for (const id of stale) delete unreadSessions[id];
      rememberUnreadSessions(unreadSessions);
      set({ unreadSessions });
    } catch (error) {
      console.warn("清理未读标记失败", error);
    }
  },

  async deleteSession(directory, id) {
    if (!directory) return;
    try {
      await api.deleteSession(directory, id);
      sessionCache.delete(directory, id);
      get().clearSessionDelivery(id);
      const list = get().sessions[directory] ?? [];
      const busySessions = { ...get().busySessions };
      delete busySessions[id];
      const unreadSessions = { ...get().unreadSessions };
      delete unreadSessions[id];
      rememberUnreadSessions(unreadSessions);
      noteQuestionSessionClear(id);
      set({
        sessions: { ...get().sessions, [directory]: list.filter((item) => item.id !== id) },
        busySessions,
        unreadSessions,
        questions: get().questions.filter((question) => question.sessionID !== id),
      });
      if (get().directory === directory && get().sessionID === id) {
        cancelBtwPending();
        set({
          sessionID: null,
          sessionLoading: false,
          messages: [],
          editing: null,
          editPhase: "idle",
          permissions: [],
          questions: get().questions.filter((question) => question.sessionID !== id),
          todos: [],
          sessionChildren: [],
          childMessages: {},
          childTodos: {},
          sessionStatuses: {},
          selectedTaskID: null,
          tasksLoading: false,
          draftPermissionMode: null,
          streaming: false,
          sessionDiff: [],
          diffPath: null,
          overviewGit: null,
          overviewLoading: false,
          overviewError: null,
          commitMessage: "",
          commitMessageGenerating: false,
          commitMessageError: null,
          committing: false,
          pushing: false,
        });
        localStorage.removeItem(`${LAST_SESSION}.${directory}`);
        if (get().rightOpen && get().rightTab === "changes") {
          void get().refreshChanges();
        }
      }
    } catch (error) {
      set({ error: `删除会话失败：${String(error)}` });
    }
  },

  async openPreview(path) {
    const directory = get().directory;
    if (!directory) return;
    const absolute = absoluteWorkspacePath(directory, path);
    const request = ++previewRequest;
    const current = () => request === previewRequest;
    set({
      preview: {
        path,
        absolute,
        kind: "loading",
        content: "",
        mime: mimeForPath(path),
        thumbnail: null,
      },
    });

    try {
      // Office/iWork/HEIC 通常不需要整份内容，直接让系统生成缩略图，
      // 避免大文件先经过 HTTP 和 IPC 才被丢弃。
      if (quickLookFirst(path)) {
        try {
          const thumbnail = await loadQuickLook(absolute);
          if (!current()) return;
          set({
            preview: {
              path,
              absolute,
              kind: "quicklook",
              content: "",
              mime: mimeForPath(path),
              thumbnail,
            },
          });
        } catch (error) {
          if (!current()) return;
          set({
            preview: {
              path,
              absolute,
              kind: "unsupported",
              content: "",
              mime: mimeForPath(path),
              thumbnail: null,
              message: `系统无法生成预览：${String(error)}`,
            },
          });
        }
        return;
      }

      const file = await api.fileContent(directory, path);
      if (!current()) return;
      if (file.content === undefined) throw new Error("接口没有返回文件内容");

      const mime = file.mimeType || mimeForPath(path);
      let kind = classifyPreview(path, file.type, mime);
      if (kind === "unsupported" && file.type === "binary") {
        try {
          const thumbnail = await loadQuickLook(absolute);
          if (!current()) return;
          set({
            preview: {
              path,
              absolute,
              kind: "quicklook",
              content: "",
              mime,
              thumbnail,
            },
          });
          return;
        } catch (error) {
          if (!current()) return;
          kind = "unsupported";
          set({
            preview: {
              path,
              absolute,
              kind,
              content: "",
              mime,
              thumbnail: null,
              message: `系统无法生成预览：${String(error)}`,
            },
          });
          return;
        }
      }

      set({
        preview: {
          path,
          absolute,
          kind,
          content: file.content,
          mime,
          thumbnail: null,
        },
      });
    } catch (error) {
      if (!current()) return;
      set({
        preview: {
          path,
          absolute,
          kind: "error",
          content: "",
          mime: mimeForPath(path),
          thumbnail: null,
          message: `读取失败：${String(error)}`,
        },
      });
    }
  },

  async openFile(path) {
    const directory = get().directory;
    if (!directory) return;
    // CLI 返回的 filename 可能是相对路径，也可能被上游改写成绝对路径
    const normalized = path.replace(/\\/g, "/");
    const relative = normalized.startsWith(`${directory}/`)
      ? normalized.slice(directory.length + 1)
      : normalized.replace(/^\/+/, "");
    fileSearchRequest += 1;
    set({
      rightOpen: true,
      rightTab: "files",
      preview: null,
      fileQuery: "",
      fileSearchResults: [],
      fileSearching: false,
      fileSearchError: null,
      fileFocusPath: null,
    });
    if (!get().fileTree[""]) void get().loadFileDir("");
    void get().refreshFileStatuses();
    await get().openPreview(relative);
  },

  closePreview() {
    previewRequest += 1;
    set({ preview: null });
  },

  setChangeSource(source) {
    if (source === "session" && !get().sessionID) return;
    localStorage.setItem(CHANGE_SOURCE, source);
    set({ changeSource: source, diffPath: null });
    void get().refreshChanges();
  },

  async refreshChanges(options) {
    const state = get();
    const { directory, sessionID } = state;
    const source = resolvedChangeSource(state.changeSource, sessionID);
    if (!directory) {
      changesRequest += 1;
      set({
        workspaceDiff: [],
        sessionDiff: [],
        changesRepo: null,
        changesLoading: false,
        changesError: null,
      });
      return;
    }
    const request = ++changesRequest;
    const existing = source === "workspace" ? state.workspaceDiff : state.sessionDiff;
    if (!options?.silent || existing.length === 0) {
      set({ changesLoading: true, changesError: null });
    }
    try {
      if (source === "workspace") {
        const [info, diff] = await Promise.all([
          api.vcsInfo(directory).catch(() => null),
          api.vcsDiff(directory),
        ]);
        if (
          request !== changesRequest ||
          get().directory !== directory
        ) {
          return;
        }
        set({
          workspaceDiff: normalizeDiff(diff),
          changesRepo: info ? Boolean(info.branch) : null,
          changesLoading: false,
          changesError: null,
        });
        return;
      }

      const diff = await api.diff(directory, sessionID!);
      if (
        request !== changesRequest ||
        get().directory !== directory ||
        get().sessionID !== sessionID
      ) {
        return;
      }
      set({
        sessionDiff: normalizeDiff(diff),
        changesLoading: false,
        changesError: null,
      });
    } catch (error) {
      if (request !== changesRequest) return;
      set({
        changesLoading: false,
        changesError: `读取变更失败：${String(error)}`,
      });
    }
  },

  setChangeQuery(value) {
    set({ changeQuery: value });
  },

  toggleChangeDir(path) {
    const key = normalizeTreePath(path);
    const collapsed = new Set(get().collapsedChangeDirs);
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    set({ collapsedChangeDirs: [...collapsed] });
  },

  setCollapsedChangeDirs(paths) {
    set({ collapsedChangeDirs: [...new Set(paths.filter(Boolean))] });
  },

  openDiff(path) {
    set({ diffPath: path });
  },

  closeDiff() {
    set({ diffPath: null });
  },

  async refreshFileStatuses() {
    const directory = get().directory;
    if (!directory) {
      fileStatusRequest += 1;
      set({ fileStatuses: {} });
      return;
    }
    const request = ++fileStatusRequest;
    try {
      const statuses = await api.vcsStatus(directory);
      if (request !== fileStatusRequest || get().directory !== directory) return;
      const map: Record<string, VcsFileStatus> = {};
      for (const status of statuses) {
        map[normalizeTreePath(status.file)] = status;
      }
      set({ fileStatuses: map });
    } catch (error) {
      if (request !== fileStatusRequest) return;
      console.warn("读取文件状态失败", error);
    }
  },

  async loadFileDir(path) {
    const directory = get().directory;
    if (!directory) return;
    const key = normalizeTreePath(path);
    const request = (fileDirRequests.get(key) ?? 0) + 1;
    fileDirRequests.set(key, request);
    set({
      fileLoading: { ...get().fileLoading, [key]: true },
      fileErrors: { ...get().fileErrors, [key]: null },
    });
    try {
      const absolute = key ? absoluteWorkspacePath(directory, key) : directory;
      const entries = await api.listFiles(directory, absolute);
      if (request !== fileDirRequests.get(key) || get().directory !== directory) return;
      set({
        fileTree: { ...get().fileTree, [key]: sortFileNodes(entries) },
        fileLoading: { ...get().fileLoading, [key]: false },
        fileErrors: { ...get().fileErrors, [key]: null },
      });
    } catch (error) {
      if (request !== fileDirRequests.get(key) || get().directory !== directory) return;
      set({
        fileLoading: { ...get().fileLoading, [key]: false },
        fileErrors: {
          ...get().fileErrors,
          [key]: `读取目录失败：${String(error)}`,
        },
      });
    }
  },

  toggleFileDir(path) {
    const key = normalizeTreePath(path);
    if (!key) return;
    const expanded = Boolean(get().expandedDirs[key]);
    set({
      expandedDirs: { ...get().expandedDirs, [key]: !expanded },
      fileErrors: { ...get().fileErrors, [key]: null },
    });
    // 目录可能被外部进程改动过，展开时重新读取；旧内容先保留，避免闪空。
    if (!expanded) {
      void get().loadFileDir(key);
    }
  },

  async revealFileDir(path) {
    const directory = get().directory;
    if (!directory) return;
    const target = normalizeTreePath(path);
    fileSearchRequest += 1;
    if (!target) {
      set({
        fileQuery: "",
        fileSearchResults: [],
        fileSearching: false,
        fileSearchError: null,
        fileFocusPath: null,
      });
      return;
    }

    const prefixes = ancestorTreePaths(target);
    const expanded = { ...get().expandedDirs };
    for (const prefix of prefixes) expanded[prefix] = true;
    set({
      expandedDirs: expanded,
      fileQuery: "",
      fileSearchResults: [],
      fileSearching: false,
      fileSearchError: null,
      fileFocusPath: target,
    });

    // 搜索结果来自最新磁盘状态，定位时强制刷新祖先目录，避免缓存里没有新目录。
    await Promise.all(["", ...prefixes].map((prefix) => get().loadFileDir(prefix)));
    set({ fileFocusPath: target });
  },

  async runFileSearch(query) {
    const directory = get().directory;
    if (!directory) return;
    const keyword = query.trim();
    if (!keyword) {
      fileSearchRequest += 1;
      set({
        fileSearchResults: [],
        fileSearching: false,
        fileSearchError: null,
      });
      return;
    }
    const request = ++fileSearchRequest;
    set({ fileSearching: true, fileSearchError: null });
    try {
      const hits = await api.files(directory, keyword);
      if (
        request !== fileSearchRequest ||
        get().directory !== directory ||
        get().fileQuery.trim() !== keyword
      ) {
        return;
      }
      set({
        fileSearchResults: hits,
        fileSearching: false,
        fileSearchError: null,
      });
    } catch (error) {
      if (request !== fileSearchRequest) return;
      set({
        fileSearching: false,
        fileSearchError: `搜索文件失败：${String(error)}`,
      });
    }
  },

  async refreshFileTree(options) {
    const state = get();
    if (!state.directory) return;
    if (state.fileQuery.trim()) {
      await get().runFileSearch(state.fileQuery);
      void get().refreshFileStatuses();
      return;
    }
    const dirs = [
      "",
      ...Object.entries(state.expandedDirs)
        .filter(([, open]) => open)
        .map(([path]) => path),
    ];
    if (!options?.silent && !state.fileTree[""]) {
      set({ fileLoading: { ...state.fileLoading, "": true } });
    }
    await Promise.all(dirs.map((path) => get().loadFileDir(path)));
    void get().refreshFileStatuses();
  },

  setFileQuery(value) {
    fileSearchRequest += 1;
    set({ fileQuery: value, fileSearching: Boolean(value.trim()) });
    if (!value.trim()) {
      set({
        fileSearchResults: [],
        fileSearching: false,
        fileSearchError: null,
      });
    }
  },

  setShowIgnored(value) {
    localStorage.setItem(FILE_SHOW_IGNORED, value ? "1" : "0");
    set({ showIgnored: value });
  },

  setFileFocusPath(path) {
    set({ fileFocusPath: path });
  },

  dismissError() {
    set({ error: null });
  },
}));

async function loadQuickLook(path: string): Promise<Blob> {
  const png = await api.quickLookThumbnail(path);
  return new Blob([png], { type: "image/png" });
}

async function refreshPanel(
  get: () => AppState,
  _set: (partial: Partial<AppState>) => void,
) {
  const { directory, rightTab } = get();
  if (!directory) return;
  if (rightTab === "changes") {
    await get().refreshChanges();
  }
  if (rightTab === "files") {
    await get().refreshFileTree();
  }
  if (rightTab === "tasks") {
    await get().refreshTasks();
  }
}

/** 文件监听与 diff 事件会成串到达，合并成一次右栏刷新。 */
function schedulePanelRefresh(delay = 600) {
  if (panelRefreshTimer) clearTimeout(panelRefreshTimer);
  panelRefreshTimer = setTimeout(() => {
    panelRefreshTimer = null;
    const state = useApp.getState();
    if (!state.rightOpen) return;
    if (state.rightTab === "changes") {
      void state.refreshChanges({ silent: true });
    } else if (state.rightTab === "files") {
      void state.refreshFileTree({ silent: true });
    }
  }, delay);
}

/**
 * 引用文件的 MIME 只用于消息元数据：serve 对 file:// 路径会自己嗅探真实类型，
 * 所以这里按扩展名给近似值即可（未知扩展名按纯文本，便于模型直接读）。
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/plain",
  jsx: "text/plain",
  ets: "text/plain",
  mjs: "text/plain",
  cjs: "text/plain",
  json: "application/json",
  md: "text/markdown",
  css: "text/css",
  scss: "text/css",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yml: "text/yaml",
  yaml: "text/yaml",
  toml: "text/plain",
  txt: "text/plain",
  rs: "text/plain",
  py: "text/plain",
  go: "text/plain",
  java: "text/plain",
  kt: "text/plain",
  swift: "text/plain",
  sh: "text/plain",
  sql: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

function guessMime(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot > 0 ? path.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXTENSION[extension] ?? "text/plain";
}

/**
 * 工作区相对路径 → file:// URL。
 * 按 / 分段 encodeURIComponent：保留路径分隔符，但空格、中文、% 都转义，
 * 否则带空格的文件名会被 serve 拆成多个路径片段。
 */
function fileURLFor(directory: string, relative: string): string {
  const base = directory.replace(/\/+$/, "");
  const absolute = `${base}/${relative.replace(/^\/+/, "")}`;
  return `file://${absolute
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

/**
 * @ 引用 → prompt 的 file part。
 * url 用 file:// 绝对路径（serve 读盘）；source 带工作区相对路径与文本位置，
 * 消息里能还原成「引用了哪个文件、对应输入里的哪一段」。
 */
function buildPromptParts(
  directory: string,
  text: string,
  refs: MentionRef[],
  attachments: Attachment[],
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (text.trim()) parts.push({ type: "text", text });
  for (const ref of refs) parts.push(buildMentionPart(directory, ref));
  for (const file of attachments) {
    parts.push({
      type: "file",
      mime: file.mime,
      url: file.url,
      filename: file.name,
    });
  }
  return parts;
}

/**
 * 编辑历史消息时：正文和 @ 引用以新文本为准重新生成，
 * 用户上传的附件按原 part 保留（已移除的不会进来）。
 */
function buildEditedPromptParts(
  directory: string,
  text: string,
  uploads: Part[],
): Array<Record<string, unknown>> {
  const value = text.trim();
  const parts: Array<Record<string, unknown>> = [];
  if (value) parts.push({ type: "text", text: value });
  for (const ref of parseMentions(value)) {
    parts.push(buildMentionPart(directory, ref));
  }
  for (const part of uploads) {
    if (part.type !== "file" || part.synthetic) continue;
    const url = typeof part.url === "string" ? part.url : "";
    if (!url) continue;
    const file: Record<string, unknown> = {
      type: "file",
      mime: String(part.mime ?? "application/octet-stream"),
      url,
    };
    if (typeof part.filename === "string" && part.filename) {
      file.filename = part.filename;
    }
    parts.push(file);
  }
  return parts;
}

function buildMentionPart(directory: string, ref: MentionRef): Record<string, unknown> {
  const relative = ref.path.replace(/^\/+/, "");
  return {
    type: "file",
    mime: guessMime(relative),
    filename: relative,
    url: fileURLFor(directory, relative),
    source: {
      type: "file",
      path: relative,
      text: { value: ref.token, start: ref.start, end: ref.end },
    },
  };
}
