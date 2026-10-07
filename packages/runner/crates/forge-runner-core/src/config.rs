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
    /// MCP-served meta prompts. Defaults to the first-party `forge` plugin,
    /// installed on every device — the driver skill every `drive` job runs
    /// lives there, so a runner without it cannot do the work it was paired
    /// for. An explicit `enabled = false` still opts a device out.
    #[serde(default)]
    pub plugins: PluginSettings,

    /// project-slug -> local repo binding. One runner is registered per binding.
    #[serde(default)]
    pub bindings: HashMap<String, Binding>,

    /// Per-model prices `forge-runner top` estimates spend with, keyed by a
    /// transcript's `message.model`: `input`, `output`, `cache_write` and
    /// `cache_read`, in US dollars per million tokens (ISS-1375). Kept as
    /// TOML here and read by `top` alone, so an entry it cannot price is
    /// named there and never stops the daemon reading this file.
    #[serde(default, skip_serializing_if = "toml::Table::is_empty")]
    pub rates: toml::Table,
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
    /// Send `runner:register` (gated behind core `runnerFramework` flag).
    #[serde(default)]
    pub register_enabled: bool,
    #[serde(default = "default_max_job_panes")]
    pub max_job_panes: u32,
}

impl Default for RunnerSettings {
    fn default() -> Self {
        Self {
            duplex_max_sessions: default_duplex_max_sessions(),
            register_enabled: false,
            max_job_panes: default_max_job_panes(),
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
    /// Core project id (uuid). Required to match incoming jobs and to
    /// `runner:register`. Resolved at pair/bind time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

/// `~/.config/forge-runner`, where every file this box writes about itself
/// sits. [`Config::path`] names the same directory for reading; this is the
/// one a writer resolves, so the test build's refusal covers every write.
pub fn base_dir() -> Result<PathBuf> {
    let dir = os_config_dir()?;
    // A fixture project id a test wrote into the invoking user's own dir
    // became the live box's state and silenced its pool report (ISS-1344).
    #[cfg(any(test, feature = "test-support"))]
    refuse_outside_a_scratch(&dir, "writes under no config dir", CONFIG_HOME)?;
    Ok(dir.join("forge-runner"))
}

/// The OS data dir, where the ledger sits: `~/.local/share` on Linux, and the
/// config dir itself on macOS and Windows. A test build resolves it as
/// [`base_dir`] does, and refuses reads as well as writes outside a test's own
/// scratch: a spawned `forge-runner status` read the live box's ledger.
pub fn data_dir() -> Result<PathBuf> {
    #[expect(
        clippy::disallowed_methods,
        reason = "the OS data dir data_dir falls back to, guarded below in a test build"
    )]
    let dir = os_dir(DATA_HOME, dirs_next::data_dir, "data")?;
    #[cfg(any(test, feature = "test-support"))]
    refuse_outside_a_scratch(&dir, "resolves no data dir", DATA_HOME)?;
    Ok(dir)
}

/// The user's home, where Claude Code keeps its transcripts. A test build
/// resolves it as [`data_dir`] does: a scratch `HOME` on every platform, and a
/// refusal for any home outside a test's own scratch, since a test that wrote
/// a transcript under the invoking user's home left its directory there.
pub fn home_dir() -> Result<PathBuf> {
    #[expect(
        clippy::disallowed_methods,
        reason = "the OS home home_dir falls back to, guarded below in a test build"
    )]
    let dir = os_dir(HOME, dirs_next::home_dir, "home")?;
    #[cfg(any(test, feature = "test-support"))]
    refuse_outside_a_scratch(&dir, "resolves no home", HOME)?;
    Ok(dir)
}

#[cfg(any(test, feature = "test-support"))]
fn refuse_outside_a_scratch(dir: &std::path::Path, what: &str, var: &str) -> Result<()> {
    if crate::test_scratch::is_scratch(dir) {
        return Ok(());
    }
    Err(Error::Config(format!(
        "a test build {what} but a test's own scratch, and {} is not one — scope {var} to a \
         test_scratch::Scratch first",
        dir.display()
    )))
}

#[expect(
    clippy::disallowed_methods,
    reason = "the OS config dir base_dir and Config::path fall back to; base_dir guards it in a test build"
)]
fn os_config_dir() -> Result<PathBuf> {
    os_dir(CONFIG_HOME, dirs_next::config_dir, "config")
}

/// The variables a test build scopes the config, data and home dirs with.
const CONFIG_HOME: &str = "XDG_CONFIG_HOME";
const DATA_HOME: &str = "XDG_DATA_HOME";
const HOME: &str = "HOME";

/// The OS's `what` dir. A test build honours a scratch `var` on every
/// platform, so a test scoping it is isolated where `dirs_next` ignores it.
fn os_dir(var: &str, os: fn() -> Option<PathBuf>, what: &str) -> Result<PathBuf> {
    #[cfg(any(test, feature = "test-support"))]
    #[expect(
        clippy::disallowed_methods,
        reason = "the variable a test build scopes the dir with, taken only where it is a scratch"
    )]
    if let Some(x) = std::env::var_os(var).map(PathBuf::from) {
        if x.is_absolute() && crate::test_scratch::is_scratch(&x) {
            return Ok(x);
        }
    }
    #[cfg(not(any(test, feature = "test-support")))]
    let _ = var;
    os().ok_or_else(|| Error::Config(format!("cannot resolve OS {what} dir")))
}

impl Config {
    /// `~/.config/forge-runner/config.toml`.
    pub fn path() -> Result<PathBuf> {
        Ok(os_config_dir()?.join("forge-runner").join("config.toml"))
    }

    /// Load config, or a default if the file does not exist yet.
    pub fn load() -> Result<Self> {
        #[expect(
            clippy::disallowed_methods,
            reason = "Config::load reads config.toml where Config::path names it"
        )]
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

#[cfg(test)]
mod tests {
    use super::*;

