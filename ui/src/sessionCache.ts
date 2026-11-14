import type { Message } from "./types";

/** 仅在本次运行中缓存最近访问的会话，限制长会话占用的内存。 */
export class SessionCache {
  private entries = new Map<string, Message[]>();

  constructor(private readonly limit = 5) {}

  private key(directory: string, sessionID: string): string {
    return JSON.stringify([directory, sessionID]);
  }

  get(directory: string, sessionID: string): Message[] | undefined {
    const key = this.key(directory, sessionID);
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(directory: string, sessionID: string, messages: Message[]): void {
    const key = this.key(directory, sessionID);
    this.entries.delete(key);
    this.entries.set(key, messages);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  delete(directory: string, sessionID: string): void {
    this.entries.delete(this.key(directory, sessionID));
  }
}

/** 快照以服务端为准，只重放请求开始后本地发生的消息和 part 变更。 */
export function reconcileSessionMessages(
  snapshot: Message[],
  baseline: Message[],
  current: Message[],
): Message[] {
  const before = new Map(baseline.map((message) => [message.info.id, message]));
  const after = new Map(current.map((message) => [message.info.id, message]));
  const merged = snapshot.filter((message) =>
    !before.has(message.info.id) || after.has(message.info.id),
  );
  const indices = new Map(merged.map((message, index) => [message.info.id, index]));

  for (const message of current) {
    const previous = before.get(message.info.id);
    if (previous === message) continue;
    const index = indices.get(message.info.id);
    if (index === undefined) {
      // 请求前就存在、请求中未改变的旧消息不能从缓存复活。
      indices.set(message.info.id, merged.length);
      merged.push(message);
      continue;
    }
    const server = merged[index];
    const oldParts = new Map((previous?.parts ?? []).map((part) => [part.id, part]));
    const newParts = new Map(message.parts.map((part) => [part.id, part]));
    const parts = server.parts.filter((part) => !oldParts.has(part.id) || newParts.has(part.id));
    const partIndices = new Map(parts.map((part, i) => [part.id, i]));
    for (const part of message.parts) {
      if (oldParts.get(part.id) === part) continue;
      const partIndex = partIndices.get(part.id);
      if (partIndex === undefined) {
        partIndices.set(part.id, parts.length);
        parts.push(part);
      } else {
        parts[partIndex] = { ...parts[partIndex], ...part };
      }
    }
    merged[index] = {
      info: previous?.info === message.info ? server.info : { ...server.info, ...message.info },
      parts,
    };
  }
  return merged;
}
