import { useMemo } from "react";
import { useApp } from "../store";

export default function StatusBar() {
  const messages = useApp((s) => s.messages);
  const sseOk = useApp((s) => s.sseOk);
  const directory = useApp((s) => s.directory);
  const streaming = useApp((s) => s.streaming);
  const mcpCount = useApp((s) => s.mcpCount);
  const selectedAgent = useApp((s) => s.selectedAgent);
  const sseCount = useApp((s) => s.sseCount);

  const stats = useMemo(() => {
    let steps = 0;
    let input = 0;
    let output = 0;
    let cost = 0;
    let turns = 0;
    for (const message of messages) {
      if (message.info.role === "user") turns += 1;
      const tokens = message.info.tokens;
      if (tokens) {
        input += tokens.input ?? 0;
        output += tokens.output ?? 0;
      }
      cost += message.info.cost ?? 0;
      for (const part of message.parts) {
        if (part.type === "step-finish") steps += 1;
      }
    }
    return { steps, input, output, cost, turns };
  }, [messages]);

  const project = directory ? directory.split("/").filter(Boolean).pop() : "未选择工作区";

  return (
    <footer className="statusbar">
      <span
        className={`status-item ${sseOk ? "ok" : "warn"}`}
        title={`已接收 ${sseCount} 条实时事件`}
      >
        <span className="dot" />
        {sseOk ? "事件流已连接" : "事件流未连接"}
      </span>
      <span className="status-sep">·</span>
      <span className="status-item">{project}</span>
      <span className="status-grow" />
      {streaming && <span className="status-item accent">执行中</span>}
      <span className="status-item">agent: {selectedAgent}</span>
      <span className="status-sep">·</span>
      <span className="status-item">{mcpCount} MCP</span>
      <span className="status-sep">·</span>
      <span className="status-item">{stats.turns} 轮</span>
      <span className="status-sep">·</span>
      <span className="status-item">{stats.steps} 步</span>
      <span className="status-sep">·</span>
      <span className="status-item">
        {formatNumber(stats.input)} in / {formatNumber(stats.output)} out
      </span>
      {stats.cost > 0 && (
        <>
          <span className="status-sep">·</span>
          <span className="status-item">${stats.cost.toFixed(3)}</span>
        </>
      )}
    </footer>
  );
}

function formatNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
