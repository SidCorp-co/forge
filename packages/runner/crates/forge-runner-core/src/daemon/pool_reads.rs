//! What this box knows about its own reads of each project's job pool.
//!
//! A failed read and an empty pool used to be one value: `take_one` answered
//! `NothingClaimable` for both, and the only trace of the first was a WARN in
//! the daemon log. Measured on sid-xeon-1 on 2026-09-24, six reads failed at the
//! gateway (520, 522, 525) across four projects while every other route answered,
//! and nothing outside that log said the box had gone blind to its queue
//! (ISS-1234).
//!
//! Those codes are answered by the edge and never reach core, so core cannot
//! see this fault from its side: only the box that received one can report it.
//! The record is a file beside `config.toml` so that `forge-runner status` — a
//! different process — reads the same thing the daemon wrote, and so a restart
//! keeps the history. One derivation, [`report`], is read by `status`, by
//! `doctor` and by the heartbeat.
//!
//! Every measured failure lasted one pass. A flag that said "blind" only while
//! the newest read had failed would have been true for ten seconds and false by
//! the next heartbeat, so the record keeps a trailing window: a project that
//! failed a read inside it carries a condition, and one that did not carries
//! nothing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::daemon::pool_jobs::Took;
use crate::transport::pool::ReadFailure;

/// How far back a failed read still counts.
pub const WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// The most failures one project's record keeps. A project blind for a day at
/// six reads a minute would otherwise hold 8,640 of them; past this the count
/// is stated as a floor rather than left looking exact.
pub const MAX_FAILURES: usize = 200;

/// The most projects a heartbeat carries. The consumer declares the same
/// number, and `pool-read.fixture.json` holds it for both sides.
pub const MAX_PROJECTS: usize = 64;

/// `<config dir>/pool-reads.json`.
pub fn path(config_dir: &Path) -> PathBuf {
    config_dir.join("pool-reads.json")
}

/// One failed read, as the transport reported it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub at: i64,
    /// `None` where no status came back at all: a refused connection, a
    /// timeout, a body that would not decode.
    pub status: Option<u16>,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    /// Oldest first, never older than the window.
    #[serde(default)]
    failures: Vec<Failure>,
    /// The newest failure the cap dropped. While it is inside the window the
    /// kept count is a floor.
    #[serde(default)]
    dropped_through: Option<i64>,
    /// When the current run of failed reads began; `None` while reading.
    #[serde(default)]
    streak_since: Option<i64>,
    #[serde(default)]
    consecutive: u64,
    /// The first good read after the last streak.
    #[serde(default)]
    recovered_at: Option<i64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Record {
    #[serde(default)]
    projects: BTreeMap<String, Project>,
}

/// What one pass of `take_one` says about the read, where it made one.
#[derive(Debug, Clone, Copy)]
pub enum Outcome<'a> {
    Read,
    Failed(&'a ReadFailure),
}

impl<'a> Outcome<'a> {
    /// `None` where the pass never read the pool: a box at its bound asks nothing.
    pub fn of(took: &'a Took) -> Option<Self> {
        match took {
            Took::AtBound => None,
            Took::Unread(f) => Some(Outcome::Failed(f)),
            _ => Some(Outcome::Read),
        }
    }
}

/// Fold one outcome into a project's record. `true` where anything changed, so
/// a box reading cleanly every ten seconds writes nothing.
fn apply(p: &mut Project, outcome: Outcome<'_>, now_ms: i64) -> bool {
    let before = p.clone();
    match outcome {
        Outcome::Failed(f) => {
            p.failures.push(Failure {
                at: now_ms,
                status: f.status,
                reason: f.reason.clone(),
            });
            if p.streak_since.is_none() {
                p.streak_since = Some(now_ms);
                p.consecutive = 0;
            }
            p.consecutive += 1;
        }
        Outcome::Read => {
            if p.streak_since.take().is_some() {
                p.consecutive = 0;
                p.recovered_at = Some(now_ms);
            }
        }
    }
    prune(p, now_ms);
    *p != before
}

