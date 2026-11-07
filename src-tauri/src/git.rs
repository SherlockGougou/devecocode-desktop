//! 当前工作区的 Git 状态与显式提交/推送。
//!
//! Git 操作放在 Rust 侧：前端不直接持有凭据、不拼接 shell 命令，提交范围也
//! 始终限制在当前工作区目录内。查询命令和写操作都使用显式参数，不经过 shell。

use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const COMMIT_TIMEOUT: Duration = Duration::from_secs(60);
const PUSH_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_OUTPUT_CHARS: usize = 8_000;
const MAX_UNTRACKED_STATS: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    /// added / modified / deleted / untracked / unmerged
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoState {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub remote: Option<String>,
    pub detached: bool,
    pub files: Vec<GitFileStatus>,
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub additions: usize,
    pub deletions: usize,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub commit: Option<String>,
}

#[derive(Debug)]
struct GitOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl GitOutput {
    fn success(&self) -> bool {
        self.status.success()
    }

    fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).to_string()
    }

    fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).to_string()
    }
}

fn git_program() -> &'static str {
    // Finder 启动的 GUI 通常也有 /usr/bin；保留 PATH 优先，便于用户使用
    // Homebrew/自定义 git（凭据助手、SSH 配置等都在用户自己的 git 上）。
    if std::env::var_os("PATH").is_some() {
        "git"
    } else {
        "/usr/bin/git"
    }
}

async fn run_git(
    directory: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<GitOutput, String> {
    let mut command = Command::new(git_program());
    command
        .arg("--no-pager")
        .args(args)
        .current_dir(directory)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = command
        .spawn()
        .map_err(|err| format!("无法启动 git：{err}"))?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(GitOutput {
            status: output.status,
            stdout: output.stdout,
            stderr: output.stderr,
        }),
        Ok(Err(err)) => Err(format!("执行 git 失败：{err}")),
        Err(_) => Err(format!(
            "git 命令超时（{} 秒）",
            timeout.as_secs()
        )),
    }
}

fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect::<String>() + "…"
}

fn git_error(action: &str, output: &GitOutput) -> String {
    let detail = clip(output.stderr_text().trim(), MAX_OUTPUT_CHARS);
    if detail.is_empty() {
        format!("{action}失败（{}）", output.status)
    } else {
        format!("{action}失败：{detail}")
    }
}

fn lines(text: &str) -> Vec<&str> {
    text.lines().map(str::trim).filter(|line| !line.is_empty()).collect()
}

fn parse_status_files(raw: &str) -> Vec<GitFileStatus> {
    raw.split('\0')
        .filter(|item| item.len() >= 3)
        .filter_map(|item| {
            let code = &item[..2];
            let path = item[3..].trim_end_matches('\r');
            if path.is_empty() {
                return None;
            }
            let untracked = code == "??";
            let staged = !untracked && !code.starts_with(' ');
            let unstaged = untracked || code.chars().nth(1).is_some_and(|value| value != ' ');
            let status = if untracked {
                "untracked"
            } else if code.contains('U') {
                "unmerged"
            } else if code.contains('A') {
                "added"
            } else if code.contains('D') {
                "deleted"
            } else {
                "modified"
            };
            Some(GitFileStatus {
                path: path.to_string(),
                status: status.to_string(),
                staged,
                unstaged,
            })
        })
        .collect()
}

fn parse_numstat(text: &str) -> (usize, usize) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in text.lines() {
        let mut parts = line.splitn(3, '\t');
        let Some(add) = parts.next() else {
            continue;
        };
        let Some(del) = parts.next() else {
            continue;
        };
        if add == "-" || del == "-" {
            continue;
        }
        additions += add.parse::<usize>().unwrap_or(0);
        deletions += del.parse::<usize>().unwrap_or(0);
    }
    (additions, deletions)
}

fn parse_ahead_behind(text: &str) -> (usize, usize) {
    let values = text
        .split_whitespace()
        .filter_map(|value| value.parse::<usize>().ok())
        .collect::<Vec<_>>();
    if values.len() >= 2 {
        (values[0], values[1])
    } else {
        (0, 0)
    }
}

