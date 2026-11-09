import assert from "node:assert/strict";
import test from "node:test";
import {
  canControlPermission,
  controllablePermissionTools,
  ownedPermissionMode,
  rulesForMode,
} from "../test-dist/sessionPermission.js";

function agent(permission) {
  return { name: "test", permission };
}

function wildcard(pattern, value) {
  if (pattern === "*") return true;
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${source}$`).test(value);
}

function actionFor(rules, tool, value) {
  let action = null;
  for (const rule of rules) {
    if (
      (rule.permission === tool || rule.permission === "*") &&
      wildcard(rule.pattern, value)
    ) {
      action = rule.action;
    }
  }
  return action;
}

test("具体 deny 在切换会话模式后仍然优先", () => {
  const info = agent([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm *", action: "deny" },
  ]);
  const sessionRules = rulesForMode("ask", info);
  const effective = [...info.permission, ...sessionRules];

  assert.equal(actionFor(effective, "bash", "git status"), "ask");
  assert.equal(actionFor(effective, "bash", "rm -rf build"), "deny");
  assert.equal(ownedPermissionMode({ permission: sessionRules }, info), "ask");
});

test("Agent 兜底 deny 不能被完全访问重新开放", () => {
  const info = agent([
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "git *", action: "allow" },
  ]);
  const sessionRules = rulesForMode("allow", info);
  const effective = [...info.permission, ...sessionRules];

  assert.deepEqual(controllablePermissionTools(info), []);
  assert.equal(canControlPermission(info), false);
  assert.equal(
    sessionRules.some(
      (rule) =>
        rule.permission === "bash" &&
        rule.pattern === "*" &&
        rule.action === "allow",
    ),
    false,
  );
  assert.equal(actionFor(effective, "bash", "git status"), "allow");
  assert.equal(actionFor(effective, "bash", "rm -rf build"), "deny");
});

test("整体 deny 的工具保持限制，其余工具仍可切换模式", () => {
  const info = agent([
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "deny" },
  ]);
  const sessionRules = rulesForMode("ask", info);
  const effective = [...info.permission, ...sessionRules];

  assert.equal(actionFor(effective, "bash", "git status"), "deny");
  assert.equal(actionFor(effective, "external_directory", "/tmp/a.png"), "ask");
  assert.equal(ownedPermissionMode({ permission: sessionRules }, info), "ask");
});
