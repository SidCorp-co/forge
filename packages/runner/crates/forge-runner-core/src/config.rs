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

    #[serde(default)]
    pub update: UpdateSettings,

    /// Shared-skill delivery via a Claude Code plugin marketplace (ISS-739),
    /// the 3rd channel alongside per-project disk sync (ISS-737) and
    /// MCP-served meta prompts. Defaults to fully disabled — canary rollout
    /// opts in one device at a time.
    #[serde(default)]
    pub plugins: PluginSettings,

    /// project-slug -> local repo binding. One runner is registered per binding.
    #[serde(default)]
    pub bindings: HashMap<String, Binding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateSettings {
    /// Release manifest URL. Defaults to `{core_url}/api/install/latest.json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_url: Option<String>,
    /// When true, the daemon downloads + applies updates and restarts itself.
    /// Defaults to ON (ISS-392) so releases reach the fleet without anyone
    /// editing TOML; the drain guard keeps the restart from interrupting work,
    /// and `forge-runner config set update.auto false` opts a device out.
    /// Absent `[update]`/`auto =` ⇒ ON; an explicit `auto = false` still wins.
    #[serde(default = "default_auto")]
    pub auto: bool,
}

fn default_auto() -> bool {
    true
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            manifest_url: None,
            auto: default_auto(),
        }
    }
}

/// Device-level shared-skill delivery via a Claude Code plugin marketplace
/// (ISS-739). See `docs/architecture/skill-delivery-plugin-channel.md` for
/// the 3-channel doctrine and the SHA-pin decision.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSettings {
    /// Master switch. Defaults to OFF — the runner ships to every device via
    /// the Rust release channel, so this is a canary opt-in (enable on one
    /// device, prove it, then widen), mirroring the ISS-736 rollout discipline.
    #[serde(default)]
    pub enabled: bool,
    /// Marketplace source: a GitHub `owner/repo` shorthand or full git URL,
    /// passed straight to `claude plugin marketplace add`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace_repo: Option<String>,
    /// Plugin name(s) from the marketplace to install + enable. Empty = none
    /// (marketplace added but nothing installed).
    #[serde(default)]
    pub plugin_names: Vec<String>,
    /// Commit SHA the marketplace clone is checked out to right after
    /// `marketplace add`, giving a deterministic floor for the initial
    /// install. When `auto_update` is on, subsequent polls fast-forward past
    /// this pin — it seeds a known-good starting point, it does not lock the
    /// device to that commit forever.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_ref: Option<String>,
    /// Auto-update the marketplace + installed plugins on each poll.
    /// Defaults ON for the first-party Forge marketplace (owner decision).
    #[serde(default = "default_plugin_auto_update")]
    pub auto_update: bool,
    /// Background sweep cadence, in seconds, after the initial jittered
    /// (<=10min) startup delay.
    #[serde(default = "default_plugin_poll_interval_secs")]
    pub poll_interval_secs: u64,
}

fn default_plugin_auto_update() -> bool {
    true
}

fn default_plugin_poll_interval_secs() -> u64 {
    6 * 3600
}

impl Default for PluginSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            marketplace_repo: None,
            plugin_names: Vec::new(),
            pinned_ref: None,
            auto_update: default_plugin_auto_update(),
            poll_interval_secs: default_plugin_poll_interval_secs(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerSettings {
    /// Concurrent jobs per runner (per project). Core dispatch-gate assumes 1.
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent: u32,
    /// Cap on total concurrent jobs across the whole device. 0 = unlimited.
    #[serde(default)]
    pub device_max_concurrent: u32,
    /// Max concurrent interactive chat turns on this device. Chat runs OFF the
    /// jobs table and OUTSIDE the pipeline cap, so it gets its own budget — a
    /// long chat must never consume a pipeline `job.assigned` slot, and a burst
    /// of chats must never exhaust the box (ISS-321). Clamped to >= 1 at use.
    #[serde(default = "default_chat_max_concurrent")]
    pub chat_max_concurrent: u32,
    /// Send `runner:register` (gated behind core `runnerFramework` flag).
    #[serde(default)]
    pub register_enabled: bool,
}

impl Default for RunnerSettings {
    fn default() -> Self {
        Self {
            max_concurrent: default_max_concurrent(),
            device_max_concurrent: 0,
            chat_max_concurrent: default_chat_max_concurrent(),
            register_enabled: false,
        }
    }
}

fn default_max_concurrent() -> u32 {
    1
}

fn default_chat_max_concurrent() -> u32 {
    3
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

    #[test]
    fn plugin_settings_default_disabled_with_auto_update_on() {
        let cfg = Config::default();
        assert!(!cfg.plugins.enabled);
        assert!(cfg.plugins.auto_update);
        assert_eq!(cfg.plugins.poll_interval_secs, 6 * 3600);
        assert!(cfg.plugins.marketplace_repo.is_none());
        assert!(cfg.plugins.plugin_names.is_empty());
    }

    #[test]
    fn plugin_settings_roundtrip_through_toml() {
        let mut cfg = Config::default();
        cfg.plugins.enabled = true;
        cfg.plugins.marketplace_repo = Some("SidCorp-co/forge-pipeline-skills".into());
        cfg.plugins.plugin_names = vec!["forge-shared-skills".into()];
        cfg.plugins.pinned_ref = Some("deadbeef".into());
        let s = toml::to_string_pretty(&cfg).unwrap();
        let back: Config = toml::from_str(&s).unwrap();
        assert!(back.plugins.enabled);
        assert_eq!(
            back.plugins.marketplace_repo.as_deref(),
            Some("SidCorp-co/forge-pipeline-skills")
        );
        assert_eq!(back.plugins.plugin_names, vec!["forge-shared-skills"]);
        assert_eq!(back.plugins.pinned_ref.as_deref(), Some("deadbeef"));
    }
}
