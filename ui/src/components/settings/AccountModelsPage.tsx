import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { modelKey } from "../../models";
import { useApp } from "../../store";
import type {
  AuthEntry,
  CliConfigSummary,
  ModelInfo,
  ProviderOverview,
  QuotaWindow,
  StatsQuota,
  StatsUsage,
} from "../../types";
import {
  EmptyState,
  Row,
  SettingsSection,
  Tag,
  Toggle,
  formatCost,
  formatNumber,
  formatTokens,
} from "./SettingsPrimitives";

type LoadState = "loading" | "ready" | "error";

const SOURCE_LABELS: Record<string, string> = {
  config: "配置",
  api: "API Key",
  env: "环境变量",
  custom: "自定义",
};

function providerLabel(id: string): string {
  if (id === "deveco") return "DevEco Code";
  if (id === "github-copilot") return "GitHub Copilot";
  if (id === "openai") return "OpenAI";
  if (id === "gitlab") return "GitLab";
  return id;
}

function quotaLabel(name: string): string {
  if (name === "hourly") return "每小时";
  if (name === "weekly") return "每周";
  return "每月";
}

function quotaPercent(window: QuotaWindow): number | null {
  if (!window.total || window.total <= 0) return null;
  const used = window.used ?? Math.max(0, window.total - (window.remaining ?? window.total));
  return Math.min(100, Math.max(0, (used / window.total) * 100));
}

