import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store";

export default function StatusBar() {
  const messages = useApp((s) => s.messages);
  const directory = useApp((s) => s.directory);
  const sessionID = useApp((s) => s.sessionID);
  const streaming = useApp((s) => s.streaming);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!streaming) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sessionID, streaming]);

  const stats = useMemo(() => {
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let turns = 0;
    let generatedTokens = 0;
    let generationMs = 0;
    for (const message of messages) {
      if (message.info.role === "user") {
        turns += 1;
        continue;
      }
      const tokens = message.info.tokens;
      if (tokens) {
        input += tokens.input ?? 0;
        output += tokens.output ?? 0;
        reasoning += tokens.reasoning ?? 0;
        cacheRead += tokens.cache?.read ?? 0;
        cacheWrite += tokens.cache?.write ?? 0;
      }
      cost += message.info.cost ?? 0;

      const started = message.info.time?.created;
      const completed = message.info.time?.completed;
      const ended = completed ?? (streaming ? now : undefined);
      const generated = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0);
      if (started && ended && ended > started && generated > 0) {
        generatedTokens += generated;
        generationMs += ended - started;
      }
    }
    return {
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      total: input + output + reasoning,
      cost,
      turns,
      speed: generationMs > 0 ? (generatedTokens / generationMs) * 1000 : 0,
    };
  }, [messages, now, streaming]);

  const project = directory ? directory.split("/").filter(Boolean).pop() : "未选择工作区";
  const tokenTitle = [
    `输入 ${formatNumber(stats.input)}`,
    `输出 ${formatNumber(stats.output)}`,
    `推理 ${formatNumber(stats.reasoning)}`,
    `合计 ${formatNumber(stats.total)}`,
    `缓存读 ${formatNumber(stats.cacheRead)}`,
    stats.cacheWrite > 0 ? `缓存写 ${formatNumber(stats.cacheWrite)}` : null,
    stats.cost > 0 ? `成本 $${stats.cost.toFixed(3)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <footer className="statusbar">
      <div className="status-context">
        <span className="status-project" title={directory ?? project}>
          {project}
        </span>
      </div>
      <span className="status-grow" />
      <div className="status-metrics">
        {streaming && (
          <span className="status-live">
            <span className="status-live-dot" />
            运行中
          </span>
        )}
        <span className="status-metric" title={`当前会话共 ${stats.turns} 轮`}>
          <span className="status-label">轮次</span>
          <span className="status-value">{stats.turns}</span>
        </span>
        <span className="status-sep">·</span>
        <span className="status-metric" title={tokenTitle}>
          <span className="status-label">Token</span>
          <span className="status-value">{formatNumber(stats.total)}</span>
        </span>
        <span className="status-sep">·</span>
        <span
          className={`status-metric status-speed ${streaming ? "live" : ""}`}
          title="当前会话累计生成速度：输出 + 推理 token / 助手消息耗时（含等待与工具调用）"
        >
          <span className="status-label">速度</span>
          <span className="status-value">{formatSpeed(stats.speed)}</span>
        </span>
      </div>
    </footer>
  );
}

function formatNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatSpeed(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "--";
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} tok/s`;
}
