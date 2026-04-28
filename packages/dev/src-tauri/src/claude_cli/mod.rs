mod agent;
mod mcp;
pub(crate) mod platform;
mod session;
mod spawn;
pub(crate) mod worktree;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};

// Re-export public API
pub use agent::{run_agent, send_chat, abort_agent, get_status, get_claude_session_id};
pub use session::{start_session, open_terminal, SelectedIssue, SelectedTask};
pub use worktree::WorktreeInfo;

pub fn log_pub(msg: &str) { log(msg); }

const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024; // 10 MB

pub(crate) fn log(msg: &str) {
    use std::io::Write;
    use std::sync::{Mutex, OnceLock};

    static LOG_FILE: OnceLock<Mutex<std::fs::File>> = OnceLock::new();
    let file_mutex = LOG_FILE.get_or_init(|| {
        let path = std::env::temp_dir().join("forge-beta.log");
        // Rotate if too large
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > MAX_LOG_BYTES {
                let bak = std::env::temp_dir().join("forge-beta.log.old");
                let _ = std::fs::rename(&path, &bak);
            }
        }
        let f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .expect("Failed to open log file");
        Mutex::new(f)
    });
    if let Ok(mut f) = file_mutex.lock() {
        let _ = writeln!(f, "{msg}");
    }
    eprintln!("{msg}");
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AgentStatus {
    Idle,
    Running,
    Completed,
    Failed,
}

#[derive(Debug)]
pub(crate) struct AgentSession {
    pub status: AgentStatus,
    pub child: Option<Child>,
    pub claude_session_id: Option<String>,
    #[allow(dead_code)] // stored for future worktree cleanup on session end
    pub worktree_path: Option<String>,
}

pub type Sessions = Arc<Mutex<HashMap<String, AgentSession>>>;

pub fn new_sessions() -> Sessions {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Remove completed/failed sessions when count exceeds 50.
pub(crate) async fn prune_sessions(sessions: &Sessions) {
    let mut s = sessions.lock().await;
    if s.len() <= 50 { return; }
    let mut to_remove: Vec<String> = s.iter()
        .filter(|(_, sess)| matches!(sess.status, AgentStatus::Completed | AgentStatus::Failed))
        .map(|(k, _)| k.clone())
        .collect();
    to_remove.sort(); // Deterministic eviction order
    if to_remove.is_empty() {
        log(&format!("[prune] {} active sessions, none pruneable", s.len()));
        return;
    }
    for key in to_remove {
        s.remove(&key);
        if s.len() <= 50 { break; }
    }
}
