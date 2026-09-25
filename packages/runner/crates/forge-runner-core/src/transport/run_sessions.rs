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
    gate: Option<&crate::daemon::degraded::Condition>,
) -> Result<(String, String)> {
    let url = client.url("/api/devices/me/run-sessions");
    let mut body = serde_json::json!({
        "projectId": project_id,
        "runId": run_id,
        "issueKeys": issue_keys,
        "name": name,
    });
    // What was true THEN. The device's own report says what is true now, and a
    // window that has rolled over cannot answer "was the gate deciding while
    // this ran" for a run that ended weeks ago (ISS-1192).
    if let Some(gate) = gate {
        body["gate"] = serde_json::to_value(gate).unwrap_or(serde_json::Value::Null);
    }
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
    /// The issue itself has reached a terminal status at core. `None` is *not
    /// known to be over* — an older core that does not send the field, or a key
    /// that reaches no issue — and a box reads it as the run carrying on
    /// (ISS-1245).
    #[serde(default)]
    pub issue_over: Option<bool>,
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

/// Core's codes for a key under which no lease of any box can stand.
///
/// A lease call carries the key the pool handed the box, and core resolves it
/// against the project whose prefix it names. Two of its refusals settle the
/// key itself: a shape that is no issue reference, which the store keys nothing
/// by, and a prefix no project answers to — the state a deleted project leaves,
/// where `issue_prefix_aliases` keeps the row with a null project and the
/// cascade on `issue_leases.project_id` has already taken every lease that
/// project held. No lease could have opened under either shape in the first
/// place — `openRunSession` parses every key against the prefixes its project
/// holds and refuses the open otherwise — so `not held` is the fact. An error
/// in its place is a refusal the box cannot clear, and the loop marks returned only
/// on `Ok(true)`, so the run keeps its master waiting for ever (ISS-1139).
///
/// `ISSUE_LEASE_KEY_PROJECT_MISMATCH` is not one of them: the two identities in
/// that request disagree and a lease may stand under either, so `not held`
/// there is a guess wearing the shape of a fact.
const NO_LEASE_STANDS_UNDER_KEY: [&str; 2] =
    ["ISSUE_LEASE_KEY_SHAPE", "ISSUE_LEASE_KEY_UNKNOWN_PREFIX"];

/// The code core named, where it is one of those two.
///
/// Read by code and never by status: a bare `404` from a core that does not
/// serve this route says nothing about any lease, and reading that as `not
/// held` marks a lease returned while it is still standing.
fn no_lease_stands_under_key(body: &str) -> Option<&'static str> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let code = parsed.get("code")?.as_str()?;
    NO_LEASE_STANDS_UNDER_KEY
        .into_iter()
        .find(|known| *known == code)
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
        if let Some(code) = no_lease_stands_under_key(&text) {
            tracing::warn!(
                "[lease] read {issue_key}: core answers {code}; no lease stands under that key, so this box holds none"
            );
            return Ok(LeaseState {
                held: false,
                held_by_this_device: false,
                issue_over: None,
            });
        }
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
    use crate::transport::fake_core;

    const RECOVERY_PORTS: &str = include_str!("../daemon/recovery_ports.rs");

    fn client(url: String) -> CoreClient {
        CoreClient::new(url, String::from("tok"))
    }

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

    /// ISS-1245 — an answer with no such field is *not known to be over*.
    ///
    /// Core and the runner ship on different clocks, and a box running ahead of
    /// its core must read the silence as the run carrying on rather than as the
    /// issue being live or over. `false` here would be a claim nothing made.
    #[test]
    fn an_answer_that_names_no_issue_status_leaves_it_unknown() {
        let state: LeaseState =
            serde_json::from_str(r#"{"held":true,"heldByThisDevice":true,"holder":null}"#)
                .expect("a core that does not send the field still answers the lease question");

        assert_eq!(
            state.issue_over, None,
            "an older core says nothing about the issue, and a box that reads that as an answer              closes a run on evidence nobody gave it"
        );
    }

    #[test]
    fn an_over_issue_is_carried_back_on_the_lease_answer() {
        let state: LeaseState = serde_json::from_str(
            r#"{"held":false,"heldByThisDevice":false,"holder":null,"issueOver":true}"#,
        )
        .expect("the field rides on the call the close loop already makes");

        assert_eq!(
            state.issue_over,
            Some(true),
            "and it is answered off the ISSUE, so a lease core already freed still carries it"
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

    /// ISS-1139 — a key core resolves to no project must not wedge the close loop.
    ///
    /// A project is hard-deleted, its prefix stays spent, and core answers the
    /// read `404 ISSUE_LEASE_KEY_UNKNOWN_PREFIX` for as long as that row
    /// stands — which is for ever. Turning it into an `Err` leaves
    /// `is_returned` unanswerable, `CloseState::is_closed` false and the master
    /// waiting on a run that can never close. No lease survives the cascade on
    /// `issue_leases.project_id`, so `held: false` is the fact and not a
    /// softened refusal.
    #[tokio::test]
    async fn a_key_that_reaches_no_project_reads_as_no_lease() {
        let url = fake_core::serve_always("404 Not Found", fake_core::UNKNOWN_PREFIX).await;

        let state = lease_state(&client(url), Some("proj-1"), "FD-880")
            .await
            .expect("a key core resolves to no project reaches no lease, which answers the read");

        assert!(
            !state.held_by_this_device,
            "the close loop marks a lease returned only on Ok(true), so an Err here is a run that never closes"
        );
        assert!(!state.held);
    }

    #[tokio::test]
    async fn a_key_core_cannot_parse_reads_as_no_lease() {
        let url = fake_core::serve_always("400 Bad Request", fake_core::KEY_SHAPE).await;

        let state = lease_state(&client(url), Some("proj-1"), "ISS-x")
            .await
            .expect("the store keys every lease by a canonical reference, so a key that is none reaches nothing");

        assert!(!state.held_by_this_device);
    }

    #[tokio::test]
    async fn a_404_that_is_not_about_the_key_is_still_an_error() {
        let url = fake_core::serve_always("404 Not Found", fake_core::ROUTE_ABSENT).await;

        lease_state(&client(url), Some("proj-1"), "ISS-880")
            .await
            .expect_err(
                "a route core does not serve says nothing about any lease, and reading it as `not held` marks one returned that is still standing",
            );
    }

    #[tokio::test]
    async fn a_key_naming_two_projects_at_once_is_still_an_error() {
        let url = fake_core::serve_always("400 Bad Request", fake_core::PROJECT_MISMATCH).await;

        lease_state(&client(url), Some("p-1"), "FD-880")
            .await
            .expect_err(
                "the two identities disagree and a lease may stand under either, so `held: false` would be a guess dressed as a fact",
            );
    }

    /// ISS-1139 — a release core could not narrow carries its way out.
    ///
    /// The close loop logs what this error says, so the sentence naming
    /// `?projectId=` is the whole of what an operator has to act on.
    #[tokio::test]
    async fn a_release_core_could_not_narrow_names_the_way_out_in_its_error() {
        let url = fake_core::serve_always("409 Conflict", fake_core::AMBIGUOUS).await;

        let err = release_lease(&client(url), None, "ISS-880")
            .await
            .expect_err("a box holding one key in two projects gave nothing back");

        assert!(
            format!("{err}").contains("projectId"),
            "an error that drops the way out leaves the operator a run that will not close and no act to take: {err}"
        );
    }

    #[test]
    fn the_close_loop_asks_whether_this_box_gave_it_back() {
        assert!(
            RECOVERY_PORTS.contains("held_by_this_device"),
            "is_returned reading `held` would wedge this box's close loop on an issue another box legitimately holds (ISS-1109)"
        );
    }
}
