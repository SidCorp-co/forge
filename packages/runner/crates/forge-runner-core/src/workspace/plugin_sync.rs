//! Device-level shared-skill delivery via a Claude Code plugin marketplace
//! (ISS-739) — the 3rd skill-delivery channel alongside per-project disk sync
//! (`skill_sync`, ISS-737/ISS-278) and MCP-served meta prompts.
//!
//! Every pipeline job spawns `claude -p` inheriting the daemon's default
//! Claude config dir (`process::build_command` sets no `CLAUDE_CONFIG_DIR`),
//! so a plugin installed once here, at device level, is visible to every job
//! without per-project sync. This module never touches that job exec path.
//!
//! Best-effort by contract, like the sibling `provision`/`skill_sync` sweeps:
//! every step logs and continues on failure so a flaky network or an already
//! satisfied precondition (marketplace already added, plugin already
//! installed) never wedges the daemon's background sweep.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;

use crate::config::PluginSettings;
use crate::runner::process::resolve_claude_bin;

/// Wall-clock bound per `claude plugin ...` invocation. Marketplace `add`
/// does a git clone, so this is generous, but a hung network op must not pin
/// the sweep task forever.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// One resolved install target. The device's own `[plugins]` block and the server's per-project
/// designation both project down to this shape, so the sweep has a single code path.
#[derive(Debug, Clone, PartialEq)]
pub struct PluginTarget {
    pub marketplace: String,
    pub name: String,
    pub pinned_ref: Option<String>,
    pub auto_update: bool,
}

/// Targets declared in this device's own config.toml.
pub fn local_targets(settings: &PluginSettings) -> Vec<PluginTarget> {
    let Some(repo) = settings.marketplace_repo.as_deref() else {
        return Vec::new();
    };
    settings
        .plugin_names
        .iter()
        .map(|name| PluginTarget {
            marketplace: repo.to_string(),
            name: name.clone(),
            pinned_ref: settings.pinned_ref.clone(),
            auto_update: settings.auto_update,
        })
        .collect()
}

/// Union local and server targets, keyed by `marketplace + name`.
///
/// Local wins on a collision, deliberately: a device operator has to be able to override or freeze
/// a fleet-wide designation without server access, and `plugins.enabled = false` stays an absolute
/// kill switch above both.
pub fn merge_targets(local: Vec<PluginTarget>, server: Vec<PluginTarget>) -> Vec<PluginTarget> {
    let mut out = local;
    for s in server {
        if !out
            .iter()
            .any(|l| l.marketplace == s.marketplace && l.name == s.name)
        {
            out.push(s);
        }
    }
    out
}

/// Idempotently bring this device's plugin state in line with `settings` plus the server-designated
/// `server` targets. Per marketplace: sync the runner-owned clone (pin or tip), register it with
/// the CLI as a directory marketplace, install + enable each plugin, then re-sync the installs to
/// whatever the clone has checked out. No-op when disabled or when nothing is configured.
/// Never panics; every step is logged and independent of the others.
pub async fn ensure_plugins(settings: &PluginSettings, server: &[PluginTarget]) {
    if !settings.enabled {
        return;
    }

    let targets = merge_targets(local_targets(settings), server.to_vec());
    if targets.is_empty() {
        tracing::debug!("[plugins] enabled but no local or server-designated plugins — skipping");
        return;
    }

    let mut marketplaces: Vec<String> = Vec::new();
    for t in &targets {
        if !marketplaces.contains(&t.marketplace) {
            marketplaces.push(t.marketplace.clone());
        }
    }

    for repo in &marketplaces {
        let group: Vec<&PluginTarget> = targets.iter().filter(|t| &t.marketplace == repo).collect();

        let pins: BTreeSet<&str> = group
            .iter()
            .filter_map(|t| t.pinned_ref.as_deref())
            .collect();
        let pin = match pins.len() {
            0 => None,
            1 => pins.iter().next().copied(),
            _ => {
                tracing::warn!(
                    "[plugins] {repo}: conflicting pins {pins:?} across designated plugins — a device \
                     holds one clone, so it follows the tip this cycle"
                );
                None
            }
        };
        let follow_tip = pin.is_none() && group.iter().any(|t| t.auto_update);

        let Some(dir) = marketplace_clone_dir(repo) else {
            tracing::warn!("[plugins] {repo}: cannot resolve the runner config dir — skipping");
            continue;
        };
        let head = match sync_clone(&dir, &repo_url(repo), pin, follow_tip).await {
            Ok(head) => head,
            Err(e) => {
                tracing::warn!(
                    "[plugins] {repo}: clone sync failed, installing from what is on disk: {e}"
                );
                String::from("?")
            }
        };

        let Some(mp) = register_marketplace(repo, &dir).await else {
            tracing::info!(
                "[plugins] {repo}: no runner-owned marketplace to install from — skipping installs"
            );
            continue;
        };

        for t in &group {
            let install_id = format!("{}@{mp}", t.name);
            if let Err(e) = run_claude(&["plugin", "install", &install_id, "--scope", "user"]).await
            {
                tracing::info!("[plugins] install {install_id} (may already be installed): {e}");
            }
            if let Err(e) = run_claude(&["plugin", "enable", &t.name, "--scope", "user"]).await {
                tracing::debug!("[plugins] enable {} (may already be enabled): {e}", t.name);
            }
            if let Err(e) = run_claude(&["plugin", "update", &install_id]).await {
                tracing::debug!("[plugins] update {install_id}: {e}");
            }
        }
        tracing::info!(
            "[plugins] {repo} @ {head}: {:?}{}",
            group.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            pin.map(|p| format!(" (pinned {p})")).unwrap_or_default()
        );
    }
}

