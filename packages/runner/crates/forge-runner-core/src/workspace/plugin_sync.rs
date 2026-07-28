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

/// A marketplace entry resolved from `known_marketplaces.json` — the name the
/// CLI registered it under (needed for `plugin@marketplace` install ids and
/// `marketplace update <name>`), and its local git clone path (needed to
/// apply the SHA pin).
struct MarketplaceInfo {
    name: String,
    install_location: PathBuf,
}

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
/// `server` targets: per marketplace, add it, apply a pin when the group agrees on one, install +
/// enable each plugin, and auto-update when nothing in that marketplace is pinned. No-op when
/// disabled or when nothing is configured on either side.
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

        if let Err(e) = run_claude(&["plugin", "marketplace", "add", repo, "--scope", "user"]).await
        {
            tracing::info!(
                "[plugins] marketplace add {repo} (may already be added, best-effort): {e}"
            );
        }

        let marketplace = find_marketplace(repo);
        if marketplace.is_none() {
            tracing::warn!(
                "[plugins] could not resolve marketplace '{repo}' from known_marketplaces.json — \
                 pin/install steps that need its name will be skipped this cycle"
            );
        }

        let pins: BTreeSet<&str> = group
            .iter()
            .filter_map(|t| t.pinned_ref.as_deref())
            .collect();
        if pins.len() > 1 {
            tracing::warn!(
                "[plugins] {repo}: conflicting pins {pins:?} across designated plugins — a device \
                 holds one clone, so no pin is applied this cycle"
            );
        } else if let Some(sha) = pins.iter().next().copied() {
            match &marketplace {
                Some(mp) => {
                    if let Err(e) = pin_marketplace_ref(&mp.install_location, sha).await {
                        tracing::warn!("[plugins] pin {repo}@{sha} failed: {e}");
                    } else {
                        tracing::info!("[plugins] {repo} pinned to {sha}");
                    }
                }
                None => tracing::warn!(
                    "[plugins] pin requested but marketplace '{repo}' not found locally — skipping"
                ),
            }
        }

        for t in &group {
            let install_id = qualified_id(&t.name, marketplace.as_ref());
            if let Err(e) = run_claude(&["plugin", "install", &install_id, "--scope", "user"]).await
            {
                tracing::info!(
                    "[plugins] install {install_id} (may already be installed, best-effort): {e}"
                );
            }
            if let Err(e) = run_claude(&["plugin", "enable", &t.name, "--scope", "user"]).await {
                tracing::debug!("[plugins] enable {} (may already be enabled): {e}", t.name);
            }
        }

        // cm:why `marketplace update` git-pulls and would fast-forward past the pin, but `plugin update` only
        // re-installs from the clone — which is AT the pin — so a pinned group still needs the latter to move
        if !pins.is_empty() {
            tracing::info!(
                "[plugins] {repo}: pinned — skipping marketplace update, syncing installs to the pin"
            );
            for t in &group {
                if let Err(e) = run_claude(&["plugin", "update", &t.name]).await {
                    tracing::debug!("[plugins] update {} to pin: {e}", t.name);
                }
            }
            continue;
        }

        let wants_update: Vec<&&PluginTarget> = group.iter().filter(|t| t.auto_update).collect();
        if wants_update.is_empty() {
            continue;
        }

        let update_args: Vec<&str> = match &marketplace {
            Some(mp) => vec!["plugin", "marketplace", "update", &mp.name],
            None => vec!["plugin", "marketplace", "update"],
        };
        if let Err(e) = run_claude(&update_args).await {
            tracing::warn!("[plugins] marketplace update failed: {e}");
        }
        for t in wants_update {
            if let Err(e) = run_claude(&["plugin", "update", &t.name]).await {
                tracing::debug!("[plugins] update {}: {e}", t.name);
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
    // cm:why a pinned marketplace skips the auto-update pass, so without this fetch the clone never learns a newer SHA and a pin can only ever move backwards
    let fetched = tokio::time::timeout(
        COMMAND_TIMEOUT,
        Command::new("git")
            .args(["-C"])
            .arg(install_location)
            .args(["fetch", "--quiet", "--all", "--tags"])
            .output(),
    )
    .await;
    match fetched {
        Ok(Ok(o)) if !o.status.success() => tracing::info!(
            "[plugins] fetch before pin {sha} (continuing, the sha may already be local): {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Ok(Err(e)) => tracing::info!("[plugins] fetch before pin {sha} failed (continuing): {e}"),
        Err(_) => tracing::info!("[plugins] fetch before pin {sha} timed out (continuing)"),
        Ok(Ok(_)) => {}
    }

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
        // Disabled settings must never spawn a `claude` process, and that has to hold even when
        // the server designates something — `enabled = false` is the operator's kill switch above
        // both sources.
        let settings = PluginSettings::default();
        let server = vec![PluginTarget {
            marketplace: "owner/repo".into(),
            name: "forge-codemap".into(),
            pinned_ref: None,
            auto_update: true,
        }];
        ensure_plugins(&settings, &server).await; // must return promptly, no panic
    }

    fn target(name: &str, pin: Option<&str>, auto: bool) -> PluginTarget {
        PluginTarget {
            marketplace: "owner/repo".into(),
            name: name.into(),
            pinned_ref: pin.map(str::to_string),
            auto_update: auto,
        }
    }

    #[test]
    fn local_targets_expands_marketplace_x_names() {
        let settings = PluginSettings {
            enabled: true,
            marketplace_repo: Some("owner/repo".into()),
            plugin_names: vec!["a".into(), "b".into()],
            pinned_ref: Some("abc1234".into()),
            auto_update: false,
            ..PluginSettings::default()
        };
        let out = local_targets(&settings);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], target("a", Some("abc1234"), false));
        assert_eq!(out[1].name, "b");
    }

    #[test]
    fn local_targets_empty_without_a_marketplace() {
        let settings = PluginSettings {
            enabled: true,
            plugin_names: vec!["a".into()],
            ..PluginSettings::default()
        };
        assert!(local_targets(&settings).is_empty());
    }

    #[test]
    fn merge_targets_local_wins_on_collision() {
        let local = vec![target("a", Some("aaaaaaa"), false)];
        let server = vec![target("a", Some("bbbbbbb"), true), target("b", None, true)];
        let out = merge_targets(local, server);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], target("a", Some("aaaaaaa"), false));
        assert_eq!(out[1].name, "b");
    }

    #[test]
    fn merge_targets_keeps_distinct_marketplaces_apart() {
        let local = vec![target("a", None, true)];
        let server = vec![PluginTarget {
            marketplace: "other/repo".into(),
            name: "a".into(),
            pinned_ref: None,
            auto_update: true,
        }];
        assert_eq!(merge_targets(local, server).len(), 2);
    }
}
