import { useEffect, useRef, useState } from "react";
import { useApp, type MessageEditTarget } from "../store";
import { Icon } from "./Icon";

/**
 * 历史用户消息的内联编辑器。
 *
 * 只编辑正文与原始上传附件；正文里的 @token 由 store 在发送时重新生成
 * file part。@ 弹层和新增附件仍留在底部 Composer，避免这里出现两套输入逻辑。
 */
export default function MessageEditor({
  seed,
  laterCount,
}: {
  seed: MessageEditTarget;
  laterCount: number;
}) {
  const editPhase = useApp((s) => s.editPhase);
  const resendEditedMessage = useApp((s) => s.resendEditedMessage);
  const cancelEditMessage = useApp((s) => s.cancelEditMessage);
  const [text, setText] = useState(seed.text);
  const [uploads, setUploads] = useState(seed.uploads);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const cancelConfirmRef = useRef<HTMLButtonElement>(null);
  // reverted 是等待重试的稳定状态，不能把编辑器和取消按钮一起锁死。
  const busy = editPhase === "reverting" || editPhase === "prompting";
  const canSubmit = Boolean(text.trim() || uploads.length > 0);

  useEffect(() => {
    setText(seed.text);
    setUploads(seed.uploads);
    setConfirming(false);
    setError(null);
  }, [seed.messageID, seed.text, seed.uploads]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const styles = getComputedStyle(area);
    const lineHeight =
      Number.parseFloat(styles.lineHeight) || Number.parseFloat(styles.fontSize) * 1.6;
    const verticalPadding =
      Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    const minHeight = lineHeight * 2 + verticalPadding;
    const maxHeight = lineHeight * 10 + verticalPadding;
    area.style.height = "auto";
    area.style.height = `${Math.min(Math.max(area.scrollHeight, minHeight), maxHeight)}px`;
  }, [text]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }, []);

  useEffect(() => {
    if (confirming) cancelConfirmRef.current?.focus();
  }, [confirming]);

  const submit = async () => {
    if (!canSubmit || busy) return;
    setError(null);
    try {
      await resendEditedMessage({
        messageID: seed.messageID,
        text,
        uploads,
        ...(seed.agent ? { agent: seed.agent } : {}),
        ...(seed.model ? { model: seed.model } : {}),
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setConfirming(false);
    }
  };

  const requestSubmit = () => {
    if (!canSubmit || busy) return;
    setError(null);
    // 第一次提交一定先展示影响范围；prompt 失败后的重试不再重复确认，
    // 因为此时 revert 已经执行过。
    if (editPhase === "reverted") void submit();
    else setConfirming(true);
  };

  const selection = [
    seed.agent,
    seed.model ? `${seed.model.providerID}/${seed.model.modelID}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="bubble-wrap message-editor"
      aria-label="编辑历史消息"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key !== "Escape" || busy) return;
        event.preventDefault();
        event.stopPropagation();
        if (confirming) setConfirming(false);
        else cancelEditMessage();
      }}
    >
      <div className="message-editor-head">
        <Icon name="pencil" size={14} />
        <span>编辑消息</span>
        <span className="message-editor-shortcut">⌘Enter 重新发送 · Esc 取消</span>
      </div>

      <textarea
        ref={areaRef}
        className="message-editor-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (busy) return;
            if (confirming) setConfirming(false);
            else cancelEditMessage();
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.stopPropagation();
            requestSubmit();
          }
        }}
        readOnly={busy}
        rows={2}
        spellCheck={false}
        aria-label="编辑消息内容"
      />

      {uploads.length > 0 && (
        <div className="message-editor-files">
          <span className="message-editor-files-label">附件</span>
          {uploads.map((part) => {
            const name = String(part.filename ?? "附件");
            const image = String(part.mime ?? "").startsWith("image/");
            return (
              <span className="message-editor-file" key={part.id} title={name}>
                <Icon name={image ? "image" : "file"} size={13} />
                <span className="message-editor-file-name">{name}</span>
                <button
                  type="button"
                  className="chip-remove"
                  disabled={busy}
                  title="移除附件"
                  aria-label={`移除附件 ${name}`}
                  onClick={() =>
                    setUploads((current) =>
                      current.filter((item) => item.id !== part.id),
                    )
                  }
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {confirming ? (
        <div className="message-editor-confirm" role="group" aria-label="确认重新发送">
          <div className="message-editor-warning">
            <Icon name="alert" size={15} />
            <span>
              {laterCount > 0
                ? `将替换这条消息，并删除其后的 ${laterCount} 条消息，同时把工作区还原到这条消息之前。该消息之后的手动未提交修改可能一并丢失。`
                : "将替换这条消息，并把工作区还原到这条消息之前。该消息之后的手动未提交修改可能一并丢失。"}
            </span>
          </div>
          <div className="message-editor-actions">
            <button
              ref={cancelConfirmRef}
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-btn small message-editor-danger"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? "正在处理…" : "还原并重新发送"}
            </button>
          </div>
        </div>
      ) : (
        <div className="message-editor-actions">
          <span className="message-editor-meta">
            {editPhase === "reverted"
              ? "原消息已回滚，重试将直接发送"
              : selection
                ? `沿用原消息：${selection}`
                : "沿用当前 Agent 与模型"}
          </span>
          <div className="message-editor-buttons">
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={cancelEditMessage}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-btn small"
              disabled={!canSubmit || busy}
              onClick={requestSubmit}
            >
              {editPhase === "reverting"
                ? "正在还原文件…"
                : editPhase === "prompting"
                  ? "正在重新发送…"
                  : "重新发送"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="msg-error message-editor-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
