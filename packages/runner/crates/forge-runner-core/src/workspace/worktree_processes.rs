//! Who is living in a checkout, and giving them back before the checkout is.
//!
//! Removing a directory does not disturb a process running in it. The kernel
//! renders its `cwd` as `<path> (deleted)`, its open descriptors stay valid,
//! and code already loaded keeps serving. So a worktree removal that is only a
//! filesystem act leaves every server, browser and harness a run started in
//! its tree still bound to its port and still holding whatever it held, with
//! nothing on the box able to attribute it to anything: the tree that named it
//! is gone, so no later reading that looks at worktrees can see it at all. Read
//! on `sid-xeon-1` the day this module was written, more than twenty such
//! processes across three projects, one of them a `@forge/core` API on `*:8099`
//! holding twenty Postgres connections thirty-eight hours after its checkout
//! went (ISS-1271).
//!
//! Attribution here is RESIDENCE and nothing else: a process belongs to a
//! checkout when its working directory is that checkout or lies beneath it.
//! Never a port, never a command name, never a process group — each of those
//! would signal something nobody told this box belonged to the run, and a
//! reaper that cannot tell a run's own child from a stranger is required to
//! refuse rather than guess. What bounds a wrong attribution is not a better
//! predicate but the four things around it: the ledger says no run holds the
//! checkout before either route reaches here, this process and its own
//! ancestors are never signalled, a pid whose identity moved between the
//! reading and the signal is never signalled, and every pid this box does end
//! is named in the journal by pid and command line.
//!
//! The reading needs no `cfg`. It is taken off a process root handed in, so a
//! test plants one — and it answers three ways rather than two. A root that is
//! not there is a platform keeping no such table; a root that is there and will
//! not open is a reading that should have been taken and was not. That split is
//! `worktree::residence_of`'s own, and for its reason: not knowing is not the
//! same as knowing it is safe.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where a Linux box keeps the reading.
pub const PROC: &str = "/proc";

/// One process whose working directory is inside a checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resident {
    pub pid: u32,
    /// What its `cwd` link pointed at, with the kernel's ` (deleted)`
    /// annotation already taken off where it carried one.
    pub at: PathBuf,
    /// Whether that annotation was there: the directory it is living in has
    /// already been unlinked.
    pub gone: bool,
    /// Its command line, for the line that names it. Empty where it could not
    /// be read, which is never a reason to leave the process out — a process
    /// this box cannot describe is still a process in the tree.
    pub cmd: String,
    /// What this pid was when the reading found it. Read again immediately
    /// before a signal, so a pid handed to another process in between is not
    /// signalled on a reading that was about something else.
    pub identity: Option<String>,
}

impl std::fmt::Display for Resident {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "pid {} in {}", self.pid, self.at.display())?;
        if self.gone {
            write!(f, " (already unlinked)")?;
        }
        if !self.cmd.is_empty() {
            write!(f, ": {}", self.cmd)?;
        }
        Ok(())
    }
}

/// What this box could read about who is living in a checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reading {
    /// The processes found, which may be none.
    Read(Vec<Resident>),
    /// This platform keeps no process table at the root it was asked about, so
    /// the question cannot be put here at all.
    NoTable(String),
    /// The table is there and could not be read. A caller that treated this as
    /// an empty list would be asserting something nothing measured.
    Unreadable(String),
}

/// Which signal a [`Hand`] is asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sig {
    /// Ask it to go.
    Term,
    /// Take it.
    Kill,
}

/// What this box can do to a pid, and what it can read back about one.
///
/// A trait rather than three calls inline so the ending can be asserted over
/// every case — a process that ignores the first signal, one the kernel refuses
/// to signal at all, one whose pid was handed to something else between the
/// reading and the signal — rather than over the one process a test happens to
/// be able to make behave that way.
pub trait Hand: Send + Sync {
    /// Send `sig` to `pid`. `Err` carries what the kernel said.
    fn signal(&self, pid: u32, sig: Sig) -> std::result::Result<(), String>;
    /// Whether `pid` is still there.
    fn present(&self, pid: u32) -> bool;
    /// What `pid` is now, in the same terms the reading recorded.
    fn identity(&self, pid: u32) -> Option<String>;
}

/// How long the ending waits after each signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Grace {
    pub after_term: Duration,
    pub after_kill: Duration,
}

/// What a removal on this box waits: long enough for a node server to run its
/// exit handlers, short enough that a release holding a run's leases is not
/// held on it.
pub const GRACE: Grace = Grace {
    after_term: Duration::from_secs(5),
    after_kill: Duration::from_secs(2),
};

/// Whether a pid was handed to another process between two readings of it.
///
/// Only where BOTH readings name an identity and they differ. A later reading
/// that names none is a process that has gone or become a zombie — which is the
/// outcome the ending wanted, not a pid it must refuse to touch — and an
/// earlier one that names none is a platform that cannot tell, which is not
/// evidence of movement either.
fn moved(before: &Option<String>, now: &Option<String>) -> bool {
    matches!((before, now), (Some(a), Some(b)) if a != b)
}

