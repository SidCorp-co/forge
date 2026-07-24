//! Claude Code runner — wraps the `claude` CLI behind the [`Runner`] trait.
//! Ported from the Tauri app's `claude_cli/{spawn,agent,mcp}.rs`, emitting
//! [`RunnerEvent`] on a channel instead of Tauri events.
//!
//! Session key = the core `jobId`, so `abort(job_id)` maps a `job.cancel`
//! frame straight onto the right process.

use std::collections::HashMap;
use std::process::ExitStatus;
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
use crate::workspace::worktree;

struct Session {
    status: RunnerStatus,
    child: Option<tokio::process::Child>,
    claude_session_id: Option<String>,
}

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

/// Grace period after the definitive `{type:result}` marker for the CLI to
/// exit on its own before we kill it + report terminal. Guards the
/// hang-after-result bug (anthropics/claude-code#25629).
const RESULT_EXIT_GRACE: Duration = Duration::from_secs(5);

/// Signals captured from the claude stream + process exit, written
/// incrementally by the reader/completion tasks so they survive a reader abort
/// and let us emit a precise, diagnosable failure reason.
#[derive(Default)]
struct Outcome {
    /// `Some(true/false)` once a `{type:result}` event arrived (`!is_error`).
    succeeded: Option<bool>,
    /// Usage-limit message, if detected mid-stream.
    usage_limit: Option<String>,
    /// True once a `{type:result}` event was seen (the definitive done marker).
    result_seen: bool,
    /// Error detail from a `{type:result}` with `is_error=true`.
    result_error: Option<String>,
    /// `num_turns` from the `{type:result}` event. `Some(0)` on an
    /// `is_error=false` result means the CLI produced ZERO turns — the model
    /// was never invoked (e.g. `Unknown command: /forge-plan` when the skill
    /// is not installed on this device). For a pipeline job that is a no-op,
    /// not a success (ISS-626).
    num_turns: Option<i64>,
    /// The `result` text of the terminal event (used to surface WHY a no-op
    /// result had zero turns — carries the "Unknown command …" line).
    result_text: Option<String>,
    /// MCP servers that did NOT reach a connected status at `system/init`.
    mcp_failed: Vec<String>,
    /// Captured child exit status (carries exit code / terminating signal).
    exit: Option<ExitStatus>,
}

/// Split an [`ExitStatus`] into `(exit_code, terminating_signal)`.
#[cfg(unix)]
fn split_exit(status: &ExitStatus) -> (Option<i32>, Option<i32>) {
    use std::os::unix::process::ExitStatusExt;
    (status.code(), status.signal())
}

#[cfg(not(unix))]
fn split_exit(status: &ExitStatus) -> (Option<i32>, Option<i32>) {
    (status.code(), None)
}

/// From a `{type:result}` event with `is_error=true`, extract a short detail
/// string (`subtype: message`).
fn result_error_detail(json: &Value) -> String {
    let subtype = json
        .get("subtype")
        .and_then(Value::as_str)
        .unwrap_or("error");
    let msg = json
        .get("result")
        .and_then(Value::as_str)
        .or_else(|| json.get("error").and_then(Value::as_str))
        .unwrap_or("");
    let msg: String = msg.chars().take(300).collect();
    if msg.is_empty() {
        subtype.to_string()
    } else {
        format!("{subtype}: {msg}")
    }
}

/// `pending` / `connecting` are TRANSIENT: Claude Code emits the `system/init`
/// event before HTTP/stdio servers finish their handshake, and (per the docs)
/// "if your request needs tools from a server that is still connecting in the
/// background, Claude waits for that server before continuing." A server that
/// genuinely can't connect is reported as `failed` (after up to 3 retries) or
/// `needs-auth` — NOT left `pending`. So the init snapshot must not treat a
/// still-connecting server as a failure (that was the chat MCP_INIT race:
/// `forge(pending), chrome-devtools-mcp(pending)`).
fn is_transient_mcp_status(status: &str) -> bool {
    let s = status.trim();
    s.eq_ignore_ascii_case("pending")
        || s.eq_ignore_ascii_case("connecting")
        || s.eq_ignore_ascii_case("needs-restart")
}

