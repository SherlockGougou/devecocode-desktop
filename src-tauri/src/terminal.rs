//! 底部终端：复用 CLI 的 `/pty` 契约。
//!
//! CLI 已经负责真实 PTY、shell 探测和进程回收，桌面端只做三件事：
//! 1. 通过 Rust 发起创建/调整/关闭请求，WebView 不接触本机端口与口令；
//! 2. 在 Rust 内维持 `/pty/{id}/connect` 的 WebSocket，把输出转成 Tauri 事件；
//! 3. 把前端按键通过同一条连接写回 PTY。
//!
//! PTY 输出是字符串帧；首帧可能是 `0x00 + {"cursor":...}` 的二进制控制帧，
//! 用于断线重放定位，不需要交给 xterm。

use deveco_desktop::http;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

use crate::ipc::ServerConn;

const TICKET_HEADER: &str = "x-deveco-ticket";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub id: String,
    pub title: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub status: String,
    pub pid: u32,
    #[serde(default)]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Data { id: String, data: String },
    Exit { id: String, message: String },
    Error { id: String, message: String },
}

struct TerminalHandle {
    input: mpsc::UnboundedSender<String>,
    reader: AbortHandle,
    writer: AbortHandle,
}

/// 终端连接由主进程持有；面板关闭或应用退出时主动断开。
#[derive(Clone, Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalHandle>>>,
}

impl TerminalManager {
    fn insert(
        &self,
        id: String,
        input: mpsc::UnboundedSender<String>,
        reader: AbortHandle,
        writer: AbortHandle,
    ) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(previous) = sessions.insert(
                id,
                TerminalHandle {
                    input,
                    reader,
                    writer,
                },
            ) {
                previous.reader.abort();
                previous.writer.abort();
            }
        }
    }

    fn input(&self, id: &str) -> Option<mpsc::UnboundedSender<String>> {
        self.sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(id).map(|handle| handle.input.clone()))
    }

    fn remove(&self, id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(handle) = sessions.remove(id) {
                handle.reader.abort();
                handle.writer.abort();
            }
        }
    }

    pub fn shutdown_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, handle) in sessions.drain() {
                handle.reader.abort();
                handle.writer.abort();
            }
        }
    }
}

fn base_url(conn: &ServerConn) -> Result<String, String> {
    conn.base().ok_or_else(|| "后端尚未就绪".to_string())
}

fn directory_query(directory: Option<&str>) -> Vec<(String, String)> {
    directory
        .map(|value| vec![("directory".to_string(), value.to_string())])
        .unwrap_or_default()
}

fn terminal_cwd(directory: Option<&str>) -> Option<String> {
    directory
        .map(str::to_string)
        .or_else(|| dirs::home_dir().map(|path| path.to_string_lossy().to_string()))
}

fn websocket_url(base: &str, path: &str, query: &[(String, String)]) -> String {
    let mut url = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("ws://{base}")
    };
    url.push_str(path);
    if !query.is_empty() {
        let pairs: Vec<String> = query
            .iter()
            .map(|(key, value)| format!("{}={}", http::urlencode(key), http::urlencode(value)))
            .collect();
        url.push('?');
        url.push_str(&pairs.join("&"));
    }
    url
}

/// `connect-token` 要求显式的内部请求头，普通代理不会带；这里单独发一次。
async fn connect_token(
    base: &str,
    auth: Option<&str>,
    id: &str,
    directory: Option<&str>,
) -> Result<String, String> {
    let query = directory_query(directory);
    let url = websocket_url_http(base, &format!("/pty/{id}/connect-token"), &query);
    let client = reqwest::Client::builder()
        .timeout(CONNECT_TIMEOUT)
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|err| format!("创建终端连接客户端失败：{err}"))?;
    let mut request = client.post(url).header(TICKET_HEADER, "1");
    if let Some(auth) = auth {
        request = request.basic_auth("deveco", Some(auth));
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("获取终端连接票据失败：{}", err.without_url()))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("读取终端连接票据失败：{err}"))?;
    if !status.is_success() {
        return Err(format!("获取终端连接票据失败：HTTP {}", status.as_u16()));
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|err| format!("解析终端连接票据失败：{err}"))?;
    value
        .get("ticket")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "终端连接票据为空".to_string())
}

