import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const hostTarget =
  process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const target = args.target ?? hostTarget;
const platform = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
}[target];

if (!platform) {
  fail(`暂不支持 target=${target}；当前只支持 macOS arm64/x64`);
}

const source = path.resolve(
  args.source ??
    path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@deveco/deveco-code"),
);
const nodeModulesRoot = path.resolve(
  args["node-modules"] ?? path.join(source, "node_modules"),
);
const platformSource = path.resolve(
  args["platform-source"] ?? path.join(source, "node_modules", "@deveco", `deveco-code-${platform}`),
);
const output = path.resolve(args.output ?? path.join(root, "src-tauri", "resources", "cli"));

const mainPackage = readJson(path.join(source, "package.json"));
const platformPackage = readJson(path.join(platformSource, "package.json"));
const cliPackage = readJson(path.join(nodeModulesRoot, "@deveco", "deveco-cli", "package.json"));
const commonPackage = readJson(path.join(nodeModulesRoot, "@deveco", "deveco-cli-common", "package.json"));

const binaryName = platform === "darwin-x64" || platform === "darwin-arm64" ? "deveco" : "deveco.exe";
const binaryPath = path.join(platformSource, "bin", binaryName);
if (!fs.existsSync(binaryPath)) {
  fail(
    `找不到 ${platform} 原生二进制：${binaryPath}\n` +
      "如果是交叉打包，请用 --platform-source 指向对应的 @deveco/deveco-code-darwin-* 包。",
  );
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, "bin"), { recursive: true });
fs.copyFileSync(binaryPath, path.join(output, "bin", "deveco"));
fs.chmodSync(path.join(output, "bin", "deveco"), 0o755);

copyDir(path.join(platformSource, "vendor"), path.join(output, "vendor"), (src) => {
  return path.basename(src) !== ".deveco-cli-entry";
});

copyDir(nodeModulesRoot, path.join(output, "node_modules"), (src) => {
  const relative = path.relative(nodeModulesRoot, src);
  const parts = relative.split(path.sep);
  return !(
    parts[0] === "@deveco" &&
    (parts[1] === "deveco-code" || parts[1]?.startsWith("deveco-code-"))
  );
});

copyIfExists(path.join(source, "LICENSE"), path.join(output, "LICENSE"));
copyIfExists(path.join(source, "README.md"), path.join(output, "README.md"));
copyIfExists(path.join(source, "CHANGELOG.md"), path.join(output, "CHANGELOG.md"));
copyIfExists(
  path.join(nodeModulesRoot, "@deveco", "deveco-cli-common", "LICENSE"),
  path.join(output, "LICENSES", "deveco-cli-common-LICENSE"),
);
copyIfExists(
  path.join(nodeModulesRoot, "@deveco", "deveco-cli-common", "THIRD-PARTY-LICENSES"),
  path.join(output, "THIRD-PARTY-LICENSES"),
);

fs.writeFileSync(
  path.join(output, "manifest.json"),
  JSON.stringify(
    {
      package: mainPackage.name,
      packageVersion: mainPackage.version,
      platformPackage: platformPackage.name,
      platformVersion: platformPackage.version,
      cliPackage: cliPackage.name,
      cliVersion: cliPackage.version,
      commonPackage: commonPackage.name,
      commonVersion: commonPackage.version,
      target,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);

console.log(`已准备内置 CLI：${output}`);
console.log(`  version: ${mainPackage.version} / ${cliPackage.version}`);
console.log(`  target:  ${target}`);
console.log(`  binary:  ${path.join(output, "bin", "deveco")}`);

function copyDir(sourceDir, targetDir, filter = () => true) {
  if (!fs.existsSync(sourceDir)) {
    fail(`内置 CLI 缺少目录：${sourceDir}`);
  }
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter,
  });
}

function copyIfExists(sourceFile, targetFile) {
  if (!fs.existsSync(sourceFile)) return;
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.copyFileSync(sourceFile, targetFile);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`读取 ${file} 失败：${error.message}`);
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
