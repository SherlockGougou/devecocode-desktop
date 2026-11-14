import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import { onAppEvent } from "../appEvents";
import {
  canUndoVoice,
  type VoiceInsertion,
  type VoiceSelection,
} from "../voice";
import type {
  VoiceCommandError,
  VoiceEvent,
} from "../types";

const HOLD_START_DELAY_MS = 300;
const UNDO_DURATION_MS = 6000;
const TIME_LIMIT_WARNING_MS = 45_000;

export type VoicePhase =
  | "idle"
  | "starting"
  | "recording"
  | "finalizing"
  | "error"
  | "inserted";

export interface VoiceUiError {
  code: string;
  message: string;
  lastPartial?: string;
}

interface UseVoiceInputOptions {
  composerRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  currentText: string;
  getSelection: () => VoiceSelection;
  onInsert: (text: string, selection: VoiceSelection) => VoiceInsertion | null;
  onUndo: (insertion: VoiceInsertion) => void;
  onNotice: (message: string) => void;
}

function normalizeError(error: unknown): VoiceUiError {
  if (error && typeof error === "object") {
    const value = error as Partial<VoiceCommandError>;
    if (typeof value.code === "string" && typeof value.message === "string") {
      return { code: value.code, message: value.message };
    }
  }
  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error) as Partial<VoiceCommandError>;
      if (typeof parsed.code === "string" && typeof parsed.message === "string") {
        return { code: parsed.code, message: parsed.message };
      }
    } catch {
      // 普通字符串错误直接作为文案使用
    }
    return { code: "unknown", message: error };
  }
  return { code: "unknown", message: String(error) };
}

function isBusy(phase: VoicePhase) {
  return phase === "starting" || phase === "recording" || phase === "finalizing";
}

