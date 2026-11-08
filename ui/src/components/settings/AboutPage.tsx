import { useApp } from "../../store";
import type { RuntimeInfo } from "../../types";
import {
  checkForUpdates,
  formatBytes,
  formatCheckTime,
  installUpdate,
  openReleaseNotes,
  restartForUpdate,
  useUpdate,
} from "../../update";
import { Row, SettingsSection, Toggle } from "./SettingsPrimitives";

export default function AboutPage({
  runtime,
  autoCheck,
  onAutoCheckChange,
}: {
  runtime: RuntimeInfo | null;
  autoCheck: boolean;
  onAutoCheckChange: (next: boolean) => void;
}) {
  const status = useUpdate((s) => s.status);
  const version = useUpdate((s) => s.version);
  const error = useUpdate((s) => s.error);
  const errorDetail = useUpdate((s) => s.errorDetail);
  const lastError = useUpdate((s) => s.lastError);
  const lastCheckedAt = useUpdate((s) => s.lastCheckedAt);
  const downloaded = useUpdate((s) => s.downloaded);
  const total = useUpdate((s) => s.total);
  const streaming = useApp((s) => s.streaming);
  const queuedMessages = useApp((s) => s.queuedMessages);
  const queued = Object.values(queuedMessages).reduce((sum, items) => sum + items.length, 0);
  const percent = total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  const busy =
    status === "checking" || status === "downloading" || status === "installing";

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
    <>
      <SettingsSection
        title="应用版本"
        hint="应用内更新只替换桌面端，不会修改普通版使用的本机 CLI。"
      >
        <Row label="当前版本" value={runtime?.appVersion ? `v${runtime.appVersion}` : "读取中…"} />
        <Row label="更新源" value="GitHub Releases（稳定版）" />
        <Row label="上次检查" value={formatCheckTime(lastCheckedAt)} />
      </SettingsSection>

      <SettingsSection
        title="更新设置"
        hint="自动检查只读取 GitHub Release 清单；发现更新后仍需手动确认下载和重启。"
      >
        <Toggle
          label="启动后自动检查更新"
          hint="启动约 8 秒后检查一次，之后每 24 小时检查一次"
          checked={autoCheck}
          onChange={onAutoCheckChange}
        />
      </SettingsSection>

      <SettingsSection title="检查与安装">
        <div className="settings-actions">
          <button
            className="ghost-btn"
            onClick={() => void checkForUpdates()}
            disabled={busy || status === "ready-to-restart"}
          >
            {status === "checking" ? "检查中…" : "检查更新"}
          </button>
          {status === "available" && (
            <button className="primary-btn" onClick={() => void installUpdate()}>
              下载并安装 v{version}
            </button>
          )}
          {status === "ready-to-restart" && (
            <button className="primary-btn" onClick={restart}>
              立即重启
            </button>
          )}
          <button className="ghost-btn" onClick={() => void openReleaseNotes(version)}>
            发布说明
          </button>
        </div>

        <p className={`settings-note ${status === "error" ? "err" : ""}`}>
          {status === "idle" &&
            (lastCheckedAt ? `上次自动检查未完成：${lastError ?? "未知错误"}` : "尚未检查更新。")}
          {status === "checking" && "正在检查更新…"}
          {status === "up-to-date" && "已是最新版本。"}
          {status === "available" && `发现新版本 v${version}，可以下载安装。`}
          {status === "downloading" &&
            (percent !== null
              ? `正在下载：${percent}%（${formatBytes(downloaded)} / ${formatBytes(total ?? 0)}）`
              : `正在下载：已下载 ${formatBytes(downloaded)}`)}
          {status === "installing" && "下载完成，正在安装更新…"}
          {status === "ready-to-restart" &&
            `v${version} 已安装。重启应用后生效；下次启动也会自动加载新版本。`}
          {status === "error" && <span title={errorDetail ?? undefined}>{error}</span>}
        </p>

        {status === "downloading" && (
          <div
            className="update-progress settings-update-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <span style={{ width: percent !== null ? `${percent}%` : "35%" }} />
          </div>
        )}

        <p className="settings-note">
          更新包使用 Ed25519 签名校验。安装前请保持网络连接；从 DMG 直接运行或没有写入权限时，
          需要先把应用移动到“应用程序”。Offline 版更新会同时替换内置 CLI。
        </p>
      </SettingsSection>
    </>
  );
}
