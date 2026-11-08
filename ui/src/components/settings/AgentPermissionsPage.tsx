import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { applyConfigChanges, asRecord, asString } from "../../cliConfig";
import type {
  AgentInfo,
  CliConfigSummary,
  CommandInfo,
} from "../../types";
import {
  EmptyState,
  FormModal,
  JsonFieldEditor,
  Row,
  SelectField,
  SettingsSection,
  Tag,
  TextAreaField,
  TextField,
  Toggle,
} from "./SettingsPrimitives";
import type { CliConfigEditor } from "./useCliConfigEditor";

type AgentDraft = {
  name: string;
  description: string;
  mode: string;
  model: string;
  variant: string;
  prompt: string;
  temperature: string;
  topP: string;
  color: string;
  steps: string;
  maxSteps: string;
  options: string;
  tools: string;
  permission: string;
  hidden: boolean;
  disable: boolean;
};

type CommandDraft = {
  name: string;
  description: string;
  agent: string;
  model: string;
  variant: string;
  template: string;
  subtask: boolean;
};

const EMPTY_AGENT: AgentDraft = {
  name: "",
  description: "",
  mode: "primary",
  model: "",
  variant: "",
  prompt: "",
  temperature: "",
  topP: "",
  color: "",
  steps: "",
  maxSteps: "",
  options: "{}",
  tools: "{}",
  permission: "{}",
  hidden: false,
  disable: false,
};

const EMPTY_COMMAND: CommandDraft = {
  name: "",
  description: "",
  agent: "",
  model: "",
  variant: "",
  template: "",
  subtask: false,
};

