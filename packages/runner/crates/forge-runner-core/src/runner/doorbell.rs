/*
 * The door a blocked-but-live run listens at, and the ring that wakes it.
 *
 * A run blocked on a machine or a peer keeps its process (ISS-964 criterion 5),
 * so an answer that arrives quickly can reach it without a revival. The channel
 * is a FIFO beside the ledger, and a ringer that finds nobody listening learns
 * it from `ENXIO` and parks the question rather than failing.
 *
 * There is no resident reader here on purpose: the background task that waits
 * on this door with a deadline is deferred by the issue's own CHỐT. What this
 * module owns is the channel; `runner/blocked.rs` owns the order it is armed in.
 */

use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};

use nix::errno::Errno;
use nix::fcntl::{open, OFlag};
use nix::sys::stat::Mode;
use nix::unistd::{mkfifo, write};

use crate::error::{Error, Result};

/// Whether a ring reached anybody.
// cm:guard `NoListener` is an OUTCOME, never an error: it is what a ringer meets whenever the run took the human branch and exited, which is the ordinary case rather than a fault. An `Err` here makes a peer's fast path fail on the slow path's success (ISS-964 criterion 11).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ring {
    /// A reader holds the door open; the wake is now its business.
    Heard,
    /// Nobody is listening. The caller parks the question instead.
    NoListener,
}

/// The open read end of one run's door.
// cm:guard HOLD this for as long as the run is blocked and do not drop it early: dropping closes the read end, and the next ring meets `ENXIO` and parks a question the run was live and waiting for (ISS-964 criteria 10, 11).
#[derive(Debug)]
pub struct Listening {
    path: PathBuf,
    _read: OwnedFd,
}

impl Listening {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Where one run's door lives.
// cm:guard derived from the LEDGER's own directory and nothing else, so a ringer that can read the ledger can always find the door. `XDG_RUNTIME_DIR` would separate two runner services that share a data dir from each other's doors while sharing their runs, and a fixed name would put two boxes' doors on one path.
pub fn path_for(ledger_path: &Path, run_id: &str) -> PathBuf {
    ledger_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("doors")
        .join(format!("{run_id}.fifo"))
}

fn ensure(path: &Path) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| Error::Other(format!("doorbell: cannot create {}: {e}", dir.display())))?;
    }
    match mkfifo(path, Mode::from_bits_truncate(0o600)) {
        Ok(()) => Ok(()),
        Err(Errno::EEXIST) => Ok(()),
        Err(e) => Err(Error::Other(format!(
            "doorbell: mkfifo {}: {e}",
            path.display()
        ))),
    }
}

/// Open one run's door for READING, creating it if this is the first arm.
// cm:guard `O_NONBLOCK` on the read side is what makes this return at all: a FIFO opened `O_RDONLY` without it blocks until a writer appears, so the arm would hang inside the step that is supposed to precede the declaration (ISS-964 criteria 10, 11).
pub fn listen(ledger_path: &Path, run_id: &str) -> Result<Listening> {
    let path = path_for(ledger_path, run_id);
    ensure(&path)?;
    let fd = open(&path, OFlag::O_RDONLY | OFlag::O_NONBLOCK, Mode::empty())
        .map_err(|e| Error::Other(format!("doorbell: open read {}: {e}", path.display())))?;
    Ok(Listening { path, _read: fd })
}

/// Ring one run's door, without ever blocking on it.
// cm:guard `ENXIO` means no reader holds the door, and it is the ONLY errno that reads as `NoListener`. `EAGAIN` is a listener that has not drained a previous ring, which is still `Heard` — the door has already been rung and re-ringing it adds nothing (ISS-964 criterion 11).
// cm:guard no control action blocks on the thing it controls: both the open and the write are `O_NONBLOCK`, so a listener that is wedged inside its own turn costs the ringer nothing (ISS-964 criterion 11).
pub fn ring(ledger_path: &Path, run_id: &str) -> Result<Ring> {
    let path = path_for(ledger_path, run_id);
    if !path.exists() {
        return Ok(Ring::NoListener);
    }
    let fd = match open(&path, OFlag::O_WRONLY | OFlag::O_NONBLOCK, Mode::empty()) {
        Ok(fd) => fd,
        Err(Errno::ENXIO) => return Ok(Ring::NoListener),
        Err(e) => {
            return Err(Error::Other(format!(
                "doorbell: open write {}: {e}",
                path.display()
            )))
        }
    };
    match write(&fd, b"\x07") {
        Ok(_) | Err(Errno::EAGAIN) => Ok(Ring::Heard),
        Err(e) => Err(Error::Other(format!(
            "doorbell: ring {}: {e}",
            path.display()
        ))),
    }
}

