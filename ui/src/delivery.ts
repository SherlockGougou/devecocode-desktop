import type { Attachment, MentionRef } from "./types";

/** 同一会话最多保留多少条待发送消息，避免长队列和附件长期占用内存。 */
export const MAX_QUEUE_ITEMS = 20;
/** 同一会话排队消息携带的附件总量上限。 */
export const MAX_QUEUE_ATTACHMENT_BYTES = 64 * 1024 * 1024;

export interface PromptSelection {
  model: { providerID: string; modelID: string } | null;
  agent: string;
  variant: string | null;
}

export type QueueItemStatus = "queued" | "sending" | "failed";

export interface QueuedMessage {
  id: string;
  sessionID: string;
  directory: string;
  text: string;
  refs: MentionRef[];
  attachments: Attachment[];
  selection: PromptSelection;
  createdAt: number;
  status: QueueItemStatus;
  error?: string;
}

export type PendingSteerStatus = "sent" | "paused" | "failed";

export interface PendingSteer {
  messageID: string;
  sessionID: string;
  directory: string;
  createdAt: number;
  selection: PromptSelection;
  status: PendingSteerStatus;
  error?: string;
}

export interface SteerDelivery {
  sessionID: string;
  directory: string;
  text: string;
  refs: MentionRef[];
  attachments: Attachment[];
  selection: PromptSelection;
  /** 请求未被接收时，是否把原文回填到输入框 */
  restoreOnFailure: boolean;
}

export function newQueueItemID(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function queueAttachmentBytes(items: QueuedMessage[]): number {
  return items.reduce(
    (total, item) =>
      total + item.attachments.reduce((sum, attachment) => sum + attachment.size, 0),
    0,
  );
}

/** 队列行只展示一行短预览，完整内容放在 title 里。 */
export function previewQueuedMessage(item: QueuedMessage): string {
  const text = item.text.replace(/\s+/g, " ").trim();
  if (text) return text.length > 96 ? `${text.slice(0, 96)}…` : text;
  if (item.attachments.length > 0) return `附件 ${item.attachments.length} 个`;
  if (item.refs.length > 0) return `引用 ${item.refs.length} 个文件`;
  return "空消息";
}
