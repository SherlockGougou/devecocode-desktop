import { useEffect, useState } from "react";
import { api } from "../../api";
import type {
  AppConfig,
  CliConfigSummary,
  CliPathInfo,
  RuntimeInfo,
  ShellInfo,
} from "../../types";
import {
  EmptyState,
  Row,
  SettingsSection,
  Tag,
  Toggle,
  compactPath,
} from "./SettingsPrimitives";

export default function CliServicePage({
  draft,
  runtime,
  config,
  directory,
  detecting,
  onCliPathChange,
  onServerChange,
  onDetect,
}: {
  draft: AppConfig;
  runtime: RuntimeInfo | null;
  config: CliConfigSummary | null;
  directory: string | null;
  detecting: boolean;
  onCliPathChange: (value: string | null) => void;
  onServerChange: (patch: Partial<AppConfig["server"]>) => void;
  onDetect: () => void;
}) {
  const [paths, setPaths] = useState<CliPathInfo | null>(null);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void Promise.allSettled([
      api.cliPaths(directory ?? undefined),
      api.shells(directory ?? undefined),
    ]).then(([pathResult, shellResult]) => {
      if (cancelled) return;
      if (pathResult.status === "fulfilled") setPaths(pathResult.value);
      else setPaths(null);
      if (shellResult.status === "fulfilled") setShells(shellResult.value);
      else setShells([]);
      if (pathResult.status === "rejected" && shellResult.status === "rejected") {
        setError("无法读取 CLI 配置路径与 Shell 列表。");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [directory]);

  return (
    <>
      <SettingsSection
        title="CLI"
        hint="桌面端只保存可执行文件路径；其他配置以 deveco 的有效配置为准。"
      >
        <div className="settings-row">
          <div className="settings-label">
            <span>可执行文件路径</span>
            <small>留空则自动探测（配置 → 环境变量 → 常见路径 → login shell）</small>
          </div>
          <div className="settings-control inline">
            <input
              className="settings-input wide"
              value={draft.cli_path ?? ""}
              placeholder="自动探测"
              onChange={(event) => onCliPathChange(event.target.value || null)}
            />
            <button className="ghost-btn" onClick={onDetect} disabled={detecting}>
              {detecting ? "探测中…" : "自动探测"}
            </button>
          </div>
        </div>
        <Row label="运行版本" value={runtime?.cliVersion ?? "未知"} />
        <Row label="实际路径" value={runtime?.cliPath ?? "未找到"} mono />
        <Row label="服务地址" value={runtime?.baseUrl ?? "未就绪"} mono />
      </SettingsSection>

      <SettingsSection title="有效配置" hint="项目配置会覆盖全局配置。">
        <Row label="默认模型" value={config?.model ?? "未设置"} mono />
        <Row label="小模型" value={config?.small_model ?? "-"} mono />
        <Row label="默认 Agent" value={config?.default_agent ?? "build"} mono />
        <Row label="Shell" value={config?.shell ?? "自动"} mono />
        <Row label="用户标识" value={config?.username ?? "系统用户名"} />
        <div className="settings-inline-tags">
          <Tag>{config?.providerCount ?? 0} Provider 覆盖</Tag>
          <Tag>{config?.mcpCount ?? 0} MCP</Tag>
          <Tag>{config?.pluginCount ?? 0} Plugin</Tag>
          <Tag>{config?.skillSources.length ?? 0} Skill 来源</Tag>
        </div>
        {config?.skillSources.length ? (
          <div className="settings-path-list">
            {config.skillSources.map((source) => (
              <code key={source} title={source}>
                {source}
              </code>
            ))}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="配置来源">
        {error && <div className="settings-inline-error">{error}</div>}
        {!paths ? (
          <EmptyState>正在读取 CLI 路径信息…</EmptyState>
        ) : (
          <>
            <Row
              label="全局配置目录"
              value={compactPath(paths.config, paths.home)}
              mono
              title={paths.config}
            />
            <Row
              label="项目配置目录"
              value={compactPath(paths.projectConfig, paths.home)}
              mono
              title={paths.projectConfig}
            />
            <Row
              label="当前工作区"
              value={compactPath(paths.worktree, paths.home)}
              mono
              title={paths.worktree}
            />
            <div className="settings-actions">
              <button className="ghost-btn" onClick={() => void api.openPath(paths.config)}>
                打开全局配置目录
              </button>
              <button
                className="ghost-btn"
                onClick={() => void api.openPath(paths.projectConfig)}
              >
                打开项目配置目录
              </button>
            </div>
            <p className="settings-note">
              配置读取顺序：<code>.deveco/deveco.jsonc</code> →{' '}
              <code>deveco.jsonc</code> → 用户 <code>.config/deveco/deveco.jsonc</code>。
            </p>
          </>
        )}
      </SettingsSection>

      <SettingsSection title="可用 Shell">
        {shells.length === 0 ? (
          <EmptyState>没有读取到 Shell 列表。</EmptyState>
        ) : (
          <>
            <Row label="当前配置" value={config?.shell ?? "自动选择"} mono />
            <div className="settings-inline-tags">
              {shells.map((shell) => (
                <Tag
                  key={shell.path}
                  tone={
                    config?.shell === shell.path || config?.shell === shell.name
                      ? "ok"
                      : "muted"
                  }
                >
                  {shell.name}
                </Tag>
              ))}
            </div>
            <p className="settings-note">
              Shell 供 Agent 的终端与 Bash 工具使用；当前版本只读展示。
            </p>
          </>
        )}
      </SettingsSection>

      <SettingsSection title="本机服务" hint="这些选项属于桌面端启动参数，不写入 deveco 配置。">
        <div className="settings-row">
          <div className="settings-label">
            <span>端口偏好</span>
            <small>0 表示由应用挑空闲端口；固定端口便于复用已在运行的实例</small>
          </div>
          <div className="settings-control inline">
            <input
              className="settings-input narrow"
              type="number"
              min={0}
              max={65535}
              value={draft.server.preferred_port}
              onChange={(event) =>
                onServerChange({
                  preferred_port: Number(event.target.value) || 0,
                })
              }
            />
          </div>
        </div>
        <Toggle
          label="本地服务口令"
          hint="开启后 Rust 侧会生成随机口令保护 127.0.0.1 端口；需要重启生效"
          checked={Boolean(draft.server.secure)}
          onChange={(secure) => onServerChange({ secure })}
        />
      </SettingsSection>
    </>
  );
}
