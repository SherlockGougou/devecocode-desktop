import type { ModelInfo } from "./types";

/** `/api/model` 会带上历史模型；列表与选择只保留当前可用项。 */
export function isModelAvailable(model: ModelInfo): boolean {
  return model.enabled !== false && model.status !== "deprecated";
}

/** CLI 的 variants 按推理强度从低到高排列，最后一项就是当前模型的最高档。 */
export function highestModelVariant(model: ModelInfo | undefined): string | null {
  return model?.variants?.at(-1)?.id ?? null;
}
