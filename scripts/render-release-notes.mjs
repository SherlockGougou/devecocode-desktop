import fs from "node:fs";

const tag = process.argv[2];
const output = process.argv[3] ?? ".release-notes.md";
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error("用法：node scripts/render-release-notes.mjs vX.Y.Z [output]");
}

const file = `docs/releases/${tag}.md`;
if (!fs.existsSync(file)) {
  throw new Error(`缺少版本说明：${file}`);
}
const notes = fs.readFileSync(file, "utf8");
for (const heading of ["## 中文", "## English"]) {
  if (!notes.includes(heading)) {
    throw new Error(`${file} 缺少 ${heading} 段落`);
  }
}

fs.writeFileSync(output, notes);
console.log(`Release notes: ${file} -> ${output}`);