/// Whether the kernel is holding an exit status under this pid and nothing
/// else.
///
/// A zombie answers `kill(0)` for as long as its parent has not waited, and
/// holds no working directory, no port and no connection — so counting one as
/// standing would refuse a removal over a process that has already gone.
/// `runner::doorbell::incarnation` reads the same field for the same reason,
/// and says so in its own words: *a pid does not name a process*.
#[cfg(target_os = "linux")]
fn is_zombie(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    // The command sits in parens and may hold spaces and parens of its own, so
    // the state is read from the last `)` rather than from the start.
    stat.rsplit_once(") ")
        .and_then(|(_, rest)| rest.split(' ').next())
        == Some("Z")
}

#[cfg(not(target_os = "linux"))]
fn is_zombie(_pid: u32) -> bool {
    false
}

/// Why a resident is still standing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Why {
    /// This process, or one of its own ancestors. It was never signalled: a
    /// daemon whose cwd is inside a tree it is reaping means the reading is
    /// wrong, and a reaper that kills its own supervisor turns a disk sweep
    /// into an outage.
    OurOwn,
    /// The pid was handed to another process between the reading and the
    /// signal. It was never signalled: the process this box attributed is
    /// already gone, and the one holding the pid now was attributed to nothing.
    Moved,
    /// It was not in the reading this ending was taken over. It moved into the
    /// checkout, or was forked by a resident, while that resident was being
    /// ended — so every pid the ending knew about can be gone and somebody can
    /// still be living there.
    Arrived,
    /// Signalled with `SIGKILL` and still there when the grace was up.
    Survived,
    /// The kernel refused the signal, and what it said.
    Refused(String),
}

impl std::fmt::Display for Why {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Why::OurOwn => f.write_str(
                "it is this process or one of its own ancestors, which this box will not signal",
            ),
            Why::Moved => f.write_str(
                "its pid was handed to another process between the reading and the signal, so \
                 signalling it would reach something this box never attributed to anything",
            ),
            Why::Arrived => f.write_str(
                "it appeared in the checkout while this box was clearing it, so no reading this \
                 ending was taken over ever named it",
            ),
            Why::Survived => f.write_str("it was still there after SIGKILL"),
            Why::Refused(said) => write!(f, "the signal was refused: {said}"),
        }
    }
}

/// What became of the residents of a checkout about to be given back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ending {
    /// Nobody was living there, or everybody who was is gone.
    Clear { ended: Vec<Resident> },
    /// This platform keeps no process table, so nothing was read and nothing
    /// signalled. The removal is no worse off than it was before this module.
    NoTable(String),
    /// The table is there and could not be read. Nothing was signalled, and
    /// nothing is claimed about who is living in the checkout.
    Unreadable(String),
    /// Residents this box could not end.
    Standing {
        standing: Vec<(Resident, Why)>,
        ended: Vec<Resident>,
    },
}

/// What a removal may do about the checkout, and the one line it owes a reader
/// either way.
///
/// The decision is a value rather than four arms written twice, because both
/// removal routes owe the same answer and a reader has to be able to tell,
/// afterwards, which of the four a directory went or stayed under. A removal
/// taken without the reading looks in the journal exactly like one taken after
/// a clear reading, and those are not the same claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// The directory may be taken. `Some` is a line to say first.
    Take(Option<String>),
    /// It may not, and why.
    Refuse(String),
}

