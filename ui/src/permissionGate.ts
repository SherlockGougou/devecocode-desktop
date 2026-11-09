export type PermissionPatchResult = "ok" | "failed" | "superseded";

/** 权限规则没有成功落地时，禁止用旧规则启动下一轮 prompt。 */
export async function awaitPermissionPatch(
  patch: Promise<PermissionPatchResult>,
): Promise<void> {
  const result = await patch;
  if (result !== "ok") {
    throw new Error("会话权限未成功应用，已取消本次发送");
  }
}