/// From a `system`/`init` stream event, return the MCP servers that TERMINALLY
/// failed to connect (`name(status)`) — `failed` / `needs-auth` / etc., but NOT
/// transient `pending`/`connecting` (see [`is_transient_mcp_status`]). `None` if
/// `json` is not a system event carrying `mcp_servers` (so the caller keeps
/// looking); an empty vec means no server is terminally failed.
fn mcp_failed_servers(json: &Value) -> Option<Vec<String>> {
    if json.get("type").and_then(Value::as_str) != Some("system") {
        return None;
    }
    let servers = json.get("mcp_servers").and_then(Value::as_array)?;
    let failed = servers
        .iter()
        .filter_map(|s| {
            let name = s.get("name").and_then(Value::as_str)?;
            let status = s.get("status").and_then(Value::as_str).unwrap_or("");
            // Connected → fine. Still-connecting → transient, ignore. Anything
            // else (failed / needs-auth / empty) → a real not-connected failure.
            if status.eq_ignore_ascii_case("connected") || is_transient_mcp_status(status) {
                None
            } else {
                Some(format!("{name}({status})"))
            }
        })
        .collect::<Vec<_>>();
    Some(failed)
}

/// Build a precise, diagnosable failure reason for an abnormal claude exit.
/// Pure + unit-tested. Returns a bracketed token (matched by core's
/// `failure-classifier`) plus human-readable detail. Only called on the
/// non-usage-limit / non-resume-failed failure path.
fn classify_failure_reason(
    exit_code: Option<i32>,
    signal: Option<i32>,
    result_seen: bool,
    result_error: Option<&str>,
    mcp_failed: &[String],
    stderr: &str,
) -> String {
    let stderr = stderr.trim();
    let tail = || -> String { stderr.chars().take(400).collect() };

    // 1. A result event that reported is_error — most precise.
    if let Some(msg) = result_error {
        let msg: String = msg.chars().take(400).collect();
        return format!("[RESULT_ERROR] {msg}");
    }
    // 2. MCP server(s) failed to connect at startup — environment/infra.
    if !mcp_failed.is_empty() {
        let servers = mcp_failed.join(", ");
        let extra = if stderr.is_empty() {
            String::new()
        } else {
            format!(" — {}", tail())
        };
        return format!("[MCP_INIT_FAILED] {servers} did not connect at startup{extra}");
    }
    // 3. Killed by a signal (SIGKILL/OOM, SIGTERM, …).
    if let Some(sig) = signal {
        let extra = if stderr.is_empty() {
            String::new()
        } else {
            format!(" — {}", tail())
        };
        return format!("[SIGNAL_KILLED] signal={sig}{extra}");
    }
    // 4. Non-empty stderr (none of the above) — pass the raw CLI text through
    //    so core's existing patterns (invalid_request / 5xx / 429 / …) can
    //    still match a real provider error.
    if !stderr.is_empty() {
        return tail();
    }
    // 5. No result event — the CLI exited before producing a result
    //    (cc-startup-death class).
    if !result_seen {
        return match exit_code {
            Some(0) => {
                "[NO_RESULT_CLEAN_EXIT] claude exited 0 before emitting a result event".to_string()
            }
            Some(code) => format!("[NO_RESULT_EXIT] exitCode={code}, no result event"),
            None => "[NO_RESULT_EXIT] no exit code, no result event".to_string(),
        };
    }
    // 6. Degenerate fallback (result seen, not is_error, yet not succeeded).
    "[NO_RESULT_EXIT] terminal with no success signal".to_string()
}

/// Is the required `forge` MCP server among the ones that TERMINALLY failed to
/// connect at init? (`mcp_failed` already excludes transient `pending` — see
/// [`mcp_failed_servers`].) Every pipeline step requires forge tools
/// (`forge_issues.*` etc.) to read the issue and advance its status. A job that
/// ran without them can only emit pseudocode — it must FAIL (not Done) so core
/// routes it through bounded auto-retry instead of leaving the issue unchanged
/// and letting the reconciler re-dispatch forever (ISS-570 / ISS-563 loop).
///
/// Scope is intentionally narrow: only servers whose name starts with `forge(`
/// are considered required. Override servers (playwright, postman, …) are
/// opt-in per state and may legitimately be absent without invalidating the job.
fn required_mcp_down(mcp_failed: &[String]) -> bool {
    mcp_failed.iter().any(|s| s.starts_with("forge("))
}

