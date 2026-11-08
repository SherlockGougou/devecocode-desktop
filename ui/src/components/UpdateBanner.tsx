import { useApp } from "../store";
import {
  checkForUpdates,
  dismissUpdateBanner,
  formatBytes,
  installUpdate,
  openReleaseNotes,
  restartForUpdate,
  useUpdate,
} from "../update";
import { Icon } from "./Icon";

/** 主窗口顶部的更新提示。只在用户需要做决定或看到进度时出现。 */
export default function UpdateBanner() {
  const status = useUpdate((s) => s.status);
  const version = useUpdate((s) => s.version);
  const error = useUpdate((s) => s.error);
  const errorDetail = useUpdate((s) => s.errorDetail);
  const downloaded = useUpdate((s) => s.downloaded);
  const total = useUpdate((s) => s.total);
  const dismissed = useUpdate((s) => s.bannerDismissed);
  const streaming = useApp((s) => s.streaming);
  const queuedMessages = useApp((s) => s.queuedMessages);

  if (dismissed) return null;
  if (
    status !== "available" &&
    status !== "downloading" &&
    status !== "installing" &&
    status !== "ready-to-restart" &&
    status !== "error"
  ) {
    return null;
  }

  const percent = total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  const queued = Object.values(queuedMessages).reduce((sum, items) => sum + items.length, 0);

  const restart = () => {
    if (
      (streaming || queued > 0) &&
      !window.confirm(
        `当前${streaming ? "有会话正在执行" : "有排队消息"}${queued > 0 ? `（排队 ${queued} 条）` : ""}。重启会中断任务并丢失内存中的排队消息，仍要重启吗？`,
      )
    ) {
      return;
    }
    void restartForUpdate();
  };

  return (
    <div
      className={`update-banner ${status}`}
      role="region"
      aria-label="应用更新"
      aria-live="polite"
    >
      <Icon name="download" size={16} />
      <div className="update-banner-copy">
        {status === "available" && (
          <>
            <strong>发现新版本 {version ? `v${version}` : ""}</strong>
            <span>下载完成后由你确认重启，不会中断正在执行的任务。</span>
          </>
        )}
        {status === "downloading" && (
          <>
            <strong>正在下载更新 {version ? `v${version}` : ""}</strong>
            <span>
              {percent !== null
                ? `${percent}% · ${formatBytes(downloaded)} / ${formatBytes(total ?? 0)}`
                : `已下载 ${formatBytes(downloaded)}`}
            </span>
          </>
        )}
        {status === "installing" && (
          <>
            <strong>正在安装更新</strong>
            <span>安装完成后会提示重启应用。</span>
          </>
        )}
        {status === "ready-to-restart" && (
          <>
            <strong>更新 {version ? `v${version}` : ""} 已安装</strong>
            <span>重启应用后生效；继续使用旧进程也可以，下次启动会自动加载新版本。</span>
          </>
        )}
        {status === "error" && (
          <>
            <strong>更新未完成</strong>
            <span title={errorDetail ?? undefined}>{error}</span>
          </>
        )}
        {status === "downloading" && (
          <div
            className="update-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <span style={{ width: percent !== null ? `${percent}%` : "35%" }} />
          </div>
        )}
      </div>
      <div className="update-banner-actions">
        {status === "available" && (
          <button className="primary-btn" onClick={() => void installUpdate()}>
            下载并安装
          </button>
        )}
        {status === "ready-to-restart" && (
          <button className="primary-btn" onClick={restart}>
            立即重启
          </button>
        )}
        {status === "error" && (
          <button
            className="primary-btn"
            onClick={() =>
              void (useUpdate.getState().errorSource === "install"
                ? installUpdate()
                : checkForUpdates())
            }
          >
            重试
          </button>
        )}
        {(status === "available" || status === "ready-to-restart" || status === "error") && (
          <button className="ghost-btn" onClick={() => void openReleaseNotes(version)}>
            发布说明
          </button>
        )}
        {(status === "available" || status === "ready-to-restart" || status === "error") && (
          <button
            className="icon-btn"
            onClick={dismissUpdateBanner}
            title="稍后"
            aria-label="稍后"
          >
            <Icon name="close" size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
