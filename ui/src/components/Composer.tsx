import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, MentionRef } from "../types";
import { api } from "../api";
import { useApp } from "../store";
import { Icon } from "./Icon";

/** 一次最多引用多少个文件：超过后不再插入，避免把整个目录塞进上下文 */
const MAX_REFS = 8;
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
 * 从文本解析全部 @ 引用，触发规则与 detectMention 保持一致。
 * 文本是唯一事实来源：输入框上方的 chip、发送时的 file part 都从它派生。
 * 未闭合的引号 token 不算引用（用户可能还在输入）；按路径去重。
 */
function parseMentions(value: string): MentionRef[] {
  const pattern = /(?:^|\s)(@"[^"\n]+"|@[^\s@"][^\s@]*)/gm;
  const refs: MentionRef[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(pattern)) {
    const token = match[1];
    const start = (match.index ?? 0) + match[0].length - token.length;
    const path = token.startsWith('@"') ? token.slice(2, -1) : token.slice(1);
    // 目录项（以 / 结尾）不能作为文件引用，和弹层过滤保持同一规则
    if (!path || path.endsWith("/") || seen.has(path)) continue;
    seen.add(path);
    refs.push({ path, token, start, end: start + token.length });
    if (refs.length >= MAX_REFS) break;
  }
  return refs;
}

/**
 * 取 @ 弹层的候选文件。
 * `/find/file` 的 query 必须存在，但值可以是空串——空串返回工作区文件列表，
 * 所以刚敲下 @ 时也能直接列出候选（Rust 代理已保留空值参数）。
 */
function loadMentionFiles(directory: string, query: string): Promise<string[]> {
  return api.searchFiles(directory, query);
}

export default function Composer() {
  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const streaming = useApp((s) => s.streaming);
  const directory = useApp((s) => s.directory);
  const models = useApp((s) => s.models);
  const agents = useApp((s) => s.agents);
  const selectedAgent = useApp((s) => s.selectedAgent);
  const selectAgent = useApp((s) => s.selectAgent);
  const commands = useApp((s) => s.commands);
  const selectedVariant = useApp((s) => s.selectedVariant);
  const selectVariant = useApp((s) => s.selectVariant);
  const [agentOpen, setAgentOpen] = useState(false);
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const failedText = useApp((s) => s.failedText);
  const clearFailedText = useApp((s) => s.clearFailedText);
  /** 上次发送的引用：失败恢复原文时用它把 chip 一起还回来 */
  const lastSentRefs = useRef<MentionRef[]>([]);
  const [keyword, setKeyword] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!pickerOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [pickerOpen]);

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

  const MAX_FILE = 8 * 1024 * 1024;

  const readFile = (file: File) =>
    new Promise<Attachment | null>((resolve) => {
      if (file.size > MAX_FILE) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          id: `${file.name}-${file.lastModified}`,
          name: file.name,
          mime: file.type || "application/octet-stream",
          url: String(reader.result ?? ""),
          size: file.size,
        });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });

  const pickFiles = async (list: FileList | null) => {
    if (!list) return;
    const picked = await Promise.all(Array.from(list).slice(0, 4).map(readFile));
    const valid = picked.filter((item): item is Attachment => Boolean(item));
    if (valid.length > 0) setAttachments((current) => [...current, ...valid].slice(0, 4));
    if (fileInputRef.current) fileInputRef.current.value = "";
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
        {refs.length > 0 && (
          <div className="ref-row">
            {refs.map((ref) => (
              <span className="ref-chip" key={ref.path} title={`引用：${ref.path}`}>
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
              <span className="attachment-chip" key={file.id} title={`${file.name} · ${Math.round(file.size / 1024)}KB`}>
                <Icon name={file.mime.startsWith("image/") ? "image" : "file"} size={14} />
                {file.name}
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
          onBlur={() => setMention(null)}
          placeholder={
            directory
              ? "发消息给 DevEco Code，输入 @ 引用工作区文件，Shift + Enter 换行"
              : "请先在左侧选择工作区"
          }
          rows={1}
          disabled={!directory}
        />
        <div className="composer-actions">
          <div className="composer-left">
            <button
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              title="添加附件（最多 4 个，单个不超过 8MB）"
              disabled={!directory}
            >
              <Icon name="paperclip" size={17} />
            </button>
            <div className="agent-picker">
              <button
                className="model-chip"
                onClick={() => setAgentOpen((open) => !open)}
                title="切换 Agent（Build / Plan / Debug…）"
              >
                <span className="agent-dot" />
                {selectedAgent}
              </button>
              {agentOpen && (
                <div className="model-pop">
                  {agents.map((agent) => (
                    <button
                      key={agent.name}
                      className={`model-item ${agent.name === selectedAgent ? "active" : ""}`}
                      onClick={() => {
                        selectAgent(agent.name);
                        setAgentOpen(false);
                      }}
                      title={agent.description}
                    >
                      <span className="model-name">{agent.name}</span>
                    </button>
                  ))}
                  {agents.length === 0 && <div className="empty-line">没有可用 Agent</div>}
                </div>
              )}
            </div>
            {variants.length > 0 && (
              <button
                className={`variant-chip ${selectedVariant ? "on" : ""}`}
                title="推理强度（model variant）"
                onClick={() => {
                  const index = selectedVariant ? variants.indexOf(selectedVariant) : -1;
                  const next = index + 1 >= variants.length ? null : variants[index + 1];
                  selectVariant(next);
                }}
              >
                {selectedVariant ?? "默认档"}
              </button>
            )}
            <div className="model-picker" ref={pickerRef}>
              <button
                className={`model-chip ${pickerOpen ? "open" : ""}`}
                onClick={() => setPickerOpen((open) => !open)}
                title="切换模型"
              >
                <span className="model-dot" />
                {modelLabel}
                <Icon name="chevron-down" size={14} className="model-caret" />
              </button>
              {pickerOpen && (
                <div className="model-pop">
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
                          key={`${item.providerID}/${item.id}`}
                          className={`model-item ${active ? "active" : ""}`}
                          onClick={() => {
                            selectModel({ providerID: item.providerID, modelID: item.id });
                            setPickerOpen(false);
                          }}
                        >
                          <span className="model-name">{item.name ?? item.id}</span>
                          <span className="model-provider">{item.providerID}</span>
                        </button>
                      );
                    })}
                    {filtered.length === 0 && <div className="empty-line">没有匹配的模型</div>}
                  </div>
                </div>
              )}
            </div>
            <span className="composer-hint">{streaming ? "Agent 正在执行…" : "Enter 发送"}</span>
          </div>
          {streaming ? (
            <button className="stop-btn" onClick={() => void stop()}>
              <Icon name="stop" size={12} />
              停止
            </button>
          ) : (
            <button
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
  );
}
