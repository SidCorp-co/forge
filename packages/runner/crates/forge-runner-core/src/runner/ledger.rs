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

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{Error, Result};

/// Is there a process, and does the boot it belongs to still exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Incarnation {
    Live,
    Starting,
    Exited,
}

/// What this box can HONESTLY say about a run's process, in three values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    Alive,
    Dead,
    Unknown,
}

/// Why a revival was refused. Each is terminal under its own name.
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

/// Can the run move, independent of whether its process is there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Work {
    Runnable,
    Blocked,
    Done,
}

/// Who could resolve the block — which decides the branch a blocked run takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockerKind {
    Machine,
    MasterOrPeer,
    Human,
    Nobody,
}

impl Run {
    /// Whether this run is the processless park a human has to answer.
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
    /// The subagent this run was bound to, once its `SubagentStart` arrived.
    pub agent_id: Option<String>,
    /// What a resumed master chose to do about this run: `continue`, `restart` or `leave`.
    pub resume_choice: Option<String>,
    pub resume_choice_why: Option<String>,
    /// Set when this pane was RESUMED over the run, which is what makes a choice owed.
    pub resume_owed_at: Option<i64>,
}

/// What this box knows about one project's resident master pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterRow {
    pub project_id: String,
    pub pane_name: String,
    pub conversation_id: Option<String>,
    pub boot_id: String,
    pub cold_started_at: i64,
    pub last_seen_at: i64,
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
];

#[cfg(test)]
const MASTER_COLUMNS: &[&str] = &[
    "project_id",
    "pane_name",
    "conversation_id",
    "boot_id",
    "cold_started_at",
    "last_seen_at",
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
  resume_owed_at      INTEGER
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
  boot_id         TEXT NOT NULL,
  cold_started_at INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL
);
";

