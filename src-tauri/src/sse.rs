//! SSE（`text/event-stream`）解析与订阅。
//!
//! 事件流是一行一个 `data: {json}`，中间用空行分隔。这里自己实现一个最小解析器
//! 而不是引入额外依赖：规则固定、可单测，也不会因为第三方库升级带来的行为差异
//! 影响通知链路。

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use std::time::Duration;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub id: Option<String>,
    pub data: String,
}

#[derive(Debug, Default)]
pub struct SseParser {
    buf: String,
    event: Option<String>,
    id: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    /// 喂入一段字节流（已按 UTF-8 解码），返回本次可以完整派发的事件。
    pub fn push(&mut self, chunk: &str) -> Vec<SseEvent> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.find('\n') {
            let mut line: String = self.buf[..pos].to_string();
            self.buf.drain(..=pos);
            if line.ends_with('\r') {
                line.pop();
            }
            if line.is_empty() {
                if !self.data.is_empty() || self.event.is_some() || self.id.is_some() {
                    out.push(SseEvent {
                        event: self.event.take(),
                        id: self.id.take(),
                        data: self.data.join("\n"),
                    });
                    self.data.clear();
                }
                continue;
            }
            if line.starts_with(':') {
                // 注释/心跳
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line.as_str(), ""),
            };
            match field {
                "data" => self.data.push(value.to_string()),
                "event" => self.event = Some(value.to_string()),
                "id" => self.id = Some(value.to_string()),
                _ => {}
            }
        }
        out
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        // SSE 是长连接，不设整体超时
        .build()
        .expect("构建 HTTP client 失败")
}

/// 连接一次事件流，阻塞式回调每个事件，直到流结束或出错。
pub async fn stream_once<F>(url: &str, password: Option<&str>, mut on_event: F) -> Result<()>
where
    F: FnMut(SseEvent),
{
    let mut req = client().get(url).header("Accept", "text/event-stream");
    if let Some(pw) = password {
        req = req.basic_auth("deveco", Some(pw));
    }
    let resp = req.send().await.context("连接事件流失败")?;
    if !resp.status().is_success() {
        bail!("订阅事件流返回 HTTP {}", resp.status());
    }

    let mut stream = resp.bytes_stream();
    let mut parser = SseParser::default();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.context("读取事件流失败")?;
        // 事件流是 UTF-8；损坏的字节不应打断整条链路
        let text = String::from_utf8_lossy(&bytes);
        for event in parser.push(&text) {
            on_event(event);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析单条事件() {
        let mut p = SseParser::default();
        let out = p.push("data: {\"type\":\"server.connected\"}\n\n");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].data, "{\"type\":\"server.connected\"}");
        assert_eq!(out[0].event, None);
    }

    #[test]
    fn 分片到达时等待完整空行() {
        let mut p = SseParser::default();
        assert!(p.push("data: {\"type\":\"sess").is_empty());
        assert!(p.push("ion.idle\"}").is_empty());
        let out = p.push("\n\n");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].data, "{\"type\":\"session.idle\"}");
    }

    #[test]
    fn 忽略心跳注释与空行() {
        let mut p = SseParser::default();
        assert!(p.push(": ping\n\n").is_empty());
        assert!(p.push("\n").is_empty());
    }

    #[test]
    fn 支持crlf与多行data() {
        let mut p = SseParser::default();
        let out = p.push("event: custom\r\ndata: line1\r\ndata: line2\r\n\r\n");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event.as_deref(), Some("custom"));
        assert_eq!(out[0].data, "line1\nline2");
    }

    #[test]
    fn 连续多条事件一次性返回() {
        let mut p = SseParser::default();
        let out = p.push("data: a\n\ndata: b\n\n");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].data, "a");
        assert_eq!(out[1].data, "b");
    }
}
