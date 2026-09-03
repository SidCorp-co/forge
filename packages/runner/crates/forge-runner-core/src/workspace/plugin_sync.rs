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
            tracing::warn!(
                "[plugins] {repo}: not registered with the CLI after `marketplace add` — skipping installs"
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
            // cm:guard `plugin update` takes the QUALIFIED id; the bare name answers "not found" and exits non-zero, so a bare-name update here is a silent no-op that leaves the cache at whatever commit first installed it (every box, 2026-09-03)
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
    let config = crate::config::Config::path().ok()?;
    Some(
        config
            .parent()?
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

// cm:guard the runner, not the CLI, owns this clone. `claude plugin install` re-clones a github-source marketplace even when the plugin is already installed (measured on claude 2.1.241, 2026-09-03), so a pin applied to the CLI's clone survives until the next install. A directory-source marketplace gives the CLI nothing to re-clone; `plugin install`/`update` copy whatever this clone has checked out.
/// Bring the clone at `dir` to `pin`, or to `origin/HEAD` when `follow_tip`, else leave it where it
/// is. Clones (full depth) when absent. Returns the short HEAD.
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
        if !known {
            // cm:guard fetch the SHA by name, not `--all`: a pin that has left every branch tip is not moved by a tip fetch, and on a shallow clone it is never fetched at all (`reference is not a tree`, fleet-wide 2026-09-03). The tip fetch stays as the fallback for a remote that refuses SHA wants.
            if git(Some(dir), &["fetch", "--quiet", "origin", sha])
                .await
                .is_err()
            {
                git(Some(dir), &["fetch", "--quiet", "--all", "--tags"]).await?;
            }
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
    /// Registered from another source (the CLI's own github clone, or another path) under this name.
    Legacy(String),
    Absent,
}

pub fn classify_known(json: &str, repo: &str, dir: &Path) -> KnownMarketplace {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return KnownMarketplace::Absent;
    };
    let Some(obj) = v.as_object() else {
        return KnownMarketplace::Absent;
    };
    let mut legacy = None;
    for (name, entry) in obj {
        let source = entry.get("source");
        let path = source.and_then(|s| s.get("path")).and_then(|p| p.as_str());
        if path.is_some_and(|p| Path::new(p) == dir) {
            return KnownMarketplace::Registered(name.clone());
        }
        let recorded = source.and_then(|s| s.get("repo")).and_then(|r| r.as_str());
        if recorded.is_some_and(|r| repo_matches(repo, r)) {
            legacy = Some(name.clone());
        }
    }
    legacy.map_or(KnownMarketplace::Absent, KnownMarketplace::Legacy)
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
    match classify_known(&read_known_marketplaces(), repo, dir) {
        KnownMarketplace::Registered(name) => return Some(name),
        KnownMarketplace::Legacy(name) => {
            // cm:guard `marketplace remove` uninstalls that marketplace's plugins (measured 2026-09-03), so the install loop after this is what brings them back — never return early between the two
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
    match classify_known(&read_known_marketplaces(), repo, dir) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn commit(origin: &Path, msg: &str) -> String {
        sh(
            origin,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                msg,
            ],
        );
        sh(origin, &["rev-parse", "--short", "HEAD"])
    }

    #[tokio::test]
    async fn sync_clone_pins_moves_follows_and_freezes() {
        let tmp = std::env::temp_dir().join(format!("plugin-sync-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let origin = tmp.join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        sh(&origin, &["init", "-q", "-b", "master"]);
        let one = commit(&origin, "one");
        let two = commit(&origin, "two");
        let url = format!("file://{}", origin.display());
        let clone = tmp.join("marketplaces").join("owner__repo");

        let head = sync_clone(&clone, &url, Some(&one), false).await.unwrap();
        assert_eq!(head, one, "fresh clone lands on the pin, not the tip");

        let head = sync_clone(&clone, &url, Some(&two), false).await.unwrap();
        assert_eq!(head, two, "a moved pin moves the clone");

        let three = commit(&origin, "three");
        let head = sync_clone(&clone, &url, None, true).await.unwrap();
        assert_eq!(head, three, "unpinned + auto_update follows origin/HEAD");

        let four = commit(&origin, "four");
        let head = sync_clone(&clone, &url, None, false).await.unwrap();
        assert_eq!(
            head, three,
            "unpinned without auto_update stays where it is"
        );

        let head = sync_clone(&clone, &url, Some(&four), false).await.unwrap();
        assert_eq!(
            head, four,
            "a pin the clone has never fetched is fetched by name"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn sync_clone_pin_to_an_unknown_sha_is_an_error_not_a_silent_tip() {
        let tmp = std::env::temp_dir().join(format!("plugin-sync-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let origin = tmp.join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        sh(&origin, &["init", "-q", "-b", "master"]);
        commit(&origin, "one");
        let url = format!("file://{}", origin.display());
        let clone = tmp.join("clone");

        let err = sync_clone(
            &clone,
            &url,
            Some("0123456789abcdef0123456789abcdef01234567"),
            false,
        )
        .await
        .unwrap_err();
        assert!(err.contains("git"), "{err}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn classify_known_prefers_our_directory_over_a_legacy_github_entry() {
        let dir = Path::new("/home/x/.config/forge-runner/marketplaces/sidcorp-co__forge-plugin");
        let legacy = r#"{"forge-local":{"source":{"source":"github","repo":"SidCorp-co/forge-plugin"},"installLocation":"/home/x/.claude/plugins/marketplaces/forge-local"}}"#;
        assert_eq!(
            classify_known(legacy, "SidCorp-co/forge-plugin", dir),
            KnownMarketplace::Legacy("forge-local".into())
        );
        let ours = r#"{"forge-local":{"source":{"source":"directory","path":"/home/x/.config/forge-runner/marketplaces/sidcorp-co__forge-plugin"},"installLocation":"/home/x/.config/forge-runner/marketplaces/sidcorp-co__forge-plugin"}}"#;
        assert_eq!(
            classify_known(ours, "https://github.com/SidCorp-co/forge-plugin.git", dir),
            KnownMarketplace::Registered("forge-local".into())
        );
        let other =
            r#"{"forge":{"source":{"source":"github","repo":"SidCorp-co/forge-pipeline-skills"}}}"#;
        assert_eq!(
            classify_known(other, "SidCorp-co/forge-plugin", dir),
            KnownMarketplace::Absent
        );
        assert_eq!(
            classify_known("not json", "SidCorp-co/forge-plugin", dir),
            KnownMarketplace::Absent
        );
    }

    #[test]
    fn repo_url_and_clone_dir_from_shorthand_or_url() {
        assert_eq!(
            repo_url("SidCorp-co/forge-plugin"),
            "https://github.com/SidCorp-co/forge-plugin.git"
        );
        assert_eq!(
            repo_url("git@github.com:SidCorp-co/forge-plugin.git"),
            "git@github.com:SidCorp-co/forge-plugin.git"
        );
        assert_eq!(repo_url("https://gitlab.com/a/b"), "https://gitlab.com/a/b");
        assert_eq!(
            repo_key("https://github.com/SidCorp-co/Forge-Plugin.git"),
            "sidcorp-co/forge-plugin"
        );
        assert!(marketplace_clone_dir("SidCorp-co/forge-plugin")
            .unwrap()
            .ends_with("forge-runner/marketplaces/sidcorp-co__forge-plugin"));
    }

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
