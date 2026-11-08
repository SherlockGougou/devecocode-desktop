---
name: deveco-desktop-device
description: "Use when working with a connected HarmonyOS or OpenHarmony device from DevEco Code Desktop: list real devices and emulators, capture the screen, inspect the UI layout, tap/swipe/type, install or launch an app, collect hilog or crash logs, or diagnose hdc connection failures. Triggers: 手机, 真机, 鸿蒙设备, 手机屏幕, 设备截图, 连接设备, hdc, 安装应用, 启动应用, 在手机上打开, 点一下, 滑动, hilog, 查看日志."
---

# DevEco Code Desktop 设备能力

DevEco Code Desktop 内置设备面板，并在启动 CLI 时注入可用的 `HDC` 路径。这个 skill 让 Agent
不依赖鼠标操作界面，而是通过 `hdc` 观察和操作同一台 HarmonyOS 设备。

与其他 skill 的边界：

- 构建、签名和完整部署流程仍遵循 `deveco-cli` skill；不要用本 skill 绕过构建或签名。
- 崩溃/闪退/白屏的证据分析优先遵循 `hmos-runtime-fix-skill`。
- `devecocli` 可用时优先使用它的 `device`、`ui` 和 `log` 子命令；不可用时再用本 skill 的
  原生 HDC 命令。

## 1. 边界与顺序

1. **先观察，再操作**：先取得设备列表、截图或布局树，确认目标设备和当前页面后才执行点击、
   安装、启动、停止等动作。
2. **只做用户要求的事**：安装、卸载、清数据、重启设备、修改系统设置和发送文件都必须来自
   用户的明确请求；不要因为“顺手”扩大操作范围。
3. **多设备不猜**：多于一个 `Connected` 设备时，明确列出并让用户选择；没有唯一目标就停止。
4. **不在仓库留下设备证据**：截图、布局树和日志放在 `.agent-temp/device/`；设备序列号、
   截图内容和日志不要提交到仓库或写入项目文档。
5. **UI 面板是人工入口**：用户仍可在右栏「设备」页查看同一台设备并附加截图；Agent 不应
   假装能点击桌面端的 UI，使用下面的 HDC 命令。

## 2. 定位 HDC 与选择设备

桌面端通常已经把 `HDC` 设为可执行文件路径。每个新 shell 都先确认：

```bash
HDC_BIN="${HDC:-}"
if [ -z "$HDC_BIN" ] || [ ! -x "$HDC_BIN" ]; then
  HDC_BIN="$(command -v hdc 2>/dev/null || true)"
fi
if [ -z "$HDC_BIN" ] || [ ! -x "$HDC_BIN" ]; then
  for candidate in \
    "$HOME/Library/OpenHarmony/Sdk"/*/toolchains/hdc \
    "$HOME/Library/Huawei/Sdk"/*/toolchains/hdc \
    /Applications/DevEco-Studio*.app/Contents/sdk/default/openharmony/toolchains/hdc \
    /opt/homebrew/bin/hdc /usr/local/bin/hdc; do
    if [ -x "$candidate" ]; then HDC_BIN="$candidate"; break; fi
  done
fi
test -x "$HDC_BIN" || { echo "未找到 hdc，请安装 DevEco Studio 或设置 HDC"; exit 2; }
"$HDC_BIN" list targets -v
```

读取输出时：

- 没有目标：提示用户开启开发者模式、USB/无线调试，并在手机上授权本机调试。
- 唯一的 `Connected` 目标：记录它的 serial，后续命令都带 `-t "$SERIAL"`。
- 多个目标：列出型号或 serial，使用问题选择工具或请用户确认；不要任选第一个。
- `Offline`、`Unauthorized`：先修复连接，不要继续抓图或注入输入。

读取设备信息（只读）：

```bash
"$HDC_BIN" -t "$SERIAL" shell \
  'param get const.product.model; param get const.product.name; \
   param get const.ohos.apiversion; param get const.product.software.version'
```

需要充电/电源状态时：

```bash
"$HDC_BIN" -t "$SERIAL" shell hidumper -s BatteryService -a -i
```

## 3. 观察屏幕

单帧截图比持续投屏更稳定，也足够做视觉判断。截图必须使用 `.jpeg` 后缀：

```bash
mkdir -p .agent-temp/device
REMOTE="/data/local/tmp/deveco-agent-shot-$(date +%s).jpeg"
"$HDC_BIN" -t "$SERIAL" shell snapshot_display -f "$REMOTE"
"$HDC_BIN" -t "$SERIAL" file recv "$REMOTE" .agent-temp/device/screen.jpeg
"$HDC_BIN" -t "$SERIAL" shell rm -f "$REMOTE"
sips -g pixelWidth -g pixelHeight .agent-temp/device/screen.jpeg
```

- 截图后用 Read 工具读取 JPEG（当前模型支持图片时）；如果当前环境不能渲染图片，如实报告
  文件路径和尺寸，不要凭空描述画面。
- 锁屏、安全窗口和受保护内容可能黑屏；此时请用户解锁或换到普通页面。
- 显示器不是默认屏时，`snapshot_display` 可加 `-i <displayId>`；不确定 display id 时先不要猜。

## 4. 检查 UI 布局

布局树能提供节点 id、类型、文本、可点击性、滚动性和 bounds，是定位坐标的首选证据：

