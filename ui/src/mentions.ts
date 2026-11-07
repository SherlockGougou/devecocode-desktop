import type { MentionRef } from "./types";

/** 一次最多引用多少个文件：超过后不再插入，避免把整个目录塞进上下文 */
export const MAX_REFS = 8;

/**
 * 从文本解析全部 @ 引用，触发规则与 Composer 的 detectMention 保持一致。
 * 文本是唯一事实来源：输入框上方的 chip、发送时的 file part 都从它派生。
 * 未闭合的引号 token 不算引用（用户可能还在输入）；按路径去重。
 */
export function parseMentions(value: string): MentionRef[] {
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
