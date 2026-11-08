import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outIndex = process.argv.indexOf("--out");
if (outIndex < 0 || !process.argv[outIndex + 1]) {
  throw new Error("用法：node scripts/updater/prepare-fixtures.mjs --out <dir>");
}

const fixtures = path.resolve("scripts/updater/fixtures/assets");
const output = path.resolve(process.argv[outIndex + 1]);
mkdirSync(output, { recursive: true });

const signatures = readdirSync(fixtures).filter((name) => name.endsWith(".app.tar.gz.sig"));
if (signatures.length === 0) {
  throw new Error(`${fixtures} 中没有签名 fixture`);
}

for (const name of signatures) {
  const archive = name.slice(0, -".sig".length);
  // 测试只关心文件名和签名内容；真实更新包不能进入仓库。
  writeFileSync(path.join(output, archive), "");
  copyFileSync(path.join(fixtures, name), path.join(output, name));
  console.log(`fixture: ${archive}`);
}
