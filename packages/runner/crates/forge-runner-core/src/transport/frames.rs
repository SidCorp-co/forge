//! Wire frames received from core over `/ws`.

use serde::Deserialize;

/// A job-scoped PAT minted by core for the life of one job.
// cm:guard the redacting `Debug` is the whole point of the newtype — `ClaimedJob` and `JobSpec` both derive `Debug`, so the day someone adds a `tracing::debug!("{job:?}")` a plain `String` here writes a live credential into the daemon log and into Sentry. Keep the manual impl; deriving `Debug` on this type silently undoes it.
#[derive(Clone, Deserialize)]
#[serde(transparent)]
pub struct JobToken(String);

impl JobToken {
    pub fn new(raw: String) -> Self {
        Self(raw)
    }

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

    #[test]
    fn debug_never_prints_the_token() {
        let token = JobToken::new("forge_pat_live_secret".into());
        let rendered = format!("{token:?}");
        assert!(
            !rendered.contains("forge_pat_live_secret"),
            "the token reached a Debug rendering: {rendered}"
        );
        assert!(rendered.contains("JobToken(redacted)"));
        assert_eq!(token.expose(), "forge_pat_live_secret");
    }

    #[test]
    fn a_cancel_frame_yields_its_job_id() {
        let data = serde_json::json!({ "jobId": "j1" });
        assert_eq!(job_id_of(&data).as_deref(), Some("j1"));
        assert!(job_id_of(&serde_json::json!({})).is_none());
    }
}
