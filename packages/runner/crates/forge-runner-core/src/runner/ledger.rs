//! The registry of run sessions this box owns (ISS-933), and the typed shape a
//! blocked one parks in (ISS-964).
//!
//! A run is no longer a `jobs` row: core wakes a master, the master creates
//! runs, and nothing outside this box knows which worktree belongs to which
//! run. This file is that knowledge, in SQLite so it survives the master, the
//! daemon and the boot.
//!
//! Two things it is deliberately NOT. It is not a queue — no event cursor, no
//! wake bookkeeping, no "what have I processed" — because a registry that also
//! remembers progress becomes the second source of truth core already is. And
//! it is not a status string: an incarnation (is the process there) and a work
//! state (can it move) are separate columns, because the question the whole
//! design exists to answer is *waiting or dead*, and one string cannot say
//! both.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Incarnation {
    Live,
    Starting,
    Exited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    Alive,
    Dead,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevivalRefusal {
    FenceSuperseded,
    WorktreeGone,
    WorkClosed,
    NotOwed,
}

impl RevivalRefusal {
    pub fn name(self) -> &'static str {
        match self {
            RevivalRefusal::FenceSuperseded => "fence_superseded",
            RevivalRefusal::WorktreeGone => "worktree_gone",
            RevivalRefusal::WorkClosed => "work_closed",
            RevivalRefusal::NotOwed => "not_owed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Work {
    Runnable,
    Blocked,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockerKind {
    Machine,
    MasterOrPeer,
    Human,
    Nobody,
}

impl Run {
    pub fn is_parked_on_human(&self) -> bool {
        matches!(self.incarnation, Incarnation::Exited)
            && matches!(self.work, Work::Blocked)
            && matches!(self.blocker_kind, Some(BlockerKind::Human))
    }
}

impl BlockerKind {
    pub fn wire(self) -> &'static str {
        match self {
            BlockerKind::Machine => "machine",
            BlockerKind::MasterOrPeer => "master_or_peer",
            BlockerKind::Human => "human",
            BlockerKind::Nobody => "nobody",
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "machine" => Some(BlockerKind::Machine),
            "master_or_peer" => Some(BlockerKind::MasterOrPeer),
            "human" => Some(BlockerKind::Human),
            "nobody" => Some(BlockerKind::Nobody),
            _ => None,
        }
    }
}

impl Incarnation {
    pub fn wire(self) -> &'static str {
        match self {
            Incarnation::Live => "live",
            Incarnation::Starting => "starting",
            Incarnation::Exited => "exited",
        }
    }
}

impl Work {
    pub fn wire(self) -> &'static str {
        match self {
            Work::Runnable => "runnable",
            Work::Blocked => "blocked",
            Work::Done => "done",
        }
    }
}

/// A refusal as the ledger now holds it: when its streak began, and whether
/// this call is the one that began it — which is what tells a caller to say it
/// out loud rather than to say it again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refusal {
    pub since: i64,
    pub opened_the_streak: bool,
}

/// One run session: a worktree, a group of issues, and the marks that close it.
#[derive(Debug, Clone)]
pub struct Run {
    pub run_id: String,
    pub project_id: Option<String>,
    pub master_session_id: String,
    pub session_id: Option<String>,
    pub worktree_path: PathBuf,
    pub pid: Option<u32>,
    pub boot_id: String,
    pub incarnation: Incarnation,
    pub work: Work,
    pub blocker_kind: Option<BlockerKind>,
    pub waiting_on: Option<String>,
    pub resume_id: Option<String>,
    pub session_terminal_at: Option<i64>,
    pub worktree_gone_at: Option<i64>,
    pub claim_owner: Option<String>,
    pub claim_generation: i64,
    pub claim_expires_at: Option<i64>,
    pub revival_token: Option<String>,
    pub revival_deadline_at: Option<i64>,
    pub ended_by: Option<String>,
    pub ended_reason: Option<String>,
    pub agent_id: Option<String>,
    /// What a resumed master chose to do about this run: `continue`, `restart` or `leave`.
    pub resume_choice: Option<String>,
    pub resume_choice_why: Option<String>,
    /// Set when this pane was RESUMED over the run, which is what makes a choice owed.
    pub resume_owed_at: Option<i64>,
    /// When the refusal this run's release is currently standing on was FIRST
    /// seen. Cleared the moment a release gets past it, so it is the age of one
    /// streak and not a count of every refusal this run ever had.
    pub release_refused_at: Option<i64>,
    /// That refusal in its own words, kept so a person reading the row is told
    /// what the box could not answer rather than that something went wrong.
    pub release_refusal: Option<String>,
    /// When that refusal was decided to be one no retry can get past. From here
    /// the leases are back, the run is over, and the checkout is still on disk.
    pub release_terminal_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterRow {
    pub project_id: String,
    pub pane_name: String,
    pub conversation_id: Option<String>,
    /// The core session id this pane registered under, which is the key its
    /// `runs` rows carry. `None` on a row an older binary wrote, where the
    /// runs this master holds cannot be established at all.
    pub session_id: Option<String>,
    pub boot_id: String,
    pub cold_started_at: i64,
    pub last_seen_at: i64,
}

/// An owner's standing decision about one project's resident master on this
/// box: stood down until stood up again (ISS-1118).
///
/// A lifted row outlives the lifting so the next pane placed can be told the
/// interval, and is removed once it has been.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterStanding {
    pub project_id: String,
    pub slug: String,
    pub stood_down_at: i64,
    pub stood_down_by: String,
    pub why: Option<String>,
    /// `None` while the stand-down stands.
    pub stood_up_at: Option<i64>,
}

impl MasterStanding {
    /// Whether this row withholds a pane right now.
    pub fn stands(&self) -> bool {
        self.stood_up_at.is_none()
    }
}

/// What this box last established about the authority of one project's
/// resident master pane: whether the control capability that pane holds is one
/// this daemon can still resolve to the session core gives it (ISS-1099).
///
/// On disk rather than in the daemon's own registry because the state it
/// describes is produced by a restart. An in-process record of why a project
/// has no working master is erased by the very event that creates the state,
/// and the only account left was a journal line — which is what this issue's
/// Outcome says nobody should have to read.
///
/// A table of its own rather than columns on `masters`: that row is written
/// from one place, `control.rs:note_master_pane`, which is gated on the pane's
/// capability resolving. A pane in the state this records writes nothing there,
/// so a row that had to exist for the verdict to be kept would have to invent
/// the `pane_name` and `boot_id` it declares NOT NULL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterAuthority {
    pub project_id: String,
    pub slug: String,
    /// The pane the verdict was reached about.
    pub pane_name: String,
    /// Which incarnation of that name was running, as tmux's own opaque
    /// answer: the name is derived from the slug and every incarnation carries
    /// it, so the name alone identifies nothing. `None` where tmux could not be
    /// asked at the moment the verdict was reached, which is not the same as a
    /// pane that has just started — a reader that finds it `None` says it
    /// cannot tell rather than guessing either way.
    pub pane_incarnation: Option<String>,
    /// `current`, `stale` or `unknown` — the three `capability_of` answers, kept
    /// three here for the same reason they are kept three there.
    pub verdict: String,
    /// Why the answer is `unknown`, and `None` on the other two.
    pub detail: Option<String>,
    /// When this verdict was first reached. A sweep reaching the same verdict
    /// again leaves it alone, so it answers "how long has this stood".
    pub since: i64,
    pub seen_at: i64,
}

impl MasterAuthority {
    /// Some capability this box minted names the session core gives it.
    pub const CURRENT: &'static str = "current";
    /// None does, so every frame that pane sends is refused.
    pub const STALE: &'static str = "stale";
    /// This box could not read its own capability map, which is evidence about
    /// the map and not about any pane.
    pub const UNKNOWN: &'static str = "unknown";

    /// How long this verdict has stood, at the moment it was last confirmed.
    pub fn held_for(&self) -> Duration {
        Duration::from_secs(self.seen_at.saturating_sub(self.since).max(0) as u64)
    }
}

/// One issue's membership in a run, and whether its lease came back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Membership {
    pub issue_key: String,
    pub lease_returned_at: Option<i64>,
}

/// What a group creation carries. A group of one is a group.
#[derive(Debug, Clone)]
pub struct NewRun {
    pub run_id: String,
    pub project_id: String,
    pub master_session_id: String,
    pub worktree_path: PathBuf,
    pub boot_id: String,
    pub issue_keys: Vec<String>,
}

#[cfg(test)]
const RUN_COLUMNS: &[&str] = &[
    "run_id",
    "project_id",
    "master_session_id",
    "session_id",
    "worktree_path",
    "pid",
    "boot_id",
    "incarnation",
    "work",
    "blocker_kind",
    "waiting_on",
    "resume_id",
    "park_deadline_at",
    "session_terminal_at",
    "worktree_gone_at",
    "claim_owner",
    "claim_generation",
    "claim_expires_at",
    "revival_token",
    "revival_deadline_at",
    "ended_by",
    "ended_reason",
    "created_at",
    "agent_id",
    "resume_choice",
    "resume_choice_why",
    "resume_owed_at",
    "release_refused_at",
    "release_refusal",
    "release_terminal_at",
];

#[cfg(test)]
const MASTER_COLUMNS: &[&str] = &[
    "project_id",
    "pane_name",
    "conversation_id",
    "session_id",
    "boot_id",
    "cold_started_at",
    "last_seen_at",
];

#[cfg(test)]
const MASTER_STANDING_COLUMNS: &[&str] = &[
    "project_id",
    "slug",
    "stood_down_at",
    "stood_down_by",
    "why",
    "stood_up_at",
];

#[cfg(test)]
const QUESTION_COLUMNS: &[&str] = &["question_id", "run_id", "round", "asked_at"];

#[cfg(test)]
const RUN_ISSUE_COLUMNS: &[&str] = &["run_id", "issue_key", "lease_returned_at"];

