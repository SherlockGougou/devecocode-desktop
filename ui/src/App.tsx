import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import {
  clampRightPanelWidth,
  RIGHT_PANEL_MIN_WIDTH,
  useApp,
} from "./store";
import type { BackendPhase } from "./types";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import Composer from "./components/Composer";
import StatusBar from "./components/StatusBar";
import RightPanel from "./components/RightPanel";
import Settings from "./components/Settings";
import Shortcuts from "./components/Shortcuts";
import TaskOverview from "./components/TaskOverview";
import { Icon } from "./components/Icon";
import { AppIcon } from "./components/AppIcon";

export default function App() {
  const booted = useRef(false);
  const booting = useApp((s) => s.booting);
  const bootMessage = useApp((s) => s.bootMessage);
  const error = useApp((s) => s.error);
  const notice = useApp((s) => s.notice);
  const rightOpen = useApp((s) => s.rightOpen);
  const overviewOpen = useApp((s) => s.overviewOpen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const shortcutsOpen = useApp((s) => s.shortcutsOpen);
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const rightWidth = useApp((s) => s.rightWidth);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const setSidebarWidth = useApp((s) => s.setSidebarWidth);
  const setRightWidth = useApp((s) => s.setRightWidth);
  const dismissError = useApp((s) => s.dismissError);
  const boot = useApp((s) => s.boot);
  const onSse = useApp((s) => s.onSse);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;

    const unlisteners: Array<() => void> = [];
    listen<string>("deveco://sse", (event) => onSse(event.payload)).then((un) =>
      unlisteners.push(un),
    );
    listen<{ message: string; detail?: string; error: boolean }>("deveco://status", (event) => {
      if (!event.payload.error && event.payload.message) {
        useApp.setState({ bootMessage: event.payload.message });
      }
    }).then((un) => unlisteners.push(un));
    // 后端自愈状态：启动阶段的广播可能早于前端挂载，先同步一次当前值
    listen<BackendPhase>("deveco://backend", (event) => {
      useApp.getState().onBackend(event.payload);
    }).then((un) => unlisteners.push(un));
    void api
      .backendState()
      .then((phase) => useApp.getState().onBackend(phase))
      .catch(() => {
        // 命令缺失时保持启动态，不影响主流程
      });
    // 原生菜单动作
    listen<string>("deveco://menu", (event) => {
      const state = useApp.getState();
      switch (event.payload) {
        case "new_session":
          void state.newSession();
          break;
        case "settings":
          state.openSettings();
          break;
        case "toggle_right":
          state.toggleRight();
          break;
        case "export_session":
          void state.exportCurrentSession();
          break;
        case "shortcuts":
          state.openShortcuts();
          break;
        case "open_logs":
          void api.getSettings().then(({ runtime }) => {
            if (runtime.logDir) void api.openPath(runtime.logDir);
          });
          break;
        case "reload_ui":
          window.location.reload();
          break;
        default:
          break;
      }
    }).then((un) => unlisteners.push(un));

    // ⌘, 打开设置（macOS 惯例）
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === ",") {
        event.preventDefault();
        useApp.getState().openSettings();
      }
      if (event.metaKey && event.key === "f") {
        event.preventDefault();
        useApp.getState().openFind();
      }
      if (event.metaKey && event.key === "/") {
        event.preventDefault();
        const state = useApp.getState();
        if (state.shortcutsOpen) state.closeShortcuts();
        else state.openShortcuts();
      }
    };
    window.addEventListener("keydown", onKey);

    void boot();
    return () => {
      window.removeEventListener("keydown", onKey);
      unlisteners.forEach((un) => un());
    };
  }, [boot, onSse]);

  // 启动阶段后端就失败时不要一直卡在启动页（原来要等 60s 轮询超时）：
  // 直接进主界面，用提示条给出原因与「重试 / 诊断」出口。
  const backendState = useApp((s) => s.backend);
  useEffect(() => {
    if (!booting || backendState.state !== "failed") return;
    // 原因由提示条展示，不再叠一条 toast（重复且挡视线）
    useApp.setState({ booting: false });
  }, [booting, backendState.state, backendState.detail]);

  // 右侧宽度上限依赖当前窗口宽度；窗口缩小时立即把已有偏好夹回一半以内。
  useEffect(() => {
    const onResize = () => {
      const state = useApp.getState();
      if (clampRightPanelWidth(state.rightWidth) !== state.rightWidth) {
        setRightWidth(state.rightWidth);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setRightWidth]);

  // 窗口标题跟随会话
  const sessions = useApp((s) => s.sessions);
  const directory = useApp((s) => s.directory);
  const sessionID = useApp((s) => s.sessionID);
  const streaming = useApp((s) => s.streaming);
  const traySessionTitle = useApp((s) => {
    if (!s.sessionID) return null;
    const title = (s.sessions[s.directory ?? ""] ?? []).find(
      (item) => item.id === s.sessionID,
    )?.title;
    return title ?? null;
  });
  const sessionTitle = sessionID
    ? ((sessions[directory ?? ""] ?? []).find((item) => item.id === sessionID)?.title ?? "")
    : "";
  const projectTitle = directory ? (directory.split("/").filter(Boolean).pop() ?? "") : "";
  const windowTitle = [sessionTitle || "DevEco Code", projectTitle]
    .filter(Boolean)
    .join(" · ");
  useEffect(() => {
    void invoke("set_window_title", { title: windowTitle });
  }, [windowTitle]);

  // 菜单栏只接收轻量上下文；SSE 是否运行、授权数量仍由 Rust 侧维护
  useEffect(() => {
    if (booting) return;
    const project = directory ? directory.split("/").filter(Boolean).pop() : "";
    void api
      .syncTrayContext({
        project: project || null,
        sessionTitle: traySessionTitle,
        streaming,
      })
      .catch(() => {
        // 菜单栏同步失败不影响聊天主流程
      });
  }, [booting, directory, traySessionTitle, streaming]);

  if (booting) {
    return (
      <div className="boot">
        <AppIcon size={48} className="boot-icon" />
        <div className="boot-title">DevEco Code</div>
        <div className="boot-msg">{bootMessage}</div>
        <div className="boot-bar">
          <span />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`shell ${rightOpen ? "right-open" : ""} ${overviewOpen ? "overview-open" : ""} ${sidebarOpen ? "" : "left-collapsed"}`}
      style={{
        gridTemplateColumns: `${sidebarOpen ? sidebarWidth : 0}px minmax(0, 1fr) ${rightOpen ? `${rightWidth}px` : "0px"}`,
      }}
    >
      <TitleBar sessionTitle={sessionTitle} project={projectTitle} streaming={streaming} />
      <TaskOverview />
      <Sidebar />
      {sidebarOpen && (
        <div
          className="sidebar-resizer"
          style={{ left: `${sidebarWidth}px` }}
          title="拖动调整侧栏宽度，双击复位"
          onDoubleClick={() => setSidebarWidth(296)}
          onMouseDown={(event) => {
            event.preventDefault();
            const startX = event.clientX;
            const startWidth = sidebarWidth;
            const onMove = (moveEvent: MouseEvent) =>
              setSidebarWidth(startWidth + (moveEvent.clientX - startX));
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
              document.body.style.cursor = "";
            };
            document.body.style.cursor = "col-resize";
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
        />
      )}
      <main className="main">
        <BackendBanner />
        <ChatView />
        <Composer />
        <StatusBar />
      </main>
      <RightPanel />
      {rightOpen && (
        <div
          className="right-resizer"
          style={{ right: `${rightWidth}px` }}
          title="拖动调整右侧面板宽度，双击复位"
          onDoubleClick={() => setRightWidth(RIGHT_PANEL_MIN_WIDTH)}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            const startX = event.clientX;
            const startWidth = rightWidth;
            const onMove = (moveEvent: MouseEvent) =>
              setRightWidth(startWidth - (moveEvent.clientX - startX));
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
              document.body.style.cursor = "";
              document.body.style.userSelect = "";
            };
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
        />
      )}
      {settingsOpen && <Settings />}
      {shortcutsOpen && <Shortcuts />}
      {error && (
        <div className="toast" onClick={dismissError} title="点击关闭">
          {error}
        </div>
      )}
      {notice && <div className="toast ok">{notice}</div>}
    </div>
  );
}

const IS_MACOS = /Mac/i.test(navigator.userAgent);

/**
 * 按住顶栏拖动窗口（macOS 专用，实现在 `src-tauri/src/windrag.rs`）。
 *
 * 为什么不用 `data-tauri-drag-region`：它由注入脚本在 `mousedown` 里异步 IPC 触发
 * `tao::drag_window()`，回到主线程时已拿不到那次按下事件，窗口不动（权限已按官方
 * 文档补上，调用也不报错）。这里改成按帧把窗口位置推给 Rust 侧，不依赖平台的事件语义。
 */
function useTitleBarDrag(handleRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const handle = handleRef.current;
    if (!IS_MACOS || !handle) return;

    // base：按下时窗口左上角的物理像素；start：按下时的屏幕坐标（CSS 像素）
    let base: [number, number] | null = null;
    let start: { x: number; y: number } | null = null;
    let pending: { x: number; y: number } | null = null;
    let frame = 0;

    const flush = () => {
      frame = 0;
      if (!base || !start || !pending) return;
      void invoke("move_window_by_pointer", {
        baseX: base[0],
        baseY: base[1],
        deltaX: pending.x - start.x,
        deltaY: pending.y - start.y,
      }).catch(() => {
        // 拖动失败不该变成用户可见报错，最多是这一帧没跟上
      });
      pending = null;
    };

    const onMove = (e: MouseEvent) => {
      if (!start) return;
      pending = { x: e.screenX, y: e.screenY };
      if (!frame) frame = requestAnimationFrame(flush);
    };

    const onUp = () => {
      start = null;
      base = null;
      pending = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    const onDown = (e: MouseEvent) => {
      // 只认左键，且避开顶栏上的按钮
      if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      start = { x: e.screenX, y: e.screenY };
      base = null;
      void invoke<[number, number]>("window_outer_position")
        .then((pos) => {
          base = [pos[0], pos[1]];
        })
        .catch(() => {
          // 拿不到基准位置就当这次没拖，窗口不会乱跳
        });
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };

    handle.addEventListener("mousedown", onDown);
    return () => {
      handle.removeEventListener("mousedown", onDown);
      onUp();
    };
  }, [handleRef]);
}

