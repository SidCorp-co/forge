//! What the box has left, on the filesystem its runs write their scratch into.
//!
//! Nothing else in either crate reads a filesystem at all, so until this the
//! daemon could watch a box fill and had no word for it. What that cost, on
//! sid-xeon-1 on 2026-09-25: `/tmp` — a 61G tmpfs, so RAM — ran out, and an
//! agent lost its shell entirely. Every call it made died before running, with
//! `ENOSPC ... open '/proc/self/fd/11/<id>.output'`, so it could take none of
//! the acts that would have freed space, and nothing anywhere named the disk
//! (ISS-1260).
//!
//! **Two axes, and reporting one of them is worse than reporting neither.**
//! Over the hours around that failure bytes fell from 43G used to 27G on their
//! own, as processes exited and tmpfs handed the pages back; inodes went the
//! other way, 89% used to 96%, because those come back when a directory is
//! removed and nothing was removing any. Every byte-shaped check said there was
//! room for the whole of it. So each line here carries both figures and names
//! which one crossed.
//!
//! **This reclaims nothing, and says so.** The reaper that removes a finished
//! run's checkout is [`crate::workspace::worktree_reap`]; it sweeps two roots
//! that both lie inside a repository, and it takes nothing younger than its
//! `MIN_AGE` of fourteen days. The trees that filled this box lay outside every
//! repository and were hours old. An operator who read a warning and assumed
//! the sweep had it in hand would have been told something false by omission.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How often the reading is taken.
///
/// The box ISS-1260 was raised from consumed ~93,000 inodes in four hours,
/// about 9% of what that filesystem holds. A reading on the worktree sweep's
/// six-hour period could cross both thresholds and the ceiling between two
/// ticks and report none of the three.
pub const TICK: Duration = Duration::from_secs(5 * 60);

/// How long a standing [`Verdict::Critical`] waits before it is said again.
///
/// Said once and then silent is how ISS-1201's sweep outage became a line
/// among thousands; said every tick is the other failure, and this sits
/// between them.
pub const SAY_CRITICAL_AGAIN: Duration = Duration::from_secs(60 * 60);

/// The free fraction, per axis, under which a reading is [`Verdict::Critical`].
///
/// Taken from one measured tree rather than from a round number: a judging
/// run's checkout on that box cost ~66,000 inodes of the 1,048,576 `/tmp`
/// holds, which is 6.3% (ISS-1260, measured 2026-09-26 00:02 +07 over five
/// such trees). So 8% free is the point at which at most one more of them
/// fits, and the one after that fails in whatever way its own tooling fails.
pub const CRITICAL_FREE_PERCENT: u64 = 8;

/// The free fraction, per axis, under which a reading is [`Verdict::Tight`]:
/// room for three of the trees `CRITICAL_FREE_PERCENT` measures, which is the
/// last point at which saying so is still early.
pub const TIGHT_FREE_PERCENT: u64 = 20;

/// Which of the two a figure was read on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    Bytes,
    Inodes,
}

impl Axis {
    pub fn name(self) -> &'static str {
        match self {
            Self::Bytes => "bytes",
            Self::Inodes => "inodes",
        }
    }
}

/// What the filesystem holding a box's scratch root had left at one moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Headroom {
    pub bytes_free: u64,
    pub bytes_total: u64,
    pub inodes_free: u64,
    pub inodes_total: u64,
}

/// The free fraction of one axis, or `None` where the filesystem states no
/// total for it.
///
/// A total of zero is not a full filesystem. btrfs and several others report
/// `f_files` as zero because they hold no fixed inode table, and reading that
/// as 0% free would put every such box permanently at `Critical` — an alarm
/// that is always on is one nobody reads.
///
/// The multiply comes before the divide and is taken in `u128`: a saturating
/// `u64` one turns counts near the type's ceiling into 1% free, which is a
/// clear filesystem reported as critical (consult fa8132 F1). A reading of
/// more free than total is capped rather than believed, for the same reason —
/// it is not a full disk.
fn free_percent(free: u64, total: u64) -> Option<u64> {
    if total == 0 {
        return None;
    }
    let percent = u128::from(free) * 100 / u128::from(total);
    Some(u64::try_from(percent.min(100)).unwrap_or(100))
}

impl Headroom {
    pub fn bytes_free_percent(&self) -> Option<u64> {
        free_percent(self.bytes_free, self.bytes_total)
    }

    pub fn inodes_free_percent(&self) -> Option<u64> {
        free_percent(self.inodes_free, self.inodes_total)
    }

    /// The tighter of the two measurable axes, and what it says.
    pub fn verdict(&self) -> Verdict {
        let mut tightest: Option<(Axis, u64)> = None;
        for (axis, percent) in [
            (Axis::Bytes, self.bytes_free_percent()),
            (Axis::Inodes, self.inodes_free_percent()),
        ] {
            let Some(percent) = percent else { continue };
            match tightest {
                Some((_, held)) if held <= percent => {}
                _ => tightest = Some((axis, percent)),
            }
        }
        let Some((axis, percent)) = tightest else {
            return Verdict::Unmeasurable(
                "the filesystem states a total of zero for both bytes and inodes".to_string(),
            );
        };
        if percent < CRITICAL_FREE_PERCENT {
            Verdict::Critical(axis)
        } else if percent < TIGHT_FREE_PERCENT {
            Verdict::Tight(axis)
        } else {
            Verdict::Clear
        }
    }
}

/// What one tick got when it asked the filesystem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reading {
    Took(Headroom),
    /// Why no reading could be taken. Kept apart from a reading of zero on
    /// purpose: the two are indistinguishable once either is turned into a
    /// number, and only one of them is a full disk.
    Refused(String),
}

impl Reading {
    pub fn verdict(&self) -> Verdict {
        match self {
            Self::Took(room) => room.verdict(),
            Self::Refused(why) => Verdict::Unmeasurable(why.clone()),
        }
    }

    /// Both axes, whichever one crossed, so the clear one is read beside it.
    fn figures(&self) -> String {
        match self {
            Self::Took(room) => format!(
                "{}, {}",
                figure(
                    "bytes",
                    said_bytes(room.bytes_free),
                    said_bytes(room.bytes_total),
                    room.bytes_free_percent(),
                ),
                figure(
                    "inodes",
                    room.inodes_free.to_string(),
                    room.inodes_total.to_string(),
                    room.inodes_free_percent(),
                ),
            ),
            Self::Refused(why) => format!("no reading ({why})"),
        }
    }
}

/// What one reading says about the box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Every measurable axis is above [`TIGHT_FREE_PERCENT`].
    Clear,
    /// The named axis is under [`TIGHT_FREE_PERCENT`].
    Tight(Axis),
    /// The named axis is under [`CRITICAL_FREE_PERCENT`].
    Critical(Axis),
    /// Nothing could be measured, and why. A box that cannot be read is not a
    /// box that is fine.
    Unmeasurable(String),
}

/// What a tick has to put in the journal, or `None` where the last line it
/// wrote still says it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Report {
    /// A verdict this tick is the first to reach.
    Entered(Verdict),
    /// A `Critical` verdict that still stands, said again, with how long it
    /// has stood.
    Stands { verdict: Verdict, held: Duration },
    /// A return to `Clear`, with how long the pressure it replaces stood.
    Cleared { was: Verdict, stood: Duration },
    /// A reading that could not be taken while a pressure stood, with that
    /// pressure and how long it had stood when the box last answered.
    ///
    /// Apart from `Entered(Unmeasurable)`, which is a box nothing was known
    /// about, because the two earn different levels. This one is no less full
    /// than it was five minutes ago (ISS-1260 F4).
    Blinded {
        was: Verdict,
        why: String,
        held: Duration,
    },
}

