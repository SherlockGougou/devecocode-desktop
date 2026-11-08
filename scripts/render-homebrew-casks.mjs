import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const versionArg = valueOf("--version");
const sumsPath = valueOf("--sums");
const outDir = valueOf("--out-dir");
if (!versionArg || !sumsPath || !outDir) {
  throw new Error(
    "用法：node scripts/render-homebrew-casks.mjs --version vX.Y.Z --sums SHA256SUMS.txt --out-dir Casks",
  );
}

const version = versionArg.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`版本格式无效：${versionArg}，应为 vX.Y.Z 或 X.Y.Z`);
}

const sums = new Map();
for (const line of readFileSync(sumsPath, "utf8").split(/\r?\n/)) {
  const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/);
  if (match) sums.set(match[2], match[1]);
}

const required = {
  standardArm: `DevEco.Code_${version}_aarch64.dmg`,
  standardIntel: `DevEco.Code_${version}_x64.dmg`,
  offlineArm: `DevEco.Code.Offline_${version}_aarch64.dmg`,
  offlineIntel: `DevEco.Code.Offline_${version}_x64.dmg`,
};
for (const [key, file] of Object.entries(required)) {
  if (!sums.has(file)) {
    throw new Error(`SHA256SUMS 缺少 ${key} 对应资产：${file}`);
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const templateDir = join(scriptDir, "homebrew");
const render = (templateName, values) => {
  let output = readFileSync(join(templateDir, templateName), "utf8");
  for (const [key, value] of Object.entries(values)) {
    output = output.split(`__${key}__`).join(value);
  }
  if (/__[A-Z0-9_]+__/.test(output)) {
    throw new Error(`模板 ${templateName} 仍有未替换的占位符`);
  }
  return output;
};

mkdirSync(outDir, { recursive: true });
const casks = [
  [
    "devecocode-desktop.rb",
    "devecocode-desktop.rb.tpl",
    {
      VERSION: version,
      SHA256_ARM: sums.get(required.standardArm),
      SHA256_INTEL: sums.get(required.standardIntel),
    },
  ],
  [
    "devecocode-desktop-offline.rb",
    "devecocode-desktop-offline.rb.tpl",
    {
      VERSION: version,
      SHA256_ARM: sums.get(required.offlineArm),
      SHA256_INTEL: sums.get(required.offlineIntel),
    },
  ],
];

for (const [fileName, templateName, values] of casks) {
  const output = join(outDir, fileName);
  writeFileSync(output, render(templateName, values));
  console.log(`已生成 ${output}`);
}
