import assert from "node:assert/strict";
import test from "node:test";

import {
  isSubagentSession,
  rootSessions,
  stripSubagentTitle,
} from "../src/sessionTree.ts";

test("有 parentID 的会话按子会话处理", () => {
  assert.equal(
    isSubagentSession({ parentID: "ses_parent", title: "独立标题" }),
    true,
  );
});

test("旧子会话只有标题标记时也能识别", () => {
  assert.equal(
    isSubagentSession({
      title: "检查构建配置 (@build subagent)",
    }),
    true,
  );
  assert.equal(isSubagentSession({ title: "普通会话（保留 fork）" }), false);
});

test("根会话列表不包含子会话", () => {
  const root = { id: "ses_root", title: "主会话" };
  const child = {
    id: "ses_child",
    title: "子任务 (@explore subagent)",
    parentID: root.id,
  };
  assert.deepEqual(rootSessions([root, child]), [root]);
});

test("子会话标题去掉 CLI 的子代理后缀", () => {
  assert.equal(
    stripSubagentTitle("检查构建配置 (@build subagent)"),
    "检查构建配置",
  );
  assert.equal(stripSubagentTitle("普通标题"), "普通标题");
});
