import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import type { Attachment } from "./types";

/** 与 composer 的附件上限保持一致，选择文件和粘贴截图共用同一套规则 */
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

let attachmentSeq = 0;

function nextId(prefix: string) {
  attachmentSeq += 1;
  return `${prefix}-${Date.now()}-${attachmentSeq}`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** 截图没有文件名，用本地时间生成稳定、可读的名称 */
export function pastedImageName(mime = "image/png", now = new Date()) {
  const subtype = mime.startsWith("image/") ? mime.slice(6).replace("+xml", "") : "png";
  const extension = subtype === "jpeg" ? "jpg" : subtype || "png";
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `screenshot-${date}-${time}.${extension}`;
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取附件失败"));
    reader.readAsDataURL(blob);
  });
}

/** 文件/Blob 转 Attachment；只拒绝超出大小上限的文件，读取失败向上抛给调用方 */
export async function blobToAttachment(
  blob: Blob,
  name: string,
  mime = blob.type || "application/octet-stream",
  prefix = "file",
): Promise<Attachment | null> {
  if (blob.size > MAX_ATTACHMENT_BYTES) return null;
  return {
    id: nextId(prefix),
    name,
    mime,
    url: await blobToDataURL(blob),
    size: blob.size,
  };
}

/**
 * 直接从系统剪贴板读取图片并重编码为 PNG。
 * WKWebView 的 paste 事件有时只暴露剪贴板类型、不给出可直接读取的 File，
 * 这时插件返回的 RGBA 是唯一稳定的来源。
 */
export async function clipboardImageToAttachment(): Promise<Attachment | null> {
  let image: Awaited<ReturnType<typeof readImage>> | null = null;
  try {
    image = await readImage();
    const { width, height } = await image.size();
    if (!width || !height) return null;
    const rgba = await image.rgba();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) return null;
    return await blobToAttachment(blob, pastedImageName(), "image/png", "pasted");
  } catch {
    // 剪贴板里没有图片时会抛错，这是文本粘贴的常态，不向上报错
    return null;
  } finally {
    if (image) await image.close().catch(() => undefined);
  }
}
