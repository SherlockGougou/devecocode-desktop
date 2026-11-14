import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canUndoVoice,
  insertVoiceTranscript,
  normalizeVoiceTranscript,
  undoVoiceInsertion,
} from "../test-dist/voice.js";

test("空识别结果不修改草稿", () => {
  assert.equal(insertVoiceTranscript("已有内容", "   ", { start: 0, end: 0 }), null);
});

test("中文直接插入且不加空格", () => {
  const result = insertVoiceTranscript("请检查", "登录页面", { start: 4, end: 4 });
  assert.equal(result?.afterText, "请检查登录页面");
  assert.equal(result?.caret, 7);
});

test("中英文边界补空格", () => {
  const result = insertVoiceTranscript("fix ", "登录 bug", { start: 4, end: 4 });
  assert.equal(result?.afterText, "fix 登录 bug");
});

test("英文单词之间补空格并替换选区", () => {
  const result = insertVoiceTranscript("run old test", "new", { start: 4, end: 7 });
  assert.equal(result?.afterText, "run new test");
  assert.equal(result?.insertedStart, 4);
  assert.equal(result?.insertedEnd, 7);
});

test("换行和制表符归一化为空格", () => {
  assert.equal(normalizeVoiceTranscript("  hello\n\tworld  "), "hello world");
});

test("撤销要求正文仍是插入后的快照", () => {
  const result = insertVoiceTranscript("abc", "def", { start: 3, end: 3 });
  assert.ok(result);
  assert.equal(canUndoVoice(result, "abc def"), true);
  assert.equal(canUndoVoice(result, "abc def 后续"), false);
  assert.deepEqual(undoVoiceInsertion(result), { text: "abc", start: 3, end: 3 });
});
