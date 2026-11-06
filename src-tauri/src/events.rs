//! 事件分类与通知文案。
//!
//! 只关心四类语义事件：需要授权、任务结束、执行失败、阶段推进。其余一律
//! `Ignored`——上游新增事件类型时不会打断通知链路，这是「跟随官方更新」的关键。

use crate::sse::SseEvent;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    Connected,
    Permission {
        request_id: String,
        session_id: String,
        permission: String,
        detail: String,
    },
    PermissionResolved {
        session_id: String,
        reply: String,
    },
    Idle {
        session_id: String,
    },
    Error {
        session_id: String,
        message: String,
    },
    Step {
        session_id: String,
    },
    Ignored,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeText {
    pub title: String,
    pub body: String,
}

fn json(ev: &SseEvent) -> Option<Value> {
    serde_json::from_str::<Value>(&ev.data).ok()
}

fn str_at(v: &Value, pointer: &str) -> Option<String> {
    v.pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn list_at(v: &Value, pointer: &str) -> String {
    v.pointer(pointer)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .take(3)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

/// 在任意深度的错误对象里找第一个可读文本，用于 `session.error`。
fn first_message(v: &Value) -> Option<String> {
    for key in ["message", "name", "code", "type"] {
        if let Some(s) = v.get(key).and_then(Value::as_str) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    if let Some(obj) = v.as_object() {
        for (_, child) in obj {
            if let Some(found) = first_message(child) {
                return Some(found);
            }
        }
    }
    None
}

pub fn classify(ev: &SseEvent) -> Notice {
    let Some(value) = json(ev) else {
        return Notice::Ignored;
    };
    let ty = value
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| ev.event.clone())
        .unwrap_or_default();
    let props = value.get("properties").cloned().unwrap_or(Value::Null);

    match ty.as_str() {
        "server.connected" => Notice::Connected,
        "permission.asked" => Notice::Permission {
            request_id: str_at(&props, "/id").unwrap_or_default(),
            session_id: str_at(&props, "/sessionID").unwrap_or_default(),
            permission: str_at(&props, "/permission").unwrap_or_else(|| "工具调用".into()),
            detail: list_at(&props, "/patterns"),
        },
        // v2 契约（预览面）字段名不同，一并兼容，避免官方切换后通知失效
        "permission.v2.asked" => Notice::Permission {
            request_id: str_at(&props, "/id").unwrap_or_default(),
            session_id: str_at(&props, "/sessionID").unwrap_or_default(),
            permission: str_at(&props, "/action").unwrap_or_else(|| "工具调用".into()),
            detail: list_at(&props, "/resources"),
        },
        "permission.replied" | "permission.v2.replied" => Notice::PermissionResolved {
            session_id: str_at(&props, "/sessionID").unwrap_or_default(),
            reply: str_at(&props, "/reply").unwrap_or_else(|| "resolved".into()),
        },
        "session.idle" => Notice::Idle {
            session_id: str_at(&props, "/sessionID").unwrap_or_default(),
        },
        "session.error" => {
            let message = props
                .get("error")
                .and_then(first_message)
                .unwrap_or_else(|| "未知错误".to_string());
            Notice::Error {
                session_id: str_at(&props, "/sessionID").unwrap_or_default(),
                message,
            }
        }
        "session.next.step.ended" => Notice::Step {
            session_id: str_at(&props, "/sessionID").unwrap_or_default(),
        },
        _ => Notice::Ignored,
    }
}

pub fn truncate(text: &str, max_chars: usize) -> String {
    let mut out: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        out.push('…');
    }
    out.replace('\n', " ")
}

fn with_project(body: &str, project: &str) -> String {
    if project.trim().is_empty() {
        body.to_string()
    } else {
        format!("{body}\n{project}")
    }
}

/// 生成通知文案。返回 `None` 表示这类事件不需要打扰用户。
pub fn render(notice: &Notice, project: &str) -> Option<NoticeText> {
    match notice {
        Notice::Permission {
            permission, detail, ..
        } => {
            let body = if detail.is_empty() {
                truncate(permission, 90)
            } else {
                truncate(&format!("{permission}：{detail}"), 120)
            };
            Some(NoticeText {
                title: "DevEco Code 需要授权".into(),
                body: with_project(&body, project),
            })
        }
        Notice::Idle { .. } => Some(NoticeText {
            title: "任务完成".into(),
            body: with_project("本轮执行已结束", project),
        }),
        Notice::Error { message, .. } => Some(NoticeText {
            title: "执行失败".into(),
            body: with_project(&truncate(message, 120), project),
        }),
        Notice::Step { .. } => Some(NoticeText {
            title: "阶段推进".into(),
            body: with_project("Agent 进入下一步", project),
        }),
        Notice::Connected | Notice::PermissionResolved { .. } | Notice::Ignored => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(data: &str) -> SseEvent {
        SseEvent {
            event: None,
            id: None,
            data: data.to_string(),
        }
    }

    #[test]
    fn 识别授权请求及其模式() {
        let notice = classify(&ev(
            r#"{"id":"evt_1","type":"permission.asked","properties":{"id":"per_1","sessionID":"ses_1","permission":"bash","patterns":["rm -rf build","ls"],"metadata":{},"always":[]}}"#,
        ));
        assert_eq!(
            notice,
            Notice::Permission {
                request_id: "per_1".into(),
                session_id: "ses_1".into(),
                permission: "bash".into(),
                detail: "rm -rf build, ls".into(),
            }
        );
    }

    #[test]
    fn 兼容v2授权事件() {
        let notice = classify(&ev(
            r#"{"id":"evt_2","type":"permission.v2.asked","properties":{"id":"per_2","sessionID":"ses_2","action":"edit","resources":["src/a.ets"]}}"#,
        ));
        assert_eq!(
            notice,
            Notice::Permission {
                request_id: "per_2".into(),
                session_id: "ses_2".into(),
                permission: "edit".into(),
                detail: "src/a.ets".into(),
            }
        );
    }

    #[test]
    fn 识别空闲与错误() {
        assert_eq!(
            classify(&ev(
                r#"{"type":"session.idle","properties":{"sessionID":"ses_9"}}"#
            )),
            Notice::Idle {
                session_id: "ses_9".into()
            }
        );
        let err = classify(&ev(
            r#"{"type":"session.error","properties":{"sessionID":"ses_9","error":{"name":"APIError","data":{"message":"rate limited"}}}}"#,
        ));
        match err {
            Notice::Error { message, .. } => {
                assert!(message.contains("APIError") || message.contains("rate limited"))
            }
            other => panic!("期望 Error，实际 {other:?}"),
        }
    }

    #[test]
    fn 未知事件被忽略不报错() {
        assert_eq!(
            classify(&ev(
                r#"{"type":"message.part.delta","properties":{"sessionID":"ses_1"}}"#
            )),
            Notice::Ignored
        );
        assert_eq!(classify(&ev("not json")), Notice::Ignored);
        assert_eq!(
            classify(&ev(r#"{"type":"session.next.text.delta","properties":{}}"#)),
            Notice::Ignored
        );
    }

    #[test]
    fn 解包全局事件包装() {
        let raw = r#"{"directory":"/private/tmp/x","project":"p1","payload":{"type":"server.connected","properties":{}}}"#;
        let (dir, payload) = unwrap_global(raw);
        assert_eq!(dir.as_deref(), Some("/private/tmp/x"));
        assert_eq!(
            classify(&SseEvent {
                event: None,
                id: None,
                data: payload
            }),
            Notice::Connected
        );
        // 裸事件原样返回
        let (dir, payload) = unwrap_global(r#"{"type":"session.idle","properties":{}}"#);
        assert!(dir.is_none());
        assert!(payload.contains("session.idle"));
    }

    #[test]
    fn 连接事件单独归类() {
        assert_eq!(
            classify(&ev(r#"{"type":"server.connected","properties":{}}"#)),
            Notice::Connected
        );
    }

    #[test]
    fn 授权通知带项目名并截断() {
        let notice = Notice::Permission {
            request_id: "per".into(),
            session_id: "ses".into(),
            permission: "bash".into(),
            detail: "x".repeat(200),
        };
        let text = render(&notice, "DevEcoCodeDesktop").unwrap();
        assert_eq!(text.title, "DevEco Code 需要授权");
        assert!(text.body.ends_with("DevEcoCodeDesktop"));
        assert!(text.body.chars().count() < 200);
    }

    #[test]
    fn 连接与已解决事件不产生通知() {
        assert!(render(&Notice::Connected, "p").is_none());
        assert!(render(
            &Notice::PermissionResolved {
                session_id: "s".into(),
                reply: "once".into()
            },
            "p"
        )
        .is_none());
    }
}

/// 全局事件流（`/global/event`）把每个事件包在 `{ directory, project, payload }` 里。
/// 返回 (事件所属目录, payload JSON 文本)；已是裸事件时原样返回。
pub fn unwrap_global(data: &str) -> (Option<String>, String) {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return (None, data.to_string());
    };
    match value.get("payload") {
        Some(payload) => (
            value
                .get("directory")
                .and_then(Value::as_str)
                .map(str::to_string),
            payload.to_string(),
        ),
        None => (None, data.to_string()),
    }
}