impl Report {
    /// Where this belongs in the journal.
    pub fn level(&self) -> tracing::Level {
        match self {
            Self::Entered(Verdict::Critical(_)) | Self::Stands { .. } => tracing::Level::ERROR,
            // The level the pressure it replaces had, never a lower one: an
            // alert routed on ERROR must not go quiet at the moment the
            // filesystem stops answering, which on a filling box is not an
            // unlikely moment (ISS-1260 F4).
            Self::Blinded { was, .. } => match was {
                Verdict::Critical(_) => tracing::Level::ERROR,
                _ => tracing::Level::WARN,
            },
            Self::Entered(Verdict::Tight(_) | Verdict::Unmeasurable(_)) => tracing::Level::WARN,
            Self::Entered(Verdict::Clear) | Self::Cleared { .. } => tracing::Level::INFO,
        }
    }
}

/// The levels a verdict has already been reported at, and when.
///
/// The shape is `worktree_reap::SweepClock`'s and for the same reason: a
/// condition that lasts is one line, not one line per tick, and the end of it
/// carries the duration because that is the number the disk answers to.
#[derive(Debug, Default)]
pub struct Watch {
    said: Option<Verdict>,
    said_at: Option<Instant>,
    since: Option<Instant>,
    /// The pressure that stood when the box stopped answering, held for as
    /// long as it goes on not answering. Without it the second blind tick has
    /// nothing to read the level off but the unreadable verdict itself.
    blinding: Option<Verdict>,
}

impl Watch {
    /// What this tick owes the journal.
    pub fn tick(&mut self, now: Instant, verdict: Verdict) -> Option<Report> {
        if let Verdict::Unmeasurable(why) = &verdict {
            if let Some(was) = self.blinding.clone().or_else(|| self.pressure()) {
                return self.blinded(now, was, why.clone());
            }
        }
        // Taken rather than dropped: a clear reading arriving straight out of
        // blindness replaces the pressure that was standing, not the
        // unreadable verdict that stood in for it, and `said` holds the
        // latter (consult ba0b62 F1).
        let blinded_over = self.blinding.take();
        if self.said.as_ref() == Some(&verdict) {
            if !matches!(verdict, Verdict::Critical(_)) {
                return None;
            }
            let said_at = self.said_at?;
            if now.duration_since(said_at) < SAY_CRITICAL_AGAIN {
                return None;
            }
            self.said_at = Some(now);
            return Some(Report::Stands {
                verdict,
                held: self.since.map_or(Duration::ZERO, |s| now.duration_since(s)),
            });
        }
        let was = self.said.replace(verdict.clone());
        let stood = self.since.map_or(Duration::ZERO, |s| now.duration_since(s));
        self.said_at = Some(now);
        self.since = Some(now);
        match (was, &verdict) {
            (Some(was), Verdict::Clear) if was != Verdict::Clear => Some(Report::Cleared {
                was: blinded_over.unwrap_or(was),
                stood,
            }),
            _ => Some(Report::Entered(verdict)),
        }
    }

    /// The pressure the last line reported, where it reported one.
    fn pressure(&self) -> Option<Verdict> {
        match self.said.clone() {
            Some(v @ (Verdict::Critical(_) | Verdict::Tight(_))) => Some(v),
            _ => None,
        }
    }

    /// A box that stopped answering while `was` stood.
    ///
    /// `since` is left where the pressure set it, so the duration on the line
    /// is how long that pressure has stood rather than how long the box has
    /// been unreadable. `said_at` moves, because the hour the repeat is
    /// measured from runs from the line that was actually written: taking it
    /// from the critical line before would put two lines five minutes apart.
    fn blinded(&mut self, now: Instant, was: Verdict, why: String) -> Option<Report> {
        let first = self.blinding.is_none();
        self.blinding = Some(was.clone());
        self.said = Some(Verdict::Unmeasurable(why.clone()));
        if !first {
            if !matches!(was, Verdict::Critical(_)) {
                return None;
            }
            let said_at = self.said_at?;
            if now.duration_since(said_at) < SAY_CRITICAL_AGAIN {
                return None;
            }
        }
        self.said_at = Some(now);
        Some(Report::Blinded {
            was,
            why,
            held: self.since.map_or(Duration::ZERO, |s| now.duration_since(s)),
        })
    }
}

/// Every distinct filesystem a run on this box writes its scratch into.
///
/// The process temp directory is where this process's own tooling writes, and for
/// a long time this module read only that. It is not the only place scratch
/// lands. A daemon started with `TMPDIR` pointing at one filesystem still
/// shares the box with every tool that ignores `TMPDIR` and writes under
/// `/tmp`, and those are the tools that fill it.
///
/// Measured 2026-09-26 on the box that raised ISS-1260, whose daemon runs with
/// `TMPDIR=/home/dev/.cache/forge-tmp`: that path is on the root disk, which
/// stood at 88% of its 62,447,616 inodes free, while `/tmp` — a tmpfs whose
/// 1,048,576 inodes are exactly the ceiling the incident hit — stood at 40%,
/// 461,000 of its used inodes belonging to agent scratch trees. Reading the
/// first alone reports `Clear` for a box whose other half is the one filling,
/// which is the silent substitution this module exists to refuse.
///
/// Creates nothing, on any root: the whole of this module's business with a
/// temp directory is asking the filesystem under it how much it has left.
#[cfg(unix)]
pub fn scratch_roots() -> Vec<PathBuf> {
    roots_for(std::env::temp_dir(), Path::new("/tmp"), |at| {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(at).ok().map(|m| m.dev())
    })
}

#[cfg(not(unix))]
pub fn scratch_roots() -> Vec<PathBuf> {
    vec![std::env::temp_dir()]
}

/// The configured root, plus `shared` when that is a filesystem of its own.
///
/// `device` is the caller's, so the rule can be tested without a box that
/// happens to mount the two apart.
///
/// The configured root is kept whatever `device` says about it: a `TMPDIR`
/// that cannot be stat'd is news, and [`read`] refuses it by name. `shared` is
/// added only when both devices are known and differ, so a box that cannot
/// read `/tmp`, or that already writes there, warns about neither.
fn roots_for(
    configured: PathBuf,
    shared: &Path,
    device: impl Fn(&Path) -> Option<u64>,
) -> Vec<PathBuf> {
    let mut roots = vec![configured.clone()];
    // Added whenever `shared` can be read and is not already the configured
    // root's own filesystem. An UNKNOWN configured device is not equality:
    // dropping `/tmp` because `TMPDIR` could not be stat'd is how a box loses
    // the reading of the one filesystem that is actually filling
    // (consult F1 on this change).
    if let Some(there) = device(shared) {
        if device(&configured) != Some(there) {
            roots.push(shared.to_path_buf());
        }
    }
    roots
}

/// Read every root and keep the one with least left, naming which it was.
///
/// The box is as short as its shortest filesystem, so a reading that averaged
/// them, or took the first, would report room the box does not have.
pub fn tightest(roots: &[PathBuf]) -> (PathBuf, Reading) {
    pick(roots.iter().map(|at| (at.clone(), read(at))).collect())
}

