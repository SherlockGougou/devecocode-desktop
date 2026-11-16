import type { SubagentTask } from "../types";
import type { TodoProgress } from "../tasks";
import { Icon } from "./Icon";

const STATUS_LABEL: Record<SubagentTask["status"], string> = {
  pending: "等待",
  running: "执行中",
  completed: "完成",
  error: "失败",
  interrupted: "已中断",
};

export function TaskStatusBadge({ status }: { status: SubagentTask["status"] }) {
  return (
    <span className={`task-status ${status}`}>
      {status === "running" && <span className="tool-spinner" />}
      {status === "completed" && <Icon name="check" size={11} strokeWidth={2.2} />}
      {status === "error" && <Icon name="alert" size={11} />}
      {status === "interrupted" && <Icon name="stop" size={11} />}
      {status === "pending" && <span className="todo-pending-dot" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function TaskProgressBar({ progress }: { progress: TodoProgress }) {
  return (
    <div
      className="task-progress"
      role="progressbar"
      aria-label="任务完成进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress.percent}
      title={`${progress.resolved}/${progress.total} 已结束`}
    >
      <span style={{ width: `${progress.percent}%` }} />
    </div>
  );
}

export function formatTaskDuration(
  task: Pick<SubagentTask, "startedAt" | "endedAt" | "status">,
  now = Date.now(),
) {
  if (!task.startedAt) return "";
  const end = task.endedAt ?? (task.status === "running" ? now : undefined);
  if (!end || end < task.startedAt) return "";
  const seconds = Math.max(0, Math.round((end - task.startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const minuteRest = minutes % 60;
  return minuteRest ? `${hours} 小时 ${minuteRest} 分` : `${hours} 小时`;
}
