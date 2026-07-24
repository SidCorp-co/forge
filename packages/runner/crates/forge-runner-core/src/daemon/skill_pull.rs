//! Background skill auto-pull (ISS-736) + on-demand one-shot sync (ISS-740).
//!
//! `handle_skill_sync` (`daemon/dispatch.rs`) is the explicit-push path: a
//! server `skill.sync` event, always operator-initiated (web Sync action or
//! `forge_skills.push`). This module adds two device-initiated pull paths that
//! share one core routine, [`sync_bound_projects`]:
//! - a background poller, off by default (`[skills] auto_pull`), that
//!   periodically syncs every bound project so a device catches up on its own
//!   without a manual push;
//! - the `forge-runner sync` CLI subcommand, an independent one-shot pull an
//!   operator can run on demand (optionally scoped to one project via
//!   `--project <slug>`).
//!
//! Neither path touches the shared job-exec path (`runner/claude_code.rs`).
//!
//! Schedule: `BASE_INTERVAL_SECS` + uniform jitter on every sleep (steady
//! state and startup), so a fleet polling the same core doesn't spike load in
//! sync. On consecutive poll failures the delay backs off exponentially,
//! capped at `MAX_BACKOFF_SECS`, and resets to base on the next success.
//! Jitter is derived from `SystemTime` subsec-nanos rather than a `rand`
//! dependency, to keep `Cargo.lock` unchanged (runner version-lock gotcha).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::watch;

use crate::config::Config;
use crate::error::Result;
use crate::transport::runners;
use crate::transport::CoreClient;
use crate::workspace::skill_sync;

use super::dispatch::resolve_repo;

const BASE_INTERVAL_SECS: u64 = 15 * 60;
const JITTER_MAX_SECS: u64 = 5 * 60;
const MAX_BACKOFF_SECS: u64 = 60 * 60;
const STARTUP_DELAY_SECS: u64 = 60;

/// A pseudo-random offset in `0..=max` seconds, derived from the wall clock
/// subsec-nanos so a fleet of runners spreads out without a `rand` dependency.
fn jitter_secs(max: u64) -> u64 {
    if max == 0 {
        return 0;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0) as u64;
    nanos % (max + 1)
}

/// Next sleep duration given the count of consecutive poll failures:
/// exponential backoff on the base interval, capped, plus fresh jitter.
fn next_delay(consecutive_failures: u32) -> Duration {
    let backoff = BASE_INTERVAL_SECS.saturating_mul(1u64 << consecutive_failures.min(3));
    Duration::from_secs(backoff.min(MAX_BACKOFF_SECS) + jitter_secs(JITTER_MAX_SECS))
}

/// One-shot pull outcome for a single bound project.
pub struct ProjectSyncResult {
    pub project_id: String,
    pub slug: String,
    pub repo_path: PathBuf,
    /// `Ok(skills_synced)` or `Err(message)`.
    pub outcome: std::result::Result<usize, String>,
}

/// Resolve every bound project (or just `only_slug` when `Some`) and sync its
/// skills once — the shared routine behind both the background poller
/// ([`run`]) and the `forge-runner sync` CLI command. A project with no
/// usable local repo path is skipped, not reported as an error.
///
/// The top-level `Err` fires ONLY when the `list_me` manifest listing itself
/// fails (can't reach core / bad token) — a per-project sync failure is
/// carried in that project's [`ProjectSyncResult::outcome`] instead, so one
/// bad project never hides the others' results.
pub async fn sync_bound_projects(
    client: &CoreClient,
    cfg: &Config,
    only_slug: Option<&str>,
) -> Result<Vec<ProjectSyncResult>> {
    let server = runners::list_me(client).await?;

    let mut project_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for r in &server {
        project_ids.insert(r.project_id.clone());
    }
    for b in cfg.bindings.values() {
        if let Some(pid) = &b.project_id {
            project_ids.insert(pid.clone());
        }
    }

    if let Some(slug) = only_slug {
        let by_config = cfg.bindings.get(slug).and_then(|b| b.project_id.clone());
        let by_server = server
            .iter()
            .find(|r| r.slug == slug)
            .map(|r| r.project_id.clone());
        let matched = by_server
            .or(by_config)
            .filter(|pid| project_ids.contains(pid));

        project_ids = match matched {
            Some(pid) => std::iter::once(pid).collect(),
            None => {
                return Ok(vec![ProjectSyncResult {
                    project_id: String::new(),
                    slug: slug.to_string(),
                    repo_path: PathBuf::new(),
                    outcome: Err(format!(
                        "no bound project '{slug}' with a local repo path"
                    )),
                }]);
            }
        };
    }

    let mut results = Vec::with_capacity(project_ids.len());
    for project_id in project_ids {
        let resolved = match resolve_repo(&server, cfg, &project_id) {
            Ok(r) => r,
            Err(slug) => {
                tracing::debug!(
                    "[skills] sync: project '{slug}' has no local repo path — skipping"
                );
                continue;
            }
        };

        let outcome = skill_sync::sync_skills(client, &project_id, &resolved.repo_path)
            .await
            .map_err(|e| e.to_string());
        results.push(ProjectSyncResult {
            project_id,
            slug: resolved.slug,
            repo_path: resolved.repo_path,
            outcome,
        });
    }
    Ok(results)
}

