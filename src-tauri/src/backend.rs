//! 启动编排：CLI 发现 → 拉起/复用 server → 健康检查 → 取项目目录。
//!
//! 主进程与无头自检程序共用同一套逻辑，保证「自测过的路径 = 真实运行的路径」。

use crate::cli::{self, CliInfo};
use crate::config::Config;
use crate::server::{self, DevEcoServer, LaunchSpec};
use anyhow::{bail, Result};
use std::time::Duration;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(45);

pub struct Backend {
    pub cli: CliInfo,
    pub server: DevEcoServer,
    pub auth: Option<String>,
    pub project_dir: Option<String>,
}

impl Backend {
    /// 按配置启动后端。`on_status` 用于把进度回显到启动过渡页。
    pub async fn boot(cfg: &mut Config, on_status: impl Fn(&str)) -> Result<Self> {
        on_status("正在定位本机 deveco CLI…");
        let explicit = cfg.cli_path.as_ref().map(std::path::PathBuf::from);
        let cli = cli::discover(explicit.as_deref())?;
        if let Some(version) = cli.version {
            if cli::is_below_supported(version) {
                log::warn!("deveco {version} 低于建议版本 0.2.0，可能缺少部分能力");
            }
            on_status(&format!("已找到 deveco {version}"));
        }

        let auth = cfg.effective_password();

        // 目标端口上已有实例时直接复用，避免重复拉起 161MB 的进程
        if cfg.server.preferred_port != 0 {
            on_status("检查已有服务实例…");
            if let Some(existing) = DevEcoServer::reuse(
                &cfg.server.hostname,
                cfg.server.preferred_port,
                auth.as_deref(),
            )
            .await
            {
                log::info!("复用已运行的服务：{}", existing.base_url);
                let project_dir = server::project_dir(&existing.base_url, auth.as_deref()).await;
                return Ok(Self {
                    cli,
                    server: existing,
                    auth,
                    project_dir,
                });
            }
        }

        on_status("正在启动 DevEco Code 服务（首次约需数秒）…");
        // 端口 0 会被 CLI 当成默认 4096，可能与用户自己的实例冲突，这里显式挑空闲端口
        let port = if cfg.server.preferred_port == 0 {
            server::free_port().unwrap_or(0)
        } else {
            cfg.server.preferred_port
        };
        let spec = LaunchSpec {
            bin: cli.path.clone(),
            hostname: cfg.server.hostname.clone(),
            port,
            auth: auth.clone(),
            cwd: None,
        };
        let spawned = DevEcoServer::spawn(spec).await?;
        let base_url = spawned.base_url.clone();

        on_status("等待服务就绪…");
        if !server::wait_healthy(&base_url, auth.as_deref(), HEALTH_TIMEOUT).await {
            bail!("服务已启动但 {HEALTH_TIMEOUT:?} 内健康检查未通过：{base_url}");
        }
        let project_dir = server::project_dir(&base_url, auth.as_deref()).await;

        Ok(Self {
            cli,
            server: spawned,
            auth,
            project_dir,
        })
    }

    pub fn project_label(&self) -> String {
        self.project_dir
            .as_deref()
            .and_then(|dir| std::path::Path::new(dir).file_name())
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default()
    }
}
