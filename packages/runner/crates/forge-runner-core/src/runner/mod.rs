//! The runner abstraction — the seam that lets one device drive multiple CLI
//! backends (Claude Code today; codex / antigravity later). Core already tags
//! every `job.assigned` with `runnerType`, so a new kind = new `RunnerKind`
//! variant + a `Runner` impl + a stream parser.

use std::path::PathBuf;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::error::Result;

pub mod claude_code;
pub mod inflight;
pub mod process;

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

/// Normalized job description, decoupled from core's exact `job.assigned` shape.
#[derive(Debug, Clone)]
pub struct JobSpec {
    pub job_id: String,
    pub project_id: String,
    /// Project slug — used for the MCP `X-Forge-Project-Slug` header.
    pub project_slug: Option<String>,
    pub issue_id: Option<String>,
    /// Pipeline step: triage|clarify|plan|code|review|test|release|fix|pm|custom.
    pub step: String,
    pub repo_path: PathBuf,
    pub prompt: Option<String>,
    pub system_prompt: Option<String>,
    pub model: Option<String>,
    pub allowed_tools: Option<String>,
    pub disallowed_tools: Option<String>,
    pub permission_mode: Option<String>,
    pub timeout_seconds: Option<u64>,
    pub mcp_servers_override: Option<serde_json::Value>,
    pub worktree_branch: Option<String>,
    /// Commit-ish a NEW `worktree_branch` is cut from — `origin/<base>` when the
    /// daemon resolved one. `None` falls back to the main worktree's HEAD.
    pub worktree_start_point: Option<String>,
    /// `claudeSessionId` from core — the single source of truth for resume.
    pub resume_id: Option<String>,
    pub agent_session_id: Option<String>,
    // cm:guard duplex means the prompt arrives on stdin as a stream-json message instead of `-p`, so a duplex spawn with no prompt is a live process nobody ever spoke to. Chat sets this; pipeline jobs stay print until ISS-873 phase 3, and the fleet-wide flip is phase 5 — do NOT default it to true to "get there sooner", the beat and the result-miss reaper are still print-shaped.
    pub duplex: bool,
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
    // cm:guard a turn owns its own channel because a resident session outlives any one of them — chat's consumer breaks at every turn end, so re-using the channel from `start` would drop turn 2 into a receiver nobody is reading.
    async fn send(
        &self,
        session: &SessionId,
        message: String,
        tx: mpsc::Sender<RunnerEvent>,
    ) -> Result<()>;
    async fn abort(&self, session: &SessionId) -> Result<()>;
    fn status(&self, session: &SessionId) -> RunnerStatus;
}