/// Take a run's door down once nothing will ring it again.
// cm:guard removing the path is what turns a later ring into `NoListener` by the cheap check rather than by `ENXIO`, and a door left behind outlives its run exactly as the `11515.sock` in ISS-934 outlived its process. Call it when the run reaches terminal, never merely when it unblocks — a run that unblocks may block again on the same door.
pub fn take_down(ledger_path: &Path, run_id: &str) -> Result<()> {
    let path = path_for(ledger_path, run_id);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::Other(format!(
            "doorbell: remove {}: {e}",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn led_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("door-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("ledger.sqlite")
    }

    // cm:guard the door must sit BESIDE the ledger, because that is the only path a ringer in another process can derive from what it already has. A door under `XDG_RUNTIME_DIR` is unreachable for a service that shares the data dir but not the runtime dir.
    #[test]
    fn the_door_lives_beside_the_ledger() {
        let p = led_path();
        let door = path_for(&p, "run-7");
        assert_eq!(door.parent().unwrap(), p.parent().unwrap().join("doors"));
        assert_eq!(door.file_name().unwrap(), "run-7.fifo");
    }

    // cm:guard the falsifying case for criterion 11, and the ordinary one: the run took the human branch and its process is gone, so nobody holds the door. This must be an OUTCOME the ringer acts on, never an `Err` that fails its turn.
    #[test]
    fn a_ring_nobody_is_listening_for_is_an_outcome_not_an_error() {
        let p = led_path();
        listen(&p, "run-1").unwrap();
        assert_eq!(ring(&p, "run-1").unwrap(), Ring::NoListener);
    }

    #[test]
    fn ringing_a_door_that_was_never_armed_reports_no_listener() {
        let p = led_path();
        assert_eq!(ring(&p, "never-armed").unwrap(), Ring::NoListener);
    }

    #[test]
    fn a_ring_reaches_a_listener_holding_the_door() {
        let p = led_path();
        let _ear = listen(&p, "run-1").unwrap();
        assert_eq!(ring(&p, "run-1").unwrap(), Ring::Heard);
    }

    // cm:guard the EAR is the listener, not the file: the same door reports `Heard` and then `NoListener` with nothing on disk changing, which is why `Listening` must be held for the whole block rather than opened and dropped.
    #[test]
    fn dropping_the_ear_stops_the_door_being_heard() {
        let p = led_path();
        let ear = listen(&p, "run-1").unwrap();
        assert_eq!(ring(&p, "run-1").unwrap(), Ring::Heard);
        drop(ear);
        assert_eq!(ring(&p, "run-1").unwrap(), Ring::NoListener);
    }

    // cm:guard `EAGAIN` is a listener that has not drained, and it is still `Heard`: a full pipe means the door has ALREADY been rung and nobody read it yet, so reporting `NoListener` there would park a question the run is live and waiting for. There is no resident reader in this build, so this is the state a real second ring meets.
    #[test]
    fn a_door_nobody_drains_still_counts_as_heard() {
        let p = led_path();
        let _ear = listen(&p, "run-1").unwrap();
        for _ in 0..100_000 {
            if ring(&p, "run-1").unwrap() != Ring::Heard {
                panic!("an undrained door must stay `Heard`");
            }
        }
    }

    // cm:guard no control action blocks on the thing it controls. Without `O_NONBLOCK` the write side blocks forever once the pipe fills and the read side blocks until a writer appears, so this measures the two calls a wedged listener would otherwise hang.
    #[test]
    fn neither_arming_nor_ringing_waits_on_the_other_side() {
        let p = led_path();
        let started = Instant::now();
        let ear = listen(&p, "run-1").unwrap();
        for _ in 0..200_000 {
            let _ = ring(&p, "run-1").unwrap();
        }
        drop(ear);
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "a blocking open or write would never reach here at all"
        );
    }

    #[test]
    fn taking_the_door_down_makes_the_next_ring_report_no_listener() {
        let p = led_path();
        let _ear = listen(&p, "run-1").unwrap();
        assert_eq!(ring(&p, "run-1").unwrap(), Ring::Heard);
        take_down(&p, "run-1").unwrap();
        assert_eq!(ring(&p, "run-1").unwrap(), Ring::NoListener);
        take_down(&p, "run-1").unwrap();
    }

    #[test]
    fn arming_a_door_twice_reuses_the_one_that_is_there() {
        let p = led_path();
        let first = listen(&p, "run-1").unwrap();
        let second = listen(&p, "run-1").unwrap();
        assert_eq!(first.path(), second.path());
        drop(first);
        assert_eq!(
            ring(&p, "run-1").unwrap(),
            Ring::Heard,
            "the second ear still holds the door"
        );
    }
}
