//! The JOBS pool: read it, take a row, start it, or give it back.
//!
//! Core has carried this surface since ISS-919 split the one-shot claim into a
//! preparation and a stamp, and until ISS-1080 nothing on any box called it.
//! The four kinds that have no issue to rank — `smoke`, `release_batch`,
//! `reconcile`, `verify_skill` — were minted, woken for, and then waited on a
//! reader that did not exist.
//!
//! This is the reader. It is deliberately NOT `admissible`: an admissible issue
//! is a candidate for a wave and carries no `job_id` by its own guard, while a
//! pool row IS the work and carries nothing else.

use super::CoreClient;
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolEntry {
    pub job_id: String,
    #[serde(rename = "type")]
    pub job_type: String,
    #[serde(default)]
    pub issue_id: Option<String>,
    #[serde(default)]
    pub issue_key: Option<String>,
    #[serde(default)]
    pub age_minutes: f64,
    #[serde(default)]
    pub attempts: i64,
    #[serde(default)]
    pub held_by: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PoolResponse {
    #[serde(default)]
    items: Vec<PoolEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedJob {
    pub job_id: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub issue_id: Option<String>,
    #[serde(rename = "type", default)]
    pub job_type: String,
    #[serde(default)]
    pub agent_session_id: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub prompt_string: Option<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub repo_path: Option<String>,
    #[serde(default)]
    pub prior_claude_session_id: Option<String>,
    #[serde(default)]
    pub runner_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    NotFound,
    AlreadyHeld,
    IssueBusy,
    BudgetExhausted,
    HoldLost,
    RunnerTooOld,
    RunnerWithdrawn,
    DeviceDisabled,
    RunnerUnbound,
    ReleaseLabelMissing,
    Unknown(String),
}

impl Refusal {
    fn of(raw: &str) -> Self {
        match raw {
            "not_found" => Self::NotFound,
            "already_held" => Self::AlreadyHeld,
            "issue_busy" => Self::IssueBusy,
            "budget_exhausted" => Self::BudgetExhausted,
            "hold_lost" => Self::HoldLost,
            "runner_too_old" => Self::RunnerTooOld,
            "runner_withdrawn" => Self::RunnerWithdrawn,
            "device_disabled" => Self::DeviceDisabled,
            "runner_unbound" => Self::RunnerUnbound,
            "release_label_missing" => Self::ReleaseLabelMissing,
            other => Self::Unknown(other.to_string()),
        }
    }

    /// The word core used, which is what a log line and an operator want.
    pub fn as_str(&self) -> &str {
        match self {
            Self::NotFound => "not_found",
            Self::AlreadyHeld => "already_held",
            Self::IssueBusy => "issue_busy",
            Self::BudgetExhausted => "budget_exhausted",
            Self::HoldLost => "hold_lost",
            Self::RunnerTooOld => "runner_too_old",
            Self::RunnerWithdrawn => "runner_withdrawn",
            Self::DeviceDisabled => "device_disabled",
            Self::RunnerUnbound => "runner_unbound",
            Self::ReleaseLabelMissing => "release_label_missing",
            Self::Unknown(raw) => raw,
        }
    }
}

/// A preparation, or the named reason there is not one.
pub enum Prepared {
    Took(Box<PreparedJob>),
    Refused(Refusal),
}

pub enum Started {
    Ok,
    Refused(Refusal),
}

#[derive(Debug, Deserialize)]
struct ClaimResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    prepared: Option<PreparedJob>,
}

/// Why a read of the pool returned no list. A failed read is its own fact and
/// never an empty pool (ISS-1234): `status` is the one the endpoint returned,
/// or `None` where none came back at all, and `reason` names it by number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadFailure {
    pub status: Option<u16>,
    pub reason: String,
}

impl std::fmt::Display for ReadFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason)
    }
}

/// The deadline every call to core carries, named here for the callers that
/// reach for the pool's own. [`super::CALL_DEADLINE`] is where the value and
/// the reason for it live.
pub const CALL_DEADLINE: Duration = super::CALL_DEADLINE;

pub async fn list(
    client: &CoreClient,
    project_id: Option<&str>,
    limit: u32,
) -> std::result::Result<Vec<PoolEntry>, ReadFailure> {
    list_within(client, project_id, limit, CALL_DEADLINE).await
}

