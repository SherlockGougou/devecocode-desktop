import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import {
  applyConfigChanges,
  asArray,
  asBoolean,
  asRecord,
  asString,
} from "../../cliConfig";
import type { CliConfigSummary, McpServerInfo, SkillStatus } from "../../types";
import {
  EmptyState,
  FormModal,
  JsonFieldEditor,
  SelectField,
  SettingsSection,
  StringListEditor,
  Tag,
  TextAreaField,
  TextField,
  Toggle,
} from "./SettingsPrimitives";
import type { CliConfigEditor } from "./useCliConfigEditor";

type LoadState = "loading" | "ready" | "error";

const SCOPE_LABELS: Record<SkillStatus["scope"], string> = {
  global: "全局",
  project: "项目",
  builtin: "内置",
};

type McpDraft = {
  name: string;
  type: "remote" | "local";
  url: string;
  command: string;
  cwd: string;
  enabled: boolean;
  timeout: string;
  headers: string;
  environment: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  oauthCallbackPort: string;
  oauthRedirectUri: string;
};

const EMPTY_MCP: McpDraft = {
  name: "",
  type: "remote",
  url: "",
  command: "",
  cwd: "",
  enabled: true,
  timeout: "",
  headers: "{}",
  environment: "{}",
  oauthClientId: "",
  oauthClientSecret: "",
  oauthScope: "",
  oauthCallbackPort: "",
  oauthRedirectUri: "",
};

function mcpTone(status?: string): "ok" | "warn" | "danger" | "muted" {
  if (status === "connected") return "ok";
  if (status === "failed") return "danger";
  if (status === "needs_auth" || status === "needs_client_registration") return "warn";
  return "muted";
}

function mcpLabel(status?: string): string {
  if (status === "connected") return "已连接";
  if (status === "failed") return "失败";
  if (status === "needs_auth") return "需要认证";
  if (status === "needs_client_registration") return "需要注册客户端";
  if (status === "disabled") return "已禁用";
  return status || "未知";
}