#[cfg(test)]
const DECISION_COLUMNS: &[&str] = &["decision_id", "session_id", "verb", "decided_at"];

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS runs (
  run_id              TEXT PRIMARY KEY,
  project_id          TEXT,
  master_session_id   TEXT NOT NULL,
  session_id          TEXT,
  worktree_path       TEXT NOT NULL,
  pid                 INTEGER,
  boot_id             TEXT NOT NULL,
  incarnation         TEXT NOT NULL,
  work                TEXT NOT NULL,
  blocker_kind        TEXT,
  waiting_on          TEXT,
  resume_id           TEXT,
  park_deadline_at    INTEGER,
  session_terminal_at INTEGER,
  worktree_gone_at    INTEGER,
  claim_owner         TEXT,
  claim_generation    INTEGER NOT NULL DEFAULT 0,
  claim_expires_at    INTEGER,
  revival_token       TEXT,
  revival_deadline_at INTEGER,
  ended_by            TEXT,
  ended_reason        TEXT,
  created_at          INTEGER NOT NULL,
  agent_id            TEXT,
  resume_choice       TEXT,
  resume_choice_why   TEXT,
  resume_owed_at      INTEGER,
  release_refused_at  INTEGER,
  release_refusal     TEXT,
  release_terminal_at INTEGER
);
CREATE TABLE IF NOT EXISTS run_issues (
  run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  issue_key         TEXT NOT NULL,
  lease_returned_at INTEGER,
  PRIMARY KEY (run_id, issue_key)
);
CREATE TABLE IF NOT EXISTS questions (
  question_id TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  round       INTEGER NOT NULL,
  asked_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  verb        TEXT NOT NULL,
  decided_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS masters (
  project_id      TEXT PRIMARY KEY,
  pane_name       TEXT NOT NULL,
  conversation_id TEXT,
  session_id      TEXT,
  boot_id         TEXT NOT NULL,
  cold_started_at INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS master_standing (
  project_id    TEXT PRIMARY KEY,
  slug          TEXT NOT NULL,
  stood_down_at INTEGER NOT NULL,
  stood_down_by TEXT NOT NULL,
  why           TEXT,
  stood_up_at   INTEGER
);
CREATE TABLE IF NOT EXISTS master_authority (
  project_id      TEXT PRIMARY KEY,
  slug            TEXT NOT NULL,
  pane_name       TEXT NOT NULL,
  pane_incarnation TEXT,
  verdict         TEXT NOT NULL,
  detail          TEXT,
  since           INTEGER NOT NULL,
  seen_at         INTEGER NOT NULL
);
";

/// Columns a build added after the table shipped, by table. A ledger written by
/// an older binary gains them on open, so an upgraded box reads rather than
/// fails.
const ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    ("runs", "project_id", "TEXT"),
    ("runs", "claim_owner", "TEXT"),
    ("runs", "claim_generation", "INTEGER NOT NULL DEFAULT 0"),
    ("runs", "claim_expires_at", "INTEGER"),
    ("runs", "revival_token", "TEXT"),
    ("runs", "revival_deadline_at", "INTEGER"),
    ("runs", "ended_by", "TEXT"),
    ("runs", "ended_reason", "TEXT"),
    ("runs", "agent_id", "TEXT"),
    ("runs", "resume_choice", "TEXT"),
    ("runs", "resume_choice_why", "TEXT"),
    ("runs", "resume_owed_at", "INTEGER"),
    ("runs", "release_refused_at", "INTEGER"),
    ("runs", "release_refusal", "TEXT"),
    ("runs", "release_terminal_at", "INTEGER"),
    ("masters", "session_id", "TEXT"),
];

/// The ledger, open on one box.
pub struct Ledger {
    conn: Connection,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn sql_err(e: rusqlite::Error) -> Error {
    Error::Other(format!("ledger: {e}"))
}

const SELECT_RUN: &str = "SELECT run_id, project_id, master_session_id, session_id, worktree_path, pid, boot_id,
        incarnation, work, blocker_kind, waiting_on, resume_id, session_terminal_at, worktree_gone_at,
        claim_owner, claim_generation, claim_expires_at, revival_token, revival_deadline_at,
        ended_by, ended_reason, agent_id, resume_choice, resume_choice_why, resume_owed_at,
        release_refused_at, release_refusal, release_terminal_at
 FROM runs";

fn map_standing(row: &rusqlite::Row<'_>) -> rusqlite::Result<MasterStanding> {
    Ok(MasterStanding {
        project_id: row.get(0)?,
        slug: row.get(1)?,
        stood_down_at: row.get(2)?,
        stood_down_by: row.get(3)?,
        why: row.get(4)?,
        stood_up_at: row.get(5)?,
    })
}

fn map_authority(row: &rusqlite::Row<'_>) -> rusqlite::Result<MasterAuthority> {
    Ok(MasterAuthority {
        project_id: row.get(0)?,
        slug: row.get(1)?,
        pane_name: row.get(2)?,
        pane_incarnation: row.get(3)?,
        verdict: row.get(4)?,
        detail: row.get(5)?,
        since: row.get(6)?,
        seen_at: row.get(7)?,
    })
}

fn map_master(row: &rusqlite::Row<'_>) -> rusqlite::Result<MasterRow> {
    Ok(MasterRow {
        project_id: row.get(0)?,
        pane_name: row.get(1)?,
        conversation_id: row.get(2)?,
        session_id: row.get(3)?,
        boot_id: row.get(4)?,
        cold_started_at: row.get(5)?,
        last_seen_at: row.get(6)?,
    })
}

fn map_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        run_id: row.get(0)?,
        project_id: row.get(1)?,
        master_session_id: row.get(2)?,
        session_id: row.get(3)?,
        worktree_path: PathBuf::from(row.get::<_, String>(4)?),
        pid: row.get::<_, Option<i64>>(5)?.map(|p| p as u32),
        boot_id: row.get(6)?,
        incarnation: match row.get::<_, String>(7)?.as_str() {
            "live" => Incarnation::Live,
            "starting" => Incarnation::Starting,
            _ => Incarnation::Exited,
        },
        work: match row.get::<_, String>(8)?.as_str() {
            "runnable" => Work::Runnable,
            "blocked" => Work::Blocked,
            _ => Work::Done,
        },
        blocker_kind: row
            .get::<_, Option<String>>(9)?
            .and_then(|s| match s.as_str() {
                "machine" => Some(BlockerKind::Machine),
                "master_or_peer" => Some(BlockerKind::MasterOrPeer),
                "human" => Some(BlockerKind::Human),
                "nobody" => Some(BlockerKind::Nobody),
                _ => None,
            }),
        waiting_on: row.get(10)?,
        resume_id: row.get(11)?,
        session_terminal_at: row.get(12)?,
        worktree_gone_at: row.get(13)?,
        claim_owner: row.get(14)?,
        claim_generation: row.get(15)?,
        claim_expires_at: row.get(16)?,
        revival_token: row.get(17)?,
        revival_deadline_at: row.get(18)?,
        ended_by: row.get(19)?,
        ended_reason: row.get(20)?,
        agent_id: row.get(21)?,
        resume_choice: row.get(22)?,
        resume_choice_why: row.get(23)?,
        resume_owed_at: row.get(24)?,
        release_refused_at: row.get(25)?,
        release_refusal: row.get(26)?,
        release_terminal_at: row.get(27)?,
    })
}

