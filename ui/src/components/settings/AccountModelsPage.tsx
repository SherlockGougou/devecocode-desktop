import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { applyConfigChanges, asArray, asRecord, asString } from "../../cliConfig";
import { modelKey } from "../../models";
import { useApp } from "../../store";
import type {
  AuthEntry,
  CliConfigSummary,
  ModelInfo,
  ProductAgreement,
  ProviderAuthAuthorization,
  ProviderAuthMethods,
  ProviderOverview,
  QuotaWindow,
  StatsQuota,
  StatsUsage,
} from "../../types";
import {
  EmptyState,
  FormModal,
  JsonFieldEditor,
  Row,
  SelectField,
  SettingsSection,
  Tag,
  TextField,
  Toggle,
  formatCost,
  formatNumber,
  formatTokens,
} from "./SettingsPrimitives";
import type { CliConfigEditor } from "./useCliConfigEditor";

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

type ProviderDraft = {
  id: string;
  name: string;
  npm: string;
  baseURL: string;
  apiKey: string;
  modelID: string;
  context: string;
  output: string;
};

const EMPTY_PROVIDER: ProviderDraft = {
  id: "",
  name: "",
  npm: "@ai-sdk/openai-compatible",
  baseURL: "",
  apiKey: "",
  modelID: "",
  context: "",
  output: "",
};

