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

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  url: string;
  size: number;
}
