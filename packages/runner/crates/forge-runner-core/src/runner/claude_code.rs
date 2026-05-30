//! Claude Code runner — wraps the `claude` CLI behind the [`Runner`] trait.
//! Ported from the Tauri app's `claude_cli/{spawn,agent,mcp}.rs`, emitting
//! [`RunnerEvent`] on a channel instead of Tauri events.
//!
//! Session key = the core `jobId`, so `abort(job_id)` maps a `job.cancel`
//! frame straight onto the right process.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::{mpsc, Mutex};

use super::process::{build_command, graceful_kill};
use super::{FailureKind, JobSpec, Runner, RunnerEvent, RunnerKind, RunnerStatus, SessionId};
use crate::error::{Error, Result};
use crate::mcp;
use crate::transport::CoreClient;
use crate::workspace::{skill_sync, worktree};

struct Session {
    status: RunnerStatus,
    child: Option<tokio::process::Child>,
    claude_session_id: Option<String>,
}

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

pub struct ClaudeCodeRunner {
    core_url: String,
    device_token: String,
    sessions: Sessions,
}

impl ClaudeCodeRunner {
    pub fn new(core_url: impl Into<String>, device_token: impl Into<String>) -> Self {
        Self {
            core_url: core_url.into(),
            device_token: device_token.into(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

fn build_args(spec: &JobSpec, mcp_path: &str) -> Vec<String> {
    let mode = spec
        .permission_mode
        .as_deref()
        .unwrap_or("bypassPermissions");
    let mut args: Vec<String> = vec![
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--permission-mode".into(),
        mode.into(),
    ];
    if let Some(sp) = spec.system_prompt.as_deref().filter(|s| !s.is_empty()) {
        args.push("--append-system-prompt".into());
        args.push(sp.into());
    }
    if let Some(tools) = spec.allowed_tools.as_deref().filter(|s| !s.is_empty()) {
        args.push("--allowed-tools".into());
        args.push(tools.into());
    }
    if let Some(model) = spec.model.as_deref().filter(|s| !s.is_empty()) {
        args.push("--model".into());
        args.push(model.into());
    }
    args.push("--mcp-config".into());
    args.push(mcp_path.into());
    if let Some(rid) = spec.resume_id.as_deref().filter(|s| !s.is_empty()) {
        args.push("--resume".into());
        args.push(rid.into());
    }
    args
}

/// Detect an "out of extra usage" message in a JSONL line.
fn detect_usage_limit(json: &Value) -> Option<String> {
    let hit = |s: &str| s.to_lowercase().contains("out of extra usage");
    if let Some(content) = json
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        for block in content {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    if hit(t) {
                        return Some(t.chars().take(500).collect());
                    }
                }
            }
        }
    }
    if let Some(err) = json.get("error").and_then(Value::as_str) {
        if hit(err) {
            return Some(err.chars().take(500).collect());
        }
    }
    None
}

#[async_trait]
impl Runner for ClaudeCodeRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::ClaudeCode
    }

    async fn start(&self, spec: JobSpec, tx: mpsc::Sender<RunnerEvent>) -> Result<SessionId> {
        let job_id = spec.job_id.clone();

        // Resolve repo (worktree if a branch was requested).
        let repo = spec.repo_path.to_string_lossy().to_string();
        let effective_repo = match spec.worktree_branch.as_deref() {
            Some(branch) => worktree::create(&repo, branch)
                .await?
                .to_string_lossy()
                .to_string(),
            None => repo,
        };

        // ISS-278 — server-driven skill seeding. Pull the project's effective
        // skills, seed `.claude/skills/<name>/` into the working dir, and
        // report installed hashes. Best-effort: a sync failure (old server,
        // transient error, no registered skills) must never block the job —
        // it just means `/forge-*` skills may be absent for this run.
        {
            let client = CoreClient::new(self.core_url.clone(), self.device_token.clone());
            match skill_sync::sync_skills(
                &client,
                &spec.project_id,
                std::path::Path::new(&effective_repo),
            )
            .await
            {
                Ok(n) => tracing::info!("[skills] job={job_id} synced {n} skill(s)"),
                Err(e) => tracing::warn!("[skills] job={job_id} sync skipped: {e}"),
            }
        }

        let prompt = spec
            .prompt
            .clone()
            .ok_or_else(|| Error::Other("job has no prompt".into()))?;

        // MCP config (Forge server + overrides) → temp file.
        let slug = spec.project_slug.as_deref().unwrap_or("");
        let mcp_path = mcp::config::write(
            &self.core_url,
            &self.device_token,
            slug,
            spec.mcp_servers_override.as_ref(),
        )?;
        let mut args = build_args(&spec, &mcp_path.to_string_lossy());
        args.push("-p".into());
        args.push(prompt);

        let invoked_with_resume = spec.resume_id.is_some();
        let timeout = spec
            .timeout_seconds
            .filter(|s| *s > 0)
            .map(Duration::from_secs);

        let mut cmd = build_command(&args, &effective_repo);
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        // New process group so we can kill the whole tree.
        #[cfg(unix)]
        unsafe {
            cmd.pre_exec(|| {
                nix::unistd::setsid()
                    .map(|_| ())
                    .map_err(std::io::Error::other)
            });
        }

        let mut child = cmd.spawn().map_err(|e| {
            let _ = std::fs::remove_file(&mcp_path);
            Error::Other(format!("failed to spawn claude: {e}"))
        })?;
        tracing::info!("[claude] spawned job={job_id}");

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Other("no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::Other("no stderr".into()))?;

        self.sessions.lock().await.insert(
            job_id.clone(),
            Session {
                status: RunnerStatus::Running,
                child: Some(child),
                claude_session_id: None,
            },
        );

        // Shared outcome written incrementally so it survives a reader abort.
        let outcome: Arc<Mutex<(Option<bool>, Option<String>)>> =
            Arc::new(Mutex::new((None, None)));

        // stderr → string.
        let stderr_handle = tokio::spawn(async move {
            let mut buf = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut buf).await;
            buf
        });

        // stdout reader.
        let reader = {
            let tx = tx.clone();
            let sessions = self.sessions.clone();
            let outcome = outcome.clone();
            let job_id = job_id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                let mut got_sid = false;
                let mut got_limit = false;
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(json) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if !got_sid {
                        if let Some(sid) = json.get("session_id").and_then(Value::as_str) {
                            if let Some(s) = sessions.lock().await.get_mut(&job_id) {
                                s.claude_session_id = Some(sid.to_string());
                            }
                            let _ = tx.send(RunnerEvent::ClaudeSessionId(sid.to_string())).await;
                            got_sid = true;
                        }
                    }
                    if !got_limit {
                        if let Some(msg) = detect_usage_limit(&json) {
                            outcome.lock().await.1 = Some(msg);
                            got_limit = true;
                        }
                    }
                    if json.get("type").and_then(Value::as_str) == Some("result") {
                        let is_error = json
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(true);
                        outcome.lock().await.0 = Some(!is_error);
                    }
                    if tx.send(RunnerEvent::Stdout(json)).await.is_err() {
                        break;
                    }
                }
            })
        };

        // Completion task: race reader-EOF vs child-exit (MCP grandchildren can
        // hold the pipe open), then reap, classify, and emit Done/Failed.
        let sessions = self.sessions.clone();
        let job_id_task = job_id.clone();
        tokio::spawn(async move {
            let job_id = job_id_task;
            let mut reader = reader;
            let exit_poll = {
                let sessions = sessions.clone();
                let job_id = job_id.clone();
                async move {
                    loop {
                        {
                            let mut s = sessions.lock().await;
                            match s.get_mut(&job_id).and_then(|x| x.child.as_mut()) {
                                Some(child) => match child.try_wait() {
                                    Ok(Some(_)) | Err(_) => break,
                                    Ok(None) => {}
                                },
                                None => break,
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                }
            };

            match timeout {
                Some(d) => tokio::select! {
                    _ = &mut reader => {}
                    _ = exit_poll => { let _ = tokio::time::timeout(Duration::from_secs(2), &mut reader).await; }
                    _ = tokio::time::sleep(d) => { tracing::warn!("[claude] job={job_id} timed out"); }
                },
                None => tokio::select! {
                    _ = &mut reader => {}
                    _ = exit_poll => { let _ = tokio::time::timeout(Duration::from_secs(2), &mut reader).await; }
                },
            }
            reader.abort();

            let (succeeded_opt, usage_limit) = {
                let o = outcome.lock().await;
                (o.0, o.1.clone())
            };

            // Reap the child + group.
            if let Some(s) = sessions.lock().await.get_mut(&job_id) {
                if let Some(mut child) = s.child.take() {
                    graceful_kill(&mut child).await;
                }
            }

            let stderr = tokio::time::timeout(Duration::from_secs(3), stderr_handle)
                .await
                .ok()
                .and_then(|r| r.ok())
                .unwrap_or_default();

            let usage_limit = usage_limit.or_else(|| {
                stderr
                    .to_lowercase()
                    .contains("out of extra usage")
                    .then(|| stderr.trim().chars().take(500).collect())
            });
            let succeeded = usage_limit.is_none() && succeeded_opt.unwrap_or(false);

            let resume_failed = invoked_with_resume && !succeeded && {
                let b = stderr.to_lowercase();
                b.contains("session not found")
                    || b.contains("could not resume")
                    || b.contains("no such session")
                    || b.contains("session file missing")
                    || b.contains("session id not found")
            };

            // Final status + emit terminal event.
            if let Some(s) = sessions.lock().await.get_mut(&job_id) {
                s.status = if succeeded {
                    RunnerStatus::Completed
                } else {
                    RunnerStatus::Failed
                };
            }
            let _ = std::fs::remove_file(&mcp_path);

            if succeeded {
                let _ = tx.send(RunnerEvent::Done { exit_code: 0 }).await;
            } else if let Some(msg) = usage_limit {
                let _ = tx
                    .send(RunnerEvent::Failed {
                        error: format!("[USAGE_LIMIT] {msg}"),
                        kind: FailureKind::UsageLimit,
                    })
                    .await;
            } else if resume_failed {
                let body: String = stderr.trim().chars().take(500).collect();
                let _ = tx
                    .send(RunnerEvent::Failed {
                        error: format!("[RESUME_FAILED] {body}"),
                        kind: FailureKind::ResumeFailed,
                    })
                    .await;
            } else {
                let body = stderr.trim();
                let error = if body.is_empty() {
                    "Agent completed with errors".to_string()
                } else {
                    body.chars().take(500).collect()
                };
                let _ = tx
                    .send(RunnerEvent::Failed {
                        error,
                        kind: FailureKind::Transient,
                    })
                    .await;
            }
            sessions.lock().await.remove(&job_id);
        });

        Ok(job_id)
    }

    async fn send(&self, _session: &SessionId, _message: String) -> Result<()> {
        // Interactive follow-ups are a chat feature; pipeline jobs are one-shot.
        Err(Error::NotImplemented("ClaudeCodeRunner::send"))
    }

    async fn abort(&self, session: &SessionId) -> Result<()> {
        let mut s = self.sessions.lock().await;
        if let Some(sess) = s.get_mut(session) {
            if let Some(mut child) = sess.child.take() {
                graceful_kill(&mut child).await;
            }
            sess.status = RunnerStatus::Failed;
            Ok(())
        } else {
            Err(Error::Other("session not found".into()))
        }
    }

    fn status(&self, session: &SessionId) -> RunnerStatus {
        self.sessions
            .try_lock()
            .ok()
            .and_then(|s| s.get(session).map(|x| x.status))
            .unwrap_or(RunnerStatus::Idle)
    }
}
