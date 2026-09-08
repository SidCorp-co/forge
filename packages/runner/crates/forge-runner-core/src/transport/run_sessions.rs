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
}

/// Open the core-side record for a run, carrying the WHOLE group of issues.
// cm:edge contract -> packages/core/src/devices/run-session.ts — `openRunSession` is the other half; membership lands on `pipeline_runs.metadata.runIssues` because `issue_id` is one column and a run carries many.
pub async fn open(
    client: &CoreClient,
    project_id: &str,
    run_id: &str,
    issue_keys: &[String],
    name: &str,
) -> Result<String> {
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
    Ok(parsed.session_id)
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
