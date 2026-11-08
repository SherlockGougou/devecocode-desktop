//! 无头自检：不打开窗口，验证「发现 CLI → 拉起 serve → 健康检查 → 订阅事件流
//! → 事件分类/通知文案」整条链路，最后验证进程能被正确回收。
//!
//! 用法：`cargo run --features selftest --bin deveco-selftest`
//! 退出码 0 表示全部通过。

use deveco_desktop::{
    cli,
    config::Config,
    device,
    events::{classify, render, unwrap_global as events_unwrap, Notice},
    http,
    notify::{should_notify, Debouncer, DEBOUNCE_WINDOW},
    server,
    sse::{self, SseEvent},
    supervise::Supervisor,
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

    // 2. 启动失败清理：用假 CLI 走一遍「serve 起不来」的路径，验证报错与进程清理
    self_check_failed_boot(&mut report).await;

    // 3. 拉起后端（走与桌面端完全相同的 Supervisor 路径）
    let cfg = Config::default();
    let mut supervisor = Supervisor::new(cfg);
    let started = Instant::now();
    match supervisor.ensure().await {
        Ok(()) => {
            let backend = supervisor.backend().expect("ensure 成功后必须有后端");
            report.pass(
                "拉起 deveco serve",
                format!(
                    "{}（{:.1}s，来源={:?}）",
                    backend.server.base_url,
                    started.elapsed().as_secs_f32(),
                    backend.server.origin
                ),
            );
        }
        Err(err) => {
            report.fail("拉起 deveco serve", err);
            finish(report);
        }
    }

    let base = supervisor
        .base_url()
        .expect("ensure 成功后必须有 base_url")
        .to_string();

    // 3. 健康检查
    report.check(
        "健康检查 /api/health",
        server::health(&base, None).await,
        base.clone(),
    );
    match check_device_skill(&base).await {
        Ok(detail) => report.pass("CLI 已加载内嵌设备 skill", detail),
        Err(err) => report.fail("CLI 已加载内嵌设备 skill", err),
    }
    if let Ok(hdc) = device::locate_hdc() {
        let injected = supervisor
            .backend()
            .map(|backend| backend.cli_env.iter().any(|(key, _)| key == "HDC"))
            .unwrap_or(false)
            || std::env::var_os("HDC").is_some();
        report.check(
            "设备 HDC 已传给 serve",
            injected,
            hdc.to_string_lossy().to_string(),
        );
    }
    match check_btw_route(&base).await {
        Ok(detail) => report.pass("OpenAPI 包含 Agent 提交信息接口", detail),
        Err(err) => report.fail("OpenAPI 包含 Agent 提交信息接口", err),
    }

    // 4. 项目目录（通知文案里会用）
    let project_dir = supervisor
        .backend()
        .and_then(|backend| backend.project_dir.clone());
    report.check(
        "读取 /api/location",
        project_dir.is_some(),
        project_dir
            .clone()
            .unwrap_or_else(|| "未返回 project.directory".into()),
    );

    // 5. UI 实际使用的读写路径：建会话 → 写消息 → 读消息 → 删会话
    match proxy_roundtrip(&base).await {
        Ok(detail) => report.pass("代理读写路径（POST/GET/DELETE）", detail),
        Err(err) => report.fail("代理读写路径（POST/GET/DELETE）", err),
    }

    // 6. 事件流
    let event_url = supervisor
        .global_event_url()
        .expect("ensure 成功后必须有事件流地址");
    match wait_for_connected(&event_url).await {
        Ok(elapsed) => report.pass(
            "订阅 /global/event 并收到 server.connected",
            format!("{:.0}ms", elapsed.as_secs_f32() * 1000.0),
        ),
        Err(err) => report.fail("订阅 /global/event 并收到 server.connected", err),
    }

    // 7. 通知链路（用真实事件格式构造，覆盖分类 → 文案 → 策略 → 去抖）
    self_check_notifications(&mut report);

    // 8. 崩溃自愈：直接 SIGKILL 进程组，验证监管者能自己把后端拉回来
    self_check_recovery(&mut report, &mut supervisor, &base).await;

    // 9. 进程回收
    let stopped = Instant::now();
    let final_base = supervisor.base_url().unwrap_or_default().to_string();
    supervisor.shutdown().await;
    let mut gone = false;
    for _ in 0..40 {
        if !server::health(&final_base, None).await {
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

/// 杀掉 serve 进程组，确认 Supervisor 能重建后端并恢复健康。
async fn self_check_recovery(report: &mut Report, supervisor: &mut Supervisor, base: &str) {
    const NAME: &str = "崩溃自愈（SIGKILL → 自动重建）";
    let Some(pgid) = supervisor.pgid() else {
        report.fail(NAME, "拿不到 serve 进程组 id");
        return;
    };
    let running_before = matches!(supervisor.liveness(), server::Liveness::Running);
    report.check(
        "自愈前识别 serve 进程仍在运行",
        running_before,
        format!("进程组 {pgid}"),
    );

    let old_base = base.to_string();
    let killed = Instant::now();
    // 负 pid 表示整个进程组：launcher 与 161MB 原生二进制一起消失，等价于真实崩溃
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }

    let mut down = false;
    for _ in 0..50 {
        if !server::health(&old_base, None).await {
            down = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !down {
        report.fail(NAME, "SIGKILL 后旧实例仍在响应，无法验证自愈");
        return;
    }
    let mut exited = false;
    for _ in 0..50 {
        if matches!(supervisor.liveness(), server::Liveness::Exited) {
            exited = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    report.check(
        "SIGKILL 后识别 serve 进程已退出",
        exited,
        format!("进程组 {pgid} 已无响应"),
    );

    let rebuilt = supervisor.ensure().await;
    let new_base = supervisor.base_url().unwrap_or_default().to_string();
    let healthy = server::health(&new_base, None).await;
    let elapsed = killed.elapsed().as_secs_f32();

    report.check(
        NAME,
        rebuilt.is_ok() && healthy,
        match rebuilt {
            Ok(()) => format!("{old_base} → {new_base}，{elapsed:.1}s 恢复"),
            Err(err) => format!("重建失败：{err}"),
        },
    );
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
    let prompt_path = format!("/session/{session_id}/prompt_async");
    let accepted = http::send(
        base,
        None,
        "POST",
        &prompt_path,
        &query,
        Some(&serde_json::json!({
            "parts": [{ "type": "text", "text": "自检消息" }],
            "noReply": true
        })),
    )
    .await
    .map_err(|err| format!("写消息失败：{err:#}"))?;
    if !accepted.is_null() {
        return Err("prompt_async 应返回空响应".into());
    }

    // prompt_async 先返回 204，消息随后异步落库；给 CLI 最多 5s 完成这一步
    let deadline = Instant::now() + Duration::from_secs(5);
    let count = loop {
        let messages = http::send(base, None, "GET", &message_path, &query, None)
            .await
            .map_err(|err| format!("读消息失败：{err:#}"))?;
        let count = messages.as_array().map(|items| items.len()).unwrap_or(0);
        if count > 0 {
            break count;
        }
        if Instant::now() >= deadline {
            return Err("prompt_async 5s 内未落库".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };

    let session_path = format!("/session/{session_id}");
    http::send(base, None, "DELETE", &session_path, &query, None)
        .await
        .map_err(|err| format!("清理会话失败：{err:#}"))?;

    Ok(format!("会话 {session_id}，读到 {count} 条消息，已清理"))
}

/// 只校验路由契约存在，不调用模型，因此自检不消耗 token。
async fn check_btw_route(base: &str) -> Result<String, String> {
    let doc = http::send(base, None, "GET", "/doc", &[], None)
        .await
        .map_err(|err| format!("读取 OpenAPI 失败：{err:#}"))?;
    let paths = doc
        .get("paths")
        .and_then(|value| value.as_object())
        .ok_or("OpenAPI 未返回 paths")?;
    let has_route = paths
        .get("/session/{sessionID}/btw")
        .and_then(|value| value.get("post"))
        .is_some();
    if !has_route {
        return Err("当前 CLI 未暴露 POST /session/{sessionID}/btw".into());
    }
    Ok("POST /session/{sessionID}/btw".into())
}

async fn check_device_skill(base: &str) -> Result<String, String> {
    let directory = std::env::current_dir()
        .map_err(|err| err.to_string())?
        .to_string_lossy()
        .to_string();
    let query = vec![("directory".to_string(), directory)];
    let value = http::send(base, None, "GET", "/skill/status", &query, None)
        .await
        .map_err(|err| format!("读取 skill 状态失败：{err:#}"))?;
    let items = value.as_array().ok_or("skill 状态没有返回数组")?;
    let skill = items
        .iter()
        .find(|item| {
            item.get("name").and_then(serde_json::Value::as_str) == Some("deveco-desktop-device")
        })
        .ok_or("未在 /skill/status 中找到 deveco-desktop-device")?;
    let enabled = skill
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let location = skill
        .get("location")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("位置未知");
    Ok(format!(
        "{}{}",
        location,
        if enabled { "" } else { "（当前已停用）" }
    ))
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

/// 用假 CLI 验证「serve 起不来」时的行为：失败要快、原因要能看懂、进程组登记要清掉。
///
/// 真实场景对应：CLI 路径写错、CLI 被删、锁屏导致 CLI 挂住、端口被占等。
async fn self_check_failed_boot(report: &mut Report) {
    const NAME: &str = "启动失败清理（假 CLI 立即退出）";

    let dir = std::env::temp_dir().join(format!("deveco-selftest-{}", std::process::id()));
    let script = dir.join("deveco");
    let body = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 0.2.5; exit 0; fi\necho 'boom' >&2\nexit 1\n";

    let setup = std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::write(&script, body))
        .and_then(|_| {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
        });
    if let Err(err) = setup {
        report.fail(NAME, format!("准备假 CLI 失败：{err}"));
        let _ = std::fs::remove_dir_all(&dir);
        return;
    }

    let cfg = Config {
        cli_path: Some(script.to_string_lossy().to_string()),
        ..Default::default()
    };
    let mut supervisor = Supervisor::new(cfg);
    let started = Instant::now();
    let result = supervisor.ensure().await;
    let elapsed = started.elapsed();

    let has_reason = result
        .as_ref()
        .err()
        .map(|reason| reason.contains("立即退出"))
        .unwrap_or(false);
    let cleaned = server::active_pgid().is_none();
    let failed_fast = elapsed < Duration::from_secs(15);

    report.check(
        NAME,
        has_reason && cleaned && failed_fast,
        match &result {
            Err(reason) => format!(
                "{:.1}s 内失败（原因可读={has_reason}，进程组已清理={cleaned}）：{reason}",
                elapsed.as_secs_f32()
            ),
            Ok(()) => format!("假 CLI 竟然启动了（{:.1}s）", elapsed.as_secs_f32()),
        },
    );

    let _ = std::fs::remove_dir_all(&dir);
}

fn finish(report: Report) -> ! {
    println!("\n自检结果：{} 通过，{} 失败", report.passed, report.failed);
    std::process::exit(if report.failed == 0 { 0 } else { 1 });
}
