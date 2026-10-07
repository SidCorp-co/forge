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

/// The most projects a heartbeat may carry; the consumer declares the same
/// number and `pool-read-report.fixture.json` holds it for both sides. The box
/// never truncates to it: the list is its whole picture, so a project cut from
/// it would be cleared at core while it was failing. Past it core refuses the
/// whole report by name and the box logs that refusal.
pub const MAX_PROJECTS: usize = 256;

/// `<config dir>/pool-reads.json`.
pub fn path(config_dir: &Path) -> PathBuf {
    config_dir.join("pool-reads.json")
}

/// Whether core's heartbeat schema takes `id` as a project id: the hyphenated
/// form with an RFC 9562 version and variant in either case, or the nil id, or
/// the max id in lowercase only, which is what its `z.uuid()` reads. One key it
/// refuses refuses the whole report, so no other project's condition reaches
/// core either (ISS-1344).
pub fn is_project_id(id: &str) -> bool {
    let b = id.as_bytes();
    if id == "00000000-0000-0000-0000-000000000000" || id == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
        && (b'1'..=b'8').contains(&b[14])
        && matches!(b[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
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

/// Whether this is the first time this process names `id` under `config_dir`
/// for `what`. Once for the daemon's life: core serves the same id every sweep
/// and the heartbeat reads the same file every beat, the id does not change
/// shape between them, and a restart names it again (ISS-1344).
fn first_naming(what: &'static str, config_dir: &Path, id: &str) -> bool {
    type Named = std::collections::BTreeSet<(&'static str, PathBuf, String)>;
    static NAMED: std::sync::Mutex<Named> = std::sync::Mutex::new(Named::new());
    NAMED.lock().unwrap_or_else(|e| e.into_inner()).insert((
        what,
        config_dir.to_path_buf(),
        id.to_string(),
    ))
}

/// A record that exists and cannot be read: unopenable, or not the shape this
/// box writes. It is not the empty record an absent file is — read as one, the
/// heartbeat would clear at core every condition the box had reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreadable {
    pub path: PathBuf,
    pub reason: String,
}

impl std::fmt::Display for Unreadable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} cannot be read ({})",
            self.path.display(),
            self.reason
        )
    }
}

/// The record with every key [`is_project_id`] refuses taken out, and those
/// keys, so the caller that writes can say which it dropped.
fn load_valid(config_dir: &Path) -> Result<(Record, Vec<String>), Unreadable> {
    let mut r = load(config_dir)?;
    let refused: Vec<String> = r
        .projects
        .keys()
        .filter(|id| !is_project_id(id))
        .cloned()
        .collect();
    for id in &refused {
        r.projects.remove(id);
    }
    Ok((r, refused))
}

/// An absent file is no record; any other failure to read it is [`Unreadable`].
fn load(config_dir: &Path) -> Result<Record, Unreadable> {
    let at = path(config_dir);
    let unreadable = |reason: String| Unreadable {
        path: at.clone(),
        reason,
    };
    let body = match std::fs::read_to_string(&at) {
        Ok(body) => body,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Record::default()),
        Err(e) => return Err(unreadable(e.to_string())),
    };
    serde_json::from_str(&body).map_err(|e| unreadable(format!("does not parse: {e}")))
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

