//! Handle one `job.assigned`: resolve the repo, run it via the runner, and map
//! the normalized [`RunnerEvent`] stream onto core's job-event + lifecycle API.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc;

use crate::config::Config;
use crate::error::{Error, Result};
use crate::runner::claude_code::ClaudeCodeRunner;
use crate::runner::{JobSpec, Runner, RunnerEvent, ToolPhase};
use crate::transport::events::{post_job_events, JobEventInput};
use crate::transport::frames::JobAssigned;
use crate::transport::{lifecycle, CoreClient};

const FLUSH_INTERVAL: Duration = Duration::from_millis(500);

pub async fn handle(
    client: &CoreClient,
    runner: Arc<ClaudeCodeRunner>,
    cfg: &Config,
    data: Value,
) -> Result<()> {
    let ja: JobAssigned =
        serde_json::from_value(data).map_err(|e| Error::Other(format!("bad job.assigned: {e}")))?;
    let job_id = ja.job_id.clone();
    tracing::info!(
        "[job {job_id}] type={} project={}",
        ja.job_type,
        ja.project_id
    );

    // Resolve the local binding by project id.
    let Some((slug, binding)) = cfg
        .bindings
        .iter()
        .find(|(_, b)| b.project_id.as_deref() == Some(ja.project_id.as_str()))
    else {
        let msg = format!(
            "no local binding for project {} — run `forge-runner bind <slug> --path <dir> --project-id {}`",
            ja.project_id, ja.project_id
        );
        tracing::error!("[job {job_id}] {msg}");
        let _ = lifecycle::fail(client, &job_id, &msg).await;
        return Ok(());
    };

    // Only create a worktree when core explicitly hands us a feature branch
    // (e.g. code/fix stages). Triage/plan/review run in the repo root. Never
    // fall back to the binding's base branch — that branch is already checked
    // out in the main worktree, so `git worktree add` would refuse it.
    let worktree_branch = ja
        .payload
        .get("worktreeBranch")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let spec = JobSpec {
        job_id: job_id.clone(),
        project_id: ja.project_id.clone(),
        project_slug: Some(slug.clone()),
        issue_id: ja.issue_id.clone(),
        step: ja.job_type.clone(),
        repo_path: binding.repo_path.clone(),
        prompt: ja.prompt_string.clone(),
        system_prompt: ja.system_prompt.clone(),
        model: ja.model.clone(),
        allowed_tools: ja.allowed_tools.clone(),
        permission_mode: ja.permission_mode.clone(),
        timeout_seconds: ja.timeout_seconds,
        mcp_servers_override: ja.mcp_servers_override.clone(),
        worktree_branch,
        resume_id: ja.claude_session_id.clone(),
        agent_session_id: ja.agent_session_id.clone(),
    };

    let (tx, rx) = mpsc::channel::<RunnerEvent>(200);
    if let Err(e) = runner.start(spec, tx).await {
        let msg = format!("failed to start job: {e}");
        tracing::error!("[job {job_id}] {msg}");
        let _ = lifecycle::fail(client, &job_id, &msg).await;
        return Ok(());
    }

    consume(client, &job_id, rx).await;
    Ok(())
}

/// Drain runner events, batching job events and posting on a 500ms cadence,
/// then call complete/fail on the terminal event.
async fn consume(client: &CoreClient, job_id: &str, mut rx: mpsc::Receiver<RunnerEvent>) {
    let mut buf: Vec<JobEventInput> = Vec::new();
    let mut flush = tokio::time::interval(FLUSH_INTERVAL);
    flush.tick().await;

    enum Terminal {
        Done(i32),
        Failed(String),
    }
    let mut terminal: Option<Terminal> = None;

    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Some(RunnerEvent::Done { exit_code }) => { terminal = Some(Terminal::Done(exit_code)); break; }
                Some(RunnerEvent::Failed { error, .. }) => { terminal = Some(Terminal::Failed(error)); break; }
                Some(ev) => { if let Some(e) = map_event(ev) { buf.push(e); } }
                None => break,
            },
            _ = flush.tick() => {
                if !buf.is_empty() {
                    let batch = std::mem::take(&mut buf);
                    if let Err(e) = post_job_events(client, job_id, &batch).await {
                        tracing::warn!("[job {job_id}] post events: {e}");
                    }
                }
            }
        }
    }

    if !buf.is_empty() {
        if let Err(e) = post_job_events(client, job_id, &buf).await {
            tracing::warn!("[job {job_id}] final post events: {e}");
        }
    }

    match terminal {
        Some(Terminal::Done(code)) => {
            if let Err(e) = lifecycle::complete(client, job_id, code, None).await {
                tracing::warn!("[job {job_id}] complete: {e}");
            } else {
                tracing::info!("[job {job_id}] done");
            }
        }
        Some(Terminal::Failed(err)) => {
            if let Err(e) = lifecycle::fail(client, job_id, &err).await {
                tracing::warn!("[job {job_id}] fail: {e}");
            } else {
                tracing::info!("[job {job_id}] failed: {err}");
            }
        }
        None => {
            // Channel closed with no terminal event — treat as failure.
            let _ = lifecycle::fail(client, job_id, "runner ended without a result").await;
        }
    }
}

fn map_event(ev: RunnerEvent) -> Option<JobEventInput> {
    match ev {
        RunnerEvent::Stdout(json) => Some(JobEventInput::new(
            "stdout",
            serde_json::json!({ "line": json }),
        )),
        RunnerEvent::Tool { name, phase } => {
            let kind = match phase {
                ToolPhase::Call => "tool_call",
                ToolPhase::Result => "tool_result",
            };
            Some(JobEventInput::new(
                kind,
                serde_json::json!({ "name": name }),
            ))
        }
        RunnerEvent::Usage {
            input,
            output,
            cache_read,
            cache_write,
        } => Some(JobEventInput::new(
            "progress",
            serde_json::json!({ "usage": {
                "input": input, "output": output,
                "cacheRead": cache_read, "cacheWrite": cache_write
            }}),
        )),
        RunnerEvent::ClaudeSessionId(sid) => Some(JobEventInput::new(
            "progress",
            serde_json::json!({ "claudeSessionId": sid }),
        )),
        RunnerEvent::Done { .. } | RunnerEvent::Failed { .. } => None,
    }
}
