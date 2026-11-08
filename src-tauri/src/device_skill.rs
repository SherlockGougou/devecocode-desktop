//! 内嵌的 Agent 设备 skill。
//!
//! 桌面端把 skill 写入 CLI 的全局 skills 目录，并在 serve 环境中注入 `HDC`。
//! 只覆盖带管理标记的目录，不覆盖用户自己创建或修改过的同名 skill。

use std::fs;
use std::path::{Path, PathBuf};

const SKILL_NAME: &str = "deveco-desktop-device";
const SKILL_BODY: &str = include_str!("../skills/deveco-desktop-device/SKILL.md");
const MARKER_NAME: &str = ".deveco-desktop-managed";
const MARKER_BODY: &str = "managed-by=devEco-code-desktop\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallOutcome {
    Installed(PathBuf),
    Unchanged(PathBuf),
    SkippedExisting(PathBuf),
}

/// 将内嵌 skill 写入 CLI 实际使用的配置目录。
///
/// Offline 版会把 `XDG_CONFIG_HOME` 指向应用数据目录；普通版通常使用 `~/.config`。
/// 这里不修改 `deveco.jsonc`，只写入 CLI 默认扫描的 `skills/<name>/SKILL.md`。
pub fn install(env: &[(String, String)]) -> Result<InstallOutcome, String> {
    let config_dir = config_dir_with_env(env).ok_or_else(|| "无法定位 CLI 配置目录".to_string())?;
    install_in(&config_dir)
}

pub fn install_in(config_dir: &Path) -> Result<InstallOutcome, String> {
    let skill_dir = config_dir.join("skills").join(SKILL_NAME);
    if let Ok(metadata) = fs::symlink_metadata(&skill_dir) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Ok(InstallOutcome::SkippedExisting(skill_dir));
        }
        if !skill_dir.join(MARKER_NAME).is_file() {
            return Ok(InstallOutcome::SkippedExisting(skill_dir));
        }
    }

    fs::create_dir_all(&skill_dir).map_err(|err| format!("创建设备 skill 目录失败：{err}"))?;
    let marker = skill_dir.join(MARKER_NAME);
    let skill_file = skill_dir.join("SKILL.md");

    if read_text(&marker).as_deref() == Some(MARKER_BODY)
        && read_text(&skill_file).as_deref() == Some(SKILL_BODY)
    {
        return Ok(InstallOutcome::Unchanged(skill_dir));
    }

    write_atomic(&marker, MARKER_BODY)?;
    write_atomic(&skill_file, SKILL_BODY)?;
    Ok(InstallOutcome::Installed(skill_dir))
}

fn config_dir_with_env(env: &[(String, String)]) -> Option<PathBuf> {
    config_dir_from(
        env_value(env, "DEVECO_CONFIG_DIR"),
        env_value(env, "XDG_CONFIG_HOME"),
        env_value(env, "HOME"),
    )
}

fn config_dir_from(
    deveco_config: Option<String>,
    xdg_config: Option<String>,
    home: Option<String>,
) -> Option<PathBuf> {
    if let Some(value) = deveco_config {
        return Some(PathBuf::from(value));
    }
    if let Some(value) = xdg_config {
        return Some(PathBuf::from(value).join("deveco"));
    }
    home.map(PathBuf::from)
        .or_else(dirs::home_dir)
        .map(|home| home.join(".config").join("deveco"))
}

fn env_value(env: &[(String, String)], key: &str) -> Option<String> {
    env.iter()
        .rev()
        .find(|(name, _)| name.as_str() == key)
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var(key).ok())
}

fn read_text(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法确定写入目录：{}", path.display()))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("skill");
    let temp = parent.join(format!(".{name}.tmp-{}", std::process::id()));
    fs::write(&temp, contents).map_err(|err| format!("写入设备 skill 失败：{err}"))?;
    if let Err(err) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("提交设备 skill 失败：{err}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn 内嵌_skill_frontmatter_完整() {
        assert!(SKILL_BODY.starts_with("---\n"));
        assert!(SKILL_BODY.contains("\nname: deveco-desktop-device\n"));
        assert!(SKILL_BODY.contains("\ndescription: \""));
        assert!(SKILL_BODY.contains("\n## 2. 定位 HDC 与选择设备\n"));
    }

    #[test]
    fn 配置目录优先使用显式环境变量() {
        assert_eq!(
            config_dir_from(
                Some("/tmp/deveco".into()),
                Some("/tmp/xdg".into()),
                Some("/tmp/home".into())
            )
            .unwrap(),
            PathBuf::from("/tmp/deveco")
        );
    }

    #[test]
    fn 配置目录支持_xdg_和_home() {
        assert_eq!(
            config_dir_from(None, Some("/tmp/xdg".into()), Some("/tmp/home".into())).unwrap(),
            PathBuf::from("/tmp/xdg/deveco")
        );
        assert_eq!(
            config_dir_from(None, None, Some("/tmp/home".into())).unwrap(),
            PathBuf::from("/tmp/home/.config/deveco")
        );
    }

    #[test]
    fn 首次安装写入标记并可重复执行() {
        let dir = tempfile::tempdir().unwrap();
        let first = install_in(dir.path()).unwrap();
        let skill_dir = dir.path().join("skills").join(SKILL_NAME);
        assert_eq!(first, InstallOutcome::Installed(skill_dir.clone()));
        assert!(skill_dir.join("SKILL.md").is_file());
        assert!(skill_dir.join(MARKER_NAME).is_file());

        let second = install_in(dir.path()).unwrap();
        assert_eq!(second, InstallOutcome::Unchanged(skill_dir));
    }

    #[test]
    fn 不覆盖没有管理标记的同名目录() {
        let dir = tempfile::tempdir().unwrap();
        let skill_dir = dir.path().join("skills").join(SKILL_NAME);
        fs::create_dir_all(&skill_dir).unwrap();
        let mut file = fs::File::create(skill_dir.join("SKILL.md")).unwrap();
        file.write_all(b"user skill").unwrap();

        let outcome = install_in(dir.path()).unwrap();
        assert_eq!(outcome, InstallOutcome::SkippedExisting(skill_dir.clone()));
        assert_eq!(
            fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
            "user skill"
        );
    }

    #[test]
    fn 已管理的内容变化时自动更新() {
        let dir = tempfile::tempdir().unwrap();
        install_in(dir.path()).unwrap();
        let skill_file = dir.path().join("skills").join(SKILL_NAME).join("SKILL.md");
        fs::write(&skill_file, "old body").unwrap();

        assert!(matches!(
            install_in(dir.path()).unwrap(),
            InstallOutcome::Installed(_)
        ));
        assert_eq!(fs::read_to_string(skill_file).unwrap(), SKILL_BODY);
    }
}