impl Ending {
    /// One sentence naming everything still standing, for the refusal that
    /// carries it.
    pub fn said(standing: &[(Resident, Why)]) -> String {
        standing
            .iter()
            .map(|(r, why)| format!("{r} — {why}"))
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// Whether the checkout at `at` may be taken now.
    pub fn verdict(&self, at: &Path) -> Verdict {
        match self {
            Ending::Clear { ended } if ended.is_empty() => Verdict::Take(None),
            Ending::Clear { ended } => Verdict::Take(Some(format!(
                "ended {} process(es) living in {} before taking it — {}",
                ended.len(),
                at.display(),
                ended
                    .iter()
                    .map(Resident::to_string)
                    .collect::<Vec<_>>()
                    .join("; ")
            ))),
            Ending::NoTable(said) => Verdict::Take(Some(format!(
                "who is living in {} cannot be asked on this platform ({said}) — the directory is \
                 taken anyway, and a process left standing in it would keep its port and its \
                 connections with nothing on this box naming it",
                at.display()
            ))),
            Ending::Unreadable(said) => Verdict::Refuse(format!(
                "who is living in {} could not be read ({said}) — the directory stays, because \
                 not knowing is not the same as knowing nobody is in it",
                at.display()
            )),
            // What was ended is named here too, and not only what stands. A
            // refusal that printed the survivors alone would leave the
            // processes this box really did signal in no line anywhere, which
            // is the same silence the whole change exists to end (consult
            // 8064e5 F2).
            Ending::Standing { standing, ended } => Verdict::Refuse(format!(
                "{} process(es) are still running in {} — {}. {} The directory stays: it is the \
                 only thing left naming them",
                standing.len(),
                at.display(),
                Ending::said(standing),
                match ended.is_empty() {
                    true => "Nothing in it was ended.".to_string(),
                    false => format!(
                        "{} was ended first: {}.",
                        match ended.len() {
                            1 => "One process".to_string(),
                            n => format!("{n} processes"),
                        },
                        ended
                            .iter()
                            .map(Resident::to_string)
                            .collect::<Vec<_>>()
                            .join("; ")
                    ),
                }
            )),
        }
    }
}

/// A `cwd` link's target, with the kernel's annotation taken off it.
///
/// ` (deleted)` is an annotation and never a filename (`exe::DELETED_SUFFIX`),
/// so a path carrying it names a directory that is already gone — which is
/// exactly the state this module exists to stop, met from the other side.
fn link_target(raw: &Path) -> (PathBuf, bool) {
    let text = raw.to_string_lossy();
    match text.strip_suffix(crate::exe::DELETED_SUFFIX) {
        Some(base) => (PathBuf::from(base), true),
        None => (raw.to_path_buf(), false),
    }
}

/// The one spelling every path in this module is compared by.
fn resolved(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// Whether `at` is `root` or lies beneath it.
///
/// `Path::starts_with` compares whole components, which is the whole of why it
/// is used rather than a string prefix: this box names its worktrees `<tree>`,
/// `<tree>-b1`, `<tree>-b2`, and a prefix test would read a sibling as a
/// resident and end a LIVE run's processes over its neighbour's removal.
fn under(root: &Path, at: &Path) -> bool {
    at == root || at.starts_with(root)
}

fn cmdline_of(proc_pid: &Path) -> String {
    let Ok(raw) = std::fs::read(proc_pid.join("cmdline")) else {
        return String::new();
    };
    let line = raw
        .split(|b| *b == 0)
        .filter(|a| !a.is_empty())
        .map(|a| String::from_utf8_lossy(a).into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    line.chars().take(200).collect()
}

/// Every pid under `proc_root` whose working directory is `worktree` or lies
/// beneath it.
pub fn residents_of(proc_root: &Path, worktree: &Path) -> Reading {
    residents_of_with(proc_root, worktree, crate::daemon::serving::start_ticks)
}

/// [`residents_of`], with the reading of a pid's identity supplied.
///
/// A `/proc/<pid>` entry is two reads, not one, and a pid that exits between
/// them can be handed to an unrelated process before the second. Ending a
/// process on a reading half of which belonged to something else is precisely
/// the blind kill this module refuses, so the identity is read before the reads
/// and again after, and an entry whose identity moved is left out of the
/// reading rather than reported. It is passed in rather than taken off `/proc`
/// so a test can move it, which a planted tree cannot.
pub fn residents_of_with(
    proc_root: &Path,
    worktree: &Path,
    identity: impl Fn(u32) -> Option<String>,
) -> Reading {
    let want = resolved(worktree);
    each_pid(proc_root, identity, |at, _gone| under(&want, at))
}

/// Every pid under `proc_root` whose working directory is a path already
/// unlinked that lies beneath one of `roots`.
///
/// These are the processes past every removal's reach: their checkout went
/// without them, so nothing recorded a decision about them and no owner is left
/// to make one. They are named and never signalled — a reading that reaches
/// them cannot tell a run's own child from a stranger, and a reaper that cannot
/// tell must refuse. Naming them is still the whole of what nothing on this box
/// does: both orphans ISS-1271 was filed over were found by a person reading
/// `/proc/<pid>/cwd` by hand, because no line anywhere names one.
pub fn deleted_residents_under(proc_root: &Path, roots: &[PathBuf]) -> Reading {
    let wants: Vec<PathBuf> = roots.iter().map(|r| resolved(r)).collect();
    each_pid(
        proc_root,
        crate::daemon::serving::start_ticks,
        |at, gone| gone && wants.iter().any(|w| under(w, at)),
    )
}

fn each_pid(
    proc_root: &Path,
    identity: impl Fn(u32) -> Option<String>,
    wanted: impl Fn(&Path, bool) -> bool,
) -> Reading {
    let entries = match std::fs::read_dir(proc_root) {
        Ok(e) => e,
        // A root that is not there at all is a platform that keeps no such
        // table. Any OTHER reason it would not open is a reading this box
        // should have been able to take and did not, and a reading nobody took
        // says nothing about who is in the checkout.
        Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound) => {
            return Reading::NoTable(format!(
                "there is no {} on this platform, so no process's working directory can be read \
                 from here",
                proc_root.display()
            ))
        }
        Err(e) => {
            return Reading::Unreadable(format!(
                "{} could not be listed ({e})",
                proc_root.display()
            ))
        }
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        let before = identity(pid);
        // A pid whose cwd link cannot be read belongs to another user, and a
        // process of another user was not started by a run of this box's.
        let Ok(raw) = std::fs::read_link(entry.path().join("cwd")) else {
            continue;
        };
        let (base, gone) = link_target(&raw);
        let at = if gone { base } else { resolved(&base) };
        if !wanted(&at, gone) {
            continue;
        }
        let cmd = cmdline_of(&entry.path());
        // Everything above came off one pid. Only now can this box say whether
        // it came off one PROCESS.
        if identity(pid) != before {
            continue;
        }
        found.push(Resident {
            pid,
            at,
            gone,
            cmd,
            identity: before,
        });
    }
    found.sort_by_key(|r| r.pid);
    Reading::Read(found)
}

/// This process and every ancestor of it that `proc_root` names.
///
/// Read once, and handed to the ending as the set it may not signal.
pub fn ancestry(proc_root: &Path, of: u32) -> BTreeSet<u32> {
    let mut chain = BTreeSet::new();
    let mut pid = of;
    // A cycle cannot happen on a sane kernel and would hang this loop on an
    // insane one, so the walk is bounded by the set it is building.
    while chain.insert(pid) {
        let Some(parent) = parent_of(proc_root, pid) else {
            break;
        };
        if parent == 0 {
            break;
        }
        pid = parent;
    }
    chain
}

fn parent_of(proc_root: &Path, pid: u32) -> Option<u32> {
    let status = std::fs::read_to_string(proc_root.join(pid.to_string()).join("status")).ok()?;
    status
        .lines()
        .find_map(|l| l.strip_prefix("PPid:"))
        .and_then(|v| v.trim().parse::<u32>().ok())
}

/// Give the checkout's residents back to the box, and say what is left.
///
/// `SIGTERM` to every resident this box may signal, the first grace, `SIGKILL`
/// to those still there, the second grace, and one more reading. A pid in
/// `ours`, and one whose identity moved since the reading, are never signalled
/// at all and stand under their own reasons.
pub async fn end_residents(
    residents: Vec<Resident>,
    ours: &BTreeSet<u32>,
    grace: Grace,
    hand: &dyn Hand,
) -> Ending {
    let (mine, theirs): (Vec<Resident>, Vec<Resident>) =
        residents.into_iter().partition(|r| ours.contains(&r.pid));

    let mut handed_on: BTreeSet<u32> = BTreeSet::new();
    let mut refused: Vec<(u32, String)> = Vec::new();
    let mut send = |r: &Resident, sig: Sig, handed_on: &mut BTreeSet<u32>| {
        // The identity is read HERE and not only at the discovery: a pid the
        // reading attributed can exit and be handed to something else before
        // this line, and the signal would then reach a process nobody
        // attributed to anything (consult 8635d2 F1).
        if moved(&r.identity, &hand.identity(r.pid)) {
            handed_on.insert(r.pid);
            return;
        }
        if let Err(said) = hand.signal(r.pid, sig) {
            refused.push((r.pid, said));
        }
    };

    for r in &theirs {
        send(r, Sig::Term, &mut handed_on);
    }
    // Every resident has been asked before any is taken: a process whose
    // sibling was killed under it exits differently from one asked to go.
    tokio::time::sleep(grace.after_term).await;

    for r in &theirs {
        if !handed_on.contains(&r.pid) && hand.present(r.pid) {
            send(r, Sig::Kill, &mut handed_on);
        }
    }
    tokio::time::sleep(grace.after_kill).await;

    let mut ended = Vec::new();
    let mut standing: Vec<(Resident, Why)> = Vec::new();
    for r in theirs {
        if handed_on.contains(&r.pid) {
            standing.push((r, Why::Moved));
            continue;
        }
        if !hand.present(r.pid) {
            // A refused signal over a pid that is gone is `ESRCH` and its kin:
            // the process this box meant to end is not there, which is the
            // outcome it wanted.
            ended.push(r);
            continue;
        }
        let why = match refused.iter().find(|(pid, _)| *pid == r.pid) {
            Some((_, said)) => Why::Refused(said.clone()),
            None => Why::Survived,
        };
        standing.push((r, why));
    }
    for r in mine {
        standing.push((r, Why::OurOwn));
    }
    standing.sort_by_key(|(r, _)| r.pid);

    if standing.is_empty() {
        Ending::Clear { ended }
    } else {
        Ending::Standing { standing, ended }
    }
}

/// What a removal uses to clear a checkout's residents.
///
/// One seam rather than three parameters threaded through every caller:
/// `Clearing::this_box()` is what the daemon runs with, and a test hands its
/// own process root, its own graces and its own hand.
pub struct Clearing<'a> {
    pub proc_root: &'a Path,
    pub grace: Grace,
    pub hand: &'a dyn Hand,
}

/// The signalling this box really does.
pub struct ThisBox;

impl Hand for ThisBox {
    #[cfg(unix)]
    fn signal(&self, pid: u32, sig: Sig) -> std::result::Result<(), String> {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        let raw = i32::try_from(pid).map_err(|_| format!("{pid} is no pid this box can name"))?;
        let signal = match sig {
            Sig::Term => Signal::SIGTERM,
            Sig::Kill => Signal::SIGKILL,
        };
        kill(Pid::from_raw(raw), signal).map_err(|e| e.to_string())
    }