/// [`list`], with the deadline a test can shorten.
pub async fn list_within(
    client: &CoreClient,
    project_id: Option<&str>,
    limit: u32,
    deadline: Duration,
) -> std::result::Result<Vec<PoolEntry>, ReadFailure> {
    let mut url = client.url(&format!("/api/devices/me/pool?limit={limit}"));
    if let Some(p) = project_id {
        url.push_str(&format!("&projectId={p}"));
    }
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .timeout(deadline)
        .send()
        .await
        .map_err(|e| ReadFailure {
            status: None,
            reason: format!("pool request: {}", super::status::unanswered(&e, deadline)),
        })?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        let mut reason = super::status::refused("pool", status, &text);
        if status == 401 {
            reason.push_str(" — the device token was refused; `forge-runner login`");
        }
        return Err(ReadFailure {
            status: Some(status),
            reason,
        });
    }
    let parsed: PoolResponse = resp.json().await.map_err(|e| ReadFailure {
        status: None,
        reason: format!("pool response: {}", super::status::unanswered(&e, deadline)),
    })?;
    Ok(parsed.items)
}

pub async fn prepare(client: &CoreClient, job_id: &str, session_id: &str) -> Result<Prepared> {
    prepare_within(client, job_id, session_id, CALL_DEADLINE).await
}

/// [`prepare`], with the deadline a test can shorten.
pub async fn prepare_within(
    client: &CoreClient,
    job_id: &str,
    session_id: &str,
    deadline: Duration,
) -> Result<Prepared> {
    let body = serde_json::json!({ "jobId": job_id, "sessionId": session_id });
    let parsed = post(client, "/api/devices/me/pool/prepare", body, deadline).await?;
    if parsed.ok {
        return match parsed.prepared {
            Some(p) => Ok(Prepared::Took(Box::new(p))),
            None => Err(Error::Other(
                "pool prepare answered ok with no preparation — the job is held and nothing can run it".into(),
            )),
        };
    }
    Ok(Prepared::Refused(Refusal::of(
        parsed.reason.as_deref().unwrap_or("unknown"),
    )))
}

pub async fn start(client: &CoreClient, job_id: &str, session_id: &str) -> Result<Started> {
    let body = serde_json::json!({ "jobId": job_id, "sessionId": session_id });
    let parsed = post(client, "/api/devices/me/pool/start", body, CALL_DEADLINE).await?;
    if parsed.ok {
        return Ok(Started::Ok);
    }
    Ok(Started::Refused(Refusal::of(
        parsed.reason.as_deref().unwrap_or("unknown"),
    )))
}

/// Give one job back, or every job this session is holding.
pub async fn release(client: &CoreClient, job_id: Option<&str>, session_id: &str) -> Result<()> {
    let mut body = serde_json::json!({ "sessionId": session_id });
    if let Some(id) = job_id {
        body["jobId"] = serde_json::Value::String(id.to_string());
    }
    post(client, "/api/devices/me/pool/release", body, CALL_DEADLINE).await?;
    Ok(())
}

