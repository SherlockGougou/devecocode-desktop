import type { Attachment } from "./types";

type AppEventMap = {
  "reference-file": { directory: string; path: string };
  "settings-save": undefined;
  "attach-device-screenshot": Attachment;
};

type AppEventName = keyof AppEventMap;
type AppEventHandler<K extends AppEventName> = (detail: AppEventMap[K]) => void;

const listeners = new Map<AppEventName, Set<(detail: unknown) => void>>();

export function emitAppEvent<K extends AppEventName>(
  name: K,
  detail: AppEventMap[K],
): void {
  const handlers = listeners.get(name);
  handlers?.forEach((handler) => handler(detail));
}

export function onAppEvent<K extends AppEventName>(
  name: K,
  handler: AppEventHandler<K>,
): () => void {
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  const wrapped = handler as (detail: unknown) => void;
  set.add(wrapped);
  return () => {
    set.delete(wrapped);
  };
}
