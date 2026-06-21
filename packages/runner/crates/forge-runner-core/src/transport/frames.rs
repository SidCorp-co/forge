//! Wire frames received from core over `/ws`.

use serde::Deserialize;

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
    #[serde(default)]
    pub agent_session_id: Option<String>,
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
