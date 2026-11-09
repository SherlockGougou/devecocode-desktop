//! 定位本机的 `deveco` CLI。
//!
//! 关键背景：从 Finder / LaunchServices 启动的 GUI 进程，`PATH` 只有
//! `/usr/bin:/bin:/usr/sbin:/sbin`，因此不能依赖 `which deveco`。这里按
//! 「显式配置 → 环境变量 → 常见安装路径 → login shell → PATH」的顺序探测。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// `deveco --version` 的等待上限。
///
/// 实测：另一个 serve 实例占着 CLI 数据锁时，`--version` 会一直不返回。
/// 探测版本只是「锦上添花」，不能因为没有超时把整个启动流程卡死。
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

pub const ENV_OVERRIDE: &str = "DEVECO_BIN_PATH";

/// CLI 子进程的 PATH 补全。
///
/// npm / Homebrew 安装的 `deveco` 是 `#!/usr/bin/env node` 启动器。从 Finder
/// 启动的应用只有 `/usr/bin:/bin:/usr/sbin:/sbin`，找不到 Homebrew 或版本管理器
/// 里的 `node`，`deveco serve` 会立刻以 127 退出且不产生 stdout。这里把 CLI
/// 自身目录和常见安装目录并回 PATH；调用方显式传入的 env 仍然优先。
pub fn child_path(bin: &Path) -> Option<std::ffi::OsString> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(parent) = bin.parent() {
        dirs.push(parent.to_path_buf());
    }
    // 用户已有的 PATH 优先于兜底目录，避免把 nvm / asdf 里的 node
    // 悄悄换成 Homebrew 版本。
    if let Some(existing) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&existing));
    }
    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".local/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".bun/bin",
            ".asdf/shims",
            ".mise/shims",
            "Library/pnpm",
            ".yarn/bin",
        ] {
            dirs.push(home.join(rel));
        }
        // 版本管理器把 node 和全局包放在同一个版本目录下；只加常见目录
        // 不够，用户可能把 deveco 装在 nvm / fnm 的某个版本里。
        for root in version_manager_dirs(&home) {
            dirs.push(root.join("bin"));
            dirs.push(root.join("installation/bin"));
        }
    }
    for dir in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        dirs.push(PathBuf::from(dir));
    }

    let mut seen = std::collections::HashSet::new();
    let unique: Vec<PathBuf> = dirs
        .into_iter()
        .filter(|dir| !dir.as_os_str().is_empty() && seen.insert(dir.clone()))
        .collect();
    std::env::join_paths(unique).ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliInfo {
    pub path: PathBuf,
    pub version: Option<Version>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("未找到 deveco CLI。已尝试：{tried:?}")]
    NotFound { tried: Vec<PathBuf> },
    #[error("deveco CLI 无法执行：{path}（{source}）")]
    NotExecutable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("读取 deveco 版本失败")]
    VersionUnavailable,
    #[error("deveco --version 超过 {0:?} 没有返回")]
    VersionTimeout(Duration),
}

/// 解析 `deveco --version` 的输出，容忍 `v` 前缀与预发布后缀。
pub fn parse_version(raw: &str) -> Option<Version> {
    let line = raw.lines().map(str::trim).find(|l| {
        !l.is_empty()
            && l.chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit() || c == 'v')
    })?;
    let cleaned = line.trim_start_matches('v');
    let core = cleaned
        .split(|c: char| c == '-' || c == '+' || c.is_whitespace())
        .next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().unwrap_or(0);
    Some(Version {
        major,
        minor,
        patch,
    })
}

/// 我们依赖的是 opencode 系的 v1 契约（/session、/global/event、/permission）。
/// 低于 0.2.0 时提示用户升级，但不阻断——契约更老也更简单。
pub fn is_below_supported(v: Version) -> bool {
    v < Version {
        major: 0,
        minor: 2,
        patch: 0,
    }
}

/// 候选路径。顺序即优先级，先本机包管理器，再用户级安装。
pub fn probe_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(p) = std::env::var_os(ENV_OVERRIDE) {
        out.push(PathBuf::from(p));
    }
    if let Some(home) = dirs::home_dir() {
        out.push(home.join(".local/bin/deveco"));
        out.push(home.join(".npm-global/bin/deveco"));
        out.push(home.join(".volta/bin/deveco"));
        out.push(home.join(".bun/bin/deveco"));
        for dir in version_manager_dirs(&home) {
            out.push(dir.join("bin/deveco"));
            out.push(dir.join("installation/bin/deveco"));
        }
    }
    out.push(PathBuf::from("/opt/homebrew/bin/deveco"));
    out.push(PathBuf::from("/usr/local/bin/deveco"));
    out.push(PathBuf::from("/usr/bin/deveco"));
    out
}

/// nvm / fnm 的多版本目录，新版本优先。
fn version_manager_dirs(home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in [".nvm/versions/node", ".fnm/node-versions"] {
        if let Ok(entries) = std::fs::read_dir(home.join(root)) {
            let mut dirs: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
            dirs.sort();
            out.extend(dirs.into_iter().rev());
        }
    }
    out
}

fn is_runnable(path: &Path) -> bool {
    path.is_file()
}

