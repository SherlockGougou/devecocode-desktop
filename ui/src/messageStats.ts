import type { Message } from "./types";

/**
 * 单条助手消息的 Token 总量。
 * CLI 的 tokens.total 已包含未缓存输入、输出、推理和缓存读写；旧数据缺少
 * total 时按同一口径回退，避免底栏与设置页、CLI stats 不一致。
 */
export function messageTotalTokens(message: Message): number {
  const tokens = message.info.tokens;
  if (!tokens) return 0;
  const input = tokens.input ?? 0;
  const output = tokens.output ?? 0;
  const reasoning = tokens.reasoning ?? 0;
  const cacheRead = tokens.cache?.read ?? 0;
  const cacheWrite = tokens.cache?.write ?? 0;
  return tokens.total ?? input + output + reasoning + cacheRead + cacheWrite;
}

/**
 * 输出解码耗时，对齐 DSH 的 decodeMs：
 * - 从首个输出 token 开始，到本步输出结束，不含工具执行；
 * - 有工具调用时，优先用事件流记录的工具调用输出结束时间（streamedAt），
 *   避免把工具执行前的排队/审批等待算进解码耗时；
 * - 历史消息缺少 streamedAt 时，优先用最后一个 text/reasoning 结束，
 *   再退回首个工具开始时间或消息完成时间；
 * - 没有可见 text/reasoning 的 tool-call-only 步骤，以消息创建时间近似首 token；
 * - 只统计已完成的助手消息，流式中的步骤不进入分母。
 */
export function messageDecodeMs(message: Message): number {
  if (message.info.role !== "assistant") return 0;
  const time = message.info.time;
  if (!time?.created || !time.completed) return 0;

  const outputParts = message.parts.filter(
    (part) => (part.type === "text" || part.type === "reasoning") && part.time?.start !== undefined,
  );

  let firstToken: number | undefined;
  let lastOutputEnd: number | undefined;
  for (const part of outputParts) {
    const start = part.time?.start;
    const end = part.time?.end;
    if (typeof start === "number") {
      firstToken = firstToken === undefined ? start : Math.min(firstToken, start);
    }
    if (typeof end === "number") {
      lastOutputEnd = lastOutputEnd === undefined ? end : Math.max(lastOutputEnd, end);
    }
  }

  const toolStarts = message.parts
    .filter((part) => part.type === "tool")
    .map((part) => part.state?.time?.start)
    .filter((value): value is number => typeof value === "number");
  const toolStreamEnds = message.parts
    .filter((part) => part.type === "tool")
    .map((part) => part.streamedAt)
    .filter((value): value is number => typeof value === "number");

  const start = firstToken ?? time.created;
  const rawEnd =
    toolStreamEnds.length > 0
      ? Math.max(...toolStreamEnds)
      : lastOutputEnd ?? (toolStarts.length > 0 ? Math.min(...toolStarts) : time.completed);
  const end = Math.min(rawEnd, time.completed);
  return end > start ? end - start : 0;
}

export interface SessionStats {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitPercent: number | null;
  total: number;
  cost: number;
  turns: number;
  generatedTokens: number;
  decodeMs: number;
  speed: number;
  contextTokens: number;
  contextModel: { providerID: string; modelID: string } | null;
}

/**
 * 汇总当前会话的用量和输出速度。
 * 速度口径与 DSH 的 TPS 一致：输出 + 推理 token / 解码耗时。
 */
export function summarizeMessages(messages: Message[]): SessionStats {
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let total = 0;
  let cost = 0;
  let turns = 0;
  let generatedTokens = 0;
  let decodeMs = 0;
  let contextTokens = 0;
  let contextModel: { providerID: string; modelID: string } | null = null;

  for (const message of messages) {
    if (message.info.role === "user") {
      turns += 1;
      continue;
    }

    const tokens = message.info.tokens;
    if (tokens) {
      const messageInput = tokens.input ?? 0;
      const messageCacheRead = tokens.cache?.read ?? 0;
      const messageCacheWrite = tokens.cache?.write ?? 0;
      input += messageInput;
      output += tokens.output ?? 0;
      reasoning += tokens.reasoning ?? 0;
      cacheRead += messageCacheRead;
      cacheWrite += messageCacheWrite;
      const prompt = messageInput + messageCacheRead + messageCacheWrite;
      if (prompt > 0) {
        contextTokens = prompt;
        contextModel =
          message.info.model ??
          (message.info.providerID && message.info.modelID
            ? { providerID: message.info.providerID, modelID: message.info.modelID }
            : null);
      }
    }
    total += messageTotalTokens(message);
    cost += message.info.cost ?? 0;

    const generated = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0);
    if (generated <= 0) continue;
    const decode = messageDecodeMs(message);
    if (decode <= 0) continue;
    generatedTokens += generated;
    decodeMs += decode;
  }

  const promptTotal = input + cacheRead + cacheWrite;
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    cacheHitPercent: promptTotal > 0 ? (cacheRead / promptTotal) * 100 : null,
    total,
    cost,
    turns,
    generatedTokens,
    decodeMs,
    speed: decodeMs > 0 ? (generatedTokens / decodeMs) * 1000 : 0,
    contextTokens,
    contextModel,
  };
}
