# 离线版打包

离线版把固定版本的 DevEco Code CLI 和桌面端一起放进 `.app`，安装时不需要先安装 Node/npm
或全局 `deveco`。它解决的是**离线安装**，不是完全离线运行：

- 华为账号登录、模型调用、HarmonyOS 知识库仍需要网络；
- HarmonyOS 构建、真机运行和模拟器仍需要 DevEco Studio、SDK、HDC 等外部工具；
- 当前只支持 macOS。

## 构建

```bash
npm install
npm --prefix ui install
npm run build:offline -- --target aarch64-apple-darwin
```

默认从本机全局安装的 `@deveco/deveco-code` 取 CLI。构建 x64 时，如果当前机器没有对应
平台包，传入平台包目录：

```bash
npm run build:offline -- \
  --target x86_64-apple-darwin \
  --platform-source /path/to/@deveco/deveco-code-darwin-x64
```

只生成 CLI 资源、不打包应用：

```bash
npm run stage:offline-cli -- --target aarch64-apple-darwin
```

资源生成在 `src-tauri/resources/cli/`，该目录被 `.gitignore` 忽略，不提交到仓库。
`tauri.offline.conf.json` 将它映射到 `.app/Contents/Resources/bundled-cli/`，并使用独立的
产品名和 bundle identifier。

## 当前打包内容

- `@deveco/deveco-code` 的原生 `deveco` 二进制；
- `vendor/`（devecocli 入口、UI 验证资源和 ripgrep）；
- `@deveco/deveco-cli`、`deveco-cli-common` 及其运行依赖；
- CLI `LICENSE`、`deveco-cli-common` 的第三方许可证和版本 manifest。

当前实测体积约为 `.app 281MiB`、`.dmg 119MiB`（arm64）；x64 会有差异。

## 启动流程

1. `.app` 内的资源是只读的，首次启动复制到
   `~/Library/Application Support/DevEco Code Desktop/cli-runtime/<version>/`。
2. 在副本中写入 `vendor/.deveco-cli-entry` 的绝对路径。
3. 设置 `XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_CACHE_HOME`、`XDG_STATE_HOME` 到
   `~/Library/Application Support/DevEco Code Desktop/cli/`，避免和系统 CLI 共用会话数据库。
4. 设置 `DEVECO_DISABLE_AUTOUPDATE` 和 `DEVECO_CLI_DISABLE_UPDATE`，固定内置 CLI 版本。
5. 通过 `use_bundled_cli` 设置优先使用内置 CLI；手动填写 `cli_path` 时使用系统 CLI。

内置 CLI 的数据目录与系统 CLI 分开后，用户需要在内置 CLI 中重新登录一次。

## 发布

`.github/workflows/release.yml` 的 `offline` job 在版本标签或手动发布时构建两个架构：

- 从 npm 下载固定版本 CLI；
- 用 `npm pack` 取出目标架构平台包，避免在 arm runner 上安装 x64 包；
- 生成离线 DMG 和 `.app.zip`，上传到同一个 GitHub Release；
- 保持 ad-hoc 签名，不配置 Apple Developer ID，也不做公证。

发布前至少验证：

1. 没有全局 CLI 的机器可以直接打开离线 `.app`；
2. 应用使用 `cli-runtime` 中的内置二进制并拉起 `serve`；
3. `cli/config`、`cli/data` 被使用，系统 CLI 的目录没有被改写；
4. arm64 和 x64 各自的 DMG 可安装；
5. 断网时应用能打开并给出可读错误；
6. CLI 许可证和第三方 notices 随 DMG 分发。
