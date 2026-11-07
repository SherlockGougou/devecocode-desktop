import { useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useApp, type RightTab } from "../store";
import { hasCopyableText } from "../filePreview";
import {
  copyItem,
  referenceItem,
  revealItem,
  useContextMenu,
} from "../contextMenu";
import {
  absoluteWorkspacePath,
  relativeWorkspacePath,
} from "../paths";
import FilePreviewView from "./FilePreview";
import DevicePanel from "./DevicePanel";
import { Icon } from "./Icon";
import TasksPanel from "./TasksPanel";

const RIGHT_TAB_LABELS: Record<RightTab, string> = {
  changes: "变更",
  files: "文件",
  tasks: "任务",
  device: "设备",
};
const TAB_LONG_PRESS_MS = 320;
const TAB_DRAG_THRESHOLD = 5;

async function openDefaultApp(path: string) {
  try {
    await api.openPath(path);
  } catch (error) {
    useApp.setState({ error: String(error) });
  }
}

export default function RightPanel() {
  const open = useApp((s) => s.rightOpen);
  const tab = useApp((s) => s.rightTab);
  const setTab = useApp((s) => s.setRightTab);
  const tabOrder = useApp((s) => s.rightTabOrder);
  const moveTab = useApp((s) => s.moveRightTab);
  const diff = useApp((s) => s.diff);
  const files = useApp((s) => s.files);
  const preview = useApp((s) => s.preview);
  const openPreview = useApp((s) => s.openPreview);
  const closePreview = useApp((s) => s.closePreview);
  const filePath = useApp((s) => s.filePath);
  const fileQuery = useApp((s) => s.fileQuery);
  const enterDir = useApp((s) => s.enterDir);
  const goUpDir = useApp((s) => s.goUpDir);
  const setFileQuery = useApp((s) => s.setFileQuery);
  const directory = useApp((s) => s.directory);
  const newSession = useApp((s) => s.newSession);
  const toggleRight = useApp((s) => s.toggleRight);
  const openSettings = useApp((s) => s.openSettings);
  const menu = useContextMenu();
  const [draggingTab, setDraggingTab] = useState<RightTab | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    tab: RightTab;
    after: boolean;
  } | null>(null);
  const tabDragRef = useRef<{
    source: RightTab;
    startX: number;
    startY: number;
    active: boolean;
    moved: boolean;
    cancelled: boolean;
    timer: number;
  } | null>(null);
  const tabDropTargetRef = useRef<{ tab: RightTab; after: boolean } | null>(null);

  const shown = useMemo(() => files, [files]);

  const beginTabPress = (event: React.MouseEvent<HTMLButtonElement>, source: RightTab) => {
    if (event.button !== 0) return;
    const gesture = {
      source,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      moved: false,
      cancelled: false,
      timer: 0,
    };
    tabDragRef.current = gesture;
    gesture.timer = window.setTimeout(() => {
      if (tabDragRef.current !== gesture || gesture.cancelled) return;
      gesture.active = true;
      setDraggingTab(source);
      document.body.style.cursor = "grabbing";
    }, TAB_LONG_PRESS_MS);

    const stopListening = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("blur", onBlur, true);
    };

    const finish = (commit: boolean) => {
      stopListening();
      document.body.style.cursor = "";
      const current = tabDragRef.current;
      tabDragRef.current = null;
      if (current?.timer) window.clearTimeout(current.timer);
      const target = commit ? tabDropTargetRef.current : null;
      tabDropTargetRef.current = null;
      setDraggingTab(null);
      setDropTarget(null);
      if (!current?.active) return;
      // 长按后没有移动仍按普通点击处理，只有真正拖动过才排序并吞掉 click。
      if (!current.moved) return;

      if (commit) {
        // 长按后的 mouseup 仍会触发 click；吞掉它，避免排序后误切标签。
        const swallowClick = (clickEvent: MouseEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
        };
        window.addEventListener("click", swallowClick, true);
        window.setTimeout(
          () => window.removeEventListener("click", swallowClick, true),
          0,
        );
        if (target) moveTab(current.source, target.tab, target.after);
      }
    };

    const onMove = (moveEvent: MouseEvent) => {
      const current = tabDragRef.current;
      if (!current) return;
      const distance = Math.hypot(
        moveEvent.clientX - current.startX,
        moveEvent.clientY - current.startY,
      );
      if (!current.active) {
        if (distance < TAB_DRAG_THRESHOLD) return;
        current.cancelled = true;
        window.clearTimeout(current.timer);
        current.timer = 0;
        return;
      }

      if (distance < TAB_DRAG_THRESHOLD) return;
      moveEvent.preventDefault();
      current.moved = true;
      const row = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>(".right-tab[data-right-tab]");
      const nextTab = row?.dataset.rightTab as RightTab | undefined;
      if (!row || !nextTab || nextTab === current.source) {
        tabDropTargetRef.current = null;
        setDropTarget(null);
        return;
      }
      const rect = row.getBoundingClientRect();
      const next = {
        tab: nextTab,
        after: moveEvent.clientX > rect.left + rect.width / 2,
      };
      tabDropTargetRef.current = next;
      setDropTarget(next);
    };

    const onUp = () => finish(true);
    const onBlur = () => finish(false);

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
    window.addEventListener("blur", onBlur, true);
  };

  if (!open) return null;

  return (
    <aside
      className="right"
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
              label: "切换右侧面板",
              icon: "panel-right",
              shortcut: "⌘⇧B",
              onSelect: toggleRight,
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
          { label: "右侧面板菜单" },
        )
      }
    >
      <div className="right-tabs">
        {tabOrder.map((id) => {
          const dragClass =
            draggingTab === id
              ? "dragging"
              : dropTarget?.tab === id
                ? dropTarget.after
                  ? "drop-after"
                  : "drop-before"
                : "";
          return (
            <button
              key={id}
              className={`right-tab ${tab === id ? "active" : ""} ${dragClass}`}
              data-right-tab={id}
              draggable={false}
              title="长按拖动排序"
              onMouseDown={(event) => beginTabPress(event, id)}
              onClick={() => setTab(id)}
            >
              {RIGHT_TAB_LABELS[id]}
              {id === "changes" && diff.length > 0 && (
                <span className="count">{diff.length}</span>
              )}
            </button>
          );
        })}
      </div>

      {tab === "changes" && (
        <div className="right-body">
          {diff.length === 0 && (
            <div className="empty-line">没有检测到文件变更（非 git 仓库或暂无改动）</div>
          )}
          {diff.map((entry) => {
            const relative = directory
              ? relativeWorkspacePath(directory, entry.file)
              : entry.file;
            const absolute = directory
              ? absoluteWorkspacePath(directory, relative)
              : entry.file;
            return (
              <details
                key={entry.file}
                className="diff-entry"
                onContextMenu={(event) => {
                  const details = event.currentTarget;
                  menu.open(
                    event,
                    [
                      {
                        type: "item",
                        label: details.open ? "收起变更" : "展开变更",
                        icon: details.open ? "chevron-down" : "chevron-right",
                        onSelect: () => {
                          details.open = !details.open;
                        },
                      },
                      { type: "separator" },
                      copyItem("复制文件路径", relative, "文件路径已复制"),
                      ...(directory
                        ? [
                            copyItem("复制绝对路径", absolute, "绝对路径已复制"),
                            revealItem("在 Finder 中显示", absolute),
                            referenceItem("引用到输入框", directory, relative),
                          ]
                        : []),
                      ...(entry.patch
                        ? [
                            { type: "separator" as const },
                            copyItem("复制补丁", entry.patch, "补丁已复制"),
                          ]
                        : []),
                    ],
                    { label: "变更文件菜单" },
                  );
                }}
              >
                <summary>
                  <Icon name="chevron-right" size={14} className="caret" />
                  <span className="diff-file">{entry.file}</span>
                  <span className="diff-stat">
                    {entry.additions ? <em className="add">+{entry.additions}</em> : null}
                    {entry.deletions ? <em className="del">-{entry.deletions}</em> : null}
                  </span>
                </summary>
                {entry.patch && <pre className="patch">{entry.patch}</pre>}
              </details>
            );
          })}
        </div>
      )}

      {tab === "files" && preview && (
        <div
          className="right-body preview"
          onContextMenu={(event) => {
            const relative = directory
              ? relativeWorkspacePath(directory, preview.path)
              : preview.path;
            const absolute = directory
              ? absoluteWorkspacePath(directory, relative)
              : preview.path;
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
                  type: "item" as const,
                  label: "用默认应用打开",
                  icon: "external" as const,
                  onSelect: () => openDefaultApp(preview.absolute),
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
            );
          }}
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
            <span className="preview-path" title={preview.path}>
              {preview.path}
            </span>
            <button
              className="mini-btn"
              onClick={() => void openDefaultApp(preview.absolute)}
              title="用默认应用打开"
              aria-label="用默认应用打开"
            >
              <Icon name="external" size={14} />
            </button>
          </div>
          <FilePreviewView preview={preview} />
        </div>
      )}

      {tab === "files" && !preview && (
        <div className="right-body">
          <input
            className="right-search"
            value={fileQuery}
            onChange={(event) => void setFileQuery(event.target.value)}
            placeholder="搜索文件（留空浏览目录）"
          />
          {!fileQuery.trim() && (
            <div className="file-crumbs">
              <button
                className="mini-btn"
                onClick={() => void goUpDir()}
                disabled={!filePath}
                title="上一级"
                aria-label="上一级目录"
              >
                <Icon name="folder-up" size={15} />
              </button>
              <span className="crumb-path" title={filePath || "根目录"}>
                {filePath || "根目录"}
              </span>
            </div>
          )}
          <div className="file-list">
            {shown.map((file) => {
              const relative = directory
                ? relativeWorkspacePath(directory, file.path)
                : file.path;
              const absolute =
                file.absolute ??
                (directory ? absoluteWorkspacePath(directory, relative) : file.path);
              const isDirectory = file.type === "directory";
              const open = () =>
                isDirectory ? enterDir(file.path) : openPreview(file.path);
              return (
                <button
                  key={file.path}
                  className="file-row"
                  title={file.path}
                  onClick={() => void open()}
                  onContextMenu={(event) =>
                    menu.open(
                      event,
                      [
                        {
                          type: "item",
                          label: isDirectory ? "打开目录" : "打开预览",
                          icon: isDirectory ? "folder" : "file",
                          onSelect: open,
                        },
                        ...(!isDirectory && directory
                          ? [referenceItem("引用到输入框", directory, relative)]
                          : []),
                        { type: "separator" },
                        revealItem("在 Finder 中显示", absolute),
                        copyItem("复制相对路径", relative, "相对路径已复制"),
                        copyItem("复制绝对路径", absolute, "绝对路径已复制"),
                      ],
                      { label: isDirectory ? "目录菜单" : "文件菜单" },
                    )
                  }
                >
                  <span className="file-kind">
                    <Icon
                      name={isDirectory ? "folder" : "file"}
                      size={15}
                      className="file-icon"
                    />
                  </span>
                  <span className="file-name">{file.name}</span>
                  {file.ignored && <span className="file-tag">ignored</span>}
                </button>
              );
            })}
            {shown.length === 0 && <div className="empty-line">没有文件</div>}
          </div>
        </div>
      )}

      {tab === "device" && (
        <div className="right-body device-body">
          <DevicePanel />
        </div>
      )}

      {tab === "tasks" && (
        <div className="right-body tasks-body">
          <TasksPanel />
        </div>
      )}
    </aside>
  );
}