/// One poll pass: resolve every bound project (same `list_me` + `resolve_repo`
/// union `daemon::run` uses to build registrations) and sync its skills.
/// Returns `false` (triggering backoff) if the manifest listing failed or any
/// project's sync errored; a project with no usable repo path is skipped, not
/// a failure.
async fn poll_once(client: &CoreClient, cfg: &Config) -> bool {
    let results = match sync_bound_projects(client, cfg, None).await {
        Ok(results) => results,
        Err(e) => {
            tracing::warn!("[skills] auto-pull: me/runners failed: {e}");
            return false;
        }
    };

    let mut ok = true;
    for r in &results {
        match &r.outcome {
            Ok(n) if *n > 0 => {
                tracing::debug!(
                    "[skills] auto-pull: project={} synced {n} skill(s) into {}",
                    r.project_id,
                    r.repo_path.join(".claude/skills").display()
                );
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("[skills] auto-pull: project={} sync failed: {e}", r.project_id);
                ok = false;
            }
        }
    }
    ok
}

/// Run the background poller until `cancel_rx` fires. Spawned only when
/// `cfg.skills.auto_pull` is set (`daemon/mod.rs`).
pub async fn run(client: Arc<CoreClient>, cfg: Arc<Config>, mut cancel_rx: watch::Receiver<bool>) {
    let startup = Duration::from_secs(STARTUP_DELAY_SECS + jitter_secs(JITTER_MAX_SECS));
    tokio::select! {
        _ = tokio::time::sleep(startup) => {}
        _ = cancel_rx.changed() => { if *cancel_rx.borrow() { return; } }
    }

    let mut failures = 0u32;
    loop {
        let ok = poll_once(&client, &cfg).await;
        failures = if ok { 0 } else { failures.saturating_add(1) };
        let delay = next_delay(failures);
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jitter_zero_max_is_zero() {
        assert_eq!(jitter_secs(0), 0);
    }

    #[test]
    fn jitter_bounded_by_max() {
        for _ in 0..20 {
            assert!(jitter_secs(JITTER_MAX_SECS) <= JITTER_MAX_SECS);
        }
    }

    #[test]
    fn next_delay_base_bounds() {
        let d = next_delay(0).as_secs();
        assert!(d >= BASE_INTERVAL_SECS && d <= BASE_INTERVAL_SECS + JITTER_MAX_SECS);
    }

    #[test]
    fn next_delay_backs_off() {
        let d = next_delay(1).as_secs();
        let expected_base = BASE_INTERVAL_SECS * 2;
        assert!(d >= expected_base && d <= expected_base + JITTER_MAX_SECS);
    }

    #[test]
    fn next_delay_capped_at_max_backoff() {
        for failures in [3u32, 4, 10] {
            let d = next_delay(failures).as_secs();
            assert!(d >= MAX_BACKOFF_SECS && d <= MAX_BACKOFF_SECS + JITTER_MAX_SECS);
        }
    }
}
