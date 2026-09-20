/*
 * The door a blocked-but-live run listens at, and the ring that wakes it.
 *
 * A run blocked on a machine or a peer keeps its process (ISS-964 criterion 5),
 * so an answer that arrives quickly can reach it without a revival. The channel
 * is a FIFO beside the ledger, and a ringer that finds nobody listening learns
 * it and parks the question rather than failing.
 *
 * The kernel alone cannot say who is listening. `ENXIO` reports only that no
 * descriptor on the read end is open anywhere, and a child that inherited one
 * is such a descriptor without ever being a listener. So an ear registers
 * itself beside the door, and `Heard` rests on that registration being live
 * on both sides of the byte (ISS-1131).
 *
 * There is no resident reader here on purpose: the background task that waits
 * on this door with a deadline is deferred by the issue's own CHỐT. What this
 * module owns is the channel; `runner/blocked.rs` owns the order it is armed in.
 */

use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use nix::errno::Errno;
use nix::fcntl::{open, OFlag};
use nix::sys::signal::kill;
use nix::sys::stat::Mode;
use nix::unistd::{mkfifo, write, Pid};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ring {
    /// A live ear was registered for this door before the byte was written and
    /// still registered after it, and the kernel took the byte. The wake is now
    /// that ear's business.
    ///
    /// The one thing it cannot rule out: the process holding that ear dying
    /// between the second look and its own next read of the door. Only an
    /// answer from the other side would close that, and this door has no
    /// resident reader to send one.
    Heard,
    /// Nobody is listening. The caller parks the question instead.
    NoListener,
}

#[derive(Debug)]
pub struct Listening {
    path: PathBuf,
    ear: PathBuf,
    _read: OwnedFd,
}

impl Listening {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Listening {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.ear);
    }
}

pub fn path_for(ledger_path: &Path, run_id: &str) -> PathBuf {
    ledger_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("doors")
        .join(format!("{run_id}.fifo"))
}

fn ears_dir(door: &Path) -> PathBuf {
    door.with_extension("ears")
}

/// Every open of either end of a door goes through here, so neither end can be
/// opened without `O_CLOEXEC`: a descriptor that survives an exec makes the
/// child holding it a reader the kernel counts and nobody can be woken by.
fn open_door(door: &Path, direction: OFlag) -> std::result::Result<OwnedFd, Errno> {
    open(
        door,
        direction | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
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

/// One file per ear, named and filled with the process that armed it. Several
/// ears may hold the same door, so each takes a file of its own and drops it
/// on its way out.
fn register(door: &Path) -> Result<PathBuf> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = ears_dir(door);
    std::fs::create_dir_all(&dir)
        .map_err(|e| Error::Other(format!("doorbell: cannot create {}: {e}", dir.display())))?;
    let pid = std::process::id();
    let ear = dir.join(format!(
        "{pid}-{}.ear",
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&ear, pid.to_string())
        .map_err(|e| Error::Other(format!("doorbell: cannot register {}: {e}", ear.display())))?;
    Ok(ear)
}

fn alive(pid: i32) -> bool {
    !matches!(kill(Pid::from_raw(pid), None), Err(Errno::ESRCH))
}

/// Whether a process that armed this door is still alive to read it. A
/// registration left behind by a process that died without dropping its ear
/// does not count, whoever else still holds the read end open.
fn still_listening(door: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(ears_dir(door)) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        path.extension().is_some_and(|x| x == "ear")
            && std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| s.trim().parse::<i32>().ok())
                .is_some_and(alive)
    })
}

/// Whether the kernel took the byte. A door whose last reader went between the
/// open and this write answers `EPIPE`, and that is a `NoListener` as surely as
/// `ENXIO` is. `EAGAIN` is a reader that is there and behind, which is its
/// business and not the ringer's.
fn write_the_ring(fd: &OwnedFd, door: &Path) -> Result<bool> {
    match write(fd, b"\x07") {
        Ok(_) | Err(Errno::EAGAIN) => Ok(true),
        Err(Errno::EPIPE) => Ok(false),
        Err(e) => Err(Error::Other(format!(
            "doorbell: ring {}: {e}",
            door.display()
        ))),
    }
}

pub fn listen(ledger_path: &Path, run_id: &str) -> Result<Listening> {
    let path = path_for(ledger_path, run_id);
    ensure(&path)?;
    let fd = open_door(&path, OFlag::O_RDONLY)
        .map_err(|e| Error::Other(format!("doorbell: open read {}: {e}", path.display())))?;
    let ear = register(&path)?;
    Ok(Listening {
        path,
        ear,
        _read: fd,
    })
}

/// `Heard` is a claim that a listener will receive this ring, so it is asked
/// twice: once before the byte goes, and once after. What lies between the two
/// looks is the only window left, and the variant's own doc names it.
pub fn ring(ledger_path: &Path, run_id: &str) -> Result<Ring> {
    let path = path_for(ledger_path, run_id);
    if !path.exists() || !still_listening(&path) {
        return Ok(Ring::NoListener);
    }
    let fd = match open_door(&path, OFlag::O_WRONLY) {
        Ok(fd) => fd,
        Err(Errno::ENXIO) => return Ok(Ring::NoListener),
        Err(e) => {
            return Err(Error::Other(format!(
                "doorbell: open write {}: {e}",
                path.display()
            )))
        }
    };
    if !write_the_ring(&fd, &path)? || !still_listening(&path) {
        return Ok(Ring::NoListener);
    }
    Ok(Ring::Heard)
}