/** 双击顶栏缩放窗口（macOS 系统习惯；原来由 Tauri 的 drag.js 提供）。 */
function toggleMaximize() {
  void invoke("plugin:window|internal_toggle_maximize").catch(() => {
    // 缩放失败不影响其它交互
  });
}

function TitleBar({
  sessionTitle,
  project,
  streaming,
}: {
  sessionTitle: string;
  project: string;
  streaming: boolean;
}) {
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const rightOpen = useApp((s) => s.rightOpen);
  const toggleRight = useApp((s) => s.toggleRight);
  const overviewOpen = useApp((s) => s.overviewOpen);
  const toggleOverview = useApp((s) => s.toggleOverview);
  const sessionID = useApp((s) => s.sessionID);
  const exportCurrentSession = useApp((s) => s.exportCurrentSession);
  const handleRef = useRef<HTMLDivElement>(null);
  useTitleBarDrag(handleRef);
  const fullTitle = [sessionTitle || "DevEco Code", project].filter(Boolean).join(" · ");

  return (
    // 顶栏左边留给红黄绿灯（padding-left），中间整段是可拖动的窗口标题区。
    // macOS 由 useTitleBarDrag 处理；其它平台仍交给 Tauri 的 drag region。
    <header className="titlebar">
      <div
        ref={handleRef}
        className="titlebar-handle"
        onDoubleClick={IS_MACOS ? toggleMaximize : undefined}
        {...(IS_MACOS ? {} : { "data-tauri-drag-region": "deep" })}
      >
        <button
          className={`icon-btn titlebar-sidebar-toggle ${sidebarOpen ? "active" : ""}`}
          onClick={toggleSidebar}
          onDoubleClick={(event) => event.stopPropagation()}
          title={sidebarOpen ? "收起左侧边栏" : "展开左侧边栏"}
          aria-label={sidebarOpen ? "收起左侧边栏" : "展开左侧边栏"}
          aria-pressed={sidebarOpen}
        >
          <Icon name="panel-left" size={18} />
        </button>
        <div className="titlebar-title" title={fullTitle}>
          <AppIcon size={16} className="titlebar-icon" />
          <span className="titlebar-title-text">{sessionTitle || "DevEco Code"}</span>
          {!sessionTitle && <span className="brand-ver">v0.2</span>}
          {streaming && <span className="titlebar-streaming">· 执行中</span>}
        </div>
        <div className="titlebar-drag" />
      </div>
      <div className="titlebar-actions">
        <button
          className="icon-btn"
          onClick={() => void exportCurrentSession()}
          disabled={!sessionID}
          title="导出当前会话 (⌘E)"
          aria-label="导出当前会话"
        >
          <Icon name="download" size={17} />
        </button>
        <button
          className={`icon-btn ${overviewOpen ? "active" : ""}`}
          data-overview-toggle
          onClick={toggleOverview}
          title="任务概览"
          aria-label="任务概览"
          aria-expanded={overviewOpen}
          aria-controls="task-overview"
        >
          <Icon name="list" size={18} />
        </button>
        <button
          className={`icon-btn ${rightOpen ? "active" : ""}`}
          onClick={toggleRight}
          title="切换右侧面板"
          aria-label="切换右侧面板"
        >
          <Icon name="panel-right" size={18} />
        </button>
      </div>
    </header>
  );
}

