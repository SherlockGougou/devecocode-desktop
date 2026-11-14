/** Dock 角标使用系统数字徽标；超过两位数时收敛为 99+，避免占用过多宽度。 */
export function dockBadgeLabel(count: number): string | undefined {
  if (!Number.isFinite(count) || count <= 0) return undefined;
  const value = Math.floor(count);
  return value > 99 ? "99+" : String(value);
}