/// Whether a missing `forge` MCP server should be treated as FATAL for this run.
///
/// ISS-570's hard-fail exists to stop the *reconciler re-dispatch loop*: an
/// issue pipeline job that ran without forge tools can only emit pseudocode,
/// leaves its issue unchanged, and the reconciler re-dispatches it forever.
/// That loop is impossible without an issue behind the run, so the hard-fail is
/// scoped to issue-bound pipeline jobs (`issue_id = Some`).
///
/// Interactive runs — chat (`daemon/chat.rs` sets `step="chat"`, `issue_id=None`)
/// and schedule ticks — have no reconciler driving them. A transient `pending`
/// at the single init snapshot must NOT nuke them; at worst they answer the turn
/// without forge tools instead of failing the whole session and wedging a slot.
/// (For issue jobs that hit the same transient race, the failure is emitted as
/// `FailureKind::Transient`, so core's bounded auto-retry self-heals it.)
fn mcp_failure_is_fatal(is_issue_job: bool, mcp_failed: &[String]) -> bool {
    is_issue_job && required_mcp_down(mcp_failed)
}

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
        // Emit partial-message + subagent stream events so a quiet-but-busy
        // fan-out session keeps producing stdout (liveness) and the runner
        // sees every event (ISS-479).
        "--include-partial-messages".into(),
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
    // Capability denylist (ISS-531). `--disallowed-tools` removes a tool from
    // the available SET even under `--permission-mode bypassPermissions`
    // (verified on claude v2.1.185), so it is a real least-agency hard-deny,
    // not just an auto-approval gate.
    if let Some(tools) = spec.disallowed_tools.as_deref().filter(|s| !s.is_empty()) {
        args.push("--disallowed-tools".into());
        args.push(tools.into());
    }
    if let Some(model) = spec.model.as_deref().filter(|s| !s.is_empty()) {
        args.push("--model".into());
        args.push(model.into());
    }
    args.push("--mcp-config".into());
    args.push(mcp_path.into());
    // The temp `--mcp-config` is authoritative for a job run. `--strict-mcp-config`
    // makes Claude ignore the working-dir `.mcp.json` instead of merging it — so a
    // provisioned repo's persistent `.mcp.json` (which also defines a `forge`
    // server, for interactive use) never double-loads on top of this fresh-token
    // temp config. See docs / ISS-466 follow-up.
    args.push("--strict-mcp-config".into());
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

        // No skill seeding at job start: the job consumes whatever is already
        // in `<worktree>/.claude/skills/`, delivered ahead of time by the disk
        // sync channel (`workspace::skill_sync`, driven by provision / the
        // `skill.sync` event / background auto-pull), plus any device-scope
        // plugin skills inherited from the config dir. A job-start re-seed was
        // removed because it clobbered project-shadowed skills mid-flight.

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
        // ISS-570 hard-fail on a down `forge` server is scoped to reconciler-driven
        // issue jobs (see mcp_failure_is_fatal). Chat / schedule runs carry no
        // issue_id and must not be nuked by a transient `pending` at init.
        let is_issue_job = spec.issue_id.is_some();
        let timeout = spec
            .timeout_seconds
            .filter(|s| *s > 0)
            .map(Duration::from_secs);

        let mut cmd = build_command(&args, &effective_repo);
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // Give MCP servers room to connect before the `system/init` snapshot.
        // Heavy stdio servers (e.g. chrome-devtools-mcp / playwright launched via
        // `npx`, which fetch a package + spawn a browser) routinely need >5s; the
        // claude default is tight. Caller-set env wins (don't clobber an override).
        if std::env::var_os("MCP_TIMEOUT").is_none() {
            cmd.env("MCP_TIMEOUT", "15000");
        }

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
        let outcome: Arc<Mutex<Outcome>> = Arc::new(Mutex::new(Outcome::default()));

        // Notified once when the reader sees the definitive `{type:result}`
        // marker, so the completion task can report terminal immediately
        // (ISS-479 terminal-on-result) instead of inferring it from silence.
        let result_notify = Arc::new(tokio::sync::Notify::new());

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
            let result_notify = result_notify.clone();
            let job_id = job_id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                let mut got_sid = false;
                let mut got_limit = false;
                let mut got_init = false;
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
                    if !got_init {
                        if let Some(failed) = mcp_failed_servers(&json) {
                            got_init = true;
                            if failed.is_empty() {
                                tracing::debug!("[claude] job={job_id} all MCP servers connected");
                            } else {
                                tracing::warn!(
                                    "[claude] job={job_id} MCP servers not connected: {failed:?}"
                                );
                                outcome.lock().await.mcp_failed = failed;
                            }
                        }
                    }
                    if !got_limit {
                        if let Some(msg) = detect_usage_limit(&json) {
                            outcome.lock().await.usage_limit = Some(msg);
                            got_limit = true;
                        }
                    }
                    if json.get("type").and_then(Value::as_str) == Some("result") {
                        let is_error = json
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(true);
                        {
                            let mut o = outcome.lock().await;
                            o.succeeded = Some(!is_error);
                            o.result_seen = true;
                            o.num_turns = json.get("num_turns").and_then(Value::as_i64);
                            o.result_text = json
                                .get("result")
                                .and_then(Value::as_str)
                                .map(|s| s.chars().take(300).collect());
                            if is_error {
                                o.result_error = Some(result_error_detail(&json));
                            }
                        }
                        // Definitive done marker — wake the completion task.
                        result_notify.notify_one();
                    }
                    if tx.send(RunnerEvent::Stdout(json)).await.is_err() {
                        break;
                    }
                }
            })
        };

        // Completion task: race reader-EOF vs child-exit (MCP grandchildren can
        // hold the pipe open) vs the definitive `{type:result}` marker, then
        // reap, classify, and emit Done/Failed.
        let sessions = self.sessions.clone();
        let job_id_task = job_id.clone();
        tokio::spawn(async move {
            let job_id = job_id_task;
            let mut reader = reader;
            let exit_poll = {
                let sessions = sessions.clone();
                let outcome = outcome.clone();
                let job_id = job_id.clone();
                async move {
                    loop {
                        // Snapshot try_wait WITHOUT holding the sessions lock
                        // across the outcome lock (avoids a lock-order cycle).
                        let polled = {
                            let mut s = sessions.lock().await;
                            match s.get_mut(&job_id).and_then(|x| x.child.as_mut()) {
                                Some(child) => match child.try_wait() {
                                    Ok(Some(status)) => Some(Some(status)), // exited
                                    Err(_) => Some(None),                   // give up
                                    Ok(None) => None,                       // still running
                                },
                                None => Some(None),
                            }
                        };
                        match polled {
                            Some(Some(status)) => {
                                outcome.lock().await.exit = Some(status);
                                break;
                            }
                            Some(None) => break,
                            None => {}
                        }
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                }
            };

            let on_result = {
                let result_notify = result_notify.clone();
                async move { result_notify.notified().await }
            };

            match timeout {
                Some(d) => tokio::select! {
                    _ = &mut reader => {}
                    _ = exit_poll => { let _ = tokio::time::timeout(Duration::from_secs(2), &mut reader).await; }
                    _ = on_result => { let _ = tokio::time::timeout(RESULT_EXIT_GRACE, &mut reader).await; }
                    _ = tokio::time::sleep(d) => { tracing::warn!("[claude] job={job_id} timed out"); }
                },
                None => tokio::select! {
                    _ = &mut reader => {}
                    _ = exit_poll => { let _ = tokio::time::timeout(Duration::from_secs(2), &mut reader).await; }
                    _ = on_result => { let _ = tokio::time::timeout(RESULT_EXIT_GRACE, &mut reader).await; }
                },
            }
            reader.abort();

            // Reap the child + group, capturing its exit status if the
            // exit-poll branch didn't already.
            let killed_exit = if let Some(s) = sessions.lock().await.get_mut(&job_id) {
                if let Some(mut child) = s.child.take() {
                    graceful_kill(&mut child).await
                } else {
                    None
                }
            } else {
                None
            };

            let (
                succeeded_opt,
                usage_limit,
                result_seen,
                result_error,
                mcp_failed,
                polled_exit,
                num_turns,
                result_text,
            ) = {
                let o = outcome.lock().await;
                (
                    o.succeeded,
                    o.usage_limit.clone(),
                    o.result_seen,
                    o.result_error.clone(),
                    o.mcp_failed.clone(),
                    o.exit,
                    o.num_turns,
                    o.result_text.clone(),
                )
            };
            let outcome_exit = polled_exit.or(killed_exit);

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
            // ISS-626 — a pipeline result with ZERO turns did no work: the CLI
            // short-circuited before invoking the model (the classic case is
            // `Unknown command: /forge-<skill>` when the skill is not installed
            // on this device). The result is `is_error=false`, so without this
            // guard the job records Done and the reconciler re-dispatches the
            // no-op forever. Fail it → core routes the cc-startup signal to a
            // different-device failover (a device that HAS the skill).
            let no_work = is_issue_job && succeeded_opt == Some(true) && num_turns == Some(0);

            let succeeded = usage_limit.is_none()
                && succeeded_opt.unwrap_or(false)
                && !mcp_failure_is_fatal(is_issue_job, &mcp_failed)
                && !no_work;

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
            } else if no_work {
                // ISS-626 — zero-turn pipeline result (CLI short-circuited, e.g.
                // an unknown /forge-<skill> command). Carry the result text so
                // core's classifier routes it (an "Unknown command" line matches
                // the cc-startup patterns → transient-cc → different-device
                // failover to a runner that HAS the skill).
                let detail = result_text.unwrap_or_default();
                let _ = tx
                    .send(RunnerEvent::Failed {
                        error: format!(
                            "[NO_WORK] claude produced 0 turns — no work done (skill likely not installed on this device): {detail}"
                        ),
                        kind: FailureKind::Transient,
                    })
                    .await;
            } else {
                let (exit_code, signal) = match outcome_exit {
                    Some(ref st) => split_exit(st),
                    None => (None, None),
                };
                let error = classify_failure_reason(
                    exit_code,
                    signal,
                    result_seen,
                    result_error.as_deref(),
                    &mcp_failed,
                    &stderr,
                );
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn killed_by_signal_reports_signal_token() {
        let r = classify_failure_reason(None, Some(9), false, None, &[], "");
        assert!(r.starts_with("[SIGNAL_KILLED]"), "{r}");
        assert!(r.contains("signal=9"), "{r}");
    }

    #[test]
    fn clean_exit_without_result_is_no_result_clean_exit() {
        let r = classify_failure_reason(Some(0), None, false, None, &[], "");
        assert!(r.starts_with("[NO_RESULT_CLEAN_EXIT]"), "{r}");
    }

    #[test]
    fn nonzero_exit_without_result_is_no_result_exit() {
        let r = classify_failure_reason(Some(1), None, false, None, &[], "");
        assert!(r.starts_with("[NO_RESULT_EXIT]"), "{r}");
        assert!(r.contains("exitCode=1"), "{r}");
    }

    #[test]
    fn mcp_init_failure_reports_mcp_token() {
        let failed = vec!["forge(failed)".to_string()];
        let r = classify_failure_reason(Some(0), None, false, None, &failed, "");
        assert!(r.starts_with("[MCP_INIT_FAILED]"), "{r}");
        assert!(r.contains("forge(failed)"), "{r}");
    }

    #[test]
    fn result_error_reports_result_token() {
        let r = classify_failure_reason(
            Some(0),
            None,
            true,
            Some("error_max_turns: hit cap"),
            &[],
            "",
        );
        assert!(r.starts_with("[RESULT_ERROR]"), "{r}");
        assert!(r.contains("error_max_turns"), "{r}");
    }

    #[test]
    fn nonempty_stderr_passes_through_for_existing_pattern_match() {
        // Real provider error text should pass through untokenized so core's
        // existing classifier patterns can match it.
        let r = classify_failure_reason(
            Some(1),
            None,
            false,
            None,
            &[],
            "  invalid_request_error: bad  ",
        );
        assert_eq!(r, "invalid_request_error: bad");
    }

    #[test]
    fn signal_wins_over_stderr_passthrough() {
        let r = classify_failure_reason(None, Some(9), false, None, &[], "some noise");
        assert!(r.starts_with("[SIGNAL_KILLED]"), "{r}");
        assert!(r.contains("some noise"), "{r}");
    }

    #[test]
    fn mcp_init_parse_flags_unconnected_servers() {
        let init = json!({
            "type": "system",
            "subtype": "init",
            "mcp_servers": [
                { "name": "forge", "status": "failed" },
                { "name": "playwright", "status": "connected" }
            ]
        });
        let failed = mcp_failed_servers(&init).expect("system event");
        assert_eq!(failed, vec!["forge(failed)".to_string()]);
    }

    #[test]
    fn mcp_init_parse_ignores_transient_pending() {
        // The race we fixed: claude emits init while servers are still connecting.
        // `pending` / `connecting` are transient (claude waits for them), so they
        // must NOT be reported as failed — only a genuinely terminal status is.
        let init = json!({
            "type": "system",
            "subtype": "init",
            "mcp_servers": [
                { "name": "forge", "status": "pending" },
                { "name": "chrome-devtools-mcp", "status": "connecting" },
                { "name": "playwright", "status": "failed" }
            ]
        });
        let failed = mcp_failed_servers(&init).expect("system event");
        assert_eq!(failed, vec!["playwright(failed)".to_string()]);
    }

    #[test]
    fn mcp_init_parse_all_connected_is_empty() {
        let init = json!({
            "type": "system",
            "subtype": "init",
            "mcp_servers": [ { "name": "forge", "status": "connected" } ]
        });
        assert_eq!(mcp_failed_servers(&init), Some(vec![]));
    }

    #[test]
    fn non_system_event_is_ignored_by_mcp_parse() {
        let assistant = json!({ "type": "assistant", "message": {} });
        assert_eq!(mcp_failed_servers(&assistant), None);
    }

    #[test]
    fn transient_statuses_classified() {
        assert!(is_transient_mcp_status("pending"));
        assert!(is_transient_mcp_status("Connecting"));
        assert!(is_transient_mcp_status(" needs-restart "));
        assert!(!is_transient_mcp_status("failed"));
        assert!(!is_transient_mcp_status("needs-auth"));
        assert!(!is_transient_mcp_status("connected"));
    }

    // required_mcp_down — ISS-570 (mcp_failed only ever holds TERMINAL statuses;
    // pending is filtered upstream by mcp_failed_servers).
    #[test]
    fn required_mcp_down_forge_failed_is_true() {
        assert!(required_mcp_down(&["forge(failed)".to_string()]));
    }

    #[test]
    fn required_mcp_down_non_forge_server_is_false() {
        assert!(!required_mcp_down(&["playwright(failed)".to_string()]));
    }

    #[test]
    fn required_mcp_down_empty_is_false() {
        assert!(!required_mcp_down(&[]));
    }

    #[test]
    fn required_mcp_down_mixed_forge_and_non_forge_is_true() {
        let failed = vec![
            "playwright(failed)".to_string(),
            "forge(failed)".to_string(),
        ];
        assert!(required_mcp_down(&failed));
    }

    // mcp_failure_is_fatal — scope the ISS-570 hard-fail to issue jobs only.
    // (mcp_failed only ever holds TERMINAL statuses; pending never reaches here.)
    #[test]
    fn mcp_failure_fatal_for_issue_job_when_forge_down() {
        // Reconciler-driven issue job loses forge terminally → fatal (ISS-570).
        assert!(mcp_failure_is_fatal(true, &["forge(failed)".to_string()]));
        assert!(mcp_failure_is_fatal(
            true,
            &["forge(needs-auth)".to_string()]
        ));
    }

    #[test]
    fn mcp_failure_not_fatal_for_chat_even_when_forge_down() {
        // Chat / schedule (issue_id=None) must never be nuked by a down forge.
        assert!(!mcp_failure_is_fatal(false, &["forge(failed)".to_string()]));
        assert!(!mcp_failure_is_fatal(
            false,
            &[
                "forge(failed)".to_string(),
                "playwright(failed)".to_string()
            ]
        ));
    }

    #[test]
    fn mcp_failure_not_fatal_when_forge_up() {
        // Only the required `forge` server gates; a down override never is fatal.
        assert!(!mcp_failure_is_fatal(
            true,
            &["playwright(failed)".to_string()]
        ));
        assert!(!mcp_failure_is_fatal(true, &[]));
    }
}
