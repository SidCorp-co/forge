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

/// The verdict where it is a pressure, and nothing where it is not.
///
/// `Clear` and `Unmeasurable` are both states a box passes through without
/// anything being short, and only a short box has a pressure to clear.
fn pressure(verdict: Verdict) -> Option<Verdict> {
    match verdict {
        v @ (Verdict::Critical(_) | Verdict::Tight(_)) => Some(v),
        _ => None,
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
            if let Some(was) = self.blinding.clone().or_else(|| self.standing()) {
                return self.blinded(now, was, why.clone());
            }
        }
        // Taken rather than dropped: a clear reading arriving straight out of
        // blindness replaces the pressure that was standing, not the
        // unreadable verdict that stood in for it, and `said` holds the
        // latter (consult f45b6d F1).
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
        // A pressure that comes back from blindness unchanged never left, and
        // criterion 17 restarts the clock on a change of level or of axis
        // rather than on the box having gone quiet in between. Restarting it
        // here reported five minutes of a pressure that had stood fifteen
        // (consult 09a28d F1).
        if blinded_over.as_ref() != Some(&verdict) {
            self.since = Some(now);
        }
        match (was, &verdict) {
            // Only a pressure clears. An unreadable reading that nothing stood
            // behind is an outage ending, and reporting it as
            // `clear on both axes again after 5m: unreadable (...)` tells an
            // operator the box had been filling when it had not
            // (consult cc9900 F1).
            (Some(was), Verdict::Clear) => match blinded_over.or_else(|| pressure(was)) {
                Some(was) => Some(Report::Cleared { was, stood }),
                None => Some(Report::Entered(verdict)),
            },
            _ => Some(Report::Entered(verdict)),
        }
    }

    /// The pressure the last line reported, where it reported one.
    fn standing(&self) -> Option<Verdict> {
        pressure(self.said.clone()?)
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

#[cfg(unix)]
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
    // unit that leaves the figure at or above one (consult f45b6d F3).
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