/// One tick's reading of the box: the root with least left, and every other
/// root that is also not clear.
///
/// The worst root alone decides the verdict and the level. The others are
/// carried because ranking one above another does not make the second one's
/// pressure go away: an operator told only that `/tmp` is critical cleans
/// `/tmp`, and learns five minutes later that the other root was critical too.
/// This module already prints the axis that did NOT cross beside the one that
/// did, for the same reason (consult F3 on this change).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Survey {
    pub at: PathBuf,
    pub reading: Reading,
    pub beside: Vec<(PathBuf, Reading)>,
}

/// Read every root and sort out which is the headline.
pub fn survey(roots: &[PathBuf]) -> Survey {
    surveyed(roots.iter().map(|at| (at.clone(), read(at))).collect())
}

/// The survey a set of readings makes, kept apart from taking them so the
/// sorting can be tested against planted readings.
fn surveyed(all: Vec<(PathBuf, Reading)>) -> Survey {
    let (at, reading) = pick(all.clone());
    let beside = all
        .into_iter()
        .filter(|(root, other)| *root != at && !matches!(other.verdict(), Verdict::Clear))
        .collect();
    Survey {
        at,
        reading,
        beside,
    }
}

/// The worst of what was read, kept apart from the reading itself so the
/// choosing can be tested against planted readings rather than against
/// whatever the box running the tests happens to have left.
///
/// No roots at all refuses. It would be a shorter function that returned
/// `Clear` for a box it never looked at, and that is the reading this module
/// must never produce.
fn pick(readings: Vec<(PathBuf, Reading)>) -> (PathBuf, Reading) {
    let mut worst: Option<(PathBuf, Reading)> = None;
    for (root, reading) in readings {
        let takes_it = match &worst {
            None => true,
            Some((_, held)) => ranked(&reading) > ranked(held),
        };
        if takes_it {
            worst = Some((root, reading));
        }
    }
    worst.unwrap_or_else(|| {
        (
            PathBuf::from("<none>"),
            Reading::Refused("this box names no scratch root to read".to_string()),
        )
    })
}

/// How bad a reading is, larger being worse: the severity of its verdict, then
/// how little is left on its shortest measurable axis.
///
/// `Unmeasurable` sits above `Clear` on purpose and below real pressure: a
/// root that cannot be read is not a root that is fine, and it is not evidence
/// of a fuller one either.
fn ranked(reading: &Reading) -> (u8, u64) {
    let severity = match reading.verdict() {
        Verdict::Clear => 0,
        Verdict::Unmeasurable(_) => 1,
        Verdict::Tight(_) => 2,
        Verdict::Critical(_) => 3,
    };
    let shortest = match reading {
        Reading::Took(room) => room
            .bytes_free_percent()
            .into_iter()
            .chain(room.inodes_free_percent())
            .min()
            .unwrap_or(100),
        Reading::Refused(_) => 100,
    };
    (severity, 100 - shortest.min(100))
}

/// Ask the filesystem holding `at` what it has left.
///
/// `fsblkcnt_t` and `fsfilcnt_t` are 64 bits on Linux and 32 on macOS, so the
/// widening is real on one of the two platforms this ships to and a no-op on
/// the other. Dropping it would narrow nothing and would stop compiling on the
/// platform where it widens.
///
/// **Priced, and not taken: this call cannot be killed.** `statvfs` blocks,
/// and on an unresponsive network or FUSE mount it blocks for as long as that
/// mount does. The caller runs it on the blocking pool, so no async worker
/// stalls and every other task keeps running; it awaits it plainly, so at most
/// one such call is ever out. What is left is that one blocking-pool thread
/// stays in the syscall, and the runtime's shutdown waits on it. Killing it
/// needs the probe in a process of its own, which is a subprocess every five
/// minutes on every box and a new failure surface of its own, to bound a case
/// that needs the scratch root to be a hung remote mount. That trade is named
/// here rather than taken, and it ends the day a box is measured running this
/// against one (consult 825bfe F1).
#[cfg(unix)]
#[allow(clippy::useless_conversion)]
pub fn read(at: &Path) -> Reading {
    match nix::sys::statvfs::statvfs(at) {
        Ok(fs) => {
            let block = u64::from(fs.fragment_size());
            Reading::Took(Headroom {
                bytes_free: u64::from(fs.blocks_available()).saturating_mul(block),
                bytes_total: u64::from(fs.blocks()).saturating_mul(block),
                inodes_free: u64::from(fs.files_available()),
                inodes_total: u64::from(fs.files()),
            })
        }
        Err(e) => Reading::Refused(format!("statvfs on {} answered {e}", at.display())),
    }
}

/// Ask the filesystem holding `at` what it has left.
#[cfg(not(unix))]
pub fn read(at: &Path) -> Reading {
    Reading::Refused(format!(
        "this platform has no filesystem reading the daemon can take, so nothing is known about {}",
        at.display()
    ))
}

/// What a checkout that cannot create a file does, in the words the journal is
/// searched with.
const COSTS: &str = "a run that cannot create a file fails in whatever way its own tooling fails: \
                     on 2026-09-25 every shell call an agent made died before it ran, naming a \
                     file descriptor and never the disk";

/// The half an operator would otherwise assume: both of the sweep's roots lie
/// inside a repository, so a box filling with scratch an hour old is filling
/// with what it cannot reach.
///
/// The age is read off `worktree_reap::MIN_AGE` rather than written here
/// beside it. A sentence naming a number the code no longer holds is a lie,
/// and this one would be a lie the moment that constant moves — which is the
/// change `docs/proposals/scratch-outside-the-repository-has-no-reaper.md`
/// asks for next.
fn sweep_wont(min_age: Duration) -> String {
    format!(
        "the worktree sweep will not reclaim this — it removes a checkout only after {} days, and \
         only under a repository",
        min_age.as_secs() / (24 * 3600)
    )
}

/// Put one report in the journal at the level its reading earned.
///
/// Here rather than in the daemon's tick because that tick is a `tokio` task
/// inside `daemon::run` with no seam a test can reach, and a source scan for
/// the three macro names passes while every one of them goes out as `info!` —
/// the shape this project's own `source-scanning-test-assertions` entry
/// records, and the one consult fa8132 F2 found here.
pub fn say(survey: &Survey, report: &Report) {
    let line = said(&survey.at, &survey.reading, report, &survey.beside);
    let level = report.level();
    if level == tracing::Level::ERROR {
        tracing::error!("{line}");
    } else if level == tracing::Level::WARN {
        tracing::warn!("{line}");
    } else {
        tracing::info!("{line}");
    }
}

