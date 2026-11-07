//! 桌面主进程：拉起 CLI、加载官方 Web UI、把 Agent 事件转成系统通知。
//!
//! 设计要点：**不重写 UI**。官方 `deveco serve` 的 `/` 已经是完整的 DevEco Code
//! Web 应用，这里只做进程生命周期、托盘、单实例与通知。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use deveco_desktop::{
    config::Config,
    events::{classify, render, Notice},
    notify::{should_notify, Debouncer, DEBOUNCE_WINDOW},
    server,
    sse::{self, SseEvent},
    supervise::{self, Phase, Supervisor},
};
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

mod ipc;
mod windrag;

#[derive(Clone, Serialize)]
struct StatusPayload {
    message: String,
    detail: Option<String>,
    error: bool,
}

fn main() {
    init_logging();
    install_signal_handlers();
    log::info!(
        "启动环境：DEVECO_DESKTOP_DIR={:?}",
        std::env::var("DEVECO_DESKTOP_DIR").ok()
    );

    let app = tauri::Builder::default()
        .manage(ServerGroup::default())
        .manage(ipc::ServerConn::default())
        .manage(ipc::SettingsState::default())
        .manage(ipc::BackendCtl::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_notification::init())
        // 记住窗口大小/位置，下次启动恢复
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            ipc::server_request,
            ipc::startup_directory,
            ipc::path_exists,
            ipc::pick_workspace_folder,
            ipc::get_settings,
            ipc::save_settings,
            ipc::probe_cli,
            ipc::open_path,
            ipc::reveal_path,
            ipc::quick_look_thumbnail,
            ipc::restart_app,
            ipc::export_session,
            ipc::set_window_title,
            ipc::backend_state,
            ipc::retry_backend,
            windrag::window_outer_position,
            windrag::move_window_by_pointer
        ])
        .setup(|app| {
            build_menu(app.handle())?;
            build_tray(app.handle())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { run_backend(handle).await });
            Ok(())
        })
        .on_menu_event(|app, event| {
            // 菜单动作交给前端执行（前端才掌握会话状态）
            let _ = app.emit("deveco://menu", event.id().0.clone());
        })
        .on_window_event(|window, event| {
            // 关窗不退进程：托盘常驻，避免每次唤起都重启 161MB 的服务
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri 构建失败");

    app.run(|handle, event| {
        // 应用退出（含 Cmd+Q / AppleScript quit）时兜底回收 serve 进程组，
        // 这类退出路径不会走到 Rust 的 Drop。
        if let tauri::RunEvent::Exit = event {
            SHUTTING_DOWN.store(true, std::sync::atomic::Ordering::SeqCst);
            shutdown_server(handle);
        }
    });
}

/// 后端主循环：自愈 + 事件流。
///
/// 状态机：Starting →（ensure）Ready →（流断开）Reconnecting →（健康检查失败）
/// Recovering →（重建成功）Ready /（失败）Failed →（退避或用户重试）Recovering …
///
/// 关键点：`Supervisor` 一直持有后端，重建时先停旧进程再拉起新进程；
/// 连接信息（base_url / auth）重建后重新写回 IPC 状态，前端无需感知端口变化。
/// 退出闸门：RunEvent::Exit 时置位，监管循环看到后立刻停手。
///
/// 没有这个闸门，退出流程杀掉 serve 后，监管循环会把「事件流中断」当成崩溃，
/// 在进程退出前又拉起一个新的 serve——留下孤儿进程并占住 CLI 的数据锁。
static SHUTTING_DOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn shutting_down() -> bool {
    SHUTTING_DOWN.load(std::sync::atomic::Ordering::SeqCst)
}

async fn run_backend(app: AppHandle) {
    let config_path = Config::default_path();
    let loaded = match &config_path {
        Some(path) => Config::load(path),
        None => Config::default(),
    };
    let ctl = app.state::<ipc::BackendCtl>().clone();
    let mut supervisor = Supervisor::new(loaded.clone());
    let mut attempt: u32 = 0;
    let mut ready_once = false;

    publish_phase(&app, Phase::Starting);

    loop {
        if shutting_down() {
            log::info!("应用正在退出，停止后端监管");
            supervisor.shutdown().await;
            return;
        }
        if let Err(reason) = supervisor.ensure().await {
            attempt = attempt.saturating_add(1);
            publish_phase(&app, Phase::Failed { reason, attempt });
            let wait = supervise::backoff(attempt);
            log::warn!("{}s 后重试重建后端（第 {attempt} 次）", wait.as_secs());
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = ctl.retry.notified() => log::info!("用户要求立即重试后端"),
            }
            continue;
        }

        apply_backend(&app, &supervisor, &loaded, config_path.as_ref(), &mut ready_once);

        let Some(url) = supervisor.global_event_url() else {
            attempt = attempt.saturating_add(1);
            publish_phase(
                &app,
                Phase::Failed {
                    reason: "后端未提供事件流地址".into(),
                    attempt,
                },
            );
            continue;
        };
        let auth = supervisor.auth();
        let project = supervisor.project_label();
        let base = supervisor.base_url().unwrap_or_default().to_string();

        stream_until_down(
            &app,
            &url,
            auth.as_deref(),
            &project,
            &base,
            &mut supervisor,
            &ctl,
        )
        .await;

        if shutting_down() {
            log::info!("应用正在退出，跳过重建");
            supervisor.shutdown().await;
            return;
        }
        // 走到这里说明事件流断开且健康检查失败：交给下一轮 ensure 重建
        log::warn!("后端不可用，进入重建流程");
        publish_phase(&app, Phase::Recovering { attempt: 1 });
        attempt = 1;
    }
}

