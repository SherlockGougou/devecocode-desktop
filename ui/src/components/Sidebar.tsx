import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store";
import type { Session } from "../types";
import { copyItem, openPathItem, useContextMenu } from "../contextMenu";
import { Icon } from "./Icon";

/** 每个工作区默认先显示最近几个会话，其余折叠成一行「展开其余 N 个会话」 */
const SESSION_PREVIEW = 5;

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
        {active && <span className={`chat-ring ${streaming ? "run" : ""}`} />}
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
  const newSession = useApp((s) => s.newSession);
  const newSessionIn = useApp((s) => s.newSessionIn);
  const setFilter = useApp((s) => s.setFilter);
  const openSettings = useApp((s) => s.openSettings);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
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

  useEffect(() => {
    if (!filter.trim()) return;
    const timer = setTimeout(() => void runSearch(filter), 300);
    return () => clearTimeout(timer);
  }, [filter, runSearch]);

  const toggleSearch = () => {
    if (searchOpen) {
      setSearchOpen(false);
      setFilter("");
      return;
    }
    setSearchOpen(true);
  };

  // 单击工作区＝切换过去；再次单击当前工作区＝收起它的会话列表（与参考截图一致，同时只展开一个）
  const onWorkspace = (dir: string) => {
    if (dir === directory && (expanded[dir] ?? false)) void toggleProject(dir);
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
      ],
      { label: "工作区菜单" },
    );
  };

  const renderWorkspace = (dir: string, isCurrent: boolean) => {
    const isOpen = expanded[dir] ?? false;
    const loaded = loadedDirs[dir] ?? false;
    const rawList = sessions[dir] ?? [];
    const list = showArchived ? rawList : rawList.filter((item) => !item.time?.archived);
    const all = showAll[dir] ?? false;
    const shown = all ? list : list.slice(0, SESSION_PREVIEW);
    const hidden = list.length - shown.length;
    return (
      <div className="ws" key={dir}>
        <button
          className={`ws-row ${isCurrent ? "active" : ""}`}
          onClick={() => onWorkspace(dir)}
          onContextMenu={(event) => workspaceMenu(event, dir, true)}
          title={dir}
          aria-expanded={isOpen}
        >
          <span className="ws-icon">
            <Icon name="workspace" size={19} strokeWidth={1.9} />
          </span>
          <span className="ws-name">{basename(dir)}</span>
        </button>
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
                onClick={() => setShowAll({ ...showAll, [dir]: true })}
              >
                展开其余 {hidden} 个会话
              </button>
            )}
            {all && list.length > SESSION_PREVIEW && (
              <button
                className="chat-more"
                onClick={() => setShowAll({ ...showAll, [dir]: false })}
              >
                收起
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

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
              icon: "sliders",
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
            className={`ws-action ${showArchived ? "on" : ""}`}
            onClick={toggleArchivedView}
            title={showArchived ? "隐藏已归档会话" : "显示已归档会话"}
            aria-label={showArchived ? "隐藏已归档会话" : "显示已归档会话"}
            aria-pressed={showArchived}
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
          ? Object.entries(searchResults).map(([dir, list]) => (
              <div className="ws" key={`search-${dir}`}>
                <div
                  className={`ws-row static ${dir === directory ? "active" : ""}`}
                  title={dir}
                  onContextMenu={(event) => workspaceMenu(event, dir, false)}
                >
                  <span className="ws-icon">
                    <Icon name="workspace" size={19} strokeWidth={1.9} />
                  </span>
                  <span className="ws-name">{basename(dir)}</span>
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
        {keyword && !searching && Object.keys(searchResults).length === 0 && (
          <div className="empty-line">没有匹配的会话</div>
        )}
        {!keyword && visible.length === 0 && <div className="empty-line">没有匹配的项目</div>}
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
