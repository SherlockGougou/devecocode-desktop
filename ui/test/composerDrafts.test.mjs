import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPOSER_DRAFT_PREFIX,
  composerDraftKey,
  readComposerDraft,
  writeComposerDraft,
} from "../test-dist/composerDrafts.js";

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("草稿按工作区和会话隔离并在重启后恢复", () => {
  const storage = memoryStorage();
  const first = { directory: "/workspace/a", sessionID: "ses_a" };
  const second = { directory: "/workspace/a", sessionID: "ses_b" };
  const anotherWorkspace = { directory: "/workspace/b", sessionID: "ses_a" };

  writeComposerDraft(storage, first, "第一处草稿", 100);
  writeComposerDraft(storage, second, "第二处草稿", 200);

  assert.deepEqual(readComposerDraft(storage, first), {
    text: "第一处草稿",
    updatedAt: 100,
  });
  assert.deepEqual(readComposerDraft(storage, second), {
    text: "第二处草稿",
    updatedAt: 200,
  });
  assert.equal(readComposerDraft(storage, anotherWorkspace), null);
  assert.notEqual(
    composerDraftKey(first),
    composerDraftKey({ directory: first.directory, sessionID: null }),
  );
});

test("空输入会清除当前草稿，不留下空白草稿", () => {
  const storage = memoryStorage();
  const scope = { directory: "/workspace/a", sessionID: null };

  writeComposerDraft(storage, scope, "待发送");
  assert.equal(readComposerDraft(storage, scope)?.text, "待发送");

  writeComposerDraft(storage, scope, " \n\t ");
  assert.equal(readComposerDraft(storage, scope), null);
  assert.equal(storage.values.size, 0);
});

test("损坏或上下文不匹配的草稿会明确报错", () => {
  const storage = memoryStorage();
  const scope = { directory: "/workspace/a", sessionID: "ses_a" };
  const key = composerDraftKey(scope);

  storage.setItem(key, "{broken");
  assert.throws(() => readComposerDraft(storage, scope), /草稿数据损坏/);

  storage.setItem(
    key,
    JSON.stringify({
      version: 1,
      directory: "/workspace/a",
      sessionID: "ses_b",
      text: "不属于当前会话",
      updatedAt: 100,
    }),
  );
  assert.throws(() => readComposerDraft(storage, scope), /不匹配/);
  assert.ok(key.startsWith(`${COMPOSER_DRAFT_PREFIX}:`));
});
