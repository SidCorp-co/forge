//! The runner abstraction — the seam that lets one device drive multiple CLI
//! backends (Claude Code today; codex later). Core already tags
//! every claimed job with `runnerType`, so a new kind = a new
//! `Runner` impl + a stream parser.

pub mod chat;
pub mod chat_checkout;
#[cfg(test)]
mod chat_checkout_test_repo;
pub mod claude_code;
pub mod support_build;

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
    pub mcp_servers_override: Option<serde_json::Value>,
    /// `claudeSessionId` from core — the single source of truth for resume.
    pub resume_id: Option<String>,
    pub counts_against_session_cap: bool,
    /// The token core minted for the person this session answers (ISS-17). When present it is
    /// the session's `forge` MCP credential and its `$FORGE_PAT`, in place of the box's own —
    /// which belongs to whoever paired the box, not to the person who asked.
    pub credential: Option<TurnCredential>,
    /// Core's word that this session holds only `credential`: none of this box's own, in its
    /// environment or on any path it can read. `None` runs it with the box's view, as a run.
    pub confinement: Option<Confinement>,
    /// Core's word that this session runs with every Claude Code hook off (`ungated` on the turn
    /// frame): a POC room's agent, whose edit reaches its preview with no check the checkout declares
    /// run in between (REQ-44 BC-3).
    pub hooks_off: bool,
    /// Core's word that this session stays resident across turns that each carry their own token
    /// (`keepResident` on the turn frame): a support group's session (REQ-75 BC-11). Its `forge`
    /// server reads the bearer from a file the runner rewrites before each turn, and its
    /// environment holds no Forge credential, so a later turn is written into the same process
    /// rather than spawning one.
    pub keep_resident: bool,
}

/// What a confined session is handed beyond its checkout, its MCP config and Claude Code's
/// own install: files it reads, such as a turn's attachments, and how it sees the checkout.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Confinement {
    pub reads: Vec<PathBuf>,
    pub checkout: CheckoutView,
}

/// How a confined session sees the working directory it is spawned in (`checkout` on the turn
/// frame, REQ-75 r5 BC-27). A support room granted `read_checkout` reads the project's checkout and
/// writes none of it; one granted nothing sees an empty folder; one granted `build` works in a
/// working copy of the development branch this box keeps for the room, whose git directory it
/// still cannot write, so it never commits or pushes on its own; a channel agent in owner mode
/// works in its own clone, git directory included (ISS-765).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum CheckoutView {
    /// The checkout, writable: every chat door before REQ-75 r5, and any turn that names no view.
    #[default]
    Write,
    Read,
    None,
    /// The room's working copy (the session's working directory) of `base`, kept under `key`.
    Build {
        key: String,
        base: String,
    },
    /// An owner-mode channel agent's own clone of `base` (ISS-765), kept under `key`: writable with
    /// its git directory, so it commits and pushes itself, holding a credential core mints for its
    /// own repository alone; it reaches `hosts` (the repository's git and API hosts) besides the
    /// model and core, and nothing else this box keeps.
    Own {
        key: String,
        base: String,
        hosts: Vec<String>,
    },
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
