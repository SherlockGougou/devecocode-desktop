# 参与贡献

感谢你愿意改进 DevEco Code Desktop。提交代码前，请先阅读
[架构说明](docs/architecture.md)和[开发指南](docs/development.md)。

## 开发流程

1. 先搜索现有 issue 和 pull request，避免重复工作。
2. 较大的功能或行为变更先开 issue，说明使用场景、边界和验收方式。
3. 从最新的 `main` 创建分支，保持改动聚焦；不要混入无关格式化或重构。
4. 修改后运行与风险相称的检查，并在 pull request 中写明实际运行了哪些命令。

```bash
npm run check
npm run check:selftest   # 需要本机已安装并登录 deveco CLI
```

## 代码与文档约定

- 注释和用户文档使用中文；标识符、API 名和协议字段保留英文原文。
- Rust 错误必须带上下文，不吞错；解析、分类、策略和去抖等纯逻辑需要单测。
- TypeScript 保持严格模式，组件不直接发 HTTP 请求，统一经过 `ui/src/api.ts`。
- 新增界面状态必须有加载、空态和失败态文案。
- 新增依赖前先确认现有依赖无法满足需求，并在 pull request 中说明理由。
- 行为变化同步更新 `README.md` 和 `docs/`；历史实施细节写入
  [实现记录](docs/archive/implementation-log.md)，不要混入当前架构说明。

## Pull Request 要求

- 说明问题、方案、用户可见变化和未验证项。
- 涉及 UI 的改动附真实应用截图；只通过构建不能证明界面行为正确。
- 涉及 CLI 交互的改动运行 `npm run check:selftest`。
- 不要提交密钥、口令、tokenized URL、个人目录截图或其他敏感数据。
- 不要在同一个 pull request 中顺带修复无关问题。

## 许可证

提交即表示你同意将贡献以仓库的 [MIT License](LICENSE) 发布，无需额外签署 CLA。
