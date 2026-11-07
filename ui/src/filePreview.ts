/** 文件面板预览的格式判定。
 *
 * CLI 的 `/file/content` 对二进制文件返回 base64，并尽量带上 mimeType；
 * 文本文件只返回 type=text。这里只做展示层分类，不尝试解析文件内容。
 */

export type PreviewKind =
  | "loading"
  | "text"
  | "markdown"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "quicklook"
  | "unsupported"
  | "error";

export interface FilePreview {
  path: string;
  absolute: string;
  kind: PreviewKind;
  /** 文本正文；二进制文件为 base64。 */
  content: string;
  mime: string;
  /** Quick Look 生成的 PNG。 */
  thumbnail: Blob | null;
  message?: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const NATIVE_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
]);

/** 这些文件通常体积大且浏览器不能直接展示，先走 Quick Look，避免把整份文件传进 WebView。 */
const QUICKLOOK_FIRST_EXTENSIONS = new Set([
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "pages",
  "numbers",
  "key",
  "rtf",
  "odt",
  "ods",
  "odp",
  "epub",
  "heic",
  "heif",
  "tif",
  "tiff",
  "bmp",
  "ico",
  "psd",
  "sketch",
]);

export function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function mimeForPath(path: string): string {
  return MIME_BY_EXTENSION[fileExtension(path)] ?? "";
}

export function isMarkdownFile(path: string): boolean {
  return /^(md|markdown)$/i.test(fileExtension(path));
}

export function quickLookFirst(path: string): boolean {
  return QUICKLOOK_FIRST_EXTENSIONS.has(fileExtension(path));
}

export function classifyPreview(
  path: string,
  sourceType: string | undefined,
  mimeType: string | undefined,
): PreviewKind {
  if (sourceType === "text") {
    return isMarkdownFile(path) ? "markdown" : "text";
  }
  if (sourceType !== "binary") return "unsupported";

  const mime = (mimeType || mimeForPath(path)).split(";")[0].trim().toLowerCase();
  if (mime === "application/pdf" || fileExtension(path) === "pdf") return "pdf";
  if (NATIVE_IMAGE_MIMES.has(mime)) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "unsupported";
}

export function hasCopyableText(preview: FilePreview): boolean {
  return preview.kind === "text" || preview.kind === "markdown";
}
