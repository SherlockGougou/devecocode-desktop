import { useEffect, useMemo, useRef, useState } from "react";
import { useApp, type SessionSort } from "../store";
import type { Session } from "../types";
import { copyItem, openPathItem, useContextMenu } from "../contextMenu";
import { Icon } from "./Icon";

const TITLE_COLLATOR = new Intl.Collator("zh-Hans", {
  numeric: true,
  sensitivity: "base",
});

function sortSessions(list: Session[], sort: SessionSort): Session[] {
  const next = [...list];
  if (sort === "title") {
    next.sort((a, b) =>
      TITLE_COLLATOR.compare(a.title || "未命名会话", b.title || "未命名会话"),
    );
    return next;
  }
  const key = sort === "created" ? "created" : "updated";
  next.sort((a, b) => (b.time?.[key] ?? 0) - (a.time?.[key] ?? 0));
  return next;
}

function basename(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 会话行的相对时间：与参考截图一致，不带「前」也不加空格（刚刚 / 32分钟 / 1小时） */
function timeAgo(ms?: number) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const minute = 60_000;
  if (diff < minute) return "刚刚";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)}分钟`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))}小时`;
  if (diff < 30 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))}天`;
  return new Date(ms).toLocaleDateString();
}

/** 单条会话：默认只有标题与相对时间，重命名/归档/删除只在悬停或聚焦时出现 */
function ChatRow({
  session,
  directory,
  active,
  streaming,
  onOpen,
}: {
  session: Session;
  directory: string;
  active: boolean;
  streaming: boolean;
  onOpen: () => void;
}) {
  const renameSession = useApp((s) => s.renameSession);
  const archiveSession = useApp((s) => s.archiveSession);
  const deleteSession = useApp((s) => s.deleteSession);
  const exportSession = useApp((s) => s.exportSession);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const title = session.title || "未命名会话";
  const archived = session.time?.archived ?? false;
  const menu = useContextMenu();

  const commitRename = async () => {
    const value = (editing ?? "").trim();
    setEditing(null);
    if (value && value !== session.title) await renameSession(directory, session.id, value);
  };

  return (
    <div
      className={`chat-row ${active ? "active" : ""} ${archived ? "archived" : ""}`}
      onContextMenu={(event) =>
        menu.open(
          event,
          [
            {
              type: "item",
              label: "打开会话",
              icon: "chevron-right",
              onSelect: onOpen,
            },
            {
              type: "item",
              label: "重命名",
              icon: "pencil",
              onSelect: () => setEditing(session.title ?? ""),
            },
            {
              type: "item",
              label: archived ? "取消归档" : "归档会话",
              icon: archived ? "unarchive" : "archive",
              onSelect: () => archiveSession(directory, session.id, !archived),
            },
            { type: "separator" },
            {
              type: "item",
              label: "导出会话",
              icon: "download",
              onSelect: () => exportSession(directory, session.id),
            },
            copyItem("复制会话标题", title, "会话标题已复制"),
            copyItem("复制会话 ID", session.id, "会话 ID 已复制"),
            { type: "separator" },
            {
              type: "item",
              label: "删除会话…",
              icon: "trash",
              danger: true,
              onSelect: () => setConfirming(true),
            },
          ],
          { label: "会话菜单" },
        )
      }
    >
      <span className="chat-mark" aria-hidden>
        {active && <span className={`chat-select ${streaming ? "run" : ""}`} />}
      </span>
      {editing !== null ? (
        <input
          className="chat-rename"
          autoFocus
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commitRename();
            if (event.key === "Escape") setEditing(null);
          }}
        />
      ) : (
        <button
          className="chat-main"
          onClick={onOpen}
          onDoubleClick={() => setEditing(session.title ?? "")}
          title={session.title ?? session.id}
          aria-current={active ? "true" : undefined}
        >
          <span className="chat-title">{title}</span>
          <span className="chat-time">{timeAgo(session.time?.updated)}</span>
        </button>
      )}
      {confirming ? (
        <span className="chat-confirm">
          <span>删除？</span>
          <button
            className="mini-btn text danger"
            onClick={() => {
              setConfirming(false);
              void deleteSession(directory, session.id);
            }}
          >
            确认
          </button>
          <button className="mini-btn text" onClick={() => setConfirming(false)}>
            取消
          </button>
        </span>
      ) : (
        editing === null && (
          <span className="chat-actions">
            <button
              className="mini-btn"
              title="重命名"
              aria-label="重命名会话"
              onClick={() => setEditing(session.title ?? "")}
            >
              <Icon name="pencil" size={14} />
            </button>
            <button
              className="mini-btn"
              title={archived ? "取消归档" : "归档会话"}
              aria-label={archived ? "取消归档" : "归档会话"}
              onClick={() => void archiveSession(directory, session.id, !archived)}
            >
              <Icon name={archived ? "unarchive" : "archive"} size={14} />
            </button>
            <button
              className="mini-btn danger"
              title="删除会话"
              aria-label="删除会话"
              onClick={() => setConfirming(true)}
            >
              <Icon name="trash" size={14} />
            </button>
          </span>
        )
      )}
    </div>
  );
}

export default function Sidebar() {
  const projects = useApp((s) => s.projects);
  const expanded = useApp((s) => s.expanded);
  const sessions = useApp((s) => s.sessions);
  const loadedDirs = useApp((s) => s.loadedDirs);
  const searchResults = useApp((s) => s.searchResults);
  const searching = useApp((s) => s.searching);
  const runSearch = useApp((s) => s.runSearch);
  const directory = useApp((s) => s.directory);
  const sessionID = useApp((s) => s.sessionID);
  const streaming = useApp((s) => s.streaming);
  const filter = useApp((s) => s.filter);
  const selectProject = useApp((s) => s.selectProject);
  const toggleProject = useApp((s) => s.toggleProject);
  const openSessionIn = useApp((s) => s.openSessionIn);
  const showArchived = useApp((s) => s.showArchived);
  const toggleArchivedView = useApp((s) => s.toggleArchivedView);
  const sessionSort = useApp((s) => s.sessionSort);
  const sessionPreview = useApp((s) => s.sessionPreview);
  const setSessionSort = useApp((s) => s.setSessionSort);
  const setSessionPreview = useApp((s) => s.setSessionPreview);
  const toggleAllProjects = useApp((s) => s.toggleAllProjects);
  const newSession = useApp((s) => s.newSession);
  const newSessionIn = useApp((s) => s.newSessionIn);
  const removeWorkspace = useApp((s) => s.removeWorkspace);
  const moveWorkspace = useApp((s) => s.moveWorkspace);
  const pickWorkspaceFolder = useApp((s) => s.pickWorkspaceFolder);
  const setFilter = useApp((s) => s.setFilter);
  const openSettings = useApp((s) => s.openSettings);
  const [searchOpen, setSearchOpen] = useState(false);
  /** 每个工作区当前展示的会话条数；收起工作区或改默认条数时清掉。 */
  const [sessionLimits, setSessionLimits] = useState<Record<string, number>>({});
  /** 正在等待二次确认移除的工作区。 */
  const [removing, setRemoving] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ dir: string; after: boolean } | null>(
    null,
  );
  const dragRef = useRef<{
    source: string;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const dropTargetRef = useRef<{ dir: string; after: boolean } | null>(null);
  const draggedAt = useRef(0);
  const menu = useContextMenu();

  const keyword = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!keyword) return projects;
    return projects.filter((project) => {
      if (project.worktree.toLowerCase().includes(keyword)) return true;
      return (sessions[project.worktree] ?? []).some((session) =>
        (session.title ?? "").toLowerCase().includes(keyword),
      );
    });
  }, [projects, sessions, keyword]);

  const orderedSessions = useMemo(() => {
    const result: Record<string, Session[]> = {};
    for (const [dir, list] of Object.entries(sessions)) {
      const filtered = showArchived
        ? list
        : list.filter((item) => !item.time?.archived);
      result[dir] = sortSessions(filtered, sessionSort);
    }
    return result;
  }, [sessions, showArchived, sessionSort]);

  const orderedSearchResults = useMemo(() => {
    const result: Record<string, Session[]> = {};
    for (const [dir, list] of Object.entries(searchResults)) {
      const filtered = showArchived
        ? list
        : list.filter((item) => !item.time?.archived);
      result[dir] = sortSessions(filtered, sessionSort);
    }
    return result;
  }, [searchResults, showArchived, sessionSort]);

  useEffect(() => {
    if (!filter.trim()) return;
    const timer = setTimeout(() => void runSearch(filter), 300);
    return () => clearTimeout(timer);
  }, [filter, runSearch]);

  useEffect(() => {
    setSessionLimits({});
  }, [sessionPreview]);

  useEffect(() => {
    if (removing && !projects.some((project) => project.worktree === removing)) {
      setRemoving(null);
    }
  }, [projects, removing]);

  useEffect(() => {
    const dirs = new Set(projects.map((project) => project.worktree));
    setSessionLimits((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const dir of Object.keys(next)) {
        if (!dirs.has(dir) || !expanded[dir]) {
          delete next[dir];
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [expanded, projects]);

  const toggleSearch = () => {
    if (searchOpen) {
      setSearchOpen(false);
      setFilter("");
      return;
    }
    setSearchOpen(true);
  };

  // 点击其它工作区＝切过去并展开；点击当前工作区＝只切换它自己的展开状态。
  // 这样重新展开不会重新拉取并跳到最近会话，多个工作区也可以同时保持展开。
  const onWorkspace = (dir: string) => {
    // 拖动结束后的 click 不应被当成一次工作区切换。
    if (Date.now() - draggedAt.current < 250) return;
    setRemoving(null);
    if (dir === directory) void toggleProject(dir);
    else void selectProject(dir);
  };

  const workspaceMenu = (
    event: React.MouseEvent,
    dir: string,
    canToggle: boolean,
  ) => {
    const isOpen = expanded[dir] ?? false;
    menu.open(
      event,
      [
        {
          type: "item",
          label: "新建会话",
          icon: "compose",
          onSelect: () => newSessionIn(dir),
        },
        ...(canToggle
          ? [
              {
                type: "item" as const,
                label: isOpen ? "收起会话" : "展开会话",
                icon: isOpen ? ("chevron-down" as const) : ("chevron-right" as const),
                onSelect: () => toggleProject(dir),
              },
            ]
          : []),
        { type: "separator" as const },
        copyItem("复制工作区路径", dir, "工作区路径已复制"),
        openPathItem("在 Finder 中打开", dir),
        { type: "separator" as const },
        {
          type: "item" as const,
          label: "从侧栏移除…",
          icon: "trash" as const,
          danger: true,
          onSelect: () => setRemoving(dir),
        },
      ],
      { label: "工作区菜单" },
    );
  };

  const viewMenu = (event: React.MouseEvent) => {
    setRemoving(null);
    const allOpen =
      projects.length > 0 &&
      projects.every((project) => expanded[project.worktree] ?? false);
    menu.open(
      event,
      [
        {
          type: "item",
          label: "显示已归档会话",
          icon: "archive",
          checked: showArchived,
          checkType: "checkbox",
          onSelect: toggleArchivedView,
        },
        { type: "separator" },
        {
          type: "item",
          label: "按最近更新排序",
          checked: sessionSort === "updated",
          checkType: "radio",
          onSelect: () => setSessionSort("updated"),
        },
        {
          type: "item",
          label: "按创建时间排序",
          checked: sessionSort === "created",
          checkType: "radio",
          onSelect: () => setSessionSort("created"),
        },
        {
          type: "item",
          label: "按标题排序",
          checked: sessionSort === "title",
          checkType: "radio",
          onSelect: () => setSessionSort("title"),
        },
        { type: "separator" },
        {
          type: "item",
          label: "默认显示 5 条",
          checked: sessionPreview === 5,
          checkType: "radio",
          onSelect: () => setSessionPreview(5),
        },
        {
          type: "item",
          label: "默认显示 10 条",
          checked: sessionPreview === 10,
          checkType: "radio",
          onSelect: () => setSessionPreview(10),
        },
        {
          type: "item",
          label: "默认显示 20 条",
          checked: sessionPreview === 20,
          checkType: "radio",
          onSelect: () => setSessionPreview(20),
        },
        {
          type: "item",
          label: "显示全部会话",
          checked: sessionPreview === "all",
          checkType: "radio",
          onSelect: () => setSessionPreview("all"),
        },
        { type: "separator" },
        {
          type: "item",
          label: allOpen ? "全部收起工作区" : "全部展开工作区",
          icon: allOpen ? "chevron-right" : "chevron-down",
          disabled: projects.length === 0,
          onSelect: () => void toggleAllProjects(),
        },
        { type: "separator" },
        {
          type: "item",
          label: "打开设置…",
          icon: "sliders",
          shortcut: "⌘,",
          onSelect: openSettings,
        },
      ],
      { label: "视图设置" },
    );
  };

  const beginDrag = (event: React.MouseEvent<HTMLDivElement>, dir: string) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest(".ws-buttons") || target.closest(".ws-confirm")) return;
    setRemoving(null);
    dragRef.current = {
      source: dir,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };

    const onMove = (moveEvent: MouseEvent) => {
      const state = dragRef.current;
      if (!state) return;
      if (!state.active) {
        const distance = Math.hypot(
          moveEvent.clientX - state.startX,
          moveEvent.clientY - state.startY,
        );
        if (distance < 4) return;
        state.active = true;
        setDragging(state.source);
        document.body.style.cursor = "grabbing";
      }
      moveEvent.preventDefault();
      const row = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>(".ws-row[data-workspace]");
      const nextDir = row?.dataset.workspace;
      if (!row || !nextDir || nextDir === state.source) {
        dropTargetRef.current = null;
        setDropTarget(null);
        return;
      }
      const rect = row.getBoundingClientRect();
      const next = {
        dir: nextDir,
        after: moveEvent.clientY > rect.top + rect.height / 2,
      };
      dropTargetRef.current = next;
      setDropTarget(next);
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("blur", onUp, true);
      document.body.style.cursor = "";
      const state = dragRef.current;
      dragRef.current = null;
      if (!state) return;
      const target = dropTargetRef.current;
      dropTargetRef.current = null;
      setDragging(null);
      setDropTarget(null);
      if (!state.active) return;
      draggedAt.current = Date.now();
      // 拖动结束后浏览器可能继续派发 click，吞掉它，避免误切工作区。
      const swallowClick = (clickEvent: MouseEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
      };
      window.addEventListener("click", swallowClick, true);
      window.setTimeout(
        () => window.removeEventListener("click", swallowClick, true),
        0,
      );
      if (target && target.dir !== state.source) {
        moveWorkspace(state.source, target.dir, target.after);
      }
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
    window.addEventListener("blur", onUp, true);
  };

  const renderWorkspace = (dir: string, isCurrent: boolean) => {
    const isOpen = expanded[dir] ?? false;
    const loaded = loadedDirs[dir] ?? false;
    const list = orderedSessions[dir] ?? [];
    const step = sessionPreview === "all" ? 0 : sessionPreview;
    const limit =
      sessionPreview === "all"
        ? list.length
        : (sessionLimits[dir] ?? sessionPreview);
    const shown = list.slice(0, limit);
    const hidden = list.length - shown.length;
    const dragClass =
      dragging === dir
        ? "dragging"
        : dropTarget?.dir === dir
          ? dropTarget.after
            ? "drop-after"
            : "drop-before"
          : "";
    return (
      <div className="ws" key={dir}>
        <div
          className={`ws-row ${isCurrent ? "active" : ""} ${dragClass}`}
          data-workspace={dir}
          onMouseDown={(event) => beginDrag(event, dir)}
          onContextMenu={(event) => workspaceMenu(event, dir, true)}
        >
          <div
            className="ws-main"
            role="button"
            tabIndex={0}
            onClick={() => onWorkspace(dir)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onWorkspace(dir);
            }}
            title={dir}
            aria-expanded={isOpen}
          >
            <span className="ws-icon">
              <Icon name="workspace" size={19} strokeWidth={1.9} />
            </span>
            <span className="ws-name">{basename(dir)}</span>
          </div>
          {removing === dir ? (
            <span className="ws-confirm">
              <span>移除？</span>
              <button
                className="mini-btn text danger"
                autoFocus
                onClick={() => {
                  setRemoving(null);
                  void removeWorkspace(dir);
                }}
              >
                确认
              </button>
              <button className="mini-btn text" onClick={() => setRemoving(null)}>
                取消
              </button>
            </span>
          ) : (
            <span className="ws-buttons">
              <button
                className="ws-new"
                onClick={() => void newSessionIn(dir)}
                title={`在 ${basename(dir)} 中新建会话`}
                aria-label={`在 ${basename(dir)} 中新建会话`}
              >
                <Icon name="compose" size={16} />
              </button>
              <button
                className="ws-remove"
                onClick={() => setRemoving(dir)}
                title={`从侧栏移除 ${basename(dir)}（不删除文件夹）`}
                aria-label={`从侧栏移除 ${basename(dir)}`}
              >
                <Icon name="trash" size={15} />
              </button>
            </span>
          )}
        </div>
        {isOpen && (
          <div className="ws-sessions">
            {!loaded && <div className="empty-line">加载中…</div>}
            {loaded && list.length === 0 && <div className="empty-line">还没有会话</div>}
            {shown.map((session) => (
              <ChatRow
                key={session.id}
                session={session}
                directory={dir}
                active={isCurrent && session.id === sessionID}
                streaming={isCurrent && session.id === sessionID && streaming}
                onOpen={() => void openSessionIn(dir, session.id)}
              />
            ))}
            {hidden > 0 && (
              <button
                className="chat-more"
                title={`再显示 ${Math.min(step, hidden)} 个会话`}
                onClick={() =>
                  setSessionLimits((previous) => ({
                    ...previous,
                    [dir]: (previous[dir] ?? step) + step,
                  }))
                }
              >
                展开更多
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const viewCustomized =
    showArchived || sessionSort !== "updated" || sessionPreview !== 5;

  return (
    <aside
      className="sidebar"
      onContextMenu={(event) =>
        menu.open(
          event,
          [
            {
              type: "item",
              label: "新建会话",
              icon: "compose",
              shortcut: "⌘N",
              disabled: !directory,
              onSelect: () => newSession(),
            },
            {
              type: "item",
              label: searchOpen ? "关闭搜索" : "搜索工作区或会话",
              icon: "search",
              onSelect: toggleSearch,
            },
            {
              type: "item",
              label: showArchived ? "隐藏已归档会话" : "显示已归档会话",
              icon: "archive",
              onSelect: toggleArchivedView,
            },
            { type: "separator" },
            {
              type: "item",
              label: "打开设置",
              icon: "sliders",
              shortcut: "⌘,",
              onSelect: openSettings,
            },
          ],
          { label: "侧栏菜单" },
        )
      }
    >
      <div className="ws-header">
        <span className="ws-title">
          {keyword ? (searching ? "搜索中…" : "搜索结果") : "工作区"}
        </span>
        <div className="ws-actions">
          <button
            className={`ws-action ${searchOpen ? "on" : ""}`}
            onClick={toggleSearch}
            title="搜索工作区或会话"
            aria-label="搜索工作区或会话"
            aria-pressed={searchOpen}
          >
            <Icon name="search" size={17} />
          </button>
          <button
            className={`ws-action ${viewCustomized ? "on" : ""}`}
            onClick={viewMenu}
            title="视图设置"
            aria-label="视图设置"
            aria-haspopup="menu"
          >
            <Icon name="sliders" size={17} />
          </button>
          <button
            className="ws-action"
            onClick={() => void newSession()}
            disabled={!directory}
            title="新会话"
            aria-label="新会话"
          >
            <Icon name="compose" size={17} />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="sidebar-search">
          <Icon name="search" size={14} />
          <input
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="搜索工作区或会话"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setFilter("");
                setSearchOpen(false);
              }
            }}
          />
          <button
            className="search-clear"
            onClick={() => {
              setFilter("");
              setSearchOpen(false);
            }}
            title="关闭搜索"
            aria-label="关闭搜索"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      <div className="tree">
        {keyword
          ? Object.entries(orderedSearchResults).map(([dir, list]) => (
              <div className="ws" key={`search-${dir}`}>
                <div
                  className={`ws-row static ${dir === directory ? "active" : ""}`}
                  onContextMenu={(event) => workspaceMenu(event, dir, false)}
                >
                  <div className="ws-main" title={dir}>
                    <span className="ws-icon">
                      <Icon name="workspace" size={19} strokeWidth={1.9} />
                    </span>
                    <span className="ws-name">{basename(dir)}</span>
                  </div>
                  {removing === dir ? (
                    <span className="ws-confirm">
                      <span>移除？</span>
                      <button
                        className="mini-btn text danger"
                        autoFocus
                        onClick={() => {
                          setRemoving(null);
                          void removeWorkspace(dir);
                        }}
                      >
                        确认
                      </button>
                      <button
                        className="mini-btn text"
                        onClick={() => setRemoving(null)}
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <span className="ws-buttons">
                      <button
                        className="ws-new"
                        onClick={() => void newSessionIn(dir)}
                        title={`在 ${basename(dir)} 中新建会话`}
                        aria-label={`在 ${basename(dir)} 中新建会话`}
                      >
                        <Icon name="compose" size={16} />
                      </button>
                      <button
                        className="ws-remove"
                        onClick={() => setRemoving(dir)}
                        title={`从侧栏移除 ${basename(dir)}（不删除文件夹）`}
                        aria-label={`从侧栏移除 ${basename(dir)}`}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </span>
                  )}
                </div>
                <div className="ws-sessions">
                  {list.map((session) => (
                    <ChatRow
                      key={session.id}
                      session={session}
                      directory={dir}
                      active={session.id === sessionID && dir === directory}
                      streaming={session.id === sessionID && dir === directory && streaming}
                      onOpen={() => void openSessionIn(dir, session.id)}
                    />
                  ))}
                </div>
              </div>
            ))
          : visible.map((project) => renderWorkspace(project.worktree, project.worktree === directory))}
        {keyword && !searching && Object.keys(orderedSearchResults).length === 0 && (
          <div className="empty-line">没有匹配的会话</div>
        )}
        {!keyword && visible.length === 0 && (
          <div className="workspace-empty">
            <div className="empty-line">还没有工作区</div>
            <button className="ghost-btn" onClick={() => void pickWorkspaceFolder()}>
              <Icon name="workspace" size={14} />
              选择文件夹…
            </button>
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <span className="dot" />
        <span className="footer-text">本机 CLI</span>
        <button
          className="footer-btn"
          onClick={() => openSettings()}
          title="设置 (⌘,)"
          aria-label="打开设置"
        >
          <Icon name="sliders" size={16} />
        </button>
      </div>
    </aside>
  );
}
