//! Device-level shared-skill delivery via a Claude Code plugin marketplace
//! (ISS-739) — the 3rd skill-delivery channel alongside per-project disk sync
//! (`skill_sync`, ISS-737/ISS-278) and MCP-served meta prompts. See
//! `docs/architecture/skill-delivery-plugin-channel.md` for the doctrine.
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

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;

use crate::config::PluginSettings;
use crate::runner::process::resolve_claude_bin;

/// Wall-clock bound per `claude plugin ...` invocation. Marketplace `add`
/// does a git clone, so this is generous, but a hung network op must not pin
/// the sweep task forever.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// A marketplace entry resolved from `known_marketplaces.json` — the name the
/// CLI registered it under (needed for `plugin@marketplace` install ids and
/// `marketplace update <name>`), and its local git clone path (needed to
/// apply the SHA pin).
struct MarketplaceInfo {
    name: String,
    install_location: PathBuf,
}

/// Idempotently bring this device's plugin state in line with `settings`:
/// add the marketplace, pin it to `pinned_ref` (if set), install + enable the
/// configured plugin(s), and — when `auto_update` — pull the latest first
/// party marketplace + plugin versions. No-op when disabled or unconfigured.
/// Never panics; every step is logged and independent of the others.
pub async fn ensure_plugins(settings: &PluginSettings) {
    if !settings.enabled {
        return;
    }
    let Some(repo) = settings.marketplace_repo.as_deref() else {
        tracing::debug!("[plugins] enabled but no marketplace_repo configured — skipping");
        return;
    };

    if let Err(e) = run_claude(&["plugin", "marketplace", "add", repo, "--scope", "user"]).await {
        tracing::info!("[plugins] marketplace add {repo} (may already be added, best-effort): {e}");
    }

    let marketplace = find_marketplace(repo);
    if marketplace.is_none() {
        tracing::warn!(
            "[plugins] could not resolve marketplace '{repo}' from known_marketplaces.json — \
             pin/install steps that need its name will be skipped this cycle"
        );
    }

    if let Some(sha) = settings.pinned_ref.as_deref() {
        match &marketplace {
            Some(mp) => {
                if let Err(e) = pin_marketplace_ref(&mp.install_location, sha).await {
                    tracing::warn!("[plugins] pin {repo}@{sha} failed: {e}");
                } else {
                    tracing::info!("[plugins] {repo} pinned to {sha}");
                }
            }
            None => tracing::warn!(
                "[plugins] pinned_ref set but marketplace '{repo}' not found locally — skipping pin"
            ),
        }
    }

    for plugin in &settings.plugin_names {
        let install_id = qualified_id(plugin, marketplace.as_ref());
        if let Err(e) = run_claude(&["plugin", "install", &install_id, "--scope", "user"]).await {
            tracing::info!(
                "[plugins] install {install_id} (may already be installed, best-effort): {e}"
            );
        }
        if let Err(e) = run_claude(&["plugin", "enable", plugin, "--scope", "user"]).await {
            tracing::debug!("[plugins] enable {plugin} (may already be enabled): {e}");
        }
    }

    if settings.auto_update {
        let update_args: Vec<&str> = match &marketplace {
            Some(mp) => vec!["plugin", "marketplace", "update", &mp.name],
            None => vec!["plugin", "marketplace", "update"],
        };
        if let Err(e) = run_claude(&update_args).await {
            tracing::warn!("[plugins] marketplace update failed: {e}");
        }
        for plugin in &settings.plugin_names {
            if let Err(e) = run_claude(&["plugin", "update", plugin]).await {
                tracing::debug!("[plugins] update {plugin}: {e}");
            }
        }
    }
}

/// `<plugin>@<marketplace-name>` when the marketplace name is known, else the
/// bare plugin name (works when only one marketplace serves it).
fn qualified_id(plugin: &str, marketplace: Option<&MarketplaceInfo>) -> String {
    match marketplace {
        Some(mp) => format!("{plugin}@{}", mp.name),
        None => plugin.to_string(),
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

/// Look up a marketplace's registered name + local clone path by matching its
/// configured source repo against `<config-dir>/plugins/known_marketplaces.json`.
/// This is an undocumented CLI-internal file (not a public contract) — best
/// effort, tolerant of a missing file or a shape the CLI has since changed.
fn find_marketplace(repo: &str) -> Option<MarketplaceInfo> {
    let path = claude_config_dir()?
        .join("plugins")
        .join("known_marketplaces.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let obj = json.as_object()?;
    for (name, entry) in obj {
        let entry_repo = entry.get("source")?.get("repo")?.as_str()?;
        if repo_matches(repo, entry_repo) {
            let install_location = entry.get("installLocation")?.as_str()?;
            return Some(MarketplaceInfo {
                name: name.clone(),
                install_location: PathBuf::from(install_location),
            });
        }
    }
    None
}

/// Compares a configured source (`owner/repo` shorthand or a full git URL)
/// against the `owner/repo` the CLI recorded, case-insensitively and
/// tolerant of a `.git` suffix / URL prefix on either side.
fn repo_matches(configured: &str, recorded: &str) -> bool {
    fn normalize(s: &str) -> String {
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
    normalize(configured) == normalize(recorded)
}

/// Checkout the pinned commit SHA in the marketplace's local git clone
/// (detached HEAD) — the installed-plugin snapshot in
/// `~/.claude/plugins/cache/...` is copied from whatever this clone has
/// checked out at install/update time.
async fn pin_marketplace_ref(install_location: &Path, sha: &str) -> crate::error::Result<()> {
    let output = tokio::time::timeout(
        COMMAND_TIMEOUT,
        Command::new("git")
            .args(["-C"])
            .arg(install_location)
            .args(["checkout", "--detach", sha])
            .output(),
    )
    .await
    .map_err(|_| crate::error::Error::Other(format!("git checkout {sha} timed out")))??;

    if !output.status.success() {
        return Err(crate::error::Error::Other(format!(
            "git checkout {sha} in {}: {}",
            install_location.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_matches_shorthand_vs_full_url() {
        assert!(repo_matches(
            "SidCorp-co/forge-pipeline-skills",
            "SidCorp-co/forge-pipeline-skills"
        ));
        assert!(repo_matches(
            "https://github.com/SidCorp-co/forge-pipeline-skills.git",
            "SidCorp-co/forge-pipeline-skills"
        ));
        assert!(repo_matches(
            "git@github.com:SidCorp-co/forge-pipeline-skills.git",
            "sidcorp-co/forge-pipeline-skills"
        ));
        assert!(!repo_matches(
            "SidCorp-co/forge-pipeline-skills",
            "anthropics/claude-plugins-official"
        ));
    }

    #[test]
    fn qualified_id_uses_marketplace_name_when_known() {
        let mp = MarketplaceInfo {
            name: "forge".into(),
            install_location: PathBuf::from("/tmp/forge"),
        };
        assert_eq!(
            qualified_id("forge-shared-skills", Some(&mp)),
            "forge-shared-skills@forge"
        );
        assert_eq!(
            qualified_id("forge-shared-skills", None),
            "forge-shared-skills"
        );
    }

    #[tokio::test]
    async fn ensure_plugins_noop_when_disabled() {
        // Disabled settings must never spawn a `claude` process — there's no
        // `marketplace_repo` here either, so a failure to no-op would panic
        // on the `Option` unwrap before this test could tell the difference,
        // but the real guard is the early return on `enabled == false`.
        let settings = PluginSettings::default();
        ensure_plugins(&settings).await; // must return promptly, no panic
    }
}
