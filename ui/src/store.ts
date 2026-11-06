import { create } from "zustand";
import { api } from "./api";
import type {
  AgentInfo,
  Attachment,
  CommandInfo,
  FileDiff,
  FileNode,
  Message,
  ModelInfo,
  Part,
  PermissionRequest,
  Project,
  Session,
} from "./types";

type RightTab = "changes" | "files";

const LAST_DIR = "deveco.desktop.dir";
const LAST_SESSION = "deveco.desktop.session";

function upsertSession(list: Session[], session: Session): Session[] {
  const index = list.findIndex((item) => item.id === session.id);
  if (index === -1) return [session, ...list];
  const next = list.slice();
  next[index] = { ...next[index], ...session };
  return next;
}

function upsertMessage(list: Message[], info: Message["info"]): Message[] {
  const index = list.findIndex((m) => m.info.id === info.id);
  if (index === -1) return [...list, { info, parts: [] }];
  const next = list.slice();
  next[index] = { ...next[index], info: { ...next[index].info, ...info } };
  return next;
}

function upsertPart(list: Message[], part: Part): Message[] {
  const messageIndex = list.findIndex((m) => m.info.id === part.messageID);
  if (messageIndex === -1) {
    // 事件先到、消息后到：先建占位，等 message.updated 补齐信息
    return [
      ...list,
      {
        info: { id: part.messageID, sessionID: part.sessionID, role: "assistant" },
        parts: [part],
      },
    ];
  }
  const next = list.slice();
  const message = next[messageIndex];
  const partIndex = message.parts.findIndex((p) => p.id === part.id);
  const parts = message.parts.slice();
  if (partIndex === -1) parts.push(part);
  else parts[partIndex] = { ...parts[partIndex], ...part };
  next[messageIndex] = { ...message, parts };
  return next;
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
  agents: AgentInfo[];
  selectedAgent: string;
  commands: CommandInfo[];
  mcpCount: number;
  selectedVariant: string | null;
  selectedModel: { providerID: string; modelID: string } | null;
  preview: { path: string; content: string; type: string } | null;
  directory: string | null;
  sessionID: string | null;
  messages: Message[];
  permissions: PermissionRequest[];
  streaming: boolean;
  sseOk: boolean;
  sseCount: number;
  rightOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  rightTab: RightTab;
  diff: FileDiff[];
  files: FileNode[];
  filePath: string;
  fileQuery: string;
  filter: string;
  showArchived: boolean;
  failedText: string | null;
  notice: string | null;
  findOpen: boolean;
  findQuery: string;
  findIndex: number;
  sidebarWidth: number;
  clearFailedText(): void;
  showNotice(message: string): void;
  exportCurrentSession(): Promise<void>;
  openFind(): void;
  closeFind(): void;
  setFindQuery(query: string): void;
  stepFind(delta: number): void;
  setSidebarWidth(width: number): void;

  boot(): Promise<void>;
  selectProject(directory: string): Promise<void>;
  openSession(id: string): Promise<void>;
  newSession(): Promise<void>;
  send(text: string, attachments?: Attachment[]): Promise<void>;
  stop(): Promise<void>;
  replyPermission(id: string, reply: "once" | "always" | "reject"): Promise<void>;
  onSse(raw: string): void;
  toggleRight(): void;
  openSettings(): void;
  closeSettings(): void;
  openShortcuts(): void;
  closeShortcuts(): void;
  setRightTab(tab: RightTab): void;
  setFilter(value: string): void;
  runSearch(query: string): Promise<void>;
  openSessionIn(directory: string, id: string): Promise<void>;
  toggleProject(directory: string): Promise<void>;
  loadModels(): Promise<void>;
  loadMeta(): Promise<void>;
  selectAgent(name: string): void;
  selectVariant(variant: string | null): void;
  selectModel(model: { providerID: string; modelID: string }): void;
  renameSession(id: string, title: string): Promise<void>;
  archiveSession(id: string, archived: boolean): Promise<void>;
  toggleArchivedView(): void;
  deleteSession(id: string): Promise<void>;
  refreshDiff(): Promise<void>;
  openPreview(path: string): Promise<void>;
  loadFiles(): Promise<void>;
  enterDir(path: string): Promise<void>;
  goUpDir(): Promise<void>;
  setFileQuery(value: string): Promise<void>;
  closePreview(): void;
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
  agents: [],
  selectedAgent: "build",
  commands: [],
  mcpCount: 0,
  selectedVariant: null,
  selectedModel: null,
  preview: null,
  directory: null,
  sessionID: null,
  messages: [],
  permissions: [],
  streaming: false,
  sseOk: false,
  sseCount: 0,
  rightOpen: false,
  settingsOpen: false,
  shortcutsOpen: false,
  rightTab: "changes",
  diff: [],
  files: [],
  filePath: "",
  fileQuery: "",
  filter: "",
  showArchived: localStorage.getItem("deveco.desktop.showArchived") === "1",
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

  async boot() {
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
    try {
      const all = await api.projects();
      // 工作区注册表里会残留已删除/临时目录，先过滤掉不存在的路径
      const existence = await Promise.all(
        all.map((project) => api.pathExists(project.worktree).catch(() => true)),
      );
      // CLI 的 /project 可能对同一路径返回多条不同 id 的记录，按 worktree 去重
      const seen = new Set<string>();
      const projects = all.filter((project, index) => {
        if (!existence[index]) return false;
        const key = project.worktree.replace(/\/$/, "");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // 最近使用的项目排前面
      projects.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
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
        booting: false,
        bootMessage: "",
        projects,
        expanded: directory ? { [directory]: true } : {},
      });
      if (directory) {
        await get().selectProject(directory);
      }
    } catch (error) {
      set({ booting: false, error: `读取项目列表失败：${String(error)}` });
    }
  },

  async selectProject(directory) {
    localStorage.setItem(LAST_DIR, directory);
    set({
      directory,
      expanded: { ...get().expanded, [directory]: true },
      sessionID: null,
      messages: [],
      permissions: [],
      diff: [],
      files: [],
  filePath: "",
  fileQuery: "",
    });
    try {
      const sessions = await api.sessions(directory);
      sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      set({
        sessions: { ...get().sessions, [directory]: sessions },
        loadedDirs: { ...get().loadedDirs, [directory]: true },
      });
      const permissions = await api.permissions(directory).catch(() => []);
      set({ permissions });
      void get().loadMeta();
      // 和 DSH 一致：切换工作区时直接打开最近（或上次）的会话，而不是停在空白页
      const last = localStorage.getItem(`${LAST_SESSION}.${directory}`);
      const target = sessions.find((item) => item.id === last) ?? sessions[0];
      if (target) await get().openSession(target.id);
    } catch (error) {
      set({ error: `读取会话失败：${String(error)}` });
    }
  },

  async openSessionIn(directory, id) {
    if (get().directory !== directory) {
      await get().selectProject(directory);
    }
    await get().openSession(id);
  },

  async openSession(id) {
    const directory = get().directory;
    if (!directory) return;
    localStorage.setItem(`${LAST_SESSION}.${directory}`, id);
    set({ sessionID: id, messages: [], streaming: false });
    try {
      const [messages, diff] = await Promise.all([
        api.messages(directory, id),
        get().rightTab === "changes" ? api.diff(directory, id).catch(() => []) : Promise.resolve([]),
      ]);
      // 打开会话期间可能已经有事件到达，合并而不是覆盖
      const existing = get().messages;
      const merged = messages.slice();
      for (const message of existing) {
        if (!merged.some((m) => m.info.id === message.info.id)) merged.push(message);
      }
      set({ messages: merged, diff });
    } catch (error) {
      set({ error: `读取消息失败：${String(error)}` });
    }
  },

  async newSession() {
    const directory = get().directory;
    if (!directory) return;
    try {
      const session = await api.createSession(directory);
      const list = get().sessions[directory] ?? [];
      set({
        sessions: { ...get().sessions, [directory]: upsertSession(list, session) },
      });
      await get().openSession(session.id);
    } catch (error) {
      set({ error: `新建会话失败：${String(error)}` });
    }
  },

  async send(text, attachments) {
    const directory = get().directory;
    const files = attachments ?? [];
    if (!directory || (!text.trim() && files.length === 0)) return;
    let sessionID = get().sessionID;
    try {
      if (!sessionID) {
        const session = await api.createSession(directory);
        sessionID = session.id;
        const list = get().sessions[directory] ?? [];
        set({
          sessions: { ...get().sessions, [directory]: upsertSession(list, session) },
          sessionID,
        });
      }
      set({ streaming: true, error: null });
      const { selectedModel: model, selectedAgent, selectedVariant } = get();
      const parts: Array<Record<string, unknown>> = [];
      if (text.trim()) parts.push({ type: "text", text });
      for (const file of files) {
        parts.push({ type: "file", mime: file.mime, url: file.url, filename: file.name });
      }
      const message = await api.prompt(directory, sessionID, parts, {
        ...(model ? { model } : {}),
        agent: selectedAgent,
        ...(selectedVariant ? { variant: selectedVariant } : {}),
      });
      set({ messages: upsertMessage(get().messages, message.info) });
      for (const part of message.parts) {
        set({ messages: upsertPart(get().messages, part) });
      }
    } catch (error) {
      // 失败的原文还回输入框，用户不用重新打一遍
      set({ streaming: false, error: `发送失败：${String(error)}`, failedText: text });
    }
  },

  async stop() {
    const { directory, sessionID } = get();
    if (!directory || !sessionID) return;
    await api.abort(directory, sessionID).catch(() => undefined);
    set({ streaming: false });
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

    switch (type) {
      case "server.connected":
        set({ sseOk: true });
        break;
      case "message.updated":
        if (props.sessionID === get().sessionID && props.info) {
          // 助手消息在跑 → 正在执行；不管这条任务是从哪触发的（界面/经典界面/CLI）
          const streaming = props.info.role === "assistant" ? true : get().streaming;
          set({ messages: upsertMessage(get().messages, props.info), streaming });
        }
        break;
      case "message.part.updated":
        if (props.sessionID === get().sessionID && props.part) {
          set({ messages: upsertPart(get().messages, props.part as Part) });
        }
        break;
      case "message.part.delta": {
        if (props.sessionID !== get().sessionID) break;
        const messages = get().messages;
        const message = messages.find((m) => m.info.id === props.messageID);
        const part = message?.parts.find((p) => p.id === props.partID);
        if (!part) break;
        const field = (props.field as string) ?? "text";
        set({
          messages: upsertPart(messages, {
            ...part,
            [field]: `${(part[field] as string) ?? ""}${props.delta ?? ""}`,
          }),
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
        set({
          sessions: { ...get().sessions, [directory]: upsertSession(list, info) },
          loadedDirs: { ...get().loadedDirs, [directory]: true },
        });
        break;
      }
      case "session.idle":
        if (props.sessionID === get().sessionID) {
          set({ streaming: false });
          // 执行结束后变更列表才有意义，顺手刷新右面板
          const { directory, rightOpen, rightTab } = get();
          if (rightOpen && rightTab === "changes" && directory) {
            void loadDiff(directory, props.sessionID).then((diff) => set({ diff }));
          }
        }
        break;
      case "session.error": {
        const message = props.error?.data?.message ?? props.error?.name ?? "未知错误";
        set({ streaming: false, error: `会话错误：${message}` });
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
      case "session.next.step.started":
        if (props.sessionID === get().sessionID) set({ streaming: true });
        break;
      case "permission.replied":
      case "permission.v2.replied":
        set({ permissions: get().permissions.filter((p) => p.id !== props.requestID) });
        break;
      default:
        break;
    }
  },

  openSettings() {
    set({ settingsOpen: true });
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

  showNotice(message) {
    set({ notice: message });
    setTimeout(() => set({ notice: null }), 4000);
  },

  async exportCurrentSession() {
    const { directory, sessionID } = get();
    if (!directory || !sessionID) {
      set({ error: "请先打开一个会话再导出" });
      return;
    }
    try {
      const path = await api.exportSession(directory, sessionID);
      get().showNotice(`已导出：${path}`);
    } catch (error) {
      set({ error: `导出失败：${String(error)}` });
    }
  },

  openFind() {
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

  toggleRight() {
    const open = !get().rightOpen;
    set({ rightOpen: open });
    if (open) void refreshPanel(get, set);
  },

  setRightTab(tab) {
    set({ rightTab: tab });
    void refreshPanel(get, set);
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
    set({ expanded: { ...expanded, [directory]: open } });
    if (open && !get().loadedDirs[directory]) {
      try {
        const sessions = await api.sessions(directory);
        sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
        set({
          sessions: { ...get().sessions, [directory]: sessions },
          loadedDirs: { ...get().loadedDirs, [directory]: true },
        });
      } catch (error) {
        set({ error: `读取会话失败：${String(error)}` });
      }
    }
  },

  async loadModels() {
    if (get().models.length > 0) return;
    try {
      const result = await api.models();
      set({ models: result.data ?? [] });
    } catch {
      // 模型列表拿不到不影响聊天，静默失败
    }
  },

  selectModel(model) {
    // 换模型时清掉上一模型的 variant，避免把 max 带到不支持的模型上
    set({ selectedModel: model, selectedVariant: null });
  },

  selectAgent(name) {
    set({ selectedAgent: name });
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

  async renameSession(id, title) {
    const directory = get().directory;
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

  async archiveSession(id, archived) {
    const directory = get().directory;
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

  async deleteSession(id) {
    const directory = get().directory;
    if (!directory) return;
    try {
      await api.deleteSession(directory, id);
      const list = get().sessions[directory] ?? [];
      set({
        sessions: { ...get().sessions, [directory]: list.filter((item) => item.id !== id) },
      });
      if (get().sessionID === id) {
        set({ sessionID: null, messages: [], permissions: [], streaming: false });
        localStorage.removeItem(`${LAST_SESSION}.${directory}`);
      }
    } catch (error) {
      set({ error: `删除会话失败：${String(error)}` });
    }
  },

  async openPreview(path) {
    const directory = get().directory;
    if (!directory) return;
    try {
      const file = await api.fileContent(directory, path);
      set({
        preview: {
          path,
          content: file.content ?? "",
          type: file.type ?? "unknown",
        },
      });
    } catch (error) {
      set({ preview: { path, content: `读取失败：${String(error)}`, type: "error" } });
    }
  },

  closePreview() {
    set({ preview: null });
  },

  async refreshDiff() {
    const { directory, sessionID } = get();
    if (!directory) return;
    set({ diff: await loadDiff(directory, sessionID) });
  },

  async loadFiles() {
    const { directory, filePath, fileQuery } = get();
    if (!directory) return;
    try {
      if (fileQuery.trim()) {
        const hits = await api.files(directory, fileQuery.trim());
        set({
          files: hits.map((path) => ({
            name: path.split("/").filter(Boolean).pop() ?? path,
            path,
            type: path.endsWith("/") ? "directory" : "file",
          })),
        });
        return;
      }
      const absolute = filePath ? `${directory}/${filePath}` : directory;
      const entries = await api.listFiles(directory, absolute);
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      set({ files: entries });
    } catch (error) {
      set({ error: `读取文件失败：${String(error)}` });
    }
  },

  async enterDir(path) {
    set({ filePath: path.replace(/\/$/, ""), fileQuery: "", preview: null });
    await get().loadFiles();
  },

  async goUpDir() {
    const parts = get().filePath.split("/").filter(Boolean);
    parts.pop();
    set({ filePath: parts.join("/"), fileQuery: "", preview: null });
    await get().loadFiles();
  },

  async setFileQuery(value) {
    set({ fileQuery: value });
    await get().loadFiles();
  },

  dismissError() {
    set({ error: null });
  },
}));

async function refreshPanel(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
) {
  const { directory, sessionID, rightTab } = get();
  if (!directory) return;
  if (rightTab === "changes") {
    const diff = await loadDiff(directory, sessionID);
    set({ diff });
  }
  if (rightTab === "files") {
    await get().loadFiles();
  }
}


/** 会话快照 diff 为空时，回退到 git 工作区 diff（非 git 项目自然为空） */
async function loadDiff(directory: string, sessionID: string | null): Promise<FileDiff[]> {
  if (sessionID) {
    const snapshot = await api.diff(directory, sessionID).catch(() => []);
    if (snapshot.length > 0) return snapshot;
  }
  return api.vcsDiff(directory).catch(() => []);
}
