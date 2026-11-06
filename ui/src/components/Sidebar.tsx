import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store";

function basename(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function timeAgo(ms?: number) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const minute = 60_000;
  if (diff < minute) return "刚刚";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  if (diff < 30 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
  return new Date(ms).toLocaleDateString();
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
  const filter = useApp((s) => s.filter);
  const selectProject = useApp((s) => s.selectProject);
  const toggleProject = useApp((s) => s.toggleProject);
  const openSession = useApp((s) => s.openSession);
  const openSessionIn = useApp((s) => s.openSessionIn);
  const showArchived = useApp((s) => s.showArchived);
  const toggleArchivedView = useApp((s) => s.toggleArchivedView);
  const archiveSession = useApp((s) => s.archiveSession);
  const newSession = useApp((s) => s.newSession);
  const setFilter = useApp((s) => s.setFilter);
  const openSettings = useApp((s) => s.openSettings);
  const renameSession = useApp((s) => s.renameSession);
  const deleteSession = useApp((s) => s.deleteSession);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const visible = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    return projects.filter((project) => {
      if (!keyword) return true;
      if (project.worktree.toLowerCase().includes(keyword)) return true;
      return (sessions[project.worktree] ?? []).some((session) =>
        (session.title ?? "").toLowerCase().includes(keyword),
      );
    });
  }, [projects, sessions, filter]);

  useEffect(() => {
    if (!filter.trim()) return;
    const timer = setTimeout(() => void runSearch(filter), 300);
    return () => clearTimeout(timer);
  }, [filter, runSearch]);

  const commitRename = async () => {
    if (!editing) return;
    const { id, value } = editing;
    setEditing(null);
    if (value.trim()) await renameSession(id, value);
  };

  return (
    <aside className="sidebar">
      <button className="new-session" onClick={() => void newSession()} disabled={!directory}>
        <span className="plus">+</span> 新会话
      </button>

      <div className="search">
        <span className="search-icon">⌕</span>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="搜索项目或会话"
        />
      </div>

      <div className="section-title">
        <span>{filter.trim() ? (searching ? "搜索中…" : "搜索结果") : "工作区"}</span>
        {!filter.trim() && (
          <button
            className={`archive-toggle ${showArchived ? "active" : ""}`}
            onClick={toggleArchivedView}
            title={showArchived ? "隐藏已归档会话" : "显示已归档会话"}
          >
            {showArchived ? "隐藏归档" : "显示归档"}
          </button>
        )}
      </div>
      <div className="tree">
        {filter.trim() &&
          Object.entries(searchResults).map(([dir, list]) => (
            <div key={`search-${dir}`} className="project">
              <div className="project-row">
                <span className="chevron-btn open" aria-hidden>
                  ›
                </span>
                <button className="project-name" onClick={() => void selectProject(dir)} title={dir}>
                  {basename(dir)}
                </button>
                <span className="project-count">{list.length}</span>
              </div>
              <div className="sessions">
                {list.map((session) => (
                  <div
                    key={session.id}
                    className={`session-row ${session.id === sessionID ? "active" : ""}`}
                  >
                    <button
                      className="session-main"
                      title={session.title ?? session.id}
                      onClick={() => void openSessionIn(dir, session.id)}
                    >
                      <span className="session-title">{session.title || "未命名会话"}</span>
                      <span className="session-time">{timeAgo(session.time?.updated)}</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        {filter.trim() && !searching && Object.keys(searchResults).length === 0 && (
          <div className="empty-line">没有匹配的会话</div>
        )}
        {!filter.trim() && visible.map((project) => {
          const dir = project.worktree;
          const isOpen = expanded[dir] ?? false;
          const loaded = loadedDirs[dir] ?? false;
          const rawList = sessions[dir] ?? [];
          const list = showArchived
            ? rawList
            : rawList.filter((item) => !item.time?.archived);
          const keyword = filter.trim().toLowerCase();
          const shown = keyword
            ? list.filter((s) => (s.title ?? "").toLowerCase().includes(keyword))
            : list;
          return (
            <div key={dir} className="project">
              <div className={`project-row ${dir === directory ? "active" : ""}`}>
                <button
                  className={`chevron-btn ${isOpen ? "open" : ""}`}
                  onClick={() => void toggleProject(dir)}
                  title={isOpen ? "折叠" : "展开"}
                >
                  ›
                </button>
                <button className="project-name" onClick={() => void selectProject(dir)} title={dir}>
                  {basename(dir)}
                </button>
                <span className="project-count">{loaded ? list.length || "" : ""}</span>
              </div>
              {isOpen && (
                <div className="sessions">
                  {!loaded && <div className="empty-line">加载中…</div>}
                  {loaded && shown.length === 0 && (
                    <div className="empty-line">{keyword ? "没有匹配的会话" : "还没有会话"}</div>
                  )}
                  {shown.map((session) => {
                    const isEditing = editing?.id === session.id;
                    return (
                      <div
                        key={session.id}
                        className={`session-row ${session.id === sessionID ? "active" : ""}`}
                      >
                        {isEditing ? (
                          <input
                            className="session-rename"
                            autoFocus
                            value={editing.value}
                            onChange={(event) =>
                              setEditing({ id: session.id, value: event.target.value })
                            }
                            onBlur={() => void commitRename()}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void commitRename();
                              if (event.key === "Escape") setEditing(null);
                            }}
                          />
                        ) : (
                          <button
                            className="session-main"
                            onClick={() => void openSession(session.id)}
                            onDoubleClick={() =>
                              setEditing({ id: session.id, value: session.title ?? "" })
                            }
                            title={session.title ?? session.id}
                          >
                            <span className="session-title">{session.title || "未命名会话"}</span>
                            <span className="session-time">{timeAgo(session.time?.updated)}</span>
                          </button>
                        )}
                        {confirming === session.id && (
                          <span className="session-confirm">
                            <span>删除？</span>
                            <button
                              className="mini-btn danger"
                              onClick={() => {
                                setConfirming(null);
                                void deleteSession(session.id);
                              }}
                            >
                              确认
                            </button>
                            <button className="mini-btn" onClick={() => setConfirming(null)}>
                              取消
                            </button>
                          </span>
                        )}
                        {!isEditing && confirming !== session.id && (
                          <span className="session-actions">
                            <button
                              className="mini-btn"
                              title="重命名"
                              onClick={() => setEditing({ id: session.id, value: session.title ?? "" })}
                            >
                              ✎
                            </button>
                            <button
                              className="mini-btn"
                              title={session.time?.archived ? "取消归档" : "归档会话"}
                              onClick={() => void archiveSession(session.id, !session.time?.archived)}
                            >
                              {session.time?.archived ? "↩" : "⇩"}
                            </button>
                            <button
                              className="mini-btn danger"
                              title="删除会话"
                              onClick={() => setConfirming(session.id)}
                            >
                              ✕
                            </button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {visible.length === 0 && <div className="empty-line">没有匹配的项目</div>}
      </div>

      <div className="sidebar-footer">
        <span className="dot" />
        <span className="footer-text">本机 CLI</span>
        <button className="footer-btn" onClick={() => openSettings()} title="设置 (⌘,)">
          ⚙
        </button>
      </div>
    </aside>
  );
}
