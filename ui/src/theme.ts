//! 主题：跟随系统深浅色，也可以在设置页显式选亮色/暗色。
//!
//! 暗色是设计基准，亮色只覆盖 CSS 变量。选择存 localStorage（纯前端偏好，
//! 不进 Rust 配置，避免为了一个显示选项改动配置契约）。

const STORAGE_KEY = "deveco.desktop.theme";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

export type ThemeChoice = "system" | "light" | "dark";

export function getThemeChoice(): ThemeChoice {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

/** 把选择落到 `<html data-theme>`；`system` 时按当前系统外观解析 */
export function applyTheme(choice: ThemeChoice = getThemeChoice()) {
  const root = document.documentElement;
  // 页面已经在 HTML 上显式指定过主题（截图工具/外部嵌入）且用户没选过，就尊重它
  if (!localStorage.getItem(STORAGE_KEY) && root.dataset.theme) return;

  const resolved = choice === "system" ? (window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark") : choice;
  root.dataset.theme = resolved;
}

export function setThemeChoice(choice: ThemeChoice) {
  localStorage.setItem(STORAGE_KEY, choice);
  applyTheme(choice);
}

export function initTheme() {
  applyTheme();
  // 只有「跟随系统」时才响应外观切换；显式选过的不受影响
  window.matchMedia(LIGHT_QUERY).addEventListener("change", () => {
    if (getThemeChoice() === "system") applyTheme("system");
  });
}