export function useVoiceInput({
  composerRef,
  enabled,
  currentText,
  getSelection,
  onInsert,
  onUndo,
  onNotice,
}: UseVoiceInputOptions) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<VoiceUiError | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [maxDurationMs, setMaxDurationMs] = useState(60_000);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [holdOption, setHoldOption] = useState(true);
  const [undo, setUndo] = useState<VoiceInsertion | null>(null);

  const phaseRef = useRef<VoicePhase>("idle");
  const sessionIDRef = useRef<number | null>(null);
  const startTokenRef = useRef(0);
  const baseTextRef = useRef("");
  const anchorRef = useRef<VoiceSelection>({ start: 0, end: 0 });
  const lastPartialRef = useRef("");
  const pendingEventsRef = useRef<VoiceEvent[]>([]);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdActiveRef = useRef(false);
  const holdReleasePendingRef = useRef(false);
  const undoRef = useRef<VoiceInsertion | null>(null);
  const currentTextRef = useRef(currentText);
  const enabledRef = useRef(enabled);
  const holdOptionRef = useRef(holdOption);
  const optionsRef = useRef({
    getSelection,
    onInsert,
    onUndo,
    onNotice,
  });

  currentTextRef.current = currentText;
  enabledRef.current = enabled;
  holdOptionRef.current = holdOption;
  optionsRef.current = { getSelection, onInsert, onUndo, onNotice };

  const updatePhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const clearHoldPending = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdReleasePendingRef.current = false;
  }, []);

  const resetVoice = useCallback(() => {
    startTokenRef.current += 1;
    sessionIDRef.current = null;
    baseTextRef.current = "";
    lastPartialRef.current = "";
    pendingEventsRef.current = [];
    holdActiveRef.current = false;
    clearHoldPending();
    setTranscript("");
    setStartedAt(null);
    setElapsedMs(0);
    updatePhase("idle");
  }, [clearHoldPending, updatePhase]);

  const cancel = useCallback(() => {
    resetVoice();
    setError(null);
    setUndo(null);
    undoRef.current = null;
    void api.voiceCancel().catch(() => undefined);
  }, [resetVoice]);

  const stop = useCallback(() => {
    if (phaseRef.current !== "recording") return;
    updatePhase("finalizing");
    void api.voiceStop().catch((raw) => {
      const next = normalizeError(raw);
      sessionIDRef.current = null;
      setError(next);
      updatePhase("error");
    });
  }, [updatePhase]);

  const commit = useCallback(
    (text: string, selection: VoiceSelection) => {
      const insertion = enabledRef.current
        ? optionsRef.current.onInsert(text, selection)
        : null;
      if (!insertion) {
        const next = {
          code: "draft_changed",
          message: "草稿已变化，语音结果没有插入",
          lastPartial: text,
        };
        setError(next);
        setTranscript(text);
        updatePhase("error");
        return;
      }
      setTranscript(text);
      setUndo(insertion);
      undoRef.current = insertion;
      updatePhase("inserted");
    },
    [updatePhase],
  );

  const handleEvent = useCallback(
    (event: VoiceEvent) => {
      if (sessionIDRef.current === null) {
        if (phaseRef.current === "starting") pendingEventsRef.current.push(event);
        return;
      }
      if (event.sessionId !== sessionIDRef.current) return;

      switch (event.type) {
        case "partial": {
          lastPartialRef.current = event.text;
          setTranscript(event.text);
          break;
        }
        case "finalizing": {
          updatePhase("finalizing");
          break;
        }
        case "final": {
          lastPartialRef.current = event.text;
          sessionIDRef.current = null;
          setStartedAt(null);
          if (currentTextRef.current !== baseTextRef.current) {
            setTranscript(event.text);
            setError({
              code: "draft_changed",
              message: "草稿已变化，请手动插入语音结果",
              lastPartial: event.text,
            });
            updatePhase("error");
            return;
          }
          commit(event.text, anchorRef.current);
          break;
        }
        case "error": {
          sessionIDRef.current = null;
          setStartedAt(null);
          setTranscript(event.lastPartial ?? lastPartialRef.current);
          setError({
            code: event.code,
            message: event.message,
            lastPartial: event.lastPartial,
          });
          updatePhase("error");
          break;
        }
      }
    },
    [commit, updatePhase],
  );

  const eventHandlerRef = useRef(handleEvent);
  eventHandlerRef.current = handleEvent;

  const start = useCallback(
    async (trigger: "button" | "hold") => {
      if (!enabledRef.current || isBusy(phaseRef.current)) return;
      const token = ++startTokenRef.current;
      const selection = optionsRef.current.getSelection();
      baseTextRef.current = currentTextRef.current;
      anchorRef.current = {
        start: Math.max(0, Math.min(baseTextRef.current.length, selection.start)),
        end: Math.max(0, Math.min(baseTextRef.current.length, selection.end)),
      };
      if (anchorRef.current.end < anchorRef.current.start) {
        anchorRef.current = {
          start: anchorRef.current.end,
          end: anchorRef.current.start,
        };
      }
      lastPartialRef.current = "";
      pendingEventsRef.current = [];
      holdReleasePendingRef.current = false;
      setTranscript("");
      setError(null);
      setUndo(null);
      undoRef.current = null;
      setElapsedMs(0);
      updatePhase("starting");
      try {
        const result = await api.voiceStart();
        if (token !== startTokenRef.current) {
          void api.voiceCancel().catch(() => undefined);
          return;
        }
        sessionIDRef.current = result.sessionId;
        setStartedAt(Date.now());
        setMaxDurationMs(result.maxDurationMs);
        updatePhase("recording");
        const pending = pendingEventsRef.current.splice(0);
        for (const event of pending) {
          if (event.sessionId === result.sessionId) {
            eventHandlerRef.current(event);
          }
        }
        if (holdReleasePendingRef.current) {
          holdReleasePendingRef.current = false;
          stop();
        }
      } catch (raw) {
        if (token !== startTokenRef.current) return;
        const next = normalizeError(raw);
        if (next.code === "cancelled") {
          resetVoice();
          return;
        }
        setError(next);
        updatePhase("error");
      }
    },
    [resetVoice, stop, updatePhase],
  );

  const startRef = useRef(start);
  const stopRef = useRef(stop);
  const cancelRef = useRef(cancel);
  startRef.current = start;
  stopRef.current = stop;
  cancelRef.current = cancel;

  const insertDraft = useCallback(() => {
    const text = error?.lastPartial ?? transcript;
    if (!text.trim()) return;
    const insertion = optionsRef.current.onInsert(
      text,
      optionsRef.current.getSelection(),
    );
    if (!insertion) return;
    setTranscript(text);
    setError(null);
    setUndo(insertion);
    undoRef.current = insertion;
    updatePhase("inserted");
  }, [error, transcript, updatePhase]);

  const undoInsertion = useCallback(() => {
    const current = undoRef.current;
    if (!current || !canUndoVoice(current, currentTextRef.current)) {
      setUndo(null);
      undoRef.current = null;
      if (phaseRef.current === "inserted") updatePhase("idle");
      return;
    }
    optionsRef.current.onUndo(current);
    setUndo(null);
    undoRef.current = null;
    setTranscript("");
    updatePhase("idle");
  }, [updatePhase]);

  const dismissError = useCallback(() => {
    setError(null);
    setTranscript("");
    updatePhase("idle");
  }, [updatePhase]);

  const retry = useCallback(() => {
    setError(null);
    setUndo(null);
    undoRef.current = null;
    void startRef.current("button");
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<VoiceEvent>("deveco://voice", (event) => {
      eventHandlerRef.current(event.payload);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void api
      .getSettings()
      .then(({ config }) => {
        if (!disposed) setHoldOption(config.voice.hold_option);
      })
      .catch(() => undefined);
    const off = onAppEvent("settings-saved", (config) => {
      if (!disposed) setHoldOption(config.voice.hold_option);
    });
    return () => {
      disposed = true;
      off();
    };
  }, []);

  useEffect(() => {
    if (phase !== "recording" || startedAt === null) return;
    const tick = () => setElapsedMs(Date.now() - startedAt);
    tick();
    const timer = setInterval(tick, 200);
    return () => clearInterval(timer);
  }, [phase, startedAt]);

  useEffect(() => {
    if ((phase === "recording" || phase === "finalizing") &&
        currentText !== baseTextRef.current) {
      optionsRef.current.onNotice("输入内容已变化，语音输入已取消");
      cancelRef.current();
    }
  }, [currentText, phase]);

  useEffect(() => {
    if (!enabled && isBusy(phase)) cancelRef.current();
  }, [enabled, phase]);

  useEffect(() => {
    if (!undo) return;
    if (currentText !== undo.afterText) {
      setUndo(null);
      undoRef.current = null;
      if (phaseRef.current === "inserted") updatePhase("idle");
      return;
    }
    const timer = setTimeout(() => {
      if (undoRef.current === undo) {
        setUndo(null);
        undoRef.current = null;
        if (phaseRef.current === "inserted") updatePhase("idle");
      }
    }, UNDO_DURATION_MS);
    return () => clearTimeout(timer);
  }, [currentText, undo, updatePhase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (event.key === "Escape" && isBusy(phaseRef.current)) {
        event.preventDefault();
        event.stopPropagation();
        cancelRef.current();
        return;
      }
      if (!composerRef.current?.contains(document.activeElement)) return;
      if (!holdOptionRef.current || !enabledRef.current) return;
      if (
        event.code !== "AltLeft" ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        isBusy(phaseRef.current)
      ) {
        return;
      }
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        holdActiveRef.current = true;
        void startRef.current("hold");
      }, HOLD_START_DELAY_MS);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "AltLeft") return;
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
        return;
      }
      if (!holdActiveRef.current) return;
      holdActiveRef.current = false;
      if (phaseRef.current === "starting") {
        holdReleasePendingRef.current = true;
      } else if (phaseRef.current === "recording") {
        stopRef.current();
      }
    };
    const onPointerDown = () => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };
    const onWindowBlur = () => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [composerRef, updatePhase]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && isBusy(phaseRef.current)) {
        cancelRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(
    () => () => {
      void api.voiceCancel().catch(() => undefined);
    },
    [],
  );

  return {
    phase,
    busy: isBusy(phase),
    recording: phase === "recording",
    starting: phase === "starting",
    finalizing: phase === "finalizing",
    transcript,
    error,
    elapsedMs,
    maxDurationMs,
    limitWarning: elapsedMs >= TIME_LIMIT_WARNING_MS,
    undoAvailable: Boolean(undo),
    holdOption,
    start,
    stop,
    cancel,
    retry,
    insertDraft,
    undoInsertion,
    dismissError,
    openPrivacySettings: (kind: "microphone" | "speech") =>
      api.voiceOpenPrivacySettings(kind),
  };
}
