import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../store";
import type { Message, Part } from "../types";
import Markdown from "./Markdown";

const MAX_PREVIEW = 4000;

function formatTime(ms?: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function preview(value: unknown) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}\n…` : text;
}

function ToolCard({ part }: { part: Part }) {
  const state = part.state ?? {};
  const status = state.status ?? "pending";
  const label: Record<string, string> = {
    pending: "等待",
    running: "执行中",
    completed: "完成",
    error: "失败",
  };
  return (
    <details className={`tool ${status}`}>
      <summary>
        <span className="tool-dot" />
        <span className="tool-name">{part.tool ?? "tool"}</span>
        <span className={`tool-status ${status}`}>{label[status] ?? status}</span>
        {state.title && <span className="tool-title">{state.title}</span>}
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

function AssistantBlocks({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((part) => {
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
            <details key={part.id} className="reasoning" open={running}>
              <summary>{running ? "思考中…" : `思考过程${seconds ? ` · ${seconds}s` : ""}`}</summary>
              <div className="reasoning-body">{part.text}</div>
            </details>
          );
        }
        if (part.type === "tool") return <ToolCard key={part.id} part={part} />;
        if (part.type === "file") return null;
        if (part.type === "step-start" || part.type === "step-finish") return null;
        return null;
      })}
    </>
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
      message.parts.some(
        (part) => part.type === "text" && (part.text ?? "").toLowerCase().includes(keyword),
      ),
    );
  }, [messages, findQuery]);

  const visibleMessages = findQuery.trim() ? matches : messages;

  useEffect(() => {
    if (!findQuery.trim() || matches.length === 0) return;
    const target = matches[Math.min(findIndex, matches.length - 1)];
    document.getElementById(`msg-${target.info.id}`)?.scrollIntoView({ block: "center" });
  }, [findIndex, findQuery, matches]);

  return (
    <section className="chat">
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
            导出
          </button>
          <button className="ghost-btn" onClick={() => void api.openClassicView()}>
            经典界面
          </button>
        </div>
      </div>

      {findOpen && (
        <div className="findbar">
          <span className="find-icon">⌕</span>
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
          <button className="mini-btn" onClick={() => stepFind(-1)} title="上一个">
            ↑
          </button>
          <button className="mini-btn" onClick={() => stepFind(1)} title="下一个">
            ↓
          </button>
          <button className="mini-btn" onClick={closeFind} title="关闭">
            ✕
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
            <MessageRow message={message} />
          </div>
        ))}
        {findQuery.trim() !== "" && matches.length === 0 && (
          <div className="empty-line">没有匹配的消息</div>
        )}

        {pending.map((permission) => (
          <div className="permission" key={permission.id}>
            <div className="permission-head">
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
    </section>
  );
}

function MessageRow({ message }: { message: Message }) {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    const files = message.parts.filter((part) => part.type === "file");
    if (!text.trim() && files.length === 0) return null;
    return (
      <div className="row user">
        <div className="bubble-wrap">
          {files.length > 0 && (
            <div className="bubble-files">
              {files.map((part) => (
                <span className="attachment-chip" key={part.id} title={String(part.filename ?? "")}>
                  {String(part.mime ?? "").startsWith("image/") ? "🖼" : "📄"}{" "}
                  {String(part.filename ?? "附件")}
                </span>
              ))}
            </div>
          )}
          {text.trim() && <div className="bubble">{text}</div>}
          <div className="msg-actions">
            <CopyButton text={text} />
          </div>
          <div className="msg-time">{formatTime(message.info.time?.created)}</div>
        </div>
      </div>
    );
  }
  const hasContent = message.parts.some(
    (part) => (part.type === "text" && part.text) || part.type === "tool" || part.type === "reasoning",
  );
  if (!hasContent) return null;
  return (
    <div className="row assistant">
      <div className="avatar">D</div>
      <div className="assistant-body">
        <div className="assistant-actions">
          <span className="msg-time">{formatTime(message.info.time?.created)}</span>
          <CopyButton
            text={message.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n")}
          />
        </div>
        {message.info.error && (
          <div className="msg-error">
            {message.info.error.data?.message ?? message.info.error.name ?? "执行出错"}
          </div>
        )}
        <AssistantBlocks parts={message.parts} />
      </div>
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
        const ok = await copyText(text);
        if (ok) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }
      }}
    >
      {done ? "已复制" : "复制"}
    </button>
  );
}