    #[cfg(not(unix))]
    fn signal(&self, _pid: u32, _sig: Sig) -> std::result::Result<(), String> {
        Err("this platform cannot signal another process from here".to_string())
    }

    fn present(&self, pid: u32) -> bool {
        crate::daemon::serving::pid_alive(pid) && !is_zombie(pid)
    }

    fn identity(&self, pid: u32) -> Option<String> {
        crate::daemon::serving::start_ticks(pid)
    }
}

static THIS_BOX: ThisBox = ThisBox;

impl Clearing<'static> {
    /// The real process table, the real graces, and a hand that really signals.
    pub fn this_box() -> Self {
        Self {
            proc_root: Path::new(PROC),
            grace: GRACE,
            hand: &THIS_BOX,
        }
    }
}

impl Clearing<'_> {
    /// Read who is living in `worktree`, end them, and say what is left.
    ///
    /// The last word is a FRESH reading and never the snapshot the ending
    /// started from. A resident that forks a replacement inside the checkout as
    /// it is asked to go leaves every pid the ending knew about gone — a clear
    /// answer over a checkout somebody is still living in, which is the orphan
    /// this whole module exists to stop, arrived at through the guard against
    /// it (consult 8064e5 F1). Nothing loops on it: a checkout that keeps
    /// growing residents is refused, and the refusal is what a caller is bound
    /// by.
    pub async fn clear(&self, worktree: &Path) -> Ending {
        let ended = match residents_of(self.proc_root, worktree) {
            Reading::NoTable(why) => return Ending::NoTable(why),
            Reading::Unreadable(why) => return Ending::Unreadable(why),
            Reading::Read(rs) if rs.is_empty() => Vec::new(),
            Reading::Read(rs) => {
                let ours = ancestry(self.proc_root, std::process::id());
                match end_residents(rs, &ours, self.grace, self.hand).await {
                    Ending::Clear { ended } => ended,
                    standing => return standing,
                }
            }
        };
        match residents_of(self.proc_root, worktree) {
            Reading::Read(rs) if rs.is_empty() => Ending::Clear { ended },
            Reading::Read(rs) => Ending::Standing {
                standing: rs.into_iter().map(|r| (r, Why::Arrived)).collect(),
                ended,
            },
            Reading::NoTable(why) | Reading::Unreadable(why) => Ending::Unreadable(format!(
                "the checkout was cleared and the reading that would confirm it could not be \
                 taken ({why})"
            )),
        }
    }

    /// The processes living in paths under `roots` that are already unlinked.
    pub fn stranded(&self, roots: &[PathBuf]) -> Reading {
        deleted_residents_under(self.proc_root, roots)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    use std::os::unix::fs::symlink;
    use std::sync::Mutex;

    use crate::test_scratch::Scratch;

    /// A `/proc` of this test's own: one directory per pid, a `cwd` symlink and
    /// a `cmdline`, which is every file the reading opens.
    fn plant(root: &Path, pid: u32, cwd: &str, cmd: &str) {
        let d = root.join(pid.to_string());
        std::fs::create_dir_all(&d).expect("a pid directory");
        // The target is written as text and never resolved by the planting, so
        // a kernel annotation and a path that does not exist are both plantable.
        symlink(cwd, d.join("cwd")).expect("a cwd link");
        std::fs::write(d.join("cmdline"), cmd.replace(' ', "\0")).expect("a cmdline");
    }

    fn plant_parent(root: &Path, pid: u32, ppid: u32) {
        let d = root.join(pid.to_string());
        std::fs::create_dir_all(&d).expect("a pid directory");
        std::fs::write(d.join("status"), format!("Name:\tx\nPPid:\t{ppid}\n")).expect("a status");
    }

    fn pids(reading: &Reading) -> Vec<u32> {
        match reading {
            Reading::Read(rs) => rs.iter().map(|r| r.pid).collect(),
            other => panic!("the reading was taken, not {other:?}"),
        }
    }

    /// A hand that signals nothing and records everything.
    #[derive(Default)]
    struct Fake {
        sent: Mutex<Vec<(u32, Sig)>>,
        dies_on: Mutex<std::collections::HashMap<u32, Sig>>,
        refuses: Mutex<BTreeSet<u32>>,
        gone: Mutex<BTreeSet<u32>>,
        /// What each pid answers when asked who it is. Absent means it answers
        /// the same thing the reading recorded.
        now: Mutex<std::collections::HashMap<u32, String>>,
    }

    impl Fake {
        fn dying_on(self, pid: u32, sig: Sig) -> Self {
            self.dies_on.lock().unwrap().insert(pid, sig);
            self
        }
        fn refusing(self, pid: u32) -> Self {
            self.refuses.lock().unwrap().insert(pid);
            self
        }
        /// The pid was handed to another process after the reading found it.
        fn handed_on(self, pid: u32) -> Self {
            self.now.lock().unwrap().insert(pid, "somebody else".into());
            self
        }
        fn sent(&self) -> Vec<(u32, Sig)> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl Hand for Fake {
        fn signal(&self, pid: u32, sig: Sig) -> std::result::Result<(), String> {
            self.sent.lock().unwrap().push((pid, sig));
            if self.refuses.lock().unwrap().contains(&pid) {
                return Err("Operation not permitted".to_string());
            }
            if self.dies_on.lock().unwrap().get(&pid) == Some(&sig) {
                self.gone.lock().unwrap().insert(pid);
            }
            Ok(())
        }
        fn present(&self, pid: u32) -> bool {
            !self.gone.lock().unwrap().contains(&pid)
        }
        fn identity(&self, pid: u32) -> Option<String> {
            Some(
                self.now
                    .lock()
                    .unwrap()
                    .get(&pid)
                    .cloned()
                    .unwrap_or_else(|| format!("proc-{pid}")),
            )
        }
    }

    const NO_WAIT: Grace = Grace {
        after_term: Duration::ZERO,
        after_kill: Duration::ZERO,
    };

    fn resident(pid: u32) -> Resident {
        Resident {
            pid,
            at: PathBuf::from("/wt"),
            gone: false,
            cmd: format!("proc-{pid}"),
            identity: Some(format!("proc-{pid}")),
        }
    }

    fn ending(residents: Vec<Resident>, ours: &[u32], hand: &Fake) -> Ending {
        let ours: BTreeSet<u32> = ours.iter().copied().collect();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(end_residents(residents, &ours, NO_WAIT, hand))
    }

    #[test]
    fn the_reading_names_every_pid_whose_working_directory_is_the_checkout_or_under_it() {
        let scratch = Scratch::new("wtproc-under");
        let proc = scratch.join("proc");
        let wt = scratch.join("wt");
        std::fs::create_dir_all(wt.join("packages/core")).expect("a checkout");

        plant(&proc, 11, &wt.to_string_lossy(), "next-server");
        plant(
            &proc,
            12,
            &wt.join("packages/core").to_string_lossy(),
            "node api",
        );

        assert_eq!(
            pids(&residents_of(&proc, &wt)),
            vec![11, 12],
            "a process living in the checkout and one living beneath it are both residents of it"
        );
    }

    #[test]
    fn the_reading_leaves_out_a_pid_living_outside_the_checkout() {
        let scratch = Scratch::new("wtproc-outside");
        let proc = scratch.join("proc");
        let wt = scratch.join("wt");
        let elsewhere = scratch.join("elsewhere");
        std::fs::create_dir_all(&wt).expect("a checkout");
        std::fs::create_dir_all(&elsewhere).expect("somewhere else");

        plant(&proc, 21, &elsewhere.to_string_lossy(), "another server");

        assert_eq!(
            pids(&residents_of(&proc, &wt)),
            Vec::<u32>::new(),
            "residence is the whole predicate: a process outside the checkout is nothing to do \
             with its removal"
        );
    }

    #[test]
    fn the_reading_leaves_out_a_sibling_checkout_whose_name_merely_starts_the_same() {
        let scratch = Scratch::new("wtproc-sibling");
        let proc = scratch.join("proc");
        let wt = scratch.join("iss-1271");
        let sibling = scratch.join("iss-1271-b2");
        std::fs::create_dir_all(&wt).expect("a checkout");
        std::fs::create_dir_all(&sibling).expect("a sibling checkout");

        plant(
            &proc,
            31,
            &sibling.to_string_lossy(),
            "another run's server",
        );

        assert_eq!(
            pids(&residents_of(&proc, &wt)),
            Vec::<u32>::new(),
            "this box names its worktrees <tree>, <tree>-b1, <tree>-b2 — a prefix test rather \
             than a component test would end a LIVE run's processes over a removal of its \
             neighbour"
        );
    }

    #[test]
    fn a_pid_whose_identity_moved_between_the_reads_is_left_out_of_the_reading() {
        let scratch = Scratch::new("wtproc-identity");
        let proc = scratch.join("proc");
        let wt = scratch.join("wt");
        std::fs::create_dir_all(&wt).expect("a checkout");
        plant(&proc, 41, &wt.to_string_lossy(), "here then gone");
        plant(&proc, 42, &wt.to_string_lossy(), "here throughout");

        let seen = Mutex::new(std::collections::HashMap::<u32, u32>::new());
        let identity = |pid: u32| {
            let mut seen = seen.lock().unwrap();
            let n = seen.entry(pid).or_insert(0);
            *n += 1;
            // 41 answers differently the second time it is asked: the pid was
            // handed to another process between the two reads.
            Some(if pid == 41 {
                format!("{pid}-{n}")
            } else {
                pid.to_string()
            })
        };

        assert_eq!(
            pids(&residents_of_with(&proc, &wt, identity)),
            vec![42],
            "everything read off a pid belongs to one PROCESS only where the identity either \
             side of the reads is the same one — reporting the other is how a blind kill is \
             reached from a careful predicate"
        );
    }

    #[test]
    fn a_process_root_that_is_not_there_answers_no_table_rather_than_an_empty_list() {
        let scratch = Scratch::new("wtproc-notable");
        let absent = scratch.join("there-is-no-proc-here");

        let Reading::NoTable(why) = residents_of(&absent, Path::new("/wt")) else {
            panic!("a platform with no process table is not a platform where nobody is running");
        };
        assert!(
            why.contains("no process's working directory can be read"),
            "it says what this platform cannot do, because the removal goes ahead on it: {why}"
        );
    }

    #[test]
    fn a_process_root_that_is_there_and_will_not_open_answers_unreadable() {
        let scratch = Scratch::new("wtproc-unreadable");
        let proc = scratch.join("proc");
        // A file where a directory belongs: it IS there, and it will not list.
        std::fs::write(&proc, "not a directory").expect("a file at the root's path");

        let Reading::Unreadable(why) = residents_of(&proc, Path::new("/wt")) else {
            panic!(
                "a table that is there and would not open is not the same answer as a platform \
                 that keeps none — not knowing is not knowing it is safe"
            );
        };
        assert!(why.contains("could not be listed"), "{why}");
    }

    #[test]
    fn every_resident_it_may_signal_is_asked_to_go_before_any_of_them_is_taken() {
        let hand = Fake::default();
        let _ = ending(vec![resident(51), resident(52), resident(53)], &[], &hand);

        let sent = hand.sent();
        let last_term = sent.iter().rposition(|(_, s)| *s == Sig::Term);
        let first_kill = sent.iter().position(|(_, s)| *s == Sig::Kill);
        assert!(
            matches!((last_term, first_kill), (Some(t), Some(k)) if t < k),
            "a process whose sibling was killed under it exits differently from one asked to \
             go, so every SIGTERM precedes every SIGKILL: {sent:?}"
        );
    }

    #[test]
    fn a_resident_that_went_on_the_first_signal_is_never_sent_the_second() {
        let hand = Fake::default()
            .dying_on(61, Sig::Term)
            .dying_on(62, Sig::Kill);
        let _ = ending(vec![resident(61), resident(62)], &[], &hand);

        assert!(
            !hand.sent().contains(&(61, Sig::Kill)),
            "SIGKILL goes only to what is still there when the grace is up: {:?}",
            hand.sent()
        );
        assert!(
            hand.sent().contains(&(62, Sig::Kill)),
            "and it does go to what is: {:?}",
            hand.sent()
        );
    }

    #[test]
    fn this_process_and_its_own_ancestors_are_never_signalled_at_all() {
        let hand = Fake::default();
        let _ = ending(vec![resident(71), resident(72)], &[71], &hand);

        assert_eq!(
            hand.sent().iter().filter(|(p, _)| *p == 71).count(),
            0,
            "a reaper that kills its own supervisor turns a disk sweep into an outage: {:?}",
            hand.sent()
        );
    }

    #[test]
    fn a_pid_handed_to_another_process_since_the_reading_is_never_signalled() {
        let hand = Fake::default().handed_on(75);
        let _ = ending(vec![resident(75), resident(76)], &[], &hand);

        assert_eq!(
            hand.sent().iter().filter(|(p, _)| *p == 75).count(),
            0,
            "the process this box attributed is already gone and the one holding its pid now was \
             attributed to nothing, so the signal would reach a stranger: {:?}",
            hand.sent()
        );
        assert!(
            hand.sent().iter().any(|(p, _)| *p == 76),
            "and the reading's other pid is still signalled: {:?}",
            hand.sent()
        );
    }

    #[test]
    fn a_resident_still_there_after_sigkill_stands_and_the_removal_is_told_which() {
        let hand = Fake::default().dying_on(81, Sig::Term);
        let outcome = ending(vec![resident(81), resident(82)], &[], &hand);

        let Ending::Standing { standing, ended } = outcome else {
            panic!("a resident that survived SIGKILL is not a clear checkout: {outcome:?}");
        };
        assert_eq!(ended.iter().map(|r| r.pid).collect::<Vec<_>>(), vec![81]);
        assert_eq!(
            standing
                .iter()
                .map(|(r, w)| (r.pid, w.clone()))
                .collect::<Vec<_>>(),
            vec![(82, Why::Survived)]
        );
    }

    #[test]
    fn a_resident_this_box_may_not_signal_stands_under_its_own_reason() {
        let hand = Fake::default();
        let outcome = ending(vec![resident(91)], &[91], &hand);

        let Ending::Standing { standing, .. } = outcome else {
            panic!("an unsignallable resident is not a clear checkout: {outcome:?}");
        };
        assert_eq!(standing[0].1, Why::OurOwn);
    }

    #[test]
    fn a_pid_that_moved_stands_under_its_own_reason_rather_than_counting_as_ended() {
        let hand = Fake::default().handed_on(93);
        let outcome = ending(vec![resident(93)], &[], &hand);

        let Ending::Standing { standing, ended } = outcome else {
            panic!("a pid nobody could safely signal is not a clear checkout: {outcome:?}");
        };
        assert!(ended.is_empty(), "{ended:?}");
        assert_eq!(standing[0].1, Why::Moved);
    }

    #[test]
    fn a_kernel_that_refuses_the_signal_stands_under_what_it_said() {
        let hand = Fake::default().refusing(95);
        let outcome = ending(vec![resident(95)], &[], &hand);

        let Ending::Standing { standing, .. } = outcome else {
            panic!("a refused signal is not a clear checkout: {outcome:?}");
        };
        assert!(
            matches!(&standing[0].1, Why::Refused(said) if said.contains("not permitted")),
            "the kernel's own words reach the refusal rather than a sentence about them: {:?}",
            standing[0].1
        );
    }

    #[test]
    fn a_checkout_whose_residents_all_went_is_clear_and_says_who_it_ended() {
        let hand = Fake::default()
            .dying_on(101, Sig::Term)
            .dying_on(102, Sig::Kill);
        let outcome = ending(vec![resident(101), resident(102)], &[], &hand);

        let Ending::Clear { ended } = outcome else {
            panic!("everybody went, so the directory may be taken: {outcome:?}");
        };
        assert_eq!(
            ended.iter().map(|r| r.pid).collect::<Vec<_>>(),
            vec![101, 102]
        );
    }

    #[test]
    fn the_stranded_reading_names_a_process_living_in_a_worktree_path_already_gone() {
        let scratch = Scratch::new("wtproc-stranded");
        let proc = scratch.join("proc");
        let root = scratch.join("repo/.claude/worktrees");
        std::fs::create_dir_all(&root).expect("a worktree root");
        let gone = root.join("iss-1217-judge");

        plant(
            &proc,
            111,
            &format!("{}{}", gone.display(), crate::exe::DELETED_SUFFIX),
            "chrome --headless",
        );

        assert_eq!(
            pids(&deleted_residents_under(&proc, &[root])),
            vec![111],
            "nothing on this box names these today, which is the state the issue was filed from"
        );
    }

    #[test]
    fn the_stranded_reading_leaves_out_a_process_whose_checkout_is_still_there() {
        let scratch = Scratch::new("wtproc-live");
        let proc = scratch.join("proc");
        let root = scratch.join("repo/.claude/worktrees");
        let live = root.join("iss-1271-b2");
        std::fs::create_dir_all(&live).expect("a live checkout");

        plant(&proc, 121, &live.to_string_lossy(), "a live run's server");

        assert_eq!(
            pids(&deleted_residents_under(&proc, &[root])),
            Vec::<u32>::new(),
            "a live run's own processes are not stranded, and warning about them every sweep is \
             how a report stops being read"
        );
    }

    /// A hand that plants a NEW pid in the process root the moment it signals,
    /// which is a resident forking a replacement inside the checkout as it is
    /// asked to go.
    ///
    /// It also takes the signalled pid's entry out of the root, because that is
    /// what a kernel does and a fixture that left it would have the second
    /// reading find a process that is not there — which is the fixture failing,
    /// not the source.
    struct Forks<'a> {
        proc_root: &'a Path,
        at: &'a Path,
        gone: Mutex<BTreeSet<u32>>,
    }

    impl Hand for Forks<'_> {
        fn signal(&self, pid: u32, _sig: Sig) -> std::result::Result<(), String> {
            self.gone.lock().unwrap().insert(pid);
            let _ = std::fs::remove_dir_all(self.proc_root.join(pid.to_string()));
            plant(
                self.proc_root,
                777,
                &self.at.to_string_lossy(),
                "the replacement",
            );
            Ok(())
        }
        fn present(&self, pid: u32) -> bool {
            !self.gone.lock().unwrap().contains(&pid)
        }
        fn identity(&self, pid: u32) -> Option<String> {
            Some(format!("proc-{pid}"))
        }
    }

    #[test]
    fn a_replacement_forked_while_the_checkout_was_being_cleared_refuses_the_removal() {
        let scratch = Scratch::new("wtproc-forked");
        let proc = scratch.join("proc");
        let wt = scratch.join("wt");
        std::fs::create_dir_all(&wt).expect("a checkout");
        plant(
            &proc,
            700,
            &wt.to_string_lossy(),
            "the one the reading found",
        );

        let hand = Forks {
            proc_root: &proc,
            at: &wt,
            gone: Mutex::new(BTreeSet::new()),
        };
        let clearing = Clearing {
            proc_root: &proc,
            grace: NO_WAIT,
            hand: &hand,
        };
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(clearing.clear(&wt));

        let Ending::Standing { standing, ended } = outcome else {
            panic!(
                "every pid the ending knew about went, and somebody is still living in the \
                 checkout — answering `Clear` here is the orphan this module exists to stop, \
                 reached through the guard against it: {outcome:?}"
            );
        };
        assert_eq!(ended.iter().map(|r| r.pid).collect::<Vec<_>>(), vec![700]);
        assert_eq!(
            standing
                .iter()
                .map(|(r, w)| (r.pid, w.clone()))
                .collect::<Vec<_>>(),
            vec![(777, Why::Arrived)]
        );
    }

    #[test]
    fn a_refusal_names_what_was_ended_first_and_not_only_what_stands() {
        let said = Ending::Standing {
            standing: vec![(resident(82), Why::Survived)],
            ended: vec![resident(81)],
        }
        .verdict(Path::new("/wt"));
        let Verdict::Refuse(said) = said else {
            panic!("{said:?}");
        };
        assert!(
            said.contains("pid 81") && said.contains("One process was ended first"),
            "a refusal that printed the survivors alone would leave the process this box really \
             did signal in no line anywhere, which is the silence the whole change ends: {said}"
        );
    }

    #[test]
    fn the_ancestor_set_is_this_process_and_the_chain_above_it() {
        let scratch = Scratch::new("wtproc-ancestry");
        let proc = scratch.join("proc");
        plant_parent(&proc, 300, 200);
        plant_parent(&proc, 200, 100);
        plant_parent(&proc, 100, 0);

        assert_eq!(
            ancestry(&proc, 300),
            [100, 200, 300].into_iter().collect::<BTreeSet<u32>>()
        );
    }

    #[test]
    fn a_table_that_would_not_open_refuses_the_removal_and_a_platform_without_one_does_not() {
        let at = Path::new("/wt");
        assert!(
            matches!(
                Ending::Unreadable("it would not open".into()).verdict(at),
                Verdict::Refuse(_)
            ),
            "a box that HAS a process table and would not read it has not established that \
             nobody is in the checkout"
        );
        let Verdict::Take(Some(said)) = Ending::NoTable("no /proc here".into()).verdict(at) else {
            panic!(
                "a platform that keeps no process table reclaims its disk as it did before this \
                 module, and says on every removal that it could not look"
            );
        };
        assert!(said.contains("cannot be asked on this platform"), "{said}");
    }
}
