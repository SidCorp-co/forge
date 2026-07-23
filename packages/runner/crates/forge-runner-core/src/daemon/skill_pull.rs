//! Background skill auto-pull (ISS-736).
//!
//! `handle_skill_sync` (`daemon/dispatch.rs`) is the explicit-push path: a
//! server `skill.sync` event, always operator-initiated (web Sync action or
//! `forge_skills.push`). This module adds an independent poller, off by
//! default (`[skills] auto_pull`), that periodically calls the same
//! `skill_sync::sync_skills` for every bound project so a device catches up on
//! its own without a manual push. It never touches the shared job-exec path
//! (`runner/claude_code.rs`).
//!
//! Schedule: `BASE_INTERVAL_SECS` + uniform jitter on every sleep (steady
//! state and startup), so a fleet polling the same core doesn't spike load in
//! sync. On consecutive poll failures the delay backs off exponentially,
//! capped at `MAX_BACKOFF_SECS`, and resets to base on the next success.
//! Jitter is derived from `SystemTime` subsec-nanos rather than a `rand`
//! dependency, to keep `Cargo.lock` unchanged (runner version-lock gotcha).

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::watch;

use crate::config::Config;
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

/// One poll pass: resolve every bound project (same `list_me` + `resolve_repo`
/// union `daemon::run` uses to build registrations) and sync its skills.
/// Returns `false` (triggering backoff) if the manifest listing failed or any
/// project's sync errored; a project with no usable repo path is skipped, not
/// a failure.
async fn poll_once(client: &CoreClient, cfg: &Config) -> bool {
    let server = match runners::list_me(client).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("[skills] auto-pull: me/runners failed: {e}");
            return false;
        }
    };

    let mut project_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for r in &server {
        project_ids.insert(r.project_id.clone());
    }
    for b in cfg.bindings.values() {
        if let Some(pid) = &b.project_id {
            project_ids.insert(pid.clone());
        }
    }

    let mut ok = true;
    for project_id in project_ids {
        let resolved = match resolve_repo(&server, cfg, &project_id) {
            Ok(r) => r,
            Err(slug) => {
                tracing::debug!(
                    "[skills] auto-pull: project '{slug}' has no local repo path — skipping"
                );
                continue;
            }
        };

        match skill_sync::sync_skills(client, &project_id, &resolved.repo_path).await {
            Ok(n) => {
                if n > 0 {
                    tracing::debug!(
                        "[skills] auto-pull: project={project_id} synced {n} skill(s) into {}",
                        resolved.repo_path.join(".claude/skills").display()
                    );
                }
            }
            Err(e) => {
                tracing::warn!("[skills] auto-pull: project={project_id} sync failed: {e}");
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
