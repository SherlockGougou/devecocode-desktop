//! 访问本机 CLI 的 HTTP 客户端。
//!
//! 放在 lib 而不是 Tauri 命令里，是为了让无头自检程序（`deveco-selftest`）
//! 能对真实的 `deveco serve` 跑一遍 UI 实际使用的读写路径。

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use std::time::Duration;

/// 普通请求上限。
///
/// 本机 CLI 正常时全部在毫秒级；卡住通常是 CLI 自身被阻塞（例如锁屏时访问
/// 钥匙串）。300s 会让界面无限转圈，30s 能把「卡住」变成界面上看得见的错误。
/// 会话 prompt 走 `/prompt_async`，长任务不再受这个上限影响。
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 启动阶段读取工作区时可以等得更久：macOS 首次询问文件夹权限时，
/// 用户可能过一阵才点「允许」，这不是后端故障，不应在 30 秒后直接报错。
const MAX_REQUEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub fn request_timeout(timeout_ms: Option<u64>) -> Duration {
    match timeout_ms {
        Some(ms) if ms > 0 => Duration::from_millis(ms).min(MAX_REQUEST_TIMEOUT),
        _ => REQUEST_TIMEOUT,
    }
}

fn client(timeout: Duration) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(5))
        .build()
        .context("构建 HTTP client 失败")
}

fn timeout_label(timeout: Duration) -> String {
    let secs = timeout.as_secs();
    if secs >= 60 && secs % 60 == 0 {
        format!("{} 分钟", secs / 60)
    } else {
        format!("{secs} 秒")
    }
}

/// 极简 percent-encoding：只需处理会出现在路径/查询里的字符。
pub fn urlencode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn build_url(base: &str, path: &str, query: &[(String, String)]) -> String {
    let mut url = format!("{base}{path}");
    // 空值参数必须保留：CLI 有些接口把「键存在但为空」当作合法输入
    // （例如 /find/file?query= 表示列出工作区全部文件），丢掉键会变成 400。
    // null 已经在 ipc.rs 里过滤掉了，这里不再二次过滤。
    let pairs: Vec<String> = query
        .iter()
        .map(|(key, value)| format!("{}={}", urlencode(key), urlencode(value)))
        .collect();
    if !pairs.is_empty() {
        url.push('?');
        url.push_str(&pairs.join("&"));
    }
    url
}

/// 发一个请求并把响应解析成 JSON。非 2xx 会带上响应体前 400 字返回错误。
pub async fn send(
    base: &str,
    auth: Option<&str>,
    method: &str,
    path: &str,
    query: &[(String, String)],
    body: Option<&Value>,
) -> Result<Value> {
    send_with_timeout(base, auth, method, path, query, body, REQUEST_TIMEOUT).await
}

/// 与 [`send`] 相同，但允许调用方指定单次请求的超时。
pub async fn send_with_timeout(
    base: &str,
    auth: Option<&str>,
    method: &str,
    path: &str,
    query: &[(String, String)],
    body: Option<&Value>,
    timeout: Duration,
) -> Result<Value> {
    let url = build_url(base, path, query);
    let client = client(timeout)?;
    let mut request = match method.to_ascii_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PATCH" => client.patch(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        other => bail!("不支持的 method：{other}"),
    };
    if let Some(auth) = auth {
        request = request.basic_auth("deveco", Some(auth));
    }
    if let Some(body) = body {
        if !body.is_null() {
            request = request.json(body);
        }
    }

    let response = request.send().await.map_err(|err| {
        if err.is_timeout() {
            // 不要把内部端口、session id 和 directory 原样丢给用户
            anyhow!("本地服务 {} 未响应", timeout_label(timeout))
        } else if err.is_connect() {
            anyhow!("无法连接本地服务")
        } else {
            anyhow!("请求本地服务失败：{}", err.without_url())
        }
    })?;
    let status = response.status();
    let text = response.text().await.context("读取响应失败")?;
    if !status.is_success() {
        let snippet: String = text.chars().take(400).collect();
        bail!("HTTP {}：{}", status.as_u16(), snippet);
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).context("解析响应 JSON 失败")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 编码查询参数() {
        assert_eq!(urlencode("/Users/example/x"), "/Users/example/x");
        assert_eq!(urlencode("a b&c"), "a%20b%26c");
        assert_eq!(urlencode("中文"), "%E4%B8%AD%E6%96%87");
    }

    #[test]
    fn 拼接查询串时保留空值() {
        let url = build_url(
            "http://127.0.0.1:1",
            "/session",
            &[
                ("directory".into(), "/tmp/a b".into()),
                ("empty".into(), String::new()),
            ],
        );
        // 查询串里的 `/` 保持原样即可（与 CLI 自身解析一致），空格必须编码；
        // 空值要保留成 `empty=`，否则 /find/file?query= 这类接口会 400
        assert_eq!(
            url,
            "http://127.0.0.1:1/session?directory=/tmp/a%20b&empty="
        );
    }

    #[test]
    fn 请求超时可按调用方延长并封顶() {
        assert_eq!(request_timeout(None), REQUEST_TIMEOUT);
        assert_eq!(request_timeout(Some(0)), REQUEST_TIMEOUT);
        assert_eq!(
            request_timeout(Some(5 * 60 * 1000)),
            Duration::from_secs(300)
        );
        assert_eq!(request_timeout(Some(60 * 60 * 1000)), MAX_REQUEST_TIMEOUT);
    }

    #[test]
    fn 超时文案按分钟显示() {
        assert_eq!(timeout_label(Duration::from_secs(30)), "30 秒");
        assert_eq!(timeout_label(Duration::from_secs(300)), "5 分钟");
        assert_eq!(timeout_label(Duration::from_secs(90)), "90 秒");
    }
}
