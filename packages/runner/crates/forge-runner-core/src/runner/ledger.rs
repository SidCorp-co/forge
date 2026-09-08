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
// cm:guard `Starting` is the window between the revival CAS committing and the process registering, and it exists so recovery can tell "a revival is on its way to exec" from "nothing is coming". Without it that state reads as `Exited`, a second wake wins the same CAS while the first is still spawning, and two processes reach one worktree (ISS-964 criteria 38, 39).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Incarnation {
    Live,
    Starting,
    Exited,
}

/// What this box can HONESTLY say about a run's process, in three values.
// cm:guard `Dead` requires a process identity refuted INSIDE the same boot epoch, and everything else is `Unknown` — never `Dead`. A pid from another boot names whatever the kernel has since handed that number to, so concluding death from it reclaims a worktree a live run is writing in; `Unknown` permits no reclamation at all, which is the safe direction (ISS-964 criteria 35, 36).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    Alive,
    Dead,
    Unknown,
}

/// Why a revival was refused. Each is terminal under its own name.
// cm:guard every variant is NAMED and none is a retry: a revival that failed its fence is a different operator problem from one whose tree is gone, and a blind retry on either is how a superseded claim spawns anyway (ISS-964 criteria 40, 41).
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
// cm:guard `Blocked` is orthogonal to `Incarnation` and MUST stay so: a human-blocked run is `Exited × Blocked` (it released the box, ISS-964), and a machine-blocked one is `Live × Blocked`. Collapsing the two axes into one status is the defect this design exists to remove — a reader cannot then tell waiting from dead without inspecting a pid, which is exactly what a lost box makes impossible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Work {
    Runnable,
    Blocked,
    Done,
}

/// Who could resolve the block — which decides the branch a blocked run takes.
// cm:guard `Nobody` is a FAILURE with a name, never a question: it writes no queue row (ISS-964). A blocker with no possible resolver that is filed as a question produces a row nobody can ever answer, which is indistinguishable from a run that is merely slow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockerKind {
    Machine,
    MasterOrPeer,
    Human,
    Nobody,
}

impl Run {
    /// Whether this run is the processless park a human has to answer.
    // cm:edge contract -> packages/core/src/jobs/park-deadline.ts — the same predicate on the other side (`parkedOnAHuman`), and the two must agree: core spares this shape from three sweeps and the box spares it from `recovery::reconcile`, so a side that computes it differently has one of them reaping what the other preserves (ISS-964 criteria 24, 28).
    // cm:guard all THREE columns, never `blocker_kind` alone: a bounded wait writes an open question with a blocker too, and a run that merely CRASHED while blocked on a human is `Exited x Blocked` with no park behind it. The park is the conjunction (ISS-964 criterion 9).
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

    // cm:guard the inverse of `wire` and the ONLY parser of these four words, because the strings are a wire format two processes agree on: a caller that matches them inline is a second spelling of the enum, and the one that rots is the one read less often.
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

// cm:guard EVERY column of both tables is named here and the schema test asserts the database matches it EXACTLY, so a column added for a second purpose fails the build rather than quietly making this a queue (ISS-933 criterion 10). Adding one means changing this list on purpose.
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
  created_at          INTEGER NOT NULL
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
";

// cm:guard `CREATE TABLE IF NOT EXISTS` adds NO column to a table that already exists, so a ledger written by an earlier build keeps its old shape and every statement naming a new column fails at RUNTIME on a live box. This runs on every open, is idempotent, and is the only reason a box that parked yesterday can be read today. A column added to `SCHEMA` must be added here in the same edit.
// cm:guard every entry is NULLABLE or carries a default, because this list runs against a ledger an EARLIER build wrote: `project_id` NOT NULL with a default would give every pre-upgrade run the same wrong project and publish it into one it does not belong to, which is why `session_ledger::snapshot` skips a run with no project and names it (ISS-934).
const ADDED_COLUMNS: &[(&str, &str)] = &[
    ("project_id", "TEXT"),
    ("claim_owner", "TEXT"),
    ("claim_generation", "INTEGER NOT NULL DEFAULT 0"),
    ("claim_expires_at", "INTEGER"),
    ("revival_token", "TEXT"),
    ("revival_deadline_at", "INTEGER"),
    ("ended_by", "TEXT"),
    ("ended_reason", "TEXT"),
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

// cm:guard the order here IS the index `map_run` reads by, and nothing type-checks the pair: insert a column anywhere but the end and every field after it reads the neighbouring column's value, of the same SQLite type, with no error (ISS-964).
const SELECT_RUN: &str = "SELECT run_id, project_id, master_session_id, session_id, worktree_path, pid, boot_id,
        incarnation, work, blocker_kind, waiting_on, resume_id, session_terminal_at, worktree_gone_at,
        claim_owner, claim_generation, claim_expires_at, revival_token, revival_deadline_at,
        ended_by, ended_reason
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
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(sql_err)?;
        conn.execute_batch(SCHEMA).map_err(sql_err)?;
        Self::add_missing_columns(&conn)?;
        Ok(Self { conn })
    }

