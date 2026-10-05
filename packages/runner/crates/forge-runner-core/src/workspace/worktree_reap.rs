//! Reaping the agent worktrees nothing else removes.
//!
//! Two directories, from two different conventions, and nothing used to remove
//! either: `<repo>/.claude/worktrees/<slug>` is Claude Code's own, and
//! `<repo>/.worktrees/<branch>` is where the retired job pool cut one, which
//! boxes that ran it still hold. They accumulate for the life of the box.
//!
//! A liveness problem rather than tidiness: a full disk fails every job on the
//! box (ubuntu6, 2026-08-20).
//!
//! The predicate is deliberately timid — this deletes work, and a wrong
//! judgement here is unrecoverable. A worktree is reaped only when all four
//! hold: no run in the ledger still holds it, it is older than `MIN_AGE`, it
//! has no commit the remote lacks, and nothing in it is unsaved — a modified
//! tracked file, or a file git has never been told about. Files `.gitignore`
//! claims protect nothing, which is what keeps build output from pinning a
//! checkout forever.
//!
//! The ledger is first among those because the other three are all SHAPE, and
//! a well-behaved park has exactly the shape of an abandoned tree (ISS-964
//! criteria 25, 36).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};

use tokio::process::Command;

use crate::error::Result;
use crate::runner::ledger::Ledger;
use crate::workspace::worktree::{kind_at, Kind};
use crate::workspace::worktree_processes::{
    residents_of, Clearing, Loud, Reading, Resident, Say, Verdict,
};

pub const MIN_AGE: Duration = Duration::from_secs(14 * 24 * 3600);

const WORKTREE_ROOTS: [&str; 2] = [".claude/worktrees", ".worktrees"];

/// How long the sweep waits after a tick that read the ledger.
pub const SWEEP_PERIOD: Duration = Duration::from_secs(6 * 3600);

/// How long it waits after the first tick that could not.
pub const FIRST_RETRY: Duration = Duration::from_secs(60);

/// The sweep's clock, and what a tick that could not read the ledger does to it.
///
/// This sweep is the only thing that removes a finished run's checkout, so a
/// tick it cannot take is disk that nothing reclaims until the next one — and
/// the next one is six hours away. A ledger that was unreadable for the length
/// of one `ALTER` therefore cost a whole period, in a warning nobody reads
/// (ISS-1201).
///
/// So an outage is said once, at error, and retried a minute later rather than
/// a period later; and while it lasts the wait doubles up to the period, which
/// is what keeps a ledger that is broken rather than busy from printing the
/// same line every minute for ever. The end of one is said too, with how long
/// the sweep was off, because that is the number the disk answers to.
#[derive(Debug, Default)]
pub struct SweepClock {
    outage: Option<Outage>,
}

#[derive(Debug, Clone, Copy)]
struct Outage {
    began_at: std::time::Instant,
    ticks: u32,
}

/// What a tick that could not read the ledger leaves the caller to do.
#[derive(Debug, PartialEq, Eq)]
pub struct Unreadable {
    /// Whether this tick is the one that opens the outage, and so the one that
    /// reports it.
    pub announce: bool,
    /// What to wait before trying the ledger again.
    pub retry_in: Duration,
}

impl SweepClock {
    /// A tick that could not open the ledger.
    pub fn unreadable(&mut self, now: std::time::Instant) -> Unreadable {
        let outage = self.outage.get_or_insert(Outage {
            began_at: now,
            ticks: 0,
        });
        outage.ticks = outage.ticks.saturating_add(1);
        Unreadable {
            announce: outage.ticks == 1,
            retry_in: FIRST_RETRY
                .saturating_mul(2u32.saturating_pow(outage.ticks.saturating_sub(1)))
                .min(SWEEP_PERIOD),
        }
    }

    /// A tick that opened it. `Some` is an outage that has just ended, and how
    /// long the sweep was off.
    pub fn readable(&mut self, now: std::time::Instant) -> Option<Duration> {
        let outage = self.outage.take()?;
        Some(now.duration_since(outage.began_at))
    }
}

async fn git(dir: &Path, args: &[&str]) -> Option<std::process::Output> {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .await
        .ok()
}

pub async fn holds_work(wt: &Path) -> bool {
    if has_unsaved_changes(wt).await {
        return true;
    }
    match git(wt, &["log", "--oneline", "@{u}..", "-1"]).await {
        Some(out) if out.status.success() => !out.stdout.is_empty(),
        _ => !head_is_on_a_remote(wt).await,
    }
}

pub async fn has_uncommitted_changes(wt: &Path) -> bool {
    match git(wt, &["status", "--porcelain", "--untracked-files=no"]).await {
        Some(out) => !out.stdout.is_empty(),
        None => true,
    }
}

pub async fn has_unsaved_changes(wt: &Path) -> bool {
    if has_uncommitted_changes(wt).await {
        return true;
    }
    match git(wt, &["ls-files", "--others", "--exclude-standard"]).await {
        Some(out) if out.status.success() => !out.stdout.is_empty(),
        _ => true,
    }
}

async fn head_is_on_a_remote(wt: &Path) -> bool {
    matches!(
        git(wt, &["branch", "-r", "--contains", "HEAD"]).await,
        Some(out) if out.status.success() && !out.stdout.is_empty()
    )
}

fn older_than(p: &Path, age: Duration) -> bool {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .is_some_and(|d| d >= age)
}

#[derive(Debug, Default)]
pub struct HeldTrees(std::collections::HashMap<PathBuf, String>);

impl HeldTrees {
    pub fn from_ledger(ledger: &Ledger) -> Result<Self> {
        let mut held = std::collections::HashMap::new();
        for (path, run_id) in ledger.held_worktrees()? {
            if let Ok(real) = path.canonicalize() {
                held.insert(real, run_id.clone());
            }
            held.insert(path, run_id);
        }
        Ok(Self(held))
    }

    fn holder(&self, path: &Path) -> Option<&str> {
        path.canonicalize()
            .ok()
            .and_then(|real| self.0.get(&real))
            .or_else(|| self.0.get(path))
            .map(String::as_str)
    }
}

#[derive(Debug, Default)]
pub struct Reaped {
    pub removed: Vec<PathBuf>,
    /// Each tree left alone, with the run id that holds it.
    pub held: Vec<(PathBuf, String)>,
}

pub async fn reap_repo(repo: &Path, min_age: Duration, held_by: &HeldTrees) -> Reaped {
    reap_repo_clearing(repo, min_age, held_by, &Clearing::this_box()).await
}

