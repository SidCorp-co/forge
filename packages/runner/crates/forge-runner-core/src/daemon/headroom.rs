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
/// as 0% free would put every such box permanently at `Critical` — a alarm
/// that is always on is one nobody reads.
fn free_percent(free: u64, total: u64) -> Option<u64> {
    if total == 0 {
        return None;
    }
    Some(free.saturating_mul(100) / total)
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
                "{} of {} bytes free ({}), {} of {} inodes free ({})",
                gib(room.bytes_free),
                gib(room.bytes_total),
                said_percent(room.bytes_free_percent()),
                room.inodes_free,
                room.inodes_total,
                said_percent(room.inodes_free_percent()),
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
}

impl Report {
    /// Where this belongs in the journal.
    pub fn level(&self) -> tracing::Level {
        match self {
            Self::Entered(Verdict::Critical(_)) | Self::Stands { .. } => tracing::Level::ERROR,
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
}

impl Watch {
    /// What this tick owes the journal.
    pub fn tick(&mut self, now: Instant, verdict: Verdict) -> Option<Report> {
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
            (Some(was), Verdict::Clear) if was != Verdict::Clear => {
                Some(Report::Cleared { was, stood })
            }
            _ => Some(Report::Entered(verdict)),
        }
    }
}

/// The directory a run on this box writes its scratch into.
///
/// One site, and it creates nothing: the whole of this module's business with
/// the temp directory is asking the filesystem under it how much it has left.
pub fn scratch_root() -> PathBuf {
    std::env::temp_dir()
}

/// Ask the filesystem holding `at` what it has left.
///
/// `fsblkcnt_t` and `fsfilcnt_t` are 64 bits on Linux and 32 on macOS, so the
/// widening is real on one of the two platforms this ships to and a no-op on
/// the other. Dropping it would narrow nothing and would stop compiling on the
/// platform where it widens.
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

/// The line one report goes into the journal as.
pub fn said(at: &Path, reading: &Reading, report: &Report) -> String {
    let where_and_what = format!("{}: {}", at.display(), reading.figures());
    match report {
        Report::Entered(Verdict::Clear) => {
            format!("[headroom] {where_and_what} — clear on both axes")
        }
        Report::Cleared { was, stood } => format!(
            "[headroom] {where_and_what} — clear on both axes again after {}s of {}",
            stood.as_secs(),
            crossed(was),
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
            "[headroom] {where_and_what} — {} and has stood for {}s. {COSTS}. {}",
            crossed(verdict),
            held.as_secs(),
            sweep_wont(crate::workspace::worktree_reap::MIN_AGE)
        ),
    }
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

/// An axis the filesystem states no total for is named on the line rather than
/// left off it: a figure missing from a diagnostic reads as a figure nobody
/// thought to take.
fn said_percent(percent: Option<u64>) -> String {
    percent.map_or_else(|| "no total stated".to_string(), |p| format!("{p}%"))
}

fn gib(bytes: u64) -> String {
    format!("{:.1}G", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
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
        assert_eq!(
            watch.tick(t0 + stood, Verdict::Clear),
            Some(Report::Cleared {
                was: critical,
                stood,
            })
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
            "it is not an error that a platform cannot be measured, and it is not nothing"
        );
        assert!(
            said(Path::new("/tmp"), &reading, &report).contains("is not a box that is fine"),
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
        );
        assert!(line.contains("bytes is CRITICAL"), "{line}");
        assert!(
            line.contains("inodes free (no total stated)"),
            "the axis that could not be measured is named on the line rather than left off it: \
             {line}"
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

    #[test]
    fn each_verdict_reaches_the_journal_at_the_level_its_reading_earns() {
        assert_eq!(
            Report::Entered(Verdict::Critical(Axis::Bytes)).level(),
            tracing::Level::ERROR
        );
        assert_eq!(
            Report::Entered(Verdict::Tight(Axis::Bytes)).level(),
            tracing::Level::WARN
        );
        assert_eq!(
            Report::Entered(Verdict::Clear).level(),
            tracing::Level::INFO
        );
    }

    /// The tick is a `tokio` task inside `daemon::run` with no seam a test can
    /// reach, so the source is the subject — the same shape
    /// `worktree_reap`'s own tick test takes. What goes red here is the tick
    /// losing a level, which is how a verdict earned at `ERROR` reaches the
    /// journal as one more `info!` among thousands.
    #[test]
    fn the_tick_puts_each_report_in_the_journal_at_the_level_it_earned() {
        const DAEMON: &str = include_str!("mod.rs");

        assert!(
            DAEMON.contains("headroom::read(&at)"),
            "the tick takes a reading of the filesystem the box writes scratch into"
        );
        assert!(
            DAEMON.contains("tokio::time::interval(TICK)"),
            "the tick keeps this module's own period: a reading on the sweep's six hours could \
             cross both thresholds and the ceiling between two of them"
        );
        let at = DAEMON
            .find("headroom::said(")
            .expect("the tick puts this module's own line in the journal, not one of its own");
        let after = &DAEMON[at..DAEMON.len().min(at + 600)];
        for said in ["tracing::error!", "tracing::warn!", "tracing::info!"] {
            assert!(
                after.contains(said),
                "the tick flattens {said} away, so a level this module earned never reaches the \
                 journal: {after}"
            );
        }
    }
}
