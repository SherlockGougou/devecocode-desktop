# Changelog

版本说明按发布标签维护在 [`docs/releases/`](docs/releases/README.md)。Release workflow
会读取对应版本的 Markdown 文件，生成 GitHub Release 正文。

## 0.2.7 - 2026-11-11

- 服务协议更新或同意状态需要复核时，聊天区显示明确引导和“查看并同意”入口，不再只显示
  原始错误；账号页支持重新同意、显示同步状态，并在已接受但尚未上传时重试同步。
- 接受更新后的协议会提交当前版本与服务端 revision，区分保存中、等待同步和失败状态。
- Agent 问答在模型漏掉 `multiple`、但题干明确标注“可多选”时按多选渲染；显式字段仍然
  优先。单选后自动进入下一题，末题、单题和多选题不会自动提交。
- 编辑历史用户消息时把完整编辑区滚动到视口内，底部操作按钮可见；用户消息操作按钮在
  指针从短消息移向按钮时保持显示。
- 增加协议状态、问答多选推断和自动翻页测试，前端测试共 17 项。

完整说明：[v0.2.7](docs/releases/v0.2.7.md)

## 0.2.6 - 2026-11-11

- Agent 等待输入时用底部问答面板替换 Composer，支持单题/多题翻页、单选/多选、选项说明、
  自定义答案、“无偏好”、`⌘Enter` 提交、收起面板和停止生成；回答后保留可展开的摘要。
- 待答请求从 `/question` 补齐，并跟随 `question.asked/replied/rejected` 实时增删；
  断线重连、切换会话、空闲、错误和删除会话时同步清理。
- 通知、菜单栏、侧栏和窗口标题增加等待回答状态；授权与提问即使应用在前台也会提醒，
  设置页新增“需要回答时提醒”开关。
- 自动 OAuth 回调与状态轮询统一使用 10 分钟等待窗口，支持“检查登录状态”；关闭弹窗、
  离开设置页或开始新的登录会取消在途流程，迟到的回调不会串到新会话。
- 增加问题归一化、答案矩阵、快照与实时事件合并测试，以及提问分类、通知文案和前台提醒
  自检。

完整说明：[v0.2.6](docs/releases/v0.2.6.md)

## 0.2.5 - 2026-11-09

- 消息支持内嵌本地 Markdown 图片和工具返回图片，新增缩放/拖动/多图切换查看器，
  以及复制图片、图片另存为和失败占位。
- Composer 新增“跟随 Agent / 每次询问 / 完全访问”会话级权限选择；规则只写入当前会话，
  保留 Agent 的通配 deny、兜底 deny 和具体命令/路径限制。
- 权限 PATCH 失败或已被新请求取代时取消发送；切换 Agent 同步失败时恢复原 Agent。
- 增加轮次导航、“最新消息”按钮、同分钟助手步骤聚合、图标化消息操作和空闲会话待办中断态。
- 图片读取增加 32MB 上限、远程流式限制、URL 编码路径解析和解码失败占位。
- 新增前端纯逻辑测试、Rust 图片边界测试和会话权限 PATCH 追加契约自检。

完整说明：[v0.2.5](docs/releases/v0.2.5.md)

## 0.2.4 - 2026-11-09

- 修复普通版从 Finder / LaunchServices 启动时找不到 Node，导致 `deveco serve` 立即退出、
  界面显示“本地服务已停止 / 输出：（无输出）”的问题。
- 启动 CLI 前把 CLI 自身目录、用户现有 PATH 和常见包管理器 / 版本管理器目录并入子进程
  PATH；版本探测与 serve 启动共用同一规则，并保持用户已有 PATH 的优先级。
- 启动失败横幅同时显示 stdout 与 stderr 尾部，不再隐藏 `env: node: No such file or
  directory` 等真实错误。
- 发布完成后只保留当前 Release，旧版本不再提供下载，避免继续安装受影响的 0.2.3。

完整说明：[v0.2.4](docs/releases/v0.2.4.md)

## 0.2.3 - 2026-11-08

- 新增应用内更新：普通版与 Offline 版分别检查 `latest.json` / `latest-offline.json`；
  设置页提供自动检查开关、下载/安装进度和发布说明，菜单栏与应用菜单可直接检查更新。
- Release 构建增加 Ed25519 更新包签名、`.app.tar.gz` / `.sig` 资产和两套 updater 清单；
  更新包使用前端固定的公钥和 `requireSignedVersion` 校验。
