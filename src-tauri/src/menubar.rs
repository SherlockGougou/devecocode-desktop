//! macOS 菜单栏状态项。
//!
//! 托盘图标不只是「显示 / 退出」的入口：它同时承担轻量状态面板的职责。
//! 这里用 template 单色图标适配浅色 / 深色菜单栏，并展示后端、当前会话和
//! 等待授权数量。所有纯展示逻辑与图标生成都在本模块内，便于单测。

use crate::ipc::{self, BackendCtl, SettingsState};
use deveco_desktop::config::{Config, MenuBarCfg, MenuBarIconStyle};
use deveco_desktop::supervise::Phase;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_clipboard_manager::ClipboardExt;

const TRAY_ID: &str = "main";
const ICON_SIZE: u32 = 72;
const SUPERSAMPLE: u32 = 3;
const DIAGNOSTICS_LABEL: &str = "复制诊断信息";

/// 前端同步的当前上下文。只放展示需要的字段，不把消息正文带进原生层。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TrayContext {
    pub project: Option<String>,
    pub session_title: Option<String>,
    pub streaming: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayStatus {
    Idle,
    Working,
    Attention,
    Connecting,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TrayPreferences {
    icon_style: MenuBarIconStyle,
    always_visible: bool,
}

impl From<MenuBarCfg> for TrayPreferences {
    fn from(cfg: MenuBarCfg) -> Self {
        Self {
            icon_style: cfg.icon_style,
            always_visible: cfg.always_visible,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TrayView {
    status: TrayStatus,
    preferences: TrayPreferences,
    header: String,
    context: String,
    service: String,
    title: Option<String>,
    tooltip: String,
}

struct TrayInner {
    tray: TrayIcon<Wry>,
    always_on_top: CheckMenuItem<Wry>,
    mono_icon: CheckMenuItem<Wry>,
    color_icon: CheckMenuItem<Wry>,
    always_visible: CheckMenuItem<Wry>,
    diagnostics: MenuItem<Wry>,
    phase: Phase,
    context: TrayContext,
    preferences: TrayPreferences,
    pending_permissions: HashMap<String, String>,
    applied: TrayView,
}

/// Tauri managed state：菜单项句柄与最近一次展示状态。
pub struct TrayState {
    inner: Mutex<TrayInner>,
}

/// 创建菜单栏项。启动阶段只依赖默认状态，随后由后端阶段与前端上下文刷新。
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::MenuId;

    let saved = Config::default_path()
        .map(|path| Config::load(&path))
        .unwrap_or_default();
    let preferences = TrayPreferences::from(saved.menu_bar);

    let show = MenuItem::with_id(
        app,
        MenuId::new("tray_show"),
        "显示主窗口",
        true,
        None::<&str>,
    )?;
    let hide = MenuItem::with_id(
        app,
        MenuId::new("tray_hide"),
        "隐藏到菜单栏",
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(
        app,
        MenuId::new("tray_settings"),
        "设置…",
        true,
        None::<&str>,
    )?;
    let always_on_top = CheckMenuItem::with_id(
        app,
        MenuId::new("tray_always_on_top"),
        "主窗口置顶",
        true,
        false,
        None::<&str>,
    )?;
    let mono_icon = CheckMenuItem::with_id(
        app,
        MenuId::new("tray_icon_mono"),
        "单色（自动适配外观）",
        true,
        preferences.icon_style == MenuBarIconStyle::Monochrome,
        None::<&str>,
    )?;
    let color_icon = CheckMenuItem::with_id(
        app,
        MenuId::new("tray_icon_color"),
        "彩色",
        true,
        preferences.icon_style == MenuBarIconStyle::Color,
        None::<&str>,
    )?;
    let always_visible = CheckMenuItem::with_id(
        app,
        MenuId::new("tray_always_visible"),
        "常驻菜单栏",
        true,
        preferences.always_visible,
        None::<&str>,
    )?;
    let logs = MenuItem::with_id(
        app,
        MenuId::new("tray_logs"),
        "打开日志目录",
        true,
        None::<&str>,
    )?;
    let diagnostics = MenuItem::with_id(
        app,
        MenuId::new("tray_diagnostics"),
        DIAGNOSTICS_LABEL,
        true,
        None::<&str>,
    )?;
    let restart = MenuItem::with_id(
        app,
        MenuId::new("tray_restart"),
        "重启本地服务",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        MenuId::new("tray_quit"),
        "退出 DevEco Code",
        true,
        None::<&str>,
    )?;
    let separator_a = PredefinedMenuItem::separator(app)?;
    let separator_c = PredefinedMenuItem::separator(app)?;
    let separator_style = PredefinedMenuItem::separator(app)?;
    let icon_menu = Submenu::with_items(
        app,
        "菜单栏图标",
        true,
        &[&mono_icon, &color_icon, &separator_style, &always_visible],
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &hide,
            &settings,
            &separator_a,
            &always_on_top,
            &icon_menu,
            &logs,
            &diagnostics,
            &separator_c,
            &restart,
            &quit,
        ],
    )?;

    let view = view_for(&Phase::Starting, &TrayContext::default(), 0, preferences);
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(&view.tooltip)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .icon(icon_image(view.status, view.preferences.icon_style))
        .icon_as_template(view.preferences.icon_style == MenuBarIconStyle::Monochrome)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .build(app)?;

    app.manage(TrayState {
        inner: Mutex::new(TrayInner {
            tray,
            always_on_top,
            mono_icon,
            color_icon,
            always_visible,
            diagnostics,
            phase: Phase::Starting,
            context: TrayContext::default(),
            preferences,
            pending_permissions: HashMap::new(),
            applied: view,
        }),
    });
    sync_tray_visibility(app);
    Ok(())
}

/// 后端状态变化由 Rust 直接刷新，不依赖前端是否已挂载。
pub fn set_phase(app: &AppHandle, phase: Phase) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let should_clear = matches!(
        phase,
        Phase::Starting | Phase::Recovering { .. } | Phase::Failed { .. }
    );
    state.update(|inner| {
        inner.phase = phase;
        if should_clear {
            inner.pending_permissions.clear();
        }
    });
}

/// 前端只同步「当前正在看什么、是否在生成」，不传消息正文。
#[tauri::command]
pub fn sync_tray_context(state: tauri::State<'_, TrayState>, context: TrayContext) {
    state.set_context(context);
}

/// 权限事件来自全局 SSE：这里维护跨工作区的待处理数量。
pub fn observe_notice(app: &AppHandle, notice: &deveco_desktop::events::Notice) {
    use deveco_desktop::events::Notice;

    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    match notice {
        Notice::Permission {
            request_id,
            session_id,
            ..
        } => state.set_permission(request_id, session_id, true),
        Notice::PermissionResolved {
            request_id,
            session_id,
            ..
        } => state.resolve_permission(request_id, session_id),
        Notice::Idle { session_id } | Notice::Error { session_id, .. } => {
            state.clear_session_permissions(session_id)
        }
        _ => {}
    }
}

impl TrayState {
    fn set_context(&self, context: TrayContext) {
        let context = TrayContext {
            project: clean_optional(context.project),
            session_title: clean_optional(context.session_title),
            streaming: context.streaming,
        };
        self.update(|inner| inner.context = context);
    }

    fn set_permission(&self, request_id: &str, session_id: &str, pending: bool) {
        if request_id.trim().is_empty() {
            return;
        }
        let request_id = request_id.to_string();
        let session_id = session_id.to_string();
        self.update(|inner| {
            if pending {
                inner.pending_permissions.insert(request_id, session_id);
            } else {
                inner.pending_permissions.remove(&request_id);
            }
        });
    }

    fn resolve_permission(&self, request_id: &str, session_id: &str) {
        self.update(|inner| {
            if request_id.trim().is_empty() {
                inner
                    .pending_permissions
                    .retain(|_, owner| owner != session_id);
            } else {
                inner.pending_permissions.remove(request_id);
            }
        });
    }

    fn clear_session_permissions(&self, session_id: &str) {
        if session_id.trim().is_empty() {
            return;
        }
        self.update(|inner| {
            inner
                .pending_permissions
                .retain(|_, owner| owner != session_id);
        });
    }

    fn set_always_on_top(&self, value: bool) {
        let handle = self
            .inner
            .lock()
            .map(|inner| inner.always_on_top.clone())
            .ok();
        if let Some(item) = handle {
            if let Err(err) = item.set_checked(value) {
                log::warn!("更新菜单栏置顶勾选失败：{err}");
            }
        }
    }

    fn set_preferences(&self, preferences: TrayPreferences) {
        let handles = {
            let Ok(mut inner) = self.inner.lock() else {
                log::warn!("菜单栏状态锁中毒");
                return;
            };
            inner.preferences = preferences;
            (
                inner.mono_icon.clone(),
                inner.color_icon.clone(),
                inner.always_visible.clone(),
            )
        };
        let mono = preferences.icon_style == MenuBarIconStyle::Monochrome;
        if let Err(err) = handles.0.set_checked(mono) {
            log::warn!("更新单色图标勾选失败：{err}");
        }
        if let Err(err) = handles.1.set_checked(!mono) {
            log::warn!("更新彩色图标勾选失败：{err}");
        }
        if let Err(err) = handles.2.set_checked(preferences.always_visible) {
            log::warn!("更新常驻显示勾选失败：{err}");
        }
        self.update(|_| {});
    }

    fn tray_and_preferences(&self) -> Option<(TrayIcon<Wry>, TrayPreferences)> {
        let inner = self.inner.lock().ok()?;
        Some((inner.tray.clone(), inner.preferences))
    }

    fn diagnostics_snapshot(&self) -> Option<(String, String, String)> {
        let inner = self.inner.lock().ok()?;
        Some((
            inner.applied.header.clone(),
            inner.applied.context.clone(),
            inner.applied.tooltip.clone(),
        ))
    }

    fn flash_diagnostics_copied(&self) {
        let item = self
            .inner
            .lock()
            .ok()
            .map(|inner| inner.diagnostics.clone());
        let Some(item) = item else {
            return;
        };
        if let Err(err) = item.set_text("诊断信息已复制") {
            log::warn!("更新菜单栏诊断项失败：{err}");
            return;
        }
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1400)).await;
            if let Err(err) = item.set_text(DIAGNOSTICS_LABEL) {
                log::warn!("恢复菜单栏诊断项失败：{err}");
            }
        });
    }

    fn update(&self, mutate: impl FnOnce(&mut TrayInner)) {
        let handles = {
            let Ok(mut inner) = self.inner.lock() else {
                log::warn!("菜单栏状态锁中毒");
                return;
            };
            mutate(&mut inner);
            let view = view_for(
                &inner.phase,
                &inner.context,
                inner.pending_permissions.len(),
                inner.preferences,
            );
            if view == inner.applied {
                return;
            }
            inner.applied = view.clone();
            (inner.tray.clone(), view)
        };

        let (tray, view) = handles;
        let is_template = view.preferences.icon_style == MenuBarIconStyle::Monochrome;
        if let Err(err) = tray.set_icon_with_as_template(
            Some(icon_image(view.status, view.preferences.icon_style)),
            is_template,
        ) {
            log::warn!("更新菜单栏图标失败：{err}");
        }
        if let Err(err) = tray.set_title(view.title.as_deref()) {
            log::warn!("更新菜单栏标题失败：{err}");
        }
        if let Err(err) = tray.set_tooltip(Some(view.tooltip.as_str())) {
            log::warn!("更新菜单栏提示失败：{err}");
        }
    }
}

