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

use std::collections::BTreeSet;
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

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
    ///
    /// On a platform with no `/proc`, an ear another process registered is
    /// judged by its pid alone, so a reused pid widens that window to the
    /// whole of the dead owner's absence. Nothing rings across processes yet;
    /// what closes it is a source of process identity for that platform, owed
    /// by whoever wires the first cross-process ringer.
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
        ours().remove(&self.ear);
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

/// The ears this process holds. One of ours needs no guessing about a pid: we
/// are here, and the file goes when the `Listening` does.
fn ours() -> std::sync::MutexGuard<'static, BTreeSet<PathBuf>> {
    static OURS: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());
    OURS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A pid does not name a process. Pids are reused, and a zombie answers
/// `kill(0)` long after it stopped reading anything, so a registration carries
/// the incarnation of the process that wrote it where the platform has one.
#[cfg(target_os = "linux")]
pub(crate) fn incarnation(pid: i32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command sits in parens and may hold spaces and parens of its own, so
    // the fields are counted from the last `)` rather than from the start.
    let mut fields = stat.rsplit_once(") ")?.1.split(' ');
    if fields.next()? == "Z" {
        return None;
    }
    fields.nth(18).map(str::to_string)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn incarnation(_pid: i32) -> Option<String> {
    None
}

/// One file per ear, holding the pid that must do the reading and that pid's
/// incarnation. Several ears may hold the same door, so each takes a file of
/// its own and drops it on its way out.
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
    let body = format!("{pid}\n{}", incarnation(pid as i32).unwrap_or_default());
    std::fs::write(&ear, body)
        .map_err(|e| Error::Other(format!("doorbell: cannot register {}: {e}", ear.display())))?;
    ours().insert(ear.clone());
    Ok(ear)
}

/// Whether the ear named by this registration is still there to read the door.
fn ear_is_live(ear: &Path) -> bool {
    let Ok(body) = std::fs::read_to_string(ear) else {
        return false;
    };
    let mut lines = body.lines();
    let Some(pid) = lines.next().and_then(|l| l.trim().parse::<i32>().ok()) else {
        return false;
    };
    let stamped = lines.next().unwrap_or("").trim();
    match incarnation(pid) {
        // The pid is alive and is the same process that armed this door.
        Some(now) => now == stamped,
        // Either nothing is there under that pid, or it is a zombie, or this
        // platform names no incarnation and a live pid is all there is to go on.
        None => stamped.is_empty() && !matches!(kill(Pid::from_raw(pid), None), Err(Errno::ESRCH)),
    }
}

/// Whether a process that armed this door is still alive to read it. A
/// registration left behind by a process that died without dropping its ear
/// does not count, whoever else still holds the read end open.
fn still_listening(door: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(ears_dir(door)) else {
        return false;
    };
    let mine = ours();
    entries.flatten().any(|entry| {
        let path = entry.path();
        path.extension().is_some_and(|x| x == "ear") && (mine.contains(&path) || ear_is_live(&path))
    })
}

/// Whether the kernel took the byte. A door whose last reader went between the
/// open and this write answers `EPIPE`, and that is a `NoListener` as surely as
/// `ENXIO` is. `EAGAIN` is a reader that is there and behind, which is its
/// business and not the ringer's.
fn write_the_ring(fd: &OwnedFd, door: &Path) -> Result<bool> {
    classify_write(write(fd, b"\x07"), door)
}

/// What each outcome of that write means, apart from the kernel that produced
/// it. Anything other than these three is this module meeting something it has
/// no reading for, and it says so rather than choosing one.
fn classify_write(outcome: std::result::Result<usize, Errno>, door: &Path) -> Result<bool> {
    match outcome {
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