- 修复桌面端设置保存只更新内存、不写入 `config.json` 的问题；后端自愈时也不再覆盖
  启动后保存的配置。
- 新增完整英文 README，中文仍为默认入口，并在两份 README 顶部互相切换。
- Dependabot 的 patch/minor 更新在 7 项必需检查通过后自动 squash 合并；major 继续人工处理。
- 新增独立 Homebrew tap `SherlockGougou/homebrew-tap`，提供普通版与 Offline 版 cask，
  按 arm64/x64 校验 DMG。
- Release 成功后自动更新 tap cask；更新失败可用同一 tag 手动重跑。
- 新增 Homebrew Cask 渲染脚本、cask 模板和 tap CI。

完整说明：[v0.2.3](docs/releases/v0.2.3.md)

## 0.2.2 - 2026-11-08

- 升级 Tauri 与 Rust 依赖：`tauri-plugin-dialog 2.8.4`、`dirs 7`、
  `tokio-tungstenite 0.30`、`jsonc-parser 0.34`。
- 升级 TypeScript `7.0.2`、Vite `8.3.6`、`@vitejs/plugin-react 6.2.1` 和 GitHub Actions
  主版本。
- 修复 `tokio-tungstenite` 文本消息类型、`jsonc-parser` feature、Node 20 Vite 配置加载、
  `.artifacts` 隐藏目录上传和已退役 `macos-14` runner 的兼容问题。
- 增加 Dependabot 周更、CodeQL、Dependency Review、RustSec `cargo audit`、
  Release readiness 和 PR 路径标签工作流。
- 配置 `main`/`v*` ruleset 和 Release immutability。
- README、官网和安装页改用真实应用截图，新增界面截图区块和截图素材维护约定。

完整说明：[v0.2.2](docs/releases/v0.2.2.md)

## 0.2.1 - 2026-11-08

- 设置页升级为 CLI 配置中心：支持全局/当前工作区作用域、常用字段表单、高级 JSONC、
  Provider/模型、MCP、Agent/Command、权限、Skills、Plugins、启动参数和 CLI 升级。
- CLI 配置写入增加 base hash 冲突检测、原子替换、备份恢复和实例重载；密钥默认脱敏。
- 内嵌 `deveco-desktop-device` skill，并向 CLI 注入已定位的 `HDC`，让 Agent 可以使用
  HarmonyOS 设备截图、布局检查、输入、应用控制和日志能力。
- 应用启动前自动同步带管理标记的设备 skill；不修改 `deveco.jsonc`，不覆盖用户同名目录。
- 右栏重构为变更、文件、任务、设备四个标签：工作区/会话双来源 diff、目录树、统一
  diff 查看器、文件搜索与系统预览。
- 新增底部终端：通过 CLI `/pty` 创建当前工作区的本地 Shell，支持 `⌘J` 展开、拖高、
  重启和关闭回收；PTY 与 WebSocket 只在 Rust 侧管理。
- 状态栏改为 Token 总量、缓存命中、上下文占用和输出速度（TPS），任务概览复用同一口径；
  输出速度排除工具执行等待。
- 历史用户消息可原位编辑：先用 `revert` 还原工作区，再按原 Agent/模型重新请求；
  提交前展示影响范围，失败时按服务端状态恢复。
- 执行中 Enter 排队、`⌘Enter` 引导：`session.idle` 后按会话 FIFO 投递，停止时暂停队列，
  错过当前轮时发送 synthetic 继续消息。
- 打开会话与重连时用 `/session/status` 校准执行态；残留工具/思考显示“已中断”，
  侧栏显示执行中加载指示与结束未查看的未读圆点。
- 对齐 macOS 红绿灯与自绘顶栏基线，修正重叠与窄窗口下的布局问题。
- 发布资产附带 `SHA256SUMS.txt` 和 GitHub artifact attestation；发布流程改为 draft-first，
  兼容 immutable release。

完整说明：[v0.2.1](docs/releases/v0.2.1.md)

## 0.2.0 - 2026-11-07

- 重组 macOS 客户端文档、官网和开源发布配置。
- 增加普通版与 Offline 版两种 macOS 发布包。
- Offline 版内置固定版本 DevEco Code CLI，并隔离 CLI 配置、会话数据与认证。
- Release 支持中英文版本说明、arm64/x64 DMG 和安装限制提示。

完整说明：[v0.2.0](docs/releases/v0.2.0.md)