async fn post(
    client: &CoreClient,
    path: &str,
    body: serde_json::Value,
    deadline: Duration,
) -> Result<ClaimResponse> {
    let url = client.url(path);
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&body)
        .timeout(deadline)
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "pool {path}: {}",
                super::status::unanswered(&e, deadline)
            ))
        })?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(super::status::refused(
            &format!("pool {path}"),
            status,
            &text,
        )));
    }
    resp.json().await.map_err(|e| {
        Error::Other(format!(
            "pool {path} response: {}",
            super::status::unanswered(&e, deadline)
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::fake_core;

    fn client(url: String) -> CoreClient {
        CoreClient::new(url, "device-token")
    }

    const GATEWAY_PAGE: &str =
        "<!DOCTYPE html>\n<html>\n  <head><title>525: SSL handshake failed</title></head>\n</html>";

    /// Criteria 2 and 4 against the wire: the status the endpoint returned is
    /// the one the failure carries, by number and name.
    #[tokio::test]
    async fn a_gateway_status_is_carried_by_number_and_named() {
        for (line, code, gist) in [
            (
                "520 Origin Error",
                520u16,
                "the origin returned an unknown error",
            ),
            ("522 Timeout", 522, "the connection to the origin timed out"),
            (
                "525 Handshake",
                525,
                "the TLS handshake with the origin failed",
            ),
        ] {
            let url = fake_core::serve_always(line, GATEWAY_PAGE).await;
            let failed = list(&client(url), Some("p1"), 20)
                .await
                .expect_err("a gateway answer is a failed read, not a pool");
            assert_eq!(failed.status, Some(code));
            assert!(failed.reason.contains(gist), "{}", failed.reason);
            assert!(
                failed
                    .reason
                    .starts_with(&format!("pool {code} (gateway: ")),
                "{}",
                failed.reason
            );
            assert!(
                !failed.reason.contains("unknown status code"),
                "{}",
                failed.reason
            );
            assert!(!failed.reason.contains('\n'), "one line: {}", failed.reason);
        }
    }

    /// Criterion 3.
    #[tokio::test]
    async fn a_registered_status_carries_its_registered_phrase() {
        let url = fake_core::serve_always("503 Whatever", "").await;
        let failed = list(&client(url), Some("p1"), 20).await.unwrap_err();
        assert_eq!(failed.status, Some(503));
        assert_eq!(failed.reason, "pool 503 Service Unavailable");
    }

    /// Criterion 4: nothing answered, so there is no status to carry, and the
    /// reason is the transport's own cause rather than the url it was sent to.
    #[tokio::test]
    async fn a_read_nobody_answered_has_no_status_and_says_why() {
        // Port 1, which no test here can take: every listener in this suite binds
        // `:0`, and the kernel never hands out a port outside its ephemeral range,
        // root or not. A freed `:0` port was raced under the parallel suite.
        let failed = list(&client("http://127.0.0.1:1".to_string()), Some("p1"), 20)
            .await
            .unwrap_err();
        assert_eq!(failed.status, None);
        assert!(
            failed
                .reason
                .starts_with("pool request: could not connect: "),
            "{}",
            failed.reason
        );
        assert!(
            failed.reason.to_lowercase().contains("refused"),
            "the cause is named: {}",
            failed.reason
        );
        assert!(
            !failed.reason.contains("http://") && !failed.reason.contains("projectId="),
            "no url in a reason an operator reads on the runner card: {}",
            failed.reason
        );
    }

    /// Criterion 4, the timeout it names: a peer that accepts the connection
    /// and never answers is a failed read once the deadline passes, and never a
    /// read still in flight. The outer bound is what goes red when the call
    /// carries no deadline — it waited out the whole 340s the judge measured.
    #[tokio::test]
    async fn a_read_the_peer_never_answers_fails_at_its_deadline() {
        let url = fake_core::serve_silent().await;
        let failed = tokio::time::timeout(
            Duration::from_secs(10),
            list_within(&client(url), Some("p1"), 20, Duration::from_millis(300)),
        )
        .await
        .expect("a silent peer held the pool read past its deadline")
        .expect_err("no answer is a failed read, not a pool");
        assert_eq!(failed.status, None);
        assert_eq!(failed.reason, "pool request: timed out after 300ms");
    }

    /// The boundary past the status line: headers arrived and the body stalled.
    #[tokio::test]
    async fn a_read_whose_body_stalls_fails_at_its_deadline() {
        let url = fake_core::serve_stalled_body("200 OK").await;
        let failed = tokio::time::timeout(
            Duration::from_secs(10),
            list_within(&client(url), Some("p1"), 20, Duration::from_millis(300)),
        )
        .await
        .expect("a stalled body held the pool read past its deadline")
        .expect_err("half a body is a failed read, not a pool");
        assert_eq!(failed.status, None);
        assert_eq!(failed.reason, "pool response: timed out after 300ms");
    }

    /// The claim that follows a read is bounded the same way, or a hung
    /// preparation holds the sweep exactly as a hung read did.
    #[tokio::test]
    async fn a_preparation_the_peer_never_answers_fails_at_its_deadline() {
        let url = fake_core::serve_silent().await;
        let Err(e) = tokio::time::timeout(
            Duration::from_secs(10),
            prepare_within(&client(url), "j1", "s1", Duration::from_millis(300)),
        )
        .await
        .expect("a silent peer held the preparation past its deadline") else {
            panic!("no answer is not a preparation");
        };
        assert_eq!(
            e.to_string(),
            "pool /api/devices/me/pool/prepare: timed out after 300ms"
        );
    }

    /// A refusal whose page stalls still returns inside the deadline, carrying
    /// the status it did get: the body is garnish once the status is known.
    #[tokio::test]
    async fn a_refusal_whose_body_stalls_still_names_its_status_in_time() {
        let url = fake_core::serve_stalled_body("503 Whatever").await;
        let failed = tokio::time::timeout(
            Duration::from_secs(10),
            list_within(&client(url), Some("p1"), 20, Duration::from_millis(300)),
        )
        .await
        .expect("a refusal's stalled body held the pool read past its deadline")
        .expect_err("a 503 is a failed read");
        assert_eq!(failed.status, Some(503));
        assert_eq!(failed.reason, "pool 503 Service Unavailable");
    }

    /// And the claim's answer, when its body stalls after the status line.
    #[tokio::test]
    async fn a_preparation_whose_body_stalls_fails_at_its_deadline() {
        let url = fake_core::serve_stalled_body("200 OK").await;
        let Err(e) = tokio::time::timeout(
            Duration::from_secs(10),
            prepare_within(&client(url), "j1", "s1", Duration::from_millis(300)),
        )
        .await
        .expect("a stalled body held the preparation past its deadline") else {
            panic!("half a body is not a preparation");
        };
        assert_eq!(
            e.to_string(),
            "pool /api/devices/me/pool/prepare response: timed out after 300ms"
        );
    }

    #[test]
    fn the_deadline_lands_before_the_next_heartbeat() {
        assert!(CALL_DEADLINE < Duration::from_secs(30));
    }

    #[tokio::test]
    async fn a_body_that_will_not_decode_has_no_status_and_says_why() {
        let url = fake_core::serve_always("200 OK", "not json").await;
        let failed = list(&client(url), Some("p1"), 20).await.unwrap_err();
        assert_eq!(failed.status, None);
        assert!(
            failed
                .reason
                .starts_with("pool response: the body did not decode: "),
            "{}",
            failed.reason
        );
        assert!(
            failed.reason.contains("line 1 column"),
            "the decoder's own words, which reqwest's Display dropped: {}",
            failed.reason
        );
    }

    #[tokio::test]
    async fn an_empty_pool_is_an_empty_list_and_not_a_failure() {
        let url = fake_core::serve_always("200 OK", r#"{"items":[]}"#).await;
        assert!(list(&client(url), Some("p1"), 20).await.unwrap().is_empty());
    }

    /// Criterion 24, the naming half: a refused preparation names its status too.
    #[tokio::test]
    async fn a_refused_preparation_names_its_status() {
        let url = fake_core::serve_always("520 Origin Error", GATEWAY_PAGE).await;
        let Err(e) = prepare(&client(url), "j1", "s1").await else {
            panic!("a gateway answer is not a preparation");
        };
        let said = e.to_string();
        assert!(
            said.starts_with("pool /api/devices/me/pool/prepare 520 (gateway: the origin returned an unknown error)"),
            "{said}"
        );
    }

    #[test]
    fn a_release_row_with_no_issue_still_decodes() {
        let raw = serde_json::json!({
            "jobId": "j1", "type": "release_batch", "issueId": null, "issueKey": null,
            "title": null, "status": null, "ageMinutes": 12.5, "attempts": 0, "heldBy": null
        });
        let entry: PoolEntry = serde_json::from_value(raw).unwrap();
        assert_eq!(entry.job_id, "j1");
        assert_eq!(entry.job_type, "release_batch");
        assert!(entry.issue_id.is_none());
    }

    #[test]
    fn a_row_with_fields_core_added_later_still_decodes() {
        let raw = serde_json::json!({
            "jobId": "j1", "type": "smoke", "somethingCoreAddedLater": 42
        });
        let entry: PoolEntry = serde_json::from_value(raw).unwrap();
        assert_eq!(entry.job_type, "smoke");
    }

    #[test]
    fn an_absent_items_reads_as_an_empty_pool() {
        let parsed: PoolResponse = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(parsed.items.is_empty());
    }

    #[test]
    fn every_refusal_core_can_answer_has_its_own_name() {
        for raw in [
            "not_found",
            "already_held",
            "issue_busy",
            "budget_exhausted",
            "hold_lost",
            "runner_too_old",
            "runner_withdrawn",
            "device_disabled",
            "runner_unbound",
            "release_label_missing",
        ] {
            let refusal = Refusal::of(raw);
            assert!(
                !matches!(refusal, Refusal::Unknown(_)),
                "`{raw}` fell through to Unknown"
            );
            assert_eq!(refusal.as_str(), raw);
        }
    }

    #[test]
    fn a_reason_from_a_newer_core_keeps_its_word() {
        let refusal = Refusal::of("some_future_reason");
        assert_eq!(refusal, Refusal::Unknown("some_future_reason".into()));
        assert_eq!(refusal.as_str(), "some_future_reason");
    }

    #[test]
    fn a_preparation_carries_the_prompt_and_the_session_core_minted() {
        let raw = serde_json::json!({
            "jobId": "j1", "projectId": "p1", "issueId": null, "type": "release_batch",
            "agentSessionId": "s1", "systemPrompt": "sys", "promptString": "## Batch Release",
            "model": "claude", "repoPath": "/srv/app", "priorClaudeSessionId": null,
            "runnerId": "r1", "runnerType": "claude-code", "attempts": 0
        });
        let prepared: PreparedJob = serde_json::from_value(raw).unwrap();
        assert_eq!(prepared.agent_session_id, "s1");
        assert_eq!(prepared.prompt_string.as_deref(), Some("## Batch Release"));
        assert_eq!(prepared.repo_path.as_deref(), Some("/srv/app"));
    }
}
