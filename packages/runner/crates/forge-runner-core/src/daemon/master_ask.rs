/*
 * Whether a project holding admissible work is being asked about it.
 *
 * Every sweep visits every project this box serves, so being swept is never
 * what a project lacks. What it can lack is being ASKED: a master whose last
 * turn ran over work that has not changed is not nudged again by the change
 * rule, and a pane that cannot be typed into is not nudged at all. The floor
 * bounds the first, and the unasked clock here is what makes the second a line
 * in the journal instead of an absence only a person counting nudges finds
 * (ISS-1306).
 */

use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

use super::agent_activity::{Activity, Doing};
use super::master::NUDGE_REFRESH;

/// The longest an idle master is left unasked while the same admissible work
/// stands. ISS-1100 withdrew the five-minute re-ask because blocked work cost a
/// pass per window; core now filters blocked work out, and what is left is
/// work a master is meant to take, so it is asked again at this floor.
pub(crate) const ASK_FLOOR: Duration = Duration::from_secs(30 * 60);

/// How long a project with admissible work may go without its master being
/// asked or seen working before the journal says so: the floor, plus one
/// retry window for the nudge the floor owed to land.
pub(crate) const UNASKED_AFTER: Duration =
    Duration::from_secs(ASK_FLOOR.as_secs() + NUDGE_REFRESH.as_secs());

/// Since when a child has been read absent, and the sweep that last read it.
#[derive(Debug, Clone, Copy)]
struct Absence {
    since: Instant,
    sweep: u64,
}

#[derive(Debug, Clone, Copy)]
struct Clock {
    /// When this project's master was last asked or seen working, or when its
    /// work was first seen if neither has happened since.
    since: Instant,
    /// When the journal last said this project was unasked.
    said: Option<Instant>,
}

/// Per project, how long admissible work has stood unasked, the last error its
/// admissible read failed on, and what this box has read of its master's
/// dispatched runs.
#[derive(Debug, Default)]
pub(crate) struct AskClocks {
    clocks: HashMap<String, Clock>,
    unread: HashMap<String, String>,
    /// Per project, per child agent id, since when every sweep has read that
    /// child with no process in its worktree.
    absent: HashMap<String, HashMap<String, Absence>>,
    /// Per project, the children already said to have stopped counting.
    lost_said: HashMap<String, BTreeSet<String>>,
    /// Which sweep this is, so a child's absence runs unbroken only across
    /// sweeps that each read it.
    sweep: u64,
}

impl AskClocks {
    /// The master was just asked: a nudge reached its pane, or a placement's
    /// brief did.
    pub(crate) fn asked(&mut self, project_id: &str, now: Instant) {
        self.clocks.insert(
            project_id.to_string(),
            Clock {
                since: now,
                said: None,
            },
        );
    }

    /// One sweep's read of a project whose admissible set it read: whether it
    /// holds work, and whether its master is seen working. Answers how long the
    /// work has stood unasked where that is worth a journal line now.
    pub(crate) fn note(
        &mut self,
        project_id: &str,
        work: bool,
        working: bool,
        now: Instant,
    ) -> Option<Duration> {
        if !work {
            self.clocks.remove(project_id);
            return None;
        }
        if working {
            self.asked(project_id, now);
            return None;
        }
        let clock = self.clocks.entry(project_id.to_string()).or_insert(Clock {
            since: now,
            said: None,
        });
        let waited = now.saturating_duration_since(clock.since);
        if waited < UNASKED_AFTER {
            return None;
        }
        let due = clock
            .said
            .is_none_or(|said| now.saturating_duration_since(said) >= ASK_FLOOR);
        if !due {
            return None;
        }
        clock.said = Some(now);
        Some(waited)
    }

    /// A failed admissible read, and whether it is news: a different error, or
    /// the first since a good read.
    pub(crate) fn read_failed(&mut self, project_id: &str, error: &str) -> bool {
        let news = self.unread.get(project_id).map(String::as_str) != Some(error);
        if news {
            self.unread
                .insert(project_id.to_string(), error.to_string());
        }
        news
    }

    /// The admissible read answered; the next failure is news again.
    pub(crate) fn read_ok(&mut self, project_id: &str) {
        self.unread.remove(project_id);
    }

    /// A sweep begins. A child not read on it, whatever the reason — a failed
    /// admissible read, a drain, a stand-down — breaks its run of absence,
    /// because absence nobody observed is not absence.
    pub(crate) fn new_sweep(&mut self) {
        self.sweep += 1;
    }

