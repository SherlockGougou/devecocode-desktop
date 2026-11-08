import { useEffect, useMemo } from "react";
import {
  buildChangeTree,
  collectChangeDirs,
  filterChangeEntries,
  type ChangeDirNode,
  type ChangeEntry,
  type ChangeTreeNode,
} from "../changes";
import {
  copyItem,
  referenceItem,
  revealItem,
  useContextMenu,
} from "../contextMenu";
import { changeStatus } from "../diff";
import { openDefaultApp } from "../openPath";
import { absoluteWorkspacePath, relativeWorkspacePath } from "../paths";
import { resolvedChangeSource, useApp } from "../store";
import DiffView from "./DiffView";
import { Icon } from "./Icon";
import StatusBadge from "./StatusBadge";

function totals(entries: ChangeEntry[]) {
  let additions = 0;
  let deletions = 0;
  for (const item of entries) {
    additions += item.entry.additions ?? 0;
    deletions += item.entry.deletions ?? 0;
  }
  return { additions, deletions };
}

function flatPath(path: string) {
  return path.split("/").filter(Boolean).join(" / ");
}

export default function ChangesPanel() {
  const directory = useApp((s) => s.directory);
  const sessionID = useApp((s) => s.sessionID);
  const changeSource = useApp((s) => s.changeSource);
  const workspaceDiff = useApp((s) => s.workspaceDiff);
  const sessionDiff = useApp((s) => s.sessionDiff);
  const changesLoading = useApp((s) => s.changesLoading);
  const changesError = useApp((s) => s.changesError);
  const changesRepo = useApp((s) => s.changesRepo);
  const changeQuery = useApp((s) => s.changeQuery);
  const collapsedChangeDirs = useApp((s) => s.collapsedChangeDirs);
  const diffPath = useApp((s) => s.diffPath);
  const setChangeSource = useApp((s) => s.setChangeSource);
  const refreshChanges = useApp((s) => s.refreshChanges);
  const setChangeQuery = useApp((s) => s.setChangeQuery);
  const toggleChangeDir = useApp((s) => s.toggleChangeDir);
  const setCollapsedChangeDirs = useApp((s) => s.setCollapsedChangeDirs);
  const openDiff = useApp((s) => s.openDiff);
  const closeDiff = useApp((s) => s.closeDiff);
  const openFile = useApp((s) => s.openFile);
  const menu = useContextMenu();

  const source = resolvedChangeSource(changeSource, sessionID);
  const active = source === "workspace" ? workspaceDiff : sessionDiff;
  const entries = useMemo<ChangeEntry[]>(
    () =>
      active.flatMap((entry) => {
        const path = directory
          ? relativeWorkspacePath(directory, entry.file)
          : entry.file.replace(/^\/+/, "");
        return path ? [{ entry, path }] : [];
      }),
    [active, directory],
  );
  const tree = useMemo(() => buildChangeTree(entries), [entries]);
  const dirPaths = useMemo(() => collectChangeDirs(tree), [tree]);
  const collapsed = useMemo(() => new Set(collapsedChangeDirs), [collapsedChangeDirs]);
  const filtered = useMemo(
    () => filterChangeEntries(entries, changeQuery),
    [entries, changeQuery],
  );
  const summary = useMemo(() => totals(entries), [entries]);
  const allCollapsed =
    dirPaths.length > 0 && dirPaths.every((path) => collapsed.has(path));
  const searching = Boolean(changeQuery.trim());

  useEffect(() => {
    if (!diffPath) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeDiff();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [diffPath, closeDiff]);

  const selected = diffPath
    ? entries.find((item) => item.path === diffPath || item.entry.file === diffPath)
    : undefined;

  if (diffPath) {
    if (!selected) {
      return (
        <div className="right-body change-detail">
          <div className="preview-head">
            <button
              className="mini-btn"
              onClick={closeDiff}
              title="返回变更列表"
              aria-label="返回变更列表"
            >
              <Icon name="arrow-left" size={15} />
            </button>
            <span className="preview-path" title={diffPath}>
              {diffPath}
            </span>
          </div>
          <div className="panel-state">
            {changesLoading ? (
              <>
                <span className="panel-spinner" />
                正在刷新变更…
              </>
            ) : (
              "这个文件已不在当前变更列表中"
            )}
          </div>
        </div>
      );
    }

    const absolute = directory
      ? absoluteWorkspacePath(directory, selected.path)
      : selected.entry.file;
    return (
      <DiffView
        entry={selected.entry}
        relativePath={selected.path}
        absolutePath={absolute}
        onBack={closeDiff}
        onRefresh={() => void refreshChanges()}
        onPreview={
          changeStatus(selected.entry) === "deleted"
            ? null
            : () => void openFile(selected.path)
        }
      />
    );
  }

  const fileMenu = (event: React.MouseEvent, item: ChangeEntry) => {
    const status = changeStatus(item.entry);
    const absolute = directory
      ? absoluteWorkspacePath(directory, item.path)
      : item.entry.file;
    menu.open(
      event,
      [
        {
          type: "item",
          label: "查看 Diff",
          icon: "list",
          onSelect: () => openDiff(item.path),
        },
        ...(status !== "deleted"
          ? [
              {
                type: "item" as const,
                label: "预览文件",
                icon: "file" as const,
                onSelect: () => void openFile(item.path),
              },
              {
                type: "item" as const,
                label: "用默认应用打开",
                icon: "external" as const,
                onSelect: () => void openDefaultApp(absolute),
              },
            ]
          : []),
        ...(directory
          ? [referenceItem("引用到输入框", directory, item.path)]
          : []),
        { type: "separator" },
        revealItem("在 Finder 中显示", absolute),
        copyItem("复制相对路径", item.path, "相对路径已复制"),
        copyItem("复制绝对路径", absolute, "绝对路径已复制"),
        ...(item.entry.patch
          ? [
              { type: "separator" as const },
              copyItem("复制补丁", item.entry.patch, "补丁已复制"),
            ]
          : []),
      ],
      { label: "变更文件菜单" },
    );
  };

  const dirMenu = (event: React.MouseEvent, node: ChangeDirNode) => {
    const absolute = directory
      ? absoluteWorkspacePath(directory, node.path)
      : node.path;
    const isCollapsed = collapsed.has(node.path);
    menu.open(
      event,
      [
        {
          type: "item",
          label: isCollapsed ? "展开目录" : "收起目录",
          icon: isCollapsed ? "chevron-down" : "chevron-right",
          onSelect: () => toggleChangeDir(node.path),
        },
        { type: "separator" },
        revealItem("在 Finder 中显示", absolute),
        copyItem("复制目录路径", node.path, "目录路径已复制"),
        copyItem("复制绝对路径", absolute, "绝对路径已复制"),
      ],
      { label: "变更目录菜单" },
    );
  };

  const renderFileRow = (node: Extract<ChangeTreeNode, { type: "file" }>, depth: number) => {
    const status = changeStatus(node.entry);
    const item = entries.find((entry) => entry.path === node.path);
    return (
      <button
        key={`file:${node.path}`}
        className="tree-row change-file-row"
        data-change-row
        data-kind="file"
        data-path={node.path}
        role="treeitem"
        aria-level={depth + 1}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={node.path}
        onClick={() => openDiff(node.path)}
        onContextMenu={(event) => item && fileMenu(event, item)}
      >
        <span className="tree-space" />
        <StatusBadge status={status} />
        <span className="tree-name">{node.name}</span>
        <span className="diff-stat">
          {node.additions > 0 && <em className="add">+{node.additions}</em>}
          {node.deletions > 0 && <em className="del">−{node.deletions}</em>}
        </span>
      </button>
    );
  };

  const renderNodes = (nodes: ChangeTreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      if (node.type === "file") return renderFileRow(node, depth);
      const isCollapsed = collapsed.has(node.path);
      return (
        <div key={`dir:${node.path}`} className="tree-group">
          <button
            className="tree-row change-dir-row"
            data-change-row
            data-kind="dir"
            data-path={node.path}
            role="treeitem"
            aria-level={depth + 1}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={node.path}
            aria-expanded={!isCollapsed}
            onClick={() => toggleChangeDir(node.path)}
            onContextMenu={(event) => dirMenu(event, node)}
          >
            <Icon
              name={isCollapsed ? "chevron-right" : "chevron-down"}
              size={13}
              className="tree-caret"
            />
            <Icon name="folder" size={15} className="tree-icon" />
            <span className="tree-name">{node.name}</span>
            <span className="tree-count">{node.fileCount}</span>
            <span className="diff-stat">
              {node.additions > 0 && <em className="add">+{node.additions}</em>}
              {node.deletions > 0 && <em className="del">−{node.deletions}</em>}
            </span>
          </button>
          {!isCollapsed && renderNodes(node.children, depth + 1)}
        </div>
      );
    });

  const toggleAll = () => {
    setCollapsedChangeDirs(allCollapsed ? [] : dirPaths);
  };

  const keyboardNavigate = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-change-row]"),
    );
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = current === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, current + delta));
      rows[next]?.focus();
      return;
    }
    if (!rows[current]) return;
    const row = rows[current];
    if (event.key === "ArrowRight" && row.dataset.kind === "dir" && row.getAttribute("aria-expanded") === "false") {
      event.preventDefault();
      row.click();
    } else if (event.key === "ArrowLeft" && row.dataset.kind === "dir" && row.getAttribute("aria-expanded") === "true") {
      event.preventDefault();
      row.click();
    }
  };

  const emptyMessage = searching
    ? "没有匹配的变更文件"
    : source === "session"
      ? "本次会话没有产生文件变更"
      : changesRepo === false
        ? "当前目录不是 Git 仓库"
        : "工作区没有未提交的变更";

  return (
    <div className="right-body panel-body">
      <div className="panel-toolbar">
        <div className="panel-toolbar-row">
          <div className="panel-segment" role="group" aria-label="变更来源">
            <button
              className={source === "workspace" ? "active" : ""}
              onClick={() => setChangeSource("workspace")}
            >
              工作区
            </button>
            <button
              className={source === "session" ? "active" : ""}
              disabled={!sessionID}
              title={sessionID ? "查看本次会话产生的变更" : "打开会话后可查看"}
              onClick={() => setChangeSource("session")}
            >
              本次会话
            </button>
          </div>
          <button
            className="mini-btn"
            onClick={() => void refreshChanges()}
            disabled={changesLoading}
            title="刷新变更"
            aria-label="刷新变更"
          >
            {changesLoading ? <span className="panel-spinner small" /> : <Icon name="refresh" size={14} />}
          </button>
        </div>
        <div className="panel-toolbar-row">
          <div className="panel-search">
            <Icon name="search" size={13} />
            <input
              value={changeQuery}
              onChange={(event) => setChangeQuery(event.target.value)}
              placeholder="筛选变更文件"
              aria-label="筛选变更文件"
            />
            {changeQuery && (
              <button
                className="search-clear"
                onClick={() => setChangeQuery("")}
                title="清除筛选"
                aria-label="清除筛选"
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
          <button
            className="mini-btn"
            onClick={toggleAll}
            disabled={dirPaths.length === 0}
            title={allCollapsed ? "展开全部目录" : "收起全部目录"}
            aria-label={allCollapsed ? "展开全部目录" : "收起全部目录"}
          >
            <Icon name={allCollapsed ? "chevron-down" : "chevron-right"} size={14} />
          </button>
        </div>
        <div className="panel-summary">
          <span>{entries.length} 个文件</span>
          {summary.additions > 0 && <em className="add">+{summary.additions}</em>}
          {summary.deletions > 0 && <em className="del">−{summary.deletions}</em>}
        </div>
      </div>

      {changesError && (
        <div className="panel-error">
          <Icon name="alert" size={14} />
          <span>{changesError}</span>
          <button onClick={() => void refreshChanges()}>重试</button>
        </div>
      )}

      <div
        className="panel-scroll"
        role="tree"
        aria-label="变更文件"
        onKeyDown={keyboardNavigate}
      >
        {changesLoading && entries.length === 0 && (
          <div className="panel-state">
            <span className="panel-spinner" />
            正在读取变更…
          </div>
        )}
        {!changesLoading && entries.length === 0 && !changesError && (
          <div className="panel-state">{emptyMessage}</div>
        )}
        {searching && filtered.length === 0 && entries.length > 0 && (
          <div className="panel-state">没有匹配的变更文件</div>
        )}
        {searching &&
          filtered.map((item) => {
            const status = changeStatus(item.entry);
            return (
              <button
                key={`search:${item.path}`}
                className="tree-row change-search-row"
                data-change-row
                data-kind="file"
                data-path={item.path}
                role="treeitem"
                aria-level={1}
                title={item.path}
                onClick={() => openDiff(item.path)}
                onContextMenu={(event) => fileMenu(event, item)}
              >
                <StatusBadge status={status} />
                <span className="tree-name">{item.path.split("/").pop()}</span>
                <span className="tree-path">{flatPath(item.path.slice(0, Math.max(0, item.path.lastIndexOf("/"))))}</span>
                <span className="diff-stat">
                  {(item.entry.additions ?? 0) > 0 && (
                    <em className="add">+{item.entry.additions}</em>
                  )}
                  {(item.entry.deletions ?? 0) > 0 && (
                    <em className="del">−{item.entry.deletions}</em>
                  )}
                </span>
              </button>
            );
          })}
        {!searching && entries.length > 0 && renderNodes(tree.children, 0)}
      </div>
    </div>
  );
}
