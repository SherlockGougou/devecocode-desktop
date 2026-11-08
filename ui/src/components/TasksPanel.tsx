import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useApp } from "../store";
import {
  buildSubagentTasks,
  taskActivities,
  todoProgress,
  type TaskActivityItem,
  type TodoProgress,
} from "../tasks";
import type { SubagentTask, TodoItem } from "../types";
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

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function TodoMark({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return (
      <span className="todo-mark completed">
        <Icon name="check" size={11} strokeWidth={2.3} />
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="todo-mark in-progress">
        <span className="tool-spinner" />
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className="todo-mark cancelled">
        <Icon name="close" size={10} strokeWidth={2} />
      </span>
    );
  }
  return <span className="todo-mark pending" />;
}

function TodoChecklist({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="todo-list">
      {todos.map((todo, index) => (
        <div
          className={`todo-item ${todo.status}`}
          key={`${todo.content}-${index}`}
          title={todo.content}
        >
          <TodoMark status={todo.status} />
          <span className="todo-text">{todo.content}</span>
          {todo.status === "in_progress" && <span className="todo-tag">进行中</span>}
          {todo.priority === "high" && <span className="todo-priority">高</span>}
        </div>
      ))}
    </div>
  );
}

function TodoSection({ todos, compact = false }: { todos: TodoItem[]; compact?: boolean }) {
  const progress = todoProgress(todos);
  if (todos.length === 0) return null;
  return (
    <section className={`task-section${compact ? " compact" : ""}`}>
      <div className="task-section-head">
        <span className="task-section-title">
          <Icon name="list" size={14} />
          待办
        </span>
        <span className="task-section-meta">
          {progress.resolved}/{progress.total}
          {progress.cancelled > 0 && ` · ${progress.cancelled} 取消`}
        </span>
      </div>
      <TaskProgressBar progress={progress} />
      <TodoChecklist todos={todos} />
    </section>
  );
}

function runningCount(tasks: SubagentTask[]) {
  return tasks.filter((task) => task.status === "running" || task.status === "pending").length;
}

function SubagentRow({ task, now }: { task: SubagentTask; now: number }) {
  const openTasks = useApp((state) => state.openTasks);
  const childTodos = useApp((state) =>
    task.sessionID ? state.childTodos[task.sessionID] : undefined,
  );
  const progress = childTodos ? todoProgress(childTodos) : null;
  const duration = formatTaskDuration(task, now);
  return (
    <button
      className={`subagent-row ${task.status}`}
      onClick={() => openTasks(task.id)}
      title={task.description}
    >
      <span className="subagent-icon">
        <Icon name="branch" size={15} />
      </span>
      <span className="subagent-copy">
        <span className="subagent-title">{task.description}</span>
        <span className="subagent-meta">
          {task.agent}
          {duration && ` · ${duration}`}
          {progress && progress.total > 0 && ` · 待办 ${progress.resolved}/${progress.total}`}
        </span>
      </span>
      <TaskStatusBadge status={task.status} />
      <Icon name="chevron-right" size={13} className="subagent-caret" />
    </button>
  );
}

function SubagentSection({
  tasks,
  now,
  compact = false,
}: {
  tasks: SubagentTask[];
  now: number;
  compact?: boolean;
}) {
  if (tasks.length === 0) return null;
  return (
    <section className={`task-section${compact ? " compact" : ""}`}>
      <div className="task-section-head">
        <span className="task-section-title">
          <Icon name="branch" size={14} />
          子代理
        </span>
        <span className="task-section-meta">
          {runningCount(tasks) > 0
            ? `${runningCount(tasks)} 个进行中`
            : `${tasks.length} 个任务`}
        </span>
      </div>
      <div className="subagent-list">
        {tasks.map((task) => (
          <SubagentRow key={task.id} task={task} now={now} />
        ))}
      </div>
    </section>
  );
}

