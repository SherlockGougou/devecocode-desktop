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

设备面板额外需要 `hdc` 与开启开发者模式的 HarmonyOS 设备。`hdc` 会从 DevEco Studio、
OpenHarmony SDK、`HDC` 环境变量或 PATH 中查找。

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
| `npm run build:debug` | 生成 debug `.app`，最快验证桌面集成 |
| `npm run build` | 生成 release `.app` / `.dmg` |
| `npm run check` | 前端构建 + 全部 Rust 单测 |
| `npm run check:selftest` | 启动真实 serve 的端到端自检 |
| `npm run test` | 只跑 Rust 单测 |

构建产物：

- debug：`src-tauri/target/debug/bundle/macos/DevEco Code.app`
- release：`src-tauri/target/release/bundle/macos/DevEco Code.app`
- dmg：`src-tauri/target/release/bundle/dmg/`

打包后必须退出旧进程再重新打开，托盘“退出”是干净退出路径。源码构建不会热更新已运行
的 `.app`。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DEVECO_BIN_PATH` | 显式指定 `deveco` 可执行文件，优先于自动探测 |
| `DEVECO_DESKTOP_DIR` | 启动时优先打开指定工作区 |
| `DEVECO_DESKTOP_NOTIFY_TEST` | 设置任意值后，在首次就绪时投递一条通知通道测试 |
| `RUST_LOG` | Rust 日志级别，默认 `info` |

本机服务口令由设置页的 `secure` 开关控制。开启后应用生成随机口令并写入应用配置；
测试时不要把它写进仓库或日志。

## 测试分层

### 日常护栏

```bash
npm run check
```

覆盖 TypeScript 类型检查、Vite 构建和 Rust 单元测试，适合每次提交前运行。

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
- `SIGKILL` 后端自愈与退出进程组回收。

它不调用模型，不消耗 token，但需要已登录的 CLI 和解锁的桌面会话。锁屏或文件夹权限弹窗
可能让 CLI 阻塞，导致自检失败。

### 手动 UI 验证

涉及界面的改动必须启动真实 `.app` 并截图确认。至少覆盖：

- 成功路径；
- 空态和失败态；
- 窄窗口与右栏展开/收起；
- 亮色和暗色主题（改动 CSS 时）。

测试数据请使用临时工作区或脱敏样例，不要提交真实会话标题、路径、设备截图和通知内容。

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

自检程序是开发用二进制，默认不参与应用打包；手动运行
`cargo run --bin deveco-selftest` 时需要加 `--features selftest`。

## CD 与 Release

`.github/workflows/release.yml` 在推送 `v*` 标签或手动触发时运行：

1. 校验 tag 与 `package.json`、`ui/package.json`、`src-tauri/Cargo.toml`、
   `src-tauri/tauri.conf.json` 中的版本一致；
2. 分别构建 `aarch64-apple-darwin` 和 `x86_64-apple-darwin`；
3. 通过 `tauri-action` 上传 `.app` / `.dmg` 到 GitHub Release 和 Actions artifacts。

当前发布策略明确**不使用 Developer ID 证书，不做公证**。工作流不配置 `APPLE_*` secrets，
构建使用 ad-hoc 签名；用户需要按[macOS 安装与使用](installation.md)首次放行。若未来改变
分发策略，应在 release workflow 中单独加入签名、公证和密钥管理，不要把凭据放进仓库。

手动发布时，在 Actions 中选择 `Release`，填写与项目版本一致的 tag（例如 `v0.2.0`）。

官网由 `.github/workflows/pages.yml` 部署到 GitHub Pages；本地预览方式见
[website/README.md](../website/README.md)。

## 调试与排障

### CLI 找不到

GUI 进程通常拿不到 shell 的完整 PATH。应用会按设置、`DEVECO_BIN_PATH`、常见 Node
版本目录和 login shell 探测。仍失败时，在“设置 → CLI 与服务”中手动选择可执行文件。

### 后端启动失败

查看 `~/Library/Logs/DevEco Code Desktop/app.log`，并在终端确认：

```bash
deveco --version
deveco serve --hostname 127.0.0.1 --port 4096 --print-logs
```

不要在应用侧使用 `--port 0`。如果端口被占用，让应用重新选择空闲端口，而不是杀掉
不属于本应用的 serve 进程。

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
