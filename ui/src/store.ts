import { create } from "zustand";
import { api } from "./api";
import {
  classifyPreview,
  mimeForPath,
  quickLookFirst,
  type FilePreview,
} from "./filePreview";
import { absoluteWorkspacePath } from "./paths";
import type {
  AgentInfo,
  Attachment,
  BackendPhase,
  CommandInfo,
  FileDiff,
  FileNode,
  MentionRef,
  Message,
  ModelInfo,
  Part,
  PermissionRequest,
  Project,
  Session,
  SessionStatus,
  TodoItem,
} from "./types";
import { buildSubagentTasks, normalizeTodos } from "./tasks";

type RightTab = "changes" | "files" | "tasks";

const LAST_DIR = "deveco.desktop.dir";
const LAST_SESSION = "deveco.desktop.session";
const LOCAL_WORKSPACES = "deveco.desktop.workspaces";
/** 启动阶段读取工作区可能被 macOS 文件夹授权弹窗阻塞，给用户留足处理时间。 */
const BOOT_LOAD_TIMEOUT_MS = 5 * 60 * 1000;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let previewRequest = 0;
let permissionWatchTimer: ReturnType<typeof setTimeout> | null = null;
let permissionWatchToken = 0;
let tasksRequest = 0;

function normalizeWorkspace(path: string) {
  const trimmed = path.trim();
  return trimmed === "/" ? trimmed : trimmed.replace(/\/+$/, "");
}

function readLocalWorkspaces(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_WORKSPACES) ?? "[]");
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