/// The line one report goes into the journal as.
pub fn said(
    at: &Path,
    reading: &Reading,
    report: &Report,
    beside: &[(PathBuf, Reading)],
) -> String {
    let where_and_what = format!("{}: {}", at.display(), reading.figures());
    let line = match report {
        Report::Entered(Verdict::Clear) => {
            format!("[headroom] {where_and_what} — clear on both axes")
        }
        Report::Cleared { was, stood } => format!(
            "[headroom] {where_and_what} — clear on both axes again after {}: {}",
            lasted(*stood),
            had_crossed(was),
        ),
        Report::Blinded { was, why, held } => format!(
            "[headroom] {}: no reading could be taken ({why}) — {} when the box last answered, \
             and that verdict has stood {}. A box that stops answering is not a box that has \
             emptied. {COSTS}. {}",
            at.display(),
            had_crossed(was),
            lasted(*held),
            sweep_wont(crate::workspace::worktree_reap::MIN_AGE)
        ),
        Report::Entered(Verdict::Unmeasurable(why)) => format!(
            "[headroom] {}: no reading could be taken ({why}) — a box that cannot be read is not \
             a box that is fine, and nothing here will say it is filling",
            at.display()
        ),
        Report::Entered(verdict) => format!(
            "[headroom] {where_and_what} — {}. {COSTS}. {}",
            crossed(verdict),
            sweep_wont(crate::workspace::worktree_reap::MIN_AGE)
        ),
        Report::Stands { verdict, held } => format!(
            "[headroom] {where_and_what} — {} and has stood for {}. {COSTS}. {}",
            crossed(verdict),
            lasted(*held),
            sweep_wont(crate::workspace::worktree_reap::MIN_AGE)
        ),
    };
    if beside.is_empty() {
        return line;
    }
    let others = beside
        .iter()
        .map(|(root, other)| {
            format!(
                "{}: {} — {}",
                root.display(),
                other.figures(),
                crossed(&other.verdict())
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    format!("{line} Also short, and not fixed by clearing the above: {others}")
}

/// Which axis crossed which threshold, named so that the axis that did not is
/// read beside it rather than instead of it.
fn crossed(verdict: &Verdict) -> String {
    match verdict {
        Verdict::Critical(axis) => format!(
            "{} is CRITICAL, under {CRITICAL_FREE_PERCENT}% free",
            axis.name()
        ),
        Verdict::Tight(axis) => {
            format!("{} is TIGHT, under {TIGHT_FREE_PERCENT}% free", axis.name())
        }
        Verdict::Clear => "clear".to_string(),
        Verdict::Unmeasurable(why) => format!("unreadable ({why})"),
    }
}

/// The same clause as [`crossed`], about a pressure that is over.
///
/// `crossed` is a present-tense predicate, and a line that puts it in a noun
/// slot — `after 8220s of bytes is CRITICAL, under 8% free` — is the one line
/// of this module that did not read as English (ISS-1260 F1).
fn had_crossed(verdict: &Verdict) -> String {
    match verdict {
        Verdict::Critical(axis) => format!(
            "{} was CRITICAL, under {CRITICAL_FREE_PERCENT}% free",
            axis.name()
        ),
        Verdict::Tight(axis) => {
            format!(
                "{} was TIGHT, under {TIGHT_FREE_PERCENT}% free",
                axis.name()
            )
        }
        Verdict::Clear => "clear".to_string(),
        Verdict::Unmeasurable(why) => format!("unreadable ({why})"),
    }
}

/// One axis's counts, or the fact that the filesystem states no total for it.
///
/// An axis with no total used to print `0 of 0 inodes free (no total stated)`,
/// and `0 inodes free` is precisely the reading [`free_percent`]'s refusal
/// exists to stop anyone believing. The arithmetic refused it and the line
/// printed it anyway, leaving two zeros and a parenthetical to reconcile
/// mid-incident (ISS-1260 F2).
fn figure(axis: &str, free: String, total: String, percent: Option<u64>) -> String {
    match percent {
        Some(p) => format!("{free} of {total} {axis} free ({p}%)"),
        None => format!("{axis}: no total stated"),
    }
}

/// Bytes in the largest binary unit that leaves the figure at or above one,
/// and a plain count below a kibibyte so zero has a unit to be rendered in.
///
/// Always dividing by 1024^3 put `0.0G of 0.2G bytes free (3%)` at the head of
/// an ERROR line on a 200M tmpfs — a headline figure contradicting the
/// percentage beside it, on exactly the shape of scratch root a container
/// gives a run (ISS-1260 F3).
fn said_bytes(bytes: u64) -> String {
    const K: u64 = 1024;
    // Up to exbibytes because `u64::MAX` is about 16 of them. A table
    // stopping at T renders a pebibyte as `1024.0T`, which is not the largest
    // unit that leaves the figure at or above one (consult ba0b62 F3).
    for (unit, scale) in [
        ("E", K * K * K * K * K * K),
        ("P", K * K * K * K * K),
        ("T", K * K * K * K),
        ("G", K * K * K),
        ("M", K * K),
        ("K", K),
    ] {
        if bytes >= scale {
            return format!("{:.1}{unit}", bytes as f64 / scale as f64);
        }
    }
    format!("{bytes}B")
}

/// How long something stood, in a form a reader takes at a glance, with the
/// raw seconds beside it.
///
/// Seconds alone are the figure the line used to carry, and at three days they
/// come back as `273600s` for the reader to divide by 86,400 themselves. Under
/// a minute there is nothing to divide and `0h 0m` is noise, so that case is
/// the seconds alone (ISS-1260 F1).
fn lasted(stood: Duration) -> String {
    let seconds = stood.as_secs();
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let (days, hours, minutes) = (
        seconds / (24 * 3600),
        (seconds % (24 * 3600)) / 3600,
        (seconds % 3600) / 60,
    );
    let mut said = String::new();
    if days > 0 {
        said.push_str(&format!("{days}d "));
    }
    if days > 0 || hours > 0 {
        said.push_str(&format!("{hours}h "));
    }
    said.push_str(&format!("{minutes}m"));
    format!("{said} ({seconds}s)")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The filesystem as ISS-1260 measured it at 2026-09-26 00:02 +07: 51,843
    /// inodes free of 1,048,576, and 35G of 61G bytes free. The byte axis reads
    /// clear at 57%, which is the whole point — a byte-shaped check said there
    /// was room while the box was 51,843 inodes from a failure that took an
    /// agent's shell away.
    fn the_measured_box() -> Headroom {
        Headroom {
            bytes_free: 35 * 1024 * 1024 * 1024,
            bytes_total: 61 * 1024 * 1024 * 1024,
            inodes_free: 51_843,
            inodes_total: 1_048_576,
        }
    }

    #[test]
    fn the_inode_axis_goes_critical_while_the_byte_axis_reads_clear() {
        let room = the_measured_box();
        assert_eq!(
            room.bytes_free_percent(),
            Some(57),
            "the byte axis is the one that said there was room"
        );
        assert_eq!(
            room.verdict(),
            Verdict::Critical(Axis::Inodes),
            "a verdict that reads the byte axis, or reads the axes together, misses exactly the \
             failure this was built for"
        );
    }

    #[test]
    fn the_byte_axis_goes_critical_while_the_inode_axis_reads_clear() {
        let room = Headroom {
            bytes_free: 2 * 1024 * 1024 * 1024,
            bytes_total: 61 * 1024 * 1024 * 1024,
            inodes_free: 900_000,
            inodes_total: 1_048_576,
        };
        assert_eq!(room.inodes_free_percent(), Some(85));
        assert_eq!(room.verdict(), Verdict::Critical(Axis::Bytes));

        let reading = Reading::Took(room);
        let line = said(
            Path::new("/tmp"),
            &reading,
            &Report::Entered(reading.verdict()),
            &[],
        );
        assert!(
            line.contains("bytes is CRITICAL"),
            "an axis that names the other one sends every reader to the wrong figure: {line}"
        );
    }

    #[test]
    fn the_line_carries_both_axes_and_names_the_one_that_crossed() {
        let reading = Reading::Took(the_measured_box());
        let line = said(
            Path::new("/tmp"),
            &reading,
            &Report::Entered(reading.verdict()),
            &[],
        );
        assert!(line.contains("/tmp"), "{line}");
        assert!(line.contains("51843 of 1048576 inodes free (4%)"), "{line}");
        assert!(
            line.contains("35.0G of 61.0G bytes free (57%)"),
            "the axis that reads clear is what makes the other one legible: {line}"
        );
        assert!(line.contains("inodes is CRITICAL"), "{line}");
        assert!(
            line.contains("died before it ran"),
            "the line says what the condition costs: {line}"
        );
        assert!(
            line.contains("only after 14 days"),
            "an operator who assumes the sweep is handling this has been told something false by \
             omission: {line}"
        );
    }

    /// The number in that sentence is the reaper's own, not a copy standing
    /// beside it. The next change in this area is expected to lower
    /// `MIN_AGE`, and a line that went on saying fourteen afterwards would be
    /// a false statement with no checker over it.
    #[test]
    fn the_age_the_line_names_is_read_off_the_reaper_rather_than_written_beside_it() {
        assert!(
            sweep_wont(Duration::from_secs(14 * 24 * 3600)).contains("only after 14 days"),
            "{}",
            sweep_wont(Duration::from_secs(14 * 24 * 3600))
        );
        assert!(
            sweep_wont(Duration::from_secs(2 * 24 * 3600)).contains("only after 2 days"),
            "the sentence is built from the age it is handed, so lowering the reaper's constant \
             moves the line with it: {}",
            sweep_wont(Duration::from_secs(2 * 24 * 3600))
        );
        const SRC: &str = include_str!("headroom.rs");
        let from = SRC
            .find("pub fn said(")
            .expect("the line builder is in this file");
        let to = SRC[from..]
            .find("\nfn crossed(")
            .map_or(SRC.len(), |end| from + end);
        assert!(
            SRC[from..to].contains("sweep_wont(crate::workspace::worktree_reap::MIN_AGE)"),
            "and the age it is handed is the reaper's own constant, not a number typed beside it. \
             The window is the line builder's body alone, because a whole-file search would find \
             this assertion's own text and pass whatever the builder does"
        );
    }

    #[test]
    fn a_level_is_reported_on_the_tick_that_enters_it_and_not_on_every_tick_it_stands() {
        let mut watch = Watch::default();
        let t0 = Instant::now();
        let tight = Verdict::Tight(Axis::Inodes);

        assert_eq!(
            watch.tick(t0, tight.clone()),
            Some(Report::Entered(tight.clone()))
        );
        assert_eq!(
            watch.tick(t0 + TICK, tight.clone()),
            None,
            "the same verdict said on every tick is the line among thousands this replaces"
        );
        assert_eq!(
            watch.tick(t0 + SAY_CRITICAL_AGAIN * 2, tight),
            None,
            "only a critical verdict is worth saying twice"
        );
    }

    #[test]
    fn a_critical_verdict_that_stands_is_said_again_no_more_often_than_hourly() {
        let mut watch = Watch::default();
        let t0 = Instant::now();
        let critical = Verdict::Critical(Axis::Inodes);

        assert_eq!(
            watch.tick(t0, critical.clone()),
            Some(Report::Entered(critical.clone()))
        );
        assert_eq!(
            watch.tick(t0 + SAY_CRITICAL_AGAIN / 2, critical.clone()),
            None
        );
        assert_eq!(
            watch.tick(t0 + SAY_CRITICAL_AGAIN, critical.clone()),
            Some(Report::Stands {
                verdict: critical.clone(),
                held: SAY_CRITICAL_AGAIN,
            }),
            "a condition that ends in an unreadable failure is not said once four hours ago"
        );
        assert_eq!(
            watch.tick(t0 + SAY_CRITICAL_AGAIN + TICK, critical),
            None,
            "and the repeat is hourly, not per tick"
        );
    }

    #[test]
    fn a_return_to_clear_carries_how_long_the_pressure_stood() {
        let mut watch = Watch::default();
        let t0 = Instant::now();
        let critical = Verdict::Critical(Axis::Inodes);
        watch.tick(t0, critical.clone());

        let stood = SAY_CRITICAL_AGAIN * 3;
        let report = watch
            .tick(t0 + stood, Verdict::Clear)
            .expect("a return to clear is reported");
        assert_eq!(
            report,
            Report::Cleared {
                was: critical,
                stood,
            }
        );
        assert!(
            said(
                Path::new("/tmp"),
                &Reading::Took(the_measured_box()),
                &report,
                &[],
            )
            .contains("(10800s)"),
            "this used to assert the Report value alone, which is how an unreadable sentence \
             shipped under a passing criterion"
        );
    }

    #[test]
    fn a_reading_that_could_not_be_taken_is_not_a_clear_one() {
        let reading = Reading::Refused("statvfs answered ENOENT".to_string());
        let verdict = reading.verdict();
        assert!(
            matches!(verdict, Verdict::Unmeasurable(_)),
            "{verdict:?} — a box that cannot be read is not a box that is fine"
        );
        assert_ne!(verdict, Verdict::Clear);

        let mut watch = Watch::default();
        let report = watch
            .tick(Instant::now(), verdict)
            .expect("an unreadable box is reported rather than passed over");
        assert_eq!(
            report.level(),
            tracing::Level::WARN,
            "it is not an error that a platform cannot be measured, and it is not nothing. This \
             is the no-pressure plant, and it was the only one: what a box already critical does \
             when it stops answering is \
             `a_critical_box_that_stops_answering_keeps_its_level_and_its_repeat`"
        );
        assert!(
            said(Path::new("/tmp"), &reading, &report, &[]).contains("is not a box that is fine"),
            "the line has to say what the silence would otherwise mean"
        );
    }

    /// A filesystem holding no fixed inode table states `f_files` as zero.
    /// Read as a percentage that is 0% free, which is every such box pinned at
    /// `Critical` for ever — an alarm that is always on is one nobody reads.
    #[test]
    fn a_filesystem_stating_no_inode_total_is_judged_on_the_axis_it_does_state() {
        let room = Headroom {
            bytes_free: 40 * 1024 * 1024 * 1024,
            bytes_total: 61 * 1024 * 1024 * 1024,
            inodes_free: 0,
            inodes_total: 0,
        };
        assert_eq!(room.inodes_free_percent(), None);
        assert_eq!(room.verdict(), Verdict::Clear);
    }

    /// Two axes that floor to the same percentage are one reading and one
    /// line, so the tie needs a side to fall on or two boxes reading alike
    /// report differently.
    #[test]
    fn two_axes_floored_to_the_same_percentage_are_reported_under_bytes() {
        let room = Headroom {
            bytes_free: 61 * 1024 * 1024 * 1024 / 10,
            bytes_total: 61 * 1024 * 1024 * 1024,
            inodes_free: 1_048_576 / 10,
            inodes_total: 1_048_576,
        };
        assert_eq!(room.bytes_free_percent(), room.inodes_free_percent());
        assert_eq!(room.verdict(), Verdict::Tight(Axis::Bytes));
    }

    /// Criterion 10's last clause: where one axis states no total, the line is
    /// about the axis that does, not about neither.
    #[test]
    fn a_single_measurable_axis_is_the_one_a_pressure_line_names() {
        let room = Headroom {
            bytes_free: 1024 * 1024 * 1024,
            bytes_total: 61 * 1024 * 1024 * 1024,
            inodes_free: 0,
            inodes_total: 0,
        };
        assert_eq!(room.verdict(), Verdict::Critical(Axis::Bytes));

        let reading = Reading::Took(room);
        let line = said(
            Path::new("/tmp"),
            &reading,
            &Report::Entered(reading.verdict()),
            &[],
        );
        assert!(line.contains("bytes is CRITICAL"), "{line}");
        assert!(
            line.contains("inodes: no total stated"),
            "the axis that could not be measured is named on the line rather than left off it: \
             {line}"
        );
        assert!(
            !line.contains("0 of 0"),
            "and named without the count nobody took. The assertion above used to be a substring \
             of `0 of 0 inodes free (no total stated)`, so it could only go red on the axis being \
             dropped from the line entirely: {line}"
        );
    }

    /// The line a pressure's end goes out as, which no assertion here read
    /// until now: `crossed` is a present-tense predicate and `said` dropped it
    /// into a noun slot, so a Critical that cleared after 2h17m went out as
    /// `after 8220s of bytes is CRITICAL, under 8% free` (ISS-1260 F1).
    #[test]
    fn a_pressure_that_ended_is_named_in_the_past_tense_and_timed_in_both_forms() {
        let mut watch = Watch::default();
        let t0 = Instant::now();
        watch.tick(t0, Verdict::Critical(Axis::Bytes));
        let stood = Duration::from_secs(8_220);
        let report = watch
            .tick(t0 + stood, Verdict::Clear)
            .expect("a return to clear is reported");

        let line = said(
            Path::new("/tmp"),
            &Reading::Took(the_measured_box()),
            &report,
            &[],
        );
        assert!(
            line.contains("clear on both axes again after 2h 17m (8220s): bytes was CRITICAL"),
            "the pressure that ended belongs in the sentence rather than in a noun slot, and \
             three days of it must not be read off a count of seconds: {line}"
        );
        assert!(
            !line.contains("of bytes is CRITICAL"),
            "a present-tense predicate after `of` is the clause this replaces: {line}"
        );
    }

    /// Under a minute there is nothing to divide, and `0h 0m (45s)` is noise.
    #[test]
    fn a_duration_under_a_minute_is_stated_in_seconds_alone() {
        assert_eq!(lasted(Duration::from_secs(45)), "45s");
        assert_eq!(lasted(Duration::from_secs(60)), "1m (60s)");
        assert_eq!(lasted(Duration::from_secs(273_600)), "3d 4h 0m (273600s)");
    }

    /// `0 of 0 inodes free` is exactly the reading `free_percent` refuses, and
    /// the line printed it anyway beside the parenthetical that refuses it
    /// (ISS-1260 F2).
    #[test]
    fn an_axis_with_no_stated_total_carries_no_count_nobody_took() {
        let room = Headroom {
            bytes_free: 2 * 1024 * 1024 * 1024,
            bytes_total: 61 * 1024 * 1024 * 1024,
            inodes_free: 0,
            inodes_total: 0,
        };
        let reading = Reading::Took(room);
        let line = said(
            Path::new("/data"),
            &reading,
            &Report::Entered(reading.verdict()),
            &[],
        );
        assert!(line.contains("inodes: no total stated"), "{line}");
        assert!(
            !line.contains("0 of 0"),
            "two zeros and a parenthetical for an operator to reconcile mid-incident: {line}"
        );
    }

    /// A small tmpfs is the ordinary shape of a container's scratch root, and
    /// `0.0G of 0.2G bytes free (3%)` contradicts itself at the head of an
    /// ERROR line (ISS-1260 F3).
    #[test]
    fn a_filesystem_under_a_gibibyte_does_not_report_its_free_bytes_as_zero() {
        let room = Headroom {
            bytes_free: 6 * 1024 * 1024,
            bytes_total: 200 * 1024 * 1024,
            inodes_free: 300,
            inodes_total: 12_800,
        };
        let reading = Reading::Took(room);
        let line = said(
            Path::new("/tmp"),
            &reading,
            &Report::Entered(reading.verdict()),
            &[],
        );
        assert!(line.contains("6.0M of 200.0M bytes free (3%)"), "{line}");
        assert!(
            !line.contains("0.0G"),
            "a reader who takes the headline bytes at face value reaches for the wrong axis: \
             {line}"
        );
        assert_eq!(said_bytes(0), "0B", "zero has no unit to be rendered in");
        assert_eq!(said_bytes(1023), "1023B");
        assert_eq!(said_bytes(1024), "1.0K");
    }

    /// The box is no less full than it was five minutes ago. Levelling an
    /// unreadable reading at WARN unconditionally, and guarding the hourly
    /// repeat on `Verdict::Critical`, took an ERROR line away at the moment
    /// the filesystem stopped answering (ISS-1260 F4).
    #[test]
    fn a_critical_box_that_stops_answering_keeps_its_level_and_its_repeat() {
        let mut watch = Watch::default();
        let t0 = Instant::now();
        let critical = Verdict::Critical(Axis::Bytes);
        let why = "statvfs on /tmp answered EIO".to_string();
        let blind = Verdict::Unmeasurable(why.clone());

        assert_eq!(
            watch.tick(t0, critical.clone()),
            Some(Report::Entered(critical.clone()))
        );
        let entered = watch
            .tick(t0 + TICK, blind.clone())
            .expect("a box that stops answering under a standing critical is said");
        assert_eq!(
            entered,
            Report::Blinded {
                was: critical.clone(),
                why: why.clone(),
                held: TICK,
            }
        );
        assert_eq!(
            entered.level(),
            tracing::Level::ERROR,
            "an alert routed on ERROR going quiet the moment the filesystem stops answering is \
             the silence this module exists to refuse"
        );

        assert_eq!(
            watch.tick(t0 + TICK * 2, blind.clone()),
            None,
            "and it is not said again on every tick"
        );
        let again = watch
            .tick(t0 + TICK + SAY_CRITICAL_AGAIN, blind)
            .expect("the hourly repeat survives the box going unreadable");
        assert_eq!(again.level(), tracing::Level::ERROR);

        let line = said(
            Path::new("/tmp"),
            &Reading::Refused("statvfs on /tmp answered EIO".to_string()),
            &again,
            &[],
        );
        assert!(line.contains("no reading could be taken"), "{line}");
        assert!(
            line.contains("bytes was CRITICAL"),
            "the pressure that stood when the box last answered is what the operator acts on: \
             {line}"
        );
        assert!(
            line.contains("that verdict has stood 1h 5m (3900s)"),
            "the duration is how long the verdict has stood, not how long ago the box last \
             answered — the two differ by every successful tick in between (consult ba0b62 F2): \
             {line}"
        );
    }

    /// A pressure that ends while the box is still unreadable is still that
    /// pressure ending. Reporting `unreadable (...)` as the thing that
    /// cleared loses the axis an operator acts on, and `said` holds the
    /// unreadable verdict rather than the pressure by then (consult ba0b62
    /// F1).
    #[test]
    fn a_clear_reading_out_of_blindness_names_the_pressure_and_not_the_blindness() {
        let mut watch = Watch::default();
        let t0 = Instant::now();
        let critical = Verdict::Critical(Axis::Bytes);
        let blind = Verdict::Unmeasurable("statvfs answered EIO".to_string());

        watch.tick(t0, critical.clone());
        watch.tick(t0 + TICK, blind);
        let cleared = watch
            .tick(t0 + TICK * 2, Verdict::Clear)
            .expect("a return to clear is reported");
        assert_eq!(
            cleared,
            Report::Cleared {
                was: critical,
                stood: TICK * 2,
            },
            "the duration runs from the pressure, not from the tick the box stopped answering"
        );

        let line = said(
            Path::new("/tmp"),
            &Reading::Took(the_measured_box()),
            &cleared,
            &[],
        );
        assert!(
            line.contains("bytes was CRITICAL"),
            "the axis that was short is what a reader came for: {line}"
        );
    }

    /// `u64::MAX` is about sixteen exbibytes, so a table ending at T renders a
    /// pebibyte as `1024.0T` (consult ba0b62 F3).
    #[test]
    fn a_byte_figure_is_rendered_in_the_largest_unit_the_type_can_reach() {
        const K: u64 = 1024;
        assert_eq!(said_bytes(K * K * K * K * K), "1.0P");
        assert_eq!(said_bytes(K * K * K * K * K * K), "1.0E");
        assert_eq!(said_bytes(u64::MAX), "16.0E");
    }

    /// A tight box that stops answering is news once. Giving it the critical
    /// repeat would put an hourly line on every box whose `statvfs` is slow,
    /// which is the alarm nobody reads from the other end.
    #[test]
    fn a_tight_box_that_stops_answering_keeps_warn_and_is_said_once() {
        let mut watch = Watch::default();
        let t0 = Instant::now();
        let tight = Verdict::Tight(Axis::Inodes);
        let blind = Verdict::Unmeasurable("statvfs answered EIO".to_string());

        watch.tick(t0, tight.clone());
        let entered = watch
            .tick(t0 + TICK, blind.clone())
            .expect("the change of level is reported on the tick it arrives");
        assert_eq!(entered.level(), tracing::Level::WARN);
        assert!(matches!(entered, Report::Blinded { ref was, .. } if *was == tight));
        assert_eq!(
            watch.tick(t0 + TICK + SAY_CRITICAL_AGAIN, blind),
            None,
            "only a critical verdict is worth saying twice, blind or not"
        );
    }

    /// Minute 0 critical, minute 55 unreadable: the unreadable reading is a
    /// report of its own, so the hour runs from it. Criterion 15 is about the
    /// gap between two lines, and minute 60 would put two five minutes apart.
    #[test]
    fn going_blind_restarts_the_clock_the_hourly_repeat_is_measured_from() {
        let mut watch = Watch::default();
        let t0 = Instant::now();
        let critical = Verdict::Critical(Axis::Bytes);
        let blind = Verdict::Unmeasurable("statvfs answered EIO".to_string());

        watch.tick(t0, critical);
        watch.tick(t0 + Duration::from_secs(55 * 60), blind.clone());
        assert_eq!(
            watch.tick(t0 + Duration::from_secs(60 * 60), blind.clone()),
            None,
            "an hour after the critical line, but five minutes after the blind one"
        );
        assert!(
            watch
                .tick(t0 + Duration::from_secs(115 * 60), blind)
                .is_some(),
            "an hour after the line that was actually written"
        );
    }

    #[test]
    fn a_filesystem_stating_no_total_at_all_is_unmeasurable_rather_than_clear() {
        let room = Headroom {
            bytes_free: 0,
            bytes_total: 0,
            inodes_free: 0,
            inodes_total: 0,
        };
        assert!(matches!(room.verdict(), Verdict::Unmeasurable(_)));
    }

    /// Read back off a real subscriber rather than off `Report::level()`, and
    /// rather than off a source scan for the three macro names — which passes
    /// while every one of them goes out as `info!` (consult fa8132 F2).
    #[test]
    fn each_verdict_reaches_the_journal_at_the_level_its_reading_earns() {
        let reading = Reading::Took(the_measured_box());
        let at = Path::new("/tmp");

        let critical = logged_while(|| {
            say(
                &one_root(at, &reading),
                &Report::Entered(Verdict::Critical(Axis::Inodes)),
            );
        });
        assert!(
            critical.contains("ERROR"),
            "a critical box demoted into the thousands of info lines is the silence this \
             replaces: {critical}"
        );

        let tight = logged_while(|| {
            say(
                &one_root(at, &reading),
                &Report::Entered(Verdict::Tight(Axis::Inodes)),
            );
        });
        assert!(tight.contains("WARN"), "{tight}");
        assert!(!tight.contains("ERROR"), "{tight}");

        let clear = logged_while(|| {
            say(&one_root(at, &reading), &Report::Entered(Verdict::Clear));
        });
        assert!(clear.contains("INFO"), "{clear}");
        assert!(!clear.contains("WARN"), "{clear}");
    }

    /// A third copy of this crate's log-capture helper, beside `master.rs`'s
    /// `give_back_tests::logged_while` and its `own_exe_reporting_tests` one.
    /// The shared one is `pub(super)` inside a private test module of a file
    /// this change may not edit, so it is out of reach from here.
    fn logged_while(f: impl FnOnce()) -> String {
        use std::sync::{Arc, Mutex};
        #[derive(Clone)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf(Arc::new(Mutex::new(Vec::new())));
        let made = buf.clone();
        let sub = tracing_subscriber::fmt()
            .with_writer(move || made.clone())
            .with_ansi(false)
            .finish();
        crate::daemon::keep_tracing_capturable();
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    /// The counts a filesystem states are whatever it states, and the one
    /// arithmetic step between them and the verdict is a multiply. Taken in
    /// `u64` it saturates, and an empty filesystem reads as 1% free — which is
    /// `Critical` on a box with everything free (consult fa8132 F1).
    #[test]
    fn counts_at_the_ceiling_of_their_type_read_as_free_rather_than_as_full() {
        let room = Headroom {
            bytes_free: u64::MAX,
            bytes_total: u64::MAX,
            inodes_free: u64::MAX,
            inodes_total: u64::MAX,
        };
        assert_eq!(room.bytes_free_percent(), Some(100));
        assert_eq!(room.inodes_free_percent(), Some(100));
        assert_eq!(room.verdict(), Verdict::Clear);
    }

    /// The tick is a `tokio` task inside `daemon::run` with no seam a test can
    /// reach, so the source is the subject — the same shape
    /// `worktree_reap`'s own tick test takes. What goes red here is the tick
    /// losing a level, which is how a verdict earned at `ERROR` reaches the
    /// journal as one more `info!` among thousands.
    #[test]
    fn the_tick_reads_off_the_blocking_pool_and_leaves_the_level_to_this_module() {
        const DAEMON: &str = include_str!("mod.rs");

        assert!(
            DAEMON.contains("spawn_blocking(move || headroom::survey(&here))"),
            "`statvfs` blocks, so a scratch root on a hung mount would take a daemon worker with it"
        );
        assert!(
            DAEMON.contains("headroom::scratch_roots()"),
            "a tick reading one root reports the configured filesystem and stays silent about the \
             one the box is actually filling"
        );
        assert!(
            DAEMON.contains("tokio::time::interval(TICK)"),
            "the tick keeps this module's own period: a reading on the sweep's six hours could \
             cross both thresholds and the ceiling between two of them"
        );
        assert!(
            DAEMON.contains("headroom::say(&survey, &report)"),
            "the level is this module's, where a subscriber reads it back; a tick building its \
             own line is a level nothing checks"
        );
    }

    /// A survey of one root, for the assertions that are about the level or
    /// the line rather than about choosing between roots.
    fn one_root(at: &Path, reading: &Reading) -> Survey {
        Survey {
            at: at.to_path_buf(),
            reading: reading.clone(),
            beside: Vec::new(),
        }
    }

    /// A device lookup that answers from a table, so the rule under
    /// `roots_for` is measured rather than the mount table of whatever box
    /// runs the suite.
    fn devices(table: &[(&'static str, u64)]) -> impl Fn(&Path) -> Option<u64> {
        let owned: Vec<(String, u64)> = table
            .iter()
            .map(|(at, dev)| ((*at).to_string(), *dev))
            .collect();
        move |at: &Path| {
            owned
                .iter()
                .find(|(known, _)| Path::new(known) == at)
                .map(|(_, dev)| *dev)
        }
    }

    #[test]
    fn a_tmp_on_a_filesystem_of_its_own_is_read_beside_the_configured_root() {
        let roots = roots_for(
            PathBuf::from("/home/dev/.cache/forge-tmp"),
            Path::new("/tmp"),
            devices(&[("/home/dev/.cache/forge-tmp", 66306), ("/tmp", 47)]),
        );
        assert_eq!(
            roots,
            vec![
                PathBuf::from("/home/dev/.cache/forge-tmp"),
                PathBuf::from("/tmp")
            ],
            "this is the box that raised ISS-1260: reading only the configured root reports the \
             disk at 88% free and says nothing about the tmpfs at 40%"
        );
    }

    #[test]
    fn a_configured_root_already_on_tmp_is_read_once_and_not_twice() {
        let roots = roots_for(
            PathBuf::from("/tmp/forge"),
            Path::new("/tmp"),
            devices(&[("/tmp/forge", 47), ("/tmp", 47)]),
        );
        assert_eq!(
            roots,
            vec![PathBuf::from("/tmp/forge")],
            "one filesystem read twice is one pressure reported as two"
        );
    }

    #[test]
    fn a_tmp_that_cannot_be_stated_is_left_alone_rather_than_warned_about() {
        let roots = roots_for(
            PathBuf::from("/scratch"),
            Path::new("/tmp"),
            devices(&[("/scratch", 9)]),
        );
        assert_eq!(
            roots,
            vec![PathBuf::from("/scratch")],
            "a box with no /tmp to read must not be told every five minutes that it cannot read it"
        );
    }

    #[test]
    fn a_configured_root_that_cannot_be_stated_is_kept_and_costs_tmp_nothing() {
        let roots = roots_for(
            PathBuf::from("/gone"),
            Path::new("/tmp"),
            devices(&[("/tmp", 47)]),
        );
        assert_eq!(
            roots,
            vec![PathBuf::from("/gone"), PathBuf::from("/tmp")],
            "a TMPDIR that cannot be stat'd is news, so it is kept and `read` refuses it by name; \
             and an unknown device is not proof that /tmp is the same filesystem, so dropping /tmp \
             here loses the reading of the one that is actually filling"
        );
    }

    /// A filesystem with `percent` of both axes free.
    fn with_free(percent: u64) -> Reading {
        Reading::Took(Headroom {
            bytes_free: percent,
            bytes_total: 100,
            inodes_free: percent,
            inodes_total: 100,
        })
    }

    #[test]
    fn the_root_with_least_left_is_the_one_reported() {
        let (at, reading) = pick(vec![
            (PathBuf::from("/roomy"), with_free(90)),
            (PathBuf::from("/filling"), with_free(5)),
        ]);
        assert_eq!(
            at,
            PathBuf::from("/filling"),
            "the box is as short as its shortest filesystem; taking the first reports room it \
             does not have"
        );
        assert_eq!(reading.verdict(), Verdict::Critical(Axis::Bytes));
    }

    #[test]
    fn the_shortest_root_is_reported_whichever_order_it_was_read_in() {
        let (at, _) = pick(vec![
            (PathBuf::from("/filling"), with_free(5)),
            (PathBuf::from("/roomy"), with_free(90)),
        ]);
        assert_eq!(
            at,
            PathBuf::from("/filling"),
            "a later clear root must not displace the pressure already found"
        );
    }

    #[test]
    fn between_two_roots_under_the_same_verdict_the_shorter_one_is_reported() {
        let (at, _) = pick(vec![
            (PathBuf::from("/tight"), with_free(19)),
            (PathBuf::from("/tighter"), with_free(10)),
        ]);
        assert_eq!(
            at,
            PathBuf::from("/tighter"),
            "both are Tight, so the severity alone cannot separate them and the figures must"
        );
    }

    #[test]
    fn a_root_that_cannot_be_read_outranks_a_clear_one() {
        let (at, reading) = pick(vec![
            (PathBuf::from("/roomy"), with_free(90)),
            (
                PathBuf::from("/unreadable"),
                Reading::Refused("statvfs said no".to_string()),
            ),
        ]);
        assert_eq!(
            at,
            PathBuf::from("/unreadable"),
            "a root that cannot be read is not a root that is fine"
        );
        assert!(matches!(reading.verdict(), Verdict::Unmeasurable(_)));
    }

    #[test]
    fn a_root_that_cannot_be_read_does_not_outrank_one_under_real_pressure() {
        let (at, _) = pick(vec![
            (
                PathBuf::from("/unreadable"),
                Reading::Refused("statvfs said no".to_string()),
            ),
            (PathBuf::from("/filling"), with_free(5)),
        ]);
        assert_eq!(
            at,
            PathBuf::from("/filling"),
            "a measured failure is the one to put in front of an operator, not the guess beside it"
        );
    }

    #[test]
    fn reading_no_roots_at_all_refuses_rather_than_reporting_clear() {
        let (_, reading) = pick(Vec::new());
        assert!(
            matches!(reading.verdict(), Verdict::Unmeasurable(_)),
            "a box nothing looked at is not a box with room: {:?}",
            reading.verdict()
        );
    }

    #[test]
    fn a_second_root_that_is_also_short_is_carried_beside_the_headline() {
        let taken = surveyed(vec![
            (PathBuf::from("/configured"), with_free(4)),
            (PathBuf::from("/tmp"), with_free(5)),
        ]);
        assert_eq!(taken.at, PathBuf::from("/configured"));
        assert_eq!(
            taken.beside,
            vec![(PathBuf::from("/tmp"), with_free(5))],
            "ranking one root above another does not make the second one's pressure go away"
        );
    }

    #[test]
    fn a_clear_root_is_not_carried_beside_the_headline() {
        let taken = surveyed(vec![
            (PathBuf::from("/filling"), with_free(4)),
            (PathBuf::from("/roomy"), with_free(90)),
        ]);
        assert!(
            taken.beside.is_empty(),
            "a root with room is not a second thing to go and clear: {:?}",
            taken.beside
        );
    }

    #[test]
    fn the_line_names_every_root_that_is_also_short() {
        let taken = surveyed(vec![
            (PathBuf::from("/configured"), with_free(4)),
            (PathBuf::from("/tmp"), with_free(5)),
        ]);
        let line = said(
            &taken.at,
            &taken.reading,
            &Report::Entered(taken.reading.verdict()),
            &taken.beside,
        );
        assert!(line.contains("/configured"), "{line}");
        assert!(
            line.contains("/tmp"),
            "an operator told only the worst root cleans it and learns about the other one five \
             minutes later: {line}"
        );
        assert!(
            line.contains("Also short"),
            "the second root has to read as a second thing to go and do: {line}"
        );
    }

    #[test]
    fn a_line_with_nothing_else_short_says_nothing_about_other_roots() {
        let taken = surveyed(vec![
            (PathBuf::from("/filling"), with_free(4)),
            (PathBuf::from("/roomy"), with_free(90)),
        ]);
        let line = said(
            &taken.at,
            &taken.reading,
            &Report::Entered(taken.reading.verdict()),
            &taken.beside,
        );
        assert!(
            !line.contains("Also short"),
            "a box with one pressure must not read as a box with two: {line}"
        );
    }
}