/// Name the processes living in this repository's worktree paths that are
/// already gone.
///
/// These are past every removal's reach: their checkout went without them, so
/// nothing recorded a decision about them and no owner is left to make one.
/// They are named and never signalled — a reading that reaches them cannot tell
/// a run's own child from a stranger, and a reaper that cannot tell must refuse
/// rather than guess. Naming them is still the whole of what nothing on this
/// box does: both orphans ISS-1271 was filed over were found by a person
/// reading `/proc/<pid>/cwd` by hand, because no line anywhere names one.
fn report_the_stranded(repo: &Path, clearing: &Clearing<'_>) {
    let roots: Vec<PathBuf> = WORKTREE_ROOTS.iter().map(|r| repo.join(r)).collect();
    match clearing.stranded(&roots) {
        Reading::Read {
            residents: stranded,
            ..
        } => {
            for r in stranded {
                tracing::warn!(
                    "[worktree-reap] {r} — the checkout it was living in went without it, so this \
                     sweep can end it on nobody's terms and signals it not at all; it still holds \
                     every port and every connection it held"
                );
            }
        }
        Reading::NoTable(said) | Reading::Unreadable(said) => tracing::debug!(
            "[worktree-reap] the processes stranded in worktree paths already gone cannot be read \
             on this box ({said})"
        ),
    }
}

/// The line each stray directory was last given, for the life of this daemon.
///
/// A stray stands until a person acts, and the sweep reads it every period, so
/// a line said at every reading is the same words for days that nobody can
/// tell from a new one (ISS-1250, judge r4 item 3). It is said once, and again
/// only when what the sweep read there changes.
static STRAYS: std::sync::Mutex<std::collections::BTreeMap<PathBuf, String>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

/// What the sweep read at a stray directory, and what would end it.
///
/// The act is built from the reading, never fixed text: a line that read
/// nobody living in the directory and then asked for what lives there to be
/// ended contradicted itself (ISS-1250, judge r4 item 1). A process whose
/// working directory at this path was already deleted is not in the directory
/// standing, so removing that directory ends nothing of it, and it is named
/// apart rather than among the ones to end (judge r4 item 2).
fn stray_line(p: &Path, top: &Path, holder: Option<&str>, clearing: &Clearing<'_>) -> String {
    let named = |rs: &[&Resident]| {
        rs.iter()
            .map(|r| r.to_string())
            .collect::<Vec<_>>()
            .join("; ")
    };
    let (living, first, after) = match residents_of(clearing.proc_root, p) {
        Reading::Read {
            residents,
            not_asked,
        } => {
            let (here, deleted): (Vec<&Resident>, Vec<&Resident>) =
                residents.iter().partition(|r| !r.gone);
            // Whether the kernel refused some pids, and never how many: on a
            // shared box that count moves with every other user's processes,
            // so a line carrying it would be a new line at every sweep.
            let partial = if not_asked == 0 {
                String::new()
            } else {
                "; the processes of another user, whose working directory this box is not \
                 allowed to read, were not read"
                    .to_string()
            };
            let mut living = if here.is_empty() && not_asked == 0 {
                "no process is living in it".to_string()
            } else if here.is_empty() {
                format!("no process this box could read is living in it{partial}")
            } else {
                format!("still living in it: {}{partial}", named(&here))
            };
            if !deleted.is_empty() {
                living.push_str(&format!(
                    "; not in it, though at its path: {}",
                    named(&deleted)
                ));
            }
            let unread = "make sure no process this box could not read works in it, then ";
            let first = match (here.is_empty(), not_asked) {
                (false, n) => format!(
                    "end {}, {}",
                    here.iter()
                        .map(|r| format!("pid {}", r.pid))
                        .collect::<Vec<_>>()
                        .join(" and "),
                    if n == 0 { "then " } else { unread }
                ),
                (true, 0) => String::new(),
                (true, _) => unread.to_string(),
            };
            let after = match deleted.as_slice() {
                [] => String::new(),
                gone => format!(
                    "; removing the directory does not end {}, whose working directory was the \
                     one already deleted there — end it on its own if it is not wanted",
                    gone.iter()
                        .map(|r| format!("pid {}", r.pid))
                        .collect::<Vec<_>>()
                        .join(" or ")
                ),
            };
            (living, first, after)
        }
        Reading::NoTable(why) | Reading::Unreadable(why) => (
            format!("who is living in it could not be read ({why})"),
            "find and end whatever is living in it, which this box could not read, then "
                .to_string(),
            String::new(),
        ),
    };
    let held = holder
        .map(|run| format!(" Run {run} holds it in the ledger until it is gone."))
        .unwrap_or_default();
    format!(
        "leaving {} standing — git, asked at the path, answers for the enclosing checkout {}, so \
         whether it holds work cannot be read from it and this box will not remove it; {living}.\
         {held} To end it: once nothing in it is wanted, {first}remove the directory by hand, and \
         run `git worktree prune` in {}{after}. Said again only when this reading changes or the \
         daemon restarts.",
        p.display(),
        top.display(),
        top.display()
    )
}

/// Say a stray's line unless it is the one it was last given.
fn say_stray(p: &Path, line: String) {
    let mut said = STRAYS.lock().unwrap_or_else(|e| e.into_inner());
    if said.get(p) == Some(&line) {
        tracing::debug!(
            "[worktree-reap] {} reads as it did when last said",
            p.display()
        );
        return;
    }
    tracing::warn!("[worktree-reap] {line}");
    said.insert(p.to_path_buf(), line);
}

/// Forget every stray under this repository's roots the sweep no longer read
/// as one, so one that goes and comes back is said again.
fn forget_strays(repo: &Path, still: &[PathBuf]) {
    let roots: Vec<PathBuf> = WORKTREE_ROOTS.iter().map(|r| repo.join(r)).collect();
    STRAYS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|p, _| !roots.iter().any(|r| p.starts_with(r)) || still.contains(p));
}

