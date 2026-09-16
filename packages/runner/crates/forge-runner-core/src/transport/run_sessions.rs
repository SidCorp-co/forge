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
pub async fn close(
    client: &CoreClient,
    session_id: &str,
    outcome: Outcome,
    detail: Option<&str>,
    checkpoint: Option<serde_json::Value>,
) -> Result<()> {
    let url = client.url(&format!("/api/devices/me/run-sessions/{session_id}/close"));
    let mut body = serde_json::json!({ "outcome": outcome.wire() });
    if let Some(d) = detail {
        body["detail"] = serde_json::Value::String(d.to_string());
    }
    if let Some(cp) = checkpoint {
        body["checkpoint"] = cp;
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

/// Tell core what a resumed master decided about a run it inherited.
pub async fn report_resume_choice(
    client: &CoreClient,
    session_id: &str,
    choice: serde_json::Value,
) -> Result<()> {
    let url = client.url(&format!(
        "/api/devices/me/run-sessions/{session_id}/resume-choice"
    ));
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&choice)
        .send()
        .await
        .map_err(|e| Error::Other(format!("resume-choice report: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!(
            "resume-choice report: {status}: {text}"
        )));
    }
    Ok(())
}

/// Tell core this box is keeping a checkout because its work is on no remote.
pub async fn report_held_worktree(
    client: &CoreClient,
    session_id: &str,
    held: serde_json::Value,
) -> Result<()> {
    let url = client.url(&format!(
        "/api/devices/me/run-sessions/{session_id}/held-worktree"
    ));
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&held)
        .send()
        .await
        .map_err(|e| Error::Other(format!("held-worktree report: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!(
            "held-worktree report: {status}: {text}"
        )));
    }
    Ok(())
}

/// Is this box's run session terminal? Read from core's own row.
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