pub fn take_down(ledger_path: &Path, run_id: &str) -> Result<()> {
    let path = path_for(ledger_path, run_id);
    let ears = ears_dir(&path);
    if let Err(e) = std::fs::remove_dir_all(&ears) {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(Error::Other(format!(
                "doorbell: remove {}: {e}",
                ears.display()
            )));
        }
    }
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
            answer,
            Ring::NoListener,
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
            answer,
            Ring::NoListener,
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
    fn the_write_end_is_not_carried_through_an_exec() {
        let p = led_path();
        let door = path_for(&p, "run-1");
        let _ear = listen(&p, "run-1").unwrap();
        let fd = open_door(&door, OFlag::O_WRONLY).unwrap();
        assert!(
            is_cloexec(fd.as_fd()),
            "the end a ringer opens must not outlive the ring into a child"
        );
    }

    #[test]
    fn an_ear_registers_itself_and_takes_the_registration_with_it() {
        let p = led_path();
        let door = path_for(&p, "run-1");
        let ear = listen(&p, "run-1").unwrap();

        let held: Vec<_> = std::fs::read_dir(ears_dir(&door))
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .collect();
        assert_eq!(held.len(), 1, "an ear registers itself beside its door");
        assert_eq!(
            std::fs::read_to_string(&held[0]).unwrap(),
            std::process::id().to_string(),
            "the registration names the process that must do the reading"
        );

        drop(ear);
        assert_eq!(
            std::fs::read_dir(ears_dir(&door)).unwrap().count(),
            0,
            "and the registration goes when the ear does"
        );
    }

    /// The first look, on its own: a descriptor on the read end with no ear
    /// behind it is what an inherited one is, in-process and deterministic.
    #[test]
    fn a_reader_that_never_registered_is_not_a_listener() {
        let p = led_path();
        let door = path_for(&p, "run-1");
        let ear = listen(&p, "run-1").unwrap();
        let stranger = open_door(&door, OFlag::O_RDONLY).unwrap();

        drop(ear);
        assert_eq!(
            ring(&p, "run-1").unwrap(),
            Ring::NoListener,
            "the door still has a reader, and no ear: `Heard` would be a claim \
             about delivery with nobody to deliver to"
        );
        drop(stranger);
    }

    /// The same look, against the registration a crashed process leaves behind.
    #[test]
    fn a_registration_whose_owner_has_died_is_not_a_listener() {
        let p = led_path();
        let door = path_for(&p, "run-1");
        let ear = listen(&p, "run-1").unwrap();
        let stranger = open_door(&door, OFlag::O_RDONLY).unwrap();

        let mut gone = std::process::Command::new("true").spawn().expect("true");
        let dead = gone.id();
        gone.wait().unwrap();

        drop(ear);
        std::fs::write(
            ears_dir(&door).join(format!("{dead}-0.ear")),
            dead.to_string(),
        )
        .unwrap();

        assert_eq!(
            ring(&p, "run-1").unwrap(),
            Ring::NoListener,
            "a registration left behind by a process that has died is not an ear"
        );
        drop(stranger);
    }

    /// `EPIPE` is the reader going between the open and the write. `ring()`
    /// cannot be steered into that window from outside, so the branch is read
    /// where it is decided.
    #[test]
    fn a_write_to_a_door_whose_reader_has_gone_is_not_heard() {
        let p = led_path();
        let door = path_for(&p, "run-1");
        let ear = listen(&p, "run-1").unwrap();
        let fd = open_door(&door, OFlag::O_WRONLY).unwrap();

        drop(ear);
        assert!(
            !write_the_ring(&fd, &door).unwrap(),
            "the byte went nowhere, and a ring that went nowhere was not heard"
        );
    }

    /// The look `ring()` takes after the byte has gone, which is what makes
    /// `Heard` true at the moment it is returned rather than a moment earlier.
    #[test]
    fn the_second_look_is_what_heard_rests_on() {
        let p = led_path();
        let door = path_for(&p, "run-1");
        let ear = listen(&p, "run-1").unwrap();
        assert!(still_listening(&door));
        drop(ear);
        assert!(
            !still_listening(&door),
            "an ear dropped while the byte was in flight leaves nobody to read it"
        );
    }

    #[test]
    fn taking_the_door_down_leaves_no_registration_behind() {
        let p = led_path();
        let door = path_for(&p, "run-1");
        let _ear = listen(&p, "run-1").unwrap();
        assert!(ears_dir(&door).exists());
        take_down(&p, "run-1").unwrap();
        assert!(
            !ears_dir(&door).exists(),
            "a door that is down has no ears, or the next door of that name \
             inherits them"
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
