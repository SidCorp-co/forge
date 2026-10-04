//! The master's own row in core: registration, liveness, and its ending.
//!
//! A master used to invent its own session id, so `jobs.held_by` pointed at
//! nothing and core had no record the process ever existed. These three calls
//! are what put it on the same rail chat and schedule already run on.

use std::time::Duration;

use serde::Deserialize;

use super::{status, CoreClient, CALL_DEADLINE};
use runner_platform::error::{Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterSession {
    pub session_id: String,
    pub name: String,
}

pub async fn register(
    client: &CoreClient,
    project_id: &str,
    name: &str,
    max_job_panes: u32,
) -> Result<MasterSession> {
    register_within(client, project_id, name, max_job_panes, CALL_DEADLINE).await
}

/// [`register`], with the deadline a test can shorten.
pub async fn register_within(
    client: &CoreClient,
    project_id: &str,
    name: &str,
    max_job_panes: u32,
    deadline: Duration,
) -> Result<MasterSession> {
    let url = client.url("/api/devices/me/master-session");
    let body = serde_json::json!({
        "projectId": project_id,
        "name": name,
        "maxJobPanes": max_job_panes,
    });
    let resp = post(client, "master-session", &url, body, deadline).await?;
    resp.json()
        .await
        .map_err(|e| Error::Other(format!("master-session decode: {e}")))
}

pub async fn close(client: &CoreClient, session_id: &str, reason: &str) -> Result<()> {
    let url = client.url("/api/devices/me/master-session/close");
    let body = serde_json::json!({ "sessionId": session_id, "reason": reason });
    post(client, "master-session", &url, body, CALL_DEADLINE)
        .await
        .map(|_| ())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PassError {
    Refused { code: String, detail: String },
    Unreached(String),
}

impl std::fmt::Display for PassError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused { code, detail } => write!(f, "{code}: {detail}"),
            Self::Unreached(said) => f.write_str(said),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct PassReply {
    pass: PassRow,
}

#[derive(Debug, Clone, Deserialize)]
struct PassRow {
    id: String,
}

pub async fn open_pass(
    client: &CoreClient,
    session_id: &str,
    verb: &str,
    issue_key: Option<&str>,
) -> std::result::Result<String, PassError> {
    let body = serde_json::json!({
        "op": "open",
        "sessionId": session_id,
        "verb": verb,
        "issueKey": issue_key,
    });
    pass_call(client, body).await
}

pub async fn close_pass(
    client: &CoreClient,
    session_id: &str,
    pass_id: &str,
    dispatched: &[String],
) -> std::result::Result<String, PassError> {
    let body = serde_json::json!({
        "op": "close",
        "sessionId": session_id,
        "passId": pass_id,
        "dispatched": dispatched,
        "skipped": [],
        "parked": [],
    });
    pass_call(client, body).await
}

async fn pass_call(
    client: &CoreClient,
    body: serde_json::Value,
) -> std::result::Result<String, PassError> {
    const WHAT: &str = "master-session/pass";
    let resp = client
        .http()
        .post(client.url("/api/devices/me/master-session/pass"))
        .bearer_auth(client.device_token())
        .json(&body)
        .timeout(CALL_DEADLINE)
        .send()
        .await
        .map_err(|e| {
            PassError::Unreached(format!(
                "{WHAT} request: {}",
                status::unanswered(&e, CALL_DEADLINE)
            ))
        })?;
    let code = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if (200..300).contains(&code) {
        return serde_json::from_str::<PassReply>(&text)
            .map(|r| r.pass.id)
            .map_err(|e| PassError::Unreached(format!("{WHAT} decode: {e}")));
    }
    Err(pass_refusal(code, &text)
        .unwrap_or_else(|| PassError::Unreached(status::refused(WHAT, code, &text))))
}

pub(crate) fn pass_refusal(status: u16, text: &str) -> Option<PassError> {
    if !(400..500).contains(&status) || matches!(status, 401 | 408 | 429) {
        return None;
    }
    let body: serde_json::Value = serde_json::from_str(text).ok()?;
    let error = body.get("error").unwrap_or(&body);
    let code = error.get("code")?.as_str()?.to_string();
    let detail = error
        .get("refusals")
        .and_then(|r| r.get(0))
        .and_then(|r| r.get("detail"))
        .or_else(|| error.get("message"))
        .and_then(|d| d.as_str())
        .unwrap_or_default()
        .to_string();
    Some(PassError::Refused { code, detail })
}

pub async fn report_limit(
    client: &CoreClient,
    reason: &str,
    resets_in_seconds: Option<u64>,
    detail: &str,
) -> Result<()> {
    let mut body = serde_json::json!({ "reason": reason, "detail": detail });
    if let Some(secs) = resets_in_seconds {
        body["resetsInSeconds"] = serde_json::json!(secs);
    }
    let url = client.url("/api/devices/me/limit");
    post(client, "me/limit", &url, body, CALL_DEADLINE)
        .await
        .map(|_| ())
}

pub async fn clear_limit(client: &CoreClient) -> Result<()> {
    let url = client.url("/api/devices/me/limit");
    let resp = client
        .http()
        .delete(&url)
        .bearer_auth(client.device_token())
        .timeout(CALL_DEADLINE)
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "me/limit request: {}",
                status::unanswered(&e, CALL_DEADLINE)
            ))
        })?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(status::refused("me/limit", code, &text)));
    }
    Ok(())
}

/// One call to core, said the way a refusal has to read.
///
/// What comes back here is the `{e}` in the master sweep's warning AND the
/// `detail` of `Unplaced::RegisterFailed`, which is the reason an operator gets
/// from `forge-runner master status` when a project has no pane. It used to be
/// `reqwest::StatusCode`'s `Display` plus the body verbatim, so a gateway's 520
/// read as `<unknown status code>` and its whole HTML page was printed twice
/// (ISS-1233). Both halves are [`status`]'s to say now.
async fn post(
    client: &CoreClient,
    what: &str,
    url: &str,
    body: serde_json::Value,
    deadline: Duration,
) -> Result<reqwest::Response> {
    let resp = client
        .http()
        .post(url)
        .bearer_auth(client.device_token())
        .json(&body)
        .timeout(deadline)
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "{what} request: {}",
                status::unanswered(&e, deadline)
            ))
        })?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(status::refused(what, code, &text)));
    }
    Ok(resp)
}
