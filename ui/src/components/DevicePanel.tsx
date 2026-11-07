import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { blobToAttachment } from "../attachments";
import { emitAppEvent } from "../appEvents";
import type {
  DeviceAwakeStatus,
  DeviceInfo,
  DeviceProbe,
  DeviceShot,
} from "../types";
import { useApp } from "../store";
import { Icon } from "./Icon";

type Busy = "scan" | "capture" | "copy" | "save" | "attach" | null;

type DeviceCache = {
  initialized: boolean;
  hdcPath: string | null;
  hdcVersion: string | null;
  devices: DeviceInfo[];
  selected: string;
  shot: DeviceShot | null;
  previewBytes: Uint8Array<ArrayBuffer> | null;
  awake: DeviceAwakeStatus | null;
  error: string | null;
};

let deviceCache: DeviceCache | null = null;

function updateDeviceCache(patch: Partial<DeviceCache>) {
  deviceCache = {
    initialized: false,
    hdcPath: null,
    hdcVersion: null,
    devices: [],
    selected: "",
    shot: null,
    previewBytes: null,
    awake: null,
    error: null,
    ...(deviceCache ?? {}),
    ...patch,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(milliseconds: number): string {
  return new Date(milliseconds).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function deviceLabel(device: DeviceInfo | undefined): string {
  return device?.name ?? device?.model ?? device?.serial ?? "HarmonyOS 设备";
}

function deviceMeta(device: DeviceInfo | undefined): string {
  if (!device) return "";
  const osVersion =
    device.osVersion && device.model && device.osVersion.startsWith(device.model)
      ? device.osVersion.slice(device.model.length).trim()
      : device.osVersion;
  return [
    device.model,
    osVersion,
    device.apiVersion ? `API ${device.apiVersion}` : null,
    device.connection,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

export default function DevicePanel() {
  const showNotice = useApp((s) => s.showNotice);
  const cached = deviceCache;
  const [hdcPath, setHdcPath] = useState<string | null>(cached?.hdcPath ?? null);
  const [hdcVersion, setHdcVersion] = useState<string | null>(
    cached?.hdcVersion ?? null,
  );
  const [devices, setDevices] = useState<DeviceInfo[]>(cached?.devices ?? []);
  const [selected, setSelected] = useState<string>(cached?.selected ?? "");
  const [shot, setShot] = useState<DeviceShot | null>(cached?.shot ?? null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBytes, setPreviewBytes] = useState<Uint8Array<ArrayBuffer> | null>(
    cached?.previewBytes ?? null,
  );
  const [awake, setAwake] = useState<DeviceAwakeStatus | null>(
    cached?.awake ?? null,
  );
  const [awakeBusy, setAwakeBusy] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(cached?.error ?? null);

  const activeDevice = useMemo(
    () => devices.find((device) => device.serial === selected),
    [devices, selected],
  );

  const refreshAwake = async (serial: string) => {
    try {
      const status = await api.deviceAwakeStatus(serial);
      setAwake(status);
      updateDeviceCache({ awake: status });
    } catch {
      // 电池/电源服务暂时不可用不应打断截图主流程。
    }
  };

  const capture = async (serial: string) => {
    if (!serial) return;
    setBusy("capture");
    setError(null);
    try {
      const next = await api.deviceCapture(serial);
      setPreviewBytes(null);
      setShot(next);
      setSelected(next.serial);
      updateDeviceCache({
        initialized: true,
        shot: next,
        previewBytes: null,
        selected: next.serial,
        error: null,
      });
      void refreshAwake(next.serial);
    } catch (captureError) {
      const message = String(captureError);
      setError(message);
      updateDeviceCache({ error: message });
    } finally {
      setBusy(null);
    }
  };

  const scan = async () => {
    setBusy("scan");
    setError(null);
    try {
      const probe: DeviceProbe = await api.deviceProbe();
      setHdcPath(probe.hdcPath);
      setHdcVersion(probe.hdcVersion);
      setDevices(probe.devices);
      const nextSerial =
        probe.devices.find((device) => device.serial === selected)?.serial ??
        probe.devices.find(
          (device) => device.status.toLowerCase() === "connected",
        )?.serial ??
        probe.devices[0]?.serial ??
        "";
      if (nextSerial !== selected && awake?.enabled) {
        void api.deviceSetAwake(selected, false).catch(() => undefined);
      }
      if (nextSerial !== selected) {
        setShot(null);
        setPreviewBytes(null);
        setAwake(null);
        updateDeviceCache({ shot: null, previewBytes: null, awake: null });
      }
      setSelected(nextSerial);
      updateDeviceCache({
        initialized: true,
        hdcPath: probe.hdcPath,
        hdcVersion: probe.hdcVersion,
        devices: probe.devices,
        selected: nextSerial,
        error: null,
      });
      if (!nextSerial) {
        setShot(null);
        setPreviewBytes(null);
        setAwake(null);
        updateDeviceCache({
          shot: null,
          previewBytes: null,
          awake: null,
        });
        return;
      }
      await capture(nextSerial);
    } catch (probeError) {
      const message = String(probeError);
      setDevices([]);
      setHdcPath(null);
      setHdcVersion(null);
      setSelected("");
      setShot(null);
      setPreviewBytes(null);
      setAwake(null);
      setError(message);
      updateDeviceCache({
        initialized: true,
        hdcPath: null,
        hdcVersion: null,
        devices: [],
        selected: "",
        shot: null,
        previewBytes: null,
        awake: null,
        error: message,
      });
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    // 收起右栏/切换标签只会卸载组件，不会清掉模块级缓存。
    // 再次打开时直接复用上一帧；只有从没初始化过时才扫描设备。
    if (deviceCache?.initialized) {
      if (deviceCache.selected) void refreshAwake(deviceCache.selected);
      return;
    }
    void scan();
  }, []);

  useEffect(() => {
    if (!shot) {
      setPreviewUrl(null);
      setPreviewBytes(null);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setPreviewUrl(null);
    setPreviewLoading(true);
    setError(null);
    const load = async () => {
      // 缓存里有 JPEG bytes 时不再经过 Rust 读盘；只有缓存缺图才请求。
      let bytes = previewBytes;
      if (!bytes) {
        const buffer = await api.deviceScreenshotBytes(shot.path);
        bytes = new Uint8Array(buffer);
      }
      if (cancelled) return;
      const blob = new Blob([bytes], { type: "image/jpeg" });
      objectUrl = URL.createObjectURL(blob);
      setPreviewBytes(bytes);
      setPreviewUrl(objectUrl);
      updateDeviceCache({ previewBytes: bytes });
    };
    void load()
      .catch((readError) => {
        if (!cancelled) {
          const message = `读取截图失败：${String(readError)}`;
          setError(message);
          updateDeviceCache({ error: message });
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [shot]);

  const refresh = () => {
    if (selected) void capture(selected);
    else void scan();
  };

  const copy = async () => {
    if (!shot) return;
    setBusy("copy");
    setError(null);
    try {
      await api.deviceCopyScreenshot(shot.path);
      showNotice("设备截图已复制到剪贴板", 1800);
    } catch (copyError) {
      setError(String(copyError));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!shot) return;
    setBusy("save");
    setError(null);
    try {
      const saved = await api.deviceSaveScreenshot(shot.path, shot.name);
      if (saved) showNotice(`已保存：${saved}`, 5000);
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setBusy(null);
    }
  };

  const attach = async () => {
    if (!shot || !previewBytes) return;
    setBusy("attach");
    setError(null);
    try {
      const blob = new Blob([previewBytes], { type: "image/jpeg" });
      const attachment = await blobToAttachment(blob, shot.name, "image/jpeg", "device");
      if (!attachment) {
        setError("截图超过 8MB，无法附加到对话");
        return;
      }
      emitAppEvent("attach-device-screenshot", attachment);
      showNotice("设备截图已附加到输入框，发送后可交给 Agent", 3200);
    } catch (attachError) {
      setError(String(attachError));
    } finally {
      setBusy(null);
    }
  };

  const toggleAwake = async () => {
    if (!selected || awakeBusy) return;
    const enabled = !(awake?.enabled ?? false);
    setAwakeBusy(true);
    setError(null);
    try {
      const status = await api.deviceSetAwake(selected, enabled);
      setAwake(status);
      updateDeviceCache({ awake: status });
      showNotice(
        enabled
          ? status.active
            ? "充电中，已保持手机亮屏"
            : "已开启，连接充电器后保持亮屏"
          : "已关闭，手机恢复系统默认息屏时间",
        2800,
      );
    } catch (awakeError) {
      setError(String(awakeError));
    } finally {
      setAwakeBusy(false);
    }
  };

  useEffect(() => {
    if (!selected || !awake?.enabled) return;
    const timer = setInterval(() => void refreshAwake(selected), 5000);
    return () => clearInterval(timer);
  }, [selected, awake?.enabled]);

  const emptyTitle =
    busy === "scan"
      ? "正在扫描设备…"
      : busy === "capture"
        ? "正在获取最新页面…"
        : error
          ? "设备连接失败"
          : devices.length === 0
            ? "未发现 HarmonyOS 设备"
            : "还没有截图";
  const emptyCopy =
    error ??
    (busy === "capture"
      ? "正在调用 hdc 抓取当前屏幕，通常需要约 0.6 秒。"
      : devices.length === 0
        ? "请在手机上开启开发者模式与 USB 调试，连接后回到这里点「重新扫描」。"
        : "点右上角刷新按钮获取当前页面。");

  return (
    <div className="device-panel">
      <div className="device-head">
        <div className="device-heading">
          <div className="device-title" title={activeDevice?.serial}>
            {deviceLabel(activeDevice)}
          </div>
          <div className="device-meta" title={deviceMeta(activeDevice)}>
            {deviceMeta(activeDevice) || "HDC 设备"}
          </div>
        </div>
        <button
          className="device-refresh"
          onClick={refresh}
          disabled={busy !== null}
          title={selected ? "刷新当前画面" : "重新扫描设备"}
          aria-label={selected ? "刷新当前画面" : "重新扫描设备"}
        >
          <Icon name="refresh" size={13} />
          <span>刷新</span>
        </button>
      </div>

      {devices.length > 0 && (
        <div className="device-select-row">
          <select
            className="device-select"
            value={selected}
            onChange={(event) => {
              const next = event.target.value;
              if (selected && selected !== next && awake?.enabled) {
                void api.deviceSetAwake(selected, false).catch(() => undefined);
              }
              setSelected(next);
              setShot(null);
              setPreviewBytes(null);
              setAwake(null);
              setError(null);
              updateDeviceCache({
                selected: next,
                shot: null,
                previewBytes: null,
                awake: null,
                error: null,
              });
              if (next) {
                void capture(next);
                void refreshAwake(next);
              }
            }}
            aria-label="选择设备"
          >
            {devices.map((device) => (
              <option key={device.serial} value={device.serial}>
                {deviceLabel(device)} · {device.status}
              </option>
            ))}
          </select>
          <span className={`device-status ${activeDevice?.status.toLowerCase() === "connected" ? "ok" : ""}`}>
            {activeDevice?.status ?? ""}
          </span>
        </div>
      )}

      {error && shot && <div className="device-error">{error}</div>}

      {shot ? (
        <>
          <div className="device-shot-wrap">
            {previewUrl ? (
              <img
                className="device-shot"
                src={previewUrl}
                alt="HarmonyOS 设备当前画面"
                draggable={false}
              />
            ) : (
              <div className="device-shot-placeholder">
                <div className="preview-spinner" />
                <span>{previewLoading ? "正在读取截图…" : "截图不可用"}</span>
              </div>
            )}
            {busy === "capture" && (
              <div className="device-shot-loading">
                <div className="preview-spinner" />
                <span>正在获取最新页面…</span>
              </div>
            )}
          </div>
          <div className="device-shot-meta">
            <span>{formatTime(shot.capturedAt)}</span>
            <span>
              {shot.width}×{shot.height}
            </span>
            <span>{formatBytes(shot.bytes)}</span>
          </div>
          <div className="device-actions">
            <button
              className="device-action"
              onClick={() => void copy()}
              disabled={busy !== null || !previewBytes}
            >
              复制
            </button>
            <button
              className="device-action"
              onClick={() => void save()}
              disabled={busy !== null}
            >
              保存…
            </button>
            <button
              className="device-action primary"
              onClick={() => void attach()}
              disabled={busy !== null || !previewBytes}
            >
              附加到对话
            </button>
          </div>
        </>
      ) : (
        <div className="device-empty">
          <div className="device-empty-icon">
            <Icon name="device" size={26} />
          </div>
          <strong>{emptyTitle}</strong>
          <span>{emptyCopy}</span>
          <button
            className="ghost-btn"
            onClick={() => void scan()}
            disabled={busy !== null}
          >
            {busy === "scan" ? "扫描中…" : "重新扫描"}
          </button>
        </div>
      )}

      <div className={`device-awake-row ${awake?.enabled ? "on" : ""}`}>
        <div className="device-awake-copy">
          <span>充电时保持亮屏</span>
          <small>
            {!selected
              ? "连接设备后可设置"
              : !awake
                ? "正在读取电源状态…"
                : awake.enabled
                  ? awake.active
                    ? "充电中，已保持亮屏"
                    : "已开启，等待充电器连接"
                  : "关闭后恢复系统默认息屏时间"}
          </small>
        </div>
        <button
          className={`switch ${awake?.enabled ? "on" : ""}`}
          role="switch"
          aria-checked={Boolean(awake?.enabled)}
          aria-label="充电时保持亮屏"
          disabled={!selected || awakeBusy}
          onClick={() => void toggleAwake()}
        >
          <span />
        </button>
      </div>

      <div className="device-footer">
        <span title={hdcPath ?? undefined}>
          {hdcPath ? `hdc ${hdcVersion ?? ""}` : "未找到 hdc"}
        </span>
        <span>手动刷新获取最新画面；锁屏/安全窗口可能黑屏。</span>
      </div>
    </div>
  );
}
