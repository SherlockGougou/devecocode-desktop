//! HarmonyOS 设备截图桥。
//!
//! 这里只使用本机 `hdc` 的官方调试命令：发现设备、调用 `snapshot_display`
//! 抓取一帧、再通过 `file recv` 取回。截图是低频操作，不需要在设备上常驻
//! 投屏服务，也不依赖华为投屏组件的内部协议。

use serde::Serialize;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;

/// 截图命令和文件传输通常几百毫秒完成；留足设备首次启动 hdc 服务的时间。
const HDC_TIMEOUT_SECS: u64 = 20;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub serial: String,
    pub connection: String,
    pub status: String,
    pub model: Option<String>,
    pub name: Option<String>,
    pub manufacturer: Option<String>,
    pub api_version: Option<String>,
    pub os_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProbe {
    pub hdc_path: String,
    pub hdc_version: Option<String>,
    pub devices: Vec<DeviceInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceShot {
    pub serial: String,
    pub path: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub captured_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAwakeStatus {
    pub enabled: bool,
    pub charging: bool,
    pub active: bool,
}

/// 设备截图固定放在应用数据目录，避免和用户工作区的文件混在一起。
pub fn screenshots_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|dir| dir.join("DevEco Code Desktop").join("device-shots"))
        .ok_or_else(|| "无法定位应用数据目录".to_string())
}

