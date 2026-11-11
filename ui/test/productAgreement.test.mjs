import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCT_AGREEMENT_CHANGED_GUIDANCE,
  isProductAgreementError,
  productAgreementAcceptancePayload,
  productAgreementNeedsAcceptance,
  productAgreementUploadLabel,
} from "../test-dist/productAgreement.js";

const agreement = {
  version: "1",
  termsUrl: "https://example.com/terms",
  privacyUrl: "https://example.com/privacy",
  accepted: true,
  upload: {
    state: "review_required",
    revision: '[["10000351",20261111,0]]',
  },
};

test("识别协议更新错误并保留通用文案", () => {
  assert.equal(
    isProductAgreementError(
      "会话错误：The DevEco Code service agreements changed. Review and accept them before retrying your request.",
    ),
    true,
  );
  assert.equal(
    isProductAgreementError("Review the product agreements in DevEco Code"),
    true,
  );
  assert.equal(isProductAgreementError("rate limited"), false);
  assert.equal(isProductAgreementError(null), false);
  assert.match(PRODUCT_AGREEMENT_CHANGED_GUIDANCE, /服务协议已更新/);
});

test("review_required 即使本地已接受也要求重新同意", () => {
  assert.equal(productAgreementNeedsAcceptance(agreement), true);
  assert.equal(
    productAgreementNeedsAcceptance({
      ...agreement,
      upload: { ...agreement.upload, state: "uploaded" },
    }),
    false,
  );
  assert.equal(productAgreementNeedsAcceptance({ ...agreement, accepted: false }), true);
});

test("接受协议时提交版本与服务端 revision", () => {
  assert.deepEqual(productAgreementAcceptancePayload(agreement), {
    version: "1",
    accepted: true,
    serviceRevision: '[["10000351",20261111,0]]',
  });
  assert.deepEqual(
    productAgreementAcceptancePayload({
      ...agreement,
      upload: { state: "review_required" },
    }),
    { version: "1", accepted: true },
  );
});

test("同步状态展示为中文说明", () => {
  assert.equal(productAgreementUploadLabel("review_required"), "需要重新同意协议");
  assert.equal(productAgreementUploadLabel("uploaded"), "同步完成");
  assert.equal(productAgreementUploadLabel("failed"), "同步失败");
  assert.equal(productAgreementUploadLabel(undefined), null);
});
