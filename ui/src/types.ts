// DevEco Code CLI 的 HTTP 契约类型（取自 /doc 的 OpenAPI，只保留用到的部分）

export interface Project {
  id: string;
  worktree: string;
  vcs?: string;
  time?: { created: number; updated: number };
}

export interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface Session {
  id: string;
  title?: string;
  directory?: string;
  agent?: string;
  parentID?: string;
  slug?: string;
  cost?: number;
  tokens?: Tokens;
  time?: { created: number; updated: number; archived?: number };
  summary?: { additions: number; deletions: number; files: number };
}

export interface Part {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  /** CLI 生成的内部上下文（如 file:// 引用展开的 Read 调用），不面向用户展示 */
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  state?: ToolState;
  /* 其余字段按需透传 */
  [key: string]: unknown;
}

export interface ToolState {
  status?: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: unknown;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
  error?: unknown;
}

export interface MessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  agent?: string;
  model?: { providerID: string; modelID: string };
  time?: { created: number; completed?: number };
  cost?: number;
  tokens?: Tokens;
  error?: { name?: string; data?: { message?: string } };
}

export interface Message {
  info: MessageInfo;
  parts: Part[];
}

export interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
}

export interface FileDiff {
  file: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  status?: string;
}

export interface ModelInfo {
  id: string;
  providerID: string;
  name?: string;
  family?: string | null;
  variants?: Array<{ id: string }>;
}

export interface AgentInfo {
  name: string;
  description?: string;
  mode?: "subagent" | "primary" | "all";
  hidden?: boolean;
}

export interface CommandInfo {
  name: string;
  description?: string;
  source?: string;
  agent?: string;
  model?: string;
}

export interface McpServerInfo {
  status?: string;
}

// ---------- 设置页 ----------

export interface NotificationSettings {
  enabled: boolean;
  on_permission: boolean;
  on_idle: boolean;
  on_error: boolean;
  on_step: boolean;
  quiet_when_focused: boolean;
}

export interface ServerSettings {
  hostname: string;
  preferred_port: number;
  secure: boolean;
  /** 口令等其余字段原样保留，前端不解释 */
  [key: string]: unknown;
}

export interface AppConfig {
  cli_path: string | null;
  notifications: NotificationSettings;
  server: ServerSettings;
}

export interface RuntimeInfo {
  appVersion: string;
  baseUrl: string | null;
  cliPath: string | null;
  cliVersion: string | null;
  configPath: string | null;
  logDir: string | null;
  dataDir: string | null;
}

export interface CliConfigSummary {
  model?: string;
  small_model?: string;
  permission?: unknown;
  plugin?: string[];
}

export interface FileNode {
  name: string;
  path: string;
  absolute?: string;
  type: "file" | "directory";
  ignored?: boolean;
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoPriority = "high" | "medium" | "low";

/** CLI `/session/{id}/todo` 与 `todo.updated` 的稳定结构。 */
export interface TodoItem {
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

/** 由 task 工具或 subtask part 推导出的子代理任务，仅用于界面展示。 */
export interface SubagentTask {
  /** part id；没有 part 的孤儿子会话用 `session:<id>` */
  id: string;
  parentSessionID: string;
  sessionID: string | null;
  agent: string;
  description: string;
  prompt: string;
  status: "pending" | "running" | "completed" | "error";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  child?: Session;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  url: string;
  size: number;
}

/**
 * Composer 里 @ 引用的工作区文件。
 * 输入文本是唯一事实来源：chip 与发送时的 file part 都从文本解析出来，
 * token 是文本中实际出现的 `@path` 或 `@"path with space"`。
 */
export interface MentionRef {
  /** 工作区相对路径（不含引号） */
  path: string;
  /** 文本中实际出现的 token（路径含空格时带引号） */
  token: string;
  /** token 在文本中的起始下标，发送时作为 source.text.start */
  start: number;
  /** token 在文本中的结束下标（不含），发送时作为 source.text.end */
  end: number;
}

/** 后端状态：主进程自愈过程广播给界面的状态机 */
export type BackendState = "starting" | "ready" | "reconnecting" | "recovering" | "failed";

export interface BackendPhase {
  state: BackendState;
  attempt: number;
  detail: string | null;
}
