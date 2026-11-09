import type {
  AgentInfo,
  PermissionAction,
  PermissionMode,
  PermissionRule,
  Session,
} from "./types";

/**
 * 会话权限选择器只控制这三类高频风险操作：
 * 命令执行、工作区外文件、网络访问。
 * 读文件、工作区内编辑和 Agent 自己的其它规则不在这里覆盖。
 */
export const CONTROLLED_PERMISSIONS = [
  "bash",
  "external_directory",
  "webfetch",
  "websearch",
] as const;

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  allow: "完全访问",
  ask: "每次询问",
};

function isPermissionAction(value: unknown): value is PermissionAction {
  return value === "allow" || value === "ask" || value === "deny";
}

function agentRules(agent?: AgentInfo): PermissionRule[] {
  return agent?.permission ?? [];
}

/** Agent 解析后的兜底（工具和资源都为通配）默认动作；没有显式规则时返回 null。 */
export function effectiveCatchAll(agent?: AgentInfo): PermissionAction | null {
  const rules = agentRules(agent);
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (
      rule.permission === "*" &&
      rule.pattern === "*" &&
      isPermissionAction(rule.action)
    ) {
      return rule.action;
    }
  }
  return null;
}

function rulesForTool(rules: PermissionRule[], tool: string): PermissionRule[] {
  return rules.filter((rule) => rule.permission === tool);
}

/**
 * CLI 按最后匹配规则决定动作。这里同时考虑工具通配规则和全局兜底，
 * 用于判断某个工具是否整体处于 deny 状态。
 */
function effectiveToolCatchAll(
  agent: AgentInfo | undefined,
  tool: string,
): PermissionAction | null {
  const rules = agentRules(agent);
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (!isPermissionAction(rule.action)) continue;
    if (
      rule.pattern === "*" &&
      (rule.permission === tool || rule.permission === "*")
    ) {
      return rule.action;
    }
  }
  return null;
}

function isHardDenied(agent: AgentInfo | undefined, tool: string): boolean {
  const rules = rulesForTool(agentRules(agent), tool);
  // 工具自身出现过通配 deny 时，不尝试从会话层重新开放它的子路径。
  if (rules.some((rule) => rule.pattern === "*" && rule.action === "deny")) {
    return true;
  }
  return effectiveToolCatchAll(agent, tool) === "deny";
}

function hardDeniedTools(agent?: AgentInfo): Set<string> {
  return new Set<string>(
    CONTROLLED_PERMISSIONS.filter((tool) => isHardDenied(agent, tool)),
  );
}

/** 四类操作里哪些还能被会话选择器调整；全部硬拒绝时选择器应禁用。 */
export function controllablePermissionTools(agent?: AgentInfo): string[] {
  const hardDenied = hardDeniedTools(agent);
  return CONTROLLED_PERMISSIONS.filter((tool) => !hardDenied.has(tool));
}

/**
 * 生成要追加到会话末尾的 Agent 硬限制。
 *
 * 对整体拒绝的工具重建其通配 deny 与工具规则，保证切回该 Agent 时仍保留
 * 允许的局部路径；对仍可调整的工具只保留 deny，避免模式规则覆盖具体限制。
 */
export function hardPermissionRules(agent?: AgentInfo): PermissionRule[] {
  const rules = agentRules(agent);
  const hardDenied = hardDeniedTools(agent);
  const result: PermissionRule[] = [];
  for (const tool of CONTROLLED_PERMISSIONS) {
    const toolRules = rulesForTool(rules, tool);
    if (hardDenied.has(tool)) {
      if (
        effectiveToolCatchAll(agent, tool) === "deny" &&
        !toolRules.some(
          (rule) => rule.pattern === "*" && rule.action === "deny",
        )
      ) {
        result.push({ permission: tool, pattern: "*", action: "deny" });
      }
      result.push(...toolRules);
      continue;
    }
    result.push(...toolRules.filter((rule) => rule.action === "deny"));
  }
  return result;
}

