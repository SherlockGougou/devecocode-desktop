# Changelog

版本说明按发布标签维护在 [`docs/releases/`](docs/releases/README.md)。Release workflow
会读取对应版本的 Markdown 文件，生成 GitHub Release 正文。

## Unreleased

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

完整说明：[v0.2.1](docs/releases/v0.2.1.md)

## 0.2.0 - 2026-11-07

- 重组 macOS 客户端文档、官网和开源发布配置。
- 增加普通版与 Offline 版两种 macOS 发布包。
- Offline 版内置固定版本 DevEco Code CLI，并隔离 CLI 配置、会话数据与认证。
- Release 支持中英文版本说明、arm64/x64 DMG 和安装限制提示。

完整说明：[v0.2.0](docs/releases/v0.2.0.md)