    /// One sweep's reading of the master's children, by agent id: `Some(true)`
    /// where the child's worktree was read holding no process (or no open run
    /// names it), `Some(false)` where a process stands there, `None` where it
    /// could not be read. Answers how long each child has been read absent
    /// on an unbroken run of sweeps; a resident, an unread reading or a sweep
    /// that did not read it starts it again, and a child no longer listed is
    /// forgotten. A sweep may read a child twice; both readings are its own.
    pub(crate) fn absent_for(
        &mut self,
        project_id: &str,
        read: &[(String, Option<bool>)],
        now: Instant,
    ) -> HashMap<String, Duration> {
        let had = self.absent.remove(project_id).unwrap_or_default();
        let mut kept = HashMap::new();
        let mut out = HashMap::new();
        for (agent, absent) in read {
            if *absent != Some(true) {
                continue;
            }
            let sweep = self.sweep;
            let since = had
                .get(agent)
                .filter(|a| a.sweep + 1 >= sweep)
                .map_or(now, |a| a.since);
            kept.insert(agent.clone(), Absence { since, sweep });
            out.insert(agent.clone(), now.saturating_duration_since(since));
        }
        if !kept.is_empty() {
            self.absent.insert(project_id.to_string(), kept);
        }
        out
    }

    /// The children of this project's master that stopped counting this sweep
    /// and have not been said to: each is said once while it stays lost, and
    /// one that counts again is said again if it is lost again.
    pub(crate) fn lost_news(&mut self, project_id: &str, lost: &[String]) -> Vec<String> {
        let said = self.lost_said.remove(project_id).unwrap_or_default();
        let news = lost
            .iter()
            .filter(|id| !said.contains(*id))
            .cloned()
            .collect();
        let now: BTreeSet<String> = lost.iter().cloned().collect();
        if !now.is_empty() {
            self.lost_said.insert(project_id.to_string(), now);
        }
        news
    }

    #[cfg(test)]
    pub(crate) fn since(&self, project_id: &str) -> Option<Instant> {
        self.clocks.get(project_id).map(|c| c.since)
    }
}

/// What this box last read of a master, at the moment its work is said to
/// stand unasked: the reason a reader opens the pane for, said in the line
/// itself, because nothing else this box offers reads a permission question
/// back (ISS-1306 round 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Seen {
    /// No master pane is placed for the project.
    NoPane,
    /// The pane's session has reported nothing to this box's hooks.
    Unreported,
    /// Stopped on a question only a person can answer; `ago` since its hooks
    /// last reported.
    Permission { ago: Duration },
    /// Reported, and no turn has begun in it.
    NoTurn { ago: Duration },
    /// Its last turn ended.
    Ended { ago: Duration },
    /// Its last turn ended on an API or model error.
    Failed { ago: Duration },
    /// Its hooks read it as working. The warning is never written for one,
    /// which restarts the clock; it is here so the reading is total.
    Working { ago: Duration },
}

impl Seen {
    /// `placed` is whether this box holds a master for the project, `seen`
    /// what that master's own hooks report as counted (`master_children`),
    /// `now_ms` wall-clock ms.
    pub(crate) fn of(placed: bool, seen: Option<&Activity>, now_ms: i64) -> Self {
        if !placed {
            return Seen::NoPane;
        }
        let Some(a) = seen else {
            return Seen::Unreported;
        };
        let ago = Duration::from_millis(now_ms.saturating_sub(a.last_event_at).max(0) as u64);
        match a.doing() {
            Doing::AwaitingPermission => Seen::Permission { ago },
            Doing::Working | Doing::AwaitingChildren => Seen::Working { ago },
            Doing::Idle if a.prompts == 0 => Seen::NoTurn { ago },
            Doing::Idle if a.turn_ended_failed => Seen::Failed { ago },
            Doing::Idle => Seen::Ended { ago },
        }
    }

