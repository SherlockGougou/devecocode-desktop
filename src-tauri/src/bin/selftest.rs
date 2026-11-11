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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const EVENT_WAIT: Duration = Duration::from_secs(20);

/// CLI 只接受 ULID 形状的 msg_ ID；非 ULID 会静默忽略（HTTP 仍 204）。
fn new_message_id() -> String {
    const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let mut millis = now.as_millis() as u64;
    let mut time = [0u8; 10];
    for index in (0..10).rev() {
        time[index] = CROCKFORD[(millis % 32) as usize];
        millis /= 32;
    }
    let mut seed = now.as_nanos() ^ ((std::process::id() as u128) << 64);
    let mut random = String::with_capacity(16);
    for _ in 0..16 {
        random.push(CROCKFORD[(seed % 32) as usize] as char);
        seed /= 32;
    }
    format!("msg_{}{}", String::from_utf8_lossy(&time), random)
}

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
    match check_revert_roundtrip(&base).await {
        Ok(detail) => report.pass("历史消息 revert/unrevert 契约", detail),
        Err(err) => report.fail("历史消息 revert/unrevert 契约", err),
    }
    match check_session_permission_roundtrip(&base).await {
        Ok(detail) => report.pass("会话权限规则契约（POST/PATCH 追加保留旧规则）", detail),
        Err(err) => report.fail("会话权限规则契约（POST/PATCH 追加保留旧规则）", err),
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
    // 引导消息依赖客户端生成的 messageID；这里用不调模型的 noReply 请求验证契约。
    let message_id = new_message_id();
    let accepted = http::send(
        base,
        None,
        "POST",
        &prompt_path,
        &query,
        Some(&serde_json::json!({
            "messageID": message_id,
            "parts": [
                { "type": "text", "text": "自检消息" },
                {
                    "type": "text",
                    "text": "Continue with the latest user steering message.",
                    "synthetic": true
                }
            ],
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
    let (count, first_message) = loop {
        let messages = http::send(base, None, "GET", &message_path, &query, None)
            .await
            .map_err(|err| format!("读消息失败：{err:#}"))?;
        let items = messages.as_array();
        let count = items.map(|items| items.len()).unwrap_or(0);
        let first = items.and_then(|items| items.first());
        let has_parts = first
            .and_then(|message| message.get("parts"))
            .and_then(|parts| parts.as_array())
            .map(|parts| !parts.is_empty())
            .unwrap_or(false);
        if count > 0 && has_parts {
            break (count, first.cloned());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "prompt_async 5s 内未完整落库：{}",
                first
                    .map(|message| message.to_string())
                    .unwrap_or_else(|| "没有消息".into())
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let first_message = first_message.ok_or("读到消息但无法取第一条")?;
    let stored_id = first_message
        .get("info")
        .and_then(|info| info.get("id"))
        .and_then(|id| id.as_str());
    if stored_id != Some(message_id.as_str()) {
        return Err(format!(
            "prompt_async 未保留客户端 messageID，实际为 {stored_id:?}"
        ));
    }
    let has_synthetic = first_message
        .get("parts")
        .and_then(|parts| parts.as_array())
        .map(|parts| {
            parts
                .iter()
                .any(|part| part.get("synthetic").and_then(|value| value.as_bool()) == Some(true))
        })
        .unwrap_or(false);
    if !has_synthetic {
        return Err(format!(
            "prompt_async 未保留 synthetic part：{}",
            first_message
        ));
    }

    let session_path = format!("/session/{session_id}");
    http::send(base, None, "DELETE", &session_path, &query, None)
        .await
        .map_err(|err| format!("清理会话失败：{err:#}"))?;

    Ok(format!("会话 {session_id}，读到 {count} 条消息，已清理"))
}

/// 历史消息编辑依赖 `revert` 持久化边界、`unrevert` 清空边界。
/// 全部使用 noReply 消息，不调用模型，因此不消耗 token。
async fn check_revert_roundtrip(base: &str) -> Result<String, String> {
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
        Some(&serde_json::json!({ "title": "desktop-selftest-revert" })),
    )
    .await
    .map_err(|err| format!("创建会话失败：{err:#}"))?;
    let session_id = created
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or("创建会话未返回 id")?
        .to_string();
    let session_path = format!("/session/{session_id}");
    let message_path = format!("/session/{session_id}/message");
    let prompt_path = format!("/session/{session_id}/prompt_async");

    let result = async {
        let mut message_ids = Vec::with_capacity(2);
        for index in 0..2 {
            let message_id = new_message_id();
            http::send(
                base,
                None,
                "POST",
                &prompt_path,
                &query,
                Some(&serde_json::json!({
                    "messageID": message_id,
                    "parts": [{ "type": "text", "text": format!("revert selftest {index}") }],
                    "noReply": true
                })),
            )
            .await
            .map_err(|err| format!("写入第 {} 条消息失败：{err:#}", index + 1))?;
            wait_for_message(base, &message_path, &query, &message_id).await?;
            message_ids.push(message_id);
        }

        let boundary = message_ids.get(1).ok_or("第二条消息 ID 缺失")?.clone();
        let reverted = http::send(
            base,
            None,
            "POST",
            &format!("/session/{session_id}/revert"),
            &query,
            Some(&serde_json::json!({ "messageID": boundary })),
        )
        .await
        .map_err(|err| format!("revert 失败：{err:#}"))?;
        let revert_message = reverted
            .get("revert")
            .and_then(|value| value.get("messageID"))
            .and_then(|value| value.as_str());
        if revert_message != Some(boundary.as_str()) {
            return Err(format!(
                "revert 未持久化边界：期望 {boundary}，实际 {revert_message:?}"
            ));
        }

        let restored = http::send(
            base,
            None,
            "POST",
            &format!("/session/{session_id}/unrevert"),
            &query,
            None,
        )
        .await
        .map_err(|err| format!("unrevert 失败：{err:#}"))?;
        if restored
            .get("revert")
            .and_then(|value| value.as_object())
            .is_some()
        {
            return Err(format!("unrevert 后仍保留 revert：{restored}"));
        }

        Ok(format!(
            "会话 {session_id}，revert 边界 {boundary}，unrevert 已清空"
        ))
    }
    .await;

    let _ = http::send(base, None, "DELETE", &session_path, &query, None).await;
    result
}

fn permission_action<'a>(session: &'a serde_json::Value, tool: &str) -> Option<&'a str> {
    session
        .get("permission")?
        .as_array()?
        .iter()
        .rev()
        .find_map(|rule| {
            if rule.get("permission")?.as_str()? != tool || rule.get("pattern")?.as_str()? != "*" {
                return None;
            }
            rule.get("action")?.as_str()
        })
}

fn permission_rule_count(
    session: &serde_json::Value,
    tool: &str,
    pattern: &str,
    action: &str,
) -> usize {
    session
        .get("permission")
        .and_then(|value| value.as_array())
        .map(|rules| {
            rules
                .iter()
                .filter(|rule| {
                    rule.get("permission").and_then(|value| value.as_str()) == Some(tool)
                        && rule.get("pattern").and_then(|value| value.as_str()) == Some(pattern)
                        && rule.get("action").and_then(|value| value.as_str()) == Some(action)
                })
                .count()
        })
        .unwrap_or(0)
}

/// 会话权限是 UI 的总开关契约：创建时带规则，PATCH 追加并覆盖旧动作。
/// 不调用模型，失败时会清理临时会话。
async fn check_session_permission_roundtrip(base: &str) -> Result<String, String> {
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
        Some(&serde_json::json!({
            "title": "desktop-selftest-permission",
            "permission": [
                { "permission": "bash", "pattern": "*", "action": "ask" }
            ]
        })),
    )
    .await
    .map_err(|err| format!("创建带权限的会话失败：{err:#}"))?;
    let session_id = created
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or("创建带权限的会话未返回 id")?
        .to_string();
    let session_path = format!("/session/{session_id}");

    let result = async {
        if permission_action(&created, "bash") != Some("ask") {
            return Err(format!("创建会话未保留 ask 规则：{created}"));
        }
        let fetched = http::send(base, None, "GET", &session_path, &query, None)
            .await
            .map_err(|err| format!("读取会话失败：{err:#}"))?;
        if permission_action(&fetched, "bash") != Some("ask") {
            return Err(format!("GET 未返回创建时的 ask 规则：{fetched}"));
        }

        let updated = http::send(
            base,
            None,
            "PATCH",
            &session_path,
            &query,
            Some(&serde_json::json!({
                "permission": [
                    { "permission": "bash", "pattern": "*", "action": "allow" },
                    { "permission": "webfetch", "pattern": "*", "action": "allow" }
                ]
            })),
        )
        .await
        .map_err(|err| format!("PATCH 会话权限失败：{err:#}"))?;
        if permission_action(&updated, "bash") != Some("allow")
            || permission_action(&updated, "webfetch") != Some("allow")
        {
            return Err(format!("PATCH 未更新权限规则：{updated}"));
        }
        if permission_rule_count(&updated, "bash", "*", "ask") != 1
            || permission_rule_count(&updated, "bash", "*", "allow") != 1
        {
            return Err(format!(
                "PATCH 没有保留旧规则，疑似替换而不是追加：{updated}"
            ));
        }

        let switched_back = http::send(
            base,
            None,
            "PATCH",
            &session_path,
            &query,
            Some(&serde_json::json!({
                "permission": [
                    { "permission": "bash", "pattern": "*", "action": "ask" },
                    { "permission": "webfetch", "pattern": "*", "action": "ask" }
                ]
            })),
        )
        .await
        .map_err(|err| format!("再次 PATCH 会话权限失败：{err:#}"))?;
        if permission_action(&switched_back, "bash") != Some("ask")
            || permission_action(&switched_back, "webfetch") != Some("ask")
        {
            return Err(format!("追加规则未覆盖旧动作：{switched_back}"));
        }
        if permission_rule_count(&switched_back, "bash", "*", "ask") != 2
            || permission_rule_count(&switched_back, "bash", "*", "allow") != 1
        {
            return Err(format!("第二次 PATCH 未继续追加规则：{switched_back}"));
        }
        Ok(format!("会话 {session_id}，ask → allow → ask"))
    }
    .await;

    let _ = http::send(base, None, "DELETE", &session_path, &query, None).await;
    result
}

async fn wait_for_message(
    base: &str,
    message_path: &str,
    query: &[(String, String)],
    message_id: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let messages = http::send(base, None, "GET", message_path, query, None)
            .await
            .map_err(|err| format!("读取消息失败：{err:#}"))?;
        let found = messages
            .as_array()
            .map(|items| {
                items.iter().any(|item| {
                    item.get("info")
                        .and_then(|info| info.get("id"))
                        .and_then(|id| id.as_str())
                        == Some(message_id)
                })
            })
            .unwrap_or(false);
        if found {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("消息 {message_id} 5s 内未落库"));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
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

    let question_raw = r#"{"type":"question.asked","properties":{"id":"que_selftest","sessionID":"ses_selftest","questions":[{"header":"运行方式","question":"请选择运行方式"}]}}"#;
    let question = classify(&SseEvent {
        event: None,
        id: None,
        data: question_raw.to_string(),
    });
    let question_classified = matches!(
        &question,
        Notice::Question {
            request_id,
            session_id,
            header,
            detail,
            total,
        } if request_id == "que_selftest"
            && session_id == "ses_selftest"
            && header == "运行方式"
            && detail == "请选择运行方式"
            && *total == 1
    );
    report.check("提问事件分类", question_classified, format!("{question:?}"));

    let question_text = render(&question, "DevEcoCodeDesktop");
    report.check(
        "提问通知文案",
        question_text
            .as_ref()
            .map(|text| text.title.contains("回答") && text.body.contains("运行方式"))
            .unwrap_or(false),
        question_text
            .map(|text| format!("{} / {}", text.title, text.body.replace('\n', " ")))
            .unwrap_or_else(|| "未生成文案".into()),
    );

    let mut question_cfg = Config::default().notifications;
    let question_focused = should_notify(&question_cfg, &question, true);
    question_cfg.on_question = false;
    let question_disabled = !should_notify(&question_cfg, &question, true);
    report.check(
        "通知策略（前台仍提醒提问 / 单项开关生效）",
        question_focused && question_disabled,
        format!("focused={question_focused} disabled={question_disabled}"),
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
