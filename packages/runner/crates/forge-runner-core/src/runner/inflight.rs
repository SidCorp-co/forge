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

/// How long a SIGTERM'd group gets before SIGKILL. Mirrors `graceful_kill`.
// cm:why cfg-gated with the signalling path that reads them: `cargo clippy` on the windows-latest leg of runner-ci warns on an unused const, and the runner-release workflow re-runs that same leg, where a warning is one more line of noise over the failure that actually stops a binary shipping
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
    /// The `outcome` value core's `POST /jobs/:id/kill-ack` accepts.
    // cm:edge contract -> packages/core/src/jobs/lifecycle-routes.ts — the kill-ack zod schema is `z.enum(['killed','not_found'])`; a third word here is a 400 the runner logs and drops, and core falls back to waiting out the whole heartbeat window
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

/// Something that changes on every boot, or `None` on a platform where this
/// daemon cannot obtain one.
// cm:guard a platform with NO boot identity MUST return None here, and `record` + `marker_is_current` must both refuse to act on that — the empty-string fallback this replaced made `marker.boot_id != current` compare "" against "", which never rejects, so on macOS (a shipped release target) a marker that outlived a reboot went straight to kill_group on a pid something else now owns. Reporting `not_found` for a process we cannot vouch for is wrong-but-honest; killing a stranger is not.
#[cfg(target_os = "linux")]
fn boot_identity() -> Option<String> {
    std::fs::read_to_string(BOOT_ID_PATH)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `kern.boottime` is a fixed wall-clock instant per boot, so it separates
/// boots exactly as well as Linux's random id.
#[cfg(target_os = "macos")]
fn boot_identity() -> Option<String> {
    std::process::Command::new("sysctl")
        .args(["-n", "kern.boottime"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn boot_identity() -> Option<String> {
    None
}

/// Whether a marker was written by the boot we are running now.
// cm:why a pure function taking the identity as an argument, because the cases that matter are the ones the test host cannot be put into: a platform with no boot identity at all, and a marker left by the version of this file that wrote an empty one
fn marker_is_current(marker_boot: &str, current: Option<&str>) -> bool {
    match current {
        Some(now) => !now.is_empty() && marker_boot == now,
        None => false,
    }
}

fn default_dir() -> Option<PathBuf> {
    dirs_next::config_dir().map(|d| d.join("forge-runner").join("inflight"))
}

// cm:guard the job id is reflected straight off a WS frame into a filesystem path — reject anything that is not the id core sends, or a crafted `job.cancel` chooses which file this deletes
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
    // cm:guard no boot identity means no marker: a record this daemon could never verify would be read back as a live pid after the next reboot, so the honest state is the pre-ISS-862 one (no record, `not_found`) rather than a record nobody may act on
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
    // cm:why a pid only means anything within one boot — after a reboot the child is gone by definition and the number may already belong to something else, so a marker from another boot is discarded rather than signalled
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
async fn kill_group(pid: u32) -> Reaped {
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
async fn kill_group(pid: u32) -> Reaped {
    match std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output()
    {
        Ok(out) if out.status.success() => Reaped::Killed,
        _ => Reaped::NotFound,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each test owns its directory, so the suite never races on prune.
    fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join(format!("forge-inflight-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).expect("mkdir scratch");
        d
    }

    const JOB: &str = "6c0cd286-7428-4795-8dbb-e4a9377e5fe5";
    /// A boot identity, spelled out so every test runs the same on a host that
    /// has one (Linux, macOS) and one that has none (Windows).
    const BOOT: &str = "this-boot";

    #[test]
    fn a_job_id_that_is_not_an_id_gets_no_path() {
        let d = scratch();
        assert!(marker_path(&d, "../../etc/passwd").is_none());
        assert!(marker_path(&d, "a/b").is_none());
        assert!(marker_path(&d, "").is_none());
        assert!(marker_path(&d, &"x".repeat(65)).is_none());
        assert!(marker_path(&d, JOB).is_some());
    }

    #[tokio::test]
    async fn no_record_at_all_reports_not_found() {
        assert_eq!(
            reap_orphan_in(&scratch(), JOB, Some(BOOT)).await,
            Reaped::NotFound
        );
    }

    #[tokio::test]
    async fn a_record_from_another_boot_reports_not_found_without_signalling_anything() {
        let d = scratch();
        // pid 1 is always alive: without the boot check this would try to kill init.
        std::fs::write(
            marker_path(&d, JOB).expect("valid id"),
            serde_json::to_string(&Marker {
                pid: 1,
                boot_id: "a-boot-that-is-not-this-one".into(),
            })
            .expect("serialize"),
        )
        .expect("write");
        assert_eq!(reap_orphan_in(&d, JOB, Some(BOOT)).await, Reaped::NotFound);
        assert!(
            !marker_path(&d, JOB).expect("valid id").exists(),
            "the marker is consumed either way"
        );
    }

    // The macOS regression: `boot_identity` used to fall back to an empty
    // string there, so `"" != ""` never rejected and a marker that outlived a
    // reboot went straight to `kill_group` on a pid something else now owns.
    #[test]
    fn a_marker_is_never_current_without_a_boot_identity_to_compare_against() {
        assert!(!marker_is_current(BOOT, None));
        assert!(!marker_is_current("", None));
        assert!(!marker_is_current("", Some("")));
        assert!(!marker_is_current(BOOT, Some("")));
        assert!(!marker_is_current("", Some(BOOT)));
        assert!(!marker_is_current("another-boot", Some(BOOT)));
        assert!(marker_is_current(BOOT, Some(BOOT)));
    }

    #[tokio::test]
    async fn a_live_pid_is_left_alone_on_a_platform_with_no_boot_identity() {
        let d = scratch();
        // pid 1 again: reaching kill_group here would signal init.
        record_in(&d, JOB, 1, BOOT);
        assert_eq!(reap_orphan_in(&d, JOB, None).await, Reaped::NotFound);
    }

    #[test]
    fn nothing_is_recorded_when_this_daemon_has_no_boot_identity() {
        // `record` (not `record_in`) owns that refusal, so drive it through the
        // same gate by asserting the platform contract it reads.
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        assert!(
            boot_identity().is_some(),
            "a supported host has an identity"
        );
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        assert!(
            boot_identity().is_none(),
            "an unanchored host must record nothing"
        );
    }

    #[test]
    fn recording_a_new_job_clears_markers_left_by_a_previous_boot() {
        let d = scratch();
        std::fs::write(
            d.join("00000000-0000-4000-8000-00000000beef.json"),
            serde_json::to_string(&Marker {
                pid: 4242,
                boot_id: "an-older-boot".into(),
            })
            .expect("serialize"),
        )
        .expect("write");
        record_in(&d, JOB, 1, BOOT);
        assert!(!d.join("00000000-0000-4000-8000-00000000beef.json").exists());
        assert!(marker_path(&d, JOB).expect("valid id").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_recorded_group_that_is_already_gone_reports_not_found() {
        let d = scratch();
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("spawn /bin/true");
        let pid = child.id();
        child.wait().expect("reap");
        record_in(&d, JOB, pid, BOOT);
        assert_eq!(reap_orphan_in(&d, JOB, Some(BOOT)).await, Reaped::NotFound);
    }

    // The ISS-837 scenario: the daemon restarted, the setsid child did not.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_surviving_group_is_killed_and_reported_killed() {
        use std::os::unix::process::CommandExt;

        let d = scratch();
        let mut cmd = std::process::Command::new("sleep");
        cmd.arg("120");
        unsafe {
            cmd.pre_exec(|| {
                nix::unistd::setsid()
                    .map(|_| ())
                    .map_err(std::io::Error::other)
            });
        }
        let mut child = cmd.spawn().expect("spawn sleep");
        record_in(&d, JOB, child.id(), BOOT);

        assert_eq!(reap_orphan_in(&d, JOB, Some(BOOT)).await, Reaped::Killed);
        let status = child.wait().expect("reap");
        assert!(!status.success(), "the child was signalled: {status}");
        assert_eq!(
            reap_orphan_in(&d, JOB, Some(BOOT)).await,
            Reaped::NotFound,
            "the record is consumed, so a second cancel does not re-claim a kill"
        );
    }

    #[test]
    fn forget_removes_the_record() {
        let d = scratch();
        record_in(&d, JOB, 1, BOOT);
        assert!(marker_path(&d, JOB).expect("valid id").exists());
        forget_in(&d, JOB);
        assert!(!marker_path(&d, JOB).expect("valid id").exists());
    }

    #[test]
    fn the_wire_words_are_the_two_core_accepts() {
        assert_eq!(Reaped::Killed.wire(), "killed");
        assert_eq!(Reaped::NotFound.wire(), "not_found");
    }
}
