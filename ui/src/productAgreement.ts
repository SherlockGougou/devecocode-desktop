import type { ProductAgreement } from "./types";

export const PRODUCT_AGREEMENT_REVIEW_REQUIRED = "review_required";

export const PRODUCT_AGREEMENT_CHANGED_GUIDANCE =
  "DevEco Code 的服务协议已更新。请阅读并同意更新后的条款，再重新发送请求。";

export interface ProductAgreementAcceptancePayload {
  version: string;
  accepted: true;
  serviceRevision?: string;
}

export function isProductAgreementError(message?: string | null): boolean {
  const normalized = message?.toLowerCase() ?? "";
  return (
    normalized.includes("service agreements changed") ||
    normalized.includes("product agreements changed") ||
    normalized.includes("review the product agreements") ||
    normalized.includes("deveco auth consent")
  );
}

export function productAgreementNeedsAcceptance(
  agreement: ProductAgreement | null | undefined,
): boolean {
  return Boolean(
    agreement &&
      (!agreement.accepted ||
        agreement.upload?.state === PRODUCT_AGREEMENT_REVIEW_REQUIRED),
  );
}

export function productAgreementAcceptancePayload(
  agreement: ProductAgreement,
): ProductAgreementAcceptancePayload {
  return {
    version: agreement.version,
    accepted: true,
    ...(agreement.upload?.revision
      ? { serviceRevision: agreement.upload.revision }
      : {}),
  };
}

export function productAgreementUploadLabel(state?: string): string | null {
  switch (state) {
    case "uploaded":
      return "同步完成";
    case PRODUCT_AGREEMENT_REVIEW_REQUIRED:
      return "需要重新同意协议";
    case "uploading":
      return "正在同步同意状态";
    case "pending":
      return "等待同步同意状态";
    case "failed":
      return "同步失败";
    default:
      return state ? `同步状态：${state}` : null;
  }
}
