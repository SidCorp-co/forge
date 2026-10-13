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
//!
//! A `404` is a different failure from those: the server saying the pool is not
//! there, which retrying does not change. [`STANDING_AFTER`] of them in a row
//! make the project [`Verdict::Unserved`], and the daemon stops reading it
//! until core's list of this box's projects changes (ISS-1326).

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

/// How many consecutive `404`s settle that the server has no pool for a
/// project. One could be a route absent for a moment; three passes running is
/// thirty seconds of the same answer, while `list_me` in the same sweep still
/// lists the project.
pub const STANDING_AFTER: u64 = 3;

/// The status that is the server's answer about the pool rather than a stumble
/// of its own: asking again does not change a `404`, while a `502` or a `525`
/// may read the next time.
const STANDING_STATUS: u16 = 404;

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

/// Whether the newest [`STANDING_AFTER`] reads of this project all failed with a
/// `404` and nothing has read since: the server's answer about the pool, not a
/// stumble.
fn standing(p: &Project) -> bool {
    let n = STANDING_AFTER as usize;
    p.streak_since.is_some()
        && p.consecutive >= STANDING_AFTER
        && p.failures.len() >= n
        && p.failures
            .iter()
            .rev()
            .take(n)
            .all(|f| f.status == Some(STANDING_STATUS))
}

fn prune(p: &mut Project, now_ms: i64) {
    let floor = now_ms - WINDOW_MS;
    // A standing project is not read again, so nothing newer will replace the
    // reads that settled it. Aging them out of the window would drop the row
    // while the box still does not read the pool.
    let keep_from = if standing(p) {
        p.failures.len().saturating_sub(STANDING_AFTER as usize)
    } else {
        p.failures.len()
    };
    let mut i = 0;
    p.failures.retain(|f| {
        i += 1;
        i > keep_from || f.at >= floor
    });
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

/// The projects this daemon has stopped reading, each with the runner id core
/// listed it under when the box stopped. Held in memory on purpose: a restart
/// asks once more, and a daemon that re-reads a stale file would stay deaf to
/// a pool core has since started serving.
type Holds = BTreeMap<(PathBuf, String), String>;
static HELD: std::sync::Mutex<Holds> = std::sync::Mutex::new(Holds::new());

/// Whether the daemon has stopped reading `project_id`'s pool because the
/// server answered `404` for it, under the runner `runner_id` core still lists
/// it under. A project listed under another runner is a changed assignment
/// and is read again.
pub fn is_held(config_dir: &Path, project_id: &str, runner_id: &str) -> bool {
    HELD.lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&(config_dir.to_path_buf(), project_id.to_string()))
        .is_some_and(|held_under| held_under == runner_id)
}

/// After a pass has been [`note`]d: stop reading a project whose record now
/// says the server's `404` is standing, and say so once, by name; and release
/// a project whose latest read was anything else.
pub fn settle(config_dir: &Path, project_id: &str, runner_id: &str, took: &Took) {
    let key = (config_dir.to_path_buf(), project_id.to_string());
    let Some(outcome) = Outcome::of(took) else {
        return;
    };
    let record = load_valid(config_dir)
        .ok()
        .and_then(|(mut r, _)| r.projects.remove(project_id));
    let failure = match (outcome, record) {
        (Outcome::Failed(f), Some(p)) if f.status == Some(STANDING_STATUS) && standing(&p) => f,
        _ => {
            HELD.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
            return;
        }
    };
    let first = HELD
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, runner_id.to_string())
        .as_deref()
        != Some(runner_id);
    if first {
        tracing::warn!(
            "[pool] {project_id}: core answered 404 to {STANDING_AFTER} pool reads in a row ({}) — a standing answer, not a stumble that retrying clears, so this box stops reading the pool until core's list of its projects changes or the daemon restarts; `forge-runner status` names it UNSERVED",
            crate::daemon::degraded::clip(&failure.reason)
        );
    }
}

