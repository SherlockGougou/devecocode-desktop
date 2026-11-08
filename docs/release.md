# 开源发布检查

这份清单区分“仓库里已经准备好的内容”和“发布者必须在 GitHub／Apple 侧完成的动作”。
不要把未完成项写成已验证。

## 仓库内已准备

- [x] MIT License 与 npm/Cargo 元数据；
- [x] README、功能、架构、开发、限制文档；
- [x] CONTRIBUTING、SECURITY、issue 与 pull request 模板；
- [x] 不依赖本机 CLI 的 CI：前端构建、Rust 格式、Clippy、单测；
- [x] CI 额外校验 arm64/x64 离线 CLI 资源生成；
- [x] tag 触发的 CD：arm64/x86_64 构建、GitHub Release 与 workflow artifacts；
- [x] 含内置 CLI 的 Offline 构建任务，固定 CLI 版本并随 Release 发布；
- [x] 静态官网与 GitHub Pages 部署 workflow；
- [x] 面向普通用户的 [macOS 安装与使用](installation.md)；
- [x] 历史提交已清理本机用户目录与私有工作区名；实现记录中的 `.agent-temp/`
  截图路径只是本地证据，公开仓库不包含这些文件。

## 公开前必须人工确认

### 版权与许可证

- 确认 `LICENSE` 中的版权主体（当前为 “DevEco Code Desktop contributors”）符合你的发布身份。
- 复核 `@deveco/deveco-code`、图标、字体和第三方依赖的许可证与商标使用边界。
- 确认项目名称和 “DevEco” 描述不会让用户误认为官方产品；README 已包含非官方声明，但仍需发布者自行判断。
- 若未来更改许可证，同时更新 `LICENSE`、`package.json`、`ui/package.json`、`src-tauri/Cargo.toml`
  和 README 的许可证段落。

### 数据与历史记录

- 在 GitHub 推送前检查完整历史，而不只是当前工作树：

```bash
git log --all --name-only --pretty=format: | sort -u
git grep -n -I -e 'PRIVATE KEY' -e 'api_key' -e 'ghp_' $(git rev-list --all) -- 2>/dev/null || true
```

- 检查截图、日志、`.agent-temp/` 和测试夹具是否包含真实路径、凭据、设备标识或私有会话。
- 确认没有需要保留但不适合公开的历史分支、标签或远程地址。
- 如果历史中已经提交过凭据，先轮换凭据，再重写历史；仅删除当前文件不足以消除泄漏。

### GitHub 仓库设置

- 设置仓库 description、topics、默认分支、README 和 social preview。
- 在 **Settings → Pages → Source** 选择 **GitHub Actions**，并运行 `Pages` workflow；
  官网维护细节见 [website/README.md](../website/README.md)。
- 启用 Security Advisories、secret scanning（如账户支持）和 Dependabot。
- 为 `main` 配置分支保护：要求 CI 通过、禁止 force push、合并后删除分支。
- 选择是否启用 Discussions；不要在还没有维护承诺时开启过多支持渠道。
- 确认 issue/PR 模板中的标签已经存在，或让 GitHub 自动创建。

### 发布构建

- 在另一台 Apple Silicon Mac 上验证 `.app`，记录 macOS 版本与 CLI 版本。
- 当前发布策略是**不做 Developer ID 签名，不做公证**；发布页必须保留未签名提示和
  [macOS 安装与使用](installation.md)链接。不要把它描述成已签名或可无提示安装。
- `release.yml` 当前分别构建 Apple Silicon 和 Intel 两种 DMG，不需要 Universal 二进制；
  若未来改为 Universal，需要单独验证合并后的包。
- Offline 版额外包含固定 CLI；发布前需要确认 CLI 版本、许可证、内置数据隔离和两个架构的
  DMG 都在 Release 中。详细验收见[离线版打包](offline-packaging.md)。
- 确认版本号在 `package.json`、`ui/package.json`、`src-tauri/Cargo.toml` 和
  `src-tauri/tauri.conf.json` 中一致，可运行 `npm run check:version`。
- 每个版本维护 `docs/releases/vX.Y.Z.md`，必须同时包含 `## 中文` 和 `## English`；
  Release workflow 会在两类产物上传后更新正文。不要只写自动生成的历史提交摘要。
- Release notes 附已知限制和安装说明；不要附带未脱敏截图。若增加校验和，应在 release job
  中生成并上传，不能在文档里声称已提供。

## 发布后

- 为安全问题保留私密报告入口，不在公开 issue 中讨论细节。
- 对 CLI 上游契约变化建立回归检查；当前 CI 不安装真实 CLI，因此不替代本地
  `npm run check:selftest`。
- 记录最低 macOS 版本、CLI 建议版本和已知未验证场景；不要承诺自动更新、Windows 支持或
  Gatekeeper 无提示安装。
