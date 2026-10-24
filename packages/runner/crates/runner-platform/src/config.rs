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

    /// The label this box paired under — what the web app's device list calls
    /// it. A refusal that has to name the box to whoever reads it names this,
    /// because the hostname it falls back to is not what a box paired with
    /// `forge-runner login --name X` is listed as, and naming the wrong one
    /// sends a reader looking for a device that is not in the list (ISS-1235).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,

    /// Parent dir where repos are placed/cloned when a binding has no explicit path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projects_root: Option<PathBuf>,

    #[serde(default)]
    pub runner: RunnerSettings,

    #[serde(default)]
    pub update: UpdateSettings,

    #[serde(default)]
    pub skills: SkillSettings,

    /// Shared-skill delivery via a Claude Code plugin marketplace (ISS-739),
    /// the 3rd channel alongside per-project disk sync (ISS-737) and
    /// MCP-served meta prompts. Defaults to the first-party `forge` plugin,
    /// installed on every device — the driver skill every `drive` job runs
    /// lives there, so a runner without it cannot do the work it was paired
    /// for. An explicit `enabled = false` still opts a device out.
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
    /// Master switch. Defaults to ON: the canary widened, and the plugin the
    /// default names carries the driver skill a pipeline job executes.
    /// `forge-runner config set plugins.enabled false` opts a device out.
    #[serde(default = "default_plugins_enabled")]
    pub enabled: bool,
    /// Marketplace source: a GitHub `owner/repo` shorthand or full git URL,
    /// passed straight to `claude plugin marketplace add`. Defaults to the
    /// first-party marketplace.
    #[serde(
        default = "default_marketplace_repo",
        skip_serializing_if = "Option::is_none"
    )]
    pub marketplace_repo: Option<String>,
    /// Plugin name(s) from the marketplace to install + enable. Defaults to
    /// the `forge` plugin; an explicit empty list installs nothing.
    #[serde(default = "default_plugin_names")]
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

/// The first-party marketplace: `github.com/SidCorp-co/forge-plugin`, which
/// carries the `forge` CLI, the session hooks and the `issue-flow` driver
/// skill. `forge-pipeline-skills` was its predecessor and is retired.
pub const DEFAULT_MARKETPLACE_REPO: &str = "SidCorp-co/forge-plugin";
/// The plugin published by [`DEFAULT_MARKETPLACE_REPO`].
pub const DEFAULT_PLUGIN_NAME: &str = "forge";
/// The marketplace the default replaced. A config still naming it is migrated
/// on load, loudly.
pub const RETIRED_MARKETPLACE_REPO: &str = "SidCorp-co/forge-pipeline-skills";

fn default_plugins_enabled() -> bool {
    true
}

fn default_marketplace_repo() -> Option<String> {
    Some(DEFAULT_MARKETPLACE_REPO.to_string())
}

fn default_plugin_names() -> Vec<String> {
    vec![DEFAULT_PLUGIN_NAME.to_string()]
}

fn default_plugin_poll_interval_secs() -> u64 {
    6 * 3600
}

impl PluginSettings {
    /// A config still pointing at the retired marketplace is moved onto the
    /// first-party one and told so. Leaving it would not preserve anything:
    /// the plugin names it carries do not exist in the new marketplace, so
    /// every sweep would fail against a source nobody publishes to.
    fn migrate_retired_marketplace(&mut self, path: &std::path::Path) {
        if self.marketplace_repo.as_deref() != Some(RETIRED_MARKETPLACE_REPO) {
            return;
        }
        self.marketplace_repo = default_marketplace_repo();
        self.plugin_names = default_plugin_names();
        tracing::warn!(
            "{}: `[plugins] marketplace_repo = \"{RETIRED_MARKETPLACE_REPO}\"` is retired — this \
             run uses {DEFAULT_MARKETPLACE_REPO} with plugin `{DEFAULT_PLUGIN_NAME}` instead. \
             Delete the `[plugins]` block, or `forge-runner config set plugins.marketplace-repo \
             {DEFAULT_MARKETPLACE_REPO}`, to stop seeing this.",
            path.display()
        );
    }
}

