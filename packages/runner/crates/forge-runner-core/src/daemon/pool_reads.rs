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
    for id in &refused {
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