async fn read_state(directory: &str) -> Result<GitRepoState, String> {
    let path = Path::new(directory);
    if !path.is_dir() {
        return Err(format!("工作区不存在或不可访问：{directory}"));
    }

    let top = run_git(path, &["rev-parse", "--show-toplevel"], QUERY_TIMEOUT).await?;
    if !top.success() {
        return Ok(GitRepoState::default());
    }
    let root = top.stdout_text().trim().to_string();

    let branch_result = run_git(
        path,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        QUERY_TIMEOUT,
    )
    .await?;
    let branch = branch_result
        .success()
        .then(|| branch_result.stdout_text().trim().to_string())
        .filter(|value| !value.is_empty());
    let detached = branch.is_none();

    let status = run_git(
        path,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
            "--",
            ".",
        ],
        QUERY_TIMEOUT,
    )
    .await?;
    if !status.success() {
        return Err(git_error("读取 Git 状态", &status));
    }
    let files = parse_status_files(&status.stdout_text());
    let untracked = files.iter().filter(|file| file.status == "untracked").count();
    let staged = files.iter().filter(|file| file.staged).count();
    let unstaged = files.iter().filter(|file| file.unstaged).count();

    let mut additions = 0;
    let mut deletions = 0;
    for args in [
        &["diff", "--numstat", "--no-ext-diff", "--no-renames", "--", "."][..],
        &[
            "diff",
            "--cached",
            "--numstat",
            "--no-ext-diff",
            "--no-renames",
            "--",
            ".",
        ][..],
    ] {
        let output = run_git(path, args, QUERY_TIMEOUT).await?;
        if output.success() {
            let (add, del) = parse_numstat(&output.stdout_text());
            additions += add;
            deletions += del;
        }
    }

    // 未跟踪文件没有 HEAD 对象可比较；逐个用 no-index 统计文本行，
    // 避免把新文件显示成 +0 -0。命令数有上限，避免大目录拖慢概览。
    for file in files
        .iter()
        .filter(|file| file.status == "untracked")
        .take(MAX_UNTRACKED_STATS)
    {
        let output = run_git(
            path,
            &["diff", "--no-index", "--numstat", "--", "/dev/null", &file.path],
            Duration::from_secs(10),
        )
        .await?;
        // `git diff --no-index` 有差异时退出码为 1，输出仍然是有效统计。
        let (add, del) = parse_numstat(&output.stdout_text());
        additions += add;
        deletions += del;
    }

    let upstream_result = run_git(
        path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
        ],
        QUERY_TIMEOUT,
    )
    .await?;
    let upstream = upstream_result
        .success()
        .then(|| upstream_result.stdout_text().trim().to_string())
        .filter(|value| !value.is_empty());

    let (ahead, behind) = if upstream.is_some() {
        let result = run_git(
            path,
            &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
            QUERY_TIMEOUT,
        )
        .await?;
        if result.success() {
            parse_ahead_behind(&result.stdout_text())
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    let remotes_result = run_git(path, &["remote"], QUERY_TIMEOUT).await?;
    let remotes = if remotes_result.success() {
        lines(&remotes_result.stdout_text())
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let remote = if remotes.iter().any(|remote| remote == "origin") {
        Some("origin".to_string())
    } else if remotes.len() == 1 {
        Some(remotes[0].clone())
    } else {
        None
    };

    Ok(GitRepoState {
        is_repo: true,
        root: Some(root),
        branch: branch.clone(),
        upstream,
        remote,
        detached,
        files,
        staged,
        unstaged,
        untracked,
        additions,
        deletions,
        ahead,
        behind,
    })
}

/// 读取当前工作区的 Git 状态；非 Git 目录返回 `isRepo = false`，不作为异常。
#[tauri::command]
pub async fn git_state(directory: String) -> Result<GitRepoState, String> {
    read_state(&directory).await
}

/// 暂存当前工作区全部改动并提交。不会自动推送，也不会 amend。
#[tauri::command]
pub async fn git_commit(
    directory: String,
    message: String,
) -> Result<GitCommandResult, String> {
    let path = Path::new(&directory);
    let message = message.trim();
    if message.is_empty() {
        return Err("提交信息不能为空".into());
    }
    let state = read_state(&directory).await?;
    if !state.is_repo {
        return Err("当前工作区不是 Git 仓库".into());
    }
    if state.detached {
        return Err("当前处于 detached HEAD，无法提交".into());
    }
    if state.files.is_empty() {
        return Err("当前没有可提交的改动".into());
    }

    let add = run_git(path, &["add", "-A", "--", "."], COMMIT_TIMEOUT).await?;
    if !add.success() {
        return Err(git_error("暂存改动", &add));
    }

    let staged = run_git(
        path,
        &["diff", "--cached", "--quiet", "--", "."],
        QUERY_TIMEOUT,
    )
    .await?;
    match staged.status.code() {
        Some(0) => return Err("当前没有可提交的改动".into()),
        Some(1) => {}
        _ => return Err(git_error("检查暂存内容", &staged)),
    }

    let commit = run_git(
        path,
        &["commit", "-m", message],
        COMMIT_TIMEOUT,
    )
    .await?;
    if !commit.success() {
        return Err(git_error("提交", &commit));
    }
    let hash = run_git(path, &["rev-parse", "--short", "HEAD"], QUERY_TIMEOUT)
        .await
        .ok()
        .filter(|output| output.success())
        .map(|output| output.stdout_text().trim().to_string())
        .filter(|value| !value.is_empty());

    Ok(GitCommandResult {
        stdout: clip(&commit.stdout_text(), MAX_OUTPUT_CHARS),
        stderr: clip(&commit.stderr_text(), MAX_OUTPUT_CHARS),
        commit: hash,
    })
}

/// 推送当前分支。优先使用 upstream；没有 upstream 时回退到 origin。
#[tauri::command]
pub async fn git_push(directory: String) -> Result<GitCommandResult, String> {
    let path = Path::new(&directory);
    let state = read_state(&directory).await?;
    if !state.is_repo {
        return Err("当前工作区不是 Git 仓库".into());
    }
    if state.detached || state.branch.is_none() {
        return Err("当前处于 detached HEAD，无法推送".into());
    }
    let branch = state.branch.as_deref().unwrap_or_default();

    let output = if state.upstream.is_some() {
        run_git(path, &["push"], PUSH_TIMEOUT).await?
    } else if let Some(remote) = state.remote.as_deref() {
        run_git(
            path,
            &["push", "-u", remote, branch],
            PUSH_TIMEOUT,
        )
        .await?
    } else {
        return Err("当前分支没有 upstream，且找不到可用的 origin 远端".into());
    };

    if !output.success() {
        return Err(git_error("推送", &output));
    }

    Ok(GitCommandResult {
        stdout: clip(&output.stdout_text(), MAX_OUTPUT_CHARS),
        stderr: clip(&output.stderr_text(), MAX_OUTPUT_CHARS),
        commit: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn run(cwd: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("启动 git 失败");
        assert!(
            output.status.success(),
            "git {:?} 失败：{}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), &["init", "-b", "main"]);
        run(dir.path(), &["config", "user.name", "DevEco Test"]);
        run(dir.path(), &["config", "user.email", "deveco-test@example.invalid"]);
        fs::write(dir.path().join("tracked.txt"), "old\n").unwrap();
        run(dir.path(), &["add", "tracked.txt"]);
        run(dir.path(), &["commit", "-m", "initial"]);
        dir
    }

    fn bare_remote(root: &Path) -> PathBuf {
        let remote = root.join("remote.git");
        let output = std::process::Command::new("git")
            .args(["init", "--bare", remote.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(output.status.success());
        remote
    }

    #[tokio::test]
    async fn 非仓库返回空状态() {
        let dir = tempfile::tempdir().unwrap();
        let state = read_state(dir.path().to_str().unwrap()).await.unwrap();
        assert!(!state.is_repo);
        assert!(state.files.is_empty());
    }

    #[tokio::test]
    async fn 统计暂存未暂存和未跟踪文件() {
        let dir = init_repo();
        fs::write(dir.path().join("tracked.txt"), "new\n").unwrap();
        fs::write(dir.path().join("staged.txt"), "staged\n").unwrap();
        run(dir.path(), &["add", "staged.txt"]);
        fs::write(dir.path().join("untracked.txt"), "untracked\n").unwrap();

        let state = read_state(dir.path().to_str().unwrap()).await.unwrap();
        assert!(state.is_repo);
        assert_eq!(state.branch.as_deref(), Some("main"));
        assert_eq!(state.files.len(), 3);
        assert_eq!(state.staged, 1);
        assert_eq!(state.unstaged, 2);
        assert_eq!(state.untracked, 1);
        assert!(state.additions >= 3);
        assert!(state.deletions >= 1);
    }

    #[tokio::test]
    async fn 提交会包含当前工作区全部改动() {
        let dir = init_repo();
        fs::write(dir.path().join("tracked.txt"), "new\n").unwrap();
        fs::write(dir.path().join("new.txt"), "new file\n").unwrap();

        let result = git_commit(
            dir.path().to_str().unwrap().to_string(),
            "test: include all changes".into(),
        )
        .await
        .unwrap();
        assert!(result.commit.is_some());

        let state = read_state(dir.path().to_str().unwrap()).await.unwrap();
        assert!(state.files.is_empty());
        let log = std::process::Command::new("git")
            .args(["log", "-1", "--format=%s"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&log.stdout).trim(),
            "test: include all changes"
        );
    }

    #[tokio::test]
    async fn 没有改动时拒绝提交() {
        let dir = init_repo();
        let err = git_commit(
            dir.path().to_str().unwrap().to_string(),
            "empty".into(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("没有可提交"));
    }

    #[tokio::test]
    async fn detached_head拒绝提交和推送() {
        let dir = init_repo();
        run(dir.path(), &["checkout", "--detach"]);
        let commit = git_commit(
            dir.path().to_str().unwrap().to_string(),
            "detached".into(),
        )
        .await
        .unwrap_err();
        assert!(commit.contains("detached HEAD"));
        let push = git_push(dir.path().to_str().unwrap().to_string())
            .await
            .unwrap_err();
        assert!(push.contains("detached HEAD"));
    }

    #[tokio::test]
    async fn 提交_hook_失败不会产生提交() {
        let dir = init_repo();
        fs::write(dir.path().join("tracked.txt"), "new\n").unwrap();
        let hook = dir.path().join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&hook).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&hook, permissions).unwrap();
        }

        let err = git_commit(
            dir.path().to_str().unwrap().to_string(),
            "should fail".into(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("提交失败"));
        let log = std::process::Command::new("git")
            .args(["log", "-1", "--format=%s"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&log.stdout).trim(), "initial");
    }

    #[tokio::test]
    async fn 没有_upstream_时回退到_origin_并设置追踪() {
        let dir = init_repo();
        let remote_root = tempfile::tempdir().unwrap();
        let remote = bare_remote(remote_root.path());
        run(
            dir.path(),
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        fs::write(dir.path().join("tracked.txt"), "new\n").unwrap();
        git_commit(
            dir.path().to_str().unwrap().to_string(),
            "test: push fallback".into(),
        )
        .await
        .unwrap();

        let result = git_push(dir.path().to_str().unwrap().to_string())
            .await
            .unwrap();
        assert!(result.stderr.contains("main") || !result.stdout.is_empty());
        let state = read_state(dir.path().to_str().unwrap()).await.unwrap();
        assert_eq!(state.upstream.as_deref(), Some("origin/main"));
        assert_eq!(state.ahead, 0);
    }

    #[tokio::test]
    async fn 没有远端时推送报可读错误() {
        let dir = init_repo();
        let err = git_push(dir.path().to_str().unwrap().to_string())
            .await
            .unwrap_err();
        assert!(err.contains("upstream") && err.contains("origin"));
    }
}
