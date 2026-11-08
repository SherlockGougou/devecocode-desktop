import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api";
import {
  TERMINAL_DEFAULT_HEIGHT,
  useApp,
} from "../store";
import type { PtySession, TerminalEventPayload } from "../types";
import { Icon } from "./Icon";

type TerminalStatus = "connecting" | "ready" | "error" | "exited";

const FIT_DEBOUNCE_MS = 40;
const RESIZE_DEBOUNCE_MS = 80;

function cssValue(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function terminalTheme(): ITheme {
  const light = document.documentElement.dataset.theme === "light";
  return {
    background: cssValue("--bg") || (light ? "#f6f3ee" : "#0e0d0c"),
    foreground: cssValue("--text") || (light ? "#1f1c18" : "#e9e5e0"),
    cursor: cssValue("--accent") || (light ? "#3b352e" : "#d7d2ca"),
    cursorAccent: cssValue("--bg") || (light ? "#f6f3ee" : "#0e0d0c"),
    selectionBackground: light
      ? "rgba(59, 111, 224, 0.22)"
      : "rgba(126, 162, 255, 0.28)",
    selectionInactiveBackground: light
      ? "rgba(31, 26, 21, 0.12)"
      : "rgba(233, 229, 224, 0.14)",
    black: light ? "#2b2722" : "#1b1917",
    red: light ? "#c0392b" : "#ef6b62",
    green: light ? "#2f7d52" : "#63d18b",
    yellow: light ? "#8a6114" : "#e0b341",
    blue: light ? "#1d5fd0" : "#7ea2ff",
    magenta: light ? "#7b3fa0" : "#c792ea",
    cyan: light ? "#0f6d7a" : "#89ddff",
    white: light ? "#4a443d" : "#e9e5e0",
    brightBlack: light ? "#6b645b" : "#847d75",
    brightRed: light ? "#a8332a" : "#ff8b82",
    brightGreen: light ? "#1c6a3e" : "#85e8a8",
    brightYellow: light ? "#7f5c0c" : "#f0c95a",
    brightBlue: light ? "#1750b5" : "#9bb9ff",
    brightMagenta: light ? "#6b3292" : "#d8aaf3",
    brightCyan: light ? "#0b5d68" : "#a8e8ff",
    brightWhite: light ? "#1f1c18" : "#fffaf4",
  };
}

function leaf(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

export default function TerminalPanel() {
  const open = useApp((s) => s.terminalOpen);
  const height = useApp((s) => s.terminalHeight);
  const directory = useApp((s) => s.directory);
  const setTerminalHeight = useApp((s) => s.setTerminalHeight);
  const toggleTerminal = useApp((s) => s.toggleTerminal);
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<PtySession | null>(null);
  const [restartNonce, setRestartNonce] = useState(0);

  useEffect(() => {
    if (!open) return;
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let sessionID: string | null = null;
    let unlisten: (() => void) | undefined;
    let fitFrame = 0;
    let fitTimer = 0;
    let resizeTimer = 0;
    const early: TerminalEventPayload[] = [];

    setStatus("connecting");
    setError(null);
    setSession(null);

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontFamily: cssValue("--font-mono") || "monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      macOptionIsMeta: true,
      scrollback: 10_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fitRef.current = fit;

    const fitNow = () => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        // 面板展开动画或窗口最小化时容器可能暂时没有尺寸，下一次观察再试
      }
    };
    const scheduleFit = () => {
      if (disposed) return;
      window.cancelAnimationFrame(fitFrame);
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = 0;
        fitNow();
      });
    };

    const syncAppearance = () => {
      if (disposed) return;
      term.options.theme = terminalTheme();
      term.options.fontFamily = cssValue("--font-mono") || "monospace";
      scheduleFit();
    };
    const appearance = new MutationObserver(syncAppearance);
    appearance.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });

    const resizeObserver = new ResizeObserver(() => {
      window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(scheduleFit, FIT_DEBOUNCE_MS);
    });
    resizeObserver.observe(host);

    const resizeSub = term.onResize(({ cols, rows }) => {
      if (!sessionID || cols <= 0 || rows <= 0) return;
      const id = sessionID;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        void api.terminalResize(id, directory, cols, rows).catch(() => {
          // 面板关闭或 shell 退出后尺寸同步失败是预期路径，不打断输入
        });
      }, RESIZE_DEBOUNCE_MS);
    });
    const inputSub = term.onData((data) => {
      if (!sessionID) return;
      void api.terminalWrite(sessionID, data).catch((err) => {
        if (disposed) return;
        setStatus("error");
        setError(String(err));
      });
    });

    const handleEvent = (event: TerminalEventPayload) => {
      if (disposed) return;
      if (!sessionID || event.id !== sessionID) {
        // `terminal_open` 的 invoke 响应可能晚于首批 PTY 输出，先缓存同会话事件。
        if (!sessionID) early.push(event);
        return;
      }
      if (event.kind === "data") {
        term.write(event.data);
      } else if (event.kind === "exit") {
        setStatus("exited");
        setError(event.message);
      } else {
        setStatus("error");
        setError(event.message);
      }
    };

    const start = async () => {
      try {
        const stop = await listen<TerminalEventPayload>(
          "deveco://terminal",
          (event) => handleEvent(event.payload),
        );
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
        fitNow();
        const opened = await api.terminalOpen(directory, term.cols, term.rows);
        if (disposed) {
          void api.terminalClose(opened.id, directory).catch(() => {});
          return;
        }
        sessionID = opened.id;
        setSession(opened);
        setStatus("ready");
        for (const event of early.splice(0)) {
          if (event.id === opened.id) handleEvent(event);
        }
        window.requestAnimationFrame(() => {
          if (disposed) return;
          fitNow();
          term.focus();
        });
      } catch (err) {
        if (disposed) return;
        setStatus("error");
        setError(String(err));
      }
    };
    void start();
    void document.fonts.ready.then(scheduleFit);

    return () => {
      disposed = true;
      window.clearTimeout(fitTimer);
      window.clearTimeout(resizeTimer);
      window.cancelAnimationFrame(fitFrame);
      appearance.disconnect();
      resizeObserver.disconnect();
      resizeSub.dispose();
      inputSub.dispose();
      unlisten?.();
      fitRef.current = null;
      term.dispose();
      if (sessionID) {
        const id = sessionID;
        void api.terminalClose(id, directory).catch(() => {
          // 面板关闭不需要把清理失败升级成全局错误
        });
      }
    };
  }, [open, directory, restartNonce]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // 高度变化过程中容器可能瞬时为 0，ResizeObserver 会补一次
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [height, open]);

  if (!open) return null;

  const meta = session
    ? `${leaf(session.command)} · ${leaf(session.cwd)}`
    : status === "connecting"
      ? "正在创建终端…"
      : "本地 Shell";
  const statusLabel =
    status === "ready"
      ? "运行中"
      : status === "connecting"
        ? "连接中"
        : status === "exited"
          ? "已结束"
          : "连接失败";

  return (
    <section
      id="terminal-panel"
      className="terminal-panel"
      style={{ height: `${height}px` }}
      aria-label="终端"
    >
      <div
        className="terminal-resizer"
        title="拖动调整终端高度，双击复位"
        onDoubleClick={() => setTerminalHeight(TERMINAL_DEFAULT_HEIGHT)}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const startY = event.clientY;
          const startHeight = height;
          const onMove = (moveEvent: MouseEvent) => {
            setTerminalHeight(startHeight - (moveEvent.clientY - startY));
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
          };
          document.body.style.cursor = "row-resize";
          document.body.style.userSelect = "none";
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      />
      <header className="terminal-head">
        <div className="terminal-head-main">
          <span className="terminal-head-title">
            <Icon name="terminal" size={15} />
            终端
          </span>
          <span className="terminal-head-meta" title={session?.cwd ?? directory ?? ""}>
            {meta}
          </span>
          <span className={`terminal-status ${status}`} title={statusLabel}>
            <span className="terminal-status-dot" />
            {statusLabel}
          </span>
        </div>
        <div className="terminal-actions">
          <button
            className="icon-btn"
            onClick={() => setRestartNonce((value) => value + 1)}
            title="重启终端"
            aria-label="重启终端"
            disabled={status === "connecting"}
          >
            <Icon name="refresh" size={15} />
          </button>
          <button
            className="icon-btn"
            onClick={toggleTerminal}
            title="收起终端"
            aria-label="收起终端"
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      </header>
      <div className="terminal-body">
        <div ref={hostRef} className="terminal-host" />
        {status !== "ready" && (
          <div className={`terminal-state ${status}`}>
            {status === "connecting" ? (
              <>
                <span className="terminal-spinner" />
                <strong>正在启动终端</strong>
                <span>从当前工作区创建本地 Shell…</span>
              </>
            ) : (
              <>
                <strong>{status === "exited" ? "终端已结束" : "终端连接失败"}</strong>
                <span>{error ?? "无法连接本地终端"}</span>
                <button
                  className="ghost-btn"
                  onClick={() => setRestartNonce((value) => value + 1)}
                >
                  重新打开
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

