import type { Session } from "./types";

const SUBAGENT_TITLE = /\(@[^)]+\s+subagent\)/i;

/** 子代理会话：CLI 通过 parentID 关联父会话，旧数据只在标题里保留标记。 */
export function isSubagentSession(
  session: Pick<Session, "parentID" | "title">,
): boolean {
  return Boolean(session.parentID) || SUBAGENT_TITLE.test(session.title ?? "");
}

/** 工作区侧栏只展示根会话；子会话从父会话的任务面板进入。 */
export function rootSessions(sessions: Session[]): Session[] {
  return sessions.filter((session) => !isSubagentSession(session));
}

export function stripSubagentTitle(title: string) {
  return title.replace(/\s*\(@[^)]+\s+subagent\)\s*$/i, "").trim();
}
