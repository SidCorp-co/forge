//! What on a project, or on the box, wants an operator's eye, and how loudly.
//!
//! Every finding is made from a reading the frame already holds, and names that
//! reading, so the table's one word and colour can be traced in the detail to
//! the source that earned it. A source that could not be read is a finding of
//! its own: never nothing, and never the healthy word.

use super::cli_slug::Slug;
use super::gather::{Project, Snapshot};
use super::ledger_ro::{self, short, Run};
use super::render::{self, Pane, Unnamed};
use super::skill::Skill;
use super::source::{ago, span};
use super::tree_age::TreeAge;

/// A runnable run whose worktree has gone this long unwritten is ageing.
pub const AGEING_MS: i64 = 10 * 60_000;
/// And this long, stalled.
pub const STALL_MS: i64 = 30 * 60_000;

/// How loudly a row speaks, quietest first, so the loudest is the greatest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tone {
    Dim,
    Plain,
    /// A source that could not be read: louder than fine, quieter than a
    /// finding that was read.
    Unread,
    Yellow,
    Red,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub tone: Tone,
    /// The verdict word the table shows for it: six cells at most.
    pub word: &'static str,
    pub text: String,
    /// The reading it was made from.
    pub source: String,
}

/// Every finding of one row, in the order the criteria rank them.
#[derive(Debug, Clone, Default)]
pub struct Assessment {
    pub findings: Vec<Finding>,
}

impl Assessment {
    fn add(&mut self, tone: Tone, word: &'static str, text: String, source: impl Into<String>) {
        self.findings.push(Finding {
            tone,
            word,
            text,
            source: source.into(),
        });
    }

    fn unread(&mut self, text: impl std::fmt::Display, source: impl Into<String>) {
        self.add(Tone::Unread, "?", text.to_string(), source);
    }

    /// The findings that want an operator: red and yellow, never an unread one.
    pub fn count(&self) -> usize {
        self.findings
            .iter()
            .filter(|f| f.tone >= Tone::Yellow)
            .count()
    }

    pub fn any_unread(&self) -> bool {
        self.findings.iter().any(|f| f.tone == Tone::Unread)
    }

    /// The first finding of the loudest tone.
    pub fn worst(&self) -> Option<&Finding> {
        let top = self.findings.iter().map(|f| f.tone).max()?;
        self.findings.iter().find(|f| f.tone == top)
    }

    /// The row's tone: its worst finding's, else dim where the row is idle.
    pub fn tone(&self, idle: bool) -> Tone {
        match self.worst() {
            Some(f) => f.tone,
            None if idle => Tone::Dim,
            None => Tone::Plain,
        }
    }

    /// The row's verdict word: its worst finding's, else `idle` or `ok`.
    pub fn verdict(&self, idle: bool) -> &'static str {
        match self.worst() {
            Some(f) => f.word,
            None if idle => "idle",
            None => "ok",
        }
    }
}

/// What the table's PANE cell reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneCell {
    Up {
        started_ms: i64,
    },
    /// Named, and tmux holds no such session. `served` where the name came
    /// from core's slug, so the daemon should be keeping one.
    Down {
        served: bool,
    },
    /// Core does not serve the project and the ledger records no pane.
    None,
    Unread,
}

impl PaneCell {
    pub fn cell(&self) -> &'static str {
        match self {
            PaneCell::Up { .. } => "up",
            PaneCell::Down { .. } => "down",
            PaneCell::None => "none",
            PaneCell::Unread => "?",
        }
    }
}

pub fn pane(s: &Snapshot, p: &Project) -> PaneCell {
    match render::master_pane(s, p) {
        Err(Unnamed::NoPane(_)) => PaneCell::None,
        Err(Unnamed::Unread(_)) => PaneCell::Unread,
        Ok(_) => match render::pane_state(s, p) {
            Pane::Running { started_ms } => PaneCell::Up { started_ms },
            Pane::NotRunning => PaneCell::Down {
                served: p.core_slug.is_some(),
            },
            Pane::Unread => PaneCell::Unread,
        },
    }
}

