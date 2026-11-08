import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import {
  applyConfigChanges,
  asRecord,
  parseCliConfig,
  parseCliConfigErrors,
  type CliConfigChange,
  type JsonRecord,
} from "../../cliConfig";
import type { CliConfigScope, CliConfigSnapshot } from "../../types";

export interface CliConfigEditor {
  snapshot: CliConfigSnapshot | null;
  text: string;
  value: JsonRecord;
  parseErrors: string[];
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  notice: string | null;
  revealed: boolean;
  setText: (text: string) => void;
  applyChanges: (changes: CliConfigChange[]) => void;
  save: (nextText?: string) => Promise<boolean>;
  reload: () => Promise<void>;
  discard: () => void;
  revealSecrets: () => Promise<void>;
  hideSecrets: () => Promise<void>;
  clearNotice: () => void;
}

export function useCliConfigEditor({
  backendState,
  directory,
  scope,
  enabled,
  streaming,
}: {
  backendState: string;
  directory: string | null;
  scope: CliConfigScope;
  enabled: boolean;
  streaming: boolean;
}): CliConfigEditor {
  const [snapshot, setSnapshot] = useState<CliConfigSnapshot | null>(null);
  const [text, setTextState] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(
    async (revealSecrets = false) => {
      if (!enabled || backendState !== "ready") {
        setSnapshot(null);
        setTextState("");
        return;
      }
      if (scope === "project" && !directory) {
        setSnapshot(null);
        setTextState("");
        setError(null);
        return;
      }
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      setNotice(null);
      try {
        const next = await api.cliConfigRead(
          scope,
          scope === "project" ? directory : null,
          revealSecrets,
        );
        if (id !== requestId.current) return;
        setSnapshot(next);
        setTextState(next.text);
        setRevealed(revealSecrets);
      } catch (err) {
        if (id === requestId.current) setError(String(err));
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [backendState, directory, enabled, scope],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const value = useMemo(() => asRecord(parseCliConfig(text)), [text]);
  const parseErrors = useMemo(
    () => (parseCliConfig(text) === null ? parseCliConfigErrors(text) : []),
    [text],
  );
  const dirty = Boolean(snapshot && text !== snapshot.text);

  const setText = useCallback((next: string) => {
    setTextState(next);
    setNotice(null);
  }, []);

  const applyChanges = useCallback((changes: CliConfigChange[]) => {
    if (changes.length === 0) return;
    setTextState((current) => applyConfigChanges(current, changes));
    setNotice(null);
  }, []);

  const save = useCallback(async (nextText?: string) => {
    if (!snapshot || saving) return false;
    const payloadText = nextText ?? text;
    // 先落到草稿：即使运行中重载被取消，用户的这次修改也不会丢。
    setTextState(payloadText);
    if (streaming && !window.confirm("当前会话仍在生成。保存 CLI 配置会重新加载 CLI 实例，可能中断任务。继续？")) {
      return false;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.cliConfigSave({
        scope,
        directory: scope === "project" ? directory : null,
        base_hash: snapshot.hash,
        text: payloadText,
        reveal_secrets: revealed,
      });
      setSnapshot(result.snapshot);
      setTextState(result.snapshot.text);
      setRevealed(false);
      setNotice(
        result.warnings.length > 0
          ? `已保存并应用。${result.warnings.join("；")}`
          : "已保存并应用，CLI 已重新加载配置。",
      );
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [directory, revealed, saving, scope, snapshot, streaming, text]);

  const reload = useCallback(async () => {
    if (dirty && !window.confirm("还有未保存的 CLI 配置，重新读取会丢弃这些修改。继续？")) {
      return;
    }
    setNotice(null);
    await load(revealed);
  }, [dirty, load, revealed]);

  const discard = useCallback(() => {
    setTextState(snapshot?.text ?? "");
    setNotice(null);
    setError(null);
  }, [snapshot]);

  const revealSecrets = useCallback(async () => {
    if (dirty) {
      setNotice("先保存或放弃当前修改，再显示密钥。");
      return;
    }
    setNotice(null);
    await load(true);
  }, [dirty, load]);

  const hideSecrets = useCallback(async () => {
    if (dirty) {
      setNotice("先保存或放弃当前修改，再隐藏密钥。");
      return;
    }
    setNotice(null);
    await load(false);
  }, [dirty, load]);

  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    snapshot,
    text,
    value,
    parseErrors,
    dirty,
    loading,
    saving,
    error,
    notice,
    revealed,
    setText,
    applyChanges,
    save,
    reload,
    discard,
    revealSecrets,
    hideSecrets,
    clearNotice,
  };
}
