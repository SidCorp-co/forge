//! Wire frames received from core over `/ws`.

use serde::Deserialize;

/// Envelope core wraps every broadcast in: `{ event, data, timestamp }`.
#[derive(Debug, Clone, Deserialize)]
pub struct Frame {
    pub event: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

/// Extract a `jobId` from a `job.cancel` frame.
pub fn job_id_of(data: &serde_json::Value) -> Option<String> {
    data.get("jobId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Extract a `sessionId` from an `agent:abort` or `agent:close` (chat) frame.
pub fn session_id_of(data: &serde_json::Value) -> Option<String> {
    data.get("sessionId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}
