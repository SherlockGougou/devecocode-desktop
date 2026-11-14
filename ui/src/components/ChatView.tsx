import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  messageEditProblem,
  useApp,
  type MessageEditTarget,
} from "../store";
import type { Message, Part } from "../types";
import { matchMentionFiles, type InlineFileRef } from "../mentions";
import { copyText } from "../clipboard";
import { onAppEvent } from "../appEvents";
import {
  copyItem,
  referenceItem,
  revealItem,
  useContextMenu,
  type ContextMenuEntry,
} from "../contextMenu";
import {
  absoluteWorkspacePath,
  relativeWorkspacePath,
} from "../paths";
import Markdown from "./Markdown";
import InlineImage from "./InlineImage";
import { Icon } from "./Icon";
import { TaskProgressBar, TaskStatusBadge, formatTaskDuration } from "./TasksPanel";
import {
  buildSubagentTasks,
  latestTaskActivity,
  taskFromPart,
  todoProgress,
} from "../tasks";
import {
  copyImageSource,
  imageFileName,
  saveImageSource,
} from "../imageActions";
import { ImageGroup } from "../imageViewer";
import { AppIcon } from "./AppIcon";
import MessageEditor from "./MessageEditor";
import {
  questionInputQuestions,
  questionRequestMatchesPart,
  questionResultAnswers,
} from "../questions";

const MAX_PREVIEW = 4000;
const MAX_ATTACHMENT_PREVIEW = 120_000;

