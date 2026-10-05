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

use runner_core::ledger::Ledger;
use runner_platform::error::Result;

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
            waiting_on: run
                .waiting_on
                .map(|w| within_utf16(w, WAITING_ON_MAX_UTF16)),
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

/// The longest `waitingOn` core stores, in UTF-16 units as core measures a string
/// (`devices/run-ledger-ws.ts:runSchema`). Longer text is cut here, where it is
/// written, so one long sentence cannot get its run refused.
pub const WAITING_ON_MAX_UTF16: usize = 1024;

/// `text` cut to at most `max` UTF-16 units, on a character boundary.
fn within_utf16(text: String, max: usize) -> String {
    if text.encode_utf16().count() <= max {
        return text;
    }
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= max
        })
        .collect()
}

/// The frame text, ready for the socket. Each run carries its own boot id.
pub fn frame(runs: &[RunEntry]) -> String {
    serde_json::json!({
        "type": FRAME_TYPE,
        "data": { "runs": runs },
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waiting_on_within_the_cap_is_kept_whole() {
        let text = "a".repeat(WAITING_ON_MAX_UTF16);
        assert_eq!(within_utf16(text.clone(), WAITING_ON_MAX_UTF16), text);
    }

    #[test]
    fn waiting_on_past_the_cap_is_cut_on_a_character_boundary() {
        // Each of these is two UTF-16 units, so an odd cap cannot split one.
        let text = "😀".repeat(600);
        let cut = within_utf16(text, 1023);
        assert_eq!(cut.encode_utf16().count(), 1022);
        assert!(cut.chars().all(|c| c == '😀'));
    }

    #[test]
    fn the_frame_carries_no_top_level_boot_id() {
        let frame: serde_json::Value = serde_json::from_str(&frame(&[])).unwrap();
        assert_eq!(frame["type"], FRAME_TYPE);
        assert!(frame["data"].get("bootId").is_none());
        assert_eq!(frame["data"]["runs"], serde_json::json!([]));
    }
}
