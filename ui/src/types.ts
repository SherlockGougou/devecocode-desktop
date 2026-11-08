// DevEco Code CLI 的 HTTP 契约类型（取自 /doc 的 OpenAPI，只保留用到的部分）

export interface Project {
  id: string;
  worktree: string;
  vcs?: string;
  time?: { created: number; updated: number };
}

export interface Tokens {
  /** CLI 已聚合的总量（未缓存输入 + 输出 + 推理 + 缓存读写）；旧数据可能缺失 */
  total?: number;
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
  time?: { start?: number; end?: number };
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
  providerID?: string;
  modelID?: string;
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

export interface VcsInfo {
  branch: string | null;
  default_branch?: string | null;
}

export interface VcsFileStatus {
  file: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

export type GitFileStatusKind =
  | "added"
  | "modified"
  | "deleted"
  | "untracked"
  | "unmerged";

export interface GitFileStatus {
  path: string;
  status: GitFileStatusKind;
  staged: boolean;
  unstaged: boolean;
}

/** Rust `git_state` 的返回结构；非 Git 目录返回 isRepo=false。 */
export interface GitRepoState {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  detached: boolean;
  files: GitFileStatus[];
  staged: number;
  unstaged: number;
  untracked: number;
  additions: number;
  deletions: number;
  ahead: number;
  behind: number;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  commit: string | null;
}

export interface ModelInfo {
  id: string;
  providerID: string;
  name?: string;
  family?: string | null;
  status?: "alpha" | "beta" | "deprecated" | "active";
  enabled?: boolean;
  variants?: Array<{ id: string }>;
  limit?: { context?: number | null; output?: number | null };
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
  error?: string;
}

// ---------- 设置页 ----------

export type SettingsPage =
  | "appearance"
  | "account"
  | "agent"
  | "extensions"
  | "cli"
  | "notifications"
  | "diagnostics";

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
  /** CLI serve 启动参数；旧配置缺省时由 Rust 侧补默认值 */
  log_level?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  pure?: boolean;
  mdns?: boolean;
  mdns_domain?: string;
  cors?: string[];
  /** 口令等其余字段原样保留，前端不解释 */
  [key: string]: unknown;
}

export interface MenuBarSettings {
  icon_style: "monochrome" | "color";
  always_visible: boolean;
}

export interface AppConfig {
  cli_path: string | null;
  use_bundled_cli: boolean;
  notifications: NotificationSettings;
  server: ServerSettings;
  menu_bar: MenuBarSettings;
}

export interface TrayContext {
  project: string | null;
  sessionTitle: string | null;
  streaming: boolean;
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

export interface PermissionSummary {
  total: number;
  allow: number;
  ask: number;
  deny: number;
  defaultEffect: string | null;
}

export interface CliAgentSummary {
  name: string;
  description?: string;
  model?: string;
  variant?: string;
  mode?: string;
  hidden?: boolean;
  disabled?: boolean;
}

export interface CliConfigSummary {
  model?: string;
  small_model?: string;
  default_agent?: string;
  shell?: string;
  username?: string;
  share?: string;
  autoupdate?: boolean | "notify";
  providerCount: number;
  mcpCount: number;
  pluginCount: number;
  pluginNames: string[];
  skillSources: string[];
  permission: PermissionSummary;
  agents: CliAgentSummary[];
  uiVerificationModel?: string;
}

export type CliConfigScope = "global" | "project";
export type CliConfigPath = Array<string | number>;

export interface CliSecretInfo {
  path: CliConfigPath;
  label: string;
  configured: boolean;
}

export interface CliConfigSnapshot {
  scope: CliConfigScope;
  path: string;
  exists: boolean;
  hash: string;
  text: string;
  value: Record<string, unknown>;
  secrets: CliSecretInfo[];
  parse_error: string | null;
  redacted: boolean;
  updated_at: number | null;
}

export interface CliConfigSources {
  config_dir: string;
  global_path: string;
  project_config_dir: string | null;
  project_path: string | null;
  worktree: string | null;
}

export interface CliConfigSaveRequest {
  scope: CliConfigScope;
  directory: string | null;
  base_hash: string;
  text: string;
  reveal_secrets: boolean;
}

export interface CliConfigSaveResult {
  snapshot: CliConfigSnapshot;
  warnings: string[];
}

export interface CliBackupInfo {
  name: string;
  path: string;
  updated_at: number;
  size: number;
}

export interface ProviderAuthPromptOption {
  label: string;
  value: string;
  hint?: string;
}

export interface ProviderAuthPrompt {
  type: "text" | "select";
  key: string;
  message: string;
  placeholder?: string;
  options?: ProviderAuthPromptOption[];
  when?: { key: string; op: "eq" | "neq"; value: string };
}

export interface ProviderAuthMethod {
  type: "oauth" | "api";
  label: string;
  prompts?: ProviderAuthPrompt[];
}

export type ProviderAuthMethods = Record<string, ProviderAuthMethod[]>;

export interface ProviderAuthAuthorization {
  url: string;
  method: "auto" | "code";
  instructions: string;
}

export interface ProductAgreement {
  version: string;
  termsUrl: string;
  privacyUrl: string;
  accepted: boolean;
  acceptedAt?: number | string | null;
  upload?: {
    state?: string;
    revision?: string;
    lastAttemptAt?: number | string | null;
    uploadedAt?: number | string | null;
  };
}

export interface AuthEntry {
  providerID: string;
  type: string;
  removable: boolean;
  isRealName?: boolean;
}

export interface ProviderSummary {
  id: string;
  name: string;
  source?: string;
  modelCount: number;
}

export interface ProviderOverview {
  providers: ProviderSummary[];
  default: Record<string, string>;
}

export interface QuotaWindow {
  enabled: boolean;
  periodHours?: number;
  nextResetTime?: string;
  total?: number;
  used?: number;
  remaining?: number;
}

export interface StatsQuota {
  hourly?: QuotaWindow;
  weekly?: QuotaWindow;
  monthly?: QuotaWindow;
}

export interface UsageTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface StatsUsage {
  directory?: string;
  total: {
    sessions: number;
    messages: number;
    cost: number;
    longestDuration: number;
    tokens: UsageTokens;
  };
  models: Array<{
    providerID: string;
    modelID: string;
    messages: number;
    cost: number;
    tokens: UsageTokens;
  }>;
}

export interface SkillStatus {
  name: string;
  description?: string;
  location: string;
  scope: "global" | "project" | "builtin";
  enabled: boolean;
}

export interface CliPathInfo {
  home: string;
  state: string;
  config: string;
  projectConfig: string;
  worktree: string;
  directory: string;
}

export interface ShellInfo {
  path: string;
  name: string;
  acceptable: boolean;
}

export interface PtySession {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: "running" | "exited";
  pid: number;
  exitCode?: number;
}

export type TerminalEventPayload =
  | { kind: "data"; id: string; data: string }
  | { kind: "exit"; id: string; message: string }
  | { kind: "error"; id: string; message: string };

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

/** HDC 发现的 HarmonyOS 设备。序列号只在本地用于选择设备。 */
export interface DeviceInfo {
  serial: string;
  connection: string;
  status: string;
  model: string | null;
  name: string | null;
  manufacturer: string | null;
  apiVersion: string | null;
  osVersion: string | null;
}

export interface DeviceProbe {
  hdcPath: string;
  hdcVersion: string | null;
  devices: DeviceInfo[];
}

/** `snapshot_display` 抓取并转存到应用数据目录的一帧截图。 */
export interface DeviceShot {
  serial: string;
  path: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  capturedAt: number;
}

export interface DeviceAwakeStatus {
  enabled: boolean;
  charging: boolean;
  active: boolean;
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
