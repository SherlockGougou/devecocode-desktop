import type { AgentInfo, CliConfigSummary } from "../../types";
import {
  EmptyState,
  Row,
  SettingsSection,
  Tag,
} from "./SettingsPrimitives";

export default function AgentPermissionsPage({
  config,
  agents,
  selectedAgent,
}: {
  config: CliConfigSummary | null;
  agents: AgentInfo[];
  selectedAgent: string;
}) {
  const defaultAgent = config?.default_agent || "build";
  const overrides = new Map((config?.agents ?? []).map((agent) => [agent.name, agent]));
  const permission = config?.permission;

  return (
    <>
      <SettingsSection
        title="Agent"
        hint="默认 Agent 来自 CLI 配置；当前会话选择仅在 Composer 中切换。"
      >
        <Row label="默认 Agent" value={defaultAgent} mono />
        <Row label="当前会话" value={selectedAgent || "未选择"} mono />
        {agents.length === 0 ? (
          <EmptyState>
            当前没有可展示的主 Agent。请先从侧栏选择一个工作区。
          </EmptyState>
        ) : (
          agents.map((agent) => {
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
              </div>
            );
          })
        )}
      </SettingsSection>

      <SettingsSection
        title="Agent 配置覆盖"
        hint="这些条目来自 deveco 配置，包括隐藏的专用 Agent。"
      >
        {!config || config.agents.length === 0 ? (
          <EmptyState>没有自定义 Agent 覆盖。</EmptyState>
        ) : (
          config.agents.map((agent) => (
            <div className="settings-entity" key={agent.name}>
              <div className="settings-entity-main">
                <div className="settings-entity-title">
                  <span>{agent.name}</span>
                  {agent.hidden && <Tag tone="muted">隐藏</Tag>}
                  {agent.disabled && <Tag tone="danger">禁用</Tag>}
                </div>
                <div className="settings-entity-meta">
                  {agent.description || agent.mode || "配置覆盖"}
                </div>
                {agent.model && (
                  <div className="settings-entity-sub">
                    {agent.model}
                    {agent.variant ? ` · ${agent.variant}` : ""}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </SettingsSection>

      <SettingsSection
        title="权限"
        hint="桌面端只展示当前配置摘要；具体规则仍由 deveco 配置管理。"
      >
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
        <Row
          label="UI 校验模型"
          value={config?.uiVerificationModel ?? "登录内置 / 未显式配置"}
          mono
        />
        <p className="settings-note">
          当前版本不在此处直接编辑权限规则，避免覆盖项目级配置；权限审批仍在会话内完成。
        </p>
      </SettingsSection>
    </>
  );
}

function permissionLabel(value: string): string {
  if (value === "allow") return "允许";
  if (value === "ask") return "询问";
  if (value === "deny") return "拒绝";
  return value;
}
