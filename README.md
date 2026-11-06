# DevEco Code Desktop

把本机的 [DevEco Code CLI](https://www.npmjs.com/package/@deveco/deveco-code)（opencode 的 HarmonyOS 定制分支）
包成 macOS 桌面应用。**自研 DSH 式界面**，直接驱动 CLI 的 HTTP + SSE 契约，官方 Web UI 保留为「经典界面」兜底。

## 结构

```
ui/                       React + TypeScript 前端（Vite）
  src/App.tsx             标题栏 + 三栏骨架
  src/components/         Sidebar / ChatView / Composer / StatusBar / RightPanel
  src/store.ts            zustand：会话、消息、权限、SSE 合并
  src/api.ts              invoke 包装（全部走 Rust 代理）
src-tauri/
  src/main.rs             Tauri 主进程：托盘、单实例、通知、信号处理
  src/ipc.rs              前端 ↔ CLI 的命令桥（server_request / open_classic_view）
  src/http.rs             访问 CLI 的 HTTP 客户端（lib，自检程序复用）
  src/cli.rs              定位 debevo：配置 → 环境变量 → 常见路径 → login shell → PATH
  src/server.rs           拉起 serve、解析 listening、健康检查、进程组回收
  src/sse.rs              text/event-stream 解析与订阅
  src/events.rs           事件分类（授权/空闲/错误/阶段）与通知文案
  src/notify.rs           通知策略与去抖
  src/config.rs           配置：CLI 路径、通知开关、端口、可选口令
  src/bin/selftest.rs     无头端到端自检
```

```mermaid
graph LR
  UI["React UI<br/>三栏骨架"] -- "invoke(server_request)" --> IPC["Rust IPC 代理"]
  UI -- "listen(deveco://sse)" --> EV["Rust SSE 中继"]
  IPC -- "HTTP" --> CLI["deveco serve<br/>127.0.0.1:随机端口"]
  EV -- "SSE /event" --> CLI
  IPC --> N["通知中心<br/>UNUserNotificationCenter"]
```

前端不直连 `127.0.0.1`：一是绕开 CORS/ATS，二是连接信息（端口、可选口令）只留在 Rust 侧。

## 界面结构（对齐 DSH Desktop）

| 区域 | 内容 |
|---|---|
| 标题栏 | 无系统标题栏（`titleBarStyle: Overlay`），红黄绿灯内嵌，自绘品牌与状态 |
| 左栏 | 新会话 → 搜索 → 工作区树（项目 → 会话，带相对时间）→ 底部连接状态 |
| 主区 | 会话标题 + 经典界面入口；消息流（markdown、思考折叠、工具卡片）；底部 composer（含模型选择） |
| 状态栏 | 事件流状态 · 当前工作区 · 轮次 · 步数 · token 输入/输出 · 成本 |
| 右栏 | 可折叠：变更（按文件 diff）/ 文件（目录浏览 + 搜索 + 内容预览） |
| 设置页 | `⌘,` 打开：运行状态 / CLI 路径 / 服务端口与口令 / 通知开关 / CLI 配置只读 / 诊断（日志、配置文件、经典界面、重启） |
| 原生菜单 | `⌘N` 新建会话、`⌘,` 设置、`⌘⇧B` 切换右栏、`⌘⇧C` 经典界面、`⌘R` 重载界面，含标准编辑菜单与窗口菜单 |
| 窗口 | 大小/位置自动记忆；标题跟随「会话 · 项目」 |

权限审批以卡片形式出现在对话流末尾：允许一次 / 总是允许 / 拒绝。

## 构建与运行

```bash
npm install                 # 仓库根：拿 tauri CLI
npm --prefix ui install     # 前端依赖
npm run dev                 # 开发模式（自动拉起本机 deveco serve）
npm run build               # 出 .app / .dmg
```

前置条件：本机已安装 CLI（`npm i -g @deveco/deveco-code`），并已通过 `deveco providers` 登录过。

## 自测

```bash
cargo test --manifest-path src-tauri/Cargo.toml        # 单元测试
cargo run --manifest-path src-tauri/Cargo.toml --bin deveco-selftest   # 端到端
```

自检不打开窗口、不消耗模型 token，退出码 0 表示全链路通过。

| 检查 | 说明 |
|---|---|
| 发现 CLI | 打印路径与版本 |
| 拉起 serve | 随机空闲端口，实测 1.6s 就绪 |
| 健康检查 /api/health | — |
| 读取 /api/location | 通知文案用的项目目录 |
| 代理读写路径 | POST 建会话 → POST 写消息（noReply）→ GET 读消息 → DELETE 清理 |
| 订阅 /event | 收到 `server.connected` |
| 授权事件分类 / 文案 / 策略 / 去抖 | 用真实事件格式构造 |
| 退出回收 | serve 子进程组停止响应 |

最近一次结果：**34 个单测 + 11 项自检全部通过**（2026-11-06，macOS 27.2 / CLI 0.2.5）。

真实模型流式对话已实测（临时工作区，多次 prompt）：思考过程实时滚动、正文逐字到达、
状态栏计数同步、任务结束后自动刷新右侧变更。

## 踩过的坑（都已修，写下来避免重犯）

1. **`/event` 是实例级的**：它只推送 `deveco serve` 启动目录那一个工作区的事件。
   切换工作区后会话事件全部收不到——必须订阅 `/global/event`，它把所有工作区的事件
   多路复用，外层包成 `{ directory, project, payload }`。
2. **`--port 0` 无效**：CLI 会当成「未指定」落到默认 4096，必须应用侧先挑空闲端口。
3. **launcher 会留孤儿**：`deveco` 是 node 包装脚本，只杀它会留下 161MB 原生二进制继续占端口，
   必须按进程组发信号（含 `SIGTERM/SIGINT/SIGHUP` 兜底）。
4. **路径要规范化**：macOS 上 `/tmp` → `/private/tmp`，CLI 返回的 worktree 是规范化后的路径。
5. **`noReply` 可造消息**：`POST /session/{id}/message` 带 `noReply: true` 能写入真实格式的
   用户消息且不调用模型，自检和调试靠它。

## 会话与文件

- **工作区懒加载**：展开某个工作区时才拉它的会话列表，切换工作区不会卡。
- **会话管理**：悬停显示 `✎` 重命名（也可双击标题）、`✕` 删除（行内二次确认，删当前会话会清空视图）。
- **模型选择**：composer 左下角的模型胶囊，支持搜索与切换；选定后新消息带上该模型。
- **Agent 切换**：`build / plan / debug …` 胶囊（`/agent` 的 primary 列表），选中后新消息带 `agent`。
- **推理强度**：模型带 variants 时出现档位胶囊（如 `max`），点击循环切换，随消息带 `variant`。
- **斜杠命令**：输入 `/` 弹出 62 条技能/命令，↑↓ 选择、Enter 插入、Esc 取消。
- **MCP 状态**：状态栏显示当前连接的 MCP server 数量（`/mcp`）。
- **文件面板**：按目录浏览（进入/返回上级），输入关键字走 `find` 搜索，点文件在面板内预览文本内容，`←` 返回列表，非文本文件给出提示。
- **全局搜索**：搜索框输入后（300ms 防抖）并行查询所有工作区，未展开过的工作区也能搜到，点击结果直接跳转。
- **消息复制**：悬停气泡/助手消息出现「复制」，写入系统剪贴板。
- **会话归档**：`⇩` 归档当前会话（默认从侧栏隐藏），「显示归档」开关可查看并 `↩` 取消归档。
- **停止生成**：任务执行中 composer 显示「停止」，点击后中断（外部/经典界面触发的任务同样会显示）。
- **变更面板**：优先展示会话快照 diff，为空时自动回退到 git 工作区 diff（非 git 项目会给出提示）。
- **@ 引用文件**：输入框里打 `@` 弹出工作区文件搜索，`↑↓` 选择、`Enter` 插入路径、`Esc` 取消。
- **快捷键面板**：`⌘/` 或「视图 → 快捷键」查看全部快捷键。
- **消息时间**：悬停消息显示发送时间；发送失败会把原文放回输入框，不用重新输入。
- **会话导出**：`⌘E` 或「文件 → 导出当前会话」，调用 `deveco export` 生成 JSON 到
  `~/Library/Application Support/DevEco Code Desktop/exports/` 并在 Finder 中定位。
- **会话内查找**：`⌘F` 打开查找条，Enter/⇧Enter 上下跳转，Esc 关闭。
- **侧栏宽度**：拖动分隔条调整（双击复位），宽度记在 localStorage。
- **附件**：输入框左下 `+` 选择文件（最多 4 个、单个 ≤8MB），转 data URL 随消息发送；
  图片/文档以 chip 展示，可单个移除。文本类附件由 CLI 自动内联，二进制保留 file part。

## 设置页

`⌘,` 或左栏底部齿轮打开，`Esc` 关闭，`⌘S` 保存，`Tab` 焦点锁在面板内。

| 区块 | 内容 | 是否即时生效 |
|---|---|---|
| 运行状态 | CLI 路径/版本、服务地址、应用版本 | 只读 |
| CLI | 可执行文件路径 + 自动探测 | 需重启 |
| 服务 | 端口偏好（0=自动挑空闲端口）、本地服务口令 | 需重启 |
| 通知 | 总开关、授权/完成/失败/阶段四类、前台静音 | **即时生效**（每次事件实时读配置） |
| CLI 配置 | 模型、小模型、权限、插件数量 | 只读（归 deveco 自己的配置管） |
| 诊断 | 打开日志目录 / 配置文件 / 经典界面 / 重启应用 | — |

设置写入 `~/Library/Application Support/DevEco Code Desktop/config.json`。

## 跟随官方 CLI 更新

- 不打包 CLI，永远驱动本机那一份；`deveco upgrade` 后重启应用即可。
- 只依赖 v1 契约：`/project`、`/session`、`/session/{id}/message`、`/event`、`/permission`、`/api/health`。
- 事件侧只对四类语义做处理，未知事件忽略——上游新增事件不会打断 UI。
- 端口用应用侧挑选的空闲端口 + 解析 `listening on` 行，不假设 4096。

## 已知限制

- **流式对话未经真实模型验证**：SSE → store 的合并逻辑已按契约实现并单测过，但还没有用真实 prompt 跑过（会消耗 token，需你确认后再做）。
- 通知点击只能聚焦窗口，不能跳到会话，也不能在通知里直接批准。
- 工作区列表直接来自 CLI 的 `/project` 注册表，历史探测残留的目录（如 `/tmp/dvt`）也会出现。
- 仅 macOS 验证；Windows 需替换通知与 CLI 发现逻辑。
