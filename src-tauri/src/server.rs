//! `deveco serve` 子进程的生命周期：启动、端口发现、健康检查、退出。
//!
//! 官方 CLI 支持 `--port 0` 并在 stdout 打印
//! `deveco server listening on http://127.0.0.1:<port>`，
//! 因此这里不假设固定端口，而是解析这一行——这是「跟随官方更新」里最稳的接口之一。

use anyhow::{anyhow, bail, Context, Result};
use std::sync::atomic::{AtomicI32, Ordering};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

pub const EVENT_PATH: &str = "/event";
pub const HEALTH_PATH: &str = "/api/health";
pub const LOCATION_PATH: &str = "/api/location";
pub const GLOBAL_EVENT_PATH: &str = "/global/event";

const START_TIMEOUT: Duration = Duration::from_secs(60);
const TERM_TIMEOUT: Duration = Duration::from_secs(5);

/// 选取一个空闲端口。
///
/// `deveco serve --port 0` 会被 CLI 当成「未指定」并落到默认的 4096，
/// 与用户手动起的实例冲突，所以这里自己先占一个空端口再传进去。
pub fn free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
}

/// 向整个进程组发信号。
///
/// `/opt/homebrew/bin/deveco` 是 node launcher，它再 spawn 真正干活的 161MB 原生
/// 二进制。只杀 launcher 会留下孤儿进程继续占端口，因此必须按进程组处理。
#[cfg(unix)]
fn signal_group(pid: u32, signal: i32) {
    // 负 pid 表示进程组；忽略错误（进程可能已退出）
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

/// 最近一次拉起的 serve 进程组 id。
///
/// 进程内的兜底回收（信号处理、应用退出）只依赖这个值：`Backend::boot` 在
/// 健康检查通过之前就会把子进程拉起来，如果等到启动完成才登记，这段窗口里被
/// 强杀就会留下孤儿 serve。
static ACTIVE_PGID: AtomicI32 = AtomicI32::new(0);

/// 当前登记的 serve 进程组（健康检查阶段也可见）
pub fn active_pgid() -> Option<i32> {
    let pid = ACTIVE_PGID.load(Ordering::SeqCst);
    (pid > 0).then_some(pid)
}

/// 兜底回收：杀掉登记的整个进程组（launcher + 原生二进制）
pub fn kill_active_group() {
    let pid = ACTIVE_PGID.swap(0, Ordering::SeqCst);
    if pid > 0 {
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
}

#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub bin: PathBuf,
    pub hostname: String,
    pub port: u16,
    pub auth: Option<String>,
    pub cwd: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// 由本应用拉起的子进程，退出时会一并回收
    Spawned,
    /// 复用用户已经在跑的实例，不能杀
    Reused,
}

/// 后端进程的存活状态。
///
/// 健康检查失败不等于进程已经退出：macOS 的文件夹授权弹窗未处理时，
/// `deveco serve` 会一直阻塞在文件访问上。此时杀掉进程会打断系统授权，
/// 并可能让授权弹窗反复出现，因此需要把「还在运行」与「已经退出」分开。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    /// 由本应用拉起且仍然存活
    Running,
    /// 由本应用拉起，但已经退出（或子进程句柄丢失）
    Exited,
    /// 复用的外部实例，拿不到子进程句柄，无法判断
    Unowned,
}

pub struct DevEcoServer {
    pub base_url: String,
    pub origin: Origin,
    child: Option<Child>,
}

impl DevEcoServer {
    /// 进程组 id（即 launcher 的 pid）；用于应用退出时兜底回收。
    pub fn pgid(&self) -> Option<i32> {
        self.child
            .as_ref()
            .and_then(|child| child.id())
            .map(|pid| pid as i32)
    }

    pub fn is_spawned(&self) -> bool {
        self.origin == Origin::Spawned
    }