/// 设置页保存后立即刷新菜单栏；配置本身的持久化由 `save_settings` 完成。
pub fn apply_preferences(app: &AppHandle, cfg: MenuBarCfg) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.set_preferences(TrayPreferences::from(cfg));
    }
    sync_tray_visibility(app);
}

/// 常驻模式始终显示；非常驻模式只在主窗口不可见时保留入口。
pub fn sync_tray_visibility(app: &AppHandle) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let Some((tray, preferences)) = state.tray_and_preferences() else {
        return;
    };
    let window_visible = app
        .get_webview_window("main")
        .map(|window| {
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
        })
        .unwrap_or(false);
    let visible = tray_should_be_visible(preferences, window_visible);
    if let Err(err) = tray.set_visible(visible) {
        log::warn!("更新菜单栏显示状态失败：{err}");
    }
}

/// 窗口 hide/show 是异步投递到主线程的，延后一拍再判断真实可见性。
pub fn sync_tray_visibility_soon(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        sync_tray_visibility(&app);
    });
}

fn tray_should_be_visible(preferences: TrayPreferences, window_visible: bool) -> bool {
    preferences.always_visible || !window_visible
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "tray_show" => crate::focus_main(app),
        "tray_hide" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
            sync_tray_visibility_soon(app);
        }
        "tray_settings" => {
            crate::focus_main(app);
            emit_menu_action(app, "settings");
        }
        "tray_restart" => {
            app.state::<BackendCtl>().request_restart();
            log::info!("菜单栏请求重启本地服务");
        }
        "tray_always_on_top" => toggle_always_on_top(app),
        "tray_icon_mono" => set_icon_style(app, MenuBarIconStyle::Monochrome),
        "tray_icon_color" => set_icon_style(app, MenuBarIconStyle::Color),
        "tray_always_visible" => toggle_always_visible(app),
        "tray_logs" => open_logs_dir(),
        "tray_diagnostics" => copy_diagnostics(app),
        "tray_quit" => app.exit(0),
        _ => {}
    }
}