/// Record what one pass learned about `project_id`'s pool. An unreadable
/// record is left as it stands: replaced by a fresh one, the next beat would
/// carry this failure alone and clear at core every project recorded before.
pub fn note(config_dir: &Path, project_id: &str, took: &Took, now_ms: i64) {
    let Some(outcome) = Outcome::of(took) else {
        return;
    };
    if !is_project_id(project_id) {
        if !first_naming("read", config_dir, project_id) {
            return;
        }
        tracing::warn!(
            "[pool] {project_id:?} is not a project id core takes (a UUID), so this read of its pool is not recorded — a record holding it would make core refuse every project's report"
        );
        return;
    }
    let _held = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let (mut r, refused) = match load_valid(config_dir) {
        Ok(loaded) => loaded,
        Err(e) => {
            if let Outcome::Failed(f) = outcome {
                tracing::warn!(
                    "[pool] {project_id}: a failed read ({}) is not recorded — {e}; remove the file to start a fresh record",
                    crate::daemon::degraded::clip(&f.reason)
                );
            }
            return;
        }
    };
    for id in &refused {
        tracing::warn!(
            "[pool] dropped {id:?} from {}: not a project id core takes (a UUID), and while it stood core refused this box's whole pool report",
            path(config_dir).display()
        );
    }
    let known = r.projects.contains_key(project_id);
    if !known && matches!(outcome, Outcome::Read) && refused.is_empty() {
        return;
    }
    let p = r.projects.entry(project_id.to_string()).or_default();
    let was = (p.streak_since, p.consecutive);
    if !apply(p, outcome, now_ms) && refused.is_empty() {
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
pub fn report(config_dir: &Path, now_ms: i64) -> Result<Vec<Condition>, Unreadable> {
    let (r, refused) = load_valid(config_dir)?;
    for id in refused
        .iter()
        .filter(|id| first_naming("report", config_dir, id))
    {
        tracing::warn!(
            "[pool] {id:?} in {} is not a project id core takes (a UUID) and is left out of the report; the daemon's next pool read removes it",
            path(config_dir).display()
        );
    }
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
    Ok(out)
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
    const P1: &str = "68567cd4-0000-4000-8000-00000000000a";
    const INTERMITTENT: &str = "68567cd4-0000-4000-8000-00000000000b";
    const BLIND: &str = "68567cd4-0000-4000-8000-00000000000c";

    /// Every case but the unreadable ones reads a record this module wrote.
    fn report(d: &Path, now_ms: i64) -> Vec<Condition> {
        super::report(d, now_ms).expect("a record this module wrote")
    }

    fn dir(name: &str) -> crate::test_scratch::Scratch {
        crate::test_scratch::Scratch::new(&format!("pool-reads-{name}"))
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
        note(&d, P1, &gw525(), NOW - 2 * MIN);
        note(&d, P1, &gw525(), NOW - MIN);
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
        note(&d, P1, &gw525(), NOW - 10 * MIN);
        note(&d, P1, &Took::NothingClaimable, NOW - 9 * MIN);
        note(&d, P1, &Took::NothingClaimable, NOW - 8 * MIN);
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
        note(&d, P1, &gw525(), NOW - WINDOW_MS - MIN);
        note(&d, P1, &Took::NothingClaimable, NOW - WINDOW_MS);
        assert!(report(&d, NOW).is_empty());
        note(&d, P1, &Took::NothingClaimable, NOW);
        assert!(
            !path(&d).exists() || !std::fs::read_to_string(path(&d)).unwrap().contains(P1),
            "an aged-out project leaves the file"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_project_never_failed_is_never_written() {
        let d = dir("clean");
        note(&d, P1, &Took::NothingClaimable, NOW);
        note(&d, P1, &Took::Started("j1".into()), NOW);
        assert!(!path(&d).exists(), "a clean read writes nothing");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A pass that stopped at the bound asked core nothing, so it is neither.
    #[test]
    fn a_pass_at_its_bound_is_not_a_read() {
        let d = dir("bound");
        note(&d, P1, &gw525(), NOW - MIN);
        note(&d, P1, &Took::AtBound, NOW);
        assert_eq!(report(&d, NOW)[0].verdict, Verdict::Blind);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Criterion 5, the cap. Past it the count is a floor, and a fresh read of
    /// the file — which is what a restart is — still says so.
    #[test]
    fn past_the_cap_the_count_is_a_floor_and_a_restart_still_says_so() {
        let d = dir("cap");
        for i in 0..(MAX_FAILURES as i64 + 5) {
            note(&d, P1, &gw525(), NOW - 100 * MIN + i * 1000);
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
            P1,
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
        note(&d, INTERMITTENT, &gw525(), NOW - 3 * MIN);
        note(&d, INTERMITTENT, &Took::NothingClaimable, NOW - 2 * MIN);
        note(&d, BLIND, &gw525(), NOW - 5 * MIN);
        let r = report(&d, NOW);
        assert_eq!(r[0].project_id, BLIND);
        assert_eq!(r[1].project_id, INTERMITTENT);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Consult F1. However many projects failed, every one is reported: one cut
    /// from the list would read at core as a project that read cleanly.
    #[test]
    fn every_failing_project_is_reported_and_none_is_cut() {
        let d = dir("many");
        let n = MAX_PROJECTS + 5;
        for i in 0..n {
            note(
                &d,
                &format!("68567cd4-0000-4000-8000-{i:012}"),
                &gw525(),
                NOW - MIN,
            );
        }
        assert_eq!(report(&d, NOW).len(), n);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A record that exists and cannot be read is said to be unreadable, never
    /// read as empty, and a failed read does not overwrite it: a fresh record
    /// holding that failure alone would clear at core every project before it.
    #[test]
    fn a_file_that_will_not_parse_is_unreadable_and_is_not_overwritten() {
        let d = dir("junk");
        std::fs::write(path(&d), "{not json").unwrap();
        let e = super::report(&d, NOW).expect_err("junk is not an empty record");
        assert_eq!(e.path, path(&d));
        assert!(e.reason.starts_with("does not parse"), "{e}");
        note(&d, P1, &gw525(), NOW);
        assert_eq!(std::fs::read_to_string(path(&d)).unwrap(), "{not json");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_path_that_cannot_be_opened_is_unreadable_and_an_absent_one_is_empty() {
        let d = dir("unopenable");
        assert_eq!(super::report(&d, NOW), Ok(vec![]), "no file is no record");
        std::fs::create_dir(path(&d)).unwrap();
        let e = super::report(&d, NOW).expect_err("a directory is not a record");
        assert!(!e.reason.starts_with("does not parse"), "{e}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The record this box held on 2026-09-30: every key a project id but one,
    /// a fixture's, whose failures carry `fake_core::ROUTE_ABSENT` byte for byte.
    fn plant_the_boxs_record(d: &Path) {
        let body = serde_json::json!({ "projects": {
            "proj-u": {
                "failures": [{ "at": NOW - 2 * MIN, "status": 404, "reason": format!(
                    "pool 404 Not Found: {}", crate::transport::fake_core::ROUTE_ABSENT) }],
                "droppedThrough": null, "streakSince": NOW - 2 * MIN, "consecutive": 1, "recoveredAt": null
            },
            BLIND: {
                "failures": [{ "at": NOW - MIN, "status": 525, "reason": "pool 525" }],
                "droppedThrough": null, "streakSince": NOW - MIN, "consecutive": 1, "recoveredAt": null
            }
        }});
        std::fs::write(path(d), body.to_string()).unwrap();
    }

    /// ISS-1344. A key core's schema refuses is left out of the report, and the
    /// project beside it still goes: one bad key used to refuse them all.
    #[test]
    fn a_key_core_would_refuse_is_left_out_and_every_project_id_still_goes() {
        let d = dir("bad-key");
        plant_the_boxs_record(&d);
        let r = report(&d, NOW);
        let ids: Vec<&str> = r.iter().map(|c| c.project_id.as_str()).collect();
        assert_eq!(ids, vec![BLIND], "only the project id travels: {r:?}");
    }

    /// What `f` logged, for the criteria that are about what the daemon says.
    fn logged(f: impl FnOnce()) -> String {
        #[derive(Clone)]
        struct Buf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf(Default::default());
        let made = buf.clone();
        crate::daemon::keep_tracing_capturable();
        let sub = tracing_subscriber::fmt()
            .with_writer(move || made.clone())
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    /// ISS-1344. The first pool read the daemon records takes the bad key out of
    /// the file, whichever project that read was of and however it went, and
    /// says which key it dropped.
    #[test]
    fn the_next_recorded_read_removes_a_key_core_would_refuse_from_the_file() {
        let d = dir("bad-key-drop");
        plant_the_boxs_record(&d);
        let said = logged(|| note(&d, P1, &Took::NothingClaimable, NOW));
        let body = std::fs::read_to_string(path(&d)).unwrap();
        assert!(!body.contains("proj-u"), "{body}");
        assert!(body.contains(BLIND), "the valid entry is kept: {body}");
        assert!(said.contains(r#"dropped "proj-u" from"#), "{said}");
    }

    /// ISS-1344. A read of a project whose id core would refuse is not stored,
    /// so it can never reach the report, and the log names the id.
    #[test]
    fn a_read_of_a_project_id_core_would_refuse_is_not_recorded() {
        let d = dir("bad-key-note");
        let said = logged(|| note(&d, "proj-u", &gw525(), NOW));
        assert!(!path(&d).exists(), "nothing was written");
        assert!(
            said.contains(r#""proj-u" is not a project id core takes"#),
            "{said}"
        );
        note(&d, P1, &gw525(), NOW);
        note(&d, "proj-u", &gw525(), NOW);
        let r = report(&d, NOW);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].project_id, P1);
    }

    /// ISS-1344. While core keeps serving a project whose id it would refuse,
    /// the daemon reads that pool every sweep; the id is named the first time,
    /// not every 30 seconds for as long as the daemon runs.
    #[test]
    fn a_refused_read_is_named_once_for_the_daemons_life() {
        let d = dir("bad-key-once");
        let first = logged(|| note(&d, "proj-u", &gw525(), NOW));
        let again = logged(|| note(&d, "proj-u", &gw525(), NOW + MIN / 2));
        assert!(
            first.contains(r#""proj-u" is not a project id core takes"#),
            "{first}"
        );
        assert!(
            !again.contains("proj-u"),
            "named again a sweep later: {again}"
        );
        let other = logged(|| note(&d, "proj-v", &gw525(), NOW));
        assert!(
            other.contains(r#""proj-v""#),
            "another id is named too: {other}"
        );
    }

    /// ISS-1344. A key left out of the report is named the first time the
    /// heartbeat leaves it out, not on every beat until a pool read removes it.
    #[test]
    fn a_key_left_out_of_the_report_is_named_once_for_the_daemons_life() {
        let d = dir("bad-key-report-once");
        plant_the_boxs_record(&d);
        let first = logged(|| {
            report(&d, NOW);
        });
        let again = logged(|| {
            report(&d, NOW + MIN / 2);
        });
        assert!(
            first.contains(r#""proj-u" in"#) && first.contains("left out of the report"),
            "{first}"
        );
        assert!(
            !again.contains("proj-u"),
            "named again a beat later: {again}"
        );
    }

    /// The case list core's `pool-read-report.test.ts` runs its `z.uuid()`
    /// over, so the box answers every id the way core does rather than the way
    /// `uuid::Uuid::parse_str` would, and a list that moves on one side fails
    /// the other.
    #[test]
    fn a_project_id_is_the_shape_cores_schema_takes() {
        let fixture: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../core/src/devices/pool-read-report.fixture.json"
            ))
            .expect("the pool fixture both languages read"),
        )
        .expect("the pool fixture is json");
        let ids = |side: &str| -> Vec<String> {
            fixture["projectIds"][side]
                .as_array()
                .unwrap_or_else(|| panic!("projectIds.{side} is a list"))
                .iter()
                .map(|v| v.as_str().expect("an id is a string").to_string())
                .collect()
        };
        let (taken, refused) = (ids("taken"), ids("refused"));
        assert!(
            taken.len() >= 5 && refused.len() >= 10,
            "{taken:?} {refused:?}"
        );
        for ok in &taken {
            assert!(
                is_project_id(ok),
                "core takes {ok:?} and the box refuses it"
            );
        }
        for bad in &refused {
            assert!(
                !is_project_id(bad),
                "core refuses {bad:?} and the box takes it"
            );
        }
    }
}
