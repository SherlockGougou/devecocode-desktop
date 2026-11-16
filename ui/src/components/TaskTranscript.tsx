import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store";
import type { Message, Part } from "../types";
import { ImageGroup } from "../imageViewer";
import {
  AttachmentViewer,
  inSameMinute,
  messageHasContent,
  MessageRow,
} from "./ChatView";

function groups(messages: Message[]): Message[][] {
  const result: Message[][] = [];
  let previous: Message | undefined;
  for (const message of messages) {
    const last = result[result.length - 1];
    if (
      last &&
      previous?.info.role === "assistant" &&
      message.info.role === "assistant" &&
      inSameMinute(previous, message)
    ) {
      last.push(message);
    } else {
      result.push([message]);
    }
    previous = message;
  }
  return result;
}

export default function TaskTranscript({
  sessionID,
  active,
}: {
  sessionID: string;
  active: boolean;
}) {
  const messages = useApp((state) => state.childMessages[sessionID] ?? []);
  const transcript = useApp((state) => state.childTranscripts[sessionID]);
  const directory = useApp((state) => state.directory ?? "");
  const loadTaskTranscript = useApp((state) => state.loadTaskTranscript);
  const openFile = useApp((state) => state.openFile);
  const [attachmentPreview, setAttachmentPreview] = useState<Part | null>(null);

  useEffect(() => {
    void loadTaskTranscript(sessionID);
  }, [sessionID, loadTaskTranscript]);

  const liveMessageID = useMemo(() => {
    if (!active) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.info.role !== "assistant") continue;
      return message.info.time?.completed ? null : message.info.id;
    }
    return null;
  }, [active, messages]);

  const visible = useMemo(
    () =>
      messages.filter(
        (message) =>
          messageHasContent(message) || message.info.id === liveMessageID,
      ),
    [liveMessageID, messages],
  );
  const rows = useMemo(() => groups(visible), [visible]);

  if (transcript?.loading && messages.length === 0) {
    return (
      <div className="task-transcript-state">
        <span className="tool-spinner" />
        正在读取完整对话…
      </div>
    );
  }
  if (transcript?.error && messages.length === 0) {
    return <div className="task-error">{transcript.error}</div>;
  }
  if (rows.length === 0) {
    return <div className="empty-line">子任务还没有对话记录</div>;
  }

  return (
    <div className="task-transcript">
      {rows.map((group) => (
        <div className="msg-group" key={group[0].info.id}>
          {group.map((message, index) => (
            <div className="msg-block" key={message.info.id}>
              <ImageGroup>
                <MessageRow
                  message={message}
                  continued={index > 0}
                  live={message.info.id === liveMessageID}
                  steer={false}
                  directory={directory}
                  editable={false}
                  editReason="子任务对话仅供查看"
                  laterCount={0}
                  compact={index < group.length - 1}
                  metaOverride={
                    index < group.length - 1 ? null : undefined
                  }
                  onStartEdit={() => {}}
                  onOpenFile={(path) => void openFile(path)}
                  onOpenAttachment={setAttachmentPreview}
                />
              </ImageGroup>
            </div>
          ))}
        </div>
      ))}
      {attachmentPreview && (
        <AttachmentViewer
          part={attachmentPreview}
          directory={directory || undefined}
          onClose={() => setAttachmentPreview(null)}
        />
      )}
    </div>
  );
}
