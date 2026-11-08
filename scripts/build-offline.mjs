import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const targetIndex = args.indexOf("--target");
const target =
  targetIndex >= 0 && args[targetIndex + 1]
    ? args[targetIndex + 1]
    : process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-apple-darwin";

const stageArgs = ["scripts/stage-offline-cli.mjs", "--target", target];
const platformSourceIndex = args.indexOf("--platform-source");
if (platformSourceIndex >= 0 && args[platformSourceIndex + 1]) {
  stageArgs.push("--platform-source", args[platformSourceIndex + 1]);
}

execFileSync("node", stageArgs, { cwd: root, stdio: "inherit" });
execFileSync(
  "npx",
  [
    "tauri",
    "build",
    "--config",
    "src-tauri/tauri.offline.conf.json",
    "--target",
    target,
  ],
  { cwd: root, stdio: "inherit" },
);
