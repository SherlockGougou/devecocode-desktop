import { api } from "./api";
import { useApp } from "./store";

/** 用系统默认应用打开文件或目录；失败统一走全局提示条。 */
export async function openDefaultApp(path: string) {
  try {
    await api.openPath(path);
  } catch (error) {
    useApp.setState({ error: String(error) });
  }
}
