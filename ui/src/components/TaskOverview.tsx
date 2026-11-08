import { useEffect, useMemo, useRef } from "react";
import { messageTotalTokens } from "../messageStats";
import { useApp } from "../store";
import { buildSubagentTasks, todoProgress } from "../tasks";
import type { Message } from "../types";
import { Icon } from "./Icon";
import { TaskProgressBar } from "./TasksPanel";

function formatNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function projectName(directory: string | null) {
  return directory ? directory.split("/").filter(Boolean).pop() ?? directory : "未选择工作区";
}

function summarize(messages: Message[]) {
  let turns = 0;
  let total = 0;
  let cost = 0;
  for (const message of messages) {
    if (message.info.role === "user") {
      turns += 1;
      continue;
    }
    total += messageTotalTokens(message);
    cost += message.info.cost ?? 0;
  }
  return { turns, total, cost };
}

export default function TaskOverview() {
  const open = useApp((s) => s.overviewOpen);
  const pinned = useApp((s) => s.overviewPinned);
  const directory = useApp((s) => s.directory);
  const sessionID = useApp((s) => s.sessionID);
  const sessions = useApp((s) => s.sessions);
  const messages = useApp((s) => s.messages);
  const todos = useApp((s) => s.todos);
  const sessionChildren = useApp((s) => s.sessionChildren);
  const sessionStatuses = useApp((s) => s.sessionStatuses);
  const streaming = useApp((s) => s.streaming);
  const selectedAgent = useApp((s) => s.selectedAgent);
  const selectedModel = useApp((s) => s.selectedModel);
  const git = useApp((s) => s.overviewGit);
  const loading = useApp((s) => s.overviewLoading);
  const overviewError = useApp((s) => s.overviewError);
  const commitMessage = useApp((s) => s.commitMessage);
  const commitMessageGenerating = useApp((s) => s.commitMessageGenerating);
  const commitMessageError = useApp((s) => s.commitMessageError);
  const committing = useApp((s) => s.committing);
  const pushing = useApp((s) => s.pushing);
  const closeOverview = useApp((s) => s.closeOverview);
  const setOverviewPinned = useApp((s) => s.setOverviewPinned);
  const refreshOverview = useApp((s) => s.refreshOverview);
  const setCommitMessage = useApp((s) => s.setCommitMessage);
  const commitChanges = useApp((s) => s.commitChanges);
  const pushChanges = useApp((s) => s.pushChanges);
  const openTasks = useApp((s) => s.openTasks);
  const openRightTab = useApp((s) => s.openRightTab);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || pinned) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (cardRef.current?.contains(target)) return;
      if (target.closest("[data-overview-toggle]")) return;
      closeOverview();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, pinned, closeOverview]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeOverview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeOverview]);

  useEffect(() => {
    if (open) void refreshOverview();
  }, [open, directory, sessionID, refreshOverview]);

  const title = useMemo(() => {
    if (!directory || !sessionID) return "";
    return (sessions[directory] ?? []).find((item) => item.id === sessionID)?.title ?? "";
  }, [directory, sessionID, sessions]);

  const tasks = useMemo(
    () => buildSubagentTasks(messages, sessionID, sessionChildren, sessionStatuses),
    [messages, sessionID, sessionChildren, sessionStatuses],
  );
  const progress = todoProgress(todos);
  const stats = useMemo(() => summarize(messages), [messages]);
  const runningTasks = tasks.filter(
    (task) => task.status === "running" || task.status === "pending",
  ).length;
  const agentRunning =
    streaming ||
    Object.values(sessionStatuses).some(
      (status) => status.type === "busy" || status.type === "retry",
    );
  const branch = git?.detached
    ? "detached HEAD"
    : git?.branch ?? (loading ? "读取中…" : "—");
  const model = selectedModel
    ? `${selectedModel.providerID}/${selectedModel.modelID}`
    : "跟随会话";
  const canUseGit =
    Boolean(sessionID) &&
    Boolean(git?.isRepo) &&
    !git?.detached &&
    !overviewError &&
    !loading;
  const busy = agentRunning || commitMessageGenerating || committing || pushing;
  const canCommit = canUseGit && (git?.files.length ?? 0) > 0 && !busy;
  const canPush =
    canUseGit &&
    Boolean(git?.branch) &&
    (git?.upstream ? (git?.ahead ?? 0) > 0 : Boolean(git?.remote)) &&
    !busy;

  if (!open) return null;

  const commitHint = !sessionID
    ? "打开会话后可提交"
    : loading && !git
      ? "正在读取 Git 状态…"
      : !git?.isRepo
        ? "当前工作区不是 Git 仓库"
        : git.detached
          ? "detached HEAD 无法提交"
          : git.files.length === 0
            ? "当前没有可提交的改动"
            : agentRunning
              ? "Agent 正在执行，结束后再提交"
              : commitMessageGenerating
                ? "Agent 正在生成提交信息…"
                : committing
                  ? "正在提交…"
                  : "提交当前工作区全部改动";
  const pushHint = !sessionID
    ? "打开会话后可推送"
    : !git
      ? loading
        ? "正在读取 Git 状态…"
        : "尚未读取 Git 状态"
    : !git?.isRepo
      ? "当前工作区不是 Git 仓库"
      : git.detached
        ? "detached HEAD 无法推送"
        : git.upstream
          ? git.ahead > 0
            ? `推送到 ${git.upstream}`
            : "没有待推送的提交"
          : git.remote
            ? `未设置 upstream，将推送到 ${git.remote}`
            : "当前分支没有可用远端";

  return (
    <div
      id="task-overview"
      ref={cardRef}
      className="task-overview"
      role="dialog"
      aria-label="任务概览"
    >
      <div className="task-overview-head">
        <div className="task-overview-title">
          <Icon name="list" size={15} />
          任务概览
        </div>
        <div className="task-overview-head-actions">
          <button
            className={`mini-btn task-overview-tool ${pinned ? "on" : ""}`}
            onClick={() => setOverviewPinned(!pinned)}
            title={pinned ? "取消固定展示" : "固定展示"}
            aria-label={pinned ? "取消固定展示" : "固定展示"}
            aria-pressed={pinned}
          >
            <Icon name="pin" size={15} />
          </button>
          <button
            className="mini-btn task-overview-tool"
            onClick={() => void refreshOverview()}
            title="刷新概览"
            aria-label="刷新概览"
          >
            <Icon name="refresh" size={14} />
          </button>
          <button
            className="mini-btn task-overview-tool"
            onClick={closeOverview}
            title="关闭（Esc）"
            aria-label="关闭任务概览"
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      </div>

      {!sessionID ? (
        <div className="task-overview-empty">
          <Icon name="compose" size={22} />
          <strong>还没有当前会话</strong>
          <span>打开一个会话后，这里会显示任务进度和工作区状态。</span>
        </div>
      ) : (
        <>
          <div className="task-overview-session">
            <div className="task-overview-session-title" title={title}>
              {title || "未命名会话"}
            </div>
            <div className="task-overview-subline">
              <span title={directory ?? undefined}>{projectName(directory)}</span>
              <span className="task-overview-sep">·</span>
              <span className={`task-overview-status ${agentRunning ? "running" : ""}`}>
                <span className="dot" />
                {agentRunning ? "执行中" : "空闲"}
              </span>
            </div>
            <div className="task-overview-subline task-overview-muted">
              {selectedAgent} · {model}
            </div>
          </div>

          <section className="task-overview-section">
            <div className="task-overview-section-head">
              <span>任务</span>
              <button className="task-overview-link" onClick={() => openTasks()}>
                查看完整任务
                <Icon name="chevron-right" size={12} />
              </button>
            </div>
            <div className="task-overview-progress-line">
              <span>
                待办 <strong>{progress.resolved}/{progress.total}</strong>
              </span>
              <span>
                子代理 <strong>{runningTasks > 0 ? `${runningTasks} 进行中` : `${tasks.length} 个`}</strong>
              </span>
            </div>
            {progress.total > 0 && <TaskProgressBar progress={progress} />}
            {progress.active && (
              <div className="task-overview-current" title={progress.active.content}>
                {progress.active.content}
              </div>
            )}
            {progress.total === 0 && tasks.length === 0 && (
              <div className="task-overview-muted">当前会话还没有待办或子代理记录</div>
            )}
          </section>

          <section className="task-overview-section">
            <div className="task-overview-section-head">
              <span>工作区</span>
              <button className="task-overview-link" onClick={() => openRightTab("changes")}>
                查看变更
                <Icon name="chevron-right" size={12} />
              </button>
            </div>
            {overviewError && <div className="task-overview-error">{overviewError}</div>}
            {loading && !git && !overviewError && (
              <div className="task-overview-muted">正在读取 Git 状态…</div>
            )}
            {git && !git.isRepo && (
              <div className="task-overview-muted">当前工作区不是 Git 仓库</div>
            )}
            {git?.isRepo && (
              <>
                <div className="task-overview-git-line">
                  <Icon name="branch" size={14} />
                  <strong title={git.branch ?? undefined}>{branch}</strong>
                  {git.upstream ? (
                    <span className="task-overview-muted" title={git.upstream}>
                      {git.upstream}
                    </span>
                  ) : (
                    <span className="task-overview-muted">
                      {git.remote ? `未设置 upstream · ${git.remote}` : "未配置远端"}
                    </span>
                  )}
                  {(git.ahead > 0 || git.behind > 0) && (
                    <span className="task-overview-muted">
                      {git.ahead > 0 && `↑${git.ahead}`}
                      {git.ahead > 0 && git.behind > 0 && " "}
                      {git.behind > 0 && `↓${git.behind}`}
                    </span>
                  )}
                </div>
                <div className="task-overview-change-line">
                  <span>
                    {git.files.length > 0 ? `${git.files.length} 个文件` : "工作区干净"}
                  </span>
                  {(git.additions > 0 || git.deletions > 0) && (
                    <span className="task-overview-diff">
                      {git.additions > 0 && <em className="add">+{git.additions}</em>}
                      {git.deletions > 0 && <em className="del">−{git.deletions}</em>}
                    </span>
                  )}
                  {git.untracked > 0 && (
                    <span className="task-overview-muted">{git.untracked} 未跟踪</span>
                  )}
                </div>
                <div className="task-overview-change-meta">
                  暂存 {git.staged} · 未暂存 {git.unstaged}
                </div>
              </>
            )}
          </section>

          <section className="task-overview-section">
            <div className="task-overview-section-head"><span>运行</span></div>
            <div className="task-overview-metrics">
              <div><span>轮次</span><strong>{stats.turns}</strong></div>
              <div><span>Token</span><strong>{formatNumber(stats.total)}</strong></div>
              <div><span>费用</span><strong>{stats.cost > 0 ? `$${stats.cost.toFixed(3)}` : "—"}</strong></div>
            </div>
          </section>

          <section className="task-overview-section task-overview-commit">
            <div className="task-overview-section-head">
              <span>提交</span>
              <span className="task-overview-muted">包含当前工作区全部改动</span>
            </div>
            <textarea
              className="task-overview-message"
              rows={2}
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="提交信息（留空由 Agent 生成）"
              disabled={commitMessageGenerating || committing || pushing}
              aria-label="提交信息"
            />
            {commitMessageError && <div className="task-overview-error">{commitMessageError}</div>}
            <div className="task-overview-commit-actions">
              <button
                className="primary-btn small"
                onClick={() => void commitChanges()}
                disabled={!canCommit}
                title={commitHint}
              >
                {commitMessageGenerating || committing ? (
                  <span className="tool-spinner" />
                ) : (
                  <Icon name="check" size={13} />
                )}
                {commitMessageGenerating ? "生成中…" : committing ? "提交中…" : "提交"}
              </button>
              <button
                className="ghost-btn"
                onClick={() => void pushChanges()}
                disabled={!canPush}
                title={pushHint}
              >
                {pushing ? <span className="tool-spinner" /> : <Icon name="arrow-up" size={13} />}
                {pushing ? "推送中…" : "推送"}
              </button>
            </div>
            <div className="task-overview-commit-note">{pushHint}</div>
          </section>
        </>
      )}
    </div>
  );
}