    /// 检查由本应用拉起的 serve 是否还活着。
    ///
    /// `try_wait()` 会顺手回收已经退出的子进程，因此这里不会留下僵尸进程。
    pub fn liveness(&mut self) -> Liveness {
        if !self.is_spawned() {
            return Liveness::Unowned;
        }
        match self.child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(_)) => Liveness::Exited,
                Ok(None) => Liveness::Running,
                Err(err) => {
                    log::warn!("读取 serve 进程状态失败：{err}");
                    Liveness::Exited
                }
            },
            None => Liveness::Exited,
        }
    }

    pub fn event_url(&self) -> String {
        format!("{}{}", self.base_url, EVENT_PATH)
    }

    /// 全局事件流：`/event` 只覆盖 serve 启动目录那一个实例，跨工作区的会话收不到。
    /// `/global/event` 把所有工作区的事件多路复用，外层带 `directory` 字段。
    pub fn global_event_url(&self) -> String {
        format!("{}{}", self.base_url, GLOBAL_EVENT_PATH)
    }

    /// 拉起 `deveco serve`，等待 stdout 里的 listening 行。
    pub async fn spawn(spec: LaunchSpec) -> Result<Self> {
        let mut cmd = Command::new(&spec.bin);
        cmd.arg("serve")
            .arg("--hostname")
            .arg(&spec.hostname)
            .arg("--port")
            .arg(spec.port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 应用被强杀时尽量带走子进程
            .kill_on_drop(true);
        if let Some(auth) = &spec.auth {
            cmd.env("DEVECO_SERVER_PASSWORD", auth);
        }
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }

        // 让子进程成为独立进程组的组长，退出时才能连带回收 launcher 派生出的二进制
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.as_std_mut().process_group(0);
        }

        let mut child = cmd
            .spawn()
            .with_context(|| format!("无法启动 {}", spec.bin.display()))?;
        // spawn 后立刻登记：健康检查期间被强杀也要能收掉
        let child_pid = child.id();
        if let Some(pid) = child_pid {
            ACTIVE_PGID.store(pid as i32, Ordering::SeqCst);
        }

        // 启动失败时必须按进程组清理：`kill_on_drop` 只回收 launcher，
        // 161MB 的原生二进制会变成孤儿继续占着 CLI 数据库。
        let cleanup = |message: String| -> anyhow::Error {
            if let Some(pid) = child_pid {
                #[cfg(unix)]
                signal_group(pid, libc::SIGKILL);
            }
            ACTIVE_PGID.store(0, Ordering::SeqCst);
            anyhow!(message)
        };
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("拿不到 deveco serve 的 stdout"))?;
        let stderr = child.stderr.take();

        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::debug!("[deveco stderr] {line}");
                }
            });
        }

        let mut lines = BufReader::new(stdout).lines();
        let mut tail: Vec<String> = Vec::new();
        let deadline = tokio::time::Instant::now() + START_TIMEOUT;

        let base_url = loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                let detail = if tail.is_empty() {
                    "（无输出）".to_string()
                } else {
                    tail.join("\n")
                };
                return Err(cleanup(format!(
                    "等待 deveco serve 就绪超时（{}s）。最近的输出：{detail}",
                    START_TIMEOUT.as_secs()
                )));
            }
            match tokio::time::timeout(remaining, lines.next_line()).await {
                Ok(Ok(Some(line))) => {
                    log::debug!("[deveco stdout] {line}");
                    if let Some(url) = parse_listening_url(&line) {
                        break url;
                    }
                    tail.push(line);
                    if tail.len() > 40 {
                        tail.remove(0);
                    }
                }
                Ok(Ok(None)) => {
                    let detail = if tail.is_empty() {
                        "（无输出）".to_string()
                    } else {
                        tail.join("\n")
                    };
                    return Err(cleanup(format!("deveco serve 启动后立即退出，输出：{detail}")));
                }
                Ok(Err(err)) => {
                    return Err(cleanup(format!("读取 deveco serve 输出失败：{err}")));
                }
                Err(_) => continue,
            }
        };

        // 继续排空 stdout，避免子进程因管道写满而阻塞
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("[deveco stdout] {line}");
            }
        });

        Ok(Self {
            base_url,
            origin: Origin::Spawned,
            child: Some(child),
        })
    }

    /// 复用已经在 `host:port` 上运行的实例（用户手动 `deveco serve` 的场景）。
    pub async fn reuse(host: &str, port: u16, password: Option<&str>) -> Option<Self> {
        let base_url = format!("http://{host}:{port}");
        if health(&base_url, password).await {
            Some(Self {
                base_url,
                origin: Origin::Reused,
                child: None,
            })
        } else {
            None
        }
    }

    pub async fn stop(&mut self) {
        ACTIVE_PGID.store(0, Ordering::SeqCst);
        if let Some(mut child) = self.child.take() {
            let Some(pid) = child.id() else { return };
            #[cfg(unix)]
            {
                // 先礼后兵：SIGTERM 让 launcher 转发给真正的二进制并优雅退出
                signal_group(pid, libc::SIGTERM);
                if tokio::time::timeout(TERM_TIMEOUT, child.wait())
                    .await
                    .is_ok()
                {
                    return;
                }
                log::warn!("serve 未在 {TERM_TIMEOUT:?} 内退出，强制结束进程组");
                signal_group(pid, libc::SIGKILL);
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
    }
}

impl Drop for DevEcoServer {
    fn drop(&mut self) {
        ACTIVE_PGID.store(0, Ordering::SeqCst);
        if let Some(mut child) = self.child.take() {
            // 应用退出/任务结束时不留下孤儿进程
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                signal_group(pid, libc::SIGKILL);
            }
            let _ = child.start_kill();
        }
    }
}

