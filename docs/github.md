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
| `release-check.yml` | 手动 | 校验版本一致性、双语 Release notes 和占位符，上传 notes 预览 | v0.2.4 运行通过（run `42545627940`） |
| `labeler.yml` | pull request | 按改动路径添加 `frontend`、`rust`、`docs`、`ci` 标签 | PR #15 自动添加 `ci` |
| `dependabot-automerge.yml` | Dependabot pull request | patch/minor 在 7 项必需检查通过后启用 squash auto-merge；major 和未知类型跳过 | 待下一次 Dependabot PR 验证 |
| `update-homebrew.yml` | Release 成功、手动 | 从已发布 Release 读取 `SHA256SUMS.txt`，更新独立 tap 的两个 cask | v0.2.4 自动验证通过；run `42546983059` 推送了 tap commit `2ffbc3a` |
| `release.yml` | push `v*` 标签、手动 | 构建 arm64/x64 普通版与 Offline 版，生成更新包与签名、两套 updater 清单、校验和、attestation、双语正文，draft-first 发布 | v0.2.4 通过；run `42545665753`，17 个资产，Release immutable |
| `pages.yml` | `website/**` 变更、手动 | 校验静态官网并部署到 GitHub Pages | v0.2.4 站脚更新 run `42545617290` 通过 |

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
- **合并设置**：已启用 auto-merge；合并后自动删除分支，允许 GitHub 建议更新 PR 分支。
- **Topics**：`ai-agent`、`arkts`、`desktop-app`、`deveco`、`harmonyos`、`macos`、
  `react`、`rust`、`tauri`、`homebrew`、`homebrew-cask`。
- **标签**：`dependencies`、`frontend`、`rust`、`docs`、`ci` 以及 GitHub 默认标签。

## Homebrew Tap

- 独立仓库：<https://github.com/SherlockGougou/homebrew-tap>
- cask：`devecocode-desktop`（普通版）和 `devecocode-desktop-offline`（内置 CLI）。
- 安装：先执行 `brew trust sherlockgougou/tap`，再执行
  `brew install --cask sherlockgougou/tap/devecocode-desktop` 或
  `brew install --cask sherlockgougou/tap/devecocode-desktop-offline`。
- cask 按 arm64/x64 使用不同 DMG 和 SHA-256；SHA 来自已发布 Release 的
  `SHA256SUMS.txt`，不信任本地构建产物。
- 自动更新由 `update-homebrew.yml` 完成：Release 成功后读取 release 资产，渲染
  `Casks/*.rb`，只有内容变化才提交并推送。
- 自动更新需要仓库 secret `HOMEBREW_TAP_TOKEN`。创建一个只授权
  `SherlockGougou/homebrew-tap` 的 fine-grained PAT，权限选择
  `Contents: Read and write`，再执行：

```bash
gh secret set HOMEBREW_TAP_TOKEN \
  --repo SherlockGougou/devecocode-desktop
```

- token 过期或更新失败时，重新创建 PAT、更新 secret，然后手动重跑：

```bash
gh workflow run update-homebrew.yml \
  -f tag=v0.2.4 \
  --repo SherlockGougou/devecocode-desktop
```

- tap 仓库 CI 会运行 `brew audit --cask --strict --online` 和 `brew style`；发布后还应在
  本机执行 `brew fetch --cask` 验证下载和 SHA。audit 使用 `GITHUB_TOKEN` 提高 GitHub API
  限额，避免共享 runner 触发未认证限流。
- 当前 v0.2.2 cask 已通过 tap CI（run `42492319538`），并在本机用 `brew fetch` 验证了
  arm64 和 Intel 两种 DMG 的下载与 SHA-256。

## 发布操作

```bash
npm run release:prepare -- 0.2.4
# 编写 docs/releases/v0.2.4.md，更新 CHANGELOG 和官网页脚
npm run check
npm run check:version 0.2.4
gh workflow run release-check.yml -f tag=v0.2.4
git tag -a v0.2.4 -m "DevEco Code Desktop v0.2.4"
git push origin v0.2.4
```

`release-check` 通过后再打标签。标签推送后观察 `Release` workflow：draft 创建、四个 DMG、
两个 Offline zip、四个 `.app.tar.gz` 与 `.sig`、`SHA256SUMS.txt`、`latest.json`、
`latest-offline.json`、双语正文、publish 和 immutable 检查都应成功。
Release 成功后 `update-homebrew.yml` 会自动更新 tap；如果只看 Release 成功而 tap 失败，
按上面的 `workflow_dispatch` 重跑，不要重新打标签或重建 Release。

发布完成后只保留当前版本 Release：旧 Release 用
`gh release delete <tag> --repo SherlockGougou/devecocode-desktop --yes` 下架。保留
`v*` tag 供历史引用，但旧 DMG、更新包和校验和不再可下载。v0.2.4 发布后已下架
v0.2.1、v0.2.2、v0.2.3，旧资产 URL 返回 404。

## 发布后核验

```bash
gh release view v0.2.4 --json isDraft,isImmutable,assets
gh release verify v0.2.4 -R SherlockGougou/devecocode-desktop
gh attestation verify "DevEco.Code_0.2.4_aarch64.dmg" -R SherlockGougou/devecocode-desktop
shasum -a 256 -c SHA256SUMS.txt
brew trust sherlockgougou/tap
brew info --cask sherlockgougou/tap/devecocode-desktop
brew fetch --cask sherlockgougou/tap/devecocode-desktop
brew fetch --cask sherlockgougou/tap/devecocode-desktop-offline
```

## 暂未启用

- **Discussions**：暂不开启，避免在没有稳定维护承诺时增加支持渠道。
- **Copilot code review**：取决于账号的 Copilot 可用性和仓库设置，当前未配置。
- **zizmor**：本地扫描发现 42 个 high 级提示，主要来自 action tag 未固定到 SHA 和
  Offline CLI 的有意临时安装。先在 CI 外逐项处理，再考虑作为阻断检查。
