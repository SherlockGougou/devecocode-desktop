//! 前端 ↔ 本机 CLI 的桥。
//!
//! 所有 HTTP 请求都从这里代理，好处有两个：
//! 1. WebView 不直连 `127.0.0.1:<port>`，绕开 CORS 与 ATS；
//! 2. 连接信息（base_url / 口令）只存在于 Rust 侧，前端拿不到也用不着。

use deveco_desktop::{cli_config, device, http};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::image::Image;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

/// 后端连接信息。启动完成后由主进程写入。
#[derive(Default)]
pub struct ServerConn {
    base_url: Mutex<Option<String>>,
    auth: Mutex<Option<String>>,
}

impl ServerConn {
    pub fn set(&self, base_url: String, auth: Option<String>) {
        *self.base_url.lock().expect("base_url 锁中毒") = Some(base_url);
        *self.auth.lock().expect("auth 锁中毒") = auth;
    }

    pub fn base(&self) -> Option<String> {
        self.base_url.lock().ok().and_then(|v| v.clone())
    }

    pub fn auth(&self) -> Option<String> {
        self.auth.lock().ok().and_then(|v| v.clone())
    }
}

#[tauri::command]
pub async fn server_request(
    conn: tauri::State<'_, ServerConn>,
    method: String,
    path: String,
    query: Option<Map<String, Value>>,
    body: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let base = conn.base().ok_or("后端尚未就绪")?;
    let auth = conn.auth();
    let started = std::time::Instant::now();
    log::debug!("proxy → {method} {path}");

    let pairs: Vec<(String, String)> = query
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(key, value)| {
            let text = match value {
                Value::String(s) => s,
                other => other.to_string(),
            };
            (key, text)
        })
        .collect();

    let result = http::send_with_timeout(
        &base,
        auth.as_deref(),
        &method,
        &path,
        &pairs,
        body.as_ref(),
        http::request_timeout(timeout_ms),
    )
    .await
    .map_err(|err| format!("{err:#}"));
    log::debug!(
        "proxy ← {method} {path} {:?}（{}ms）",
        result.as_ref().map(|_| "ok").map_err(|err| err.clone()),
        started.elapsed().as_millis()
    );
    result
}

#[tauri::command]
pub async fn cli_config_read(
    conn: tauri::State<'_, ServerConn>,
    scope: cli_config::Scope,
    directory: Option<String>,
    reveal_secrets: Option<bool>,
) -> Result<cli_config::ConfigSnapshot, String> {
    let base = conn.base().ok_or("后端尚未就绪")?;
    let auth = conn.auth();
    cli_config::read(
        &base,
        auth.as_deref(),
        scope,
        directory.as_deref(),
        reveal_secrets.unwrap_or(false),
    )
    .await
    .map_err(|err| format!("{err:#}"))
}

#[tauri::command]
pub async fn cli_config_sources(
    conn: tauri::State<'_, ServerConn>,
    directory: Option<String>,
) -> Result<cli_config::ConfigSources, String> {
    let base = conn.base().ok_or("后端尚未就绪")?;
    let auth = conn.auth();
    cli_config::sources(&base, auth.as_deref(), directory.as_deref())
        .await
        .map_err(|err| format!("{err:#}"))
}

#[tauri::command]
pub async fn cli_config_save(
    conn: tauri::State<'_, ServerConn>,
    request: cli_config::SaveRequest,
) -> Result<cli_config::SaveResult, String> {
    let base = conn.base().ok_or("后端尚未就绪")?;
    let auth = conn.auth();
    cli_config::save(&base, auth.as_deref(), request)
        .await
        .map_err(|err| format!("{err:#}"))
}

#[tauri::command]
pub async fn cli_config_reveal_secret(
    conn: tauri::State<'_, ServerConn>,
    scope: cli_config::Scope,
    directory: Option<String>,
    path: Vec<cli_config::PathSegment>,
) -> Result<Option<String>, String> {
    let base = conn.base().ok_or("后端尚未就绪")?;
    let auth = conn.auth();
    cli_config::reveal_secret(&base, auth.as_deref(), scope, directory.as_deref(), &path)
        .await
        .map_err(|err| format!("{err:#}"))
}

#[tauri::command]
pub async fn cli_config_backups(
    conn: tauri::State<'_, ServerConn>,
    scope: cli_config::Scope,
    directory: Option<String>,
) -> Result<Vec<cli_config::BackupInfo>, String> {
    let base = conn.base().ok_or("后端尚未就绪")?;
    let auth = conn.auth();
    cli_config::list_backups(&base, auth.as_deref(), scope, directory.as_deref())
        .await
        .map_err(|err| format!("{err:#}"))
}