fn websocket_url_http(base: &str, path: &str, query: &[(String, String)]) -> String {
    let mut url = format!("{}{}", base.trim_end_matches('/'), path);
    if !query.is_empty() {
        let pairs: Vec<String> = query
            .iter()
            .map(|(key, value)| format!("{}={}", http::urlencode(key), http::urlencode(value)))
            .collect();
        url.push('?');
        url.push_str(&pairs.join("&"));
    }
    url
}

#[tauri::command]
pub async fn terminal_open(
    app: tauri::AppHandle,
    conn: tauri::State<'_, ServerConn>,
    manager: tauri::State<'_, TerminalManager>,
    directory: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<PtyInfo, String> {
    let base = base_url(&conn)?;
    let auth = conn.auth();
    if cols == 0 || rows == 0 {
        return Err("终端尺寸不合法".to_string());
    }
    let directory = directory.filter(|value| !value.trim().is_empty());
    let cwd = terminal_cwd(directory.as_deref());
    let mut body = Map::new();
    body.insert("title".into(), json!("终端"));
    if let Some(cwd) = cwd.as_deref() {
        body.insert("cwd".into(), json!(cwd));
    }
    let pty: PtyInfo = serde_json::from_value(
        http::send(
            &base,
            auth.as_deref(),
            "POST",
            "/pty",
            &directory_query(directory.as_deref()),
            Some(&Value::Object(body)),
        )
        .await
        .map_err(|err| format!("创建终端失败：{err:#}"))?,
    )
    .map_err(|err| format!("解析终端会话失败：{err}"))?;

    // PTY 默认 80x24，先按当前面板尺寸落地，避免首屏换行错位。
    if let Err(err) = resize_pty(
        &base,
        auth.as_deref(),
        &pty.id,
        directory.as_deref(),
        cols,
        rows,
    )
    .await
    {
        let _ = delete_pty(&base, auth.as_deref(), &pty.id, directory.as_deref()).await;
        return Err(err);
    }

    let ticket = match connect_token(&base, auth.as_deref(), &pty.id, directory.as_deref()).await {
        Ok(ticket) => ticket,
        Err(err) => {
            let _ = delete_pty(&base, auth.as_deref(), &pty.id, directory.as_deref()).await;
            return Err(err);
        }
    };
    let mut query = directory_query(directory.as_deref());
    query.push(("ticket".into(), ticket));
    let ws_url = websocket_url(&base, &format!("/pty/{}/connect", pty.id), &query);
    let socket = match tokio_tungstenite::connect_async(ws_url).await {
        Ok((socket, _)) => socket,
        Err(err) => {
            let _ = delete_pty(&base, auth.as_deref(), &pty.id, directory.as_deref()).await;
            return Err(format!("连接终端失败：{err}"));
        }
    };
    let (mut sink, mut stream) = socket.split();
    let (input, mut output) = mpsc::unbounded_channel::<String>();

    let writer_app = app.clone();
    let writer_id = pty.id.clone();
    let writer = tokio::spawn(async move {
        while let Some(text) = output.recv().await {
            if let Err(err) = sink
                .send(tokio_tungstenite::tungstenite::Message::Text(text))
                .await
            {
                let _ = writer_app.emit(
                    "deveco://terminal",
                    TerminalEvent::Error {
                        id: writer_id,
                        message: format!("终端输入连接已断开：{err}"),
                    },
                );
                return;
            }
        }
        let _ = sink.close().await;
    });

    let reader_app = app.clone();
    let reader_id = pty.id.clone();
    let reader = tokio::spawn(async move {
        while let Some(message) = stream.next().await {
            match message {
                Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                    if text.is_empty() {
                        continue;
                    }
                    let _ = reader_app.emit(
                        "deveco://terminal",
                        TerminalEvent::Data {
                            id: reader_id.clone(),
                            data: text,
                        },
                    );
                }
                Ok(tokio_tungstenite::tungstenite::Message::Close(frame)) => {
                    let code = frame.as_ref().map(|frame| u16::from(frame.code));
                    let event = if code == Some(4404) {
                        TerminalEvent::Error {
                            id: reader_id.clone(),
                            message: "终端会话已不存在，请重新打开".to_string(),
                        }
                    } else {
                        TerminalEvent::Exit {
                            id: reader_id.clone(),
                            message: "终端进程已结束".to_string(),
                        }
                    };
                    let _ = reader_app.emit("deveco://terminal", event);
                    return;
                }
                Ok(_) => {}
                Err(err) => {
                    let _ = reader_app.emit(
                        "deveco://terminal",
                        TerminalEvent::Error {
                            id: reader_id.clone(),
                            message: format!("终端连接中断：{err}"),
                        },
                    );
                    return;
                }
            }
        }
    });

    manager.insert(
        pty.id.clone(),
        input,
        reader.abort_handle(),
        writer.abort_handle(),
    );
    Ok(pty)
}