```bash
LAYOUT_REMOTE="/data/local/tmp/deveco-agent-layout-$(date +%s).json"
LAYOUT_LOCAL=".agent-temp/device/layout.json"
"$HDC_BIN" -t "$SERIAL" shell uitest dumpLayout -p "$LAYOUT_REMOTE"
"$HDC_BIN" -t "$SERIAL" file recv "$LAYOUT_REMOTE" "$LAYOUT_LOCAL"
"$HDC_BIN" -t "$SERIAL" shell rm -f "$LAYOUT_REMOTE"
```

用 Read 或 `jq` 读取 `$LAYOUT_LOCAL`，按 `bounds` 计算节点中心。操作前重新取一次布局，
不要依赖上一轮的坐标；页面滚动、弹窗和窗口切换都会让旧坐标失效。

如果 `devecocli` 恰好在当前 PATH 中，可以使用更稳定的高层命令：

```bash
devecocli device list --format json
devecocli ui layout --device "$SERIAL" --format json
devecocli ui click --device "$SERIAL" --id <nodeId>
```

不可用时继续使用下节的 HDC 原生命令。

## 5. UI 输入

坐标单位为设备像素，原点在左上角。先截图/布局树确认目标，再用节点中心或明确坐标：

```bash
"$HDC_BIN" -t "$SERIAL" shell uitest uiInput click 540 1200
"$HDC_BIN" -t "$SERIAL" shell uitest uiInput doubleClick 540 1200
"$HDC_BIN" -t "$SERIAL" shell uitest uiInput longClick 540 1200
"$HDC_BIN" -t "$SERIAL" shell uitest uiInput swipe 540 1800 540 600
```

方向滚动使用 `dircFling`：`0=left`、`1=right`、`2=up`、`3=down`。

输入文本优先在已聚焦输入框上使用 `text`，或对指定坐标使用 `inputText`：

```bash
"$HDC_BIN" -t "$SERIAL" shell uitest uiInput text "hello"
"$HDC_BIN" -t "$SERIAL" shell uitest uiInput inputText 540 1200 "hello"
```

含空格、中文或 shell 特殊字符时，先做 base64 解码再传给设备，避免转义错误：

```bash
TEXT="$(printf '%s' '要输入的文字' | base64)"
"$HDC_BIN" -t "$SERIAL" shell "uitest uiInput text \"$(printf '%s' "$TEXT" | base64 -d)\""
```

每次点击、滑动或输入后，至少重新截图或 dumpLayout 一次确认状态；不要连续盲点多个坐标。

## 6. 应用安装、启动与日志

只有用户明确要求时才执行修改设备的命令：

```bash
"$HDC_BIN" -t "$SERIAL" shell aa force-stop <bundleName>
"$HDC_BIN" -t "$SERIAL" shell aa start -a <abilityName> -b <bundleName>
"$HDC_BIN" -t "$SERIAL" shell bm uninstall -n <bundleName>
```

安装前把 HAP/HSP 传到设备临时目录，再调用 `bm install`；完成后删除临时目录：

```bash
REMOTE_DIR="/data/local/tmp/deveco-agent-install-$(date +%s)"
"$HDC_BIN" -t "$SERIAL" shell mkdir "$REMOTE_DIR"
"$HDC_BIN" -t "$SERIAL" file send ./build/default/outputs/default/entry-default-signed.hap "$REMOTE_DIR/"
"$HDC_BIN" -t "$SERIAL" shell bm install -p "$REMOTE_DIR"
"$HDC_BIN" -t "$SERIAL" shell rm -rf "$REMOTE_DIR"
```

日志和崩溃分析：

- 优先使用 `devecocli log --device "$SERIAL" ...`（若 PATH 可用）。
- 崩溃/闪退/白屏任务优先遵循 `hmos-runtime-fix-skill`，不要用本 skill 取代 DFX 分析。
- 临时快速查看可用 `"$HDC_BIN" -t "$SERIAL" shell hilog -T <tag>`；把输出写入
  `.agent-temp/device/`，不要直接把大段日志粘进最终回复。
- 不要把 hilog 留成前台无限流；使用 Bash 工具的 timeout，或在采集窗口结束后终止进程。
- 采集前向用户确认要复现的操作，采集后说明时间窗口、过滤条件和日志路径。

## 7. 文件传输与清理

```bash
"$HDC_BIN" -t "$SERIAL" file send ./local/file /data/local/tmp/deveco-agent-file
"$HDC_BIN" -t "$SERIAL" file recv /data/local/tmp/deveco-agent-file .agent-temp/device/file
```

只用 `/data/local/tmp/deveco-agent-*` 作为设备侧临时路径；无论命令成功还是失败，都尝试
删除本次创建的临时文件和目录。删除失败要报告，但不要把失败当成设备操作成功。

## 8. 失败处理

- `hdc` 不存在：按第 2 节查找 DevEco Studio/OpenHarmony SDK；仍找不到就请用户安装或设置
  `HDC`，不要回退到伪造截图。
- 设备授权失败：让用户在手机上确认调试授权；不要反复重启设备。
- 命令超时或 `Offline`：先重新执行 `list targets -v`，确认设备/模拟器仍在线，再重试一次。
- 截图黑屏但操作成功：说明是锁屏/受保护页面，不要据此判断应用异常。
- 用户要求实时投屏、连续视频或远程控制：当前 skill 只提供单帧截图和 HDC 命令，明确说明
  边界，不要假装有实时流。
