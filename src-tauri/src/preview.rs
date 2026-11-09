//! 文件预览的 macOS 系统能力。
//!
//! 浏览器能直接展示图片、PDF、音视频和文本；Office、iWork、HEIC 等格式
//! 交给系统 Quick Look 生成缩略图。这里不解析文档内容，只负责调用系统
//! 生成器并读回 PNG，避免在主进程里引入大型格式解析器。

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use percent_encoding::percent_decode_str;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const QLMANAGE: &str = "/usr/bin/qlmanage";
const PREVIEW_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_EDGE: u32 = 2048;
/// Markdown 和消息附件允许内嵌的图片上限，避免一次 IPC 把超大文件读进 WebView。
pub const MAX_INLINE_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// 图片展示/复制/另存时需要区分的来源。
#[derive(Debug)]
pub enum ImageSource {
    Path(PathBuf),
    Data { bytes: Vec<u8>, mime: String },
    Remote(String),
}

/// 生成系统 Quick Look 缩略图，返回 PNG 字节。
///
/// `size` 是长边像素。超时后终止 qlmanage，避免某个异常生成器拖住预览。
pub fn quicklook_thumbnail(path: &Path, size: u32) -> Result<Vec<u8>> {
    if !path.is_file() {
        bail!("文件不存在或不是普通文件");
    }

    let output_dir = tempfile::tempdir().context("创建系统预览临时目录失败")?;
    let edge = size.clamp(256, MAX_EDGE);
    let mut child = Command::new(QLMANAGE)
        .arg("-t")
        .arg("-s")
        .arg(edge.to_string())
        .arg("-o")
        .arg(output_dir.path())
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("启动系统预览生成器失败")?;

    let deadline = Instant::now() + PREVIEW_TIMEOUT;
    let status = loop {
        match child.try_wait().context("读取系统预览生成器状态失败")? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                bail!("系统预览生成超时");
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    if !status.success() {
        bail!("系统预览生成失败（{status}）");
    }

    let png = find_png(output_dir.path()).context("系统没有生成可显示的预览图")?;
    std::fs::read(&png).context("读取系统预览图失败")
}

fn find_png(directory: &Path) -> Result<PathBuf> {
    let mut matches = Vec::new();
    for entry in std::fs::read_dir(directory).context("读取系统预览临时目录失败")? {
        let path = entry?.path();
        if path.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
        {
            matches.push(path);
        }
    }
    matches.sort();
    matches
        .into_iter()
        .next()
        .context("临时目录中没有 PNG 预览图")
}

/// WebView 能直接解码的图片格式；与前端 `NATIVE_IMAGE_MIMES` 保持一致。
pub fn inline_image_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// 解析 Markdown 或消息里的本地图片地址。
///
/// 支持绝对路径、`~/`、`file://` 和工作区相对路径；相对路径必须以 `base_dir` 为基准。
pub fn resolve_inline_image(base_dir: Option<&str>, source: &str) -> Result<PathBuf> {
    let source = source.trim();
    if source.is_empty() {
        bail!("图片路径为空");
    }
    if source.starts_with("//") {
        bail!("不支持网络图片路径：{source}");
    }
    if let Some(rest) = source.strip_prefix("file://") {
        let rest = rest.strip_prefix("localhost").unwrap_or(rest);
        if !rest.starts_with('/') {
            bail!("file 图片地址不是绝对路径：{source}");
        }
        // 空格先转成合法 URL 字符；query/fragment 由 URL 解析器识别并忽略。
        let encoded = rest.replace(' ', "%20");
        let url = reqwest::Url::parse(&format!("file://{encoded}"))
            .with_context(|| format!("解析图片地址失败：{source}"))?;
        return url
            .to_file_path()
            .map_err(|_| anyhow!("无法把图片地址转成本地路径：{source}"));
    }
    // Markdown 图片目标按 URL 语法处理：query/fragment 不属于文件名，
    // 空格和中文等字符通常已被编码成 `%20` / UTF-8 百分号转义。
    let raw = source
        .find(['?', '#'])
        .map(|index| &source[..index])
        .unwrap_or(source);
    let decoded = percent_decode_str(raw)
        .decode_utf8()
        .with_context(|| format!("图片路径不是有效的 UTF-8：{source}"))?;
    if decoded.is_empty() {
        bail!("图片路径为空");
    }
    let source = decoded.as_ref();
    if let Some(rest) = source.strip_prefix("~/") {
        let home = dirs::home_dir().context("找不到用户主目录")?;
        return Ok(home.join(rest));
    }
    if Path::new(source).is_absolute() {
        return Ok(PathBuf::from(source));
    }
    let base_dir = base_dir.context("相对图片路径缺少基准目录")?;
    Ok(Path::new(base_dir).join(source))
}

/// 读取一张本地图片的原始字节；扩展名、空文件和体积在这里统一校验。
pub fn read_inline_image(path: &Path) -> Result<Vec<u8>> {
    if inline_image_mime(path).is_none() {
        bail!(
            "不支持的图片格式（仅支持 PNG/JPEG/GIF/WebP/SVG/AVIF）：{}",
            path.display()
        );
    }
    let metadata =
        std::fs::metadata(path).with_context(|| format!("读取图片信息失败：{}", path.display()))?;
    if !metadata.is_file() {
        bail!("图片路径不是普通文件：{}", path.display());
    }
    if metadata.len() == 0 {
        bail!("图片文件为空：{}", path.display());
    }
    if metadata.len() > MAX_INLINE_IMAGE_BYTES {
        bail!(
            "图片过大（{:.1} MB），上限 {} MB：{}",
            metadata.len() as f64 / 1024.0 / 1024.0,
            MAX_INLINE_IMAGE_BYTES / 1024 / 1024,
            path.display()
        );
    }
    std::fs::read(path).with_context(|| format!("读取图片失败：{}", path.display()))
}

fn append_chunk_with_limit(bytes: &mut Vec<u8>, chunk: &[u8], limit: u64) -> Result<()> {
    let next = bytes
        .len()
        .checked_add(chunk.len())
        .context("图片大小超出可处理范围")?;
    if next as u64 > limit {
        bail!(
            "图片过大（{:.1} MB），上限 {} MB",
            next as f64 / 1024.0 / 1024.0,
            limit / 1024 / 1024
        );
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

/// 把网络响应分块追加到图片缓冲区，在分配前执行体积上限判断。
pub fn append_inline_image_chunk(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<()> {
    append_chunk_with_limit(bytes, chunk, MAX_INLINE_IMAGE_BYTES)
}

/// 解析消息里可能出现的图片地址：data URL、网络地址或本地路径。
pub fn parse_image_source(base_dir: Option<&str>, source: &str) -> Result<ImageSource> {
    let source = source.trim();
    if source.is_empty() {
        bail!("图片地址为空");
    }
    if let Some(rest) = source.strip_prefix("data:") {
        let (metadata, body) = rest.split_once(',').context("图片 data URL 缺少数据部分")?;
        let mut parts = metadata.split(';');
        let mime = parts.next().unwrap_or("").trim();
        if !mime.starts_with("image/") {
            bail!("data URL 不是图片类型：{mime}");
        }
        if !parts.any(|part| part.eq_ignore_ascii_case("base64")) {
            bail!("仅支持 base64 编码的图片 data URL");
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(body)
            .context("解码图片 data URL 失败")?;
        if bytes.is_empty() {
            bail!("图片 data URL 内容为空");
        }
        if bytes.len() as u64 > MAX_INLINE_IMAGE_BYTES {
            bail!(
                "图片过大（{:.1} MB），上限 {} MB",
                bytes.len() as f64 / 1024.0 / 1024.0,
                MAX_INLINE_IMAGE_BYTES / 1024 / 1024
            );
        }
        return Ok(ImageSource::Data {
            bytes,
            mime: mime.to_string(),
        });
    }
    if source.starts_with("http://") || source.starts_with("https://") {
        return Ok(ImageSource::Remote(source.to_string()));
    }
    if source.starts_with("//") {
        return Ok(ImageSource::Remote(format!("https:{source}")));
    }
    if source.starts_with("blob:") {
        bail!("blob 图片无法直接复制或保存，请使用原始图片地址");
    }
    resolve_inline_image(base_dir, source).map(ImageSource::Path)
}

/// 读取本地或 data URL 图片；网络图片由调用方异步下载后另行处理。
pub fn read_image_source(source: ImageSource) -> Result<(Vec<u8>, String)> {
    match source {
        ImageSource::Path(path) => {
            let mime = inline_image_mime(&path).with_context(|| {
                format!(
                    "不支持的图片格式（仅支持 PNG/JPEG/GIF/WebP/SVG/AVIF）：{}",
                    path.display()
                )
            })?;
            let bytes = read_inline_image(&path)?;
            Ok((bytes, mime.to_string()))
        }
        ImageSource::Data { bytes, mime } => Ok((bytes, mime)),
        ImageSource::Remote(_) => bail!("网络图片需要异步读取"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 只选择临时目录中的_png() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("ignored.txt"), b"x").unwrap();
        let png = directory.path().join("preview.png");
        std::fs::write(&png, b"png").unwrap();
        assert_eq!(find_png(directory.path()).unwrap(), png);
    }

    #[test]
    fn 没有_png_时明确失败() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("preview.txt"), b"x").unwrap();
        assert!(find_png(directory.path())
            .unwrap_err()
            .to_string()
            .contains("没有 PNG"));
    }

    #[test]
    fn 不存在的文件不会启动生成器() {
        let path = std::env::temp_dir().join("deveco-preview-file-that-does-not-exist");
        assert!(quicklook_thumbnail(&path, 1200)
            .unwrap_err()
            .to_string()
            .contains("文件不存在"));
    }

    #[test]
    fn 解析相对和绝对图片路径() {
        assert_eq!(
            resolve_inline_image(Some("/work"), "shots/a.png").unwrap(),
            PathBuf::from("/work/shots/a.png")
        );
        assert_eq!(
            resolve_inline_image(Some("/work"), "shots/a%20b.png?raw=1#preview").unwrap(),
            PathBuf::from("/work/shots/a b.png")
        );
        assert_eq!(
            resolve_inline_image(None, "/tmp/a%20b.png").unwrap(),
            PathBuf::from("/tmp/a b.png")
        );
        assert!(resolve_inline_image(None, "a.png")
            .unwrap_err()
            .to_string()
            .contains("基准目录"));
    }

    #[test]
    fn 解析_file_图片地址() {
        assert_eq!(
            resolve_inline_image(None, "file:///tmp/a%20b.png?raw=1#preview").unwrap(),
            PathBuf::from("/tmp/a b.png")
        );
        assert_eq!(
            resolve_inline_image(None, "file://localhost/tmp/a.png").unwrap(),
            PathBuf::from("/tmp/a.png")
        );
    }

    #[test]
    fn 解析主目录和编码后的图片路径() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            resolve_inline_image(None, "~/shots/a%20b.png?raw=1").unwrap(),
            home.join("shots/a b.png")
        );
    }

    #[test]
    fn 识别可内嵌的图片格式() {
        assert_eq!(inline_image_mime(Path::new("a.PNG")), Some("image/png"));
        assert_eq!(inline_image_mime(Path::new("a.jpeg")), Some("image/jpeg"));
        assert_eq!(inline_image_mime(Path::new("a.svg")), Some("image/svg+xml"));
        assert_eq!(inline_image_mime(Path::new("a.txt")), None);
    }

    #[test]
    fn 读取图片字节并拒绝空文件() {
        let directory = tempfile::tempdir().unwrap();
        let png = directory.path().join("shot.png");
        std::fs::write(&png, b"png-bytes").unwrap();
        assert_eq!(read_inline_image(&png).unwrap(), b"png-bytes");

        let empty = directory.path().join("empty.png");
        std::fs::write(&empty, b"").unwrap();
        assert!(read_inline_image(&empty)
            .unwrap_err()
            .to_string()
            .contains("为空"));
    }

    #[test]
    fn 拒绝超过上限的图片() {
        let directory = tempfile::tempdir().unwrap();
        let huge = directory.path().join("huge.png");
        let file = std::fs::File::create(&huge).unwrap();
        file.set_len(MAX_INLINE_IMAGE_BYTES + 1).unwrap();
        drop(file);
        assert!(read_inline_image(&huge)
            .unwrap_err()
            .to_string()
            .contains("过大"));
    }

    #[test]
    fn 流式图片在超限前停止追加() {
        let mut bytes = b"abc".to_vec();
        append_chunk_with_limit(&mut bytes, b"de", 5).unwrap();
        assert_eq!(bytes, b"abcde");
        assert!(append_chunk_with_limit(&mut bytes, b"f", 5)
            .unwrap_err()
            .to_string()
            .contains("过大"));
        assert_eq!(bytes, b"abcde");
    }

    #[test]
    fn 解析_base64_图片_data_url() {
        let source = parse_image_source(None, "data:image/png;base64,cG5nLWJ5dGVz").unwrap();
        match source {
            ImageSource::Data { bytes, mime } => {
                assert_eq!(bytes, b"png-bytes");
                assert_eq!(mime, "image/png");
            }
            other => panic!("解析成了非 data 来源：{other:?}"),
        }
    }

    #[test]
    fn 拒绝非图片或非_base64_的_data_url() {
        assert!(parse_image_source(None, "data:text/plain;base64,aGVsbG8=")
            .unwrap_err()
            .to_string()
            .contains("不是图片"));
        assert!(parse_image_source(None, "data:image/png,raw")
            .unwrap_err()
            .to_string()
            .contains("base64"));
    }

    #[test]
    fn 识别网络图片并按本地或_data_读取() {
        assert!(matches!(
            parse_image_source(None, "https://example.com/a.png").unwrap(),
            ImageSource::Remote(_)
        ));
        assert!(matches!(
            parse_image_source(None, "//example.com/a.png").unwrap(),
            ImageSource::Remote(_)
        ));
        assert!(parse_image_source(None, "blob:https://example.com/a")
            .unwrap_err()
            .to_string()
            .contains("blob"));

        let directory = tempfile::tempdir().unwrap();
        let png = directory.path().join("shot.png");
        std::fs::write(&png, b"png-bytes").unwrap();
        let parsed =
            parse_image_source(Some(directory.path().to_str().unwrap()), "shot.png").unwrap();
        let (bytes, mime) = read_image_source(parsed).unwrap();
        assert_eq!(bytes, b"png-bytes");
        assert_eq!(mime, "image/png");
    }
}
