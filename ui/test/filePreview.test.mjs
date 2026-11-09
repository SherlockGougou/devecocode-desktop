import assert from "node:assert/strict";
import test from "node:test";
import { inlineImageMime } from "../test-dist/filePreview.js";

test("本地图片扩展名忽略 Markdown URL 的 query 和 fragment", () => {
  assert.equal(inlineImageMime("shots/a.png"), "image/png");
  assert.equal(inlineImageMime("shots/a%20b.png?raw=1#preview"), "image/png");
  assert.equal(inlineImageMime("shots/a.SVG?download=1"), "image/svg+xml");
  assert.equal(inlineImageMime("shots/a.txt"), "");
});
