import type { VoicePhase, VoiceUiError } from "./useVoiceInput";
import { Icon } from "./Icon";

function formatElapsed(value: number) {
  const seconds = Math.max(0, Math.floor(value / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function permissionTarget(error: VoiceUiError): "microphone" | "speech" | null {
  if (error.code.startsWith("speech_") || error.code === "speech_disabled") {
    return "speech";
  }
  if (error.code.startsWith("microphone_")) return "microphone";
  return null;
}

function localeError(error: VoiceUiError) {
  return (
    error.code === "locale_unavailable" ||
    error.code === "on_device_unavailable" ||
    error.code === "speech_disabled"
  );
}

export default function VoiceBar({
  phase,
  transcript,
  error,
  elapsedMs,
  maxDurationMs,
  limitWarning,
  undoAvailable,
  holdOption,
  onStop,
  onCancel,
  onRetry,
  onInsertDraft,
  onUndo,
  onDismiss,
  onOpenPrivacy,
  onOpenVoiceSettings,
}: {
  phase: VoicePhase;
  transcript: string;
  error: VoiceUiError | null;
  elapsedMs: number;
  maxDurationMs: number;
  limitWarning: boolean;
  undoAvailable: boolean;
  holdOption: boolean;
  onStop: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onInsertDraft: () => void;
  onUndo: () => void;
  onDismiss: () => void;
  onOpenPrivacy: (kind: "microphone" | "speech") => void;
  onOpenVoiceSettings: () => void;
}) {
  if (phase === "idle") return null;

  if (phase === "inserted") {
    return (
      <div className="voice-bar voice-bar-inserted" role="status">
        <Icon name="check" size={14} />
        <span className="voice-status-copy">已插入语音</span>
        {undoAvailable && (
          <button type="button" className="voice-action" onClick={onUndo}>
            撤销
          </button>
        )}
      </div>
    );
  }

  if (phase === "error" && error) {
    const privacyTarget = permissionTarget(error);
    return (
      <div className="voice-bar voice-bar-error" role="alert">
        <Icon name="alert" size={14} />
        <div className="voice-error-copy">
          <span>{error.message}</span>
          {transcript && (
            <span className="voice-error-partial" aria-live="off">
              {transcript}
            </span>
          )}
        </div>
        <span className="voice-actions">
          {privacyTarget && (
            <button
              type="button"
              className="voice-action"
              onClick={() => onOpenPrivacy(privacyTarget)}
            >
              打开系统设置
            </button>
          )}
          {localeError(error) && !privacyTarget && (
            <button
              type="button"
              className="voice-action"
              onClick={onOpenVoiceSettings}
            >
              语音设置
            </button>
          )}
          {error.lastPartial && (
            <button type="button" className="voice-action" onClick={onInsertDraft}>
              插入草稿
            </button>
          )}
          <button type="button" className="voice-action" onClick={onRetry}>
            重新录音
          </button>
          <button
            type="button"
            className="voice-icon-action"
            onClick={onDismiss}
            title="关闭"
            aria-label="关闭语音输入提示"
          >
            <Icon name="close" size={13} />
          </button>
        </span>
      </div>
    );
  }

  const starting = phase === "starting";
  const finalizing = phase === "finalizing";
  return (
    <div
      className={`voice-bar voice-bar-live ${starting ? "starting" : ""} ${
        finalizing ? "finalizing" : ""
      } ${limitWarning ? "limit-warning" : ""}`}
      role="status"
    >
      {starting || finalizing ? (
        <span className="voice-spinner" aria-hidden="true" />
      ) : (
        <span className="voice-live-dot" aria-hidden="true" />
      )}
      <span className="voice-status-copy">
        {starting
          ? "正在启动麦克风…"
          : finalizing
            ? "正在识别…"
            : "正在聆听"}
      </span>
      {!starting && !finalizing && (
        <>
          <span className="voice-wave" aria-hidden="true">
            {Array.from({ length: 9 }, (_, index) => (
              <i key={index} style={{ animationDelay: `${index * 80}ms` }} />
            ))}
          </span>
          <span className="voice-timer">
            {formatElapsed(elapsedMs)} / {formatElapsed(maxDurationMs)}
          </span>
        </>
      )}
      <span className="voice-transcript" aria-live="off">
        {transcript || (starting ? "请稍候" : finalizing ? "正在整理文字" : "开始说话…")}
      </span>
      <span className="voice-actions">
        {phase === "recording" && (
          <button type="button" className="voice-action" onClick={onStop}>
            停止
          </button>
        )}
        <button
          type="button"
          className="voice-icon-action"
          onClick={onCancel}
          title="取消语音输入 (Esc)"
          aria-label="取消语音输入"
        >
          <Icon name="close" size={13} />
        </button>
      </span>
      {phase === "recording" && (
        <span className="voice-hint">
          {holdOption ? "松开左 ⌥ 或点击麦克风结束 · Esc 取消" : "点击麦克风结束 · Esc 取消"}
        </span>
      )}
      {limitWarning && phase === "recording" && (
        <span className="voice-limit">接近单次 55 秒上限，即将自动结束</span>
      )}
    </div>
  );
}
