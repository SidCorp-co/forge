//! The box's register of run sessions: which run, whose master, which worktree,
//! which pid under which boot — and WHICH ISSUES (ISS-933 wave 2).
//!
//! A run used to be a `jobs` row, so core answered every question about it. A
//! run session mints no job, so nothing central knows it exists; this is what
//! knows. It is a REGISTRY and refuses to be a cursor as well —
//! `schema_is_registry_only` fails the build on the column that tries.
//!
//! Two invariants stand in for the repo-root lock this design deletes, and they
//! are enforced here rather than assumed of the master: an issue belongs to at
//! most ONE live run, and a worktree path is held by at most ONE live run. Both
//! refuse BY NAME, naming the run that already holds the thing.
//!
//! Design: the issue body's *Sổ đăng ký* and *Một run session mang NHIỀU issue*.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{Error, Result};

/// Statuses core's `agent_sessions` treats as terminal.
// cm:edge contract -> packages/core/src/db/schema.ts — `terminalAgentSessionStatuses`. A status added there and not here leaves a finished run reading as live forever, and the master that waits on it never exits.
const TERMINAL_SESSION_STATUSES: &[&str] = &["completed", "failed", "cancelled", "timeout"];

/// How the two axes of a run are named, kept apart on purpose (ISS-964).
///
/// `incarnation` is whether a process exists; `work` is what the run is doing.
/// One status string cannot say "parked and waiting" as distinct from "dead",
/// which is the distinction the whole park design rests on.
pub const INCARNATION_LIVE: &str = "live";
pub const INCARNATION_GONE: &str = "gone";
pub const WORK_RUNNING: &str = "running";
pub const WORK_BLOCKED: &str = "blocked";
pub const WORK_DONE: &str = "done";

/// What a ledger refuses, and what it names when it does.
// cm:guard every variant NAMES the run or the path that caused the refusal. A refusal that says only "already exists" is the ISS-593 failure with a different spelling — the operator still cannot tell which run to look at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// This issue is already carried by a run that has not reached terminal.
    IssueHeld { issue_key: String, run_id: String },
    /// This worktree path is already held by a run that has not reached terminal.
    WorktreeHeld { path: String, run_id: String },
    /// A run carries a GROUP, and the empty group is not one.
    EmptyGroup,
    /// This box cannot tell one boot from another, so a pid it recorded could
    /// name a stranger's process after a reboot.
    NoBootIdentity,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::IssueHeld { issue_key, run_id } => write!(
                f,
                "{issue_key} is already carried by run {run_id}, which has not closed its loop — refusing to start a second run for it"
            ),
            Refusal::WorktreeHeld { path, run_id } => write!(
                f,
                "{path} is already held by run {run_id} — refusing to create a worktree over a live run's tree"
            ),
            Refusal::EmptyGroup => {
                write!(f, "a run carries at least one issue; this group named none")
            }
            Refusal::NoBootIdentity => write!(
                f,
                "this box has no boot identity, so a recorded pid could not be told from a stranger's after a reboot"
            ),
        }
    }
}

impl From<Refusal> for Error {
    fn from(r: Refusal) -> Self {
        Error::Other(r.to_string())
    }
}

/// One run as the ledger holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub id: String,
    pub master_session_id: String,
    pub project_id: String,
    pub worktree_path: String,
    pub pane: String,
    pub pid: Option<u32>,
    pub boot_id: String,
    pub incarnation: String,
    pub work: String,
    pub issues: Vec<IssueMembership>,
    pub session_terminal_at: Option<i64>,
    pub worktree_removed_at: Option<i64>,
    pub closed_at: Option<i64>,
}

/// One issue's membership of a run, and its own lease mark.
// cm:guard the lease mark lives HERE and not on the run. A run carrying three issues holds three leases, and one mark on the run could only ever record "some were returned" — which is the defect the close-loop exists to catch, multiplied by the size of the group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueMembership {
    pub issue_key: String,
    pub lease_returned_at: Option<i64>,
}

/// What a reader can tell about a run's close loop from the ledger ALONE.
// cm:guard `complete` is DERIVED from the marks and is never stored. A stored boolean is a fourth thing that can disagree with the three marks, and the measured failure this exists for is exactly a declaration disagreeing with what happened — a master reporting the loop closed having done one and a half of three.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseState {
    pub session_terminal: bool,
    pub worktree_gone: bool,
    pub leases_returned: usize,
    pub leases_total: usize,
    pub complete: bool,
}

