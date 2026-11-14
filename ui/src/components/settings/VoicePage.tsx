import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type {
  AppConfig,
  VoiceLocale,
  VoicePermissionState,
  VoiceStatus,
} from "../../types";
import { Icon } from "../Icon";
import { SettingsSection, Tag, Toggle } from "./SettingsPrimitives";

const PERMISSION_LABELS: Record<VoicePermissionState, string> = {
  authorized: "已允许",
  not_determined: "首次使用时询问",
  denied: "已拒绝",
  restricted: "系统限制",
};

function permissionTone(status: VoicePermissionState) {
  if (status === "authorized") return "ok";
  if (status === "not_determined") return "muted";
  return "danger";
}

function PermissionRow({
  label,
  hint,
  status,
  onOpenSettings,
}: {
  label: string;
  hint: string;
  status: VoicePermissionState;
  onOpenSettings: () => void;
}) {
  const blocked = status === "denied" || status === "restricted";
  return (
    <div className="settings-row">
      <div className="settings-label">
        <span>{label}</span>
        <small>{hint}</small>
      </div>
      <div className="voice-permission-control">
        <Tag tone={permissionTone(status)}>{PERMISSION_LABELS[status]}</Tag>
        {blocked && (
          <button type="button" className="ghost-btn small" onClick={onOpenSettings}>
            打开系统设置
          </button>
        )}
      </div>
    </div>
  );
}

export default function VoicePage({
  draft,
  onVoiceChange,
}: {
  draft: AppConfig;
  onVoiceChange: (patch: Partial<AppConfig["voice"]>) => void;
}) {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [locales, setLocales] = useState<VoiceLocale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextStatus, nextLocales] = await Promise.all([
        api.voiceStatus(),
        api.voiceLocales(),
      ]);
      setStatus(nextStatus);
      setLocales(nextLocales);
    } catch (raw) {
      setError(String(raw));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = draft.voice.locale;
  const selectedMissing =
    !loading && Boolean(selected) && !locales.some((locale) => locale.id === selected);
  const systemSupported =
    status?.locale !== null &&
    Boolean(status?.locale) &&
    locales.some((locale) => locale.id === status?.locale);
  const systemLabel = status
    ? `${status.systemLocale}${systemSupported ? ` → ${status.locale}` : "（没有本地识别资源）"}`
    : "正在读取系统语言…";

  return (
    <>
      <SettingsSection
        title="权限"
        hint="首次使用时 macOS 会分别询问；被拒绝后可从这里的系统设置入口重新允许。"
        action={
          <button
            type="button"
            className="ghost-btn small"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <Icon name="refresh" size={13} />
            {loading ? "读取中…" : "刷新"}
          </button>
        }
      >
        {error && <div className="settings-inline-error">{error}</div>}
        {status ? (
          <>
            <PermissionRow
              label="语音识别"
              hint="始终要求 macOS 在本机完成，不发送音频"
              status={status.speech}
              onOpenSettings={() => void api.voiceOpenPrivacySettings("speech")}
            />
            <PermissionRow
              label="麦克风"
              hint="只在语音条显示期间采集音频"
              status={status.microphone}
              onOpenSettings={() => void api.voiceOpenPrivacySettings("microphone")}
            />
          </>
        ) : (
          !error && <div className="settings-note">正在读取权限状态…</div>
        )}
      </SettingsSection>

      <SettingsSection
        title="识别语言"
        hint="只显示这台 Mac 当前支持本地识别的语言；离线资源由系统键盘听写管理。"
      >
        <div className="settings-row">
          <div className="settings-label">
            <span>语言</span>
            <small>跟随系统时不会静默切换到其他语言</small>
          </div>
          <div className="settings-select-wrap">
            <select
              className="settings-input settings-select wide"
              value={selected ?? ""}
              disabled={loading}
              aria-label="语音识别语言"
              onChange={(event) =>
                onVoiceChange({ locale: event.target.value || null })
              }
            >
              <option value="">跟随系统（{systemLabel}）</option>
              {selectedMissing && (
                <option value={selected ?? ""}>
                  {selected}（当前不可用）
                </option>
              )}
              {locales.map((locale) => (
                <option key={locale.id} value={locale.id}>
                  {locale.label} · {locale.id}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" size={13} className="settings-select-caret" />
          </div>
        </div>
        {selectedMissing && (
          <div className="settings-inline-error">
            当前选择的语言没有本地识别资源，请重新选择或先在系统键盘听写中下载。
          </div>
        )}
        {!loading && locales.length === 0 && !error && (
          <div className="settings-inline-error">
            没有发现可用的本地语音语言。请先在 macOS 系统设置的键盘听写中启用并下载语言资源。
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="输入方式">
        <Toggle
          label="长按左 ⌥ 开始语音输入"
          hint="仅在对话输入框聚焦时生效；松开结束，不会注册全局快捷键"
          checked={draft.voice.hold_option}
          onChange={(hold_option) => onVoiceChange({ hold_option })}
        />
      </SettingsSection>

      <SettingsSection title="隐私">
        <div className="voice-privacy-note">
          <Icon name="shield" size={15} />
          <p>
            音频只交给 macOS 本地语音识别，不写入磁盘，也不进入桌面端日志。
            识别结果在停止后进入当前输入框，仍可在发送前自由修改。
          </p>
        </div>
      </SettingsSection>
    </>
  );
}
