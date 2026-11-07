//! 前端 ↔ 本机 CLI 的桥。
//!
//! 所有 HTTP 请求都从这里代理，好处有两个：
//! 1. WebView 不直连 `127.0.0.1:<port>`，绕开 CORS 与 ATS；
//! 2. 连接信息（base_url / 口令）只存在于 Rust 侧，前端拿不到也用不着。

use deveco_desktop::http;
use serde_json::{Map, Value};
use std::sync::Mutex;

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

    let result = http::send(
        &base,
        auth.as_deref(),
        &method,
        &path,
        &pairs,
        body.as_ref(),
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
    pub phase: std::sync::Arc<Mutex<serde_json::Value>>,
}

impl Default for BackendCtl {
    fn default() -> Self {
        Self {
            retry: Default::default(),
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
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// 「经典界面」：把官方 Web UI 单独开一个窗口，保留兜底入口。
#[tauri::command]
pub async fn open_classic_view(
    app: tauri::AppHandle,
    conn: tauri::State<'_, ServerConn>,
) -> Result<(), String> {
    let base = conn.base().ok_or("后端尚未就绪")?;
    let url = tauri::Url::parse(&base).map_err(|err| err.to_string())?;
    let label = format!(
        "classic-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(url))
        .title("DevEco Code · 经典界面")
        .inner_size(1280.0, 860.0)
        .build()
        .map_err(|err| err.to_string())?;
    Ok(())
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

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, SettingsState>) -> Result<Value, String> {
    let config = state
        .config
        .lock()
        .map_err(|_| "配置锁中毒")?
        .clone();
    let runtime = state
        .runtime
        .lock()
        .map_err(|_| "运行信息锁中毒")?
        .clone();
    Ok(serde_json::json!({ "config": config, "runtime": runtime }))
}

/// 保存设置。返回 `restartRequired`：CLI 路径、端口、口令这类改动要重启才能生效。
#[tauri::command]
pub fn save_settings(
    state: tauri::State<'_, SettingsState>,
    config: Value,
) -> Result<Value, String> {
    let incoming: Config =
        serde_json::from_value(config).map_err(|err| format!("配置格式不正确：{err}"))?;
    let (previous, path) = {
        let config = state.config.lock().map_err(|_| "配置锁中毒")?;
        (
            config.clone(),
            state.config_path.lock().map_err(|_| "路径锁中毒")?.clone(),
        )
    };

    let restart_required = previous.cli_path != incoming.cli_path
        || previous.server != incoming.server;

    if let Some(path) = &path {
        incoming
            .save(path)
            .map_err(|err| format!("写入配置失败：{err}"))?;
    }
    *state.config.lock().map_err(|_| "配置锁中毒")? = incoming.clone();
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

#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// 窗口标题跟随当前会话，方便 Mission Control / 程序坞里辨认
#[tauri::command]
pub fn set_window_title(app: tauri::AppHandle, title: String) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&title);
    }
}

/// 导出当前会话为 JSON（调用 `deveco export <id>`），写盘后在 Finder 里定位。
#[tauri::command]
pub async fn export_session(
    state: tauri::State<'_, SettingsState>,
    directory: String,
    session_id: String,
) -> Result<String, String> {
    use std::process::Stdio;

    let cli_path = state
        .runtime
        .lock()
        .map_err(|_| "运行信息锁中毒")?
        .cli_path
        .clone();
    let bin = match cli_path {
        Some(path) => std::path::PathBuf::from(path),
        None => cli::discover(None).map_err(|err| err.to_string())?.path,
    };

    let output = tokio::process::Command::new(&bin)
        .arg("export")
        .arg(&session_id)
        .current_dir(&directory)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|err| format!("调用 deveco export 失败：{err}"))?;

    if !output.status.success() {
        let detail: String = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(300)
            .collect();
        return Err(format!("导出失败（{}）：{detail}", output.status));
    }

    let body = String::from_utf8_lossy(&output.stdout).to_string();
    if body.trim().is_empty() {
        return Err("导出结果为空".to_string());
    }

    let dir = data_dir()
        .map(|base| base.join("exports"))
        .ok_or("拿不到数据目录")?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建目录失败：{err}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file = dir.join(format!("{session_id}-{stamp}.json"));
    std::fs::write(&file, body.as_bytes()).map_err(|err| format!("写文件失败：{err}"))?;

    // 在 Finder 中定位到导出的文件
    let _ = std::process::Command::new("open")
        .arg("-R")
        .arg(&file)
        .status();

    log::info!("会话已导出：{}", file.display());
    Ok(file.to_string_lossy().to_string())
}
