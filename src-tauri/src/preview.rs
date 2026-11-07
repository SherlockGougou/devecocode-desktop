//! 文件预览的 macOS 系统能力。
//!
//! 浏览器能直接展示图片、PDF、音视频和文本；Office、iWork、HEIC 等格式
//! 交给系统 Quick Look 生成缩略图。这里不解析文档内容，只负责调用系统
//! 生成器并读回 PNG，避免在主进程里引入大型格式解析器。

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const QLMANAGE: &str = "/usr/bin/qlmanage";
const PREVIEW_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_EDGE: u32 = 2048;

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
}