    fn said(self) -> String {
        let m = |d: Duration| d.as_secs() / 60;
        match self {
            Seen::NoPane => "no master pane is placed for it on this box, and the line this box wrote when it did not place one says why".to_string(),
            Seen::Unreported => "its session has reported nothing to this box's hooks, so whether a turn ever ran there is not known here".to_string(),
            Seen::Permission { ago } => format!(
                "it is stopped on a question only a person can answer, which its hooks last reported {}m ago, and the ask floor never types into a pane waiting on one; answer it in the pane",
                m(ago)
            ),
            Seen::NoTurn { ago } => format!(
                "its session has begun no turn, and its hooks last reported {}m ago",
                m(ago)
            ),
            Seen::Ended { ago } => format!(
                "its last turn ended, its hooks last reported {}m ago, and nothing this box typed has reached it since",
                m(ago)
            ),
            Seen::Failed { ago } => format!(
                "its last turn ended on an API or model error, which its hooks reported {}m ago",
                m(ago)
            ),
            Seen::Working { ago } => format!(
                "its hooks last reported it working {}m ago",
                m(ago)
            ),
        }
    }
}

/// The journal line for a project whose admissible work has stood unasked.
/// `attach` is the command that opens the master's pane on the tmux server
/// master panes run on (`terminal::attach_command`).
pub(crate) fn unasked_line(
    slug: &str,
    pane: &str,
    waiting: usize,
    waited: Duration,
    seen: Seen,
    attach: &str,
) -> String {
    let open = match seen {
        Seen::NoPane => format!("once one is placed, `{attach}` opens it"),
        _ => format!("`{attach}` opens it"),
    };
    format!(
        "[master] {slug}: {waiting} admissible issue(s) and {pane} has been neither asked nor seen working for {}m — {}. This box asks an idle master at least every {}m, so something stands between it and the pane; {open}",
        waited.as_secs() / 60,
        seen.said(),
        ASK_FLOOR.as_secs() / 60,
    )
}

