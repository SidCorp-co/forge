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
            write!(f, " (that directory has since been deleted)")?;
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
    /// The processes found, which may be none, and how many pids this box was
    /// not allowed to ask about at all.
    Read {
        residents: Vec<Resident>,
        /// Pids whose `cwd` the kernel would not show this process, which it
        /// does for a process of another user. Counted rather than dropped in
        /// silence: the reading is partial, and a caller saying nobody is in
        /// the checkout would be claiming more than was measured.
        not_asked: usize,
    },
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
    /// Nobody this box could ask about was living there, or everybody who was
    /// is gone.
    Clear {
        ended: Vec<Resident>,
        /// Pids this box was not allowed to ask about, carried so the line a
        /// removal writes says how complete its reading was.
        not_asked: usize,
    },
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
        not_asked: usize,
    },
}

/// How loudly the line a removal owes arrives.
///
/// `warn` in this daemon's journal is where the stranded-process report lands,
/// which is the line this module exists to make readable. A level taken from
/// whether there is a line AT ALL puts every other kind there too — and
/// `not_asked` is never zero on a shared box: 837 of `sid-xeon-1`'s pids
/// belonged to another user the day this shipped, so every uneventful removal
/// warned, carrying a constant fact about the box rather than anything about
/// that removal. So the level is the verdict's own answer and turns on whether
/// anything HAPPENED, never on whether anything was said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Loud {
    /// Nothing was ended and nothing is owed a reader's attention. The line is
    /// the reading's own completeness, which is still said on every removal:
    /// a claim that a checkout is clear is only ever a claim about the pids
    /// this box was allowed to ask about.
    Routine,
    /// Something was ended, or the question could not be put on this platform
    /// at all. Both are about THIS removal, and both are what `warn` in this
    /// journal means.
    Notable,
}

/// The line a removal owes a reader, and how loudly it arrives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Say {
    pub loud: Loud,
    pub said: String,
}

impl Say {
    fn routine(said: String) -> Option<Self> {
        Some(Self {
            loud: Loud::Routine,
            said,
        })
    }

    fn notable(said: String) -> Option<Self> {
        Some(Self {
            loud: Loud::Notable,
            said,
        })
    }
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
    /// The directory may be taken. `Some` is a line to say first, at the level
    /// it carries.
    Take(Option<Say>),
    /// It may not, and why.
    Refuse(String),
}

/// How a reading that could not ask about every pid says so.
///
/// Never omitted where the count is not zero: a line saying a checkout is clear
/// is a claim about every process on the box, and this reading is only ever a
/// claim about the ones the kernel would answer for.
fn unasked(n: usize) -> String {
    format!(
        "{n} pid(s) belong to another user, whose working directory this box is not allowed to \
         read and whose processes it could not signal either"
    )
}

