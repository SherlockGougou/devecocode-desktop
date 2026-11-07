import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment } from "../types";
import { api } from "../api";
import { useApp } from "../store";
import { Icon } from "./Icon";

export default function Composer() {
  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const streaming = useApp((s) => s.streaming);
  const directory = useApp((s) => s.directory);
  const models = useApp((s) => s.models);
  const agents = useApp((s) => s.agents);
  const selectedAgent = useApp((s) => s.selectedAgent);
  const selectAgent = useApp((s) => s.selectAgent);
  const commands = useApp((s) => s.commands);
  const selectedVariant = useApp((s) => s.selectedVariant);
  const selectVariant = useApp((s) => s.selectVariant);
  const [agentOpen, setAgentOpen] = useState(false);
  const selectedModel = useApp((s) => s.selectedModel);
  const loadModels = useApp((s) => s.loadModels);
  const selectModel = useApp((s) => s.selectModel);
  const messages = useApp((s) => s.messages);
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const failedText = useApp((s) => s.failedText);
  const clearFailedText = useApp((s) => s.clearFailedText);
  const [keyword, setKeyword] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 220)}px`;
  }, [text]);

  // 发送失败时把原文还回输入框
  useEffect(() => {
    if (!failedText) return;
    setText((current) => (current.trim() ? current : failedText));
    clearFailedText();
  }, [failedText, clearFailedText]);

  // @ 引用：输入 @ 后按关键字搜索工作区文件
  useEffect(() => {
    if (!mention || !directory) {
      setMentionFiles([]);
      return;
    }
    const query = mention.query;
    const timer = setTimeout(() => {
      void api
        .searchFiles(directory, query)
        .then((files) => {
          setMentionFiles(files.slice(0, 8));
          setMentionIndex(0);
        })
        .catch(() => setMentionFiles([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [mention, directory]);

  const detectMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const match = /@([^\s@]*)$/.exec(before);
    if (!match) {
      setMention(null);
      return;
    }
    setMention({ query: match[1], start: caret - match[0].length, end: caret });
  };

  const applyMention = (path: string) => {
    if (!mention) return;
    const area = areaRef.current;
    const next = `${text.slice(0, mention.start)}@${path} ${text.slice(mention.end)}`;
    setText(next);
    setMention(null);
    const caret = mention.start + path.length + 2;
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(caret, caret);
    });
  };

  useEffect(() => {
    if (!pickerOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [pickerOpen]);

  // 当前模型：优先用户本次选择的，其次最近一条带模型的消息
  const currentModel = useMemo(() => {
    if (selectedModel) return selectedModel;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const model = messages[i].info.model;
      if (model) return { providerID: model.providerID, modelID: model.modelID };
    }
    return null;
  }, [selectedModel, messages]);

  const modelLabel = useMemo(() => {
    if (!currentModel) return "默认模型";
    const match = models.find(
      (item) => item.id === currentModel.modelID && item.providerID === currentModel.providerID,
    );
    return match?.name ?? `${currentModel.providerID}/${currentModel.modelID}`;
  }, [currentModel, models]);

  const variants = useMemo(() => {
    if (!currentModel) return [] as string[];
    const match = models.find(
      (item) => item.id === currentModel.modelID && item.providerID === currentModel.providerID,
    );
    return (match?.variants ?? []).map((variant) => variant.id);
  }, [currentModel, models]);

  // 斜杠命令：输入以 / 开头且还没敲空格时弹出
  const slashQuery = useMemo(() => {
    const match = /^\/(\S*)$/.exec(text);
    return match ? match[1].toLowerCase() : null;
  }, [text]);
  const slashMatches = useMemo(() => {
    if (slashQuery === null) return [] as typeof commands;
    return commands
      .filter((command) => command.name.toLowerCase().includes(slashQuery))
      .slice(0, 8);
  }, [commands, slashQuery]);
  const [slashIndex, setSlashIndex] = useState(0);

  const applyCommand = (name: string) => {
    setText(`/${name} `);
    requestAnimationFrame(() => areaRef.current?.focus());
  };

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return models.slice(0, 60);
    return models
      .filter(
        (item) =>
          (item.name ?? "").toLowerCase().includes(key) ||
          item.id.toLowerCase().includes(key) ||
          item.providerID.toLowerCase().includes(key),
      )
      .slice(0, 60);
  }, [models, keyword]);

  const submit = () => {
    const value = text.trim();
    if ((!value && attachments.length === 0) || !directory || streaming) return;
    const files = attachments;
    setText("");
    setAttachments([]);
    void send(value, files);
  };

  const MAX_FILE = 8 * 1024 * 1024;

  const readFile = (file: File) =>
    new Promise<Attachment | null>((resolve) => {
      if (file.size > MAX_FILE) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          id: `${file.name}-${file.lastModified}`,
          name: file.name,
          mime: file.type || "application/octet-stream",
          url: String(reader.result ?? ""),
          size: file.size,
        });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });

  const pickFiles = async (list: FileList | null) => {
    if (!list) return;
    const picked = await Promise.all(Array.from(list).slice(0, 4).map(readFile));
    const valid = picked.filter((item): item is Attachment => Boolean(item));
    if (valid.length > 0) setAttachments((current) => [...current, ...valid].slice(0, 4));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="file-input"
          onChange={(event) => void pickFiles(event.target.files)}
        />
        {attachments.length > 0 && (
          <div className="attachment-row">
            {attachments.map((file) => (
              <span className="attachment-chip" key={file.id} title={`${file.name} · ${Math.round(file.size / 1024)}KB`}>
                <Icon name={file.mime.startsWith("image/") ? "image" : "file"} size={14} />
                {file.name}
                <button
                  className="chip-remove"
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== file.id))}
                  title="移除"
                  aria-label={`移除 ${file.name}`}
                >
                  <Icon name="close" size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        {slashMatches.length > 0 && (
          <div className="mention-pop">
            <div className="mention-hint">斜杠命令（↑↓ 选择，Enter 插入，Esc 取消）</div>
            {slashMatches.map((command, index) => (
              <button
                key={command.name}
                className={`mention-item ${index === slashIndex ? "active" : ""}`}
                onMouseEnter={() => setSlashIndex(index)}
                onClick={() => applyCommand(command.name)}
                title={command.description ?? command.name}
              >
                /{command.name}
                <span className="slash-desc">{command.description?.slice(0, 40) ?? ""}</span>
              </button>
            ))}
          </div>
        )}
        {mention && mentionFiles.length > 0 && (
          <div className="mention-pop">
            <div className="mention-hint">引用文件（↑↓ 选择，Enter 插入，Esc 取消）</div>
            {mentionFiles.map((file, index) => (
              <button
                key={file}
                className={`mention-item ${index === mentionIndex ? "active" : ""}`}
                onMouseEnter={() => setMentionIndex(index)}
                onClick={() => applyMention(file)}
                title={file}
              >
                {file}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={areaRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            detectMention(event.target.value, event.target.selectionStart ?? 0);
          }}
          onKeyDown={(event) => {
            if (slashMatches.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSlashIndex((index) => (index + 1) % slashMatches.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSlashIndex((index) => (index - 1 + slashMatches.length) % slashMatches.length);
                return;
              }
              if (event.key === "Tab" || event.key === "Enter") {
                event.preventDefault();
                applyCommand(slashMatches[Math.min(slashIndex, slashMatches.length - 1)].name);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setText("");
                return;
              }
            }
            if (mention && mentionFiles.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMentionIndex((index) => (index + 1) % mentionFiles.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setMentionIndex((index) => (index - 1 + mentionFiles.length) % mentionFiles.length);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                applyMention(mentionFiles[mentionIndex]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setMention(null);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={directory ? "发消息给 DevEco Code，Shift + Enter 换行" : "请先在左侧选择工作区"}
          rows={1}
          disabled={!directory}
        />
        <div className="composer-actions">
          <div className="composer-left">
            <button
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              title="添加附件（最多 4 个，单个不超过 8MB）"
              disabled={!directory}
            >
              <Icon name="paperclip" size={17} />
            </button>
            <div className="agent-picker">
              <button
                className="model-chip"
                onClick={() => setAgentOpen((open) => !open)}
                title="切换 Agent（Build / Plan / Debug…）"
              >
                <span className="agent-dot" />
                {selectedAgent}
              </button>
              {agentOpen && (
                <div className="model-pop">
                  {agents.map((agent) => (
                    <button
                      key={agent.name}
                      className={`model-item ${agent.name === selectedAgent ? "active" : ""}`}
                      onClick={() => {
                        selectAgent(agent.name);
                        setAgentOpen(false);
                      }}
                      title={agent.description}
                    >
                      <span className="model-name">{agent.name}</span>
                    </button>
                  ))}
                  {agents.length === 0 && <div className="empty-line">没有可用 Agent</div>}
                </div>
              )}
            </div>
            {variants.length > 0 && (
              <button
                className={`variant-chip ${selectedVariant ? "on" : ""}`}
                title="推理强度（model variant）"
                onClick={() => {
                  const index = selectedVariant ? variants.indexOf(selectedVariant) : -1;
                  const next = index + 1 >= variants.length ? null : variants[index + 1];
                  selectVariant(next);
                }}
              >
                {selectedVariant ?? "默认档"}
              </button>
            )}
            <div className="model-picker" ref={pickerRef}>
              <button
                className={`model-chip ${pickerOpen ? "open" : ""}`}
                onClick={() => setPickerOpen((open) => !open)}
                title="切换模型"
              >
                <span className="model-dot" />
                {modelLabel}
                <Icon name="chevron-down" size={14} className="model-caret" />
              </button>
              {pickerOpen && (
                <div className="model-pop">
                  <input
                    className="model-search"
                    autoFocus
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder="搜索模型"
                  />
                  <div className="model-list">
                    {filtered.map((item) => {
                      const active =
                        currentModel?.modelID === item.id &&
                        currentModel?.providerID === item.providerID;
                      return (
                        <button
                          key={`${item.providerID}/${item.id}`}
                          className={`model-item ${active ? "active" : ""}`}
                          onClick={() => {
                            selectModel({ providerID: item.providerID, modelID: item.id });
                            setPickerOpen(false);
                          }}
                        >
                          <span className="model-name">{item.name ?? item.id}</span>
                          <span className="model-provider">{item.providerID}</span>
                        </button>
                      );
                    })}
                    {filtered.length === 0 && <div className="empty-line">没有匹配的模型</div>}
                  </div>
                </div>
              )}
            </div>
            <span className="composer-hint">{streaming ? "Agent 正在执行…" : "Enter 发送"}</span>
          </div>
          {streaming ? (
            <button className="stop-btn" onClick={() => void stop()}>
              <Icon name="stop" size={12} />
              停止
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={submit}
              disabled={(!text.trim() && attachments.length === 0) || !directory}
              title="发送（Enter）"
              aria-label="发送"
            >
              <Icon name="arrow-up" size={18} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