impl CloseState {
    /// A one-line account an operator can read without inspecting a process.
    pub fn describe(&self) -> String {
        if self.complete {
            return "closed: session terminal, worktree gone, every lease returned".into();
        }
        let mut missing: Vec<String> = Vec::new();
        if !self.session_terminal {
            missing.push("session not observed terminal".into());
        }
        if !self.worktree_gone {
            missing.push("worktree still on disk".into());
        }
        if self.leases_returned < self.leases_total {
            missing.push(format!(
                "{} of {} leases returned",
                self.leases_returned, self.leases_total
            ));
        }
        format!("partially closed — {}", missing.join(", "))
    }
}

/// Proof the runner read the AUTHORITATIVE session row back, rather than
/// trusting the response to the write that terminated it.
// cm:guard constructible only from a status the tracker reported on a READ. An ack to a `close` is the write's own echo: it says the request was accepted, never that the row reached terminal, and a mark set from one is set optimistically by definition.
#[derive(Debug, Clone, Copy)]
pub struct SessionTerminalRead(());

impl SessionTerminalRead {
    /// `None` for any status that is not terminal, and for a read that failed —
    /// the caller has nothing to pass and the mark stays unset.
    pub fn from_authoritative_read(status: &str) -> Option<Self> {
        TERMINAL_SESSION_STATUSES
            .contains(&status)
            .then_some(Self(()))
    }
}

/// Proof THIS box looked at its own filesystem and the worktree is not there.
// cm:guard the observation is made here, from the path, and cannot be asserted. `git worktree remove` returning 0 is not the same claim: it says the command succeeded, and a tree recreated a second later by anything else would leave a mark that is true about a moment and false about the world.
#[derive(Debug, Clone, Copy)]
pub struct WorktreeAbsent(());

impl WorktreeAbsent {
    pub fn observe(path: &Path) -> Option<Self> {
        (!path.exists()).then_some(Self(()))
    }
}

/// Proof the tracker was read back FOR THIS ISSUE and no longer names this run.
// cm:guard the argument is the holder the tracker reports, not the response to the return. A dropped response and a stale success both look like success to a caller reading its own request's result; only a read answers who holds the lease now.
#[derive(Debug, Clone, Copy)]
pub struct LeaseReturnRead(());

impl LeaseReturnRead {
    /// `None` while the tracker still names this run as the holder.
    pub fn from_authoritative_read(holder: Option<&str>, run_id: &str) -> Option<Self> {
        match holder {
            Some(h) if h == run_id => None,
            _ => Some(Self(())),
        }
    }
}

/// What a caller must know before it creates a run.
#[derive(Debug, Clone)]
pub struct RunSpec {
    pub run_id: String,
    pub master_session_id: String,
    pub project_id: String,
    pub worktree_path: PathBuf,
    pub pane: String,
    /// The group. One issue is a group of one and takes this same path.
    pub issue_keys: Vec<String>,
}

/// The register itself.
pub struct Ledger {
    conn: Mutex<Connection>,
    boot_id: Option<String>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS runs (
  id                  TEXT PRIMARY KEY,
  master_session_id   TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  worktree_path       TEXT NOT NULL,
  pane                TEXT NOT NULL,
  pid                 INTEGER,
  boot_id             TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  incarnation         TEXT NOT NULL,
  work                TEXT NOT NULL,
  blocker_kind        TEXT,
  waiting_on          TEXT,
  resume_id           TEXT,
  session_terminal_at INTEGER,
  worktree_removed_at INTEGER,
  closed_at           INTEGER
);

CREATE TABLE IF NOT EXISTS run_issues (
  run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  issue_key         TEXT NOT NULL,
  lease_returned_at INTEGER,
  PRIMARY KEY (run_id, issue_key)
);

CREATE INDEX IF NOT EXISTS run_issues_by_issue ON run_issues (issue_key);
CREATE INDEX IF NOT EXISTS runs_by_master ON runs (master_session_id);
"#;

/// Column names no registry may grow.
// cm:guard this list is the SHAPE of the second purpose, not a spelling of it. The ledger answers "what exists on this box"; an event cursor answers "how far has this box read", and a table holding both is written on every frame and trusted on none. ISS-933's body puts it plainly: *"Không làm cursor cho event; trộn hai mục đích là chỗ dễ sai."*
pub const FORBIDDEN_COLUMN_MARKERS: &[&str] =
    &["cursor", "offset", "seq", "wake", "event", "watermark"];

impl Ledger {
    /// Open the register at `path`, creating it and its schema if absent.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path).map_err(sqlite_err)?;
        Self::from_connection(conn)
    }

