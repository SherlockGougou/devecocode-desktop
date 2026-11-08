import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { api } from "./api";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "ready-to-restart"
  | "error";

export interface UpdateStore {
  status: UpdateStatus;
  version: string | null;
  notes: string | null;
  error: string | null;
  errorDetail: string | null;
  errorSource: "check" | "install" | null;
  lastError: string | null;
  lastCheckedAt: number | null;
  downloaded: number;
  total: number | null;
  bannerDismissed: boolean;
  autoCheck: boolean;
}

export const AUTO_CHECK_DELAY_MS = 8_000;
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const RELEASE_BASE_URL =
  "https://github.com/SherlockGougou/devecocode-desktop/releases";

const BUSY_STATUSES: UpdateStatus[] = [
  "checking",
  "downloading",
  "installing",
  "ready-to-restart",
];

export const useUpdate = create<UpdateStore>(() => ({
  status: "idle",
  version: null,
  notes: null,
  error: null,
  errorDetail: null,
  errorSource: null,
  lastError: null,
  lastCheckedAt: null,
  downloaded: 0,
  total: null,
  bannerDismissed: false,
  autoCheck: true,
}));

let pendingUpdate: Update | null = null;
let checking: Promise<void> | null = null;
let autoCheckTimer: ReturnType<typeof setTimeout> | null = null;
let autoCheckInterval: ReturnType<typeof setInterval> | null = null;

/** 发布说明使用 GitHub Release 标签页；没有版本号时退回最新 Release。 */
export function releaseNotesUrl(version: string | null): string {
  if (!version) return `${RELEASE_BASE_URL}/latest`;
  return `${RELEASE_BASE_URL}/tag/v${version.replace(/^v/, "")}`;
}

export async function openReleaseNotes(version: string | null): Promise<void> {
  await api.openUrl(releaseNotesUrl(version));
}

