//! The JOBS pool: read it, take a row, start it, or give it back.
//!
//! Core has carried this surface since ISS-919 split the one-shot claim into a
//! preparation and a stamp, and until ISS-1080 nothing on any box called it.
//! The kinds that have no issue to rank — `smoke` and `release_batch` — were
//! minted, woken for, and then waited on a
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
    /// The tools this job's policy state denies, as the pane's `--disallowed-tools`.
    #[serde(default)]
    pub denied_tools: Vec<String>,
    /// The checkout this device's binding to the project names (`runners.repo_path`).
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
    /// The project's policy cannot say how this job runs; core's sentence says why.
    PolicyRefused(String),
    HoldLost,
    RunnerTooOld,
    RunnerWithdrawn,
    DeviceDisabled,
    RunnerUnbound,
    /// This device's binding to the project names no checkout; core's sentence says how to bind one.
    CheckoutUnbound(String),
    ReleaseLabelMissing,
    Unknown(String),
}

impl Refusal {
    fn of(raw: &str, detail: Option<&str>) -> Self {
        match raw {
            "not_found" => Self::NotFound,
            "already_held" => Self::AlreadyHeld,
            "issue_busy" => Self::IssueBusy,
            "policy_refused" => Self::PolicyRefused(detail.unwrap_or_default().to_string()),
            "hold_lost" => Self::HoldLost,
            "runner_too_old" => Self::RunnerTooOld,
            "runner_withdrawn" => Self::RunnerWithdrawn,
            "device_disabled" => Self::DeviceDisabled,
            "runner_unbound" => Self::RunnerUnbound,
            "checkout_unbound" => Self::CheckoutUnbound(detail.unwrap_or_default().to_string()),
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
            Self::PolicyRefused(_) => "policy_refused",
            Self::HoldLost => "hold_lost",
            Self::RunnerTooOld => "runner_too_old",
            Self::RunnerWithdrawn => "runner_withdrawn",
            Self::DeviceDisabled => "device_disabled",
            Self::RunnerUnbound => "runner_unbound",
            Self::CheckoutUnbound(_) => "checkout_unbound",
            Self::ReleaseLabelMissing => "release_label_missing",
            Self::Unknown(raw) => raw,
        }
    }

    /// The word, and core's sentence where it sent one — what a log line needs to be acted on.
    pub fn describe(&self) -> String {
        match self {
            Self::PolicyRefused(detail) if !detail.is_empty() => {
                format!("policy_refused: {detail}")
            }
            Self::CheckoutUnbound(detail) if !detail.is_empty() => {
                format!("checkout_unbound: {detail}")
            }
            other => other.as_str().to_string(),
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
    detail: Option<String>,
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
        parsed.detail.as_deref(),
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
        parsed.detail.as_deref(),
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
