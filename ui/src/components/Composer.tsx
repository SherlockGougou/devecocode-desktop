import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import type { Attachment, MentionRef } from "../types";
import { api } from "../api";
import { revertedCount, useApp } from "../store";
import { MAX_REFS, parseMentions } from "../mentions";
import { emitAppEvent, onAppEvent } from "../appEvents";
import { copyItem, revealItem, useContextMenu } from "../contextMenu";
import { absoluteWorkspacePath, relativeWorkspacePath } from "../paths";
import { highestModelVariant, modelKey } from "../models";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  blobToAttachment,
  clipboardImageToAttachment,
  pastedImageName,
} from "../attachments";
import {
  previewQueuedMessage,
  type PendingSteer,
  type QueuedMessage,
} from "../delivery";
import {
  PERMISSION_MODE_LABELS,
  canControlPermission,
  displayedPermissionMode,
  hasCustomSessionPermission,
} from "../sessionPermission";
import {
  readComposerDraft,
  writeComposerDraft,
  type ComposerDraftScope,
} from "../composerDrafts";
import { insertVoiceTranscript, type VoiceSelection } from "../voice";
import { Icon } from "./Icon";
import VoiceBar from "./VoiceBar";
import { useVoiceInput } from "./useVoiceInput";

/** 弹层最多展示多少条候选 */
const MAX_MENTION_ITEMS = 8;
const EMPTY_QUEUE: QueuedMessage[] = [];
const EMPTY_STEERS: PendingSteer[] = [];

/** 正在填写的 @ 引用：start/end 是它在文本里的范围（end 通常就是光标处） */
type MentionDraft = { query: string; start: number; end: number };
type MentionStatus = "idle" | "loading" | "ready" | "error";

/**
 * 从光标往前找「行首或空白之后的 @」，判断用户是不是正在填写引用。
 * 「前一个字符必须是行首或空白」用来排除邮箱（a@b）之类误触发；
 * 引号形式允许路径中间有空格，直到补上右侧引号为止。
 */
function detectMention(value: string, caret: number): MentionDraft | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const prev = at === 0 ? "" : before[at - 1];
  if (prev && !/\s/.test(prev)) return null;
  const rest = before.slice(at + 1);
  if (rest.startsWith('"')) {
    const inner = rest.slice(1);
    if (inner.includes('"')) return null;
    return { query: inner, start: at, end: caret };
  }
  // 没有引号时遇到空白或另一个 @，说明这条引用已经输入完毕
  if (/[\s@]/.test(rest)) return null;
  return { query: rest, start: at, end: caret };
}

/**
 * 取 @ 弹层的候选文件。
 * `/find/file` 的 query 必须存在，但值可以是空串——空串返回工作区文件列表，
 * 所以刚敲下 @ 时也能直接列出候选（Rust 代理已保留空值参数）。
 */
function loadMentionFiles(directory: string, query: string): Promise<string[]> {
  return api.searchFiles(directory, query);
}