/// 后端就绪后同步连接信息、运行信息，并广播 `ready`。
fn apply_backend(
    app: &AppHandle,
    supervisor: &Supervisor,
    loaded: &Config,
    config_path: Option<&std::path::PathBuf>,
    ready_once: &mut bool,
) {
    let Some(backend) = supervisor.backend() else {
        return;
    };

    if let Some(pgid) = backend.server.pgid() {
        app.state::<ServerGroup>().set(Some(pgid));
        SERVER_PGID.store(pgid, std::sync::atomic::Ordering::SeqCst);
    }

    // 前端所有请求走 IPC 代理：重建后把新的 base_url 写回去即可继续工作
    app.state::<ipc::ServerConn>()
        .set(backend.server.base_url.clone(), backend.auth.clone());

    {
        let settings = app.state::<ipc::SettingsState>().clone();
        if let Ok(mut runtime) = settings.runtime.lock() {
            runtime.app_version = env!("CARGO_PKG_VERSION").to_string();
            runtime.base_url = Some(backend.server.base_url.clone());
            runtime.cli_path = Some(backend.cli.path.to_string_lossy().to_string());
            runtime.cli_version = backend.cli.version.map(|version| version.to_string());
            runtime.config_path = config_path.map(|path| path.to_string_lossy().to_string());
            runtime.log_dir = ipc::logs_dir().map(|path| path.to_string_lossy().to_string());
            runtime.data_dir = ipc::data_dir().map(|path| path.to_string_lossy().to_string());
        }
        // 先把 Arc 与 guard 绑定成变量：if let 里的临时借用活不过 settings 的作用域
        let config_handle = settings.config.clone();
        let config_guard = config_handle.lock();
        if let Ok(mut current) = config_guard {
            // 用磁盘上加载的配置覆盖初始默认值：否则设置页读到的是默认值，
            // 首次保存还会把用户自己的配置（CLI 路径、通知开关）冲掉。
            *current = loaded.clone();
            if let Some(path) = config_path {
                if let Err(err) = current.save(path) {
                    log::warn!("保存配置失败：{err}");
                }
            }
        }
    }

    publish_phase(app, Phase::Ready);
    emit_status(app, "就绪".to_string(), None, false);

    if !*ready_once {
        *ready_once = true;
        log::info!(
            "后端就绪：{} · CLI {}",
            backend.server.base_url,
            backend.cli.path.display()
        );
        // 排查用：启动后立刻投递一条系统通知，验证通知权限与通道
        if std::env::var_os("DEVECO_DESKTOP_NOTIFY_TEST").is_some() {
            send_test_notification(app);
        }
    }
}

fn publish_phase(app: &AppHandle, phase: Phase) {
    let payload = phase.payload();
    if let Some(ctl) = app.try_state::<ipc::BackendCtl>() {
        ctl.set_phase(payload.clone());
    }
    if let Err(err) = app.emit("deveco://backend", payload) {
        log::warn!("广播后端状态失败：{err}");
    }
}

