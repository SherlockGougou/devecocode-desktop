import { useEffect, useMemo, useRef } from "react";
import { hasCopyableText } from "../filePreview";
import { fileName, normalizeTreePath } from "../fileTree";
import {
  copyItem,
  referenceItem,
  revealItem,
  useContextMenu,
} from "../contextMenu";
import { openDefaultApp } from "../openPath";
import { absoluteWorkspacePath } from "../paths";
import { useApp } from "../store";
import FilePreviewView from "./FilePreview";
import { Icon, type IconName } from "./Icon";
import StatusBadge from "./StatusBadge";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "heic",
  "tif",
  "tiff",
  "bmp",
  "ico",
]);

function iconForFile(name: string): IconName {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(extension) ? "image" : "file";
}

function highlight(text: string, query: string) {
  const keyword = query.trim();
  if (!keyword) return text;
  const lower = text.toLowerCase();
  const target = keyword.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = lower.indexOf(target, cursor);
    if (index === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(<mark key={`${index}:${target}`}>{text.slice(index, index + keyword.length)}</mark>);
    cursor = index + keyword.length;
  }
  return parts;
}

export default function FilesPanel() {
  const directory = useApp((s) => s.directory);
  const preview = useApp((s) => s.preview);
  const openPreview = useApp((s) => s.openPreview);
  const closePreview = useApp((s) => s.closePreview);
  const fileTree = useApp((s) => s.fileTree);
  const expandedDirs = useApp((s) => s.expandedDirs);
  const fileLoading = useApp((s) => s.fileLoading);
  const fileErrors = useApp((s) => s.fileErrors);
  const fileSearchResults = useApp((s) => s.fileSearchResults);
  const fileSearching = useApp((s) => s.fileSearching);
  const fileSearchError = useApp((s) => s.fileSearchError);
  const fileStatuses = useApp((s) => s.fileStatuses);
  const fileQuery = useApp((s) => s.fileQuery);
  const fileFocusPath = useApp((s) => s.fileFocusPath);
  const showIgnored = useApp((s) => s.showIgnored);
  const loadFileDir = useApp((s) => s.loadFileDir);
  const toggleFileDir = useApp((s) => s.toggleFileDir);
  const revealFileDir = useApp((s) => s.revealFileDir);
  const runFileSearch = useApp((s) => s.runFileSearch);
  const refreshFileTree = useApp((s) => s.refreshFileTree);
  const refreshFileStatuses = useApp((s) => s.refreshFileStatuses);
  const setFileQuery = useApp((s) => s.setFileQuery);
  const setShowIgnored = useApp((s) => s.setShowIgnored);
  const setFileFocusPath = useApp((s) => s.setFileFocusPath);
  const menu = useContextMenu();
  const listRef = useRef<HTMLDivElement>(null);

  const searching = Boolean(fileQuery.trim());
  const rootEntries = fileTree[""] ?? [];
  const visibleRoot = rootEntries.filter((entry) => showIgnored || !entry.ignored);
  const rootLoading = Boolean(fileLoading[""]) && !rootEntries.length;
  const rootError = fileErrors[""];

  const changedDirs = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const status of Object.values(fileStatuses)) {
      const path = normalizeTreePath(status.file);
      const parts = path.split("/").filter(Boolean);
      for (let index = 0; index < parts.length; index += 1) {
        const dir = parts.slice(0, index).join("/");
        counts[dir] = (counts[dir] ?? 0) + 1;
      }
    }
    return counts;
  }, [fileStatuses]);

  useEffect(() => {
    if (!directory) return;
    if (!fileTree[""] && !fileLoading[""] && !fileErrors[""]) {
      void loadFileDir("");
    }
    if (Object.keys(fileStatuses).length === 0) {
      void refreshFileStatuses();
    }
    // 只在工作区变化时兜底加载，避免正常切页时重复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory]);

  useEffect(() => {
    const keyword = fileQuery.trim();
    if (!keyword) return;
    const timer = window.setTimeout(() => {
      void runFileSearch(keyword);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [fileQuery, directory, runFileSearch]);

  useEffect(() => {
    if (preview || !fileFocusPath) return;
    const frame = requestAnimationFrame(() => {
      const container = listRef.current;
      if (!container) return;
      const row = Array.from(
        container.querySelectorAll<HTMLElement>("[data-file-row]"),
      ).find((element) => element.dataset.path === fileFocusPath);
      row?.scrollIntoView({ block: "center" });
      row?.focus({ preventScroll: true });
      setFileFocusPath(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [preview, fileFocusPath, fileTree, expandedDirs, setFileFocusPath]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePreview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, closePreview]);

  const openSearchItem = (path: string) => {
    if (path.endsWith("/")) {
      void revealFileDir(path);
      return;
    }
    const normalized = normalizeTreePath(path);
    setFileFocusPath(normalized);
    void openPreview(normalized);
  };

  const dirMenu = (event: React.MouseEvent, path: string) => {
    const key = normalizeTreePath(path);
    const absolute = directory
      ? absoluteWorkspacePath(directory, key)
      : path;
    const open = Boolean(expandedDirs[key]);
    menu.open(
      event,
      [
        {
          type: "item",
          label: open ? "收起目录" : "展开目录",
          icon: open ? "chevron-right" : "chevron-down",
          onSelect: () => toggleFileDir(key),
        },
        {
          type: "item",
          label: "刷新目录",
          icon: "refresh",
          onSelect: () => void loadFileDir(key),
        },
        { type: "separator" },
        revealItem("在 Finder 中显示", absolute),
        copyItem("复制目录路径", key, "目录路径已复制"),
        copyItem("复制绝对路径", absolute, "绝对路径已复制"),
      ],
      { label: "目录菜单" },
    );
  };

  const fileMenu = (event: React.MouseEvent, path: string) => {
    const relative = normalizeTreePath(path);
    const absolute = directory
      ? absoluteWorkspacePath(directory, relative)
      : path;
    menu.open(
      event,
      [
        {
          type: "item",
          label: "打开预览",
          icon: "file",
          onSelect: () => {
            setFileFocusPath(relative);
            void openPreview(relative);
          },
        },
        ...(directory
          ? [referenceItem("引用到输入框", directory, relative)]
          : []),
        { type: "separator" },
        revealItem("在 Finder 中显示", absolute),
        copyItem("复制相对路径", relative, "相对路径已复制"),
        copyItem("复制绝对路径", absolute, "绝对路径已复制"),
        {
          type: "item",
          label: "用默认应用打开",
          icon: "external",
          onSelect: () => void openDefaultApp(absolute),
        },
      ],
      { label: "文件菜单" },
    );
  };

  const keyboardNavigate = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && searching) {
      event.preventDefault();
      setFileQuery("");
      return;
    }
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-file-row]"),
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

  const renderDirectoryChildren = (key: string, depth: number) => {
    if (fileLoading[key] && !fileTree[key]?.length) {
      return (
        <div className="panel-inline-state" style={{ paddingLeft: 18 + depth * 14 }}>
          <span className="panel-spinner small" />
          正在读取目录…
        </div>
      );
    }
    if (fileErrors[key]) {
      return (
        <div className="panel-inline-error" style={{ paddingLeft: 18 + depth * 14 }}>
          <span>{fileErrors[key]}</span>
          <button onClick={() => void loadFileDir(key)}>重试</button>
        </div>
      );
    }
    const entries = fileTree[key];
    if (!entries) return null;
    const visible = entries.filter((entry) => showIgnored || !entry.ignored);
    if (visible.length === 0) {
      return (
        <div className="panel-inline-state" style={{ paddingLeft: 18 + depth * 14 }}>
          {entries.length > 0 ? "只包含已忽略项" : "空目录"}
        </div>
      );
    }
    return renderNodes(visible, depth);
  };

  const renderNodes = (nodes: typeof rootEntries, depth: number): React.ReactNode =>
    nodes.map((node) => {
      if (node.ignored && !showIgnored) return null;
      const path = normalizeTreePath(node.path);
      if (node.type === "directory") {
        const open = Boolean(expandedDirs[path]);
        const changed = changedDirs[path] ?? 0;
        return (
          <div key={`dir:${path}`} className="tree-group">
            <button
              className="tree-row file-tree-row"
              data-file-row
              data-kind="dir"
              data-path={path}
              role="treeitem"
              aria-level={depth + 1}
              style={{ paddingLeft: 8 + depth * 14 }}
              aria-expanded={open}
              title={path}
              onClick={() => toggleFileDir(path)}
              onContextMenu={(event) => dirMenu(event, path)}
            >
              <Icon
                name={open ? "chevron-down" : "chevron-right"}
                size={13}
                className="tree-caret"
              />
              <Icon name="folder" size={15} className="tree-icon" />
              <span className="tree-name">{node.name}</span>
              {node.ignored && <span className="file-tag">ignored</span>}
              {changed > 0 && (
                <span className="tree-count changed" title={`${changed} 个变更文件`}>
                  {changed}
                </span>
              )}
            </button>
            {open && renderDirectoryChildren(path, depth + 1)}
          </div>
        );
      }

      const status = fileStatuses[path];
      const selected = !preview && fileFocusPath === path;
      return (
        <button
          key={`file:${path}`}
          className={`tree-row file-tree-row ${selected ? "selected" : ""}`}
          data-file-row
          data-kind="file"
          data-path={path}
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={selected}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={path}
          onClick={() => {
            setFileFocusPath(path);
            void openPreview(path);
          }}
          onContextMenu={(event) => fileMenu(event, path)}
        >
          <span className="tree-space" />
          <Icon name={iconForFile(node.name)} size={15} className="tree-icon" />
          <span className="tree-name">{node.name}</span>
          {node.ignored && <span className="file-tag">ignored</span>}
          {status && <StatusBadge status={status.status} />}
        </button>
      );
    });

  if (preview) {
    const relative = normalizeTreePath(preview.path);
    const absolute = directory
      ? absoluteWorkspacePath(directory, relative)
      : preview.absolute;
    const status = fileStatuses[relative];
    return (
      <div
        className="right-body preview"
        onContextMenu={(event) =>
          menu.open(
            event,
            [
              ...(hasCopyableText(preview)
                ? [
                    copyItem("复制全部内容", preview.content, "文件内容已复制"),
                    { type: "separator" as const },
                  ]
                : []),
              ...(directory
                ? [
                    referenceItem("引用到输入框", directory, relative),
                    revealItem("在 Finder 中显示", absolute),
                  ]
                : []),
              copyItem("复制相对路径", relative, "相对路径已复制"),
              ...(directory
                ? [copyItem("复制绝对路径", absolute, "绝对路径已复制")]
                : []),
              {
                type: "item",
                label: "用默认应用打开",
                icon: "external",
                onSelect: () => void openDefaultApp(absolute),
              },
              { type: "separator" },
              {
                type: "item",
                label: "返回文件列表",
                icon: "arrow-left",
                onSelect: closePreview,
              },
            ],
            { label: "文件预览菜单" },
          )
        }
      >
        <div className="preview-head">
          <button
            className="mini-btn"
            onClick={closePreview}
            title="返回文件列表"
            aria-label="返回文件列表"
          >
            <Icon name="arrow-left" size={15} />
          </button>
          {status && <StatusBadge status={status.status} />}
          <span className="preview-path" title={relative}>
            {relative}
          </span>
          <button
            className="mini-btn"
            onClick={() => void openPreview(relative)}
            title="重新读取文件"
            aria-label="重新读取文件"
          >
            <Icon name="refresh" size={14} />
          </button>
          <button
            className="mini-btn"
            onClick={() => void openDefaultApp(absolute)}
            title="用默认应用打开"
            aria-label="用默认应用打开"
          >
            <Icon name="external" size={14} />
          </button>
        </div>
        <FilePreviewView preview={preview} />
      </div>
    );
  }

  const rootName = directory?.split("/").filter(Boolean).pop() ?? "工作区";

  return (
    <div className="right-body panel-body">
      <div className="panel-toolbar">
        <div className="panel-toolbar-row">
          <div className="panel-search">
            <Icon name="search" size={13} />
            <input
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              placeholder="搜索文件或目录"
              aria-label="搜索文件或目录"
            />
            {fileQuery && (
              <button
                className="search-clear"
                onClick={() => setFileQuery("")}
                title="清除搜索"
                aria-label="清除搜索"
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
          <button
            className={`mini-btn ${showIgnored ? "active" : ""}`}
            onClick={() => setShowIgnored(!showIgnored)}
            title={showIgnored ? "隐藏忽略项" : "显示忽略项"}
            aria-label={showIgnored ? "隐藏忽略项" : "显示忽略项"}
            aria-pressed={showIgnored}
          >
            <Icon name={showIgnored ? "eye-off" : "eye"} size={14} />
          </button>
          <button
            className="mini-btn"
            onClick={() => void refreshFileTree()}
            title="刷新文件"
            aria-label="刷新文件"
          >
            <Icon name="refresh" size={14} />
          </button>
        </div>
        <div className="panel-summary">
          <span title={directory ?? undefined}>{rootName}</span>
          <span>
            {searching
              ? fileSearching
                ? "搜索中…"
                : `${fileSearchResults.length} 个结果`
              : showIgnored
                ? "含忽略项"
                : "隐藏忽略项"}
          </span>
        </div>
      </div>

      <div
        className="panel-scroll"
        ref={listRef}
        role="tree"
        aria-label="工作区文件"
        onKeyDown={keyboardNavigate}
      >
        {searching ? (
          <>
            {fileSearchError && (
              <div className="panel-error">
                <Icon name="alert" size={14} />
                <span>{fileSearchError}</span>
                <button onClick={() => void runFileSearch(fileQuery)}>重试</button>
              </div>
            )}
            {fileSearching && fileSearchResults.length === 0 && (
              <div className="panel-state">
                <span className="panel-spinner" />
                正在搜索工作区文件…
              </div>
            )}
            {!fileSearching && !fileSearchError && fileSearchResults.length === 0 && (
              <div className="panel-state">没有匹配的文件或目录</div>
            )}
            {fileSearchResults.map((path) => {
              const isDirectory = path.endsWith("/");
              const normalized = normalizeTreePath(path);
              const name = fileName(normalized);
              const parent = normalized.slice(0, Math.max(0, normalized.lastIndexOf("/")));
              const status = fileStatuses[normalized];
              return (
                <button
                  key={`search:${path}`}
                  className="tree-row file-search-row"
                  data-file-row
                  data-kind={isDirectory ? "dir" : "file"}
                  data-path={normalized}
                  role="treeitem"
                  aria-level={1}
                  title={path}
                  onClick={() => openSearchItem(path)}
                  onContextMenu={(event) =>
                    isDirectory ? dirMenu(event, normalized) : fileMenu(event, normalized)
                  }
                >
                  <Icon
                    name={isDirectory ? "folder" : iconForFile(name)}
                    size={15}
                    className="tree-icon"
                  />
                  <span className="tree-name">{highlight(name, fileQuery)}</span>
                  <span className="tree-path">{highlight(parent, fileQuery)}</span>
                  {status && <StatusBadge status={status.status} />}
                </button>
              );
            })}
            {fileSearchResults.length >= 200 && (
              <div className="panel-inline-state">结果较多，仅显示前 200 条</div>
            )}
          </>
        ) : rootError ? (
          <div className="panel-error">
            <Icon name="alert" size={14} />
            <span>{rootError}</span>
            <button onClick={() => void loadFileDir("")}>重试</button>
          </div>
        ) : rootLoading ? (
          <div className="panel-state">
            <span className="panel-spinner" />
            正在读取工作区文件…
          </div>
        ) : rootEntries.length === 0 ? (
          <div className="panel-state">工作区没有可显示的文件</div>
        ) : visibleRoot.length === 0 ? (
          <div className="panel-state">工作区只包含已忽略项</div>
        ) : (
          renderNodes(visibleRoot, 0)
        )}
      </div>
    </div>
  );
}
