//! 自绘顶栏的窗口拖动。
//!
//! Tauri 的 `data-tauri-drag-region` 由注入脚本在 DOM `mousedown` 里异步 `invoke` 到主线程，
//! 再交给 `tao::drag_window()`；后者取 `NSApp.currentEvent` 去 `performWindowDragWithEvent:`。
//! 在本机 macOS 27.2 上实测这条路径拿不到那次按下事件：权限已按官方文档补了
//! `core:window:allow-start-dragging`，调用不报错，窗口就是不动；
//! 换成 `NSWindow.movableByWindowBackground` + tao 在 `sendEvent:` 里的同步钩子也没有产生拖动。
//!
//! 所以这里不依赖平台的事件语义，由前端在按住顶栏时按帧把「窗口该在哪」算出来，
//! 交给 Rust 侧设置窗口位置。代价是没有系统级的贴边、跨 Space 拖动效果。
//!
//! 坐标换算：Web 侧的 `screenX/screenY` 是 CSS 像素（macOS 上等于点），
//! 而窗口位置是物理像素，乘 `scale_factor` 对齐。

use tauri::PhysicalPosition;

/// 窗口左上角在屏幕坐标系里的物理像素位置（拖动开始时作为基准）。
#[tauri::command]
pub fn window_outer_position(window: tauri::Window) -> Result<(i32, i32), String> {
    window
        .outer_position()
        .map(|pos| (pos.x, pos.y))
        .map_err(|err| err.to_string())
}

/// 把窗口移到 `base + delta`（`delta` 是 CSS 像素，基准为按下时的窗口左上角）。
#[tauri::command]
pub fn move_window_by_pointer(
    window: tauri::Window,
    base_x: i32,
    base_y: i32,
    delta_x: f64,
    delta_y: f64,
) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    let x = base_x + (delta_x * scale).round() as i32;
    let y = base_y + (delta_y * scale).round() as i32;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|err| err.to_string())
}
