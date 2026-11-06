import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import { useApp } from "./store";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import Composer from "./components/Composer";
import StatusBar from "./components/StatusBar";
import RightPanel from "./components/RightPanel";
import Settings from "./components/Settings";
import Shortcuts from "./components/Shortcuts";

export default function App() {
  const booted = useRef(false);
  const booting = useApp((s) => s.booting);
  const bootMessage = useApp((s) => s.bootMessage);
  const error = useApp((s) => s.error);
  const notice = useApp((s) => s.notice);
  const rightOpen = useApp((s) => s.rightOpen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const shortcutsOpen = useApp((s) => s.shortcutsOpen);
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const setSidebarWidth = useApp((s) => s.setSidebarWidth);
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
        case "classic":
          void api.openClassicView();
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

  // 窗口标题跟随会话
  const sessions = useApp((s) => s.sessions);
  const directory = useApp((s) => s.directory);
  const sessionID = useApp((s) => s.sessionID);
  useEffect(() => {
    const project = directory ? directory.split("/").filter(Boolean).pop() : "";
    const session = sessionID
      ? (sessions[directory ?? ""] ?? []).find((item) => item.id === sessionID)?.title
      : "";
    const title = [session || "DevEco Code", project].filter(Boolean).join(" · ");
    void invoke("set_window_title", { title });
  }, [sessions, directory, sessionID]);

  if (booting) {
    return (
      <div className="boot">
        <div className="boot-mark">D</div>
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
      className={`shell ${rightOpen ? "right-open" : ""}`}
      style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr) ${rightOpen ? "320px" : "0px"}` }}
    >
      <TitleBar />
      <Sidebar />
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
      <main className="main">
        <ChatView />
        <Composer />
        <StatusBar />
      </main>
      <RightPanel />
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

function TitleBar() {
  const rightOpen = useApp((s) => s.rightOpen);
  const toggleRight = useApp((s) => s.toggleRight);
  const sseOk = useApp((s) => s.sseOk);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="brand-dot" />
        DevEco Code
        <span className="brand-ver">v0.2</span>
      </div>
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="titlebar-actions">
        <span className={`conn ${sseOk ? "ok" : ""}`} title={sseOk ? "事件流已连接" : "事件流未连接"}>
          {sseOk ? "已连接" : "连接中"}
        </span>
        <button
          className={`icon-btn ${rightOpen ? "active" : ""}`}
          onClick={toggleRight}
          title="切换右侧面板"
        >
          ◫
        </button>
      </div>
    </header>
  );
}
