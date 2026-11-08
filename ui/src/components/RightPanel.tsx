import { useRef, useState } from "react";
import { useContextMenu } from "../contextMenu";
import { resolvedChangeSource, useApp, type RightTab } from "../store";
import ChangesPanel from "./ChangesPanel";
import DevicePanel from "./DevicePanel";
import FilesPanel from "./FilesPanel";
import TasksPanel from "./TasksPanel";

const RIGHT_TAB_LABELS: Record<RightTab, string> = {
  changes: "变更",
  files: "文件",
  tasks: "任务",
  device: "设备",
};
const TAB_LONG_PRESS_MS = 320;
const TAB_DRAG_THRESHOLD = 5;

export default function RightPanel() {
  const open = useApp((s) => s.rightOpen);
  const tab = useApp((s) => s.rightTab);
  const setTab = useApp((s) => s.setRightTab);
  const tabOrder = useApp((s) => s.rightTabOrder);
  const moveTab = useApp((s) => s.moveRightTab);
  const workspaceDiff = useApp((s) => s.workspaceDiff);
  const sessionDiff = useApp((s) => s.sessionDiff);
  const changeSource = useApp((s) => s.changeSource);
  const sessionID = useApp((s) => s.sessionID);
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
  const activeSource = resolvedChangeSource(changeSource, sessionID);
  const changeCount =
    activeSource === "workspace" ? workspaceDiff.length : sessionDiff.length;

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
              {id === "changes" && changeCount > 0 && (
                <span className="count">{changeCount}</span>
              )}
            </button>
          );
        })}
      </div>

      {tab === "changes" && <ChangesPanel />}
      {tab === "files" && <FilesPanel />}

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