#[tauri::command]
pub async fn cli_config_restore(
    conn: tauri::State<'_, ServerConn>,
    request: cli_config::BackupRestoreRequest,
) -> Result<cli_config::ConfigSnapshot, String> {
    let base = conn.base().ok_or("后端尚未就绪")?;
    let auth = conn.auth();
    cli_config::restore_backup(&base, auth.as_deref(), request)
        .await
        .map_err(|err| format!("{err:#}"))
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("只允许打开 http/https 链接".to_string());
    }
    if trimmed.contains('\0') {
        return Err("链接不合法".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|err| format!("打开链接失败：{err}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", trimmed])
            .spawn()
            .map_err(|err| format!("打开链接失败：{err}"))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|err| format!("打开链接失败：{err}"))?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 后端状态：自愈过程对界面可见，并允许用户手动触发重试
// ---------------------------------------------------------------------------

/// 后端监管者与界面之间的控制面。
///
/// `retry` 用来打断退避等待：界面点「重试」后主循环立刻再尝试一次；
/// `phase` 保存最近一次状态，避免前端在启动竞态里拿不到当前值。
#[derive(Clone)]
pub struct BackendCtl {
    pub retry: std::sync::Arc<tokio::sync::Notify>,
    /// 强制重建：即使当前后端健康，也结束事件流并回收进程组
    pub restart: std::sync::Arc<tokio::sync::Notify>,
    pub phase: std::sync::Arc<Mutex<serde_json::Value>>,
}

/// 设备“充电时保持亮屏”的前端开关和后端轮询状态。
///
/// 开关只保存在本次应用进程内；应用退出时会释放设备侧 keep-on 锁，
/// 避免把用户原本的息屏时间永久改掉。
#[derive(Clone, Default)]
pub struct DeviceAwakeState {
    inner: Arc<DeviceAwakeInner>,
}

#[derive(Default)]
struct DeviceAwakeInner {
    enabled: Mutex<HashMap<String, bool>>,
    active: Mutex<HashMap<String, bool>>,
    monitor_started: AtomicBool,
}

impl DeviceAwakeState {
    pub fn enabled_for(&self, serial: &str) -> bool {
        self.inner
            .enabled
            .lock()
            .ok()
            .and_then(|values| values.get(serial).copied())
            .unwrap_or(false)
    }

    fn set_enabled(&self, serial: &str, enabled: bool) {
        if let Ok(mut values) = self.inner.enabled.lock() {
            values.insert(serial.to_string(), enabled);
        }
    }

    fn active_for(&self, serial: &str) -> bool {
        self.inner
            .active
            .lock()
            .ok()
            .and_then(|values| values.get(serial).copied())
            .unwrap_or(false)
    }

    fn set_active(&self, serial: &str, active: bool) {
        if let Ok(mut values) = self.inner.active.lock() {
            values.insert(serial.to_string(), active);
        }
    }