fn set_icon_style(app: &AppHandle, icon_style: MenuBarIconStyle) {
    update_saved_preferences(app, |cfg| cfg.icon_style = icon_style);
}

fn toggle_always_visible(app: &AppHandle) {
    update_saved_preferences(app, |cfg| cfg.always_visible = !cfg.always_visible);
}

fn update_saved_preferences(app: &AppHandle, mutate: impl FnOnce(&mut MenuBarCfg)) {
    let state = app.state::<SettingsState>();
    let (live_config, path) = {
        let Ok(config) = state.config.lock() else {
            log::warn!("配置锁中毒，菜单栏偏好未保存");
            return;
        };
        let path = state.config_path.lock().ok().and_then(|path| path.clone());
        (config.clone(), path)
    };
    // 后端尚未就绪时 SettingsState 还是默认值，此时必须从磁盘合并，
    // 否则在启动阶段切换菜单栏偏好会把用户的 CLI 路径等配置覆盖掉。
    let loaded = state
        .runtime
        .lock()
        .map(|runtime| runtime.base_url.is_some())
        .unwrap_or(false);
    let mut config = if loaded {
        live_config
    } else {
        path.as_deref().map(Config::load).unwrap_or(live_config)
    };
    mutate(&mut config.menu_bar);
    if let Some(path) = &path {
        if let Err(err) = config.save(path) {
            log::warn!("保存菜单栏偏好失败：{err}");
        }
    }
    if let Ok(mut current) = state.config.lock() {
        *current = config.clone();
    }
    apply_preferences(app, config.menu_bar);
}

