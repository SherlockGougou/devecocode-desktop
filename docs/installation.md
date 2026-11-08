# macOS 安装与使用

本文面向从 GitHub Releases 下载应用的用户。应用是社区构建，**不使用 Apple Developer ID
签名，也不做公证**；发布包使用 Tauri 的 ad-hoc 签名（`-`），它只用于满足 macOS 的基本
签名结构要求，不代表可验证的开发者身份。因此首次打开时仍可能触发 Gatekeeper 提示。

发布页提供两种 macOS 包：

- **普通版**：体积小，需要另行安装 Node 和 DevEco Code CLI；
- **Offline 版**：内置固定版本 CLI，适合不想在机器上安装 CLI 的用户；仍需网络登录和调用模型。

## 系统要求

- macOS 12 或更高版本；
- Apple Silicon 或 Intel Mac；
- 普通版需要已安装并登录 DevEco Code CLI；Offline 版无需单独安装 CLI：

```bash
npm i -g @deveco/deveco-code
deveco providers   # 或 deveco auth
deveco --version
```

普通版不随桌面应用打包 CLI；没有 CLI 时应用可以打开，但无法连接模型或读取会话。

## 下载

在项目的 [Releases](https://github.com/SherlockGougou/devecocode-desktop/releases)
页面下载与你的 Mac 架构对应的 DMG。如果不想另装 CLI，选择文件名以 `DevEco Code Offline`
开头的 Offline 版：

- Apple Silicon（M1/M2/M3/M4）：选择文件名带 `aarch64` 或 `arm64` 的 DMG；
- Intel：选择文件名带 `x64` 或 `x86_64` 的 DMG。

不要从第三方镜像下载安装包。发布页不提供自动更新，应用也不会自动替换自身。

## 校验下载

每个 Release 附带 `SHA256SUMS.txt` 和 GitHub artifact attestation。如果下载了全部资产，
在终端执行：

```bash
shasum -a 256 -c SHA256SUMS.txt
```

如果只下载了一个 DMG，可以按文件名过滤：

```bash
grep 'DevEco.Code_.*aarch64.dmg$' SHA256SUMS.txt | shasum -a 256 -c
```

Offline 版把模式换成 `DevEco.Code.Offline_.*aarch64.dmg$`。使用 GitHub CLI 可以验证构建来源；
仓库启用 immutable release 后，还可以验证整个发布：

```bash
gh attestation verify "DevEco.Code_0.2.2_aarch64.dmg" -R SherlockGougou/devecocode-desktop
gh release verify v0.2.2 -R SherlockGougou/devecocode-desktop
```

attestation 只证明资产来自该仓库的构建工作流，不能替代 Apple Developer ID 签名或公证；
首次打开仍可能需要按下一节放行。

## 安装

1. 双击 DMG 打开磁盘映像。
2. 将 `DevEco Code` 或 `DevEco Code Offline` 拖入“应用程序”目录。
3. 在 Finder 中推出 DMG。

### 首次打开

因为应用没有 Developer ID 签名和公证，直接双击可能被 macOS 拦截：

1. 在 Finder 中右键 `DevEco Code.app` 或 `DevEco Code Offline.app`，选择“打开”；
2. 在确认对话框再次选择“打开”。

如果系统仍提示无法验证开发者：

1. 打开“系统设置 → 隐私与安全性”；
2. 在页面底部找到被拦截的应用，点击“仍要打开”；
3. 回到 Finder 重新右键打开应用。

macOS 可能提示应用“已损坏”。如果确认安装包来自本项目的 Releases 页面，并且你没有修改
过应用包，可以移除 quarantine 属性后再打开：

```bash
xattr -dr com.apple.quarantine "/Applications/DevEco Code Offline.app"
```

普通版把路径中的 `DevEco Code Offline.app` 换成 `DevEco Code.app`。

这会绕过 Gatekeeper 的隔离检查，只应对你自己信任、且来源明确的安装包使用；不要用它运行
来源不明的软件。应用没有 Apple 可验证的签名和公证，系统不会替你验证发布者。

## Homebrew

如果已经安装 Homebrew，可以通过独立 tap 安装，普通版和 Offline 版各有一个 cask：

```bash
brew trust sherlockgougou/tap
brew install --cask sherlockgougou/tap/devecocode-desktop
# Offline 版，内置固定版本 CLI
brew install --cask sherlockgougou/tap/devecocode-desktop-offline
```

Homebrew 7 起，第三方 tap 需要先执行 `brew trust sherlockgougou/tap` 才会加载 cask；
这只信任该 tap，不会关闭 macOS 的签名或隔离检查。

两个 cask 都会按 Apple Silicon / Intel 选择对应 DMG，并用 Release 中
`SHA256SUMS.txt` 的 SHA-256 校验下载文件。cask 明确保留 ad-hoc 签名和未公证提示，
不会自动绕过 Gatekeeper；首次打开仍需按上一节操作。

tap 源在 <https://github.com/SherlockGougou/homebrew-tap>。查看安装信息：

```bash
brew info --cask sherlockgougou/tap/devecocode-desktop
```

## 首次配置

### 连接 CLI

普通版会按“设置中的路径 → `DEVECO_BIN_PATH` → 常见安装路径 → login shell → PATH”查找
`deveco`；Offline 版优先使用应用内 CLI，并把数据放在应用自己的目录。如果普通版左栏底部
显示 CLI 不可用：

1. 在终端执行 `which deveco`，确认真实路径；
2. 打开应用“设置 → CLI 与服务”；
3. 在 CLI 路径中手动选择该文件，保存并重启应用；
4. 回到终端确认 `deveco --version` 能正常返回。

### 系统权限

首次读取工作区时，macOS 可能请求“文稿”文件夹访问权限。拒绝后可以到
“系统设置 → 隐私与安全性 → 文件与文件夹”恢复。通知权限可以在系统设置中重新开启。

应用本身不会读取 `~/.local/share/deveco/*.db`；设置页可以按用户操作改写
`~/.config/deveco/deveco.jsonc`，写入前会备份并校验文件 hash。Offline 版使用的是隔离后
的应用内 CLI 数据目录。

## 基本使用

1. 点击左栏“新建会话”或工作区旁的加号；
2. 选择已有工作区，或通过“新建工作区…”选择项目目录；
3. 在输入框发送消息，`@` 可以引用工作区文件；
4. Agent 请求权限时，在对话流末尾选择“允许一次 / 总是允许 / 拒绝”；
5. 右侧面板查看变更、文件、任务和 HarmonyOS 设备截图；
6. 关闭主窗口会隐藏到菜单栏，托盘菜单可退出应用或重启本地服务。

常用快捷键：`⌘N` 新建会话、`⌘,` 设置、`⌘⇧B` 切换右栏、`⌘/` 查看快捷键。

应用启动时还会安装内嵌的 `deveco-desktop-device` skill，让 Agent 能通过 HDC 使用设备
截图、布局检查、点击/滑动/输入和日志能力。它不修改 `deveco.jsonc`；路径为
`~/.config/deveco/skills/deveco-desktop-device/`。

应用配置和截图位置：

- `~/Library/Application Support/DevEco Code Desktop/config.json`
- `~/Library/Application Support/DevEco Code Desktop/device-shots/`
- 日志：`~/Library/Logs/DevEco Code Desktop/app.log`

## 更新

当前没有应用内自动更新。更新步骤：

1. 退出旧版本（托盘菜单“退出”，不要只关闭窗口）；
2. 如果通过 Homebrew 安装，执行 `brew upgrade --cask devecocode-desktop` 或
   `brew upgrade --cask devecocode-desktop-offline`；否则下载新的 DMG 并拖入
   “应用程序”，覆盖旧应用；
3. 重新打开应用。配置和会话数据通常会保留。

CLI 升级与应用更新相互独立；升级 CLI 后重启应用即可重新连接。

## 卸载

1. 从托盘菜单完全退出应用；
2. 如果通过 Homebrew 安装，执行 `brew uninstall --cask devecocode-desktop` 或
   `brew uninstall --cask devecocode-desktop-offline`；否则从“应用程序”删除
   `DevEco Code.app`；
3. 如确认不再需要本地配置和日志，Homebrew 用户可以追加 `--zap`，或手动删除：

```bash
rm -rf "$HOME/Library/Application Support/DevEco Code Desktop"
rm -rf "$HOME/Library/Logs/DevEco Code Desktop"
```

`--zap` 还会清理 WebKit、缓存和偏好；普通版与 Offline 版共用桌面端配置目录，
因此对任一 cask 执行 `--zap` 都会删除这份共享配置。

不要为了卸载桌面端删除 `~/.local/share/deveco/`，除非你明确要同时清除 CLI 会话数据。

## 常见问题

**提示“无法验证开发者”**

使用右键“打开”或“系统设置 → 隐私与安全性 → 仍要打开”。这是未使用 Developer ID 签名、
未公证应用的预期
行为，不代表安装包损坏。

**提示“已损坏”**

先确认下载来源和架构。仅在确认安装包来自本项目 Releases 时，使用上面的
`xattr -dr com.apple.quarantine` 命令；仍无法解决时不要继续运行，重新下载并检查文件。

**找不到 CLI**

在终端确认 `which deveco` 和 `deveco --version`，然后在设置页手动选择路径。GUI 应用不会
自动继承交互式 shell 的完整 PATH。

**锁屏后没有响应**

CLI 在锁屏或休眠时可能阻塞，解锁后恢复。不要反复重启应用；先解锁，再按提示重试。

**设备页没有截图**

确认手机已开启开发者模式和 USB 调试，`hdc` 可执行文件在 PATH 或 SDK 中，并在手机上授权
本机调试。桌面端设备面板只支持单帧截图，不提供实时投屏；Agent 设备 skill 也使用同一套
HDC 授权。若刚更新应用或 skill，请在托盘菜单重启本地服务后重试。

更完整的平台限制见[已知限制](limitations.md)，发布者流程见[开源发布检查](release.md)。