    fn enabled_serials(&self) -> Vec<String> {
        self.inner
            .enabled
            .lock()
            .map(|values| {
                values
                    .iter()
                    .filter_map(|(serial, enabled)| enabled.then_some(serial.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn ensure_monitor(&self) {
        if self.inner.monitor_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                for serial in state.enabled_serials() {
                    match device::battery_plugged(&serial).await {
                        Ok(charging) => {
                            let active = state.active_for(&serial);
                            if charging && !active {
                                if let Err(err) = device::set_keep_on(&serial, true).await {
                                    log::warn!("开启设备亮屏锁失败（{serial}）：{err}");
                                } else {
                                    state.set_active(&serial, true);
                                }
                            } else if !charging && active {
                                if let Err(err) = device::set_keep_on(&serial, false).await {
                                    log::warn!("释放设备亮屏锁失败（{serial}）：{err}");
                                } else {
                                    state.set_active(&serial, false);
                                }
                            }
                        }
                        Err(err) => log::debug!("查询设备充电状态失败（{serial}）：{err}"),
                    }
                }
            }
        });
    }

    /// 应用退出时同步清理，调用方在 `RunEvent::Exit` 中使用。
    pub fn shutdown_blocking(&self) {
        let mut serials = self.enabled_serials();
        if let Ok(values) = self.inner.active.lock() {
            for (serial, active) in values.iter() {
                if *active && !serials.contains(serial) {
                    serials.push(serial.clone());
                }
            }
        }
        for serial in serials {
            if let Err(err) = device::set_keep_on_blocking(&serial, false) {
                log::warn!("退出时释放设备亮屏锁失败（{serial}）：{err}");
            }
        }
        if let Ok(mut values) = self.inner.enabled.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.inner.active.lock() {
            values.clear();
        }
    }
}

impl Default for BackendCtl {
    fn default() -> Self {
        Self {
            retry: Default::default(),
            restart: Default::default(),
            // 未收到第一次广播前前端就可能来查，必须是合法初值而不是 null
            phase: std::sync::Arc::new(Mutex::new(serde_json::json!({
                "state": "starting",
                "attempt": 0,
                "detail": null,
            }))),
        }
    }
}

impl BackendCtl {
    pub fn set_phase(&self, phase: serde_json::Value) {
        if let Ok(mut current) = self.phase.lock() {
            *current = phase;
        }
    }

    pub fn phase(&self) -> serde_json::Value {
        self.phase
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| serde_json::json!({ "state": "starting" }))
    }

    /// 唤醒主循环的退避等待（没有等待者时是空操作，下一次等待会立刻通过）
    pub fn request_retry(&self) {
        self.retry.notify_one();
    }

    /// 强制结束当前事件流，让监管循环回收并重建 serve。
    pub fn request_restart(&self) {
        self.restart.notify_one();
    }
}

/// 当前后端状态（前端挂载时同步一次，避免错过启动阶段的广播）
#[tauri::command]
pub fn backend_state(ctl: tauri::State<'_, BackendCtl>) -> Value {
    ctl.phase()
}

/// 用户手动重试：立即打断退避，重新探测/重建后端
#[tauri::command]
pub fn retry_backend(ctl: tauri::State<'_, BackendCtl>) {
    log::info!("用户请求重试后端");
    ctl.request_retry();
}

/// 启动目录提示：`DEVECO_DESKTOP_DIR` 指定时优先打开该工作区。
/// 既方便自动化测试，也是将来「在 DevEco Code 中打开」深链的落点。
#[tauri::command]
pub fn startup_directory() -> Option<String> {
    let raw = std::env::var("DEVECO_DESKTOP_DIR").ok()?;
    if raw.is_empty() {
        return None;
    }
    // macOS 上 /tmp 是 /private/tmp 的符号链接，而 CLI 返回的 worktree 是规范化后的
    // 路径；不归一化就匹配不到项目。
    let canonical = std::fs::canonicalize(&raw)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or(raw);
    log::info!("启动目录提示：{canonical}");
    Some(canonical)
}

/// 判断路径是否存在：工作区列表要过滤掉已被删除/已失效的目录。
///
/// 返回 `None` 表示「无法判断」而不是「不存在」：macOS 的文件夹授权还没
/// 完成时，`metadata` 会失败或阻塞，直接把工作区当成已删除会让侧栏变空。
#[tauri::command]
pub async fn path_exists(path: String) -> Option<bool> {
    match tauri::async_runtime::spawn_blocking(move || path_exists_blocking(&path)).await {
        Ok(exists) => exists,
        Err(err) => {
            log::warn!("检查路径是否存在失败：{err}");
            None
        }
    }
}

fn path_exists_blocking(path: &str) -> Option<bool> {
    match std::fs::metadata(path) {
        Ok(_) => Some(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Some(false),
        Err(err) => {
            log::debug!("无法判断工作区是否存在：{path}（{err}）");
            None
        }
    }
}

/// 用系统目录选择器新建工作区，返回规范化后的绝对路径。
///
/// 目录选择器运行在系统 UI 线程；放进 blocking 任务，避免阻塞 Tauri 的异步命令线程。
#[tauri::command]
pub async fn pick_workspace_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_title("选择工作区文件夹")
            .blocking_pick_folder();
        let Some(folder) = picked else {
            return Ok(None);
        };
        let path = folder
            .into_path()
            .map_err(|err| format!("无法读取所选文件夹路径：{err}"))?;
        let canonical =
            std::fs::canonicalize(&path).map_err(|err| format!("无法访问所选文件夹：{err}"))?;
        if !canonical.is_dir() {
            return Err("所选路径不是文件夹".into());
        }
        Ok(Some(canonical.to_string_lossy().to_string()))
    })
    .await
    .map_err(|err| format!("目录选择器异常退出：{err}"))?
}

// ---------------------------------------------------------------------------
// 设置页
// ---------------------------------------------------------------------------

use deveco_desktop::cli;
use deveco_desktop::config::Config;
use serde::Serialize;
use std::path::PathBuf;

