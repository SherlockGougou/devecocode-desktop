# 开源发布检查

这份清单区分“仓库里已经准备好的内容”和“发布者必须在 GitHub／Apple 侧完成的动作”。
不要把未完成项写成已验证。

## 仓库内已准备

- [x] MIT License 与 npm/Cargo 元数据；
- [x] README、功能、架构、开发、限制文档；
- [x] CONTRIBUTING、SECURITY、issue 与 pull request 模板；
- [x] 不依赖本机 CLI 的 CI：前端构建、Rust 格式、Clippy、单测；
- [x] CI 额外校验 arm64/x64 离线 CLI 资源生成；
- [x] Dependabot 周更配置（根 npm、UI npm、Cargo、GitHub Actions）和安全更新；
- [x] CodeQL（Rust、JavaScript/TypeScript、GitHub Actions）与 Dependency Review；
- [x] RustSec `cargo audit`（依赖变更、每周和手动触发）；
- [x] 发布就绪检查 workflow：版本一致性、双语 notes 与占位符；
- [x] PR 路径标签 workflow，以及 `frontend`/`rust`/`docs`/`ci` 标签；
- [x] Dependabot patch/minor auto-merge workflow（major 保持人工）；
- [x] 独立的 [Homebrew tap](https://github.com/SherlockGougou/homebrew-tap) 和 cask 更新 workflow；
- [x] `npm run release:prepare -- X.Y.Z` 同步四处版本号；
- [x] `main` 与 `v*` ruleset 的可审查 JSON（`.github/rulesets/`）；
- [x] tag 触发的 CD：arm64/x86_64 构建、GitHub Release 与 workflow artifacts；
- [x] 含内置 CLI 的 Offline 构建任务，固定 CLI 版本并随 Release 发布；
- [x] Release 使用 draft-first：普通版、Offline 版、双语 notes、SHA256SUMS 和两套 updater
  清单全部完成后才发布；
- [x] 发布资产生成 `SHA256SUMS.txt`，并通过 `actions/attest` 生成 build provenance；
- [x] 静态官网与 GitHub Pages 部署 workflow；
- [x] README、官网和安装页使用真实应用截图，素材维护约定见
  [截图素材](assets/screenshots/README.md)；
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
- 在 **Settings → Releases** 启用 **Enable release immutability**。该设置只对启用后的新
  Release 生效；发布流程必须保持 draft-first，先附上全部资产，再 publish。
  也可以用有 admin 权限的 GitHub CLI 执行
  `gh api --method PUT repos/SherlockGougou/devecocode-desktop/immutable-releases`。
  启用后 GitHub 会为新 Release 自动生成 release attestation，`gh release verify` 依赖它。
  工作流不会自动修改这项仓库设置，需要发布者启用一次。
- `publish` job 会在发布后检查 Release 的 `isImmutable`；如果仍为 `false`，Actions 会输出
  警告，说明仓库设置尚未启用。
- artifact attestations 在公开仓库可用；私有仓库需要 GitHub Enterprise Cloud，因此发布
  仓库应保持公开。
- 为 `v*` 标签配置 ruleset：限制更新/删除，并要求 CI 状态检查。
- 启用 Security Advisories、secret scanning（如账户支持）和 Dependabot。
- 保持 Dependency graph 开启；Dependency Review 依赖它，关闭后 PR 检查会直接失败。
- 保持 Dependabot alerts、security updates、CodeQL 和 Dependency Review 的默认分支
  保护检查启用。
- 启用仓库 **Allow auto-merge**；Dependabot 的 patch/minor PR 会在 7 项必需检查通过后
  squash 合并，major 仍需人工处理。
- 为 tap 自动更新创建 `HOMEBREW_TAP_TOKEN`：fine-grained PAT，只授权
  `SherlockGougou/homebrew-tap` 的 `Contents: Read and write`。
- 为更新包签名创建 `TAURI_SIGNING_PRIVATE_KEY` secret，内容是 Ed25519 私钥文件文本；
  如果私钥设置了口令，再创建 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。公钥必须与
  `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` 一致。私钥不要放入仓库，
  并离线备份：丢失或更换后，已安装版本将无法验证后续更新。

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY \
  --repo SherlockGougou/devecocode-desktop \
  < ~/.tauri/deveco-desktop.key
```
- 为 `main` 配置分支保护：要求 CI 通过、禁止 force push、合并后删除分支。
- `main` ruleset 需要 `Frontend and Rust checks`、两个 `Offline resources ...`、
  `Dependency Review` 和三个 `Analyze (...)` 检查；`v*` ruleset 限制标签更新、删除和
  force push。规则副本见 `.github/rulesets/main.json` 和 `.github/rulesets/tags.json`。
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
- `publish` job 会校验 4 个 DMG、2 个 Offline `.app.zip`、4 个 `.app.tar.gz`、4 个 `.sig`、
  `SHA256SUMS.txt`、`latest.json`、`latest-offline.json` 和双语正文，全部存在后才把
  draft 发布。清单由 `scripts/render-updater-manifests.mjs` 从资产生成，并校验签名中的
  版本与 tag 一致。
- 确认版本号在 `package.json`、`ui/package.json`、`src-tauri/Cargo.toml` 和
  `src-tauri/tauri.conf.json` 中一致，可运行 `npm run check:version`。升级版本时优先用
  `npm run release:prepare -- X.Y.Z`，脚本会先检查四处版本是否一致。
- 每个版本维护 `docs/releases/vX.Y.Z.md`，必须同时包含 `## 中文` 和 `## English`；
  Release workflow 会在 draft 中更新正文，最后统一 publish。不要只写自动生成的历史提交摘要。
  首个带更新功能的版本要写明：更早版本仍需手动安装一次，之后才能收到应用内更新。
- 打标签前手动运行 `Release readiness` workflow（输入 `vX.Y.Z`），它会再次校验版本、
  双语 notes 和占位符；失败时不要继续发布。
- Release notes 附已知限制和安装说明；不要附带未脱敏截图。发布 workflow 会生成
  `SHA256SUMS.txt` 并上传到 Release，同时为资产生成 build provenance attestation；
  不要再描述成“未提供校验和”。
- 发布成功后确认 `update-homebrew.yml` 已更新 tap 的两个 cask；失败时用
  `workflow_dispatch` 输入同一 tag 重跑，不要重建 Release。

## 下载校验

`SHA256SUMS.txt` 覆盖 DMG、Offline zip、更新包和签名等构建资产。下载全部资产后，用户可以
用以下方式验证：

```bash
shasum -a 256 -c SHA256SUMS.txt
grep 'DevEco.Code_.*aarch64.dmg$' SHA256SUMS.txt | shasum -a 256 -c
gh release verify v0.2.8 -R SherlockGougou/devecocode-desktop
gh attestation verify "DevEco.Code_0.2.8_aarch64.dmg" -R SherlockGougou/devecocode-desktop
brew trust sherlockgougou/tap
brew info --cask sherlockgougou/tap/devecocode-desktop
brew fetch --cask sherlockgougou/tap/devecocode-desktop
brew fetch --cask sherlockgougou/tap/devecocode-desktop-offline
```

只下载单个 DMG 时，用 `grep` 过滤对应文件名。`gh` 命令需要 GitHub CLI 已登录。
attestation 证明构建来源和资产未被替换，不替代 Apple Developer ID 签名或公证；
Gatekeeper 提示仍可能发生。

## 发布后

- 只保留当前版本 Release；发布成功并校验资产后，用
  `gh release delete <tag> --yes` 下架旧 Release，避免用户继续下载到受影响版本。
  保留 tag 供历史引用即可，旧资产 URL 会返回 404。
- 为安全问题保留私密报告入口，不在公开 issue 中讨论细节。
- 启用 immutable release 后，已发布资产的哈希和 tag 不能再修改；发现问题应发布新版本，
  不要尝试覆盖旧 Release。
- 对 CLI 上游契约变化建立回归检查；当前 CI 不安装真实 CLI，因此不替代本地
  `npm run check:selftest`。
- 记录最低 macOS 版本、CLI 建议版本和已知未验证场景；不要承诺 Windows 支持或
  Gatekeeper 无提示安装。
