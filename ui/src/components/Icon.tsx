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
  | "panel-right"
  | "download"
  | "external"
  | "copy"
  | "check"
  | "stop"
  | "paperclip"
  | "image"
  | "file"
  | "folder"
  | "folder-up"
  | "refresh"
  | "alert";

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
