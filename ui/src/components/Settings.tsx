import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../store";
import { Icon } from "./Icon";
import { getThemeChoice, setThemeChoice, type ThemeChoice } from "../theme";
import type { AppConfig, CliConfigSummary, RuntimeInfo } from "../types";

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

export default function Settings() {
  const close = useApp((s) => s.closeSettings);
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [original, setOriginal] = useState<AppConfig | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [cliConfig, setCliConfig] = useState<CliConfigSummary | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [restartRequired, setRestartRequired] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(getThemeChoice());

  useEffect(() => {
    void api
      .getSettings()
      .then(({ config, runtime }) => {
        setDraft(config);
        setOriginal(config);
        setRuntime(runtime);
      })
      .catch((err) => setStatus({ kind: "error", message: String(err) }));
    void api
      .cliConfig()
      .then(setCliConfig)
      .catch(() => setCliConfig(null));
  }, []);

  const panelRef = useRef<HTMLDivElement>(null);

  // 面板要等配置加载完才渲染，所以依赖 draft；否则焦点会留在背后的主界面
  useEffect(() => {
    if (draft) panelRef.current?.focus();
  }, [draft]);

  // Esc 关闭、⌘S 保存、Tab 在面板内循环
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (draft && JSON.stringify(draft) !== JSON.stringify(original)) void save();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button, input, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!draft) {
    return (
      <div className="settings-overlay" onClick={close}>
        <div className="settings-panel" onClick={(event) => event.stopPropagation()}>
          <div className="settings-empty">正在读取设置…</div>
        </div>
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const notify = draft.notifications;

  const patchNotifications = (patch: Partial<AppConfig["notifications"]>) =>
    setDraft({ ...draft, notifications: { ...notify, ...patch } });
  const patchServer = (patch: Partial<AppConfig["server"]>) =>
    setDraft({ ...draft, server: { ...draft.server, ...patch } });

  const save = async () => {
    setStatus({ kind: "saving" });
    try {
      const result = await api.saveSettings(draft);
      setOriginal(result.config);
      setDraft(result.config);
      setRestartRequired(result.restartRequired);
      setStatus({ kind: "saved" });
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  };

  const detect = async () => {
    try {
      const found = await api.probeCli(null);
      setDraft({ ...draft, cli_path: found.path });
      setStatus({ kind: "saved" });
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  };

  return (
    <div className="settings-overlay" onClick={close}>
      <div
        className="settings-panel"
        ref={panelRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-head">
          <span>设置</span>
          <button className="settings-close" onClick={close} title="关闭 (Esc)" aria-label="关闭">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="settings-body">
          <section>
            <h3>运行状态</h3>
            <Row label="CLI 路径" value={runtime?.cliPath ?? "未找到"} mono />
            <Row label="CLI 版本" value={runtime?.cliVersion ?? "未知"} />
            <Row label="服务地址" value={runtime?.baseUrl ?? "未就绪"} mono />
            <Row label="应用版本" value={runtime?.appVersion ?? "-"} />
          </section>

          <section>
            <h3>外观</h3>
            <div className="settings-row">
              <div className="settings-label">
                <span>主题</span>
                <small>跟随系统时，切换 macOS 外观会立即同步</small>
              </div>
              <div className="seg">
                {(
                  [
                    ["system", "跟随系统"],
                    ["light", "亮色"],
                    ["dark", "暗色"],
                  ] as Array<[ThemeChoice, string]>
                ).map(([value, label]) => (
                  <button
                    key={value}
                    className={`seg-btn ${theme === value ? "on" : ""}`}
                    onClick={() => {
                      setTheme(value);
                      setThemeChoice(value);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section>
            <h3>CLI</h3>
            <div className="settings-row">
              <div className="settings-label">
                <span>可执行文件路径</span>
                <small>留空则自动探测（配置 → 环境变量 → 常见路径 → login shell）</small>
              </div>
              <div className="settings-control inline">
                <input
                  className="settings-input wide"
                  value={draft.cli_path ?? ""}
                  placeholder="自动探测"
                  onChange={(event) =>
                    setDraft({ ...draft, cli_path: event.target.value || null })
                  }
                />
                <button className="ghost-btn" onClick={() => void detect()}>
                  自动探测
                </button>
              </div>
            </div>
          </section>

          <section>
            <h3>服务</h3>
            <div className="settings-row">
              <div className="settings-label">
                <span>端口偏好</span>
                <small>0 表示由应用挑空闲端口；固定端口便于复用已在运行的实例</small>
              </div>
              <div className="settings-control inline">
                <input
                  className="settings-input narrow"
                  type="number"
                  min={0}
                  max={65535}
                  value={draft.server.preferred_port}
                  onChange={(event) =>
                    patchServer({ preferred_port: Number(event.target.value) || 0 })
                  }
                />
              </div>
            </div>
            <Toggle
              label="本地服务口令"
              hint="开启后 Rust 侧会生成随机口令保护 127.0.0.1 端口；需要重启生效"
              checked={Boolean(draft.server.secure)}
              onChange={(secure) => patchServer({ secure })}
            />
          </section>

          <section>
            <h3>通知</h3>
            <Toggle
              label="启用系统通知"
              hint="关闭后所有通知静默"
              checked={notify.enabled}
              onChange={(enabled) => patchNotifications({ enabled })}
            />
            <Toggle
              label="需要授权时提醒"
              hint="Agent 卡在等你批准，前台也提醒"
              checked={notify.on_permission}
              disabled={!notify.enabled}
              onChange={(on_permission) => patchNotifications({ on_permission })}
            />
            <Toggle
              label="任务完成时提醒"
              checked={notify.on_idle}
              disabled={!notify.enabled}
              onChange={(on_idle) => patchNotifications({ on_idle })}
            />
            <Toggle
              label="执行失败时提醒"
              checked={notify.on_error}
              disabled={!notify.enabled}
              onChange={(on_error) => patchNotifications({ on_error })}
            />
            <Toggle
              label="阶段推进时提醒"
              hint="默认关闭，长任务时可能比较吵"
              checked={notify.on_step}
              disabled={!notify.enabled}
              onChange={(on_step) => patchNotifications({ on_step })}
            />
            <Toggle
              label="应用在前台时静音"
              hint="授权提醒不受影响"
              checked={notify.quiet_when_focused}
              disabled={!notify.enabled}
              onChange={(quiet_when_focused) => patchNotifications({ quiet_when_focused })}
            />
          </section>

          <section>
            <h3>CLI 配置（只读）</h3>
            <Row label="模型" value={cliConfig?.model ?? "读取中…"} mono />
            <Row label="小模型" value={cliConfig?.small_model ?? "-"} mono />
            <Row
              label="权限"
              value={
                typeof cliConfig?.permission === "string"
                  ? cliConfig.permission
                  : JSON.stringify(cliConfig?.permission ?? "-")
              }
              mono
            />
            <Row label="插件" value={`${cliConfig?.plugin?.length ?? 0} 个`} />
            <p className="settings-note">
              这些由 deveco 自身的配置文件管理，桌面端只读展示；修改请用{' '}
              <code>deveco</code> 或编辑 <code>~/.config/deveco/deveco.jsonc</code>。
            </p>
          </section>

          <section>
            <h3>诊断</h3>
            <div className="settings-actions">
              <button
                className="ghost-btn"
                onClick={() => runtime?.logDir && void api.openPath(runtime.logDir)}
              >
                打开日志目录
              </button>
              <button
                className="ghost-btn"
                onClick={() => runtime?.configPath && void api.openPath(runtime.configPath)}
              >
                打开配置文件
              </button>
              <button className="ghost-btn" onClick={() => void api.openClassicView()}>
                打开经典界面
              </button>
              <button className="ghost-btn danger" onClick={() => void api.restartApp()}>
                重启应用
              </button>
            </div>
          </section>
        </div>

        <footer className="settings-foot">
          <span className="settings-status">
            {status.kind === "error" && <span className="err">{status.message}</span>}
            {status.kind === "saved" && !restartRequired && <span className="ok">已保存</span>}
            {restartRequired && <span className="warn">已保存，重启应用后生效</span>}
          </span>
          <div className="settings-buttons">
            <button className="ghost-btn" onClick={close}>
              关闭
            </button>
            <button className="primary-btn" onClick={() => void save()} disabled={!dirty || status.kind === "saving"}>
              {status.kind === "saving" ? "保存中…" : "保存"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="settings-row">
      <div className="settings-label">
        <span>{label}</span>
      </div>
      <div className={`settings-value ${mono ? "mono" : ""}`} title={value}>
        {value}
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className={`settings-row ${disabled ? "disabled" : ""}`}>
      <div className="settings-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <button
        className={`switch ${checked ? "on" : ""}`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
      >
        <span />
      </button>
    </div>
  );
}
