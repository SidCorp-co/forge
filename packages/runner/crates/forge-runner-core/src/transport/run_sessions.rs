/*
 * Telling core a run session exists, and that it is still held.
 */

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::transport::agent_sessions::{patch_session, SessionPatch};
use crate::transport::CoreClient;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenReply {
    session_id: String,
    run_id: String,
}

/// Open the core-side record for a run, carrying the WHOLE group of issues.
// cm:edge contract -> packages/core/src/devices/run-session.ts — `openRunSession` is the other half; membership lands on `pipeline_runs.metadata.runIssues` because `issue_id` is one column and a run carries many.
pub async fn open(
    client: &CoreClient,
    project_id: &str,
    run_id: &str,
    issue_keys: &[String],
    name: &str,
) -> Result<(String, String)> {
    let url = client.url("/api/devices/me/run-sessions");
    let body = serde_json::json!({
        "projectId": project_id,
        "runId": run_id,
        "issueKeys": issue_keys,
        "name": name,
    });
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("run-session open: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("run-session open: {status}: {text}")));
    }
    let parsed: OpenReply = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("run-session open decode: {e}")))?;
    Ok((parsed.session_id, parsed.run_id))
}

/// Say this box still holds the run — the ONLY thing that keeps it out of
/// core's ten-minute sweep.
// cm:edge contract -> packages/core/src/devices/run-session-reaper.ts — the beat asserts "this box still holds this run", never progress.
// cm:guard the beat is a `status` patch and nothing else — `agent-sessions/routes.ts` counts a status write as worker activity and bumps `last_heartbeat_at`, which is the whole point. Never `runtimeState: awaiting_input` here: that value is deliberately EXEMPT from the heartbeat and would park the run outside every clock instead of proving the box holds it.
pub async fn beat(client: &CoreClient, session_id: &str) -> Result<()> {
    patch_session(
        client,
        session_id,
        &SessionPatch {
            status: Some("running".into()),
            ..Default::default()
        },
    )
    .await
}

/// Why a run session ended, as core's `close` verb names the three cases.
// cm:edge contract -> packages/core/src/devices/pool-routes.ts — `closeBodySchema` is a zod enum of exactly these three wire strings; a fourth added here without a matching variant there is a 400 the daemon reads as "core refused the close" and retries forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ended,
    KilledIdle,
    Died,
}

impl Outcome {
    fn wire(self) -> &'static str {
        match self {
            Outcome::Ended => "ended",
            Outcome::KilledIdle => "killed_idle",
            Outcome::Died => "died",
        }
    }
}

/// Tell core this box finished with the run, and WHICH of the three ways.
// cm:guard the reason this verb exists: without it the only way a run session reaches terminal is core's ten-minute silence sweep, which writes `runner_unreachable` over a box that was never unreachable — 203 sessions across two projects in 7 days, ~95% of them in that bucket, of which the genuine transport failures can no longer be told apart.
// cm:edge contract -> packages/core/src/devices/pool-routes.ts — `POST /me/run-sessions/:sessionId/close` is the other half, and it is device-scoped: closing another box's session answers 404 rather than freeing its issues.
// cm:guard a 404 is SUCCESS, for `is_terminal`'s reason: core not having the session means its reaper already closed it, and raising would make the caller retry a close that can never land.
pub async fn close(
    client: &CoreClient,
    session_id: &str,
    outcome: Outcome,
    detail: Option<&str>,
) -> Result<()> {
    let url = client.url(&format!("/api/devices/me/run-sessions/{session_id}/close"));
    let mut body = serde_json::json!({ "outcome": outcome.wire() });
    if let Some(d) = detail {
        body["detail"] = serde_json::Value::String(d.to_string());
    }
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("run-session close: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if resp.status().as_u16() == 404 {
        return Ok(());
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("run-session close: {status}: {text}")));
    }
    Ok(())
}

/// Is this box's run session terminal? Read from core's own row.
// cm:edge contract -> packages/core/src/devices/pool-routes.ts — `GET /me/run-sessions/:sessionId` is the other half, and it is device-scoped: a box asking about another box's session gets a 404, not an answer.
// cm:guard a 404 answers TERMINAL rather than raising. Core no longer having the session means its own reaper got there first or an operator cancelled it; raising would park the ledger row forever on a run nothing else will ever close, where this lets the local marks land and the row retire.
pub async fn is_terminal(client: &CoreClient, session_id: &str) -> Result<bool> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Reply {
        session_terminal: bool,
    }
    let url = client.url(&format!("/api/devices/me/run-sessions/{session_id}"));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("run-session state: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if resp.status().as_u16() == 404 {
        return Ok(true);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("run-session state: {status}: {text}")));
    }
    let parsed: Reply = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("run-session state decode: {e}")))?;
    Ok(parsed.session_terminal)
}

/// Is one issue still held by a live run session on this box?
// cm:edge contract -> packages/core/src/devices/pool-routes.ts — `GET /me/issue-leases/:issueKey` asks the same question `devices/admissible.ts` excludes on, for one key.
pub async fn lease_held(client: &CoreClient, issue_key: &str) -> Result<bool> {
    #[derive(Deserialize)]
    struct Reply {
        held: bool,
    }
    let url = client.url(&format!("/api/devices/me/issue-leases/{issue_key}"));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("issue-lease read: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("issue-lease read: {status}: {text}")));
    }
    let parsed: Reply = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("issue-lease decode: {e}")))?;
    Ok(parsed.held)
}

/// Give ONE issue's lease back. The answer is discarded on purpose.
// cm:guard the caller must ask `lease_held` again to learn whether this landed, and this function's return says nothing about it. That is criterion 13's rule in the type: a stale success here sets no mark, and a dropped response over a return that landed still ends with one.
pub async fn release_lease(client: &CoreClient, issue_key: &str) -> Result<()> {
    let url = client.url(&format!("/api/devices/me/issue-leases/{issue_key}"));
    let resp = client
        .http()
        .delete(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("issue-lease release: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() && resp.status().as_u16() != 404 {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!(
            "issue-lease release: {status}: {text}"
        )));
    }
    Ok(())
}
