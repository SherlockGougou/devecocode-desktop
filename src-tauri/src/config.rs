//! 本地配置：CLI 路径、通知开关、服务端口。
//!
//! 配置只存用户偏好，不存任何 CLI 凭据——认证信息仍由 deveco 自己管理。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Config {
    /// 用户手选的 `deveco` 可执行文件路径（最高优先级，覆盖自动探测）
    pub cli_path: Option<String>,
    pub notifications: Notifications,
    pub server: ServerCfg,
    pub menu_bar: MenuBarCfg,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Notifications {
    pub enabled: bool,
    pub on_permission: bool,
    pub on_idle: bool,
    pub on_error: bool,
    pub on_step: bool,
    /// 应用处于前台时不打扰（macOS 习惯）
    pub quiet_when_focused: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerCfg {
    pub hostname: String,
    /// 0 表示随机端口；非 0 时优先复用已在该端口运行的实例
    pub preferred_port: u16,
    /// 是否为本地 server 设置 Basic Auth 口令。
    ///
    /// 默认关闭。开启后 Rust 代理访问 CLI 时携带凭据，前端不接触口令。
    /// 随机口令保存在应用配置中，不是系统钥匙串。
    pub secure: bool,
    /// `secure = true` 时使用的口令；为空则启动阶段随机生成并写回配置
    pub password: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MenuBarCfg {
    /// 单色使用 macOS template 图像，自动适配浅色 / 深色菜单栏
    pub icon_style: MenuBarIconStyle,
    /// 关闭后仅在主窗口隐藏时显示，避免长期占用菜单栏空间
    pub always_visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MenuBarIconStyle {
    Monochrome,
    Color,
}

impl Default for Notifications {
    fn default() -> Self {
        Self {
            enabled: true,
            on_permission: true,
            on_idle: true,
            on_error: true,
            on_step: false,
            quiet_when_focused: true,
        }
    }
}

impl Default for ServerCfg {
    fn default() -> Self {
        Self {
            hostname: "127.0.0.1".to_string(),
            preferred_port: 0,
            secure: false,
            password: None,
        }
    }
}

impl Default for MenuBarCfg {
    fn default() -> Self {
        Self {
            icon_style: MenuBarIconStyle::Monochrome,
            always_visible: true,
        }
    }
}

impl Config {
    /// 配置目录：`~/Library/Application Support/DevEco Code Desktop`
    pub fn default_path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("DevEco Code Desktop").join("config.json"))
    }

    /// 读取配置；文件缺失或内容损坏都退回默认值，避免因为一个坏文件打不开应用。
    pub fn load(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(text) => match serde_json::from_str::<Config>(&text) {
                Ok(cfg) => cfg,
                Err(err) => {
                    log::warn!("配置文件解析失败，使用默认配置：{err}");
                    Config::default()
                }
            },
            Err(err) if err.kind() == io::ErrorKind::NotFound => Config::default(),
            Err(err) => {
                log::warn!("配置文件读取失败，使用默认配置：{err}");
                Config::default()
            }
        }
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        fs::write(path, text)
    }

    /// 实际生效的口令：仅当 `secure` 打开时返回，并在缺失时生成一次。
    /// 只含字母数字，避免 URL/Basic Auth 转义问题。
    pub fn effective_password(&mut self) -> Option<String> {
        if !self.server.secure {
            return None;
        }
        if let Some(pw) = self.server.password.clone() {
            if !pw.is_empty() {
                return Some(pw);
            }
        }
        let pw = random_token(32);
        self.server.password = Some(pw.clone());
        Some(pw)
    }
}

fn random_token(len: usize) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut bytes = vec![0u8; len];
    // 系统熵源不可用时退回时间戳混合，保证仍有不可预测性
    let filled = fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut bytes))
        .is_ok();
    if !filled {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9e3779b97f4a7c15);
        let mut state = seed | 1;
        for b in bytes.iter_mut() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *b = state as u8;
        }
    }
    bytes
        .into_iter()
        .map(|b| ALPHABET[b as usize % ALPHABET.len()] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn 默认配置开启通知且关闭阶段提醒() {
        let cfg = Config::default();
        assert!(cfg.notifications.enabled);
        assert!(cfg.notifications.on_permission);
        assert!(!cfg.notifications.on_step);
        assert_eq!(cfg.server.hostname, "127.0.0.1");
        assert_eq!(cfg.server.preferred_port, 0);
        assert_eq!(cfg.menu_bar.icon_style, MenuBarIconStyle::Monochrome);
        assert!(cfg.menu_bar.always_visible);
    }

    #[test]
    fn 配置可往返读写() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/config.json");
        let cfg = Config {
            cli_path: Some("/opt/homebrew/bin/deveco".into()),
            notifications: Notifications {
                on_step: true,
                ..Default::default()
            },
            server: ServerCfg {
                preferred_port: 4096,
                ..Default::default()
            },
            menu_bar: MenuBarCfg {
                icon_style: MenuBarIconStyle::Color,
                always_visible: false,
            },
        };
        cfg.save(&path).unwrap();

        let loaded = Config::load(&path);
        assert_eq!(loaded, cfg);
    }

    #[test]
    fn 菜单栏偏好使用稳定字段名() {
        let cfg = Config {
            menu_bar: MenuBarCfg {
                icon_style: MenuBarIconStyle::Color,
                always_visible: false,
            },
            ..Default::default()
        };
        let value = serde_json::to_value(&cfg).unwrap();
        assert_eq!(value["menu_bar"]["icon_style"], "color");
        assert_eq!(value["menu_bar"]["always_visible"], false);
    }

    #[test]
    fn 损坏的配置回退默认值而不是报错() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut f = fs::File::create(&path).unwrap();
        f.write_all(b"{not json").unwrap();
        assert_eq!(Config::load(&path), Config::default());
    }

    #[test]
    fn 缺失字段时使用默认值() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            br#"{"cli_path": null, "server": {"preferred_port": 5000}}"#,
        )
        .unwrap();
        let cfg = Config::load(&path);
        assert_eq!(cfg.server.preferred_port, 5000);
        assert_eq!(cfg.server.hostname, "127.0.0.1");
        assert!(cfg.notifications.enabled);
        assert_eq!(cfg.menu_bar.icon_style, MenuBarIconStyle::Monochrome);
        assert!(cfg.menu_bar.always_visible);
    }

    #[test]
    fn 默认不启用本地服务口令() {
        let mut cfg = Config::default();
        assert!(!cfg.server.secure);
        assert_eq!(cfg.effective_password(), None);
    }

    #[test]
    fn 开启安全后口令生成稳定且可复用() {
        let mut cfg = Config {
            server: ServerCfg {
                secure: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let pw = cfg.effective_password().unwrap();
        assert_eq!(pw.len(), 32);
        assert!(pw.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_eq!(cfg.effective_password().unwrap(), pw);
    }
}
