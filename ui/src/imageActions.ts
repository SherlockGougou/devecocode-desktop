import { api } from "./api";
import { useApp } from "./store";

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
};

function reportError(error: unknown) {
  useApp.setState({ error: String(error) });
}

/** data URL 的 MIME；其他来源按扩展名推断。 */
export function imageMimeFromSource(source: string): string | null {
  const data = /^data:([^;,]+)[;,]/.exec(source);
  if (data) return data[1].toLowerCase();
  const extension = source
    .split(/[?#]/)[0]
    .split(".")
    .pop()
    ?.toLowerCase();
  if (!extension) return null;
  const mime = Object.entries(EXTENSION_BY_MIME).find(([, ext]) => ext === extension)?.[0];
  if (mime) return mime;
  if (extension === "jpeg") return "image/jpeg";
  return `image/${extension}`;
}

function safeBase(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return cleaned.slice(0, 80) || "图片";
}

/** 生成另存为对话框的默认文件名。 */
export function imageFileName(
  source: string,
  alt?: string,
  mime?: string | null,
): string {
  const resolvedMime = mime ?? imageMimeFromSource(source);
  const extension = resolvedMime ? EXTENSION_BY_MIME[resolvedMime] : undefined;
  if (/^data:/i.test(source)) {
    return `${safeBase(alt ?? "图片")}.${extension ?? "png"}`;
  }
  const cleanSource = source.split(/[?#]/)[0];
  const raw = cleanSource.split("/").pop() ?? "";
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // 保留原字符串即可，后续仍会做文件名安全处理。
  }
  if (name && /\.[a-z0-9]{2,6}$/i.test(name)) return safeBase(name);
  const base = name || alt || "图片";
  return `${safeBase(base)}.${extension ?? "png"}`;
}

export async function copyImageSource(
  source: string,
  baseDir: string | null,
): Promise<void> {
  try {
    await api.copyImage(baseDir, source);
    useApp.getState().showNotice("图片已复制到剪贴板", 1600);
  } catch (error) {
    reportError(error);
  }
}

export async function saveImageSource(
  source: string,
  baseDir: string | null,
  defaultName: string,
): Promise<void> {
  try {
    const saved = await api.saveImage(baseDir, source, defaultName);
    if (!saved) return;
    const name = saved.split(/[\\/]/).pop() || saved;
    useApp.getState().showNotice(`图片已保存：${name}`, 2400);
  } catch (error) {
    reportError(error);
  }
}
