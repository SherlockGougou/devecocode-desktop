//! 纯前端显示偏好：字体选择只影响当前桌面端，不进入 Rust 或 deveco 配置。

const UI_FONT_KEY = "deveco.desktop.uiFont";
const MONO_FONT_KEY = "deveco.desktop.monoFont";
const UI_FONT_FALLBACK = '-apple-system, "SF Pro Text", "PingFang SC", sans-serif';
const MONO_FONT_FALLBACK = 'ui-monospace, "SF Mono", Menlo, monospace';

export function getUIFont(): string {
  return localStorage.getItem(UI_FONT_KEY) ?? "";
}

export function getMonoFont(): string {
  return localStorage.getItem(MONO_FONT_KEY) ?? "";
}

function family(value: string): string {
  if (/^[\w-]+$/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function fontStack(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed ? `${family(trimmed)}, ${fallback}` : fallback;
}

export function applyFontPreferences() {
  const root = document.documentElement;
  root.style.setProperty("--font-ui", fontStack(getUIFont(), UI_FONT_FALLBACK));
  root.style.setProperty("--font-mono", fontStack(getMonoFont(), MONO_FONT_FALLBACK));
}

export function setUIFont(value: string) {
  const trimmed = value.trim();
  if (trimmed) localStorage.setItem(UI_FONT_KEY, trimmed);
  else localStorage.removeItem(UI_FONT_KEY);
  applyFontPreferences();
}

export function setMonoFont(value: string) {
  const trimmed = value.trim();
  if (trimmed) localStorage.setItem(MONO_FONT_KEY, trimmed);
  else localStorage.removeItem(MONO_FONT_KEY);
  applyFontPreferences();
}

export function initFontPreferences() {
  applyFontPreferences();
}
