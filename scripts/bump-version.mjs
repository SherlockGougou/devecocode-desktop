import { readFileSync, writeFileSync } from "node:fs";

const input = process.argv[2]?.replace(/^v/, "");
if (!input || !/^\d+\.\d+\.\d+$/.test(input)) {
  throw new Error("用法：node scripts/bump-version.mjs X.Y.Z");
}

const files = [
  ["package.json", /("version"\s*:\s*")([^"]+)(")/],
  ["ui/package.json", /("version"\s*:\s*")([^"]+)(")/],
  ["src-tauri/tauri.conf.json", /("version"\s*:\s*")([^"]+)(")/],
  ["src-tauri/Cargo.toml", /^(version\s*=\s*")([^"]+)(")/m],
];

const versions = files.map(([file, pattern]) => {
  const text = readFileSync(file, "utf8");
  const match = text.match(pattern);
  if (!match) throw new Error(`${file} 中没有找到版本字段`);
  return { file, version: match[2] };
});

const current = new Set(versions.map(({ version }) => version));
if (current.size !== 1) {
  const details = versions.map(({ file, version }) => `  ${file}: ${version}`).join("\n");
  throw new Error(`项目版本不一致，先修复再升级：\n${details}`);
}

const previous = versions[0].version;
if (previous === input) {
  console.log(`版本已经是 ${input}`);
  process.exit(0);
}

for (const [file, pattern] of files) {
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace(pattern, `$1${input}$3`));
  console.log(`${file}: ${previous} -> ${input}`);
}

console.log(`
下一步：
  1. 编写 docs/releases/v${input}.md（中文和 English 两段）
  2. 更新 CHANGELOG.md、docs/releases/README.md 和官网页脚版本
  3. 运行 npm run check && npm run check:version ${input}
  4. 提交后运行 Release readiness workflow，再打 v${input} 标签`);
