import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function usage() {
  throw new Error(
    "用法：node scripts/render-updater-manifests.mjs --tag vX.Y.Z --repo owner/repo --assets <dir> --out <dir> [--pub-date <RFC3339>]",
  );
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) usage();
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    args[key.slice(2)] = value;
    index += 1;
  }
  for (const required of ["tag", "repo", "assets", "out"]) {
    if (!args[required]) usage();
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const tag = args.tag.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`发布标签不是稳定版 SemVer：${args.tag}`);
}
const repo = args.repo.replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
if (!/^[^/]+\/[^/]+$/.test(repo)) {
  throw new Error(`--repo 必须是 owner/repo：${args.repo}`);
}
const assetsDir = path.resolve(args.assets);
const outDir = path.resolve(args.out);
const requestedDate = args["pub-date"] ? Date.parse(args["pub-date"]) : Date.now();
if (Number.isNaN(requestedDate)) {
  throw new Error(`--pub-date 不是有效时间：${args["pub-date"]}`);
}
const pubDate = new Date(requestedDate).toISOString();

const assetNames = readdirSync(assetsDir).filter((name) =>
  name.endsWith(".app.tar.gz") || name.endsWith(".app.tar.gz.sig"),
);

const variants = {
  standard: {
    file: "latest.json",
    match: /^DevEco[ .]Code_(\d+\.\d+\.\d+)_(aarch64|x64)\.app\.tar\.gz$/,
  },
  offline: {
    file: "latest-offline.json",
    match: /^DevEco[ .]Code[ .]Offline_(\d+\.\d+\.\d+)_(aarch64|x64)\.app\.tar\.gz$/,
  },
};

function releaseUrl(name) {
  return `https://github.com/${repo}/releases/download/v${tag}/${encodeURIComponent(name)}`;
}

function readSignature(sigName) {
  const sigPath = path.join(assetsDir, sigName);
  if (!existsSync(sigPath)) {
    throw new Error(`${sigName} 不存在`);
  }
  const signature = readFileSync(sigPath, "utf8").trim();
  if (!signature) {
    throw new Error(`${sigName} 内容为空`);
  }
  // Tauri 2.14 起 .sig 是整段 minisign 文本的 base64；旧版本可能直接写明文。
  let decoded = signature;
  if (!signature.includes("trusted comment:")) {
    try {
      decoded = Buffer.from(signature, "base64").toString("utf8");
    } catch {
      decoded = signature;
    }
  }
  const trusted = decoded
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("trusted comment:"));
  if (!trusted) {
    throw new Error(`${sigName} 缺少 trusted comment`);
  }
  const version = trusted.match(/(?:^|\s)version:([^\s]+)/)?.[1];
  if (!version) {
    throw new Error(`${sigName} 的 trusted comment 没有版本号`);
  }
  if (version !== tag) {
    throw new Error(`${sigName} 签名版本 ${version} 与发布标签 ${tag} 不一致`);
  }
  return signature;
}

function buildManifest(variant) {
  const platforms = {};
  const seen = new Set();
  for (const name of assetNames) {
    const match = variant.match.exec(name);
    if (!match) continue;
    if (seen.has(name)) {
      throw new Error(`重复的更新包：${name}`);
    }
    seen.add(name);
    const [, version, arch] = match;
    if (version !== tag) {
      throw new Error(`${name} 的版本 ${version} 与发布标签 ${tag} 不一致`);
    }
    const signature = readSignature(`${name}.sig`);
    const key = arch === "aarch64" ? "darwin-aarch64" : "darwin-x86_64";
    const platform = {
      signature,
      url: releaseUrl(name),
    };
    // Tauri 会先按 bundle type 查找 darwin-<arch>-app，再退回 darwin-<arch>。
    platforms[key] = platform;
    platforms[`${key}-app`] = platform;
  }

  for (const arch of ["aarch64", "x64"]) {
    const key = arch === "aarch64" ? "darwin-aarch64" : "darwin-x86_64";
    if (!platforms[key] || !platforms[`${key}-app`]) {
      throw new Error(`${variant.file} 缺少 ${arch} 的 .app.tar.gz 或 .sig`);
    }
  }

  return {
    version: tag,
    notes: `https://github.com/${repo}/releases/tag/v${tag}`,
    pub_date: pubDate,
    platforms,
  };
}

mkdirSync(outDir, { recursive: true });
for (const [name, variant] of Object.entries(variants)) {
  const manifest = buildManifest(variant);
  const output = path.join(outDir, variant.file);
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${name}: ${output} (${Object.keys(manifest.platforms).length} platforms)`);
}
