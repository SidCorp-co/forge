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
    /// Residents running beneath a live Claude Code process: a live agent's
    /// work, whatever the ledger says about the run that held the checkout.
    /// Nothing was signalled, theirs or anybody else's (ISS-1378).
    Live {
        /// Each such resident, and the Claude Code process it runs beneath.
        agents: Vec<(Resident, u32)>,
        /// Everybody else living there, left alone with them.
        others: Vec<Resident>,
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
            Ending::Live {
                agents,
                others,
                not_asked,
            } => Verdict::Refuse(format!(
                "{} process(es) living in {} run beneath a live Claude Code process — {} — so the \
                 checkout is a live agent's work whatever the ledger says about the run that held \
                 it. Nothing in it was signalled, and the directory stays for the next sweep{}{}",
                agents.len(),
                at.display(),
                agents
                    .iter()
                    .map(|(r, agent)| format!("{r}, beneath Claude Code pid {agent}"))
                    .collect::<Vec<_>>()
                    .join("; "),
                match others.as_slice() {
                    [] => ".".to_string(),
                    rest => format!(
                        ". Also living in it, and left alone with them: {}.",
                        rest.iter()
                            .map(Resident::to_string)
                            .collect::<Vec<_>>()
                            .join("; ")
                    ),
                },
                also(*not_asked)
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

/// What the walk up from a resident found above it.
#[derive(Debug, PartialEq, Eq)]
enum Above {
    /// A Claude Code process, by pid: the resident is in a live agent's tree.
    Agent(u32),
    /// The top of the table, the walk's own ancestry, or a process that went
    /// while it was read: no agent is running it.
    Nobody,
    /// A step that should have been readable and was not.
    Unreadable(String),
}

/// How far up a walk goes. A gate is a handful of processes below its shell,
/// and a table deeper than this is not one a reading should guess about.
const MAX_WALK: usize = 64;

/// The Claude Code process `pid` runs beneath, where one does.
///
/// An agent's own work — the gate its shell started, a server it runs in the
/// background — is a descendant of its Claude Code process for as long as
/// that agent can still act on it. A process orphaned from an agent's shell is
/// handed to the box's subreaper (`systemd --user` on `sid-xeon-1`, measured
/// 2026-10-05) and is nobody's, which is the population ISS-1271 ends. A
/// Claude Code process in `ours` — the reaper's own ancestry, which is where a
/// test run from an agent's shell stands — is not an agent living in the
/// checkout, and the walk stops there.
fn agent_above(proc_root: &Path, pid: u32, ours: &BTreeSet<u32>) -> Above {
    let mut at = pid;
    for _ in 0..MAX_WALK {
        if ours.contains(&at) {
            return Above::Nobody;
        }
        match crate::daemon::subagent_host::claude_at(proc_root, at) {
            Ok(true) => return Above::Agent(at),
            Ok(false) => {}
            Err(why) => return Above::Unreadable(why),
        }
        let dir = proc_root.join(at.to_string());
        let status = match std::fs::read_to_string(dir.join("status")) {
            Ok(s) => s,
            Err(e) if the_pid_went(&e) && !dir.exists() => return Above::Nobody,
            Err(e) if e.raw_os_error() == Some(ESRCH) => return Above::Nobody,
            Err(e) => {
                return Above::Unreadable(format!(
                    "what pid {at} runs beneath could not be read ({e})"
                ))
            }
        };
        let parent = status
            .lines()
            .find_map(|l| l.strip_prefix("PPid:"))
            .and_then(|v| v.trim().parse::<u32>().ok());
        match parent {
            Some(p) if p > 1 => at = p,
            Some(_) => return Above::Nobody,
            None => {
                return Above::Unreadable(format!(
                    "pid {at}'s status names no parent, so what it runs beneath cannot be read"
                ))
            }
        }
    }
    Above::Unreadable(format!(
        "pid {pid}'s ancestry runs deeper than {MAX_WALK} processes"
    ))
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
        let identity = |pid: u32| self.hand.identity(pid);
        let ended = match residents_of_with(self.proc_root, worktree, identity) {
            Reading::NoTable(why) => return Ending::NoTable(why),
            Reading::Unreadable(why) => return Ending::Unreadable(why),
            Reading::Read { residents, .. } if residents.is_empty() => Vec::new(),
            Reading::Read {
                residents,
                not_asked,
            } => {
                let ours = ancestry(self.proc_root, std::process::id());
                // A resident in a live agent's tree is that agent's work, and
                // the ledger calling its run over does not make it anybody's
                // to end: a gate killed under a live run reads to that run as
                // a red in its own code (ISS-1378). So it, and the checkout,
                // are left whole, and nobody else in it is signalled either —
                // the directory stays regardless.
                let mut agents = Vec::new();
                let mut others = Vec::new();
                for r in residents {
                    match agent_above(self.proc_root, r.pid, &ours) {
                        Above::Agent(agent) => agents.push((r, agent)),
                        Above::Nobody => others.push(r),
                        Above::Unreadable(why) => {
                            return Ending::Unreadable(format!(
                                "{why}, so whether {r} is a live agent's work cannot be told"
                            ))
                        }
                    }
                }
                if !agents.is_empty() {
                    return Ending::Live {
                        agents,
                        others,
                        not_asked,
                    };
                }
                match end_residents(others, not_asked, &ours, self.grace, self.hand).await {
                    Ending::Clear { ended, .. } => ended,
                    standing => return standing,
                }
            }
        };
        // The count comes off the LAST reading, because that is the one the
        // verdict is taken over.
        match residents_of_with(self.proc_root, worktree, identity) {
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

/// What a test plants to stand where a process of another user stands.
///
/// Here rather than beside either caller because both removal routes take the
/// same reading, so both owe the same fixture — and this crate has already
/// paid for the other answer once: the log-capture helper reached eight copies
/// across the daemon, several of them saying in a comment that the shared one
/// was out of reach, before ISS-1271 put one where every test could reach it.
#[cfg(all(test, unix))]
pub(crate) mod planted {
    use std::path::{Path, PathBuf};

    /// A pid this box may list and may not ask about, with the permission put
    /// back when the test is done with it — on a panic too, which is why it is
    /// a guard and not a pair of calls.
    ///
    /// The kernel answers `EACCES` for the working directory of another user's
    /// process, and a directory with no search bit answers the same way for
    /// the link inside it. It is the ordinary case and not a rare one: 837 of
    /// `sid-xeon-1`'s pids answered that way at the reading that measured
    /// ISS-1271, so a removal on this box is ALWAYS taken over a partial
    /// reading. A test run as root reads every `cwd` and plants nothing, which
    /// each caller asserts rather than assumes.
    pub(crate) struct Unaskable(PathBuf);

    impl Unaskable {
        pub(crate) fn at(proc_root: &Path, pid: u32) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let d = proc_root.join(pid.to_string());
            std::fs::create_dir_all(&d).expect("a pid directory");
            std::os::unix::fs::symlink("/", d.join("cwd")).expect("a cwd link");
            std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o600))
                .expect("a pid directory this box may not walk into");
            Self(d)
        }
    }

    impl Drop for Unaskable {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700));
        }
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
        // Parented on the table's top unless a case says otherwise, so the
        // walk up from it finds no agent and reads to its end.
        if !d.join("status").exists() {
            std::fs::write(d.join("status"), "Name:\tx\nPPid:\t1\n").expect("a status");
        }
    }

    fn plant_parent(root: &Path, pid: u32, ppid: u32) {
        let d = root.join(pid.to_string());
        std::fs::create_dir_all(&d).expect("a pid directory");
        std::fs::write(d.join("status"), format!("Name:\tx\nPPid:\t{ppid}\n")).expect("a status");
    }

    /// ISS-1250 criterion 42 — judge r4 item 2: "(already unlinked)" told an
    /// operator nothing about why removing the folder standing there now does
    /// nothing to the process.
    #[test]
    fn a_resident_whose_directory_was_deleted_is_said_so_in_words() {
        let r = Resident {
            pid: 1960566,
            at: PathBuf::from("/x/.claude/worktrees/lh-social"),
            gone: true,
            cmd: "next-server (v16.2.1)".to_string(),
            identity: None,
        };
        let said = r.to_string();
        assert!(said.contains("has since been deleted"), "{said}");
        assert!(!said.contains("unlinked"), "{said}");
        let here = Resident { gone: false, ..r }.to_string();
        assert!(!here.contains("deleted"), "{here}");
    }

    fn pids(reading: &Reading) -> Vec<u32> {
        match reading {
            Reading::Read { residents, .. } => residents.iter().map(|r| r.pid).collect(),
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

    fn ending(residents: Vec<Resident>, ours: &[u32], not_asked: usize, hand: &Fake) -> Ending {
        let ours: BTreeSet<u32> = ours.iter().copied().collect();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(end_residents(residents, not_asked, &ours, NO_WAIT, hand))
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
        let _ = ending(
            vec![resident(51), resident(52), resident(53)],
            &[],
            0,
            &hand,
        );

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
        let _ = ending(vec![resident(61), resident(62)], &[], 0, &hand);

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
        let _ = ending(vec![resident(71), resident(72)], &[71], 0, &hand);

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
        let _ = ending(vec![resident(75), resident(76)], &[], 0, &hand);

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
        let outcome = ending(vec![resident(81), resident(82)], &[], 0, &hand);

        let Ending::Standing {
            standing, ended, ..
        } = outcome
        else {
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
        let outcome = ending(vec![resident(91)], &[91], 0, &hand);

        let Ending::Standing { standing, .. } = outcome else {
            panic!("an unsignallable resident is not a clear checkout: {outcome:?}");
        };
        assert_eq!(standing[0].1, Why::OurOwn);
    }

    #[test]
    fn a_pid_that_moved_stands_under_its_own_reason_rather_than_counting_as_ended() {
        let hand = Fake::default().handed_on(93);
        let outcome = ending(vec![resident(93)], &[], 0, &hand);

        let Ending::Standing {
            standing, ended, ..
        } = outcome
        else {
            panic!("a pid nobody could safely signal is not a clear checkout: {outcome:?}");
        };
        assert!(ended.is_empty(), "{ended:?}");
        assert_eq!(standing[0].1, Why::Moved);
    }

    #[test]
    fn a_kernel_that_refuses_the_signal_stands_under_what_it_said() {
        let hand = Fake::default().refusing(95);
        let outcome = ending(vec![resident(95)], &[], 0, &hand);

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
        let outcome = ending(vec![resident(101), resident(102)], &[], 0, &hand);

        let Ending::Clear { ended, .. } = outcome else {
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

    /// The same case, with the root reached through a symlinked ancestor —
    /// what `/var` resolving to `/private/var` on macOS does to a temp
    /// directory, reproduced without depending on macOS or its layout.
    ///
    /// `root` here canonicalises to a different spelling than the one it is
    /// written with. `deleted_residents_under` still has to find pid 111:
    /// canonicalising only the live `root` side of the comparison and
    /// leaving the `(deleted)` side as written is precisely the asymmetry
    /// that read as an empty list on `runner (macos-latest)` for a root this
    /// module itself built and had never stopped existing.
    #[test]
    fn a_stranded_path_is_found_through_a_symlinked_ancestor_the_root_also_resolves_through() {
        let scratch = Scratch::new("wtproc-stranded-symlink");
        let proc = scratch.join("proc");
        let real = scratch.join("real");
        std::fs::create_dir_all(real.join("repo/.claude/worktrees")).expect("the real tree");
        let via_link = scratch.join("via-link");
        symlink(&real, &via_link).expect("a symlinked ancestor");

        let root = via_link.join("repo/.claude/worktrees");
        let gone = root.join("iss-1217-judge");
        assert_ne!(
            root,
            root.canonicalize().expect("the live root resolves"),
            "the fixture proves nothing unless the symlink actually changes root's spelling"
        );

        plant(
            &proc,
            111,
            &format!("{}{}", gone.display(), crate::exe::DELETED_SUFFIX),
            "chrome --headless",
        );

        assert_eq!(
            pids(&deleted_residents_under(&proc, &[root])),
            vec![111],
            "a root reached by two different spellings is still one root, resolved or not"
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

        let Ending::Standing {
            standing, ended, ..
        } = outcome
        else {
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

    /// A hand under which every signalled pid goes, as a process that honours
    /// SIGTERM does, and which remembers what it signalled.
    struct Ends<'a> {
        proc_root: &'a Path,
        sent: Mutex<Vec<u32>>,
    }

    impl Hand for Ends<'_> {
        fn signal(&self, pid: u32, _sig: Sig) -> std::result::Result<(), String> {
            self.sent.lock().unwrap().push(pid);
            let _ = std::fs::remove_dir_all(self.proc_root.join(pid.to_string()));
            Ok(())
        }
        fn present(&self, pid: u32) -> bool {
            self.proc_root.join(pid.to_string()).exists()
        }
        fn identity(&self, pid: u32) -> Option<String> {
            Some(format!("proc-{pid}"))
        }
    }

    fn cleared(proc: &Path, wt: &Path) -> (Ending, Vec<u32>) {
        let hand = Ends {
            proc_root: proc,
            sent: Mutex::new(Vec::new()),
        };
        let clearing = Clearing {
            proc_root: proc,
            grace: NO_WAIT,
            hand: &hand,
        };
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(clearing.clear(wt));
        let sent = hand.sent.lock().unwrap().clone();
        (outcome, sent)
    }

    /// ISS-1378 criterion 8: a live agent's gate, and the stranger living
    /// beside it, are both left alone, and the checkout is refused.
    #[test]
    fn a_resident_beneath_a_live_agent_refuses_the_removal_and_nothing_is_signalled() {
        let scratch = Scratch::new("wtproc-agent");
        let proc = scratch.join("proc");
        let wt = scratch.join("wt");
        std::fs::create_dir_all(&wt).expect("a checkout");
        plant(&proc, 801, &wt.to_string_lossy(), "node jest");
        plant_parent(&proc, 801, 800);
        plant(&proc, 800, "/home/someone", "bash -c pnpm test");
        plant_parent(&proc, 800, 777);
        plant(
            &proc,
            777,
            "/home/someone",
            "/home/someone/.local/share/claude/versions/2.1.289",
        );
        plant(&proc, 802, &wt.to_string_lossy(), "next-server");

        let (outcome, sent) = cleared(&proc, &wt);
        let Ending::Live { agents, others, .. } = &outcome else {
            panic!("a live agent's checkout is not cleared: {outcome:?}");
        };
        assert_eq!(
            agents.iter().map(|(r, a)| (r.pid, *a)).collect::<Vec<_>>(),
            vec![(801, 777)]
        );
        assert_eq!(others.iter().map(|r| r.pid).collect::<Vec<_>>(), vec![802]);
        assert!(sent.is_empty(), "nothing is signalled: {sent:?}");
        assert!(matches!(outcome.verdict(&wt), Verdict::Refuse(_)));
    }

    /// ISS-1378 criterion 10: residents beneath no Claude Code process are
    /// still ended, as ISS-1271 made it.
    #[test]
    fn residents_beneath_no_agent_are_still_ended() {
        let scratch = Scratch::new("wtproc-orphan");
        let proc = scratch.join("proc");
        let wt = scratch.join("wt");
        std::fs::create_dir_all(&wt).expect("a checkout");
        plant(&proc, 811, &wt.to_string_lossy(), "next-server");
        plant(&proc, 812, &wt.to_string_lossy(), "node server.js");
        plant_parent(&proc, 812, 810);
        plant(&proc, 810, "/", "/usr/lib/systemd/systemd --user");

        let (outcome, sent) = cleared(&proc, &wt);
        let Ending::Clear { ended, .. } = &outcome else {
            panic!("an orphan's checkout is cleared: {outcome:?}");
        };
        assert_eq!(
            ended.iter().map(|r| r.pid).collect::<Vec<_>>(),
            vec![811, 812]
        );
        assert_eq!(sent, vec![811, 812]);
    }

    /// The walk stops at the reaper's own ancestry: a Claude Code process this
    /// process runs under is not an agent living in the checkout.
    #[test]
    fn a_claude_code_process_the_reaper_itself_runs_under_is_not_read_as_an_agent_in_the_tree() {
        let scratch = Scratch::new("wtproc-ours");
        let proc = scratch.join("proc");
        let wt = scratch.join("wt");
        std::fs::create_dir_all(&wt).expect("a checkout");
        let me = std::process::id();
        plant(&proc, me, "/", "cargo test");
        plant_parent(&proc, me, 950);
        plant(&proc, 950, "/", "claude");
        plant(&proc, 821, &wt.to_string_lossy(), "sleep 100000");
        plant_parent(&proc, 821, 950);

        let (outcome, sent) = cleared(&proc, &wt);
        assert!(
            matches!(&outcome, Ending::Clear { ended, .. } if ended.len() == 1),
            "{outcome:?}"
        );
        assert_eq!(sent, vec![821]);
    }

    /// ISS-1378 criterion 11, review F2: an ancestor whose parent can be read
    /// and whose arguments cannot is one nobody can say is not an agent.
    #[test]
    fn an_ancestor_whose_arguments_cannot_be_read_refuses_the_removal_unsignalled() {
        let scratch = Scratch::new("wtproc-noargs");
        let proc = scratch.join("proc");
        let wt = scratch.join("wt");
        std::fs::create_dir_all(&wt).expect("a checkout");
        plant(&proc, 841, &wt.to_string_lossy(), "node jest");
        plant_parent(&proc, 841, 840);
        plant_parent(&proc, 840, 1);
        // A directory where the arguments belong: a read that should have
        // been possible and was not.
        std::fs::create_dir_all(proc.join("840/cmdline")).unwrap();

        let (outcome, sent) = cleared(&proc, &wt);
        let Ending::Unreadable(why) = &outcome else {
            panic!("an ancestor nobody could identify is not read as nobody's: {outcome:?}");
        };
        assert!(why.contains("pid 840"), "{why}");
        assert!(sent.is_empty(), "{sent:?}");
    }

    /// ISS-1378 criterion 11.
    #[test]
    fn a_resident_whose_ancestry_cannot_be_read_refuses_the_removal_unsignalled() {
        let scratch = Scratch::new("wtproc-noparent");
        let proc = scratch.join("proc");
        let wt = scratch.join("wt");
        std::fs::create_dir_all(&wt).expect("a checkout");
        plant(&proc, 831, &wt.to_string_lossy(), "node jest");
        plant_parent(&proc, 831, 830);
        // 830 is listed and its status is a directory: a read that should
        // have been possible and was not.
        std::fs::create_dir_all(proc.join("830/status")).unwrap();

        let (outcome, sent) = cleared(&proc, &wt);
        let Ending::Unreadable(why) = &outcome else {
            panic!("not knowing is not knowing it is safe: {outcome:?}");
        };
        assert!(
            why.contains("pid 830") && why.contains("live agent"),
            "{why}"
        );
        assert!(sent.is_empty(), "{sent:?}");
        assert!(matches!(outcome.verdict(&wt), Verdict::Refuse(_)));
    }

    #[test]
    fn a_refusal_names_what_was_ended_first_and_not_only_what_stands() {
        let said = Ending::Standing {
            standing: vec![(resident(82), Why::Survived)],
            ended: vec![resident(81)],
            not_asked: 0,
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
    fn a_working_directory_this_box_should_have_read_and_could_not_refuses_the_whole_reading() {
        let scratch = Scratch::new("wtproc-cwd-eio");
        let proc = scratch.join("proc");
        let wt = scratch.join("wt");
        std::fs::create_dir_all(&wt).expect("a checkout");
        // A DIRECTORY where the `cwd` link belongs: `read_link` answers
        // `InvalidInput`, which is neither a pid that went nor a pid of another
        // user — it is a read this box should have been able to take.
        let d = proc.join("505");
        std::fs::create_dir_all(d.join("cwd")).expect("a pid directory");

        let Reading::Unreadable(why) = residents_of(&proc, &wt) else {
            panic!(
                "a cwd this box could not read for a reason that is not permission is a reading \
                 it did not take, and an empty list here would say nobody is in the checkout on a \
                 measurement that never happened"
            );
        };
        assert!(why.contains("pid 505"), "{why}");
    }

    #[test]
    fn a_pid_that_went_between_the_listing_and_the_read_is_skipped_and_not_counted() {
        let scratch = Scratch::new("wtproc-vanished");
        let proc = scratch.join("proc");
        let wt = scratch.join("wt");
        std::fs::create_dir_all(&wt).expect("a checkout");
        // A pid directory with no `cwd` entry at all: `read_link` answers
        // `NotFound`, which is the pid having gone.
        std::fs::create_dir_all(proc.join("606")).expect("a pid directory");
        plant(&proc, 607, &wt.to_string_lossy(), "still here");

        let Reading::Read {
            residents,
            not_asked,
        } = residents_of(&proc, &wt)
        else {
            panic!("a pid that went is not a reading this box could not take");
        };
        assert_eq!(
            residents.iter().map(|r| r.pid).collect::<Vec<_>>(),
            vec![607]
        );
        assert_eq!(
            not_asked, 0,
            "a pid that no longer exists is nobody this box was refused, so counting it would \
             report a partial reading that was in fact whole"
        );
    }

    #[test]
    fn a_clear_checkout_says_how_many_pids_it_was_never_allowed_to_ask_about() {
        let said = Ending::Clear {
            ended: Vec::new(),
            not_asked: 804,
        }
        .verdict(Path::new("/wt"));
        let Verdict::Take(Some(say)) = said else {
            panic!(
                "a reading that could not ask about 804 pids is not the same claim as one that \
                 asked about every one and found nobody: {said:?}"
            );
        };
        assert!(
            say.said.contains("804 pid(s) belong to another user"),
            "{}",
            say.said
        );
        assert_eq!(
            say.loud,
            Loud::Routine,
            "and it is a routine fact about the box, not a strand: nothing was ended and the \
             directory went. Every removal on this box carries this clause, so putting it where \
             the stranded report goes is what made that report unreadable"
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
        let Verdict::Take(Some(say)) = Ending::NoTable("no /proc here".into()).verdict(at) else {
            panic!(
                "a platform that keeps no process table reclaims its disk as it did before this \
                 module, and says on every removal that it could not look"
            );
        };
        assert!(
            say.said.contains("cannot be asked on this platform"),
            "{}",
            say.said
        );
        assert_eq!(
            say.loud,
            Loud::Notable,
            "and it stays a warning on every removal it takes: that arm is the priced amnesty \
             this change took, and a platform where the outcome is not enforced says so each \
             time rather than passing quietly"
        );
    }

    /// The count belongs to the READING, and an ending is taken over one.
    ///
    /// It was written as a constant zero here, so the completeness clause
    /// appeared on every removal that succeeded — those read the table again
    /// afterwards and took the count off that — and on none that refused,
    /// which return this value straight through. That is the inverse of where
    /// a reader needs it.
    #[test]
    fn an_ending_carries_the_completeness_of_the_reading_it_was_taken_over() {
        let hand = Fake::default().dying_on(91, Sig::Term);
        let cleared = ending(vec![resident(91)], &[], 804, &hand);
        assert_eq!(
            cleared,
            Ending::Clear {
                ended: vec![resident(91)],
                not_asked: 804
            },
            "an ending that ended everybody it found still only looked at the pids this box was \
             allowed to ask about"
        );

        let hand = Fake::default();
        let standing = ending(vec![resident(92)], &[], 804, &hand);
        let Ending::Standing { not_asked, .. } = standing else {
            panic!("{standing:?}");
        };
        assert_eq!(
            not_asked, 804,
            "and a refusal is where that matters most: the directory stays, and whoever finishes \
             it by hand is owed how much of the box the reading behind it could see"
        );
    }

    /// A pid that exits as the reading reaches it must not refuse a removal it
    /// has nothing to do with.
    ///
    /// `/proc/<pid>/cwd` is resolved against a live task, so the read answers
    /// `ESRCH` and not `ENOENT` — which has no `ErrorKind` name, arrived
    /// uncategorised, and was read as a reading this box should have been able
    /// to take. Seen for real in this crate's own suite on 2026-09-28: `the
    /// working directory of pid 3962457 could not be read (No such process (os
    /// error 3))` refused a removal over a pid that had already gone, on a box
    /// where pids come and go by the second.
    #[test]
    fn a_pid_that_exits_as_the_reading_reaches_it_does_not_refuse_the_whole_removal() {
        let scratch = Scratch::new("wtproc-esrch");
        let proc = scratch.join("proc");
        let wt = scratch.join("wt");
        std::fs::create_dir_all(&wt).expect("a checkout");
        plant(&proc, 71, &wt.to_string_lossy(), "still here");
        plant(&proc, 72, &wt.to_string_lossy(), "on its way out");

        let went = |at: &Path| match at.starts_with(proc.join("72")) {
            true => Err(std::io::Error::from_raw_os_error(ESRCH)),
            false => read_cwd(at),
        };
        let reading = each_pid(&proc, |pid| Some(format!("proc-{pid}")), went, |_, _| true);

        let Reading::Read {
            residents,
            not_asked,
        } = reading
        else {
            panic!(
                "a process that exited is not a reading this box failed to take, and refusing \
                 over one stops a removal that pid was never part of: {reading:?}"
            );
        };
        assert_eq!(
            residents.iter().map(|r| r.pid).collect::<Vec<_>>(),
            vec![71],
            "the one that went is left out, and the one still there is still a resident"
        );
        assert_eq!(
            not_asked, 0,
            "and it is not counted as a pid this box was refused either: nobody refused it, it \
             stopped existing"
        );
    }
}