const ADDED_COLUMNS: &[(&str, &str)] = &[
    ("project_id", "TEXT"),
    ("claim_owner", "TEXT"),
    ("claim_generation", "INTEGER NOT NULL DEFAULT 0"),
    ("claim_expires_at", "INTEGER"),
    ("revival_token", "TEXT"),
    ("revival_deadline_at", "INTEGER"),
    ("ended_by", "TEXT"),
    ("ended_reason", "TEXT"),
    ("agent_id", "TEXT"),
    ("resume_choice", "TEXT"),
    ("resume_choice_why", "TEXT"),
    ("resume_owed_at", "INTEGER"),
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
        ended_by, ended_reason, agent_id, resume_choice, resume_choice_why, resume_owed_at
 FROM runs";

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

    /// Create a run for a GROUP of issues — the only way a run comes into being.
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

    /// The one run this master has declared and no subagent has bound.
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

    /// Every worktree a run still holds, with the run that holds it.
    ///
    /// Any incarnation and any boot, deliberately: a park is `none` and outlives
    /// a reboot, so this is what a sweeper must ask rather than
    /// `live_run_at_path` (ISS-964 criteria 8, 25).
    pub fn held_worktrees(&self) -> Result<Vec<(PathBuf, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT worktree_path, run_id FROM runs WHERE ended_by IS NULL")
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

    /// Every run whose close loop has not finished, oldest first.
    pub fn unclosed_runs(&self) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE session_terminal_at IS NULL OR worktree_gone_at IS NULL
                 OR run_id IN (SELECT run_id FROM run_issues WHERE lease_returned_at IS NULL)
                 ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt.query_map([], map_run).map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// Every run one master started, closed or not.
    /// Move a run onto the master that is now serving its project.
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

    /// Record the core session a started run reports as, once core has minted it.
    pub fn attach_session(&self, run_id: &str, session_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET session_id = ?2 WHERE run_id = ?1",
                params![run_id, session_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Record the process a started run is running as, once it exists.
    /// Bind a declared run to the subagent whose `SubagentStart` just arrived.
    ///
    /// Answers whether this call is the one that bound it, so a repeated hook
    /// event — which the harness makes no promise against — writes once.
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

    /// Every run this boot ended that core has not been told is over.
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

    /// Every run this boot declared that core has not been told about yet.
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

    /// Record what a resumed master chose to do about one of the runs it inherited.
    ///
    /// Answers false when the run is not this master's to choose for.
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

    /// A pane has just been resumed over these runs: each now owes a choice.
    ///
    /// Answers how many it marked.
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

    /// The choices this master has recorded and core has not yet been told about.
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

    /// Core has the choice for this run; the obligation is discharged.
    pub fn mark_resume_choice_said(&self, run_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET resume_owed_at = NULL WHERE run_id = ?1",
                params![run_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// The runs this master inherited that it has not yet said anything about.
    pub fn runs_awaiting_choice(&self, master_session_id: &str, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE master_session_id = ?1 AND boot_id = ?2
                   AND ended_by IS NULL AND resume_owed_at IS NOT NULL AND resume_choice IS NULL"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![master_session_id, boot_id], map_run)
            .map_err(sql_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_err)?;
        Ok(rows)
    }

    /// Record, or refresh, what this box knows about a project's master pane.
    pub fn note_master(
        &self,
        project_id: &str,
        pane_name: &str,
        conversation_id: Option<&str>,
        boot_id: &str,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO masters (project_id, pane_name, conversation_id, boot_id, cold_started_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(project_id) DO UPDATE SET
                   pane_name       = excluded.pane_name,
                   conversation_id = COALESCE(excluded.conversation_id, masters.conversation_id),
                   boot_id         = excluded.boot_id,
                   last_seen_at    = excluded.last_seen_at",
                params![project_id, pane_name, conversation_id, boot_id, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// What this box knows about one project's master pane.
    pub fn master_for_project(&self, project_id: &str) -> Result<Option<MasterRow>> {
        self.conn
            .query_row(
                "SELECT project_id, pane_name, conversation_id, boot_id, cold_started_at, last_seen_at
                 FROM masters WHERE project_id = ?1",
                params![project_id],
                |row| {
                    Ok(MasterRow {
                        project_id: row.get(0)?,
                        pane_name: row.get(1)?,
                        conversation_id: row.get(2)?,
                        boot_id: row.get(3)?,
                        cold_started_at: row.get(4)?,
                        last_seen_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(sql_err)
    }

    /// Write a process id onto a run. **No production caller, by design.**
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

    /// Stamp *session terminal*, once the authoritative row said so.
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

    /// Stamp ONE issue's lease as returned, once the tracker said it was.
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

    /// Bring a ledger written by an earlier build up to this build's shape.
    fn add_missing_columns(conn: &Connection) -> Result<()> {
        let mut have: Vec<String> = Vec::new();
        {
            let mut stmt = conn.prepare("PRAGMA table_info(runs)").map_err(sql_err)?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .map_err(sql_err)?;
            for r in rows {
                have.push(r.map_err(sql_err)?);
            }
        }
        for (name, ty) in ADDED_COLUMNS {
            if !have.iter().any(|c| c == name) {
                conn.execute_batch(&format!("ALTER TABLE runs ADD COLUMN {name} {ty};"))
                    .map_err(sql_err)?;
            }
        }
        Ok(())
    }

    /// What this box can honestly say about a run's process.
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

    /// Ask: the question row and `waiting_on` in ONE local transaction.
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

    /// Record a decision taken instead of asked, and count it.
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

    /// `(asked, decided)` for one session — the ratio, in one read.
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

    /// Step THREE for a run that keeps its process: declare `live × blocked`.
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

    /// The human branch: blocked, and the process is gone.
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

    /// Declare ownership of a run: an owner, a generation, and an expiry.
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

    /// An answer arrived: the run is owed a revival, and nothing has claimed it.
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

    /// Win the right to spawn a revival, or be refused by name.
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

    /// A revival that never reached its process hands the row back, still owed.
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

    /// Reset a revival attempt that missed its deadline, and only such an one.
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

    /// The issues a run carries, and whether each lease came back.
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

    /// A second declaration under one master, while the first has no subagent.
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

    /// The same second declaration, once the first is bound to its subagent.
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

    /// An unbound row from a previous boot names a master session this box no longer has.
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
            led.note_master("proj-1", "forge-proj-1", Some("conv-abc"), "boot-a")
                .unwrap();
        }
        let led = Ledger::open(&path).unwrap();
        let row = led.master_for_project("proj-1").unwrap().unwrap();
        assert_eq!(row.pane_name, "forge-proj-1");
        assert_eq!(row.conversation_id.as_deref(), Some("conv-abc"));
        assert!(led.master_for_project("proj-2").unwrap().is_none());
        let _ = std::fs::remove_file(&path);
    }

    /// A later report that carries no conversation must not erase the stored one.
    #[test]
    fn a_report_carrying_no_conversation_leaves_the_stored_one_alone() {
        let led = Ledger::open_in_memory().unwrap();
        led.note_master("proj-1", "forge-proj-1", Some("conv-abc"), "boot-a")
            .unwrap();
        led.note_master("proj-1", "forge-proj-1", None, "boot-a")
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

    /// The migration, against a ledger whose `runs` table predates both additions.
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
        led.note_master("proj-1", "forge-proj-1", Some("conv-abc"), "boot-a")
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