impl Ledger {
    /// Open (and migrate) the ledger at `path`, creating its directory.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path).map_err(sql_err)?;
        Self::from_conn(conn)
    }

    /// `~/.local/share/forge-runner/ledger.sqlite`.
    pub fn default_path() -> Result<PathBuf> {
        let dir = dirs_next::data_dir()
            .ok_or_else(|| Error::Other("ledger: cannot resolve OS data dir".into()))?;
        Ok(dir.join("forge-runner").join("ledger.sqlite"))
    }

    /// An in-memory ledger, for tests that must not touch the box.
    pub fn open_in_memory() -> Result<Self> {
        Self::from_conn(Connection::open_in_memory().map_err(sql_err)?)
    }

    fn from_conn(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
            .map_err(sql_err)?;
        conn.execute_batch(SCHEMA).map_err(sql_err)?;
        Self::add_missing_columns(&conn)?;
        Ok(Self { conn })
    }

    pub fn create_run_group(&mut self, new: NewRun) -> Result<Run> {
        if new.issue_keys.is_empty() {
            return Err(Error::Other(
                "ledger: a run must carry at least one issue".into(),
            ));
        }
        let tx = self.conn.transaction().map_err(sql_err)?;
        for key in &new.issue_keys {
            if let Some(holder) = Self::live_run_holding(&tx, key, &new.boot_id)? {
                return Err(Error::Other(format!(
                    "ledger: issue {key} already belongs to live run {holder}"
                )));
            }
        }
        let path = new.worktree_path.to_string_lossy().to_string();
        if let Some(holder) = Self::live_run_at_path(&tx, &path, &new.boot_id)? {
            return Err(Error::Other(format!(
                "ledger: worktree {path} is already held by live run {holder}"
            )));
        }
        if let Some(pending) = Self::unbound_run_of(&tx, &new.master_session_id, &new.boot_id)? {
            return Err(Error::Other(format!(
                "ledger: run {pending} is declared under this master and no subagent has bound it yet — close it before declaring another"
            )));
        }
        tx.execute(
            "INSERT INTO runs (run_id, project_id, master_session_id, worktree_path, pid, boot_id, incarnation, work, created_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8)",
            params![
                new.run_id,
                new.project_id,
                new.master_session_id,
                path,
                new.boot_id,
                Incarnation::Live.wire(),
                Work::Runnable.wire(),
                now()
            ],
        )
        .map_err(sql_err)?;
        for key in &new.issue_keys {
            tx.execute(
                "INSERT INTO run_issues (run_id, issue_key) VALUES (?1, ?2)",
                params![new.run_id, key],
            )
            .map_err(sql_err)?;
        }
        tx.commit().map_err(sql_err)?;
        self.run(&new.run_id)?
            .ok_or_else(|| Error::Other("ledger: run vanished after commit".into()))
    }

    fn live_run_holding(
        tx: &rusqlite::Transaction<'_>,
        issue_key: &str,
        boot_id: &str,
    ) -> Result<Option<String>> {
        tx.query_row(
            "SELECT r.run_id FROM runs r JOIN run_issues i ON i.run_id = r.run_id
             WHERE i.issue_key = ?1 AND r.incarnation = 'live' AND r.boot_id = ?2
             LIMIT 1",
            params![issue_key, boot_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_err)
    }

    fn unbound_run_of(
        tx: &rusqlite::Transaction<'_>,
        master_session_id: &str,
        boot_id: &str,
    ) -> Result<Option<String>> {
        tx.query_row(
            "SELECT run_id FROM runs
              WHERE master_session_id = ?1 AND boot_id = ?2 AND agent_id IS NULL AND ended_by IS NULL
              ORDER BY created_at LIMIT 1",
            params![master_session_id, boot_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_err)
    }

    fn live_run_at_path(
        tx: &rusqlite::Transaction<'_>,
        path: &str,
        boot_id: &str,
    ) -> Result<Option<String>> {
        let wanted = std::fs::canonicalize(path).ok();
        let mut stmt = tx
            .prepare(
                "SELECT run_id, worktree_path FROM runs
                  WHERE incarnation = 'live' AND boot_id = ?1",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![boot_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(sql_err)?;
        for row in rows {
            let (run_id, held) = row.map_err(sql_err)?;
            if held == path {
                return Ok(Some(run_id));
            }
            if let (Some(w), Ok(h)) = (wanted.as_ref(), std::fs::canonicalize(&held)) {
                if &h == w {
                    return Ok(Some(run_id));
                }
            }
        }
        Ok(None)
    }

    pub fn held_worktrees(&self) -> Result<Vec<(PathBuf, String)>> {
        let mut stmt = self
            .conn
            // A checkout the release terminally refused to remove is not the
            // reaper's to remove either: the same refusal binds both, and
            // ending the run is what would otherwise hand it over (ISS-1188).
            .prepare(
                "SELECT worktree_path, run_id FROM runs
                  WHERE ended_by IS NULL OR release_terminal_at IS NOT NULL",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    PathBuf::from(row.get::<_, String>(0)?),
                    row.get::<_, String>(1)?,
                ))
            })
            .map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// One run by id.
    pub fn run(&self, run_id: &str) -> Result<Option<Run>> {
        self.conn
            .query_row(
                &format!("{SELECT_RUN} WHERE run_id = ?1"),
                params![run_id],
                map_run,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Every run whose close loop still has something owed.
    ///
    /// A run whose release was decided terminal leaves as soon as its leases
    /// are back, and not before: its checkout is staying on disk by decision,
    /// so `worktree_gone_at` will never be stamped and reading the three marks
    /// alone would keep answering "still owed" every sweep for ever. The leases
    /// are the half that must still be chased, because a lease nobody returns
    /// is an issue no run on this box can take (ISS-1188).
    pub fn unclosed_runs(&self) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE (session_terminal_at IS NULL OR worktree_gone_at IS NULL
                 OR run_id IN (SELECT run_id FROM run_issues WHERE lease_returned_at IS NULL))
                 AND (release_terminal_at IS NULL
                 OR run_id IN (SELECT run_id FROM run_issues WHERE lease_returned_at IS NULL))
                 ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt.query_map([], map_run).map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    pub fn reparent_run(&mut self, run_id: &str, master_session_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET master_session_id = ?2 WHERE run_id = ?1",
                params![run_id, master_session_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn runs_for_master(&self, master_session_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE master_session_id = ?1 ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![master_session_id], map_run)
            .map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    pub fn attach_session(&self, run_id: &str, session_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET session_id = ?2 WHERE run_id = ?1",
                params![run_id, session_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn bind_agent(&self, run_id: &str, agent_id: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET agent_id = ?2
                  WHERE run_id = ?1 AND agent_id IS NULL
                    AND NOT EXISTS (SELECT 1 FROM runs o WHERE o.agent_id = ?2)",
                params![run_id, agent_id],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// The run this master declared that no subagent has bound yet, if any.
    pub fn unbound_run_for_master(
        &self,
        master_session_id: &str,
        boot_id: &str,
    ) -> Result<Option<Run>> {
        self.conn
            .query_row(
                &format!("{SELECT_RUN} WHERE master_session_id = ?1 AND boot_id = ?2 AND agent_id IS NULL AND ended_by IS NULL ORDER BY created_at LIMIT 1"),
                params![master_session_id, boot_id],
                map_run,
            )
            .optional()
            .map_err(sql_err)
    }

    pub fn ended_with_open_session(&self, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE boot_id = ?1 AND ended_by IS NOT NULL AND session_id IS NOT NULL
                   AND session_terminal_at IS NULL ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt.query_map(params![boot_id], map_run).map_err(sql_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(sql_err)?);
        }
        Ok(out)
    }

    pub fn declared_without_session(&self, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE boot_id = ?1 AND session_id IS NULL AND ended_by IS NULL ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt.query_map(params![boot_id], map_run).map_err(sql_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(sql_err)?);
        }
        Ok(out)
    }

    /// The run bound to this subagent, if one is.
    pub fn run_for_agent(&self, agent_id: &str) -> Result<Option<Run>> {
        self.conn
            .query_row(
                &format!("{SELECT_RUN} WHERE agent_id = ?1 AND ended_by IS NULL LIMIT 1"),
                params![agent_id],
                map_run,
            )
            .optional()
            .map_err(sql_err)
    }

    pub fn record_resume_choice(
        &self,
        run_id: &str,
        master_session_id: &str,
        choice: &str,
        why: &str,
    ) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET resume_choice = ?3, resume_choice_why = ?4
                  WHERE run_id = ?1 AND master_session_id = ?2
                    AND resume_owed_at IS NOT NULL",
                params![run_id, master_session_id, choice, why],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    pub fn owe_resume_choices(&self, master_session_id: &str, boot_id: &str) -> Result<usize> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET resume_owed_at = ?3
                  WHERE master_session_id = ?1 AND boot_id = ?2
                    AND ended_by IS NULL AND resume_choice IS NULL",
                params![master_session_id, boot_id, now()],
            )
            .map_err(sql_err)?;
        Ok(n)
    }

    pub fn choices_awaiting_report(&self, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE boot_id = ?1
                   AND resume_owed_at IS NOT NULL AND resume_choice IS NOT NULL"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![boot_id], map_run)
            .map_err(sql_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_err)?;
        Ok(rows)
    }

    pub fn mark_resume_choice_said(&self, run_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET resume_owed_at = NULL WHERE run_id = ?1",
                params![run_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn runs_awaiting_choice(&self, master_session_id: &str, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE master_session_id = ?1 AND boot_id = ?2
                   AND resume_owed_at IS NOT NULL AND resume_choice IS NULL"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![master_session_id, boot_id], map_run)
            .map_err(sql_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_err)?;
        Ok(rows)
    }

    pub fn note_master(
        &self,
        project_id: &str,
        pane_name: &str,
        conversation_id: Option<&str>,
        session_id: Option<&str>,
        boot_id: &str,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO masters (project_id, pane_name, conversation_id, session_id, boot_id, cold_started_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(project_id) DO UPDATE SET
                   pane_name       = excluded.pane_name,
                   conversation_id = COALESCE(excluded.conversation_id, masters.conversation_id),
                   session_id      = COALESCE(excluded.session_id, masters.session_id),
                   boot_id         = excluded.boot_id,
                   last_seen_at    = excluded.last_seen_at",
                params![project_id, pane_name, conversation_id, session_id, boot_id, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// What this box knows about one project's master pane.
    pub fn master_for_project(&self, project_id: &str) -> Result<Option<MasterRow>> {
        self.conn
            .query_row(
                "SELECT project_id, pane_name, conversation_id, session_id, boot_id, cold_started_at, last_seen_at
                 FROM masters WHERE project_id = ?1",
                params![project_id],
                map_master,
            )
            .optional()
            .map_err(sql_err)
    }

    /// The master row whose pane carries this name, which is how a command
    /// holding only a slug reaches the project id.
    pub fn master_for_pane(&self, pane_name: &str) -> Result<Option<MasterRow>> {
        self.conn
            .query_row(
                "SELECT project_id, pane_name, conversation_id, session_id, boot_id, cold_started_at, last_seen_at
                 FROM masters WHERE pane_name = ?1",
                params![pane_name],
                map_master,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Record that this project's resident master is stood down until somebody
    /// stands it up again. Re-recording an already-standing stand-down keeps
    /// the original timestamp, so the interval a pane is later told is the
    /// whole of it.
    pub fn stand_down_master(
        &self,
        project_id: &str,
        slug: &str,
        by: &str,
        why: Option<&str>,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO master_standing (project_id, slug, stood_down_at, stood_down_by, why, stood_up_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL)
                 ON CONFLICT(project_id) DO UPDATE SET
                   slug          = excluded.slug,
                   stood_down_at = CASE WHEN master_standing.stood_up_at IS NULL
                                        THEN master_standing.stood_down_at
                                        ELSE excluded.stood_down_at END,
                   stood_down_by = excluded.stood_down_by,
                   why           = excluded.why,
                   stood_up_at   = NULL",
                params![project_id, slug, now(), by, why],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Lift a stand-down. The row stays, carrying the interval, until a pane
    /// has been told it. Answers whether a standing stand-down was lifted.
    pub fn stand_up_master(&self, project_id: &str) -> Result<bool> {
        let changed = self
            .conn
            .execute(
                "UPDATE master_standing SET stood_up_at = ?2
                 WHERE project_id = ?1 AND stood_up_at IS NULL",
                params![project_id, now()],
            )
            .map_err(sql_err)?;
        Ok(changed > 0)
    }

    /// The standing decision about this project's master, standing or lifted.
    pub fn master_standing(&self, project_id: &str) -> Result<Option<MasterStanding>> {
        self.conn
            .query_row(
                "SELECT project_id, slug, stood_down_at, stood_down_by, why, stood_up_at
                 FROM master_standing WHERE project_id = ?1",
                params![project_id],
                map_standing,
            )
            .optional()
            .map_err(sql_err)
    }

    /// The standing for the project this box knows by this slug.
    ///
    /// Keyed by slug and not by project id because a command, and `status`,
    /// may hold only the slug — and a stand-down can be recorded for a project
    /// this box has never placed a master for, which is exactly the case a
    /// lookup going through the `masters` row cannot see.
    pub fn master_standing_for_slug(&self, slug: &str) -> Result<Option<MasterStanding>> {
        self.conn
            .query_row(
                "SELECT project_id, slug, stood_down_at, stood_down_by, why, stood_up_at
                 FROM master_standing WHERE slug = ?1",
                params![slug],
                map_standing,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Every project this box is holding a standing decision about.
    pub fn standings(&self) -> Result<Vec<MasterStanding>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT project_id, slug, stood_down_at, stood_down_by, why, stood_up_at
                 FROM master_standing ORDER BY slug",
            )
            .map_err(sql_err)?;
        let rows = stmt.query_map([], map_standing).map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// Record what this box has just established about a project's master
    /// pane authority.
    ///
    /// `since` moves only when the answer moves — a different verdict, or the
    /// same verdict about a different pane. A sweep that reaches the same
    /// verdict about the same pane refreshes `seen_at` alone, so the pair says
    /// how long this has stood rather than how recently it was looked at. That
    /// interval is the whole point: the incident this issue was filed from ran
    /// for four hours and nothing on the box could say so (ISS-1099).
    pub fn note_master_authority(
        &self,
        project_id: &str,
        slug: &str,
        pane: (&str, Option<&str>),
        verdict: &str,
        detail: Option<&str>,
    ) -> Result<()> {
        let (pane_name, pane_incarnation) = pane;
        self.conn
            .execute(
                "INSERT INTO master_authority (project_id, slug, pane_name, pane_incarnation, verdict, detail, since, seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(project_id) DO UPDATE SET
                   slug            = excluded.slug,
                   pane_name       = excluded.pane_name,
                   pane_incarnation = excluded.pane_incarnation,
                   verdict         = excluded.verdict,
                   detail          = excluded.detail,
                   since           = CASE WHEN master_authority.verdict         =  excluded.verdict
                                           AND master_authority.pane_name       =  excluded.pane_name
                                           AND master_authority.pane_incarnation IS excluded.pane_incarnation
                                          THEN master_authority.since
                                          ELSE excluded.since END,
                   seen_at         = excluded.seen_at",
                params![project_id, slug, pane_name, pane_incarnation, verdict, detail, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// The authority verdict for the project this box knows by this slug.
    ///
    /// Keyed by slug for the reason `master_standing_for_slug` is: a command,
    /// and `master status`, may hold only the slug.
    pub fn master_authority_for_slug(&self, slug: &str) -> Result<Option<MasterAuthority>> {
        self.conn
            .query_row(
                "SELECT project_id, slug, pane_name, pane_incarnation, verdict, detail, since, seen_at
                 FROM master_authority WHERE slug = ?1",
                params![slug],
                map_authority,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Every project this box holds an authority verdict about.
    pub fn authorities(&self) -> Result<Vec<MasterAuthority>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT project_id, slug, pane_name, pane_incarnation, verdict, detail, since, seen_at
                 FROM master_authority ORDER BY slug",
            )
            .map_err(sql_err)?;
        let rows = stmt.query_map([], map_authority).map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// Drop a lifted stand-down, once the pane it was kept for has been told
    /// the interval. A standing one is never dropped by this.
    pub fn forget_lifted_standing(&self, project_id: &str) -> Result<()> {
        self.conn
            .execute(
                "DELETE FROM master_standing WHERE project_id = ?1 AND stood_up_at IS NOT NULL",
                params![project_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Clear the conversation this project's next pane would resume, so it
    /// cold-starts instead.
    pub fn forget_master_conversation(&self, project_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE masters SET conversation_id = NULL WHERE project_id = ?1",
                params![project_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    #[cfg(test)]
    pub fn attach_pid(&self, run_id: &str, pid: u32) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET pid = ?2 WHERE run_id = ?1",
                params![run_id, pid as i64],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn mark_session_terminal_observed(&self, run_id: &str) -> Result<()> {
        self.stamp("session_terminal_at", run_id)
    }

    /// Stamp *worktree gone*, once the filesystem said the path is absent.
    pub fn mark_worktree_gone_observed(&self, run_id: &str) -> Result<()> {
        self.stamp("worktree_gone_at", run_id)
    }

    fn stamp(&self, column: &str, run_id: &str) -> Result<()> {
        debug_assert!(matches!(column, "session_terminal_at" | "worktree_gone_at"));
        self.conn
            .execute(
                &format!("UPDATE runs SET {column} = ?2 WHERE run_id = ?1 AND {column} IS NULL"),
                params![run_id, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn mark_lease_returned_observed(&self, run_id: &str, issue_key: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE run_issues SET lease_returned_at = ?3
                 WHERE run_id = ?1 AND issue_key = ?2 AND lease_returned_at IS NULL",
                params![run_id, issue_key, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Seed a row the public API cannot produce, so a reader's refusal path is reachable.
    #[cfg(test)]
    pub(crate) fn exec_for_test(&self, sql: &str) {
        self.conn.execute_batch(sql).unwrap();
    }

    fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(sql_err)?;
        let mut have = Vec::new();
        for r in rows {
            have.push(r.map_err(sql_err)?);
        }
        Ok(have)
    }

    /// Bring a ledger written by an earlier build up to this build's shape.
    ///
    /// Named by table rather than assuming `runs`: `masters` gained a column
    /// too, and a migration that can only reach one table would have left an
    /// upgraded box unable to say which runs its resident master holds.
    fn add_missing_columns(conn: &Connection) -> Result<()> {
        let mut known: Vec<(&str, Vec<String>)> = Vec::new();
        for (table, name, ty) in ADDED_COLUMNS {
            if !known.iter().any(|(t, _)| t == table) {
                known.push((table, Self::column_names(conn, table)?));
            }
            let have = known
                .iter_mut()
                .find(|(t, _)| t == table)
                .map(|(_, c)| c)
                .expect("the table's columns were just read");
            if !have.iter().any(|c| c == name) {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {name} {ty};"))
                    .map_err(sql_err)?;
                have.push((*name).to_string());
            }
        }
        Ok(())
    }

    pub fn liveness(run: &Run, this_boot: &str, pid_refuted: bool) -> Liveness {
        if run.boot_id != this_boot {
            return Liveness::Unknown;
        }
        match (run.incarnation, run.pid) {
            (Incarnation::Live | Incarnation::Starting, Some(_)) if !pid_refuted => Liveness::Alive,
            (Incarnation::Live | Incarnation::Starting, Some(_)) => Liveness::Dead,
            (Incarnation::Exited, _) => Liveness::Dead,
            (_, None) => Liveness::Unknown,
        }
    }

    pub fn begin_question(
        &mut self,
        question_id: &str,
        run_id: &str,
        round: i64,
        waiting_on: &str,
    ) -> Result<()> {
        let tx = self.conn.transaction().map_err(sql_err)?;
        let changed = tx
            .execute(
                "UPDATE runs SET waiting_on = ?2 WHERE run_id = ?1 AND work <> 'done'",
                params![run_id, waiting_on],
            )
            .map_err(sql_err)?;
        if changed == 0 {
            return Err(Error::Other(format!(
                "ledger: run {run_id} is unknown or already done — a finished run cannot ask"
            )));
        }
        tx.execute(
            "INSERT OR IGNORE INTO questions (question_id, run_id, round, asked_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![question_id, run_id, round, now()],
        )
        .map_err(sql_err)?;
        tx.commit().map_err(sql_err)?;
        Ok(())
    }

    pub fn record_decision(&self, decision_id: &str, session_id: &str, verb: &str) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO decisions (decision_id, session_id, verb, decided_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![decision_id, session_id, verb, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn asks_and_decisions(&self, session_id: &str) -> Result<(i64, i64)> {
        let asked: i64 = self
            .conn
            .query_row(
                "SELECT count(*) FROM questions q JOIN runs r ON r.run_id = q.run_id
                 WHERE r.master_session_id = ?1",
                params![session_id],
                |r| r.get(0),
            )
            .map_err(sql_err)?;
        let decided: i64 = self
            .conn
            .query_row(
                "SELECT count(*) FROM decisions WHERE session_id = ?1",
                params![session_id],
                |r| r.get(0),
            )
            .map_err(sql_err)?;
        Ok((asked, decided))
    }

    pub fn declare_blocked_live(
        &self,
        run_id: &str,
        blocker: BlockerKind,
        resume_id: Option<&str>,
        park_deadline_at: Option<i64>,
        _ear: &crate::runner::doorbell::Listening,
    ) -> Result<Incarnation> {
        let kind = match blocker {
            BlockerKind::Machine => "machine",
            BlockerKind::MasterOrPeer => "master_or_peer",
            BlockerKind::Human => {
                return Err(Error::Other(
                    "ledger: a human block releases the process, so it cannot be declared live — use `declare_parked_human`".into(),
                ))
            }
            BlockerKind::Nobody => {
                return Err(Error::Other(
                    "ledger: a `nobody` blocker terminates the run with a named reason and writes no question".into(),
                ))
            }
        };
        self.declare(run_id, kind, Incarnation::Live, resume_id, park_deadline_at)
    }

    pub fn declare_parked_human(
        &self,
        run_id: &str,
        resume_id: Option<&str>,
        park_deadline_at: Option<i64>,
    ) -> Result<Incarnation> {
        self.declare(
            run_id,
            "human",
            Incarnation::Exited,
            resume_id,
            park_deadline_at,
        )
    }

    fn declare(
        &self,
        run_id: &str,
        kind: &str,
        incarnation: Incarnation,
        resume_id: Option<&str>,
        park_deadline_at: Option<i64>,
    ) -> Result<Incarnation> {
        let changed = self
            .conn
            .execute(
                "UPDATE runs SET work = ?2, blocker_kind = ?3, resume_id = ?4,
                        park_deadline_at = ?5, incarnation = ?6
                 WHERE run_id = ?1 AND work <> 'done'",
                params![
                    run_id,
                    Work::Blocked.wire(),
                    kind,
                    resume_id,
                    park_deadline_at,
                    incarnation.wire()
                ],
            )
            .map_err(sql_err)?;
        if changed == 0 {
            return Err(Error::Other(format!(
                "ledger: run {run_id} is unknown or already done — a finished run cannot park"
            )));
        }
        Ok(incarnation)
    }

    /// The rounds asked on one run, oldest first.
    pub fn questions_for(&self, run_id: &str) -> Result<Vec<(String, i64)>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT question_id, round FROM questions WHERE run_id = ?1 ORDER BY asked_at, round",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![run_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    pub fn hold_claim(&self, run_id: &str, owner: &str, expires_at: i64) -> Result<i64> {
        self.conn
            .execute(
                "UPDATE runs SET claim_owner = ?2, claim_expires_at = ?3 WHERE run_id = ?1",
                params![run_id, owner, expires_at],
            )
            .map_err(sql_err)?;
        self.generation_of(run_id)
    }

    /// Take ownership away, and make every claim presented under it stale.
    pub fn revoke_claim(&self, run_id: &str) -> Result<i64> {
        self.conn
            .execute(
                "UPDATE runs SET claim_owner = NULL, claim_expires_at = NULL,
                        claim_generation = claim_generation + 1
                 WHERE run_id = ?1",
                params![run_id],
            )
            .map_err(sql_err)?;
        self.generation_of(run_id)
    }

    fn generation_of(&self, run_id: &str) -> Result<i64> {
        self.conn
            .query_row(
                "SELECT claim_generation FROM runs WHERE run_id = ?1",
                params![run_id],
                |r| r.get(0),
            )
            .map_err(sql_err)
    }

    pub fn answer_arrived(&self, run_id: &str) -> Result<bool> {
        let changed = self
            .conn
            .execute(
                "UPDATE runs SET work = 'runnable', waiting_on = NULL
                 WHERE run_id = ?1 AND work = 'blocked'",
                params![run_id],
            )
            .map_err(sql_err)?;
        Ok(changed == 1)
    }

    pub fn begin_revival(
        &self,
        run_id: &str,
        generation: i64,
        token: &str,
        deadline_at: i64,
    ) -> std::result::Result<(), RevivalRefusal> {
        let run = match self.run(run_id) {
            Ok(Some(r)) => r,
            _ => return Err(RevivalRefusal::NotOwed),
        };
        if run.claim_generation != generation {
            return Err(RevivalRefusal::FenceSuperseded);
        }
        if run.worktree_gone_at.is_some() {
            return Err(RevivalRefusal::WorktreeGone);
        }
        if matches!(run.work, Work::Done) {
            return Err(RevivalRefusal::WorkClosed);
        }
        let changed = self
            .conn
            .execute(
                "UPDATE runs SET incarnation = 'starting', revival_token = ?2, revival_deadline_at = ?3
                 WHERE run_id = ?1 AND incarnation = 'exited' AND work = 'runnable'
                   AND claim_generation = ?4",
                params![run_id, token, deadline_at, generation],
            )
            .map_err(|_| RevivalRefusal::NotOwed)?;
        if changed == 1 {
            Ok(())
        } else {
            Err(RevivalRefusal::NotOwed)
        }
    }

    pub fn revival_failed(&self, run_id: &str, token: &str) -> Result<bool> {
        let changed = self
            .conn
            .execute(
                "UPDATE runs SET incarnation = 'exited', revival_token = NULL,
                        revival_deadline_at = NULL
                 WHERE run_id = ?1 AND incarnation = 'starting' AND revival_token = ?2",
                params![run_id, token],
            )
            .map_err(sql_err)?;
        Ok(changed == 1)
    }

    pub fn reset_expired_revivals(&self, now_at: i64) -> Result<usize> {
        self.conn
            .execute(
                "UPDATE runs SET incarnation = 'exited', revival_token = NULL,
                        revival_deadline_at = NULL
                 WHERE incarnation = 'starting' AND revival_deadline_at IS NOT NULL
                   AND revival_deadline_at <= ?1",
                params![now_at],
            )
            .map_err(sql_err)
    }

    /// Close a run on the record, with who ended it and why.
    /// Record that this run's release was refused, and answer WHEN the streak
    /// it belongs to began — which is this refusal's own stamp where it is the
    /// first, and the earlier one where it is not.
    ///
    /// The stamp is in the ledger rather than in the daemon's memory so that a
    /// restart inside the window resumes the refusal's age instead of starting
    /// it again, which is how a run kept its leases across restarts for as long
    /// as the box lived.
    ///
    /// A stamp LATER than the clock now reading it is a clock that moved
    /// backwards — ntp correcting a box that booted with a bad RTC is the
    /// ordinary way — and it is pulled back to now rather than kept. Kept, it
    /// would put the end of the window that many seconds further away every
    /// sweep until the clock caught up, which is this issue's own defect in
    /// miniature: a decision deferred for as long as an input stays where it
    /// is. Pulled back, the window ends within the grace of the correction
    /// whatever the jump was. The other direction is left alone: a clock
    /// jumping FORWARD past the window decides the refusal early, and deciding
    /// early is the safe end of that trade — the leases come back and the
    /// checkout is untouched.
    pub fn note_release_refusal(&mut self, run_id: &str, why: &str, at: i64) -> Result<Refusal> {
        self.conn
            .execute(
                "UPDATE runs SET release_refusal = ?2,
                        release_refused_at = MIN(COALESCE(release_refused_at, ?3), ?3)
                  WHERE run_id = ?1",
                params![run_id, why, at],
            )
            .map_err(sql_err)?;
        let since: Option<i64> = self
            .conn
            .query_row(
                "SELECT release_refused_at FROM runs WHERE run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_err)?
            .flatten();
        let since = since.unwrap_or(at);
        Ok(Refusal {
            since,
            opened_the_streak: since == at,
        })
    }

    /// Say this refusal is one no retry gets past.
    pub fn mark_release_terminal(&mut self, run_id: &str, at: i64) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET release_terminal_at = ?2 WHERE run_id = ?1",
                params![run_id, at],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Forget a refusal: a release got past it, or an operator is asking for
    /// the next sweep to try again. Answers whether the row carried one.
    pub fn clear_release_refusal(&mut self, run_id: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET release_refused_at = NULL, release_refusal = NULL,
                        release_terminal_at = NULL
                  WHERE run_id = ?1
                    AND (release_refused_at IS NOT NULL OR release_terminal_at IS NOT NULL)",
                params![run_id],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    pub fn end_run(&self, run_id: &str, ended_by: &str, reason: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET work = 'done', incarnation = 'exited', ended_by = ?2,
                        ended_reason = ?3
                 WHERE run_id = ?1",
                params![run_id, ended_by, reason],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn issues(&self, run_id: &str) -> Result<Vec<Membership>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT issue_key, lease_returned_at FROM run_issues WHERE run_id = ?1 ORDER BY issue_key",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![run_id], |row| {
                Ok(Membership {
                    issue_key: row.get(0)?,
                    lease_returned_at: row.get(1)?,
                })
            })
            .map_err(sql_err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::blocked::Wait;

    const SOURCE: &str = include_str!("ledger.rs");

    /// The human park in one call, as the old `park` was, so the cases below
    /// keep asserting the branch rather than the new call shape.
    fn park_human(
        led: &mut Ledger,
        run_id: &str,
        q: &str,
        resume: Option<&str>,
        deadline: Option<i64>,
    ) -> Result<Incarnation> {
        crate::runner::blocked::park_for_human(
            led,
            crate::runner::blocked::Wait {
                run_id,
                question_id: q,
                round: 1,
                blocker: BlockerKind::Human,
                resume_id: resume,
                park_deadline_at: deadline,
            },
            &crate::runner::blocked::ParkPermit::from_advertisement(
                &crate::runner::blocked::PROTECTIONS_FROM_CORE
                    .iter()
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>(),
            )
            .unwrap(),
        )
    }

    fn seed(issues: &[&str]) -> NewRun {
        NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: PathBuf::from("/w/one"),
            boot_id: "boot-a".into(),
            issue_keys: issues.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    fn columns(led: &Ledger, table: &str) -> Vec<String> {
        let mut stmt = led
            .conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let mut cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        cols.sort();
        cols
    }

    #[test]
    fn the_ledger_is_a_registry_and_cannot_grow_a_second_purpose() {
        let led = Ledger::open_in_memory().unwrap();
        let mut declared: Vec<String> = RUN_COLUMNS.iter().map(|s| (*s).to_string()).collect();
        declared.sort();
        assert_eq!(
            columns(&led, "runs"),
            declared,
            "the `runs` table has a column the declared registry does not name — if this is an event cursor or wake bookkeeping, the ledger has become a queue (ISS-933 criterion 10)"
        );
        let mut declared_issues: Vec<String> =
            RUN_ISSUE_COLUMNS.iter().map(|s| (*s).to_string()).collect();
        declared_issues.sort();
        assert_eq!(columns(&led, "run_issues"), declared_issues);
        let mut declared_decisions: Vec<String> =
            DECISION_COLUMNS.iter().map(|s| (*s).to_string()).collect();
        declared_decisions.sort();
        assert_eq!(columns(&led, "decisions"), declared_decisions);
        let mut declared_masters: Vec<String> =
            MASTER_COLUMNS.iter().map(|s| (*s).to_string()).collect();
        declared_masters.sort();
        assert_eq!(
            columns(&led, "masters"),
            declared_masters,
            "the `masters` table has a column the declared registry does not name — this table holds what a box knows about a pane, and a column beyond that is the ledger growing a second purpose (ISS-933 criterion 10, ISS-1050)"
        );
        let mut declared_standing: Vec<String> = MASTER_STANDING_COLUMNS
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        declared_standing.sort();
        assert_eq!(
            columns(&led, "master_standing"),
            declared_standing,
            "the `master_standing` table holds one owner decision per project and nothing about what a pane is doing (ISS-1118)"
        );

        for banned in ["cursor", "last_event", "offset", "wake", "processed", "seq"] {
            assert!(
                !RUN_COLUMNS.iter().any(|c| c.contains(banned))
                    && !RUN_ISSUE_COLUMNS.iter().any(|c| c.contains(banned)),
                "column naming `{banned}` makes this a queue, not a registry (ISS-933 criterion 10)"
            );
        }
    }

    #[test]
    fn exactly_one_creation_path_is_exported() {
        let exported: Vec<&str> = SOURCE
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("pub fn ") || l.starts_with("pub async fn "))
            .collect();
        let creators: Vec<&&str> = exported
            .iter()
            .filter(|l| l.contains("create") || l.contains("new_run") || l.contains("insert"))
            .collect();
        assert_eq!(
            creators.len(),
            1,
            "exactly one creation path may be public so a group of one takes the SAME path as a group of three (ISS-933 criterion 8); found: {creators:?}"
        );
        assert!(
            creators[0].contains("create_run_group"),
            "the one public creator must be the GROUP creator, not a scalar one: {:?}",
            creators[0]
        );
    }

    #[test]
    fn a_run_carries_a_group_as_many_to_many_rows() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-957", "ISS-963", "ISS-901"]))
            .unwrap();
        let issues = led.issues("run-1").unwrap();
        assert_eq!(issues.len(), 3);
        assert_eq!(
            issues
                .iter()
                .map(|m| m.issue_key.as_str())
                .collect::<Vec<_>>(),
            vec!["ISS-901", "ISS-957", "ISS-963"]
        );
        assert!(issues.iter().all(|m| m.lease_returned_at.is_none()));
    }

    #[test]
    fn a_group_of_one_is_a_group() {
        let mut led = Ledger::open_in_memory().unwrap();
        let run = led.create_run_group(seed(&["ISS-932"])).unwrap();
        assert_eq!(run.work, Work::Runnable);
        assert_eq!(run.incarnation, Incarnation::Live);
        assert_eq!(led.issues("run-1").unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_second_run_at_the_same_tree_by_another_name_is_refused() {
        let real = std::env::temp_dir().join(format!("forge-ledger-path-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&real);
        std::fs::create_dir_all(&real).unwrap();
        let link = real.with_extension("served");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let mut led = Ledger::open_in_memory().unwrap();
        let mut first = seed(&["ISS-964"]);
        first.worktree_path = link.clone();
        led.create_run_group(first).unwrap();

        let mut second = seed(&["ISS-970"]);
        second.run_id = "run-2".into();
        second.worktree_path = real.clone();
        let err = led
            .create_run_group(second)
            .expect_err("the same directory under a second spelling must be refused")
            .to_string();
        assert!(
            err.contains("run-1"),
            "the refusal must name the holder: {err}"
        );
        assert!(led.run("run-2").unwrap().is_none());

        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&real);
    }

    #[test]
    fn a_second_live_run_over_one_issue_is_refused_naming_the_holder() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-957", "ISS-963"])).unwrap();
        let mut second = seed(&["ISS-963"]);
        second.run_id = "run-2".into();
        second.worktree_path = PathBuf::from("/w/two");
        let err = led
            .create_run_group(second)
            .expect_err("an issue already carried by a live run must be REFUSED, never silently reassigned to a second run — two runs holding one issue is a state the ledger exists to make unwritable (ISS-933 criterion 9)")
            .to_string();
        assert!(
            err.contains("ISS-963"),
            "the refusal must name the issue: {err}"
        );
        assert!(
            err.contains("run-1"),
            "the refusal must name the run that holds it, so the reader knows where the work already is: {err}"
        );
        assert!(led.run("run-2").unwrap().is_none());
    }

    #[test]
    fn a_decision_taken_instead_of_asked_is_recorded_and_countable() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-957"])).unwrap();
        led.record_decision("dec-1", "master-1", "git push of the run's own branch")
            .unwrap();
        led.record_decision("dec-2", "master-1", "forge status transition")
            .unwrap();
        assert_eq!(
            led.asks_and_decisions("master-1").unwrap(),
            (0, 2),
            "a design that records only asked questions leaves `this master asks too much` a feeling: the denominator is what makes it a ratio (ISS-964 criterion 2)"
        );
    }

    #[test]
    fn the_two_counts_are_read_side_by_side_for_one_session() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-957"])).unwrap();
        led.begin_question("q-1", "run-1", 1, "q-1").unwrap();
        led.record_decision("dec-1", "master-1", "commit").unwrap();
        assert_eq!(led.asks_and_decisions("master-1").unwrap(), (1, 1));
        assert_eq!(
            led.asks_and_decisions("master-2").unwrap(),
            (0, 0),
            "the counts belong to the session that took them, and another master's ratio is not this one's"
        );
    }

    #[test]
    fn a_decision_repeated_under_one_id_is_counted_once() {
        let led = Ledger::open_in_memory().unwrap();
        led.record_decision("dec-1", "master-1", "commit").unwrap();
        led.record_decision("dec-1", "master-1", "commit").unwrap();
        assert_eq!(
            led.asks_and_decisions("master-1").unwrap().1,
            1,
            "the id is minted by the caller so a retried frame is free, exactly as a re-posted question is (ISS-964 criteria 2, 10)"
        );
    }

    #[test]
    fn a_decision_outlives_the_process_that_took_it() {
        let dir = std::env::temp_dir().join(format!("forge-dec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.sqlite");
        {
            let led = Ledger::open(&path).unwrap();
            led.record_decision("dec-1", "master-1", "commit").unwrap();
        }
        let led = Ledger::open(&path).unwrap();
        assert_eq!(
            led.asks_and_decisions("master-1").unwrap().1,
            1,
            "a counter held in the process is no denominator: the master that took the decisions is gone by the time anybody reads the ratio"
        );
    }

    #[test]
    fn a_worktree_already_live_is_refused_before_it_is_created() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-957"])).unwrap();
        let mut second = seed(&["ISS-963"]);
        second.run_id = "run-2".into();
        let err = led
            .create_run_group(second)
            .expect_err("a worktree path a live run already holds must be REFUSED here, BEFORE `git worktree add` runs — that is what stops the `.worktrees/<name> already exists` failure which killed ISS-593's first job (ISS-933 criterion 12)")
            .to_string();
        assert!(
            err.contains("/w/one"),
            "the refusal must name the path: {err}"
        );
        assert!(
            err.contains("run-1"),
            "the refusal must name the run holding it: {err}"
        );
    }

    #[test]
    fn a_run_from_a_previous_boot_never_blocks_a_new_one() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-957"])).unwrap();
        let mut after_reboot = seed(&["ISS-957"]);
        after_reboot.run_id = "run-2".into();
        after_reboot.boot_id = "boot-b".into();
        let run = led.create_run_group(after_reboot).unwrap();
        assert_eq!(run.run_id, "run-2");
    }

    #[test]
    fn an_empty_group_is_refused() {
        let mut led = Ledger::open_in_memory().unwrap();
        assert!(led.create_run_group(seed(&[])).is_err());
    }

    #[test]
    fn a_run_records_the_project_it_belongs_to() {
        let mut led = Ledger::open_in_memory().unwrap();
        let run = led.create_run_group(seed(&["ISS-934"])).unwrap();
        assert_eq!(
            run.project_id.as_deref(),
            Some("proj-1"),
            "a run with no project cannot be published to one — the read surface is authorised per project, so a snapshot entry without it has nowhere legal to land (ISS-934 criterion 2)"
        );
    }

    #[test]
    fn a_ledger_written_before_the_project_column_migrates_without_inventing_one() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE runs (
               run_id TEXT PRIMARY KEY, master_session_id TEXT NOT NULL, session_id TEXT,
               worktree_path TEXT NOT NULL, pid INTEGER, boot_id TEXT NOT NULL,
               incarnation TEXT NOT NULL, work TEXT NOT NULL, blocker_kind TEXT,
               waiting_on TEXT, resume_id TEXT, park_deadline_at INTEGER,
               session_terminal_at INTEGER, worktree_gone_at INTEGER, created_at INTEGER NOT NULL);
             INSERT INTO runs (run_id, master_session_id, worktree_path, boot_id, incarnation, work, created_at)
             VALUES ('old-run', 'master-0', '/w/old', 'boot-a', 'live', 'runnable', 1);",
        )
        .unwrap();
        let led = Ledger::from_conn(conn).unwrap();
        let run = led
            .run("old-run")
            .unwrap()
            .expect("a run recorded before ISS-934 must survive the migration, not be dropped");
        assert_eq!(
            run.project_id, None,
            "a pre-upgrade run genuinely has no project on the ledger; defaulting one here would publish it into a project it does not belong to"
        );
    }

    #[test]
    fn incarnation_and_work_are_separate_columns_so_waiting_is_not_dead() {
        let cols = RUN_COLUMNS;
        assert!(cols.contains(&"incarnation") && cols.contains(&"work"));
        assert!(
            !cols.contains(&"status") && !cols.contains(&"state"),
            "one status string cannot say both `is the process there` and `can it move` (ISS-964 criterion 9)"
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_human_block_releases_the_box_and_a_machine_block_keeps_it() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        assert_eq!(
            park_human(&mut led, "run-1", "q-1", Some("r-1"), None).unwrap(),
            Incarnation::Exited
        );
        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(run.work, Work::Blocked);
        assert_eq!(run.blocker_kind, Some(BlockerKind::Human));
        assert_eq!(run.resume_id.as_deref(), Some("r-1"));

        for kind in [BlockerKind::Machine, BlockerKind::MasterOrPeer] {
            let dir = std::env::temp_dir().join(format!("led-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let mut other = Ledger::open_in_memory().unwrap();
            other.create_run_group(seed(&["ISS-2"])).unwrap();
            let (_ear, inc) = crate::runner::blocked::arm_bounded(
                &mut other,
                &dir.join("ledger.sqlite"),
                Wait {
                    run_id: "run-1",
                    question_id: "q-2",
                    round: 1,
                    blocker: kind,
                    resume_id: None,
                    park_deadline_at: None,
                },
            )
            .unwrap();
            assert_eq!(inc, Incarnation::Live, "a bounded wait keeps the process");
        }
    }

    #[test]
    fn a_blocker_nobody_could_resolve_is_refused_and_writes_no_question() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        assert!(crate::runner::blocked::arm_bounded(
            &mut led,
            std::env::temp_dir().as_path(),
            Wait {
                run_id: "run-1",
                question_id: "q-1",
                round: 1,
                blocker: BlockerKind::Nobody,
                resume_id: None,
                park_deadline_at: None,
            },
        )
        .is_err());
        assert_eq!(led.run("run-1").unwrap().unwrap().work, Work::Runnable);
        assert!(led.questions_for("run-1").unwrap().is_empty());
    }

    #[test]
    fn the_bounded_arm_refuses_a_human_block_by_name() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        let err = crate::runner::blocked::arm_bounded(
            &mut led,
            std::env::temp_dir().as_path(),
            Wait {
                run_id: "run-1",
                question_id: "q-1",
                round: 1,
                blocker: BlockerKind::Human,
                resume_id: None,
                park_deadline_at: None,
            },
        )
        .expect_err("a human wait is unbounded and cannot be declared live");
        assert!(
            format!("{err}").contains("park_for_human"),
            "the refusal must name the way out, not merely refuse: {err}"
        );
        assert_eq!(led.run("run-1").unwrap().unwrap().work, Work::Runnable);
        assert!(led.questions_for("run-1").unwrap().is_empty());
    }

    #[test]
    fn a_finished_run_cannot_park() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        led.end_run("run-1", "operator", "abandoned").unwrap();
        assert!(park_human(&mut led, "run-1", "q-1", None, None).is_err());
    }

    #[test]
    fn the_ledger_alone_tells_waiting_from_dead() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        park_human(&mut led, "run-1", "q-1", Some("r-1"), None).unwrap();
        let waiting = led.run("run-1").unwrap().unwrap();

        let mut dead_led = Ledger::open_in_memory().unwrap();
        dead_led.create_run_group(seed(&["ISS-9"])).unwrap();
        dead_led.end_run("run-1", "reaper", "session_lost").unwrap();
        let dead = dead_led.run("run-1").unwrap().unwrap();

        assert_eq!(
            (waiting.incarnation, waiting.work),
            (Incarnation::Exited, Work::Blocked)
        );
        assert_eq!(
            (dead.incarnation, dead.work),
            (Incarnation::Exited, Work::Done)
        );
        assert_eq!(dead.ended_reason.as_deref(), Some("session_lost"));
    }

    #[test]
    fn liveness_is_three_valued_and_a_foreign_boot_is_never_dead() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        led.attach_pid("run-1", 4242).unwrap();
        let run = led.run("run-1").unwrap().unwrap();

        assert_eq!(Ledger::liveness(&run, "boot-a", false), Liveness::Alive);
        assert_eq!(Ledger::liveness(&run, "boot-a", true), Liveness::Dead);
        assert_eq!(
            Ledger::liveness(&run, "a-later-boot", true),
            Liveness::Unknown,
            "a refuted pid from another boot refutes nothing"
        );
    }

    #[test]
    fn a_run_with_no_pid_recorded_is_unknown_rather_than_dead() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(Ledger::liveness(&run, "boot-a", true), Liveness::Unknown);
    }

    #[test]
    fn a_choice_recorded_when_none_is_owed_is_refused_and_leaves_the_gate_armed() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        led.bind_agent("run-1", "child-1").unwrap();

        assert!(
            !led.record_resume_choice("run-1", "master-1", "leave", "nobody asked")
                .unwrap(),
            "no resume has happened, so there is no choice to record"
        );
        assert_eq!(
            led.run("run-1").unwrap().unwrap().resume_choice,
            None,
            "a refused record must write nothing, or the gate below is already spent"
        );

        assert_eq!(
            led.owe_resume_choices("master-1", "boot-a").unwrap(),
            1,
            "the obligation must still be creatable — this is what the refusal was protecting"
        );
        assert!(
            led.record_resume_choice("run-1", "master-1", "continue", "picking it up")
                .unwrap(),
            "once the resume has owed it, the same call is the one that answers"
        );
        assert_eq!(
            led.run("run-1").unwrap().unwrap().resume_choice.as_deref(),
            Some("continue")
        );
    }

    #[test]
    fn revoking_a_claim_makes_every_claim_under_it_stale() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        let gen0 = led.hold_claim("run-1", "master-a", 9_999).unwrap();
        let gen1 = led.revoke_claim("run-1").unwrap();
        assert!(gen1 > gen0, "generation must move: {gen0} -> {gen1}");

        park_human(&mut led, "run-1", "q-1", Some("r-1"), None).unwrap();
        led.answer_arrived("run-1").unwrap();
        assert_eq!(
            led.begin_revival("run-1", gen0, "tok", 9_999).unwrap_err(),
            RevivalRefusal::FenceSuperseded
        );
    }

    #[test]
    fn an_answer_leaves_the_run_owed_a_revival_and_exactly_one_wake_wins() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        let gen = led.hold_claim("run-1", "master-a", 9_999).unwrap();
        park_human(&mut led, "run-1", "q-1", Some("r-1"), None).unwrap();
        assert!(led.answer_arrived("run-1").unwrap());

        let owed = led.run("run-1").unwrap().unwrap();
        assert_eq!(
            (owed.incarnation, owed.work),
            (Incarnation::Exited, Work::Runnable)
        );

        assert!(led.begin_revival("run-1", gen, "tok-a", 9_999).is_ok());
        assert_eq!(
            led.begin_revival("run-1", gen, "tok-b", 9_999).unwrap_err(),
            RevivalRefusal::NotOwed,
            "a second wake must not also win the CAS"
        );
        assert_eq!(
            led.run("run-1").unwrap().unwrap().incarnation,
            Incarnation::Starting
        );
    }

    #[test]
    fn a_revival_that_never_spawned_returns_the_row_still_owed() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        let gen = led.hold_claim("run-1", "m", 9_999).unwrap();
        park_human(&mut led, "run-1", "q-1", None, None).unwrap();
        led.answer_arrived("run-1").unwrap();
        led.begin_revival("run-1", gen, "tok-a", 9_999).unwrap();

        assert!(led.revival_failed("run-1", "tok-a").unwrap());
        let back = led.run("run-1").unwrap().unwrap();
        assert_eq!(
            (back.incarnation, back.work),
            (Incarnation::Exited, Work::Runnable)
        );
        assert!(led.begin_revival("run-1", gen, "tok-b", 9_999).is_ok());
    }

    #[test]
    fn recovery_resets_an_expired_revival_and_leaves_one_on_its_way_alone() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        let gen = led.hold_claim("run-1", "m", 9_999).unwrap();
        park_human(&mut led, "run-1", "q", None, None).unwrap();
        led.answer_arrived("run-1").unwrap();
        led.begin_revival("run-1", gen, "tok", 1_000).unwrap();

        assert_eq!(led.reset_expired_revivals(999).unwrap(), 0, "not yet due");
        assert_eq!(
            led.run("run-1").unwrap().unwrap().incarnation,
            Incarnation::Starting
        );
        assert_eq!(
            led.reset_expired_revivals(1_000).unwrap(),
            1,
            "due at the boundary"
        );
        assert_eq!(
            led.run("run-1").unwrap().unwrap().incarnation,
            Incarnation::Exited
        );
    }

    #[test]
    fn a_revival_is_refused_by_name_when_its_tree_is_gone_or_its_work_is_closed() {
        let mut gone = Ledger::open_in_memory().unwrap();
        gone.create_run_group(seed(&["ISS-1"])).unwrap();
        let g = gone.hold_claim("run-1", "m", 9_999).unwrap();
        park_human(&mut gone, "run-1", "q", None, None).unwrap();
        gone.answer_arrived("run-1").unwrap();
        gone.mark_worktree_gone_observed("run-1").unwrap();
        assert_eq!(
            gone.begin_revival("run-1", g, "t", 9_999).unwrap_err(),
            RevivalRefusal::WorktreeGone
        );

        let mut closed = Ledger::open_in_memory().unwrap();
        closed.create_run_group(seed(&["ISS-2"])).unwrap();
        let g2 = closed.hold_claim("run-1", "m", 9_999).unwrap();
        closed.end_run("run-1", "operator", "abandoned").unwrap();
        assert_eq!(
            closed.begin_revival("run-1", g2, "t", 9_999).unwrap_err(),
            RevivalRefusal::WorkClosed
        );
    }

    #[test]
    fn a_question_is_recorded_under_the_id_the_box_minted_and_repeats_idempotently() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        led.begin_question("q-abc", "run-1", 1, "q-abc").unwrap();
        led.begin_question("q-abc", "run-1", 1, "q-abc").unwrap();
        led.begin_question("q-def", "run-1", 2, "q-def").unwrap();
        assert_eq!(
            led.questions_for("run-1").unwrap(),
            vec![("q-abc".to_string(), 1), ("q-def".to_string(), 2)]
        );
    }

    #[test]
    fn a_park_survives_the_ledger_being_closed_and_reopened() {
        let dir = std::env::temp_dir().join(format!("forge-ledger-{}", std::process::id()));
        let path = dir.join("ledger.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let mut led = Ledger::open(&path).unwrap();
            led.create_run_group(seed(&["ISS-1"])).unwrap();
            park_human(&mut led, "run-1", "q-1", Some("r-1"), Some(77)).unwrap();
        }
        let reopened = Ledger::open(&path).unwrap();
        let run = reopened.run("run-1").unwrap().unwrap();
        assert_eq!(
            (run.incarnation, run.work),
            (Incarnation::Exited, Work::Blocked)
        );
        assert_eq!(run.resume_id.as_deref(), Some("r-1"));
        assert_eq!(run.waiting_on.as_deref(), Some("q-1"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_second_declaration_under_one_master_is_refused_naming_the_row_that_is_pending() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        let mut second = seed(&["ISS-2"]);
        second.run_id = "run-2".into();
        second.worktree_path = PathBuf::from("/w/two");
        let err = led.create_run_group(second).unwrap_err().to_string();
        assert!(
            err.contains("run-1") && err.contains("no subagent has bound it"),
            "the refusal must name the pending row a master has to close: {err}"
        );
    }

    #[test]
    fn a_bound_run_does_not_block_the_next_declaration() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        assert!(led.bind_agent("run-1", "child-a").unwrap());
        let mut second = seed(&["ISS-2"]);
        second.run_id = "run-2".into();
        second.worktree_path = PathBuf::from("/w/two");
        led.create_run_group(second)
            .expect("a master with one bound run may declare its next");
    }

    #[test]
    fn a_declaration_whose_subagent_never_started_is_cancelled_by_its_own_close() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        assert_eq!(
            led.unbound_run_for_master("master-1", "boot-a")
                .unwrap()
                .map(|r| r.run_id)
                .as_deref(),
            Some("run-1")
        );
        led.end_run("run-1", "master", "the subagent never started")
            .unwrap();
        assert!(
            led.unbound_run_for_master("master-1", "boot-a")
                .unwrap()
                .is_none(),
            "a closed declaration is no longer pending"
        );
        let mut second = seed(&["ISS-2"]);
        second.run_id = "run-2".into();
        second.worktree_path = PathBuf::from("/w/two");
        led.create_run_group(second)
            .expect("the next declaration is accepted once the cancelled one is closed");
    }

    #[test]
    fn an_unbound_run_from_a_previous_boot_never_blocks_a_declaration() {
        let mut led = Ledger::open_in_memory().unwrap();
        let mut old = seed(&["ISS-1"]);
        old.boot_id = "boot-old".into();
        led.create_run_group(old).unwrap();
        let mut fresh = seed(&["ISS-2"]);
        fresh.run_id = "run-2".into();
        fresh.worktree_path = PathBuf::from("/w/two");
        led.create_run_group(fresh)
            .expect("a boot this box is not in cannot hold the declaration");
    }

    #[test]
    fn a_bound_run_cannot_be_rebound_and_a_repeated_hook_writes_once() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(seed(&["ISS-1"])).unwrap();
        assert!(led.bind_agent("run-1", "child-a").unwrap());
        assert!(
            !led.bind_agent("run-1", "child-b").unwrap(),
            "a bound run is not repointed at another child"
        );
        assert!(
            !led.bind_agent("run-1", "child-a").unwrap(),
            "the same event twice binds once"
        );
        assert_eq!(
            led.run_for_agent("child-a").unwrap().unwrap().run_id,
            "run-1"
        );
        assert!(led.run_for_agent("child-b").unwrap().is_none());
    }

    #[test]
    fn a_master_pane_and_its_conversation_survive_the_ledger_being_closed_and_reopened() {
        let dir = std::env::temp_dir().join(format!("forge-ledger-masters-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let led = Ledger::open(&path).unwrap();
            led.note_master(
                "proj-1",
                "forge-proj-1",
                Some("conv-abc"),
                Some("sess-1"),
                "boot-a",
            )
            .unwrap();
        }
        let led = Ledger::open(&path).unwrap();
        let row = led.master_for_project("proj-1").unwrap().unwrap();
        assert_eq!(row.pane_name, "forge-proj-1");
        assert_eq!(row.conversation_id.as_deref(), Some("conv-abc"));
        assert!(led.master_for_project("proj-2").unwrap().is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_report_carrying_no_conversation_leaves_the_stored_one_alone() {
        let led = Ledger::open_in_memory().unwrap();
        led.note_master(
            "proj-1",
            "forge-proj-1",
            Some("conv-abc"),
            Some("sess-1"),
            "boot-a",
        )
        .unwrap();
        led.note_master("proj-1", "forge-proj-1", None, None, "boot-a")
            .unwrap();
        assert_eq!(
            led.master_for_project("proj-1")
                .unwrap()
                .unwrap()
                .conversation_id
                .as_deref(),
            Some("conv-abc"),
            "a report with no conversation must not erase the handle a resume needs"
        );
    }

    #[test]
    fn a_ledger_written_by_an_earlier_build_gains_the_masters_table_and_the_agent_column() {
        let dir = std::env::temp_dir().join(format!("forge-ledger-1050-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE runs (
                   run_id TEXT PRIMARY KEY, master_session_id TEXT NOT NULL, session_id TEXT,
                   worktree_path TEXT NOT NULL, pid INTEGER, boot_id TEXT NOT NULL,
                   incarnation TEXT NOT NULL, work TEXT NOT NULL, blocker_kind TEXT,
                   waiting_on TEXT, resume_id TEXT, park_deadline_at INTEGER,
                   session_terminal_at INTEGER, worktree_gone_at INTEGER,
                   created_at INTEGER NOT NULL);
                 CREATE TABLE run_issues (
                   run_id TEXT NOT NULL, issue_key TEXT NOT NULL, lease_returned_at INTEGER,
                   PRIMARY KEY (run_id, issue_key));
                 INSERT INTO runs (run_id, master_session_id, worktree_path, boot_id,
                                   incarnation, work, created_at)
                 VALUES ('old-run', 'old-master', '/tmp/w-old', 'boot-old', 'live', 'runnable', 1);
                 INSERT INTO run_issues (run_id, issue_key) VALUES ('old-run', 'ISS-900');",
            )
            .unwrap();
        }
        let mut led = Ledger::open(&path).unwrap();

        let old = led
            .run("old-run")
            .expect("a ledger an earlier build wrote must still open")
            .expect("the row it already held must survive");
        assert!(
            old.agent_id.is_none(),
            "a row written before the column existed reads as unbound, never as bound to something invented"
        );
        assert_eq!(
            led.issues("old-run").unwrap().len(),
            1,
            "the membership it already held must survive too"
        );

        led.create_run_group(NewRun {
            run_id: "new-run".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: PathBuf::from("/tmp/w-new"),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-901".into()],
        })
        .expect("a ledger an earlier build wrote must accept a write under this build");
        assert!(led.bind_agent("new-run", "child-a").unwrap());
        led.note_master(
            "proj-1",
            "forge-proj-1",
            Some("conv-abc"),
            Some("sess-1"),
            "boot-a",
        )
        .unwrap();

        assert_eq!(
            led.run_for_agent("child-a").unwrap().unwrap().run_id,
            "new-run"
        );
        assert_eq!(
            led.master_for_project("proj-1")
                .unwrap()
                .unwrap()
                .conversation_id
                .as_deref(),
            Some("conv-abc")
        );
        assert!(
            led.run("old-run").unwrap().is_some(),
            "the row the earlier build wrote is still there after this build has written its own"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// The whole point of putting the stand-down in the ledger rather than in
    /// the daemon's memory: the sweep that would replace the pane runs in a
    /// process the owner's act outlives (ISS-1118 criterion 2).
    #[test]
    fn a_stand_down_outlives_the_process_that_recorded_it() {
        let dir = std::env::temp_dir().join(format!("forge-ledger-1118-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let led = Ledger::open(&path).unwrap();
            led.stand_down_master(
                "proj-1",
                "forge-dev",
                "owner",
                Some("a human is driving it"),
            )
            .unwrap();
        }
        let led = Ledger::open(&path).unwrap();
        let standing = led
            .master_standing("proj-1")
            .unwrap()
            .expect("a stand-down written by one process is read by the next");
        assert!(standing.stands());
        assert_eq!(standing.slug, "forge-dev");
        assert_eq!(standing.why.as_deref(), Some("a human is driving it"));
        assert!(
            led.master_standing("proj-2").unwrap().is_none(),
            "one project's stand-down says nothing about another's"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn standing_a_master_up_leaves_the_interval_behind_until_a_pane_has_been_told_it() {
        let led = Ledger::open_in_memory().unwrap();
        led.stand_down_master("proj-1", "forge-dev", "owner", None)
            .unwrap();
        assert!(
            led.stand_up_master("proj-1").unwrap(),
            "lifting a standing stand-down reports that it lifted one"
        );
        let lifted = led
            .master_standing("proj-1")
            .unwrap()
            .expect("the row stays so the next pane can be told how long it was down");
        assert!(!lifted.stands());
        assert!(lifted.stood_up_at.is_some());
        assert!(
            !led.stand_up_master("proj-1").unwrap(),
            "standing up a project that is not stood down lifts nothing and says so"
        );
        led.forget_lifted_standing("proj-1").unwrap();
        assert!(
            led.master_standing("proj-1").unwrap().is_none(),
            "once the interval has been delivered the row has no reader left"
        );
    }

    #[test]
    fn a_standing_stand_down_is_never_forgotten_by_the_delivery_path() {
        let led = Ledger::open_in_memory().unwrap();
        led.stand_down_master("proj-1", "forge-dev", "owner", None)
            .unwrap();
        led.forget_lifted_standing("proj-1").unwrap();
        assert!(
            led.master_standing("proj-1")
                .unwrap()
                .is_some_and(|s| s.stands()),
            "the call that clears a delivered interval must not be able to clear a live stand-down — that would place the pane the owner withheld"
        );
    }

    #[test]
    fn standing_a_master_down_twice_keeps_the_moment_it_first_went_down() {
        let led = Ledger::open_in_memory().unwrap();
        led.stand_down_master("proj-1", "forge-dev", "owner", None)
            .unwrap();
        let first = led
            .master_standing("proj-1")
            .unwrap()
            .unwrap()
            .stood_down_at;
        led.stand_down_master("proj-1", "forge-dev", "someone-else", Some("again"))
            .unwrap();
        let again = led.master_standing("proj-1").unwrap().unwrap();
        assert_eq!(
            again.stood_down_at, first,
            "a second stand-down over a standing one must not restart the clock the interval is measured from"
        );
        assert_eq!(again.stood_down_by, "someone-else");
        led.stand_up_master("proj-1").unwrap();
        led.stand_down_master("proj-1", "forge-dev", "owner", None)
            .unwrap();
        let fresh = led.master_standing("proj-1").unwrap().unwrap();
        assert!(fresh.stands() && fresh.stood_up_at.is_none());
        assert!(
            fresh.stood_down_at >= first,
            "a stand-down after a stand-up is a new one and takes its own moment"
        );
    }

    /// Criterion 14 asks a stand-down to name the runs the master holds, and
    /// the key those rows carry is the master's core session id. A box that
    /// upgraded with a pane running has a `masters` row written without it
    /// (ISS-1118 criterion 18).
    #[test]
    fn a_masters_table_written_before_session_id_gains_the_column_on_open() {
        let dir = std::env::temp_dir().join(format!("forge-ledger-1118m-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE masters (
                   project_id TEXT PRIMARY KEY, pane_name TEXT NOT NULL, conversation_id TEXT,
                   boot_id TEXT NOT NULL, cold_started_at INTEGER NOT NULL,
                   last_seen_at INTEGER NOT NULL);
                 INSERT INTO masters (project_id, pane_name, conversation_id, boot_id,
                                      cold_started_at, last_seen_at)
                 VALUES ('proj-1', 'forge-master-forge-dev', 'conv-old', 'boot-old', 1, 1);",
            )
            .unwrap();
        }
        let led = Ledger::open(&path).expect(
            "a ledger whose masters table predates session_id must still open — the alternative is a box that upgraded with a pane running and can no longer read its own ledger",
        );
        let row = led
            .master_for_project("proj-1")
            .unwrap()
            .expect("the row the earlier build wrote survives");
        assert_eq!(row.conversation_id.as_deref(), Some("conv-old"));
        assert!(
            row.session_id.is_none(),
            "a row written before the column existed reads as unknown, never as bound to a session nothing minted"
        );
        led.note_master(
            "proj-1",
            "forge-master-forge-dev",
            None,
            Some("sess-new"),
            "boot-new",
        )
        .unwrap();
        assert_eq!(
            led.master_for_project("proj-1")
                .unwrap()
                .unwrap()
                .session_id
                .as_deref(),
            Some("sess-new"),
            "and the upgraded row takes the session id the next report carries"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// F4 from the ISS-1118 review. A project can be stood down before this
    /// box has ever placed a master for it, and a lookup that needs a pane row
    /// would report "nothing is standing it down" about a project standing
    /// down right there in the ledger.
    #[test]
    fn a_standing_is_readable_for_a_project_that_has_no_master_row_at_all() {
        let led = Ledger::open_in_memory().unwrap();
        led.stand_down_master("proj-1", "forge-dev", "owner", None)
            .unwrap();
        assert!(
            led.master_for_pane("forge-master-forge-dev")
                .unwrap()
                .is_none(),
            "the case is exactly a stand-down with no pane row behind it"
        );
        let by_slug = led
            .master_standing_for_slug("forge-dev")
            .unwrap()
            .expect("the standing is reachable by the only thing a command holds — the slug");
        assert!(by_slug.stands());
        assert_eq!(by_slug.project_id, "proj-1");
        assert!(led.master_standing_for_slug("other").unwrap().is_none());
    }

    /// Plant a verdict as having been reached `ago` seconds back, which no
    /// pair of writes inside one test second can produce: `now()` has
    /// one-second granularity, so a case that wrote twice and compared would
    /// pass whether the statement preserved `since` or overwrote it.
    fn age_authority(led: &Ledger, project_id: &str, ago: i64) -> i64 {
        let planted = now() - ago;
        led.conn
            .execute(
                "UPDATE master_authority SET since = ?2, seen_at = ?2 WHERE project_id = ?1",
                params![project_id, planted],
            )
            .unwrap();
        planted
    }

    /// The whole point of writing the verdict down. The daemon that reaches it
    /// is the one a restart replaces, and the registry that held it before was
    /// in-process: the state this records is *produced* by the restart that
    /// erased the record of it (ISS-1099 criterion 10).
    #[test]
    fn an_authority_verdict_outlives_the_process_that_reached_it() {
        let dir = std::env::temp_dir().join(format!("forge-ledger-1099a-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let led = Ledger::open(&path).unwrap();
            led.note_master_authority(
                "proj-1",
                "sidpeak",
                ("forge-master-sidpeak", Some("1700000000:$1")),
                MasterAuthority::STALE,
                None,
            )
            .unwrap();
        }
        let reopened = Ledger::open(&path).expect("a later daemon opens the same ledger");
        let row = reopened
            .master_authority_for_slug("sidpeak")
            .unwrap()
            .expect("the verdict survives the process that reached it");
        assert_eq!(row.verdict, MasterAuthority::STALE);
        assert_eq!(row.project_id, "proj-1");
        assert_eq!(row.pane_name, "forge-master-sidpeak");
        assert!(
            reopened
                .master_authority_for_slug("never-judged")
                .unwrap()
                .is_none(),
            "a project no sweep has judged has no verdict, which is not the same as a current one"
        );
        drop(reopened);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    /// `since` answers "how long has this stood", which is the number the
    /// incident behind this issue turned on: four hours, and nothing on the box
    /// could say so. A sweep that finds the same thing again is not news
    /// (ISS-1099 criterion 14).
    #[test]
    fn a_repeat_of_the_same_verdict_leaves_the_time_it_has_stood_since_alone() {
        let led = Ledger::open_in_memory().unwrap();
        led.note_master_authority(
            "proj-1",
            "sidpeak",
            ("forge-master-sidpeak", Some("1700000000:$1")),
            MasterAuthority::STALE,
            None,
        )
        .unwrap();
        let planted = age_authority(&led, "proj-1", 4 * 3600);

        led.note_master_authority(
            "proj-1",
            "sidpeak",
            ("forge-master-sidpeak", Some("1700000000:$1")),
            MasterAuthority::STALE,
            None,
        )
        .unwrap();
        let again = led.master_authority_for_slug("sidpeak").unwrap().unwrap();
        assert_eq!(
            again.since, planted,
            "the 45th sweep to find the same refusal has learned nothing the first did not"
        );
        assert!(
            again.seen_at > planted,
            "but it has confirmed it now, which is what makes the interval a live one rather than a stale reading"
        );
        assert!(
            again.held_for().as_secs() >= 4 * 3600,
            "and the pair says four hours, which is the sentence this issue exists to make sayable: {:?}",
            again.held_for()
        );

        led.note_master_authority(
            "proj-1",
            "sidpeak",
            ("forge-master-sidpeak", Some("1700000000:$1")),
            MasterAuthority::CURRENT,
            None,
        )
        .unwrap();
        let moved = led.master_authority_for_slug("sidpeak").unwrap().unwrap();
        assert!(
            moved.since > planted,
            "a pane that recovers starts its own interval, or the box reports a current capability as four hours old"
        );
    }

    /// A pane replaced under the same project is a different pane, and a
    /// verdict reached about the one before it says nothing about this one.
    #[test]
    fn a_verdict_about_a_replaced_pane_does_not_carry_its_interval_over() {
        let led = Ledger::open_in_memory().unwrap();
        led.note_master_authority(
            "proj-1",
            "sidpeak",
            ("forge-master-sidpeak", Some("1700000000:$1")),
            MasterAuthority::STALE,
            None,
        )
        .unwrap();
        let planted = age_authority(&led, "proj-1", 4 * 3600);
        led.note_master_authority(
            "proj-1",
            "sidpeak",
            ("forge-master-sidpeak-2", Some("1700000000:$1")),
            MasterAuthority::STALE,
            None,
        )
        .unwrap();
        let row = led.master_authority_for_slug("sidpeak").unwrap().unwrap();
        assert_eq!(row.pane_name, "forge-master-sidpeak-2");
        assert!(
            row.since > planted,
            "the same verdict about a different pane is a new verdict; carrying the interval would tell an operator their replacement pane has been refused for four hours"
        );
    }

    /// F1 from the review of this change. A master pane's name is derived
    /// from the project slug, so a replacement carries the name of the pane it
    /// replaced and the name alone identifies nothing. Carrying the interval
    /// over tells an operator their brand-new master has been refused for four
    /// hours.
    #[test]
    fn a_replacement_under_the_same_name_starts_its_own_interval() {
        let led = Ledger::open_in_memory().unwrap();
        led.note_master_authority(
            "proj-1",
            "sidpeak",
            ("forge-master-sidpeak", Some("1700000000:$1")),
            MasterAuthority::STALE,
            None,
        )
        .unwrap();
        let planted = age_authority(&led, "proj-1", 4 * 3600);
        led.note_master_authority(
            "proj-1",
            "sidpeak",
            ("forge-master-sidpeak", Some("1700000000:$2")),
            MasterAuthority::STALE,
            None,
        )
        .unwrap();
        let row = led.master_authority_for_slug("sidpeak").unwrap().unwrap();
        assert_eq!(
            row.pane_name, "forge-master-sidpeak",
            "the name is the same"
        );
        assert_eq!(row.pane_incarnation.as_deref(), Some("1700000000:$2"));
        assert!(
            row.since > planted,
            "the pane the four hours were measured against is gone; the one up now has been refused for seconds"
        );
    }

    /// The three verdicts stay three all the way to disk. Folding "this box
    /// could not read its own map" into "stale" would report every master on a
    /// 28-project box as unplaceable at once, off one unreadable file.
    #[test]
    fn an_unreadable_map_is_recorded_as_neither_current_nor_stale() {
        let led = Ledger::open_in_memory().unwrap();
        led.note_master_authority(
            "proj-1",
            "sidpeak",
            ("forge-master-sidpeak", Some("1700000000:$1")),
            MasterAuthority::UNKNOWN,
            Some("the capability map is not valid JSON"),
        )
        .unwrap();
        let row = led.master_authority_for_slug("sidpeak").unwrap().unwrap();
        assert_eq!(row.verdict, MasterAuthority::UNKNOWN);
        assert_ne!(row.verdict, MasterAuthority::STALE);
        assert_ne!(row.verdict, MasterAuthority::CURRENT);
        assert_eq!(
            row.detail.as_deref(),
            Some("the capability map is not valid JSON"),
            "and it carries why, because `unknown` with no reason is a shrug rather than a report"
        );
    }

    #[test]
    fn every_project_this_box_holds_an_authority_verdict_about_is_listable() {
        let led = Ledger::open_in_memory().unwrap();
        led.note_master_authority(
            "proj-1",
            "b-project",
            ("forge-master-b-project", None),
            MasterAuthority::STALE,
            None,
        )
        .unwrap();
        led.note_master_authority(
            "proj-2",
            "a-project",
            ("forge-master-a-project", None),
            MasterAuthority::CURRENT,
            None,
        )
        .unwrap();
        let slugs: Vec<String> = led
            .authorities()
            .unwrap()
            .into_iter()
            .map(|a| a.slug)
            .collect();
        assert_eq!(
            slugs,
            vec!["a-project".to_string(), "b-project".to_string()],
            "`master status` lists what it can answer for, and a pane this box adopted has no transcript directory to be found by"
        );
    }

    #[test]
    fn every_project_this_box_holds_a_decision_about_is_listable() {
        let led = Ledger::open_in_memory().unwrap();
        led.stand_down_master("proj-1", "b-project", "owner", None)
            .unwrap();
        led.stand_down_master("proj-2", "a-project", "owner", None)
            .unwrap();
        let slugs: Vec<String> = led
            .standings()
            .unwrap()
            .into_iter()
            .map(|s| s.slug)
            .collect();
        assert_eq!(
            slugs,
            vec!["a-project".to_string(), "b-project".to_string()],
            "a bare `status` that enumerated transcript directories alone would list neither, and a stood-down project with no transcript is the one an owner is most likely looking for"
        );
    }

    #[test]
    fn a_pane_name_reaches_the_project_it_belongs_to() {
        let led = Ledger::open_in_memory().unwrap();
        led.note_master(
            "proj-1",
            "forge-master-forge-dev",
            Some("conv-abc"),
            Some("sess-1"),
            "boot-a",
        )
        .unwrap();
        assert_eq!(
            led.master_for_pane("forge-master-forge-dev")
                .unwrap()
                .unwrap()
                .project_id,
            "proj-1",
            "a command holding a slug and nothing else reaches the project id through the pane name it can build"
        );
        assert!(led.master_for_pane("forge-master-other").unwrap().is_none());
    }

    #[test]
    fn clearing_the_conversation_leaves_the_pane_row_otherwise_intact() {
        let led = Ledger::open_in_memory().unwrap();
        led.note_master(
            "proj-1",
            "forge-master-forge-dev",
            Some("conv-abc"),
            Some("sess-1"),
            "boot-a",
        )
        .unwrap();
        led.forget_master_conversation("proj-1").unwrap();
        let row = led.master_for_project("proj-1").unwrap().unwrap();
        assert!(
            row.conversation_id.is_none(),
            "--fresh means the next pane cold-starts, so the handle a resume would use is gone"
        );
        assert_eq!(
            row.session_id.as_deref(),
            Some("sess-1"),
            "and nothing else about the pane is forgotten with it"
        );
    }

    /// The other direction of the same compatibility question: a ledger this
    /// build has migrated, opened by one that predates the columns. Every read
    /// of `runs` goes through `SELECT_RUN`, which names its columns and maps
    /// them positionally against that list, so a column a build has never heard
    /// of is one it never selects. The extra column below stands in for that
    /// build's blind spot — if anything here ever reaches for `SELECT *` or
    /// counts columns off the table, this goes red rather than a runner going
    /// down on a box somebody rolled back.
    #[test]
    fn a_ledger_carrying_columns_this_build_does_not_know_is_still_read_by_name() {
        assert!(
            !SELECT_RUN.contains('*'),
            "a `SELECT *` over `runs` binds every reader to the table's exact shape, and the one \
             that loses is whichever build is older: {SELECT_RUN}"
        );

        let dir = std::env::temp_dir().join(format!("forge-ledger-newer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let mut led = Ledger::open(&path).unwrap();
            led.create_run_group(NewRun {
                run_id: "run-1".into(),
                project_id: "proj-1".into(),
                master_session_id: "m".into(),
                worktree_path: PathBuf::from("/tmp/w"),
                boot_id: "boot-1".into(),
                issue_keys: vec!["ISS-1".into()],
            })
            .unwrap();
            led.note_release_refusal("run-1", "a refusal a later build recorded", 1_790_000_000)
                .unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("ALTER TABLE runs ADD COLUMN a_column_from_the_future TEXT;")
                .unwrap();
        }

        let led = Ledger::open(&path).unwrap();
        let run = led
            .run("run-1")
            .unwrap()
            .expect("the row is still readable");
        assert_eq!(run.release_refused_at, Some(1_790_000_000));
        assert_eq!(led.unclosed_runs().unwrap().len(), 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_run_given_up_on_leaves_the_close_loop_when_its_leases_are_back_and_not_before() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "m".into(),
            worktree_path: PathBuf::from("/tmp/w"),
            boot_id: "boot-1".into(),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
        led.mark_session_terminal_observed("run-1").unwrap();
        led.mark_release_terminal("run-1", 1_790_000_300).unwrap();

        assert_eq!(
            led.unclosed_runs().unwrap().len(),
            1,
            "a lease still out is the one thing worth sweeping for: an issue nobody returned is \
             admissible to no other run on this box"
        );

        led.mark_lease_returned_observed("run-1", "ISS-1").unwrap();
        assert!(
            led.unclosed_runs().unwrap().is_empty(),
            "and once it is back the run has nothing left owed — its checkout is staying by \
             decision, so reading `worktree_gone_at` would keep it here for ever"
        );
    }

    #[test]
    fn a_refusal_is_retracted_once_and_then_there_is_nothing_to_retract() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "m".into(),
            worktree_path: PathBuf::from("/tmp/w"),
            boot_id: "boot-1".into(),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
        assert!(
            !led.clear_release_refusal("run-1").unwrap(),
            "a row carrying no refusal has nothing to retract, and saying otherwise would tell \
             an operator their act landed when it did nothing"
        );

        let first = led
            .note_release_refusal("run-1", "could not reach git", 1_790_000_000)
            .unwrap();
        assert_eq!(
            first,
            Refusal {
                since: 1_790_000_000,
                opened_the_streak: true
            }
        );
        let later = led
            .note_release_refusal("run-1", "could not reach git", 1_790_000_020)
            .unwrap();
        assert_eq!(
            later,
            Refusal {
                since: 1_790_000_000,
                opened_the_streak: false
            },
            "the streak keeps the age of its first refusal, or a window measured from the last \
             sweep never ends"
        );

        assert!(led.clear_release_refusal("run-1").unwrap());
        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(run.release_refused_at, None);
        assert_eq!(run.release_refusal, None);
        assert_eq!(run.release_terminal_at, None);
    }

    #[test]
    fn a_ledger_written_by_an_earlier_build_gains_the_new_columns_on_open() {
        let dir = std::env::temp_dir().join(format!("forge-ledger-old-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE runs (
                   run_id TEXT PRIMARY KEY, master_session_id TEXT NOT NULL, session_id TEXT,
                   worktree_path TEXT NOT NULL, pid INTEGER, boot_id TEXT NOT NULL,
                   incarnation TEXT NOT NULL, work TEXT NOT NULL, blocker_kind TEXT,
                   waiting_on TEXT, resume_id TEXT, park_deadline_at INTEGER,
                   session_terminal_at INTEGER, worktree_gone_at INTEGER,
                   created_at INTEGER NOT NULL);
                 INSERT INTO runs (run_id, master_session_id, worktree_path, boot_id,
                                   incarnation, work, created_at)
                 VALUES ('old-run', 'm', '/tmp/w', 'boot-1', 'live', 'runnable', 1);",
            )
            .unwrap();
        }
        let led = Ledger::open(&path).unwrap();
        let run = led
            .run("old-run")
            .expect("an old ledger must still be readable")
            .expect("the pre-existing row must survive");
        assert_eq!(run.claim_generation, 0);
        assert!(run.ended_reason.is_none());
        led.hold_claim("old-run", "m", 5).unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_questions_table_carries_only_the_boxs_half() {
        let led = Ledger::open_in_memory().unwrap();
        let mut declared: Vec<String> = QUESTION_COLUMNS.iter().map(|s| (*s).to_string()).collect();
        declared.sort();
        assert_eq!(columns(&led, "questions"), declared);
    }
}
