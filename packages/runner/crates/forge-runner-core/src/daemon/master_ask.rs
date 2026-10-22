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

use std::collections::HashMap;
use std::time::{Duration, Instant};

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

#[derive(Debug, Clone, Copy)]
struct Clock {
    /// When this project's master was last asked or seen working, or when its
    /// work was first seen if neither has happened since.
    since: Instant,
    /// When the journal last said this project was unasked.
    said: Option<Instant>,
}

/// Per project, how long admissible work has stood unasked, and the last error
/// its admissible read failed on.
#[derive(Debug, Default)]
pub(crate) struct AskClocks {
    clocks: HashMap<String, Clock>,
    unread: HashMap<String, String>,
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

    #[cfg(test)]
    pub(crate) fn since(&self, project_id: &str) -> Option<Instant> {
        self.clocks.get(project_id).map(|c| c.since)
    }
}

/// The journal line for a project whose admissible work has stood unasked.
pub(crate) fn unasked_line(slug: &str, pane: &str, waiting: usize, waited: Duration) -> String {
    format!(
        "[master] {slug}: {waiting} admissible issue(s) and {pane} has been neither asked nor seen working for {}m — this box asks an idle master at least every {}m, so something stands between it and the pane; `forge-runner master status {slug}` says what",
        waited.as_secs() / 60,
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

    #[test]
    fn the_unasked_line_names_project_pane_count_and_age() {
        let line = unasked_line("pixelight", "forge-master-pixelight", 1, UNASKED_AFTER);
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

    #[test]
    fn the_floor_sits_above_the_refresh_window_and_the_report_above_the_floor() {
        assert!(ASK_FLOOR > NUDGE_REFRESH);
        assert!(UNASKED_AFTER > ASK_FLOOR);
    }
}
