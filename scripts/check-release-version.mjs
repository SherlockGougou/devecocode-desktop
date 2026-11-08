import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const expected = process.argv[2]?.replace(/^v/, "");
const jsonFiles = [
  ["package.json", JSON.parse(readFileSync("package.json", "utf8")).version],
  ["ui/package.json", JSON.parse(readFileSync("ui/package.json", "utf8")).version],
  [
    "src-tauri/tauri.conf.json",
    JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version,
  ],
];

const metadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--no-deps",
      "--format-version",
      "1",
    ],
    { encoding: "utf8" },
  ),
);
const cargoVersion = metadata.packages.find((pkg) => pkg.name === "deveco-desktop")?.version;
if (!cargoVersion) {
  throw new Error("Cargo metadata 中没有找到 deveco-desktop");
}
jsonFiles.push(["src-tauri/Cargo.toml", cargoVersion]);

const versions = new Set(jsonFiles.map(([, version]) => version));
if (versions.size !== 1) {
  const details = jsonFiles.map(([file, version]) => `  ${file}: ${version}`).join("\n");
  throw new Error(`项目版本不一致：\n${details}`);
}

const version = jsonFiles[0][1];
if (expected && expected !== version) {
  throw new Error(`发布标签 v${expected} 与项目版本 ${version} 不一致`);
}

const releaseNotes = `docs/releases/v${version}.md`;
let notes;
try {
  notes = readFileSync(releaseNotes, "utf8");
} catch {
  throw new Error(`缺少版本说明：${releaseNotes}`);
}
for (const heading of ["## 中文", "## English"]) {
  if (!notes.includes(heading)) {
    throw new Error(`${releaseNotes} 缺少 ${heading} 段落`);
  }
}

console.log(version);
