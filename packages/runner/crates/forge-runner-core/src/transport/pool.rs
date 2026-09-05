//! The pool half of master orchestration: what work exists, taking it,
//! handing it back, and how loaded this box is.
//!
//! Core answers all four; this box is the only thing holding a device token,
//! so a master asks through here rather than talking to core itself.

use super::CoreClient;
use crate::error::{Error, Result};
use crate::transport::frames::JobToken;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolRelation {
    pub kind: String,
    #[serde(default)]
    pub depends_on_key: Option<String>,
    // cm:guard these three stay RAW and are never folded into a boolean on the way through. The master decides what a blocker means; a `dropped` blocker and one that merged then went `reopen` need different answers, and both collapse to the same `false`.
    #[serde(default)]
    pub blocker_status: Option<String>,
    #[serde(default)]
    pub blocker_merged_at: Option<String>,
    #[serde(default)]
    pub edge_valid_until: Option<String>,
}

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
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub age_minutes: f64,
    #[serde(default)]
    pub attempts: i64,
    #[serde(default)]
    pub relations: Vec<PoolRelation>,
}

/// One issue a project has declared VISIBLE to its master without making it
/// work: no job, no run, nothing claimable. Turning one into work is
/// `promote`, and nothing else here can.
// cm:guard there is no `job_id` on this type and there must never be one — the whole point of the sibling `backlog` key is that a row here cannot be handed to `pool claim`, and a field that made it look claimable would put that mistake one typo away.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklogEntry {
    pub issue_id: String,
    #[serde(default)]
    pub issue_key: Option<String>,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub age_minutes: f64,
    #[serde(default)]
    pub relations: Vec<PoolRelation>,
}

/// What core answered: claimable work, and the declared backlog beside it.
// cm:guard `backlog` carries `#[serde(default)]` so a core that predates ISS-917 (or a project with no `poolBacklog`) decodes to an empty vec rather than a parse error. Same rule as every other field here: a runner must survive talking to a core older OR newer than itself.
#[derive(Debug, Deserialize)]
struct PoolResponse {
    items: Vec<PoolEntry>,
    #[serde(default)]
    backlog: Vec<BacklogEntry>,
}

/// Claimable work and the declared backlog, as one read.
pub struct PoolView {
    pub items: Vec<PoolEntry>,
    pub backlog: Vec<BacklogEntry>,
}

pub async fn pool(client: &CoreClient, limit: u32, project_id: Option<&str>) -> Result<PoolView> {
    let mut url = client.url(&format!("/api/devices/me/pool?limit={limit}"));
    if let Some(p) = project_id {
        url.push_str(&format!("&projectId={p}"));
    }
    let resp = get(client, &url).await?;
    let parsed: PoolResponse = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("pool decode: {e}")))?;
    Ok(PoolView {
        items: parsed.items,
        backlog: parsed.backlog,
    })
}

/// The outcome of asking core to turn one backlog row into work.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteOutcome {
    pub ok: bool,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub issue_key: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
}

/// Move one backlog issue to the entry status so it becomes claimable.
// cm:guard promote goes STRAIGHT TO CORE, unlike `claim`, and that difference is deliberate: it starts no process, takes no repo lock and touches no in-flight map, so routing it through the daemon would buy nothing and make a master on a box whose daemon is down unable to do a thing the box never needed to be up for.
// cm:guard a refusal is `ok:false` on a 200 and must not be retried in a loop — `entry_gated` clears only when a human edits the project config, and `issue_busy` only when another master's work ends.
pub async fn promote(client: &CoreClient, issue_id: &str) -> Result<PromoteOutcome> {
    let url = client.url("/api/devices/me/pool/promote");
    let body = serde_json::json!({ "issueId": issue_id });
    let resp = post(client, &url, body).await?;
    resp.json()
        .await
        .map_err(|e| Error::Other(format!("promote decode: {e}")))
}

/// What core prepared for a claimed job: identity, prompt, and the settings the
/// process runs under.
// cm:guard NEVER add `#[serde(deny_unknown_fields)]`, here or on any type below. Core ships fields before the fleet is on the version that reads them, and denying unknowns turns the next such field into every box failing every claim at once, with the error inside serde rather than anywhere an operator would look.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub job_id: String,
    pub project_id: String,
    #[serde(default)]
    pub issue_id: Option<String>,
    #[serde(rename = "type")]
    pub job_type: String,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default)]
    pub prompt_string: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub prior_claude_session_id: Option<String>,
    #[serde(default)]
    pub runner_type: Option<String>,
    #[serde(default)]
    pub session_mode: Option<String>,
    #[serde(default)]
    pub session_residency_seconds: Option<u64>,
    #[serde(default)]
    pub agent_session_id: Option<String>,
    #[serde(default)]
    pub attempts: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOutcome {
    pub ok: bool,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub job_token: Option<String>,
    #[serde(default)]
    pub issue_key: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default, skip_serializing)]
    pub prepared: Option<Prepared>,
}

