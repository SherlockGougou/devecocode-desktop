//! CLI 配置读写：全局 / 当前工作区、JSONC 解析、密钥脱敏、备份与重载。
//!
//! 前端不直接接触配置文件路径。读取时返回脱敏文本；保存时由 Rust 校验
//! 基线和 JSONC 语法，写入后触发 CLI 实例重载，失败则恢复备份。

use anyhow::{anyhow, bail, Context, Result};
use jsonc_parser::ast::{Object, Value as AstValue};
use jsonc_parser::common::Range;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::http;

const CONFIG_TIMEOUT: Duration = Duration::from_secs(20);
const RELOAD_TIMEOUT: Duration = Duration::from_secs(20);
const BACKUP_LIMIT: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Global,
    Project,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PathSegment {
    Key(String),
    Index(usize),
}

impl PathSegment {
    fn key(&self) -> Option<&str> {
        match self {
            Self::Key(value) => Some(value),
            Self::Index(_) => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SecretInfo {
    pub path: Vec<PathSegment>,
    pub label: String,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigSnapshot {
    pub scope: Scope,
    pub path: String,
    pub exists: bool,
    pub hash: String,
    pub text: String,
    pub value: Value,
    pub secrets: Vec<SecretInfo>,
    pub parse_error: Option<String>,
    /// 文本中是否仍包含明文密钥。解析失败时可能为 true。
    pub redacted: bool,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigSources {
    pub config_dir: String,
    pub global_path: String,
    pub project_config_dir: Option<String>,
    pub project_path: Option<String>,
    pub worktree: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveRequest {
    pub scope: Scope,
    pub directory: Option<String>,
    pub base_hash: String,
    pub text: String,
    #[serde(default)]
    pub reveal_secrets: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SaveResult {
    pub snapshot: ConfigSnapshot,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BackupRestoreRequest {
    pub scope: Scope,
    pub directory: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupInfo {
    pub name: String,
    pub path: String,
    pub updated_at: u64,
    pub size: u64,
}

struct Paths {
    config_dir: PathBuf,
    project_config_dir: Option<PathBuf>,
    worktree: Option<PathBuf>,
}

#[derive(Debug)]
struct Target {
    path: PathBuf,
}

pub async fn sources(
    base: &str,
    auth: Option<&str>,
    directory: Option<&str>,
) -> Result<ConfigSources> {
    let paths = resolve_paths(base, auth, directory).await?;
    let global = resolve_target(&paths, Scope::Global)?;
    let has_project = directory.is_some();
    let project = if has_project {
        Some(resolve_target(&paths, Scope::Project)?)
    } else {
        None
    };
    Ok(ConfigSources {
        config_dir: path_text(&paths.config_dir),
        global_path: path_text(&global.path),
        project_config_dir: if has_project {
            paths.project_config_dir.as_deref().map(path_text)
        } else {
            None
        },
        project_path: project.as_ref().map(|target| path_text(&target.path)),
        worktree: if has_project {
            paths.worktree.as_deref().map(path_text)
        } else {
            None
        },
    })
}

pub async fn read(
    base: &str,
    auth: Option<&str>,
    scope: Scope,
    directory: Option<&str>,
    reveal_secrets: bool,
) -> Result<ConfigSnapshot> {
    require_project_directory(scope, directory)?;
    let paths = resolve_paths(base, auth, directory).await?;
    let target = resolve_target(&paths, scope)?;
    read_target(scope, &target.path, reveal_secrets)
}

pub async fn save(base: &str, auth: Option<&str>, request: SaveRequest) -> Result<SaveResult> {
    require_project_directory(request.scope, request.directory.as_deref())?;
    let paths = resolve_paths(base, auth, request.directory.as_deref()).await?;
    let target = resolve_target(&paths, request.scope)?;
    let current = if target.path.exists() {
        fs::read_to_string(&target.path).context("读取 CLI 配置失败")?
    } else {
        String::new()
    };
    if hash_text(&current) != request.base_hash {
        bail!("配置文件已被其他进程修改，请重新加载后再保存");
    }

    let mut warnings = Vec::new();
    let text = if request.reveal_secrets {
        if request.text.contains("__DEVECO_SECRET_") {
            bail!("显示密钥后配置中仍包含占位符，请重新读取后再保存");
        }
        request.text
    } else {
        match restore_sentinels(&current, &request.text) {
            Ok(text) => text,
            Err(_) if !request.text.contains("__DEVECO_SECRET_") => {
                if !current.trim().is_empty() {
                    warnings.push(
                        "当前文件无法解析，已按原始文本保存；请确认密钥未被意外暴露".to_string(),
                    );
                }
                request.text
            }
            Err(error) => return Err(error),
        }
    };
    if text.trim().is_empty() {
        bail!("配置内容不能为空");
    }
    parse_text(&text).context("配置不是合法的 JSONC")?;

    let backup = if target.path.exists() {
        Some(write_backup(request.scope, &target.path, &current)?)
    } else {
        None
    };
    write_atomic(&target.path, &text)?;

    if let Err(error) = reload(base, auth, request.scope, request.directory.as_deref()).await {
        restore_after_failure(&target.path, backup.as_deref())?;
        let _ = reload(base, auth, request.scope, request.directory.as_deref()).await;
        return Err(anyhow!("{error:#}；已恢复上一版本"));
    }

    let snapshot = read_target(request.scope, &target.path, false)?;
    if snapshot.parse_error.is_some() {
        restore_after_failure(&target.path, backup.as_deref())?;
        let _ = reload(base, auth, request.scope, request.directory.as_deref()).await;
        bail!("CLI 无法解析保存后的配置，已恢复上一版本");
    }
    if backup.is_none() {
        warnings.push("这是新建的配置文件".to_string());
    }
    Ok(SaveResult { snapshot, warnings })
}

pub async fn reveal_secret(
    base: &str,
    auth: Option<&str>,
    scope: Scope,
    directory: Option<&str>,
    path: &[PathSegment],
) -> Result<Option<String>> {
    require_project_directory(scope, directory)?;
    if !is_secret_path(path) {
        bail!("该字段不是受支持的密钥路径");
    }
    let paths = resolve_paths(base, auth, directory).await?;
    let target = resolve_target(&paths, scope)?;
    let text = fs::read_to_string(&target.path).unwrap_or_default();
    let parsed = parse_text(&text)?;
    Ok(find_string(&parsed, path))
}

pub async fn list_backups(
    base: &str,
    auth: Option<&str>,
    scope: Scope,
    directory: Option<&str>,
) -> Result<Vec<BackupInfo>> {
    require_project_directory(scope, directory)?;
    let paths = resolve_paths(base, auth, directory).await?;
    let target = resolve_target(&paths, scope)?;
    let target_hash = hash_text(&path_text(&target.path));
    let dir = backup_dir(scope)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).context("读取配置备份目录失败")? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonc")
            || !backup_matches_target(&path, &target_hash)
        {
            continue;
        }
        let meta = entry.metadata()?;
        let updated_at = meta
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
            .unwrap_or(0);
        entries.push(BackupInfo {
            name: entry.file_name().to_string_lossy().to_string(),
            path: path_text(&path),
            updated_at,
            size: meta.len(),
        });
    }
    entries.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(entries)
}

pub async fn restore_backup(
    base: &str,
    auth: Option<&str>,
    request: BackupRestoreRequest,
) -> Result<ConfigSnapshot> {
    if request.name.contains('/') || request.name.contains('\\') {
        bail!("备份名不合法");
    }
    require_project_directory(request.scope, request.directory.as_deref())?;
    let paths = resolve_paths(base, auth, request.directory.as_deref()).await?;
    let target = resolve_target(&paths, request.scope)?;
    let backup = backup_dir(request.scope)?.join(&request.name);
    if !backup_matches_target(&backup, &hash_text(&path_text(&target.path))) {
        bail!("该备份不属于当前配置目标");
    }
    let text = fs::read_to_string(&backup).context("读取配置备份失败")?;
    parse_text(&text).context("备份不是合法的 JSONC")?;
    let previous = if target.path.exists() {
        Some(fs::read_to_string(&target.path).context("读取当前配置失败")?)
    } else {
        None
    };
    if let Some(current) = previous.as_deref() {
        write_backup(request.scope, &target.path, current)?;
    }
    write_atomic(&target.path, &text)?;
    if let Err(error) = reload(base, auth, request.scope, request.directory.as_deref()).await {
        restore_previous_text(&target.path, previous.as_deref())?;
        let _ = reload(base, auth, request.scope, request.directory.as_deref()).await;
        return Err(anyhow!("{error:#}；已恢复上一版本"));
    }
    let snapshot = read_target(request.scope, &target.path, false)?;
    if snapshot.parse_error.is_some() {
        restore_previous_text(&target.path, previous.as_deref())?;
        let _ = reload(base, auth, request.scope, request.directory.as_deref()).await;
        bail!("CLI 无法解析恢复后的配置，已恢复上一版本");
    }
    Ok(snapshot)
}

fn read_target(scope: Scope, path: &Path, reveal_secrets: bool) -> Result<ConfigSnapshot> {
    let exists = path.exists();
    let current = if exists {
        fs::read_to_string(path).context("读取 CLI 配置失败")?
    } else {
        String::new()
    };
    let text = if exists {
        current.clone()
    } else {
        "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n".to_string()
    };
    let updated_at = if exists {
        fs::metadata(path)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
    } else {
        None
    };

    let (display_text, secrets, parse_error, redacted) = match redact_jsonc(&text) {
        Ok((redacted_text, secrets)) => {
            let (parse_error, redacted_text) = match parse_text(&redacted_text) {
                Ok(_) => (None, redacted_text),
                Err(error) => (Some(error.to_string()), redacted_text),
            };
            let display = if reveal_secrets {
                text.clone()
            } else {
                redacted_text
            };
            (display, secrets, parse_error, !reveal_secrets)
        }
        Err(error) => (text.clone(), Vec::new(), Some(error.to_string()), false),
    };

    let value: Value = parse_text(&display_text)
        .map(Into::into)
        .unwrap_or_else(|_| json!({}));
    Ok(ConfigSnapshot {
        scope,
        path: path_text(path),
        exists,
        hash: hash_text(&current),
        text: display_text,
        value,
        secrets,
        parse_error,
        redacted,
        updated_at,
    })
}

async fn resolve_paths(base: &str, auth: Option<&str>, directory: Option<&str>) -> Result<Paths> {
    let query = directory
        .map(|value| vec![("directory".to_string(), value.to_string())])
        .unwrap_or_default();
    let value = http::send_with_timeout(base, auth, "GET", "/path", &query, None, CONFIG_TIMEOUT)
        .await
        .context("读取 CLI 配置路径失败")?;
    let config_dir = value
        .get("config")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("CLI 没有返回全局配置目录"))?;
    let project_config_dir = value
        .get("projectConfig")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let worktree = value
        .get("worktree")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    Ok(Paths {
        config_dir: PathBuf::from(config_dir),
        project_config_dir,
        worktree,
    })
}

fn require_project_directory(scope: Scope, directory: Option<&str>) -> Result<()> {
    if scope == Scope::Project && directory.is_none() {
        bail!("项目配置需要先选择工作区");
    }
    Ok(())
}

fn resolve_target(paths: &Paths, scope: Scope) -> Result<Target> {
    match scope {
        Scope::Global => {
            let candidates = [
                paths.config_dir.join("deveco.jsonc"),
                paths.config_dir.join("deveco.json"),
                paths.config_dir.join("config.json"),
            ];
            let path = candidates
                .iter()
                .find(|path| path.exists())
                .cloned()
                .unwrap_or_else(|| candidates[0].clone());
            Ok(Target { path })
        }
        Scope::Project => {
            let project_dir = paths
                .project_config_dir
                .as_ref()
                .ok_or_else(|| anyhow!("当前没有可用的项目配置目录"))?;
            let worktree = paths
                .worktree
                .as_ref()
                .ok_or_else(|| anyhow!("当前没有可用的工作区"))?;
            let candidates = [
                project_dir.join("deveco.jsonc"),
                worktree.join("deveco.jsonc"),
            ];
            let path = candidates
                .iter()
                .find(|path| path.exists())
                .cloned()
                .unwrap_or_else(|| candidates[0].clone());
            Ok(Target { path })
        }
    }
}

fn parse_text(text: &str) -> Result<AstValue<'_>> {
    let parsed = jsonc_parser::parse_to_ast(
        text,
        &jsonc_parser::CollectOptions::default(),
        &jsonc_parser::ParseOptions::default(),
    )
    .map_err(|error| anyhow!("{error}"))?;
    let value = parsed.value.ok_or_else(|| anyhow!("配置内容为空"))?;
    if !matches!(value, AstValue::Object(_)) {
        bail!("CLI 配置的根节点必须是 JSON 对象");
    }
    Ok(value)
}

fn redact_jsonc(text: &str) -> Result<(String, Vec<SecretInfo>)> {
    let root = parse_text(text)?;
    let mut edits = Vec::<(Range, String)>::new();
    let mut secrets = Vec::<SecretInfo>::new();
    collect_redactions(&root, &mut Vec::new(), &mut edits, &mut secrets);
    edits.sort_by_key(|(range, _)| range.start);
    let mut output = text.to_string();
    for (range, replacement) in edits.into_iter().rev() {
        if range.end <= output.len() && range.start <= range.end {
            output.replace_range(range.start..range.end, &replacement);
        }
    }
    Ok((output, secrets))
}

fn collect_redactions(
    value: &AstValue<'_>,
    path: &mut Vec<PathSegment>,
    edits: &mut Vec<(Range, String)>,
    secrets: &mut Vec<SecretInfo>,
) {
    match value {
        AstValue::Object(object) => collect_object_redactions(object, path, edits, secrets),
        AstValue::Array(array) => {
            for (index, item) in array.elements.iter().enumerate() {
                path.push(PathSegment::Index(index));
                collect_redactions(item, path, edits, secrets);
                path.pop();
            }
        }
        _ => {}
    }
}

fn collect_object_redactions(
    object: &Object<'_>,
    path: &mut Vec<PathSegment>,
    edits: &mut Vec<(Range, String)>,
    secrets: &mut Vec<SecretInfo>,
) {
    for property in &object.properties {
        let key = property.name.as_str().to_string();
        path.push(PathSegment::Key(key.clone()));
        if is_secret_path(path) {
            if let AstValue::StringLit(literal) = &property.value {
                let sentinel = sentinel_for(path);
                edits.push((literal.range, format!("\"{sentinel}\"")));
                secrets.push(SecretInfo {
                    path: path.clone(),
                    label: secret_label(path),
                    configured: !literal.value.trim().is_empty(),
                });
            } else {
                secrets.push(SecretInfo {
                    path: path.clone(),
                    label: secret_label(path),
                    configured: !matches!(property.value, AstValue::NullKeyword(_)),
                });
            }
        } else {
            collect_redactions(&property.value, path, edits, secrets);
        }
        path.pop();
    }
}

fn is_secret_path(path: &[PathSegment]) -> bool {
    let keys: Vec<&str> = path.iter().filter_map(PathSegment::key).collect();
    if keys.len() < 3 {
        return false;
    }
    if keys[0] == "provider" && keys[2] == "options" && keys.last() == Some(&"apiKey") {
        return true;
    }
    if keys.len() >= 4 && keys[0] == "mcp" && keys.get(2) == Some(&"headers") {
        return true;
    }
    if keys.len() >= 4
        && keys[0] == "mcp"
        && keys.get(2) == Some(&"oauth")
        && keys.last() == Some(&"clientSecret")
    {
        return true;
    }
    if keys.len() >= 4
        && keys[0] == "mcp"
        && keys.get(2) == Some(&"environment")
        && keys.last().map(|key| looks_secret(key)).unwrap_or(false)
    {
        return true;
    }
    false
}

fn looks_secret(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "AUTH"]
        .iter()
        .any(|part| upper.contains(part))
}

fn secret_label(path: &[PathSegment]) -> String {
    path.iter()
        .filter_map(PathSegment::key)
        .collect::<Vec<_>>()
        .join(".")
}

fn sentinel_for(path: &[PathSegment]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for segment in path {
        let text = match segment {
            PathSegment::Key(value) => format!("/{value}"),
            PathSegment::Index(value) => format!("/{value}"),
        };
        for byte in text.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("__DEVECO_SECRET_{hash:016x}__")
}

fn restore_sentinels(current: &str, edited: &str) -> Result<String> {
    let root = parse_text(current)?;
    let mut values = Vec::<(String, String)>::new();
    collect_secret_values(&root, &mut Vec::new(), &mut values);
    let mut output = edited.to_string();
    for (sentinel, secret) in values {
        let needle = format!("\"{sentinel}\"");
        if output.contains(&needle) {
            let replacement = serde_json::to_string(&secret).context("序列化密钥失败")?;
            output = output.replace(&needle, &replacement);
        }
    }
    if output.contains("__DEVECO_SECRET_") {
        bail!("密钥占位符已被修改，请撤销对应修改或显式显示密钥后再编辑");
    }
    Ok(output)
}

fn collect_secret_values(
    value: &AstValue<'_>,
    path: &mut Vec<PathSegment>,
    values: &mut Vec<(String, String)>,
) {
    match value {
        AstValue::Object(object) => {
            for property in &object.properties {
                path.push(PathSegment::Key(property.name.as_str().to_string()));
                if is_secret_path(path) {
                    if let AstValue::StringLit(literal) = &property.value {
                        values.push((sentinel_for(path), literal.value.to_string()));
                    }
                } else {
                    collect_secret_values(&property.value, path, values);
                }
                path.pop();
            }
        }
        AstValue::Array(array) => {
            for (index, item) in array.elements.iter().enumerate() {
                path.push(PathSegment::Index(index));
                collect_secret_values(item, path, values);
                path.pop();
            }
        }
        _ => {}
    }
}

fn find_string(root: &AstValue<'_>, path: &[PathSegment]) -> Option<String> {
    let mut current = root;
    for segment in path {
        match (current, segment) {
            (AstValue::Object(object), PathSegment::Key(key)) => {
                let property = object
                    .properties
                    .iter()
                    .find(|property| property.name.as_str() == key)?;
                current = &property.value;
            }
            (AstValue::Array(array), PathSegment::Index(index)) => {
                current = array.elements.get(*index)?;
            }
            _ => return None,
        }
    }
    match current {
        AstValue::StringLit(literal) => Some(literal.value.to_string()),
        _ => None,
    }
}

async fn reload(
    base: &str,
    auth: Option<&str>,
    scope: Scope,
    directory: Option<&str>,
) -> Result<()> {
    match scope {
        Scope::Project => {
            let directory = directory.ok_or_else(|| anyhow!("缺少项目目录"))?;
            http::send_with_timeout(
                base,
                auth,
                "POST",
                "/instance/dispose",
                &[("directory".to_string(), directory.to_string())],
                None,
                RELOAD_TIMEOUT,
            )
            .await
            .context("重载项目配置失败")?;
            http::send_with_timeout(
                base,
                auth,
                "GET",
                "/config",
                &[("directory".to_string(), directory.to_string())],
                None,
                RELOAD_TIMEOUT,
            )
            .await
            .context("CLI 无法加载项目配置")?;
        }
        Scope::Global => {
            http::send_with_timeout(
                base,
                auth,
                "POST",
                "/global/dispose",
                &[],
                None,
                RELOAD_TIMEOUT,
            )
            .await
            .context("重载全局配置失败")?;
            http::send_with_timeout(
                base,
                auth,
                "GET",
                "/global/config",
                &[],
                None,
                RELOAD_TIMEOUT,
            )
            .await
            .context("CLI 无法加载全局配置")?;
        }
    }
    Ok(())
}

fn restore_after_failure(path: &Path, backup: Option<&Path>) -> Result<()> {
    if let Some(backup) = backup {
        let text = fs::read_to_string(backup).context("读取配置备份失败")?;
        write_atomic(path, &text).context("恢复配置备份失败")?;
    } else if path.exists() {
        fs::remove_file(path).context("删除新建配置失败")?;
    }
    Ok(())
}

fn restore_previous_text(path: &Path, previous: Option<&str>) -> Result<()> {
    if let Some(text) = previous {
        write_atomic(path, text).context("恢复上一版本失败")?;
    } else if path.exists() {
        fs::remove_file(path).context("删除恢复失败的新配置失败")?;
    }
    Ok(())
}

fn write_atomic(path: &Path, text: &str) -> Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow!("配置路径没有父目录"))?;
    fs::create_dir_all(parent).context("创建配置目录失败")?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let temp = parent.join(format!(
        ".{}.tmp-{stamp}",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("deveco.jsonc")
    ));
    fs::write(&temp, text).context("写入临时配置失败")?;
    if let Ok(meta) = fs::metadata(path) {
        let _ = fs::set_permissions(&temp, meta.permissions());
    } else {
        set_private_permissions(&temp);
    }
    fs::rename(&temp, path).context("替换配置文件失败")?;
    Ok(())
}

fn write_backup(scope: Scope, source: &Path, text: &str) -> Result<PathBuf> {
    let dir = backup_dir(scope)?;
    fs::create_dir_all(&dir).context("创建配置备份目录失败")?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let target_hash = hash_text(&path_text(source));
    let name = format!("{stamp}-{target_hash}.jsonc");
    let path = dir.join(name);
    fs::write(&path, text).context("写入配置备份失败")?;
    set_private_permissions(&path);
    prune_backups(&dir, &target_hash);
    Ok(path)
}

fn backup_matches_target(path: &Path, target_hash: &str) -> bool {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(|name| name.ends_with(&format!("-{target_hash}")))
        .unwrap_or(false)
}

fn prune_backups(dir: &Path, target_hash: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension().and_then(|value| value.to_str()) == Some("jsonc")
                && backup_matches_target(path, target_hash)
        })
        .collect();
    files.sort();
    while files.len() > BACKUP_LIMIT {
        if let Some(path) = files.first().cloned() {
            let _ = fs::remove_file(path);
            files.remove(0);
        } else {
            break;
        }
    }
}

fn backup_dir(scope: Scope) -> Result<PathBuf> {
    let base = dirs::config_dir().ok_or_else(|| anyhow!("找不到应用配置目录"))?;
    Ok(base
        .join("DevEco Code Desktop")
        .join("cli-config-backups")
        .join(scope.as_str()))
}

fn hash_text(text: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 密钥路径识别() {
        let path = vec![
            PathSegment::Key("provider".into()),
            PathSegment::Key("custom".into()),
            PathSegment::Key("options".into()),
            PathSegment::Key("apiKey".into()),
        ];
        assert!(is_secret_path(&path));
        let header = vec![
            PathSegment::Key("mcp".into()),
            PathSegment::Key("x".into()),
            PathSegment::Key("headers".into()),
            PathSegment::Key("Authorization".into()),
        ];
        assert!(is_secret_path(&header));
    }

    #[test]
    fn 脱敏并恢复密钥() {
        let text = "{\n  // 保留注释\n  \"provider\": {\"p\": {\"options\": {\"apiKey\": \"secret-value\"}}}\n}\n";
        let (redacted, secrets) = redact_jsonc(text).unwrap();
        assert!(redacted.contains("__DEVECO_SECRET_"));
        assert!(!redacted.contains("secret-value"));
        assert_eq!(secrets.len(), 1);
        let restored = restore_sentinels(text, &redacted).unwrap();
        assert!(restored.contains("secret-value"));
        assert!(restored.contains("保留注释"));
    }

    #[test]
    fn 脱敏_mcp_header_和_environment() {
        let text = r#"{
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": {"Authorization": "Bearer top-secret"},
      "environment": {"API_TOKEN": "env-secret"}
    }
  }
}"#;
        let (redacted, secrets) = redact_jsonc(text).unwrap();
        assert!(!redacted.contains("top-secret"));
        assert!(!redacted.contains("env-secret"));
        assert_eq!(secrets.len(), 2);
        let restored = restore_sentinels(text, &redacted).unwrap();
        assert!(restored.contains("top-secret"));
        assert!(restored.contains("env-secret"));
    }

    #[test]
    fn 脱敏_mcp_oauth_client_secret() {
        let text = r#"{
  "mcp": {
    "remote": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "oauth": {
        "clientId": "public-client",
        "clientSecret": "oauth-secret",
        "scope": "read"
      }
    }
  }
}"#;
        let (redacted, secrets) = redact_jsonc(text).unwrap();
        assert!(!redacted.contains("oauth-secret"));
        assert!(redacted.contains("public-client"));
        assert!(redacted.contains("__DEVECO_SECRET_"));
        assert_eq!(secrets.len(), 1);
        let restored = restore_sentinels(text, &redacted).unwrap();
        assert!(restored.contains("oauth-secret"));
    }

    #[test]
    fn 项目配置必须绑定工作区() {
        assert!(require_project_directory(Scope::Project, None).is_err());
        assert!(require_project_directory(Scope::Project, Some("/tmp/workspace")).is_ok());
        assert!(require_project_directory(Scope::Global, None).is_ok());
    }

    #[test]
    fn 配置根节点必须是对象() {
        assert!(parse_text("[1, 2]").is_err());
        assert!(parse_text("{\"model\":\"a/b\"}").is_ok());
    }

    #[test]
    fn 备份按目标路径隔离() {
        let path = Path::new("1794113770022-52700f96f89e2bed.jsonc");
        assert!(backup_matches_target(path, "52700f96f89e2bed"));
        assert!(!backup_matches_target(path, "0000000000000000"));
    }

    #[test]
    fn 清理备份按目标路径分别保留() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        for index in 0..12 {
            fs::write(
                dir.join(format!("{index:013}-aaaaaaaaaaaaaaaa.jsonc")),
                "{}",
            )
            .unwrap();
        }
        for index in 0..3 {
            fs::write(
                dir.join(format!("{index:013}-bbbbbbbbbbbbbbbb.jsonc")),
                "{}",
            )
            .unwrap();
        }
        prune_backups(dir, "aaaaaaaaaaaaaaaa");
        let remaining: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            remaining
                .iter()
                .filter(|name| name.ends_with("-aaaaaaaaaaaaaaaa.jsonc"))
                .count(),
            BACKUP_LIMIT
        );
        assert_eq!(
            remaining
                .iter()
                .filter(|name| name.ends_with("-bbbbbbbbbbbbbbbb.jsonc"))
                .count(),
            3
        );
    }

    #[test]
    fn 恢复上一版本文本() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("deveco.jsonc");
        write_atomic(&path, "new").unwrap();
        restore_previous_text(&path, Some("old")).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        restore_previous_text(&path, None).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn 修改过的哨兵会被拒绝() {
        let text = "{\"provider\":{\"p\":{\"options\":{\"apiKey\":\"secret\"}}}}";
        let (redacted, _) = redact_jsonc(text).unwrap();
        let broken = redacted.replace("__DEVECO_SECRET_", "__DEVECO_SECRET_EDIT_");
        assert!(restore_sentinels(text, &broken).is_err());
    }

    #[test]
    fn 哈希稳定() {
        assert_eq!(hash_text("abc"), hash_text("abc"));
        assert_ne!(hash_text("abc"), hash_text("abd"));
    }

    #[test]
    fn 不存在的配置文件使用空文件基线() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = read_target(Scope::Global, &dir.path().join("deveco.jsonc"), false).unwrap();
        assert!(!snapshot.exists);
        assert_eq!(snapshot.hash, hash_text(""));
        assert!(snapshot.text.contains("$schema"));
    }

    #[tokio::test]
    #[ignore = "需要本机安装 deveco CLI；用于隔离环境的手工集成验证"]
    async fn 真实_cli_项目配置读写与重载() {
        let bin = std::env::var("DEVECO_BIN_PATH")
            .unwrap_or_else(|_| "/opt/homebrew/bin/deveco".to_string());
        if !Path::new(&bin).exists() {
            eprintln!("跳过：找不到 {bin}");
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let project = root.path().join("project");
        fs::create_dir_all(home.join(".config/deveco")).unwrap();
        fs::create_dir_all(project.join(".deveco")).unwrap();
        fs::write(
            project.join(".deveco/deveco.jsonc"),
            "{\n  // 项目配置\n  \"model\": \"probe/old\"\n}\n",
        )
        .unwrap();

        let port = crate::server::free_port().unwrap();
        let mut command = tokio::process::Command::new(&bin);
        command
            .args([
                "serve",
                "--hostname",
                "127.0.0.1",
                "--port",
                &port.to_string(),
            ])
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_DATA_HOME", home.join(".local/share"))
            .env("XDG_CACHE_HOME", home.join(".cache"))
            .env("XDG_STATE_HOME", home.join(".local/state"))
            .current_dir(&project)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        let mut child = command.spawn().unwrap();
        let base = format!("http://127.0.0.1:{port}");
        let mut healthy = false;
        for _ in 0..120 {
            if http::send(&base, None, "GET", "/api/health", &[], None)
                .await
                .is_ok()
            {
                healthy = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(healthy, "隔离 CLI 未启动");

        let project_text = project.to_string_lossy().to_string();
        let sources = sources(&base, None, Some(&project_text)).await.unwrap();
        assert!(sources
            .project_path
            .unwrap()
            .ends_with(".deveco/deveco.jsonc"));

        let snapshot = read(&base, None, Scope::Project, Some(&project_text), false)
            .await
            .unwrap();
        assert!(snapshot.text.contains("probe/old"));
        let next = snapshot.text.replace("probe/old", "probe/new");
        let saved = save(
            &base,
            None,
            SaveRequest {
                scope: Scope::Project,
                directory: Some(project_text.clone()),
                base_hash: snapshot.hash,
                text: next,
                reveal_secrets: false,
            },
        )
        .await
        .unwrap();
        assert!(saved.snapshot.text.contains("probe/new"));
        let backups = list_backups(&base, None, Scope::Project, Some(&project_text))
            .await
            .unwrap();
        assert!(!backups.is_empty());
        assert!(list_backups(&base, None, Scope::Project, None)
            .await
            .is_err());

        let effective = http::send(
            &base,
            None,
            "GET",
            "/config",
            &[("directory".to_string(), project_text)],
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            effective.get("model").and_then(Value::as_str),
            Some("probe/new")
        );

        #[cfg(unix)]
        unsafe {
            if let Some(pid) = child.id() {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = child.wait().await;
    }
}