/** 后端断线/重建提示条：只在非就绪态出现，失败时给可操作出口。 */
function BackendBanner() {
  const backend = useApp((s) => s.backend);
  const retryBackend = useApp((s) => s.retryBackend);
  const openSettings = useApp((s) => s.openSettings);
  if (backend.state === "ready" || backend.state === "starting") return null;

  const failed = backend.state === "failed";
  const title = failed
    ? "本地服务已停止"
    : backend.state === "recovering"
      ? `正在重启本地服务（第 ${backend.attempt} 次）`
      : `与本地服务的连接中断（第 ${backend.attempt} 次重连）`;
  const detail =
    backend.detail ??
    (failed
      ? "可能是 CLI 崩溃或被升级替换，可手动重试。"
      : "正在自动恢复，期间消息可能延迟；恢复后会重新同步当前会话。");

  return (
    <div className={`backend-banner ${failed ? "bad" : "warn"}`}>
      <span className="dot" />
      <div className="backend-text">
        <strong>{title}</strong>
        <span title={detail}>{detail}</span>
      </div>
      {(failed || backend.state === "reconnecting") && (
        <>
          <button className="ghost-btn" onClick={() => void retryBackend()}>
            {failed ? "立即重试" : "重启服务"}
          </button>
          <button className="ghost-btn" onClick={() => openSettings("diagnostics")}>
            诊断
          </button>
        </>
      )}
    </div>
  );
}