/// Keep only what core still lists to this box: `listed` is every
/// `(project id, runner id)` the sweep's `list_me` returned. A project core no
/// longer lists is not a pool this box reads, so its record and its hold go,
/// whatever its verdict; one listed under another runner keeps its record and
/// loses its hold, which is how the next pass reads it again.
pub fn retain_served(config_dir: &Path, listed: &[(&str, &str)]) {
    {
        let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
        held.retain(|(dir, project), under| {
            dir != config_dir
                || listed
                    .iter()
                    .any(|(p, runner)| p == project && runner == under)
        });
    }
    let _held = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let Ok((mut r, refused)) = load_valid(config_dir) else {
        return;
    };
    let gone: Vec<String> = r
        .projects
        .keys()
        .filter(|id| !listed.iter().any(|(p, _)| p == id))
        .cloned()
        .collect();
    if gone.is_empty() {
        return;
    }
    for id in &refused {
        tracing::warn!(
            "[pool] dropped {id:?} from {}: not a project id core takes (a UUID), and while it stood core refused this box's whole pool report",
            path(config_dir).display()
        );
    }
    for id in &gone {
        r.projects.remove(id);
        tracing::info!(
            "[pool] {id}: core no longer lists this project to this box, so its pool-read record is dropped"
        );
    }
    if let Err(e) = save(config_dir, &r) {
        tracing::warn!(
            "[pool] could not write {}: {e} — a project core no longer lists stays in it",
            path(config_dir).display()
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// The newest read failed: the box cannot see this project's queue now.
    Blind,
    /// The server answered `404` to the last [`STANDING_AFTER`] reads and the
    /// box stopped asking. Unread like a blind pool, and unlike one it does not
    /// recover by being read again.
    Unserved,
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
    // A standing project's settling reads outlive the window (see `prune`).
    let aged = standing(p);
    let kept: Vec<&Failure> = p
        .failures
        .iter()
        .filter(|f| aged || f.at >= floor)
        .collect();
    let last = kept.last()?;
    let blind = p.streak_since.is_some();
    Some(Condition {
        project_id: project_id.to_string(),
        verdict: match (blind, standing(p)) {
            (true, true) => Verdict::Unserved,
            (true, false) => Verdict::Blind,
            (false, _) => Verdict::Intermittent,
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

/// Every project that failed a read inside the window, blind ones first, then
/// the unserved, then the intermittent.
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
    let rank = |v: Verdict| match v {
        Verdict::Blind => 0,
        Verdict::Unserved => 1,
        Verdict::Intermittent => 2,
    };
    out.sort_by(|a, b| {
        rank(a.verdict)
            .cmp(&rank(b.verdict))
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

    const R1: &str = "runner-1";
    const R2: &str = "runner-2";

    /// What the box emits for a pool core answers `404` for.
    fn gone() -> Took {
        unread(
            Some(404),
            "pool 404 Not Found: Not Found: GET /api/devices/me/pool",
        )
    }

    fn bad_gateway() -> Took {
        unread(Some(502), "pool 502 Bad Gateway")
    }

    /// One daemon pass over `project`: what `take_pool_job` does with the answer.
    fn pass(d: &Path, project: &str, runner: &str, took: &Took, at: i64) {
        note(d, project, took, at);
        settle(d, project, runner, took);
    }

    /// ISS-1326, planted before the fix and red on main, where this read BLIND:
    /// a pool core answers `404` for three reads running is not a stumble that
    /// recovers, so it reads UNSERVED, and the box stops reading it.
    #[test]
    fn a_pool_the_server_answers_404_for_reads_unserved_not_blind() {
        let d = dir("planted-404");
        for i in (1..=3).rev() {
            pass(&d, P1, R1, &gone(), NOW - i * 10_000);
        }
        let c = &report(&d, NOW)[0];
        assert_eq!(c.verdict, Verdict::Unserved, "{c:?}");
        assert_eq!(c.unread_since, Some(NOW - 30_000));
        assert_eq!(c.consecutive, 3);
        assert_eq!(c.last_failure.status, Some(404));
        assert_eq!(c.recovered_at, None);
        assert!(is_held(&d, P1, R1), "the box stopped reading it");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The boundary: two `404`s are not yet three, so the pool reads BLIND and
    /// is read again; and a `502` inside the run means the run is not three.
    #[test]
    fn fewer_than_three_404s_in_a_row_stay_blind_and_are_read_again() {
        let d = dir("two-404");
        for i in (1..=2).rev() {
            pass(&d, P1, R1, &gone(), NOW - i * 10_000);
        }
        assert_eq!(report(&d, NOW)[0].verdict, Verdict::Blind);
        assert!(!is_held(&d, P1, R1));

        let d2 = dir("interrupted-404");
        for took in [gone(), gone(), bad_gateway(), gone()] {
            pass(&d2, P1, R1, &took, NOW - 10_000);
        }
        assert_eq!(report(&d2, NOW)[0].verdict, Verdict::Blind);
        assert!(!is_held(&d2, P1, R1));
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&d2);
    }

    /// The pools that are genuinely degraded keep today's behaviour: any number
    /// of `502`s and `525`s is BLIND, never held, and ends intermittent.
    #[test]
    fn a_stumbling_pool_is_never_held_however_long_it_stumbles() {
        let d = dir("stumble");
        for i in (1..=10).rev() {
            pass(&d, P1, R1, &bad_gateway(), NOW - i * 10_000);
            pass(&d, BLIND, R1, &gw525(), NOW - i * 10_000);
        }
        assert!(report(&d, NOW).iter().all(|c| c.verdict == Verdict::Blind));
        assert!(!is_held(&d, P1, R1) && !is_held(&d, BLIND, R1));
        pass(&d, P1, R1, &Took::NothingClaimable, NOW);
        let c = report(&d, NOW)
            .into_iter()
            .find(|c| c.project_id == P1)
            .unwrap();
        assert_eq!(c.verdict, Verdict::Intermittent);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The reads that settled the answer are not read again, so nothing newer
    /// ever replaces them; they must outlive the window or the row would vanish
    /// while the pool stayed unread.
    #[test]
    fn an_unserved_row_outlives_the_window_because_nothing_will_read_it_again() {
        let d = dir("unserved-ages");
        for i in (1..=3).rev() {
            pass(&d, P1, R1, &gone(), NOW - 3 * WINDOW_MS - i * 10_000);
        }
        let c = &report(&d, NOW)[0];
        assert_eq!(c.verdict, Verdict::Unserved);
        assert_eq!(c.failures, 3);
        // A restart's one probe, days on, still finds it unserved: the reads
        // that settled it are kept beside the new one, not aged away from it.
        pass(&d, P1, R1, &gone(), NOW);
        let c = &report(&d, NOW)[0];
        assert_eq!(c.verdict, Verdict::Unserved, "{c:?}");
        assert_eq!(c.failures, 3);
        assert_eq!(c.last_failure.at, NOW);
        // A project that merely stumbled does age out, as before.
        note(&d, BLIND, &gw525(), NOW - 3 * WINDOW_MS);
        assert_eq!(report(&d, NOW).len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Unserved rows sort after the blind ones and before the intermittent.
    #[test]
    fn unserved_comes_between_blind_and_intermittent() {
        let d = dir("unserved-order");
        note(&d, INTERMITTENT, &gw525(), NOW - 3 * MIN);
        note(&d, INTERMITTENT, &Took::NothingClaimable, NOW - 2 * MIN);
        for i in (1..=3).rev() {
            pass(&d, P1, R1, &gone(), NOW - 20 * MIN - i * 1000);
        }
        note(&d, BLIND, &gw525(), NOW - 30 * MIN);
        let ids: Vec<String> = report(&d, NOW).into_iter().map(|c| c.project_id).collect();
        assert_eq!(ids, vec![BLIND, P1, INTERMITTENT]);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The hold is per runner: core listing the project under another runner is
    /// the server's list changing, so it is read again, and a read that
    /// succeeds ends the condition the way any recovery does.
    #[test]
    fn a_changed_runner_is_read_again_and_a_good_read_recovers_it() {
        let d = dir("reassigned");
        for i in (1..=3).rev() {
            pass(&d, P1, R1, &gone(), NOW - i * 10_000);
        }
        assert!(is_held(&d, P1, R1));
        assert!(!is_held(&d, P1, R2), "another runner is not held");
        retain_served(&d, &[(P1, R2)]);
        assert!(!is_held(&d, P1, R1), "the hold went with the old runner");
        assert_eq!(report(&d, NOW)[0].verdict, Verdict::Unserved, "record kept");
        pass(&d, P1, R2, &Took::NothingClaimable, NOW);
        let c = &report(&d, NOW)[0];
        assert_eq!(c.verdict, Verdict::Intermittent);
        assert!(!is_held(&d, P1, R2));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A project core stops listing is not a pool this box reads: the record
    /// and the hold go whatever the verdict, and the others stay. Listed again
    /// it starts from a clean record.
    #[test]
    fn a_project_core_stops_listing_leaves_the_record_and_the_hold() {
        let d = dir("unlisted");
        for i in (1..=3).rev() {
            pass(&d, P1, R1, &gone(), NOW - i * 10_000);
        }
        pass(&d, BLIND, R1, &gw525(), NOW - 10_000);
        pass(&d, INTERMITTENT, R1, &gw525(), NOW - 20_000);
        pass(&d, INTERMITTENT, R1, &Took::NothingClaimable, NOW - 10_000);
        assert_eq!(report(&d, NOW).len(), 3);
        retain_served(&d, &[(BLIND, R1)]);
        let ids: Vec<String> = report(&d, NOW).into_iter().map(|c| c.project_id).collect();
        assert_eq!(ids, vec![BLIND], "only the listed project is left");
        assert!(!is_held(&d, P1, R1));
        pass(&d, P1, R1, &Took::NothingClaimable, NOW);
        assert_eq!(report(&d, NOW).len(), 1, "listed again, nothing is carried");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Nothing is dropped from a record when everything in it is still listed,
    /// and an unreadable record is left as it stands.
    #[test]
    fn retaining_what_is_all_listed_writes_nothing_and_a_junk_record_is_left() {
        let d = dir("retain-noop");
        note(&d, P1, &gw525(), NOW);
        let before = std::fs::read_to_string(path(&d)).unwrap();
        retain_served(&d, &[(P1, R1)]);
        assert_eq!(std::fs::read_to_string(path(&d)).unwrap(), before);
        std::fs::write(path(&d), "{not json").unwrap();
        retain_served(&d, &[]);
        assert_eq!(std::fs::read_to_string(path(&d)).unwrap(), "{not json");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The standing answer is named once, by project and by what core said.
    #[test]
    fn the_standing_404_is_named_once_and_not_on_a_later_pass() {
        let d = dir("named-once");
        let said = logged(|| {
            for i in (1..=3).rev() {
                pass(&d, P1, R1, &gone(), NOW - i * 10_000);
            }
        });
        assert_eq!(said.matches("core answered 404").count(), 1, "{said}");
        assert!(said.contains(P1), "{said}");
        assert!(
            said.contains("Not Found: GET /api/devices/me/pool"),
            "{said}"
        );
        assert!(said.contains("UNSERVED"), "{said}");
        let again = logged(|| pass(&d, P1, R1, &gone(), NOW));
        assert!(!again.contains("core answered 404"), "{again}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The hold follows the read just made, not only the record: where a
    /// probe's `502` could not be written, the file still says standing, and the
    /// project must still be read again rather than held on a stale record.
    #[test]
    fn a_stumble_whose_record_could_not_be_written_does_not_hold_the_project() {
        let d = dir("unwritable");
        for i in (1..=3).rev() {
            pass(&d, P1, R1, &gone(), NOW - i * 10_000);
        }
        retain_served(&d, &[(P1, R2)]);
        assert!(!is_held(&d, P1, R1));
        // `save` writes through a sibling named for this process; a directory
        // standing there makes the write fail and leaves the old record whole.
        let sibling = d.join(format!("pool-reads.json.{}.tmp", std::process::id()));
        std::fs::create_dir(&sibling).unwrap();
        for stumble in [bad_gateway(), gw525()] {
            pass(&d, P1, R2, &stumble, NOW);
            assert!(
                !is_held(&d, P1, R2),
                "held on a stale record after {stumble:?}"
            );
        }
        assert_eq!(
            report(&d, NOW)[0].verdict,
            Verdict::Unserved,
            "the old record stands"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A `502` before the three `404`s does not keep the project from settling:
    /// what matters is the newest three reads.
    #[test]
    fn a_stumble_before_three_404s_does_not_keep_it_from_settling() {
        let d = dir("stumble-then-404");
        pass(&d, P1, R1, &bad_gateway(), NOW - 40_000);
        for i in (1..=3).rev() {
            pass(&d, P1, R1, &gone(), NOW - i * 10_000);
        }
        assert_eq!(report(&d, NOW)[0].verdict, Verdict::Unserved);
        assert_eq!(report(&d, NOW)[0].consecutive, 4);
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