/// `<runner config dir>/marketplaces/<owner>__<repo>` — a clone the runner owns, so the CLI has
/// nothing of its own to re-clone.
pub fn marketplace_clone_dir(repo: &str) -> Option<PathBuf> {
    Some(
        crate::config::base_dir()
            .ok()?
            .join("marketplaces")
            .join(repo_key(repo).replace('/', "__")),
    )
}

/// `owner/repo` shorthand becomes a GitHub HTTPS URL; anything with a scheme or `git@` is a URL already.
pub fn repo_url(repo: &str) -> String {
    if repo.contains("://") || repo.starts_with("git@") {
        repo.to_string()
    } else {
        format!("https://github.com/{}.git", repo.trim_matches('/'))
    }
}

pub async fn sync_clone(
    dir: &Path,
    url: &str,
    pin: Option<&str>,
    follow_tip: bool,
) -> Result<String, String> {
    if !dir.join(".git").is_dir() {
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let dir_s = dir.to_string_lossy().into_owned();
        git(None, &["clone", "--quiet", url, &dir_s]).await?;
    }

    if let Some(sha) = pin {
        let known = git(Some(dir), &["cat-file", "-e", &format!("{sha}^{{commit}}")])
            .await
            .is_ok();
        if !known
            && git(Some(dir), &["fetch", "--quiet", "origin", sha])
                .await
                .is_err()
        {
            git(Some(dir), &["fetch", "--quiet", "--all", "--tags"]).await?;
        }
        git(Some(dir), &["checkout", "--quiet", "--detach", sha]).await?;
    } else if follow_tip {
        git(Some(dir), &["fetch", "--quiet", "origin"]).await?;
        git(
            Some(dir),
            &["checkout", "--quiet", "--detach", "origin/HEAD"],
        )
        .await?;
    }

    git(Some(dir), &["rev-parse", "--short", "HEAD"]).await
}

/// What `known_marketplaces.json` says about a repo we want served from `dir`.
#[derive(Debug, PartialEq)]
pub enum KnownMarketplace {
    /// Already the directory marketplace at `dir`, under this CLI name.
    Registered(String),
    /// The CLI's own github clone of the same repo, under this name — ours to replace.
    Legacy(String),
    /// A directory the operator registered under the name this repo's `marketplace.json` claims — theirs; the runner leaves it.
    Foreign(String, PathBuf),
    Absent,
}

