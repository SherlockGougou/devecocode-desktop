import type { ModelInfo } from "./types";

const HIDDEN_MODELS_KEY = "deveco.desktop.hiddenModels";

/** Provider ID 不包含冒号；模型 ID 即使包含斜杠也能保持 key 唯一。 */
export function modelKey(providerID: string, modelID: string): string {
  return `${providerID}:${modelID}`;
}

/** `/api/model` 会带上历史模型；列表与选择只保留当前可用项。 */
export function isModelAvailable(model: ModelInfo): boolean {
  return model.enabled !== false && model.status !== "deprecated";
}

/** CLI 的 variants 按推理强度从低到高排列，最后一项就是当前模型的最高档。 */
export function highestModelVariant(model: ModelInfo | undefined): string | null {
  return model?.variants?.at(-1)?.id ?? null;
}

/** 模型可见性是桌面端本地偏好；坏数据回退为全部可见。 */
export function readHiddenModels(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HIDDEN_MODELS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        ),
      ),
    ];
  } catch {
    return [];
  }
}

export function writeHiddenModels(keys: readonly string[]) {
  localStorage.setItem(HIDDEN_MODELS_KEY, JSON.stringify([...new Set(keys)]));
}
