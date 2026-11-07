//! 后端自愈：把「启动一次」升级为受管状态。
//!
//! `deveco serve` 会因崩溃、`deveco upgrade`、被手动 kill 而消失。此前主进程只跑一条
//! 重连循环：进程没了就永远重连一个不存在的端口，而界面还显示「已连接」，只能重启应用
//! （代价是一次 161MB 进程的冷启动）。
//!
//! 这里把后端健康与否交给 `Supervisor` 判断：健康检查失败就回收旧进程，再按同一份配置
//! 重建后端（优先复用固定端口，否则挑新的空闲端口）。状态变化用 `Phase` 表达，由主进程
//! 广播给界面，重连/重建对用户可见。

use crate::backend::Backend;
use crate::config::Config;
use crate::server;
use std::time::Duration;

/// 单次重建等待健康检查的时间上限。冷启动实测 1.6s，留足余量。
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(45);

/// 后端对外的状态。会广播给前端，决定状态栏与提示条文案。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    /// 首次启动中
    Starting,
    /// 后端可用
    Ready,
    /// 事件流断开、正在退避重连（后端进程可能还活着）
    Reconnecting { attempts: u32 },
    /// 已确认后端不可用，正在重建
    Recovering { attempt: u32 },
    /// 重建失败，等待退避重试或用户手动重试
    Failed { reason: String, attempt: u32 },
}

impl Phase {
    /// 前端按这个字符串分派状态，改名字要同步 store.ts。
    pub fn key(&self) -> &'static str {
        match self {
            Phase::Starting => "starting",
            Phase::Ready => "ready",
            Phase::Reconnecting { .. } => "reconnecting",
            Phase::Recovering { .. } => "recovering",
            Phase::Failed { .. } => "failed",
        }
    }

    pub fn attempt(&self) -> u32 {
        match self {
            Phase::Reconnecting { attempts } => *attempts,
            Phase::Recovering { attempt } | Phase::Failed { attempt, .. } => *attempt,
            _ => 0,
        }
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            Phase::Failed { reason, .. } => Some(reason),
            _ => None,
        }
    }

    pub fn is_ready(&self) -> bool {
        matches!(self, Phase::Ready)
    }

    /// 广播给前端的载荷。字段名与 `ui/src/types.ts` 的 `BackendPhase` 一一对应，
    /// 前端按 `state` 分派、按 `attempt` 显示重试次数、按 `detail` 展示失败原因。
    pub fn payload(&self) -> serde_json::Value {
        serde_json::json!({
            "state": self.key(),
            "attempt": self.attempt(),
            "detail": self.reason(),
        })
    }
}

/// 指数退避：1s → 2s → 4s → 8s → 15s 封顶。
///
/// 上限 15s 与主进程原来的事件流退避一致：serve 重建最慢要几十秒，
/// 退避太快只会把日志打满。
pub fn backoff(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(4);
    Duration::from_secs(1u64 << shift).min(Duration::from_secs(15))
}

/// 后端监管者：持有当前 `Backend`（含 serve 子进程句柄）。
pub struct Supervisor {
    cfg: Config,
    backend: Option<Backend>,
    /// 是否已经成功启动过一次：区分「首次启动」与「重建」的日志/文案
    started_before: bool,
}

impl Supervisor {
    pub fn new(cfg: Config) -> Self {
        Self {
            cfg,
            backend: None,
            started_before: false,
        }
    }

    pub fn backend(&self) -> Option<&Backend> {
        self.backend.as_ref()
    }

    pub fn base_url(&self) -> Option<&str> {
        self.backend.as_ref().map(|item| item.server.base_url.as_str())
    }

    pub fn auth(&self) -> Option<String> {
        self.backend.as_ref().and_then(|item| item.auth.clone())
    }

    pub fn global_event_url(&self) -> Option<String> {
        self.backend
            .as_ref()
            .map(|item| item.server.global_event_url())
    }

    /// 通知文案里显示的项目名
    pub fn project_label(&self) -> String {
        self.backend
            .as_ref()
            .map(|item| item.project_label())
            .unwrap_or_default()
    }

    /// serve 进程组 id，供退出兜底回收
    pub fn pgid(&self) -> Option<i32> {
        self.backend.as_ref().and_then(|item| item.server.pgid())
    }

