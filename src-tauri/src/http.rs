//! 访问本机 CLI 的 HTTP 客户端。
//!
//! 放在 lib 而不是 Tauri 命令里，是为了让无头自检程序（`deveco-selftest`）
//! 能对真实的 `deveco serve` 跑一遍 UI 实际使用的读写路径。

use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::time::Duration;

/// 单次请求上限。
///
/// 本机 CLI 正常时全部在毫秒级；卡住通常是 CLI 自身被阻塞（例如锁屏时访问
/// 钥匙串）。300s 会让界面无限转圈，30s 能把「卡住」变成界面上看得见的错误。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(Duration::from_secs(5))
        .build()
        .context("构建 HTTP client 失败")
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
    let url = build_url(base, path, query);
    let client = client()?;
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

    let response = request
        .send()
        .await
        .with_context(|| format!("请求 {url} 失败"))?;
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
}