    /// Create a run for a GROUP of issues — the only way a run comes into being.
    // cm:guard the ONE public creator, and the surface test pins it: every scalar primitive below is private, so there is no entry point that takes a single issue and no caller can grow one (ISS-933 criterion 8). A second exported creator is how "one run, one issue" comes back — which is the exact defect this issue exists to remove, measured as two sessions in one worktree (pids 334254 and 335001, same cwd, 06:12-06:15Z).
    // cm:guard the membership rows and the run row are ONE transaction. A run committed without its issues is a run the refusals below cannot see, so a crash between two statements would let a second run take an issue this one already holds.
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

    // cm:guard "live" is `incarnation='live'` AND the run's boot matching this one. A row from a previous boot names a pid something else now owns (`runner/inflight.rs` carries the same rule and the incident behind it), so treating it as live would refuse a legitimate creation forever after a reboot.
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

    // cm:guard compared in RUST over the live rows, never as `worktree_path = ?1` in SQL, and the reason is the same divergence `HeldTrees` was fixed for: a run records `resolve_repo`'s answer, which prefers the path the SERVER serves, so one symlink or bind mount makes the same directory two strings. String equality here misses the refusal and `git worktree add` then puts a second agent in a tree a live run is working in (ISS-964 criterion 12).
    // cm:guard the RAW spelling is still compared as well as the resolved one — a run whose tree has since been removed cannot be canonicalised, and it must keep holding its path.
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
    // cm:guard NOT `live_run_at_path`, and the difference is the whole point: that one predicates on `incarnation = 'live' AND boot_id = ?`, which is exactly what a processless park is not. Reusing it here would report every parked tree as unheld and the reaper would delete the diff the park exists to keep.
    // cm:guard `ended_by IS NULL` is the hold, never a status word: a run reaches terminal by being ENDED, and reading any other column to mean "finished" gives the reaper a second definition of done to disagree with.
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
    // cm:guard the ONLY input the recovery path has (ISS-933 criterion 16). `incarnation` is deliberately not in the predicate: a run whose pane exited with a lease still out is exactly the row recovery exists to find, so filtering on it would hide the failure from the thing meant to repair it.
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
    // cm:guard scoped to ONE master's session id, because the question "are my children done" is asked per master and two masters share this box's ledger. A query over every run would have one project's master held open by another's work, which is the whole-box coupling residency exists to avoid.
    /// Move a run onto the master that is now serving its project.
    // cm:guard writes the parent and NOTHING else — not the boot, not the incarnation, not a mark. A respawned master is a new reader of an unchanged park, so anything else touched here would be this call inventing progress the run has not made (ISS-964 criterion 28).
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
    // cm:guard stamped AFTER the row like the pid, and for the same reason: core mints the id, so a row written with one would be naming a session that may not exist. Recovery reads it from HERE rather than from a caller, which is what makes closing the loop from the ledger alone possible (ISS-933 criterion 16).
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
    // cm:guard the pid arrives AFTER the row, never with it. A row written with a pid the spawn had not yet produced would name a process that may never exist, and the recovery path cannot tell that from a process that died — the ledger's whole value is that a recorded run with no pid is a KNOWN unstarted run rather than an unknown one.
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
    // cm:guard every mark setter here is `_observed` on purpose: the ONLY legitimate caller is one that has just read the fact back from the world (ISS-933 criterion 13). A setter named for the mark rather than for the evidence invites a caller that has merely finished doing the thing, and "I did it" is what the measured failure believed — a master reported the loop closed having done one and a half of three.
    pub fn mark_session_terminal_observed(&self, run_id: &str) -> Result<()> {
        self.stamp("session_terminal_at", run_id)
    }

