//! Handle one `job.assigned`: resolve the repo, run it via the runner, and map
//! the normalized [`RunnerEvent`] stream onto core's job-event + lifecycle API.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc;

use crate::config::Config;
use crate::daemon::preflight;
use crate::error::{Error, Result};
use crate::runner::claude_code::ClaudeCodeRunner;
use crate::runner::{JobSpec, Runner, RunnerEvent, ToolPhase};
use crate::transport::events::{post_job_events, JobEventInput};
use crate::transport::frames::JobAssigned;
use crate::transport::runners::{self, MeRunner};
use crate::transport::{lifecycle, CoreClient};
use crate::workspace::skill_sync;

/// Resolved working dir for one assigned project. The server (`/me/runners`)
/// is the source of truth for `repo_path`; `config.toml` is only a local
/// fallback/cache when the server has no path set yet (ISS-271).
#[derive(Debug)]
pub(crate) struct Resolved {
    pub slug: String,
    pub repo_path: PathBuf,
}

/// Merge server assignments with local config bindings for one project id.
/// Returns `Ok(None)` when the project is assigned but has no usable path on
/// either side (caller emits a `bind` hint), and `Err` only never (kept simple).
pub(crate) fn resolve_repo(
    server: &[MeRunner],
    cfg: &Config,
    project_id: &str,
) -> std::result::Result<Resolved, String> {
    let server_match = server.iter().find(|r| r.project_id == project_id);
    let config_match = cfg
        .bindings
        .iter()
        .find(|(_, b)| b.project_id.as_deref() == Some(project_id));

    // Slug: prefer the server's authoritative slug, else the local config key.
    let slug = server_match
        .map(|r| r.slug.clone())
        .or_else(|| config_match.map(|(slug, _)| slug.clone()))
        .unwrap_or_else(|| project_id.to_string());

    // Repo path: server first (non-empty), then local config binding.
    let server_path = server_match
        .and_then(|r| r.repo_path.as_deref())
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);
    let repo_path = server_path.or_else(|| config_match.map(|(_, b)| b.repo_path.clone()));

    match repo_path {
        Some(repo_path) => Ok(Resolved { slug, repo_path }),
        None => Err(slug),
    }
}

const FLUSH_INTERVAL: Duration = Duration::from_millis(500);
/// Cadence for the per-job session heartbeat. A `POST /api/jobs/:id/events`
/// bumps `agent_sessions.lastHeartbeatAt` server-side, so emitting a tiny
/// `progress` event while the agent is silent keeps the session alive. 25s is
/// comfortably under the server's 180s session stale threshold
/// (`PIPELINE_HEARTBEAT_TIMEOUT_MS`, min 30s) and matches desktop parity
/// (`packages/dev/src/hooks/use-web-socket.ts`). See ISS-285.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(25);