export default function AccountModelsPage({
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
  const [auth, setAuth] = useState<AuthEntry[]>([]);
  const [providers, setProviders] = useState<ProviderOverview | null>(null);
  const [quota, setQuota] = useState<StatsQuota | null>(null);
  const [usage, setUsage] = useState<StatsUsage | null>(null);
  const [authMethods, setAuthMethods] = useState<ProviderAuthMethods>({});
  const [agreement, setAgreement] = useState<ProductAgreement | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState<string | null>(null);
  const [authDialog, setAuthDialog] = useState<string | null>(null);
  const [authMethodIndex, setAuthMethodIndex] = useState(0);
  const [authInputs, setAuthInputs] = useState<Record<string, string>>({});
  const [authAuthorization, setAuthAuthorization] =
    useState<ProviderAuthAuthorization | null>(null);
  const [authCode, setAuthCode] = useState("");
  const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(null);
  const [providerEditing, setProviderEditing] = useState<string | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
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
      api.providerAuthMethods(directory ?? undefined),
      api.productAgreement(),
    ]).then(([authResult, providerResult, quotaResult, usageResult, methodResult, agreementResult]) => {
      if (cancelled) return;
      if (authResult.status === "fulfilled") setAuth(authResult.value);
      else setAuth([]);
      if (providerResult.status === "fulfilled") setProviders(providerResult.value);
      else setProviders(null);
      if (quotaResult.status === "fulfilled") setQuota(quotaResult.value);
      else setQuota(null);
      if (usageResult.status === "fulfilled") setUsage(usageResult.value);
      else setUsage(null);
      if (methodResult.status === "fulfilled") setAuthMethods(methodResult.value);
      else setAuthMethods({});
      if (agreementResult.status === "fulfilled") setAgreement(agreementResult.value);
      else setAgreement(null);
      setState(
        authResult.status === "rejected" &&
          providerResult.status === "rejected" &&
          quotaResult.status === "rejected" &&
          usageResult.status === "rejected" &&
          methodResult.status === "rejected"
          ? "error"
          : "ready",
      );
    });
    return () => {
      cancelled = true;
    };
  }, [directory]);

  useEffect(() => {
    if (!authDialog || authAuthorization?.method !== "auto") return;
    let cancelled = false;
    const poll = window.setInterval(async () => {
      try {
        const entries = await api.authEntries();
        if (!cancelled && entries.some((entry) => entry.providerID === authDialog)) {
          setAuthDialog(null);
          setAuthAuthorization(null);
          await refreshAuth();
          await loadModels(true);
        }
      } catch {
        // 轮询失败不覆盖 OAuth 弹窗里的错误
      }
    }, 2000);
    const timeout = window.setTimeout(() => {
      if (!cancelled) setActionError("登录等待超时，可以在浏览器完成后再刷新账号。");
    }, 120_000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearTimeout(timeout);
    };
  }, [authAuthorization, authDialog, loadModels]);

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

  const refreshAuth = async () => {
    const [nextAuth, nextMethods, nextAgreement, nextProviders] = await Promise.all([
      api.authEntries(),
      api.providerAuthMethods(directory ?? undefined),
      api.productAgreement(),
      api.providerOverview(directory ?? undefined),
    ]);
    setAuth(nextAuth);
    setAuthMethods(nextMethods);
    setAgreement(nextAgreement);
    setProviders(nextProviders);
  };

  const beginAuth = (providerID: string) => {
    setAuthDialog(providerID);
    setAuthMethodIndex(0);
    setAuthInputs({});
    setAuthAuthorization(null);
    setAuthCode("");
    setActionError(null);
  };

  const loginProvider = authDialog;
  const loginMethods = loginProvider ? authMethods[loginProvider] ?? [] : [];
  const loginMethod = loginMethods[authMethodIndex];

  const submitAuth = async () => {
    if (!loginProvider || !loginMethod) return;
    setAuthBusy(loginProvider);
    setActionError(null);
    try {
      if (loginMethod.type === "api") {
        const key = authInputs.key?.trim() ?? "";
        if (!key) throw new Error("请输入 API Key");
        const metadata: Record<string, string> = {};
        for (const prompt of loginMethod.prompts ?? []) {
          if (prompt.key !== "key" && authInputs[prompt.key]) {
            metadata[prompt.key] = authInputs[prompt.key];
          }
        }
        await api.setProviderApiKey(loginProvider, key, metadata);
        setAuthDialog(null);
        await refreshAuth();
        await loadModels(true);
      } else {
        const result = await api.providerOAuthAuthorize(
          loginProvider,
          authMethodIndex,
          authInputs,
        );
        setAuthAuthorization(result);
        await api.openUrl(result.url);
      }
    } catch (error) {
      setActionError(String(error));
    } finally {
      setAuthBusy(null);
    }
  };

  const submitAuthCode = async () => {
    if (!loginProvider || !loginMethod) return;
    setAuthBusy(loginProvider);
    setActionError(null);
    try {
      if (!(authAuthorization?.method === "auto" && !authCode.trim())) {
        await api.providerOAuthCallback(
          loginProvider,
          authMethodIndex,
          authCode.trim() || undefined,
        );
      }
      setAuthDialog(null);
      setAuthAuthorization(null);
      await refreshAuth();
      await loadModels(true);
    } catch (error) {
      setActionError(String(error));
    } finally {
      setAuthBusy(null);
    }
  };

  const logout = async (providerID: string) => {
    if (!window.confirm(`退出 ${providerID} 的登录？`)) return;
    setAuthBusy(providerID);
    setActionError(null);
    try {
      await api.removeProviderAuth(providerID);
      await refreshAuth();
    } catch (error) {
      setActionError(String(error));
    } finally {
      setAuthBusy(null);
    }
  };

  const acceptAgreement = async () => {
    setActionError(null);
    try {
      setAgreement(await api.acceptProductAgreement());
    } catch (error) {
      setActionError(String(error));
    }
  };

  const openProviderForm = (providerID?: string) => {
    const existing = asRecord(asRecord(editor.value.provider)[providerID ?? ""]);
    const models = asRecord(existing.models);
    const firstModel = Object.entries(models)[0];
    const model = asRecord(firstModel?.[1]);
    const limit = asRecord(model.limit);
    setProviderEditing(providerID ?? null);
    setProviderDraft({
      id: providerID ?? "",
      name: asString(existing.name) || providerID || "",
      npm: asString(existing.npm) || "@ai-sdk/openai-compatible",
      baseURL: asString(asRecord(existing.options).baseURL),
      apiKey: "",
      modelID: firstModel?.[0] ?? "",
      context: limit.context !== undefined ? String(limit.context) : "",
      output: limit.output !== undefined ? String(limit.output) : "",
    });
  };

  const saveProvider = async () => {
    if (!providerDraft) return;
    const id = providerDraft.id.trim();
    if (!id) {
      setActionError("Provider ID 不能为空");
      return;
    }
    setProviderSaving(true);
    setActionError(null);
    try {
      const providers = asRecord(editor.value.provider);
      const existing = asRecord(providers[id]);
      const options = asRecord(existing.options);
      const nextOptions: Record<string, unknown> = {
        ...options,
        ...(providerDraft.baseURL.trim()
          ? { baseURL: providerDraft.baseURL.trim() }
          : {}),
        ...(providerDraft.apiKey.trim() ? { apiKey: providerDraft.apiKey.trim() } : {}),
      };
      const models = asRecord(existing.models);
      const nextModels: Record<string, unknown> = { ...models };
      if (providerDraft.modelID.trim()) {
        const modelID = providerDraft.modelID.trim();
        const previous = asRecord(models[modelID]);
        const context = Number(providerDraft.context);
        const output = Number(providerDraft.output);
        nextModels[modelID] = {
          ...previous,
          name: modelID,
          ...(Number.isFinite(context) || Number.isFinite(output)
            ? {
                limit: {
                  context: Number.isFinite(context) ? context : 1000000,
                  output: Number.isFinite(output) ? output : 8192,
                },
              }
            : {}),
        };
      }
      const nextProvider = {
        ...existing,
        name: providerDraft.name.trim() || id,
        npm: providerDraft.npm.trim() || "@ai-sdk/openai-compatible",
        options: nextOptions,
        ...(Object.keys(nextModels).length ? { models: nextModels } : {}),
      };
      const nextText = applyConfigChanges(editor.text, [
        { path: ["provider", id], op: "set", value: nextProvider },
      ]);
      if (await editor.save(nextText)) {
        setProviderDraft(null);
        setProviderEditing(null);
        await onRefreshConfig();
      }
    } catch (error) {
      setActionError(String(error));
    } finally {
      setProviderSaving(false);
    }
  };

  const deleteProvider = async (providerID: string) => {
    if (!window.confirm(`删除 Provider ${providerID} 及其配置？`)) return;
    setActionError(null);
    try {
      await api.deleteProvider(providerID, directory ?? undefined);
      await onRefreshConfig();
      await refreshAuth();
    } catch (error) {
      setActionError(String(error));
    }
  };

  const deleteModel = async (providerID: string, modelID: string) => {
    if (!window.confirm(`删除模型 ${providerID}/${modelID}？`)) return;
    setActionError(null);
    try {
      await api.deleteProviderModel(providerID, modelID, directory ?? undefined);
      await onRefreshConfig();
    } catch (error) {
      setActionError(String(error));
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
  const providerRows = useMemo(() => {
    const configured = asRecord(editor.value.provider);
    const rows = new Map<
      string,
      { id: string; name: string; modelCount: number; source?: string; configured: boolean }
    >();
    for (const provider of providers?.providers ?? []) {
      rows.set(provider.id, {
        id: provider.id,
        name: provider.name,
        modelCount: provider.modelCount,
        source: provider.source,
        configured: Boolean(configured[provider.id]),
      });
    }
    for (const [id, raw] of Object.entries(configured)) {
      const provider = asRecord(raw);
      rows.set(id, {
        id,
        name: asString(provider.name) || id,
        modelCount: Object.keys(asRecord(provider.models)).length,
        source: "config",
        configured: true,
      });
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [editor.value.provider, providers]);

  return (
    <>
      <SettingsSection
        title="账号"
        hint="登录状态来自 deveco auth；桌面端只保存 OAuth/API Key，不展示凭据。"
      >
        {agreement && (
          <div className="settings-entity">
            <div className="settings-entity-main">
              <div className="settings-entity-title">
                <span>产品协议</span>
                <Tag tone={agreement.accepted ? "ok" : "warn"}>
                  {agreement.accepted ? "已接受" : "未接受"}
                </Tag>
                <Tag tone="muted">版本 {agreement.version}</Tag>
              </div>
              <div className="settings-entity-meta">
                {agreement.upload?.state
                  ? `上传状态：${agreement.upload.state}`
                  : "接受后才能使用内置模型与云端能力"}
              </div>
            </div>
            <div className="settings-entity-actions">
              <button className="ghost-btn" onClick={() => void api.openUrl(agreement.termsUrl)}>
                条款
              </button>
              <button className="ghost-btn" onClick={() => void api.openUrl(agreement.privacyUrl)}>
                隐私
              </button>
              {!agreement.accepted && (
                <button className="ghost-btn" onClick={() => void acceptAgreement()}>
                  接受
                </button>
              )}
              {agreement.accepted && agreement.upload?.state !== "uploaded" && (
                <button
                  className="ghost-btn"
                  onClick={() =>
                    void api.retryAgreementUpload().then(setAgreement).catch((error) =>
                      setActionError(String(error)),
                    )
                  }
                >
                  重试上传
                </button>
              )}
            </div>
          </div>
        )}
        {actionError && <div className="settings-inline-error">{actionError}</div>}
        {state === "loading" ? (
          <EmptyState>正在读取账号信息…</EmptyState>
        ) : state === "error" ? (
          <EmptyState>无法连接 CLI，账号与模型信息暂不可用。</EmptyState>
        ) : auth.length === 0 ? (
          <EmptyState>当前未登录。免费模型通道需要完成华为账号登录。</EmptyState>
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
                  {entry.removable ? " · 可在此处退出登录" : " · 由环境管理"}
                </div>
              </div>
              {entry.removable && (
                <div className="settings-entity-actions">
                  <button
                    className="ghost-btn"
                    disabled={authBusy === entry.providerID}
                    onClick={() => void logout(entry.providerID)}
                  >
                    {authBusy === entry.providerID ? "处理中…" : "退出"}
                  </button>
                </div>
              )}
            </div>
          ))
        )}
        <div className="settings-actions">
          <button
            className="ghost-btn"
            onClick={() => beginAuth("deveco")}
            disabled={!authMethods.deveco?.length}
          >
            登录华为账号
          </button>
          <button className="ghost-btn" onClick={() => void refreshAuth()}>
            刷新账号
          </button>
        </div>
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
        hint="默认值写入当前配置范围；项目配置会覆盖全局配置。"
      >
        <SelectField
          label="默认模型"
          hint="Composer 没有显式选择时使用"
          value={asString(editor.value.model)}
          options={[
            { label: "继承 / 未设置", value: "" },
            ...allModelOptions(models),
          ]}
          onChange={(next) =>
            editor.applyChanges([
              next
                ? { path: ["model"], op: "set", value: next }
                : { path: ["model"], op: "delete" },
            ])
          }
        />
        <SelectField
          label="小模型"
          hint="标题、摘要等轻任务使用"
          value={asString(editor.value.small_model)}
          options={[
            { label: "继承 / 未设置", value: "" },
            ...allModelOptions(models),
          ]}
          onChange={(next) =>
            editor.applyChanges([
              next
                ? { path: ["small_model"], op: "set", value: next }
                : { path: ["small_model"], op: "delete" },
            ])
          }
        />
        <SelectField
          label="UI 校验模型"
          hint="仅用于界面检查；未设置时使用登录内置模型"
          value={asString(
            asRecord(asRecord(editor.value.agent).ui_verification).model,
          )}
          options={[
            { label: "继承 / 未设置", value: "" },
            ...allModelOptions(models),
          ]}
          onChange={(next) =>
            editor.applyChanges(
              next
                ? [
                    {
                      path: ["agent", "ui_verification", "model"],
                      op: "set",
                      value: next,
                    },
                  ]
                : [{ path: ["agent", "ui_verification", "model"], op: "delete" }],
            )
          }
        />
        <Row label="有效值" value={verification} mono />
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
        hint="可在当前配置范围添加自定义 Provider；API Key 默认写入脱敏配置。"
        action={
          <div className="settings-actions">
            <button className="ghost-btn" onClick={() => openProviderForm()}>
              添加
            </button>
            <button className="ghost-btn" onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? "刷新中…" : "刷新"}
            </button>
          </div>
        }
      >
        {actionError && <div className="settings-inline-error">{actionError}</div>}
        {providerRows.length === 0 ? (
          <EmptyState>未读取到 Provider。请先选择工作区并确认 CLI 已登录。</EmptyState>
        ) : (
          providerRows.map((provider) => (
            <div className="settings-entity" key={provider.id}>
              <div className="settings-entity-main">
                <div className="settings-entity-title">
                  <span>{provider.name}</span>
                  {providers?.default[provider.id] && (
                    <Tag tone="muted">默认 {providers.default[provider.id]}</Tag>
                  )}
                  {provider.configured && <Tag tone="ok">配置</Tag>}
                </div>
                <div className="settings-entity-meta">
                  {provider.id} · {provider.modelCount} 个模型
                </div>
              </div>
              <div className="settings-entity-actions">
                {provider.configured && (
                  <>
                    <button className="ghost-btn" onClick={() => openProviderForm(provider.id)}>
                      编辑
                    </button>
                    <button
                      className="ghost-btn danger-text"
                      onClick={() => void deleteProvider(provider.id)}
                    >
                      删除
                    </button>
                  </>
                )}
                {authMethods[provider.id]?.length > 0 && (
                  <button className="ghost-btn" onClick={() => beginAuth(provider.id)}>
                    登录
                  </button>
                )}
                <Tag tone={provider.source === "env" ? "warn" : "muted"}>
                  {SOURCE_LABELS[provider.source ?? ""] ?? provider.source ?? "已连接"}
                </Tag>
              </div>
            </div>
          ))
        )}
        {Object.keys(authMethods).filter((id) => id !== "deveco").length > 0 && (
          <div className="settings-note">
            可登录的 Provider：{" "}
            {Object.keys(authMethods)
              .filter((id) => id !== "deveco")
              .slice(0, 8)
              .join("、")}
            {Object.keys(authMethods).filter((id) => id !== "deveco").length > 8 ? " 等" : ""}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="自定义模型"
        hint="删除只影响当前配置中的 Provider 模型；内置模型保持只读。"
      >
        {providerRows.filter((provider) => provider.configured).length === 0 ? (
          <EmptyState>当前作用域还没有自定义 Provider。</EmptyState>
        ) : (
          providerRows
            .filter((provider) => provider.configured)
            .map((provider) => {
              const entry = asRecord(asRecord(editor.value.provider)[provider.id]);
              const modelEntries = Object.entries(asRecord(entry.models));
              return (
                <div key={provider.id} className="settings-model-group">
                  <div className="settings-model-group-head">
                    <span>{provider.name}</span>
                    <span>{modelEntries.length} 个模型</span>
                  </div>
                  {modelEntries.length === 0 ? (
                    <EmptyState>还没有模型，编辑 Provider 时添加。</EmptyState>
                  ) : (
                    modelEntries.map(([modelID, raw]) => {
                      const model = asRecord(raw);
                      return (
                        <div className="settings-entity" key={`${provider.id}-${modelID}`}>
                          <div className="settings-entity-main">
                            <div className="settings-entity-title">
                              <span>{asString(model.name) || modelID}</span>
                              <Tag tone="muted">配置</Tag>
                            </div>
                            <div className="settings-entity-meta">{modelID}</div>
                          </div>
                          <button
                            className="ghost-btn danger-text"
                            onClick={() => void deleteModel(provider.id, modelID)}
                          >
                            删除
                          </button>
                        </div>
                      );
                    })
                  )}
                  <JsonFieldEditor
                    label="Provider 完整 JSON"
                    hint="可编辑 api/env/whitelist/blacklist/options/models 等全部字段"
                    value={entry}
                    onApply={(next) =>
                      editor.applyChanges([
                        { path: ["provider", provider.id], op: "set", value: next },
                      ])
                    }
                  />
                </div>
              );
            })
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

      {loginProvider && (
        <FormModal
          title={`${providerLabel(loginProvider)} 登录`}
          onClose={() => {
            setAuthDialog(null);
            setAuthAuthorization(null);
            setAuthCode("");
          }}
          onSave={() =>
            authAuthorization ? void submitAuthCode() : void submitAuth()
          }
          saving={authBusy === loginProvider}
          saveLabel={authAuthorization ? "完成登录" : "继续"}
          error={actionError}
        >
          {!authAuthorization ? (
            <>
              {loginMethods.length > 1 && (
                <SelectField
                  label="登录方式"
                  value={String(authMethodIndex)}
                  options={loginMethods.map((method, index) => ({
                    label: `${method.label}${method.type === "oauth" ? "（浏览器）" : "（API Key）"}`,
                    value: String(index),
                  }))}
                  onChange={(next) => {
                    setAuthMethodIndex(Number(next));
                    setAuthInputs({});
                  }}
                />
              )}
              {loginMethod?.type === "api" ? (
                <TextField
                  label="API Key"
                  type="password"
                  value={authInputs.key ?? ""}
                  placeholder="粘贴 Provider API Key"
                  onChange={(next) => setAuthInputs((current) => ({ ...current, key: next }))}
                />
              ) : (
                <p className="settings-note">
                  点击“继续”会打开浏览器完成 OAuth；完成后回到这里确认。
                </p>
              )}
              {(loginMethod?.prompts ?? [])
                .filter(
                  (prompt) =>
                    !prompt.when ||
                    (prompt.when.op === "eq"
                      ? authInputs[prompt.when.key] === prompt.when.value
                      : authInputs[prompt.when.key] !== prompt.when.value),
                )
                .map((prompt) =>
                  prompt.type === "select" ? (
                    <SelectField
                      key={prompt.key}
                      label={prompt.message}
                      value={authInputs[prompt.key] ?? ""}
                      options={[
                        { label: "请选择", value: "" },
                        ...(prompt.options ?? []).map((option) => ({
                          label: option.hint ? `${option.label} — ${option.hint}` : option.label,
                          value: option.value,
                        })),
                      ]}
                      onChange={(next) =>
                        setAuthInputs((current) => ({ ...current, [prompt.key]: next }))
                      }
                    />
                  ) : (
                    <TextField
                      key={prompt.key}
                      label={prompt.message}
                      value={authInputs[prompt.key] ?? ""}
                      placeholder={prompt.placeholder}
                      onChange={(next) =>
                        setAuthInputs((current) => ({ ...current, [prompt.key]: next }))
                      }
                    />
                  ),
                )}
            </>
          ) : (
            <>
              <p className="settings-note">{authAuthorization.instructions}</p>
              <div className="settings-actions">
                <button
                  className="ghost-btn"
                  onClick={() => void api.openUrl(authAuthorization.url)}
                >
                  重新打开浏览器
                </button>
              </div>
              {authAuthorization.method === "code" ? (
                <TextField
                  label="授权码"
                  value={authCode}
                  placeholder="粘贴浏览器返回的 code"
                  onChange={setAuthCode}
                />
              ) : (
                <p className="settings-note">
                  浏览器完成登录后，应用会自动轮询账号状态；也可以直接点击“完成登录”。
                </p>
              )}
            </>
          )}
        </FormModal>
      )}

      {providerDraft && (
        <FormModal
          title={providerEditing ? `编辑 Provider · ${providerEditing}` : "添加 Provider"}
          onClose={() => {
            setProviderDraft(null);
            setProviderEditing(null);
          }}
          onSave={() => void saveProvider()}
          saving={providerSaving}
          saveLabel={providerEditing ? "保存并应用" : "添加并应用"}
          error={actionError}
        >
          <TextField
            label="Provider ID"
            hint="用于 model 引用，例如 myprovider"
            value={providerDraft.id}
            disabled={Boolean(providerEditing)}
            onChange={(next) => setProviderDraft({ ...providerDraft, id: next })}
          />
          <TextField
            label="显示名称"
            value={providerDraft.name}
            onChange={(next) => setProviderDraft({ ...providerDraft, name: next })}
          />
          <TextField
            label="npm 包"
            hint="OpenAI 兼容服务通常保持默认"
            value={providerDraft.npm}
            onChange={(next) => setProviderDraft({ ...providerDraft, npm: next })}
          />
          <TextField
            label="Base URL"
            value={providerDraft.baseURL}
            placeholder="https://api.example.com/v1"
            onChange={(next) => setProviderDraft({ ...providerDraft, baseURL: next })}
          />
          <TextField
            label="API Key"
            hint="留空保留已有密钥；新 Provider 留空则稍后通过登录写入"
            type="password"
            value={providerDraft.apiKey}
            onChange={(next) => setProviderDraft({ ...providerDraft, apiKey: next })}
          />
          <TextField
            label="模型 ID"
            hint="例如 gpt-4o 或 group/qoder"
            value={providerDraft.modelID}
            onChange={(next) => setProviderDraft({ ...providerDraft, modelID: next })}
          />
          <TextField
            label="上下文窗口"
            value={providerDraft.context}
            placeholder="1000000"
            onChange={(next) => setProviderDraft({ ...providerDraft, context: next })}
          />
          <TextField
            label="最大输出"
            value={providerDraft.output}
            placeholder="8192"
            onChange={(next) => setProviderDraft({ ...providerDraft, output: next })}
          />
        </FormModal>
      )}
    </>
  );
}

function allModelOptions(models: ModelInfo[]): Array<{ label: string; value: string }> {
  const seen = new Set<string>();
  return models
    .map((model) => ({
      label: `${model.name ?? model.id} · ${model.providerID}`,
      value: `${model.providerID}/${model.id}`,
    }))
    .filter((option) => {
      if (seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    })
    .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}