/// [`reap_repo`], with the reading and the signalling supplied.
pub async fn reap_repo_clearing(
    repo: &Path,
    min_age: Duration,
    held_by: &HeldTrees,
    clearing: &Clearing<'_>,
) -> Reaped {
    report_the_stranded(repo, clearing);
    let mut removed: Vec<PathBuf> = Vec::new();
    let mut held: Vec<(PathBuf, String)> = Vec::new();
    let mut strays: Vec<PathBuf> = Vec::new();
    for root in WORKTREE_ROOTS {
        let Ok(entries) = std::fs::read_dir(repo.join(root)) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            // What is at the path is asked before anything is read off it: at a
            // directory that is no checkout's top level, git answers for the
            // checkout around it, and whether it "holds work" would be that
            // checkout's answer. Asked ahead of the ledger's hold too, so a run
            // holding it does not hide what git said (ISS-1250, judge j3).
            if let Kind::Enclosed(top) = kind_at(&p).await {
                say_stray(&p, stray_line(&p, &top, held_by.holder(&p), clearing));
                strays.push(p);
                continue;
            }
            if let Some(run_id) = held_by.holder(&p) {
                tracing::info!(
                    "[worktree-reap] keeping {} — run {run_id} still holds it in the ledger",
                    p.display()
                );
                held.push((p, run_id.to_string()));
                continue;
            }
            if !older_than(&p, min_age) || holds_work(&p).await {
                continue;
            }
            // What is living in the tree is given back before the tree is, and a
            // tree this box could not clear stays under neither count: it is
            // the only thing left naming what is running in it (ISS-1271). This
            // is ahead of BOTH routes below, because `remove_dir_all` leaves a
            // process exactly as running as git does.
            match clearing.clear(&p).await.verdict(&p) {
                Verdict::Refuse(said) => {
                    tracing::warn!("[worktree-reap] {said}");
                    continue;
                }
                // `warn` in this sweep is the stranded-process report above,
                // which is the line nothing on this box wrote before. A
                // removal that ended nothing arrives below it (ISS-1271).
                Verdict::Take(Some(Say {
                    loud: Loud::Notable,
                    said,
                })) => tracing::warn!("[worktree-reap] {said}"),
                Verdict::Take(Some(Say {
                    loud: Loud::Routine,
                    said,
                })) => tracing::info!("[worktree-reap] {said}"),
                Verdict::Take(None) => {}
            }
            // The caller prints a count, and a count is not a path. Two
            // directories went from this box with nothing in the journal naming
            // either, and what took them could not be established afterwards at
            // all (ISS-1250) — so the remover says which one it took and by
            // which of its two routes, and says what git answered when it would
            // not take one (consult 27dbdd F3).
            let refused = match git(
                repo,
                &["worktree", "remove", "--force", &p.to_string_lossy()],
            )
            .await
            {
                Some(o) if o.status.success() => None,
                Some(o) => Some(
                    String::from_utf8_lossy(&o.stderr)
                        .lines()
                        .map(str::trim)
                        .find(|l| !l.is_empty())
                        .unwrap_or("git exited non-zero and said nothing")
                        .to_string(),
                ),
                None => Some("`git worktree remove` could not be spawned".to_string()),
            };
            let Some(refusal) = refused else {
                tracing::info!(
                    "[worktree-reap] removed {} — no run in the ledger holds it, it is older than \
                     {}s, and it holds no work",
                    p.display(),
                    min_age.as_secs()
                );
                removed.push(p);
                continue;
            };
            match std::fs::remove_dir_all(&p) {
                Ok(()) if !p.exists() => {
                    tracing::warn!(
                        "[worktree-reap] git would not remove {} ({refusal}) — the directory held \
                         no work and is older than {}s, so it was removed directly and git's own \
                         registry is pruned below",
                        p.display(),
                        min_age.as_secs()
                    );
                    removed.push(p);
                }
                Ok(()) => tracing::warn!(
                    "[worktree-reap] git would not remove {} ({refusal}), and the directory is \
                     still there after removing it — it stays, and this sweep took nothing here",
                    p.display()
                ),
                Err(e) => tracing::warn!(
                    "[worktree-reap] {} stays: git would not remove it ({refusal}) and neither \
                     would the filesystem ({e})",
                    p.display()
                ),
            }
        }
    }
    if !removed.is_empty() {
        git(repo, &["worktree", "prune"]).await;
    }
    forget_strays(repo, &strays);
    Reaped { removed, held }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::runner::ledger::NewRun;

    /// The tick itself is a tokio task inside `daemon::run` with no seam a test
    /// can reach, and the thing ISS-1201 was about is exactly what that task
    /// says and at what level: the sweep went off and reported it in a `warn!`
    /// among thousands. So the source is the subject here — a level quietly put
    /// back, or a sentence that stops naming what the outage costs, goes red.
    #[test]
    fn the_tick_reports_an_unreadable_ledger_at_error_and_names_what_it_costs() {
        const DAEMON: &str = include_str!("../daemon/mod.rs");
        const SAID: &str = "[worktree-reap] the ledger will not open";

        assert!(
            !DAEMON.contains("[worktree-reap] skipped: the ledger could not be read"),
            "the line that swallowed the outage is still in the tick"
        );
        let at = DAEMON.find(SAID).expect(
            "the tick reports an unreadable ledger in words an operator can search the journal for",
        );
        let before = &DAEMON[at.saturating_sub(300)..at];
        assert!(
            before.contains("tracing::error!"),
            "a sweep that cannot run is not a warning: {before}"
        );
        assert!(
            before.contains("outage.announce"),
            "an outage is reported by the tick that opens it and not by every tick it lasts: \
             {before}"
        );
        let said = &DAEMON[at..DAEMON[at..].find(");").map_or(DAEMON.len(), |e| at + e)];
        assert!(
            said.contains("removes a finished run's checkout"),
            "the line says what the outage costs, which is the whole reason it is not a warning: \
             {said}"
        );
    }

    /// Criterion 6 and 7 together, because they are one behaviour: the outage
    /// is announced by the tick that opens it, and the wait after it is short
    /// enough that a ledger busy for a moment costs a minute rather than the
    /// six hours it cost on sid-xeon-1.
    #[test]
    fn an_outage_is_announced_once_and_retried_far_sooner_than_the_period() {
        let mut clock = SweepClock::default();
        let t0 = std::time::Instant::now();

        let first = clock.unreadable(t0);
        assert!(first.announce, "the tick that opens an outage reports it");
        assert_eq!(first.retry_in, FIRST_RETRY);
        assert!(
            first.retry_in < SWEEP_PERIOD,
            "a ledger that could not be read for a moment must not cost a whole period"
        );

        let second = clock.unreadable(t0 + FIRST_RETRY);
        assert!(
            !second.announce,
            "the same outage reported on every tick is the line among thousands this replaced"
        );
        assert_eq!(
            second.retry_in,
            FIRST_RETRY * 2,
            "and the wait grows, so a ledger that is broken rather than busy is not retried every \
             minute for ever"
        );
    }

    /// The other end of that growth: it stops at the period the sweep would
    /// have waited anyway, so an outage nobody fixes costs no more attention
    /// than the sweep did before it.
    #[test]
    fn the_wait_grows_to_the_period_and_no_further() {
        let mut clock = SweepClock::default();
        let t0 = std::time::Instant::now();
        let mut previous = Duration::ZERO;
        for tick in 0..64 {
            let waited = clock.unreadable(t0).retry_in;
            assert!(
                waited >= previous,
                "the wait may not shrink as an outage goes on: tick {tick} waited {waited:?} \
                 after {previous:?}"
            );
            assert!(
                waited <= SWEEP_PERIOD,
                "and never grows past the period: tick {tick} waited {waited:?}"
            );
            previous = waited;
        }
        assert_eq!(
            previous, SWEEP_PERIOD,
            "an outage that lasts settles on the period rather than on some larger number"
        );
    }

    /// An outage that ends says so, once, with the number the disk answers to.
    #[test]
    fn the_end_of_an_outage_carries_how_long_the_sweep_was_off() {
        let mut clock = SweepClock::default();
        let t0 = std::time::Instant::now();

        assert_eq!(
            clock.readable(t0),
            None,
            "a tick that worked after a tick that worked is not the end of anything"
        );

        clock.unreadable(t0);
        clock.unreadable(t0 + FIRST_RETRY);
        assert_eq!(
            clock.readable(t0 + Duration::from_secs(900)),
            Some(Duration::from_secs(900)),
            "the sweep was off from the first tick that failed, not from the last"
        );
        assert_eq!(
            clock.readable(t0 + Duration::from_secs(1000)),
            None,
            "and the outage that ended is not reported a second time"
        );
    }

    /// A ledger holding nothing, for the cases about the git and age predicates.
    fn led() -> HeldTrees {
        HeldTrees::default()
    }

    /// A ledger with one run holding `wt`, in whatever state the caller names.
    fn led_holding(wt: &Path, park: bool, ended: bool) -> HeldTrees {
        let mut l = Ledger::open_in_memory().unwrap();
        l.create_run_group(NewRun {
            run_id: "run-held".into(),
            project_id: "p-1".into(),
            master_session_id: "m-1".into(),
            boot_id: "boot-before-the-reboot".into(),
            worktree_path: wt.to_path_buf(),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
        if park {
            l.begin_question("q-1", "run-held", 1, "q-1").unwrap();
            l.declare_parked_human("run-held", Some("resume-1"), None)
                .unwrap();
        }
        if ended {
            l.end_run("run-held", "operator", "abandoned").unwrap();
        }
        HeldTrees::from_ledger(&l).unwrap()
    }

    async fn run(dir: &Path, args: &[&str]) {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .await
            .unwrap();
    }

    /// A repo with one agent worktree. `NOW` as `min_age` isolates the git
    /// predicates from the age gate, which its own test covers.
    /// The runner's own lane, `.worktrees/<branch>` — unswept until 2026-09-05
    /// and unbounded since the master began naming its own agents.
    #[tokio::test]
    async fn reaps_the_runners_own_worktree_lane_too() {
        let (repo, _wt) = repo_with_worktree_in("runner-lane", WORKTREE_ROOTS[1]).await;
        let removed = reap_repo(&repo, NOW, &led()).await.removed;
        assert_eq!(removed.len(), 1, "{removed:?}");
        assert!(
            removed[0]
                .components()
                .any(|c| c.as_os_str() == std::ffi::OsStr::new(WORKTREE_ROOTS[1])),
            "{removed:?}"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn refuses_a_clean_pushed_silent_tree_a_park_still_holds() {
        let (repo, wt) = repo_with_worktree("parked").await;
        let swept = reap_repo(&repo, NOW, &led_holding(&wt, true, false)).await;

        assert!(swept.removed.is_empty(), "{swept:?}");
        assert!(wt.exists());
        assert_eq!(
            swept
                .held
                .iter()
                .map(|(_, r)| r.as_str())
                .collect::<Vec<_>>(),
            vec!["run-held"],
            "{swept:?}"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn holds_a_park_the_ledger_recorded_under_a_different_spelling() {
        let (repo, wt) = repo_with_worktree("spelling").await;
        let link = repo.with_extension("served");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&repo, &link).unwrap();
        let served = link.join(WORKTREE_ROOTS[0]).join("iss-spelling");
        assert_ne!(served, wt, "the two spellings must differ as strings");

        let swept = reap_repo(&repo, NOW, &led_holding(&served, true, false)).await;

        assert!(swept.removed.is_empty(), "{swept:?}");
        assert!(wt.exists());
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn holds_a_park_when_the_sweep_is_the_one_walking_a_symlink() {
        let (repo, wt) = repo_with_worktree("bound").await;
        let link = repo.with_extension("bound-link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&repo, &link).unwrap();

        let swept = reap_repo(&link, NOW, &led_holding(&wt, true, false)).await;

        assert!(swept.removed.is_empty(), "{swept:?}");
        assert!(wt.exists());
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn holds_a_park_that_outlived_the_boot_it_was_made_in() {
        let (repo, wt) = repo_with_worktree("rebooted").await;
        let held = led_holding(&wt, true, false);
        assert_eq!(held.holder(&wt), Some("run-held"));

        let swept = reap_repo(&repo, NOW, &held).await;
        assert!(swept.removed.is_empty(), "{swept:?}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn holds_a_tree_a_live_run_is_working_in() {
        let (repo, wt) = repo_with_worktree("live-run").await;
        let swept = reap_repo(&repo, NOW, &led_holding(&wt, false, false)).await;

        assert!(swept.removed.is_empty(), "{swept:?}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn reaps_a_tree_whose_run_has_ended() {
        let (repo, wt) = repo_with_worktree("ended").await;
        let swept = reap_repo(&repo, NOW, &led_holding(&wt, true, true)).await;

        assert_eq!(swept.removed.len(), 1, "{swept:?}");
        assert!(swept.held.is_empty(), "{swept:?}");
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn a_hold_on_another_tree_shields_nothing() {
        let (repo, wt) = repo_with_worktree("unrelated").await;
        let swept = reap_repo(
            &repo,
            NOW,
            &led_holding(Path::new("/somewhere/else"), true, false),
        )
        .await;

        assert_eq!(swept.removed.len(), 1, "{swept:?}");
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    async fn repo_with_worktree(tag: &str) -> (crate::test_scratch::InScratch, PathBuf) {
        repo_with_worktree_in(tag, WORKTREE_ROOTS[0]).await
    }

    async fn repo_with_worktree_in(
        tag: &str,
        root: &str,
    ) -> (crate::test_scratch::InScratch, PathBuf) {
        repo_with_worktree_pushed(tag, root, true).await
    }

    /// The repo sits one level inside its scratch so the bare remote beside it
    /// (`repo.with_extension("remote.git")`) goes with the scratch too.
    async fn repo_with_worktree_pushed(
        tag: &str,
        root: &str,
        push: bool,
    ) -> (crate::test_scratch::InScratch, PathBuf) {
        let repo = crate::test_scratch::Scratch::new(&format!("wt-reap-{tag}")).at("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-b", "main"]).await;
        run(&repo, &["config", "user.email", "t@t"]).await;
        run(&repo, &["config", "user.name", "t"]).await;
        std::fs::write(repo.join("f.txt"), "one").unwrap();
        run(&repo, &["add", "."]).await;
        run(&repo, &["commit", "-m", "init"]).await;
        // A bare remote so `@{u}` resolves: on the fleet the agent pushes its
        // ISS-* branch, and a worktree with no upstream is spared by design.
        let remote = repo.with_extension("remote.git");
        let _ = std::fs::remove_dir_all(&remote);
        std::fs::create_dir_all(&remote).unwrap();
        run(&remote, &["init", "--bare", "-b", "main"]).await;
        run(
            &repo,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        )
        .await;
        run(&repo, &["push", "-u", "origin", "main"]).await;

        let wt = repo.join(root).join(format!("iss-{tag}"));
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        run(
            &repo,
            &["worktree", "add", &wt.to_string_lossy(), "-b", tag],
        )
        .await;
        if push {
            run(&wt, &["push", "-u", "origin", tag]).await;
        }
        (repo, wt)
    }

    const NOW: Duration = Duration::ZERO;

    #[tokio::test]
    async fn reaps_a_clean_worktree() {
        let (repo, wt) = repo_with_worktree("clean").await;
        assert_eq!(reap_repo(&repo, NOW, &led()).await.removed.len(), 1);
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// A clean, pushed worktree caught partway through a recursive delete: its
    /// `.git` file is gone and its directory stands. The repository ignores
    /// what sits under the worktree roots, as the fleet's do, so git asked at
    /// the path answers with the enclosing checkout's clean, published state.
    async fn half_deleted(tag: &str) -> (crate::test_scratch::InScratch, PathBuf) {
        let (repo, wt) = repo_with_worktree(tag).await;
        let exclude = repo.join(".git/info/exclude");
        let mut ignored = std::fs::read_to_string(&exclude).unwrap_or_default();
        for root in WORKTREE_ROOTS {
            ignored.push_str(&format!("/{root}/\n"));
        }
        std::fs::write(&exclude, ignored).unwrap();
        std::fs::remove_file(wt.join(".git")).unwrap();
        (repo, wt)
    }

    /// ISS-1250 criteria 32, 33 — judge j3: whether a directory holds work was
    /// read, at a path with no `.git` of its own, off the checkout around it.
    #[test]
    fn a_directory_git_answers_for_from_the_enclosing_checkout_is_left_standing_and_named() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let (repo, wt) = rt.block_on(half_deleted("enclosed"));

        let said = crate::workspace::worktree::tests::logged_while(|| {
            let swept = rt.block_on(reap_repo(&repo, NOW, &led()));
            assert!(swept.removed.is_empty(), "{:?}", swept.removed);
        });

        assert!(wt.join("f.txt").is_file(), "the directory stands");
        assert!(
            said.contains(&wt.display().to_string()),
            "the journal names the directory: {said}"
        );
        let top = repo.canonicalize().unwrap();
        assert!(
            said.contains(&format!("enclosing checkout {}", top.display())),
            "and the checkout git answered for: {said}"
        );
    }

    #[test]
    fn a_held_directory_git_answers_for_from_the_enclosing_checkout_is_named_as_that() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let (repo, wt) = rt.block_on(half_deleted("enclosedheld"));

        let said = crate::workspace::worktree::tests::logged_while(|| {
            rt.block_on(reap_repo(&repo, NOW, &led_holding(&wt, true, false)));
        });

        assert!(wt.join("f.txt").is_file(), "the directory stands");
        let top = repo.canonicalize().unwrap();
        assert!(
            said.contains(&format!("enclosing checkout {}", top.display())),
            "a run holding it does not hide what git answered at it: {said}"
        );
    }

    /// ISS-1250 judge r4 item 3: sid-desk `judge-ISS-483` drew the same warning
    /// every sweep for days, and not one of them said what would end it.
    #[test]
    fn a_stray_directory_is_said_once_with_what_ends_it_and_again_only_when_it_comes_back() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let (repo, wt) = rt.block_on(half_deleted("enclosedonce"));
        let leaving = format!("leaving {} standing", wt.display());

        let said = crate::workspace::worktree::tests::logged_while(|| {
            for _ in 0..3 {
                rt.block_on(reap_repo(&repo, NOW, &led()));
            }
        });
        assert_eq!(
            said.matches(&leaving).count(),
            1,
            "three sweeps reading the same stray say it once: {said}"
        );
        let top = repo.canonicalize().unwrap();
        assert!(
            said.contains("remove the directory by hand")
                && said.contains(&format!("`git worktree prune` in {}", top.display())),
            "the line names what ends it: {said}"
        );

        std::fs::remove_dir_all(&wt).unwrap();
        let gone = crate::workspace::worktree::tests::logged_while(|| {
            rt.block_on(reap_repo(&repo, NOW, &led()));
        });
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join("f.txt"), "back\n").unwrap();
        let back = crate::workspace::worktree::tests::logged_while(|| {
            rt.block_on(reap_repo(&repo, NOW, &led()));
        });
        assert!(!gone.contains(&leaving), "{gone}");
        assert_eq!(
            back.matches(&leaving).count(),
            1,
            "a stray that went and came back is said again: {back}"
        );

        let held = crate::workspace::worktree::tests::logged_while(|| {
            rt.block_on(reap_repo(&repo, NOW, &led_holding(&wt, true, false)));
            rt.block_on(reap_repo(&repo, NOW, &led_holding(&wt, true, false)));
        });
        assert_eq!(
            held.matches(&leaving).count(),
            1,
            "a run coming to hold it is a changed reading, said once: {held}"
        );
        assert!(held.contains("Run run-held holds it"), "{held}");
    }

    /// ISS-1250 — the second remover on this box said nothing either.
    ///
    /// `reap_repo` prints `keeping <path>` for every tree it leaves and its
    /// caller prints only `removed N stale worktree(s)`, so a directory that
    /// went and a directory that stayed left the same evidence and the one that
    /// went left no name. `removed.len()` is not that proof: the count is
    /// exactly what was already there.
    #[test]
    fn a_reaped_worktree_is_named_in_the_journal_and_not_only_counted() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let (repo, wt) = rt.block_on(repo_with_worktree("logged"));

        let said = crate::workspace::worktree::tests::logged_while(|| {
            let swept = rt.block_on(reap_repo(&repo, NOW, &led()));
            assert_eq!(swept.removed.len(), 1, "the premise: this sweep took one");
        });
        let _ = std::fs::remove_dir_all(&repo);

        assert!(
            said.contains(&wt.display().to_string()),
            "a person reading the journal has to be able to tell which directory went: {said}"
        );
        assert!(
            said.contains("holds no work"),
            "and why it was allowed to go: {said}"
        );
    }

    /// consult 27dbdd F3 — a refused removal left nothing in the journal, so a
    /// directory git would not take read exactly like one nobody swept.
    ///
    /// A locked worktree is the shape that refuses while staying a worktree:
    /// `git worktree remove --force` will not take one, and every question the
    /// age and work predicates ask still answers, so the fallback is reached.
    #[test]
    fn a_removal_git_refuses_says_what_git_said_before_the_fallback_takes_it() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let (repo, wt) = rt.block_on(repo_with_worktree("refused"));
        // Lock it: git refuses a locked working tree by design.
        rt.block_on(run(&repo, &["worktree", "lock", &wt.to_string_lossy()]));

        let said = crate::workspace::worktree::tests::logged_while(|| {
            let swept = rt.block_on(reap_repo(&repo, NOW, &led()));
            assert_eq!(
                swept.removed.len(),
                1,
                "the fallback still takes a directory holding no work"
            );
        });
        let _ = std::fs::remove_dir_all(&repo);

        assert!(
            said.contains(&wt.display().to_string()),
            "the path has to be in the line whichever route took it: {said}"
        );
        assert!(
            said.contains("git would not remove"),
            "and a refusal that is answered by removing the directory anyway is not a silent \
             success: {said}"
        );
    }

    #[tokio::test]
    async fn spares_every_worktree_younger_than_the_gate() {
        let (repo, wt) = repo_with_worktree("fresh").await;
        assert!(reap_repo(&repo, MIN_AGE, &led()).await.removed.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn spares_a_worktree_with_a_modified_tracked_file() {
        let (repo, wt) = repo_with_worktree("dirty").await;
        std::fs::write(wt.join("f.txt"), "changed").unwrap();
        assert!(reap_repo(&repo, NOW, &led()).await.removed.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn spares_a_worktree_whose_commits_were_never_pushed() {
        let (repo, wt) = repo_with_worktree("unpushed").await;
        std::fs::write(wt.join("g.txt"), "new").unwrap();
        run(&wt, &["add", "."]).await;
        run(&wt, &["commit", "-m", "local only"]).await;
        assert!(reap_repo(&repo, NOW, &led()).await.removed.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn ignored_build_output_does_not_pin_a_worktree() {
        let (repo, wt) = repo_with_worktree("artifacts").await;
        // Written to `.git/info/exclude` rather than a committed `.gitignore`, because committing
        // one would put an unpushed commit on the branch and this test would then be spared for a
        // reason it is not about. `--exclude-standard` reads both.
        std::fs::write(repo.join(".git/info/exclude"), "node_modules/\n").unwrap();
        std::fs::create_dir_all(wt.join("node_modules")).unwrap();
        std::fs::write(wt.join("node_modules/x.js"), "built").unwrap();
        assert_eq!(reap_repo(&repo, NOW, &led()).await.removed.len(), 1);
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn spares_a_worktree_holding_an_untracked_file_the_repo_does_not_ignore() {
        let (repo, wt) = repo_with_worktree("untracked").await;
        std::fs::write(wt.join("notes.md"), "the only copy of this").unwrap();
        assert!(
            reap_repo(&repo, NOW, &led()).await.removed.is_empty(),
            "a file the repository did not call disposable is work, and this sweep deletes work irreversibly"
        );
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn a_repo_with_no_agent_worktrees_is_a_no_op() {
        let repo = crate::test_scratch::Scratch::new("wt-none");

        assert!(reap_repo(&repo, NOW, &led()).await.removed.is_empty());
        let _ = std::fs::remove_dir_all(&repo);
    }
    #[tokio::test]
    async fn reaps_a_clean_worktree_whose_branch_was_never_given_an_upstream() {
        let (repo, wt) = repo_with_worktree_pushed("noup", WORKTREE_ROOTS[0], false).await;
        assert_eq!(reap_repo(&repo, NOW, &led()).await.removed.len(), 1);
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn spares_a_worktree_with_no_upstream_carrying_a_commit_of_its_own() {
        let (repo, wt) = repo_with_worktree_pushed("noup-commit", WORKTREE_ROOTS[0], false).await;
        std::fs::write(wt.join("g.txt"), "local").unwrap();
        run(&wt, &["add", "."]).await;
        run(&wt, &["commit", "-m", "nowhere else"]).await;
        assert!(reap_repo(&repo, NOW, &led()).await.removed.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn spares_a_worktree_in_a_repo_that_has_no_remote() {
        let (repo, wt) = repo_with_worktree_pushed("noremote", WORKTREE_ROOTS[0], false).await;
        run(&repo, &["remote", "remove", "origin"]).await;
        assert!(reap_repo(&repo, NOW, &led()).await.removed.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// A hand and a process root of this test's own, so a sweep meeting a tree
    /// somebody is living in is reached without a real process being made to
    /// survive a real SIGKILL.
    /// Unix only, and named here rather than left to the platform gate to
    /// find: the fixture plants a process root, and a `cwd` entry in one is a
    /// symlink, which is an API only unix has. What it proves — that a removal
    /// refuses over a resident it could not end — is about signalling, which
    /// is unix's too.
    #[cfg(unix)]
    mod residents {
        use super::*;
        use crate::workspace::worktree_processes::{Grace, Hand, Sig};

        /// Signals nothing, dies of nothing, and remembers every pid it was
        /// asked about — so a test can assert what was NOT signalled, which is
        /// the whole claim in the stranded case.
        #[derive(Default)]
        pub(super) struct Wont {
            pub(super) sent: std::sync::Mutex<Vec<u32>>,
        }

        impl Hand for Wont {
            fn signal(&self, pid: u32, _sig: Sig) -> std::result::Result<(), String> {
                self.sent.lock().unwrap().push(pid);
                Ok(())
            }
            fn present(&self, _pid: u32) -> bool {
                true
            }
            fn identity(&self, pid: u32) -> Option<String> {
                Some(format!("proc-{pid}"))
            }
        }

        pub(super) const NO_WAIT: Grace = Grace {
            after_term: Duration::ZERO,
            after_kill: Duration::ZERO,
        };

        pub(super) fn plant(root: &Path, pid: u32, cwd: &str, cmd: &str) {
            let d = root.join(pid.to_string());
            std::fs::create_dir_all(&d).expect("a pid directory");
            std::os::unix::fs::symlink(cwd, d.join("cwd")).expect("a cwd link");
            std::fs::write(d.join("cmdline"), cmd.replace(' ', "\0")).expect("a cmdline");
            parent(root, pid, 1);
        }

        /// What `pid` runs beneath, as the process table records it.
        pub(super) fn parent(root: &Path, pid: u32, ppid: u32) {
            let d = root.join(pid.to_string());
            std::fs::create_dir_all(&d).expect("a pid directory");
            std::fs::write(d.join("status"), format!("Name:\tx\nPPid:\t{ppid}\n"))
                .expect("a status");
        }

        pub(super) use crate::workspace::worktree_processes::planted::Unaskable;

        pub(super) fn clearing<'a>(proc_root: &'a Path, hand: &'a Wont) -> Clearing<'a> {
            Clearing {
                proc_root,
                grace: NO_WAIT,
                hand,
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_tree_somebody_is_still_living_in_is_left_standing_and_taken_by_neither_route() {
        let (repo, wt) = repo_with_worktree("residents-standing").await;
        let proc = repo.join("proc-of-this-test");
        residents::plant(&proc, 909, &wt.to_string_lossy(), "next-server (v16.2.1)");

        let swept = reap_repo_clearing(
            &repo,
            NOW,
            &led(),
            &residents::clearing(&proc, &residents::Wont::default()),
        )
        .await;

        assert!(
            swept.removed.is_empty(),
            "a tree this box could not clear is not a tree it removed: {:?}",
            swept.removed
        );
        assert!(
            swept.held.is_empty(),
            "and it is not a run's held tree either — `held` is what the LEDGER says, and \
             reporting this one there would tell an operator a run still has it: {:?}",
            swept.held
        );
        assert!(
            wt.is_dir(),
            "neither `git worktree remove` nor `remove_dir_all` was reached: removing the \
             directory leaves the process exactly as running and takes the only thing naming it"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// ISS-1378 criteria 8 and 12, the issue's own case: the ledger says the
    /// run that held the tree has ended, and a gate its live agent started is
    /// still running in it. The sweep that would otherwise reap the tree
    /// leaves it standing and signals nothing.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_tree_a_live_agents_gate_is_running_in_survives_a_sweep_that_would_reap_it() {
        let (repo, wt) = repo_with_worktree("live-agent-gate").await;
        let proc = repo.join("proc-of-this-test");
        residents::plant(&proc, 909, &wt.to_string_lossy(), "node jest");
        residents::parent(&proc, 909, 908);
        residents::parent(&proc, 908, 900);
        residents::parent(&proc, 900, 1);
        std::fs::write(proc.join("900/cmdline"), "claude").unwrap();
        let hand = residents::Wont::default();

        let (log, guard) = crate::log_capture::capturing();
        let swept = reap_repo_clearing(
            &repo,
            NOW,
            &led_holding(&wt, true, true),
            &residents::clearing(&proc, &hand),
        )
        .await;
        drop(guard);
        let said = log.said();

        assert!(swept.removed.is_empty(), "{swept:?}");
        assert!(wt.is_dir(), "the live agent's tree stands");
        assert!(
            hand.sent.lock().unwrap().is_empty(),
            "nothing in it was signalled: {:?}",
            hand.sent.lock().unwrap()
        );
        assert!(
            said.contains("pid 909") && said.contains("beneath Claude Code pid 900"),
            "{said}"
        );
        assert!(said.contains("stays for the next sweep"), "{said}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// Judge r4 item 3's other stray, portal-lighthuman `ISS-71`, still had a
    /// `next-server` living in it: what the stray holds is part of the reading,
    /// so a resident arriving is a changed reading and is said.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stray_directory_is_said_again_when_a_process_is_found_living_in_it() {
        let (repo, wt) = half_deleted("enclosedresident").await;
        let proc = repo.join("proc-of-this-test");
        std::fs::create_dir_all(&proc).unwrap();
        let hand = residents::Wont::default();
        let leaving = format!("leaving {} standing", wt.display());

        let (log, guard) = crate::log_capture::capturing();
        let _ = reap_repo_clearing(&repo, NOW, &led(), &residents::clearing(&proc, &hand)).await;
        let _ = reap_repo_clearing(&repo, NOW, &led(), &residents::clearing(&proc, &hand)).await;
        residents::plant(&proc, 909, &wt.to_string_lossy(), "next-server (v16.2.1)");
        let _ = reap_repo_clearing(&repo, NOW, &led(), &residents::clearing(&proc, &hand)).await;
        drop(guard);
        let said = log.said();

        assert_eq!(
            said.matches(&leaving).count(),
            2,
            "said at the first reading and at the one that found a resident: {said}"
        );
        assert!(
            said.contains("pid 909") && said.contains("next-server"),
            "the resident is named: {said}"
        );
        assert!(
            hand.sent.lock().unwrap().is_empty(),
            "a stray's resident is named and never signalled: {:?}",
            hand.sent.lock().unwrap()
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_tree_whose_process_table_will_not_open_is_left_standing() {
        let (repo, wt) = repo_with_worktree("residents-unreadable").await;
        // A file where the root belongs: it IS there, and it will not list.
        let broken = repo.join("proc-that-will-not-open");
        std::fs::write(&broken, "not a directory").expect("a file at the root's path");

        let swept = reap_repo_clearing(
            &repo,
            NOW,
            &led(),
            &residents::clearing(&broken, &residents::Wont::default()),
        )
        .await;

        assert!(swept.removed.is_empty(), "{:?}", swept.removed);
        assert!(
            wt.is_dir(),
            "not knowing who is in a checkout is not the same as knowing nobody is"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_sweep_names_a_process_stranded_in_a_worktree_path_that_is_already_gone() {
        let (repo, _wt) = repo_with_worktree("residents-stranded").await;
        let proc = repo.join("proc-of-this-test");
        let went = repo.join(WORKTREE_ROOTS[0]).join("iss-1217-judge");
        residents::plant(
            &proc,
            1234,
            &format!("{}{}", went.display(), crate::exe::DELETED_SUFFIX),
            "chrome --headless=new",
        );

        let hand = residents::Wont::default();
        let (log, guard) = crate::log_capture::capturing();
        let _ = reap_repo_clearing(&repo, NOW, &led(), &residents::clearing(&proc, &hand)).await;
        drop(guard);
        let said = log.said();

        assert!(
            !hand.sent.lock().unwrap().contains(&1234),
            "nothing stranded is signalled: a reading that reaches it cannot tell a run's own              child from a stranger, and a reaper that cannot tell must refuse. Sent: {:?}",
            hand.sent.lock().unwrap()
        );

        assert!(
            said.contains("pid 1234") && said.contains("chrome"),
            "both orphans this was filed over were found by a person reading /proc by hand, \
             because nothing on the box names one: {said}"
        );
        assert!(
            said.contains("signals it not at all"),
            "and the line says it signalled nothing, because their checkout went without them and \
             no owner is left to decide: {said}"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// The second door onto the same defect: a sweep that took a tree nobody
    /// was living in warned about it, because the box it swept has other
    /// people's processes on it — which every shared box does.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_uneventful_sweep_removal_is_not_reported_where_a_stranded_process_is() {
        let (repo, wt) = repo_with_worktree("residents-routine").await;
        let proc = repo.join("proc-of-this-test");
        let unaskable = residents::Unaskable::at(&proc, 8123);

        let (log, guard) = crate::log_capture::capturing();
        let swept = reap_repo_clearing(
            &repo,
            NOW,
            &led(),
            &residents::clearing(&proc, &residents::Wont::default()),
        )
        .await;
        drop(guard);
        let said = log.said();

        assert!(
            swept.removed.contains(&wt),
            "nobody this box may ask about is living in it, so the sweep takes it: {swept:?}"
        );
        assert!(
            said.contains("1 pid(s) belong to another user"),
            "the fixture plants a pid this box may not ask about, and a reading that could ask \
             about it is not the shared box this is about at all: {said}"
        );
        assert!(
            !said.contains("WARN"),
            "the sweep's warnings are the processes stranded in checkouts already gone, which is \
             the line nothing on this box wrote before. A warning on every ordinary removal puts \
             a constant fact about the box in the same stream: {said}"
        );

        drop(unaskable);
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// One sweep over a planted stray and a planted process root, and what it said.
    #[cfg(unix)]
    async fn stray_said(repo: &Path, proc: &Path) -> String {
        let hand = residents::Wont::default();
        let (log, guard) = crate::log_capture::capturing();
        let _ = reap_repo_clearing(repo, NOW, &led(), &residents::clearing(proc, &hand)).await;
        drop(guard);
        assert!(
            hand.sent.lock().unwrap().is_empty(),
            "a stray's residents are named and never signalled"
        );
        log.said()
    }

    /// The part of a stray's line that says what a person does.
    #[cfg(unix)]
    fn act_of(said: &str) -> &str {
        let at = said
            .find("To end it:")
            .unwrap_or_else(|| panic!("no act: {said}"));
        let tail = &said[at..];
        &tail[..tail.find("Said again").unwrap_or(tail.len())]
    }

    /// ISS-1250 criterion 39 — judge r4 item 1: `judge-ISS-483` read "no
    /// process … is living in it" and then "end what is living in it".
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stray_nobody_is_living_in_asks_nobody_to_be_ended() {
        let (repo, _wt) = half_deleted("strayempty").await;
        let proc = repo.join("proc-of-this-test");
        std::fs::create_dir_all(&proc).unwrap();

        let said = stray_said(&repo, &proc).await;

        assert!(said.contains("no process is living in it"), "{said}");
        let act = act_of(&said);
        assert!(
            !act.contains("living") && !act.contains("pid") && !act.contains("process"),
            "a line that read nobody asks for nobody to be ended: {act}"
        );
        assert!(act.contains("remove the directory by hand"), "{act}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// ISS-1250 criteria 35, 44: the process living in the directory is the one
    /// the act names, by pid.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stray_names_the_process_living_in_it_as_the_one_to_end() {
        let (repo, wt) = half_deleted("strayliving").await;
        let proc = repo.join("proc-of-this-test");
        residents::plant(&proc, 909, &wt.to_string_lossy(), "next-server (v16.2.1)");

        let said = stray_said(&repo, &proc).await;

        assert!(said.contains("still living in it: pid 909"), "{said}");
        let act = act_of(&said);
        assert!(
            act.contains("end pid 909") && act.contains("remove the directory by hand"),
            "{act}"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// ISS-1250 criteria 40, 41, 42 — judge r4 item 2: portal-lighthuman `ISS-71`'s
    /// `next-server` works in an earlier `lh-social`, since deleted, and the
    /// line offered removing the one standing now as what ends it.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_process_in_a_deleted_directory_at_a_strays_path_is_not_offered_removal_as_its_end() {
        let (repo, wt) = half_deleted("straydeleted").await;
        let proc = repo.join("proc-of-this-test");
        residents::plant(
            &proc,
            1960566,
            &format!("{}{}", wt.display(), crate::exe::DELETED_SUFFIX),
            "next-server (v16.2.1)",
        );

        let said = stray_said(&repo, &proc).await;
        let line = said
            .lines()
            .find(|l| l.contains(&format!("leaving {} standing", wt.display())))
            .unwrap_or_else(|| panic!("no stray line: {said}"));

        assert!(
            line.contains("no process is living in it"),
            "the process is not in the directory standing: {line}"
        );
        assert!(
            line.contains("pid 1960566") && line.contains("has since been deleted"),
            "it is still named, and why it is not in this one: {line}"
        );
        assert!(!line.contains("unlinked"), "{line}");
        let act = act_of(line);
        let (offered, not) = act
            .split_once("removing the directory does not end pid 1960566")
            .unwrap_or_else(|| panic!("the act says removal does not end it: {act}"));
        assert!(
            !offered.contains("1960566"),
            "removing the directory is not offered as what ends it: {act}"
        );
        assert!(not.contains("end it on its own"), "{act}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// ISS-1250 criteria 43, 44, review 711cb47 F1: a resident read beside
    /// pids the kernel refused is named to end, and the act still says the
    /// reading was partial.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stray_read_in_part_with_a_resident_names_both_in_its_act() {
        let (repo, wt) = half_deleted("straymixed").await;
        let proc = repo.join("proc-of-this-test");
        residents::plant(&proc, 909, &wt.to_string_lossy(), "next-server (v16.2.1)");
        let unaskable = residents::Unaskable::at(&proc, 8123);

        let said = stray_said(&repo, &proc).await;
        drop(unaskable);
        let line = said
            .lines()
            .find(|l| l.contains(&format!("leaving {} standing", wt.display())))
            .unwrap_or_else(|| panic!("no stray line: {said}"));

        let act = act_of(line);
        assert!(
            act.contains("end pid 909") && act.contains("could not read works in it"),
            "a test run as root reads every pid and plants nothing: {act}"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// ISS-1250 criterion 43: a reading the kernel refused in part says so,
    /// so "no process is living in it" is never a claim about pids it could
    /// not read.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stray_whose_table_refused_some_pids_says_they_were_not_read() {
        let (repo, wt) = half_deleted("strayunasked").await;
        let proc = repo.join("proc-of-this-test");
        let unaskable = residents::Unaskable::at(&proc, 8123);

        let said = stray_said(&repo, &proc).await;
        drop(unaskable);
        let line = said
            .lines()
            .find(|l| l.contains(&format!("leaving {} standing", wt.display())))
            .unwrap_or_else(|| panic!("no stray line: {said}"));

        assert!(
            line.contains("the processes of another user") && line.contains("were not read"),
            "a test run as root reads every pid and plants nothing: {line}"
        );
        assert!(!line.contains("no process is living in it"), "{line}");
        assert!(
            act_of(line).contains("no process this box could not read works in it"),
            "the act says what it could not read: {line}"
        );
        assert!(
            !line.contains("1 pid"),
            "the count moves with every other user's processes, so carrying it would say the \
             line again at every sweep: {line}"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }
}
