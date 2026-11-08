import { useEffect } from "react";
import { useApp } from "../store";
import { Icon } from "./Icon";

const GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: "会话",
    items: [
      ["⌘N", "新建会话"],
      ["Enter", "发送消息"],
      ["⇧Enter", "换行"],
      ["@", "引用工作区文件"],
    ],
  },
  {
    title: "视图",
    items: [
      ["⌘J", "展开或收起终端"],
      ["⌘⇧B", "切换右侧面板"],
      ["⌘R", "重新加载界面"],
      ["⌘/", "显示本帮助"],
    ],
  },
  {
    title: "设置与窗口",
    items: [
      ["⌘,", "打开设置"],
      ["⌘S", "保存设置（设置页内）"],
      ["Esc", "关闭弹层"],
      ["⌘W", "关闭窗口（收进托盘）"],
    ],
  },
];

export default function Shortcuts() {
  const close = useApp((s) => s.closeShortcuts);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div className="settings-overlay" onClick={close}>
      <div className="shortcuts-panel" onClick={(event) => event.stopPropagation()}>
        <header className="settings-head">
          <span>快捷键</span>
          <button className="settings-close" onClick={close} title="关闭 (Esc)" aria-label="关闭">
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="shortcuts-body">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              {group.items.map(([keys, label]) => (
                <div className="shortcut-row" key={keys}>
                  <span className="shortcut-label">{label}</span>
                  <span className="shortcut-keys">
                    {keys.split(" ").map((part) => (
                      <kbd key={part}>{part}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
