//! On-disk config: `~/.config/forge-runner/config.toml`.
//!
//! Secrets (device token) never live here — they go to the credential store
//! (keychain, or `0600` file fallback). See `auth` (M1).

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub core_url: Option<String>,

    /// Non-secret device id returned at pairing time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,

    /// Parent dir where repos are placed/cloned when a binding has no explicit path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projects_root: Option<PathBuf>,

    /// Windows only: "native" | "wsl" | "auto".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_mode: Option<String>,

    #[serde(default)]
    pub runner: RunnerSettings,

    /// project-slug -> local repo binding. One runner is registered per binding.
    #[serde(default)]
    pub bindings: HashMap<String, Binding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerSettings {
    /// Concurrent jobs per runner (per project). Core dispatch-gate assumes 1.
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent: u32,
    /// Cap on total concurrent jobs across the whole device. 0 = unlimited.
    #[serde(default)]
    pub device_max_concurrent: u32,
    /// Send `runner:register` (gated behind core `runnerFramework` flag).
    #[serde(default)]
    pub register_enabled: bool,
}

impl Default for RunnerSettings {
    fn default() -> Self {
        Self {
            max_concurrent: default_max_concurrent(),
            device_max_concurrent: 0,
            register_enabled: false,
        }
    }
}

fn default_max_concurrent() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Binding {
    pub repo_path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Core project id (uuid). Required to match incoming jobs and to
    /// `runner:register`. Resolved at pair/bind time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

impl Config {
    /// `~/.config/forge-runner/config.toml`.
    pub fn path() -> Result<PathBuf> {
        let dir = dirs_next::config_dir()
            .ok_or_else(|| Error::Config("cannot resolve OS config dir".into()))?;
        Ok(dir.join("forge-runner").join("config.toml"))
    }

    /// Load config, or a default if the file does not exist yet.
    pub fn load() -> Result<Self> {
        let p = Self::path()?;
        if !p.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(&p)?;
        toml::from_str(&raw).map_err(|e| Error::Config(format!("parse {}: {e}", p.display())))
    }

    /// Atomic write (`.tmp` + rename).
    pub fn save(&self) -> Result<()> {
        let p = Self::path()?;
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let body = toml::to_string_pretty(self).map_err(|e| Error::Config(e.to_string()))?;
        let tmp = p.with_extension("toml.tmp");
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, &p)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_through_toml() {
        let mut cfg = Config {
            core_url: Some("https://core.example.com".into()),
            device_id: Some("dev-1".into()),
            ..Default::default()
        };
        cfg.bindings.insert(
            "my-app".into(),
            Binding {
                repo_path: PathBuf::from("/home/u/code/my-app"),
                branch: Some("main".into()),
                project_id: Some("p-1".into()),
            },
        );
        let s = toml::to_string_pretty(&cfg).unwrap();
        let back: Config = toml::from_str(&s).unwrap();
        assert_eq!(back.core_url.as_deref(), Some("https://core.example.com"));
        assert_eq!(back.runner.max_concurrent, 1);
        assert_eq!(back.bindings.len(), 1);
    }
}