    /// ISS-1344. A test build writes under no config dir but a test's own
    /// scratch: not one that may be the invoking user's own, and not one that is
    /// merely under the temp dir. Reading where the box's config lives is not a
    /// write, so [`Config::path`] still answers it.
    #[test]
    fn a_test_build_writes_under_no_config_dir_but_a_tests_own_scratch() {
        use crate::auth::cred_store::{ScopedVar, ENV_TEST_LOCK};
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let own = crate::test_scratch::Scratch::new("config-own");
        let temp_dir = own.path().parent().expect("the temp dir").to_path_buf();
        // Strictly under the temp dir and named like no scratch: a guard that
        // took the whole temp dir would take these, where the temp dir itself
        // is refused for having nothing after the prefix.
        let under_temp = temp_dir.join("iss-1344-not-a-scratch");
        let under_tmp = PathBuf::from("/tmp").join("iss-1344-not-a-scratch");
        let users_own = PathBuf::from(if cfg!(windows) {
            r"C:\iss-1344-nobody\AppData\Roaming"
        } else {
            "/iss-1344-nobody/.config"
        });
        let xdg = ScopedVar::set("XDG_CONFIG_HOME", &users_own);
        for refused_dir in [&users_own, &temp_dir, &under_temp, &under_tmp] {
            xdg.move_to(refused_dir);
            let refused = base_dir().expect_err("not a test's own scratch");
            assert!(refused.to_string().contains("is not one"), "{refused}");
            // Elsewhere `dirs_next` ignores the variable, so the refusal names
            // the OS's own dir rather than this one.
            #[cfg(target_os = "linux")]
            assert!(
                refused
                    .to_string()
                    .contains(&refused_dir.display().to_string()),
                "the refusal names the directory: {refused}"
            );
            assert_eq!(crate::daemon::control::config_dir(), None);
            assert!(crate::daemon::control::socket_path().is_none());
            assert!(crate::daemon::pool_jobs::FileRecords::default_dir().is_none());
            assert!(crate::auth::git_cred::git_credentials_path().is_err());
            assert!(Config::default().save().is_err());
        }
        #[cfg(target_os = "linux")]
        {
            xdg.move_to(&users_own);
            #[expect(
                clippy::disallowed_methods,
                reason = "the test that reading where the config lives is still answered outside a scratch"
            )]
            let read = Config::path().unwrap();
            assert_eq!(
                read,
                users_own.join("forge-runner").join("config.toml"),
                "reading where the config lives is still answered"
            );
        }

        xdg.move_to(own.path());
        assert_eq!(
            crate::daemon::control::config_dir(),
            Some(own.path().join("forge-runner"))
        );
        Config::default()
            .save()
            .expect("a test's own scratch takes the write");
        assert!(own
            .path()
            .join("forge-runner")
            .join("config.toml")
            .is_file());
    }

    /// ISS-1344. A test build resolves no data dir, where the ledger sits, but
    /// a test's own scratch, and refuses reads too: a spawned `status` read
    /// the live box's ledger. A scratch `XDG_DATA_HOME` is honoured on every
    /// platform, where `dirs_next` reads it on Linux alone.
    #[test]
    fn a_test_build_resolves_no_data_dir_but_a_tests_own_scratch() {
        use crate::auth::cred_store::{ScopedVar, ENV_TEST_LOCK};
        use crate::runner::ledger::Ledger;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let own = crate::test_scratch::Scratch::new("data-own");
        let temp_dir = own.path().parent().expect("the temp dir").to_path_buf();
        let under_temp = temp_dir.join("iss-1344-not-a-scratch");
        let users_own = PathBuf::from(if cfg!(windows) {
            r"C:\iss-1344-nobody\AppData\Roaming"
        } else {
            "/iss-1344-nobody/.local/share"
        });
        let xdg = ScopedVar::set("XDG_DATA_HOME", &users_own);
        for refused_dir in [&users_own, &temp_dir, &under_temp] {
            xdg.move_to(refused_dir);
            let refused = Ledger::default_path().expect_err("not a test's own scratch");
            let said = refused.to_string();
            assert!(
                said.contains("resolves no data dir") && said.contains("is not one"),
                "{said}"
            );
            #[cfg(target_os = "linux")]
            assert!(
                said.contains(&refused_dir.display().to_string()),
                "the refusal names the directory: {said}"
            );
        }
        xdg.move_to(own.path());
        assert_eq!(
            Ledger::default_path().unwrap(),
            own.path().join("forge-runner").join("ledger.sqlite"),
            "a scratch XDG_DATA_HOME is where the ledger resolves, on every platform"
        );
    }

    /// ISS-1344. A test build resolves no home but a test's own scratch, so a
    /// test that writes a transcript cannot reach the invoking user's home. A
    /// scratch `HOME` is honoured on every platform, where `dirs_next` reads it
    /// on Unix alone.
    #[test]
    fn a_test_build_resolves_no_home_but_a_tests_own_scratch() {
        use crate::auth::cred_store::{ScopedVar, ENV_TEST_LOCK};
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let own = crate::test_scratch::Scratch::new("home-own");
        let temp_dir = own.path().parent().expect("the temp dir").to_path_buf();
        let under_temp = temp_dir.join("iss-1344-not-a-scratch");
        let users_own = PathBuf::from(if cfg!(windows) {
            r"C:\Users\iss-1344-nobody"
        } else {
            "/iss-1344-nobody"
        });
        let home = ScopedVar::set("HOME", &users_own);
        for refused_dir in [&users_own, &temp_dir, &under_temp] {
            home.move_to(refused_dir);
            let said = home_dir()
                .expect_err("not a test's own scratch")
                .to_string();
            assert!(
                said.contains("resolves no home") && said.contains("is not one"),
                "{said}"
            );
            #[cfg(target_os = "linux")]
            assert!(
                said.contains(&refused_dir.display().to_string()),
                "the refusal names the directory: {said}"
            );
        }
        home.move_to(own.path());
        assert_eq!(
            home_dir().unwrap(),
            own.path(),
            "a scratch HOME is the home, on every platform"
        );
    }

    /// ISS-1344. A writer under the config dir resolves it through
    /// [`base_dir`], the ledger through [`data_dir`] and a transcript's home
    /// through [`home_dir`], so the test build's refusal reaches all three.
    /// Every other route `packages/runner/clippy.toml` names, in any target of
    /// either crate, is counted here per occurrence by file with what it does,
    /// as clippy resolves it with every lint attribute overridden, so a new one
    /// goes red until it is either moved or argued in. The spelling of a read
    /// is the compiler's business, not this test's: two judges beat a token
    /// scan with spellings it did not know.
    #[test]
    fn every_other_resolution_of_the_config_dir_is_a_counted_reader() {
        // File, its occurrences on Linux, macOS and Windows, and what they do.
        const ALLOWED: &[(&str, [usize; 3], &str)] = &[
            (
                "forge-runner-core/build.rs",
                [3, 3, 3],
                "the target triple, the package version and the FORGE_RUNNER_* stamps the \
                 build stamps into the binary",
            ),
            (
                "forge-runner-core/src/auth/cred_store.rs",
                [4, 4, 4],
                "FORGE_RUNNER_CRED_STORE and FORGE_PAT, operator overrides; and ScopedVar's set \
                 and unset, each reading the value it puts back; test only",
            ),
            (
                "forge-runner-core/src/auth/pairing.rs",
                [1, 1, 1],
                "FORGE_RUNNER_MACHINE_ID, an operator override",
            ),
            (
                "forge-runner-core/src/config.rs",
                [6, 5, 5],
                "the three OS dirs base_dir, data_dir and home_dir fall back to, guarded in a test \
                 build; os_dir's read of the variable a test scopes them with; Config::load's \
                 read; and, on Linux, the test that reading is still answered outside a scratch",
            ),
            (
                "forge-runner-core/src/daemon/handover.rs",
                [2, 2, 0],
                "the environment a handover passes whole to the daemon taking over, and the \
                 listener a replaced image was handed",
            ),
            (
                "forge-runner-core/src/daemon/pane_path.rs",
                [2, 2, 2],
                "$HOME for $HOME/.local/bin on a pane's PATH, which is not the config dir, and \
                 the PATH a pane inherits",
            ),
            (
                "forge-runner-core/src/daemon/pool_jobs.rs",
                [1, 1, 0],
                "a test reads the PATH the pane was built from",
            ),
            (
                "forge-runner-core/src/daemon/serving.rs",
                [2, 0, 0],
                "the Linux test of config_dir_in's production rule, which hands it this \
                 process's environment and compares it with Config::path",
            ),
            (
                "forge-runner-core/src/daemon/session_tokens.rs",
                [1, 1, 1],
                "FORGE_CONTROL_TOKEN, the token the daemon spawned this session with",
            ),
            (
                "forge-runner-core/src/daemon/terminal.rs",
                [8, 8, 7],
                "session_config_dir, the tmux socket's dir, a writer held by ISS-1265, which owes \
                 its move to base_dir; unoverridden_config_dir's platform arm, a comparison; \
                 MCP_TOOL_TIMEOUT; and tests reading PATH, MCP_TOOL_TIMEOUT, \
                 FORGE_TEST_REQUIRE_TMUX and the fake tmux's own variables",
            ),
            ("forge-runner-core/src/exe.rs", [1, 1, 1], "the PATH a binary is resolved on"),
            (
                "forge-runner-core/src/mcp/config.rs",
                [1, 1, 1],
                "mcp_read_dir: where session_path, session_dir and session_matches read",
            ),
            (
                "forge-runner-core/src/runner/claude_code.rs",
                [1, 1, 1],
                "MCP_TIMEOUT, an operator value the spawned claude keeps",
            ),
            (
                "forge-runner-core/src/runner/process.rs",
                [2, 2, 1],
                "resolve_claude_bin: $HOME for where the claude binary is installed, a read; and \
                 MCP_TOOL_TIMEOUT",
            ),
            (
                "forge-runner-core/src/workspace/plugin_sync.rs",
                [2, 2, 2],
                "CLAUDE_CONFIG_DIR or ~/.claude, Claude Code's own home, which is not the config \
                 dir",
            ),
            (
                "forge-runner-core/src/workspace/skill_sync.rs",
                [1, 1, 1],
                "detect_user_shadow, which reads ~/.claude/skills",
            ),
            (
                "forge-runner-core/src/workspace/trust.rs",
                [2, 2, 2],
                "CLAUDE_CONFIG_DIR or ~/.claude.json, Claude Code's trust file, which is not the \
                 config dir",
            ),
            (
                "forge-runner/src/cmd/api.rs",
                [1, 1, 1],
                "FORGE_PROJECT_SLUG, the project a pane runs for",
            ),
            ("forge-runner/src/cmd/config.rs", [2, 2, 2], "prints the path"),
            ("forge-runner/src/cmd/doctor.rs", [1, 1, 1], "reads the config"),
            (
                "forge-runner/src/cmd/gate.rs",
                [3, 3, 3],
                "TMUX_PANE and TMUX, the pane and server a hook runs in",
            ),
            (
                "forge-runner/src/cmd/hook.rs",
                [1, 1, 1],
                "connects to the daemon's socket",
            ),
            (
                "forge-runner/src/cmd/master.rs",
                [4, 4, 4],
                "reads transcripts and the masters' records; USER or LOGNAME, the operator a \
                 message names",
            ),
            (
                "forge-runner/src/cmd/run.rs",
                [1, 1, 1],
                "connects to the daemon's socket",
            ),
            (
                "forge-runner/src/cmd/service.rs",
                [2, 2, 0],
                "the systemd unit and XDG_RUNTIME_DIR on Linux, the launchd plist and log on \
                 macOS, written by `service install`, which no test runs",
            ),
            (
                "forge-runner/src/cmd/setup.rs",
                [4, 4, 4],
                "the PATH a binary is looked up on; the projects_root it proposes under home, \
                 saved through Config::save; and shellexpand's `~` and its test",
            ),
            (
                "forge-runner/src/cmd/start.rs",
                [1, 1, 0],
                "the listener a replaced image was handed",
            ),
            (
                "forge-runner/src/cmd/top/gather.rs",
                [4, 4, 4],
                "prints the path, hands cli_config_dir home and a reader of this process's \
                 environment, and reads the transcripts under home's .claude/projects for SPEND \
                 (ISS-1375), a read",
            ),
            (
                "forge-runner/src/cmd/top/mod.rs",
                [1, 1, 1],
                "NO_COLOR, the operator turning colour off",
            ),
            (
                "forge-runner/src/cmd/top/panes.rs",
                [2, 2, 2],
                "a test reads FORGE_TEST_REQUIRE_TMUX and hands its tmux this process's PATH",
            ),
            (
                "forge-runner/src/cmd/update.rs",
                [1, 0, 0],
                "XDG_RUNTIME_DIR, whether systemctl --user can reach the user manager",
            ),
            (
                "forge-runner/tests/config_isolation.rs",
                [1, 1, 1],
                "the temp-dir variables it passes to the child it spawns, read by name",
            ),
            (
                "forge-runner/tests/dispatch_gate_door.rs",
                [1, 1, 0],
                "FORGE_TEST_REQUIRE_TMUX, whether this run promised a tmux",
            ),
            (
                "forge-runner/tests/handover_service_manager.rs",
                [0, 0, 1],
                "the directory the parent test handed this child image",
            ),
            (
                "forge-runner/tests/logs_command.rs",
                [1, 1, 1],
                "the PATH it hands the child it spawns",
            ),
            (
                "forge-runner/tests/master_status_unplaced.rs",
                [1, 1, 1],
                "the temp-dir variables it passes to the child it spawns, read by name",
            ),
            (
                "forge-runner/tests/update_handover.rs",
                [3, 3, 0],
                "the directory, listener and image the parent test handed this child image",
            ),
        ];
        // A path segment, by text: an admitted home joined to one adds no read clippy can count.
        const LITERALS: &[(&str, usize, &str)] = &[
            (
                "forge-runner/src/cmd/top/cli_slug.rs",
                1,
                "cli_config_dir, the forge CLI's own dir by its own rule, a read",
            ),
            (
                "forge-runner/tests/dispatch_gate_door.rs",
                1,
                "the macOS config dir under a scratch home it hands a child",
            ),
            (
                "forge-runner/tests/probation.rs",
                2,
                "the config home inside the test's scratch that an `update` child is handed",
            ),
            (
                "forge-runner-core/src/daemon/serving.rs",
                1,
                "config_dir_in, which rebuilds the XDG rule from another process's environment \
                 to compare it, and only reads",
            ),
            (
                "forge-runner-core/src/daemon/terminal.rs",
                1,
                "unoverridden_config_dir's Linux arm, a comparison",
            ),
        ];
        let crates = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let column = if cfg!(target_os = "linux") {
            0
        } else if cfg!(target_os = "macos") {
            1
        } else if cfg!(windows) {
            2
        } else {
            panic!("ALLOWED holds no counts for this platform")
        };

        let seen = disallowed_occurrences(&crates.join(".."));
        let want: std::collections::BTreeMap<&str, usize> = ALLOWED
            .iter()
            .map(|(f, n, _)| (*f, n[column]))
            .filter(|(_, n)| *n > 0)
            .collect();
        let moved = drift(&seen, &want);
        assert!(
            moved.is_empty(),
            "a route clippy.toml names that is not `config::base_dir`: a writer moves to it, a \
             reader is counted here with what it does\n{}",
            moved.join("\n")
        );

        let mut literal_seen = std::collections::BTreeMap::<String, Vec<String>>::new();
        for (rel, text) in crate_sources(&crates) {
            for (n, line) in without_comments(&text).lines().enumerate() {
                let hits = segment_needles()
                    .iter()
                    .map(|needle| line.matches(needle.as_str()).count())
                    .sum::<usize>();
                for _ in 0..hits {
                    literal_seen.entry(rel.clone()).or_default().push(format!(
                        "line {}: {}",
                        n + 1,
                        line.trim()
                    ));
                }
            }
        }
        let literal_want: std::collections::BTreeMap<&str, usize> =
            LITERALS.iter().map(|(f, n, _)| (*f, *n)).collect();
        let moved = drift(&literal_seen, &literal_want);
        assert!(
            moved.is_empty(),
            "a path segment naming a user directory: build the path from config instead, or \
             count it here with what it does\n{}",
            moved.join("\n")
        );

        // The list itself and the level that enforces it, so neither narrows in silence.
        let toml_at = |rel: &str| -> toml::Table {
            toml::from_str(&std::fs::read_to_string(crates.join(rel)).unwrap())
                .unwrap_or_else(|e| panic!("{rel}: {e}"))
        };
        let clippy = toml_at("../clippy.toml");
        let listed: Vec<(String, bool)> = clippy["disallowed-methods"]
            .as_array()
            .expect("clippy.toml lists disallowed-methods")
            .iter()
            .map(|e| {
                (
                    e["path"].as_str().unwrap().to_string(),
                    e.get("reason")
                        .and_then(toml::Value::as_str)
                        .is_some_and(|r| !r.trim().is_empty()),
                )
            })
            .collect();
        let paths: std::collections::BTreeSet<&str> =
            listed.iter().map(|(p, _)| p.as_str()).collect();
        let named: std::collections::BTreeSet<&str> = DISALLOWED.iter().copied().collect();
        assert_eq!(paths, named, "clippy.toml's disallowed-methods");
        assert!(
            listed.iter().all(|(_, reason)| *reason),
            "every disallowed method says why"
        );
        assert_eq!(listed.len(), DISALLOWED.len(), "each path once");
        let workspace = toml_at("../Cargo.toml");
        assert_eq!(
            workspace["workspace"]["lints"],
            toml::Value::Table(toml::from_str("[clippy]\ndisallowed_methods = \"deny\"").unwrap()),
            "the workspace denies the list and allows nothing past it"
        );
        for krate in ["forge-runner-core", "forge-runner"] {
            assert_eq!(
                toml_at(&format!("{krate}/Cargo.toml"))["lints"],
                toml::Value::Table(toml::from_str("workspace = true").unwrap()),
                "{krate} takes the workspace's lints and no other"
            );
        }

        let ledger =
            std::fs::read_to_string(crates.join("forge-runner-core/src/runner/ledger.rs")).unwrap();
        let default_path = ledger
            .split("pub fn default_path(")
            .nth(1)
            .and_then(|r| r.split("\n    }").next())
            .expect("Ledger::default_path is in ledger.rs");
        assert!(
            default_path.contains("crate::config::data_dir()"),
            "the ledger resolves its dir through the guarded route"
        );

        // A doctest builds this crate with no refusal and runs code clippy never lints; a renamed
        // dependency is a directory crate the key check below cannot see.
        for krate in ["forge-runner-core", "forge-runner"] {
            let m = toml_at(&format!("{krate}/Cargo.toml"));
            let has_lib = m.contains_key("lib") || crates.join(krate).join("src/lib.rs").is_file();
            assert!(
                !has_lib || runs_no_doctest(&m),
                "{krate}'s library runs doctests, which build it with no refusal: set \
                 `[lib] doctest = false`"
            );
        }
        for rel in [
            "../Cargo.toml",
            "forge-runner-core/Cargo.toml",
            "forge-runner/Cargo.toml",
        ] {
            let m = toml::Value::Table(toml_at(rel));
            let renamed = renamed_dependencies(&m, "");
            assert!(
                renamed.is_empty(),
                "{rel} renames {renamed:?}, which the directory-crate check reads by key"
            );
            let other = directory_crates(&m, "");
            assert!(
                other.is_empty(),
                "{rel} depends on {other:?}, a crate that names the user's directories, which \
                 clippy.toml lists only for dirs-next: resolve through config instead"
            );
        }
        // `doctest = false` keeps `cargo test` from running them, and an
        // explicit `cargo test --doc` runs them anyway, so the library refuses
        // to be collected for one, whatever form the doc's code takes.
        // By line, because a Windows checkout holds this file with CRLF endings.
        let lib = std::fs::read_to_string(crates.join("forge-runner-core/src/lib.rs")).unwrap();
        let lib: Vec<&str> = lib.lines().collect();
        assert!(
            lib.windows(2)
                .any(|pair| pair[0] == concat!("#[cfg(doc", "test)]")
                    && pair[1].starts_with("compile_error!(")),
            "forge-runner-core's lib.rs refuses `cargo test --doc` by name"
        );
        let doctests_on: toml::Table = toml::from_str("[lib]\ndoctest = true").unwrap();
        let no_lib_table: toml::Table = toml::from_str("[package]\nname = \"x\"").unwrap();
        assert!(!runs_no_doctest(&doctests_on) && !runs_no_doctest(&no_lib_table));
        let renamed: toml::Value =
            toml::from_str("[dependencies]\nd = { package = \"dirs\", version = \"5\" }").unwrap();
        assert_eq!(renamed_dependencies(&renamed, ""), ["dependencies.d"]);
        let plain_dirs: toml::Value = toml::from_str(
            "[dependencies]\ndirs = \"5\"\n[target.'cfg(unix)'.dev-dependencies]\nhome = \"0.5\"",
        )
        .unwrap();
        assert_eq!(
            directory_crates(&plain_dirs, ""),
            [
                "dependencies.dirs",
                "target.cfg(unix).dev-dependencies.home"
            ]
        );
        let master =
            std::fs::read_to_string(crates.join("forge-runner-core/src/daemon/master.rs")).unwrap();
        let transcript = master
            .split("pub(crate) fn conversation_transcript(")
            .nth(1)
            .and_then(|r| r.split("\n}").next())
            .expect("conversation_transcript is in master.rs");
        assert!(
            transcript.contains("crate::config::home_dir()"),
            "a transcript's home resolves through the guarded route"
        );
        let take = master
            .split("async fn take_pool_job(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .expect("take_pool_job is in master.rs");
        assert!(
            take.contains("crate::daemon::control::config_dir()"),
            "the pool-read writer resolves its dir through the guarded route"
        );
    }

    /// What `packages/runner/clippy.toml` refuses outside an admission.
    const DISALLOWED: &[&str] = &[
        "std::env::var",
        "std::env::var_os",
        "std::env::vars",
        "std::env::vars_os",
        "std::env::home_dir",
        "dirs_next::home_dir",
        "dirs_next::cache_dir",
        "dirs_next::config_dir",
        "dirs_next::data_dir",
        "dirs_next::data_local_dir",
        "dirs_next::executable_dir",
        "dirs_next::runtime_dir",
        "dirs_next::audio_dir",
        "dirs_next::desktop_dir",
        "dirs_next::document_dir",
        "dirs_next::download_dir",
        "dirs_next::font_dir",
        "dirs_next::picture_dir",
        "dirs_next::public_dir",
        "dirs_next::template_dir",
        "dirs_next::video_dir",
        "libc::getenv",
        "libc::getpwuid",
        "libc::getpwuid_r",
        "libc::getpwnam",
        "libc::getpwnam_r",
        "forge_runner_core::config::Config::path",
    ];

    /// Every occurrence of a method clippy.toml disallows, by file, as clippy
    /// resolves it with the lint forced to warn, so no `expect`, `allow`,
    /// group or inner attribute hides one. Keyed by its span and the macro call
    /// sites it came through, so a read compiled into the lib and the lib-test
    /// units counts once and one macro invoked twice counts twice.
    fn disallowed_occurrences(
        workspace: &std::path::Path,
    ) -> std::collections::BTreeMap<String, Vec<String>> {
        let mut cmd = std::process::Command::new(env!("CARGO"));
        cmd.current_dir(workspace)
            .args([
                "clippy",
                "--workspace",
                "--all-targets",
                "--locked",
                "--quiet",
                "--message-format=json",
                "--",
                "--force-warn",
                "clippy::disallowed_methods",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // The child takes this process's environment as it stands at the spawn, and a test
        // scoping HOME or PATH holds this lock while it does.
        let child = {
            let _env = crate::auth::cred_store::ENV_TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cmd.spawn()
                .unwrap_or_else(|e| panic!("cargo clippy could not be started: {e}"))
        };
        let out = child.wait_with_output().expect("cargo clippy ran");
        assert!(
            out.status.success(),
            "cargo clippy could not count the routes ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );
        let mut sites = std::collections::BTreeMap::<String, Vec<String>>::new();
        let mut keys = std::collections::BTreeSet::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let m = &msg["message"];
            if msg["reason"] != "compiler-message"
                || m["code"]["code"] != "clippy::disallowed_methods"
            {
                continue;
            }
            let Some(span) = m["spans"]
                .as_array()
                .and_then(|s| s.iter().find(|s| s["is_primary"] == true))
            else {
                continue;
            };
            let mut key = Vec::new();
            let mut at = Some(span);
            while let Some(s) = at {
                key.push(format!("{}:{}", s["file_name"], s["byte_start"]));
                at = s["expansion"]["span"]
                    .as_object()
                    .map(|_| &s["expansion"]["span"]);
            }
            if !keys.insert(key) {
                continue;
            }
            let file = span["file_name"].as_str().unwrap_or("?").replace('\\', "/");
            let file = file.strip_prefix("crates/").unwrap_or(&file).to_string();
            sites.entry(file).or_default().push(format!(
                "line {}: {}",
                span["line_start"],
                m["message"].as_str().unwrap_or("?")
            ));
        }
        sites
    }

    /// Each file whose count moved from `want`, with the sites it holds.
    fn drift(
        seen: &std::collections::BTreeMap<String, Vec<String>>,
        want: &std::collections::BTreeMap<&str, usize>,
    ) -> Vec<String> {
        seen.keys()
            .map(String::as_str)
            .chain(want.keys().copied())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .filter(|f| seen.get(*f).map_or(0, Vec::len) != want.get(f).copied().unwrap_or(0))
            .map(|f| {
                let lines = seen.get(f).into_iter().flatten();
                format!(
                    "{f}: {} occurrence(s), {} counted\n{}",
                    seen.get(f).map_or(0, Vec::len),
                    want.get(f).copied().unwrap_or(0),
                    lines
                        .map(|l| format!("    {l}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            })
            .collect()
    }

    /// `text` with every `//` and `/* */` comment blanked, strings and char
    /// literals kept as they are, and every newline kept so a line number holds.
    fn without_comments(text: &str) -> String {
        let c: Vec<char> = text.chars().collect();
        let mut out = String::with_capacity(text.len());
        let mut i = 0;
        let keep_newlines = |out: &mut String, from: &[char]| {
            out.extend(from.iter().filter(|ch| **ch == '\n'));
        };
        while i < c.len() {
            let next = c.get(i + 1).copied();
            if c[i] == '/' && next == Some('/') {
                while i < c.len() && c[i] != '\n' {
                    i += 1;
                }
            } else if c[i] == '/' && next == Some('*') {
                let (start, mut depth) = (i, 0usize);
                while i < c.len() {
                    if c[i] == '/' && c.get(i + 1) == Some(&'*') {
                        depth += 1;
                        i += 2;
                    } else if c[i] == '*' && c.get(i + 1) == Some(&'/') {
                        depth -= 1;
                        i += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
                keep_newlines(&mut out, &c[start..i.min(c.len())]);
            } else if c[i] == 'r' && matches!(next, Some('"') | Some('#')) {
                let start = i;
                i += 1;
                let mut hashes = 0;
                while c.get(i) == Some(&'#') {
                    hashes += 1;
                    i += 1;
                }
                if c.get(i) != Some(&'"') {
                    out.extend(&c[start..i]);
                    continue;
                }
                i += 1;
                while i < c.len()
                    && !(c[i] == '"' && (1..=hashes).all(|k| c.get(i + k) == Some(&'#')))
                {
                    i += 1;
                }
                i = (i + 1 + hashes).min(c.len());
                out.extend(&c[start..i]);
            } else if c[i] == '"' {
                let start = i;
                i += 1;
                while i < c.len() && c[i] != '"' {
                    i += if c[i] == '\\' { 2 } else { 1 };
                }
                i = (i + 1).min(c.len());
                out.extend(&c[start..i]);
            } else if c[i] == '\'' && (next == Some('\\') || c.get(i + 2) == Some(&'\'')) {
                let start = i;
                i += if next == Some('\\') { 3 } else { 2 };
                while i < c.len() && c[i] != '\'' {
                    i += 1;
                }
                i = (i + 1).min(c.len());
                out.extend(&c[start..i]);
            } else {
                out.push(c[i]);
                i += 1;
            }
        }
        out
    }

    /// A needle in a comment is no path segment, and one in a string is, whatever
    /// the comment or string around it holds.
    #[test]
    fn the_literal_count_reads_code_and_strings_and_no_comment() {
        let needle = &segment_needles()[0];
        let src = format!(
            "let a = 1; // {n}\n/* {n}\n /* nested */ {n} */ let b = 2;\n\
             let url = \"https://x//\"; let c = {n};\nlet q = '\"'; let r = r#\"{n} // x\"#;\n\
             let l: &'static str = {n};\n",
            n = needle
        );
        let kept = without_comments(&src);
        let at: Vec<usize> = kept
            .lines()
            .enumerate()
            .filter(|(_, l)| l.contains(needle.as_str()))
            .map(|(n, _)| n + 1)
            .collect();
        assert_eq!(at, [4, 5, 6], "{kept}");
        assert_eq!(
            kept.lines().count(),
            src.lines().count(),
            "every line is kept"
        );
    }

    /// The path segments the literal count reads, built so this file holds none of them.
    fn segment_needles() -> [String; 4] {
        [
            format!("\".{}\"", "config"),
            ["APP", "DATA"].concat(),
            ["Roaming", "AppData"].concat(),
            ["Application", " Support"].concat(),
        ]
    }

    /// Every `.rs` file of both crates, `build.rs`, tests and benches included,
    /// by its path under `crates/`.
    fn crate_sources(crates: &std::path::Path) -> Vec<(String, String)> {
        let mut stack: Vec<PathBuf> = ["forge-runner-core", "forge-runner"]
            .iter()
            .map(|krate| crates.join(krate))
            .collect();
        for root in &stack {
            assert!(root.join("src").is_dir(), "{} is a crate", root.display());
        }
        let mut files = Vec::new();
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let p = entry.path();
                if p.is_dir() {
                    if p.file_name().is_some_and(|n| n != "target") {
                        stack.push(p);
                    }
                    continue;
                }
                if p.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                let rel = p
                    .strip_prefix(crates)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                files.push((rel, std::fs::read_to_string(&p).unwrap()));
            }
        }
        files
    }

    /// ISS-1344 criterion 29. An `env!` or `option_env!` reads the build's
    /// environment at compile time, and clippy's macro lint cannot see one
    /// inside an eagerly expanded builtin such as `concat!` or a format
    /// string. rustc records every such read in the build's dep-info after
    /// expansion, so this reads that record for every build of either crate
    /// this run's target dir holds.
    #[test]
    fn no_build_of_either_crate_reads_a_user_directory_variable() {
        let refused = [
            "HOME".to_string(),
            "USERPROFILE".to_string(),
            "XDG_CONFIG_HOME".to_string(),
            "XDG_DATA_HOME".to_string(),
            ["APP", "DATA"].concat(),
            ["LOCALAPP", "DATA"].concat(),
        ];
        let exe = std::env::current_exe().expect("this test's own binary");
        let deps = exe.parent().expect("the deps dir");
        let own = deps.join(format!("{}.d", exe.file_stem().unwrap().to_string_lossy()));
        let own_reads = env_deps(&std::fs::read_to_string(&own).unwrap_or_else(|e| {
            panic!(
                "this build's own dep-info {} could not be read: {e}",
                own.display()
            )
        }));
        assert!(
            own_reads.iter().any(|v| v == "CARGO_MANIFEST_DIR"),
            "{} records no env!(\"CARGO_MANIFEST_DIR\"), which this crate reads, so the record \
             is not being read",
            own.display()
        );
        let crates = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        // Every target of either crate: its lib and bin, and each test, example and bench file.
        let mut stems = vec!["forge_runner_core".to_string(), "forge_runner".to_string()];
        for krate in ["forge-runner-core", "forge-runner"] {
            for kind in ["tests", "examples", "benches"] {
                let Ok(files) = std::fs::read_dir(crates.join(krate).join(kind)) else {
                    continue;
                };
                stems.extend(files.flatten().filter_map(|e| {
                    let p = e.path();
                    if p.extension()? != "rs" {
                        return None;
                    }
                    Some(p.file_stem()?.to_string_lossy().replace('-', "_"))
                }));
            }
        }
        let ours = |name: &str| {
            name.strip_suffix(".d")
                .and_then(|n| n.rsplit_once('-'))
                .is_some_and(|(stem, hash)| {
                    stems.iter().any(|s| s == stem) && hash.chars().all(|c| c.is_ascii_hexdigit())
                })
        };
        // The target dir's root, so a `--target` build's records and the host build scripts
        // it compiled are read wherever cargo put them.
        let root = deps
            .ancestors()
            .find(|d| d.join("CACHEDIR.TAG").is_file())
            .expect("the target dir this test was built in");
        let mut profiles = Vec::new();
        for first in std::fs::read_dir(root).unwrap().flatten() {
            let first = first.path();
            if first.join("deps").is_dir() {
                profiles.push(first.clone());
            }
            for second in std::fs::read_dir(&first).into_iter().flatten().flatten() {
                if second.path().join("deps").is_dir() {
                    profiles.push(second.path());
                }
            }
        }
        let listed = |dir: PathBuf| -> Vec<PathBuf> {
            std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path())
                .collect()
        };
        let mut records: Vec<PathBuf> = Vec::new();
        for profile in &profiles {
            for p in listed(profile.join("deps"))
                .into_iter()
                .chain(listed(profile.join("examples")))
            {
                if p.file_name().is_some_and(|n| ours(&n.to_string_lossy())) {
                    records.push(p);
                }
            }
            for build in listed(profile.join("build")) {
                if !build
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("forge-runner"))
                {
                    continue;
                }
                for f in listed(build) {
                    let name = f.file_name().unwrap().to_string_lossy().into_owned();
                    if name.starts_with("build_script_build-") && name.ends_with(".d") {
                        records.push(f);
                    }
                }
            }
        }
        assert!(
            records.contains(&own),
            "the scan reads this build's own record"
        );
        let read: Vec<String> = records
            .iter()
            .flat_map(|p| {
                let text = std::fs::read_to_string(p).unwrap_or_default();
                env_deps(&text)
                    .into_iter()
                    .filter(|v| refused.contains(v))
                    .map(|v| format!("{v}, read at compile time by the build {}", p.display()))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(
            read.is_empty(),
            "a build of a runner crate read a user directory's variable through env! or \
             option_env!, which bakes the builder's directory into the binary:\n{}",
            read.join("\n")
        );
        assert_eq!(
            env_deps("x.d: src/lib.rs\n# env-dep:HOME=/home/x\n# env-dep:TMP\n"),
            ["HOME", "TMP"],
            "a value and an unset read both name their variable"
        );
    }

    /// The variables a dep-info record says the build read.
    fn env_deps(record: &str) -> Vec<String> {
        record
            .lines()
            .filter_map(|l| l.strip_prefix("# env-dep:"))
            .map(|v| v.split_once('=').map_or(v, |(name, _)| name).to_string())
            .collect()
    }

    fn runs_no_doctest(manifest: &toml::Table) -> bool {
        manifest
            .get("lib")
            .and_then(|lib| lib.get("doctest"))
            .and_then(toml::Value::as_bool)
            == Some(false)
    }

    /// Every dependency on a crate, other than `dirs-next`, that names the
    /// user's directories, by its dotted path. A list, not a rule: a crate
    /// missing from it is a route clippy.toml does not name (ISS-1344's decision).
    fn directory_crates(v: &toml::Value, at: &str) -> Vec<String> {
        const NAMED: [&str; 11] = [
            "dirs",
            "dirs-sys",
            "dirs-sys-next",
            "directories",
            "directories-next",
            "home",
            "etcetera",
            "xdg",
            "platform-dirs",
            "app_dirs2",
            "homedir",
        ];
        let Some(table) = v.as_table() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (k, child) in table {
            let path = if at.is_empty() {
                k.clone()
            } else {
                format!("{at}.{k}")
            };
            if at.ends_with("dependencies") && NAMED.contains(&k.as_str()) {
                out.push(path.clone());
            }
            out.extend(directory_crates(child, &path));
        }
        out
    }

    /// Every dependency key carrying `package = "<name>"`, by its dotted path.
    fn renamed_dependencies(v: &toml::Value, at: &str) -> Vec<String> {
        let Some(table) = v.as_table() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (k, child) in table {
            let path = if at.is_empty() {
                k.clone()
            } else {
                format!("{at}.{k}")
            };
            if child.get("package").is_some_and(toml::Value::is_str) {
                out.push(path.clone());
            }
            out.extend(renamed_dependencies(child, &path));
        }
        out
    }

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

    #[test]
    fn a_same_named_key_in_another_table_is_not_mistaken_for_the_retired_one() {
        let raw = "[skills]\nmax_concurrent = 9\n\n[runner]\nchat_max_concurrent = 3\n";
        assert_eq!(toml_scalar_in_runner_table(raw, "max_concurrent"), None);
    }

    #[test]
    fn plugin_settings_default_to_the_first_party_plugin() {
        let cfg = Config::default();
        assert!(cfg.plugins.enabled);
        assert!(cfg.plugins.auto_update);
        assert_eq!(cfg.plugins.poll_interval_secs, 6 * 3600);
        assert_eq!(
            cfg.plugins.marketplace_repo.as_deref(),
            Some(DEFAULT_MARKETPLACE_REPO)
        );
        assert_eq!(cfg.plugins.plugin_names, vec![DEFAULT_PLUGIN_NAME]);
    }

    #[test]
    fn a_config_with_no_plugins_block_still_gets_the_first_party_plugin() {
        let cfg: Config = toml::from_str("core_url = \"https://core.example.com\"\n").unwrap();
        assert!(cfg.plugins.enabled);
        assert_eq!(cfg.plugins.plugin_names, vec![DEFAULT_PLUGIN_NAME]);
    }

    #[test]
    fn an_explicit_opt_out_survives_the_new_default() {
        let cfg: Config = toml::from_str("[plugins]\nenabled = false\n").unwrap();
        assert!(!cfg.plugins.enabled);
    }

    #[test]
    fn the_retired_marketplace_is_migrated_onto_the_first_party_one() {
        let mut plugins: PluginSettings = toml::from_str(&format!(
            "marketplace_repo = \"{RETIRED_MARKETPLACE_REPO}\"\nplugin_names = [\"forge-pipeline-skills\"]\n"
        ))
        .unwrap();
        plugins.migrate_retired_marketplace(std::path::Path::new("/tmp/config.toml"));
        assert_eq!(
            plugins.marketplace_repo.as_deref(),
            Some(DEFAULT_MARKETPLACE_REPO)
        );
        assert_eq!(plugins.plugin_names, vec![DEFAULT_PLUGIN_NAME]);
    }

    #[test]
    fn a_marketplace_nobody_retired_is_left_alone() {
        let mut plugins: PluginSettings = toml::from_str(
            "marketplace_repo = \"acme/private-skills\"\nplugin_names = [\"house-rules\"]\n",
        )
        .unwrap();
        plugins.migrate_retired_marketplace(std::path::Path::new("/tmp/config.toml"));
        assert_eq!(
            plugins.marketplace_repo.as_deref(),
            Some("acme/private-skills")
        );
        assert_eq!(plugins.plugin_names, vec!["house-rules"]);
    }

    #[test]
    fn plugin_settings_roundtrip_through_toml() {
        let mut cfg = Config::default();
        cfg.plugins.enabled = true;
        cfg.plugins.marketplace_repo = Some("acme/private-skills".into());
        cfg.plugins.plugin_names = vec!["house-rules".into()];
        cfg.plugins.pinned_ref = Some("deadbeef".into());
        let s = toml::to_string_pretty(&cfg).unwrap();
        let back: Config = toml::from_str(&s).unwrap();
        assert!(back.plugins.enabled);
        assert_eq!(
            back.plugins.marketplace_repo.as_deref(),
            Some("acme/private-skills")
        );
        assert_eq!(back.plugins.plugin_names, vec!["house-rules"]);
        assert_eq!(back.plugins.pinned_ref.as_deref(), Some("deadbeef"));
    }
}
