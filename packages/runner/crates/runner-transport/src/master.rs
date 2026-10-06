//! The master's own row in core: registration, liveness, and its ending.
//!
//! A master used to invent its own session id, so `jobs.held_by` pointed at
//! nothing and core had no record the process ever existed. These three calls
//! are what put it on the same rail chat and schedule already run on.

use std::time::Duration;

use serde::Deserialize;

use super::{status, CoreClient, CALL_DEADLINE};
use runner_platform::error::Result;

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
    let body = serde_json::json!({
        "projectId": project_id,
        "name": name,
        "maxJobPanes": max_job_panes,
    });
    let req = client.post("/api/devices/me/master-session").json(&body);
    status::fetch_within(req, "master-session", deadline).await
}

pub async fn close(client: &CoreClient, session_id: &str, reason: &str) -> Result<()> {
    let body = serde_json::json!({ "sessionId": session_id, "reason": reason });
    let req = client
        .post("/api/devices/me/master-session/close")
        .json(&body);
    status::send_within(req, "master-session", CALL_DEADLINE).await?;
    Ok(())
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
    trigger: &str,
) -> std::result::Result<String, PassError> {
    let body = serde_json::json!({
        "op": "open",
        "sessionId": session_id,
        "verb": verb,
        "issueKey": issue_key,
        "trigger": trigger,
    });
    pass_call(client, body).await
}

/// `reason` is how this box judged the pass ended, one of core's
/// `MASTER_PASS_CLOSE_REASONS` (`turn_ended`, `abandoned_quiet`, …), stored on
/// the pass so an abandoned one never reads like one whose turn ended.
pub async fn close_pass(
    client: &CoreClient,
    session_id: &str,
    pass_id: &str,
    dispatched: &[String],
    refused: Option<(&str, &str)>,
    reason: &str,
) -> std::result::Result<String, PassError> {
    pass_call(
        client,
        close_body(session_id, pass_id, dispatched, refused, reason),
    )
    .await
}

/// The close as sent: `dispatched` is the caller's list exactly, never blanked
/// for a refusal. A refused close that carries work is core's to refuse by name
/// (`MASTER_PASS_REFUSED_WITH_WORK`), not this body's to make look empty.
pub(crate) fn close_body(
    session_id: &str,
    pass_id: &str,
    dispatched: &[String],
    refused: Option<(&str, &str)>,
    close_reason: &str,
) -> serde_json::Value {
    serde_json::json!({
        "op": "close",
        "sessionId": session_id,
        "passId": pass_id,
        "dispatched": dispatched,
        "skipped": [],
        "parked": [],
        "refused": refused.map(|(reason, detail)| serde_json::json!({ "reason": reason, "detail": detail })),
        "closeReason": close_reason,
    })
}

async fn pass_call(
    client: &CoreClient,
    body: serde_json::Value,
) -> std::result::Result<String, PassError> {
    const WHAT: &str = "master-session/pass";
    let resp = client
        .post("/api/devices/me/master-session/pass")
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

/// Tell core the dialog this box read on a master's pane, or that none stands
/// (`None`). `dialog` is the text and where it was read: `pane` or `hooks`.
pub async fn report_dialog(
    client: &CoreClient,
    session_id: &str,
    dialog: Option<(&str, &str)>,
) -> Result<()> {
    let body = serde_json::json!({
        "sessionId": session_id,
        "dialog": dialog.map(|(text, source)| serde_json::json!({ "text": text, "source": source })),
    });
    let req = client
        .post("/api/devices/me/master-session/dialog")
        .json(&body);
    status::send_within(req, "master-session/dialog", CALL_DEADLINE).await?;
    Ok(())
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
    let req = client.post("/api/devices/me/limit").json(&body);
    status::send_within(req, "me/limit", CALL_DEADLINE).await?;
    Ok(())
}

pub async fn clear_limit(client: &CoreClient) -> Result<()> {
    status::send_within(
        client.delete("/api/devices/me/limit"),
        "me/limit",
        CALL_DEADLINE,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_close_carries_the_dispatched_list_it_was_given() {
        let dispatched = vec!["ISS-1".to_string(), "ISS-2".to_string()];
        let body = close_body(
            "s",
            "p",
            &dispatched,
            Some(("usage_limit", "limit")),
            "turn_ended",
        );
        assert_eq!(
            body["dispatched"],
            serde_json::json!(["ISS-1", "ISS-2"]),
            "a refused close blanked the ledger's dispatched list: {body}"
        );
        assert_eq!(body["refused"]["reason"], "usage_limit");
    }

    #[test]
    fn a_close_that_ran_sends_no_refusal() {
        let body = close_body("s", "p", &[], None, "turn_ended");
        assert_eq!(body["dispatched"], serde_json::json!([]));
        assert!(body["refused"].is_null());
    }

    #[test]
    fn a_close_names_how_the_box_judged_it_ended() {
        let body = close_body("s", "p", &[], None, "abandoned_quiet");
        assert_eq!(body["closeReason"], "abandoned_quiet");
    }
}
