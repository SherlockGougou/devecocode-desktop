import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import {
  asArray,
  asBoolean,
  asRecord,
  asString,
  formatCliConfig,
  type CliConfigChange,
} from "../../cliConfig";
import type {
  AgentInfo,
  CliBackupInfo,
  CliConfigSources,
  ShellInfo,
} from "../../types";
import type { CliConfigEditor } from "./useCliConfigEditor";
import {
  EmptyState,
  JsonFieldEditor,
  Row,
  SelectField,
  SettingsSection,
  StringListEditor,
  Tag,
  TextAreaField,
  TextField,
  Toggle,
  compactPath,
} from "./SettingsPrimitives";

const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"];

export default function CliConfigPage({
  editor,
  sources,
  shells,
  agents,
  onOpenPath,
}: {
  editor: CliConfigEditor;
  sources: CliConfigSources | null;
  shells: ShellInfo[];
  agents: AgentInfo[];
  onOpenPath: (path: string) => void;
}) {
  const [backups, setBackups] = useState<CliBackupInfo[]>([]);
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [rawNotice, setRawNotice] = useState<string | null>(null);
  const value = editor.value;
  const scope = editor.snapshot?.scope ?? "global";
  const directory = scope === "project" ? sources?.worktree ?? null : null;

  const set = useCallback(
    (path: Array<string | number>, next: unknown) => {
      editor.applyChanges([{ path, op: "set", value: next }]);
    },
    [editor],
  );
  const remove = useCallback(
    (path: Array<string | number>) => {
      editor.applyChanges([{ path, op: "delete" }]);
    },
    [editor],
  );
  const setOptional = useCallback(
    (path: Array<string | number>, next: string) => {
      if (next.trim()) set(path, next);
      else remove(path);
    },
    [remove, set],
  );
  const setSkillsField = useCallback(
    (key: "paths" | "urls", items: string[]) => {
      const current = asRecord(value.skills);
      const next = { ...current, [key]: items };
      if (items.length === 0) delete next[key];
      if (Object.keys(next).length === 0) remove(["skills"]);
      else set(["skills"], next);
    },
    [remove, set, value.skills],
  );
  const changes = useCallback(
    (next: CliConfigChange[]) => editor.applyChanges(next),
    [editor],
  );

  const loadBackups = useCallback(async () => {
    setBackupLoading(true);
    setBackupError(null);
    try {
      setBackups(await api.cliConfigBackups(scope, directory));
    } catch (err) {
      setBackups([]);
      setBackupError(String(err));
    } finally {
      setBackupLoading(false);
    }
  }, [directory, scope]);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  const restore = async (name: string) => {
    if (
      editor.dirty &&
      !window.confirm("还有未保存的 CLI 配置，恢复备份会丢弃这些修改。继续？")
    ) {
      return;
    }
    if (!window.confirm("恢复这个备份会覆盖当前配置，并重新加载 CLI。继续？")) return;
    try {
      const next = await api.cliConfigRestore(scope, directory, name);
      editor.discard();
      await editor.reload();
      setRawNotice(`已恢复备份 ${name}（${next.path}）`);
      await loadBackups();
    } catch (err) {
      setRawNotice(String(err));
    }
  };

  const logLevel = asString(value.logLevel) || "INFO";
  const share = asString(value.share) || "";
  const autoupdate = value.autoupdate;
  const shell = asString(value.shell);
  const agentNames = new Set(
    agents.filter((agent) => agent.mode !== "subagent").map((agent) => agent.name),
  );
  for (const [name, raw] of Object.entries(asRecord(value.agent))) {
    if (asString(asRecord(raw).mode) !== "subagent") agentNames.add(name);
  }

  return (
    <>
      <SettingsSection
        title="配置范围"
        hint="这里编辑的是原始配置文件；下方“有效配置”仍是 CLI 合并后的结果。"
      >
        {editor.snapshot ? (
          <>
            <Row
              label={scope === "project" ? "当前项目文件" : "全局文件"}
              value={editor.snapshot.path}
              mono
              title={editor.snapshot.path}
            />
            <div className="settings-inline-tags">
              <Tag tone={editor.snapshot.exists ? "ok" : "warn"}>
                {editor.snapshot.exists ? "已存在" : "首次保存时创建"}
              </Tag>
              <Tag
                tone={
                  editor.snapshot.parse_error && !editor.snapshot.redacted
                    ? "danger"
                    : editor.snapshot.secrets.length === 0
                    ? "muted"
                    : editor.snapshot.redacted
                      ? "muted"
                      : "warn"
                }
              >
                {editor.snapshot.parse_error && !editor.snapshot.redacted
                  ? "无法脱敏"
                  : editor.snapshot.secrets.length === 0
                  ? "无密钥"
                  : editor.snapshot.redacted
                    ? "密钥已脱敏"
                    : "密钥明文"}
              </Tag>
              {editor.dirty && <Tag tone="warn">未保存</Tag>}
              {editor.parseErrors.length > 0 && <Tag tone="danger">JSONC 有错误</Tag>}
            </div>
            <div className="settings-actions">
              <button
                className="ghost-btn"
                onClick={() => onOpenPath(editor.snapshot!.path)}
                disabled={!editor.snapshot.exists}
                title={editor.snapshot.exists ? undefined : "首次保存后才能定位文件"}
              >
                在 Finder 中显示
              </button>
              <button className="ghost-btn" onClick={() => void editor.reload()}>
                重新读取
              </button>
              <button className="ghost-btn" onClick={editor.discard} disabled={!editor.dirty}>
                放弃修改
              </button>
              <button
                className="primary-btn small"
                onClick={() => void editor.save()}
                disabled={!editor.dirty || editor.saving || editor.parseErrors.length > 0}
              >
                {editor.saving ? "保存中…" : "保存并应用"}
              </button>
            </div>
          </>
        ) : (
          <EmptyState>
            {scope === "project"
              ? "先从侧栏选择一个工作区，再编辑项目配置。"
              : "正在读取 CLI 配置…"}
          </EmptyState>
        )}
        {editor.error && <div className="settings-inline-error">{editor.error}</div>}
        {editor.notice && <div className="settings-note">{editor.notice}</div>}
        {editor.parseErrors.length > 0 && (
          <div className="settings-inline-error">
            JSONC 解析失败：{editor.parseErrors.join("；")}
          </div>
        )}
        {editor.snapshot?.parse_error && (
          <div className="settings-inline-error">
            当前文件无法被 CLI 解析：{editor.snapshot.parse_error}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="常规" hint="这些字段写入当前作用域的 deveco.jsonc。">
        <SelectField
          label="默认模型"
          hint="格式为 provider/model；留空表示继承 CLI 默认"
          value={asString(value.model)}
          options={[
            { label: "继承 / 未设置", value: "" },
            ...modelOptions(value),
          ]}
          onChange={(next) => setOptional(["model"], next)}
        />
        <SelectField
          label="小模型"
          hint="标题生成、摘要等轻任务使用"
          value={asString(value.small_model)}
          options={[
            { label: "继承 / 未设置", value: "" },
            ...modelOptions(value),
          ]}
          onChange={(next) => setOptional(["small_model"], next)}
        />
        <SelectField
          label="默认 Agent"
          hint="没有显式选择时使用"
          value={asString(value.default_agent)}
          options={[
            { label: "继承 / build", value: "" },
            ...[...agentNames]
              .sort((a, b) => a.localeCompare(b, "zh-CN"))
              .map((name) => ({ label: name, value: name })),
          ]}
          onChange={(next) => setOptional(["default_agent"], next)}
        />
        <SelectField
          label="Shell"
          hint="Agent 终端和 Bash 工具使用"
          value={shell}
          options={[
            { label: "自动选择", value: "" },
            ...shells.map((item) => ({ label: item.name, value: item.path })),
          ]}
          onChange={(next) => setOptional(["shell"], next)}
        />
        <TextField
          label="用户标识"
          hint="显示在会话中的用户名"
          value={asString(value.username)}
          placeholder="系统用户名"
          onChange={(next) => setOptional(["username"], next)}
        />
        <SelectField
          label="日志级别"
          value={logLevel}
          options={LOG_LEVELS.map((level) => ({ label: level, value: level }))}
          onChange={(next) => set(["logLevel"], next)}
        />
        <SelectField
          label="会话分享"
          hint="disabled 禁止，manual 手动，auto 自动"
          value={share}
          options={[
            { label: "未设置", value: "" },
            { label: "手动", value: "manual" },
            { label: "自动", value: "auto" },
            { label: "禁用", value: "disabled" },
          ]}
          onChange={(next) => setOptional(["share"], next)}
        />
        <Toggle
          label="自动分享会话"
          hint="旧版 autoshare 字段；新配置优先使用 share"
          checked={asBoolean(value.autoshare, false)}
          onChange={(next) =>
            next ? set(["autoshare"], true) : remove(["autoshare"])
          }
        />
        <SelectField
          label="CLI 更新"
          value={
            autoupdate === true ? "true" : autoupdate === false ? "false" : autoupdate === "notify" ? "notify" : ""
          }
          options={[
            { label: "未设置", value: "" },
            { label: "自动更新", value: "true" },
            { label: "仅提示", value: "notify" },
            { label: "关闭", value: "false" },
          ]}
          onChange={(next) => {
            if (!next) remove(["autoupdate"]);
            else set(["autoupdate"], next === "true" ? true : next === "false" ? false : next);
          }}
        />
        <Toggle
          label="启用快照"
          hint="保存会话前的文件快照，用于回退"
          checked={asBoolean(value.snapshot, true)}
          onChange={(next) => set(["snapshot"], next)}
        />
      </SettingsSection>

      <SettingsSection title="指令与技能">
        <StringListEditor
          label="额外指令文件"
          hint="路径或 glob；会作为系统指令加载"
          items={stringArray(value.instructions)}
          placeholder="AGENTS.md 或 docs/*.md"
          onChange={(items) => setOrRemove(set, remove, ["instructions"], items)}
        />
        <StringListEditor
          label="Skill 路径"
          hint="额外 Skill 文件夹"
          items={stringArray(asRecord(value.skills).paths)}
          placeholder="~/.config/deveco/skills"
          onChange={(items) => setSkillsField("paths", items)}
        />
        <StringListEditor
          label="Skill URL"
          hint="从远程清单加载 Skill"
          items={stringArray(asRecord(value.skills).urls)}
          placeholder="https://example.com/.well-known/skills/"
          onChange={(items) => setSkillsField("urls", items)}
        />
      </SettingsSection>

      <SettingsSection title="Provider 与工具">
        <StringListEditor
          label="禁用 Provider"
          hint="这些 Provider 不会被加载"
          items={stringArray(value.disabled_providers)}
          placeholder="provider-id"
          onChange={(items) => setOrRemove(set, remove, ["disabled_providers"], items)}
        />
        <StringListEditor
          label="启用 Provider"
          hint="设置后只加载这些 Provider"
          items={stringArray(value.enabled_providers)}
          placeholder="provider-id"
          onChange={(items) => setOrRemove(set, remove, ["enabled_providers"], items)}
        />
        <JsonFieldEditor
          label="Plugin 配置"
          hint="字符串或 [入口, 选项对象] 元组；只编辑配置，不执行 npm 安装"
          value={value.plugin ?? []}
          onApply={(next) => {
            const items = Array.isArray(next) ? next : [];
            if (items.length) set(["plugin"], items);
            else remove(["plugin"]);
          }}
        />
        <Toggle
          label="启用 Formatter"
          hint="关闭后不运行内置或自定义格式化器"
          checked={value.formatter !== false}
          onChange={(next) => {
            if (
              !next &&
              value.formatter &&
              typeof value.formatter === "object" &&
              !window.confirm("关闭 Formatter 会清除自定义 formatter 配置。继续？")
            ) {
              return;
            }
            if (next) remove(["formatter"]);
            else set(["formatter"], false);
          }}
        />
        <Toggle
          label="启用 LSP"
          hint="关闭后不启动语言服务器"
          checked={value.lsp !== false}
          onChange={(next) => {
            if (
              !next &&
              value.lsp &&
              typeof value.lsp === "object" &&
              !window.confirm("关闭 LSP 会清除自定义 LSP 配置。继续？")
            ) {
              return;
            }
            if (next) remove(["lsp"]);
            else set(["lsp"], false);
          }}
        />
        <JsonFieldEditor
          label="Formatter 覆盖"
          hint="高级 JSON；完整字段见 CLI 配置文档"
          value={value.formatter ?? {}}
          onApply={(next) => set(["formatter"], next)}
        />
        <JsonFieldEditor
          label="LSP 覆盖"
          hint="高级 JSON；自定义 LSP 通常需要 extensions"
          value={value.lsp ?? {}}
          onApply={(next) => set(["lsp"], next)}
        />
      </SettingsSection>

      <SettingsSection title="运行与压缩">
        <Toggle
          label="自动压缩上下文"
          hint="上下文快满时自动压缩"
          checked={asBoolean(asRecord(value.compaction).auto, true)}
          onChange={(next) => set(["compaction", "auto"], next)}
        />
        <Toggle
          label="裁剪旧工具输出"
          hint="减少长会话的上下文占用"
          checked={asBoolean(asRecord(value.compaction).prune, true)}
          onChange={(next) => set(["compaction", "prune"], next)}
        />
        <TextField
          label="压缩保留 token"
          hint="0 表示使用 CLI 默认；数字越小越积极压缩"
          value={String(asRecord(value.compaction).reserved ?? "")}
          onChange={(next) => {
            if (!next.trim()) remove(["compaction", "reserved"]);
            else {
              const parsed = Number(next);
              if (Number.isFinite(parsed)) set(["compaction", "reserved"], Math.max(0, Math.trunc(parsed)));
            }
          }}
        />
        <JsonFieldEditor
          label="Compaction 高级"
          hint="tail_turns、preserve_recent_tokens、snip 等完整字段"
          value={value.compaction ?? {}}
          onApply={(next) => set(["compaction"], next)}
        />
        <Toggle
          label="批量工具"
          checked={asBoolean(asRecord(value.experimental).batch_tool, false)}
          onChange={(next) => set(["experimental", "batch_tool"], next)}
        />
        <Toggle
          label="OpenTelemetry"
          checked={asBoolean(asRecord(value.experimental).openTelemetry, false)}
          onChange={(next) => set(["experimental", "openTelemetry"], next)}
        />
        <Toggle
          label="拒绝工具后继续循环"
          checked={asBoolean(asRecord(value.experimental).continue_loop_on_deny, false)}
          onChange={(next) => set(["experimental", "continue_loop_on_deny"], next)}
        />
        <JsonFieldEditor
          label="Experimental 高级"
          hint="disable_paste_summary、primary_tools、mcp_timeout、policies 等完整字段"
          value={value.experimental ?? {}}
          onApply={(next) => set(["experimental"], next)}
        />
        <JsonFieldEditor
          label="Tool Output"
          hint="工具输出大小与截断策略"
          value={value.tool_output ?? {}}
          onApply={(next) => set(["tool_output"], next)}
        />
        <JsonFieldEditor
          label="Attachment"
          hint="图片附件的尺寸和格式限制"
          value={value.attachment ?? {}}
          onApply={(next) => set(["attachment"], next)}
        />
        <JsonFieldEditor
          label="Watcher"
          hint="文件监听忽略规则"
          value={value.watcher ?? {}}
          onApply={(next) => set(["watcher"], next)}
        />
        <JsonFieldEditor
          label="CLI Server"
          hint="CLI 自身的 serve 默认参数；桌面端启动参数在下方单独配置"
          value={value.server ?? {}}
          onApply={(next) => set(["server"], next)}
        />
        <TextField
          label="Enterprise URL"
          value={asString(asRecord(value.enterprise).url)}
          placeholder="https://..."
          onChange={(next) => {
            if (!next.trim()) remove(["enterprise"]);
            else set(["enterprise", "url"], next);
          }}
        />
      </SettingsSection>

      <SettingsSection
        title="高级对象"
        hint="这些字段结构变化较少；表单不常用，直接编辑完整 JSON。"
      >
        <JsonFieldEditor
          label="references"
          hint="外部参考资料"
          value={value.references ?? {}}
          onApply={(next) => set(["references"], next)}
        />
        <JsonFieldEditor
          label="reference"
          hint="旧版 reference 字段；会原样保留"
          value={value.reference ?? {}}
          onApply={(next) => set(["reference"], next)}
        />
        <JsonFieldEditor
          label="tools"
          hint="旧版工具开关；新配置优先使用 permission"
          value={value.tools ?? {}}
          onApply={(next) => set(["tools"], next)}
        />
        <JsonFieldEditor
          label="mode"
          hint="旧版 Agent 配置；CLI 会自动迁移到 agent"
          value={value.mode ?? {}}
          onApply={(next) => set(["mode"], next)}
        />
        <JsonFieldEditor
          label="agreement"
          hint="CLI 内部协议状态；通常不需要修改"
          value={value.agreement ?? {}}
          onApply={(next) => set(["agreement"], next)}
        />
        <JsonFieldEditor
          label="layout"
          hint="已废弃；仅用于兼容旧配置"
          value={value.layout ?? "auto"}
          onApply={(next) => set(["layout"], next)}
        />
      </SettingsSection>

      <SettingsSection
        title="高级 JSONC"
        hint="直接编辑原始文件；上方表单和这里共享同一份文本。"
        action={
          <div className="settings-actions">
            <button
              className="ghost-btn"
              onClick={() => {
                if (editor.parseErrors.length > 0) {
                  setRawNotice("JSONC 还有解析错误，先修正后再格式化。");
                  return;
                }
                try {
                  editor.setText(formatCliConfig(editor.text));
                  setRawNotice("已格式化");
                } catch (err) {
                  setRawNotice(String(err));
                }
              }}
            >
              格式化
            </button>
            <button
              className="ghost-btn"
              onClick={() =>
                editor.revealed
                  ? void editor.hideSecrets()
                  : void editor.revealSecrets()
              }
            >
              {editor.revealed ? "隐藏密钥" : "显示密钥"}
            </button>
          </div>
        }
      >
        {rawNotice && <div className="settings-note">{rawNotice}</div>}
        <textarea
          className="settings-textarea mono settings-raw-editor"
          rows={20}
          value={editor.text}
          spellCheck={false}
          onChange={(event) => editor.setText(event.target.value)}
        />
        {editor.revealed && (
          <div className="settings-inline-error">
            当前显示明文密钥；截图或录屏前请切回隐藏。
          </div>
        )}
        <p className="settings-note">
          保存后会调用 CLI 的实例重载接口。运行中的任务可能被中断；失败时 Rust 侧会恢复上一份备份。
        </p>
      </SettingsSection>

      <SettingsSection
        title="配置来源"
        action={
          <button className="ghost-btn" onClick={() => void loadBackups()} disabled={backupLoading}>
            {backupLoading ? "读取中…" : "刷新备份"}
          </button>
        }
      >
        {sources ? (
          <>
            <Row
              label="全局配置"
              value={compactPath(sources.global_path)}
              mono
              title={sources.global_path}
            />
            <Row
              label="项目配置"
              value={sources.project_path ? compactPath(sources.project_path) : "未选择工作区"}
              mono
              title={sources.project_path ?? ""}
            />
            <Row
              label="读取顺序"
              value=".deveco/deveco.jsonc → deveco.jsonc → 全局 deveco.jsonc"
            />
            <div className="settings-actions">
              <button className="ghost-btn" onClick={() => onOpenPath(sources.config_dir)}>
                打开全局目录
              </button>
              {sources.project_config_dir && (
                <button
                  className="ghost-btn"
                  onClick={() => onOpenPath(sources.project_config_dir!)}
                >
                  打开项目目录
                </button>
              )}
            </div>
          </>
        ) : (
          <EmptyState>正在读取配置来源…</EmptyState>
        )}
        <div className="settings-note">备份位于应用数据目录，权限 0600，每个配置文件保留最近 10 份。</div>
        {backupError ? (
          <div className="settings-inline-error">{backupError}</div>
        ) : backups.length === 0 ? (
          <EmptyState>还没有配置备份。</EmptyState>
        ) : (
          backups.map((backup) => (
            <div className="settings-entity" key={backup.name}>
              <div className="settings-entity-main">
                <div className="settings-entity-title">
                  <span>{backup.name}</span>
                </div>
                <div className="settings-entity-meta">
                  {new Date(backup.updated_at * 1000).toLocaleString("zh-CN")} · {backup.size} bytes
                </div>
              </div>
              <div className="settings-entity-actions">
                <button className="ghost-btn" onClick={() => void restore(backup.name)}>
                  恢复
                </button>
              </div>
            </div>
          ))
        )}
      </SettingsSection>
    </>
  );
}

function stringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function modelOptions(value: Record<string, unknown>): Array<{ label: string; value: string }> {
  const seen = new Set<string>();
  const options: Array<{ label: string; value: string }> = [];
  const providers = asRecord(value.provider);
  for (const [providerID, provider] of Object.entries(providers)) {
    const models = asRecord(asRecord(provider).models);
    for (const modelID of Object.keys(models)) {
      const key = `${providerID}/${modelID}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ label: key, value: key });
    }
  }
  const current = asString(value.model);
  if (current && !seen.has(current)) options.unshift({ label: current, value: current });
  return options;
}

function setOrRemove(
  set: (path: Array<string | number>, value: unknown) => void,
  remove: (path: Array<string | number>) => void,
  path: Array<string | number>,
  items: string[],
) {
  if (items.length) set(path, items);
  else remove(path);
}