function workspaceName(path: string | null) {
  if (!path) return "选择工作区";
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function normalizePickerPath(path: string) {
  return path === "/" ? path : path.replace(/\/+$/, "");
}

export default function Composer() {
  const stop = useApp((s) => s.stop);
  const streaming = useApp((s) => s.streaming);
  const busySessions = useApp((s) => s.busySessions);
  const stoppingSessions = useApp((s) => s.stoppingSessions);
  const directory = useApp((s) => s.directory);
  const sessionID = useApp((s) => s.sessionID);
  const sessions = useApp((s) => s.sessions);
  const creatingSession = useApp((s) => s.creatingSession);
  const sessionLoading = useApp((s) => s.sessionLoading);
  const draftPermissionMode = useApp((s) => s.draftPermissionMode);
  const permissionUpdating = useApp((s) => s.permissionUpdating);
  const setPermissionMode = useApp((s) => s.setPermissionMode);
  const resetPermissionMode = useApp((s) => s.resetPermissionMode);
  const queuedMessages = useApp((s) =>
    s.sessionID ? s.queuedMessages[s.sessionID] : undefined,
  );
  const queuePaused = useApp((s) =>
    s.sessionID ? s.queuePaused[s.sessionID] === true : false,
  );
  const queueSending = useApp((s) =>
    s.sessionID ? s.queueSending[s.sessionID] === true : false,
  );
  const pendingSteers = useApp((s) =>
    s.sessionID ? s.pendingSteers[s.sessionID] : undefined,
  );
  const submitMessage = useApp((s) => s.submitMessage);
  const steerQueuedMessage = useApp((s) => s.steerQueuedMessage);
  const removeQueuedMessage = useApp((s) => s.removeQueuedMessage);
  const restoreQueuedMessage = useApp((s) => s.restoreQueuedMessage);
  const retryQueuedMessage = useApp((s) => s.retryQueuedMessage);
  const resumeDelivery = useApp((s) => s.resumeDelivery);
  const retryPendingSteer = useApp((s) => s.retryPendingSteer);
  const dismissPendingSteer = useApp((s) => s.dismissPendingSteer);
  const projects = useApp((s) => s.projects);
  const changeDraftWorkspace = useApp((s) => s.changeDraftWorkspace);
  const pickWorkspaceFolder = useApp((s) => s.pickWorkspaceFolder);
  const models = useApp((s) => s.models);
  const hiddenModels = useApp((s) => s.hiddenModels);
  const agents = useApp((s) => s.agents);
  const selectedAgent = useApp((s) => s.selectedAgent);
  const selectAgent = useApp((s) => s.selectAgent);
  const commands = useApp((s) => s.commands);
  const selectedVariant = useApp((s) => s.selectedVariant);
  const selectVariant = useApp((s) => s.selectVariant);
  const selectedModel = useApp((s) => s.selectedModel);
  const loadModels = useApp((s) => s.loadModels);
  const selectModel = useApp((s) => s.selectModel);
  const showNotice = useApp((s) => s.showNotice);
  const editing = useApp((s) => s.editing);
  const cancelEditMessage = useApp((s) => s.cancelEditMessage);
  const messages = useApp((s) => s.messages);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const shortcutsOpen = useApp((s) => s.shortcutsOpen);
  const openSettings = useApp((s) => s.openSettings);
  const [text, setText] = useState("");
  /** @ 引用：始终与 text 同步，见 applyText 的注释 */
  const [refs, setRefs] = useState<MentionRef[]>([]);
  const [mention, setMention] = useState<MentionDraft | null>(null);
  const [mentionResults, setMentionResults] = useState<string[]>([]);
  const [mentionStatus, setMentionStatus] = useState<MentionStatus>("idle");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [agentOpen, setAgentOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [variantOpen, setVariantOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [workspacePicking, setWorkspacePicking] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [revertConfirm, setRevertConfirm] = useState(false);
  const textRef = useRef("");
  const draftScopeRef = useRef<ComposerDraftScope | null>(null);
  const draftSaveErrorRef = useRef(false);
  const revertDeliveryRef = useRef<"queue" | "steer">("queue");
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const failedText = useApp((s) => s.failedText);
  const clearFailedText = useApp((s) => s.clearFailedText);
  /** 上次发送的引用：失败恢复原文时用它把 chip 一起还回来 */
  const lastSentRefs = useRef<MentionRef[]>([]);
  /** 上次发送的附件：失败恢复原文时一并还原 */
  const lastSentAttachments = useRef<Attachment[]>([]);
  const [keyword, setKeyword] = useState("");
  const composerRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const variantPickerRef = useRef<HTMLDivElement>(null);
  const workspacePickerRef = useRef<HTMLDivElement>(null);
  const permissionPickerRef = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();

  const hiddenModelKeys = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const visibleModels = useMemo(
    () =>
      models.filter((model) => !hiddenModelKeys.has(modelKey(model.providerID, model.id))),
    [hiddenModelKeys, models],
  );
  const queue = queuedMessages ?? EMPTY_QUEUE;
  const pending = pendingSteers ?? EMPTY_STEERS;
  const stopping = Boolean(sessionID && stoppingSessions[sessionID]);
  const busy = Boolean(
    sessionID && (streaming || busySessions[sessionID] || stopping),
  );
  const pendingFailed = pending.some((item) => item.status === "failed");
  const pendingPaused = pending.some((item) => item.status === "paused");
  const editingActive = Boolean(editing && editing.sessionID === sessionID);
  const activeSession = useMemo(
    () =>
      directory && sessionID
        ? (sessions[directory] ?? []).find((item) => item.id === sessionID)
        : undefined,
    [directory, sessionID, sessions],
  );
  const selectedAgentInfo = useMemo(
    () => agents.find((agent) => agent.name === selectedAgent),
    [agents, selectedAgent],
  );
  const permissionMode = displayedPermissionMode(
    sessionID ? activeSession : undefined,
    selectedAgentInfo,
    sessionID ? null : draftPermissionMode,
  );
  const permissionAvailable = canControlPermission(selectedAgentInfo);
  const permissionCustom = Boolean(
    sessionID && activeSession && hasCustomSessionPermission(activeSession),
  );
  const permissionLabel = permissionMode
    ? PERMISSION_MODE_LABELS[permissionMode]
    : permissionCustom
      ? "自定义"
      : "跟随 Agent";
  const permissionDisabled =
    !directory ||
    !selectedAgentInfo ||
    !permissionAvailable ||
    busy ||
    creatingSession ||
    permissionUpdating;
  const permissionTitle = !directory
    ? "请先选择工作区"
    : !selectedAgentInfo
      ? "Agent 信息未加载，暂时无法切换权限"
      : !permissionAvailable
        ? "该 Agent 已拒绝这些操作，无法切换权限"
        : permissionUpdating
          ? "正在应用权限…"
          : creatingSession
            ? "正在创建会话…"
            : busy
              ? "当前轮执行中，结束后可切换权限"
              : permissionMode
                ? `Agent 权限：${permissionLabel}（点击切换）`
                : permissionCustom
                  ? "当前会话使用自定义权限规则（点击切换）"
                  : "跟随 Agent 默认权限（点击选择）";
  const agentDisabled = busy || creatingSession || permissionUpdating;
  const agentTitle = permissionUpdating
    ? "正在应用权限…"
    : creatingSession
      ? "正在创建会话…"
      : busy
        ? "当前轮执行中，结束后可切换 Agent"
        : `切换 Agent（当前：${selectedAgent}）`;
  const revertCount = revertedCount(messages, activeSession?.revert);

  // 设备面板截图通过轻量事件总线附加到当前输入框；不把附件状态提升到全局，
  // 避免影响 Composer 现有的草稿、失败恢复和工作区切换逻辑。
  useEffect(
    () =>
      onAppEvent("attach-device-screenshot", (attachment) => {
        const current = attachmentsRef.current;
        if (current.length >= MAX_ATTACHMENTS) {
          showNotice(`最多添加 ${MAX_ATTACHMENTS} 个附件，请先移除已有附件`);
          return;
        }
        const next = [...current, attachment];
        attachmentsRef.current = next;
        setAttachments(next);
        requestAnimationFrame(() => areaRef.current?.focus());
      }),
    [showNotice],
  );

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const styles = getComputedStyle(area);
    const lineHeight =
      Number.parseFloat(styles.lineHeight) || Number.parseFloat(styles.fontSize) * 1.6;
    const verticalPadding =
      Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    // 默认两行、最多四行；字体或缩放变化后仍按实际行高换算
    const minHeight = lineHeight * 2 + verticalPadding;
    const maxHeight = lineHeight * 4 + verticalPadding;
    area.style.height = "auto";
    area.style.height = `${Math.min(Math.max(area.scrollHeight, minHeight), maxHeight)}px`;
  }, [text]);

  /**
   * 文本与引用必须一起更新：文本是唯一事实来源，
   * 手动删掉文本里的 @token 后 chip 会跟着消失，不需要另存一份状态去对齐。
   */
  const applyText = (next: string, nextRefs?: MentionRef[]) => {
    textRef.current = next;
    setText(next);
    setRefs(nextRefs ?? parseMentions(next));
    const scope = draftScopeRef.current;
    if (!scope) return;
    try {
      writeComposerDraft(localStorage, scope, next);
      draftSaveErrorRef.current = false;
    } catch (error) {
      if (draftSaveErrorRef.current) return;
      draftSaveErrorRef.current = true;
      showNotice(`草稿保存失败：${String(error)}`);
    }
  };

  const getVoiceSelection = (): VoiceSelection => {
    const area = areaRef.current;
    const start = area?.selectionStart ?? textRef.current.length;
    const end = area?.selectionEnd ?? start;
    return { start, end };
  };

  const insertVoiceText = (transcript: string, selection: VoiceSelection) => {
    const insertion = insertVoiceTranscript(textRef.current, transcript, selection);
    if (!insertion) return null;
    applyText(insertion.afterText);
    requestAnimationFrame(() => {
      const area = areaRef.current;
      area?.focus();
      area?.setSelectionRange(insertion.caret, insertion.caret);
    });
    return insertion;
  };

  const undoVoiceText = (insertion: {
    beforeText: string;
    beforeStart: number;
    beforeEnd: number;
  }) => {
    applyText(insertion.beforeText);
    requestAnimationFrame(() => {
      const area = areaRef.current;
      area?.focus();
      area?.setSelectionRange(insertion.beforeStart, insertion.beforeEnd);
    });
  };

  const voice = useVoiceInput({
    composerRef,
    enabled: Boolean(directory) && !editingActive,
    currentText: text,
    getSelection: getVoiceSelection,
    onInsert: insertVoiceText,
    onUndo: undoVoiceText,
    onNotice: showNotice,
  });

  useEffect(() => {
    if (!voice.busy) return;
    setMention(null);
    setAgentOpen(false);
    setModelOpen(false);
    setVariantOpen(false);
    setWorkspaceOpen(false);
    setPermissionOpen(false);
  }, [voice.busy]);

  // 发送失败时把原文还回输入框，引用 chip 也要一起恢复
  useEffect(() => {
    if (!failedText) return;
    // 用户已经重新输入了别的内容：保留新草稿，不覆盖
    if (!text.trim()) {
      // 只恢复 token 仍在原文里的引用，用户已经删掉的不再复活
      const restored = lastSentRefs.current.filter((ref) => failedText.includes(ref.token));
      applyText(failedText, restored);
    }
    if (attachments.length === 0 && lastSentAttachments.current.length > 0) {
      setAttachments(lastSentAttachments.current);
    }
    lastSentRefs.current = [];
    lastSentAttachments.current = [];
    clearFailedText();
    // 只在失败文本变化时触发；text 取当前渲染值即可
  }, [failedText, clearFailedText]);

  // 切换工作区或会话时先保存上一处草稿，再恢复当前上下文自己的草稿。
  // 新会话使用 sessionID=null 的独立槽位，首条消息建会话后不会串到已有会话。
  useLayoutEffect(() => {
    const previous = draftScopeRef.current;
    const next = directory ? { directory, sessionID } : null;
    const scopeChanged =
      Boolean(previous) &&
      (!next ||
        previous?.directory !== next?.directory ||
        previous?.sessionID !== next?.sessionID);
    if (scopeChanged && voice.phase !== "idle") {
      voice.cancel();
    }
    if (
      previous &&
      (!next ||
        previous.directory !== next.directory ||
        previous.sessionID !== next.sessionID)
    ) {
      try {
        writeComposerDraft(localStorage, previous, textRef.current);
        draftSaveErrorRef.current = false;
      } catch (error) {
        if (!draftSaveErrorRef.current) {
          draftSaveErrorRef.current = true;
          showNotice(`草稿保存失败：${String(error)}`);
        }
      }
    }

    draftScopeRef.current = next;
    setMention(null);
    if (!next) {
      textRef.current = "";
      setText("");
      setRefs([]);
      return;
    }

    try {
      const saved = readComposerDraft(localStorage, next);
      applyText(saved?.text ?? "");
      draftSaveErrorRef.current = false;
    } catch (error) {
      applyText("");
      if (!draftSaveErrorRef.current) {
        draftSaveErrorRef.current = true;
        showNotice(`草稿读取失败：${String(error)}`);
      }
    }
  }, [directory, sessionID]);

  useEffect(() => {
    if ((settingsOpen || shortcutsOpen) && voice.phase !== "idle") {
      voice.cancel();
    }
  }, [settingsOpen, shortcutsOpen, voice.phase, voice.cancel]);

  // @ 引用：输入 @ 后按关键字搜索工作区文件（空关键字返回工作区文件列表）
  useEffect(() => {
    if (!mention || !directory) {
      setMentionResults([]);
      setMentionStatus("idle");
      return;
    }
    const query = mention.query;
    let cancelled = false;
    setMentionStatus("loading");
    setMentionIndex(0);
    // 停 180ms 再查，避免每敲一个字符都打一次 /find/file
    const timer = setTimeout(() => {
      void loadMentionFiles(directory, query)
        .then((files) => {
          if (cancelled) return;
          setMentionResults(files);
          setMentionStatus("ready");
        })
        .catch(() => {
          if (cancelled) return;
          setMentionResults([]);
          setMentionStatus("error");
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention, directory]);

  // 候选：过滤目录项（/find/file 用 / 结尾表示目录）和已经引用过的文件
  const mentionItems = useMemo(
    () =>
      mentionResults
        .filter((file) => file && !file.endsWith("/"))
        .filter((file) => !refs.some((ref) => ref.path === file))
        .slice(0, MAX_MENTION_ITEMS),
    [mentionResults, refs],
  );
  const activeMentionIndex = Math.min(mentionIndex, Math.max(0, mentionItems.length - 1));

  const applyMention = (path: string) => {
    // 用当前光标重新定位：用户可能已经移动过光标，旧 draft 的下标不可信
    const draft = detectMention(text, areaRef.current?.selectionStart ?? text.length);
    if (!draft) {
      setMention(null);
      return;
    }
    if (refs.length >= MAX_REFS) {
      showNotice(`最多引用 ${MAX_REFS} 个文件，请先移除已有引用`);
      return;
    }
    // 路径含空格时用引号包起来，否则解析不回去
    const label = path.includes(" ") ? `@"${path}"` : `@${path}`;
    const next = `${text.slice(0, draft.start)}${label} ${text.slice(draft.end)}`;
    applyText(next);
    setMention(null);
    // 光标落到插入的 token + 一个空格之后
    const caret = draft.start + label.length + 1;
    requestAnimationFrame(() => {
      const area = areaRef.current;
      area?.focus();
      area?.setSelectionRange(caret, caret);
    });
  };

  const removeRef = (ref: MentionRef) => {
    // 重新解析一次：文本可能已经被编辑过，旧下标不可信
    const current = parseMentions(text).find((item) => item.path === ref.path);
    if (!current) return;
    // 顺手吞掉 token 后面紧跟的一个空格，避免留下连续空格
    const end = text[current.end] === " " ? current.end + 1 : current.end;
    applyText(text.slice(0, current.start) + text.slice(end));
  };

  const insertReference = (path: string) => {
    if (!directory || !path || path.endsWith("/")) return;
    const relative = relativeWorkspacePath(directory, path);
    const existing = parseMentions(text).find((ref) => ref.path === relative);
    if (existing) {
      requestAnimationFrame(() => {
        const area = areaRef.current;
        area?.focus();
        area?.setSelectionRange(existing.start, existing.end);
      });
      showNotice("该文件已在引用中");
      return;
    }
    if (refs.length >= MAX_REFS) {
      showNotice(`最多引用 ${MAX_REFS} 个文件，请先移除已有引用`);
      return;
    }
    const area = areaRef.current;
    const start = area?.selectionStart ?? text.length;
    const end = area?.selectionEnd ?? start;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const token = relative.includes(" ") ? `@"${relative}"` : `@${relative}`;
    const next = `${before}${prefix}${token} ${suffix}${after}`;
    applyText(next);
    setMention(null);
    const caret = start + prefix.length + token.length + 1;
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(caret, caret);
    });
  };

  useEffect(
    () =>
      onAppEvent("reference-file", ({ directory: sourceDirectory, path }) => {
        if (sourceDirectory !== directory) {
          showNotice("请先切换到该文件所在的工作区");
          return;
        }
        insertReference(path);
      }),
    [directory, insertReference, showNotice],
  );

  // 工具栏菜单互斥；点外部或按 Esc 一起收起，避免弹层叠在一起。
  useEffect(() => {
    if (
      !agentOpen &&
      !modelOpen &&
      !variantOpen &&
      !workspaceOpen &&
      !permissionOpen
    ) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!agentPickerRef.current?.contains(target)) setAgentOpen(false);
      if (!modelPickerRef.current?.contains(target)) setModelOpen(false);
      if (!variantPickerRef.current?.contains(target)) setVariantOpen(false);
      if (!workspacePickerRef.current?.contains(target)) setWorkspaceOpen(false);
      if (!permissionPickerRef.current?.contains(target)) setPermissionOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAgentOpen(false);
      setModelOpen(false);
      setVariantOpen(false);
      setWorkspaceOpen(false);
      setPermissionOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [agentOpen, modelOpen, variantOpen, workspaceOpen, permissionOpen]);

  // 忙碌或权限写入期间不允许继续操作弹层，避免选择结果与当前轮错位。
  useEffect(() => {
    if (permissionDisabled) setPermissionOpen(false);
  }, [permissionDisabled]);

  // Agent 切换会同步会话权限，执行中或权限写入期间收起菜单并禁用入口。
  useEffect(() => {
    if (busy || creatingSession || permissionUpdating) setAgentOpen(false);
  }, [busy, creatingSession, permissionUpdating]);

  // 当前模型：优先用户本次选择的，其次最近一条带模型的消息
  const currentModel = useMemo(() => {
    if (selectedModel) return selectedModel;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const model = messages[i].info.model;
      if (model) return { providerID: model.providerID, modelID: model.modelID };
    }
    return null;
  }, [selectedModel, messages]);

  const modelLabel = useMemo(() => {
    if (!currentModel) return "默认模型";
    const match = models.find(
      (item) => item.id === currentModel.modelID && item.providerID === currentModel.providerID,
    );
    return match?.name ?? `${currentModel.providerID}/${currentModel.modelID}`;
  }, [currentModel, models]);

  const currentModelInfo = useMemo(() => {
    if (!currentModel) return undefined;
    return models.find(
      (item) => item.id === currentModel.modelID && item.providerID === currentModel.providerID,
    );
  }, [currentModel, models]);

  const variants = useMemo(() => {
    return (currentModelInfo?.variants ?? []).map((variant) => variant.id);
  }, [currentModelInfo]);

  // 模型数据或当前模型变化后，默认选中该模型的最高档；用户之后仍可手动改回默认。
  const defaultVariantModel = useRef<string | null>(null);
  useEffect(() => {
    if (!currentModel) {
      defaultVariantModel.current = null;
      return;
    }
    if (!currentModelInfo) return;
    const key = `${currentModel.providerID}/${currentModel.modelID}`;
    if (defaultVariantModel.current === key) return;
    defaultVariantModel.current = key;
    const choices = (currentModelInfo.variants ?? []).map((variant) => variant.id);
    if (selectedVariant && choices.includes(selectedVariant)) return;
    selectVariant(highestModelVariant(currentModelInfo));
  }, [currentModel, currentModelInfo, selectVariant, selectedVariant]);

  // 斜杠命令：输入以 / 开头且还没敲空格时弹出
  const slashQuery = useMemo(() => {
    const match = /^\/(\S*)$/.exec(text);
    return match ? match[1].toLowerCase() : null;
  }, [text]);
  const slashMatches = useMemo(() => {
    if (slashQuery === null) return [] as typeof commands;
    return commands
      .filter((command) => command.name.toLowerCase().includes(slashQuery))
      .slice(0, 8);
  }, [commands, slashQuery]);
  const [slashIndex, setSlashIndex] = useState(0);

  const applyCommand = (name: string) => {
    applyText(`/${name} `, []);
    requestAnimationFrame(() => areaRef.current?.focus());
  };

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return visibleModels.slice(0, 60);
    return visibleModels
      .filter(
        (item) =>
          (item.name ?? "").toLowerCase().includes(key) ||
          item.id.toLowerCase().includes(key) ||
          item.providerID.toLowerCase().includes(key),
      )
      .slice(0, 60);
  }, [keyword, visibleModels]);

  const performSubmit = (delivery: "queue" | "steer") => {
    const value = text.trim();
    if ((!value && attachments.length === 0) || !directory) return;
    if (voice.busy) {
      showNotice("正在语音输入，请先停止录音");
      return;
    }
    if (editingActive) {
      showNotice("正在编辑历史消息，请先完成或取消编辑");
      return;
    }
    const files = attachments;
    // 位置按真正发出去的文本重算（trim 会挪动下标），保证 source.text 与 text part 对得上
    const mentioned = parseMentions(value);
    if (!submitMessage(value, files, mentioned, delivery)) return;
    emitAppEvent("message-submitted", { directory, sessionID });
    lastSentRefs.current = mentioned;
    lastSentAttachments.current = files;
    applyText("", []);
    setAttachments([]);
    setMention(null);
  };

  const submit = (delivery: "queue" | "steer") => {
    const value = text.trim();
    if ((!value && attachments.length === 0) || !directory) return;
    if (voice.busy) {
      showNotice("正在语音输入，请先停止录音");
      return;
    }
    if (editingActive) {
      showNotice("正在编辑历史消息，请先完成或取消编辑");
      return;
    }
    if (revertCount > 0) {
      revertDeliveryRef.current = delivery;
      setRevertConfirm(true);
      return;
    }
    performSubmit(delivery);
  };

  useEffect(() => {
    setRevertConfirm(false);
  }, [sessionID, directory]);

  useEffect(() => {
    if (revertCount === 0 || editingActive) setRevertConfirm(false);
  }, [revertCount, editingActive]);

  const editQueued = (item: QueuedMessage) => {
    if (text.trim() || attachments.length > 0 || refs.length > 0) {
      showNotice("请先清空输入框，再编辑排队消息");
      return;
    }
    const restored = restoreQueuedMessage(item.sessionID, item.id);
    if (!restored) return;
    applyText(restored.text, restored.refs);
    setAttachments(restored.attachments);
    requestAnimationFrame(() => {
      const area = areaRef.current;
      area?.focus();
      area?.setSelectionRange(restored.text.length, restored.text.length);
    });
  };

  /** 把一批附件并入当前列表，超出上限的部分丢弃并明确提示 */
  const addAttachments = (incoming: Attachment[]) => {
    if (incoming.length === 0) return;
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (room === 0) {
      showNotice(`最多添加 ${MAX_ATTACHMENTS} 个附件，请先移除已有附件`);
      return;
    }
    setAttachments((current) =>
      [...current, ...incoming.slice(0, room)].slice(0, MAX_ATTACHMENTS),
    );
    if (incoming.length > room) {
      showNotice(`最多添加 ${MAX_ATTACHMENTS} 个附件，超出的已忽略`);
    }
  };

  const pickFiles = async (list: FileList | null) => {
    if (!list) return;
    const files = Array.from(list);
    try {
      const picked = await Promise.all(
        files
          .slice(0, MAX_ATTACHMENTS)
          .map((file) => blobToAttachment(file, file.name)),
      );
      const valid = picked.filter((item): item is Attachment => Boolean(item));
      if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
        showNotice("超过 8MB 的附件已忽略");
      }
      addAttachments(valid);
    } catch (error) {
      showNotice(`读取附件失败：${String(error)}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  /** 粘贴的图片没有文件名，按图片类型生成截图名称 */
  const pasteImages = async (files: File[]) => {
    try {
      const picked = await Promise.all(
        files.slice(0, MAX_ATTACHMENTS).map((file) => {
          const mime = file.type || "image/png";
          return blobToAttachment(file, pastedImageName(mime), mime, "pasted");
        }),
      );
      const valid = picked.filter((item): item is Attachment => Boolean(item));
      if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
        showNotice("超过 8MB 的截图已忽略");
      }
      addAttachments(valid);
    } catch (error) {
      showNotice(`读取截图失败：${String(error)}`);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;

    const images: File[] = [];
    for (const item of Array.from(clipboard.items)) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) images.push(file);
    }
    if (images.length === 0) {
      for (const file of Array.from(clipboard.files)) {
        if (file.type.startsWith("image/")) images.push(file);
      }
    }
    if (images.length > 0) {
      event.preventDefault();
      void pasteImages(images);
      return;
    }

    // 有文本就交给 textarea 正常粘贴；只剩未知/文件类型时再走原生图片读取兜底
    const hasText = Array.from(clipboard.types).some(
      (type) => type === "text/plain" || type === "text/html" || type === "text/rtf",
    );
    if (hasText) return;
    event.preventDefault();
    void clipboardImageToAttachment().then((image) => {
      if (image) addAttachments([image]);
      else showNotice("无法读取剪贴板图片，请重试或点击回形针添加");
    });
  };

  const chooseWorkspaceFolder = async () => {
    if (workspacePicking) return;
    setWorkspaceOpen(false);
    setWorkspacePicking(true);
    try {
      await pickWorkspaceFolder();
    } finally {
      setWorkspacePicking(false);
    }
  };

  return (
    <div className="composer" ref={composerRef}>
      {editingActive && (
        <div className="composer-edit-banner">
          <Icon name="pencil" size={14} />
          <span>正在编辑历史消息；完成或取消后可继续发送。</span>
          <button type="button" onClick={cancelEditMessage}>
            取消编辑
          </button>
        </div>
      )}
      {!editingActive && revertConfirm && revertCount > 0 && (
        <div className="composer-edit-banner composer-revert-banner">
          <Icon name="undo" size={14} />
          <span>
            会话中还有 {revertCount} 条已回滚消息。继续发送会永久删除它们，工作区保持当前回滚状态。
          </span>
          <button type="button" onClick={() => setRevertConfirm(false)}>
            取消
          </button>
          <button
            type="button"
            className="composer-revert-send"
            onClick={() => {
              setRevertConfirm(false);
              performSubmit(revertDeliveryRef.current);
            }}
          >
            丢弃并发送
          </button>
        </div>
      )}
      <div className="composer-box">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="file-input"
          onChange={(event) => void pickFiles(event.target.files)}
        />
        {!sessionID && (
          <div className="composer-workspace">
            <span className="composer-workspace-label">工作区</span>
            <div className="toolbar-picker workspace-picker" ref={workspacePickerRef}>
              <button
                type="button"
                className={`workspace-pill ${workspaceOpen ? "open" : ""}`}
                onClick={() => {
                  setWorkspaceOpen((open) => !open);
                  setAgentOpen(false);
                  setModelOpen(false);
                  setVariantOpen(false);
                  setPermissionOpen(false);
                }}
                disabled={workspacePicking}
                title={directory ?? "选择新会话的工作区"}
                aria-label={`选择新会话工作区，当前 ${workspaceName(directory)}`}
                aria-haspopup="menu"
                aria-expanded={workspaceOpen}
              >
                <Icon name="workspace" size={14} />
                <span className="workspace-pill-name">
                  {workspacePicking ? "正在选择…" : workspaceName(directory)}
                </span>
                <Icon name="chevron-down" size={13} className="toolbar-caret" />
              </button>
              {workspaceOpen && (
                <div
                  className="composer-pop workspace-pop"
                  role="menu"
                  aria-label="选择新会话工作区"
                >
                  <div className="composer-pop-head">选择新会话工作区</div>
                  <div className="workspace-pop-note">发送首条消息后固定</div>
                  <div className="model-list workspace-list">
                    {projects.map((project) => {
                      const active =
                        normalizePickerPath(project.worktree) ===
                        normalizePickerPath(directory ?? "");
                      return (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          key={project.worktree}
                          className={`toolbar-menu-item ${active ? "active" : ""}`}
                          onClick={() => {
                            setWorkspaceOpen(false);
                            void changeDraftWorkspace(project.worktree);
                          }}
                          title={project.worktree}
                        >
                          <Icon name="workspace" size={14} />
                          <span className="toolbar-menu-copy">
                            <span className="toolbar-menu-title">
                              {workspaceName(project.worktree)}
                            </span>
                            <span className="toolbar-menu-desc">{project.worktree}</span>
                          </span>
                          <Icon
                            name="check"
                            size={14}
                            className={`toolbar-menu-check ${active ? "on" : ""}`}
                          />
                        </button>
                      );
                    })}
                    {projects.length === 0 && (
                      <div className="empty-line">还没有工作区，请从本机选择文件夹</div>
                    )}
                  </div>
                  <div className="workspace-pop-footer">
                    <button
                      type="button"
                      role="menuitem"
                      className="workspace-create"
                      onClick={() => void chooseWorkspaceFolder()}
                    >
                      <Icon name="plus" size={14} />
                      新建工作区…
                    </button>
                  </div>
                </div>
              )}
            </div>
            <span className="composer-workspace-hint">发送后固定</span>
          </div>
        )}
        {(queue.length > 0 || pending.length > 0) && (
          <div className="queue-tray">
            <div className="queue-tray-head">
              <span className="queue-tray-title">
                {queueSending
                  ? "发送中…"
                  : queue.length > 0
                    ? `待发送 ${queue.length} 条`
                    : "引导消息"}
              </span>
              {queuePaused && queue.length > 0 && (
                <span className="queue-paused">已暂停</span>
              )}
              <span className="queue-shortcut">Enter 排队 · ⌘Enter 引导</span>
              {queuePaused &&
                queue.length > 0 &&
                !pendingFailed &&
                sessionID && (
                  <button
                    type="button"
                    className="queue-head-btn"
                    onClick={() => resumeDelivery(sessionID)}
                  >
                    继续发送
                  </button>
                )}
            </div>
            {pending.length > 0 && (
              <div
                className={`queue-steer-status${pendingFailed ? " failed" : ""}`}
                role="status"
              >
                <Icon name="spark" size={12} />
                <span>
                  {pendingFailed
                    ? "引导消息未送达"
                    : pendingPaused
                      ? "引导消息已暂停"
                      : "引导消息等待下一步…"}
                </span>
                {sessionID && pendingFailed && (
                  <button
                    type="button"
                    className="queue-head-btn"
                    onClick={() => void retryPendingSteer(sessionID)}
                  >
                    重试
                  </button>
                )}
                {sessionID && pendingPaused && !pendingFailed && (
                  <button
                    type="button"
                    className="queue-head-btn"
                    onClick={() => resumeDelivery(sessionID)}
                  >
                    继续
                  </button>
                )}
                {sessionID && (pendingFailed || pendingPaused) && (
                  <button
                    type="button"
                    className="queue-head-btn"
                    onClick={() => dismissPendingSteer(sessionID)}
                  >
                    忽略
                  </button>
                )}
              </div>
            )}
            {queue.map((item) => (
              <div className={`queue-item ${item.status}`} key={item.id}>
                <span className="queue-badge">
                  {item.status === "sending"
                    ? "发送中"
                    : item.status === "failed"
                      ? "失败"
                      : "排队"}
                </span>
                <span
                  className="queue-preview"
                  title={item.text || previewQueuedMessage(item)}
                >
                  {previewQueuedMessage(item)}
                </span>
                <span className="queue-meta">
                  {item.refs.length > 0 && (
                    <span title={`引用 ${item.refs.length} 个文件`}>
                      <Icon name="file" size={11} />
                      {item.refs.length}
                    </span>
                  )}
                  {item.attachments.length > 0 && (
                    <span title={`附件 ${item.attachments.length} 个`}>
                      <Icon name="paperclip" size={11} />
                      {item.attachments.length}
                    </span>
                  )}
                </span>
                <span className="queue-actions">
                  <button
                    type="button"
                    disabled={item.status === "sending" || stopping}
                    onClick={() =>
                      void steerQueuedMessage(item.sessionID, item.id)
                    }
                    title={busy ? "作为引导发送" : "立即发送"}
                  >
                    {busy ? "引导" : "发送"}
                  </button>
                  <button
                    type="button"
                    disabled={item.status === "sending" || stopping}
                    onClick={() => editQueued(item)}
                    title="编辑"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    disabled={item.status === "sending"}
                    onClick={() =>
                      removeQueuedMessage(item.sessionID, item.id)
                    }
                    title="删除"
                  >
                    删除
                  </button>
                  {item.status === "failed" && (
                    <button
                      type="button"
                      onClick={() =>
                        retryQueuedMessage(item.sessionID, item.id)
                      }
                    >
                      重试
                    </button>
                  )}
                </span>
                {item.status === "failed" && item.error && (
                  <span className="queue-error">{item.error}</span>
                )}
              </div>
            ))}
          </div>
        )}
        <VoiceBar
          phase={voice.phase}
          transcript={voice.transcript}
          error={voice.error}
          elapsedMs={voice.elapsedMs}
          maxDurationMs={voice.maxDurationMs}
          limitWarning={voice.limitWarning}
          undoAvailable={voice.undoAvailable}
          holdOption={voice.holdOption}
          onStop={voice.stop}
          onCancel={voice.cancel}
          onRetry={voice.retry}
          onInsertDraft={voice.insertDraft}
          onUndo={voice.undoInsertion}
          onDismiss={voice.dismissError}
          onOpenPrivacy={(kind) => void voice.openPrivacySettings(kind)}
          onOpenVoiceSettings={() => openSettings("voice")}
        />
        {refs.length > 0 && (
          <div className="ref-row">
            {refs.map((ref) => (
              <span
                className="ref-chip"
                key={ref.path}
                title={`引用：${ref.path}`}
                onContextMenu={(event) => {
                  if (!directory) return;
                  const absolute = absoluteWorkspacePath(directory, ref.path);
                  menu.open(
                    event,
                    [
                      revealItem("在 Finder 中显示", absolute),
                      copyItem("复制相对路径", ref.path, "相对路径已复制"),
                      copyItem("复制绝对路径", absolute, "绝对路径已复制"),
                      { type: "separator" },
                      {
                        type: "item",
                        label: "移除引用",
                        icon: "close",
                        onSelect: () => removeRef(ref),
                      },
                    ],
                    { label: "引用文件菜单" },
                  );
                }}
              >
                <Icon name="file" size={13} />
                <span className="ref-chip-path">{ref.path}</span>
                <button
                  className="chip-remove"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => removeRef(ref)}
                  title="移除引用"
                  aria-label={`移除引用 ${ref.path}`}
                >
                  <Icon name="close" size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachment-row">
            {attachments.map((file) => (
              <span
                className="attachment-chip"
                key={file.id}
                title={`${file.name} · ${Math.round(file.size / 1024)}KB`}
                onContextMenu={(event) =>
                  menu.open(
                    event,
                    [
                      copyItem("复制文件名", file.name, "文件名已复制"),
                      { type: "separator" },
                      {
                        type: "item",
                        label: "移除附件",
                        icon: "close",
                        onSelect: () =>
                          setAttachments((current) =>
                            current.filter((item) => item.id !== file.id),
                          ),
                      },
                    ],
                    { label: "附件菜单" },
                  )
                }
              >
                {file.mime.startsWith("image/") ? (
                  <img className="attachment-thumb" src={file.url} alt="" />
                ) : (
                  <Icon name="file" size={14} />
                )}
                <span className="attachment-name">{file.name}</span>
                <button
                  className="chip-remove"
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== file.id))}
                  title="移除"
                  aria-label={`移除 ${file.name}`}
                >
                  <Icon name="close" size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        {slashMatches.length > 0 && (
          <div className="mention-pop">
            <div className="mention-hint">斜杠命令（↑↓ 选择，Enter 插入，Esc 取消）</div>
            {slashMatches.map((command, index) => (
              <button
                key={command.name}
                className={`mention-item ${index === slashIndex ? "active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setSlashIndex(index)}
                onClick={() => applyCommand(command.name)}
                title={command.description ?? command.name}
              >
                /{command.name}
                <span className="slash-desc">{command.description?.slice(0, 40) ?? ""}</span>
              </button>
            ))}
          </div>
        )}
        {mention && slashMatches.length === 0 && (
          <div className="mention-pop">
            <div className="mention-hint">
              {mentionStatus === "loading"
                ? "正在搜索工作区文件…"
                : "引用文件（↑↓ 选择，Enter 插入，Esc 取消）"}
            </div>
            {mentionStatus === "error" ? (
              <div className="mention-empty">文件搜索不可用</div>
            ) : refs.length >= MAX_REFS ? (
              <div className="mention-empty">已达引用上限（{MAX_REFS} 个），移除后可继续引用</div>
            ) : mentionStatus === "ready" && mentionItems.length === 0 ? (
              <div className="mention-empty">
                {mention.query.trim() ? "没有匹配的文件" : "工作区没有可引用文件"}
              </div>
            ) : (
              mentionItems.map((file, index) => (
                <button
                  key={file}
                  className={`mention-item ${index === activeMentionIndex ? "active" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setMentionIndex(index)}
                  onClick={() => applyMention(file)}
                  title={file}
                >
                  {file}
                </button>
              ))
            )}
          </div>
        )}
        <textarea
          ref={areaRef}
          value={text}
          onChange={(event) => {
            const value = event.target.value;
            applyText(value);
            setMention(detectMention(value, event.target.selectionStart ?? value.length));
          }}
          onKeyDown={(event) => {
            // IME 组字过程中的按键交给输入法：否则中文/日文候选词会被当成快捷键吞掉
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (voice.busy) {
              if (event.key === "Enter") event.preventDefault();
              return;
            }
            if (slashMatches.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSlashIndex((index) => (index + 1) % slashMatches.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSlashIndex((index) => (index - 1 + slashMatches.length) % slashMatches.length);
                return;
              }
              if (event.key === "Tab" || event.key === "Enter") {
                event.preventDefault();
                applyCommand(slashMatches[Math.min(slashIndex, slashMatches.length - 1)].name);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                applyText("", []);
                return;
              }
            }
            if (mention) {
              if (event.key === "Escape") {
                event.preventDefault();
                setMention(null);
                return;
              }
              if (mentionItems.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionIndex((index) => (index + 1) % mentionItems.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionIndex((index) => (index - 1 + mentionItems.length) % mentionItems.length);
                  return;
                }
                // Shift+Enter / Shift+Tab 保留原义（换行/反向焦点），不当作选择
                if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                  event.preventDefault();
                  applyMention(mentionItems[activeMentionIndex]);
                  return;
                }
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit(event.metaKey || event.ctrlKey ? "steer" : "queue");
            }
          }}
          onPaste={handlePaste}
          onBlur={() => setMention(null)}
          placeholder={
            directory
              ? editingActive
                ? "正在编辑历史消息：完成或取消后可继续发送"
                : busy
                ? stopping
                  ? "正在停止：新消息会加入排队"
                  : "执行中：Enter 排队，⌘Enter 引导，可继续 @ 引用文件"
                : "发消息，@ 引用文件，可粘贴截图，Enter 发送"
              : "请先在左侧选择工作区"
          }
          rows={2}
          readOnly={voice.busy}
          disabled={!directory}
        />
        <div className="composer-actions">
          <div className="composer-tools composer-tools-left">
            <button
              type="button"
              className="toolbar-icon-btn"
              onClick={() => fileInputRef.current?.click()}
              title="添加附件或粘贴截图（最多 4 个，单个不超过 8MB）"
              aria-label="添加附件"
              disabled={!directory}
            >
              <Icon name="paperclip" size={17} />
            </button>
            <button
              type="button"
              className={`toolbar-icon-btn voice-mic-btn ${
                voice.recording ? "recording" : ""
              } ${voice.starting ? "starting" : ""}`}
              onClick={() => {
                if (voice.recording) voice.stop();
                else if (voice.phase !== "starting" && voice.phase !== "finalizing") {
                  void voice.start("button");
                }
              }}
              title={
                voice.recording
                  ? "停止语音输入"
                  : voice.starting
                    ? "正在启动语音输入…"
                    : voice.finalizing
                      ? "正在识别语音…"
                      : voice.holdOption
                        ? "语音输入（点击或长按左 ⌥）"
                        : "语音输入"
              }
              aria-label={voice.recording ? "停止语音输入" : "开始语音输入"}
              aria-pressed={voice.recording}
              disabled={
                !directory ||
                editingActive ||
                voice.starting ||
                voice.finalizing
              }
            >
              <Icon name="microphone" size={17} />
            </button>
            <div className="toolbar-picker agent-picker" ref={agentPickerRef}>
              <button
                type="button"
                className={`toolbar-pill agent-pill ${agentOpen ? "open" : ""}`}
                onClick={() => {
                  setAgentOpen((open) => !open);
                  setModelOpen(false);
                  setVariantOpen(false);
                  setPermissionOpen(false);
                }}
                title={agentTitle}
                aria-label={agentTitle}
                aria-haspopup="menu"
                aria-expanded={agentOpen}
                disabled={agentDisabled}
              >
                <span className="agent-dot" />
                <span className="toolbar-label">{selectedAgent}</span>
                <Icon name="chevron-down" size={13} className="toolbar-caret" />
              </button>
              {agentOpen && (
                <div className="composer-pop agent-pop" role="menu" aria-label="切换 Agent">
                  <div className="composer-pop-head">Agent</div>
                  {agents.map((agent) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={agent.name === selectedAgent}
                      key={agent.name}
                      className={`toolbar-menu-item ${agent.name === selectedAgent ? "active" : ""}`}
                      onClick={() => {
                        selectAgent(agent.name);
                        setAgentOpen(false);
                      }}
                      title={agent.description ?? agent.name}
                    >
                      <span className="toolbar-menu-copy">
                        <span className="toolbar-menu-title">{agent.name}</span>
                        {agent.description && (
                          <span className="toolbar-menu-desc">{agent.description}</span>
                        )}
                      </span>
                      <Icon
                        name="check"
                        size={14}
                        className={`toolbar-menu-check ${
                          agent.name === selectedAgent ? "on" : ""
                        }`}
                      />
                    </button>
                  ))}
                  {agents.length === 0 && <div className="empty-line">没有可用 Agent</div>}
                </div>
              )}
            </div>
            <div
              className="toolbar-picker permission-picker"
              ref={permissionPickerRef}
            >
              <button
                type="button"
                className={`toolbar-pill permission-pill ${
                  permissionMode === "allow" ? "danger" : ""
                } ${permissionOpen ? "open" : ""}`}
                onClick={() => {
                  setPermissionOpen((open) => !open);
                  setAgentOpen(false);
                  setModelOpen(false);
                  setVariantOpen(false);
                  setWorkspaceOpen(false);
                }}
                disabled={permissionDisabled}
                title={permissionTitle}
                aria-label={`Agent 权限，当前 ${permissionLabel}`}
                aria-haspopup="menu"
                aria-expanded={permissionOpen}
              >
                <Icon
                  name={permissionMode === "allow" ? "alert" : "shield"}
                  size={15}
                  className="permission-icon"
                />
                <span className="toolbar-label">{permissionLabel}</span>
                <Icon name="chevron-down" size={13} className="toolbar-caret" />
              </button>
              {permissionOpen && (
                <div
                  className="composer-pop permission-pop"
                  role="menu"
                  aria-label="Agent 权限"
                >
                  {!sessionID && (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={permissionMode === null}
                      className="toolbar-menu-item permission-option"
                      onClick={() => {
                        setPermissionOpen(false);
                        resetPermissionMode();
                      }}
                    >
                      <Icon
                        name="shield"
                        size={18}
                        className="permission-option-icon"
                      />
                      <span className="toolbar-menu-copy">
                        <span className="toolbar-menu-title">跟随 Agent</span>
                        <span className="toolbar-menu-desc">
                          使用 Agent 当前的权限配置，不写入会话规则
                        </span>
                      </span>
                      <Icon
                        name="check"
                        size={15}
                        className={`toolbar-menu-check ${
                          permissionMode === null ? "on" : ""
                        }`}
                      />
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={permissionMode === "ask"}
                    className="toolbar-menu-item permission-option"
                    onClick={() => {
                      setPermissionOpen(false);
                      void setPermissionMode("ask");
                    }}
                  >
                    <Icon
                      name="shield"
                      size={18}
                      className="permission-option-icon"
                    />
                    <span className="toolbar-menu-copy">
                      <span className="toolbar-menu-title">每次询问</span>
                      <span className="toolbar-menu-desc">
                        执行命令、修改工作区外文件或访问网络前，始终询问
                      </span>
                    </span>
                    <Icon
                      name="check"
                      size={15}
                      className={`toolbar-menu-check ${
                        permissionMode === "ask" ? "on" : ""
                      }`}
                    />
                  </button>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={permissionMode === "allow"}
                    className="toolbar-menu-item permission-option danger"
                    onClick={() => {
                      setPermissionOpen(false);
                      void setPermissionMode("allow");
                    }}
                  >
                    <Icon
                      name="alert"
                      size={18}
                      className="permission-option-icon"
                    />
                    <span className="toolbar-menu-copy">
                      <span className="toolbar-menu-title">完全访问</span>
                      <span className="toolbar-menu-desc">
                        不再询问，可自由访问你的文件、终端和网络
                      </span>
                    </span>
                    <Icon
                      name="check"
                      size={15}
                      className={`toolbar-menu-check ${
                        permissionMode === "allow" ? "on" : ""
                      }`}
                    />
                  </button>
                  <div className="permission-pop-note">
                    Agent 自身的硬性限制仍然生效
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="composer-tools composer-tools-right">
            <div className="toolbar-picker model-picker" ref={modelPickerRef}>
              <button
                type="button"
                className={`toolbar-pill model-pill ${modelOpen ? "open" : ""}`}
                onClick={() => {
                  setModelOpen((open) => !open);
                  setAgentOpen(false);
                  setVariantOpen(false);
                  setPermissionOpen(false);
                }}
                title={`切换模型（当前：${modelLabel}）`}
                aria-label={`切换模型，当前 ${modelLabel}`}
                aria-haspopup="dialog"
                aria-expanded={modelOpen}
              >
                <span className="model-dot" />
                <span className="toolbar-label">{modelLabel}</span>
                <Icon name="chevron-down" size={13} className="toolbar-caret" />
              </button>
              {modelOpen && (
                <div className="composer-pop model-pop" role="dialog" aria-label="选择模型">
                  <div className="composer-pop-head">模型</div>
                  <input
                    className="model-search"
                    autoFocus
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder="搜索模型"
                  />
                  <div className="model-list">
                    {filtered.map((item) => {
                      const active =
                        currentModel?.modelID === item.id &&
                        currentModel?.providerID === item.providerID;
                      return (
                        <button
                          type="button"
                          key={`${item.providerID}/${item.id}`}
                          className={`toolbar-menu-item ${active ? "active" : ""}`}
                          onClick={() => {
                            selectModel({ providerID: item.providerID, modelID: item.id });
                            setModelOpen(false);
                          }}
                          title={`${item.name ?? item.id} · ${item.providerID}`}
                        >
                          <span className="toolbar-menu-copy">
                            <span className="toolbar-menu-title">{item.name ?? item.id}</span>
                            <span className="toolbar-menu-desc">{item.providerID}</span>
                          </span>
                          <Icon
                            name="check"
                            size={14}
                            className={`toolbar-menu-check ${active ? "on" : ""}`}
                          />
                        </button>
                      );
                    })}
                    {filtered.length === 0 && (
                      <div className="empty-line">
                        {models.length === 0
                          ? "当前没有可用模型"
                          : visibleModels.length === 0
                            ? "设置中未勾选任何模型"
                            : "没有匹配的模型"}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            {variants.length > 0 && (
              <div className="toolbar-picker variant-picker" ref={variantPickerRef}>
                <button
                  type="button"
                  className={`toolbar-pill variant-pill ${
                    variantOpen ? "open" : ""
                  } ${selectedVariant ? "on" : ""}`}
                  title={`推理深度（当前：${selectedVariant ?? "默认"}）`}
                  aria-label={`推理深度，当前 ${selectedVariant ?? "默认"}`}
                  aria-haspopup="menu"
                  aria-expanded={variantOpen}
                  onClick={() => {
                    setVariantOpen((open) => !open);
                    setAgentOpen(false);
                    setModelOpen(false);
                    setPermissionOpen(false);
                  }}
                >
                  <Icon name="spark" size={14} className="variant-icon" />
                  <span className="variant-label">推理</span>
                  <span className="variant-value">{selectedVariant ?? "默认"}</span>
                  <Icon name="chevron-down" size={13} className="toolbar-caret" />
                </button>
                {variantOpen && (
                  <div className="composer-pop variant-pop" role="menu" aria-label="推理深度">
                    <div className="composer-pop-head">推理深度</div>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={!selectedVariant}
                      className={`toolbar-menu-item ${!selectedVariant ? "active" : ""}`}
                      onClick={() => {
                        selectVariant(null);
                        setVariantOpen(false);
                      }}
                    >
                      <span className="toolbar-menu-copy">
                        <span className="toolbar-menu-title">默认</span>
                        <span className="toolbar-menu-desc">跟随模型默认档位</span>
                      </span>
                      <Icon
                        name="check"
                        size={14}
                        className={`toolbar-menu-check ${!selectedVariant ? "on" : ""}`}
                      />
                    </button>
                    {variants.map((variant) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={selectedVariant === variant}
                        key={variant}
                        className={`toolbar-menu-item ${
                          selectedVariant === variant ? "active" : ""
                        }`}
                        onClick={() => {
                          selectVariant(variant);
                          setVariantOpen(false);
                        }}
                      >
                        <span className="toolbar-menu-copy">
                          <span className="toolbar-menu-title">{variant}</span>
                        </span>
                        <Icon
                          name="check"
                          size={14}
                          className={`toolbar-menu-check ${
                            selectedVariant === variant ? "on" : ""
                          }`}
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {busy ? (
              <div className="composer-send-group">
                <button
                  type="button"
                  className="send-btn"
                  onClick={(event) =>
                    submit(event.metaKey || event.ctrlKey ? "steer" : "queue")
                  }
                  disabled={
                    (!text.trim() && attachments.length === 0) ||
                    !directory ||
                    sessionLoading ||
                    editingActive ||
                    voice.busy
                  }
                  title={
                    voice.busy
                      ? "请先结束语音输入"
                      : editingActive
                      ? "请先完成或取消历史消息编辑"
                      : revertCount > 0
                        ? "发送前会确认是否丢弃回滚消息"
                      : "排队发送（Enter）；引导发送（⌘Enter）"
                  }
                  aria-label="排队发送"
                >
                  <Icon name="arrow-up" size={18} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  className="stop-btn"
                  onClick={() => void stop()}
                  disabled={stopping}
                  title="停止当前任务；排队消息会暂停保留"
                >
                  <Icon name="stop" size={12} />
                  {stopping ? "停止中…" : "停止"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="send-btn"
                onClick={(event) =>
                  submit(event.metaKey || event.ctrlKey ? "steer" : "queue")
                }
                disabled={
                  (!text.trim() && attachments.length === 0) ||
                  !directory ||
                  sessionLoading ||
                  editingActive ||
                  voice.busy
                }
                title={
                  voice.busy
                    ? "请先结束语音输入"
                    : editingActive
                    ? "请先完成或取消历史消息编辑"
                    : revertCount > 0
                      ? "发送前会确认是否丢弃回滚消息"
                    : "发送（Enter）"
                }
                aria-label="发送"
              >
                <Icon name="arrow-up" size={18} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