/// 从 WebView 传入的路径只允许指向应用自己的截图目录，防止变成任意文件读取。
pub fn validate_screenshot_path(raw: &str) -> Result<PathBuf, String> {
    let expected = screenshots_dir()?;
    let path =
        std::fs::canonicalize(raw).map_err(|err| format!("截图文件不存在或无法访问：{err}"))?;
    let root = std::fs::canonicalize(&expected).unwrap_or(expected);
    if !path.starts_with(&root) {
        return Err("截图文件不在 DevEco Code 的设备截图目录内".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "jpg" | "jpeg" | "png") {
        return Err("不支持的截图格式".into());
    }
    Ok(path)
}

pub async fn probe() -> Result<DeviceProbe, String> {
    let hdc = locate_hdc()?;
    let hdc_version = hdc_version(&hdc).await.ok();
    let mut devices = list_targets(&hdc).await?;
    for device in &mut devices {
        if let Err(err) = enrich_device(&hdc, device).await {
            // 设备授权/系统版本差异不应该让整个列表失败；保留序列号让用户还能看到它。
            log::debug!("读取设备信息失败（{}）：{err}", device.serial);
        }
    }
    Ok(DeviceProbe {
        hdc_path: hdc.to_string_lossy().to_string(),
        hdc_version,
        devices,
    })
}

pub async fn capture(serial: Option<&str>, output_dir: &Path) -> Result<DeviceShot, String> {
    let hdc = locate_hdc()?;
    let serial = match serial.map(str::trim).filter(|value| !value.is_empty()) {
        Some(serial) => serial.to_string(),
        None => list_targets(&hdc)
            .await?
            .into_iter()
            .find(|device| device.status.eq_ignore_ascii_case("connected"))
            .map(|device| device.serial)
            .ok_or_else(|| "没有已连接的 HarmonyOS 设备".to_string())?,
    };

    std::fs::create_dir_all(output_dir).map_err(|err| format!("创建设备截图目录失败：{err}"))?;
    let stamp = now_millis();
    let safe_serial = sanitize_serial(&serial);
    // snapshot_display 只接受 .jpeg 后缀；用 .jpg 会返回 invalid suffix。
    let remote = format!("/data/local/tmp/deveco-desktop-{stamp}.jpeg");
    let local = output_dir.join(format!("device-{safe_serial}-{stamp}.jpeg"));
    let local_text = local.to_string_lossy().to_string();

    let result = async {
        run_hdc(
            &hdc,
            &["-t", &serial, "shell", "snapshot_display", "-f", &remote],
            HDC_TIMEOUT_SECS,
        )
        .await?;
        run_hdc(
            &hdc,
            &["-t", &serial, "file", "recv", &remote, &local_text],
            HDC_TIMEOUT_SECS,
        )
        .await?;
        let (width, height) = image_dimensions(&local).await?;
        let bytes = std::fs::metadata(&local)
            .map(|meta| meta.len())
            .map_err(|err| format!("读取截图大小失败：{err}"))?;
        let name = format!("device-screenshot-{stamp}.jpeg");
        Ok::<DeviceShot, String>(DeviceShot {
            serial: serial.clone(),
            path: local_text,
            name,
            width,
            height,
            bytes,
            captured_at: stamp,
        })
    }
    .await;

    // 无论抓取/传输是否成功，都尽量清掉设备侧临时文件；清理失败不影响主结果。
    let _ = run_hdc(&hdc, &["-t", &serial, "shell", "rm", "-f", &remote], 8).await;

    match result {
        Ok(shot) => {
            log::info!(
                "设备截图已保存：{}（{}×{}）",
                shot.path,
                shot.width,
                shot.height
            );
            Ok(shot)
        }
        Err(err) => {
            log::warn!("设备截图失败：{err}");
            let _ = std::fs::remove_file(&local);
            Err(err)
        }
    }
}

/// 查询设备是否接了充电器。`pluggedType` 为 0 表示未接电源。
pub async fn battery_plugged(serial: &str) -> Result<bool, String> {
    let hdc = locate_hdc()?;
    let output = run_hdc(
        &hdc,
        &[
            "-t",
            serial,
            "shell",
            "hidumper",
            "-s",
            "BatteryService",
            "-a",
            "-i",
        ],
        12,
    )
    .await?;
    parse_battery_plugged(&String::from_utf8_lossy(&output.stdout))
}

fn parse_battery_plugged(text: &str) -> Result<bool, String> {
    for line in text.lines() {
        let Some(value) = line.trim().strip_prefix("pluggedType:") else {
            continue;
        };
        let plugged = value
            .trim()
            .parse::<i32>()
            .map_err(|err| format!("无法解析充电状态：{err}"))?;
        return Ok(plugged != 0);
    }
    Err("未读取到 pluggedType".into())
}

/// 设置/释放 PowerManagerService 的 SCREEN keep-on 锁。
///
/// `-f` 只释放这把锁，不会改写系统默认息屏时间；因此关闭开关后，
/// 手机仍按用户原本的“息屏时间”设置运行。
pub async fn set_keep_on(serial: &str, keep_on: bool) -> Result<(), String> {
    let hdc = locate_hdc()?;
    let flag = if keep_on { "-t" } else { "-f" };
    run_hdc(
        &hdc,
        &[
            "-t",
            serial,
            "shell",
            "hidumper",
            "-s",
            "PowerManagerService",
            "-a",
            flag,
        ],
        12,
    )
    .await?;
    Ok(())
}

/// 应用退出时同步释放 keep-on 锁，避免留下手机保持亮屏的副作用。
pub fn set_keep_on_blocking(serial: &str, keep_on: bool) -> Result<(), String> {
    let hdc = locate_hdc()?;
    let flag = if keep_on { "-t" } else { "-f" };
    let status = std::process::Command::new(hdc)
        .args([
            "-t",
            serial,
            "shell",
            "hidumper",
            "-s",
            "PowerManagerService",
            "-a",
            flag,
        ])
        .stdin(Stdio::null())
        .status()
        .map_err(|err| format!("释放设备亮屏锁失败：{err}"))?;
    if !status.success() {
        return Err(format!("释放设备亮屏锁失败：{status}"));
    }
    Ok(())
}

fn locate_hdc() -> Result<PathBuf, String> {
    for candidate in hdc_candidates() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("未找到 hdc。请安装 DevEco Studio（或 OpenHarmony SDK），\
         也可以设置 HDC 环境变量指向 hdc 可执行文件。"
        .to_string())
}

fn hdc_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(value) = env::var_os("HDC") {
        candidates.push(PathBuf::from(value));
    }

    if let Some(home) = dirs::home_dir() {
        collect_ide_bundles(&home.join("Applications"), &mut candidates);
    }
    collect_ide_bundles(Path::new("/Applications"), &mut candidates);
    if let Some(home) = dirs::home_dir() {
        collect_sdk_versions(&home.join("Library/OpenHarmony/Sdk"), &mut candidates);
        collect_sdk_versions(&home.join("Library/Huawei/Sdk"), &mut candidates);
    }

    if let Some(value) = env::var_os("PATH") {
        for dir in env::split_paths(&value) {
            candidates.push(dir.join("hdc"));
        }
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/hdc"));
    candidates.push(PathBuf::from("/usr/local/bin/hdc"));
    candidates
}

fn collect_ide_bundles(root: &Path, candidates: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with("DevEco-Studio") && name.ends_with(".app"))
        .collect();
    // 同一台机器可能同时装了多个 DevEco Studio 版本，优先新版本。
    names.sort_by(|a, b| b.cmp(a));
    for name in names {
        candidates.push(
            root.join(name)
                .join("Contents/sdk/default/openharmony/toolchains/hdc"),
        );
    }
}

