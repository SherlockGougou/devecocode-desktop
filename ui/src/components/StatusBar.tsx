import { useMemo } from "react";
import { summarizeMessages } from "../messageStats";
import { useApp } from "../store";

export default function StatusBar() {
  const messages = useApp((s) => s.messages);
  const directory = useApp((s) => s.directory);
  const streaming = useApp((s) => s.streaming);
  const models = useApp((s) => s.models);
  const selectedModel = useApp((s) => s.selectedModel);
  const stats = useMemo(() => summarizeMessages(messages), [messages]);

  const project = directory ? directory.split("/").filter(Boolean).pop() : "未选择工作区";
  const cacheHit = formatCacheHit(stats.cacheHitPercent);
  const context = useMemo(() => {
    if (!stats.contextTokens) return null;
    const target = stats.contextModel ?? selectedModel;
    if (!target) return null;
    const model = models.find(
      (item) => item.id === target.modelID && item.providerID === target.providerID,
    );
    const contextWindow = model?.limit?.context;
    if (!contextWindow || contextWindow <= 0) return null;
    return {
      used: stats.contextTokens,
      window: contextWindow,
      percent: Math.min(100, Math.round((stats.contextTokens / contextWindow) * 100)),
    };
  }, [models, selectedModel, stats.contextModel, stats.contextTokens]);
  const contextTitle = context
    ? `上下文已用 ${context.percent}%（最近一次请求 ~${formatNumber(context.used)} / ${formatNumber(context.window)}）`
    : "";
  const tokenTitle = [
    `未缓存输入 ${formatNumber(stats.input)}`,
    `输出 ${formatNumber(stats.output)}`,
    `推理 ${formatNumber(stats.reasoning)}`,
    `缓存读取 ${formatNumber(stats.cacheRead)}`,
    stats.cacheWrite > 0 ? `缓存写入 ${formatNumber(stats.cacheWrite)}` : null,
    cacheHit !== null ? `缓存命中 ${cacheHit}%` : null,
    `合计 ${formatNumber(stats.total)}`,
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
          {cacheHit !== null && <span className="status-cache">缓存命中 {cacheHit}%</span>}
        </span>
        <span className="status-sep">·</span>
        <span
          className={`status-metric status-speed ${streaming ? "live" : ""}`}
          title="输出速度（TPS）：(输出 + 推理) token / 解码耗时（首 token 到输出结束，不含工具执行）；按已完成步骤累计"
        >
          <span className="status-label">速度</span>
          <span className="status-value">{formatSpeed(stats.speed)}</span>
        </span>
        {context && (
          <>
            <span className="status-sep">·</span>
            <span className="status-metric status-context" title={contextTitle}>
              <span className="status-label">上下文</span>
              <ContextRing percent={context.percent} />
              <span className="status-value">{context.percent}%</span>
            </span>
          </>
        )}
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
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} tok/s`;
}

function formatCacheHit(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  if (value >= 100) return "100";
  if (value >= 99.95) return "99.9";
  if (value >= 99.5) return value.toFixed(1);
  return String(Math.round(value));
}

function ContextRing({ percent }: { percent: number }) {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      className="status-context-ring"
      viewBox="0 0 14 14"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <circle className="status-context-track" cx="7" cy="7" r={radius} />
      <circle
        className="status-context-fill"
        cx="7"
        cy="7"
        r={radius}
        strokeDasharray={`${(circumference * percent) / 100} ${circumference}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}