/// 订阅事件流，直到确认后端已不可用（能自愈的断线在这里退避重连，不回到外层）。
async fn stream_until_down(
    app: &AppHandle,
    url: &str,
    auth: Option<&str>,
    project: &str,
    base: &str,
    supervisor: &mut Supervisor,
    ctl: &ipc::BackendCtl,
) {
    let mut debouncer = Debouncer::new(DEBOUNCE_WINDOW);
    let mut attempts: u32 = 0;

    loop {
        let started = Instant::now();
        let inner_app = app.clone();
        let inner_project = project.to_string();
        let result = sse::stream_once(url, auth, |event| {
            handle_event(&inner_app, &inner_project, &mut debouncer, &event);
        })
        .await;

        // 连接活得够久说明刚才只是短暂抖动，重新计数，避免退避越拖越长
        if started.elapsed() > Duration::from_secs(30) {
            attempts = 0;
        }
        attempts = attempts.saturating_add(1);
        match result {
            Ok(()) => log::warn!("事件流已关闭（第 {attempts} 次），准备重连"),
            Err(err) => log::warn!("事件流中断（第 {attempts} 次）：{err}"),
        }

        publish_phase(app, Phase::Reconnecting { attempts });
        let _ = app.emit("deveco://reconnecting", attempts);

        // 先判断进程是否还活着。macOS 文件夹授权弹窗未处理时，serve 会阻塞在
        // 文件访问上，健康检查也会失败；此时杀进程会打断授权并导致弹窗反复出现。
        // 只有确认进程已经退出时才交给监管者重建。
        if supervisor.liveness() == server::Liveness::Exited {
            log::warn!("serve 进程已退出，交给监管者重建：{base}");
            return;
        }
        if !server::health(base, auth).await {
            match supervisor.liveness() {
                server::Liveness::Exited => {
                    log::warn!("健康检查未通过且 serve 已退出，交给监管者重建：{base}");
                    return;
                }
                server::Liveness::Running => {
                    log::warn!(
                        "健康检查未通过，但 serve 进程仍在运行；保持进程并继续重连（可能正在等待系统授权）：{base}"
                    );
                }
                server::Liveness::Unowned => {
                    log::warn!("复用实例健康检查未通过，交给监管者重新接管：{base}");
                    return;
                }
            }
        }
        // 用户点「重启服务」时不再等下一轮退避：回到外层由 Supervisor 回收重建。
        tokio::select! {
            _ = tokio::time::sleep(supervise::backoff(attempts)) => {}
            _ = ctl.retry.notified() => {
                log::info!("用户要求立即重启后端，结束当前重连循环");
                return;
            }
        }
    }
}

fn handle_event(app: &AppHandle, project: &str, debouncer: &mut Debouncer, event: &SseEvent) {
    // 每次事件读一遍配置：设置页改通知开关后立即生效，无需重启
    let policy = app
        .state::<ipc::SettingsState>()
        .config
        .lock()
        .map(|config| config.notifications.clone())
        .unwrap_or_default();
    // 全局事件流把每个事件包在 { directory, project, payload } 里，
    // 前端与通知逻辑只关心 payload；directory 用来给通知补项目名。
    let (directory, payload) = deveco_desktop::events::unwrap_global(&event.data);

    static FORWARDED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = FORWARDED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    match app.emit("deveco://sse", payload.clone()) {
        Ok(()) => {
            if seq % 50 == 0 {
                log::info!("SSE 转发 #{seq}");
            }
        }
        Err(err) => log::warn!("SSE 转发失败：{err}"),
    }

    let scoped = SseEvent {
        event: event.event.clone(),
        id: event.id.clone(),
        data: payload,
    };
    let notice = classify(&scoped);
    match notice {
        Notice::Ignored => return,
        Notice::Connected => {
            log::info!("事件流已连接");
            let _ = app.emit("deveco://connected", true);
            // 断线重连成功后必须把状态从 reconnecting 拉回 ready：
            // 否则界面会一直停在「正在重连」的提示条上。
            publish_phase(app, Phase::Ready);
            return;
        }
        _ => {}
    }

    let focused = app
        .get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    if !should_notify(&policy, &notice, focused) {
        return;
    }
    let Some(key) = Debouncer::key(&notice) else {
        return;
    };
    if !debouncer.allow(&key, Instant::now()) {
        return;
    }
    // 优先用事件自带的目录名，通知里显示真实的项目
    let label = directory
        .as_deref()
        .and_then(|dir| std::path::Path::new(dir).file_name())
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| project.to_string());
    let Some(text) = render(&notice, &label) else {
        return;
    };

    match app
        .notification()
        .builder()
        .title(&text.title)
        .body(&text.body)
        .show()
    {
        Ok(()) => log::info!("已发送通知：{}", text.title),
        Err(err) => log::warn!("通知发送失败：{err}"),
    }
}

