//! A run session's own row in core: registration, its ending, and the READ that
//! decides whether the close loop's first mark may be set (ISS-933 wave 2).
//!
//! Three calls, and the third is the one that matters. `status` re-reads the
//! authoritative row rather than trusting the answer to `close`, because an ack
//! says the write was accepted and never that the row reached terminal — and
//! the mark this feeds is the one a lying or crashed master must not be able
//! to set.

use serde::Deserialize;

use super::CoreClient;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSession {
    pub session_id: String,
    pub name: String,
}

/// Core's refusal, carrying the run that already holds the issue.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSessionRefused {
    pub reason: String,
    pub issue_id: String,
    pub held_by_session_id: String,
}

#[derive(Debug, Clone)]
pub enum Registered {
    Ok(RunSession),
    Refused(RunSessionRefused),
}

/// Register a run session for a GROUP, before anything is spawned.
// cm:edge contract -> packages/core/src/devices/pool-routes.ts — `POST /me/run-session` takes `issueIds` as an ARRAY and answers 409 with `reason: 'issue_in_live_run'`. A scalar field here would re-encode the one-issue default this issue exists to reverse, and a 409 read as a transport error would have the caller retry a refusal that is correct.
pub async fn register(
    client: &CoreClient,
    project_id: &str,
    name: &str,
    issue_ids: &[String],
    worktree_path: &str,
) -> Result<Registered> {
    let url = client.url("/api/devices/me/run-session");
    let body = serde_json::json!({
        "projectId": project_id,
        "name": name,
        "issueIds": issue_ids,
        "worktreePath": worktree_path,
    });
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("run-session request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if resp.status().as_u16() == 409 {
        let refused: RunSessionRefused = resp
            .json()
            .await
            .map_err(|e| Error::Other(format!("run-session refusal decode: {e}")))?;
        return Ok(Registered::Refused(refused));
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("run-session {status}: {text}")));
    }
    resp.json()
        .await
        .map(Registered::Ok)
        .map_err(|e| Error::Other(format!("run-session decode: {e}")))
}

/// Ask core to end this run's row.
// cm:guard the reply to this is NOT evidence the row is terminal, and no caller may treat it as such. `status` below is what the close loop reads; this only asks.
pub async fn close(client: &CoreClient, session_id: &str, reason: &str) -> Result<()> {
    let url = client.url("/api/devices/me/run-session/close");
    let body = serde_json::json!({ "sessionId": session_id, "reason": reason });
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("run-session close: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("run-session close {status}: {text}")));
    }
    Ok(())
}

/// The row's status as core holds it right now.
// cm:guard an error here is NOT "not terminal" and must not be flattened into one. The caller sets no mark on an `Err`, and the run stays on the retry list; mapping a network failure onto a status would let a dropped response set a mark, which is the exact optimism criterion 13 forbids.
pub async fn status(client: &CoreClient, session_id: &str) -> Result<String> {
    let url = client.url(&format!("/api/agent-sessions/{session_id}"));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("run-session status: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("run-session status {status}: {text}")));
    }
    let row: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("run-session status decode: {e}")))?;
    row.get("status")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| Error::Other("run-session status: the row carried no status".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registration_reply_decodes() {
        let v =
            serde_json::json!({ "ok": true, "sessionId": "s1", "name": "forge-run-attachments" });
        let s: RunSession = serde_json::from_value(v).expect("core's reply must decode");
        assert_eq!(s.session_id, "s1");
    }

    // cm:guard the refusal must decode with the run that HOLDS the issue on it. A refusal that decoded to a bare reason would leave the operator with `issue_in_live_run` and nothing to look at, which is the ISS-593 failure respelled.
    #[test]
    fn a_refusal_decodes_and_names_the_run_that_holds_the_issue() {
        let v = serde_json::json!({
            "ok": false,
            "reason": "issue_in_live_run",
            "issueId": "i1",
            "heldBySessionId": "s-other"
        });
        let r: RunSessionRefused = serde_json::from_value(v).expect("the 409 body must decode");
        assert_eq!(r.held_by_session_id, "s-other");
    }
}
