# 文档索引

本目录只维护当前仍然有效的产品、架构和开发说明。按任务选择入口：

| 文档 | 适合谁 | 内容 |
|---|---|---|
| [macOS 安装与使用](installation.md) | 下载应用的用户 | 架构选择、首次打开、CLI 配置、更新与卸载 |
| [离线版打包](offline-packaging.md) | 开发者、发布者 | 内置 CLI 资源、构建、数据隔离和发布验收 |
| [功能说明](features.md) | 用户、产品与测试 | 三栏界面、会话、文件、任务、设备与设置行为 |
| [架构说明](architecture.md) | 维护者、审查者 | 进程模型、前后端边界、CLI 契约、数据目录与关键不变量 |
| [开发指南](development.md) | 本地开发者 | 环境、命令、测试、打包、排障与提交前检查 |
| [已知限制](limitations.md) | 用户、发布者 | 平台范围、未验证能力、签名与安全限制 |
| [开源发布检查](release.md) | 发布者 | 许可证、数据审计、GitHub 设置、校验和、attestation 与 Release 构建清单 |
| [GitHub 能力与工作流](github.md) | 维护者、发布者 | 已启用的 Actions、ruleset、安全扫描和发布操作 |
| [版本说明](releases/README.md) | 发布者 | 每个版本的中英文 Release notes 与资产说明 |
| [官网源码](../website/README.md) | 网站维护者 | 静态官网结构、本地预览与 GitHub Pages 部署 |
| [实现记录](archive/implementation-log.md) | 需要追溯决策的人 | 2026-11-06 至 2026-11-07 的设计演进、实测证据和踩坑记录 |

## 阅读顺序

第一次安装应用时，先读[macOS 安装与使用](installation.md)和仓库根目录的
[README](../README.md)。准备修改代码时继续读[架构说明](architecture.md)和
[开发指南](development.md)。

## 维护约定

- 当前行为以 `README.md`、`features.md`、`architecture.md` 和代码为准。
- `archive/implementation-log.md` 是历史快照，不保证与当前实现一致；其中的版本号、
  测试数量和本机路径都只代表当时状态。
- 行为变化必须同时更新相关文档；只在实现记录中追加流水不算完成文档更新。
- 不把凭据、token、私有仓库地址、真实用户目录或未脱敏截图写入文档。
