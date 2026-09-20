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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ring {
    /// A reader holds the door open; the wake is now its business.
    Heard,
    /// Nobody is listening. The caller parks the question instead.
    NoListener,
}

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

pub fn listen(ledger_path: &Path, run_id: &str) -> Result<Listening> {
    let path = path_for(ledger_path, run_id);
    ensure(&path)?;
    let fd = open(&path, OFlag::O_RDONLY | OFlag::O_NONBLOCK, Mode::empty())
        .map_err(|e| Error::Other(format!("doorbell: open read {}: {e}", path.display())))?;
    Ok(Listening { path, _read: fd })
}

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
    use std::os::fd::AsFd;
    use std::time::{Duration, Instant};

    fn led_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("door-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("ledger.sqlite")
    }

    fn is_cloexec(fd: std::os::fd::BorrowedFd<'_>) -> bool {
        let bits = nix::fcntl::fcntl(fd, nix::fcntl::F_GETFD).unwrap();
        nix::fcntl::FdFlag::from_bits_truncate(bits).contains(nix::fcntl::FdFlag::FD_CLOEXEC)
    }

    #[test]
    fn the_door_lives_beside_the_ledger() {
        let p = led_path();
        let door = path_for(&p, "run-7");
        assert_eq!(door.parent().unwrap(), p.parent().unwrap().join("doors"));
        assert_eq!(door.file_name().unwrap(), "run-7.fifo");
    }

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

    #[test]
    fn dropping_the_ear_stops_the_door_being_heard() {
        let p = led_path();
        let ear = listen(&p, "run-1").unwrap();
        assert_eq!(ring(&p, "run-1").unwrap(), Ring::Heard);
        drop(ear);
        assert_eq!(ring(&p, "run-1").unwrap(), Ring::NoListener);
    }

    /// The defect ISS-1131 was filed for: a child forked while the door was
    /// armed inherits the read end, and the kernel then counts it as a reader
    /// long after the ear that armed the door has gone.
    #[test]
    fn a_child_that_inherited_the_door_is_not_a_listener() {
        let p = led_path();
        let dir = p.parent().unwrap().to_path_buf();
        let ear = listen(&p, "run-1").unwrap();
        assert_eq!(ring(&p, "run-1").unwrap(), Ring::Heard);

        // The child must have reached its own image before the ear goes, or
        // this would prove only the fork-to-exec window rather than the leak.
        let ready = dir.join("child-ready");
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("echo ready > {}; sleep 30", ready.display()))
            .spawn()
            .expect("sh");
        let waited = Instant::now();
        while !ready.exists() {
            assert!(
                waited.elapsed() < Duration::from_secs(10),
                "the child never reached its own image, so this proves nothing"
            );
            std::thread::sleep(Duration::from_millis(5));
        }

        drop(ear);
        let answer = ring(&p, "run-1").unwrap();
        let _ = child.kill();
        let _ = child.wait();

        assert_eq!(
            answer, Ring::NoListener,
            "`Heard` is a claim that a listener will receive the ring. A child \
             that inherited the read end is not that listener: it never reads \
             the door, and the question is dropped on the floor"
        );
    }

    /// The half of the same defect that close-on-exec cannot reach: a child
    /// that has forked and not yet executed holds every descriptor whatever
    /// flags they carry, so only the registration can answer this one.
    #[test]
    fn a_child_that_never_executed_is_not_a_listener_either() {
        let p = led_path();
        let ear = listen(&p, "run-1").unwrap();
        assert_eq!(ring(&p, "run-1").unwrap(), Ring::Heard);

        // SAFETY: the child sleeps and `_exit`s, both async-signal-safe, and
        // touches nothing this process's other threads could hold a lock on.
        let forked = unsafe { nix::unistd::fork() }.expect("fork");
        let child = match forked {
            nix::unistd::ForkResult::Child => {
                std::thread::sleep(Duration::from_secs(30));
                unsafe { nix::libc::_exit(0) }
            }
            nix::unistd::ForkResult::Parent { child } => child,
        };

        drop(ear);
        let answer = ring(&p, "run-1").unwrap();
        let _ = nix::sys::signal::kill(child, nix::sys::signal::Signal::SIGKILL);
        let _ = nix::sys::wait::waitpid(child, None);

        assert_eq!(
            answer, Ring::NoListener,
            "`Heard` is a claim that a listener will receive the ring. A child \
             caught between fork and exec holds the read end whatever flags it \
             carries, and it is not the ear that armed this door"
        );
    }

    #[test]
    fn the_read_end_is_not_carried_through_an_exec() {
        let p = led_path();
        let ear = listen(&p, "run-1").unwrap();
        assert!(
            is_cloexec(ear._read.as_fd()),
            "the door a run listens at must not outlive this process into a child"
        );
    }

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
