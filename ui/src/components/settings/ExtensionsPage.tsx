import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type { CliConfigSummary, McpServerInfo, SkillStatus } from "../../types";
import { EmptyState, SettingsSection, Tag } from "./SettingsPrimitives";

type LoadState = "loading" | "ready" | "error";

const SCOPE_LABELS: Record<SkillStatus["scope"], string> = {
  global: "全局",
  project: "项目",
  builtin: "内置",
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
}: {
  directory: string | null;
  config: CliConfigSummary | null;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [mcp, setMcp] = useState<Record<string, McpServerInfo>>({});
  const [skills, setSkills] = useState<SkillStatus[]>([]);
  const [search, setSearch] = useState("");
  const [busyMcp, setBusyMcp] = useState<string | null>(null);
  const [busySkill, setBusySkill] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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

  return (
    <>
      <SettingsSection
        title="MCP"
        hint="展示当前工作区的连接状态；新增、删除和 OAuth 认证仍在 deveco CLI 中完成。"
      >
        {actionError && <div className="settings-inline-error">{actionError}</div>}
        {state === "loading" ? (
          <EmptyState>正在读取扩展状态…</EmptyState>
        ) : state === "error" ? (
          <EmptyState>无法读取 MCP 与 Skills 状态。</EmptyState>
        ) : !directory ? (
          <EmptyState>先从侧栏选择工作区，再查看 MCP 和 Skills。</EmptyState>
        ) : mcpEntries.length === 0 ? (
          <EmptyState>没有配置 MCP Server。</EmptyState>
        ) : (
          mcpEntries.map(([name, server]) => {
            const canConnect =
              server.status !== "connected" &&
              server.status !== "needs_auth" &&
              server.status !== "needs_client_registration";
            return (
              <div className="settings-entity" key={name}>
                <div className="settings-entity-main">
                  <div className="settings-entity-title">
                    <span>{name}</span>
                    <Tag tone={mcpTone(server.status)}>{mcpLabel(server.status)}</Tag>
                  </div>
                  {server.error && (
                    <div className="settings-entity-error" title={server.error}>
                      {server.error}
                    </div>
                  )}
                </div>
                <div className="settings-entity-actions">
                  {server.status === "connected" ? (
                    <button
                      className="ghost-btn"
                      disabled={busyMcp === name}
                      onClick={() => void updateMcp(name, false)}
                    >
                      {busyMcp === name ? "处理中…" : "断开"}
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
                    <span className="settings-action-hint">需在 CLI 认证</span>
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
      </SettingsSection>

      <SettingsSection title="Plugins" hint="只展示已加载的插件入口，不提供在线安装。">
        {!config || config.pluginNames.length === 0 ? (
          <EmptyState>没有配置 Plugin。</EmptyState>
        ) : (
          config.pluginNames.map((plugin) => (
            <div className="settings-entity" key={plugin}>
              <div className="settings-entity-main">
                <div className="settings-entity-title">
                  <span>{plugin}</span>
                </div>
                <div className="settings-entity-meta">由 deveco 配置加载</div>
              </div>
            </div>
          ))
        )}
      </SettingsSection>
    </>
  );
}
