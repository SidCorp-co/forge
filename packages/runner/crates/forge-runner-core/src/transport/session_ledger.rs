//! The box's registry, said out loud (ISS-934).
//!
//! `runner/ledger.rs` is the only record of which pane belongs to which run,
//! which master started it, what pid it is and which worktree it holds — and
//! until this module it was readable only by shelling onto the box. This turns
//! it into one frame on the websocket the daemon already holds open.
//!
//! A SNAPSHOT, never a delta. The whole unclosed set goes every time and the
//! newest one replaces the last, so a dropped frame, a reconnect and a daemon
//! restart all self-correct on the next tick with no cursor anywhere. That is
//! also what keeps the ledger a registry: a delta stream would need to
//! remember what it had sent, which is the queue bookkeeping ISS-933 refused.

use serde::Serialize;

use crate::error::Result;
use crate::runner::ledger::Ledger;

/// The message type core routes on.
// cm:edge contract -> packages/core/src/ws/server.ts — that switch dispatches this exact string, and only for a device principal. It is an INBOUND type on a socket whose other traffic is core→box; renaming it here without renaming it there silently stops every box reporting, and nothing goes red.
pub const FRAME_TYPE: &str = "runner:sessions";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueEntry {
    pub issue_key: String,
    pub lease_returned: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunEntry {
    pub run_id: String,
    pub project_id: String,
    pub session_id: Option<String>,
    pub master_session_id: Option<String>,
    pub pid: Option<u32>,
    pub worktree_path: String,
    pub boot_id: String,
    pub incarnation: String,
    pub work: String,
    pub blocker_kind: Option<String>,
    pub waiting_on: Option<String>,
    pub issues: Vec<IssueEntry>,
}

/// Every unclosed run on this box, as core will read it.
// cm:guard `unclosed_runs` and not every row: a run whose loop closed is history, and republishing it would have the reader's list grow without bound while saying nothing new. The set shrinking to empty is itself the report that this box holds nothing.
// cm:guard a run with no project is SKIPPED and named in the log, never published under a guessed one. The read surface authorises per project, so an entry with the wrong project id would show one tenant's worktree and pid to another — and a ledger row written before ISS-934 genuinely has no project to give.
pub fn snapshot(ledger: &Ledger) -> Result<Vec<RunEntry>> {
    let mut out = Vec::new();
    for run in ledger.unclosed_runs()? {
        let Some(project_id) = run.project_id.clone() else {
            tracing::warn!(
                "[ledger] run {} predates the project column and cannot be published — it stays local until it closes",
                run.run_id
            );
            continue;
        };
        let issues = ledger
            .issues(&run.run_id)?
            .into_iter()
            .map(|m| IssueEntry {
                issue_key: m.issue_key,
                lease_returned: m.lease_returned_at.is_some(),
            })
            .collect();
        out.push(RunEntry {
            run_id: run.run_id,
            project_id,
            session_id: run.session_id,
            master_session_id: non_empty(run.master_session_id),
            pid: run.pid,
            worktree_path: run.worktree_path.to_string_lossy().to_string(),
            boot_id: run.boot_id,
            incarnation: run.incarnation.wire().to_string(),
            work: run.work.wire().to_string(),
            blocker_kind: run.blocker_kind.map(|b| b.wire().to_string()),
            waiting_on: run.waiting_on,
            issues,
        });
    }
    Ok(out)
}

// cm:guard an empty master session id travels as `null`, not as `""`. Core's schema takes a uuid or
// nothing, and a run opened by a runner one release behind has the empty string on its ledger row —
// sending it would fail the whole snapshot's validation and take every other run down with it.
fn non_empty(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// The frame text, ready for the socket.
pub fn frame(boot_id: &str, runs: &[RunEntry]) -> String {
    serde_json::json!({
        "type": FRAME_TYPE,
        "data": { "bootId": boot_id, "runs": runs },
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ledger::NewRun;
    use std::path::PathBuf;

    fn seeded() -> Ledger {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: PathBuf::from("/w/one"),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-934".into(), "ISS-933".into()],
        })
        .unwrap();
        led
    }

    #[test]
    fn one_run_reports_every_field_a_reader_off_the_box_has_no_other_way_to_get() {
        let led = seeded();
        led.attach_session("run-1", "sess-1").unwrap();
        led.attach_pid("run-1", 4242).unwrap();
        led.mark_lease_returned_observed("run-1", "ISS-933")
            .unwrap();

        let runs = snapshot(&led).unwrap();
        assert_eq!(runs.len(), 1);
        let r = &runs[0];
        assert_eq!(r.project_id, "proj-1");
        assert_eq!(r.session_id.as_deref(), Some("sess-1"));
        assert_eq!(
            r.master_session_id.as_deref(),
            Some("master-1"),
            "the PARENT session is the field the issue names first — without it a reader sees panes with no idea which master owns them (ISS-934 criterion 5)"
        );
        assert_eq!(r.pid, Some(4242));
        assert_eq!(r.worktree_path, "/w/one");
        assert_eq!(r.boot_id, "boot-a");
        assert_eq!(r.incarnation, "live");
        assert_eq!(r.work, "runnable");
        assert_eq!(
            r.issues,
            vec![
                IssueEntry {
                    issue_key: "ISS-933".into(),
                    lease_returned: true
                },
                IssueEntry {
                    issue_key: "ISS-934".into(),
                    lease_returned: false
                },
            ],
            "lease return is PER ISSUE on the wire too — a group that returned one of two must not read as a clean close"
        );
    }

    #[test]
    fn a_run_with_no_master_reports_null_rather_than_an_empty_string() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-old".into(),
            project_id: "proj-1".into(),
            master_session_id: String::new(),
            worktree_path: PathBuf::from("/w/old"),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
        let runs = snapshot(&led).unwrap();
        assert_eq!(runs[0].master_session_id, None);
        assert!(
            !frame("boot-a", &runs).contains("\"masterSessionId\":\"\""),
            "an empty string reaches core as an invalid uuid and takes the WHOLE snapshot down with it, so every other run on the box stops being reported too"
        );
    }

    #[test]
    fn a_run_the_ledger_cannot_place_in_a_project_is_left_out() {
        let led = Ledger::open_in_memory().unwrap();
        led.exec_for_test(
            "INSERT INTO runs (run_id, project_id, master_session_id, worktree_path, boot_id, incarnation, work, created_at)
             VALUES ('orphan', NULL, 'master-1', '/w/orphan', 'boot-a', 'live', 'runnable', 1);",
        );
        assert!(
            snapshot(&led).unwrap().is_empty(),
            "publishing a run under a guessed project shows one tenant's worktree and pid to another — the read surface authorises per project (ISS-934)"
        );
    }

    #[test]
    fn the_frame_names_the_type_core_dispatches_on() {
        let led = seeded();
        let text = frame("boot-a", &snapshot(&led).unwrap());
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["type"], FRAME_TYPE);
        assert_eq!(v["data"]["bootId"], "boot-a");
        assert_eq!(v["data"]["runs"].as_array().unwrap().len(), 1);
    }
}
