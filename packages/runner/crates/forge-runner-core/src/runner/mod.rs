//! The runner abstraction — the seam that lets one device drive multiple CLI
//! backends (Claude Code today; codex later). Core already tags
//! every claimed job with `runnerType`, so a new kind = new `RunnerKind`
//! variant + a `Runner` impl + a stream parser.

use std::path::PathBuf;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::error::Result;

pub mod blocked;
pub mod claude_code;
pub mod close_loop;
#[cfg_attr(not(unix), path = "doorbell_no_fifo.rs")]
pub mod doorbell;
pub mod inflight;
pub mod ledger;
pub mod process;
pub mod terminate;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunnerKind {
    ClaudeCode,
    // Codex,
    // Antigravity,
}

impl RunnerKind {
    /// Wire value used by core (`runnerType` / `runner:register`).
    pub fn wire_type(&self) -> &'static str {
        match self {
            RunnerKind::ClaudeCode => "claude-code",
        }
    }
}

pub type SessionId = String;

/// Normalized job description, decoupled from core's exact claim shape.
#[derive(Debug, Clone)]
pub struct JobSpec {
    pub job_id: String,
    pub project_id: String,
    /// Project slug — used for the MCP `X-Forge-Project-Slug` header.
    pub project_slug: Option<String>,
    pub issue_id: Option<String>,
    /// Pipeline step: triage|clarify|plan|code|review|test|release|fix|pm|custom.
    pub step: String,
    /// The directory the session runs in, already resolved by the caller.
    pub repo_path: PathBuf,
    pub prompt: Option<String>,
    pub system_prompt: Option<String>,
    pub model: Option<String>,
    pub allowed_tools: Option<String>,
    pub disallowed_tools: Option<String>,
    pub permission_mode: Option<String>,
    pub timeout_seconds: Option<u64>,
    pub mcp_servers_override: Option<serde_json::Value>,
    /// `claudeSessionId` from core — the single source of truth for resume.
    pub resume_id: Option<String>,
    pub agent_session_id: Option<String>,
    pub counts_against_session_cap: bool,
    /// How long a resident session may sit parked between turns, from
    /// `pipelineConfig.sessionResidencySeconds`. `None` and `Some(0)` both mean
    /// "use the default" — see `resolve_residency`.
    pub session_residency_seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPhase {
    Call,
    Result,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Transient,
    ResumeFailed,
    UsageLimit,
    Permanent,
}

/// Normalized output, independent of which CLI produced it. The daemon maps
/// these onto core's job events / lifecycle calls.
#[derive(Debug, Clone)]
pub enum RunnerEvent {
    /// One raw JSONL line from the underlying CLI.
    Stdout(serde_json::Value),
    Tool {
        name: String,
        phase: ToolPhase,
    },
    Usage {
        input: u64,
        output: u64,
        cache_read: u64,
        cache_write: u64,
    },
    /// Captured CLI session id (for resume bookkeeping on core).
    ClaudeSessionId(String),
    /// The PROCESS's own state, distinct from the job's lifecycle status.
    StateChanged(&'static str),
    Done {
        exit_code: i32,
    },
    Failed {
        error: String,
        kind: FailureKind,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerStatus {
    Idle,
    Running,
    Completed,
    Failed,
}

#[async_trait]
pub trait Runner: Send + Sync {
    fn kind(&self) -> RunnerKind;
    /// Spawn the job, streaming normalized events on `tx`. Returns the session id.
    async fn start(&self, spec: JobSpec, tx: mpsc::Sender<RunnerEvent>) -> Result<SessionId>;
    /// Send one more turn into a LIVE session, streaming its events on `tx`.
    async fn send(
        &self,
        session: &SessionId,
        message: String,
        tx: mpsc::Sender<RunnerEvent>,
    ) -> Result<()>;
    async fn abort(&self, session: &SessionId) -> Result<()>;
    fn status(&self, session: &SessionId) -> RunnerStatus;
}