fn prune(p: &mut Project, now_ms: i64) {
    let floor = now_ms - WINDOW_MS;
    p.failures.retain(|f| f.at >= floor);
    if p.failures.len() > MAX_FAILURES {
        let cut = p.failures.len() - MAX_FAILURES;
        let newest_cut = p.failures[cut - 1].at;
        p.failures.drain(..cut);
        p.dropped_through = Some(p.dropped_through.map_or(newest_cut, |d| d.max(newest_cut)));
    }
    if p.dropped_through.is_some_and(|d| d < floor) {
        p.dropped_through = None;
    }
}

/// Serialises writers inside one process. The daemon is the only writer, and
/// its sweep is sequential, but a test harness is not.
static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// An absent file is no record. One that will not parse is said, then read as
/// none: the next failure starts a fresh record rather than none being kept.
fn load(config_dir: &Path) -> Record {
    let Ok(body) = std::fs::read_to_string(path(config_dir)) else {
        return Record::default();
    };
    serde_json::from_str(&body).unwrap_or_else(|e| {
        tracing::warn!(
            "[pool] {} does not parse ({e}) — read as no record, and replaced by the next failed read",
            path(config_dir).display()
        );
        Record::default()
    })
}

/// Written whole, through a sibling file and a rename, so `status` reading
/// while the daemon writes sees the old record or the new one and never half.
fn save(config_dir: &Path, r: &Record) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let body = serde_json::to_string_pretty(r).map_err(std::io::Error::other)?;
    let tmp = config_dir.join(format!("pool-reads.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path(config_dir))
}

/// Record what one pass learned about `project_id`'s pool.
pub fn note(config_dir: &Path, project_id: &str, took: &Took, now_ms: i64) {
    let Some(outcome) = Outcome::of(took) else {
        return;
    };
    let _held = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut r = load(config_dir);
    let known = r.projects.contains_key(project_id);
    if !known && matches!(outcome, Outcome::Read) {
        return;
    }
    let p = r.projects.entry(project_id.to_string()).or_default();
    let was = (p.streak_since, p.consecutive);
    if !apply(p, outcome, now_ms) {
        return;
    }
    if let (Some(since), n, Outcome::Read) = (was.0, was.1, outcome) {
        tracing::info!(
            "[pool] {project_id}: the pool reads again after {n} failed read(s) over {}s",
            (now_ms - since).max(0) / 1000
        );
    }
    if p.failures.is_empty() && p.streak_since.is_none() {
        r.projects.remove(project_id);
    }
    if let Err(e) = save(config_dir, &r) {
        tracing::warn!(
            "[pool] could not write {}: {e} — this box's pool reads are recorded nowhere but the log",
            path(config_dir).display()
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// The newest read failed: the box cannot see this project's queue now.
    Blind,
    /// The newest read succeeded, and one inside the window did not.
    Intermittent,
}

/// One project's condition, exactly as it rides on the heartbeat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub project_id: String,
    pub verdict: Verdict,
    /// Failed reads inside the window; a floor where `count_is_floor`.
    pub failures: usize,
    pub count_is_floor: bool,
    pub window_ms: i64,
    pub unread_since: Option<i64>,
    pub consecutive: u64,
    pub recovered_at: Option<i64>,
    pub last_failure: WireFailure,
}

/// The newest failure as it travels: `what` is [`what_failed`], so every
/// surface names the status the same way without a table of its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFailure {
    pub at: i64,
    pub status: Option<u16>,
    pub what: String,
    pub reason: String,
}

fn condition(project_id: &str, p: &Project, now_ms: i64) -> Option<Condition> {
    let floor = now_ms - WINDOW_MS;
    let kept: Vec<&Failure> = p.failures.iter().filter(|f| f.at >= floor).collect();
    let last = kept.last()?;
    let blind = p.streak_since.is_some();
    Some(Condition {
        project_id: project_id.to_string(),
        verdict: if blind {
            Verdict::Blind
        } else {
            Verdict::Intermittent
        },
        failures: kept.len(),
        count_is_floor: p.dropped_through.is_some_and(|d| d >= floor),
        window_ms: WINDOW_MS,
        unread_since: if blind { p.streak_since } else { None },
        consecutive: if blind { p.consecutive } else { 0 },
        recovered_at: if blind { None } else { p.recovered_at },
        last_failure: WireFailure {
            at: last.at,
            status: last.status,
            what: crate::daemon::degraded::clip(&what_failed(last)),
            reason: crate::daemon::degraded::clip(&last.reason),
        },
    })
}

/// Every project that failed a read inside the window, blind ones first.
/// A project absent from this list read cleanly all window, or was never read.
pub fn report(config_dir: &Path, now_ms: i64) -> Vec<Condition> {
    let r = load(config_dir);
    let mut out: Vec<Condition> = r
        .projects
        .iter()
        .filter_map(|(id, p)| condition(id, p, now_ms))
        .collect();
    out.sort_by(|a, b| {
        (b.verdict == Verdict::Blind)
            .cmp(&(a.verdict == Verdict::Blind))
            .then_with(|| b.last_failure.at.cmp(&a.last_failure.at))
    });
    out.truncate(MAX_PROJECTS);
    out
}

/// What a reader is told a failure was: its status by number and name, or the
/// transport's own reason where no status came back.
pub fn what_failed(f: &Failure) -> String {
    match f.status {
        Some(code) => crate::transport::status::named(code),
        None => f.reason.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_236_800_000;
    const MIN: i64 = 60_000;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "forge-pool-reads-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("scratch");
        d
    }

    fn unread(status: Option<u16>, reason: &str) -> Took {
        Took::Unread(ReadFailure {
            status,
            reason: reason.to_string(),
        })
    }

    fn gw525() -> Took {
        unread(
            Some(525),
            "pool 525 (gateway: the TLS handshake with the origin failed)",
        )
    }

    /// Criteria 5 and 7. A failure is on disk the moment it happens, and a
    /// second process reading the file sees the project blind.
    #[test]
    fn a_failed_read_leaves_the_project_blind_on_disk() {
        let d = dir("blind");
        note(&d, "p1", &gw525(), NOW - 2 * MIN);
        note(&d, "p1", &gw525(), NOW - MIN);
        let r = report(&d, NOW);
        assert_eq!(r.len(), 1);
        let c = &r[0];
        assert_eq!(c.verdict, Verdict::Blind);
        assert_eq!(c.unread_since, Some(NOW - 2 * MIN));
        assert_eq!(c.consecutive, 2);
        assert_eq!(c.failures, 2);
        assert_eq!(c.last_failure.status, Some(525));
        assert_eq!(c.recovered_at, None);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Criteria 6 and 8. The streak ends on the first good read; the failures
    /// stay counted, which is what makes a ten-second blip visible afterwards.
    #[test]
    fn a_good_read_ends_the_streak_and_keeps_the_count() {
        let d = dir("recover");
        note(&d, "p1", &gw525(), NOW - 10 * MIN);
        note(&d, "p1", &Took::NothingClaimable, NOW - 9 * MIN);
        note(&d, "p1", &Took::NothingClaimable, NOW - 8 * MIN);
        let c = &report(&d, NOW)[0];
        assert_eq!(c.verdict, Verdict::Intermittent);
        assert_eq!(c.recovered_at, Some(NOW - 9 * MIN), "the FIRST good read");
        assert_eq!(c.unread_since, None);
        assert_eq!(c.consecutive, 0);
        assert_eq!(c.failures, 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Criterion 9. Outside the window a project carries nothing at all.
    #[test]
    fn a_project_clean_for_a_whole_window_carries_no_condition() {
        let d = dir("aged");
        note(&d, "p1", &gw525(), NOW - WINDOW_MS - MIN);
        note(&d, "p1", &Took::NothingClaimable, NOW - WINDOW_MS);
        assert!(report(&d, NOW).is_empty());
        note(&d, "p1", &Took::NothingClaimable, NOW);
        assert!(
            !path(&d).exists() || !std::fs::read_to_string(path(&d)).unwrap().contains("p1"),
            "an aged-out project leaves the file"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_project_never_failed_is_never_written() {
        let d = dir("clean");
        note(&d, "p1", &Took::NothingClaimable, NOW);
        note(&d, "p1", &Took::Started("j1".into()), NOW);
        assert!(!path(&d).exists(), "a clean read writes nothing");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A pass that stopped at the bound asked core nothing, so it is neither.
    #[test]
    fn a_pass_at_its_bound_is_not_a_read() {
        let d = dir("bound");
        note(&d, "p1", &gw525(), NOW - MIN);
        note(&d, "p1", &Took::AtBound, NOW);
        assert_eq!(report(&d, NOW)[0].verdict, Verdict::Blind);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Criterion 5, the cap. Past it the count is a floor, and a fresh read of
    /// the file — which is what a restart is — still says so.
    #[test]
    fn past_the_cap_the_count_is_a_floor_and_a_restart_still_says_so() {
        let d = dir("cap");
        for i in 0..(MAX_FAILURES as i64 + 5) {
            note(&d, "p1", &gw525(), NOW - 100 * MIN + i * 1000);
        }
        let c = &report(&d, NOW)[0];
        assert_eq!(c.failures, MAX_FAILURES);
        assert!(c.count_is_floor);
        let body = std::fs::read_to_string(path(&d)).unwrap();
        assert!(body.contains("droppedThrough"), "{body}");
        let again = &report(&d, NOW + 1)[0];
        assert!(again.count_is_floor, "read back off disk, the floor stands");
        let later = report(&d, NOW + WINDOW_MS);
        assert!(later.is_empty(), "every failure has aged out: {later:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Criterion 4. No status is a state of its own, carried with its reason.
    #[test]
    fn a_failure_with_no_status_keeps_the_transports_reason() {
        let d = dir("nostatus");
        note(
            &d,
            "p1",
            &unread(None, "pool request: operation timed out"),
            NOW,
        );
        let c = &report(&d, NOW)[0];
        assert_eq!(c.last_failure.status, None);
        assert_eq!(c.last_failure.what, "pool request: operation timed out");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_reader_is_told_the_status_by_number_and_name() {
        let f = Failure {
            at: NOW,
            status: Some(520),
            reason: "pool 520 (gateway: the origin returned an unknown error): <html>".into(),
        };
        assert_eq!(
            what_failed(&f),
            "520 (gateway: the origin returned an unknown error)"
        );
    }

    #[test]
    fn blind_projects_come_first() {
        let d = dir("order");
        note(&d, "a-intermittent", &gw525(), NOW - 3 * MIN);
        note(&d, "a-intermittent", &Took::NothingClaimable, NOW - 2 * MIN);
        note(&d, "b-blind", &gw525(), NOW - 5 * MIN);
        let r = report(&d, NOW);
        assert_eq!(r[0].project_id, "b-blind");
        assert_eq!(r[1].project_id, "a-intermittent");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_file_that_will_not_parse_reads_as_no_record() {
        let d = dir("junk");
        std::fs::write(path(&d), "{not json").unwrap();
        assert!(report(&d, NOW).is_empty());
        note(&d, "p1", &gw525(), NOW);
        assert_eq!(
            report(&d, NOW).len(),
            1,
            "the next failure starts a fresh record"
        );
        let _ = std::fs::remove_dir_all(&d);
    }
}
