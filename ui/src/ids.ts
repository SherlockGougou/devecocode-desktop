const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * 生成与 CLI 同形的 ULID 风格消息 ID。
 * 引导消息需要提前知道 ID，才能用 assistant.parentID 判断它有没有被当前轮消费。
 */
export function newMessageID(now = Date.now()): string {
  let time = "";
  let value = now;
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD[value % 32] + time;
    value = Math.floor(value / 32);
  }

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let random = "";
  for (const byte of bytes) random += CROCKFORD[byte % 32];
  return `msg_${time}${random}`;
}
