//! The runner abstraction — the seam that lets one device drive multiple CLI
//! backends (Claude Code today; codex later). Core already tags
//! every claimed job with `runnerType`, so a new kind = a new
//! `Runner` impl + a stream parser.

pub mod chat;
pub mod claude_code;

use std::path::PathBuf;

use async_trait::async_trait;

use tokio::sync::mpsc;

use runner_platform::error::Result;
pub type SessionId = String;

/// Normalized job description, decoupled from core's exact claim shape.
#[derive(Debug, Clone)]
pub struct JobSpec {
    pub job_id: String,
    pub project_id: String,
    /// Project slug — used for the MCP `X-Forge-Project-Slug` header.
    pub project_slug: Option<String>,

    pub repo_path: PathBuf,
    pub prompt: Option<String>,
    pub system_prompt: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub timeout_seconds: Option<u64>,
    pub mcp_servers_override: Option<serde_json::Value>,
    /// `claudeSessionId` from core — the single source of truth for resume.
    pub resume_id: Option<String>,
    pub counts_against_session_cap: bool,
    /// The token core minted for the person this session answers (ISS-17). When present it is
    /// the session's `forge` MCP credential and its `$FORGE_PAT`, in place of the box's own —
    /// which belongs to whoever paired the box, not to the person who asked.
    pub credential: Option<TurnCredential>,
}

/// A per-session token handed over by core. Its `Debug` never prints the secret.
#[derive(Clone, PartialEq, Eq)]
pub struct TurnCredential(pub String);

impl std::fmt::Debug for TurnCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TurnCredential(<redacted>)")
    }
}

/// Normalized output, independent of which CLI produced it. The daemon maps
/// these onto core's job events / lifecycle calls.
#[derive(Debug, Clone)]
pub enum RunnerEvent {
    /// One raw JSONL line from the underlying CLI.
    Stdout(serde_json::Value),
    /// Captured CLI session id (for resume bookkeeping on core).
    ClaudeSessionId(String),
    StateChanged(&'static str),
    Done,
    Failed {
        error: String,
    },
}

#[async_trait]
pub trait Runner: Send + Sync {
    /// Spawn the job, streaming normalized events on `tx`. Returns the session id.
    async fn start(&self, spec: JobSpec, tx: mpsc::Sender<RunnerEvent>) -> Result<SessionId>;
    async fn send(
        &self,
        session: &SessionId,
        message: String,
        tx: mpsc::Sender<RunnerEvent>,
    ) -> Result<()>;
    async fn abort(&self, session: &SessionId) -> Result<()>;
}
