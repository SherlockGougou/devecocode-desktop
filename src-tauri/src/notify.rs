//! 通知策略：哪些事件该弹、什么时候不打扰、如何去抖。
//!
//! 这里只做纯逻辑（时钟由参数传入），方便单测；真正的系统通知由主进程调用
//! `tauri-plugin-notification` 投递。

use crate::config::Notifications;
use crate::events::Notice;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// 同一会话同类事件的去抖窗口
pub const DEBOUNCE_WINDOW: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub struct Debouncer {
    window: Duration,
    last: HashMap<String, Instant>,
}

impl Debouncer {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            last: HashMap::new(),
        }
    }

    /// 去抖 key：授权请求按 requestID 区分（不同请求必须各自提醒），
    /// 其余按「类型 + 会话」聚合。
    pub fn key(notice: &Notice) -> Option<String> {
        match notice {
            Notice::Permission { request_id, .. } => Some(format!("permission:{request_id}")),
            Notice::Idle { session_id } => Some(format!("idle:{session_id}")),
            Notice::Error { session_id, .. } => Some(format!("error:{session_id}")),
            Notice::Step { session_id } => Some(format!("step:{session_id}")),
            _ => None,
        }
    }

    pub fn allow(&mut self, key: &str, now: Instant) -> bool {
        if let Some(prev) = self.last.get(key) {
            if now.duration_since(*prev) < self.window {
                return false;
            }
        }
        self.last.insert(key.to_string(), now);
        true
    }
}

/// 是否应该弹通知。
///
/// 授权请求是「Agent 正卡在这里等用户」，即使应用在前台也照样提醒；
/// 其余类别遵循 `quiet_when_focused`。
pub fn should_notify(cfg: &Notifications, notice: &Notice, focused: bool) -> bool {
    if !cfg.enabled {
        return false;
    }
    let permission = matches!(notice, Notice::Permission { .. });
    if focused && cfg.quiet_when_focused && !permission {
        return false;
    }
    match notice {
        Notice::Permission { .. } => cfg.on_permission,
        Notice::Idle { .. } => cfg.on_idle,
        Notice::Error { .. } => cfg.on_error,
        Notice::Step { .. } => cfg.on_step,
        Notice::Connected | Notice::PermissionResolved { .. } | Notice::Ignored => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn permission(id: &str) -> Notice {
        Notice::Permission {
            request_id: id.to_string(),
            session_id: "ses_1".into(),
            permission: "bash".into(),
            detail: String::new(),
        }
    }

    #[test]
    fn 授权请求优先于其他类别() {
        let cfg = Notifications {
            on_idle: false,
            ..Default::default()
        };
        assert!(should_notify(&cfg, &permission("per_1"), true));
        assert!(!should_notify(
            &cfg,
            &Notice::Idle {
                session_id: "ses_1".into()
            },
            true
        ));
    }

    #[test]
    fn 前台安静模式下抑制普通通知但保留授权() {
        let cfg = Notifications::default();
        assert!(!should_notify(
            &cfg,
            &Notice::Idle {
                session_id: "ses_1".into()
            },
            true
        ));
        assert!(should_notify(
            &cfg,
            &Notice::Idle {
                session_id: "ses_1".into()
            },
            false
        ));
        assert!(should_notify(&cfg, &permission("per_2"), true));
    }

    #[test]
    fn 总开关关闭时全部静默() {
        let cfg = Notifications {
            enabled: false,
            ..Default::default()
        };
        assert!(!should_notify(&cfg, &permission("per_3"), false));
    }

    #[test]
    fn 去抖窗口内同key只放行一次() {
        let mut deb = Debouncer::new(Duration::from_secs(10));
        let now = Instant::now();
        assert!(deb.allow("idle:ses_1", now));
        assert!(!deb.allow("idle:ses_1", now + Duration::from_secs(3)));
        assert!(deb.allow("idle:ses_1", now + Duration::from_secs(11)));
    }

    #[test]
    fn 不同授权请求独立计数() {
        let mut deb = Debouncer::new(Duration::from_secs(10));
        let now = Instant::now();
        assert!(deb.allow(&Debouncer::key(&permission("per_a")).unwrap(), now));
        assert!(deb.allow(&Debouncer::key(&permission("per_b")).unwrap(), now));
    }
}
