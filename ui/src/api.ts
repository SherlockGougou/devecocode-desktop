import { invoke } from "@tauri-apps/api/core";
import type {
  AgentInfo,
  AppConfig,
  AuthEntry,
  BackendPhase,
  CliConfigSummary,
  CliPathInfo,
  CommandInfo,
  DeviceAwakeStatus,
  DeviceProbe,
  DeviceShot,
  FileDiff,
  FileNode,
  GitCommandResult,
  GitRepoState,
  McpServerInfo,
  Message,
  ModelInfo,
  PermissionRequest,
  ProviderOverview,
  Project,
  RuntimeInfo,
  Session,
  SessionStatus,
  ShellInfo,
  SkillStatus,
  StatsQuota,
  StatsUsage,
  TrayContext,
  TodoItem,
} from "./types";

type Query = Record<string, string | number | boolean | undefined>;

/** 所有请求都走 Rust 侧代理：避免 CORS，并复用 CLI 连接信息。 */
async function request<T>(
  method: string,
  path: string,
  query?: Query,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
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
    timeoutMs: timeoutMs ?? null,
  })) as T;
}

type RawCliConfig = {
  model?: unknown;
  small_model?: unknown;
  default_agent?: unknown;
  shell?: unknown;
  username?: unknown;
  share?: unknown;
  autoupdate?: unknown;
  provider?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  plugin?: unknown[];
  skills?: { paths?: unknown[]; urls?: unknown[] } | unknown;
  permission?: unknown;
  agent?: Record<
    string,
    {
      description?: unknown;
      model?: unknown;
      variant?: unknown;
      mode?: unknown;
      hidden?: unknown;
      disable?: unknown;
      disabled?: unknown;
    }
  >;
};

type RawProviderResponse = {
  providers?: Array<{
    id?: unknown;
    name?: unknown;
    source?: unknown;
    models?: Record<string, unknown>;
  }>;
  default?: Record<string, string>;
};

type RawSkillStatus = Omit<SkillStatus, "content"> & { content?: string };

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function permissionSummary(value: unknown): CliConfigSummary["permission"] {
  let total = 0;
  let allow = 0;
  let ask = 0;
  let deny = 0;
  let defaultEffect: string | null = null;
  const count = (effect: unknown) => {
    if (effect !== "allow" && effect !== "ask" && effect !== "deny") return;
    total += 1;
    if (effect === "allow") allow += 1;
    else if (effect === "ask") ask += 1;
    else deny += 1;
  };
  if (typeof value === "string") {
    defaultEffect = value;
    count(value);
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, effect] of Object.entries(value as Record<string, unknown>)) {
      if (key === "*" && typeof effect === "string") defaultEffect = effect;
      if (typeof effect === "string" || effect === null) count(effect);
      else if (effect && typeof effect === "object" && !Array.isArray(effect)) {
        for (const nested of Object.values(effect)) count(nested);
      }
    }
  }
  return { total, allow, ask, deny, defaultEffect };
}

function summarizeConfig(raw: RawCliConfig): CliConfigSummary {
  const agentEntries = Object.entries(raw.agent ?? {});
  const agents = agentEntries.map(([name, agent]) => ({
    name,
    description: stringValue(agent.description),
    model: stringValue(agent.model),
    variant: stringValue(agent.variant),
    mode: stringValue(agent.mode),
    hidden: agent.hidden === true,
    disabled: agent.disabled === true || agent.disable === true,
  }));
  const pluginNames = (raw.plugin ?? []).flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (Array.isArray(entry) && typeof entry[0] === "string") return [entry[0]];
    return [];
  });
  const skillSources: string[] = [];
  if (raw.skills && typeof raw.skills === "object" && !Array.isArray(raw.skills)) {
    const skills = raw.skills as { paths?: unknown[]; urls?: unknown[] };
    for (const value of [...(skills.paths ?? []), ...(skills.urls ?? [])]) {
      if (typeof value === "string") skillSources.push(value);
    }
  }
  return {
    model: stringValue(raw.model),
    small_model: stringValue(raw.small_model),
    default_agent: stringValue(raw.default_agent),
    shell: stringValue(raw.shell),
    username: stringValue(raw.username),
    share: stringValue(raw.share),
    autoupdate:
      typeof raw.autoupdate === "boolean" || raw.autoupdate === "notify"
        ? raw.autoupdate
        : undefined,
    providerCount: Object.keys(raw.provider ?? {}).length,
    mcpCount: Object.keys(raw.mcp ?? {}).length,
    pluginCount: pluginNames.length,
    pluginNames,
    skillSources,
    permission: permissionSummary(raw.permission),
    agents,
    uiVerificationModel: stringValue(raw.agent?.ui_verification?.model),
  };
}