export default function ExtensionsPage({
  directory,
  config,
  editor,
  onRefreshConfig,
}: {
  directory: string | null;
  config: CliConfigSummary | null;
  editor: CliConfigEditor;
  onRefreshConfig: () => Promise<void>;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [mcp, setMcp] = useState<Record<string, McpServerInfo>>({});
  const [skills, setSkills] = useState<SkillStatus[]>([]);
  const [search, setSearch] = useState("");
  const [busyMcp, setBusyMcp] = useState<string | null>(null);
  const [busySkill, setBusySkill] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mcpDraft, setMcpDraft] = useState<McpDraft | null>(null);
  const [mcpEditing, setMcpEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!directory) {
      setState("ready");
      setMcp({});
      setSkills([]);
      return;
    }
    let cancelled = false;
    setState("loading");
    setActionError(null);
    void Promise.allSettled([api.mcpStatus(directory), api.skills(directory)]).then(
      ([mcpResult, skillResult]) => {
        if (cancelled) return;
        if (mcpResult.status === "fulfilled") setMcp(mcpResult.value);
        else setMcp({});
        if (skillResult.status === "fulfilled") setSkills(skillResult.value);
        else setSkills([]);
        setState(
          mcpResult.status === "rejected" && skillResult.status === "rejected"
            ? "error"
            : "ready",
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [directory]);

  const filteredSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) ||
        skill.description?.toLowerCase().includes(query) ||
        skill.location.toLowerCase().includes(query),
    );
  }, [search, skills]);

  const enabledSkills = skills.filter((skill) => skill.enabled).length;
  const mcpEntries = Object.entries(mcp).sort(([a], [b]) => a.localeCompare(b));

  const updateMcp = async (name: string, connect: boolean) => {
    if (!directory) return;
    setBusyMcp(name);
    setActionError(null);
    try {
      if (connect) await api.mcpConnect(directory, name);
      else await api.mcpDisconnect(directory, name);
      setMcp(await api.mcpStatus(directory));
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusyMcp(null);
    }
  };

  const updateSkill = async (skill: SkillStatus, enabled: boolean) => {
    if (!directory) return;
    setBusySkill(skill.name);
    setActionError(null);
    try {
      const updated = await api.setSkillEnabled(
        directory,
        skill.name,
        skill.scope,
        enabled,
      );
      setSkills((current) =>
        current.map((item) =>
          item.name === skill.name ? { ...item, enabled: updated.enabled } : item,
        ),
      );
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusySkill(null);
    }
  };

  const refreshExtensions = async () => {
    if (!directory) return;
    const [nextMcp, nextSkills] = await Promise.all([
      api.mcpStatus(directory).catch(() => ({})),
      api.skills(directory).catch(() => []),
    ]);
    setMcp(nextMcp);
    setSkills(nextSkills);
  };

  const configuredMcp = asRecord(editor.value.mcp);
  const configuredSkills = asRecord(editor.value.skills);
  const mcpRows = useMemo(() => {
    const rows = new Map<
      string,
      { name: string; status?: string; error?: string; configured: boolean }
    >();
    for (const [name, server] of Object.entries(mcp)) {
      rows.set(name, {
        name,
        status: server.status,
        error: server.error,
        configured: Boolean(configuredMcp[name]),
      });
    }
    for (const name of Object.keys(configuredMcp)) {
      if (!rows.has(name)) {
        const entry = asRecord(configuredMcp[name]);
        rows.set(name, {
          name,
          status: entry.enabled === false ? "disabled" : undefined,
          configured: true,
        });
      }
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [configuredMcp, mcp]);

  const openMcp = (name?: string) => {
    const existing = asRecord(configuredMcp[name ?? ""]);
    const oauth = asRecord(existing.oauth);
    setMcpEditing(name ?? null);
    setMcpDraft({
      name: name ?? "",
      type: existing.type === "local" ? "local" : "remote",
      url: asString(existing.url),
      command: asArray(existing.command).filter((item): item is string => typeof item === "string").join(" "),
      cwd: asString(existing.cwd),
      enabled: existing.enabled !== false,
      timeout: existing.timeout !== undefined ? String(existing.timeout) : "",
      headers: JSON.stringify(asRecord(existing.headers), null, 2),
      environment: JSON.stringify(asRecord(existing.environment), null, 2),
      oauthClientId: asString(oauth.clientId),
      oauthClientSecret: asString(oauth.clientSecret),
      oauthScope: asString(oauth.scope),
      oauthCallbackPort:
        oauth.callbackPort !== undefined ? String(oauth.callbackPort) : "",
      oauthRedirectUri: asString(oauth.redirectUri),
    });
    setActionError(null);
  };

  const saveMcp = async () => {
    if (!mcpDraft) return;
    const name = mcpDraft.name.trim();
    if (!name) {
      setActionError("MCP 名称不能为空");
      return;
    }
    if (mcpDraft.type === "remote" && !mcpDraft.url.trim()) {
      setActionError("Remote MCP 必须填写 URL");
      return;
    }
    if (mcpDraft.type === "local" && !mcpDraft.command.trim()) {
      setActionError("Local MCP 必须填写启动命令");
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const existing = asRecord(configuredMcp[name]);
      const headers = parseJsonObject(mcpDraft.headers, "Headers");
      const environment = parseJsonObject(mcpDraft.environment, "Environment");
      const next: Record<string, unknown> = {
        type: mcpDraft.type,
        enabled: mcpDraft.enabled,
      };
      if (mcpDraft.type === "remote") {
        next.url = mcpDraft.url.trim();
        if (Object.keys(headers).length) next.headers = headers;
        const oauth = buildMcpOAuth(existing.oauth, mcpDraft);
        if (oauth !== undefined) next.oauth = oauth;
      } else {
        next.command = mcpDraft.command
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (mcpDraft.cwd.trim()) next.cwd = mcpDraft.cwd.trim();
        if (Object.keys(environment).length) next.environment = environment;
      }
      setOptionalPositiveInteger(next, "timeout", mcpDraft.timeout, "超时");
      const nextText = applyConfigChanges(editor.text, [
        { path: ["mcp", name], op: "set", value: next },
      ]);
      if (await editor.save(nextText)) {
        setMcpDraft(null);
        setMcpEditing(null);
        await refreshExtensions();
        await onRefreshConfig();
      }
    } catch (error) {
      setActionError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const deleteMcp = async (name: string) => {
    if (!window.confirm(`删除 MCP Server ${name}？`)) return;
    setActionError(null);
    try {
      const nextText = applyConfigChanges(editor.text, [
        { path: ["mcp", name], op: "delete" },
      ]);
      if (!(await editor.save(nextText))) return;
      await refreshExtensions();
      await onRefreshConfig();
    } catch (error) {
      setActionError(String(error));
    }
  };

  const authenticateMcp = async (name: string) => {
    if (!directory) return;
    setBusyMcp(name);
    setActionError(null);
    try {
      await api.mcpAuthenticate(directory, name);
      await refreshExtensions();
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusyMcp(null);
    }
  };

  const removeMcpAuth = async (name: string) => {
    if (!directory) return;
    setBusyMcp(name);
    setActionError(null);
    try {
      await api.mcpRemoveAuth(directory, name);
      await refreshExtensions();
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusyMcp(null);
    }
  };

  const setSkillsConfig = async (key: "paths" | "urls", items: string[]) => {
    const current = asRecord(configuredSkills);
    const next = {
      ...current,
      [key]: items,
    };
    if (items.length === 0) delete next[key];
    const nextText = applyConfigChanges(editor.text, [
      Object.keys(next).length
        ? { path: ["skills"], op: "set", value: next }
        : { path: ["skills"], op: "delete" },
    ]);
    if (await editor.save(nextText)) await onRefreshConfig();
  };

  const setPlugins = async (items: unknown[]) => {
    const nextText = applyConfigChanges(editor.text, [
      items.length
        ? { path: ["plugin"], op: "set", value: items }
        : { path: ["plugin"], op: "delete" },
    ]);
    if (await editor.save(nextText)) await onRefreshConfig();
  };

  return (
    <>
      <SettingsSection
        title="MCP"
        hint="配置会写入当前作用域；连接、断开和 OAuth 认证通过 CLI API 执行。"
        action={
          <button className="ghost-btn" onClick={() => openMcp()}>
            添加 MCP
          </button>
        }
      >
        {actionError && <div className="settings-inline-error">{actionError}</div>}
        {state === "loading" ? (
          <EmptyState>正在读取扩展状态…</EmptyState>
        ) : state === "error" ? (
          <EmptyState>无法读取 MCP 与 Skills 状态。</EmptyState>
        ) : !directory ? (
          <EmptyState>先从侧栏选择工作区，再查看 MCP 和 Skills。</EmptyState>
        ) : mcpRows.length === 0 ? (
          <EmptyState>没有配置 MCP Server。</EmptyState>
        ) : (
          mcpRows.map(({ name, status, error, configured }) => {
            const canConnect =
              status !== "connected" &&
              status !== "needs_auth" &&
              status !== "needs_client_registration";
            const configEntry = asRecord(configuredMcp[name]);
            return (
              <div className="settings-entity" key={name}>
                <div className="settings-entity-main">
                  <div className="settings-entity-title">
                    <span>{name}</span>
                    <Tag tone={mcpTone(status)}>{mcpLabel(status)}</Tag>
                    {configured && <Tag tone="ok">配置</Tag>}
                    {configEntry.enabled === false && <Tag tone="warn">已禁用</Tag>}
                  </div>
                  {error && (
                    <div className="settings-entity-error" title={error}>
                      {error}
                    </div>
                  )}
                </div>
                <div className="settings-entity-actions">
                  {configured && (
                    <>
                      <button className="ghost-btn" onClick={() => openMcp(name)}>
                        编辑
                      </button>
                      <button
                        className="ghost-btn danger-text"
                        onClick={() => void deleteMcp(name)}
                      >
                        删除
                      </button>
                    </>
                  )}
                  {status === "connected" ? (
                    <button
                      className="ghost-btn"
                      disabled={busyMcp === name}
                      onClick={() => void updateMcp(name, false)}
                    >
                      {busyMcp === name ? "处理中…" : "断开"}
                    </button>
                  ) : status === "needs_auth" ? (
                    <button
                      className="ghost-btn"
                      disabled={busyMcp === name}
                      onClick={() => void authenticateMcp(name)}
                    >
                      {busyMcp === name ? "认证中…" : "认证"}
                    </button>
                  ) : canConnect ? (
                    <button
                      className="ghost-btn"
                      disabled={busyMcp === name}
                      onClick={() => void updateMcp(name, true)}
                    >
                      {busyMcp === name ? "处理中…" : "重试连接"}
                    </button>
                  ) : (
                    <button
                      className="ghost-btn"
                      disabled={busyMcp === name}
                      onClick={() => void authenticateMcp(name)}
                    >
                      认证
                    </button>
                  )}
                  {(status === "connected" || status === "needs_auth") && (
                    <button
                      className="ghost-btn"
                      disabled={busyMcp === name}
                      onClick={() => void removeMcpAuth(name)}
                    >
                      移除认证
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </SettingsSection>

      <SettingsSection
        title="Skills"
        hint={`${enabledSkills} / ${skills.length} 已启用。启停会持久化到 CLI 的 Skill 偏好。`}
        action={
          <input
            className="settings-input settings-search"
            type="search"
            value={search}
            placeholder="搜索 Skill"
            onChange={(event) => setSearch(event.target.value)}
          />
        }
      >
        {state === "loading" ? (
          <EmptyState>正在读取 Skills…</EmptyState>
        ) : filteredSkills.length === 0 ? (
          <EmptyState>{search ? "没有匹配的 Skill。" : "未发现 Skill。"}</EmptyState>
        ) : (
          filteredSkills.map((skill) => (
            <div className="settings-entity settings-skill" key={`${skill.scope}:${skill.name}`}>
              <div className="settings-entity-main">
                <div className="settings-entity-title">
                  <span>{skill.name}</span>
                  <Tag tone="muted">{SCOPE_LABELS[skill.scope]}</Tag>
                  {!skill.enabled && <Tag tone="warn">已停用</Tag>}
                </div>
                {skill.description && (
                  <div className="settings-entity-description" title={skill.description}>
                    {skill.description}
                  </div>
                )}
                <div className="settings-entity-path" title={skill.location}>
                  {skill.location}
                </div>
              </div>
              <button
                className={`switch ${skill.enabled ? "on" : ""}`}
                disabled={busySkill === skill.name}
                onClick={() => void updateSkill(skill, !skill.enabled)}
                role="switch"
                aria-checked={skill.enabled}
                aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.name}`}
              >
                <span />
              </button>
            </div>
          ))
        )}
        <StringListEditor
          label="额外 Skill 路径"
          hint="写入当前作用域的 skills.paths"
          items={asArray(configuredSkills.paths).filter(
            (item): item is string => typeof item === "string",
          )}
          placeholder="~/.config/deveco/skills"
          onChange={(items) => void setSkillsConfig("paths", items)}
        />
        <StringListEditor
          label="额外 Skill URL"
          hint="写入当前作用域的 skills.urls"
          items={asArray(configuredSkills.urls).filter(
            (item): item is string => typeof item === "string",
          )}
          placeholder="https://example.com/.well-known/skills/"
          onChange={(items) => void setSkillsConfig("urls", items)}
        />
      </SettingsSection>

      <SettingsSection title="Plugins" hint="只编辑配置入口；npm 包仍需在外部安装。">
        <JsonFieldEditor
          label="Plugin 入口"
          hint="字符串或 [入口, 选项对象] 元组；写入当前作用域的 plugin 数组"
          value={editor.value.plugin ?? []}
          onApply={(next) => {
            const items = Array.isArray(next) ? next : [];
            void setPlugins(items);
          }}
        />
        {config && config.pluginNames.length > 0 && (
          <div className="settings-note">
            CLI 当前已加载：{config.pluginNames.join("、")}
          </div>
        )}
      </SettingsSection>

      {mcpDraft && (
        <FormModal
          title={mcpEditing ? `编辑 MCP · ${mcpEditing}` : "添加 MCP Server"}
          onClose={() => {
            setMcpDraft(null);
            setMcpEditing(null);
          }}
          onSave={() => void saveMcp()}
          saving={saving}
          saveLabel="保存并应用"
          error={actionError}
        >
          <TextField
            label="名称"
            value={mcpDraft.name}
            disabled={Boolean(mcpEditing)}
            onChange={(next) => setMcpDraft({ ...mcpDraft, name: next })}
          />
          <SelectField
            label="类型"
            value={mcpDraft.type}
            options={[
              { label: "Remote (HTTP)", value: "remote" },
              { label: "Local (stdio)", value: "local" },
            ]}
            onChange={(next) =>
              setMcpDraft({ ...mcpDraft, type: next as "remote" | "local" })
            }
          />
          {mcpDraft.type === "remote" ? (
            <TextField
              label="URL"
              value={mcpDraft.url}
              placeholder="https://mcp.example.com/mcp"
              onChange={(next) => setMcpDraft({ ...mcpDraft, url: next })}
            />
          ) : (
            <>
              <TextField
                label="启动命令"
                hint="参数用空格分隔"
                value={mcpDraft.command}
                placeholder="npx @playwright/mcp@latest"
                onChange={(next) => setMcpDraft({ ...mcpDraft, command: next })}
              />
              <TextField
                label="工作目录"
                hint="可选；Local MCP 的 cwd"
                value={mcpDraft.cwd}
                onChange={(next) => setMcpDraft({ ...mcpDraft, cwd: next })}
              />
            </>
          )}
          <Toggle
            label="启用"
            checked={mcpDraft.enabled}
            onChange={(next) => setMcpDraft({ ...mcpDraft, enabled: next })}
          />
          <TextField
            label="超时（毫秒）"
            value={mcpDraft.timeout}
            onChange={(next) => setMcpDraft({ ...mcpDraft, timeout: next })}
          />
          <TextAreaField
            label="Headers"
            hint="JSON 对象；Authorization 会被自动脱敏"
            value={mcpDraft.headers}
            onChange={(next) => setMcpDraft({ ...mcpDraft, headers: next })}
            rows={4}
          />
          <TextAreaField
            label="Environment"
            hint="JSON 对象；KEY/TOKEN/SECRET/PASSWORD 会被自动脱敏"
            value={mcpDraft.environment}
            onChange={(next) => setMcpDraft({ ...mcpDraft, environment: next })}
            rows={4}
          />
          <TextField
            label="OAuth Client ID"
            value={mcpDraft.oauthClientId}
            onChange={(next) => setMcpDraft({ ...mcpDraft, oauthClientId: next })}
          />
          <TextField
            label="OAuth Client Secret"
            type="password"
            value={mcpDraft.oauthClientSecret}
            onChange={(next) => setMcpDraft({ ...mcpDraft, oauthClientSecret: next })}
          />
          <TextField
            label="OAuth Scope"
            value={mcpDraft.oauthScope}
            onChange={(next) => setMcpDraft({ ...mcpDraft, oauthScope: next })}
          />
          <TextField
            label="OAuth Callback Port"
            hint="1-65535；留空使用 CLI 默认"
            value={mcpDraft.oauthCallbackPort}
            onChange={(next) =>
              setMcpDraft({ ...mcpDraft, oauthCallbackPort: next })
            }
          />
          <TextField
            label="OAuth Redirect URI"
            value={mcpDraft.oauthRedirectUri}
            onChange={(next) =>
              setMcpDraft({ ...mcpDraft, oauthRedirectUri: next })
            }
          />
        </FormModal>
      )}
    </>
  );
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim() || "{}");
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${String(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function parsePositiveInteger(raw: string, label: string, max?: number): number | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 必须是大于 0 的整数`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${label} 不能大于 ${max}`);
  }
  return parsed;
}

function setOptionalPositiveInteger(
  target: Record<string, unknown>,
  key: string,
  raw: string,
  label: string,
  max?: number,
) {
  const value = parsePositiveInteger(raw, label, max);
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function buildMcpOAuth(
  existing: unknown,
  draft: McpDraft,
): unknown {
  const hasDraft =
    draft.oauthClientId.trim() ||
    draft.oauthClientSecret.trim() ||
    draft.oauthScope.trim() ||
    draft.oauthCallbackPort.trim() ||
    draft.oauthRedirectUri.trim();
  if (!hasDraft) return existing;

  const next: Record<string, unknown> = { ...asRecord(existing) };
  if (draft.oauthClientId.trim()) next.clientId = draft.oauthClientId.trim();
  if (draft.oauthClientSecret.trim()) next.clientSecret = draft.oauthClientSecret.trim();
  if (draft.oauthScope.trim()) next.scope = draft.oauthScope.trim();
  if (draft.oauthRedirectUri.trim()) next.redirectUri = draft.oauthRedirectUri.trim();
  setOptionalPositiveInteger(next, "callbackPort", draft.oauthCallbackPort, "OAuth 回调端口", 65535);
  return next;
}
