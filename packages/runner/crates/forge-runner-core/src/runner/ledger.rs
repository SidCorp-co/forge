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
    Exited,
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

impl Incarnation {
    fn wire(self) -> &'static str {
        match self {
            Incarnation::Live => "live",
            Incarnation::Exited => "exited",
        }
    }
}

impl Work {
    fn wire(self) -> &'static str {
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
    pub master_session_id: String,
    pub worktree_path: PathBuf,
    pub boot_id: String,
    pub issue_keys: Vec<String>,
}

// cm:guard EVERY column of both tables is named here and the schema test asserts the database matches it EXACTLY, so a column added for a second purpose fails the build rather than quietly making this a queue (ISS-933 criterion 10). Adding one means changing this list on purpose.
#[cfg(test)]
const RUN_COLUMNS: &[&str] = &[
    "run_id",
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
    "created_at",
];

#[cfg(test)]
const RUN_ISSUE_COLUMNS: &[&str] = &["run_id", "issue_key", "lease_returned_at"];

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS runs (
  run_id              TEXT PRIMARY KEY,
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
  created_at          INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run_issues (
  run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  issue_key         TEXT NOT NULL,
  lease_returned_at INTEGER,
  PRIMARY KEY (run_id, issue_key)
);
";

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

const SELECT_RUN: &str = "SELECT run_id, master_session_id, session_id, worktree_path, pid, boot_id,
        incarnation, work, blocker_kind, waiting_on, resume_id, session_terminal_at, worktree_gone_at
 FROM runs";

fn map_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        run_id: row.get(0)?,
        master_session_id: row.get(1)?,
        session_id: row.get(2)?,
        worktree_path: PathBuf::from(row.get::<_, String>(3)?),
        pid: row.get::<_, Option<i64>>(4)?.map(|p| p as u32),
        boot_id: row.get(5)?,
        incarnation: match row.get::<_, String>(6)?.as_str() {
            "live" => Incarnation::Live,
            _ => Incarnation::Exited,
        },
        work: match row.get::<_, String>(7)?.as_str() {
            "runnable" => Work::Runnable,
            "blocked" => Work::Blocked,
            _ => Work::Done,
        },
        blocker_kind: row
            .get::<_, Option<String>>(8)?
            .and_then(|s| match s.as_str() {
                "machine" => Some(BlockerKind::Machine),
                "master_or_peer" => Some(BlockerKind::MasterOrPeer),
                "human" => Some(BlockerKind::Human),
                "nobody" => Some(BlockerKind::Nobody),
                _ => None,
            }),
        waiting_on: row.get(9)?,
        resume_id: row.get(10)?,
        session_terminal_at: row.get(11)?,
        worktree_gone_at: row.get(12)?,
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

    /// An in-memory ledger, for tests that must not touch the box.
    pub fn open_in_memory() -> Result<Self> {
        Self::from_conn(Connection::open_in_memory().map_err(sql_err)?)
    }

    fn from_conn(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(sql_err)?;
        conn.execute_batch(SCHEMA).map_err(sql_err)?;
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
            "INSERT INTO runs (run_id, master_session_id, worktree_path, pid, boot_id, incarnation, work, created_at)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7)",
            params![
                new.run_id,
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

    fn live_run_at_path(
        tx: &rusqlite::Transaction<'_>,
        path: &str,
        boot_id: &str,
    ) -> Result<Option<String>> {
        tx.query_row(
            "SELECT run_id FROM runs WHERE worktree_path = ?1 AND incarnation = 'live' AND boot_id = ?2 LIMIT 1",
            params![path, boot_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_err)
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

    const SOURCE: &str = include_str!("ledger.rs");

    fn seed(issues: &[&str]) -> NewRun {
        NewRun {
            run_id: "run-1".into(),
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
    fn incarnation_and_work_are_separate_columns_so_waiting_is_not_dead() {
        let cols = RUN_COLUMNS;
        assert!(cols.contains(&"incarnation") && cols.contains(&"work"));
        assert!(
            !cols.contains(&"status") && !cols.contains(&"state"),
            "one status string cannot say both `is the process there` and `can it move` (ISS-964 criterion 9)"
        );
    }
}
