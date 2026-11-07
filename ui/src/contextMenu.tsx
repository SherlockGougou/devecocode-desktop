import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { emitAppEvent } from "./appEvents";
import { copyText, readClipboardText } from "./clipboard";
import { useApp } from "./store";
import { Icon, type IconName } from "./components/Icon";

export type ContextMenuItem = {
  type: "item";
  label: string;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void | Promise<void>;
};

export type ContextMenuSeparator = { type: "separator" };
export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

type OpenOptions = {
  /** 默认自动在首项加入「复制所选文字」，文本编辑菜单传 false。 */
  includeSelection?: boolean;
  label?: string;
  restoreFocus?: boolean;
};

type ContextMenuApi = {
  open: (
    event: ReactMouseEvent | MouseEvent,
    items: ContextMenuEntry[],
    options?: OpenOptions,
  ) => void;
  close: () => void;
};

type MenuState = {
  items: ContextMenuEntry[];
  x: number;
  y: number;
  label: string;
  restoreFocus: boolean;
  previousActive: HTMLElement | null;
};

const ContextMenuContext = createContext<ContextMenuApi | null>(null);

function reportError(error: unknown) {
  useApp.setState({ error: String(error) });
}

function selectedText(): string {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (start !== null && end !== null && end > start) {
      return active.value.slice(start, end);
    }
  }
  return window.getSelection()?.toString() ?? "";
}

function compactEntries(items: ContextMenuEntry[]): ContextMenuEntry[] {
  const result: ContextMenuEntry[] = [];
  for (const item of items) {
    if (item.type === "separator" && (result.length === 0 || result.at(-1)?.type === "separator")) {
      continue;
    }
    result.push(item);
  }
  while (result.at(-1)?.type === "separator") result.pop();
  return result;
}

function withSelection(items: ContextMenuEntry[]): ContextMenuEntry[] {
  const text = selectedText();
  if (!text.trim()) return compactEntries(items);
  return compactEntries([
    copyItem("复制所选文字", text, "已复制所选文字"),
    { type: "separator" },
    ...items,
  ]);
}

function eventPosition(
  event: MouseEvent,
  target: HTMLElement | null,
): { x: number; y: number } {
  if (event.clientX || event.clientY) {
    return { x: event.clientX, y: event.clientY };
  }
  const rect = target?.getBoundingClientRect();
  if (!rect) return { x: 12, y: 12 };
  return {
    x: rect.left + Math.min(rect.width / 2, 48),
    y: rect.bottom + 4,
  };
}

type EditableSnapshot = {
  element: HTMLInputElement | HTMLTextAreaElement | HTMLElement;
  start: number | null;
  end: number | null;
  text: string;
};

function editableTarget(target: EventTarget | null): EditableSnapshot["element"] | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(
    "input, textarea, [contenteditable=''], [contenteditable='true']",
  );
  if (!element) return null;
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (["button", "checkbox", "radio", "range", "color", "file"].includes(type)) return null;
  }
  return element;
}

function editableSnapshot(element: EditableSnapshot["element"]): EditableSnapshot {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    return {
      element,
      start,
      end,
      text: start !== null && end !== null ? element.value.slice(start, end) : "",
    };
  }
  return {
    element,
    start: null,
    end: null,
    text: window.getSelection()?.toString() ?? "",
  };
}

function restoreEditable(snapshot: EditableSnapshot): void {
  const { element } = snapshot;
  element.focus({ preventScroll: true });
  if (
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
    snapshot.start !== null &&
    snapshot.end !== null
  ) {
    element.setSelectionRange(snapshot.start, snapshot.end);
  }
}

