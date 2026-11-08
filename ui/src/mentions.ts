import { normalizeWorkspacePath } from "./paths";
import type { MentionRef, Part } from "./types";

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

export type InlineFileRef = {
  start: number;
  end: number;
  path: string;
};

/**
 * 正文里的 @token 与 CLI 回传的 file part 做匹配。
 * CLI 已经丢弃 source 元数据，只能依赖 filename；返回值同时供气泡渲染
 * 和“编辑消息时区分 @ 引用与用户上传附件”使用。
 */
export function matchMentionFiles(text: string, files: Part[]) {
  const used = new Set<string>();
  const links: InlineFileRef[] = [];
  for (const ref of parseMentions(text)) {
    const exact = files.find(
      (part) =>
        !used.has(part.id) &&
        normalizeWorkspacePath(String(part.filename ?? "")) ===
          normalizeWorkspacePath(ref.path),
    );
    const matched =
      exact ??
      files.find(
        (part) =>
          !used.has(part.id) &&
          typeof part.filename === "string" &&
          normalizeWorkspacePath(part.filename).endsWith(
            `/${normalizeWorkspacePath(ref.path)}`,
          ),
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