fn emit_status(app: &AppHandle, message: String, detail: Option<String>, error: bool) {
    let _ = app.emit(
        "deveco://status",
        StatusPayload {
            message,
            detail,
            error,
        },
    );
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 DevEco Code", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("DevEco Code")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => focus_main(app),
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 日志同时写入 `~/Library/Logs/DevEco Code Desktop/app.log`。
/// GUI 从 Finder 启动时看不到 stderr，出问题只能靠这个文件定位。
fn init_logging() {
    let mut builder =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
    if let Some(dir) = log_dir() {
        if std::fs::create_dir_all(&dir).is_ok() {
            let path = dir.join("app.log");
            if let Ok(file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                builder.target(env_logger::Target::Pipe(Box::new(SharedWriter::new(file))));
            }
        }
    }
    builder.init();
}

fn log_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|home| home.join("Library/Logs/DevEco Code Desktop"))
}

/// 多个线程共享同一个日志文件句柄
struct SharedWriter(std::sync::Arc<std::sync::Mutex<std::fs::File>>);

impl SharedWriter {
    fn new(file: std::fs::File) -> Self {
        Self(std::sync::Arc::new(std::sync::Mutex::new(file)))
    }
}

impl std::io::Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self.0.lock() {
            Ok(mut file) => file.write(buf),
            Err(_) => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self.0.lock() {
            Ok(mut file) => file.flush(),
            Err(_) => Ok(()),
        }
    }
}

fn send_test_notification(app: &AppHandle) {
    match app
        .notification()
        .builder()
        .title("DevEco Code Desktop")
        .body("通知通道自检：桌面端已就绪")
        .show()
    {
        Ok(()) => log::info!("通知通道自检：已投递"),
        Err(err) => log::warn!("通知通道自检失败：{err}"),
    }
}

/// 记录 serve 子进程的进程组 id，供退出时兜底回收。
#[derive(Clone, Default)]
struct ServerGroup(std::sync::Arc<std::sync::atomic::AtomicI32>);

impl ServerGroup {
    fn set(&self, pgid: Option<i32>) {
        if let Some(pid) = pgid {
            self.0.store(pid, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn take(&self) -> Option<i32> {
        let pid = self.0.swap(0, std::sync::atomic::Ordering::SeqCst);
        (pid > 0).then_some(pid)
    }
}

fn shutdown_server(app: &AppHandle) {
    let group = app.state::<ServerGroup>();
    let Some(pgid) = group.take() else {
        // 启动阶段（健康检查中）还没有发布 pgid，用 lib 侧登记的兜底
        server::kill_active_group();
        return;
    };
    // 给监管循环一个调度窗口，避免它在回收之后又拉起新实例
    std::thread::sleep(Duration::from_millis(50));
    log::info!("退出：回收 serve 进程组 {pgid}");
    unsafe {
        libc::kill(-pgid, libc::SIGTERM);
    }
    std::thread::sleep(Duration::from_millis(600));
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
}

/// serve 子进程组 id，供信号处理函数读取。
static SERVER_PGID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// 被 kill / 系统注销时也要带走 serve：这条路径不走 Rust 的 Drop 与 RunEvent。
extern "C" fn handle_termination(_signal: libc::c_int) {
    let pgid = SERVER_PGID.load(std::sync::atomic::Ordering::SeqCst);
    if pgid > 0 {
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
    // 启动窗口期（pgid 尚未发布）也要带走 serve，否则会留下孤儿占端口
    server::kill_active_group();
    unsafe { libc::_exit(0) };
}

fn install_signal_handlers() {
    unsafe {
        libc::signal(
            libc::SIGTERM,
            handle_termination as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGINT,
            handle_termination as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGHUP,
            handle_termination as *const () as libc::sighandler_t,
        );
    }
}


/// 原生菜单：把常用动作挂到 macOS 菜单栏与快捷键上
fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

    let app_menu = SubmenuBuilder::new(app, "DevEco Code")
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("settings", "设置…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "文件")
        .item(
            &MenuItemBuilder::with_id("new_session", "新建会话")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("export_session", "导出当前会话…")
                .accelerator("CmdOrCtrl+E")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "视图")
        .item(
            &MenuItemBuilder::with_id("toggle_right", "切换右侧面板")
                .accelerator("CmdOrCtrl+Shift+B")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("shortcuts", "快捷键")
                .accelerator("CmdOrCtrl+/")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open_logs", "打开日志目录")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("reload_ui", "重新加载界面").accelerator("CmdOrCtrl+R").build(app)?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "窗口")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}