pub fn classify_known(json: &str, repo: &str, dir: &Path, name: Option<&str>) -> KnownMarketplace {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return KnownMarketplace::Absent;
    };
    let Some(obj) = v.as_object() else {
        return KnownMarketplace::Absent;
    };
    let mut legacy = None;
    for (key, entry) in obj {
        let source = entry.get("source");
        let path = source.and_then(|s| s.get("path")).and_then(|p| p.as_str());
        if path.is_some_and(|p| Path::new(p) == dir) {
            return KnownMarketplace::Registered(key.clone());
        }
        if name == Some(key.as_str()) {
            if let Some(p) = path {
                return KnownMarketplace::Foreign(key.clone(), PathBuf::from(p));
            }
        }
        let recorded = source.and_then(|s| s.get("repo")).and_then(|r| r.as_str());
        if recorded.is_some_and(|r| repo_matches(repo, r)) {
            legacy = Some(key.clone());
        }
    }
    legacy.map_or(KnownMarketplace::Absent, KnownMarketplace::Legacy)
}

/// The name the CLI will register this clone under: `.claude-plugin/marketplace.json` → `name`.
fn marketplace_name_in(dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join(".claude-plugin").join("marketplace.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("name")?.as_str().map(str::to_owned)
}

fn read_known_marketplaces() -> String {
    claude_config_dir()
        .map(|d| d.join("plugins").join("known_marketplaces.json"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

/// Make the CLI serve `repo` from `dir`, returning the marketplace name it registered (the name is
/// the plugin repo's own `marketplace.json` name, needed for `plugin@name` ids).
async fn register_marketplace(repo: &str, dir: &Path) -> Option<String> {
    let name = marketplace_name_in(dir);
    match classify_known(&read_known_marketplaces(), repo, dir, name.as_deref()) {
        KnownMarketplace::Registered(name) => return Some(name),
        KnownMarketplace::Foreign(name, path) => {
            tracing::warn!(
                "[plugins] {repo}: '{name}' is registered to {} by the operator — leaving it; the server designation is not applied on this device",
                path.display()
            );
            return None;
        }
        KnownMarketplace::Legacy(name) => {
            tracing::info!("[plugins] {repo}: replacing CLI-owned marketplace '{name}' with the runner's clone");
            if let Err(e) = run_claude(&["plugin", "marketplace", "remove", &name]).await {
                tracing::warn!("[plugins] marketplace remove {name}: {e}");
            }
        }
        KnownMarketplace::Absent => {}
    }
    let dir_s = dir.to_string_lossy().into_owned();
    if let Err(e) = run_claude(&["plugin", "marketplace", "add", &dir_s, "--scope", "user"]).await {
        tracing::info!("[plugins] marketplace add {dir_s} (may already be added): {e}");
    }
    match classify_known(&read_known_marketplaces(), repo, dir, name.as_deref()) {
        KnownMarketplace::Registered(name) => Some(name),
        _ => None,
    }
}

async fn git(dir: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    if let Some(d) = dir {
        cmd.arg("-C").arg(d);
    }
    let out = tokio::time::timeout(COMMAND_TIMEOUT, cmd.args(args).output())
        .await
        .map_err(|_| format!("git {} timed out", args.join(" ")))?
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Resolve the Claude config dir the CLI itself would use: an explicit
/// `CLAUDE_CONFIG_DIR` (respecting an operator override, same rule as
/// `process::build_command`'s `MCP_TOOL_TIMEOUT`), else `~/.claude`.
fn claude_config_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    dirs_next::home_dir().map(|h| h.join(".claude"))
}

/// `owner/repo`, lower-cased, from a shorthand or any git URL shape.
fn repo_key(s: &str) -> String {
    s.trim_end_matches('/')
        .trim_end_matches(".git")
        .rsplit(['/', ':'])
        .take(2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("/")
        .to_ascii_lowercase()
}

/// Compares a configured source (`owner/repo` shorthand or a full git URL)
/// against the `owner/repo` the CLI recorded, case-insensitively and
/// tolerant of a `.git` suffix / URL prefix on either side.
fn repo_matches(configured: &str, recorded: &str) -> bool {
    repo_key(configured) == repo_key(recorded)
}

/// Run `claude <args>` with a bounded timeout, returning `Err` (never
/// panicking) on a non-zero exit, spawn failure, or timeout.
async fn run_claude(args: &[&str]) -> crate::error::Result<()> {
    let output = tokio::time::timeout(
        COMMAND_TIMEOUT,
        Command::new(resolve_claude_bin()).args(args).output(),
    )
    .await
    .map_err(|_| crate::error::Error::Other(format!("claude {} timed out", args.join(" "))))??;

    if !output.status.success() {
        return Err(crate::error::Error::Other(format!(
            "claude {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
}