fn emit_menu_action(app: &AppHandle, action: &str) {
    if let Err(err) = app.emit("deveco://menu", action.to_string()) {
        log::warn!("发送菜单栏动作失败：{err}");
    }
}

fn toggle_always_on_top(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let next = window
        .is_always_on_top()
        .map(|current| !current)
        .unwrap_or(true);
    if let Err(err) = window.set_always_on_top(next) {
        log::warn!("切换主窗口置顶失败：{err}");
        return;
    }
    if let Some(state) = app.try_state::<TrayState>() {
        state.set_always_on_top(next);
    }
}

fn open_logs_dir() {
    let Some(dir) = ipc::logs_dir() else {
        log::warn!("无法定位日志目录");
        return;
    };
    if let Err(err) = std::fs::create_dir_all(&dir) {
        log::warn!("创建日志目录失败：{err}");
        return;
    }
    match std::process::Command::new("open").arg(&dir).spawn() {
        Ok(_) => log::info!("已打开日志目录：{}", dir.display()),
        Err(err) => log::warn!("打开日志目录失败：{err}"),
    }
}

fn copy_diagnostics(app: &AppHandle) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let Some((header, context, tooltip)) = state.diagnostics_snapshot() else {
        return;
    };
    let runtime = app
        .state::<SettingsState>()
        .runtime
        .lock()
        .map(|runtime| runtime.clone())
        .unwrap_or_default();
    let text = format!(
        "DevEco Code Desktop {}\n{}\n{}\n服务地址：{}\nCLI：{}\nCLI 版本：{}\n配置：{}\n日志：{}\n\n{}",
        runtime.app_version,
        header,
        context,
        runtime.base_url.unwrap_or_else(|| "—".into()),
        runtime.cli_path.unwrap_or_else(|| "—".into()),
        runtime.cli_version.unwrap_or_else(|| "—".into()),
        runtime.config_path.unwrap_or_else(|| "—".into()),
        runtime.log_dir.unwrap_or_else(|| "—".into()),
        tooltip,
    );
    match app.clipboard().write_text(text) {
        Ok(()) => {
            log::info!("菜单栏已复制诊断信息");
            state.flash_diagnostics_copied();
        }
        Err(err) => log::warn!("复制诊断信息失败：{err}"),
    }
}

