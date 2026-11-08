import { useMemo } from "react";
import {
  copyItem,
  referenceItem,
  revealItem,
  useContextMenu,
} from "../contextMenu";
import {
  changeStatus,
  parsePatch,
  statusLabel,
  MAX_DIFF_LINES,
} from "../diff";
import { openDefaultApp } from "../openPath";
import { useApp } from "../store";
import type { FileDiff } from "../types";
import { Icon } from "./Icon";
import StatusBadge from "./StatusBadge";

export default function DiffView({
  entry,
  relativePath,
  absolutePath,
  onBack,
  onRefresh,
  onPreview,
}: {
  entry: FileDiff;
  relativePath: string;
  absolutePath: string;
  onBack: () => void;
  onRefresh: () => void;
  onPreview: (() => void) | null;
}) {
  const directory = useApp((s) => s.directory);
  const menu = useContextMenu();
  const status = changeStatus(entry);
  const parsed = useMemo(() => parsePatch(entry.patch), [entry.patch]);
  const deleted = status === "deleted";

  return (
    <div
      className="right-body change-detail"
      onContextMenu={(event) =>
        menu.open(
          event,
          [
            {
              type: "item",
              label: "刷新变更",
              icon: "refresh",
              onSelect: onRefresh,
            },
            ...(onPreview
              ? [
                  {
                    type: "item" as const,
                    label: "预览文件",
                    icon: "file" as const,
                    onSelect: onPreview,
                  },
                ]
              : []),
            ...(!deleted
              ? [
                  {
                    type: "item" as const,
                    label: "用默认应用打开",
                    icon: "external" as const,
                    onSelect: () => void openDefaultApp(absolutePath),
                  },
                ]
              : []),
            { type: "separator" },
            ...(directory
              ? [referenceItem("引用到输入框", directory, relativePath)]
              : []),
            revealItem("在 Finder 中显示", absolutePath),
            copyItem("复制相对路径", relativePath, "相对路径已复制"),
            copyItem("复制绝对路径", absolutePath, "绝对路径已复制"),
            ...(entry.patch
              ? [
                  { type: "separator" as const },
                  copyItem("复制补丁", entry.patch, "补丁已复制"),
                ]
              : []),
            { type: "separator" },
            {
              type: "item",
              label: "返回变更列表",
              icon: "arrow-left",
              onSelect: onBack,
            },
          ],
          { label: "Diff 菜单" },
        )
      }
    >
      <div className="preview-head change-detail-head">
        <button
          className="mini-btn"
          onClick={onBack}
          title="返回变更列表"
          aria-label="返回变更列表"
        >
          <Icon name="arrow-left" size={15} />
        </button>
        <StatusBadge status={status} />
        <span className="preview-path" title={relativePath}>
          {relativePath}
        </span>
        <button
          className="mini-btn"
          onClick={onRefresh}
          title="刷新变更"
          aria-label="刷新变更"
        >
          <Icon name="refresh" size={14} />
        </button>
        {onPreview && (
          <button
            className="mini-btn"
            onClick={onPreview}
            title="预览文件"
            aria-label="预览文件"
          >
            <Icon name="file" size={14} />
          </button>
        )}
        {!deleted && (
          <button
            className="mini-btn"
            onClick={() => void openDefaultApp(absolutePath)}
            title="用默认应用打开"
            aria-label="用默认应用打开"
          >
            <Icon name="external" size={14} />
          </button>
        )}
      </div>

      <div className="diff-summary">
        <span className={`diff-status-text ${status}`}>{statusLabel(status)}</span>
        {parsed.folded > 0 && (
          <span className="diff-folded">折叠 {parsed.folded} 行</span>
        )}
        <span className="diff-stat">
          {(entry.additions ?? 0) > 0 && <em className="add">+{entry.additions}</em>}
          {(entry.deletions ?? 0) > 0 && <em className="del">−{entry.deletions}</em>}
        </span>
      </div>

      {parsed.lines.length === 0 ? (
        <div className="panel-state">
          {entry.patch
            ? "补丁只有文件元数据，没有可显示的行"
            : "没有可显示的补丁（可能是二进制文件或只修改了文件权限）"}
        </div>
      ) : (
        <>
          {parsed.truncated && (
            <div className="diff-note">
              补丁共 {parsed.total} 行，仅显示前 {MAX_DIFF_LINES} 行；可通过右键菜单复制完整补丁。
            </div>
          )}
          <div className="diff-scroll">
            {parsed.lines.map((line, index) =>
              line.kind === "hunk" ? (
                <div key={index} className="diff-line hunk">
                  {line.text}
                </div>
            ) : line.kind === "skip" ? (
              <div key={index} className="diff-line skip">
                {line.text}
              </div>
              ) : line.kind === "meta" ? (
                <div key={index} className="diff-line diff-meta">
                  {line.text}
                </div>
              ) : (
                <div key={index} className={`diff-line ${line.kind}`}>
                  <span className="diff-gutter old">{line.oldNo ?? ""}</span>
                  <span className="diff-gutter new">{line.newNo ?? ""}</span>
                <span className="diff-sign">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                </span>
                  <code>{line.text || " "}</code>
                </div>
              ),
            )}
          </div>
        </>
      )}
    </div>
  );
}
