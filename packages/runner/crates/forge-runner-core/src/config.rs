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

    #[serde(default)]
    pub skills: SkillSettings,

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
/// (ISS-739) — the 3rd delivery channel, SHA-pinned.
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
pub struct SkillSettings {
    /// Background skill auto-pull. Defaults to ON (ISS-738) after the ISS-736
    /// canary confirmed it fleet-wide; the atomic + hash-gated + instance-locked
    /// sync (ISS-743) makes concurrent pulls torn-read-safe. Absent `[skills]` /
    /// `auto_pull =` ⇒ ON; an explicit `auto_pull = false` opts a device out.
    #[serde(default = "default_skill_auto_pull")]
    pub auto_pull: bool,
}

impl Default for SkillSettings {
    fn default() -> Self {
        Self {
            auto_pull: default_skill_auto_pull(),
        }
    }
}

fn default_skill_auto_pull() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerSettings {
    /// Max live duplex claude PROCESSES this device runs for PIPELINE jobs
    /// (`pipelineConfig.sessionMode='duplex'`). Chat is not counted here and has
    /// no ceiling of its own — a chat process is bounded by its residency
    /// timeout alone. Clamped to >= 1 at use.
    // cm:edge contract -> packages/runner/crates/forge-runner-core/src/runner/claude_code.rs — this number sizes `session_sem`, whose permit is taken only when a spec sets `counts_against_session_cap`. Renamed from `chat_max_concurrent` on 2026-09-04 because chat stopped taking permits and the old name then described nothing the number does.
    #[serde(default = "default_duplex_max_sessions")]
    pub duplex_max_sessions: u32,
    /// Send `runner:register` (gated behind core `runnerFramework` flag).
    #[serde(default)]
    pub register_enabled: bool,
}

impl Default for RunnerSettings {
    fn default() -> Self {
        Self {
            duplex_max_sessions: default_duplex_max_sessions(),
            register_enabled: false,
        }
    }
}

fn default_duplex_max_sessions() -> u32 {
    3
}

/// `[runner] max_concurrent`, `device_max_concurrent` and `chat_max_concurrent`
/// were all removed on 2026-09-04. The first two were parsed and written for
/// their whole life and read by nothing, so a box set to 4 ran exactly one job
/// and said nothing about it. `chat_max_concurrent` WAS read — it sized both the
/// chat turn queue and the duplex process ceiling — so a config that sets it is
/// asking for something the runner no longer does with that key.
///
/// Serde ignores unknown keys, so an old file still loads — but ignoring is what
/// made them a trap. Warn only on a value the operator can only have typed:
/// every config the runner ever WROTE carries `max_concurrent = 1` and
/// `device_max_concurrent = 0`, and warning the whole fleet about its own
/// defaults is noise nobody reads.
// cm:guard warn, NEVER refuse to start. These keys were serialized into every config file this tool has ever written, so a hard failure here is a fleet-wide outage on upgrade — the opposite of the loud break, which is meant to stop a WRONG action, not every action.
// cm:edge contract -> packages/core/src/runners/device-cap.ts#effectiveDeviceCap — this warning text promises core owns the cap, and that is now `devices.max_concurrent` resolved against the runner's version. If the knob moves again, this message has to move with it or it sends operators somewhere that no longer decides.
fn warn_on_retired_concurrency_keys(raw: &str, path: &std::path::Path) {
    const CORE_OWNS_IT: &str = "pipeline concurrency is decided by core, per device";
    // cm:guard `chat_max_concurrent` is the one retired key whose value was LOAD-BEARING, so its warning must name the key that replaced it. Say only "no longer read" here and an operator who raised it to 8 is told their line is inert while the ceiling it used to lift silently sits at the default 3.
    const CHAT_UNCAPPED: &str = "chat no longer has a concurrency limit at all, and the duplex          process ceiling this number used to size now reads `duplex_max_sessions`";
    for (key, tool_written_default, why) in [
        ("max_concurrent", "1", CORE_OWNS_IT),
        ("device_max_concurrent", "0", CORE_OWNS_IT),
        ("chat_max_concurrent", "3", CHAT_UNCAPPED),
    ] {
        let Some(value) = toml_scalar_in_runner_table(raw, key) else {
            continue;
        };
        if value == tool_written_default {
            continue;
        }
        tracing::warn!(
            "{}: `[runner] {key} = {value}` is no longer read — {why}. Remove the line; it will \
             disappear on the next config write either way.",
            path.display()
        );
    }
}

/// The scalar assigned to `key` inside the `[runner]` table, if the file sets one.
fn toml_scalar_in_runner_table(raw: &str, key: &str) -> Option<String> {
    let mut in_runner = false;
    for line in raw.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_runner = line == "[runner]";
            continue;
        }
        if !in_runner {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim() == key {
            return Some(value.trim().to_string());
        }
    }
    None
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
        warn_on_retired_concurrency_keys(&raw, &p);
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
        assert_eq!(back.runner.duplex_max_sessions, 3);
        assert_eq!(back.bindings.len(), 1);
        assert!(back.skills.auto_pull);
    }

    // cm:guard an old config MUST still load. `save()` serialized `max_concurrent` and
    // `device_max_concurrent` into every file this tool has ever written, so if removing the
    // fields made parsing strict, every runner in the fleet would fail to start on upgrade.
    #[test]
    fn a_config_carrying_the_retired_keys_still_loads() {
        let raw = r#"
core_url = "https://core.example.com"

[runner]
max_concurrent = 4
device_max_concurrent = 8
chat_max_concurrent = 5
"#;
        let cfg: Config = toml::from_str(raw).expect("retired keys must not break parsing");
        assert_eq!(
            cfg.runner.duplex_max_sessions, 3,
            "a retired key must not keep sizing the ceiling that replaced it"
        );
    }

    #[test]
    fn a_deliberately_set_retired_key_is_detected_but_the_tool_written_default_is_not() {
        let deliberate = "[runner]\nmax_concurrent = 4\ndevice_max_concurrent = 8\n";
        assert_eq!(
            toml_scalar_in_runner_table(deliberate, "max_concurrent").as_deref(),
            Some("4")
        );
        assert_eq!(
            toml_scalar_in_runner_table(deliberate, "device_max_concurrent").as_deref(),
            Some("8")
        );

        assert_eq!(
            toml_scalar_in_runner_table(
                "[runner]\nchat_max_concurrent = 8\n",
                "chat_max_concurrent"
            )
            .as_deref(),
            Some("8")
        );

        let written_by_the_tool =
            "[runner]\nmax_concurrent = 1\ndevice_max_concurrent = 0\nchat_max_concurrent = 3\n";
        assert_eq!(
            toml_scalar_in_runner_table(written_by_the_tool, "max_concurrent").as_deref(),
            Some("1")
        );
        assert_eq!(
            toml_scalar_in_runner_table(written_by_the_tool, "chat_max_concurrent").as_deref(),
            Some("3")
        );
    }

    // cm:guard the scan is table-scoped: `max_concurrent` under ANOTHER table is not this key, and
    // reading it would warn an operator about a line that is doing its job.
    #[test]
    fn a_same_named_key_in_another_table_is_not_mistaken_for_the_retired_one() {
        let raw = "[skills]\nmax_concurrent = 9\n\n[runner]\nchat_max_concurrent = 3\n";
        assert_eq!(toml_scalar_in_runner_table(raw, "max_concurrent"), None);
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