    /// 保证有一个健康后端：已健康就直接返回，不健康则回收旧进程并重建。
    ///
    /// 返回 `Err` 时旧后端已经停止，调用方按退避策略再调一次即可。
    pub async fn ensure(&mut self) -> Result<(), String> {
        if let Some(backend) = &self.backend {
            if server::health(&backend.server.base_url, backend.auth.as_deref()).await {
                return Ok(());
            }
            let base = backend.server.base_url.clone();
            log::warn!("后端无响应，准备重建：{base}");
            if let Some(mut backend) = self.backend.take() {
                // 先礼后兵地收掉旧进程组，避免和重建出来的新实例抢端口
                backend.server.stop().await;
            }
        }

        let action = if self.started_before { "重建" } else { "启动" };
        log::info!("正在{action}后端…");
        match Backend::boot(&mut self.cfg, |message| log::info!("{action}后端：{message}")).await {
            Ok(backend) => {
                log::info!("后端已就绪：{}", backend.server.base_url);
                self.backend = Some(backend);
                self.started_before = true;
                Ok(())
            }
            Err(err) => {
                // 界面横幅只有一行位置：把多行输出压成单行并截断，完整内容留在日志里
                let reason = one_line(&format!("{err:#}"));
                log::error!("{action}后端失败：{reason}");
                Err(reason)
            }
        }
    }

    /// 主动停止后端（退出时用；`Drop` 也会兜底）。
    pub async fn shutdown(&mut self) {
        if let Some(mut backend) = self.backend.take() {
            backend.server.stop().await;
        }
    }
}

/// 压成单行并截断：用于界面提示（完整错误在日志里）
pub fn one_line(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= 160 {
        return collapsed;
    }
    let mut short: String = collapsed.chars().take(160).collect();
    short.push('…');
    short
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 退避按指数增长并封顶() {
        assert_eq!(backoff(1), Duration::from_secs(1));
        assert_eq!(backoff(2), Duration::from_secs(2));
        assert_eq!(backoff(3), Duration::from_secs(4));
        assert_eq!(backoff(4), Duration::from_secs(8));
        assert_eq!(backoff(5), Duration::from_secs(15));
        assert_eq!(backoff(99), Duration::from_secs(15));
    }

    #[test]
    fn 状态可序列化为稳定键() {
        assert_eq!(Phase::Starting.key(), "starting");
        assert_eq!(Phase::Ready.key(), "ready");
        assert_eq!(Phase::Reconnecting { attempts: 3 }.key(), "reconnecting");
        assert_eq!(Phase::Recovering { attempt: 1 }.key(), "recovering");
        assert_eq!(
            Phase::Failed {
                reason: "x".into(),
                attempt: 2
            }
            .key(),
            "failed"
        );
    }

    #[test]
    fn 只有就绪态算就绪() {
        assert!(Phase::Ready.is_ready());
        assert!(!Phase::Recovering { attempt: 1 }.is_ready());
        assert!(!Phase::Failed {
            reason: "boom".into(),
            attempt: 1
        }
        .is_ready());
    }

    #[test]
    fn 错误原因压成单行并截断() {
        let raw = "deveco serve 启动后立即退出。输出：\n\n  [deveco stderr] boom\n\n";
        assert_eq!(one_line(raw), "deveco serve 启动后立即退出。输出： [deveco stderr] boom");

        let long = "错误".repeat(200);
        let short = one_line(&long);
        assert_eq!(short.chars().count(), 161);
        assert!(short.ends_with('…'));
    }

    #[test]
    fn 广播载荷字段与前端契约一致() {
        let ready = Phase::Ready.payload();
        assert_eq!(ready["state"], "ready");
        assert_eq!(ready["attempt"], 0);
        assert!(ready["detail"].is_null());

        let failed = Phase::Failed {
            reason: "连接被拒绝".into(),
            attempt: 3,
        }
        .payload();
        assert_eq!(failed["state"], "failed");
        assert_eq!(failed["attempt"], 3);
        assert_eq!(failed["detail"], "连接被拒绝");
    }

    #[test]
    fn 失败态携带原因与尝试次数() {
        let phase = Phase::Failed {
            reason: "连接被拒绝".into(),
            attempt: 4,
        };
        assert_eq!(phase.reason(), Some("连接被拒绝"));
        assert_eq!(phase.attempt(), 4);
    }
}
