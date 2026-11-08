//! 离线版内置 CLI 的提取与数据目录隔离。
//!
//! `.app` 里的资源目录是只读的，而 CLI 的 `vendor/.deveco-cli-entry` 需要一个
//! 绝对路径。因此首次启动时把资源复制到 Application Support，再在副本里写入
//! 入口标记；后续启动直接复用同一版本目录。

use anyhow::{Context, Result};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const RESOURCE_DIR: &str = "bundled-cli";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledCli {
    pub binary: PathBuf,
    pub env: Vec<(String, String)>,
    pub version: String,
}

pub fn prepare(resource_dir: &Path, data_dir: &Path) -> Result<Option<BundledCli>> {
    let resource_root = resource_dir.join(RESOURCE_DIR);
    let manifest_path = resource_root.join("manifest.json");
    if !manifest_path.is_file() {
        return Ok(None);
    }

    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(&manifest_path)
            .with_context(|| format!("读取内置 CLI manifest 失败：{}", manifest_path.display()))?,
    )
    .context("解析内置 CLI manifest 失败")?;
    let version = manifest
        .get("packageVersion")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let version = safe_component(version);
    let runtime_root = data_dir.join("cli-runtime").join(&version);

    if !runtime_root.join("bin/deveco").is_file() {
        if runtime_root.exists() {
            fs::remove_dir_all(&runtime_root)
                .with_context(|| format!("清理不完整的内置 CLI：{}", runtime_root.display()))?;
        }
        let temp_root = data_dir
            .join("cli-runtime")
            .join(format!("{version}.tmp-{}", std::process::id()));
        if temp_root.exists() {
            fs::remove_dir_all(&temp_root)
                .with_context(|| format!("清理临时内置 CLI：{}", temp_root.display()))?;
        }
        copy_dir(&resource_root, &temp_root)
            .with_context(|| format!("复制内置 CLI 到 {}", temp_root.display()))?;
        fs::rename(&temp_root, &runtime_root)
            .with_context(|| format!("提交内置 CLI 目录：{}", runtime_root.display()))?;
    }

    let binary = runtime_root.join("bin/deveco");
    ensure_executable(&binary)?;

    let cli_entry = runtime_root.join("node_modules/@deveco/deveco-cli/cli.js");
    if cli_entry.is_file() {
        fs::create_dir_all(runtime_root.join("vendor"))?;
        fs::write(
            runtime_root.join("vendor/.deveco-cli-entry"),
            format!("{}\n", cli_entry.display()),
        )?;
    } else {
        log::warn!("内置 CLI 未包含 devecocli 入口：{}", cli_entry.display());
    }

    let cli_data = data_dir.join("cli");
    for dir in ["config", "data", "cache", "state"] {
        fs::create_dir_all(cli_data.join(dir))?;
    }

    let env = vec![
        (
            "XDG_CONFIG_HOME".to_string(),
            cli_data.join("config").to_string_lossy().to_string(),
        ),
        (
            "XDG_DATA_HOME".to_string(),
            cli_data.join("data").to_string_lossy().to_string(),
        ),
        (
            "XDG_CACHE_HOME".to_string(),
            cli_data.join("cache").to_string_lossy().to_string(),
        ),
        (
            "XDG_STATE_HOME".to_string(),
            cli_data.join("state").to_string_lossy().to_string(),
        ),
        ("DEVECO_DISABLE_AUTOUPDATE".to_string(), "1".to_string()),
        ("DEVECO_CLI_DISABLE_UPDATE".to_string(), "1".to_string()),
        (
            "DEVECO_BIN_PATH".to_string(),
            binary.to_string_lossy().to_string(),
        ),
    ];

    Ok(Some(BundledCli {
        binary,
        env,
        version,
    }))
}

fn safe_component(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if value.is_empty() {
        "unknown".to_string()
    } else {
        value
    }
}

fn copy_dir(source: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)
        .with_context(|| format!("读取内置 CLI 资源失败：{}", source.display()))?
    {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            copy_dir(&source_path, &target_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &target_path)?;
            fs::set_permissions(&target_path, metadata.permissions())?;
        }
    }
    Ok(())
}

fn ensure_executable(path: &Path) -> Result<()> {
    if !path.is_file() {
        anyhow::bail!("内置 CLI 缺少二进制：{}", path.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(permissions.mode() | 0o111);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 版本目录只保留安全字符() {
        assert_eq!(safe_component("0.2.5"), "0.2.5");
        assert_eq!(safe_component("v0.2.5/beta"), "v0.2.5_beta");
        assert_eq!(safe_component(""), "unknown");
    }

    #[test]
    fn 没有_manifest_时不启用内置_cli() {
        let dir = tempfile::tempdir().unwrap();
        assert!(prepare(dir.path(), dir.path()).unwrap().is_none());
    }

    #[test]
    fn 准备内置_cli并写入入口() {
        let dir = tempfile::tempdir().unwrap();
        let resources = dir.path().join("resources");
        let data = dir.path().join("data");
        let bundled = resources.join(RESOURCE_DIR);
        fs::create_dir_all(bundled.join("bin")).unwrap();
        fs::create_dir_all(bundled.join("node_modules/@deveco/deveco-cli")).unwrap();
        fs::write(bundled.join("bin/deveco"), "#!/bin/sh\n").unwrap();
        fs::write(
            bundled.join("node_modules/@deveco/deveco-cli/cli.js"),
            "#!/usr/bin/env node\n",
        )
        .unwrap();
        fs::write(
            bundled.join("manifest.json"),
            r#"{"packageVersion":"0.2.5"}"#,
        )
        .unwrap();

        let cli = prepare(&resources, &data).unwrap().unwrap();
        assert!(cli.binary.is_file());
        assert!(data.join("cli/config").is_dir());
        assert!(data.join("cli/data").is_dir());
        assert!(cli.env.iter().any(|(key, _)| key == "XDG_DATA_HOME"));
        let marker = data.join("cli-runtime/0.2.5/vendor/.deveco-cli-entry");
        assert!(marker.is_file());
        assert!(fs::read_to_string(marker)
            .unwrap()
            .contains("deveco-cli/cli.js"));
    }
}
