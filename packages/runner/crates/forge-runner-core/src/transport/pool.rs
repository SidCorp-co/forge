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

/// One claimable row, as `GET /me/pool` answers it.
// cm:guard every field but `job_id` and `type` is `#[serde(default)]`, and the four issue-less kinds are why: core LEFT JOINs the issue, so `title`, `status` and the rest come back null for exactly the rows this module exists to take. A required field here would make the pool undecodable for the only work in it.
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

/// The work core built for a job this box has taken but not yet started.
// cm:edge contract -> packages/core/src/jobs/prepare-claimed-job.ts — `PreparedJob` is this shape, and its own guard says identity travels WITH the preparation and never from the runner's own pool read: a pool entry is a snapshot this box may have held for minutes, and rebuilding the job's identity from it is the mismatch `prepareClaimedJob` refuses one guard down, arriving by a different door.
// cm:guard `agent_session_id` is core's, minted by the preparation, and the box must never invent one. It is the row the issue's "visible as an agent_sessions row" is about, and it exists the instant a prepare succeeds — before any process does.
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

/// What a refused preparation says, in core's own words.
// cm:guard every variant core can answer is named here, and `Unknown` carries the raw string rather than collapsing into it. A master that cannot tell `release_label_missing` from `budget_exhausted` retries the one condition retrying cannot change; an operator reading a log needs the word core chose, not this crate's guess at it.
// cm:edge lockstep -> packages/core/src/devices/claim.ts — `PrepareResult`'s refusal union. A member added there and not here decodes as `Unknown`, which is the deliberate soft landing; a member removed there leaves a variant no core answers, which is dead and should go.
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

/// A stamp, or the named reason the job is no longer this box's to start.
// cm:guard its own type and NOT a `Prepared` carrying an empty preparation. `startJobForMaster` answers `{ok:true}` and nothing else — a synthesised `PreparedJob` here would put a record with an empty `agentSessionId` into a caller's hands, which is the silent substitution this repo refuses, wearing a shape that type-checks.
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

/// Every claimable row for this box, optionally narrowed to one project.
// cm:edge contract -> packages/core/src/devices/pool-routes.ts — `GET /me/pool`, device-authenticated. Its own guard says a row with no `jobId` is a malformed claim waiting to happen, which is why `job_id` is the one field this crate requires.
pub async fn list(
    client: &CoreClient,
    project_id: Option<&str>,
    limit: u32,
) -> Result<Vec<PoolEntry>> {
    let mut url = client.url(&format!("/api/devices/me/pool?limit={limit}"));
    if let Some(p) = project_id {
        url.push_str(&format!("&projectId={p}"));
    }
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("pool request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("pool {status}: {text}")));
    }
    let parsed: PoolResponse = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("pool decode: {e}")))?;
    Ok(parsed.items)
}

/// Take a job without starting it: it stays `queued` and becomes HELD.
// cm:guard the caller OWES a `start` or a `release` for every `Took`, and there is no third answer. Core's three-minute reaper is the backstop rather than the plan: a hold nobody follows through on keeps the row out of the pool for that whole window, and it is this box that would be waiting for its own work.
pub async fn prepare(client: &CoreClient, job_id: &str, session_id: &str) -> Result<Prepared> {
    let body = serde_json::json!({ "jobId": job_id, "sessionId": session_id });
    let parsed = post(client, "/api/devices/me/pool/prepare", body).await?;
    if parsed.ok {
        return match parsed.prepared {
            Some(p) => Ok(Prepared::Took(Box::new(p))),
            // cm:guard an `ok:true` with no preparation is a CONTRACT BREAK and is refused by name rather than treated as an empty success. The job is held at this point, so a silent `None` would leave the row out of the pool with nobody intending to run it.
            None => Err(Error::Other(
                "pool prepare answered ok with no preparation — the job is held and nothing can run it".into(),
            )),
        };
    }
    Ok(Prepared::Refused(Refusal::of(
        parsed.reason.as_deref().unwrap_or("unknown"),
    )))
}

/// Hand a prepared job to the process now starting it.
// cm:edge lockstep -> packages/core/src/devices/claim.ts — `startJobForMaster` stamps `device_id`, `runner_id`, `status` and `started_at` and clears the hold in ONE statement. Nothing here may run between those; a job left with `device_id` NULL while its agent is alive makes every runner route 403 at 2/s with no backpressure (measured on epodsystem 2026-09-05).
pub async fn start(client: &CoreClient, job_id: &str, session_id: &str) -> Result<Started> {
    let body = serde_json::json!({ "jobId": job_id, "sessionId": session_id });
    let parsed = post(client, "/api/devices/me/pool/start", body).await?;
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
    post(client, "/api/devices/me/pool/release", body).await?;
    Ok(())
}

// cm:guard a refused claim answers 200 with `ok:false`, so a non-2xx here is a TRANSPORT fault and must stay an `Err` — core's own route guard says a busy issue and a lost race are ordinary outcomes and making them errors invites a retry loop against a condition retrying cannot change. Folding a 500 into `Refused` would do the reverse and hide a broken core as a full pool.
async fn post(client: &CoreClient, path: &str, body: serde_json::Value) -> Result<ClaimResponse> {
    let url = client.url(path);
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("pool {path}: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("pool {path} {status}: {text}")));
    }
    resp.json()
        .await
        .map_err(|e| Error::Other(format!("pool {path} decode: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    // cm:guard the four issue-less kinds decode with every issue field null, which is the ONLY
    // shape this module ever sees in production. A required `title` or `status` would make the pool
    // undecodable for exactly the work it exists to take.
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

    // cm:guard every refusal core can answer maps to its own variant. This list is the lockstep the
    // guard on `Refusal` names: a reason that fell through to `Unknown` would be indistinguishable
    // from a core newer than this binary, and the two need different answers.
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

    // cm:guard a reason this binary has never heard of keeps its WORD. A core deployed ahead of the
    // fleet is the ordinary case, and an operator reading the log needs what core said.
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