/// Handle a server-pushed `skill.sync` command: resolve the project's repo on
/// this device and seed `<repo>/.claude/skills/<name>/` from the effective
/// manifest, reporting installed hashes back. This is the ONLY path that pulls
/// skills to a CLI runner — it never runs automatically at job start (that was
/// removed in 53d4ad94 because it clobbered project-local overrides). A push is
/// always operator-initiated (web Sync action or `forge_skills.push`).
pub async fn handle_skill_sync(client: &CoreClient, cfg: &Config, data: Value) -> Result<()> {
    let project_id = data
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Other("skill.sync: missing projectId".into()))?
        .to_string();

    let server = runners::list_me(client).await.unwrap_or_default();
    let resolved = match resolve_repo(&server, cfg, &project_id) {
        Ok(r) => r,
        Err(slug) => {
            tracing::warn!(
                "[skill.sync] project '{slug}' is assigned here but has no repo path — skipping"
            );
            return Ok(());
        }
    };

    match skill_sync::sync_skills(client, &project_id, &resolved.repo_path).await {
        Ok(n) => tracing::info!(
            "[skill.sync] project={project_id} synced {n} skill(s) into {}",
            resolved.repo_path.join(".claude/skills").display()
        ),
        Err(e) => tracing::warn!("[skill.sync] project={project_id} sync failed: {e}"),
    }
    Ok(())
}

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

    // Resolve the working dir. The server (`/me/runners`) is the source of
    // truth for the repo path; the local config.toml binding is only a
    // fallback when the server has no path yet. Fetch per-dispatch so a
    // freshly web-set path is picked up without a daemon restart (ISS-271).
    let server = match runners::list_me(client).await {
        Ok(rows) => rows,
        Err(e) => {
            // Stay functional on a transient/old-server failure: fall back to
            // the local config bindings only.
            tracing::warn!("[job {job_id}] /me/runners unavailable ({e}) — using local config");
            Vec::new()
        }
    };

    let resolved = match resolve_repo(&server, cfg, &ja.project_id) {
        Ok(r) => r,
        Err(slug) => {
            let msg = format!(
                "project '{slug}' is assigned to this device but has no repo path — run `forge-runner bind {slug} --path <dir>`"
            );
            tracing::error!("[job {job_id}] {msg}");
            let _ = lifecycle::fail(client, &job_id, &msg).await;
            return Ok(());
        }
    };
    let slug = resolved.slug;

    // ISS-451 (ISS-442 C5, invariant I6): fail fast BEFORE claiming the job
    // when the repo / push credentials / hooks are broken, instead of a
    // 40-minute mid-run discovery. The `preflight_failed` prefix is
    // load-bearing — core's classifier maps it to failureKind=infra for fast
    // device failover.
    if let Err(err) = preflight::preflight(&resolved.repo_path).await {
        let msg = format!("preflight_failed: {err}");
        tracing::error!("[job {job_id}] {msg}");
        let _ = lifecycle::fail(client, &job_id, &msg).await;
        return Ok(());
    }

    // ISS-449 (Decision B): explicit claim ack once preflight passes.
    // Best-effort — the server falls back to treating the first job_event as
    // the ack, so an ack failure must never abort the job.
    if let Err(e) = lifecycle::ack(client, &job_id).await {
        tracing::warn!("[job {job_id}] ack: {e}");
    }

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
        repo_path: resolved.repo_path.clone(),
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

    // Independent per-job session heartbeat (ISS-285). Posts a tiny `progress`
    // event every 25s only when no real batch was posted in the window, so the
    // server keeps `lastHeartbeatAt` fresh through long silent steps (docker
    // build / E2E) without false `heartbeat_timeout`, yet active jobs emit no
    // extra rows.
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    // Skip (don't burst-catch-up) missed ticks: if a slow `post_job_events`
    // retry/backoff stalls the loop past a tick, fire once on the next tick
    // rather than back-to-back. The heartbeat only needs to land within the
    // 180s window, not recover every elapsed interval.
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    heartbeat.tick().await;
    let mut posted_since_beat = false;

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
                    } else {
                        posted_since_beat = true;
                    }
                }
            }
            _ = heartbeat.tick() => {
                if !posted_since_beat {
                    let beat = [JobEventInput::new("progress", serde_json::json!({ "heartbeat": true }))];
                    if let Err(e) = post_job_events(client, job_id, &beat).await {
                        tracing::debug!("[job {job_id}] heartbeat: {e}");
                    }
                }
                posted_since_beat = false;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Binding;

    fn me(project_id: &str, slug: &str, repo_path: Option<&str>) -> MeRunner {
        MeRunner {
            project_id: project_id.into(),
            runner_id: "run-1".into(),
            slug: slug.into(),
            base_branch: Some("main".into()),
            repo_path: repo_path.map(str::to_string),
            branch: None,
            status: "online".into(),
        }
    }

    fn cfg_with_binding(slug: &str, project_id: Option<&str>, repo_path: &str) -> Config {
        let mut cfg = Config::default();
        cfg.bindings.insert(
            slug.into(),
            Binding {
                repo_path: PathBuf::from(repo_path),
                branch: None,
                project_id: project_id.map(str::to_string),
            },
        );
        cfg
    }

    #[test]
    fn prefers_server_path_over_config() {
        let server = vec![me("p-1", "app", Some("/srv/app"))];
        let cfg = cfg_with_binding("app", Some("p-1"), "/local/app");
        let r = resolve_repo(&server, &cfg, "p-1").expect("resolves");
        assert_eq!(r.repo_path, PathBuf::from("/srv/app"));
        assert_eq!(r.slug, "app");
    }

    #[test]
    fn falls_back_to_config_when_server_path_empty() {
        let server = vec![me("p-1", "app", Some("   "))];
        let cfg = cfg_with_binding("app", Some("p-1"), "/local/app");
        let r = resolve_repo(&server, &cfg, "p-1").expect("resolves");
        assert_eq!(r.repo_path, PathBuf::from("/local/app"));
    }

    #[test]
    fn falls_back_to_config_when_not_on_server() {
        let server = vec![];
        let cfg = cfg_with_binding("app", Some("p-1"), "/local/app");
        let r = resolve_repo(&server, &cfg, "p-1").expect("resolves");
        assert_eq!(r.repo_path, PathBuf::from("/local/app"));
    }

    #[test]
    fn errs_with_slug_when_no_path_anywhere() {
        let server = vec![me("p-1", "app", None)];
        let cfg = Config::default();
        let err = resolve_repo(&server, &cfg, "p-1").unwrap_err();
        assert_eq!(err, "app");
    }
}