/// 运行期信息（只读展示）
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub app_version: String,
    pub base_url: Option<String>,
    pub cli_path: Option<String>,
    pub cli_version: Option<String>,
    #[serde(skip)]
    pub cli_env: Vec<(String, String)>,
    pub config_path: Option<String>,
    pub log_dir: Option<String>,
    pub data_dir: Option<String>,
}

/// 设置页状态：可写配置 + 只读运行信息。
/// 内部用 Arc<Mutex<_>>，让调用方可以先把句柄克隆出来再离开 State 借用。
#[derive(Default, Clone)]
pub struct SettingsState {
    pub config: std::sync::Arc<Mutex<Config>>,
    pub runtime: std::sync::Arc<Mutex<RuntimeInfo>>,
    pub config_path: std::sync::Arc<Mutex<Option<PathBuf>>>,
}

pub fn logs_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Library/Logs/DevEco Code Desktop"))
}

pub fn data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join("DevEco Code Desktop"))
}

/// 枚举系统字体家族，供设置页的下拉框使用。
#[tauri::command]
pub async fn list_font_families() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(deveco_desktop::fonts::available_font_families)
        .await
        .map_err(|err| format!("字体列表任务失败：{err}"))?
        .map_err(|err| format!("{err:#}"))
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, SettingsState>) -> Result<Value, String> {
    let config = state.config.lock().map_err(|_| "配置锁中毒")?.clone();
    let runtime = state.runtime.lock().map_err(|_| "运行信息锁中毒")?.clone();
    Ok(serde_json::json!({ "config": config, "runtime": runtime }))
}

/// 保存设置。返回 `restartRequired`：CLI 路径、端口、口令这类改动要重启才能生效。
#[tauri::command]
pub fn save_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, SettingsState>,
    config: Value,
) -> Result<Value, String> {
    let mut incoming: Config =
        serde_json::from_value(config).map_err(|err| format!("配置格式不正确：{err}"))?;
    let (previous, path) = {
        let config = state.config.lock().map_err(|_| "配置锁中毒")?;
        (
            config.clone(),
            state.config_path.lock().map_err(|_| "路径锁中毒")?.clone(),
        )
    };
    incoming.bundled_cli = previous.bundled_cli.clone();

    let restart_required = previous.cli_path != incoming.cli_path
        || previous.use_bundled_cli != incoming.use_bundled_cli
        || previous.server != incoming.server;

    if let Some(path) = &path {
        incoming
            .save(path)
            .map_err(|err| format!("写入配置失败：{err}"))?;
    }
    *state.config.lock().map_err(|_| "配置锁中毒")? = incoming.clone();
    crate::menubar::apply_preferences(&app, incoming.menu_bar.clone());
    log::info!("设置已保存（restartRequired={restart_required}）");

    Ok(serde_json::json!({
        "ok": true,
        "restartRequired": restart_required,
        "config": incoming,
    }))
}

/// 重新探测 CLI（用于用户手选路径后校验）
#[tauri::command]
pub async fn probe_cli(explicit: Option<String>) -> Result<Value, String> {
    let found = cli::discover(explicit.as_deref().map(std::path::Path::new))
        .map_err(|err| err.to_string())?;
    Ok(serde_json::json!({
        "path": found.path.to_string_lossy(),
        "version": found.version.map(|version| version.to_string()),
    }))
}

/// 用系统默认方式打开文件/目录（Finder、日志目录等）
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .status()
        .map_err(|err| format!("打开失败：{err}"))?;
    Ok(())
}

/// 在 Finder 中定位文件或目录，而不是直接打开它。
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("路径不存在：{path}"));
    }
    let status = std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|err| format!("在 Finder 中定位失败：{err}"))?;
    if !status.success() {
        return Err(format!("在 Finder 中定位失败：{status}"));
    }
    Ok(())
}

/// 调用 macOS Quick Look 生成预览图，原始 PNG 直接回传 WebView。
///
/// 放在阻塞线程里执行：qlmanage 需要启动系统服务，偶尔会明显慢于普通 IPC。
#[tauri::command]
pub async fn quick_look_thumbnail(path: String) -> Result<tauri::ipc::Response, String> {
    let source = std::path::PathBuf::from(path);
    let png = tauri::async_runtime::spawn_blocking(move || {
        deveco_desktop::preview::quicklook_thumbnail(&source, 1400)
    })
    .await
    .map_err(|err| format!("系统预览任务失败：{err}"))?
    .map_err(|err| format!("{err:#}"))?;
    Ok(tauri::ipc::Response::new(png))
}

