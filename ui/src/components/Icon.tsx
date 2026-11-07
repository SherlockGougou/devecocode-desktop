//! 统一图标集：线性 SVG（24 视框、1.75 描边、currentColor）。
//!
//! 之前界面用 `⌕ ✎ ⇩ ↩ ⚙ ◫` 这类 Unicode 字形当图标，问题有三个：
//! 字形墨迹只占 em 的一半左右（12px 字号看起来只有 8px 大）、
//! 不同字体的基线/粗细不一致、部分字形在系统里会回退成方框。
//! 统一换成同一视框、同一描边宽度的 SVG 后，尺寸可控、主题跟随、
//! 也不会被字体替换影响。

import type { ReactNode } from "react";

export type IconName =
  | "plus"
  | "search"
  | "chevron-right"
  | "chevron-down"
  | "arrow-up"
  | "arrow-down"
  | "arrow-left"
  | "close"
  | "pencil"
  | "archive"
  | "unarchive"
  | "trash"
  | "sliders"
  | "panel-left"
  | "panel-right"
  | "download"
  | "external"
  | "pin"
  | "copy"
  | "check"
  | "stop"
  | "paperclip"
  | "image"
  | "file"
  | "compose"
  | "workspace"
  | "folder"
  | "folder-up"
  | "refresh"
  | "alert"
  | "spark"
  | "branch"
  | "list"
  | "undo"
  | "redo"
  | "scissors"
  | "clipboard"
  | "select-all"
  | "keyboard"
  | "appearance"
  | "terminal"
  | "device"
  | "server"
  | "bell"
  | "activity"
  | "account"
  | "puzzle";