#[tauri::command]
pub fn terminal_write(
    manager: tauri::State<'_, TerminalManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let input = manager.input(&id).ok_or_else(|| "终端未连接".to_string())?;
    input
        .send(data)
        .map_err(|_| "终端输入连接已关闭".to_string())
}

#[tauri::command]
pub async fn terminal_resize(
    conn: tauri::State<'_, ServerConn>,
    id: String,
    directory: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Ok(());
    }
    let base = base_url(&conn)?;
    let auth = conn.auth();
    resize_pty(
        &base,
        auth.as_deref(),
        &id,
        directory.as_deref(),
        cols,
        rows,
    )
    .await
}

#[tauri::command]
pub async fn terminal_close(
    conn: tauri::State<'_, ServerConn>,
    manager: tauri::State<'_, TerminalManager>,
    id: String,
    directory: Option<String>,
) -> Result<(), String> {
    manager.remove(&id);
    let base = match conn.base() {
        Some(base) => base,
        None => return Ok(()),
    };
    delete_pty(&base, conn.auth().as_deref(), &id, directory.as_deref()).await
}

async fn resize_pty(
    base: &str,
    auth: Option<&str>,
    id: &str,
    directory: Option<&str>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    http::send(
        base,
        auth,
        "PUT",
        &format!("/pty/{id}"),
        &directory_query(directory),
        Some(&json!({ "size": { "cols": cols, "rows": rows } })),
    )
    .await
    .map_err(|err| format!("调整终端尺寸失败：{err:#}"))?;
    Ok(())
}

async fn delete_pty(
    base: &str,
    auth: Option<&str>,
    id: &str,
    directory: Option<&str>,
) -> Result<(), String> {
    http::send(
        base,
        auth,
        "DELETE",
        &format!("/pty/{id}"),
        &directory_query(directory),
        None,
    )
    .await
    .map_err(|err| format!("关闭终端失败：{err:#}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_url_转换协议并编码查询串() {
        let query = vec![
            ("directory".to_string(), "/tmp/a b".to_string()),
            ("ticket".to_string(), "t&x".to_string()),
        ];
        assert_eq!(
            websocket_url("http://127.0.0.1:4096", "/pty/pty_1/connect", &query),
            "ws://127.0.0.1:4096/pty/pty_1/connect?directory=/tmp/a%20b&ticket=t%26x"
        );
        assert_eq!(
            websocket_url("https://example.test", "/pty/pty_1/connect", &[]),
            "wss://example.test/pty/pty_1/connect"
        );
    }

    #[test]
    fn directory_query_只在有工作区时下发() {
        assert!(directory_query(None).is_empty());
        assert_eq!(
            directory_query(Some("/tmp/project")),
            vec![("directory".to_string(), "/tmp/project".to_string())]
        );
    }

    #[test]
    fn terminal_cwd_优先工作区并回退用户目录() {
        assert_eq!(
            terminal_cwd(Some("/tmp/project")).as_deref(),
            Some("/tmp/project")
        );
        assert_eq!(
            terminal_cwd(None),
            dirs::home_dir().map(|path| path.to_string_lossy().to_string())
        );
    }
}