/// One claimed job, in the shape the dispatch path runs.
// cm:guard identity here comes from `Prepared`, never from the pool entry the master was holding — that entry is a snapshot minutes old by the time a master decides, and core refuses the same mismatch on its own side rather than let a session row and a running process name different jobs.
#[derive(Debug, Clone)]
pub struct ClaimedJob {
    pub job_id: String,
    pub project_id: String,
    pub issue_id: Option<String>,
    pub job_type: String,
    pub payload: serde_json::Value,
    pub prompt_string: Option<String>,
    pub system_prompt: Option<String>,
    pub model: Option<String>,
    pub allowed_tools: Option<String>,
    pub disallowed_tools: Option<String>,
    pub permission_mode: Option<String>,
    pub timeout_seconds: Option<u64>,
    pub mcp_servers_override: Option<serde_json::Value>,
    pub claude_session_id: Option<String>,
    pub runner_type: Option<String>,
    pub session_mode: Option<String>,
    pub session_residency_seconds: Option<u64>,
    pub agent_session_id: Option<String>,
    pub issue_key: Option<String>,
    pub attempts: Option<u32>,
    pub pat_token: Option<JobToken>,
    // cm:guard the master's name for this agent, and the git branch its worktree sits on. It replaces core's `worktreeBranch` payload outright: core no longer names a branch, so a job that reaches dispatch with this empty has no checkout of its own and would write the repo ROOT — which is why the claim refuses an unnamed agent at the door rather than defaulting one here.
    pub agent_name: String,
}

fn payload_str(payload: &serde_json::Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

impl Prepared {
    /// Fold the preparation and the claim's own two fields into one job.
    // cm:guard the stage overrides live INSIDE `payload` (core's `buildOverridesPayload` writes them there) and must be read out here rather than expected as siblings. Reading them off the top level yields `None` for every one, which is not a parse error — it is a job that silently runs with the project defaults instead of the stage's model, tools and timeout.
    pub fn into_claimed(
        self,
        job_token: Option<String>,
        issue_key: Option<String>,
        agent_name: String,
    ) -> ClaimedJob {
        let payload = self.payload;
        ClaimedJob {
            job_id: self.job_id,
            project_id: self.project_id,
            issue_id: self.issue_id,
            job_type: self.job_type,
            allowed_tools: payload_str(&payload, "allowedTools"),
            disallowed_tools: payload_str(&payload, "disallowedTools"),
            permission_mode: payload_str(&payload, "permissionMode"),
            timeout_seconds: payload
                .get("timeoutSeconds")
                .and_then(serde_json::Value::as_u64),
            mcp_servers_override: payload.get("mcpServersOverride").cloned(),
            issue_key: issue_key.or_else(|| payload_str(&payload, "issueKey")),
            payload,
            prompt_string: self.prompt_string,
            system_prompt: self.system_prompt,
            model: self.model,
            claude_session_id: self.prior_claude_session_id,
            runner_type: self.runner_type,
            session_mode: self.session_mode,
            session_residency_seconds: self.session_residency_seconds,
            agent_session_id: self.agent_session_id,
            attempts: self.attempts,
            pat_token: job_token.map(JobToken::new),
            agent_name,
        }
    }
}

/// Take one job for `session_id`.
// cm:guard a refusal comes back as `ok:false` on a 200 and MUST NOT be retried in a loop. A full box and a lost race are ordinary; retrying either changes nothing and burns the master's turn budget on a condition only another master finishing can clear.
pub async fn claim(client: &CoreClient, job_id: &str, session_id: &str) -> Result<ClaimOutcome> {
    let url = client.url("/api/devices/me/pool/claim");
    let body = serde_json::json!({ "jobId": job_id, "sessionId": session_id });
    let resp = post(client, &url, body).await?;
    resp.json()
        .await
        .map_err(|e| Error::Other(format!("claim decode: {e}")))
}

/// Hand back one job, or everything this session holds when `job_id` is None.
pub async fn release(client: &CoreClient, job_id: Option<&str>, session_id: &str) -> Result<u32> {
    let url = client.url("/api/devices/me/pool/release");
    let mut body = serde_json::json!({ "sessionId": session_id });
    if let Some(id) = job_id {
        body["jobId"] = serde_json::Value::String(id.to_string());
    }
    let resp = post(client, &url, body).await?;
    let parsed: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("release decode: {e}")))?;
    Ok(parsed.get("released").and_then(|v| v.as_u64()).unwrap_or(0) as u32)
}