/// 通过 login shell 解析，覆盖 zsh 的 .zprofile / bash 的 .bash_profile 里的 PATH 设置。
pub fn from_login_shell() -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    if !Path::new(&shell).exists() {
        return None;
    }
    let output = Command::new(&shell)
        .args(["-lic", "command -v deveco"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .map(str::trim)
        // login shell 可能打印欢迎语，只接受绝对路径
        .find(|line| line.starts_with('/') && line.ends_with("/deveco"))
        .map(PathBuf::from)
}

fn from_path_env() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("deveco"))
        .find(|candidate| is_runnable(candidate))
}

pub fn read_version(path: &Path) -> Result<Version, CliError> {
    read_version_with_env(path, &[])
}

pub fn read_version_with_env(path: &Path, env: &[(String, String)]) -> Result<Version, CliError> {
    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path_env) = child_path(path) {
        command.env("PATH", path_env);
    }
    // 显式 env 最后应用，允许调用方覆盖 PATH（与 spawn 的优先级保持一致）
    command.envs(env.iter().map(|(key, value)| (key, value)));
    // 独立进程组：`deveco` 是 node launcher，超时只杀 launcher 会留下 161MB 的
    // 原生二进制继续占着 CLI 数据库（实测会让下一次探测直接卡死）。
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|source| CliError::NotExecutable {
        path: path.to_path_buf(),
        source,
    })?;

    let deadline = Instant::now() + VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                // 卡住的探测进程必须整组收掉，否则它自己会变成新的孤儿占住资源
                let pid = child.id();
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
                let _ = child.wait();
                return Err(CliError::VersionTimeout(VERSION_TIMEOUT));
            }
            Err(_) => return Err(CliError::VersionUnavailable),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|_| CliError::VersionUnavailable)?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    parse_version(&text).ok_or(CliError::VersionUnavailable)
}

/// 按优先级解析 CLI。`explicit` 来自用户配置。
pub fn discover(explicit: Option<&Path>) -> Result<CliInfo, CliError> {
    discover_with_env(explicit, &[])
}

pub fn discover_with_env(
    explicit: Option<&Path>,
    env: &[(String, String)],
) -> Result<CliInfo, CliError> {
    let mut tried: Vec<PathBuf> = Vec::new();

    let mut ordered: Vec<PathBuf> = Vec::new();
    if let Some(p) = explicit {
        ordered.push(p.to_path_buf());
    }
    ordered.extend(probe_candidates());

    for candidate in ordered {
        tried.push(candidate.clone());
        if is_runnable(&candidate) {
            let version = read_version_with_env(&candidate, env).ok();
            return Ok(CliInfo {
                path: candidate,
                version,
            });
        }
    }

    for candidate in [from_login_shell(), from_path_env()].into_iter().flatten() {
        tried.push(candidate.clone());
        if is_runnable(&candidate) {
            let version = read_version_with_env(&candidate, env).ok();
            return Ok(CliInfo {
                path: candidate,
                version,
            });
        }
    }

    Err(CliError::NotFound { tried })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析标准版本号() {
        assert_eq!(
            parse_version("0.2.5\n"),
            Some(Version {
                major: 0,
                minor: 2,
                patch: 5
            })
        );
    }

    #[test]
    fn 解析带前缀与预发布后缀的版本号() {
        assert_eq!(
            parse_version("v0.3.0-stable"),
            Some(Version {
                major: 0,
                minor: 3,
                patch: 0
            })
        );
        assert_eq!(
            parse_version("1.2.3-rc.1"),
            Some(Version {
                major: 1,
                minor: 2,
                patch: 3
            })
        );
    }

    #[test]
    fn 无法解析版本号时返回空() {
        assert_eq!(parse_version("command not found"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn 候选路径包含常见安装位置() {
        let candidates = probe_candidates();
        assert!(candidates
            .iter()
            .any(|p| p == Path::new("/opt/homebrew/bin/deveco")));
        assert!(candidates
            .iter()
            .any(|p| p == Path::new("/usr/local/bin/deveco")));
    }

    #[test]
    fn 低于0_2_0被标记为过旧() {
        assert!(is_below_supported(Version {
            major: 0,
            minor: 1,
            patch: 9
        }));
        assert!(!is_below_supported(Version {
            major: 0,
            minor: 2,
            patch: 0
        }));
    }

    #[test]
    fn 子进程_path_包含_cli_目录与常见安装位置() {
        let path = child_path(Path::new("/opt/homebrew/bin/deveco")).expect("构建 PATH");
        let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();

        assert_eq!(dirs.first(), Some(&PathBuf::from("/opt/homebrew/bin")));
        assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
        assert!(dirs.contains(&PathBuf::from("/opt/local/bin")));
        assert!(dirs.contains(&PathBuf::from("/usr/bin")));
        if let Some(home) = dirs::home_dir() {
            assert!(dirs.contains(&home.join(".asdf/shims")));
        }
        assert_eq!(
            dirs.iter()
                .filter(|dir| dir.as_path() == Path::new("/opt/homebrew/bin"))
                .count(),
            1,
            "重复目录应被去掉"
        );
        assert_eq!(
            dirs.iter()
                .filter(|dir| dir.as_path() == Path::new("/usr/bin"))
                .count(),
            1,
            "现有 PATH 与兜底目录重复时应去重"
        );
    }
}
