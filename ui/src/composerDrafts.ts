/**
 * Composer 草稿按“工作区 + 会话”隔离。
 * 新会话尚未创建时 sessionID 为空，使用固定槽位，避免草稿被带到别的会话。
 */

export const COMPOSER_DRAFT_PREFIX = "deveco.desktop.composerDraft.v1";

const DRAFT_VERSION = 1;

export interface ComposerDraftScope {
  directory: string;
  sessionID: string | null;
}

export interface ComposerDraft {
  text: string;
  updatedAt: number;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredComposerDraft extends ComposerDraft {
  version: number;
  directory: string;
  sessionID: string | null;
}

export function composerDraftKey({
  directory,
  sessionID,
}: ComposerDraftScope): string {
  const session = sessionID ? encodeURIComponent(sessionID) : "new";
  return `${COMPOSER_DRAFT_PREFIX}:${encodeURIComponent(directory)}:${session}`;
}

export function readComposerDraft(
  storage: DraftStorage,
  scope: ComposerDraftScope,
): ComposerDraft | null {
  const raw = storage.getItem(composerDraftKey(scope));
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`草稿数据损坏：${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("草稿数据格式无效");
  }

  const draft = parsed as Partial<StoredComposerDraft>;
  if (
    draft.version !== DRAFT_VERSION ||
    draft.directory !== scope.directory ||
    draft.sessionID !== scope.sessionID ||
    typeof draft.text !== "string" ||
    typeof draft.updatedAt !== "number"
  ) {
    throw new Error("草稿数据与当前工作区或会话不匹配");
  }
  return { text: draft.text, updatedAt: draft.updatedAt };
}

export function writeComposerDraft(
  storage: DraftStorage,
  scope: ComposerDraftScope,
  text: string,
  updatedAt = Date.now(),
): void {
  const key = composerDraftKey(scope);
  if (!text.trim()) {
    storage.removeItem(key);
    return;
  }
  const value: StoredComposerDraft = {
    version: DRAFT_VERSION,
    directory: scope.directory,
    sessionID: scope.sessionID,
    text,
    updatedAt,
  };
  storage.setItem(key, JSON.stringify(value));
}