/// The journal line for a project whose admissible read failed.
pub(crate) fn unread_line(slug: &str, error: &str) -> String {
    format!(
        "[master] {slug}: cannot read its admissible work ({error}) — this sweep neither asks nor retires its master and treats the work as unknown, not as none; said once per distinct error"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ago(now: Instant, d: Duration) -> Instant {
        now.checked_sub(d).expect("clock older than the window")
    }

    #[test]
    fn work_unasked_past_the_threshold_is_said() {
        let now = Instant::now();
        let mut c = AskClocks::default();
        assert_eq!(c.note("p", true, false, ago(now, UNASKED_AFTER)), None);
        assert_eq!(
            c.note("p", true, false, now),
            Some(UNASKED_AFTER),
            "work first seen UNASKED_AFTER ago with no ask since is reported"
        );
    }

    #[test]
    fn work_unasked_inside_the_threshold_is_not_said() {
        let now = Instant::now();
        let mut c = AskClocks::default();
        let start = ago(now, UNASKED_AFTER - Duration::from_secs(1));
        assert_eq!(c.note("p", true, false, start), None);
        assert_eq!(c.note("p", true, false, now), None);
    }

    #[test]
    fn the_line_repeats_each_floor_while_it_holds_and_not_between() {
        let now = Instant::now();
        let mut c = AskClocks::default();
        let start = ago(now, UNASKED_AFTER + ASK_FLOOR);
        c.note("p", true, false, start);
        let first = start + UNASKED_AFTER;
        assert!(c.note("p", true, false, first).is_some());
        assert_eq!(
            c.note("p", true, false, first + ASK_FLOOR - Duration::from_secs(1)),
            None,
            "said once per floor, not every sweep"
        );
        assert_eq!(
            c.note("p", true, false, first + ASK_FLOOR),
            Some(UNASKED_AFTER + ASK_FLOOR)
        );
    }

    #[test]
    fn an_ask_restarts_the_clock() {
        let now = Instant::now();
        let mut c = AskClocks::default();
        c.note("p", true, false, ago(now, UNASKED_AFTER * 2));
        c.asked("p", ago(now, Duration::from_secs(60)));
        assert_eq!(c.note("p", true, false, now), None);
    }

    #[test]
    fn a_master_seen_working_is_not_unasked() {
        let now = Instant::now();
        let mut c = AskClocks::default();
        c.note("p", true, false, ago(now, UNASKED_AFTER * 2));
        assert_eq!(c.note("p", true, true, now), None);
        assert_eq!(c.since("p"), Some(now), "working restarts the clock");
    }

    #[test]
    fn no_work_clears_the_clock_and_says_nothing() {
        let now = Instant::now();
        let mut c = AskClocks::default();
        c.note("p", true, false, ago(now, UNASKED_AFTER * 2));
        assert_eq!(c.note("p", false, false, now), None);
        assert_eq!(c.since("p"), None);
        assert_eq!(
            c.note("p", true, false, now),
            None,
            "work that comes back starts a fresh clock"
        );
    }

    #[test]
    fn one_project_unasked_says_nothing_about_another() {
        let now = Instant::now();
        let mut c = AskClocks::default();
        c.note("a", true, false, ago(now, UNASKED_AFTER));
        c.note("b", true, false, now);
        assert!(c.note("a", true, false, now).is_some());
        assert_eq!(c.note("b", true, false, now), None);
    }

    #[test]
    fn a_failed_read_is_said_once_per_distinct_error() {
        let mut c = AskClocks::default();
        assert!(c.read_failed("p", "admissible request: cut"));
        assert!(!c.read_failed("p", "admissible request: cut"));
        assert!(c.read_failed("p", "admissible 500"));
        c.read_ok("p");
        assert!(
            c.read_failed("p", "admissible 500"),
            "the first failure after a good read is news"
        );
    }

    const ATTACH: &str =
        "tmux -S /home/op/.config/forge-runner/tmux.sock attach -t forge-master-pixelight";

    fn line(seen: Seen) -> String {
        unasked_line(
            "pixelight",
            "forge-master-pixelight",
            1,
            UNASKED_AFTER,
            seen,
            ATTACH,
        )
    }

    #[test]
    fn the_unasked_line_names_project_pane_count_and_age() {
        let line = line(Seen::Ended {
            ago: Duration::from_secs(40 * 60),
        });
        for part in [
            "pixelight:",
            "forge-master-pixelight",
            "1 admissible issue(s)",
            "35m",
            "every 30m",
        ] {
            assert!(line.contains(part), "{part} missing from: {line}");
        }
    }

    /// Round 2, criteria 11 and 12: the line says what was read, and for a
    /// permission question that it is one and how long ago it was reported.
    #[test]
    fn the_unasked_line_says_what_it_found() {
        let ago = Duration::from_secs(52 * 60);
        for (seen, part) in [
            (Seen::NoPane, "no master pane is placed"),
            (Seen::Unreported, "reported nothing to this box's hooks"),
            (
                Seen::Permission { ago },
                "stopped on a question only a person can answer, which its hooks last reported 52m ago",
            ),
            (Seen::NoTurn { ago }, "has begun no turn"),
            (Seen::Ended { ago }, "its last turn ended, its hooks last reported 52m ago"),
            (Seen::Failed { ago }, "ended on an API or model error"),
        ] {
            let said = line(seen);
            assert!(said.contains(part), "{seen:?}: {part} missing from: {said}");
        }
    }

    /// Round 2, criteria 13 and 14: the line opens the pane, and names no
    /// command that cannot say why it stands.
    #[test]
    fn the_unasked_line_gives_the_attach_command_and_not_master_status() {
        for seen in [
            Seen::NoPane,
            Seen::Unreported,
            Seen::Permission {
                ago: Duration::ZERO,
            },
            Seen::Ended {
                ago: Duration::ZERO,
            },
        ] {
            let said = line(seen);
            assert!(said.contains(&format!("`{ATTACH}`")), "{said}");
            assert!(!said.contains("master status"), "{said}");
        }
    }

    fn activity(
        events: &[(super::super::agent_activity::Event, Option<&str>)],
        at: i64,
    ) -> Activity {
        let all = super::super::agent_activity::Activities::new();
        let mut last = None;
        for (event, subject) in events {
            last = Some(all.record(
                "s",
                super::super::agent_activity::Report {
                    event: *event,
                    at,
                    subject: *subject,
                    conversation: None,
                    transcript: None,
                },
            ));
        }
        last.expect("at least one event")
    }

    #[test]
    fn seen_reads_the_masters_own_report() {
        use super::super::agent_activity::Event;
        let now = 10_000_000;
        let at = now - 7 * 60_000;
        let ago = Duration::from_secs(7 * 60);
        assert_eq!(Seen::of(false, None, now), Seen::NoPane);
        assert_eq!(Seen::of(true, None, now), Seen::Unreported);
        let asked = activity(
            &[
                (Event::PromptSubmitted, None),
                (Event::PermissionRequested, None),
            ],
            at,
        );
        assert_eq!(Seen::of(true, Some(&asked), now), Seen::Permission { ago });
        let ended = activity(
            &[(Event::PromptSubmitted, None), (Event::Stopped, None)],
            at,
        );
        assert_eq!(Seen::of(true, Some(&ended), now), Seen::Ended { ago });
        let failed = activity(
            &[(Event::PromptSubmitted, None), (Event::StoppedFailed, None)],
            at,
        );
        assert_eq!(Seen::of(true, Some(&failed), now), Seen::Failed { ago });
        let never = activity(&[(Event::Stopped, None)], at);
        assert_eq!(Seen::of(true, Some(&never), now), Seen::NoTurn { ago });
    }

    /// Round 2, criteria 16 and 18 (the clock half): absence is observed on
    /// an unbroken run of sweeps, and a resident or an unread reading starts
    /// it again.
    #[test]
    fn absence_is_the_unbroken_run_of_absent_readings() {
        let now = Instant::now();
        let t0 = ago(now, ASK_FLOOR * 2);
        let mut c = AskClocks::default();
        let read = |absent: Option<bool>| vec![("a1".to_string(), absent)];
        assert_eq!(
            c.absent_for("p", &read(Some(true)), t0).get("a1"),
            Some(&Duration::ZERO)
        );
        c.new_sweep();
        assert_eq!(
            c.absent_for("p", &read(Some(true)), t0 + ASK_FLOOR)
                .get("a1"),
            Some(&ASK_FLOOR)
        );
        c.new_sweep();
        assert_eq!(
            c.absent_for("p", &read(Some(false)), t0 + ASK_FLOOR)
                .get("a1"),
            None,
            "a resident ends the absence"
        );
        c.new_sweep();
        assert_eq!(
            c.absent_for("p", &read(Some(true)), now).get("a1"),
            Some(&Duration::ZERO),
            "and it starts again from the next absent reading"
        );
        c.new_sweep();
        assert!(
            c.absent_for("p", &read(None), now).is_empty(),
            "an unread reading is no absence"
        );
        c.new_sweep();
        assert_eq!(
            c.absent_for("p", &read(Some(true)), now + Duration::from_secs(30))
                .get("a1"),
            Some(&Duration::ZERO),
            "the unread reading broke the run"
        );
        assert!(
            c.absent_for("p", &[], now).is_empty(),
            "a child no longer listed is forgotten"
        );
    }

    /// Whole-set reads F1: a sweep that never looked at the child (a failed
    /// admissible read skips the rest of the project's iteration) breaks the
    /// run of absence, however soon the next reading comes.
    #[test]
    fn absence_nobody_observed_is_not_absence() {
        let now = Instant::now();
        let t0 = ago(now, ASK_FLOOR * 2);
        let read = vec![("a1".to_string(), Some(true))];
        let mut skipping = AskClocks::default();
        let mut at = t0;
        while at < t0 + ASK_FLOOR * 2 {
            skipping.new_sweep();
            assert_eq!(
                skipping.absent_for("p", &read, at).get("a1"),
                Some(&Duration::ZERO),
                "every other sweep did not read it"
            );
            skipping.new_sweep();
            assert!(skipping.read_failed("p", "admissible 503"));
            skipping.read_ok("p");
            at += Duration::from_secs(60);
        }
        let mut steady = AskClocks::default();
        let mut at = t0;
        while at <= t0 + ASK_FLOOR {
            steady.new_sweep();
            steady.absent_for("p", &read, at);
            steady.absent_for("p", &read, at);
            at += Duration::from_secs(30);
        }
        steady.new_sweep();
        assert!(
            steady.absent_for("p", &read, at)["a1"] >= ASK_FLOOR,
            "a reading on every sweep, twice in some, is one unbroken run"
        );
    }

    #[test]
    fn a_lost_child_is_said_once_while_it_stays_lost() {
        let mut c = AskClocks::default();
        let one = vec!["a1".to_string()];
        assert_eq!(c.lost_news("p", &one), one);
        assert!(c.lost_news("p", &one).is_empty());
        assert!(c.lost_news("p", &[]).is_empty());
        assert_eq!(c.lost_news("p", &one), one, "lost again is news again");
    }

    #[test]
    fn the_floor_sits_above_the_refresh_window_and_the_report_above_the_floor() {
        assert!(ASK_FLOOR > NUDGE_REFRESH);
        assert!(UNASKED_AFTER > ASK_FLOOR);
    }
}