impl Default for PluginSettings {
    fn default() -> Self {
        Self {
            enabled: default_plugins_enabled(),
            marketplace_repo: default_marketplace_repo(),
            plugin_names: default_plugin_names(),
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
    #[serde(default = "default_duplex_max_sessions")]
    pub duplex_max_sessions: u32,
    #[serde(default = "default_max_job_panes")]
    pub max_job_panes: u32,
    /// Hosts a confined chat session may reach beyond the model's endpoint, Forge core and its
    /// MCP servers — `host`, `host:port` or a URL. Each one is a place a prompt-injected chat
    /// can send what it reads, so the default is none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chat_egress_allow: Vec<String>,
}

impl Default for RunnerSettings {
    fn default() -> Self {
        Self {
            duplex_max_sessions: default_duplex_max_sessions(),
            max_job_panes: default_max_job_panes(),
            chat_egress_allow: Vec::new(),
        }
    }
}

fn default_duplex_max_sessions() -> u32 {
    3
}

fn default_max_job_panes() -> u32 {
    2
}

fn warn_on_retired_concurrency_keys(raw: &str, path: &std::path::Path) {
    const RUNNER_OWNS_IT: &str =
        "pipeline concurrency is decided by this runner — see `duplex_max_sessions`";
    const CHAT_UNCAPPED: &str = "chat no longer has a concurrency limit at all, and the duplex          process ceiling this number used to size now reads `duplex_max_sessions`";
    for (key, tool_written_default, why) in [
        ("max_concurrent", "1", RUNNER_OWNS_IT),
        ("device_max_concurrent", "0", RUNNER_OWNS_IT),
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
    /// Core project id (uuid). Required to match incoming jobs. Resolved at
    /// pair/bind time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

/// The variable naming this runner's config directory, the one holding `config.toml` and
/// `credentials.json`, ahead of the XDG rule. A daemon hands it to every pane it starts, so a
/// pane's `forge-runner` reaches that daemon while `XDG_CONFIG_HOME` stays the user's and every
/// other tool there reads its own config (ISS-574). It names a location, never a credential.
pub const CONFIG_DIR_ENV: &str = "FORGE_RUNNER_CONFIG_DIR";

/// `~/.config/forge-runner`, or the directory [`CONFIG_DIR_ENV`] names, where every file this
/// box writes about itself sits. [`Config::path`] names the same directory for reading.
pub fn base_dir() -> Result<PathBuf> {
    base_dir_from(std::env::var_os(CONFIG_DIR_ENV), os_config_dir)
}

/// The config directory a [`CONFIG_DIR_ENV`] value names: `None` where it is unset or empty
/// (an empty variable reads as unset, as the XDG ones do), refused by name where it is relative,
/// since a relative one would name a different directory from every working directory.
pub fn named_dir(value: Option<std::ffi::OsString>) -> Result<Option<PathBuf>> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let dir = PathBuf::from(value);
    if dir.is_absolute() {
        return Ok(Some(dir));
    }
    Err(Error::Config(format!(
        "{CONFIG_DIR_ENV}={} is a relative path: it must name the runner's config directory \
         (the one holding config.toml) by an absolute path, or be unset",
        dir.display()
    )))
}

fn base_dir_from(
    named: Option<std::ffi::OsString>,
    os_dir: impl FnOnce() -> Result<PathBuf>,
) -> Result<PathBuf> {
    match named_dir(named)? {
        Some(dir) => Ok(dir),
        None => Ok(os_dir()?.join("forge-runner")),
    }
}

fn os_config_dir() -> Result<PathBuf> {
    dirs_next::config_dir().ok_or_else(|| Error::Config("cannot resolve OS config dir".into()))
}

impl Config {
    /// `config.toml` in [`base_dir`].
    pub fn path() -> Result<PathBuf> {
        Ok(base_dir()?.join("config.toml"))
    }

    /// Load config, or a default if the file does not exist yet.
    pub fn load() -> Result<Self> {
        let p = Self::path()?;
        if !p.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(&p)?;
        warn_on_retired_concurrency_keys(&raw, &p);
        let mut cfg: Config = toml::from_str(&raw)
            .map_err(|e| Error::Config(format!("parse {}: {e}", p.display())))?;
        cfg.plugins.migrate_retired_marketplace(&p);
        Ok(cfg)
    }

    /// Atomic write (`.tmp` + rename).
    pub fn save(&self) -> Result<()> {
        let p = base_dir()?.join("config.toml");
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

pub fn unoverridden_config_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "linux")]
    {
        dirs_next::home_dir().map(|h| h.join(".config").join("forge-runner"))
    }
    // Only Linux has the user manager this unit is placed in, and `dirs_next`
    // consults no XDG variable elsewhere, so the resolved dir IS the box's own.
    #[cfg(not(target_os = "linux"))]
    {
        dirs_next::config_dir().map(|d| d.join("forge-runner"))
    }
}

/// Whether `dir` is the config dir this box's user resolves with no override: the daemon that
/// owns the box-wide names (the session unit, the OS data dir's ledger) rather than a second one.
pub fn is_the_boxs_own_config_dir(dir: &std::path::Path) -> bool {
    unoverridden_config_dir().is_none_or(|own| resolved(dir) == resolved(&own))
}

pub fn resolved(p: &std::path::Path) -> std::path::PathBuf {
    if let Ok(whole) = p.canonicalize() {
        return whole;
    }
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = p;
    while let (Some(parent), Some(name)) = (cursor.parent(), cursor.file_name()) {
        missing.push(name.to_os_string());
        if let Ok(base) = parent.canonicalize() {
            let mut out = base;
            for part in missing.iter().rev() {
                out.push(part);
            }
            return out;
        }
        cursor = parent;
    }
    p.to_path_buf()
}

/// The directory this box's marks and its plugin clones sit in.
pub fn config_dir() -> Option<PathBuf> {
    base_dir().ok()
}

/// The directory this box keeps `slug`'s master transcript and last exit in.
/// The daemon writes the record here, so it resolves through
/// [`crate::config::base_dir`].
pub fn master_dir(slug: &str) -> crate::error::Result<PathBuf> {
    Ok(base_dir()?.join("master").join(slug))
}

#[cfg(test)]
mod tests {
    use super::{base_dir_from, named_dir, Config, CONFIG_DIR_ENV};
    use std::ffi::OsString;
    use std::path::PathBuf;

    fn xdg_rule() -> crate::error::Result<PathBuf> {
        Ok(PathBuf::from("/home/u/.forge-dev-runner/xdg"))
    }

    #[test]
    fn the_runner_variable_names_the_config_dir_over_the_xdg_rule() {
        // absolute on every platform: "/srv/..." is relative on Windows, and refused there
        let dir = std::env::temp_dir().join("srv/daemon/forge-runner");
        assert_eq!(
            base_dir_from(Some(dir.clone().into_os_string()), xdg_rule).unwrap(),
            dir,
            "{CONFIG_DIR_ENV} set: forge-runner resolved its config from XDG_CONFIG_HOME instead"
        );
    }

    #[test]
    fn an_unset_or_empty_runner_variable_leaves_the_xdg_rule() {
        let want = PathBuf::from("/home/u/.forge-dev-runner/xdg/forge-runner");
        assert_eq!(base_dir_from(None, xdg_rule).unwrap(), want);
        assert_eq!(
            base_dir_from(Some(OsString::new()), xdg_rule).unwrap(),
            want
        );
    }

    #[test]
    fn a_relative_runner_variable_is_refused_by_name() {
        let err = base_dir_from(Some(OsString::from("cfg/forge-runner")), xdg_rule)
            .expect_err("a relative config dir was taken")
            .to_string();
        assert!(err.contains(CONFIG_DIR_ENV), "{err}");
        assert!(err.contains("cfg/forge-runner"), "{err}");
        assert!(named_dir(Some(OsString::from("cfg"))).is_err());
    }

    #[test]
    fn a_config_written_with_the_retired_claude_mode_still_loads_and_does_not_write_it_back() {
        let cfg: Config = toml::from_str("core_url = \"https://x\"\nclaude_mode = \"wsl\"\n")
            .expect("a key nothing reads must not refuse the whole config");
        assert_eq!(cfg.core_url.as_deref(), Some("https://x"));
        let saved = toml::to_string_pretty(&cfg).unwrap();
        assert!(!saved.contains("claude_mode"), "{saved}");
    }
}
