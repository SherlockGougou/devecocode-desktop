import assert from "node:assert/strict";
import test from "node:test";
import { awaitPermissionPatch } from "../test-dist/permissionGate.js";

test("权限成功写入后才允许发送", async () => {
  await assert.doesNotReject(awaitPermissionPatch(Promise.resolve("ok")));
});

test("权限写入失败或已被新请求取代时取消发送", async () => {
  for (const result of ["failed", "superseded"]) {
    await assert.rejects(
      awaitPermissionPatch(Promise.resolve(result)),
      /会话权限未成功应用/,
    );
  }
});
