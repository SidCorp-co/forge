//! The run ledger, read and never written.
//!
//! `Ledger::open` migrates under an IMMEDIATE write transaction every time it
//! opens (`runner/ledger.rs:Ledger::migrate`), so no reader built on it can
//! promise the file is left alone — and a view an operator leaves running
//! against a live box would take that write lock every frame. This opens the
//! file `SQLITE_OPEN_READ_ONLY` and asks it only `SELECT`s.
//!
//! The price is that these queries name the ledger's columns themselves. Two
//! things hold that coupling: every column read is checked with `PRAGMA
//! table_info` first, so a ledger of another shape is refused naming the
//! column rather than misread; and this file's tests plant the ledger through
//! `Ledger::open`, so a column renamed there fails here before any box does.
//!
//! It does not read `master_standing`. `runner/ledger.rs`'s
//! `nothing_outside_this_module_writes_the_standing_table` refuses any file
//! outside the ledger that holds the table's name after `FROM`, which a
//! `SELECT` does as much as a `DELETE`; `master status` prints a stand-down.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use super::source::{Read, Unreadable};

/// One run the ledger says still holds something: a lease not yet returned,
/// or a park on a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub run_id: String,
    pub project_id: Option<String>,
    pub master_session_id: String,
    pub boot_id: String,
    pub worktree_path: PathBuf,
    pub worktree_gone_at: Option<i64>,
    pub released_as: Option<String>,
    pub ended_by: Option<String>,
    /// What the daemon last said about this run's standing, in its own word.
    pub kept_notice: Option<String>,
    pub incarnation: String,
    pub work: String,
    pub blocker_kind: Option<String>,
    pub waiting_on: Option<String>,
    pub created_at: i64,
    /// Every issue of the run, and whether its lease is still out.
    pub issues: Vec<(String, bool)>,
}

impl Run {
    pub fn held_keys(&self) -> Vec<&str> {
        self.issues
            .iter()
            .filter(|(_, held)| *held)
            .map(|(k, _)| k.as_str())
            .collect()
    }