    /// Stamp *worktree gone*, once the filesystem said the path is absent.
    pub fn mark_worktree_gone_observed(&self, run_id: &str) -> Result<()> {
        self.stamp("worktree_gone_at", run_id)
    }

    // cm:guard the column name is chosen from a FIXED set two lines up, never taken from a caller. This is the one place a column name is interpolated into SQL in this file, and an argument that reached it would be an injection point in a file that otherwise binds every value.
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
    // cm:guard per ISSUE and never per run (ISS-933 criterion 14). A run carrying three issues that returned one lease must read as exactly that; a single flag for the group makes a partial return indistinguishable from a clean one, which is the defect this whole close-loop exists to expose.
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
    // cm:guard the pid is refuted by a CALLER that inspected this boot's process table, and the boot comparison happens HERE so no caller can skip it. `Unknown` on a boot mismatch is not caution, it is correctness: the recorded pid names a different process now, so an answer of `Dead` would be a guess dressed as a fact (ISS-964 criterion 35).
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
    // cm:guard one transaction, and `waiting_on` is the question id the RUNNER minted. Two writes would let a crash between them leave a run pointing at a question this box has no record of asking, or a question row belonging to a run that never says it is waiting — and the pair is what makes the two halves joinable across the window where the box has parked and core has not heard (ISS-964 criterion 10).
    // cm:guard this is step ONE of three and it does NOT declare the block. Setting `work`/`incarnation` here would collapse the order criterion 10 fixes, because the declaration is what tells a ringer somebody is listening and the door is not open yet.
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
    // cm:guard the DENOMINATOR, and it is the whole reason this table exists: a ledger that records only the questions asked can say how many there were and never whether that was many, so `this master asks too much` stays a feeling. Deleting either half of `asks_and_decisions` leaves a numerator with nothing under it (ISS-964 criterion 2).
    // cm:why the verb is free text and the tier-0 inventory is NOT duplicated here — the inventory lives on ISS-964 and a second copy in Rust would drift from it in silence, which is worse than no copy.
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
    // cm:guard the asks are counted through `runs.master_session_id` rather than off the `questions` row, because a question belongs to a RUN and the session that asked it is the run's parent. Counting `questions` alone would credit a re-parented park to whichever master adopted it (ISS-964 criteria 2, 28).
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
    // cm:guard the `Listening` is a PRECONDITION expressed in the type, not a courtesy: a caller cannot declare this state without having opened the door first, which is criterion 10's ordering made unwritable rather than merely tested (ISS-964 criterion 10).
    // cm:guard `Human` and `Nobody` are REFUSED here by name. A human wait is unbounded and releases the process, so it cannot hold a read fd and must not claim `Live`; `Nobody` is a failure with a name that writes no question at all (ISS-964 criteria 4, 5, 6).
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
    // cm:guard `Exited` is the whole point and is not a detail of this call: a human wait has no time limit, so holding a runner slot for it is what the park exists to stop. A live incarnation here would make the slot unreclaimable by every reader that trusts these two columns (ISS-964 criteria 5, 8, 9).
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
    // cm:guard ownership is DECLARED and never inferred, and the generation is what makes a stale holder harmless: revoking increments it, so a revival presenting the old number is refused rather than racing (ISS-964 criteria 37, 42).
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
    // cm:guard this flips `work` to `runnable` and leaves `incarnation` at `exited`, because `exited x runnable` IS the state criterion 38 calls "owed a revival" and the state its CAS predicates on. Writing `runnable` while also clearing the block to `live` would skip the CAS and let two wakes spawn (ISS-964 criterion 38).
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
    // cm:guard exactly ONE writer may pass, and the CAS is what enforces it: the predicate is `incarnation='exited' AND work='runnable'` — the answered-and-unclaimed state — and only a row count of 1 may go on to exec. A predicate on `work='blocked'` matches zero rows for an ANSWERED park and the run is owed a revival forever (ISS-964 criterion 38).
    // cm:guard the token and the deadline are written INSIDE the same statement that wins the CAS, so recovery can tell an attempt on its way to exec from an abandoned one and may reset only an EXPIRED attempt. Without the deadline, recovery resets the window between commit and registering and a second wake wins while the first is still spawning (ISS-964 criterion 39).
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
    // cm:guard back to `exited x runnable` and NEVER to `blocked`: the answer has already arrived, so a row returned to `blocked` is a run waiting for a second answer nobody will send (ISS-964 criterion 38).
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
    // cm:guard `now >= revival_deadline_at` is the WHOLE predicate and the deadline may not be dropped from it. Recovery legitimately observes `starting` in the window between the CAS commit and the process registering, and resetting there is precisely how a second wake wins while the first is on its way to exec (ISS-964 criterion 39).
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
    // cm:guard membership is many-to-many and lease return is PER ISSUE (ISS-933 criteria 7 and 14). A run that returned one of three leases must read as exactly that — an `issue_id` column on the run, or one boolean for the group, both make a partial return indistinguishable from a clean one, which is the failure this replaced: a master reported the loop closed having done one and a half of three.
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
            // cm:guard a permit built from the FULL advertisement, so these tests keep asserting the ledger branch rather than the gate — the gate's own refusals are `blocked.rs`'s to assert.
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

