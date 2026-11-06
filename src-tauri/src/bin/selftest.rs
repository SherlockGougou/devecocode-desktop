//! 无头自检：不打开窗口，验证「发现 CLI → 拉起 serve → 健康检查 → 订阅事件流
//! → 事件分类/通知文案」整条链路，最后验证进程能被正确回收。
//!
//! 用法：`cargo run --bin deveco-selftest`
//! 退出码 0 表示全部通过。

use deveco_desktop::{
    backend::Backend,
    cli,
    config::Config,
    events::{classify, render, unwrap_global as events_unwrap, Notice},
    http,
    notify::{should_notify, Debouncer, DEBOUNCE_WINDOW},
    server,
    sse::{self, SseEvent},
};
use std::time::{Duration, Instant};

const EVENT_WAIT: Duration = Duration::from_secs(20);

#[derive(Default)]
struct Report {
    passed: usize,
    failed: usize,
}

impl Report {
    fn pass(&mut self, name: &str, detail: impl Into<String>) {
        self.passed += 1;
        println!("[PASS] {name} —— {}", detail.into());
    }

    fn fail(&mut self, name: &str, detail: impl Into<String>) {
        self.failed += 1;
        println!("[FAIL] {name} —— {}", detail.into());
    }

    fn check(&mut self, name: &str, ok: bool, detail: impl Into<String>) {
        if ok {
            self.pass(name, detail);
        } else {
            self.fail(name, detail);
        }
    }
}

#[tokio::main]
async fn main() {
    println!("DevEco Code Desktop 自检开始\n");
    let mut report = Report::default();

    // 1. CLI 发现
    let found = cli::discover(None);
    match &found {
        Ok(info) => {
            let version = info
                .version
                .map(|v| format!(" ({v})"))
                .unwrap_or_else(|| " (版本未知)".to_string());
            report.pass(
                "发现 deveco CLI",
                format!("{}{version}", info.path.display()),
            );
        }
        Err(err) => report.fail("发现 deveco CLI", format!("{err}")),
    }

    // 2. 拉起后端
    let mut cfg = Config::default();
    let started = Instant::now();
    let booted = Backend::boot(&mut cfg, |message| println!("  · {message}")).await;
    let mut backend = match booted {
        Ok(backend) => {
            report.pass(
                "拉起 deveco serve",
                format!(
                    "{}（{:.1}s，来源={:?}）",
                    backend.server.base_url,
                    started.elapsed().as_secs_f32(),
                    backend.server.origin
                ),
            );
            backend
        }
        Err(err) => {
            report.fail("拉起 deveco serve", format!("{err:#}"));
            finish(report);
        }
    };

    // 3. 健康检查
    let base = backend.server.base_url.clone();
    report.check(
        "健康检查 /api/health",
        server::health(&base, None).await,
        base.clone(),
    );

    // 4. 项目目录（通知文案里会用）
    report.check(
        "读取 /api/location",
        backend.project_dir.is_some(),
        backend
            .project_dir
            .clone()
            .unwrap_or_else(|| "未返回 project.directory".into()),
    );

    // 5. UI 实际使用的读写路径：建会话 → 写消息 → 读消息 → 删会话
    match proxy_roundtrip(&base).await {
        Ok(detail) => report.pass("代理读写路径（POST/GET/DELETE）", detail),
        Err(err) => report.fail("代理读写路径（POST/GET/DELETE）", err),
    }

    // 6. 事件流
    match wait_for_connected(&backend.server.global_event_url()).await {
        Ok(elapsed) => report.pass(
            "订阅 /global/event 并收到 server.connected",
            format!("{:.0}ms", elapsed.as_secs_f32() * 1000.0),
        ),
        Err(err) => report.fail(
            "订阅 /global/event 并收到 server.connected",
            format!("{err}"),
        ),
    }

    // 6. 通知链路（用真实事件格式构造，覆盖分类 → 文案 → 策略 → 去抖）
    self_check_notifications(&mut report);

    // 7. 进程回收
    let stopped = Instant::now();
    backend.server.stop().await;
    let mut gone = false;
    for _ in 0..40 {
        if !server::health(&base, None).await {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    report.check(
        "退出时回收 serve 子进程",
        gone,
        format!(
            "{:.0}ms 内停止响应",
            stopped.elapsed().as_secs_f32() * 1000.0
        ),
    );

    finish(report);
}

/// 复现 UI 的请求链路：走 lib 里同一份 HTTP 客户端
async fn proxy_roundtrip(base: &str) -> Result<String, String> {
    let directory = std::env::current_dir()
        .map_err(|err| err.to_string())?
        .to_string_lossy()
        .to_string();
    let query = vec![("directory".to_string(), directory)];

    let created = http::send(
        base,
        None,
        "POST",
        "/session",
        &query,
        Some(&serde_json::json!({ "title": "desktop-selftest" })),
    )
    .await
    .map_err(|err| format!("{err:#}"))?;
    let session_id = created
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or("创建会话未返回 id")?
        .to_string();

    let message_path = format!("/session/{session_id}/message");
    http::send(
        base,
        None,
        "POST",
        &message_path,
        &query,
        Some(&serde_json::json!({
            "parts": [{ "type": "text", "text": "自检消息" }],
            "noReply": true
        })),
    )
    .await
    .map_err(|err| format!("写消息失败：{err:#}"))?;

    let messages = http::send(base, None, "GET", &message_path, &query, None)
        .await
        .map_err(|err| format!("读消息失败：{err:#}"))?;
    let count = messages.as_array().map(|items| items.len()).unwrap_or(0);

    let session_path = format!("/session/{session_id}");
    http::send(base, None, "DELETE", &session_path, &query, None)
        .await
        .map_err(|err| format!("清理会话失败：{err:#}"))?;

    Ok(format!("会话 {session_id}，读到 {count} 条消息，已清理"))
}

async fn wait_for_connected(url: &str) -> Result<Duration, String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SseEvent>();
    let url = url.to_string();
    tokio::spawn(async move {
        // 自检进程会先退出，忽略连接错误
        let _ = sse::stream_once(&url, None, |event| {
            let _ = tx.send(event);
        })
        .await;
    });

    let started = Instant::now();
    loop {
        let remaining = EVENT_WAIT.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(format!(
                "{}s 内未收到 server.connected",
                EVENT_WAIT.as_secs()
            ));
        }
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(event)) => {
                let (_, payload) = events_unwrap(&event.data);
                let scoped = SseEvent {
                    event: event.event,
                    id: event.id,
                    data: payload,
                };
                if matches!(classify(&scoped), Notice::Connected) {
                    return Ok(started.elapsed());
                }
            }
            Ok(None) => return Err("事件流提前结束".into()),
            Err(_) => {
                return Err(format!(
                    "{}s 内未收到 server.connected",
                    EVENT_WAIT.as_secs()
                ))
            }
        }
    }
}

