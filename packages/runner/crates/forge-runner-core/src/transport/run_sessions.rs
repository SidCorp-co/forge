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

/// What core says about one issue's lease, as this box sees it.
///
/// Two booleans because they are two questions (ISS-1109). `held` is the
/// fleet-wide fact — any box, not only this one. `held_by_this_device` is what
/// a close loop asking "have I given this back" means, and reading the first
/// under the second's name is what let two boxes hold one issue.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseState {
    pub held: bool,
    pub held_by_this_device: bool,
}

/// Where one lease lives, named by the project it was taken for.
///
/// `issue_leases` is keyed `(project_id, issue_key)` and `iss_seq` restarts per
/// project, so a box serving two of them holds two rows under one key. Core
/// refuses a give-back it cannot narrow to one, and this is how the run says
/// which it means (ISS-1139).
pub(crate) fn lease_path(project_id: Option<&str>, issue_key: &str) -> String {
    match project_id {
        Some(p) => format!("/api/devices/me/issue-leases/{issue_key}?projectId={p}"),
        None => format!("/api/devices/me/issue-leases/{issue_key}"),
    }
}

pub async fn lease_state(
    client: &CoreClient,
    project_id: Option<&str>,
    issue_key: &str,
) -> Result<LeaseState> {
    let url = client.url(&lease_path(project_id, issue_key));
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
    let parsed: LeaseState = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("issue-lease decode: {e}")))?;
    Ok(parsed)
}

pub async fn release_lease(
    client: &CoreClient,
    project_id: Option<&str>,
    issue_key: &str,
) -> Result<()> {
    let url = client.url(&lease_path(project_id, issue_key));
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
    // A 404 is core saying this box holds no such lease, which is the state the
    // release was asking for; `is_returned` reads it back either way. Anything
    // else — a 409 core could not narrow to one project among them — is an
    // error, because retrying it unchanged never resolves (ISS-1139).
    if !resp.status().is_success() && resp.status().as_u16() != 404 {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!(
            "issue-lease release: {status}: {text}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECOVERY_PORTS: &str = include_str!("../daemon/recovery_ports.rs");

    #[test]
    fn a_lease_carries_the_fleet_answer_and_this_box_answer_separately() {
        let state: LeaseState = serde_json::from_str(
            r#"{"held":true,"heldByThisDevice":false,"holder":{"deviceId":"d1"}}"#,
        )
        .expect("core sends camelCase and an extra holder object the runner does not read");

        assert!(
            state.held,
            "another box holding the issue is the fleet answer"
        );
        assert!(
            !state.held_by_this_device,
            "a box that reads the fleet answer as its own never marks its lease returned, and the run never closes"
        );
    }

    #[test]
    fn a_lease_call_names_the_project_the_lease_was_taken_for() {
        assert_eq!(
            lease_path(Some("proj-1"), "ISS-880"),
            "/api/devices/me/issue-leases/ISS-880?projectId=proj-1",
            "a box serving two projects holds two rows under one key, and core refuses a give-back that names neither"
        );
        assert_eq!(
            lease_path(None, "ISS-880"),
            "/api/devices/me/issue-leases/ISS-880",
            "a run whose ledger row carries no project still asks, and core narrows by the device alone"
        );
    }

    #[test]
    fn a_free_lease_reads_free_on_both_questions() {
        let state: LeaseState =
            serde_json::from_str(r#"{"held":false,"heldByThisDevice":false,"holder":null}"#)
                .expect("a free lease decodes with a null holder");

        assert!(!state.held);
        assert!(!state.held_by_this_device);
    }

    #[test]
    fn the_close_loop_asks_whether_this_box_gave_it_back() {
        assert!(
            RECOVERY_PORTS.contains("held_by_this_device"),
            "is_returned reading `held` would wedge this box's close loop on an issue another box legitimately holds (ISS-1109)"
        );
    }
}