/// The runs holding a lease that belong to `p`.
pub fn runs_of<'a>(s: &'a Snapshot, p: &Project) -> Vec<&'a Run> {
    let Some(id) = p.project_id.as_deref() else {
        return Vec::new();
    };
    render::runs_by_project(s).remove(id).unwrap_or_default()
}

/// The runs parked on a person that belong to `p`.
pub fn parked_of<'a>(s: &'a Snapshot, p: &Project) -> Vec<&'a Run> {
    let (Ok(view), Some(id)) = (&s.ledger, p.project_id.as_deref()) else {
        return Vec::new();
    };
    view.runs
        .iter()
        .filter(|r| r.parked_on_a_person() && r.project_id.as_deref() == Some(id))
        .collect()
}

/// How a run's worktree reads for quiet: how long since its newest write,
/// gone, or unread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Quiet {
    For(i64),
    /// A walk that stopped at its cap or met entries it could not read: a
    /// newer file than the newest seen, if one was, may be among them.
    Partial {
        seen_ms: Option<i64>,
        why: String,
    },
    Gone,
    /// Walked whole and holding no file, or not walked yet: no age to judge.
    NoAge,
    Unread(String),
}

/// Why a walk is partial, where it is.
fn partial(entries: usize, capped: bool, unread: usize) -> Option<String> {
    match (capped, unread) {
        (false, 0) => None,
        (true, 0) => Some(format!("the walk stopped at {entries} entries")),
        (false, n) => Some(format!("{n} entr(ies) could not be read")),
        (true, n) => Some(format!(
            "the walk stopped at {entries} entries and {n} could not be read"
        )),
    }
}

pub fn quiet(s: &Snapshot, r: &Run) -> Quiet {
    match s.trees.get(&r.worktree_path) {
        None => Quiet::NoAge,
        Some((
            _,
            TreeAge::Newest {
                at_ms,
                entries,
                capped,
                unread,
                ..
            },
        )) => match partial(*entries, *capped, *unread) {
            None => Quiet::For(s.now_ms - at_ms),
            Some(why) => Quiet::Partial {
                seen_ms: Some(s.now_ms - at_ms),
                why,
            },
        },
        Some((_, TreeAge::Gone)) => Quiet::Gone,
        Some((
            _,
            TreeAge::NoFiles {
                entries,
                capped,
                unread,
                ..
            },
        )) => match partial(*entries, *capped, *unread) {
            None => Quiet::NoAge,
            Some(why) => Quiet::Partial { seen_ms: None, why },
        },
        Some((_, TreeAge::Unreadable(e))) => Quiet::Unread(e.clone()),
    }
}

/// Whether a partial walk still says the run is quiet: a write seen within
/// the ageing window proves it is not, whatever the walk missed; otherwise
/// the walk cannot say how long it has been.
fn partial_says_nothing(seen_ms: Option<i64>) -> bool {
    seen_ms.is_some_and(|ms| ms < AGEING_MS)
}

/// The tone a run's own line takes.
pub fn run_tone(s: &Snapshot, r: &Run) -> Tone {
    if r.work != "runnable" {
        return Tone::Plain;
    }
    match quiet(s, r) {
        Quiet::Gone => Tone::Red,
        Quiet::For(ms) if ms >= STALL_MS => Tone::Red,
        Quiet::For(ms) if ms >= AGEING_MS => Tone::Yellow,
        Quiet::Partial { seen_ms, .. } if !partial_says_nothing(seen_ms) => Tone::Unread,
        Quiet::Unread(_) => Tone::Unread,
        _ => Tone::Plain,
    }
}