fn self_check_notifications(report: &mut Report) {
    // 真实格式（取自 OpenAPI 的 EventPermissionAsked）
    let raw = r#"{"id":"evt_selftest","type":"permission.asked","properties":{"id":"per_selftest","sessionID":"ses_selftest","permission":"bash","patterns":["hvigorw assembleHap"],"metadata":{},"always":[]}}"#;
    let notice = classify(&SseEvent {
        event: None,
        id: None,
        data: raw.to_string(),
    });

    let classified = matches!(
        &notice,
        Notice::Permission {
            request_id,
            session_id,
            permission,
            detail,
        } if request_id == "per_selftest"
            && session_id == "ses_selftest"
            && permission == "bash"
            && detail.contains("hvigorw")
    );
    report.check("授权事件分类", classified, format!("{notice:?}"));

    let text = render(&notice, "DevEcoCodeDesktop");
    report.check(
        "授权通知文案",
        text.as_ref()
            .map(|t| t.title.contains("授权") && t.body.contains("DevEcoCodeDesktop"))
            .unwrap_or(false),
        text.map(|t| format!("{} / {}", t.title, t.body.replace('\n', " ")))
            .unwrap_or_else(|| "未生成文案".into()),
    );

    let mut cfg = Config::default().notifications;
    let focused_allowed = should_notify(&cfg, &notice, true);
    cfg.enabled = false;
    let disabled_blocked = !should_notify(&cfg, &notice, false);
    report.check(
        "通知策略（前台仍提醒授权 / 总开关生效）",
        focused_allowed && disabled_blocked,
        format!("focused={focused_allowed} disabled_blocked={disabled_blocked}"),
    );

    let mut debouncer = Debouncer::new(DEBOUNCE_WINDOW);
    let key = Debouncer::key(&notice).unwrap_or_default();
    let now = Instant::now();
    let first = debouncer.allow(&key, now);
    let second = debouncer.allow(&key, now + Duration::from_secs(1));
    report.check(
        "通知去抖",
        first && !second,
        format!("first={first} second={second}"),
    );
}

fn finish(report: Report) -> ! {
    println!("\n自检结果：{} 通过，{} 失败", report.passed, report.failed);
    std::process::exit(if report.failed == 0 { 0 } else { 1 });
}