async function providerOverview(directory?: string): Promise<ProviderOverview> {
  const raw = await request<RawProviderResponse>("GET", "/config/providers", { directory });
  return {
    providers: (raw.providers ?? []).flatMap((provider) => {
      const id = stringValue(provider.id);
      if (!id) return [];
      return [
        {
          id,
          name: stringValue(provider.name) ?? id,
          source: stringValue(provider.source),
          modelCount: Object.keys(provider.models ?? {}).length,
        },
      ];
    }),
    default: raw.default ?? {},
  };
}

export const api = {
  health: () => request<{ healthy: boolean }>("GET", "/api/health"),
  projects: (timeoutMs?: number) =>
    request<Project[]>("GET", "/project", undefined, undefined, timeoutMs),
  sessions: (directory: string, timeoutMs?: number) =>
    request<Session[]>("GET", "/session", { directory, roots: "true", limit: 200 }, undefined, timeoutMs),
  searchSessions: (directory: string, search: string) =>
    request<Session[]>("GET", "/session", { directory, search, roots: "true", limit: 50 }),
  messages: (directory: string, sessionID: string, timeoutMs?: number) =>
    request<Message[]>("GET", `/session/${sessionID}/message`, { directory }, undefined, timeoutMs),
  /** 子代理只取最近的活动，避免一次拉回几百条历史消息。 */
  taskMessages: (directory: string, sessionID: string, limit = 40) =>
    request<Message[]>("GET", `/session/${sessionID}/message`, { directory, limit }),
  children: (directory: string, sessionID: string) =>
    request<Session[]>("GET", `/session/${sessionID}/children`, { directory }),
  todos: (directory: string, sessionID: string) =>
    request<TodoItem[]>("GET", `/session/${sessionID}/todo`, { directory }),
  sessionStatus: (directory: string) =>
    request<Record<string, SessionStatus>>("GET", "/session/status", { directory }),
  createSession: (directory: string, title?: string) =>
    request<Session>("POST", "/session", { directory }, title ? { title } : {}),
  prompt: (
    directory: string,
    sessionID: string,
    parts: Array<Record<string, unknown>>,
    options?: { model?: { providerID: string; modelID: string }; agent?: string; variant?: string },
  ) =>
    // 同步 message 接口会一直等到整个 agent loop 结束，长任务必然撞上代理超时；
    // prompt_async 只负责接收消息，进度统一由全局 SSE 推送。
    request<void>("POST", `/session/${sessionID}/prompt_async`, { directory }, {
      parts,
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.agent ? { agent: options.agent } : {}),
      ...(options?.variant ? { variant: options.variant } : {}),
    }),
  abort: (directory: string, sessionID: string) =>
    request<boolean>("POST", `/session/${sessionID}/abort`, { directory }, {}),
  /**
   * 隔离的单轮 Agent 问答：只读取当前会话历史，不写入会话消息，
   * 用于生成提交信息；结果通过全局 SSE 的 btw.* 事件流增量返回。
   */
  btw: (
    directory: string,
    sessionID: string,
    asideID: string,
    text: string,
    model?: string,
  ) =>
    request<{ asideID: string }>(
      "POST",
      `/session/${sessionID}/btw`,
      { directory },
      { asideID, text, ...(model ? { model } : {}) },
      60_000,
    ),
  permissions: (directory: string, timeoutMs?: number) =>
    request<PermissionRequest[]>("GET", "/permission", { directory }, undefined, timeoutMs),
  replyPermission: (directory: string, id: string, reply: "once" | "always" | "reject") =>
    request<boolean>("POST", `/permission/${id}/reply`, { directory }, { reply }),
  diff: (directory: string, sessionID: string, timeoutMs?: number) =>
    request<FileDiff[]>("GET", `/session/${sessionID}/diff`, { directory }, undefined, timeoutMs),
  vcsDiff: (directory: string) =>
    request<FileDiff[]>("GET", "/vcs/diff", { directory, mode: "git" }),
  files: (directory: string, query: string) =>
    request<string[]>("GET", "/find/file", { directory, query, limit: 200 }),
  searchFiles: (directory: string, query: string) =>
    request<string[]>("GET", "/find/file", { directory, query, limit: 20 }),
  listFiles: (directory: string, path: string) =>
    request<FileNode[]>("GET", "/file", { directory, path }),
  models: () => request<{ data: ModelInfo[] }>("GET", "/api/model"),
  agents: (directory: string) => request<AgentInfo[]>("GET", "/agent", { directory }),
  commands: (directory: string) => request<CommandInfo[]>("GET", "/command", { directory }),
  mcp: (directory: string) =>
    request<Record<string, McpServerInfo>>("GET", "/mcp", { directory }),
  exportSession: (directory: string, sessionID: string) =>
    invoke<string>("export_session", { directory, sessionId: sessionID }),
  deviceProbe: () => invoke<DeviceProbe>("device_probe"),
  deviceCapture: (serial?: string | null) =>
    invoke<DeviceShot>("device_capture", { serial: serial ?? null }),
  deviceAwakeStatus: (serial: string) =>
    invoke<DeviceAwakeStatus>("device_awake_status", { serial }),
  deviceSetAwake: (serial: string, enabled: boolean) =>
    invoke<DeviceAwakeStatus>("device_set_awake", { serial, enabled }),
  deviceScreenshotBytes: (path: string) =>
    invoke<ArrayBuffer>("device_screenshot_bytes", { path }),
  deviceCopyScreenshot: (path: string) =>
    invoke<void>("device_copy_screenshot", { path }),
  deviceSaveScreenshot: (path: string, defaultName: string) =>
    invoke<string | null>("device_save_screenshot", { path, defaultName }),
  listFontFamilies: () => invoke<string[]>("list_font_families"),
  getSettings: () => invoke<{ config: AppConfig; runtime: RuntimeInfo }>("get_settings"),
  syncTrayContext: (context: TrayContext) =>
    invoke<void>("sync_tray_context", { context }),
  saveSettings: (config: AppConfig) =>
    invoke<{ ok: boolean; restartRequired: boolean; config: AppConfig }>("save_settings", { config }),
  probeCli: (explicit: string | null) =>
    invoke<{ path: string; version: string | null }>("probe_cli", { explicit }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  restartApp: () => invoke<void>("restart_app"),
  cliConfig: async () =>
    summarizeConfig(await request<RawCliConfig>("GET", "/config")),
  authEntries: () => request<AuthEntry[]>("GET", "/auth"),
  providerOverview,
  refreshProviders: async (directory?: string) => {
    await request("POST", "/provider/refresh", { directory });
    return providerOverview(directory);
  },
  quota: () => request<StatsQuota>("GET", "/stats/quota"),
  usage: (directory: string | undefined, days: number) =>
    request<StatsUsage>("GET", "/stats/usage", { directory, days }),
  cliPaths: (directory?: string) =>
    request<CliPathInfo>("GET", "/path", { directory }),
  shells: (directory?: string) =>
    request<ShellInfo[]>("GET", "/pty/shells", { directory }),
  mcpStatus: (directory: string) =>
    request<Record<string, McpServerInfo>>("GET", "/mcp", { directory }),
  mcpConnect: (directory: string, name: string) =>
    request<boolean>("POST", `/mcp/${encodeURIComponent(name)}/connect`, { directory }),
  mcpDisconnect: (directory: string, name: string) =>
    request<boolean>("POST", `/mcp/${encodeURIComponent(name)}/disconnect`, { directory }),
  skills: async (directory: string) => {
    const raw = await request<RawSkillStatus[]>("GET", "/skill/status", { directory });
    return raw.map(({ name, description, location, scope, enabled }) => ({
      name,
      description,
      location,
      scope,
      enabled,
    }));
  },
  setSkillEnabled: (
    directory: string,
    name: string,
    scope: SkillStatus["scope"],
    enabled: boolean,
  ) =>
    request<SkillStatus>(
      "PATCH",
      `/skill/${encodeURIComponent(name)}`,
      { directory },
      { scope, enabled },
    ),
  renameSession: (directory: string, id: string, title: string) =>
    request<Session>("PATCH", `/session/${id}`, { directory }, { title }),
  archiveSession: (directory: string, id: string, archived: boolean) =>
    request<Session>("PATCH", `/session/${id}`, { directory }, {
      time: { archived: archived ? Date.now() : 0 },
    }),
  deleteSession: (directory: string, id: string) =>
    request<boolean>("DELETE", `/session/${id}`, { directory }),
  fileContent: (directory: string, path: string) =>
    request<{
      type?: "text" | "binary";
      content?: string;
      encoding?: "base64";
      mimeType?: string;
    }>("GET", "/file/content", { directory, path }),
  quickLookThumbnail: (path: string) =>
    invoke<ArrayBuffer>("quick_look_thumbnail", { path }),
  gitState: (directory: string) =>
    invoke<GitRepoState>("git_state", { directory }),
  gitCommit: (directory: string, message: string) =>
    invoke<GitCommandResult>("git_commit", { directory, message }),
  gitPush: (directory: string) =>
    invoke<GitCommandResult>("git_push", { directory }),
  startupDirectory: () => invoke<string | null>("startup_directory"),
  pathExists: (path: string) => invoke<boolean | null>("path_exists", { path }),
  pickWorkspaceFolder: () => invoke<string | null>("pick_workspace_folder"),
  backendState: () => invoke<BackendPhase>("backend_state"),
  retryBackend: () => invoke<void>("retry_backend"),
};