fn view_for(
    phase: &Phase,
    context: &TrayContext,
    pending: usize,
    preferences: TrayPreferences,
) -> TrayView {
    let service = service_label(phase);
    let status = match phase {
        Phase::Failed { .. } => TrayStatus::Error,
        _ if pending > 0 => TrayStatus::Attention,
        Phase::Starting | Phase::Reconnecting { .. } | Phase::Recovering { .. } => {
            TrayStatus::Connecting
        }
        Phase::Ready if context.streaming => TrayStatus::Working,
        Phase::Ready => TrayStatus::Idle,
    };
    let status_label = match status {
        TrayStatus::Idle => "就绪".to_string(),
        TrayStatus::Working => "正在生成".to_string(),
        TrayStatus::Attention => format!("等待授权 · {pending}"),
        TrayStatus::Connecting => service.clone(),
        TrayStatus::Error => "本地服务不可用".to_string(),
    };
    let context_line = match (context.session_title.as_deref(), context.project.as_deref()) {
        (Some(title), Some(project)) => {
            format!("{} · {}", compact(title, 42), compact(project, 18))
        }
        (Some(title), None) => compact(title, 58),
        (None, Some(project)) => format!("工作区 · {}", compact(project, 46)),
        (None, None) => "尚未打开会话".to_string(),
    };
    let title = match status {
        TrayStatus::Attention => Some(if pending > 99 {
            "99+".to_string()
        } else {
            pending.to_string()
        }),
        TrayStatus::Error => Some("!".to_string()),
        _ => None,
    };

    let mut tooltip = vec![format!("DevEco Code · {status_label}")];
    if let Some(project) = context.project.as_deref() {
        tooltip.push(format!("工作区：{}", compact(project, 80)));
    }
    if let Some(title) = context.session_title.as_deref() {
        tooltip.push(format!("会话：{}", compact(title, 80)));
    }
    tooltip.push(format!("本地服务：{service}"));
    if let Some(detail) = phase.reason() {
        tooltip.push(compact(detail, 140));
    }
    if pending > 0 {
        tooltip.push(format!("{pending} 个授权请求等待处理"));
    }

    TrayView {
        status,
        preferences,
        header: format!("DevEco Code · {status_label}"),
        context: context_line,
        service: format!("本地服务 · {service}"),
        title,
        tooltip: tooltip.join("\n"),
    }
}