export default function AgentPermissionsPage({
  config,
  agents,
  selectedAgent,
  editor,
  directory,
  onRefreshConfig,
}: {
  config: CliConfigSummary | null;
  agents: AgentInfo[];
  selectedAgent: string;
  editor: CliConfigEditor;
  directory: string | null;
  onRefreshConfig: () => Promise<void>;
}) {
  const defaultAgent = config?.default_agent || "build";
  const overrides = new Map((config?.agents ?? []).map((agent) => [agent.name, agent]));
  const permission = config?.permission;
  const configuredAgents = asRecord(editor.value.agent);
  const configuredCommands = asRecord(editor.value.command);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [agentDraft, setAgentDraft] = useState<AgentDraft | null>(null);
  const [agentEditing, setAgentEditing] = useState<string | null>(null);
  const [commandDraft, setCommandDraft] = useState<CommandDraft | null>(null);
  const [commandEditing, setCommandEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!directory) {
      setCommands([]);
      return;
    }
    let cancelled = false;
    void api
      .commands(directory)
      .then((next) => {
        if (!cancelled) {
          setCommands(next);
          setCommandError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setCommands([]);
          setCommandError(String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [directory, editor.snapshot?.hash, editor.snapshot?.updated_at]);

  const agentRows = useMemo(() => {
    const rows = new Map<
      string,
      { name: string; description?: string; mode?: string; configured: boolean }
    >();
    for (const agent of agents) {
      rows.set(agent.name, {
        name: agent.name,
        description: agent.description,
        mode: agent.mode,
        configured: Boolean(configuredAgents[agent.name]),
      });
    }
    for (const [name, raw] of Object.entries(configuredAgents)) {
      const agent = asRecord(raw);
      rows.set(name, {
        name,
        description: asString(agent.description) || asString(agent.mode),
        mode: asString(agent.mode),
        configured: true,
      });
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [agents, configuredAgents]);

  const defaultAgentOptions = useMemo(() => {
    const names = new Set(
      agents
        .filter((agent) => agent.mode !== "subagent")
        .map((agent) => agent.name),
    );
    for (const [name, raw] of Object.entries(configuredAgents)) {
      if (asString(asRecord(raw).mode) !== "subagent") names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [agents, configuredAgents]);

  const permissionRecord = useMemo(() => {
    const raw = editor.value.permission;
    if (typeof raw === "string") return { "*": raw };
    return asRecord(raw);
  }, [editor.value.permission]);

  const permissionRules = useMemo(() => {
    const keys = new Set([
      "*",
      "read",
      "edit",
      "glob",
      "grep",
      "list",
      "bash",
      "task",
      "external_directory",
      "todowrite",
      "question",
      "webfetch",
      "websearch",
      "lsp",
      "doom_loop",
      "skill",
      ...Object.keys(permissionRecord),
    ]);
    return [...keys];
  }, [permissionRecord]);

  const openAgent = (name?: string) => {
    const existing = asRecord(configuredAgents[name ?? ""]);
    setAgentEditing(name ?? null);
    setAgentDraft({
      name: name ?? "",
      description: asString(existing.description),
      mode: asString(existing.mode) || "primary",
      model: asString(existing.model),
      variant: asString(existing.variant),
      prompt: asString(existing.prompt),
      temperature: existing.temperature !== undefined ? String(existing.temperature) : "",
      topP: existing.top_p !== undefined ? String(existing.top_p) : "",
      color: asString(existing.color),
      steps: existing.steps !== undefined ? String(existing.steps) : "",
      maxSteps: existing.maxSteps !== undefined ? String(existing.maxSteps) : "",
      options: jsonDraft(existing.options),
      tools: jsonDraft(existing.tools),
      permission: jsonDraft(existing.permission),
      hidden: existing.hidden === true,
      disable: existing.disable === true,
    });
    setActionError(null);
  };

  const saveAgent = async () => {
    if (!agentDraft) return;
    const name = agentDraft.name.trim();
    if (!name) {
      setActionError("Agent 名称不能为空");
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const existing = asRecord(configuredAgents[name]);
      const next: Record<string, unknown> = { ...existing, mode: agentDraft.mode };
      setOptionalString(next, "description", agentDraft.description);
      setOptionalString(next, "model", agentDraft.model);
      setOptionalString(next, "variant", agentDraft.variant);
      setOptionalString(next, "prompt", agentDraft.prompt);
      setOptionalString(next, "color", agentDraft.color);
      setOptionalNumber(next, "temperature", agentDraft.temperature, "Temperature");
      setOptionalNumber(next, "top_p", agentDraft.topP, "Top P");
      setOptionalInteger(next, "steps", agentDraft.steps, "最大步数");
      setOptionalInteger(next, "maxSteps", agentDraft.maxSteps, "最大步数上限");
      setOptionalJsonObject(next, "options", agentDraft.options, "Options");
      setOptionalJsonObject(next, "tools", agentDraft.tools, "Tools");
      setOptionalJsonValue(next, "permission", agentDraft.permission, "Permission");
      next.hidden = agentDraft.hidden;
      next.disable = agentDraft.disable;
      const path = ["agent", name];
      const nextText = applyConfigChanges(editor.text, [
        { path, op: "set", value: next },
      ]);
      if (await editor.save(nextText)) {
        setAgentDraft(null);
        setAgentEditing(null);
        await onRefreshConfig();
      }
    } catch (error) {
      setActionError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const deleteAgent = async (name: string) => {
    if (!window.confirm(`删除配置型 Agent ${name}？`)) return;
    setActionError(null);
    try {
      const nextText = applyConfigChanges(editor.text, [
        { path: ["agent", name], op: "delete" },
      ]);
      if (!(await editor.save(nextText))) return;
      await onRefreshConfig();
    } catch (error) {
      setActionError(String(error));
    }
  };

  const openCommand = (name?: string) => {
    const existing = asRecord(configuredCommands[name ?? ""]);
    setCommandEditing(name ?? null);
    setCommandDraft({
      name: name ?? "",
      description: asString(existing.description),
      agent: asString(existing.agent),
      model: asString(existing.model),
      variant: asString(existing.variant),
      template: asString(existing.template),
      subtask: existing.subtask === true,
    });
    setActionError(null);
  };

  const saveCommand = async () => {
    if (!commandDraft) return;
    const name = commandDraft.name.trim();
    if (!name || !commandDraft.template.trim()) {
      setActionError("Command 名称和模板不能为空");
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const existing = asRecord(configuredCommands[name]);
      const next: Record<string, unknown> = {
        ...existing,
        template: commandDraft.template,
      };
      setOptionalString(next, "description", commandDraft.description);
      setOptionalString(next, "agent", commandDraft.agent);
      setOptionalString(next, "model", commandDraft.model);
      setOptionalString(next, "variant", commandDraft.variant);
      if (commandDraft.subtask) next.subtask = true;
      else delete next.subtask;
      const nextText = applyConfigChanges(editor.text, [
        { path: ["command", name], op: "set", value: next },
      ]);
      if (await editor.save(nextText)) {
        setCommandDraft(null);
        setCommandEditing(null);
        await onRefreshConfig();
      }
    } catch (error) {
      setActionError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const deleteCommand = async (name: string) => {
    if (!window.confirm(`删除配置型 Command ${name}？`)) return;
    setActionError(null);
    try {
      const nextText = applyConfigChanges(editor.text, [
        { path: ["command", name], op: "delete" },
      ]);
      if (!(await editor.save(nextText))) return;
      await onRefreshConfig();
    } catch (error) {
      setActionError(String(error));
    }
  };

  const setPermissionRule = (tool: string, effect: string) => {
    const next = { ...permissionRecord };
    if (!effect) delete next[tool];
    else next[tool] = effect;
    editor.applyChanges([
      Object.keys(next).length
        ? { path: ["permission"], op: "set", value: next }
        : { path: ["permission"], op: "delete" },
    ]);
  };

  return (
    <>
      <SettingsSection
        title="Agent"
        hint="配置型 Agent 会写入当前 deveco.jsonc；内置和文件型 Agent 只读。"
        action={
          <button className="ghost-btn" onClick={() => openAgent()}>
            新建 Agent
          </button>
        }
      >
        <SelectField
          label="默认 Agent"
          hint="写入当前作用域的 default_agent"
          value={asString(editor.value.default_agent)}
          options={[
            { label: "继承 / build", value: "" },
            ...defaultAgentOptions.map((name) => ({ label: name, value: name })),
          ]}
          onChange={(next) =>
            editor.applyChanges([
              next
                ? { path: ["default_agent"], op: "set", value: next }
                : { path: ["default_agent"], op: "delete" },
            ])
          }
        />
        <Row label="有效默认值" value={defaultAgent} mono />
        <Row label="当前会话" value={selectedAgent || "未选择"} mono />
        {actionError && <div className="settings-inline-error">{actionError}</div>}
        {agentRows.length === 0 ? (
          <EmptyState>
            当前没有可展示的主 Agent。请先从侧栏选择一个工作区。
          </EmptyState>
        ) : (
          agentRows.map((agent) => {
            const override = overrides.get(agent.name);
            const labels = [
              agent.name === defaultAgent ? "默认" : null,
              agent.name === selectedAgent ? "当前" : null,
            ].filter(Boolean);
            return (
              <div className="settings-entity" key={agent.name}>
                <div className="settings-entity-main">
                  <div className="settings-entity-title">
                    <span>{agent.name}</span>
                    {labels.map((label) => (
                      <Tag key={label} tone={label === "当前" ? "ok" : "muted"}>
                        {label}
                      </Tag>
                    ))}
                    {override?.disabled && <Tag tone="danger">已禁用配置</Tag>}
                    <Tag tone={agent.configured ? "ok" : "muted"}>
                      {agent.configured ? "配置" : "CLI"}
                    </Tag>
                  </div>
                  <div className="settings-entity-meta">
                    {agent.description || agent.mode || "Agent"}
                  </div>
                  {(override?.model || override?.variant) && (
                    <div className="settings-entity-sub">
                      {override?.model ?? "继承默认模型"}
                      {override?.variant ? ` · ${override.variant}` : ""}
                    </div>
                  )}
                </div>
                {agent.configured && (
                  <div className="settings-entity-actions">
                    <button className="ghost-btn" onClick={() => openAgent(agent.name)}>
                      编辑
                    </button>
                    <button
                      className="ghost-btn danger-text"
                      onClick={() => void deleteAgent(agent.name)}
                    >
                      删除
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </SettingsSection>

      <SettingsSection
        title="Command"
        hint="配置型 Command 可编辑；文件/内置 Command 只读。"
        action={
          <button className="ghost-btn" onClick={() => openCommand()}>
            新建 Command
          </button>
        }
      >
        {commandError && <div className="settings-inline-error">{commandError}</div>}
        {commands.length === 0 ? (
          <EmptyState>当前工作区没有读取到 Command。</EmptyState>
        ) : (
          commands.map((command) => {
            const configured = Boolean(configuredCommands[command.name]);
            return (
              <div className="settings-entity" key={command.name}>
                <div className="settings-entity-main">
                  <div className="settings-entity-title">
                    <span>/{command.name}</span>
                    <Tag tone={configured ? "ok" : "muted"}>
                      {configured ? "配置" : command.source || "只读"}
                    </Tag>
                  </div>
                  <div className="settings-entity-meta">
                    {command.description || command.agent || "Command"}
                  </div>
                  {command.model && <div className="settings-entity-sub">{command.model}</div>}
                </div>
                {configured && (
                  <div className="settings-entity-actions">
                    <button className="ghost-btn" onClick={() => openCommand(command.name)}>
                      编辑
                    </button>
                    <button
                      className="ghost-btn danger-text"
                      onClick={() => void deleteCommand(command.name)}
                    >
                      删除
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
        {Object.keys(configuredCommands)
          .filter((name) => !commands.some((command) => command.name === name))
          .map((name) => (
            <div className="settings-entity" key={`configured-${name}`}>
              <div className="settings-entity-main">
                <div className="settings-entity-title">
                  <span>/{name}</span>
                  <Tag tone="ok">配置</Tag>
                </div>
                <div className="settings-entity-meta">尚未被 CLI 加载，保存后会出现在命令列表</div>
              </div>
              <div className="settings-entity-actions">
                <button className="ghost-btn" onClick={() => openCommand(name)}>
                  编辑
                </button>
                <button
                  className="ghost-btn danger-text"
                  onClick={() => void deleteCommand(name)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
      </SettingsSection>

      <SettingsSection
        title="权限"
        hint="权限规则写入当前作用域；项目规则会覆盖全局规则。"
      >
        <div className="settings-permission-rules">
          {permissionRules.map((tool) => {
            const rule = permissionRecord[tool];
            const effect = typeof rule === "string" ? rule : "";
            const patternMap = Boolean(rule) && typeof rule === "object";
            return (
              <div className="settings-permission-rule" key={tool}>
                <div className="settings-label">
                  <span>{tool === "*" ? "默认（*）" : tool}</span>
                  {patternMap && <small>当前是 pattern map；选择效果会覆盖它</small>}
                </div>
                <select
                  className="settings-input settings-select"
                  value={effect}
                  onChange={(event) => setPermissionRule(tool, event.target.value)}
                >
                  <option value="">继承 / 未设置</option>
                  <option value="allow">允许</option>
                  <option value="ask">询问</option>
                  <option value="deny">拒绝</option>
                </select>
              </div>
            );
          })}
        </div>
        <Row
          label="默认策略"
          value={
            permission?.defaultEffect
              ? permissionLabel(permission.defaultEffect)
              : "未设置"
          }
        />
        <Row label="明确规则" value={`${permission?.total ?? 0} 条`} />
        <div className="settings-permission-grid">
          <div>
            <strong>{permission?.allow ?? 0}</strong>
            <span>允许</span>
          </div>
          <div>
            <strong>{permission?.ask ?? 0}</strong>
            <span>询问</span>
          </div>
          <div>
            <strong>{permission?.deny ?? 0}</strong>
            <span>拒绝</span>
          </div>
        </div>
        <JsonFieldEditor
          label="权限 JSON（含 pattern 规则）"
          hint='可编辑完整对象，例如 {"bash":{"git *":"allow","rm *":"deny"}}；写入当前作用域'
          value={editor.value.permission ?? {}}
          onApply={(next) => {
            if (
              next !== null &&
              next !== undefined &&
              typeof next !== "string" &&
              (typeof next !== "object" || Array.isArray(next))
            ) {
              setActionError("Permission 必须是 allow/ask/deny 字符串或 JSON 对象");
              return;
            }
            const empty =
              next === null ||
              next === undefined ||
              (typeof next === "object" &&
                !Array.isArray(next) &&
                Object.keys(next as Record<string, unknown>).length === 0);
            editor.applyChanges([
              empty
                ? { path: ["permission"], op: "delete" }
                : { path: ["permission"], op: "set", value: next },
            ]);
          }}
        />
        <Row
          label="UI 校验模型"
          value={config?.uiVerificationModel ?? "登录内置 / 未显式配置"}
          mono
        />
        <p className="settings-note">
          权限审批仍在会话内完成；这里只决定 Agent 遇到工具调用时的默认策略。
        </p>
      </SettingsSection>

      {agentDraft && (
        <FormModal
          title={agentEditing ? `编辑 Agent · ${agentEditing}` : "新建 Agent"}
          onClose={() => {
            setAgentDraft(null);
            setAgentEditing(null);
          }}
          onSave={() => void saveAgent()}
          saving={saving}
          saveLabel="保存并应用"
          error={actionError}
        >
          <TextField
            label="名称"
            value={agentDraft.name}
            disabled={Boolean(agentEditing)}
            onChange={(next) => setAgentDraft({ ...agentDraft, name: next })}
          />
          <TextField
            label="描述"
            value={agentDraft.description}
            onChange={(next) => setAgentDraft({ ...agentDraft, description: next })}
          />
          <SelectField
            label="模式"
            value={agentDraft.mode}
            options={[
              { label: "Primary", value: "primary" },
              { label: "Subagent", value: "subagent" },
              { label: "All", value: "all" },
            ]}
            onChange={(next) => setAgentDraft({ ...agentDraft, mode: next })}
          />
          <TextField
            label="模型"
            hint="provider/model，留空继承默认模型"
            value={agentDraft.model}
            onChange={(next) => setAgentDraft({ ...agentDraft, model: next })}
          />
          <TextField
            label="推理档位"
            value={agentDraft.variant}
            onChange={(next) => setAgentDraft({ ...agentDraft, variant: next })}
          />
          <TextAreaField
            label="系统提示词"
            value={agentDraft.prompt}
            onChange={(next) => setAgentDraft({ ...agentDraft, prompt: next })}
            rows={7}
            mono={false}
          />
          <TextField
            label="Temperature"
            value={agentDraft.temperature}
            onChange={(next) => setAgentDraft({ ...agentDraft, temperature: next })}
          />
          <TextField
            label="Top P"
            value={agentDraft.topP}
            onChange={(next) => setAgentDraft({ ...agentDraft, topP: next })}
          />
          <TextField
            label="最大步数上限"
            hint="maxSteps；留空不写入"
            value={agentDraft.maxSteps}
            onChange={(next) => setAgentDraft({ ...agentDraft, maxSteps: next })}
          />
          <TextField
            label="颜色"
            hint="十六进制或主题色名称"
            value={agentDraft.color}
            onChange={(next) => setAgentDraft({ ...agentDraft, color: next })}
          />
          <TextField
            label="最大步数"
            value={agentDraft.steps}
            onChange={(next) => setAgentDraft({ ...agentDraft, steps: next })}
          />
          <TextAreaField
            label="Tools JSON"
            hint='工具开关对象，例如 {"bash": false}'
            value={agentDraft.tools}
            onChange={(next) => setAgentDraft({ ...agentDraft, tools: next })}
            rows={4}
          />
          <TextAreaField
            label="Permission JSON"
            hint='权限对象或 "allow"/"ask"/"deny"'
            value={agentDraft.permission}
            onChange={(next) => setAgentDraft({ ...agentDraft, permission: next })}
            rows={4}
          />
          <TextAreaField
            label="Options JSON"
            hint="Agent 其它扩展字段"
            value={agentDraft.options}
            onChange={(next) => setAgentDraft({ ...agentDraft, options: next })}
            rows={4}
          />
          <Toggle
            label="在 @ 菜单中隐藏"
            checked={agentDraft.hidden}
            onChange={(next) => setAgentDraft({ ...agentDraft, hidden: next })}
          />
          <Toggle
            label="禁用此配置"
            checked={agentDraft.disable}
            onChange={(next) => setAgentDraft({ ...agentDraft, disable: next })}
          />
        </FormModal>
      )}

      {commandDraft && (
        <FormModal
          title={commandEditing ? `编辑 Command · /${commandEditing}` : "新建 Command"}
          onClose={() => {
            setCommandDraft(null);
            setCommandEditing(null);
          }}
          onSave={() => void saveCommand()}
          saving={saving}
          saveLabel="保存并应用"
          error={actionError}
        >
          <TextField
            label="名称"
            hint="不需要输入前导 /"
            value={commandDraft.name}
            disabled={Boolean(commandEditing)}
            onChange={(next) => setCommandDraft({ ...commandDraft, name: next })}
          />
          <TextField
            label="描述"
            value={commandDraft.description}
            onChange={(next) => setCommandDraft({ ...commandDraft, description: next })}
          />
          <TextField
            label="Agent"
            value={commandDraft.agent}
            onChange={(next) => setCommandDraft({ ...commandDraft, agent: next })}
          />
          <TextField
            label="模型"
            value={commandDraft.model}
            onChange={(next) => setCommandDraft({ ...commandDraft, model: next })}
          />
          <TextField
            label="推理档位"
            value={commandDraft.variant}
            onChange={(next) => setCommandDraft({ ...commandDraft, variant: next })}
          />
          <TextAreaField
            label="模板"
            hint="可使用 $ARGUMENTS"
            value={commandDraft.template}
            onChange={(next) => setCommandDraft({ ...commandDraft, template: next })}
            rows={8}
            mono={false}
          />
          <Toggle
            label="作为子任务执行"
            checked={commandDraft.subtask}
            onChange={(next) => setCommandDraft({ ...commandDraft, subtask: next })}
          />
        </FormModal>
      )}
    </>
  );
}

function jsonDraft(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function setOptionalString(target: Record<string, unknown>, key: string, raw: string) {
  const value = raw.trim();
  if (value) target[key] = value;
  else delete target[key];
}

function setOptionalNumber(
  target: Record<string, unknown>,
  key: string,
  raw: string,
  label: string,
) {
  const value = raw.trim();
  if (!value) {
    delete target[key];
    return;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} 必须是数字`);
  }
  target[key] = parsed;
}

function setOptionalInteger(
  target: Record<string, unknown>,
  key: string,
  raw: string,
  label: string,
) {
  const value = raw.trim();
  if (!value) {
    delete target[key];
    return;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 必须是大于 0 的整数`);
  }
  target[key] = parsed;
}

function parseJsonDraft(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw.trim() || "null");
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${String(error)}`);
  }
}

function setOptionalJsonObject(
  target: Record<string, unknown>,
  key: string,
  raw: string,
  label: string,
) {
  const value = parseJsonDraft(raw, label);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value as Record<string, unknown>).length === 0
  ) {
    delete target[key];
    return;
  }
  target[key] = value;
}

function setOptionalJsonValue(
  target: Record<string, unknown>,
  key: string,
  raw: string,
  label: string,
) {
  const value = parseJsonDraft(raw, label);
  if (typeof value === "string") {
    target[key] = value;
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是字符串或 JSON 对象`);
  }
  if (
    value === null ||
    value === undefined ||
    Object.keys(value as Record<string, unknown>).length === 0
  ) {
    delete target[key];
    return;
  }
  target[key] = value;
}

function permissionLabel(value: string): string {
  if (value === "allow") return "允许";
  if (value === "ask") return "询问";
  if (value === "deny") return "拒绝";
  return value;
}