fn collect_sdk_versions(root: &Path, candidates: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort_by(|a, b| b.cmp(a));
    for name in names {
        candidates.push(root.join(name).join("toolchains/hdc"));
    }
}

async fn hdc_version(hdc: &Path) -> Result<String, String> {
    let output = run_hdc(hdc, &["-v"], 8).await?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next().unwrap_or_default().trim();
    Ok(line
        .split_once(':')
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| line.to_string()))
}

async fn list_targets(hdc: &Path) -> Result<Vec<DeviceInfo>, String> {
    let output = run_hdc(hdc, &["list", "targets", "-v"], HDC_TIMEOUT_SECS).await?;
    Ok(parse_targets(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_targets(text: &str) -> Vec<DeviceInfo> {
    text.lines()
        .filter_map(|line| {
            let mut fields: Vec<&str> = line
                .split('\t')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect();
            if fields.len() < 3 {
                fields = line.split_whitespace().collect();
            }
            if fields.len() < 3 {
                return None;
            }
            let serial = fields[0].trim();
            if serial.is_empty() || serial == "[Empty]" || serial.eq_ignore_ascii_case("empty") {
                return None;
            }
            Some(DeviceInfo {
                serial: serial.to_string(),
                connection: fields[1].to_string(),
                status: fields[2].to_string(),
                model: None,
                name: None,
                manufacturer: None,
                api_version: None,
                os_version: None,
            })
        })
        .collect()
}

async fn enrich_device(hdc: &Path, device: &mut DeviceInfo) -> Result<(), String> {
    let script = concat!(
        "echo __DEVECO_MODEL__; param get const.product.model; ",
        "echo __DEVECO_NAME__; param get const.product.name; ",
        "echo __DEVECO_MANUFACTURER__; param get const.product.manufacturer; ",
        "echo __DEVECO_API__; param get const.ohos.apiversion; ",
        "echo __DEVECO_OS__; param get const.product.software.version"
    );
    let output = run_hdc(
        hdc,
        &["-t", &device.serial, "shell", script],
        HDC_TIMEOUT_SECS,
    )
    .await?;
    fill_device_params(device, &String::from_utf8_lossy(&output.stdout));
    Ok(())
}

fn fill_device_params(device: &mut DeviceInfo, text: &str) {
    let mut field: Option<&str> = None;
    for line in text.lines() {
        let line = line.trim();
        match line {
            "__DEVECO_MODEL__" => field = Some("model"),
            "__DEVECO_NAME__" => field = Some("name"),
            "__DEVECO_MANUFACTURER__" => field = Some("manufacturer"),
            "__DEVECO_API__" => field = Some("api"),
            "__DEVECO_OS__" => field = Some("os"),
            "" => {}
            _ => {
                let value = Some(line.to_string());
                match field {
                    Some("model") => device.model = value,
                    Some("name") => device.name = value,
                    Some("manufacturer") => device.manufacturer = value,
                    Some("api") => device.api_version = value,
                    Some("os") => device.os_version = value,
                    _ => {}
                }
            }
        }
    }
}

async fn image_dimensions(path: &Path) -> Result<(u32, u32), String> {
    let path_text = path.to_string_lossy();
    let output = run_tool(
        "sips",
        &["-g", "pixelWidth", "-g", "pixelHeight", path_text.as_ref()],
        8,
    )
    .await?;
    let text = String::from_utf8_lossy(&output.stdout);
    parse_sips_dimensions(&text)
}

fn parse_sips_dimensions(text: &str) -> Result<(u32, u32), String> {
    let mut width = None;
    let mut height = None;
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once(':') else {
            continue;
        };
        let parsed = value.trim().parse::<u32>().ok();
        match key.trim() {
            "pixelWidth" => width = parsed,
            "pixelHeight" => height = parsed,
            _ => {}
        }
    }
    match (width, height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => Ok((width, height)),
        _ => Err("无法读取截图尺寸".into()),
    }
}

async fn run_hdc(
    hdc: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(hdc);
    command.args(args).stdin(Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(timeout_secs), command.output())
        .await
        .map_err(|_| format!("hdc 命令超时（{timeout_secs}s）"))?
        .map_err(|err| format!("启动 hdc 失败：{err}"))?;
    if !output.status.success() {
        let detail = command_error(&output);
        return Err(format!("hdc 命令失败（{}）：{detail}", output.status));
    }
    Ok(output)
}

async fn run_tool(
    program: &str,
    args: &[&str],
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(timeout_secs), command.output())
        .await
        .map_err(|_| format!("{program} 命令超时（{timeout_secs}s）"))?
        .map_err(|err| format!("启动 {program} 失败：{err}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} 命令失败（{}）：{}",
            output.status,
            command_error(&output)
        ));
    }
    Ok(output)
}

