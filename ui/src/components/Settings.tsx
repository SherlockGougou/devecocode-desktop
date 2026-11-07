import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { onAppEvent } from "../appEvents";
import { useApp } from "../store";
import type {
  AppConfig,
  CliConfigSummary,
  RuntimeInfo,
  SettingsPage,
} from "../types";
import { Icon, type IconName } from "./Icon";
import AccountModelsPage from "./settings/AccountModelsPage";
import AgentPermissionsPage from "./settings/AgentPermissionsPage";
import AppearancePage from "./settings/AppearancePage";
import CliServicePage from "./settings/CliServicePage";
import ExtensionsPage from "./settings/ExtensionsPage";
import { Row, Toggle } from "./settings/SettingsPrimitives";

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

const PAGES: Array<{ id: SettingsPage; label: string; icon: IconName }> = [
  { id: "appearance", label: "外观", icon: "appearance" },
  { id: "account", label: "账号与模型", icon: "account" },
  { id: "agent", label: "Agent 与权限", icon: "branch" },
  { id: "extensions", label: "扩展", icon: "puzzle" },
  { id: "cli", label: "CLI 与服务", icon: "terminal" },
  { id: "notifications", label: "通知", icon: "bell" },
  { id: "diagnostics", label: "诊断", icon: "activity" },
];

