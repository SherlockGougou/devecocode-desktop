# AGENTS.md

本文件是本仓库的协作与工程约定。跨项目规则见 `~/.dsh/AGENTS.md`，这里只写与本仓库有关的。

## 项目定位

macOS 桌面客户端，驱动本机 `deveco` CLI（opencode 的 HarmonyOS 定制分支）的 HTTP + SSE 契约，
自研三栏界面；官方 Web UI 不再提供入口（原「经典界面」窗口已移除）。**不重写 agent 能力；
普通版不打包 CLI，Offline 版内置固定版本 CLI。**

## 常用命令

```bash
npm install                      # 仓库根：拿 tauri CLI
npm --prefix ui install          # 前端依赖
npm run dev                      # tauri dev（自动拉起本机 deveco serve）
npm run build:debug              # 出 .app（最快验证打包）

npm --prefix ui run build        # 前端构建（含 tsc --noEmit）
cargo test --manifest-path src-tauri/Cargo.toml          # 单元测试
cargo run --manifest-path src-tauri/Cargo.toml --features selftest --bin deveco-selftest   # 端到端自检
```

`deveco-selftest` 会真实拉起 `deveco serve`（不花模型 token），覆盖 CLI 定位、端口发现、
健康检查、代理读写、全局事件订阅、通知策略、进程回收。

## 代码地图

| 文件 | 职责 |
|---|---|
| `src-tauri/src/cli.rs` | 定位 CLI：配置 → 环境变量 → 常见路径 → login shell → PATH；解析版本 |
| `src-tauri/src/server.rs` | 拉起 `serve`、解析 listening 行、健康检查、进程组回收 |
| `src-tauri/src/sse.rs` | `text/event-stream` 解析与订阅（自实现，带单测） |
| `src-tauri/src/events.rs` | 事件分类（授权/空闲/错误/阶段）与通知文案；全局事件解包 |
| `src-tauri/src/notify.rs` | 通知策略与去抖（纯函数，时钟注入） |
| `src-tauri/src/http.rs` | 访问 CLI 的 HTTP 客户端（lib 层，自检复用） |
| `src-tauri/src/ipc.rs` | 前端 ↔ CLI 的命令桥：通用代理、设置、导出、窗口标题 |
| `src-tauri/src/terminal.rs` | 底部终端：`/pty` 会话、WebSocket 连接与输出事件 |
| `src-tauri/src/cli_config.rs` | CLI 配置读写：路径解析、JSONC 校验、密钥脱敏、备份、原子写入与重载 |
| `src-tauri/src/bundled_cli.rs` | Offline 版内置 CLI 资源提取、数据目录隔离与 `devecocli` 入口 |
| `src-tauri/src/main.rs` | Tauri 主进程：窗口、托盘、菜单、单实例、信号处理、SSE→通知 |
| `src-tauri/src/device_skill.rs` | 内嵌并安装 `deveco-desktop-device` skill、注入 HDC 环境 |
| `ui/src/store.ts` | 前端状态：会话、消息、权限、SSE 合并、发送 |
| `ui/src/api.ts` | invoke 包装（**所有请求走 Rust 代理**） |
| `ui/src/cliConfig.ts` | 前端 JSONC 编辑、路径变更与配置值读取工具（`jsonc-parser`） |
| `ui/src/components/settings/CliConfigPage.tsx` | 全局/项目配置表单、JSONC 高级编辑、备份恢复 |
| `ui/src/components/settings/useCliConfigEditor.ts` | 配置快照、草稿、保存/重载、密钥显示与冲突处理 |
| `ui/src/components/` | Sidebar / ChatView / Composer / RightPanel / TerminalPanel / Settings / Shortcuts / StatusBar |

## 与 CLI 交互的硬约束（改错会导致「看起来正常但实际不工作」）

1. **订阅 `/global/event`，不要用 `/event`**。后者只推 serve 启动目录那一个实例的事件，跨工作区全部丢失。
   全局事件外层是 `{ directory, project, payload }`，分类与转发前必须解包。
2. **不要用 `--port 0`**。CLI 会当成「未指定」落到默认 4096；应用侧先用 `free_port()` 再显式传入。
3. **进程按进程组回收**。`/opt/homebrew/bin/deveco` 是 node launcher，只杀 launcher 会留下 161MB 子进程；
   统一用 `SIGTERM`（launcher 会转发）→ 超时后 `SIGKILL` 整组，并保留 `SIGTERM/SIGINT/SIGHUP` 兜底。
4. **路径必须规范化**。macOS 上 `/tmp` 是 `/private/tmp` 的符号链接，CLI 返回的 `worktree` 是规范化后的路径。
5. **会话列表按 `?directory=` 查询**；`/project` 可能对同一路径返回多条不同 id 的记录，前端按 `worktree` 去重。
6. **`/find/file` 必须带 `query`**（不带是 400；值可以是空字符串，空串返回工作区文件列表，@ 弹层靠它列全量）。
   目录浏览用 `/file?path=`，内容预览用 `/file/content?path=`。
