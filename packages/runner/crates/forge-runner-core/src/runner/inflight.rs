//! Durable record of the agent processes this daemon started (ISS-862,
//! absorbing ISS-837).
//!
//! The agent child is `setsid`-detached so it survives a daemon restart; the
//! in-memory session map does not. A daemon that has just come back therefore
//! answered every `job.cancel` for a still-running child with `not_found` —
//! and core reads `not_found` as positive proof the process is dead, so it
//! failed the job and retried it onto the same worktree the surviving agent
//! was still writing.
//!
//! One small file per in-flight job closes that gap: after a restart the
//! daemon can look up what it started, kill it for real, and say `killed`.
//! `not_found` becomes a fact rather than an assumption.
//!
//! A pid only means anything within one boot, so every marker carries a boot
//! identity and nothing is recorded — or acted on — without one.

use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[cfg(target_os = "linux")]
const BOOT_ID_PATH: &str = "/proc/sys/kernel/random/boot_id";

#[cfg(unix)]
const TERM_GRACE: Duration = Duration::from_secs(5);
#[cfg(unix)]
const TERM_POLL: Duration = Duration::from_millis(200);

/// What the daemon may honestly report for a `job.cancel` it could not serve
/// from its session map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reaped {
    /// A surviving process group was found and killed.
    Killed,
    /// There is no process: nothing was ever recorded, the record is from a
    /// previous boot, or the group is already gone.
    NotFound,
}

impl Reaped {
    pub fn wire(self) -> &'static str {
        match self {
            Reaped::Killed => "killed",
            Reaped::NotFound => "not_found",
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Marker {
    /// The child's pid, which is also its process-group id (it called `setsid`).
    pid: u32,
    boot_id: String,
}

#[cfg(target_os = "linux")]
pub fn boot_identity() -> Option<String> {
    std::fs::read_to_string(BOOT_ID_PATH)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `kern.boottime` is a fixed wall-clock instant per boot, so it separates
/// boots exactly as well as Linux's random id.
#[cfg(target_os = "macos")]
pub fn boot_identity() -> Option<String> {
    std::process::Command::new("sysctl")
        .args(["-n", "kern.boottime"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn boot_identity() -> Option<String> {
    None
}

fn marker_is_current(marker_boot: &str, current: Option<&str>) -> bool {
    match current {
        Some(now) => !now.is_empty() && marker_boot == now,
        None => false,
    }
}

fn default_dir() -> Option<PathBuf> {
    crate::config::base_dir().ok().map(|d| d.join("inflight"))
}

fn marker_path(dir: &Path, job_id: &str) -> Option<PathBuf> {
    if job_id.is_empty()
        || job_id.len() > 64
        || !job_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(dir.join(format!("{job_id}.json")))
}

/// Remember that `pid` is running `job_id`, so a later daemon can kill it.
pub fn record(job_id: &str, pid: u32) {
    let (Some(dir), Some(boot)) = (default_dir(), boot_identity()) else {
        return;
    };
    record_in(&dir, job_id, pid, &boot);
}

/// Drop the record — the job reached a terminal state under this daemon.
pub fn forget(job_id: &str) {
    if let Some(dir) = default_dir() {
        forget_in(&dir, job_id);
    }
}

/// Answer a `job.cancel` for a job this daemon has no session for, by killing
/// whatever it recorded and reporting what actually happened.
pub async fn reap_orphan(job_id: &str) -> Reaped {
    match default_dir() {
        Some(dir) => reap_orphan_in(&dir, job_id, boot_identity().as_deref()).await,
        None => Reaped::NotFound,
    }
}

fn record_in(dir: &Path, job_id: &str, pid: u32, boot: &str) {
    let Some(p) = marker_path(dir, job_id) else {
        return;
    };
    let marker = Marker {
        pid,
        boot_id: boot.to_string(),
    };
    let Ok(body) = serde_json::to_string(&marker) else {
        return;
    };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    prune_previous_boots(dir, &marker.boot_id);
    if let Err(e) = std::fs::write(&p, body) {
        tracing::debug!("[inflight] record job={job_id}: {e}");
    }
}

fn forget_in(dir: &Path, job_id: &str) {
    if let Some(p) = marker_path(dir, job_id) {
        let _ = std::fs::remove_file(p);
    }
}

async fn reap_orphan_in(dir: &Path, job_id: &str, current_boot: Option<&str>) -> Reaped {
    let Some(p) = marker_path(dir, job_id) else {
        return Reaped::NotFound;
    };
    let Ok(raw) = std::fs::read_to_string(&p) else {
        return Reaped::NotFound;
    };
    let _ = std::fs::remove_file(&p);
    let Ok(marker) = serde_json::from_str::<Marker>(&raw) else {
        return Reaped::NotFound;
    };
    if !marker_is_current(&marker.boot_id, current_boot) {
        return Reaped::NotFound;
    }
    let outcome = kill_group(marker.pid).await;
    tracing::info!(
        "[inflight] orphan job={job_id} pid={} -> {}",
        marker.pid,
        outcome.wire()
    );
    outcome
}

/// Markers written before the current boot describe processes that cannot
/// exist. Cleared when the next job is recorded, so the directory stays
/// bounded even when the daemon is SIGKILLed mid-job.
fn prune_previous_boots(dir: &Path, current: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let stale = std::fs::read_to_string(&p)
            .ok()
            .and_then(|raw| serde_json::from_str::<Marker>(&raw).ok())
            .is_some_and(|m| m.boot_id != current);
        if stale {
            let _ = std::fs::remove_file(&p);
        }
    }
}

#[cfg(unix)]
pub async fn kill_group(pid: u32) -> Reaped {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;

    let Ok(raw) = i32::try_from(pid) else {
        return Reaped::NotFound;
    };
    let pgid = Pid::from_raw(-raw);
    if kill(pgid, None).is_err() {
        return Reaped::NotFound;
    }
    let _ = kill(pgid, Signal::SIGTERM);
    let deadline = tokio::time::Instant::now() + TERM_GRACE;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(TERM_POLL).await;
        if kill(pgid, None).is_err() {
            return Reaped::Killed;
        }
    }
    let _ = kill(pgid, Signal::SIGKILL);
    Reaped::Killed
}

#[cfg(not(unix))]
pub async fn kill_group(pid: u32) -> Reaped {
    match std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output()
    {
        Ok(out) if out.status.success() => Reaped::Killed,
        _ => Reaped::NotFound,
    }
}