fn service_label(phase: &Phase) -> String {
    match phase {
        Phase::Starting => "正在启动".into(),
        Phase::Ready => "就绪".into(),
        Phase::Reconnecting { attempts } => format!("正在重连 · 第 {attempts} 次"),
        Phase::Recovering { attempt } => format!("正在重建 · 第 {attempt} 次"),
        Phase::Failed { .. } => "不可用".into(),
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|text| !text.is_empty())
}

fn compact(text: &str, max_chars: usize) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max_chars {
        return normalized;
    }
    let mut short: String = normalized.chars().take(max_chars).collect();
    short.push('…');
    short
}

fn icon_image(status: TrayStatus, style: MenuBarIconStyle) -> Image<'static> {
    Image::new_owned(icon_rgba(status, style), ICON_SIZE, ICON_SIZE)
}

fn icon_rgba(status: TrayStatus, style: MenuBarIconStyle) -> Vec<u8> {
    let size = ICON_SIZE as usize;
    let mut rgba = vec![0u8; size * size * 4];
    let samples = (SUPERSAMPLE * SUPERSAMPLE) as f32;
    for y in 0..ICON_SIZE {
        for x in 0..ICON_SIZE {
            let mut covered = 0u32;
            let mut red = 0u32;
            let mut green = 0u32;
            let mut blue = 0u32;
            for sy in 0..SUPERSAMPLE {
                for sx in 0..SUPERSAMPLE {
                    let px = x as f32 + (sx as f32 + 0.5) / SUPERSAMPLE as f32;
                    let py = y as f32 + (sy as f32 + 0.5) / SUPERSAMPLE as f32;
                    if let Some(color) = icon_color_at(px, py, status, style) {
                        covered += 1;
                        red += color[0] as u32;
                        green += color[1] as u32;
                        blue += color[2] as u32;
                    }
                }
            }
            let alpha = (covered as f32 / samples * 255.0).round() as u8;
            let index = ((y as usize) * size + x as usize) * 4;
            let divisor = covered.max(1);
            rgba[index] = (red / divisor) as u8;
            rgba[index + 1] = (green / divisor) as u8;
            rgba[index + 2] = (blue / divisor) as u8;
            rgba[index + 3] = alpha;
        }
    }
    rgba
}

fn icon_color_at(x: f32, y: f32, status: TrayStatus, style: MenuBarIconStyle) -> Option<[u8; 4]> {
    let glyph = terminal_glyph(x, y);
    let gap = distance(x, y, 57.0, 53.0) <= 10.5;
    match style {
        MenuBarIconStyle::Monochrome => {
            let frame = inside_rounded_rect_stroke(x, y, 8.0, 10.0, 64.0, 58.0, 11.0, 4.2);
            let base = (frame || glyph) && !gap;
            if base || badge_shape(x, y, status, style) {
                Some([0, 0, 0, 255])
            } else {
                None
            }
        }
        MenuBarIconStyle::Color => {
            if badge_shape(x, y, status, style) {
                return Some(badge_color(status));
            }
            if gap {
                return None;
            }
            if glyph {
                return Some([246, 241, 232, 255]);
            }
            let outer = inside_rounded_rect(x, y, 8.0, 10.0, 64.0, 58.0, 11.0);
            let inner = inside_rounded_rect(x, y, 11.0, 13.0, 61.0, 55.0, 8.0);
            if outer && !inner {
                return Some([246, 241, 232, 255]);
            }
            if inner {
                return Some([43, 40, 36, 255]);
            }
            None
        }
    }
}

