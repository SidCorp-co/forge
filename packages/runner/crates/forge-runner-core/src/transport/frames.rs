//! Wire frames received from core over `/ws`.

use serde::Deserialize;

/// A job-scoped PAT minted by core for the life of one job.
// cm:guard the redacting `Debug` is the whole point of the newtype — `JobAssigned` and `JobSpec` both derive `Debug`, so the day someone adds a `tracing::debug!("{ja:?}")` a plain `String` here writes a live credential into the daemon log and into Sentry. Keep the manual impl; deriving `Debug` on this type silently undoes it.
#[derive(Clone, Deserialize)]
#[serde(transparent)]
pub struct JobToken(String);

impl JobToken {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for JobToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("JobToken(redacted)")
    }
}

/// Envelope core wraps every broadcast in: `{ event, data, timestamp }`.
#[derive(Debug, Clone, Deserialize)]
pub struct Frame {
    pub event: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

/// `job.assigned` payload (subset the runner needs). Field names are camelCase
/// on the wire.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobAssigned {
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
    pub allowed_tools: Option<String>,
    #[serde(default)]
    pub disallowed_tools: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub mcp_servers_override: Option<serde_json::Value>,
    /// Resume target — the single source of truth for `--resume`.
    #[serde(default)]
    pub claude_session_id: Option<String>,
    #[serde(default)]
    pub runner_type: Option<String>,
    // cm:edge contract -> packages/core/src/runners/adapters/claude-code.ts — `"duplex"` is the ONLY value that opts a project in; absent, null or anything else reads as print. Deserialised as a plain Option<String> rather than an enum on purpose: a core that adds a third mode must not make every job frame fail to parse on a runner that predates it.
    #[serde(default)]
    pub session_mode: Option<String>,
    // cm:edge contract -> packages/core/src/jobs/park-deadline.ts — the SAME `pipelineConfig.sessionResidencySeconds`, and core's backstop fires at this value PLUS a grace. Reading it differently on the two sides is what makes `residency_expired` stop meaning "the runner is gone": core would reap a park the runner still considers live.
    #[serde(default)]
    pub session_residency_seconds: Option<u64>,
    #[serde(default)]
    pub agent_session_id: Option<String>,
    /// `ISS-<seq>` for the issue this job serves. The runner matches it against
    /// the agent's worktree branches to find the checkout worth salvaging.
    #[serde(default)]
    pub issue_key: Option<String>,
    /// `jobs.attempts` — which try this is. `None` from a core that predates
    /// the field; the salvage commit then simply omits its `forge-attempt`
    /// trailer rather than guessing a number.
    #[serde(default)]
    pub attempts: Option<u32>,
    // cm:edge contract -> packages/core/src/jobs/job-token.ts — core mints this per job and revokes it the moment the job goes terminal, so it is useless to cache and wrong to persist. A runner that predates the field simply gets `None` and the agent keeps whatever `$FORGE_PAT` the operator set by hand, which is exactly the behaviour that lets core start sending it before the whole fleet is on this version.
    #[serde(default)]
    pub pat_token: Option<JobToken>,
}

/// Extract a `jobId` from a `job.cancel` / `job.cancelRequested` frame.
pub fn job_id_of(data: &serde_json::Value) -> Option<String> {
    data.get("jobId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Extract a `sessionId` from an `agent:abort` (chat) frame.
pub fn session_id_of(data: &serde_json::Value) -> Option<String> {
    data.get("sessionId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(extra: &str) -> JobAssigned {
        let json = format!(r#"{{"jobId":"j1","projectId":"p1","type":"code"{extra}}}"#);
        serde_json::from_str(&json).expect("job.assigned must parse")
    }

    #[test]
    fn reads_the_job_token_off_the_frame() {
        let ja = frame(r#","patToken":"forge_pat_live_abc""#);
        assert_eq!(ja.pat_token.expect("token").expose(), "forge_pat_live_abc");
    }

    #[test]
    fn a_frame_without_a_token_parses_and_carries_none() {
        assert!(frame("").pat_token.is_none());
    }

    #[test]
    fn debug_never_prints_the_token() {
        let ja = frame(r#","patToken":"forge_pat_live_secret""#);
        let rendered = format!("{ja:?}");
        assert!(
            !rendered.contains("forge_pat_live_secret"),
            "the token reached a Debug rendering: {rendered}"
        );
        assert!(rendered.contains("JobToken(redacted)"));
    }
}