async function runEditableAction(
  snapshot: EditableSnapshot,
  action: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll",
): Promise<void> {
  if (action === "copy") {
    if (snapshot.text) await copyText(snapshot.text, "已复制所选文字");
    return;
  }
  if (action === "cut") {
    if (!snapshot.text) return;
    const copied = await copyText(snapshot.text, null);
    if (!copied) return;
    restoreEditable(snapshot);
    document.execCommand("insertText", false, "");
    return;
  }
  if (action === "paste") {
    const text = await readClipboardText();
    if (!text) return;
    restoreEditable(snapshot);
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted) reportError("粘贴失败：当前控件没有可编辑区域");
    return;
  }
  restoreEditable(snapshot);
  if (action === "selectAll") {
    if (
      snapshot.element instanceof HTMLInputElement ||
      snapshot.element instanceof HTMLTextAreaElement
    ) {
      snapshot.element.select();
    } else {
      const range = document.createRange();
      range.selectNodeContents(snapshot.element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    return;
  }
  document.execCommand(action);
}

function editableMenu(snapshot: EditableSnapshot): ContextMenuEntry[] {
  const selected = Boolean(snapshot.text);
  return [
    {
      type: "item",
      label: "撤销",
      icon: "undo",
      shortcut: "⌘Z",
      onSelect: () => runEditableAction(snapshot, "undo"),
    },
    {
      type: "item",
      label: "重做",
      icon: "redo",
      shortcut: "⇧⌘Z",
      onSelect: () => runEditableAction(snapshot, "redo"),
    },
    { type: "separator" },
    {
      type: "item",
      label: "剪切",
      icon: "scissors",
      shortcut: "⌘X",
      disabled: !selected,
      onSelect: () => runEditableAction(snapshot, "cut"),
    },
    {
      type: "item",
      label: "复制",
      icon: "copy",
      shortcut: "⌘C",
      disabled: !selected,
      onSelect: () => runEditableAction(snapshot, "copy"),
    },
    {
      type: "item",
      label: "粘贴",
      icon: "clipboard",
      shortcut: "⌘V",
      onSelect: () => runEditableAction(snapshot, "paste"),
    },
    { type: "separator" },
    {
      type: "item",
      label: "全选",
      icon: "select-all",
      shortcut: "⌘A",
      onSelect: () => runEditableAction(snapshot, "selectAll"),
    },
  ];
}

function fallbackMenu(): ContextMenuEntry[] {
  const state = useApp.getState();
  if (state.settingsOpen) {
    return [
      {
        type: "item",
        label: "保存设置",
        icon: "check",
        shortcut: "⌘S",
        onSelect: () => emitAppEvent("settings-save", undefined),
      },
      { type: "separator" },
      {
        type: "item",
        label: "关闭设置",
        icon: "close",
        shortcut: "Esc",
        onSelect: () => state.closeSettings(),
      },
    ];
  }
  if (state.shortcutsOpen) {
    return [
      {
        type: "item",
        label: "关闭快捷键",
        icon: "close",
        shortcut: "Esc",
        onSelect: () => state.closeShortcuts(),
      },
    ];
  }
  return [
    {
      type: "item",
      label: "新建会话",
      icon: "compose",
      shortcut: "⌘N",
      disabled: !state.directory,
      onSelect: () => state.newSession(),
    },
    {
      type: "item",
      label: "切换右侧面板",
      icon: "panel-right",
      shortcut: "⌘⇧B",
      onSelect: () => state.toggleRight(),
    },
    { type: "separator" },
    {
      type: "item",
      label: "打开设置",
      icon: "sliders",
      shortcut: "⌘,",
      onSelect: () => state.openSettings(),
    },
    {
      type: "item",
      label: "快捷键",
      icon: "keyboard",
      shortcut: "⌘/",
      onSelect: () => state.openShortcuts(),
    },
  ];
}

export function copyItem(
  label: string,
  text: string,
  message = "已复制",
  icon: IconName = "copy",
): ContextMenuItem {
  return {
    type: "item",
    label,
    icon,
    onSelect: async () => {
      await copyText(text, message);
    },
  };
}

export function revealItem(label: string, path: string): ContextMenuItem {
  return {
    type: "item",
    label,
    icon: "folder",
    onSelect: async () => {
      try {
        await api.revealPath(path);
      } catch (error) {
        reportError(error);
      }
    },
  };
}

export function openPathItem(label: string, path: string): ContextMenuItem {
  return {
    type: "item",
    label,
    icon: "folder",
    onSelect: async () => {
      try {
        await api.openPath(path);
      } catch (error) {
        reportError(error);
      }
    },
  };
}

export function referenceItem(
  label: string,
  directory: string,
  path: string,
): ContextMenuItem {
  return {
    type: "item",
    label,
    icon: "paperclip",
    onSelect: () => emitAppEvent("reference-file", { directory, path }),
  };
}

export function useContextMenu(): ContextMenuApi {
  const value = useContext(ContextMenuContext);
  if (!value) throw new Error("useContextMenu 必须在 ContextMenuProvider 内使用");
  return value;
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    const previous = menu?.previousActive;
    const restore = menu?.restoreFocus ?? false;
    setMenu(null);
    setPosition(null);
    if (restore && previous?.isConnected) {
      requestAnimationFrame(() => previous.focus({ preventScroll: true }));
    }
  }, [menu]);

  const open = useCallback(
    (
      event: ReactMouseEvent | MouseEvent,
      items: ContextMenuEntry[],
      options?: OpenOptions,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const native = event instanceof MouseEvent ? event : event.nativeEvent;
      const target = native.target instanceof HTMLElement ? native.target : null;
      const nextItems =
        options?.includeSelection === false ? compactEntries(items) : withSelection(items);
      if (nextItems.length === 0) return;
      const { x, y } = eventPosition(native, target);
      setActiveIndex(-1);
      setPosition(null);
      setMenu({
        items: nextItems,
        x,
        y,
        label: options?.label ?? "上下文菜单",
        restoreFocus: options?.restoreFocus ?? true,
        previousActive:
          document.activeElement instanceof HTMLElement ? document.activeElement : null,
      });
    },
    [],
  );

  useEffect(() => {
    const onCapture = (event: MouseEvent) => {
      const element = editableTarget(event.target);
      if (!element) return;
      const snapshot = editableSnapshot(element);
      open(event, editableMenu(snapshot), {
        includeSelection: false,
        label: "编辑菜单",
      });
    };
    document.addEventListener("contextmenu", onCapture, true);
    return () => document.removeEventListener("contextmenu", onCapture, true);
  }, [open]);

  useEffect(() => {
    const onFallback = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      open(event, fallbackMenu(), { label: "应用菜单" });
    };
    window.addEventListener("contextmenu", onFallback);
    return () => window.removeEventListener("contextmenu", onFallback);
  }, [open]);

  useEffect(() => {
    if (!menu) return;
    const first = menu.items.findIndex(
      (entry): entry is ContextMenuItem => entry.type === "item" && !entry.disabled,
    );
    setActiveIndex(first);
    const frame = requestAnimationFrame(() => menuRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    let left = menu.x;
    let top = menu.y;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, menu.x - rect.width);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, menu.y - rect.height - gap);
    }
    setPosition({
      left: Math.min(left, window.innerWidth - rect.width - margin),
      top: Math.min(top, window.innerHeight - rect.height - margin),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const onScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menu, close]);

  const enabledIndexes = menu
    ? menu.items
        .map((entry, index) => (entry.type === "item" && !entry.disabled ? index : -1))
        .filter((index) => index >= 0)
    : [];

  const moveActive = (direction: 1 | -1) => {
    if (enabledIndexes.length === 0) return;
    const current = enabledIndexes.indexOf(activeIndex);
    const next =
      current === -1
        ? direction === 1
          ? 0
          : enabledIndexes.length - 1
        : (current + direction + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[next]);
  };

  const activate = async (item: ContextMenuItem) => {
    if (item.disabled) return;
    close();
    try {
      await item.onSelect();
    } catch (error) {
      reportError(error);
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(enabledIndexes[0] ?? -1);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(enabledIndexes.at(-1) ?? -1);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const item = menu?.items[activeIndex];
    if (item?.type === "item") void activate(item);
  };

  const contextValue = { open, close };
  const portal =
    menu &&
    createPortal(
      <div
        ref={menuRef}
        className="context-menu"
        role="menu"
        aria-label={menu.label}
        aria-activedescendant={
          activeIndex >= 0 ? `context-menu-item-${activeIndex}` : undefined
        }
        tabIndex={-1}
        style={
          position
            ? { left: position.left, top: position.top }
            : { left: menu.x, top: menu.y, visibility: "hidden" }
        }
        onKeyDown={onMenuKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {menu.items.map((entry, index) =>
          entry.type === "separator" ? (
            <div className="context-menu-sep" role="separator" key={`sep-${index}`} />
          ) : (
            <button
              type="button"
              id={`context-menu-item-${index}`}
              role="menuitem"
              className={`context-menu-item ${index === activeIndex ? "active" : ""} ${
                entry.danger ? "danger" : ""
              }`}
              key={`${entry.label}-${index}`}
              disabled={entry.disabled}
              aria-disabled={entry.disabled}
              onMouseEnter={() => !entry.disabled && setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void activate(entry)}
            >
              <span className="context-menu-icon">
                {entry.icon && <Icon name={entry.icon} size={15} />}
              </span>
              <span className="context-menu-label">{entry.label}</span>
              {entry.shortcut && <span className="context-menu-shortcut">{entry.shortcut}</span>}
            </button>
          ),
        )}
      </div>,
      document.body,
    );

  return (
    <ContextMenuContext.Provider value={contextValue}>
      {children}
      {portal}
    </ContextMenuContext.Provider>
  );
}
