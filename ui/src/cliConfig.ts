import { applyEdits, format, modify, parse } from "jsonc-parser";
import type { CliConfigPath } from "./types";

export interface CliConfigChange {
  path: CliConfigPath;
  op: "set" | "delete";
  value?: unknown;
}

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function getValue(source: unknown, path: CliConfigPath): unknown {
  let current = source;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!isRecord(current)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

export function withoutKey(source: JsonRecord, key: string): JsonRecord {
  const next = { ...source };
  delete next[key];
  return next;
}

export function withKey(source: JsonRecord, key: string, value: unknown): JsonRecord {
  return { ...source, [key]: value };
}

/** 使用 jsonc-parser 的 modify/applyEdits，保留未编辑区域的注释和缩进。 */
export function applyConfigChanges(text: string, changes: CliConfigChange[]): string {
  let current = text;
  for (const change of changes) {
    const edits = modify(current, change.path, change.op === "delete" ? undefined : change.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    current = applyEdits(current, edits);
  }
  return current;
}

export function parseCliConfig(text: string): unknown {
  const errors: Array<{ error: number; offset: number; length: number }> = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length ? null : value;
}

export function parseCliConfigErrors(text: string): string[] {
  const errors: Array<{ error: number; offset: number; length: number }> = [];
  parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.map((error) => {
    const prefix = text.slice(0, error.offset);
    const line = prefix.split("\n").length;
    const column = prefix.length - prefix.lastIndexOf("\n");
    return `第 ${line} 行第 ${column} 列（错误码 ${error.error}）`;
  });
}

export function formatCliConfig(text: string): string {
  return applyEdits(text, format(text, undefined, { insertSpaces: true, tabSize: 2 }));
}

export function secretPaths(snapshot: { secrets: Array<{ path: CliConfigPath }> }): string[] {
  return snapshot.secrets.map((secret) => secret.path.map(String).join("."));
}

export function replaceSecret(
  value: JsonRecord,
  path: CliConfigPath,
  next: unknown,
): JsonRecord {
  if (path.length === 0) return asRecord(next);
  const [head, ...rest] = path;
  if (typeof head === "number") return value;
  const current = value[head];
  if (rest.length === 0) {
    return { ...value, [head]: next };
  }
  if (typeof rest[0] === "number") {
    const array = Array.isArray(current) ? [...current] : [];
    const index = rest[0];
    array[index] = replaceSecret(
      asRecord(array[index]),
      rest.slice(1),
      next,
    );
    return { ...value, [head]: array };
  }
  return {
    ...value,
    [head]: replaceSecret(asRecord(current), rest, next),
  };
}