export default function Settings() {
  const close = useApp((s) => s.closeSettings);
  const activePage = useApp((s) => s.settingsPage);
  const setActivePage = useApp((s) => s.setSettingsPage);
  const directory = useApp((s) => s.directory);
  const agents = useApp((s) => s.agents);
  const selectedAgent = useApp((s) => s.selectedAgent);
  const backendState = useApp((s) => s.backend.state);
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [original, setOriginal] = useState<AppConfig | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [cliConfig, setCliConfig] = useState<CliConfigSummary | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [restartRequired, setRestartRequired] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const saveFromMenu = useRef<() => void>(() => undefined);
  const pageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api
      .getSettings()
      .then(({ config, runtime }) => {
        setDraft(config);
        setOriginal(config);
        setRuntime(runtime);
      })
      .catch((err) => setStatus({ kind: "error", message: String(err) }));
  }, []);

  useEffect(() => {
    if (backendState !== "ready") return;
    let cancelled = false;
    void api
      .cliConfig()
      .then((config) => {
        if (!cancelled) setCliConfig(config);
      })
      .catch(() => {
        if (!cancelled) setCliConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [backendState, directory]);

  useEffect(
    () => onAppEvent("settings-save", () => saveFromMenu.current()),
    [],
  );

  // 面板要等配置加载完才渲染，所以依赖 draft；否则焦点会留在背后的主界面
  useEffect(() => {
    if (draft) panelRef.current?.focus();
  }, [draft]);

  // 切换分类时从详情顶部开始，避免沿用上一页的滚动位置
  useEffect(() => {
    pageRef.current?.scrollTo({ top: 0 });
  }, [activePage]);

  // Esc 关闭、⌘S 保存、Tab 在面板内循环
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveFromMenu.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
        <div
          className="settings-panel"
          role="dialog"
          aria-modal="true"
          aria-label="设置"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="settings-empty">正在读取设置…</div>
        </div>
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const page = PAGES.find((item) => item.id === activePage) ?? PAGES[0];
  const notify = draft.notifications;
  const showSave =
    activePage === "cli" || activePage === "notifications" || dirty;

  const patchNotifications = (patch: Partial<AppConfig["notifications"]>) =>
    setDraft({ ...draft, notifications: { ...notify, ...patch } });
  const patchServer = (patch: Partial<AppConfig["server"]>) =>
    setDraft({ ...draft, server: { ...draft.server, ...patch } });
  const patchMenuBar = (patch: Partial<AppConfig["menu_bar"]>) =>
    setDraft({ ...draft, menu_bar: { ...draft.menu_bar, ...patch } });

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
    setDetecting(true);
    setStatus({ kind: "idle" });
    try {
      const found = await api.probeCli(null);
      setDraft((current) => (current ? { ...current, cli_path: found.path } : current));
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    } finally {
      setDetecting(false);
    }
  };

  saveFromMenu.current = () => {
    if (dirty) void save();
  };

  const renderContent = (): ReactNode => {
    switch (activePage) {
      case "appearance":
        return (
          <AppearancePage
            menuBar={draft.menu_bar}
            onMenuBarChange={patchMenuBar}
          />
        );
      case "account":
        return <AccountModelsPage directory={directory} config={cliConfig} />;
      case "agent":
        return (
          <AgentPermissionsPage
            config={cliConfig}
            agents={agents}
            selectedAgent={selectedAgent}
          />
        );
      case "extensions":
        return <ExtensionsPage directory={directory} config={cliConfig} />;
      case "cli":
        return (
          <CliServicePage
            draft={draft}
            runtime={runtime}
            config={cliConfig}
            directory={directory}
            detecting={detecting}
            onCliPathChange={(cli_path) => setDraft({ ...draft, cli_path })}
            onServerChange={patchServer}
            onDetect={() => void detect()}
          />
        );
      case "notifications":
        return (
          <section>
            <h3>提醒事件</h3>
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
              onChange={(quiet_when_focused) =>
                patchNotifications({ quiet_when_focused })
              }
            />
          </section>
        );
      case "diagnostics":
        return (
          <>
            <section>
              <h3>运行状态</h3>
              <Row label="CLI 路径" value={runtime?.cliPath ?? "未找到"} mono />
              <Row label="CLI 版本" value={runtime?.cliVersion ?? "未知"} />
              <Row label="服务地址" value={runtime?.baseUrl ?? "未就绪"} mono />
              <Row label="应用版本" value={runtime?.appVersion ?? "-"} />
              <Row label="后端状态" value={backendLabel(backendState)} />
            </section>
            <section>
              <h3>维护操作</h3>
              <div className="settings-actions">
                <button
                  className="ghost-btn"
                  onClick={() => runtime?.logDir && void api.openPath(runtime.logDir)}
                >
                  打开日志目录
                </button>
                <button
                  className="ghost-btn"
                  onClick={() =>
                    runtime?.configPath && void api.openPath(runtime.configPath)
                  }
                >
                  打开应用配置
                </button>
                <button
                  className="ghost-btn danger"
                  onClick={() => void api.restartApp()}
                >
                  重启应用
                </button>
              </div>
              <p className="settings-note">
                CLI 升级请运行 <code>deveco upgrade</code>，完成后重启应用。
              </p>
            </section>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <div className="settings-overlay" onClick={close}>
      <div
        className="settings-panel"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-head">
          <span id="settings-title">设置</span>
          <button
            className="settings-close"
            onClick={close}
            title="关闭 (Esc)"
            aria-label="关闭"
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            {PAGES.map((item) => (
              <button
                key={item.id}
                className={`settings-nav-btn ${activePage === item.id ? "active" : ""}`}
                onClick={() => setActivePage(item.id)}
                aria-current={activePage === item.id ? "page" : undefined}
              >
                <Icon name={item.icon} size={17} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div
            className="settings-body"
            ref={pageRef}
            role="region"
            aria-labelledby="settings-page-title"
          >
            <div className="settings-page">
              <header className="settings-page-head">
                <h2 id="settings-page-title">{page.label}</h2>
              </header>
              {renderContent()}
            </div>
          </div>
        </div>

        <footer className="settings-foot">
          <span className="settings-status">
            {status.kind === "error" && <span className="err">{status.message}</span>}
            {status.kind === "saved" && !restartRequired && (
              <span className="ok">已保存</span>
            )}
            {restartRequired && (
              <span className="warn">已保存，重启应用后生效</span>
            )}
          </span>
          <div className="settings-buttons">
            <button className="ghost-btn" onClick={close}>
              关闭
            </button>
            {showSave && (
              <button
                className="primary-btn"
                onClick={() => void save()}
                disabled={!dirty || status.kind === "saving"}
              >
                {status.kind === "saving" ? "保存中…" : "保存"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function backendLabel(state: string): string {
  if (state === "ready") return "已连接";
  if (state === "starting") return "启动中";
  if (state === "reconnecting") return "重连中";
  if (state === "recovering") return "重建中";
  if (state === "failed") return "不可用";
  return state;
}