    /// `ledger::Run::is_parked_on_human`, over the columns read here.
    pub fn parked_on_a_person(&self) -> bool {
        self.incarnation == "exited"
            && self.work == "blocked"
            && self.blocker_kind.as_deref() == Some("human")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Master {
    pub project_id: String,
    pub pane_name: String,
    pub session_id: Option<String>,
    pub boot_id: String,
    pub cold_started_at: i64,
    pub last_seen_at: i64,
    pub outdated: Outdated,
}

/// What the daemon last judged about a master pane's build (ISS-1379).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outdated {
    /// The ledger has no `masters.outdated` column: a daemon older than the
    /// judgement wrote it, so whether the pane is outdated cannot be said.
    Unsayable,
    /// Not judged outdated, or not judged yet.
    No,
    /// Outdated, in the daemon's words, naming what it was placed under and
    /// what stands now.
    Yes(String),
}

/// Columns read only where the ledger has them. A ledger an earlier daemon
/// wrote lacks them and is still read whole, with what they would say
/// reported as unsayable rather than refused.
pub const OPTIONAL: &[(&str, &str)] = &[("masters", "outdated")];

#[derive(Debug, Clone, Default)]
pub struct View {
    pub path: PathBuf,
    pub runs: Vec<Run>,
    pub masters: HashMap<String, Master>,
}

/// Every column this file reads, by table. The check and the queries answer to
/// this one list.
pub const READS: &[(&str, &[&str])] = &[
    (
        "runs",
        &[
            "run_id",
            "project_id",
            "master_session_id",
            "boot_id",
            "worktree_path",
            "worktree_gone_at",
            "released_as",
            "ended_by",
            "kept_notice",
            "incarnation",
            "work",
            "blocker_kind",
            "waiting_on",
            "created_at",
        ],
    ),
    ("run_issues", &["run_id", "issue_key", "lease_returned_at"]),
    (
        "masters",
        &[
            "project_id",
            "pane_name",
            "session_id",
            "boot_id",
            "cold_started_at",
            "last_seen_at",
        ],
    ),
];

const RUNS: &str = "SELECT r.run_id, r.project_id, r.master_session_id, r.boot_id, r.worktree_path,
        r.worktree_gone_at, r.released_as, r.ended_by, r.kept_notice, r.incarnation, r.work,
        r.blocker_kind, r.waiting_on, r.created_at
   FROM runs r
  WHERE EXISTS (SELECT 1 FROM run_issues m WHERE m.run_id = r.run_id AND m.lease_returned_at IS NULL)
     OR (r.ended_by IS NULL AND r.incarnation = 'exited' AND r.work = 'blocked'
         AND r.blocker_kind = 'human')
  ORDER BY r.created_at";

/// Open `path` read-only and read what the view shows.
pub fn read(path: &Path) -> Read<View> {
    let source = path.display().to_string();
    let fail = |e: &dyn std::fmt::Display| Unreadable::new(&source, e);
    if !path.exists() {
        return Err(fail(
            &"no ledger file here — a daemon creates it at its first start, so no run or master can be read",
        ));
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| fail(&e))?;
    conn.busy_timeout(Duration::from_secs(2))
        .map_err(|e| fail(&e))?;
    check_columns(&conn).map_err(|e| fail(&e))?;
    let runs = read_runs(&conn).map_err(|e| fail(&e))?;
    let masters = read_masters(&conn).map_err(|e| fail(&e))?;
    Ok(View {
        path: path.to_path_buf(),
        runs,
        masters,
    })
}

fn check_columns(conn: &Connection) -> Result<(), String> {
    for (table, wanted) in READS {
        let mut stmt = conn
            .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .map_err(|e| e.to_string())?;
        let have: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .and_then(Iterator::collect)
            .map_err(|e| e.to_string())?;
        if have.is_empty() {
            return Err(format!("the ledger has no `{table}` table"));
        }
        if let Some(missing) = wanted.iter().find(|c| !have.iter().any(|h| h == *c)) {
            return Err(format!(
                "`{table}` has no `{missing}` column, so this ledger is of a shape this view cannot read"
            ));
        }
    }
    Ok(())
}

fn read_runs(conn: &Connection) -> rusqlite::Result<Vec<Run>> {
    let mut stmt = conn.prepare(RUNS)?;
    let mut runs: Vec<Run> = stmt
        .query_map([], |r| {
            Ok(Run {
                run_id: r.get(0)?,
                project_id: r.get(1)?,
                master_session_id: r.get(2)?,
                boot_id: r.get(3)?,
                worktree_path: PathBuf::from(r.get::<_, String>(4)?),
                worktree_gone_at: r.get(5)?,
                released_as: r.get(6)?,
                ended_by: r.get(7)?,
                kept_notice: r.get(8)?,
                incarnation: r.get(9)?,
                work: r.get(10)?,
                blocker_kind: r.get(11)?,
                waiting_on: r.get(12)?,
                created_at: r.get(13)?,
                issues: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut issues = conn.prepare(
        "SELECT issue_key, lease_returned_at IS NULL FROM run_issues WHERE run_id = ?1 ORDER BY issue_key",
    )?;
    for run in &mut runs {
        run.issues = issues
            .query_map([&run.run_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
    }
    Ok(runs)
}

fn read_masters(conn: &Connection) -> rusqlite::Result<HashMap<String, Master>> {
    let judged = has_column(conn, "masters", "outdated")?;
    let mut stmt = conn.prepare(if judged {
        "SELECT project_id, pane_name, session_id, boot_id, cold_started_at, last_seen_at, outdated FROM masters"
    } else {
        "SELECT project_id, pane_name, session_id, boot_id, cold_started_at, last_seen_at, NULL FROM masters"
    })?;
    let rows = stmt.query_map([], |r| {
        Ok(Master {
            project_id: r.get(0)?,
            pane_name: r.get(1)?,
            session_id: r.get(2)?,
            boot_id: r.get(3)?,
            cold_started_at: r.get(4)?,
            last_seen_at: r.get(5)?,
            outdated: match (judged, r.get::<_, Option<String>>(6)?) {
                (false, _) => Outdated::Unsayable,
                (true, None) => Outdated::No,
                (true, Some(why)) => Outdated::Yes(why),
            },
        })
    })?;
    rows.map(|m| m.map(|m| (m.project_id.clone(), m))).collect()
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    debug_assert!(OPTIONAL.contains(&(table, column)));
    conn.prepare(&format!(
        "SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"
    ))?
    .exists([column])
}

/// Why a run holding a lease answers to nobody on this box: its declaring
/// master session is not its project's master now, or it was declared under
/// another boot. `None` for a run that still has its master.
pub fn abandoned_because(run: &Run, view: &View, this_boot: Option<&str>) -> Option<String> {
    if run.held_keys().is_empty() {
        return None;
    }
    if let Some(boot) = this_boot {
        if run.boot_id != boot {
            return Some(format!(
                "declared under boot {}, not this one",
                short(&run.boot_id)
            ));
        }
    }
    let master = run.project_id.as_deref().and_then(|p| view.masters.get(p));
    match master.and_then(|m| m.session_id.as_deref()) {
        Some(current) if current == run.master_session_id => None,
        Some(current) => Some(format!(
            "declared by master session {}, and this project's master is now {}",
            short(&run.master_session_id),
            short(current)
        )),
        None => Some(format!(
            "declared by master session {}, and the ledger records no master session for its project",
            short(&run.master_session_id)
        )),
    }
}

pub fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_runner_core::runner::ledger::{Ledger, NewRun};
    use forge_runner_core::test_scratch::Scratch;

    fn planted(dir: &Path) -> PathBuf {
        let path = dir.join("ledger.sqlite");
        let mut led = Ledger::open(&path).unwrap();
        for (run, master, keys) in [
            ("run-held", "sess-now", vec!["ISS-1", "ISS-2"]),
            ("run-old", "sess-before", vec!["ISS-3"]),
            ("run-back", "sess-now", vec!["ISS-4"]),
        ] {
            led.create_run_group(NewRun {
                run_id: run.into(),
                project_id: "p-1".into(),
                master_session_id: master.into(),
                worktree_path: dir.join(run),
                boot_id: "boot-1".into(),
                issue_keys: keys.into_iter().map(str::to_string).collect(),
            })
            .unwrap();
            // A master declares its next run only once a subagent took the last.
            led.bind_agent(run, &format!("agent-{run}")).unwrap();
        }
        led.mark_lease_returned_observed("run-held", "ISS-2")
            .unwrap();
        led.mark_lease_returned_observed("run-back", "ISS-4")
            .unwrap();
        led.note_master("p-1", "forge-master-p", None, Some("sess-now"), "boot-1")
            .unwrap();
        path
    }

    /// Criteria 5, 20. Every query this view makes, against the schema the
    /// ledger itself builds: a renamed column there is red here.
    #[test]
    fn the_view_reads_the_ledger_the_ledger_writes() {
        let s = Scratch::new("top-ledger");
        let path = planted(s.path());
        let v = read(&path).expect("a ledger Ledger::open built reads");
        let ids: Vec<&str> = v.runs.iter().map(|r| r.run_id.as_str()).collect();
        assert_eq!(
            ids,
            ["run-held", "run-old"],
            "a run whose every lease is back holds nothing"
        );
        assert_eq!(v.runs[0].held_keys(), ["ISS-1"]);
        assert_eq!(v.masters["p-1"].session_id.as_deref(), Some("sess-now"));
        assert_eq!(abandoned_because(&v.runs[0], &v, Some("boot-1")), None);
        // A session id is shown as its `short` prefix only, and these
        // assertions print nothing of it: the whole string is compared, never
        // echoed into a failure message.
        let why = abandoned_because(&v.runs[1], &v, Some("boot-1")).expect("abandoned");
        assert!(
            why == "declared by master session sess-bef, and this project's master is now sess-now",
            "the abandoned reason names both sessions by their short prefix"
        );
        assert!(
            !why.contains("sess-before"),
            "a full session id is never shown"
        );
        let why = abandoned_because(&v.runs[0], &v, Some("boot-2")).expect("foreign");
        assert!(
            why == "declared under boot boot-1, not this one",
            "a run from another boot is named by its boot"
        );
    }

    /// Criterion 24, from the side a write cannot hide on: a ledger nothing
    /// may write — file and directory both read-only — is still read. Any
    /// opener that migrates, as `Ledger::open` does, is refused here.
    #[cfg(unix)]
    #[test]
    fn a_ledger_nothing_may_write_is_still_read() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("top-ledger-locked");
        let dir = s.path().join("locked");
        std::fs::create_dir_all(&dir).unwrap();
        let path = planted(&dir);
        let mode = |p: &Path, m: u32| {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap()
        };
        let before = (
            std::fs::read(&path).unwrap(),
            std::fs::metadata(&path).unwrap().modified().unwrap(),
        );
        mode(&path, 0o444);
        mode(&dir, 0o555);
        let got = read(&path);
        mode(&dir, 0o755);
        mode(&path, 0o644);
        let v = got.expect("a read-only view reads a ledger it may not write");
        assert_eq!(v.runs.len(), 2);
        let after = (
            std::fs::read(&path).unwrap(),
            std::fs::metadata(&path).unwrap().modified().unwrap(),
        );
        assert!(before == after, "the ledger's bytes or stamp moved");
        let beside: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(beside, ["ledger.sqlite"], "no journal was left beside it");
    }

    /// Criterion 29.
    #[test]
    fn a_ledger_missing_a_column_is_refused_naming_it() {
        let s = Scratch::new("top-ledger-shape");
        let path = s.path().join("ledger.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE runs (run_id TEXT, project_id TEXT, master_session_id TEXT, boot_id TEXT,
               worktree_path TEXT, worktree_gone_at INTEGER, released_as TEXT, ended_by TEXT,
               work TEXT, blocker_kind TEXT, waiting_on TEXT, created_at INTEGER);",
        )
        .unwrap();
        drop(conn);
        let e = read(&path).unwrap_err().to_string();
        assert!(e.starts_with("UNREADABLE"), "{e}");
        assert!(e.contains("`kept_notice`"), "{e}");
    }

    /// Criterion 22.
    #[test]
    fn a_ledger_that_is_absent_or_not_sqlite_is_unreadable_never_empty() {
        let s = Scratch::new("top-ledger-bad");
        let absent = read(&s.path().join("none.sqlite")).unwrap_err();
        assert!(absent.reason.contains("no ledger file"), "{absent}");
        let junk = s.path().join("junk.sqlite");
        std::fs::write(
            &junk,
            b"this is not a database, and it is long enough to be read",
        )
        .unwrap();
        let e = read(&junk).unwrap_err().to_string();
        assert!(e.starts_with("UNREADABLE"), "{e}");
    }

    #[test]
    fn a_run_parked_on_a_person_is_read_even_with_its_leases_back() {
        let s = Scratch::new("top-ledger-park");
        let path = planted(s.path());
        let led = Ledger::open(&path).unwrap();
        led.declare_parked_human("run-back", None, None).unwrap();
        drop(led);
        let v = read(&path).unwrap();
        let parked = v
            .runs
            .iter()
            .find(|r| r.run_id == "run-back")
            .expect("read");
        assert!(parked.parked_on_a_person());
    }

    /// Consult 009e48 F1: parked is the ledger's own predicate — blocked on a
    /// human AND exited. A process still standing is not waiting on a person.
    #[test]
    fn a_blocked_run_whose_process_still_stands_is_not_parked() {
        let s = Scratch::new("top-ledger-park-live");
        let path = planted(s.path());
        let led = Ledger::open(&path).unwrap();
        led.declare_parked_human("run-back", None, None).unwrap();
        led.declare_parked_human("run-held", None, None).unwrap();
        drop(led);
        let raw = Connection::open(&path).unwrap();
        raw.execute(
            "UPDATE runs SET incarnation = 'live' WHERE run_id IN ('run-back', 'run-held')",
            [],
        )
        .unwrap();
        drop(raw);
        let v = read(&path).unwrap();
        assert!(
            v.runs.iter().all(|r| r.run_id != "run-back"),
            "a live run with its leases back is not read as parked"
        );
        let held = v
            .runs
            .iter()
            .find(|r| r.run_id == "run-held")
            .expect("held");
        assert!(!held.parked_on_a_person(), "{held:?}");
    }

    /// Criteria 37, 38: a ledger an earlier daemon wrote, with no `outdated`
    /// column, is read whole and says the verdict cannot be given.
    #[test]
    fn a_ledger_without_the_outdated_column_is_read_and_says_so() {
        let s = Scratch::new("top-ledger-unjudged");
        let path = planted(s.path());
        let raw = Connection::open(&path).unwrap();
        raw.execute_batch("ALTER TABLE masters DROP COLUMN outdated;")
            .unwrap();
        drop(raw);
        let v = read(&path).expect("criterion 37: read");
        assert_eq!(
            v.masters["p-1"].outdated,
            Outdated::Unsayable,
            "criterion 38"
        );
    }

    #[test]
    fn the_daemons_verdict_is_read_off_the_master_row() {
        let s = Scratch::new("top-ledger-outdated");
        let path = planted(s.path());
        assert_eq!(read(&path).unwrap().masters["p-1"].outdated, Outdated::No);
        let led = Ledger::open(&path).unwrap();
        led.note_master_outdated(
            "p-1",
            Some("placed under runner 0.9.1 (a), and this box runs 0.9.2 (b) now"),
        )
        .unwrap();
        drop(led);
        assert_eq!(
            read(&path).unwrap().masters["p-1"].outdated,
            Outdated::Yes("placed under runner 0.9.1 (a), and this box runs 0.9.2 (b) now".into())
        );
    }
}