/// Every finding on one project, red first in the criteria's order, then
/// yellow, then what could not be read.
pub fn project(s: &Snapshot, p: &Project) -> Assessment {
    let mut red = Assessment::default();
    let mut yellow = Assessment::default();
    let mut unread = Assessment::default();
    let ledger = s
        .ledger
        .as_ref()
        .map(|v| format!("{} runs", v.path.display()))
        .unwrap_or_else(|e| e.to_string());
    let runs = runs_of(s, p);

    // Red: stalled, parked on a person, drift, abandoned, no release path.
    for r in runs.iter().filter(|r| r.work == "runnable") {
        let keys = r.held_keys().join(",");
        let tree = r.worktree_path.display().to_string();
        match quiet(s, r) {
            Quiet::Gone => red.add(
                Tone::Red,
                "STALL",
                format!(
                    "{keys} run {} is runnable and its worktree is gone",
                    short(&r.run_id)
                ),
                format!("{ledger} × {tree}"),
            ),
            Quiet::For(ms) if ms >= STALL_MS => red.add(
                Tone::Red,
                "STALL",
                format!(
                    "{keys} run {} is runnable and its worktree has not been written for {}",
                    short(&r.run_id),
                    span(ms)
                ),
                format!("{ledger} × the newest file under {tree}"),
            ),
            Quiet::For(ms) if ms >= AGEING_MS => yellow.add(
                Tone::Yellow,
                "AGEING",
                format!(
                    "{keys} run {} is runnable and its worktree has not been written for {}",
                    short(&r.run_id),
                    span(ms)
                ),
                format!("{ledger} × the newest file under {tree}"),
            ),
            Quiet::Partial { seen_ms, why } if !partial_says_nothing(seen_ms) => unread.unread(
                format!(
                    "{keys} run {}: how long its worktree has been quiet cannot be said — {why}, so a newer file may be unread{}",
                    short(&r.run_id),
                    seen_ms
                        .map(|ms| format!("; the newest write seen is {} old", span(ms)))
                        .unwrap_or_default()
                ),
                tree,
            ),
            Quiet::Unread(e) => unread.unread(
                format!(
                    "{keys} run {}: its worktree cannot be walked — {e}",
                    short(&r.run_id)
                ),
                tree,
            ),
            _ => {}
        }
    }
    for r in parked_of(s, p) {
        let keys: Vec<&str> = r.issues.iter().map(|(k, _)| k.as_str()).collect();
        red.add(
            Tone::Red,
            "ASKS",
            format!(
                "{} run {} is parked on a person, waiting on {}",
                keys.join(","),
                short(&r.run_id),
                r.waiting_on
                    .as_deref()
                    .unwrap_or("an answer it did not record")
            ),
            ledger.clone(),
        );
    }
    match &p.skill {
        Some(Skill::Read {
            path,
            matches: Ok(false),
            ..
        }) => red.add(
            Tone::Red,
            "DRIFT",
            format!(
                "the master skill at {} is not the asset of the binary the daemon runs",
                path.display()
            ),
            format!("{} × the daemon's /proc/<pid>/exe", path.display()),
        ),
        Some(Skill::Read {
            path,
            matches: Err(e),
            ..
        }) => unread.unread(
            format!("whether the master skill drifted: {e}"),
            path.display().to_string(),
        ),
        Some(Skill::Unreadable(e)) => unread.unread(e, "the master skill"),
        _ => {}
    }
    match &p.cli {
        Some(Slug::Drift { record, cli, core }) => red.add(
            Tone::Red,
            "DRIFT",
            format!(
                "the forge CLI here resolves `{cli}`, and core's slug for this project is `{core}`"
            ),
            record.display().to_string(),
        ),
        Some(Slug::Unreadable(e)) => unread.unread(e, "the forge CLI's project record"),
        Some(Slug::CoreUnknown { record, cli }) => unread.unread(
            format!("the CLI resolves `{cli}`, and core's slug could not be read to compare"),
            record.display().to_string(),
        ),
        _ => {}
    }
    if let Ok(view) = &s.ledger {
        for r in &runs {
            if let Some(why) = ledger_ro::abandoned_because(r, view, s.boot.as_deref()) {
                red.add(
                    Tone::Red,
                    "ORPHAN",
                    format!(
                        "{} run {} still holds its lease(s): {why}",
                        r.held_keys().join(","),
                        short(&r.run_id)
                    ),
                    format!("{} runs × masters", view.path.display()),
                );
            }
        }
    }
    let id = p.project_id.as_deref().unwrap_or("");
    let core = match &s.core {
        Err(e) => {
            unread.unread(e, "core");
            None
        }
        Ok((_, all)) => match render::core_of(p, all) {
            Ok(c) => Some(c),
            Err(why) => {
                unread.unread(why, "core");
                None
            }
        },
    };
    if let Some(core) = core {
        match &core.awaiting {
            Ok(a) if a.total > 0 => match &a.blockers {
                Ok(b) if !b.is_empty() => red.add(
                    Tone::Red,
                    "NOPATH",
                    format!(
                        "{} at awaiting_release ({}) with no release path: {}",
                        a.total,
                        a.keys.join(", "),
                        b[0].code
                    ),
                    format!("GET /api/projects/{id}/release-readiness"),
                ),
                Err(e) => unread.unread(
                    format!(
                        "whether a release can start over {} at awaiting_release: {e}",
                        a.total
                    ),
                    format!("GET /api/projects/{id}/release-readiness"),
                ),
                _ => {}
            },
            Err(e) => unread.unread(e, "GET /api/projects/:id/issues?status=awaiting_release"),
            _ => {}
        }
    }

    // Yellow beyond ageing: a served pane down, questions open.
    match pane(s, p) {
        PaneCell::Down { served: true } => yellow.add(
            Tone::Yellow,
            "DOWN",
            "core serves this project to this box and its master pane is not running".into(),
            "tmux list-sessions",
        ),
        PaneCell::Unread => unread.unread(
            match &s.sessions {
                Err(e) => e.to_string(),
                Ok(_) => "the master pane cannot be named".into(),
            },
            "tmux list-sessions",
        ),
        _ => {}
    }
    if let Some(core) = core {
        match &core.questions {
            Ok(q) if q.total > 0 => yellow.add(
                Tone::Yellow,
                "WAITS",
                format!("{} question(s) open on core", q.total),
                format!("GET /api/questions?projectId={id}&status=open"),
            ),
            Err(e) => unread.unread(e, "GET /api/questions"),
            _ => {}
        }
        if let Err(e) = &core.lanes {
            unread.unread(e, super::people::lanes_route(id));
        }
    }
    if let Err(e) = &s.ledger {
        if p.project_id.is_some() {
            unread.unread(format!("its runs: {e}"), "the ledger");
        }
    }

    red.findings.extend(yellow.findings);
    red.findings.extend(unread.findings);
    red
}