    /// A register that lives only as long as the test that made it.
    pub fn in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory().map_err(sqlite_err)?)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
        )
        .map_err(sqlite_err)?;
        conn.execute_batch(SCHEMA).map_err(sqlite_err)?;
        Ok(Self {
            conn: Mutex::new(conn),
            boot_id: super::inflight::boot_identity(),
        })
    }

    /// Pretend this register was written by another boot, for the recovery tests.
    #[cfg(test)]
    fn with_boot_id(mut self, boot: &str) -> Self {
        self.boot_id = Some(boot.to_string());
        self
    }

    /// Where the register lives on a real box.
    pub fn default_path() -> Option<PathBuf> {
        dirs_next::config_dir().map(|d| d.join("forge-runner").join("ledger.sqlite3"))
    }

    /// Create a run carrying a GROUP of issues. The only way a run is made.
    ///
    /// The row and every membership are committed BEFORE the caller spawns
    /// anything, so a crash between the two leaves a recorded worktree with no
    /// process — recoverable — rather than a process no record names.
    // cm:guard this is the ONE exported creation symbol, and `scalar_creation_is_private` below is what keeps it so. A `create_run_for_issue` beside it would encode the default this change exists to reverse: a group of one has to be the same path as a group of three, or the path taken once a month is the one that rots.
    // cm:guard `BEGIN IMMEDIATE`, never a deferred read-then-write. Both refusals below are read-decide-write, and under SQLite's default deferred transaction two masters can both read "free" and both insert — the invariant would then live in the gap the repo-root lock used to cover.
    pub fn create_run_for_group(&self, spec: &RunSpec) -> std::result::Result<Run, Refusal> {
        if spec.issue_keys.is_empty() {
            return Err(Refusal::EmptyGroup);
        }
        let boot = self.boot_id.clone().ok_or(Refusal::NoBootIdentity)?;
        let worktree = spec.worktree_path.to_string_lossy().to_string();

        let mut conn = self.conn.lock().expect("ledger poisoned");
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| Refusal::WorktreeHeld {
                path: worktree.clone(),
                run_id: format!("<ledger unreadable: {e}>"),
            })?;

        if let Some(holder) = live_run_for_worktree(&tx, &worktree) {
            return Err(Refusal::WorktreeHeld {
                path: worktree,
                run_id: holder,
            });
        }
        for key in &spec.issue_keys {
            if let Some(holder) = live_run_for_issue(&tx, key) {
                return Err(Refusal::IssueHeld {
                    issue_key: key.clone(),
                    run_id: holder,
                });
            }
        }

        let now = now_ms();
        tx.execute(
            "INSERT INTO runs (id, master_session_id, project_id, worktree_path, pane, pid, boot_id, created_at, incarnation, work) \
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9)",
            params![
                spec.run_id,
                spec.master_session_id,
                spec.project_id,
                worktree,
                spec.pane,
                boot,
                now,
                INCARNATION_LIVE,
                WORK_RUNNING
            ],
        )
        .map_err(|e| Refusal::WorktreeHeld {
            path: worktree.clone(),
            run_id: format!("<insert refused: {e}>"),
        })?;

        let mut keys = spec.issue_keys.clone();
        keys.sort();
        keys.dedup();
        for key in &keys {
            tx.execute(
                "INSERT INTO run_issues (run_id, issue_key, lease_returned_at) VALUES (?1, ?2, NULL)",
                params![spec.run_id, key],
            )
            .map_err(|e| Refusal::IssueHeld {
                issue_key: key.clone(),
                run_id: format!("<insert refused: {e}>"),
            })?;
        }
        tx.commit().map_err(|e| Refusal::WorktreeHeld {
            path: worktree.clone(),
            run_id: format!("<commit refused: {e}>"),
        })?;
        drop(conn);

        self.run(&spec.run_id)
            .ok_or(Refusal::EmptyGroup)
            .map_err(|_| Refusal::WorktreeHeld {
                path: worktree,
                run_id: "<row vanished after commit>".into(),
            })
    }

    /// Record the pid of the process the caller has just spawned for `run_id`.
    pub fn record_pid(&self, run_id: &str, pid: u32) -> Result<()> {
        let conn = self.conn.lock().expect("ledger poisoned");
        conn.execute(
            "UPDATE runs SET pid = ?2 WHERE id = ?1",
            params![run_id, pid],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    /// One run, with its whole group.
    pub fn run(&self, run_id: &str) -> Option<Run> {
        let conn = self.conn.lock().expect("ledger poisoned");
        read_run(&conn, run_id)
    }

    /// Every run this master owns that has not closed its loop.
    // cm:guard this is what "are the children done" is answered from, and it must stay a LEDGER read. The counter it replaces was wrong by a factor of six — `pool load` reported `jobsRunning: 1` while six agents ran — and a master that exits on a wrong zero takes its children's close loop with it.
    pub fn open_runs_for_master(&self, master_session_id: &str) -> Vec<Run> {
        let conn = self.conn.lock().expect("ledger poisoned");
        let ids = collect_ids(
            &conn,
            "SELECT id FROM runs WHERE master_session_id = ?1 AND closed_at IS NULL ORDER BY created_at",
            params![master_session_id],
        );
        ids.iter().filter_map(|id| read_run(&conn, id)).collect()
    }

    /// Every run with an unfinished close loop, whatever master owns it.
    ///
    /// The daemon's recovery list: a master that died mid-run leaves its marks
    /// here, and closing them is idempotent, so a retry costs a re-read.
    pub fn runs_needing_close(&self) -> Vec<Run> {
        let conn = self.conn.lock().expect("ledger poisoned");
        let ids = collect_ids(
            &conn,
            "SELECT id FROM runs WHERE closed_at IS NULL ORDER BY created_at",
            params![],
        );
        ids.iter().filter_map(|id| read_run(&conn, id)).collect()
    }

    /// Whether this run was recorded by the boot we are running now.
    // cm:guard a pid means nothing across a reboot, so a row from a previous boot is READ but never ACTED on. `inflight.rs` learned this the hard way: an empty-string boot identity compared equal to itself and sent `kill_group` at a pid a stranger now owned.
    pub fn is_current_boot(&self, run: &Run) -> bool {
        match self.boot_id.as_deref() {
            Some(now) => !now.is_empty() && run.boot_id == now,
            None => false,
        }
    }

    /// The close loop as the ledger alone can report it.
    pub fn close_state(&self, run_id: &str) -> Option<CloseState> {
        self.run(run_id).map(|r| close_state_of(&r))
    }

    /// Mark the run's session observed terminal. Idempotent.
    pub fn mark_session_terminal(&self, run_id: &str, _read: SessionTerminalRead) -> Result<()> {
        self.set_mark("session_terminal_at", run_id)
    }

    /// Mark the run's worktree observed absent from this box. Idempotent.
    pub fn mark_worktree_gone(&self, run_id: &str, _seen: WorktreeAbsent) -> Result<()> {
        self.set_mark("worktree_removed_at", run_id)
    }

    /// Mark ONE issue's lease observed returned. Idempotent, and per issue.
    pub fn mark_lease_returned(
        &self,
        run_id: &str,
        issue_key: &str,
        _read: LeaseReturnRead,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("ledger poisoned");
        conn.execute(
            "UPDATE run_issues SET lease_returned_at = ?3 \
             WHERE run_id = ?1 AND issue_key = ?2 AND lease_returned_at IS NULL",
            params![run_id, issue_key, now_ms()],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    /// Stamp `closed_at` if and only if all three marks are set.
    ///
    /// Answers whether it closed, so a caller can retry rather than assume.
    // cm:guard the stamp is DERIVED here and is never a parameter. A caller that could pass "closed" would be a master declaring the loop shut, which is the one thing every mark on this run is designed not to accept.
    pub fn close_if_complete(&self, run_id: &str) -> Result<bool> {
        let Some(run) = self.run(run_id) else {
            return Ok(false);
        };
        if !close_state_of(&run).complete {
            return Ok(false);
        }
        let conn = self.conn.lock().expect("ledger poisoned");
        conn.execute(
            "UPDATE runs SET closed_at = ?2, incarnation = ?3, work = ?4 WHERE id = ?1 AND closed_at IS NULL",
            params![run_id, now_ms(), INCARNATION_GONE, WORK_DONE],
        )
        .map_err(sqlite_err)?;
        Ok(true)
    }

    /// Park a run on a blocker, keeping the two axes apart (ISS-964).
    pub fn park(&self, run_id: &str, blocker_kind: &str, waiting_on: &str) -> Result<()> {
        let conn = self.conn.lock().expect("ledger poisoned");
        conn.execute(
            "UPDATE runs SET work = ?2, blocker_kind = ?3, waiting_on = ?4 WHERE id = ?1",
            params![run_id, WORK_BLOCKED, blocker_kind, waiting_on],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    /// Record that no process is behind this run any more, whatever its work.
    pub fn mark_incarnation_gone(&self, run_id: &str) -> Result<()> {
        let conn = self.conn.lock().expect("ledger poisoned");
        conn.execute(
            "UPDATE runs SET incarnation = ?2 WHERE id = ?1",
            params![run_id, INCARNATION_GONE],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    /// The columns the register actually has, for the registry-only assertion.
    pub fn columns(&self, table: &str) -> Vec<String> {
        let conn = self.conn.lock().expect("ledger poisoned");
        let mut stmt = match conn.prepare(&format!("PRAGMA table_info({table})")) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], |r| r.get::<_, String>(1));
        match rows {
            Ok(it) => it.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn set_mark(&self, column: &'static str, run_id: &str) -> Result<()> {
        let conn = self.conn.lock().expect("ledger poisoned");
        conn.execute(
            &format!("UPDATE runs SET {column} = ?2 WHERE id = ?1 AND {column} IS NULL"),
            params![run_id, now_ms()],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }
}

fn close_state_of(run: &Run) -> CloseState {
    let returned = run
        .issues
        .iter()
        .filter(|i| i.lease_returned_at.is_some())
        .count();
    let total = run.issues.len();
    let session_terminal = run.session_terminal_at.is_some();
    let worktree_gone = run.worktree_removed_at.is_some();
    CloseState {
        session_terminal,
        worktree_gone,
        leases_returned: returned,
        leases_total: total,
        complete: session_terminal && worktree_gone && returned == total,
    }
}

fn live_run_for_issue(conn: &Connection, issue_key: &str) -> Option<String> {
    conn.query_row(
        "SELECT r.id FROM runs r JOIN run_issues ri ON ri.run_id = r.id \
         WHERE ri.issue_key = ?1 AND r.closed_at IS NULL LIMIT 1",
        params![issue_key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn live_run_for_worktree(conn: &Connection, path: &str) -> Option<String> {
    conn.query_row(
        "SELECT id FROM runs WHERE worktree_path = ?1 AND closed_at IS NULL LIMIT 1",
        params![path],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn collect_ids<P: rusqlite::Params>(conn: &Connection, sql: &str, p: P) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let ids = match stmt.query_map(p, |r| r.get::<_, String>(0)) {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    };
    ids
}

fn read_run(conn: &Connection, run_id: &str) -> Option<Run> {
    let mut run = conn
        .query_row(
            "SELECT id, master_session_id, project_id, worktree_path, pane, pid, boot_id, \
                    incarnation, work, session_terminal_at, worktree_removed_at, closed_at \
             FROM runs WHERE id = ?1",
            params![run_id],
            |row| {
                Ok(Run {
                    id: row.get(0)?,
                    master_session_id: row.get(1)?,
                    project_id: row.get(2)?,
                    worktree_path: row.get(3)?,
                    pane: row.get(4)?,
                    pid: row.get::<_, Option<i64>>(5)?.map(|v| v as u32),
                    boot_id: row.get(6)?,
                    incarnation: row.get(7)?,
                    work: row.get(8)?,
                    issues: Vec::new(),
                    session_terminal_at: row.get(9)?,
                    worktree_removed_at: row.get(10)?,
                    closed_at: row.get(11)?,
                })
            },
        )
        .optional()
        .ok()
        .flatten()?;

    let mut stmt = conn
        .prepare(
            "SELECT issue_key, lease_returned_at FROM run_issues WHERE run_id = ?1 ORDER BY issue_key",
        )
        .ok()?;
    let rows = stmt
        .query_map(params![run_id], |r| {
            Ok(IssueMembership {
                issue_key: r.get(0)?,
                lease_returned_at: r.get(1)?,
            })
        })
        .ok()?;
    run.issues = rows.filter_map(|r| r.ok()).collect();
    Some(run)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sqlite_err(e: rusqlite::Error) -> Error {
    Error::Other(format!("ledger: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOOT: &str = "boot-under-test";

    fn ledger() -> Ledger {
        Ledger::in_memory().expect("ledger").with_boot_id(BOOT)
    }

    fn spec(run: &str, tree: &str, issues: &[&str]) -> RunSpec {
        RunSpec {
            run_id: run.into(),
            master_session_id: "master-1".into(),
            project_id: "proj-1".into(),
            worktree_path: PathBuf::from(tree),
            pane: format!("forge-run-{run}"),
            issue_keys: issues.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn close_cleanly(l: &Ledger, run: &Run) {
        l.mark_session_terminal(
            &run.id,
            SessionTerminalRead::from_authoritative_read("completed").unwrap(),
        )
        .unwrap();
        l.mark_worktree_gone(
            &run.id,
            WorktreeAbsent::observe(Path::new("/nope/gone")).unwrap(),
        )
        .unwrap();
        for i in &run.issues {
            l.mark_lease_returned(
                &run.id,
                &i.issue_key,
                LeaseReturnRead::from_authoritative_read(None, &run.id).unwrap(),
            )
            .unwrap();
        }
        l.close_if_complete(&run.id).unwrap();
    }

    // cm:guard criterion 7 — membership is MANY-TO-MANY. A single `issue_id` column would pass a test that only ever creates one-issue runs, which is why this one asserts the count on a group of three and reads it back off the ledger rather than off the spec.
    #[test]
    fn a_run_carries_a_group_and_the_ledger_reads_all_of_it_back() {
        let l = ledger();
        let run = l
            .create_run_for_group(&spec(
                "r1",
                "/w/attachments",
                &["ISS-957", "ISS-963", "ISS-964"],
            ))
            .expect("created");
        assert_eq!(run.issues.len(), 3);
        let keys: Vec<&str> = run.issues.iter().map(|i| i.issue_key.as_str()).collect();
        assert_eq!(keys, vec!["ISS-957", "ISS-963", "ISS-964"]);
        assert!(run.issues.iter().all(|i| i.lease_returned_at.is_none()));
    }

    // cm:guard criterion 8's behavioural half. The CONTINUOUS half is `scalar_creation_is_private` below; this only says the two sizes reach the same row shape, which a second entry point could also satisfy.
    #[test]
    fn a_group_of_one_takes_the_same_path_as_a_group_of_three() {
        let l = ledger();
        let one = l
            .create_run_for_group(&spec("r1", "/w/a", &["ISS-1"]))
            .unwrap();
        let three = l
            .create_run_for_group(&spec("r2", "/w/b", &["ISS-2", "ISS-3", "ISS-4"]))
            .unwrap();
        assert_eq!(one.issues.len(), 1);
        assert_eq!(three.issues.len(), 3);
        assert_eq!(one.work, three.work);
        assert_eq!(one.incarnation, three.incarnation);
    }

    #[test]
    fn the_empty_group_is_refused() {
        let l = ledger();
        assert_eq!(
            l.create_run_for_group(&spec("r1", "/w/a", &[]))
                .unwrap_err(),
            Refusal::EmptyGroup
        );
    }

    // cm:guard criterion 9 — the refusal NAMES the run that holds the issue. "already exists" is the ISS-593 failure respelled.
    #[test]
    fn an_issue_already_in_a_live_run_is_refused_by_name() {
        let l = ledger();
        l.create_run_for_group(&spec("r1", "/w/a", &["ISS-1", "ISS-2"]))
            .unwrap();
        let err = l
            .create_run_for_group(&spec("r2", "/w/b", &["ISS-2"]))
            .unwrap_err();
        assert_eq!(
            err,
            Refusal::IssueHeld {
                issue_key: "ISS-2".into(),
                run_id: "r1".into()
            }
        );
        assert!(
            err.to_string().contains("r1"),
            "refusal must name the run: {err}"
        );
    }

    #[test]
    fn an_issue_is_free_again_once_its_run_closed_its_loop() {
        let l = ledger();
        let first = l
            .create_run_for_group(&spec("r1", "/w/a", &["ISS-1"]))
            .unwrap();
        close_cleanly(&l, &first);
        l.create_run_for_group(&spec("r2", "/w/b", &["ISS-1"]))
            .expect("a closed run holds nothing");
    }

    // cm:guard criterion 12 — refused BEFORE `git worktree add` runs, which is the whole point: the failure being replaced is git's own, arriving after the tree is half-made.
    #[test]
    fn a_worktree_path_a_live_run_holds_is_refused_by_name() {
        let l = ledger();
        l.create_run_for_group(&spec("r1", "/w/shared", &["ISS-1"]))
            .unwrap();
        let err = l
            .create_run_for_group(&spec("r2", "/w/shared", &["ISS-2"]))
            .unwrap_err();
        assert_eq!(
            err,
            Refusal::WorktreeHeld {
                path: "/w/shared".into(),
                run_id: "r1".into()
            }
        );
    }

    // cm:guard criterion 11 — the measured pair, replayed. ISS-957 and ISS-963 touch one file set; one run, one worktree, and the ledger refuses anything that would put a second session on that tree.
    #[test]
    fn the_measured_pair_is_one_run_in_one_worktree() {
        let l = ledger();
        let run = l
            .create_run_for_group(&spec("r1", "/w/attachments", &["ISS-957", "ISS-963"]))
            .unwrap();
        assert_eq!(run.worktree_path, "/w/attachments");
        assert_eq!(run.issues.len(), 2);
        for key in ["ISS-957", "ISS-963"] {
            assert!(matches!(
                l.create_run_for_group(&spec("r2", "/w/attachments-2", &[key])),
                Err(Refusal::IssueHeld { .. })
            ));
        }
    }

    // cm:guard criterion 10 — a registry ONLY. This fails on the column, before anything reads it, because the mistake is cheap to make and invisible afterwards.
    #[test]
    fn schema_is_registry_only() {
        let l = ledger();
        for table in ["runs", "run_issues"] {
            for col in l.columns(table) {
                let lower = col.to_lowercase();
                for marker in FORBIDDEN_COLUMN_MARKERS {
                    assert!(
                        !lower.contains(marker),
                        "{table}.{col} looks like a `{marker}` — the ledger is a registry, not an event cursor"
                    );
                }
            }
        }
    }

    // cm:guard criterion 8's CONTINUOUS half, and it is a source scan rather than a behavioural test on purpose: a behavioural test passes forever while someone adds a second exported creator beside the first. `packages/runner/**` is excluded from `.arch.json`, so archmap cannot hold this; `cargo test --workspace` runs in the same gate and can.
    #[test]
    fn scalar_creation_is_private() {
        let src = include_str!("ledger.rs");
        let exported: Vec<&str> = src
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("pub fn create") || l.starts_with("pub fn new_run"))
            .collect();
        assert_eq!(
            exported,
            vec![
                "pub fn create_run_for_group(&self, spec: &RunSpec) -> std::result::Result<Run, Refusal> {"
            ],
            "exactly one creation path may be exported, and it takes a GROUP"
        );
    }

    // cm:guard criterion 13 — a master's declaration sets NO mark. There is no API taking one, so this asserts the shape of the witnesses instead: a mark needs one only an observation can construct.
    #[test]
    fn a_lying_master_can_set_no_mark() {
        assert!(SessionTerminalRead::from_authoritative_read("running").is_none());
        assert!(SessionTerminalRead::from_authoritative_read("").is_none());
        assert!(WorktreeAbsent::observe(Path::new(".")).is_none());
        assert!(LeaseReturnRead::from_authoritative_read(Some("r1"), "r1").is_none());
    }

    // cm:guard criterion 13 — a DROPPED response is not a read. The caller has no status to pass, so it passes nothing, the mark stays unset, and the run stays on the retry list.
    #[test]
    fn a_dropped_lease_response_leaves_the_mark_unset_and_the_run_retryable() {
        let l = ledger();
        let run = l
            .create_run_for_group(&spec("r1", "/w/a", &["ISS-1"]))
            .unwrap();
        let state = l.close_state(&run.id).unwrap();
        assert_eq!(state.leases_returned, 0);
        assert!(!state.complete);
        assert!(l.runs_needing_close().iter().any(|r| r.id == "r1"));
    }

    // cm:guard criterion 13 — a STALE success. The tracker still names this run as holder, so the return did not take effect however the write answered.
    #[test]
    fn a_stale_success_leaves_the_lease_mark_unset() {
        assert!(LeaseReturnRead::from_authoritative_read(Some("r1"), "r1").is_none());
        assert!(LeaseReturnRead::from_authoritative_read(Some("r2"), "r1").is_some());
        assert!(LeaseReturnRead::from_authoritative_read(None, "r1").is_some());
    }

    // cm:guard criteria 14 and 15 — one of three returned is READABLE as exactly that, from the ledger with no process inspected. The measured failure was a master reporting the loop closed having done one and a half of three.
    #[test]
    fn one_of_three_leases_returned_is_readable_as_exactly_that() {
        let l = ledger();
        let run = l
            .create_run_for_group(&spec("r1", "/w/a", &["ISS-1", "ISS-2", "ISS-3"]))
            .unwrap();
        l.mark_lease_returned(
            &run.id,
            "ISS-2",
            LeaseReturnRead::from_authoritative_read(None, &run.id).unwrap(),
        )
        .unwrap();
        l.mark_session_terminal(
            &run.id,
            SessionTerminalRead::from_authoritative_read("completed").unwrap(),
        )
        .unwrap();

        let state = l.close_state(&run.id).unwrap();
        assert_eq!((state.leases_returned, state.leases_total), (1, 3));
        assert!(state.session_terminal);
        assert!(!state.worktree_gone);
        assert!(!state.complete);
        assert!(!l.close_if_complete(&run.id).unwrap());
        assert!(l.run(&run.id).unwrap().closed_at.is_none());
        assert!(state.describe().contains("1 of 3 leases returned"));
    }

    #[test]
    fn a_cleanly_closed_run_reads_as_closed_and_a_partial_one_does_not() {
        let l = ledger();
        let clean = l
            .create_run_for_group(&spec("r1", "/w/a", &["ISS-1"]))
            .unwrap();
        let partial = l
            .create_run_for_group(&spec("r2", "/w/b", &["ISS-2"]))
            .unwrap();
        close_cleanly(&l, &clean);
        l.mark_session_terminal(
            &partial.id,
            SessionTerminalRead::from_authoritative_read("failed").unwrap(),
        )
        .unwrap();

        assert!(l.close_state("r1").unwrap().complete);
        assert!(!l.close_state("r2").unwrap().complete);
        assert!(l.run("r1").unwrap().closed_at.is_some());
        assert!(l.run("r2").unwrap().closed_at.is_none());
        assert_eq!(l.runs_needing_close().len(), 1);
    }

    #[test]
    fn marks_are_idempotent_so_a_retry_costs_a_re_read() {
        let l = ledger();
        let run = l
            .create_run_for_group(&spec("r1", "/w/a", &["ISS-1"]))
            .unwrap();
        close_cleanly(&l, &run);
        let first = l.run("r1").unwrap();
        close_cleanly(&l, &first);
        assert_eq!(l.run("r1").unwrap(), first);
    }

    // cm:guard criterion 6 — a row from a PREVIOUS boot is read and never acted on. `is_current_boot` is the only thing a pid-touching caller may gate on.
    #[test]
    fn a_row_from_a_previous_boot_is_never_current() {
        let l = ledger();
        let run = l
            .create_run_for_group(&spec("r1", "/w/a", &["ISS-1"]))
            .unwrap();
        assert!(l.is_current_boot(&run));

        let rebooted = Ledger::in_memory().unwrap().with_boot_id("a-later-boot");
        assert!(!rebooted.is_current_boot(&run));

        let mut blind = Ledger::in_memory().unwrap();
        blind.boot_id = None;
        assert!(!blind.is_current_boot(&run));
    }

    #[test]
    fn a_box_with_no_boot_identity_creates_no_run() {
        let mut l = Ledger::in_memory().unwrap();
        l.boot_id = None;
        assert_eq!(
            l.create_run_for_group(&spec("r1", "/w/a", &["ISS-1"]))
                .unwrap_err(),
            Refusal::NoBootIdentity
        );
    }

    // cm:guard criterion 20 — "are the children done" is a LEDGER read. The counter it replaces was wrong by a factor of six: `pool load` reported `jobsRunning: 1` while six agents ran.
    #[test]
    fn a_masters_open_runs_come_from_the_ledger_not_a_counter() {
        let l = ledger();
        let a = l
            .create_run_for_group(&spec("r1", "/w/a", &["ISS-1"]))
            .unwrap();
        l.create_run_for_group(&spec("r2", "/w/b", &["ISS-2", "ISS-3"]))
            .unwrap();
        assert_eq!(l.open_runs_for_master("master-1").len(), 2);
        close_cleanly(&l, &a);
        let left = l.open_runs_for_master("master-1");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, "r2");
        assert!(l.open_runs_for_master("master-2").is_empty());
    }

    // cm:guard ISS-964's two axes are SEPARATE columns. A parked run is `live` and `blocked`; a dead one is `gone`. One status string cannot say both, which is the property that whole design rests on.
    #[test]
    fn parked_and_dead_are_distinguishable_without_inspecting_a_process() {
        let l = ledger();
        let parked = l
            .create_run_for_group(&spec("r1", "/w/a", &["ISS-1"]))
            .unwrap();
        let dead = l
            .create_run_for_group(&spec("r2", "/w/b", &["ISS-2"]))
            .unwrap();
        l.park(&parked.id, "human", "ISS-1 needs an owner decision")
            .unwrap();
        l.mark_incarnation_gone(&dead.id).unwrap();

        let parked = l.run("r1").unwrap();
        assert_eq!(
            (parked.incarnation.as_str(), parked.work.as_str()),
            ("live", "blocked")
        );
        let dead = l.run("r2").unwrap();
        assert_eq!(
            (dead.incarnation.as_str(), dead.work.as_str()),
            ("gone", "running")
        );
    }
}
