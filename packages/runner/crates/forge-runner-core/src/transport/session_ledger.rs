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
    pub session_terminal_at_epoch_s: Option<i64>,
    pub worktree_gone_at_epoch_s: Option<i64>,
    pub issues: Vec<IssueEntry>,
}

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
            session_terminal_at_epoch_s: run.session_terminal_at,
            worktree_gone_at_epoch_s: run.worktree_gone_at,
            issues,
        });
    }
    Ok(out)
}

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