const ICONS: Record<IconName, ReactNode> = {
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.6" />
      <path d="m20 20-4.4-4.4" />
    </>
  ),
  "chevron-right": <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  "chevron-down": <path d="m5.5 9.5 6.5 6.5 6.5-6.5" />,
  "arrow-up": <path d="M12 19.5V5M5.8 11.2 12 5l6.2 6.2" />,
  "arrow-down": <path d="M12 4.5V19M5.8 12.8 12 19l6.2-6.2" />,
  "arrow-left": <path d="M19.5 12h-15M10.8 5.8 5 12l5.8 6.2" />,
  close: <path d="m6.6 6.6 10.8 10.8M17.4 6.6 6.6 17.4" />,
  pencil: <path d="M16.6 3.8a2.1 2.1 0 0 1 3 3L7.9 18.5l-4.2 1.1 1.1-4.2z" />,
  archive: (
    <>
      <rect x="3.5" y="4.6" width="17" height="4" rx="1.2" />
      <path d="M5.6 8.6v10.2a1.2 1.2 0 0 0 1.2 1.2h10.4a1.2 1.2 0 0 0 1.2-1.2V8.6" />
      <path d="M10 12.6h4" />
    </>
  ),
  unarchive: (
    <>
      <rect x="3.5" y="4.6" width="17" height="4" rx="1.2" />
      <path d="M5.6 8.6v10.2a1.2 1.2 0 0 0 1.2 1.2h10.4a1.2 1.2 0 0 0 1.2-1.2V8.6" />
      <path d="M12 16.8v-4.6M9.6 14.4 12 12l2.4 2.4" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" />
      <path d="M6.6 7l.8 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.4 7" />
      <path d="M10.2 11.2v5.4M13.8 11.2v5.4" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h6M14 7h6" />
      <circle cx="12" cy="7" r="2" />
      <path d="M4 12h10M18 12h2" />
      <circle cx="16" cy="12" r="2" />
      <path d="M4 17h4M12 17h8" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  "panel-right": (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
      <path d="M15 4.5v15" />
    </>
  ),
  "panel-left": (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
      <path d="M9 4.5v15" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.5V15M7.8 10.8 12 15l4.2-4.2" />
      <path d="M5 19.5h14" />
    </>
  ),
  external: (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5 11.5 12.5" />
      <path d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5" />
    </>
  ),
  pin: (
    <>
      <path d="M9 4.5h6M12 4.5v6.1l3 2.4v1.4H9V13l3-2.4V4.5" />
      <path d="M12 14.4v5.1" />
    </>
  ),
  copy: (
    <>
      <rect x="8.6" y="8.6" width="11.4" height="11.4" rx="2" />
      <path d="M15.4 8.6V5.4a1.8 1.8 0 0 0-1.8-1.8H5.4a1.8 1.8 0 0 0-1.8 1.8v8.2c0 1 .8 1.8 1.8 1.8h3.2" />
    </>
  ),
  check: <path d="m5 12.8 4.4 4.4L19 7.6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none" />,
  paperclip: (
    <path d="M20 11.6 12.5 19a4.4 4.4 0 0 1-6.2-6.2l7.6-7.6a3 3 0 0 1 4.2 4.2l-7.6 7.6a1.5 1.5 0 1 1-2.1-2.1l6.9-6.9" />
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <circle cx="9" cy="9.8" r="1.5" />
      <path d="m4.4 18.4 5.2-5.2 3.6 3.6 3-3 3.4 3.4" />
    </>
  ),
  file: (
    <>
      <path d="M14.2 3.6H7.6a2 2 0 0 0-2 2v12.8a2 2 0 0 0 2 2h8.8a2 2 0 0 0 2-2V8z" />
      <path d="M14 3.6v4.6h4.6" />
    </>
  ),
  // 新建会话：方形纸面 + 右上角加号（对齐参考截图的 compose 图标）
  compose: (
    <>
      <path d="M20 11.4v6.4a2.2 2.2 0 0 1-2.2 2.2H6.2A2.2 2.2 0 0 1 4 17.8V7.4A2.2 2.2 0 0 1 6.2 5.2h5.6" />
      <path d="M17.9 3.4v6.2M14.8 6.5h6.2" />
    </>
  ),
  // 工作区文件夹：带翻盖横线的开口文件夹，单个图形在 16–18px 下也认得出是「目录」
  workspace: (
    <>
      <path d="M3.7 7.8a2 2 0 0 1 2-2h3.2c.55 0 1.07.22 1.46.6l1.22 1.22h6.72a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2H5.7a2 2 0 0 1-2-2z" />
      <path d="M8.1 13.4h7.8" />
    </>
  ),
  folder: (
    <path d="M3.5 8.2A2 2 0 0 1 5.5 6.2h3.1c.5 0 1 .2 1.4.6l1.3 1.3h6.2a2 2 0 0 1 2 2v7.7a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2z" />
  ),
  "folder-up": (
    <>
      <path d="M3.5 8.2A2 2 0 0 1 5.5 6.2h3.1c.5 0 1 .2 1.4.6l1.3 1.3h6.2a2 2 0 0 1 2 2v7.7a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2z" />
      <path d="M12 17v-4.4M9.8 14.6 12 12.4l2.2 2.2" />
    </>
  ),
  refresh: (
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.5 4.6v4.8h-4.8" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.2 21 19.8H3z" />
      <path d="M12 10v4.2M12 17h.01" />
    </>
  ),
  // 思考过程：不对称的四角星，比灯泡更像“内部推理”而不是提示或灵感
  spark: (
    <>
      <path d="M12 3.6c.7 4.3 2.1 5.7 6.4 6.4-4.3.7-5.7 2.1-6.4 6.4-.7-4.3-2.1-5.7-6.4-6.4 4.3-.7 5.7-2.1 6.4-6.4Z" />
      <path d="M18.4 15.5c.3 1.6.8 2.1 2.4 2.4-1.6.3-2.1.8-2.4 2.4-.3-1.6-.8-2.1-2.4-2.4 1.6-.3 2.1-.8 2.4-2.4Z" />
    </>
  ),
  branch: (
    <>
      <circle cx="6.5" cy="6.2" r="2.2" />
      <circle cx="6.5" cy="17.8" r="2.2" />
      <circle cx="17.5" cy="12" r="2.2" />
      <path d="M6.5 8.4v3.4a4 4 0 0 0 4 4h1.2M8.7 12h2.4a4 4 0 0 0 4-4V7" />
    </>
  ),
  list: (
    <>
      <path d="M9 6.5h10M9 12h10M9 17.5h10" />
      <path d="m4.2 6.2.7.7 1.4-1.5M4.2 11.7l.7.7 1.4-1.5M4.2 17.2l.7.7 1.4-1.5" />
    </>
  ),
  undo: (
    <>
      <path d="m8.2 7.2-4 4 4 4" />
      <path d="M4.6 11.2h8.2a5.2 5.2 0 0 1 5.2 5.2v.2" />
    </>
  ),
  redo: (
    <>
      <path d="m15.8 7.2 4 4-4 4" />
      <path d="M19.4 11.2h-8.2A5.2 5.2 0 0 0 6 16.4v.2" />
    </>
  ),
  scissors: (
    <>
      <circle cx="6.2" cy="7" r="2.1" />
      <circle cx="6.2" cy="17" r="2.1" />
      <path d="m8 8.3 10.8 7.3M8 15.7 18.8 8.4" />
    </>
  ),
  clipboard: (
    <>
      <rect x="5" y="5.2" width="14" height="15" rx="2" />
      <path d="M9 5.2V3.8h6v1.4" />
      <path d="M8.5 10.2h7M8.5 14h7" />
    </>
  ),
  "select-all": (
    <>
      <path d="M8 4H5.2A1.2 1.2 0 0 0 4 5.2V8M16 4h2.8A1.2 1.2 0 0 1 20 5.2V8M20 16v2.8a1.2 1.2 0 0 1-1.2 1.2H16M8 20H5.2A1.2 1.2 0 0 1 4 18.8V16" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M19 10h.01M7 14h.01M19 14h.01M10.5 14h3" />
    </>
  ),
  appearance: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5l1.5 1.5M17 17l1.5 1.5M18.5 5.5 17 7M7 17l-1.5 1.5" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
      <path d="m7.2 9 3 3-3 3M13 15h3.8" />
    </>
  ),
  device: (
    <>
      <rect x="6.4" y="2.8" width="11.2" height="18.4" rx="2.6" />
      <path d="M10.3 18.2h3.4" />
    </>
  ),
  server: (
    <>
      <rect x="3.5" y="4.5" width="17" height="6" rx="1.7" />
      <rect x="3.5" y="13.5" width="17" height="6" rx="1.7" />
      <path d="M7 7.5h.01M7 16.5h.01M11 7.5h5.8M11 16.5h5.8" />
    </>
  ),
  bell: (
    <>
      <path d="M18 9.5a6 6 0 0 0-12 0c0 4.8-2 6-2 6h16s-2-1.2-2-6Z" />
      <path d="M9.8 19a2.4 2.4 0 0 0 4.4 0" />
    </>
  ),
  activity: <path d="M3 12h4l2.2-5 4.1 10 2.2-5H21" />,
  account: (
    <>
      <circle cx="12" cy="8.2" r="3.4" />
      <path d="M5.4 20a6.6 6.6 0 0 1 13.2 0" />
    </>
  ),
  puzzle: (
    <path d="M9.2 4.4a2 2 0 0 1 3.9 0c0 .7-.3 1.2-.8 1.7h3.2a1.5 1.5 0 0 1 1.5 1.5v3.2c.5-.5 1-.8 1.7-.8a2 2 0 0 1 0 3.9c-.7 0-1.2-.3-1.7-.8v3.2a1.5 1.5 0 0 1-1.5 1.5h-3.2c.5.5.8 1 .8 1.7a2 2 0 0 1-3.9 0c0-.7.3-1.2.8-1.7H7.7a1.5 1.5 0 0 1-1.5-1.5v-3.2c-.5.5-1 .8-1.7.8a2 2 0 0 1 0-3.9c.7 0 1.2.3 1.7.8V7.6a1.5 1.5 0 0 1 1.5-1.5H11c-.5-.5-.8-1-.8-1.7Z" />
  ),
};

export function Icon({
  name,
  size = 16,
  className,
  strokeWidth = 1.75,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={className ? `ico ${className}` : "ico"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}