export function dismissUpdateBanner(): void {
  useUpdate.setState({ bannerDismissed: true });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${Math.round(bytes)} B`;
}

export function formatCheckTime(timestamp: number | null): string {
  if (!timestamp) return "尚未检查";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function friendlyError(error: unknown): string {
  const text = rawMessage(error);
  const lower = text.toLowerCase();
  if (
    lower.includes("authentication failed") ||
    lower.includes("was cancelled") ||
    lower.includes("user canceled")
  ) {
    return "已取消管理员授权，更新没有安装。";
  }
  if (
    lower.includes("signature") ||
    lower.includes("minisign") ||
    lower.includes("trusted comment") ||
    lower.includes("signed version") ||
    lower.includes("signed for version")
  ) {
    return "更新包签名或版本校验失败，已取消安装。";
  }
  if (
    lower.includes("temp directory is not on the same mount point") ||
    lower.includes("permission denied") ||
    lower.includes("operation not permitted") ||
    lower.includes("failed to create temporary directory") ||
    lower.includes("failed to install the update")
  ) {
    return "无法替换当前应用。请先把应用移动到“应用程序”文件夹，再重试。";
  }
  if (
    lower.includes("could not fetch a valid release json") ||
    lower.includes("update endpoint did not respond")
  ) {
    return "暂时无法获取更新清单；可能尚未发布新版本，或网络不可用。";
  }
  if (
    lower.includes("could not fetch") ||
    lower.includes("network") ||
    lower.includes("timed out") ||
    lower.includes("dns") ||
    lower.includes("404") ||
    lower.includes("error sending request")
  ) {
    return "无法连接更新服务器，请检查网络后重试。";
  }
  return `更新失败：${text}`;
}

/**
 * 检查更新。silent 用于启动后的自动检查：失败时不弹横幅，只保留手动检查入口。
 * 手动检查在下载、安装或等待重启期间不会重复发起。
 */
export async function checkForUpdates(options?: {
  silent?: boolean;
}): Promise<void> {
  const silent = options?.silent ?? false;
  const status = useUpdate.getState().status;
  if (checking) return checking;
  if (BUSY_STATUSES.includes(status)) return;

  useUpdate.setState({
    status: "checking",
    error: null,
    errorDetail: null,
    errorSource: null,
    lastError: null,
  });

  checking = (async () => {
    try {
      const update = await check();
      pendingUpdate = update;
      useUpdate.setState({
        lastCheckedAt: Date.now(),
        ...(update
          ? {
              status: "available" as const,
              version: update.version,
              notes: update.body ?? null,
              bannerDismissed: false,
            }
          : {
              status: "up-to-date" as const,
              version: null,
              notes: null,
            }),
      });
    } catch (error) {
      useUpdate.setState({ lastCheckedAt: Date.now() });
      if (silent) {
        useUpdate.setState({ status: "idle", lastError: friendlyError(error) });
      } else {
        useUpdate.setState({
          status: "error",
          error: friendlyError(error),
          errorDetail: rawMessage(error),
          errorSource: "check",
          lastError: friendlyError(error),
          bannerDismissed: false,
        });
      }
    } finally {
      checking = null;
    }
  })();

  return checking;
}

/** 下载并安装更新；安装完成后保留当前进程，由用户决定何时重启。 */
export async function installUpdate(): Promise<void> {
  if (!pendingUpdate) {
    await checkForUpdates();
    return;
  }
  const status = useUpdate.getState().status;
  if (
    status === "downloading" ||
    status === "installing" ||
    status === "ready-to-restart"
  ) {
    return;
  }

  useUpdate.setState({
    status: "downloading",
    downloaded: 0,
    total: null,
    error: null,
    errorDetail: null,
    errorSource: null,
    lastError: null,
    bannerDismissed: false,
  });

  let downloaded = 0;
  let total: number | null = null;
  let lastPercent = -1;
  let lastPaint = 0;

  try {
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
        useUpdate.setState({ total });
        return;
      }
      if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        const percent = total ? Math.floor((downloaded / total) * 100) : -1;
        const now = Date.now();
        // 大包下载会高频回调；按 1% 或 200ms 节流，避免整个界面跟着重绘。
        if (percent !== lastPercent || now - lastPaint >= 200) {
          lastPercent = percent;
          lastPaint = now;
          useUpdate.setState({ downloaded, total });
        }
        return;
      }
      if (event.event === "Finished") {
        useUpdate.setState({
          status: "installing",
          downloaded: total ?? downloaded,
          total,
        });
      }
    });
    pendingUpdate = null;
    useUpdate.setState({
      status: "ready-to-restart",
      downloaded: 0,
      total: null,
      bannerDismissed: false,
    });
  } catch (error) {
    useUpdate.setState({
      status: "error",
      error: friendlyError(error),
      errorDetail: rawMessage(error),
      errorSource: "install",
      lastError: friendlyError(error),
      bannerDismissed: false,
    });
  }
}

export async function restartForUpdate(): Promise<void> {
  await api.restartApp();
}

/**
 * 配置启动检查。开发模式不自动联网，手动检查仍然可用。
 * 定时器只创建一次；关闭开关会清除，重新开启会重新安排。
 */
export function configureAutoCheck(enabled: boolean): void {
  useUpdate.setState({ autoCheck: enabled });
  if (!enabled) {
    if (autoCheckTimer) clearTimeout(autoCheckTimer);
    if (autoCheckInterval) clearInterval(autoCheckInterval);
    autoCheckTimer = null;
    autoCheckInterval = null;
    return;
  }
  if (import.meta.env.DEV) return;
  if (autoCheckTimer || autoCheckInterval) return;

  autoCheckTimer = setTimeout(() => {
    autoCheckTimer = null;
    void checkForUpdates({ silent: true });
  }, AUTO_CHECK_DELAY_MS);
  autoCheckInterval = setInterval(() => {
    void checkForUpdates({ silent: true });
  }, AUTO_CHECK_INTERVAL_MS);
}