/// 从日志行里提取服务器地址。格式示例：
/// `deveco server listening on http://127.0.0.1:41999`
pub fn parse_listening_url(line: &str) -> Option<String> {
    let marker = "listening on";
    let idx = line.find(marker)?;
    let rest = line[idx + marker.len()..].trim();
    let token = rest.split_whitespace().next()?;
    let trimmed = token.trim_end_matches(['/', ',', '.']);
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Some(trimmed.trim_end_matches('/').to_string())
    } else {
        None
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("构建 HTTP client 失败")
}

fn with_auth(req: reqwest::RequestBuilder, password: Option<&str>) -> reqwest::RequestBuilder {
    match password {
        Some(pw) => req.basic_auth("deveco", Some(pw)),
        None => req,
    }
}

pub async fn get_json(url: &str, password: Option<&str>) -> Result<serde_json::Value> {
    let req = with_auth(http_client().get(url), password);
    let resp = req.send().await.context("HTTP 请求失败")?;
    if !resp.status().is_success() {
        bail!("HTTP {}", resp.status());
    }
    resp.json().await.context("解析响应 JSON 失败")
}

pub async fn health(base_url: &str, password: Option<&str>) -> bool {
    let url = format!("{base_url}{HEALTH_PATH}");
    match get_json(&url, password).await {
        Ok(value) => value
            .get("healthy")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// 轮询健康检查，等 server 真正可用（listening 行出来时 HTTP 未必就绪）。
pub async fn wait_healthy(base_url: &str, password: Option<&str>, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if health(base_url, password).await {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// 读取当前工作目录（用于通知里显示项目名）。
pub async fn project_dir(base_url: &str, password: Option<&str>) -> Option<String> {
    let url = format!("{base_url}{LOCATION_PATH}");
    let value = get_json(&url, password).await.ok()?;
    value
        .pointer("/project/directory")
        .or_else(|| value.get("directory"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析监听地址() {
        assert_eq!(
            parse_listening_url("deveco server listening on http://127.0.0.1:41999"),
            Some("http://127.0.0.1:41999".to_string())
        );
    }

    #[test]
    fn 容忍带时间戳前缀与尾部斜杠() {
        assert_eq!(
            parse_listening_url(
                "2026-11-06T12:11:36Z INFO deveco server listening on http://0.0.0.0:4096/"
            ),
            Some("http://0.0.0.0:4096".to_string())
        );
    }

    #[test]
    fn 非地址行被忽略() {
        assert_eq!(
            parse_listening_url("loading path=/Users/x/.config/deveco/config.json"),
            None
        );
        assert_eq!(parse_listening_url("listening on 4096"), None);
    }
}