#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

// ---------------------------------------------------------------------------
// HarmonyOS 设备截图（hdc）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn device_probe() -> Result<device::DeviceProbe, String> {
    device::probe().await
}

#[tauri::command]
pub async fn device_capture(serial: Option<String>) -> Result<device::DeviceShot, String> {
    let dir = device::screenshots_dir()?;
    device::capture(serial.as_deref(), &dir).await
}

#[tauri::command]
pub async fn device_awake_status(
    state: tauri::State<'_, DeviceAwakeState>,
    serial: String,
) -> Result<device::DeviceAwakeStatus, String> {
    let enabled = state.enabled_for(&serial);
    let active = state.active_for(&serial);
    let charging = device::battery_plugged(&serial).await.unwrap_or(active);
    Ok(device::DeviceAwakeStatus {
        enabled,
        charging,
        active,
    })
}

#[tauri::command]
pub async fn device_set_awake(
    state: tauri::State<'_, DeviceAwakeState>,
    serial: String,
    enabled: bool,
) -> Result<device::DeviceAwakeStatus, String> {
    state.set_enabled(&serial, enabled);
    state.ensure_monitor();

    let charging = match device::battery_plugged(&serial).await {
        Ok(charging) => charging,
        Err(err) if enabled => {
            state.set_enabled(&serial, false);
            return Err(err);
        }
        Err(_) => false,
    };

    if enabled {
        if let Err(err) = device::set_keep_on(&serial, charging).await {
            state.set_enabled(&serial, false);
            state.set_active(&serial, false);
            return Err(err);
        }
        state.set_active(&serial, charging);
    } else {
        device::set_keep_on(&serial, false).await?;
        state.set_active(&serial, false);
    }

    Ok(device::DeviceAwakeStatus {
        enabled,
        charging,
        active: state.active_for(&serial),
    })
}

#[tauri::command]
pub fn device_screenshot_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let path = device::validate_screenshot_path(&path)?;
    let bytes = std::fs::read(&path).map_err(|err| format!("读取设备截图失败：{err}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 复制设备截图到系统剪贴板。
///
/// 设备截图保存为 JPEG 以控制体积；剪贴板插件只接受 PNG/ICO 字节，
/// 所以复制时临时转成 PNG，写完立即删除。
#[tauri::command]
pub async fn device_copy_screenshot(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let source = device::validate_screenshot_path(&path)?;
    let temp_dir = tempfile::tempdir().map_err(|err| format!("创建临时目录失败：{err}"))?;
    let png = temp_dir.path().join("device-screenshot.png");
    let mut command = tokio::process::Command::new("sips");
    command
        .args(["-s", "format", "png"])
        .arg(&source)
        .arg("--out")
        .arg(&png)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(8), command.output())
        .await
        .map_err(|_| "转换截图格式超时".to_string())?
        .map_err(|err| format!("调用 sips 失败：{err}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "转换截图格式失败（{}）：{}",
            output.status,
            detail.trim()
        ));
    }
    let image = Image::from_path(&png).map_err(|err| format!("读取 PNG 截图失败：{err}"))?;
    app.clipboard()
        .write_image(&image)
        .map_err(|err| format!("写入剪贴板失败：{err}"))?;
    log::info!("设备截图已复制到剪贴板");
    Ok(())
}

#[tauri::command]
pub async fn device_save_screenshot(
    app: tauri::AppHandle,
    path: String,
    default_name: String,
) -> Result<Option<String>, String> {
    let source = device::validate_screenshot_path(&path)?;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("保存设备截图")
            .set_file_name(default_name)
            .blocking_save_file()
    })
    .await
    .map_err(|err| format!("保存对话框异常：{err}"))?;

    let Some(target) = picked else {
        return Ok(None);
    };
    let target = target
        .into_path()
        .map_err(|err| format!("无法读取保存路径：{err}"))?;
    std::fs::copy(&source, &target).map_err(|err| format!("保存截图失败：{err}"))?;
    log::info!("设备截图已另存为：{}", target.display());
    Ok(Some(target.to_string_lossy().to_string()))
}

/// 窗口标题跟随当前会话，方便 Mission Control / 程序坞里辨认
#[tauri::command]
pub fn set_window_title(app: tauri::AppHandle, title: String) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&title);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn 路径存在性区分存在与缺失() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            super::path_exists_blocking(&dir.path().to_string_lossy()),
            Some(true)
        );
        assert_eq!(
            super::path_exists_blocking(&dir.path().join("missing").to_string_lossy()),
            Some(false)
        );
    }
}