    // cm:guard the refusal must survive the two path spellings the fleet actually produces: the first run records what `resolve_repo` returned (the SERVER's path) and the second may resolve through `cfg.bindings`, so a string compare misses and `git worktree add` reuses a tree a live run is working in — two agents, one worktree (ISS-964 criterion 12).
    // cm:why unix-only because the case IS a symlink: creating one on Windows needs Developer Mode or an elevated process, so the runner-ci windows job would fail on the fixture rather than on the property.
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

    // cm:guard the falsifying half of the park branch: `Human` must leave `Exited` and the other two `Live`. Assert only the pair together — a version that parks everything `Live` holds a slot for an unbounded human wait, and one that parks everything `Exited` pays a transcript re-read for a wait measured in seconds (ISS-964 criteria 4, 5).
    #[test]
    // cm:why unix-only because the contrast is the property: the bounded half calls `arm_bounded`, which needs a real FIFO, and on a platform selecting `doorbell_no_fifo.rs` there is no way to assert that a machine block KEEPS the process — so the pair cannot be split without losing what it holds.
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

    // cm:guard a `nobody` blocker must be REFUSED before anything is written, and must leave the run runnable and the question table empty. A row nobody can answer is indistinguishable from a run that is merely slow, and refusing AFTER `begin_question` would leave exactly that row (ISS-964 criteria 3, 6).
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

    // cm:guard the two arms are NOT interchangeable and each refuses the other's blocker by name. A human wait declared live holds a runner slot with no bound on it, and a bounded wait parked as human pays a transcript re-read for a wait measured in seconds (ISS-964 criteria 4, 5).
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

    // cm:guard the property the whole design exists for: waiting and dead are told apart from the LEDGER, with no process inspected. Both rows below have no live process; only the two typed columns separate them (ISS-964 criterion 9).
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

    // cm:guard a pid from ANOTHER boot is `Unknown`, never `Dead`. That number names whatever the kernel has since handed it to, so answering `Dead` would reclaim a worktree a live run is writing in (ISS-964 criteria 35, 36).
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

    // cm:guard revoking must INCREMENT the generation, because that number is the whole fence: a revival presenting the old one has to be refused rather than raced (ISS-964 criteria 40, 42).
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

    // cm:guard an answered park is `exited x runnable`, and the CAS predicates on exactly that. A predicate on `work='blocked'` matches zero rows here and the run is owed a revival forever (ISS-964 criterion 38).
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

    // cm:guard back to `runnable`, NEVER to `blocked`: the answer already arrived, so a row returned to `blocked` waits for a second answer nobody will send (ISS-964 criterion 38).
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

    // cm:guard recovery may reset only an EXPIRED attempt. It legitimately sees `starting` between the CAS commit and the process registering, and resetting there is how a second wake wins while the first is on its way to exec (ISS-964 criterion 39).
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

    // cm:guard the id is minted by the RUNNER and re-recording it is a no-op, because the box writes its half before core has heard and the same id is re-posted by the reconcile sweep (ISS-964 criterion 10).
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

    // cm:guard a park must survive the FILE being reopened, which is what makes criterion 8's "survives a reboot of the box" walkable without one: nothing about the park lives in the process.
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

    // cm:guard the migration is the reason a box that parked yesterday can be read today: `CREATE TABLE IF NOT EXISTS` adds no column, so without the ALTER pass every statement naming a new column fails at RUNTIME on the live ledger that already exists on forge-vm.
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
