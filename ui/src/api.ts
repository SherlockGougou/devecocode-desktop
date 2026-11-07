import { invoke } from "@tauri-apps/api/core";
import type {
  AgentInfo,
  AppConfig,
  BackendPhase,
  CommandInfo,
  McpServerInfo,
  CliConfigSummary,
  FileDiff,
  FileNode,
  Message,
  ModelInfo,
  PermissionRequest,
  Project,
  RuntimeInfo,
  Session,
} from "./types";

type Query = Record<string, string | number | boolean | undefined>;

/** 所有请求都走 Rust 侧代理：避免 CORS，并复用 CLI 连接信息。 */
async function request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
  const cleanQuery: Record<string, string> = {};
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) cleanQuery[key] = String(value);
    }
  }
  return (await invoke("server_request", {
    method,
    path,
    query: cleanQuery,
    body: body ?? null,
  })) as T;
}

export const api = {
  health: () => request<{ healthy: boolean }>("GET", "/api/health"),
  projects: () => request<Project[]>("GET", "/project"),
  sessions: (directory: string) =>
    request<Session[]>("GET", "/session", { directory, roots: "true", limit: 200 }),
  searchSessions: (directory: string, search: string) =>
    request<Session[]>("GET", "/session", { directory, search, roots: "true", limit: 50 }),
  messages: (directory: string, sessionID: string) =>
    request<Message[]>("GET", `/session/${sessionID}/message`, { directory }),
  createSession: (directory: string, title?: string) =>
    request<Session>("POST", "/session", { directory }, title ? { title } : {}),
  prompt: (
    directory: string,
    sessionID: string,
    parts: Array<Record<string, unknown>>,
    options?: { model?: { providerID: string; modelID: string }; agent?: string; variant?: string },
  ) =>
    request<Message>("POST", `/session/${sessionID}/message`, { directory }, {
      parts,
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.agent ? { agent: options.agent } : {}),
      ...(options?.variant ? { variant: options.variant } : {}),
    }),
  abort: (directory: string, sessionID: string) =>
    request<boolean>("POST", `/session/${sessionID}/abort`, { directory }, {}),
  permissions: (directory: string) =>
    request<PermissionRequest[]>("GET", "/permission", { directory }),
  replyPermission: (directory: string, id: string, reply: "once" | "always" | "reject") =>
    request<boolean>("POST", `/permission/${id}/reply`, { directory }, { reply }),
  diff: (directory: string, sessionID: string) =>
    request<FileDiff[]>("GET", `/session/${sessionID}/diff`, { directory }),
  vcsDiff: (directory: string) =>
    request<FileDiff[]>("GET", "/vcs/diff", { directory, mode: "git" }),
  files: (directory: string, query: string) =>
    request<string[]>("GET", "/find/file", { directory, query, limit: 300 }),
  searchFiles: (directory: string, query: string) =>
    request<string[]>("GET", "/find/file", { directory, query, limit: 20 }),
  listFiles: (directory: string, path: string) =>
    request<FileNode[]>("GET", "/file", { directory, path }),
  models: () => request<{ data: ModelInfo[] }>("GET", "/api/model"),
  agents: (directory: string) => request<AgentInfo[]>("GET", "/agent", { directory }),
  commands: (directory: string) => request<CommandInfo[]>("GET", "/command", { directory }),
  mcp: (directory: string) =>
    request<Record<string, McpServerInfo>>("GET", "/mcp", { directory }),
  openClassicView: () => invoke("open_classic_view"),
  exportSession: (directory: string, sessionID: string) =>
    invoke<string>("export_session", { directory, sessionId: sessionID }),
  getSettings: () => invoke<{ config: AppConfig; runtime: RuntimeInfo }>("get_settings"),
  saveSettings: (config: AppConfig) =>
    invoke<{ ok: boolean; restartRequired: boolean; config: AppConfig }>("save_settings", { config }),
  probeCli: (explicit: string | null) =>
    invoke<{ path: string; version: string | null }>("probe_cli", { explicit }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  restartApp: () => invoke<void>("restart_app"),
  cliConfig: () => request<CliConfigSummary>("GET", "/config"),
  renameSession: (directory: string, id: string, title: string) =>
    request<Session>("PATCH", `/session/${id}`, { directory }, { title }),
  archiveSession: (directory: string, id: string, archived: boolean) =>
    request<Session>("PATCH", `/session/${id}`, { directory }, {
      time: { archived: archived ? Date.now() : 0 },
    }),
  deleteSession: (directory: string, id: string) =>
    request<boolean>("DELETE", `/session/${id}`, { directory }),
  fileContent: (directory: string, path: string) =>
    request<{ type?: string; content?: string }>("GET", "/file/content", { directory, path }),
  startupDirectory: () => invoke<string | null>("startup_directory"),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  backendState: () => invoke<BackendPhase>("backend_state"),
  retryBackend: () => invoke<void>("retry_backend"),
};