fn terminal_glyph(x: f32, y: f32) -> bool {
    distance_to_polyline(x, y, &[(24.0, 26.0), (37.0, 34.0), (24.0, 42.0)]) <= 3.0
        || distance_to_segment(x, y, 44.0, 42.0, 54.0, 42.0) <= 3.0
}

fn badge_shape(x: f32, y: f32, status: TrayStatus, style: MenuBarIconStyle) -> bool {
    match status {
        TrayStatus::Idle if matches!(style, MenuBarIconStyle::Color) => {
            distance(x, y, 57.0, 53.0) <= 6.0
        }
        TrayStatus::Idle => false,
        TrayStatus::Working => distance(x, y, 57.0, 53.0) <= 6.0,
        TrayStatus::Connecting => {
            let distance = distance(x, y, 57.0, 53.0);
            (4.0..=7.0).contains(&distance)
        }
        TrayStatus::Attention => {
            distance_to_segment(x, y, 57.0, 46.0, 57.0, 52.0) <= 2.2
                || distance(x, y, 57.0, 57.0) <= 2.4
        }
        TrayStatus::Error => {
            distance_to_segment(x, y, 52.0, 48.0, 62.0, 58.0) <= 2.2
                || distance_to_segment(x, y, 62.0, 48.0, 52.0, 58.0) <= 2.2
        }
    }
}

fn badge_color(status: TrayStatus) -> [u8; 4] {
    match status {
        TrayStatus::Idle => [74, 214, 111, 255],
        TrayStatus::Working => [90, 200, 250, 255],
        TrayStatus::Connecting => [255, 214, 10, 255],
        TrayStatus::Attention => [255, 159, 10, 255],
        TrayStatus::Error => [255, 69, 58, 255],
    }
}

fn inside_rounded_rect(
    x: f32,
    y: f32,
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
    radius: f32,
) -> bool {
    if x < left || x > right || y < top || y > bottom {
        return false;
    }
    let inner_left = left + radius;
    let inner_right = right - radius;
    let inner_top = top + radius;
    let inner_bottom = bottom - radius;
    if (inner_left..=inner_right).contains(&x) || (inner_top..=inner_bottom).contains(&y) {
        return true;
    }
    let cx = if x < inner_left {
        inner_left
    } else {
        inner_right
    };
    let cy = if y < inner_top {
        inner_top
    } else {
        inner_bottom
    };
    distance(x, y, cx, cy) <= radius
}

// 纯几何函数，参数与坐标一一对应；拆成结构体反而降低调试点可读性。
#[allow(clippy::too_many_arguments)]
fn inside_rounded_rect_stroke(
    x: f32,
    y: f32,
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
    radius: f32,
    stroke: f32,
) -> bool {
    inside_rounded_rect(x, y, left, top, right, bottom, radius)
        && !inside_rounded_rect(
            x,
            y,
            left + stroke,
            top + stroke,
            right - stroke,
            bottom - stroke,
            (radius - stroke).max(1.0),
        )
}

fn distance(x: f32, y: f32, cx: f32, cy: f32) -> f32 {
    ((x - cx).powi(2) + (y - cy).powi(2)).sqrt()
}

fn distance_to_segment(x: f32, y: f32, x1: f32, y1: f32, x2: f32, y2: f32) -> f32 {
    let dx = x2 - x1;
    let dy = y2 - y1;
    let length_sq = dx * dx + dy * dy;
    if length_sq <= f32::EPSILON {
        return distance(x, y, x1, y1);
    }
    let t = (((x - x1) * dx + (y - y1) * dy) / length_sq).clamp(0.0, 1.0);
    distance(x, y, x1 + t * dx, y1 + t * dy)
}