/// The same, as a clause appended to a line that says something else first.
fn also(n: usize) -> String {
    match n {
        0 => String::new(),
        n => format!(" Also: {}.", unasked(n)),
    }
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
            // Nothing was ended, and the directory goes: the uneventful case,
            // which on a shared box is every case. The reading's completeness
            // is still owed — a run of this box could not have started
            // another user's process, but a line saying the checkout is clear
            // is a claim about the whole table and this one asked part of it —
            // so it is said, and said where a routine fact belongs.
            Ending::Clear { ended, not_asked } if ended.is_empty() => match not_asked {
                0 => Verdict::Take(None),
                n => Verdict::Take(Say::routine(format!(
                    "nobody this box may ask about is living in {}, and {}",
                    at.display(),
                    unasked(*n)
                ))),
            },
            Ending::Clear { ended, not_asked } => Verdict::Take(Say::notable(format!(
                "ended {} process(es) living in {} before taking it — {}{}",
                ended.len(),
                at.display(),
                ended
                    .iter()
                    .map(Resident::to_string)
                    .collect::<Vec<_>>()
                    .join("; "),
                also(*not_asked)
            ))),
            Ending::NoTable(said) => Verdict::Take(Say::notable(format!(
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
            Ending::Standing {
                standing,
                ended,
                not_asked,
            } => Verdict::Refuse(format!(
                "{} process(es) are still running in {} — {}. {}{} The directory stays: it is the \
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
                },
                also(*not_asked)
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
///
/// A live checkout's own path canonicalises outright. A `(deleted)` one
/// cannot — the directory it names is exactly what is gone — so this is
/// [`worktree::resolved_for_compare`], which canonicalises the longest
/// ancestor that still exists and reattaches the rest unchanged. Calling
/// `resolved` on only one side of a comparison is the bug this module was
/// filed to fix from the other direction: on a box where an ancestor
/// canonicalises to a different spelling — `/var` to `/private/var` on
/// macOS is ISS-1193's own case — a root read straight off disk and a
/// `(deleted)` path built from the same root would stop comparing equal the
/// moment only one of them was resolved.
fn resolved(p: &Path) -> PathBuf {
    super::worktree::resolved_for_compare(p)
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
    each_pid(proc_root, identity, read_cwd, |at, _gone| under(&want, at))
}

/// The `cwd` link as the kernel answers it.
fn read_cwd(at: &Path) -> std::io::Result<PathBuf> {
    std::fs::read_link(at)
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
        read_cwd,
        |at, gone| gone && wants.iter().any(|w| under(w, at)),
    )
}

/// What the kernel answers for a task that went between the listing and the
/// read.
///
/// An entry under `/proc/<pid>` is resolved against a LIVE task, so a read
/// taken as that task exits answers `ESRCH` — no such process — where the same
/// read answers `ENOENT` once the directory itself has gone.
/// `std::io::ErrorKind` has no name for `ESRCH`, so it arrives uncategorised
/// and was read as a reading this box should have been able to take: one
/// unrelated process exiting anywhere on the box refused an entire removal,
/// and on this box processes exit all the time. Seen in this crate's own
/// suite on 2026-09-28 — `the working directory of pid 3962457 could not be
/// read (No such process (os error 3))` — refusing a removal that pid had
/// nothing to do with.
///
/// The number is safe to read on every platform: Windows' own error 3 is
/// `ERROR_PATH_NOT_FOUND`, which `ErrorKind` already names `NotFound`, so this
/// arm says the same thing there that the arm above it does.
const ESRCH: i32 = 3;

/// Whether `e` says the process is gone, rather than that this box failed to
/// take a read it should have taken.
fn the_pid_went(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::NotFound) || e.raw_os_error() == Some(ESRCH)
}

/// The reading, with the `cwd` link read through `cwd`.
///
/// The reader is a seam and not a parameter anybody passes twice: the states
/// this reading has to get right are a pid that exits mid-read and a pid of
/// another user, and neither is a state a planted process root can be made to
/// enter. A test that could not reach them would be leaving the two arms that
/// decide whether a removal happens at all unproved.
fn each_pid(
    proc_root: &Path,
    identity: impl Fn(u32) -> Option<String>,
    cwd: impl Fn(&Path) -> std::io::Result<PathBuf>,
    wanted: impl Fn(&Path, bool) -> bool,
) -> Reading {
    let mut not_asked = 0usize;
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
        let raw = match cwd(&entry.path().join("cwd")) {
            Ok(raw) => raw,
            // The pid went between the listing and this line. There is no
            // process here to be living anywhere.
            Err(e) if the_pid_went(&e) => continue,
            // The kernel will not show this process's working directory, which
            // it does for a process of another user. Two things follow and
            // neither is a refusal: a run of this box executes as this user, so
            // another user's process was not started by one; and this box could
            // not signal it either, the kernel refusing that too, which already
            // stands as `Why::Refused` rather than passing. So it is skipped —
            // but COUNTED, because a reading that dropped it in silence would
            // let a caller say nobody is in the checkout on a measurement that
            // never asked. Measured on `sid-xeon-1`, 804 of 1074 pids answer
            // this way, which is why a blanket refusal here is not the fix
            // (consult 2e320c F2).
            Err(e) if matches!(e.kind(), std::io::ErrorKind::PermissionDenied) => {
                not_asked += 1;
                continue;
            }
            // Anything else is a read this box should have been able to take
            // and could not, and not knowing is not knowing it is safe.
            Err(e) => {
                return Reading::Unreadable(format!(
                    "the working directory of pid {pid} could not be read ({e}), so who is living \
                     in a checkout cannot be established on this box"
                ))
            }
        };
        let (base, gone) = link_target(&raw);
        // Both branches now spell `at` the same way, gone or not: `resolved`
        // canonicalises what still exists and reattaches what does not, which
        // for a live path is the whole of it and for a `(deleted)` one is
        // everything above the removed leaf. Special-casing `gone` here to
        // skip resolution is exactly what made a live root and a stranded
        // path stop comparing equal on a box where an ancestor's spelling
        // moves under canonicalisation.
        let at = resolved(&base);
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
    Reading::Read {
        residents: found,
        not_asked,
    }
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
///
/// `not_asked` comes from the reading this ending is taken over and is not
/// something this function can know: it is handed a list of residents, not a
/// process table. It was written here as a constant zero, and the answer is
/// carried straight out to a caller on the arm that REFUSES — so the clause
/// saying how complete the reading was reached every removal that succeeded
/// and none that refused, which is the inverse of where a reader needs it. A
/// kept directory is a decision somebody may have to finish by hand, and what
/// the box could not see is half of what that decision rests on.
pub async fn end_residents(
    residents: Vec<Resident>,
    not_asked: usize,
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
        Ending::Clear { ended, not_asked }
    } else {
        Ending::Standing {
            standing,
            ended,
            not_asked,
        }
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
            Reading::Read { residents, .. } if residents.is_empty() => Vec::new(),
            Reading::Read {
                residents,
                not_asked,
            } => {
                let ours = ancestry(self.proc_root, std::process::id());
                match end_residents(residents, not_asked, &ours, self.grace, self.hand).await {
                    Ending::Clear { ended, .. } => ended,
                    standing => return standing,
                }
            }
        };
        // The count comes off the LAST reading, because that is the one the
        // verdict is taken over.
        match residents_of(self.proc_root, worktree) {
            Reading::Read {
                residents,
                not_asked,
            } if residents.is_empty() => Ending::Clear { ended, not_asked },
            Reading::Read {
                residents,
                not_asked,
            } => Ending::Standing {
                standing: residents.into_iter().map(|r| (r, Why::Arrived)).collect(),
                ended,
                not_asked,
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
