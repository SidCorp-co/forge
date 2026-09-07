//! Wire frames received from core over `/ws`.

use serde::Deserialize;

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
    fn a_cancel_frame_yields_its_job_id() {
        let data = serde_json::json!({ "jobId": "j1" });
        assert_eq!(job_id_of(&data).as_deref(), Some("j1"));
        assert!(job_id_of(&serde_json::json!({})).is_none());
    }
}
