import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import type { Attachment, MentionRef } from "../types";
import { api } from "../api";
import { useApp } from "../store";
import { MAX_REFS, parseMentions } from "../mentions";
import { onAppEvent } from "../appEvents";
import { copyItem, revealItem, useContextMenu } from "../contextMenu";
import { absoluteWorkspacePath, relativeWorkspacePath } from "../paths";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  blobToAttachment,
  clipboardImageToAttachment,
  pastedImageName,
} from "../attachments";
import { Icon } from "./Icon";

/** 弹层最多展示多少条候选 */
const MAX_MENTION_ITEMS = 8;

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
  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const streaming = useApp((s) => s.streaming);
  const directory = useApp((s) => s.directory);
  const sessionID = useApp((s) => s.sessionID);
  const projects = useApp((s) => s.projects);
  const changeDraftWorkspace = useApp((s) => s.changeDraftWorkspace);
  const pickWorkspaceFolder = useApp((s) => s.pickWorkspaceFolder);
  const models = useApp((s) => s.models);
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
  const messages = useApp((s) => s.messages);
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
  const [workspacePicking, setWorkspacePicking] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const failedText = useApp((s) => s.failedText);
  const clearFailedText = useApp((s) => s.clearFailedText);
  /** 上次发送的引用：失败恢复原文时用它把 chip 一起还回来 */
  const lastSentRefs = useRef<MentionRef[]>([]);
  const [keyword, setKeyword] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const variantPickerRef = useRef<HTMLDivElement>(null);
  const workspacePickerRef = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 220)}px`;
  }, [text]);

  /**
   * 文本与引用必须一起更新：文本是唯一事实来源，
   * 手动删掉文本里的 @token 后 chip 会跟着消失，不需要另存一份状态去对齐。
   */
  const applyText = (next: string, nextRefs?: MentionRef[]) => {
    setText(next);
    setRefs(nextRefs ?? parseMentions(next));
  };

  // 发送失败时把原文还回输入框，引用 chip 也要一起恢复
  useEffect(() => {
    if (!failedText) return;
    // 用户已经重新输入了别的内容：保留新草稿，不覆盖
    if (!text.trim()) {
      // 只恢复 token 仍在原文里的引用，用户已经删掉的不再复活
      const restored = lastSentRefs.current.filter((ref) => failedText.includes(ref.token));
      applyText(failedText, restored);
    }
    lastSentRefs.current = [];
    clearFailedText();
    // 只在失败文本变化时触发；text 取当前渲染值即可
  }, [failedText, clearFailedText]);

  // 切换工作区后旧引用路径全部失效：草稿与 chip 一起清空，
  // 避免把上一个工作区的 file:// 路径发给模型
  const lastDirectoryRef = useRef(directory);
  useEffect(() => {
    if (lastDirectoryRef.current === directory) return;
    lastDirectoryRef.current = directory;
    applyText("", []);
    setMention(null);
  }, [directory]);

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

  // 四个工具栏菜单互斥；点外部或按 Esc 一起收起，避免弹层叠在一起。
  useEffect(() => {
    if (!agentOpen && !modelOpen && !variantOpen && !workspaceOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!agentPickerRef.current?.contains(target)) setAgentOpen(false);
      if (!modelPickerRef.current?.contains(target)) setModelOpen(false);
      if (!variantPickerRef.current?.contains(target)) setVariantOpen(false);
      if (!workspacePickerRef.current?.contains(target)) setWorkspaceOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAgentOpen(false);
      setModelOpen(false);
      setVariantOpen(false);
      setWorkspaceOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [agentOpen, modelOpen, variantOpen, workspaceOpen]);

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

  const variants = useMemo(() => {
    if (!currentModel) return [] as string[];
    const match = models.find(
      (item) => item.id === currentModel.modelID && item.providerID === currentModel.providerID,
    );
    return (match?.variants ?? []).map((variant) => variant.id);
  }, [currentModel, models]);

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
    if (!key) return models.slice(0, 60);
    return models
      .filter(
        (item) =>
          (item.name ?? "").toLowerCase().includes(key) ||
          item.id.toLowerCase().includes(key) ||
          item.providerID.toLowerCase().includes(key),
      )
      .slice(0, 60);
  }, [models, keyword]);

  const submit = () => {
    const value = text.trim();
    if ((!value && attachments.length === 0) || !directory || streaming) return;
    const files = attachments;
    // 位置按真正发出去的文本重算（trim 会挪动下标），保证 source.text 与 text part 对得上
    const mentioned = parseMentions(value);
    lastSentRefs.current = mentioned;
    applyText("", []);
    setAttachments([]);
    setMention(null);
    void send(value, files, mentioned);
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
    <div className="composer">
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
              submit();
            }
          }}
          onPaste={handlePaste}
          onBlur={() => setMention(null)}
          placeholder={
            directory
              ? "发消息，@ 引用文件，可粘贴截图，Enter 发送"
              : "请先在左侧选择工作区"
          }
          rows={1}
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
            <div className="toolbar-picker agent-picker" ref={agentPickerRef}>
              <button
                type="button"
                className={`toolbar-pill agent-pill ${agentOpen ? "open" : ""}`}
                onClick={() => {
                  setAgentOpen((open) => !open);
                  setModelOpen(false);
                  setVariantOpen(false);
                }}
                title={`切换 Agent（当前：${selectedAgent}）`}
                aria-label={`切换 Agent，当前 ${selectedAgent}`}
                aria-haspopup="menu"
                aria-expanded={agentOpen}
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
                    {filtered.length === 0 && <div className="empty-line">没有匹配的模型</div>}
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
            {streaming ? (
              <button type="button" className="stop-btn" onClick={() => void stop()}>
                <Icon name="stop" size={12} />
                停止
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                onClick={submit}
                disabled={(!text.trim() && attachments.length === 0) || !directory}
                title="发送（Enter）"
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