fn command_error(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if detail.is_empty() {
        "无错误输出".to_string()
    } else {
        detail.chars().take(400).collect()
    }
}

fn sanitize_serial(serial: &str) -> String {
    let sanitized: String = serial
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .take(48)
        .collect();
    if sanitized.is_empty() {
        "device".to_string()
    } else {
        sanitized
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析设备列表并忽略空行() {
        let devices = parse_targets(
            "DEVICE-A1B2C3\t\tUSB\tConnected\tlocalhost\thdc\n\
             192.168.1.5:5555\t\tTCP\tConnected\tlocalhost\thdc\n\
             [Empty]\n",
        );
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].serial, "DEVICE-A1B2C3");
        assert_eq!(devices[0].connection, "USB");
        assert_eq!(devices[0].status, "Connected");
        assert_eq!(devices[1].serial, "192.168.1.5:5555");
    }

    #[test]
    fn 解析设备参数标记() {
        let mut device = DeviceInfo {
            serial: "SERIAL-TEST".into(),
            connection: "USB".into(),
            status: "Connected".into(),
            model: None,
            name: None,
            manufacturer: None,
            api_version: None,
            os_version: None,
        };
        fill_device_params(
            &mut device,
            "__DEVECO_MODEL__\nTLR-AL00\n__DEVECO_NAME__\nnova 14\n\
             __DEVECO_MANUFACTURER__\nHUAWEI\n__DEVECO_API__\n26\n\
             __DEVECO_OS__\nTLR-AL00 7.0.0.111\n",
        );
        assert_eq!(device.model.as_deref(), Some("TLR-AL00"));
        assert_eq!(device.name.as_deref(), Some("nova 14"));
        assert_eq!(device.manufacturer.as_deref(), Some("HUAWEI"));
        assert_eq!(device.api_version.as_deref(), Some("26"));
        assert_eq!(device.os_version.as_deref(), Some("TLR-AL00 7.0.0.111"));
    }

    #[test]
    fn 截图序列号会转成安全文件名() {
        assert_eq!(sanitize_serial("192.168.1.5:5555"), "192.168.1.5_5555");
        assert_eq!(sanitize_serial(""), "device");
    }

    #[test]
    fn 解析sips尺寸输出() {
        let text = "/tmp/shot.jpg\n  pixelWidth: 1084\n  pixelHeight: 2412\n";
        assert_eq!(parse_sips_dimensions(text).unwrap(), (1084, 2412));
        assert!(parse_sips_dimensions("pixelWidth: 0").is_err());
    }

    #[test]
    fn 解析充电状态() {
        assert!(parse_battery_plugged("capacity: 80\npluggedType: 1\n").unwrap());
        assert!(!parse_battery_plugged("capacity: 80\npluggedType: 0\n").unwrap());
        assert!(parse_battery_plugged("capacity: 80\n").is_err());
    }
}