function rememberLocalWorkspace(path: string) {
  const normalized = normalizeWorkspace(path);
  if (!normalized) return;
  const next = [
    normalized,
    ...readLocalWorkspaces().filter((item) => item !== normalized),
  ];
  localStorage.setItem(LOCAL_WORKSPACES, JSON.stringify(next));
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

/** 用事件流里的增量覆盖快照，同一条消息按 part id 合并，避免刷新时丢掉刚到的活动。 */
function mergeMessages(base: Message[], overlay: Message[]): Message[] {
  const merged = base.slice();
  for (const message of overlay) {
    const index = merged.findIndex((item) => item.info.id === message.info.id);
    if (index === -1) {
      merged.push(message);
      continue;
    }
    const current = merged[index];
    const parts = current.parts.slice();
    for (const part of message.parts) {
      const partIndex = parts.findIndex((item) => item.id === part.id);
      if (partIndex === -1) parts.push(part);
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
    messages: [],
    todos: [],
    sessionChildren: [],
    childMessages: {},
    childTodos: {},
    sessionStatuses: {},
    selectedTaskID: null,
    tasksLoading: false,
    streaming: false,
    diff: [],
    failedText: null,
    findOpen: false,
    findQuery: "",
    findIndex: 0,
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
  agents: AgentInfo[];
  selectedAgent: string;
  commands: CommandInfo[];
  mcpCount: number;
  selectedVariant: string | null;
  selectedModel: { providerID: string; modelID: string } | null;
  preview: FilePreview | null;
  directory: string | null;
  sessionID: string | null;
  messages: Message[];
  permissions: PermissionRequest[];
  todos: TodoItem[];
  sessionChildren: Session[];
  childMessages: Record<string, Message[]>;
  childTodos: Record<string, TodoItem[]>;
  sessionStatuses: Record<string, SessionStatus>;
  selectedTaskID: string | null;
  tasksLoading: boolean;
  streaming: boolean;
  sseOk: boolean;
  sseCount: number;
  /** 后端（本机 deveco serve）状态：自愈过程对用户可见 */
  backend: BackendPhase;
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
  showNotice(message: string, duration?: number): void;
  exportCurrentSession(): Promise<void>;
  exportSession(directory: string, id: string): Promise<void>;
  openFind(): void;
  closeFind(): void;
  setFindQuery(query: string): void;
  stepFind(delta: number): void;
  setSidebarWidth(width: number): void;

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
  pickWorkspaceFolder(): Promise<void>;
  /** refs 是 Composer 里 @ 引用的工作区文件；不传时行为与之前完全一致 */
  send(text: string, attachments?: Attachment[], refs?: MentionRef[]): Promise<void>;
  stop(): Promise<void>;
  replyPermission(id: string, reply: "once" | "always" | "reject"): Promise<void>;
  onSse(raw: string): void;
  onBackend(phase: BackendPhase): void;
  retryBackend(): Promise<void>;
  refreshAfterReconnect(): Promise<void>;
  toggleRight(): void;
  openSettings(): void;
  closeSettings(): void;
  openShortcuts(): void;
  closeShortcuts(): void;
  setRightTab(tab: RightTab): void;
  /** taskID 为空时打开任务列表；传入后直接打开该子代理详情。 */
  openTasks(taskID?: string | null): void;
  closeTaskDetail(): void;
  refreshTasks(): Promise<void>;
  setFilter(value: string): void;
  runSearch(query: string): Promise<void>;
  openSessionIn(directory: string, id: string): Promise<void>;
  toggleProject(directory: string): Promise<void>;
  loadModels(): Promise<void>;
  loadMeta(): Promise<void>;
  selectAgent(name: string): void;
  selectVariant(variant: string | null): void;
  selectModel(model: { providerID: string; modelID: string }): void;
  renameSession(directory: string, id: string, title: string): Promise<void>;
  archiveSession(directory: string, id: string, archived: boolean): Promise<void>;
  toggleArchivedView(): void;
  deleteSession(directory: string, id: string): Promise<void>;
  refreshDiff(): Promise<void>;
  openPreview(path: string): Promise<void>;
  loadFiles(): Promise<void>;
  enterDir(path: string): Promise<void>;
  goUpDir(): Promise<void>;
  setFileQuery(value: string): Promise<void>;
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
  todos: [],
  sessionChildren: [],
  childMessages: {},
  childTodos: {},
  sessionStatuses: {},
  selectedTaskID: null,
  tasksLoading: false,
  streaming: false,
  sseOk: false,
  sseCount: 0,
  backend: { state: "starting", attempt: 0, detail: null },
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
        // CLI 的 /project 可能对同一路径返回多条不同 id 的记录，按 worktree 去重
        const seen = new Set<string>();
        const projects = all.filter((project, index) => {
          if (existence[index] === false) return false;
          const key = project.worktree.replace(/\/$/, "");
          if (seen.has(key)) return false;
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
          if (localExistence[index] === false || known.has(path)) continue;
          known.add(path);
          projects.push({ id: path, worktree: path });
        }
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
        set({ booting: false, bootMessage: "" });
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
    // 侧栏是「一次只展开一个工作区」的手风琴：切过去时收起其它工作区
    if (!retry) stopPermissionWatch();
    if (retry && get().directory === directory) {
      set({ expanded: { [directory]: true } });
    } else {
      previewRequest += 1;
      set({
        directory,
        expanded: { [directory]: true },
        sessionID: null,
        messages: [],
        permissions: [],
        todos: [],
        sessionChildren: [],
        childMessages: {},
        childTodos: {},
        sessionStatuses: {},
        selectedTaskID: null,
        tasksLoading: false,
        diff: [],
        files: [],
        filePath: "",
        fileQuery: "",
        error: null,
      });
    }
    try {
      const sessions = await api.sessions(directory, timeout);
      sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      set({
        sessions: { ...get().sessions, [directory]: sessions },
        loadedDirs: { ...get().loadedDirs, [directory]: true },
        error: null,
      });
      stopPermissionWatch();
      const permissions = await api.permissions(directory, timeout).catch(() => []);
      set({ permissions });
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
      await get().selectProject(directory);
    }
    await get().openSession(id);
  },

  async openSession(id, options) {
    const patient = options?.patient ?? false;
    const retry = options?.retry ?? false;
    const timeout = patient ? BOOT_LOAD_TIMEOUT_MS : undefined;
    const directory = get().directory;
    if (!directory) return;
    localStorage.setItem(`${LAST_SESSION}.${directory}`, id);
    if (!retry) stopPermissionWatch();
    if (retry && get().sessionID === id) {
      set({ streaming: false });
    } else {
      set({
        sessionID: id,
        messages: [],
        todos: [],
        sessionChildren: [],
        childMessages: {},
        childTodos: {},
        sessionStatuses: {},
        selectedTaskID: null,
        tasksLoading: true,
        streaming: false,
        ...(retry ? {} : { error: null }),
      });
    }
    try {
      const [messages, diff] = await Promise.all([
        api.messages(directory, id, timeout),
        get().rightTab === "changes"
          ? api.diff(directory, id, timeout).catch(() => [])
          : Promise.resolve([]),
      ]);
      // 打开会话期间可能已经有事件到达，合并而不是覆盖
      const merged = mergeMessages(messages, get().messages);
      stopPermissionWatch();
      set({ messages: merged, diff, error: null });
      void get().refreshTasks();
    } catch (error) {
      set({ tasksLoading: false });
      set({ error: workspaceLoadError(error, patient) });
      if (isRetryableWorkspaceError(error, patient || retry)) watchPermission(directory);
    }
  },

  async newSession() {
    const directory = get().directory;
    set({
      ...emptyConversationPatch(),
      error: null,
      ...(directory ? { expanded: { [directory]: true } } : {}),
    });
  },

  async newSessionIn(directory) {
    if (!directory) return;
    const target = normalizeWorkspace(directory);
    if (get().directory !== target) {
      await get().selectProject(target, { openRecent: false });
    }
    set({
      ...emptyConversationPatch(),
      expanded: { [target]: true },
      error: null,
    });
  },

  async changeDraftWorkspace(directory) {
    const target = normalizeWorkspace(directory);
    if (!target) return;
    if (get().sessionID || get().messages.length > 0) {
      set({ error: "会话已经包含内容，不能再切换工作区" });
      return;
    }
    if (get().directory === target) {
      set({ expanded: { [target]: true } });
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
      const projects = get().projects;
      if (!projects.some((project) => normalizeWorkspace(project.worktree) === target)) {
        set({
          projects: [{ id: target, worktree: target }, ...projects],
          error: null,
        });
        rememberLocalWorkspace(target);
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

  async send(text, attachments, refs) {
    const directory = get().directory;
    const files = attachments ?? [];
    const mentions = refs ?? [];
    if (!directory || (!text.trim() && files.length === 0 && mentions.length === 0)) return;
    let sessionID = get().sessionID;
    try {
      if (!sessionID) {
        const session = await api.createSession(directory);
        sessionID = session.id;
        const list = get().sessions[directory] ?? [];
        set({
          sessions: { ...get().sessions, [directory]: upsertSession(list, session) },
          sessionID,
          expanded: { [directory]: true },
          todos: [],
          sessionChildren: [],
          childMessages: {},
          childTodos: {},
          sessionStatuses: {},
          selectedTaskID: null,
        });
        void get().refreshTasks();
      }
      set({ streaming: true, error: null });
      const { selectedModel: model, selectedAgent, selectedVariant } = get();
      const parts: Array<Record<string, unknown>> = [];
      if (text.trim()) parts.push({ type: "text", text });
      // @ 引用：文本里已经保留 @path，这里再补 file part（file:// 绝对路径），
      // 由 serve 自己读盘并合成 Read 调用，模型才能看到文件内容
      for (const ref of mentions) parts.push(buildMentionPart(directory, ref));
      for (const file of files) {
        parts.push({ type: "file", mime: file.mime, url: file.url, filename: file.name });
      }
      await api.prompt(directory, sessionID, parts, {
        ...(model ? { model } : {}),
        agent: selectedAgent,
        ...(selectedVariant ? { variant: selectedVariant } : {}),
      });
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
        api.sessionStatus(directory).catch(() => ({}) as Record<string, SessionStatus>),
      ]);
      const tasks = buildSubagentTasks(get().messages, target, children, statuses);
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
          return { childID, messages, todos: normalizeTodos(childTodos) };
        }),
      );
      // 请求期间可能已经切到别的会话，迟到结果不能污染当前界面
      if (request !== tasksRequest || get().sessionID !== target) return;
      const childMessages: Record<string, Message[]> = {};
      const childTodos: Record<string, TodoItem[]> = {};
      for (const entry of taskData) {
        childMessages[entry.childID] = mergeMessages(
          entry.messages,
          get().childMessages[entry.childID] ?? [],
        );
        childTodos[entry.childID] = entry.todos;
      }
      set({
        todos: normalizeTodos(todos),
        sessionChildren: children,
        childMessages,
        childTodos,
        sessionStatuses: statuses,
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
      const sessions = await api.sessions(directory);
      sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      set({ sessions: { ...get().sessions, [directory]: sessions } });
      if (sessionID) {
        const [messages, permissions] = await Promise.all([
          api.messages(directory, sessionID),
          api.permissions(directory).catch(() => []),
        ]);
        set({ messages, permissions });
        void get().refreshDiff();
        void get().refreshTasks();
      }
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

    switch (type) {
      case "server.connected":
        set({ sseOk: true });
        break;
      case "message.updated":
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
      case "message.part.updated":
        if (eventSession === currentSession && props.part) {
          set({ messages: upsertPart(get().messages, props.part as Part) });
        } else if (isChildSession(eventSession) && props.part) {
          set({
            childMessages: {
              ...get().childMessages,
              [eventSession]: upsertPart(
                get().childMessages[eventSession] ?? [],
                props.part as Part,
              ),
            },
          });
        }
        break;
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
        set({
          sessions: { ...get().sessions, [directory]: upsertSession(list, info) },
          loadedDirs: { ...get().loadedDirs, [directory]: true },
          ...(info.parentID && info.parentID === currentSession
            ? { sessionChildren: upsertSession(get().sessionChildren, info) }
            : {}),
        });
        if (childAdded) void get().refreshTasks();
        break;
      }
      case "session.status": {
        if (!eventSession) break;
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
      case "session.idle":
        if (eventSession === currentSession) {
          set({ streaming: false });
          // 执行结束后变更列表才有意义，顺手刷新右面板
          const { directory, rightOpen, rightTab } = get();
          if (rightOpen && rightTab === "changes" && directory) {
            void loadDiff(directory, eventSession).then((diff) => set({ diff }));
          }
          void get().refreshTasks();
        } else if (isChildSession(eventSession)) {
          set({
            sessionStatuses: {
              ...get().sessionStatuses,
              [eventSession]: { type: "idle" },
            },
          });
        }
        break;
      case "session.error": {
        if (eventSession === currentSession) {
          const message = props.error?.data?.message ?? props.error?.name ?? "未知错误";
          set({ streaming: false, error: `会话错误：${message}` });
        } else if (isChildSession(eventSession)) {
          set({
            sessionStatuses: {
              ...get().sessionStatuses,
              [eventSession]: { type: "idle" },
            },
          });
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

  showNotice(message, duration = 4000) {
    if (noticeTimer) clearTimeout(noticeTimer);
    set({ notice: message });
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      set({ notice: null });
    }, duration);
  },

  async exportCurrentSession() {
    const { directory, sessionID } = get();
    if (!directory || !sessionID) {
      set({ error: "请先打开一个会话再导出" });
      return;
    }
    await get().exportSession(directory, sessionID);
  },

  async exportSession(directory, id) {
    if (!directory || !id) {
      set({ error: "请先打开一个会话再导出" });
      return;
    }
    try {
      const path = await api.exportSession(directory, id);
      get().showNotice(`已导出：${path}`, 6000);
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
    set({
      rightTab: tab,
      ...(tab === "tasks" ? {} : { selectedTaskID: null }),
    });
    void refreshPanel(get, set);
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
    // 打开时收起其它工作区，保持「一次只展开一个」
    set({ expanded: open ? { [directory]: true } : {} });
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

  async deleteSession(directory, id) {
    if (!directory) return;
    try {
      await api.deleteSession(directory, id);
      const list = get().sessions[directory] ?? [];
      set({
        sessions: { ...get().sessions, [directory]: list.filter((item) => item.id !== id) },
      });
      if (get().directory === directory && get().sessionID === id) {
        set({
          sessionID: null,
          messages: [],
          permissions: [],
          todos: [],
          sessionChildren: [],
          childMessages: {},
          childTodos: {},
          sessionStatuses: {},
          selectedTaskID: null,
          tasksLoading: false,
          streaming: false,
        });
        localStorage.removeItem(`${LAST_SESSION}.${directory}`);
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
    set({ rightOpen: true, rightTab: "files", preview: null });
    await get().openPreview(relative);
  },

  closePreview() {
    previewRequest += 1;
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
    previewRequest += 1;
    set({ filePath: path.replace(/\/$/, ""), fileQuery: "", preview: null });
    await get().loadFiles();
  },

  async goUpDir() {
    previewRequest += 1;
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

async function loadQuickLook(path: string): Promise<Blob> {
  const png = await api.quickLookThumbnail(path);
  return new Blob([png], { type: "image/png" });
}

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
  if (rightTab === "tasks") {
    await get().refreshTasks();
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