fn distance_to_polyline(x: f32, y: f32, points: &[(f32, f32)]) -> f32 {
    points
        .windows(2)
        .map(|pair| distance_to_segment(x, y, pair[0].0, pair[0].1, pair[1].0, pair[1].1))
        .fold(f32::INFINITY, f32::min)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 菜单栏状态按后端与授权优先级变化() {
        let preferences = TrayPreferences::from(MenuBarCfg::default());
        let idle = view_for(&Phase::Ready, &TrayContext::default(), 0, preferences);
        assert_eq!(idle.status, TrayStatus::Idle);
        assert_eq!(idle.header, "DevEco Code · 就绪");

        let working = view_for(
            &Phase::Ready,
            &TrayContext {
                streaming: true,
                ..Default::default()
            },
            0,
            preferences,
        );
        assert_eq!(working.status, TrayStatus::Working);

        let attention = view_for(
            &Phase::Ready,
            &TrayContext {
                streaming: true,
                ..Default::default()
            },
            2,
            preferences,
        );
        assert_eq!(attention.status, TrayStatus::Attention);
        assert_eq!(attention.title.as_deref(), Some("2"));

        let failed = view_for(
            &Phase::Failed {
                reason: "serve 启动失败".into(),
                attempt: 3,
            },
            &TrayContext::default(),
            2,
            preferences,
        );
        assert_eq!(failed.status, TrayStatus::Error);
        assert_eq!(failed.title.as_deref(), Some("!"));
    }

    #[test]
    fn 会话上下文压缩空白并截断() {
        let preferences = TrayPreferences::from(MenuBarCfg::default());
        let view = view_for(
            &Phase::Ready,
            &TrayContext {
                project: Some("  DevEco Code  ".into()),
                session_title: Some(format!("  {}  ", "很长的会话标题".repeat(12))),
                streaming: false,
            },
            0,
            preferences,
        );
        assert!(view.context.contains("DevEco Code"));
        assert!(view.context.contains("…"));
        assert!(!view.context.contains("  "));
    }

    #[test]
    fn 单色与彩色图标都可区分状态且保留透明边距() {
        let idle = icon_rgba(TrayStatus::Idle, MenuBarIconStyle::Monochrome);
        let working = icon_rgba(TrayStatus::Working, MenuBarIconStyle::Monochrome);
        let attention = icon_rgba(TrayStatus::Attention, MenuBarIconStyle::Monochrome);
        let color = icon_rgba(TrayStatus::Idle, MenuBarIconStyle::Color);
        let color_working = icon_rgba(TrayStatus::Working, MenuBarIconStyle::Color);
        assert_ne!(idle, working);
        assert_ne!(working, attention);
        assert_ne!(idle, color);
        assert_ne!(color, color_working);
        assert!(color.iter().skip(1).step_by(4).any(|channel| *channel > 0));
        assert_eq!(idle[3], 0, "左上角应保持透明");
        assert_eq!(
            idle[(ICON_SIZE as usize - 1) * 4 + 3],
            0,
            "右上角应保持透明"
        );
        assert!(idle.iter().skip(3).step_by(4).any(|alpha| *alpha > 0));
    }

    #[test]
    fn 图标样式偏好包含常驻设置() {
        let prefs = TrayPreferences::from(MenuBarCfg {
            icon_style: MenuBarIconStyle::Color,
            always_visible: false,
        });
        assert_eq!(prefs.icon_style, MenuBarIconStyle::Color);
        assert!(!prefs.always_visible);
    }

    #[test]
    fn 非常驻模式只在窗口不可见时显示菜单栏() {
        let resident = TrayPreferences::from(MenuBarCfg {
            icon_style: MenuBarIconStyle::Monochrome,
            always_visible: true,
        });
        let transient = TrayPreferences {
            always_visible: false,
            ..resident
        };
        assert!(tray_should_be_visible(resident, true));
        assert!(!tray_should_be_visible(transient, true));
        assert!(tray_should_be_visible(transient, false));
    }
}
