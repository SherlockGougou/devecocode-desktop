# 开发指南

## 前置条件

- macOS 12 或更高版本；
- Node.js 20+ 与 npm；
- Rust 1.77+（建议使用当前 stable）；
- 本机已安装 [DevEco Code CLI](https://www.npmjs.com/package/@deveco/deveco-code)：

```bash
npm i -g @deveco/deveco-code
deveco providers   # 或 deveco auth
deveco --version
```

设备面板和 Agent 设备 skill 额外需要 `hdc` 与开启开发者模式的 HarmonyOS 设备。`hdc` 会从
DevEco Studio、OpenHarmony SDK、`HDC` 环境变量或 PATH 中查找。应用在启动 serve 前定位
一次 `hdc`，并把结果注入 CLI 环境；仍找不到时 skill 会给出 SDK 路径兜底。

## 首次安装

```bash
npm install
npm --prefix ui install
```

根目录的 `node_modules` 只提供 Tauri CLI；前端依赖在 `ui/` 下单独安装。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | Tauri 开发模式，自动拉起本机 `deveco serve` |
| `npm --prefix ui run dev` | 只启动 Vite，适合纯前端页面调试 |
| `npm --prefix ui run build` | TypeScript 类型检查 + 前端生产构建 |
| `npm --prefix ui test` | 前端纯逻辑测试 |
| `npm run build:debug` | 生成 debug `.app`，最快验证桌面集成 |
| `npm run build` | 生成 release `.app` / `.dmg` |
| `npm run build:offline` | 生成包含固定 CLI 的离线 `.app` / `.dmg` |
| `npm run stage:offline-cli` | 只准备内置 CLI 资源，不打包应用 |
| `npm run check` | 前端测试/构建 + 全部 Rust 单测 |
| `npm run check:selftest` | 启动真实 serve 的端到端自检 |
| `npm run test` | 只跑 Rust 单测 |

构建产物：

- debug：`src-tauri/target/debug/bundle/macos/DevEco Code.app`
- release：`src-tauri/target/release/bundle/macos/DevEco Code.app`
- dmg：`src-tauri/target/release/bundle/dmg/`

打包后必须退出旧进程再重新打开，托盘“退出”是干净退出路径。源码构建不会热更新已运行
的 `.app`。

离线版默认构建当前架构；跨架构时查看[离线版打包](offline-packaging.md)的
`--platform-source` 说明。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DEVECO_BIN_PATH` | 显式指定 `deveco` 可执行文件，优先于自动探测 |
| `DEVECO_DESKTOP_DIR` | 启动时优先打开指定工作区 |
| `DEVECO_DESKTOP_NOTIFY_TEST` | 设置任意值后，在首次就绪时投递一条通知通道测试 |
| `HDC` | 显式指定 hdc 可执行文件；未设置时由应用自动探测并注入 serve |
| `RUST_LOG` | Rust 日志级别，默认 `info` |
| `TAURI_SIGNING_PRIVATE_KEY` | 打更新包时使用的 Ed25519 私钥内容或路径；只放在本机或 GitHub Actions secret |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥口令；无口令时留空 |

本机服务口令由设置页的 `secure` 开关控制。开启后应用生成随机口令并写入应用配置；
测试时不要把它写进仓库或日志。

## 测试分层

### 日常护栏

```bash
npm run check
```

覆盖前端纯逻辑测试、TypeScript 类型检查、Vite 构建和 Rust 单元测试，适合每次提交前运行。

### 端到端自检

```bash
npm run check:selftest
```

自检会真实拉起 `deveco serve`，覆盖：

- CLI 定位、版本解析与启动失败清理；
- 随机端口、健康检查、`/api/location`；
- 代理建会话、写入、读取与删除；
- `/global/event` 订阅与事件分类；
- 通知策略与去抖；
- 内嵌 `deveco-desktop-device` skill 写入后能被 CLI 的 `/skill/status` 发现；
- `SIGKILL` 后端自愈与退出进程组回收。

它不调用模型，不消耗 token，但需要已登录的 CLI 和解锁的桌面会话。锁屏或文件夹权限弹窗
可能让 CLI 阻塞，导致自检失败。

### 手动 UI 验证

涉及界面的改动必须启动真实 `.app` 并截图确认。至少覆盖：

- 成功路径；
- 空态和失败态；
- 窄窗口与右栏展开/收起；
- 底部终端展开、输入命令、拖高、重开和关闭后 PTY 回收；
- 亮色和暗色主题（改动 CSS 时）。

测试数据请使用临时工作区或脱敏样例，不要提交真实会话标题、路径、设备截图和通知内容。
准备 README 或官网素材时，截图统一放在 `docs/assets/screenshots/` 并复制到
`website/assets/screenshots/`；设备截图只保留公开可展示的机型、系统版本和系统页面，
不能包含通知、账号或聊天内容。素材清单和生成约定见
[截图素材](assets/screenshots/README.md)。

### 更新包本地验证

应用内更新的真实替换需要两个版本和同一把签名密钥。测试时不要改提交里的版本号，使用
`.agent-temp/` 下的临时 Tauri 配置覆盖 `version`、`plugins.updater.endpoints` 和
`dangerousInsecureTransportProtocol`，构建较低/较高两个测试 `.app`，再用本地 HTTP
服务提供 `latest.json`。安装较低版本、触发检查、下载、替换和重启，确认更新机制生效；
如果要同时验证界面显示的版本号，临时用 `npm run release:prepare` 同步四处版本文件，
测试后逐个还原。测试配置不能进入发布包；正式发布只使用 `src-tauri/tauri.updater.conf.json` 和
`TAURI_SIGNING_PRIVATE_KEY`。

清单脚本可以独立验证：

```bash
node scripts/updater/prepare-fixtures.mjs --out /tmp/updater-fixture-assets
node scripts/render-updater-manifests.mjs \
  --tag v0.2.3 \
  --repo example/repo \
  --assets /tmp/updater-fixture-assets \
  --out /tmp/updater-manifests \
  --pub-date 2026-11-08T00:00:00Z
```

验证设备 skill：

```bash
deveco debug skill | rg 'deveco-desktop-device'
```

首次启动应用或运行 `deveco-selftest` 会把 skill 安装到 CLI 的全局 skills 目录：
`~/.config/deveco/skills/deveco-desktop-device/`。Offline 版写入隔离的 CLI 配置目录。
该目录带 `.deveco-desktop-managed` 标记，应用只更新自己管理的内容；不要手动修改这个目录，
也不要把它当成 `deveco.jsonc` 的一部分。

## CLI 配置读写

设置页的配置编辑由 `src-tauri/src/cli_config.rs` 和前端
`ui/src/cliConfig.ts`、`components/settings/CliConfigPage.tsx` 共同完成：

- 全局路径来自 `/path` 的 `config` 目录，按 `deveco.jsonc` → `deveco.json` → `config.json`
  选择；项目路径按 `.deveco/deveco.jsonc` → 工作区根 `deveco.jsonc` 选择，首次保存创建
  `.deveco/deveco.jsonc`，不写项目根 `config.json`。
- 项目作用域必须带 `directory`；`server-cwd` 只用于启动 CLI，不能当作项目配置写入目标。
- 前端用 `jsonc-parser` 的 `modify`/`applyEdits` 保留注释和缩进；后端用
  `jsonc-parser` 校验、脱敏和还原密钥哨兵。
- 保存前比较 base hash，旧文件备份到应用数据目录（`0600`，每个配置目标最近 10 份）；写入使用
  临时文件 + rename，随后调用 `/instance/dispose` 或 `/global/dispose` 并重新读取验证。
- 重载失败时恢复备份，并把原始错误返回设置页；运行中的任务可能被中断，保存前会二次确认。

需要真实 CLI 的配置集成测试默认 `#[ignore]`，确认本机已安装 CLI 后运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored
```

## 格式与静态检查

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

CI 会以 `-D warnings` 运行 Clippy。本地出现告警时先确认是否由本次改动引入，不要用
`#[allow]` 直接吞掉；只有像纯几何函数参数过多这类已确认可读性收益的情况才允许局部豁免。

## CI

`.github/workflows/ci.yml` 在 macOS runner 上执行：

1. 安装根目录与 `ui/` 依赖；
2. `npm run check:version` 校验四处版本号一致；
3. `cargo fmt --check`；
4. 前端生产构建；
5. `cargo clippy -- -D warnings`；
6. Rust 单测。

CI 不运行 `deveco-selftest`，因为 runner 没有用户登录的 CLI；这项检查由贡献者在本地完成。
CI 还会并行运行 `offline-resources` job，分别下载 arm64/x64 的固定 CLI 包并验证离线
资源生成；它不构建 Tauri 应用，实际离线应用由 Release workflow 构建。

自检程序是开发用二进制，默认不参与应用打包；手动运行
`cargo run --bin deveco-selftest` 时需要加 `--features selftest`。

### CodeQL 与依赖审查

- `.github/workflows/codeql.yml`：Rust、JavaScript/TypeScript 和 GitHub Actions 三条
  分析任务，在 push、PR、每周计划和手动触发时运行。
- `.github/workflows/dependency-review.yml`：PR 中检查依赖变更，高危漏洞会失败；
  依赖图未启用时该检查会报错，仓库设置中必须保持 Dependency graph 开启。
- `.github/dependabot.yml`：根 npm、`ui/` npm、`src-tauri` Cargo 和 GitHub Actions
  每周更新；minor/patch 分组，major 单独提 PR。
  Cargo 侧显式忽略 Linux-only 传递依赖 `glib`，本项目只构建 macOS，当前依赖链无法
  解析到 Dependabot 要求的修复版本。

`.github/rulesets/main.json` 和 `tags.json` 是仓库 ruleset 的可审查副本。首次创建或重建：

```bash
gh api --method POST repos/<owner>/<repo>/rulesets --input .github/rulesets/main.json
gh api --method POST repos/<owner>/<repo>/rulesets --input .github/rulesets/tags.json
```

`main` 规则要求 PR、CI、CodeQL 和 Dependency Review；`v*` 规则限制更新、删除和
force push。规则里的 `bypass_actors` 只允许仓库所有者绕过。

## CD 与 Release

`.github/workflows/release.yml` 在推送 `v*` 标签或手动触发时运行：

1. 校验 tag 与 `package.json`、`ui/package.json`、`src-tauri/Cargo.toml`、
   `src-tauri/tauri.conf.json` 中的版本一致；
2. 分别构建 `aarch64-apple-darwin` 和 `x86_64-apple-darwin`；
3. 通过 `tauri-action` 把普通版 `.app` / `.dmg`、`.app.tar.gz` 和 `.sig` 写入 **draft**
   Release 和 Actions artifacts；构建时额外传入 `src-tauri/tauri.updater.conf.json`，
   由 CI secret `TAURI_SIGNING_PRIVATE_KEY` 签名；
4. `offline` job 构建离线包并继续写入同一 draft；
5. `build` 和 `offline` job 分别用 `actions/attest` 为 DMG/zip 生成 build provenance；
6. `checksums` job 下载 draft 资产，生成 `SHA256SUMS.txt`，再由
   `scripts/render-updater-manifests.mjs` 生成 `latest.json` 和 `latest-offline.json` 并上传；
7. `release-notes` job 更新双语正文；
8. `publish` job 校验资产数量、`SHA256SUMS.txt`、两套 updater 清单和双语正文后执行
   `gh release edit --draft=false`。

发布流程刻意保持 draft-first。不要把 `releaseDraft` 或 `softprops` 的 `draft` 改回
`false`：启用 release immutability 后，已发布 Release 不能再追加资产，Offline 包会上传失败。

当前发布策略明确**不使用 Developer ID 证书，不做公证**。工作流不配置 `APPLE_*` secrets，
构建使用 ad-hoc 签名；用户需要按[macOS 安装与使用](installation.md)首次放行。若未来改变
分发策略，应在 release workflow 中单独加入签名、公证和密钥管理，不要把凭据放进仓库。

准备新版本时，先用脚本同步四处版本号：

```bash
npm run release:prepare -- 0.2.4
```

然后编写 `docs/releases/v0.2.4.md`、更新 CHANGELOG 和官网页脚。推送前在 Actions 中手动
运行 `Release readiness`，输入 `v0.2.4`；它会校验版本一致性、双语正文和占位符。

手动发布时，在 Actions 中选择 `Release`，填写与项目版本一致的 tag（例如 `v0.2.4`）。
同一 workflow 的 `offline` job 还会构建包含固定 CLI 的离线版；其资源准备、体积和验收见
[离线版打包](offline-packaging.md)。

Release 正文读取 `docs/releases/vX.Y.Z.md`，必须同时包含中英文段落。新增版本时先创建对应
文件，再推送 `vX.Y.Z` 标签；发布流程先在 draft 中更新正文，最后由 `publish` job 发布。

Release 成功后，`update-homebrew.yml` 会用 `HOMEBREW_TAP_TOKEN` 把两个 cask 更新到
`SherlockGougou/homebrew-tap`；失败时用 `workflow_dispatch` 输入同一个 tag 重跑。可以用
`npm run homebrew:render -- --version v0.2.4 --sums SHA256SUMS.txt --out-dir /tmp/casks`
在本地预览生成结果，再运行 `brew style`。

官网由 `.github/workflows/pages.yml` 部署到 GitHub Pages；本地预览方式见
[website/README.md](../website/README.md)。

## 调试与排障

### CLI 找不到

GUI 进程通常拿不到 shell 的完整 PATH。应用会按设置、`DEVECO_BIN_PATH`、常见 Node
版本目录和 login shell 探测。`deveco` 本身是 `#!/usr/bin/env node` 启动器，应用在拉起
`serve` 前还会把 CLI 目录、Homebrew / npm 全局目录和 nvm / fnm 版本目录并入子进程
`PATH`，否则会因找不到 `node` 而立即退出。仍失败时，在“设置 → CLI 与服务”中手动选择
可执行文件。

### 后端启动失败

失败横幅会带 `serve` 的 stdout / stderr 尾部（例如
`env: node: No such file or directory`），完整内容在
`~/Library/Logs/DevEco Code Desktop/app.log`。也可以在终端确认：

```bash
deveco --version
deveco serve --hostname 127.0.0.1 --port 4096 --print-logs
```

不要在应用侧使用 `--port 0`。如果端口被占用，让应用重新选择空闲端口，而不是杀掉
不属于本应用的 serve 进程。

serve 固定从 `~/Library/Application Support/DevEco Code Desktop/server-cwd` 启动。不要改回
继承 Finder 的工作目录：从 Finder 启动时 cwd 是 `/`，CLI 会把整个根目录当作工作区并建立
文件监听，导致异常 CPU 和内存占用。真正的用户工作区始终通过请求的 `directory` 参数传入。

### 锁屏后无响应

CLI 在锁屏/休眠时可能阻塞，解锁后恢复。应用会将普通代理请求限制在 30 秒，并走
`prompt_async` 避免长任务被代理超时截断；后端自愈无法在锁屏状态下完成。

### 文件夹权限反复弹出

重建 debug 包可能改变 ad-hoc 签名，使 macOS TCC 记录失效。可在系统设置中重新授权，
或在终端重置后重启应用：

```bash
tccutil reset SystemPolicyDocumentsFolder com.deveco.desktop
```

### 托盘退出后仍有 serve

先确认不是用户自己启动的固定端口实例。应用只回收自己登记在案、且确认由本次启动创建的
进程组；复用的外部实例不会被杀。若仍有孤儿，记录 PID、端口和日志后提交 issue。

## 提交前检查清单

- 改动范围与 issue/pull request 描述一致；
- `npm run check` 通过；
- 改过 CLI 交互时 `npm run check:selftest` 通过；
- 改过 UI 时附真实应用截图并覆盖失败态；
- 新增或修改的配置、环境变量、数据路径已写入文档；
- `git diff --check` 通过；
- 没有凭据、私有路径、真实会话数据或未脱敏截图进入提交。