/// Every finding on the box itself, in the criteria's order.
pub fn boxwide(s: &Snapshot) -> Assessment {
    let mut a = Assessment::default();
    if s.daemon_pid.is_none() {
        a.add(
            Tone::Red,
            "DAEMON",
            "no running daemon could be named for this configuration".into(),
            "serving.json and the processes on this box",
        );
    }
    if !s.gate.is_empty() {
        a.add(Tone::Red, "GATE", s.gate.join(" "), s.gate_source.clone());
    }
    if let Ok(jobs) = &s.jobs {
        for j in &jobs.records {
            if let Some(at) = j.waiting_since() {
                a.add(
                    Tone::Red,
                    "ASKS",
                    format!(
                        "{} (job {}) has waited {} on a permission answer",
                        j.pane,
                        short(&j.job_id),
                        span(s.now_ms - at)
                    ),
                    format!("{}/{}.json", jobs.dir.display(), j.job_id),
                );
            }
        }
    }
    if let Ok(view) = &s.ledger {
        if let Some(stray) = render::runs_by_project(s).get("") {
            for r in stray {
                let why = ledger_ro::abandoned_because(r, view, s.boot.as_deref())
                    .map(|w| format!("; {w}"))
                    .unwrap_or_default();
                a.add(
                    Tone::Red,
                    "ORPHAN",
                    format!(
                        "{} run {} holds its lease(s) and names no project this box knows{why}",
                        r.held_keys().join(","),
                        short(&r.run_id)
                    ),
                    format!("{} runs", view.path.display()),
                );
            }
        }
    }
    let sources: [(&str, Option<String>); 5] = [
        (
            "the bindings",
            s.config.as_ref().err().map(ToString::to_string),
        ),
        (
            "the ledger",
            s.ledger.as_ref().err().map(ToString::to_string),
        ),
        (
            "tmux list-sessions",
            s.sessions.as_ref().err().map(ToString::to_string),
        ),
        (
            "the pool-job records",
            match &s.jobs {
                Err(e) => Some(e.to_string()),
                Ok(j) if !j.unreadable.is_empty() => Some(format!(
                    "{} record(s) could not be read, so a pane may wait unseen",
                    j.unreadable.len()
                )),
                Ok(_) => None,
            },
        ),
        ("core", s.core.as_ref().err().map(ToString::to_string)),
    ];
    for (source, why) in sources {
        if let Some(why) = why {
            a.unread(why, source);
        }
    }
    if let Err(e) = &s.discovery {
        a.unread(e, "GET /api/devices/me/runners");
    }
    a
}