7. **变更面板按来源分别读取，不做自动回退**：工作区用 `/vcs/diff?mode=git`，本次会话用
   `/session/{id}/diff`；文件状态徽标读取 `/vcs/status`，与 diff 来源相互独立。
8. **归档只是元数据**（`PATCH time.archived`），列表不会自动过滤，由前端过滤。
9. **prompt 契约**：`POST /session/{id}/message` 支持 `parts`、`model{providerID,modelID}`、`agent`、`variant`、`noReply`。
   附件用 `FilePartInput { type:"file", mime, url, filename }`，`url` 为 data URL。
   **工作区文件引用（@）用 `url: "file://<绝对路径>"` 的 file part**：serve 会自己读盘并合成 Read 工具调用
   + 文件内容给模型，客户端不要把内容内联进消息；可附 `source.type="file"` 记录相对路径与 @token 位置。
10. **前端不直连 `127.0.0.1`**：必须经 `server_request` 代理，否则会遇到 CORS/ATS，并且连接信息会泄漏到 WebView。
11. **serve 必须从受控目录启动，不能继承 Finder 的 `/`**：CLI 会把启动目录当成默认工作区并建立文件监听；
    直接继承 `/` 会扫描整个磁盘，造成异常 CPU 和内存占用。应用统一使用
    `~/Library/Application Support/DevEco Code Desktop/server-cwd`，用户工作区由请求里的 `directory` 指定。
12. **内嵌设备 skill 只写 CLI 的 skills 目录**：安装到 CLI 实际使用的
    `skills/deveco-desktop-device/`，使用 `.deveco-desktop-managed` 标记判断所有权；
    不修改 `deveco.jsonc`，不覆盖没有标记的用户同名目录。已复用的外部 serve 不会热加载
    skill，需重启服务后生效。
13. **CLI 配置写入统一走 `cli_config`**：全局配置来自 `/path` 的 `config` 目录；项目配置按
    `.deveco/deveco.jsonc` → 工作区根 `deveco.jsonc` 选择，首次保存创建 `.deveco/deveco.jsonc`，
    绝不写项目根 `config.json`。项目作用域必须带 `directory`，不能落到 `server-cwd`。写入前校验
    base hash、保存备份并原子替换；写入后调用 `/instance/dispose?directory=` 或 `/global/dispose`
    并重新读取验证，失败恢复备份。密钥默认脱敏，日志、Zustand 和 localStorage 不得出现明文。
14. **终端 PTY 连接只在 Rust 侧建立**：前端调用 `terminal_*` 命令，不接触 `/pty` 端口、
    ticket 或 Basic Auth。Rust 先创建 PTY、调整初始尺寸，再用一次性 ticket 连接
    `/pty/{id}/connect`；关闭面板时必须 `DELETE /pty/{id}`，避免 shell 残留。

## 代码约定

- 注释与文档用中文；标识符、API 名、协议字段保持英文原文。
- Rust：错误用 `anyhow`/`thiserror` 带上上下文，不吞错；纯逻辑（解析、分类、策略、去抖）必须有单测。
- TypeScript：严格模式；状态集中在 `store.ts`，组件不直接发请求（走 `api.ts`）。
- 新增面板/控件要有空态与失败态文案，不能只画成功路径。
- 不引入新依赖前先确认现有依赖能否满足；前端尽量不新增运行时依赖。

## 完成定义

一次改动算完成，需要：

1. `npm --prefix ui run build` 通过（含类型检查）；改了 Rust 跑 `cargo fmt --check`、
   `cargo clippy` 和 `cargo test`；
2. 动了 CLI 交互逻辑，跑一次 `deveco-selftest`；
3. 动了 UI，启动应用并**真机截图**确认（不能只看构建通过）；
4. 行为变化同步到 `README.md` 与 `docs/`；当前架构写在 `docs/architecture.md`，
   开发流程写在 `docs/development.md`，历史决策与踩坑归档在
   `docs/archive/implementation-log.md`。

## 已知坑（会重复踩）

- 用字符串替换打补丁时，`cargo fmt`/格式化会改掉锚点导致补丁**静默失效**；补丁后必须 `grep` 核对。
- Vite 构建产物落在 `dist/`，Tauri 打包时 `beforeBuildCommand` 会重新构建，不要在源码里手改 `dist/`。
- 打包后的应用要**退出重开**才加载新构建；托盘「退出」是干净退出路径。
- 系统通知：未签名也能投递；通知点击只能聚焦窗口，不能定位到会话。
- 权限审批卡片需要 CLI 侧 `permission` 为 `ask` 才会触发；本机默认 `allow` 时不会出现。
- 新增或更新 skill 后 CLI 只在启动时扫描；普通版下次拉起 serve 生效，复用已有实例时需显式重启服务。

## 明确不做

- 多 Tab（用户已明确不要）。
- 普通版不打包 CLI 二进制；Offline 版只内置固定版本 CLI，不解析
  `~/.local/share/deveco/*.db`。
- 不执行 Plugin 的 npm 安装；设置页只编辑 `plugin` 配置项。
- 不编辑文件型 Agent/Command 的 Markdown；只编辑 `deveco.jsonc` 中的配置型条目。