function timeText(ms?: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ActivityRow({ item }: { item: TaskActivityItem }) {
  let marker: ReactNode = <span className="activity-dot" />;
  if (item.kind === "tool") {
    if (item.status === "running" || item.status === "pending") {
      marker = <span className="tool-spinner" />;
    } else if (item.status === "completed") {
      marker = <Icon name="check" size={11} strokeWidth={2.2} />;
    } else if (item.status === "error") {
      marker = <Icon name="alert" size={11} />;
    } else if (item.status === "interrupted") {
      marker = <Icon name="stop" size={11} />;
    } else {
      marker = <span className="activity-dot" />;
    }
  } else if (item.kind === "reasoning") {
    marker = <Icon name="spark" size={11} />;
  }
  return (
    <div className={`task-activity ${item.kind} ${item.status ?? ""}`}>
      <span className="task-activity-mark">{marker}</span>
      <div className="task-activity-body">
        <div className="task-activity-head">
          <span className="task-activity-title">{item.title}</span>
          {item.time && <span className="task-activity-time">{timeText(item.time)}</span>}
        </div>
        {item.detail && <div className="task-activity-detail">{item.detail}</div>}
      </div>
    </div>
  );
}

function TaskDetail({ task, now }: { task: SubagentTask; now: number }) {
  const closeTaskDetail = useApp((state) => state.closeTaskDetail);
  const childMessages = useApp((state) =>
    task.sessionID ? state.childMessages[task.sessionID] : undefined,
  );
  const childTodos = useApp((state) =>
    task.sessionID ? state.childTodos[task.sessionID] : undefined,
  );
  const status = useApp((state) =>
    task.sessionID ? state.sessionStatuses[task.sessionID] : undefined,
  );
  const activities = useMemo(() => taskActivities(childMessages ?? []), [childMessages]);
  const duration = formatTaskDuration(task, now);
  const progress = childTodos ? todoProgress(childTodos) : null;
  const waitingForParent =
    task.status === "running" && status?.type === "idle" && Boolean(task.sessionID);

  return (
    <div className="task-detail">
      <div className="task-detail-head">
        <button
          className="mini-btn"
          onClick={closeTaskDetail}
          title="返回任务列表"
          aria-label="返回任务列表"
        >
          <Icon name="arrow-left" size={15} />
        </button>
        <span className="task-detail-title" title={task.description}>
          {task.description}
        </span>
        <TaskStatusBadge status={task.status} />
      </div>
      <div className="task-detail-meta">
        <span>{task.agent}</span>
        {duration && (
          <>
            <span className="task-detail-sep">·</span>
            <span>{duration}</span>
          </>
        )}
        {progress && progress.total > 0 && (
          <>
            <span className="task-detail-sep">·</span>
            <span>
              待办 {progress.resolved}/{progress.total}
            </span>
          </>
        )}
      </div>
      {task.error && <div className="task-error">{task.error}</div>}
      {status?.type === "retry" && (
        <div className="task-note">正在重试：{status.message || `第 ${status.attempt} 次`}</div>
      )}
      {waitingForParent && (
        <div className="task-note">子代理已停止输出，等待主代理收尾。</div>
      )}
      <TodoSection todos={childTodos ?? []} compact />
      {task.prompt && (
        <details className="task-prompt">
          <summary>
            <Icon name="chevron-right" size={12} className="caret" />
            任务说明
          </summary>
          <pre>{task.prompt}</pre>
        </details>
      )}
      <section className="task-section task-activity-section">
        <div className="task-section-head">
          <span className="task-section-title">最近活动</span>
          {task.sessionID && <span className="task-section-meta">{task.sessionID}</span>}
        </div>
        {activities.length > 0 ? (
          <div className="task-activity-list">
            {activities.map((item) => (
              <ActivityRow key={`${item.id}-${item.title}`} item={item} />
            ))}
          </div>
        ) : (
          <div className="empty-line">
            {task.status === "running" ? "等待子代理输出…" : "没有可读取的活动记录"}
          </div>
        )}
      </section>
    </div>
  );
}

export default function TasksPanel() {
  const messages = useApp((state) => state.messages);
  const sessionID = useApp((state) => state.sessionID);
  const sessionChildren = useApp((state) => state.sessionChildren);
  const sessionStatuses = useApp((state) => state.sessionStatuses);
  const todos = useApp((state) => state.todos);
  const selectedTaskID = useApp((state) => state.selectedTaskID);
  const tasksLoading = useApp((state) => state.tasksLoading);
  const tasks = useMemo(
    () => buildSubagentTasks(messages, sessionID, sessionChildren, sessionStatuses),
    [messages, sessionID, sessionChildren, sessionStatuses],
  );
  const now = useNow(tasks.some((task) => task.status === "running"));
  const selected = selectedTaskID
    ? tasks.find((task) => task.id === selectedTaskID)
    : undefined;

  if (selected) return <TaskDetail task={selected} now={now} />;

  const hasContent = todos.length > 0 || tasks.length > 0;
  return (
    <div className="tasks-overview">
      {tasksLoading && !hasContent && (
        <div className="task-loading">
          <span className="tool-spinner" />
          正在读取任务状态…
        </div>
      )}
      <TodoSection todos={todos} />
      <SubagentSection tasks={tasks} now={now} />
      {!tasksLoading && !hasContent && (
        <div className="task-empty">
          <span className="task-empty-icon">
            <Icon name="branch" size={20} />
          </span>
          <strong>没有进行中的任务</strong>
          <span>当前会话还没有待办清单或子代理任务。</span>
        </div>
      )}
    </div>
  );
}