function resetLabel(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function totalTokens(usage: StatsUsage | null): number {
  if (!usage) return 0;
  const tokens = usage.total.tokens;
  return (
    tokens.input +
    tokens.output +
    tokens.reasoning +
    tokens.cache.read +
    tokens.cache.write
  );
}

export default function AccountModelsPage({
  directory,
  config,
}: {
  directory: string | null;
  config: CliConfigSummary | null;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [auth, setAuth] = useState<AuthEntry[]>([]);
  const [providers, setProviders] = useState<ProviderOverview | null>(null);
  const [quota, setQuota] = useState<StatsQuota | null>(null);
  const [usage, setUsage] = useState<StatsUsage | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const models = useApp((s) => s.models);
  const hiddenModels = useApp((s) => s.hiddenModels);
  const modelsLoading = useApp((s) => s.modelsLoading);
  const modelsError = useApp((s) => s.modelsError);
  const loadModels = useApp((s) => s.loadModels);
  const setModelVisible = useApp((s) => s.setModelVisible);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    const usageRequest = directory
      ? api.usage(directory, 30)
      : Promise.resolve<StatsUsage | null>(null);
    void Promise.allSettled([
      api.authEntries(),
      api.providerOverview(directory ?? undefined),
      api.quota(),
      usageRequest,
    ]).then(([authResult, providerResult, quotaResult, usageResult]) => {
      if (cancelled) return;
      if (authResult.status === "fulfilled") setAuth(authResult.value);
      else setAuth([]);
      if (providerResult.status === "fulfilled") setProviders(providerResult.value);
      else setProviders(null);
      if (quotaResult.status === "fulfilled") setQuota(quotaResult.value);
      else setQuota(null);
      if (usageResult.status === "fulfilled") setUsage(usageResult.value);
      else setUsage(null);
      setState(
        authResult.status === "rejected" &&
          providerResult.status === "rejected" &&
          quotaResult.status === "rejected" &&
          usageResult.status === "rejected"
          ? "error"
          : "ready",
      );
    });
    return () => {
      cancelled = true;
    };
  }, [directory]);

  const refresh = async () => {
    setRefreshing(true);
    setActionError(null);
    try {
      const [nextProviders] = await Promise.all([
        api.refreshProviders(directory ?? undefined),
        loadModels(true),
      ]);
      setProviders(nextProviders);
    } catch (error) {
      setActionError(String(error));
    } finally {
      setRefreshing(false);
    }
  };

  const quotaRows = (Object.entries(quota ?? {}) as Array<[string, QuotaWindow]>).filter(
    ([, window]) => window?.enabled,
  );
  const tokens = totalTokens(usage);
  const signedIn = auth.some((entry) => entry.providerID === "deveco");
  const realName = auth.find((entry) => entry.providerID === "deveco")?.isRealName;
  const verification = config?.uiVerificationModel
    ? `${config.uiVerificationModel}（显式配置）`
    : signedIn
      ? "Qwen3-VL（登录内置）"
      : "未配置";
  const hiddenModelKeys = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const providerNames = useMemo(
    () => new Map((providers?.providers ?? []).map((provider) => [provider.id, provider.name])),
    [providers],
  );
  const modelGroups = useMemo(() => {
    const grouped = new Map<string, ModelInfo[]>();
    for (const model of models) {
      const group = grouped.get(model.providerID) ?? [];
      group.push(model);
      grouped.set(model.providerID, group);
    }
    return [...grouped.entries()]
      .map(([providerID, items]) => ({
        providerID,
        name: providerNames.get(providerID) ?? providerLabel(providerID),
        items: items.sort((a, b) =>
          (a.name ?? a.id).localeCompare(b.name ?? b.id, "zh-CN"),
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [models, providerNames]);
  const visibleModelCount = models.filter(
    (model) => !hiddenModelKeys.has(modelKey(model.providerID, model.id)),
  ).length;

  return (
    <>
      <SettingsSection
        title="账号"
        hint="登录状态来自 deveco auth；桌面端不读取或展示凭据。"
      >
        {state === "loading" ? (
          <EmptyState>正在读取账号信息…</EmptyState>
        ) : state === "error" ? (
          <EmptyState>无法连接 CLI，账号与模型信息暂不可用。</EmptyState>
        ) : auth.length === 0 ? (
          <EmptyState>当前未登录。免费模型通道需要在 deveco 中完成华为账号登录。</EmptyState>
        ) : (
          auth.map((entry) => (
            <div className="settings-entity" key={entry.providerID}>
              <div className="settings-entity-main">
                <div className="settings-entity-title">
                  <span>{providerLabel(entry.providerID)}</span>
                  <Tag tone={entry.type === "oauth" ? "ok" : "muted"}>
                    {entry.type === "oauth" ? "OAuth" : entry.type}
                  </Tag>
                  {entry.isRealName && <Tag tone="ok">已实名</Tag>}
                </div>
                <div className="settings-entity-meta">
                  {entry.providerID}
                  {entry.removable ? " · 可在 CLI 中移除" : " · 由环境管理"}
                </div>
              </div>
            </div>
          ))
        )}
      </SettingsSection>

      <SettingsSection title="配额" hint="由 DevEco 网关返回的小时、周、月窗口。">
        {quotaRows.length === 0 ? (
          <EmptyState>当前账号没有返回可展示的配额窗口。</EmptyState>
        ) : (
          quotaRows.map(([name, window]) => {
            const percent = quotaPercent(window);
            const reset = resetLabel(window.nextResetTime);
            const used =
              window.used ??
              (window.total !== undefined && window.remaining !== undefined
                ? Math.max(0, window.total - window.remaining)
                : undefined);
            return (
              <div className="settings-quota" key={name}>
                <div className="settings-quota-head">
                  <span>{quotaLabel(name)}</span>
                  <span>
                    {used !== undefined && window.total !== undefined
                      ? `${formatNumber(used)} / ${formatNumber(window.total)} 已用`
                      : "已启用"}
                  </span>
                </div>
                {percent !== null && (
                  <div className="settings-meter">
                    <span style={{ width: `${percent}%` }} />
                  </div>
                )}
                <div className="settings-quota-meta">
                  {window.periodHours ? `${window.periodHours} 小时窗口` : "额度窗口"}
                  {window.remaining !== undefined
                    ? ` · 剩余 ${formatNumber(window.remaining)}`
                    : ""}
                  {reset ? ` · ${reset} 重置` : ""}
                </div>
              </div>
            );
          })
        )}
      </SettingsSection>

      <SettingsSection
        title="模型"
        hint="当前默认模型来自全局有效配置；项目内配置可能覆盖。"
      >
        <Row label="默认模型" value={config?.model ?? "未设置"} mono />
        <Row label="小模型" value={config?.small_model ?? "-"} mono />
        <Row label="UI 校验模型" value={verification} mono />
      </SettingsSection>

      <SettingsSection
        title="模型管理"
        hint="勾选后显示在输入框的模型菜单；取消勾选只影响本桌面端，不改 CLI 配置或当前会话。"
        action={
          modelsError ? (
            <button className="ghost-btn" onClick={() => void loadModels(true)}>
              重试
            </button>
          ) : (
            <Tag tone="muted">
              {visibleModelCount} / {models.length} 已勾选
            </Tag>
          )
        }
      >
        {modelsError && <div className="settings-inline-error">{modelsError}</div>}
        {modelsLoading && models.length === 0 ? (
          <EmptyState>正在读取可用模型…</EmptyState>
        ) : models.length === 0 ? (
          modelsError ? null : <EmptyState>当前没有可用模型。</EmptyState>
        ) : (
          modelGroups.map((group) => (
            <div className="settings-model-group" key={group.providerID}>
              <div className="settings-model-group-head">
                <span>{group.name}</span>
                <span>{group.items.length} 个模型</span>
              </div>
              {group.items.map((model) => {
                const name = model.name ?? model.id;
                const key = modelKey(model.providerID, model.id);
                return (
                  <Toggle
                    key={key}
                    label={name}
                    hint={name === model.id ? model.providerID : model.id}
                    checked={!hiddenModelKeys.has(key)}
                    onChange={(visible) =>
                      setModelVisible(
                        { providerID: model.providerID, modelID: model.id },
                        visible,
                      )
                    }
                  />
                );
              })}
            </div>
          ))
        )}
      </SettingsSection>

      <SettingsSection
        title="Provider"
        hint="仅展示来源和模型数量，不展示 API Key、Header 或环境变量值。"
        action={
          <button
            className="ghost-btn"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            {refreshing ? "刷新中…" : "刷新"}
          </button>
        }
      >
        {actionError && <div className="settings-inline-error">{actionError}</div>}
        {!providers || providers.providers.length === 0 ? (
          <EmptyState>未读取到 Provider。请先选择工作区并确认 CLI 已登录。</EmptyState>
        ) : (
          providers.providers.map((provider) => (
            <div className="settings-entity" key={provider.id}>
              <div className="settings-entity-main">
                <div className="settings-entity-title">
                  <span>{provider.name}</span>
                  {providers.default[provider.id] && (
                    <Tag tone="muted">默认 {providers.default[provider.id]}</Tag>
                  )}
                </div>
                <div className="settings-entity-meta">
                  {provider.id} · {provider.modelCount} 个模型
                </div>
              </div>
              <Tag tone={provider.source === "env" ? "warn" : "muted"}>
                {SOURCE_LABELS[provider.source ?? ""] ?? provider.source ?? "已连接"}
              </Tag>
            </div>
          ))
        )}
      </SettingsSection>

      <SettingsSection title="最近 30 天用量" hint="统计来自 CLI 本地消息数据。">
        {!usage || usage.total.sessions === 0 ? (
          <EmptyState>当前工作区还没有可统计的模型调用。</EmptyState>
        ) : (
          <>
            <Row label="会话 / 消息" value={`${usage.total.sessions} / ${usage.total.messages}`} />
            <Row label="Token" value={formatTokens(tokens)} />
            <Row label="成本" value={formatCost(usage.total.cost)} />
            {usage.models.slice(0, 5).map((model) => (
              <Row
                key={`${model.providerID}/${model.modelID}`}
                label={model.modelID}
                value={`${model.messages} 次 · ${formatTokens(
                  model.tokens.input +
                    model.tokens.output +
                    model.tokens.reasoning +
                    model.tokens.cache.read +
                    model.tokens.cache.write,
                )} token`}
                mono
              />
            ))}
          </>
        )}
      </SettingsSection>
    </>
  );
}