function formatTime(ms?: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

type MessageMetaOverride = {
  text: string;
  time: string;
  count: number;
};

/** 同一分钟内的连续助手步骤视为一组，共用一个操作行。 */
function inSameMinute(left: Message, right: Message) {
  if (
    left.info.parentID &&
    right.info.parentID &&
    left.info.parentID !== right.info.parentID
  ) {
    return false;
  }
  const leftTime = left.info.time?.created;
  const rightTime = right.info.time?.created;
  return Boolean(
    leftTime &&
      rightTime &&
      Math.floor(leftTime / 60_000) === Math.floor(rightTime / 60_000),
  );
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

/** 图片 file part 直接挂在助手消息上；Read 读图则走 tool state.attachments。 */
function isImagePart(part: Part) {
  if (part.type !== "file" || part.synthetic) return false;
  const url = typeof part.url === "string" ? part.url : "";
  if (!url) return false;
  const mime = String(part.mime ?? "");
  return mime.startsWith("image/") || url.startsWith("data:image/");
}

type ToolImagePreview = { id: string; src: string; name: string };

/** CLI 的 Read 工具把图片放在 state.attachments，而不是单独的 file part。 */
function toolImageAttachments(part: Part): ToolImagePreview[] {
  if (part.synthetic) return [];
  const attachments = part.state?.attachments;
  if (!Array.isArray(attachments)) return [];
  const images = attachments.filter((attachment) => {
    const url = typeof attachment.url === "string" ? attachment.url : "";
    const mime = String(attachment.mime ?? "");
    return Boolean(url) && (mime.startsWith("image/") || url.startsWith("data:image/"));
  });
  if (images.length === 0) return [];
  const input = part.state?.input;
  const inputPath =
    input && typeof input === "object" && !Array.isArray(input)
      ? String(
          (input as Record<string, unknown>).filePath ??
            (input as Record<string, unknown>).path ??
            "",
        )
      : "";
  const fallbackName =
    inputPath.split(/[\\/]/).filter(Boolean).pop() || "图片";
  return images.map((attachment, index) => {
    const name =
      typeof attachment.filename === "string" && attachment.filename.trim()
        ? attachment.filename
        : fallbackName;
    return {
      id:
        typeof attachment.id === "string"
          ? attachment.id
          : `${part.id}-image-${index}`,
      src: String(attachment.url),
      name: images.length > 1 ? `${index + 1}/${images.length} ${name}` : name,
    };
  });
}

/** 消息是否有可展示内容；与 MessageRow 的提前返回保持一致，避免把空消息算成一次步骤。 */
function messageHasContent(message: Message) {
  if (message.info.role === "user") {
    const text = messageText(message.parts);
    return (
      Boolean(text.trim()) ||
      message.parts.some(
        (part) =>
          !part.synthetic && (part.type === "file" || part.type === "subtask"),
      )
    );
  }
  return message.parts.some(
    (part) =>
      !part.synthetic &&
      ((part.type === "text" && Boolean(part.text)) ||
        part.type === "tool" ||
        part.type === "subtask" ||
        part.type === "reasoning" ||
        isImagePart(part)),
  );
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
                  ...(image
                    ? [
                        {
                          type: "item" as const,
                          label: "复制图片",
                          icon: "copy" as const,
                          onSelect: () => copyImageSource(String(part.url), null),
                        },
                        {
                          type: "item" as const,
                          label: "图片另存为…",
                          icon: "download" as const,
                          onSelect: () =>
                            saveImageSource(
                              String(part.url),
                              null,
                              imageFileName(String(part.url), name),
                            ),
                        },
                      ]
                    : []),
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

function AttachmentViewer({
  part,
  directory,
  onClose,
}: {
  part: Part;
  directory?: string;
  onClose: () => void;
}) {
  const name = String(part.filename ?? "附件");
  const mime = String(part.mime ?? "");
  const url = String(part.url ?? "");
  const image =
    (mime.startsWith("image/") || /^data:image\//i.test(url)) && Boolean(url);
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
            <InlineImage
              src={url}
              alt={name}
              directory={directory}
              preview={false}
            />
          ) : text !== null ? (
            <pre>{text}</pre>
          ) : (
            <div className="empty-line">此类型暂不支持预览</div>
          )}
        </div>
        <div className="attachment-viewer-actions">
          {image && (
            <>
              <button
                className="ghost-btn"
                onClick={() => void copyImageSource(url, directory ?? null)}
              >
                <Icon name="copy" size={14} />
                复制图片
              </button>
              <button
                className="ghost-btn"
                onClick={() =>
                  void saveImageSource(
                    url,
                    directory ?? null,
                    imageFileName(url, name, mime),
                  )
                }
              >
                <Icon name="download" size={14} />
                另存为…
              </button>
            </>
          )}
          {!image && url && (
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

function questionErrorText(error: unknown): string {
  if (error === undefined || error === null) return "";
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * `question` 是 CLI 的交互工具，不是普通 shell 工具。
 * 请求通过 question.asked 单独到达，并带 messageID/callID 对回当前 tool part。
 */
function QuestionToolCard({ part }: { part: Part }) {
  const requests = useApp((s) => s.questions);
  const results = useApp((s) => s.questionResults);
  const menu = useContextMenu();
  const state = part.state ?? {};
  const status = state.status ?? "pending";
  const inputQuestions = useMemo(
    () => questionInputQuestions(state.input),
    [state.input],
  );
  const request = useMemo(
    () =>
      requests.find((item) =>
        questionRequestMatchesPart(item, part),
      ),
    [requests, part.sessionID, part.messageID, part.callID],
  );
  const questions = request?.questions.length
    ? request.questions
    : inputQuestions;
  const [seenRequestID, setSeenRequestID] = useState<string | null>(
    request?.id ?? null,
  );

  useEffect(() => {
    if (request) {
      setSeenRequestID(request.id);
    }
  }, [request?.id]);

  const result = seenRequestID ? results[seenRequestID] : undefined;
  const answers = questionResultAnswers(result, state.metadata);
  const error = questionErrorText(state.error);
  const rejected =
    result?.status === "rejected" ||
    (status === "error" && /dismiss|rejected|取消|跳过/i.test(error));
  const answered =
    result?.status === "replied" ||
    status === "completed" ||
    answers.some((answer) => answer.length > 0);
  const failed = status === "error" && !rejected;
  const aborted = status === "interrupted" && !answered && !rejected;
  const answeredCount = questions.reduce(
    (count, _question, index) =>
      count + ((answers[index]?.length ?? 0) > 0 ? 1 : 0),
    0,
  );
  const waiting =
    !request &&
    !answered &&
    !rejected &&
    (status === "running" || status === "pending");

  if (questions.length === 0) return <ToolCard part={part} />;
  if (request || waiting) {
    return (
      <div className="question-inline-note">
        <Icon name="question" size={13} />
        <span>{request ? "请在下方回答问题" : "正在同步问题请求…"}</span>
      </div>
    );
  }

  const contextItems = [
    copyItem(
      "复制问题",
      questions
        .map(
          (question) =>
            `${question.header}\n${question.question}\n${question.options
              .map((option) => `- ${option.label}${option.description ? `：${option.description}` : ""}`)
              .join("\n")}`,
        )
        .join("\n\n"),
      "问题已复制",
    ),
    ...(answers.some((answer) => answer.length > 0)
      ? [
          copyItem(
            "复制回答",
            questions
              .map(
                (question, index) =>
                  `${question.header}：${answers[index]?.join("、") || "未回答"}`,
              )
              .join("\n"),
            "回答已复制",
          ),
        ]
      : []),
  ];

  const summary = failed
    ? "问题失败"
    : rejected
      ? "已跳过"
      : aborted
        ? "已中止"
        : answeredCount > 0
          ? `${answeredCount}/${questions.length} 已回答`
          : "已回答";
  return (
    <details
      className={`question-card resolved${rejected ? " rejected" : ""}${failed ? " failed" : ""}`}
      open={failed}
      onContextMenu={(event) =>
        menu.open(event, contextItems, { label: "问题菜单" })
      }
    >
      <summary className="question-summary">
        <span className="question-summary-state">
          {failed ? (
            <Icon name="alert" size={13} />
          ) : rejected || aborted ? (
            <Icon name="close" size={13} />
          ) : (
            <Icon name="check" size={13} strokeWidth={2.2} />
          )}
        </span>
        <span className="question-summary-title">
          {questions.length === 1
            ? questions[0].question
            : `${questions.length} 个问题`}
        </span>
        <span className="question-summary-meta">{summary}</span>
        <Icon name="chevron-right" size={13} className="caret" />
      </summary>
      <div className="question-card-body resolved">
        {failed && error && (
          <div className="question-error">{error}</div>
        )}
        {questions.map((question, index) => {
          const questionAnswers = answers[index] ?? [];
          return (
            <div className="question-item" key={`${part.id}-answer-${index}`}>
              <div className="question-item-head">
                <span className="question-item-header">
                  {question.header}
                </span>
              </div>
              <div className="question-item-question">
                {question.question}
              </div>
              <div className="question-answers">
                {questionAnswers.length > 0 ? (
                  questionAnswers.map((answer) => {
                    const option = question.options.find(
                      (item) => item.label === answer,
                    );
                    return (
                      <div className="question-answer" key={answer}>
                        <span className="question-answer-check">
                          <Icon name="check" size={10} strokeWidth={2.4} />
                        </span>
                        <span className="question-answer-copy">
                          <span className="question-answer-label">
                            {answer}
                          </span>
                          {option?.description && (
                            <span className="question-answer-description">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <span className="question-answer-empty">未回答</span>
                )}
              </div>
            </div>
          );
        })}
        {rejected && (
          <div className="question-dismissed">
            已跳过这个问题，Agent 会按未回答继续处理。
          </div>
        )}
        {aborted && (
          <div className="question-dismissed">
            生成已停止，这个问题没有提交回答。
          </div>
        )}
      </div>
    </details>
  );
}

function ToolCard({ part }: { part: Part }) {
  const menu = useContextMenu();
  const state = part.state ?? {};
  const status = state.status ?? "pending";
  const statusLabel =
    status === "running"
      ? "执行中"
      : status === "error"
        ? "失败"
        : status === "interrupted"
          ? "已中断"
          : null;
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
          {status === "interrupted" && <Icon name="stop" size={12} />}
          {status !== "completed" &&
            status !== "error" &&
            status !== "running" &&
            status !== "interrupted" && <span className="tool-pending" />}
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

function ImageToolCard({
  part,
  images,
  directory,
}: {
  part: Part;
  images: ToolImagePreview[];
  directory?: string;
}) {
  const menu = useContextMenu();
  const [open, setOpen] = useState(true);
  const state = part.state ?? {};
  const status = state.status ?? "pending";
  const statusLabel =
    status === "running"
      ? "执行中"
      : status === "error"
        ? "失败"
        : status === "interrupted"
          ? "已中断"
          : null;
  const contextItems = [
    ...(state.input !== undefined
      ? [copyItem("复制工具输入", fullValue(state.input), "工具输入已复制")]
      : []),
    ...(state.output !== undefined
      ? [copyItem("复制工具输出", fullValue(state.output), "工具输出已复制")]
      : []),
  ];
  const names = images.map((image) => image.name).join("、");
  return (
    <details
      className={`tool tool-image ${status}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onContextMenu={
        contextItems.length > 0
          ? (event) => menu.open(event, contextItems, { label: "工具菜单" })
          : undefined
      }
    >
      <summary>
        <span className={`tool-state ${status}`}>
          {status === "completed" && <Icon name="image" size={13} />}
          {status === "error" && <Icon name="alert" size={13} />}
          {status === "running" && <span className="tool-spinner" />}
          {status === "interrupted" && <Icon name="stop" size={12} />}
          {status === "pending" && <span className="tool-pending" />}
        </span>
        <span className="tool-name">已查看 {images.length} 张图像</span>
        {names && (
          <span className="tool-title" title={names}>
            {names}
          </span>
        )}
        {statusLabel && <span className={`tool-status ${status}`}>{statusLabel}</span>}
        <Icon name="chevron-right" size={13} className="caret tool-caret" />
      </summary>
      <div className="tool-body tool-image-body">
        <div className="tool-image-strip">
          {images.map((image) => (
            <div className="tool-image-thumb" key={image.id} title={image.name}>
              <InlineImage
                src={image.src}
                alt={image.name}
                directory={directory}
              />
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function activitySnippet(activity: NonNullable<ReturnType<typeof latestTaskActivity>>) {
  const value =
    activity.kind === "tool"
      ? activity.title
      : activity.detail.replace(/\s+/g, " ").trim();
  const suffix =
    activity.kind === "tool"
      ? activity.status === "running"
        ? " · 执行中"
        : activity.status === "interrupted"
          ? " · 已中断"
          : ""
      : "";
  const text = `${value}${suffix}`;
  return text.length > 150 ? `${text.slice(0, 150)}…` : text;
}

function SubagentPartCard({ part, fallbackTime }: { part: Part; fallbackTime?: number }) {
  const parentSessionID = useApp((s) => s.sessionID);
  const children = useApp((s) => s.sessionChildren);
  const statuses = useApp((s) => s.sessionStatuses);
  const openTasks = useApp((s) => s.openTasks);
  const task = useMemo(
    () => taskFromPart(part, parentSessionID, children, statuses, fallbackTime),
    [part, parentSessionID, children, statuses, fallbackTime],
  );
  const childMessages = useApp((s) =>
    task?.sessionID ? s.childMessages[task.sessionID] : undefined,
  );
  const childTodos = useApp((s) =>
    task?.sessionID ? s.childTodos[task.sessionID] : undefined,
  );
  if (!task) return null;

  const progress = todoProgress(childTodos ?? []);
  const activity = latestTaskActivity(childMessages ?? []);
  const duration = formatTaskDuration(task);
  return (
    <button
      type="button"
      className={`subagent-card ${task.status}`}
      onClick={() => openTasks(task.id)}
      title={`查看「${task.description}」的进展`}
    >
      <span className="subagent-card-head">
        <span className="subagent-card-icon">
          <Icon name="branch" size={15} />
        </span>
        <span className="subagent-card-copy">
          <span className="subagent-card-title">{task.description}</span>
          <span className="subagent-card-meta">
            {task.agent}
            {duration && ` · ${duration}`}
            {progress.total > 0 && ` · 待办 ${progress.resolved}/${progress.total}`}
          </span>
        </span>
        <TaskStatusBadge status={task.status} />
        <Icon name="chevron-right" size={13} className="subagent-caret" />
      </span>
      {activity && (
        <span className={`subagent-activity ${activity.kind}`}>
          {activity.kind === "tool" && (
            <span className={`subagent-activity-mark ${activity.status ?? ""}`}>
              {activity.status === "running" || activity.status === "pending" ? (
                <span className="tool-spinner" />
              ) : activity.status === "error" ? (
                <Icon name="alert" size={10} />
              ) : activity.status === "interrupted" ? (
                <Icon name="stop" size={10} />
              ) : (
                <Icon name="check" size={10} strokeWidth={2.2} />
              )}
            </span>
          )}
          {activity.kind === "reasoning" && <Icon name="spark" size={10} />}
          <span>{activitySnippet(activity)}</span>
        </span>
      )}
    </button>
  );
}

function ToolGroup({
  parts,
  directory,
}: {
  parts: Part[];
  directory?: string;
}) {
  return (
    <div className="tool-group">
      {parts.map((part) => {
        const images = toolImageAttachments(part);
        return images.length > 0 ? (
          <ImageToolCard
            key={part.id}
            part={part}
            images={images}
            directory={directory}
          />
        ) : (
          <ToolCard key={part.id} part={part} />
        );
      })}
    </div>
  );
}

type Block = { kind: "tool"; parts: Part[] } | { kind: "part"; part: Part };

/** 相邻工具调用合成一组，避免一次任务把消息流切成一长串大卡片。 */
function groupParts(parts: Part[]): Block[] {
  const blocks: Block[] = [];
  for (const part of parts) {
    if (part.synthetic) continue;
    if (
      part.type === "subtask" ||
      (part.type === "tool" &&
        (part.tool === "task" || part.tool === "question"))
    ) {
      blocks.push({ kind: "part", part });
      continue;
    }
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

function AssistantBlocks({
  parts,
  fallbackTime,
  directory,
}: {
  parts: Part[];
  fallbackTime?: number;
  directory: string;
}) {
  const menu = useContextMenu();
  return (
    <>
      {groupParts(parts).map((block) => {
        if (block.kind === "tool") {
          return (
            <ToolGroup
              key={block.parts[0].id}
              parts={block.parts}
              directory={directory}
            />
          );
        }
        const part = block.part;
        if (part.type === "subtask" || (part.type === "tool" && part.tool === "task")) {
          return <SubagentPartCard key={part.id} part={part} fallbackTime={fallbackTime} />;
        }
        if (part.type === "tool" && part.tool === "question") {
          return <QuestionToolCard key={part.id} part={part} />;
        }
        if (part.type === "text") {
          return part.text ? (
            <Markdown key={part.id} text={part.text} directory={directory} />
          ) : null;
        }
        if (part.type === "reasoning") {
          if (!part.text) return null;
          const time = part.time as { start?: number; end?: number } | undefined;
          const interrupted = !time?.end && Boolean(part.interrupted);
          const running = !time?.end && !interrupted;
          const seconds =
            time?.start && time?.end ? Math.max(0.1, (time.end - time.start) / 1000).toFixed(1) : null;
          return (
            <details
              key={part.id}
              className={`reasoning${running ? " running" : ""}${interrupted ? " interrupted" : ""}`}
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
                {interrupted && <span className="reasoning-time">· 已中断</span>}
                <Icon name="chevron-right" size={12} className="caret" />
              </summary>
              <div className="reasoning-body">{part.text}</div>
            </details>
          );
        }
        if (part.type === "file") {
          if (!isImagePart(part)) return null;
          const name = String(part.filename ?? "图片附件");
          return (
            <div className="message-image" key={part.id}>
              <InlineImage
                src={String(part.url)}
                alt={name}
                directory={directory}
              />
            </div>
          );
        }
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
      return status === "running" || status === "pending" || status === "interrupted"
        ? null
        : <LiveLabel text="正在准备" />;
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

function SessionTaskBar() {
  const messages = useApp((s) => s.messages);
  const sessionID = useApp((s) => s.sessionID);
  const children = useApp((s) => s.sessionChildren);
  const statuses = useApp((s) => s.sessionStatuses);
  const todos = useApp((s) => s.todos);
  const openTasks = useApp((s) => s.openTasks);
  const tasks = useMemo(
    () => buildSubagentTasks(messages, sessionID, children, statuses),
    [messages, sessionID, children, statuses],
  );
  if (todos.length === 0 && tasks.length === 0) return null;

  const progress = todoProgress(todos);
  const running = tasks.filter(
    (task) => task.status === "running" || task.status === "pending",
  ).length;
  const current = progress.active?.content;
  return (
    <button
      type="button"
      className="session-task-strip"
      onClick={() => openTasks()}
      title="查看待办与子代理进度"
    >
      <span className="session-task-kind">
        <Icon name={todos.length > 0 ? "list" : "branch"} size={13} />
        {todos.length > 0 ? `待办 ${progress.resolved}/${progress.total}` : "子代理"}
      </span>
      {current && <span className="session-task-current">{current}</span>}
      {!current && tasks.length > 0 && (
        <span className="session-task-current">
          {running > 0 ? tasks.find((task) => task.status === "running")?.description : `${tasks.length} 个任务已结束`}
        </span>
      )}
      {progress.total > 0 && <TaskProgressBar progress={progress} />}
      {running > 0 && (
        <span className="session-task-running">
          <span className="dot" />
          {running} 个子代理进行中
        </span>
      )}
      <Icon name="chevron-right" size={13} className="session-task-caret" />
    </button>
  );
}

export default function ChatView() {
  const messages = useApp((s) => s.messages);
  const sessionID = useApp((s) => s.sessionID);
  const sessionLoading = useApp((s) => s.sessionLoading);
  const sessions = useApp((s) => s.sessions);
  const directory = useApp((s) => s.directory);
  const permissions = useApp((s) => s.permissions);
  const streaming = useApp((s) => s.streaming);
  const busySessions = useApp((s) => s.busySessions);
  const stoppingSessions = useApp((s) => s.stoppingSessions);
  const queuedMessages = useApp((s) =>
    s.sessionID ? s.queuedMessages[s.sessionID] : undefined,
  );
  const pendingSteers = useApp((s) =>
    s.sessionID ? s.pendingSteers[s.sessionID] : undefined,
  );
  const editing = useApp((s) => s.editing);
  const editPhase = useApp((s) => s.editPhase);
  const beginEditMessage = useApp((s) => s.beginEditMessage);
  const cancelEditMessage = useApp((s) => s.cancelEditMessage);
  const restoreRevertedMessages = useApp((s) => s.restoreRevertedMessages);
  const steerMessageIDs = useApp((s) =>
    s.sessionID ? s.steerMessageIDs[s.sessionID] : undefined,
  );
  const newSession = useApp((s) => s.newSession);
  const replyPermission = useApp((s) => s.replyPermission);
  const openFile = useApp((s) => s.openFile);
  const toggleRight = useApp((s) => s.toggleRight);
  const openSettings = useApp((s) => s.openSettings);
  const menu = useContextMenu();
  const [attachmentPreview, setAttachmentPreview] = useState<Part | null>(null);
  const [restoringReverted, setRestoringReverted] = useState(false);
  const [restoreConfirming, setRestoreConfirming] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [activeTurn, setActiveTurn] = useState(0);
  const [historyLimit, setHistoryLimit] = useState(100);
  const pendingJump = useRef<string | null>(null);
  const previousHeight = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /** 用户主动滚离底部后，图片加载不能再把视图拉回去；回到底部时自动恢复。 */
  const userScrolled = useRef(false);
  const wasEditing = useRef(false);
  const turnFrame = useRef(0);
  const turnListRef = useRef<HTMLDivElement>(null);

  const findOpen = useApp((s) => s.findOpen);
  const findQuery = useApp((s) => s.findQuery);
  const findIndex = useApp((s) => s.findIndex);
  const closeFind = useApp((s) => s.closeFind);
  const setFindQuery = useApp((s) => s.setFindQuery);
  const stepFind = useApp((s) => s.stepFind);

  useEffect(() => onAppEvent("message-submitted", (target) => {
    if (target.directory !== directory || target.sessionID !== sessionID) return;
    stickToBottom.current = true;
    userScrolled.current = false;
    closeFind();
    setAtBottom(true);
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: "end" });
    });
  }), [directory, sessionID, closeFind]);

  const title = useMemo(() => {
    if (!directory || !sessionID) return "";
    return (
      (sessions[directory] ?? []).find((s) => s.id === sessionID)?.title ??
      (sessionID ? "会话" : "")
    );
  }, [directory, sessionID, sessions]);

  const activeSession = useMemo(
    () =>
      directory && sessionID
        ? (sessions[directory] ?? []).find((item) => item.id === sessionID)
        : undefined,
    [directory, sessionID, sessions],
  );
  const revert = activeSession?.revert;
  const busy = Boolean(
    sessionID &&
      (streaming || busySessions[sessionID] || stoppingSessions[sessionID]),
  );
  const queueBlocked = Boolean(
    (queuedMessages?.length ?? 0) > 0 || (pendingSteers?.length ?? 0) > 0,
  );

  // 切换会话时重新贴底，避免沿用上一个会话的滚动位置和按钮状态
  useEffect(() => {
    stickToBottom.current = true;
    userScrolled.current = false;
    setAtBottom(true);
    setHistoryLimit(100);
  }, [sessionID]);

  useEffect(() => {
    // 用户往上翻的时候不要把他拽回底部
    if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages, permissions.length, streaming]);

  useEffect(() => {
    // 图片异步加载会改变消息高度；用户原本在底部时继续贴底，避免图片被顶出视口。
    const onImageLoad = () => {
      // 用户已经主动上翻时，历史图片加载不应把视图拉回底部。
      if (userScrolled.current) return;
      // 图片 onLoad 时新高度还没参与布局，等两帧后再贴底。
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          bottomRef.current?.scrollIntoView({ block: "end" }),
        ),
      );
    };
    window.addEventListener("deveco:inline-image-load", onImageLoad);
    return () =>
      window.removeEventListener("deveco:inline-image-load", onImageLoad);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const markUserScroll = () => {
      userScrolled.current = true;
    };
    el.addEventListener("wheel", markUserScroll, { passive: true });
    el.addEventListener("pointerdown", markUserScroll);
    return () => {
      el.removeEventListener("wheel", markUserScroll);
      el.removeEventListener("pointerdown", markUserScroll);
    };
  }, []);

  useEffect(() => {
    if (wasEditing.current && !editing && streaming) {
      stickToBottom.current = true;
      requestAnimationFrame(() =>
        bottomRef.current?.scrollIntoView({ block: "end" }),
      );
    }
    wasEditing.current = Boolean(editing);
  }, [editing, streaming]);

  const pending = permissions.filter((p) => p.sessionID === sessionID);

  const visibleBase = useMemo(() => {
    if (!revert?.messageID) return messages;
    const index = messages.findIndex(
      (message) => message.info.id === revert.messageID,
    );
    return index === -1 ? messages : messages.slice(0, index);
  }, [messages, revert?.messageID]);
  const revertedItems =
    visibleBase.length < messages.length
      ? messages.slice(visibleBase.length)
      : [];
  const revertPreview = useMemo(() => {
    const first = revertedItems.find(
      (message) =>
        message.info.role === "user" && messageText(message.parts).trim(),
    );
    const text = first
      ? messageText(first.parts).replace(/\s+/g, " ").trim()
      : "";
    return text.length > 64 ? `${text.slice(0, 64)}…` : text;
  }, [revertedItems]);

  const turnNodes = useMemo(() => {
    const visible = new Set(visibleBase.map((message) => message.info.id));
    const nodes = new Map<string, { index: number; text: string }>();
    let index = 0;
    // 编号按完整消息历史计算；回滚隐藏的消息仍占轮次，但不生成节点。
    for (const message of messages) {
      if (message.info.role !== "user") continue;
      index += 1;
      if (!visible.has(message.info.id) || !messageHasContent(message)) continue;
      const text = messageText(message.parts).replace(/\s+/g, " ").trim();
      nodes.set(message.info.id, { index, text: text || "附件消息" });
    }
    return nodes;
  }, [messages, visibleBase]);
  const turnList = useMemo(
    () => Array.from(turnNodes, ([id, turn]) => ({ id, ...turn })),
    [turnNodes],
  );
  const showTurnNodes = !findQuery.trim() && turnList.length > 0;

  const measureActiveTurn = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nodes = el.querySelectorAll<HTMLElement>(".msg-block[data-turn]");
    if (nodes.length === 0) return;
    const threshold = el.getBoundingClientRect().top + 80;
    let current = Number(nodes[0].dataset.turn) || 0;
    for (const node of nodes) {
      const index = Number(node.dataset.turn);
      if (!Number.isFinite(index)) continue;
      if (node.getBoundingClientRect().top <= threshold) current = index;
      else break;
    }
    setActiveTurn(current);
  };

  const scheduleActiveTurn = () => {
    if (turnFrame.current) return;
    turnFrame.current = requestAnimationFrame(() => {
      turnFrame.current = 0;
      measureActiveTurn();
    });
  };

  useLayoutEffect(() => {
    measureActiveTurn();
  }, [sessionID, findQuery, turnList.length]);

  useEffect(
    () => () => {
      if (turnFrame.current) cancelAnimationFrame(turnFrame.current);
    },
    [],
  );

  useEffect(() => {
    const container = turnListRef.current;
    if (!container) return;
    const row = container.querySelector<HTMLElement>(
      `[data-turn-row="${activeTurn}"]`,
    );
    if (!row) return;
    container.scrollTop = Math.max(
      0,
      row.offsetTop - container.clientHeight / 2 + row.offsetHeight / 2,
    );
  }, [activeTurn, turnList.length]);

  const jumpToTurn = (messageID: string) => {
    userScrolled.current = true;
    const index = visibleBase.findIndex((message) => message.info.id === messageID);
    if (index >= 0 && visibleBase.length - index > historyLimit) {
      pendingJump.current = messageID;
      setHistoryLimit(visibleBase.length - index);
      return;
    }
    document
      .getElementById(`msg-${messageID}`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const matches = useMemo(() => {
    const keyword = findQuery.trim().toLowerCase();
    if (!keyword) return [];
    return visibleBase.filter((message) =>
      messageText(message.parts).toLowerCase().includes(keyword),
    );
  }, [visibleBase, findQuery]);

  const visibleMessages = findQuery.trim() ? matches : visibleBase;
  const displayMessages = useMemo(() => {
    if (
      !editing ||
      editing.sessionID !== sessionID ||
      visibleMessages.some((message) => message.info.id === editing.messageID)
    ) {
      return visibleMessages;
    }
    const target = messages.find(
      (message) => message.info.id === editing.messageID,
    );
    return target ? [...visibleMessages, target] : visibleMessages;
  }, [visibleMessages, messages, editing, sessionID, editPhase]);

  useEffect(() => {
    if (
      !editing ||
      editing.sessionID !== sessionID ||
      editPhase !== "idle"
    ) {
      return;
    }
    if (!visibleBase.some((message) => message.info.id === editing.messageID)) {
      cancelEditMessage();
    }
  }, [editing, sessionID, editPhase, visibleBase, cancelEditMessage]);

  useEffect(() => {
    if (editing || revertedItems.length === 0) setRestoreConfirming(false);
  }, [editing, revertedItems.length]);

  const liveMessageId = useMemo(() => {
    if (!streaming) return null;
    for (let index = visibleBase.length - 1; index >= 0; index -= 1) {
      const message = visibleBase[index];
      if (message.info.role !== "assistant") continue;
      // 上一步已经完成、下一步还没落库时，不要把“正在生成”挂到旧消息下面。
      return message.info.time?.completed ? null : message.info.id;
    }
    return null;
  }, [visibleBase, streaming]);
  const steerIDs = useMemo(
    () => new Set(steerMessageIDs ?? []),
    [steerMessageIDs],
  );

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

  const displayIndex = useMemo(
    () => new Map(displayMessages.map((message, index) => [message.info.id, index])),
    [displayMessages],
  );
  const fullIndices = useMemo(
    () => new Map(messages.map((message, index) => [message.info.id, index])),
    [messages],
  );
  const displayGroups = useMemo(() => {
    const groups: {
      messages: Message[];
      minute: boolean;
      meta?: MessageMetaOverride;
    }[] = [];
    const groupByMinute = !findQuery.trim();
    const editingIndex = editing?.sessionID === sessionID
      ? displayMessages.findIndex((message) => message.info.id === editing.messageID)
      : -1;
    const start = editingIndex < 0
      ? Math.max(0, displayMessages.length - historyLimit)
      : Math.min(editingIndex, Math.max(0, displayMessages.length - historyLimit));
    const rendered = findQuery.trim() ? displayMessages : displayMessages.slice(start);
    for (const message of rendered) {
      if (!messageHasContent(message) && message.info.id !== liveMessageId) continue;
      const previousGroup = groups[groups.length - 1];
      const previous = previousGroup?.messages[previousGroup.messages.length - 1];
      if (
        groupByMinute &&
        message.info.role === "assistant" &&
        continued.get(message.info.id) === true &&
        previous?.info.role === "assistant" &&
        inSameMinute(previous, message)
      ) {
        previousGroup.messages.push(message);
        continue;
      }
      groups.push({ messages: [message], minute: false });
    }
    return groups.map((group) => {
      if (group.messages.length < 2) return group;
      return {
        ...group,
        minute: true,
        meta: {
          text: group.messages
            .map((message) => messageText(message.parts).trim())
            .filter(Boolean)
            .join("\n\n"),
          time: formatTime(group.messages[0].info.time?.created),
          count: group.messages.length,
        },
      };
    });
  }, [continued, displayMessages, editing, findQuery, liveMessageId, historyLimit, sessionID]);

  useLayoutEffect(() => {
    if (pendingJump.current) {
      document.getElementById(`msg-${pendingJump.current}`)?.scrollIntoView({ block: "start" });
      pendingJump.current = null;
    } else if (previousHeight.current !== null && scrollRef.current) {
      scrollRef.current.scrollTop += scrollRef.current.scrollHeight - previousHeight.current;
      previousHeight.current = null;
    }
  }, [historyLimit]);

  useEffect(() => {
    if (!findQuery.trim() || matches.length === 0) return;
    const target = matches[Math.min(findIndex, matches.length - 1)];
    userScrolled.current = true;
    document.getElementById(`msg-${target.info.id}`)?.scrollIntoView({ block: "center" });
  }, [findIndex, findQuery, matches]);

  const restoreReverted = async () => {
    if (revertedItems.length === 0) return;
    setRestoreConfirming(false);
    setRestoringReverted(true);
    try {
      await restoreRevertedMessages();
    } finally {
      setRestoringReverted(false);
    }
  };

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
              label: "查看任务与待办",
              icon: "branch",
              onSelect: () => useApp.getState().openTasks(),
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
      <SessionTaskBar />

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
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (gap < 8) userScrolled.current = false;
          const nearBottom = gap < 90;
          stickToBottom.current = nearBottom;
          setAtBottom(nearBottom);
          scheduleActiveTurn();
        }}
      >
        {sessionLoading && (
          <div className="chat-loading" role="status" aria-live="polite">
            <span className="panel-spinner small" aria-hidden="true" />
            正在加载会话…
          </div>
        )}
        {!sessionID && (
          <div className="welcome">
            <AppIcon size={44} className="welcome-icon" />
            <h2>开始一个会话</h2>
            <p>
              {directory
                ? "在下方输入需求；发送首条消息前仍可切换工作区。"
                : "在下方选择或新建工作区，然后输入需求。"}
            </p>
          </div>
        )}

        {!sessionLoading && !findQuery.trim() && displayMessages.length > historyLimit && (
          <button type="button" className="history-load" onClick={() => {
            previousHeight.current = scrollRef.current?.scrollHeight ?? null;
            userScrolled.current = true;
            stickToBottom.current = false;
            setHistoryLimit((limit) => limit + 100);
          }}>
            加载更早的消息（剩余 {displayMessages.length - historyLimit} 条）
          </button>
        )}
        {displayGroups.map((group) => (
          <div
            key={group.messages[0].info.id}
            className={`msg-group${group.minute ? " minute-group" : ""}`}
          >
            {group.messages.map((message, groupIndex) => {
              const index = displayIndex.get(message.info.id) ?? 0;
              const fullIndex = fullIndices.get(message.info.id) ?? -1;
              const laterCount =
                fullIndex === -1 ? 0 : messages.length - fullIndex - 1;
              const editReason = busy
                ? "当前会话正在执行，请先停止回复"
                : queueBlocked
                  ? "请先处理排队或待确认的消息"
                  : messageEditProblem(message);
              const turn = turnNodes.get(message.info.id);
              const metaOverride =
                group.minute && group.meta
                  ? groupIndex === group.messages.length - 1
                    ? group.meta
                    : null
                  : undefined;
              return (
                <div
                  id={`msg-${message.info.id}`}
                  key={message.info.id}
                  className={`msg-block${findQuery.trim() && index === findIndex ? " find-hit" : ""}`}
                  data-turn={turn?.index}
                >
                  <ImageGroup>
                    <MessageRow
                      message={message}
                      continued={continued.get(message.info.id) ?? false}
                      live={message.info.id === liveMessageId}
                      steer={steerIDs.has(message.info.id)}
                      directory={directory ?? ""}
                      editingSeed={
                        editing?.sessionID === sessionID &&
                        editing.messageID === message.info.id
                          ? editing
                          : undefined
                      }
                      editable={!editReason}
                      editReason={editReason ?? undefined}
                      laterCount={laterCount}
                      compact={
                        group.minute && groupIndex < group.messages.length - 1
                      }
                      metaOverride={metaOverride}
                      onStartEdit={() => beginEditMessage(message.info.id)}
                      onOpenFile={(path) => void openFile(path)}
                      onOpenAttachment={setAttachmentPreview}
                    />
                  </ImageGroup>
                </div>
              );
            })}
          </div>
        ))}
        {editing &&
          editing.sessionID === sessionID &&
          !displayMessages.some((message) => message.info.id === editing.messageID) && (
            <div className="row user editing">
              <MessageEditor seed={editing} laterCount={revertedItems.length} />
            </div>
          )}
        {!editing && revertedItems.length > 0 && (
          <div className="revert-dock" role="status">
            <div className="revert-dock-row">
              <span className="revert-dock-icon">
                <Icon name="undo" size={15} />
              </span>
              <span className="revert-dock-copy">
                <span className="revert-dock-title">
                  已回滚 {revertedItems.length} 条消息
                </span>
                {revertPreview && (
                  <span className="revert-dock-preview">从「{revertPreview}」开始</span>
                )}
              </span>
              <button
                type="button"
                className="mini-btn"
                disabled={restoringReverted || busy}
                onClick={() => setRestoreConfirming(true)}
                title={
                  busy
                    ? "会话正在执行，停止后可恢复"
                    : "恢复消息，并把工作区恢复到回滚前"
                }
              >
                {restoringReverted ? "恢复中…" : "恢复消息"}
              </button>
            </div>
            {restoreConfirming && (
              <div className="revert-dock-confirm">
                <span>
                  恢复会把消息和工作区文件一起还原到回滚前，可能覆盖之后的修改。
                </span>
                <div className="revert-dock-confirm-actions">
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => setRestoreConfirming(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary-btn small"
                    onClick={() => void restoreReverted()}
                  >
                    确认恢复
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
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
      {showTurnNodes && (
        <nav className="turn-nav" aria-label="轮次导航">
          <div className="turn-list" ref={turnListRef}>
            {turnList.map((turn) => (
              <button
                key={turn.id}
                type="button"
                data-turn-row={turn.index}
                className={`turn-row${turn.index === activeTurn ? " active" : ""}`}
                aria-label={`第 ${turn.index} 轮：${turn.text}`}
                aria-current={turn.index === activeTurn ? "step" : undefined}
                onClick={() => jumpToTurn(turn.id)}
              >
                <span className="turn-row-dash" />
                <span className="turn-row-text">{turn.text}</span>
              </button>
            ))}
          </div>
        </nav>
      )}
      {sessionID && !findQuery.trim() && !atBottom && (
        <button
          type="button"
          className="scroll-latest"
          title="回到最新消息"
          aria-label="回到最新消息"
          onClick={() => {
            const el = scrollRef.current;
            if (!el) return;
            stickToBottom.current = true;
            userScrolled.current = false;
            el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
        >
          <Icon name="arrow-down" size={14} />
          <span>最新消息</span>
        </button>
      )}
      {attachmentPreview && (
        <AttachmentViewer
          part={attachmentPreview}
          directory={directory ?? undefined}
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
  steer,
  directory,
  editingSeed,
  editable,
  editReason,
  laterCount,
  compact,
  metaOverride,
  onStartEdit,
  onOpenFile,
  onOpenAttachment,
}: {
  message: Message;
  continued: boolean;
  live: boolean;
  steer: boolean;
  directory: string;
  editingSeed?: MessageEditTarget;
  editable: boolean;
  editReason?: string;
  laterCount: number;
  compact?: boolean;
  metaOverride?: MessageMetaOverride | null;
  onStartEdit: () => void;
  onOpenFile: (path: string) => void;
  onOpenAttachment: (part: Part) => void;
}) {
  const menu = useContextMenu();
  if (message.info.role === "user") {
    const text = messageText(message.parts);
    const files = message.parts.filter((part) => part.type === "file" && !part.synthetic);
    const subtasks = message.parts.filter(
      (part) => part.type === "subtask" && !part.synthetic,
    );
    if (!text.trim() && files.length === 0 && subtasks.length === 0) return null;
    if (editingSeed) {
      return (
        <div className="row user editing">
          <MessageEditor seed={editingSeed} laterCount={laterCount} />
        </div>
      );
    }
    const { links, used } = matchMentionFiles(text, files);
    const uploads = files.filter((part) => !used.has(part.id));
    const menuItems: ContextMenuEntry[] = [];
    if (message.info.role === "user") {
      menuItems.push({
        type: "item",
        label: "编辑消息",
        icon: "pencil",
        disabled: !editable,
        onSelect: onStartEdit,
      });
    }
    if (text.trim()) {
      if (menuItems.length > 0) menuItems.push({ type: "separator" });
      menuItems.push(copyItem("复制消息", text, "消息已复制"));
    }
    return (
      <div
        className="row user"
        onContextMenu={
          menuItems.length > 0
            ? (event) =>
                menu.open(event, menuItems, {
                  label: "用户消息菜单",
                })
            : undefined
        }
      >
        <div className="bubble-wrap">
          {steer && (
            <span className="steer-tag" title="作为当前任务的引导消息发送">
              <Icon name="spark" size={10} />
              引导
            </span>
          )}
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
          {subtasks.map((part) => (
            <SubagentPartCard
              key={part.id}
              part={part}
              fallbackTime={message.info.time?.created}
            />
          ))}
          <MessageMeta
            text={text}
            time={formatTime(message.info.time?.created)}
            onEdit={onStartEdit}
            editDisabled={!editable}
            editTitle={editReason ?? "编辑这条消息"}
          />
        </div>
      </div>
    );
  }
  if (!messageHasContent(message) && !live) return null;
  const text = messageText(message.parts);
  return (
    <div
      className={`row assistant${continued ? " continued" : ""}${live ? " live" : ""}${compact ? " minute-continues" : ""}`}
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
        {continued ? <span className="step-dot" /> : <AppIcon size={24} className="avatar" />}
      </div>
      <div className="assistant-body">
        {message.info.error && (
          <div className="msg-error">
            {message.info.error.data?.message ?? message.info.error.name ?? "执行出错"}
          </div>
        )}
        <AssistantBlocks
          parts={message.parts}
          fallbackTime={message.info.time?.created}
          directory={directory}
        />
        {live && <LiveActivity parts={message.parts} />}
        {metaOverride !== null && (
          <MessageMeta
            text={metaOverride?.text ?? text}
            time={metaOverride?.time ?? formatTime(message.info.time?.created)}
            copyLabel={
              metaOverride && metaOverride.count > 1
                ? "复制这组消息"
                : "复制消息"
            }
          />
        )}
      </div>
    </div>
  );
}

function MessageMeta({
  text,
  time,
  onEdit,
  editDisabled,
  editTitle,
  copyLabel,
}: {
  text: string;
  time: string;
  onEdit?: () => void;
  editDisabled?: boolean;
  editTitle?: string;
  copyLabel?: string;
}) {
  return (
    <div className="msg-meta" role="group" aria-label="消息操作">
      {onEdit && (
        <button
          type="button"
          className="msg-action"
          title={editTitle ?? "编辑这条消息"}
          aria-label={editTitle ?? "编辑这条消息"}
          disabled={editDisabled}
          onClick={onEdit}
        >
          <Icon name="pencil" size={15} />
        </button>
      )}
      <CopyButton text={text} label={copyLabel} />
      {time && <span className="msg-time">{time}</span>}
    </div>
  );
}

function CopyButton({ text, label = "复制消息" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  if (!text.trim()) return null;
  const title = done ? "已复制" : label;
  return (
    <button
      type="button"
      className={`msg-action${done ? " copied" : ""}`}
      title={title}
      aria-label={title}
      onClick={async () => {
        const ok = await copyText(text, null);
        if (ok) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }
      }}
    >
      <Icon name={done ? "check" : "copy"} size={15} />
    </button>
  );
}
