import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useApp } from "./store";

function reportError(message: string) {
  useApp.setState({ error: message });
}

/** 复制文本；message 为 null 时只返回结果，不弹提示。 */
export async function copyText(
  text: string,
  message: string | null = "已复制",
): Promise<boolean> {
  try {
    await writeText(text);
    if (message) useApp.getState().showNotice(message, 1600);
    return true;
  } catch (error) {
    reportError(`复制失败：${String(error)}`);
    return false;
  }
}

export async function readClipboardText(): Promise<string> {
  try {
    return await readText();
  } catch (error) {
    reportError(`读取剪贴板失败：${String(error)}`);
    return "";
  }
}