/// Raw occupancy for this box, its project and the project's fleet.
// cm:guard pass this through verbatim — no derived "you may take N more" field, here or in the CLI that prints it. That number is the ceiling this design removed, and a master reading it stops weighing the facts that produced it.
pub async fn load(client: &CoreClient, project_id: Option<&str>) -> Result<serde_json::Value> {
    let mut url = client.url("/api/devices/me/load");
    if let Some(p) = project_id {
        url.push_str(&format!("?projectId={p}"));
    }
    let resp = get(client, &url).await?;
    resp.json()
        .await
        .map_err(|e| Error::Other(format!("load decode: {e}")))
}

async fn get(client: &CoreClient, url: &str) -> Result<reqwest::Response> {
    let resp = client
        .http()
        .get(url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("pool request: {e}")))?;
    check(resp).await
}

async fn post(
    client: &CoreClient,
    url: &str,
    body: serde_json::Value,
) -> Result<reqwest::Response> {
    let resp = client
        .http()
        .post(url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("pool request: {e}")))?;
    check(resp).await
}

async fn check(resp: reqwest::Response) -> Result<reqwest::Response> {
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("pool {status}: {text}")));
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relation_keeps_the_blocker_status_it_was_given() {
        let raw = serde_json::json!({
            "kind": "blocks",
            "dependsOnKey": "ISS-900",
            "blockerStatus": "dropped",
            "blockerMergedAt": null,
            "edgeValidUntil": null
        });
        let rel: PoolRelation = serde_json::from_value(raw).unwrap();
        assert_eq!(rel.blocker_status.as_deref(), Some("dropped"));
        assert!(rel.blocker_merged_at.is_none());
    }

    // cm:guard core may add fields to a pool entry at any time and a runner that predates them must still parse. Deserialisation here is permissive on purpose; making it strict turns a core deploy into a fleet-wide parse failure.
    #[test]
    fn an_entry_with_unknown_fields_still_parses() {
        let raw = serde_json::json!({
            "jobId": "j1", "type": "code", "issueKey": "ISS-1",
            "somethingCoreAddedLater": 42
        });
        let entry: PoolEntry = serde_json::from_value(raw).unwrap();
        assert_eq!(entry.job_id, "j1");
        assert_eq!(entry.job_type, "code");
        assert!(entry.relations.is_empty());
    }

    // cm:guard the reason this test exists: a core that has never heard of ISS-917 sends no `backlog` key at all, and a fleet that could not decode that response would be every box failing every pool read at once, with the error inside serde.
    #[test]
    fn a_response_without_a_backlog_key_still_parses() {
        let raw = serde_json::json!({ "items": [] });
        let parsed: PoolResponse = serde_json::from_value(raw).unwrap();
        assert!(parsed.backlog.is_empty());
    }

    #[test]
    fn a_backlog_entry_keeps_its_status_and_carries_no_job() {
        let raw = serde_json::json!({
            "issueId": "i1", "issueKey": "ISS-917", "projectId": "p1",
            "status": "draft", "priority": "high", "ageMinutes": 12.0,
            "relations": [{ "kind": "blocks", "dependsOnKey": "ISS-900",
                            "blockerStatus": "closed", "blockerMergedAt": null,
                            "edgeValidUntil": null }]
        });
        let e: BacklogEntry = serde_json::from_value(raw).unwrap();
        assert_eq!(e.status, "draft");
        assert_eq!(e.issue_key.as_deref(), Some("ISS-917"));
        assert_eq!(e.relations.len(), 1);
        assert_eq!(e.relations[0].blocker_status.as_deref(), Some("closed"));
    }

    #[test]
    fn a_refused_promote_parses_as_a_named_reason() {
        let raw = serde_json::json!({
            "ok": false, "reason": "entry_gated",
            "detail": "states.open is set to manual"
        });
        let out: PromoteOutcome = serde_json::from_value(raw).unwrap();
        assert!(!out.ok);
        assert_eq!(out.reason.as_deref(), Some("entry_gated"));
        assert!(out.job_id.is_none());
    }

    #[test]
    fn a_refusal_parses_as_a_reason_not_an_error() {
        let raw = serde_json::json!({ "ok": false, "reason": "already_held" });
        let out: ClaimOutcome = serde_json::from_value(raw).unwrap();
        assert!(!out.ok);
        assert_eq!(out.reason.as_deref(), Some("already_held"));
        assert!(out.job_token.is_none());
    }
}