/// What a run's line says of its worktree.
pub fn wrote(s: &Snapshot, r: &Run) -> String {
    let partial_of = |entries: &usize, capped: &bool, unread: &usize| {
        partial(*entries, *capped, *unread)
            .map(|why| format!(" (PARTIAL: {why})"))
            .unwrap_or_default()
    };
    match s.trees.get(&r.worktree_path) {
        None => "not walked yet".into(),
        Some((
            _,
            TreeAge::Newest {
                at_ms,
                path,
                entries,
                capped,
                unread,
                ..
            },
        )) => format!(
            "wrote {} {}{}",
            ago(s.now_ms, *at_ms),
            path.display(),
            partial_of(entries, capped, unread)
        ),
        Some((_, TreeAge::Gone)) => "worktree gone".into(),
        Some((
            _,
            TreeAge::NoFiles {
                entries,
                capped,
                unread,
                ..
            },
        )) => match partial(*entries, *capped, *unread) {
            None => "no file written".into(),
            Some(why) => format!("no file read (PARTIAL: {why})"),
        },
        Some((_, TreeAge::Unreadable(_))) => "worktree ?".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd::top::people::{AwaitingRelease, Blocker, ProjectCore, Questions};
    use crate::cmd::top::render::tests::{a_fine_box, held_run, row, snap, NOW};
    use crate::cmd::top::source::Unreadable;

    fn alpha(s: &Snapshot) -> Assessment {
        project(s, &s.projects[0])
    }

    fn words(a: &Assessment) -> Vec<&'static str> {
        a.findings.iter().map(|f| f.word).collect()
    }

    fn with_run(quiet_ms: Option<i64>, work: &str) -> Snapshot {
        let mut s = a_fine_box(false);
        let mut r = held_run("run-x", "aaaaaaaa-1111", "sess-now", "/w/x");
        r.work = work.into();
        if let Ok(v) = &mut s.ledger {
            v.runs.push(r);
        }
        let age = match quiet_ms {
            Some(ms) => TreeAge::Newest {
                at_ms: NOW - ms,
                path: "src/lib.rs".into(),
                entries: 1,
                capped: false,
                unread: 0,
                first_unread: None,
            },
            None => TreeAge::Gone,
        };
        s.trees.insert("/w/x".into(), (NOW, age));
        s
    }

    /// A box on which everything reads fine and nothing waits has no finding.
    #[test]
    fn a_quiet_fine_project_has_no_finding_and_reads_idle() {
        let s = a_fine_box(false);
        let a = alpha(&s);
        assert!(a.findings.is_empty(), "{:?}", a.findings);
        assert_eq!((a.verdict(true), a.tone(true)), ("idle", Tone::Dim));
        assert_eq!((a.verdict(false), a.tone(false)), ("ok", Tone::Plain));
    }

    /// Criteria 12 and 13 at their boundaries: a runnable run just under 10
    /// minutes quiet is nothing, at 10 ageing, at 30 or gone stalled; a run
    /// that is not runnable is never judged for quiet.
    #[test]
    fn quiet_is_judged_at_ten_and_thirty_minutes_on_runnable_runs_alone() {
        // The criteria's minutes, written out rather than read off the
        // constants, so a constant that moves is a test that fails.
        const MIN: i64 = 60_000;
        let cases = [
            (Some(10 * MIN - 1), "runnable", vec![]),
            (Some(10 * MIN), "runnable", vec!["AGEING"]),
            (Some(30 * MIN - 1), "runnable", vec!["AGEING"]),
            (Some(30 * MIN), "runnable", vec!["STALL"]),
            (None, "runnable", vec!["STALL"]),
            (Some(300 * MIN), "blocked", vec![]),
            (None, "blocked", vec![]),
        ];
        for (quiet, work, want) in cases {
            let s = with_run(quiet, work);
            let a = alpha(&s);
            assert_eq!(words(&a), want, "{quiet:?} {work}: {:?}", a.findings);
        }
        let s = with_run(Some(30 * MIN), "runnable");
        assert_eq!(alpha(&s).tone(false), Tone::Red);
        let s = with_run(Some(10 * MIN), "runnable");
        assert_eq!(alpha(&s).tone(false), Tone::Yellow);
    }

    /// Whole-set read at 9f6f4d5, F1: a walk that stopped at its cap or met
    /// entries it could not read cannot say a run is quiet, so an old newest
    /// write seen by it is `?` and never STALL or AGEING; a recent one still
    /// proves the run is writing; and the run's line says the walk was partial.
    #[test]
    fn a_partial_walk_never_earns_a_stall() {
        const MIN: i64 = 60_000;
        for (capped, unread) in [(true, 0), (false, 2), (true, 1)] {
            for (seen, want) in [
                (Some(45 * MIN), vec!["?"]),
                (Some(MIN), vec![]),
                (None, vec!["?"]),
            ] {
                let mut s = with_run(Some(0), "runnable");
                let age = match seen {
                    Some(ms) => TreeAge::Newest {
                        at_ms: NOW - ms,
                        path: "src/lib.rs".into(),
                        entries: 400_000,
                        capped,
                        unread,
                        first_unread: None,
                    },
                    None => TreeAge::NoFiles {
                        entries: 400_000,
                        unread,
                        first_unread: None,
                        capped,
                    },
                };
                s.trees.insert("/w/x".into(), (NOW, age));
                let a = alpha(&s);
                assert_eq!(
                    words(&a),
                    want,
                    "{capped} {unread} {seen:?}: {:?}",
                    a.findings
                );
                let r = s.ledger.as_ref().unwrap().runs.last().unwrap();
                let line = wrote(&s, r);
                assert!(line.contains("(PARTIAL: "), "{line}");
                assert!(!line.contains("no file written"), "{line}");
                assert_ne!(run_tone(&s, r), Tone::Red, "{line}");
            }
        }
    }

    /// Criterion 12: each red condition on its own earns red and its word,
    /// and red outranks yellow in the verdict whatever order they were met.
    #[test]
    fn every_red_condition_is_red_and_outranks_yellow() {
        // The busy box holds a parked run, an abandoned run, a release with
        // no path and an open question.
        let s = a_fine_box(true);
        let a = alpha(&s);
        assert_eq!(words(&a), vec!["ASKS", "ORPHAN", "NOPATH", "WAITS"]);
        assert_eq!((a.verdict(false), a.tone(false)), ("ASKS", Tone::Red));
        assert_eq!(a.count(), 4);

        let mut s = a_fine_box(false);
        s.projects[0].skill = Some(Skill::Read {
            path: "/repo/a/SKILL.md".into(),
            bytes: 1,
            written_ms: Ok(NOW),
            matches: Ok(false),
        });
        assert_eq!(words(&alpha(&s)), vec!["DRIFT"]);
        s.projects[0].cli = Some(Slug::Drift {
            record: "/c/r.json".into(),
            cli: "forge-dev".into(),
            core: "alpha".into(),
        });
        assert_eq!(words(&alpha(&s)), vec!["DRIFT", "DRIFT"]);
    }

    /// Criterion 13: a served pane that tmux does not hold is yellow; a pane
    /// for a project core does not serve is nothing.
    #[test]
    fn a_served_pane_down_is_yellow_and_an_unserved_one_is_nothing() {
        let mut s = a_fine_box(false);
        s.sessions = Ok(Default::default());
        let a = alpha(&s);
        assert_eq!(words(&a), vec!["DOWN"]);
        assert_eq!(a.tone(false), Tone::Yellow);
        assert_eq!(pane(&s, &s.projects[1]), PaneCell::None);
        assert!(project(&s, &s.projects[1]).findings.is_empty());
    }

    /// Criteria 9 and 10: a project whose only findings are sources it could
    /// not read says `?`, never idle or ok, and counts nothing as wanting
    /// attention.
    #[test]
    fn a_project_read_from_nothing_says_unread() {
        let s = snap(vec![row("alpha", "id-a", "/repo/a")]);
        let a = alpha(&s);
        assert!(!a.findings.is_empty());
        assert!(
            a.findings.iter().all(|f| f.tone == Tone::Unread),
            "{:?}",
            a.findings
        );
        assert_eq!((a.verdict(true), a.tone(true)), ("?", Tone::Unread));
        assert_eq!(a.count(), 0);
        assert!(a.any_unread());
    }

    /// Criterion 13: the lanes, questions and release-readiness reads each
    /// count as unread on their own.
    #[test]
    fn each_core_read_that_failed_is_its_own_unread_finding() {
        let mut s = a_fine_box(false);
        let no = || Unreadable::new("GET x", "503");
        if let Ok((_, all)) = &mut s.core {
            all.insert(
                "aaaaaaaa-1111".into(),
                ProjectCore {
                    questions: Err(no()),
                    awaiting: Ok(AwaitingRelease {
                        total: 1,
                        keys: vec!["ISS-7".into()],
                        blockers: Err(no()),
                    }),
                    lanes: Err(no()),
                },
            );
        }
        let a = alpha(&s);
        assert_eq!(a.findings.len(), 3, "{:?}", a.findings);
        assert_eq!(a.verdict(false), "?");
        let mut s = a_fine_box(false);
        if let Ok((_, all)) = &mut s.core {
            all.insert(
                "aaaaaaaa-1111".into(),
                ProjectCore {
                    questions: Ok(Questions {
                        total: 0,
                        listed: vec![],
                    }),
                    awaiting: Ok(AwaitingRelease {
                        total: 1,
                        keys: vec!["ISS-7".into()],
                        blockers: Ok(vec![Blocker {
                            code: "NO_RELEASE_GATE".into(),
                            message: "m".into(),
                        }]),
                    }),
                    lanes: Err(no()),
                },
            );
        }
        let a = alpha(&s);
        assert_eq!(words(&a), vec!["NOPATH", "?"]);
        assert_eq!(a.verdict(false), "NOPATH");
    }

    /// Criterion 6: the box's verdict is its first finding in the criterion's
    /// order, and a box source unread is `?` below every read finding.
    #[test]
    fn the_box_ranks_its_findings_in_order() {
        let mut s = a_fine_box(false);
        s.daemon_pid = Some(1);
        assert!(boxwide(&s).findings.is_empty());
        s.gate = vec!["gate       FAILING OPEN".into()];
        s.sessions = Err(Unreadable::new("tmux", "no"));
        assert_eq!(words(&boxwide(&s)), vec!["GATE", "?"]);
        s.daemon_pid = None;
        let a = boxwide(&s);
        assert_eq!(words(&a), vec!["DAEMON", "GATE", "?"]);
        assert_eq!(a.verdict(false), "DAEMON");
        assert_eq!(a.count(), 2);
    }
}