/**
 * 生成要追加到会话权限末尾的规则。
 *
 * CLI 按规则顺序 findLast，会话规则追加在 Agent 规则之后；
 * 且 PATCH 是追加合并而不是替换。这里先写目标模式，再把 Agent 的
 * 硬限制追加到最后：整体拒绝工具重建通配 deny 与局部 allow，其他
 * 工具保留具体 deny，避免旧会话规则或新模式覆盖 Agent 的限制。
 */
export function rulesForMode(
  mode: PermissionMode,
  agent?: AgentInfo,
): PermissionRule[] {
  const hardDenied = hardDeniedTools(agent);
  const modeRules: PermissionRule[] = CONTROLLED_PERMISSIONS.filter(
    (tool) => !hardDenied.has(tool),
  ).map((tool) => ({ permission: tool, pattern: "*", action: mode }));
  return [...modeRules, ...hardPermissionRules(agent)];
}

/** 四类操作全部被 Agent 硬拒绝时，选择器没有可切换的空间。 */
export function canControlPermission(agent?: AgentInfo): boolean {
  return controllablePermissionTools(agent).length > 0;
}

function lastToolRule(
  rules: PermissionRule[],
  tool: string,
): PermissionRule | null {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule.permission === tool && isPermissionAction(rule.action)) {
      return rule;
    }
  }
  return null;
}

function lastNonDenyToolRule(
  rules: PermissionRule[],
  tool: string,
): PermissionRule | null {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (
      rule.permission === tool &&
      isPermissionAction(rule.action) &&
      rule.action !== "deny"
    ) {
      return rule;
    }
  }
  return null;
}

/**
 * 从会话规则末尾推导当前模式。
 *
 * 历史规则可能保留下来，因此不能做数组完全相等比较：可调整工具最后
 * 一条非 deny 规则必须是桌面端写入的 `pattern:"*"` 预设动作；整体拒绝
 * 工具保留 Agent 的局部规则，但末尾不能出现重新开放整个工具的通配动作。
 * 若出现其它自定义路径/命令规则，或各工具动作不一致，则视为自定义。
 */
export function ownedPermissionMode(
  session: Session | undefined,
  agent?: AgentInfo,
): PermissionMode | null {
  const rules = session?.permission ?? [];
  const hardDenied = hardDeniedTools(agent);
  let mode: PermissionMode | null = null;
  for (const tool of CONTROLLED_PERMISSIONS) {
    if (hardDenied.has(tool)) {
      // 硬拒绝工具保留 Agent 的局部 allow/deny；只有末尾仍有通配模式动作
      // 才说明会话规则试图重新开放整个工具。
      const rule = lastToolRule(rules, tool);
      if (
        rule &&
        rule.pattern === "*" &&
        (rule.action === "ask" || rule.action === "allow")
      ) {
        return null;
      }
      continue;
    }
    const rule = lastNonDenyToolRule(rules, tool);
    if (!rule || rule.pattern !== "*") return null;
    if (rule.action !== "ask" && rule.action !== "allow") return null;
    if (mode && mode !== rule.action) return null;
    mode = rule.action;
  }
  return mode;
}

/** 会话里是否已有受控工具的规则；用于区分跟随 Agent 和自定义。 */
export function hasCustomSessionPermission(
  session: Session | undefined,
): boolean {
  const rules = session?.permission ?? [];
  return rules.some((rule) =>
    CONTROLLED_PERMISSIONS.some((tool) => tool === rule.permission),
  );
}

/** 当前显式模式；null 表示跟随 Agent 或自定义规则。 */
export function displayedPermissionMode(
  session: Session | undefined,
  agent: AgentInfo | undefined,
  draft: PermissionMode | null,
): PermissionMode | null {
  if (!session) return draft;
  return ownedPermissionMode(session, agent);
}
