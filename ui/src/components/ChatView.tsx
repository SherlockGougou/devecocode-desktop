import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp } from "../store";
import type { Message, Part } from "../types";
import { parseMentions } from "../mentions";
import { copyText } from "../clipboard";
import {
  copyItem,
  referenceItem,
  revealItem,
  useContextMenu,
} from "../contextMenu";
import {
  absoluteWorkspacePath,
  normalizeWorkspacePath,
  relativeWorkspacePath,
} from "../paths";
import Markdown from "./Markdown";
import { Icon } from "./Icon";

const MAX_PREVIEW = 4000;
const MAX_ATTACHMENT_PREVIEW = 120_000;

function formatTime(ms?: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function preview(value: unknown) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}\n…` : text;
}

function fullValue(value: unknown) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** 只取用户可见的文本 part；synthetic 是 CLI 灌给模型的内部上下文，不能当正文。 */
function messageText(parts: Part[]) {
  return parts
    .filter((part) => part.type === "text" && !part.synthetic)
    .map((part) => part.text ?? "")
    .join("\n");
}

/** 消息是否有可展示内容；与 MessageRow 的提前返回保持一致，避免把空消息算成一次步骤。 */
function messageHasContent(message: Message) {
  if (message.info.role === "user") {
    const text = messageText(message.parts);
    return Boolean(text.trim()) || message.parts.some((part) => part.type === "file" && !part.synthetic);
  }
  return message.parts.some(
    (part) =>
      !part.synthetic &&
      ((part.type === "text" && Boolean(part.text)) ||
        part.type === "tool" ||
        part.type === "reasoning"),
  );
}

type InlineFileRef = {
  start: number;
  end: number;
  path: string;
};

function normalizePath(value: string) {
  return normalizeWorkspacePath(value);
}

/** 正文里的 @token 与 CLI 回传的 file part 做匹配；source 已被 CLI 丢弃，只能用 filename。 */
function resolveMentionFiles(text: string, files: Part[]) {
  const used = new Set<string>();
  const links: InlineFileRef[] = [];
  for (const ref of parseMentions(text)) {
    const exact = files.find(
      (part) => !used.has(part.id) && normalizePath(String(part.filename ?? "")) === normalizePath(ref.path),
    );
    const matched =
      exact ??
      files.find(
        (part) =>
          !used.has(part.id) &&
          typeof part.filename === "string" &&
          normalizePath(part.filename).endsWith(`/${normalizePath(ref.path)}`),
      );
    if (!matched) continue;
    used.add(matched.id);
    links.push({
      start: ref.start,
      end: ref.end,
      path: String(matched.filename ?? ref.path),
    });
  }
  return { links, used };
}

function UserBubbleText({
  text,
  links,
  directory,
  onOpenFile,
}: {
  text: string;
  links: InlineFileRef[];
  directory: string;
  onOpenFile: (path: string) => void;
}) {
  const menu = useContextMenu();
  if (links.length === 0) return <>{text}</>;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const link of [...links].sort((left, right) => left.start - right.start)) {
    if (link.start < cursor || link.end > text.length || link.start >= link.end) continue;
    if (link.start > cursor) nodes.push(text.slice(cursor, link.start));
    const relative = relativeWorkspacePath(directory, link.path);
    const absolute = absoluteWorkspacePath(directory, relative);
    nodes.push(
      <button
        type="button"
        className="file-ref"
        key={`file-ref-${link.start}`}
        title={`打开 ${link.path}`}
        aria-label={`打开文件 ${link.path}`}
        onClick={() => onOpenFile(link.path)}
        onContextMenu={(event) =>
          menu.open(
            event,
            [
              {
                type: "item",
                label: "打开文件",
                icon: "file",
                onSelect: () => onOpenFile(link.path),
              },
              referenceItem("引用到输入框", directory, relative),
              { type: "separator" },
              revealItem("在 Finder 中显示", absolute),
              copyItem("复制相对路径", relative, "相对路径已复制"),
              copyItem("复制绝对路径", absolute, "绝对路径已复制"),
            ],
            { label: "文件菜单" },
          )
        }
      >
        {text.slice(link.start, link.end)}
      </button>,
    );
    cursor = link.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

function UploadAttachments({
  parts,
  onOpen,
}: {
  parts: Part[];
  onOpen: (part: Part) => void;
}) {
  const menu = useContextMenu();
  return (
    <div className="bubble-files">
      {parts.map((part) => {
        const mime = String(part.mime ?? "");
        const name = String(part.filename ?? "附件");
        const image = mime.startsWith("image/") && typeof part.url === "string";
        return (
          <button
            type="button"
            className="message-attachment"
            key={part.id}
            title={`预览 ${name}`}
            aria-label={`预览附件 ${name}`}
            onClick={() => onOpen(part)}
            onContextMenu={(event) =>
              menu.open(
                event,
                [
                  {
                    type: "item",
                    label: "打开附件",
                    icon: image ? "image" : "file",
                    onSelect: () => onOpen(part),
                  },
                  copyItem("复制文件名", name, "文件名已复制"),
                ],
                { label: "附件菜单" },
              )
            }
          >
            {image ? <img src={String(part.url)} alt="" /> : <Icon name="file" size={14} />}
            <span className="message-attachment-name">{name}</span>
          </button>
        );
      })}
    </div>
  );
}

function isTextMime(mime: string, name: string) {
  return (
    mime.startsWith("text/") ||
    /(?:json|xml|yaml|toml|javascript|typescript)/.test(mime) ||
    /\.(md|markdown|txt|json|ya?ml|toml|xml|html?|css|jsx?|tsx?|rs|swift|kt|java|py|go|c|h|cpp|sh|zsh|sql|log|csv)$/i.test(
      name,
    )
  );
}

function decodeDataURL(url: string) {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma === -1) return null;
  const metadata = url.slice(5, comma);
  const body = url.slice(comma + 1);
  try {
    if (metadata.includes(";base64")) {
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(body);
  } catch {
    return null;
  }
}

function attachmentText(part: Part) {
  const name = String(part.filename ?? "");
  const mime = String(part.mime ?? "");
  if (!isTextMime(mime, name)) return null;
  const text = decodeDataURL(String(part.url ?? ""));
  if (text === null) return null;
  return text.length > MAX_ATTACHMENT_PREVIEW
    ? `${text.slice(0, MAX_ATTACHMENT_PREVIEW)}\n…`
    : text;
}

function AttachmentViewer({ part, onClose }: { part: Part; onClose: () => void }) {
  const name = String(part.filename ?? "附件");
  const mime = String(part.mime ?? "");
  const url = String(part.url ?? "");
  const image = mime.startsWith("image/") && Boolean(url);
  const text = useMemo(() => (image ? null : attachmentText(part)), [image, part]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="attachment-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="attachment-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={name}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="attachment-viewer-head">
          <Icon name={image ? "image" : "file"} size={15} />
          <span className="attachment-viewer-name" title={name}>
            {name}
          </span>
          <button className="mini-btn" onClick={onClose} title="关闭" aria-label="关闭" autoFocus>
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="attachment-viewer-body">
          {image ? (
            <img src={url} alt={name} />
          ) : text !== null ? (
            <pre>{text}</pre>
          ) : (
            <div className="empty-line">此类型暂不支持预览</div>
          )}
        </div>
        <div className="attachment-viewer-actions">
          {url && (
            <a className="ghost-btn" href={url} download={name}>
              <Icon name="download" size={14} />
              下载
            </a>
          )}
          <button className="ghost-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolCard({ part }: { part: Part }) {
  const menu = useContextMenu();
  const state = part.state ?? {};
  const status = state.status ?? "pending";
  const statusLabel = status === "running" ? "执行中" : status === "error" ? "失败" : null;
  const contextItems = [
    ...(state.input !== undefined
      ? [copyItem("复制工具输入", fullValue(state.input), "工具输入已复制")]
      : []),
    ...(state.output !== undefined
      ? [copyItem("复制工具输出", fullValue(state.output), "工具输出已复制")]
      : []),
  ];
  return (
    <details
      className={`tool ${status}`}
      open={status === "error"}
      onContextMenu={
        contextItems.length > 0
          ? (event) => menu.open(event, contextItems, { label: "工具菜单" })
          : undefined
      }
    >
      <summary>
        <span className={`tool-state ${status}`}>
          {status === "completed" && <Icon name="check" size={13} strokeWidth={2.1} />}
          {status === "error" && <Icon name="alert" size={13} />}
          {status === "running" && <span className="tool-spinner" />}
          {status !== "completed" && status !== "error" && status !== "running" && (
            <span className="tool-pending" />
          )}
        </span>
        <span className="tool-name">{part.tool ?? "tool"}</span>
        {state.title && <span className="tool-title">{state.title}</span>}
        {statusLabel && <span className={`tool-status ${status}`}>{statusLabel}</span>}
        <Icon name="chevron-right" size={13} className="caret tool-caret" />
      </summary>
      <div className="tool-body">
        {state.input !== undefined && (
          <>
            <div className="tool-label">输入</div>
            <pre>{preview(state.input)}</pre>
          </>
        )}
        {state.output !== undefined && (
          <>
            <div className="tool-label">输出</div>
            <pre>{preview(state.output)}</pre>
          </>
        )}
      </div>
    </details>
  );
}

function ToolGroup({ parts }: { parts: Part[] }) {
  return (
    <div className="tool-group">
      {parts.map((part) => (
        <ToolCard key={part.id} part={part} />
      ))}
    </div>
  );
}

type Block = { kind: "tool"; parts: Part[] } | { kind: "part"; part: Part };

/** 相邻工具调用合成一组，避免一次任务把消息流切成一长串大卡片。 */
function groupParts(parts: Part[]): Block[] {
  const blocks: Block[] = [];
  for (const part of parts) {
    if (part.synthetic) continue;
    if (part.type === "tool") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "tool") last.parts.push(part);
      else blocks.push({ kind: "tool", parts: [part] });
      continue;
    }
    blocks.push({ kind: "part", part });
  }
  return blocks;
}

function AssistantBlocks({ parts }: { parts: Part[] }) {
  const menu = useContextMenu();
  return (
    <>
      {groupParts(parts).map((block) => {
        if (block.kind === "tool") {
          return <ToolGroup key={block.parts[0].id} parts={block.parts} />;
        }
        const part = block.part;
        if (part.type === "text") {
          return part.text ? <Markdown key={part.id} text={part.text} /> : null;
        }
        if (part.type === "reasoning") {
          if (!part.text) return null;
          const time = part.time as { start?: number; end?: number } | undefined;
          const running = !time?.end;
          const seconds =
            time?.start && time?.end ? Math.max(0.1, (time.end - time.start) / 1000).toFixed(1) : null;
          return (
            <details
              key={part.id}
              className={`reasoning${running ? " running" : ""}`}
              open={running}
              onContextMenu={(event) =>
                menu.open(
                  event,
                  [copyItem("复制思考内容", part.text ?? "", "思考内容已复制")],
                  { label: "思考菜单" },
                )
              }
            >
              <summary>
                <Icon name="spark" size={13} className="reasoning-icon" />
                <span className="reasoning-label">{running ? "思考中" : "思考"}</span>
                {seconds && <span className="reasoning-time">{seconds}s</span>}
                <Icon name="chevron-right" size={12} className="caret" />
              </summary>
              <div className="reasoning-body">{part.text}</div>
            </details>
          );
        }
        if (part.type === "file") return null;
        if (part.type === "step-start" || part.type === "step-finish") return null;
        return null;
      })}
    </>
  );
}

/** 进行中的最后一段文字没有可展开的卡片，用底部状态提示“还在写”。 */
function LiveActivity({ parts }: { parts: Part[] }) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part.synthetic) continue;
    if (part.type === "tool") {
      const status = part.state?.status;
      return status === "running" || status === "pending" ? null : <LiveLabel text="正在准备" />;
    }
    if (part.type === "reasoning") {
      const time = part.time as { end?: number } | undefined;
      return time?.end ? <LiveLabel text="正在准备" /> : null;
    }
    if (part.type === "text" && part.text) return <LiveLabel text="正在生成" />;
  }
  return <LiveLabel text="正在准备" />;
}

function LiveLabel({ text }: { text: string }) {
  return (
    <div className="live-activity" role="status">
      <span className="live-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{text}</span>
    </div>
  );
}

export default function ChatView() {
  const messages = useApp((s) => s.messages);
  const sessionID = useApp((s) => s.sessionID);
  const sessions = useApp((s) => s.sessions);
  const directory = useApp((s) => s.directory);
  const permissions = useApp((s) => s.permissions);
  const streaming = useApp((s) => s.streaming);
  const newSession = useApp((s) => s.newSession);
  const replyPermission = useApp((s) => s.replyPermission);
  const openFile = useApp((s) => s.openFile);
  const toggleRight = useApp((s) => s.toggleRight);
  const openSettings = useApp((s) => s.openSettings);
  const menu = useContextMenu();
  const [attachmentPreview, setAttachmentPreview] = useState<Part | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const findOpen = useApp((s) => s.findOpen);
  const findQuery = useApp((s) => s.findQuery);
  const findIndex = useApp((s) => s.findIndex);
  const closeFind = useApp((s) => s.closeFind);
  const setFindQuery = useApp((s) => s.setFindQuery);
  const stepFind = useApp((s) => s.stepFind);
  const exportCurrentSession = useApp((s) => s.exportCurrentSession);

  const title = useMemo(() => {
    if (!directory || !sessionID) return "";
    return (
      (sessions[directory] ?? []).find((s) => s.id === sessionID)?.title ??
      (sessionID ? "会话" : "")
    );
  }, [directory, sessionID, sessions]);

  useEffect(() => {
    // 用户往上翻的时候不要把他拽回底部
    if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages, permissions.length, streaming]);

  const pending = permissions.filter((p) => p.sessionID === sessionID);

  const matches = useMemo(() => {
    const keyword = findQuery.trim().toLowerCase();
    if (!keyword) return [];
    return messages.filter((message) =>
      messageText(message.parts).toLowerCase().includes(keyword),
    );
  }, [messages, findQuery]);

  const visibleMessages = findQuery.trim() ? matches : messages;

  const liveMessageId = useMemo(() => {
    if (!streaming) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.info.role !== "assistant") continue;
      // 上一步已经完成、下一步还没落库时，不要把“正在生成”挂到旧消息下面。
      return message.info.time?.completed ? null : message.info.id;
    }
    return null;
  }, [messages, streaming]);

  const continued = useMemo(() => {
    const flags = new Map<string, boolean>();
    let previousRole: Message["info"]["role"] | null = null;
    for (const message of visibleMessages) {
      if (!messageHasContent(message) && message.info.id !== liveMessageId) continue;
      flags.set(message.info.id, message.info.role === "assistant" && previousRole === "assistant");
      previousRole = message.info.role;
    }
    return flags;
  }, [visibleMessages, liveMessageId]);

  useEffect(() => {
    if (!findQuery.trim() || matches.length === 0) return;
    const target = matches[Math.min(findIndex, matches.length - 1)];
    document.getElementById(`msg-${target.info.id}`)?.scrollIntoView({ block: "center" });
  }, [findIndex, findQuery, matches]);

  return (
    <section
      className="chat"
      onContextMenu={(event) =>
        menu.open(
          event,
          [
            {
              type: "item",
              label: "复制会话标题",
              icon: "copy",
              disabled: !title,
              onSelect: async () => {
                await copyText(title, "会话标题已复制");
              },
            },
            {
              type: "item",
              label: "导出当前会话",
              icon: "download",
              shortcut: "⌘E",
              disabled: !sessionID,
              onSelect: () => exportCurrentSession(),
            },
            {
              type: "item",
              label: "在会话中查找",
              icon: "search",
              shortcut: "⌘F",
              disabled: !sessionID,
              onSelect: () => useApp.getState().openFind(),
            },
            { type: "separator" },
            {
              type: "item",
              label: "新建会话",
              icon: "compose",
              shortcut: "⌘N",
              disabled: !directory,
              onSelect: () => newSession(),
            },
            {
              type: "item",
              label: "切换右侧面板",
              icon: "panel-right",
              shortcut: "⌘⇧B",
              onSelect: toggleRight,
            },
            {
              type: "item",
              label: "打开设置",
              icon: "sliders",
              shortcut: "⌘,",
              onSelect: openSettings,
            },
          ],
          { label: "对话菜单" },
        )
      }
    >
      <div className="chat-head">
        <div className="chat-title">
          {title || "DevEco Code"}
          {streaming && <span className="streaming">· 执行中</span>}
        </div>
        <div className="chat-actions">
          <button
            className="ghost-btn"
            onClick={() => void exportCurrentSession()}
            disabled={!sessionID}
            title="导出当前会话 (⌘E)"
          >
            <Icon name="download" size={15} />
            导出
          </button>
        </div>
      </div>

      {findOpen && (
        <div className="findbar">
          <span className="find-icon">
            <Icon name="search" size={16} />
          </span>
          <input
            autoFocus
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeFind();
              if (event.key === "Enter") stepFind(event.shiftKey ? -1 : 1);
            }}
            placeholder="在会话中查找（Enter 下一个，Esc 关闭）"
          />
          <span className="find-count">
            {findQuery.trim() ? `${matches.length === 0 ? 0 : Math.min(findIndex + 1, matches.length)}/${matches.length}` : ""}
          </span>
          <button className="mini-btn" onClick={() => stepFind(-1)} title="上一个" aria-label="上一个匹配">
            <Icon name="arrow-up" size={15} />
          </button>
          <button className="mini-btn" onClick={() => stepFind(1)} title="下一个" aria-label="下一个匹配">
            <Icon name="arrow-down" size={15} />
          </button>
          <button className="mini-btn" onClick={closeFind} title="关闭" aria-label="关闭查找">
            <Icon name="close" size={15} />
          </button>
        </div>
      )}

      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        }}
      >
        {!sessionID && (
          <div className="welcome">
            <div className="welcome-mark">D</div>
            <h2>开始一个会话</h2>
            <p>在下方输入需求，或从左侧选择一个已有会话。</p>
            <button className="primary-btn" onClick={() => void newSession()} disabled={!directory}>
              <Icon name="plus" size={15} strokeWidth={2} />
              新建会话
            </button>
          </div>
        )}

        {visibleMessages.map((message, index) => (
          <div
            id={`msg-${message.info.id}`}
            key={message.info.id}
            className={findQuery.trim() && index === findIndex ? "find-hit" : undefined}
          >
            <MessageRow
              message={message}
              continued={continued.get(message.info.id) ?? false}
              live={message.info.id === liveMessageId}
              directory={directory ?? ""}
              onOpenFile={(path) => void openFile(path)}
              onOpenAttachment={setAttachmentPreview}
            />
          </div>
        ))}
        {findQuery.trim() !== "" && matches.length === 0 && (
          <div className="empty-line">没有匹配的消息</div>
        )}

        {pending.map((permission) => (
          <div className="permission" key={permission.id}>
            <div className="permission-head">
              <Icon name="alert" size={15} className="permission-icon" />
              <span className="permission-badge">需要授权</span>
              <span className="permission-name">{permission.permission}</span>
            </div>
            {permission.patterns.length > 0 && (
              <div className="permission-patterns">
                {permission.patterns.map((pattern) => (
                  <code key={pattern}>{pattern}</code>
                ))}
              </div>
            )}
            <div className="permission-actions">
              <button
                className="primary-btn small"
                onClick={() => void replyPermission(permission.id, "once")}
              >
                允许一次
              </button>
              <button className="ghost-btn" onClick={() => void replyPermission(permission.id, "always")}>
                总是允许
              </button>
              <button
                className="ghost-btn danger"
                onClick={() => void replyPermission(permission.id, "reject")}
              >
                拒绝
              </button>
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>
      {attachmentPreview && (
        <AttachmentViewer
          part={attachmentPreview}
          onClose={() => setAttachmentPreview(null)}
        />
      )}
    </section>
  );
}

function MessageRow({
  message,
  continued,
  live,
  directory,
  onOpenFile,
  onOpenAttachment,
}: {
  message: Message;
  continued: boolean;
  live: boolean;
  directory: string;
  onOpenFile: (path: string) => void;
  onOpenAttachment: (part: Part) => void;
}) {
  const menu = useContextMenu();
  if (message.info.role === "user") {
    const text = messageText(message.parts);
    const files = message.parts.filter((part) => part.type === "file" && !part.synthetic);
    if (!text.trim() && files.length === 0) return null;
    const { links, used } = resolveMentionFiles(text, files);
    const uploads = files.filter((part) => !used.has(part.id));
    return (
      <div
        className="row user"
        onContextMenu={
          text.trim()
            ? (event) =>
                menu.open(event, [copyItem("复制消息", text, "消息已复制")], {
                  label: "用户消息菜单",
                })
            : undefined
        }
      >
        <div className="bubble-wrap">
          {uploads.length > 0 && (
            <UploadAttachments parts={uploads} onOpen={onOpenAttachment} />
          )}
          {text.trim() && (
            <div className="bubble">
              <UserBubbleText
                text={text}
                links={links}
                directory={directory}
                onOpenFile={onOpenFile}
              />
            </div>
          )}
          <MessageMeta text={text} time={formatTime(message.info.time?.created)} />
        </div>
      </div>
    );
  }
  if (!messageHasContent(message) && !live) return null;
  const text = messageText(message.parts);
  return (
    <div
      className={`row assistant${continued ? " continued" : ""}${live ? " live" : ""}`}
      onContextMenu={
        text.trim()
          ? (event) =>
              menu.open(event, [copyItem("复制消息", text, "消息已复制")], {
                label: "助手消息菜单",
              })
          : undefined
      }
    >
      <div className="avatar-slot">
        {continued ? <span className="step-dot" /> : <div className="avatar">D</div>}
      </div>
      <div className="assistant-body">
        {message.info.error && (
          <div className="msg-error">
            {message.info.error.data?.message ?? message.info.error.name ?? "执行出错"}
          </div>
        )}
        <AssistantBlocks parts={message.parts} />
        {live && <LiveActivity parts={message.parts} />}
        <MessageMeta
          text={text}
          time={formatTime(message.info.time?.created)}
        />
      </div>
    </div>
  );
}

function MessageMeta({ text, time }: { text: string; time: string }) {
  return (
    <div className="msg-meta">
      <CopyButton text={text} />
      {time && <span className="msg-time">{time}</span>}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  if (!text.trim()) return null;
  return (
    <button
      className="mini-btn copy-btn"
      title="复制"
      onClick={async () => {
        const ok = await copyText(text, null);
        if (ok) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }
      }}
    >
      <Icon name={done ? "check" : "copy"} size={14} />
      {done ? "已复制" : "复制"}
    </button>
  );
}
