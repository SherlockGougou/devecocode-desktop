# GitHub 仓库能力与工作流

本文记录仓库当前实际启用的 GitHub 能力、验证过的运行结果和仍未启用的选项。配置以仓库
文件与 GitHub 设置为准；修改后同步更新本文。

## 工作流

| 工作流 | 触发 | 作用 | 当前验证 |
|---|---|---|---|
| `ci.yml` | push `main`、pull request、手动 | 前端类型检查与构建、版本一致性、Rust 格式、Clippy、单测、两种架构的 Offline 资源生成 | PR #14 全部通过 |
| `codeql.yml` | push、pull request、每周、手动 | CodeQL 扫描 Rust、JavaScript/TypeScript 和 GitHub Actions | PR #14 全部通过 |
| `dependency-review.yml` | pull request | 依赖变更审查，阻断 high 漏洞 | PR #14、#15 通过 |
| `security.yml` | Cargo 依赖变更、每周、手动 | RustSec `cargo audit`；`glib` 的 Linux-only 例外在 workflow 中注明 | PR #14 通过 |
| `release-check.yml` | 手动 | 校验版本一致性、双语 Release notes 和占位符，上传 notes 预览 | v0.2.2 运行通过 |
| `labeler.yml` | pull request | 按改动路径添加 `frontend`、`rust`、`docs`、`ci` 标签 | PR #15 自动添加 `ci` |
| `release.yml` | push `v*` 标签、手动 | 构建 arm64/x64 普通版与 Offline 版，生成校验和、attestation、双语正文，draft-first 发布 | v0.2.1、v0.2.2 通过；v0.2.2 run `42483989177` |
| `pages.yml` | `website/**` 变更、手动 | 校验静态官网并部署到 GitHub Pages | 提交 `31f9675` 通过 |

## 仓库设置

- **Pages**：Source 为 GitHub Actions，站点地址
  <https://sherlockgougou.github.io/devecocode-desktop/>，已写入仓库 About 的 Homepage。
- **Release immutability**：已启用。发布流程必须先写 draft，再附加全部资产，最后 publish。
- **Ruleset `Protect main`**：PR、7 个必需检查、禁止删除和 force push；
  仓库 owner 保留 bypass。
- **Ruleset `Protect release tags`**：`v*` 标签禁止更新、删除和 force push。
- **Dependabot**：根 npm、UI npm、Cargo、GitHub Actions 每周分组更新；security updates
  和 vulnerability alerts 已启用。
- **Code scanning**：CodeQL 默认设置已启用，当前告警为 0。
- **Secret scanning**：secret scanning、push protection 已启用；non-provider patterns
  和 validity checks 未启用。
- **Dependency graph**：已启用；Dependency Review 依赖它。
- **合并设置**：合并后自动删除分支，允许 GitHub 建议更新 PR 分支。
- **Topics**：`ai-agent`、`arkts`、`desktop-app`、`deveco`、`harmonyos`、`macos`、
  `react`、`rust`、`tauri`。
- **标签**：`dependencies`、`frontend`、`rust`、`docs`、`ci` 以及 GitHub 默认标签。

## 发布操作

```bash
npm run release:prepare -- 0.2.3
# 编写 docs/releases/v0.2.3.md，更新 CHANGELOG 和官网页脚
npm run check
npm run check:version 0.2.3
gh workflow run release-check.yml -f tag=v0.2.3
git tag -a v0.2.3 -m "DevEco Code Desktop v0.2.3"
git push origin v0.2.3
```

`release-check` 通过后再打标签。标签推送后观察 `Release` workflow：draft 创建、四个 DMG
和两个 Offline zip 上传、`SHA256SUMS.txt`、双语正文、publish 和 immutable 检查都应成功。

## 发布后核验

```bash
gh release view v0.2.3 --json isDraft,isImmutable,assets
gh release verify v0.2.3 -R SherlockGougou/devecocode-desktop
gh attestation verify "DevEco.Code_0.2.3_aarch64.dmg" -R SherlockGougou/devecocode-desktop
shasum -a 256 -c SHA256SUMS.txt
```

## 暂未启用

- **Discussions**：暂不开启，避免在没有稳定维护承诺时增加支持渠道。
- **Copilot code review**：取决于账号的 Copilot 可用性和仓库设置，当前未配置。
- **Homebrew tap**：需要独立 tap 仓库和持续的 formula 维护；当前只提供 GitHub Releases。
- **zizmor**：本地扫描发现 42 个 high 级提示，主要来自 action tag 未固定到 SHA 和
  Offline CLI 的有意临时安装。先在 CI 外逐项处理，再考虑作为阻断检查。
- **Dependabot 自动合并**：未启用；依赖升级仍需通过 PR 检查和人工确认。
