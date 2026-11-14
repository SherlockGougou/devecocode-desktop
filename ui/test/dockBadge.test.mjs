import assert from "node:assert/strict";
import test from "node:test";

import { dockBadgeLabel } from "../src/dockBadge.ts";

test("没有未读会话时清除 Dock 角标", () => {
  assert.equal(dockBadgeLabel(0), undefined);
  assert.equal(dockBadgeLabel(-1), undefined);
});

test("未读数量直接显示为数字", () => {
  assert.equal(dockBadgeLabel(1), "1");
  assert.equal(dockBadgeLabel(12), "12");
  assert.equal(dockBadgeLabel(99), "99");
});

test("超过两位数收敛为 99+", () => {
  assert.equal(dockBadgeLabel(100), "99+");
  assert.equal(dockBadgeLabel(1234), "99+");
});
