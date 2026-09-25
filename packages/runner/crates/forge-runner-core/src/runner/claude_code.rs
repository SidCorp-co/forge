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
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};

use super::inflight;
use super::process::{build_command, graceful_kill};
use super::{FailureKind, JobSpec, Runner, RunnerEvent, RunnerKind, RunnerStatus, SessionId};
use crate::error::{Error, Result};
use crate::mcp;

fn user_message_line(text: &str) -> String {
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    });
    format!("{msg}\n")
}

struct Session {
    status: RunnerStatus,
    child: Option<tokio::process::Child>,
    claude_session_id: Option<String>,
    /// Held open for the life of a DUPLEX session — dropping it is EOF, which
    /// is how a resident session is closed. `None` on the print path.
    stdin: Option<tokio::process::ChildStdin>,
    /// Where the CURRENT turn's events go. Swapped by [`Runner::send`].
    turn_tx: TurnTx,
    /// Raised by [`Runner::send`] so the turn loop knows the idle clock stops.
    turn_started: Arc<tokio::sync::Notify>,
    pending_inbox: Option<(String, u64)>,
    /// Completed turns, so an `applied` report can name the one that consumed
    /// the message.
    turns: u64,
    /// Raised after each turn's verdict is sent. The only signal a caller
    /// outside the turn loop has that a turn it started has finished.
    turn_done: Arc<tokio::sync::Notify>,
    /// Which door this session's state is reported by — a pipeline session is
    /// keyed by `job_id` here and cannot be PATCHed session-side.
    is_issue_job: bool,
    /// What this session was spawned with, and where its checkout stood at the
    /// last turn — the two facts a caller needs to decide whether the resident
    /// session can serve the next turn as-is.
    model: Option<String>,
    head_sha: Option<String>,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
    project_slug: Option<String>,
}

/// The current turn's event sink. Shared by the stdout reader, the completion
/// task and [`Runner::send`], because a resident process outlives any one of them.
type TurnTx = Arc<Mutex<mpsc::Sender<RunnerEvent>>>;

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

const RESULT_EXIT_GRACE: Duration = Duration::from_secs(5);

const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

fn takes_session_permit(spec: &JobSpec) -> bool {
    spec.counts_against_session_cap
}

pub const SESSION_PERMIT_WAIT: Duration = SESSION_IDLE_TIMEOUT;

async fn acquire_session_permit(
    sem: Arc<tokio::sync::Semaphore>,
    cap: usize,
    wait: Duration,
    job_id: &str,
    holders: Vec<String>,
) -> Result<tokio::sync::OwnedSemaphorePermit> {
    if let Ok(permit) = sem.clone().try_acquire_owned() {
        return Ok(permit);
    }
    tracing::warn!(
        "[job {job_id}] waiting for a session slot — all {cap} permits held by {} (parked awaiting_input sessions keep theirs until residency ends)",
        describe_holders(&holders)
    );
    match tokio::time::timeout(wait, sem.acquire_owned()).await {
        Ok(Ok(permit)) => Ok(permit),
        Ok(Err(e)) => Err(Error::Other(format!("session semaphore closed: {e}"))),
        Err(_) => Err(Error::Other(format!(
            "session_permit_saturated: all {cap} permits on this box held after {}s; holders at wait start: {}",
            wait.as_secs(),
            describe_holders(&holders)
        ))),
    }
}

fn describe_holders(holders: &[String]) -> String {
    if holders.is_empty() {
        return "no session this runner still tracks".to_string();
    }
    holders.join(", ")
}

fn resolve_residency(configured: Option<u64>) -> Duration {
    match configured {
        Some(secs) if secs > 0 => Duration::from_secs(secs),
        _ => SESSION_IDLE_TIMEOUT,
    }
}

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

impl Outcome {
    fn reset_turn(&mut self) {
        self.succeeded = None;
        self.usage_limit = None;
        self.result_seen = false;
        self.result_error = None;
        self.num_turns = None;
        self.result_text = None;
    }
}

struct TurnLoop<'a> {
    sessions: &'a Sessions,
    job_id: &'a str,
    /// Where to report `closed` when the ceiling ends a session nobody is
    /// consuming. `None` on a path with no agent-session row to report against.
    core: Option<&'a crate::transport::CoreClient>,
    outcome: &'a Arc<Mutex<Outcome>>,
    result_notify: &'a Arc<tokio::sync::Notify>,
    turn_tx: &'a TurnTx,
    turn_started: &'a Arc<tokio::sync::Notify>,
    turn_done: &'a Arc<tokio::sync::Notify>,
    is_issue_job: bool,
    residency: Duration,
}

async fn join_reader(reader: &mut tokio::task::JoinHandle<()>, within: Duration) {
    if reader.is_finished() {
        return;
    }
    let _ = tokio::time::timeout(within, reader).await;
}

async fn report_session_closed(
    is_issue_job: bool,
    turn_tx: &TurnTx,
    core: Option<&crate::transport::CoreClient>,
    job_id: &str,
) {
    if is_issue_job {
        let tx = turn_tx.lock().await;
        let _ = tx.send(RunnerEvent::StateChanged("closed")).await;
    } else if let Some(client) = core {
        crate::transport::agent_sessions::report_runtime_state(client, job_id, "closed").await;
    }
}

async fn duplex_turns(r: TurnLoop<'_>, reader: &mut tokio::task::JoinHandle<()>) -> bool {
    let TurnLoop {
        sessions,
        job_id,
        core,
        outcome,
        result_notify,
        turn_tx,
        turn_started,
        turn_done,
        is_issue_job,
        residency,
    } = r;
    let mut reported = false;
    loop {
        tokio::select! {
            _ = result_notify.notified() => {
                let ev = {
                    let mut o = outcome.lock().await;
                    let ev = turn_verdict(&o, is_issue_job);
                    o.reset_turn();
                    ev
                };
                let consumed = {
                    let mut map = sessions.lock().await;
                    map.get_mut(job_id).and_then(|s| {
                        s.turns += 1;
                        let turn = s.turns;
                        s.pending_inbox.take().map(|(sid, seq)| (sid, seq, turn))
                    })
                };
                if let (Some((sid, seq, turn)), Some(client)) = (consumed, core) {
                    crate::transport::inbox::applied(client, &sid, seq, turn).await;
                }
                let job_ended = match (is_issue_job, core) {
                    (true, Some(client)) => {
                        crate::transport::lifecycle::turn_is_job_end(client, job_id).await
                    }
                    _ => true,
                };
                {
                    let tx = turn_tx.lock().await;
                    let _ = tx.send(RunnerEvent::StateChanged("awaiting_input")).await;
                    if job_ended {
                        let _ = tx.send(ev).await;
                    }
                }
                turn_done.notify_waiters();
                reported = job_ended;
                if is_issue_job && job_ended {
                    if let Some(s) = sessions.lock().await.get_mut(job_id) {
                        s.stdin = None;
                    }
                    return reported;
                }
            }
            _ = &mut *reader => return reported,
        }
        tokio::select! {
            _ = turn_started.notified() => {}
            _ = &mut *reader => return reported,
            _ = tokio::time::sleep(residency) => {
                tracing::info!("[claude] job={job_id} idle past the session ceiling — closing");
                report_session_closed(is_issue_job, turn_tx, core, job_id).await;
                if let Some(s) = sessions.lock().await.get_mut(job_id) {
                    s.stdin = None;
                }
                return reported;
            }
        }
    }
}

fn turn_verdict(o: &Outcome, is_issue_job: bool) -> RunnerEvent {
    if let Some(msg) = o.usage_limit.clone() {
        return RunnerEvent::Failed {
            error: format!("[USAGE_LIMIT] {msg}"),
            kind: FailureKind::UsageLimit,
        };
    }
    if is_issue_job && o.succeeded == Some(true) && o.num_turns == Some(0) {
        let detail = o.result_text.clone().unwrap_or_default();
        return RunnerEvent::Failed {
            error: format!(
                "[NO_WORK] claude produced 0 turns — no work done (skill likely not installed on this device): {detail}"
            ),
            kind: FailureKind::Transient,
        };
    }
    if o.succeeded == Some(true) {
        return RunnerEvent::Done { exit_code: 0 };
    }
    RunnerEvent::Failed {
        error: o
            .result_error
            .clone()
            .map(|e| format!("[RESULT_ERROR] {e}"))
            .unwrap_or_else(|| "[NO_RESULT] the turn ended without a result event".into()),
        kind: FailureKind::Transient,
    }
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
    session_sem: Arc<tokio::sync::Semaphore>,
    session_cap: usize,
    pending_permits: Arc<std::sync::Mutex<HashMap<String, String>>>,
}

/// A permit taken but not yet visible as a `Session`, kept countable meanwhile.
///
/// Registers on construction and deregisters on `Drop`, so every early return
/// between the permit and the session row — a failed MCP config write, a spawn
/// that never happens — clears the entry without a cleanup path of its own.
struct PendingPermit {
    map: Arc<std::sync::Mutex<HashMap<String, String>>>,
    job_id: String,
}

impl PendingPermit {
    fn register(
        map: &Arc<std::sync::Mutex<HashMap<String, String>>>,
        job_id: &str,
        slug: Option<&str>,
    ) -> Self {
        if let Ok(mut m) = map.lock() {
            m.insert(job_id.to_string(), slug.unwrap_or("?").to_string());
        }
        Self {
            map: map.clone(),
            job_id: job_id.to_string(),
        }
    }
}

impl Drop for PendingPermit {
    fn drop(&mut self) {
        if let Ok(mut m) = self.map.lock() {
            m.remove(&self.job_id);
        }
    }
}

impl ClaudeCodeRunner {
    pub fn new(
        core_url: impl Into<String>,
        device_token: impl Into<String>,
        session_cap: usize,
    ) -> Self {
        Self {
            core_url: core_url.into(),
            device_token: device_token.into(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            session_sem: Arc::new(tokio::sync::Semaphore::new(session_cap.max(1))),
            session_cap: session_cap.max(1),
            pending_permits: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Project slugs of everything currently holding a duplex permit.
    ///
    /// One project's claims can exhaust a box-level ceiling that another
    /// project's jobs then fail on, and neither side can see the other from its
    /// own records (ISS-920 B4). This is what puts the holders in the loser's
    /// failure text.
    async fn permit_holders(&self) -> Vec<String> {
        let mut slugs: Vec<String> = {
            let map = self.sessions.lock().await;
            map.values()
                .filter(|s| s.permit.is_some())
                .map(|s| s.project_slug.clone().unwrap_or_else(|| "?".to_string()))
                .collect()
        };
        if let Ok(pending) = self.pending_permits.lock() {
            slugs.extend(pending.values().cloned());
        }
        slugs.sort();
        slugs
    }
}

/// What a live duplex session was spawned with. `None` means no live session.
pub struct Resident {
    pub model: Option<String>,
    /// `head_sha` recorded at the last turn, or `None` if none was recorded.
    pub head_sha: Option<String>,
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
    args.push("--input-format".into());
    args.push("stream-json".into());
    args.push("--replay-user-messages".into());
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

impl ClaudeCodeRunner {
    /// What the live duplex session for `id` was spawned with, if there is one.
    pub async fn resident(&self, id: &SessionId) -> Option<Resident> {
        let map = self.sessions.lock().await;
        let s = map.get(id)?;
        s.stdin.as_ref()?;
        Some(Resident {
            model: s.model.clone(),
            head_sha: s.head_sha.clone(),
        })
    }

    pub async fn send_resident(
        &self,
        id: &SessionId,
        message: &str,
        pending: Option<(String, u64)>,
    ) -> Result<()> {
        let turn_tx = {
            let mut map = self.sessions.lock().await;
            let sess = map
                .get_mut(id)
                .ok_or_else(|| Error::Other("session not found".into()))?;
            if sess.stdin.is_none() {
                return Err(Error::Other("session is not resident".into()));
            }
            sess.pending_inbox = pending;
            sess.turn_tx.clone()
        };
        let tx = turn_tx.lock().await.clone();
        Runner::send(self, id, message.to_string(), tx).await
    }

    /// Record the checkout the session has just been told about.
    pub async fn note_head(&self, id: &SessionId, head_sha: Option<String>) {
        if let Some(s) = self.sessions.lock().await.get_mut(id) {
            s.head_sha = head_sha;
        }
    }

    /// End a live session between turns: EOF on stdin, then let the completion
    /// task reap. Used when the next turn cannot reuse it (a model change).
    pub async fn close(&self, id: &SessionId) {
        if let Some(s) = self.sessions.lock().await.get_mut(id) {
            s.stdin = None;
        }
    }

    pub const CHECKPOINT_PROMPT: &'static str = "Write down where you are before this session ends: \
        what you have changed so far, what you were about to do next, and anything you know that is \
        not already in the repository. Do not start new work.";

    pub async fn checkpoint_and_close(&self, budget: std::time::Duration) -> Vec<SessionId> {
        let resident: Vec<SessionId> = {
            let map = self.sessions.lock().await;
            map.iter()
                .filter(|(_, s)| s.stdin.is_some())
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in &resident {
            let done = {
                let map = self.sessions.lock().await;
                map.get(id).map(|s| s.turn_done.clone())
            };
            let Some(done) = done else { continue };
            let notified = done.notified();
            if self
                .send_resident(id, Self::CHECKPOINT_PROMPT, None)
                .await
                .is_err()
            {
                continue;
            }
            if tokio::time::timeout(budget, notified).await.is_err() {
                tracing::warn!("[claude] session={id} did not finish its checkpoint in time");
            }
        }
        let closed = self.close_all_resident().await;
        let core =
            crate::transport::CoreClient::new(self.core_url.clone(), self.device_token.clone());
        for id in &closed {
            let (turn_tx, is_issue_job) = {
                let map = self.sessions.lock().await;
                match map.get(id) {
                    Some(s) => (s.turn_tx.clone(), s.is_issue_job),
                    None => continue,
                }
            };
            report_session_closed(is_issue_job, &turn_tx, Some(&core), id).await;
        }
        closed
    }

    pub async fn close_all_resident(&self) -> Vec<SessionId> {
        let mut map = self.sessions.lock().await;
        let mut closed = Vec::new();
        for (id, s) in map.iter_mut() {
            if s.stdin.take().is_some() {
                closed.push(id.clone());
            }
        }
        closed
    }
}

#[async_trait]
impl Runner for ClaudeCodeRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::ClaudeCode
    }

    async fn start(&self, spec: JobSpec, tx: mpsc::Sender<RunnerEvent>) -> Result<SessionId> {
        let job_id = spec.job_id.clone();

        let effective_repo = spec.repo_path.to_string_lossy().to_string();

        // No skill seeding at job start: the job consumes whatever is already
        // in `<worktree>/.claude/skills/`, delivered ahead of time by the disk
        // sync channel (`workspace::skill_sync`, driven by provision / the
        // `skill.sync` event / background auto-pull), plus any device-scope
        // plugin skills inherited from the config dir. A job-start re-seed was
        // removed because it clobbered project-shadowed skills mid-flight.
        //

        let prompt = spec
            .prompt
            .clone()
            .ok_or_else(|| Error::Other("job has no prompt".into()))?;
        let credential = mcp::config::job_credential()?;

        let invoked_with_resume = spec.resume_id.is_some();
        // ISS-570 hard-fail on a down `forge` server is scoped to reconciler-driven
        // issue jobs (see mcp_failure_is_fatal). Chat / schedule runs carry no
        // issue_id and must not be nuked by a transient `pending` at init.
        let is_issue_job = spec.issue_id.is_some();
        let timeout = spec
            .timeout_seconds
            .filter(|s| *s > 0)
            .map(Duration::from_secs);

        let session_permit = if takes_session_permit(&spec) {
            Some(
                acquire_session_permit(
                    self.session_sem.clone(),
                    self.session_cap,
                    SESSION_PERMIT_WAIT,
                    &spec.job_id,
                    self.permit_holders().await,
                )
                .await?,
            )
        } else {
            None
        };
        // Countable from HERE, not from the session insertion far below.
        let pending_permit = session_permit.is_some().then(|| {
            PendingPermit::register(
                &self.pending_permits,
                &spec.job_id,
                spec.project_slug.as_deref(),
            )
        });

        let slug = spec.project_slug.as_deref().unwrap_or("");
        let mcp_path = mcp::config::write(
            &self.core_url,
            &credential,
            slug,
            &spec.job_id,
            spec.mcp_servers_override.as_ref(),
        )?;
        let args = build_args(&spec, &mcp_path.to_string_lossy());
        let turn_started = Arc::new(tokio::sync::Notify::new());
        let turn_done = Arc::new(tokio::sync::Notify::new());
        let residency_secs = spec.session_residency_seconds;

        let mut cmd = build_command(&args, &effective_repo);
        cmd.env("FORGE_PAT", &credential);
        for (k, v) in project_env(&spec) {
            cmd.env(k, v);
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // Give MCP servers room to connect before the `system/init` snapshot.
        // Heavy stdio servers (e.g. chrome-devtools-mcp / playwright launched via
        // `npx`, which fetch a package + spawn a browser) routinely need >5s; the
        // claude default is tight. Caller-set env wins (don't clobber an override).
        if std::env::var_os("MCP_TIMEOUT").is_none() {
            cmd.env("MCP_TIMEOUT", "15000");
        }

        let mut child = cmd.spawn().map_err(|e| {
            let _ = std::fs::remove_file(&mcp_path);
            Error::Other(format!("failed to spawn claude: {e}"))
        })?;
        tracing::info!("[claude] spawned job={job_id}");

        let session_stdin = {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| Error::Other("no stdin on the spawn".into()))?;
            stdin
                .write_all(user_message_line(&prompt).as_bytes())
                .await
                .map_err(|e| Error::Other(format!("failed to write the first turn: {e}")))?;
            let _ = stdin.flush().await;
            Some(stdin)
        };

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Other("no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::Other("no stderr".into()))?;

        if let Some(pid) = child.id() {
            inflight::record(&job_id, pid);
        }
        let _ = tx.send(RunnerEvent::StateChanged("working")).await;
        let turn_tx: TurnTx = Arc::new(Mutex::new(tx.clone()));
        self.sessions.lock().await.insert(
            job_id.clone(),
            Session {
                status: RunnerStatus::Running,
                child: Some(child),
                claude_session_id: None,
                stdin: session_stdin,
                turn_tx: turn_tx.clone(),
                turn_started: turn_started.clone(),
                pending_inbox: None,
                turns: 0,
                turn_done: turn_done.clone(),
                is_issue_job,
                model: spec.model.clone(),
                head_sha: None,
                permit: session_permit,
                project_slug: spec.project_slug.clone(),
            },
        );
        // The session row is now the countable record; hand over rather than
        // let both report the same permit.
        drop(pending_permit);

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
            let turn_tx = turn_tx.clone();
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
                            let _ = turn_tx
                                .lock()
                                .await
                                .send(RunnerEvent::ClaudeSessionId(sid.to_string()))
                                .await;
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
                    let _ = turn_tx.lock().await.send(RunnerEvent::Stdout(json)).await;
                }
            })
        };

        // Completion task: race reader-EOF vs child-exit (MCP grandchildren can
        // hold the pipe open) vs the definitive `{type:result}` marker, then
        // reap, classify, and emit Done/Failed.
        let sessions = self.sessions.clone();
        let job_id_task = job_id.clone();
        let core_for_state = Some(crate::transport::CoreClient::new(
            self.core_url.clone(),
            self.device_token.clone(),
        ));
        let outcome_for_turns = outcome.clone();
        let result_notify_for_turns = result_notify.clone();
        let turn_tx_for_turns = turn_tx.clone();
        let turn_started_for_turns = turn_started.clone();
        let turn_done_for_turns = turn_done.clone();
        let sessions_for_turns = self.sessions.clone();
        tokio::spawn(async move {
            let job_id = job_id_task;
            let mut reader = reader;
            let already_reported = duplex_turns(
                TurnLoop {
                    sessions: &sessions_for_turns,
                    job_id: &job_id,
                    core: core_for_state.as_ref(),
                    outcome: &outcome_for_turns,
                    result_notify: &result_notify_for_turns,
                    turn_tx: &turn_tx_for_turns,
                    turn_started: &turn_started_for_turns,
                    turn_done: &turn_done_for_turns,
                    is_issue_job,
                    residency: resolve_residency(residency_secs),
                },
                &mut reader,
            )
            .await;
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

            if !reader.is_finished() {
                match timeout {
                    Some(d) => tokio::select! {
                        _ = &mut reader => {}
                        _ = exit_poll => { join_reader(&mut reader, Duration::from_secs(2)).await; }
                        _ = on_result => { join_reader(&mut reader, RESULT_EXIT_GRACE).await; }
                        _ = tokio::time::sleep(d) => { tracing::warn!("[claude] job={job_id} timed out"); }
                    },
                    None => tokio::select! {
                        _ = &mut reader => {}
                        _ = exit_poll => { join_reader(&mut reader, Duration::from_secs(2)).await; }
                        _ = on_result => { join_reader(&mut reader, RESULT_EXIT_GRACE).await; }
                    },
                }
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

            let emit = turn_tx.lock().await.clone();
            if !already_reported {
                if succeeded {
                    let _ = emit.send(RunnerEvent::Done { exit_code: 0 }).await;
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
            }
            sessions.lock().await.remove(&job_id);
            inflight::forget(&job_id);
        });

        Ok(job_id)
    }

    async fn send(
        &self,
        session: &SessionId,
        message: String,
        tx: mpsc::Sender<RunnerEvent>,
    ) -> Result<()> {
        let mut map = self.sessions.lock().await;
        let sess = map
            .get_mut(session)
            .ok_or_else(|| Error::Other("session not found".into()))?;
        let stdin = sess
            .stdin
            .as_mut()
            .ok_or_else(|| Error::Other("session is not duplex — nothing to send to".into()))?;
        stdin
            .write_all(user_message_line(&message).as_bytes())
            .await
            .map_err(|e| Error::Other(format!("failed to write the turn: {e}")))?;
        stdin
            .flush()
            .await
            .map_err(|e| Error::Other(format!("failed to flush the turn: {e}")))?;
        let _ = tx.send(RunnerEvent::StateChanged("working")).await;
        *sess.turn_tx.lock().await = tx;
        sess.turn_started.notify_one();
        Ok(())
    }

    async fn abort(&self, session: &SessionId) -> Result<()> {
        let mut s = self.sessions.lock().await;
        if let Some(sess) = s.get_mut(session) {
            sess.stdin = None;
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

fn project_env(spec: &JobSpec) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    if !spec.project_id.is_empty() {
        out.push(("FORGE_PROJECT_ID", spec.project_id.clone()));
    }
    if let Some(slug) = spec.project_slug.as_ref() {
        out.push(("FORGE_PROJECT_SLUG", slug.clone()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn project_env_names_the_project_the_rest_path_needs() {
        let mut s = spec(false);
        s.project_id = "da368b0a-8e21-4763-9d90-8f7b9d0c7115".into();
        s.project_slug = Some("forge-dev".into());
        let env = project_env(&s);
        let id = env.iter().find(|(k, _)| *k == "FORGE_PROJECT_ID");
        assert_eq!(
            id.map(|(_, v)| v.as_str()),
            Some("da368b0a-8e21-4763-9d90-8f7b9d0c7115"),
            "a bundled skill builds `projects/$FORGE_PROJECT_ID/...`; without this the path is `projects//...`"
        );
        assert_eq!(
            env.iter()
                .find(|(k, _)| *k == "FORGE_PROJECT_SLUG")
                .map(|(_, v)| v.as_str()),
            Some("forge-dev")
        );
    }

    #[test]
    fn project_env_omits_an_absent_id_rather_than_exporting_empty() {
        let s = spec(false);
        assert!(s.project_id.is_empty());
        let env = project_env(&s);
        assert!(
            env.iter().all(|(k, _)| *k != "FORGE_PROJECT_ID"),
            "exporting an empty FORGE_PROJECT_ID would build `projects//...` and 404 instead of failing loudly"
        );
    }

    fn spec(counts_against_session_cap: bool) -> JobSpec {
        JobSpec {
            job_id: "j1".into(),
            project_id: String::new(),
            project_slug: None,
            issue_id: None,
            step: "chat".into(),
            repo_path: "/tmp".into(),
            prompt: Some("hello".into()),
            system_prompt: None,
            model: None,
            allowed_tools: None,
            disallowed_tools: None,
            permission_mode: None,
            timeout_seconds: None,
            mcp_servers_override: None,
            resume_id: None,
            agent_session_id: None,
            counts_against_session_cap,
            session_residency_seconds: None,
        }
    }

    #[test]
    fn a_chat_spawn_takes_no_session_permit_but_a_pipeline_job_does() {
        assert!(
            !takes_session_permit(&spec(false)),
            "a chat turn that waits for a permit is reaped as `no_client_ack` at 90s"
        );
        assert!(
            takes_session_permit(&spec(true)),
            "a pipeline job is what the ceiling is for"
        );
    }

    /// ISS-1218: a paired box whose store holds only the device token used to
    /// write a config with no `forge` server and start the agent anyway.
    #[test]
    fn a_box_holding_only_its_device_token_refuses_the_spawn_naming_both_credentials() {
        use crate::auth::cred_store::{ScopedVar, ENV_TEST_LOCK};
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = crate::test_scratch::Scratch::new("1218-spawn");
        std::fs::create_dir_all(home.join("forge-runner")).unwrap();
        std::fs::write(
            home.join("forge-runner/credentials.json"),
            format!(r#"{{"device_token":"forge_pat_dev_{}"}}"#, "a".repeat(64)),
        )
        .unwrap();
        let _xdg = ScopedVar::set("XDG_CONFIG_HOME", &home);
        let _store = ScopedVar::set("FORGE_RUNNER_CRED_STORE", "file");
        let _pat = ScopedVar::unset("FORGE_PAT");

        let runner = ClaudeCodeRunner::new("http://core.invalid", "tok", 1);
        let mut job = spec(true);
        job.project_slug = Some("iss-1218".into());
        // A directory that is not there, so a build that got past the refusal
        // fails at `spawn` instead of starting a real `claude`.
        job.repo_path = home.join("no-such-checkout");
        let (tx, _rx) = mpsc::channel(4);
        let started = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(Runner::start(&runner, job, tx));
        let err = match started {
            Ok(id) => panic!("the spawn must be refused, and it started session {id}"),
            Err(e) => e.to_string(),
        };

        assert!(
            err.contains("personal access token"),
            "names what was wanted: {err}"
        );
        assert!(
            err.contains("device token"),
            "names what the box holds: {err}"
        );
        assert!(
            err.contains("forge-runner login --pat"),
            "names the way out: {err}"
        );
        assert!(
            !err.contains("failed to spawn claude"),
            "refused before the spawn: {err}"
        );
        let left: Vec<_> = std::fs::read_dir(home.join("forge-runner/mcp"))
            .map(|d| d.flatten().map(|e| e.file_name()).collect())
            .unwrap_or_default();
        assert!(
            left.is_empty(),
            "a refused job leaves no config behind: {left:?}"
        );
        assert_eq!(
            runner.session_sem.available_permits(),
            1,
            "a refused job holds no permit"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    fn args_for(counts_against_session_cap: bool) -> Vec<String> {
        build_args(&spec(counts_against_session_cap), "/tmp/mcp.json")
    }

    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    #[test]
    fn a_spawn_reads_its_turn_off_stdin() {
        let args = args_for(true);
        assert!(has_pair(&args, "--input-format", "stream-json"), "{args:?}");
        assert!(
            args.iter().any(|a| a == "--replay-user-messages"),
            "{args:?}"
        );
        assert!(
            !args.iter().any(|a| a == "-p"),
            "a duplex spawn that also carries -p answers the flag and never reads stdin: {args:?}"
        );
    }

    #[test]
    fn no_spawn_can_reach_the_deleted_print_lane() {
        for cap in [true, false] {
            let args = args_for(cap);
            assert!(
                !args.iter().any(|a| a == "-p"),
                "cap={cap}: a spawn carrying -p answers the flag and never reads stdin: {args:?}"
            );
            assert!(
                has_pair(&args, "--input-format", "stream-json"),
                "cap={cap}: {args:?}"
            );
            assert!(
                has_pair(&args, "--output-format", "stream-json"),
                "cap={cap}: {args:?}"
            );
        }
    }

    struct Harness {
        sessions: Sessions,
        outcome: Arc<Mutex<Outcome>>,
        result_notify: Arc<tokio::sync::Notify>,
        turn_tx: TurnTx,
        turn_started: Arc<tokio::sync::Notify>,
        turn_done: Arc<tokio::sync::Notify>,
        rx: mpsc::Receiver<RunnerEvent>,
    }

    fn resident_harness() -> Harness {
        let (tx, rx) = mpsc::channel(16);
        let turn_tx: TurnTx = Arc::new(Mutex::new(tx));
        let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
        Harness {
            sessions,
            outcome: Arc::new(Mutex::new(Outcome::default())),
            result_notify: Arc::new(tokio::sync::Notify::new()),
            turn_tx,
            turn_started: Arc::new(tokio::sync::Notify::new()),
            turn_done: Arc::new(tokio::sync::Notify::new()),
            rx,
        }
    }

    /// The bound exists so a full box FAILS instead of parking a job forever, and
    /// the pre-fix code parked it while holding the repo root lock (ISS-920).
    ///
    /// `start_paused` makes the 600s wait cost nothing: the only thing this path
    /// awaits is the semaphore and the timer, so the clock auto-advances.
    #[tokio::test(start_paused = true)]
    async fn a_saturated_box_fails_the_spawn_instead_of_waiting_forever() {
        let sem = Arc::new(tokio::sync::Semaphore::new(2));
        let _held = sem.clone().acquire_many_owned(2).await.unwrap();

        let started = tokio::time::Instant::now();
        let err = tokio::time::timeout(
            SESSION_PERMIT_WAIT + Duration::from_secs(60),
            acquire_session_permit(
                sem,
                2,
                SESSION_PERMIT_WAIT,
                "job-1",
                vec!["codemap".into(), "forge-dev".into()],
            ),
        )
        .await
        .expect("the permit wait must be bounded — an unbounded wait is the whole defect")
        .expect_err("a fully held semaphore must not hand out a permit");

        assert_eq!(
            started.elapsed(),
            SESSION_PERMIT_WAIT,
            "the wait must be the bound — no longer, and not a fail-fast either"
        );
        assert_eq!(
            err.to_string(),
            "session_permit_saturated: all 2 permits on this box held after 600s; \
             holders at wait start: codemap, forge-dev"
        );
    }

    /// One project's claims can exhaust a box-level ceiling another project's jobs
    /// then fail on, with nothing in either record connecting the two (ISS-920 B4).
    #[tokio::test(start_paused = true)]
    async fn the_failure_names_the_projects_holding_the_permits() {
        let sem = Arc::new(tokio::sync::Semaphore::new(1));
        let _held = sem.clone().acquire_owned().await.unwrap();
        let err = acquire_session_permit(
            sem,
            1,
            SESSION_PERMIT_WAIT,
            "job-2",
            vec!["someone-elses-project".into()],
        )
        .await
        .expect_err("no permit was free");
        assert!(
            err.to_string()
                .contains("holders at wait start: someone-elses-project"),
            "the loser must be told who is on the ceiling, got: {err}"
        );
    }

    /// A permit that IS free is handed over with no wait at all — the bound must
    /// not become a delay on the common path.
    #[tokio::test(start_paused = true)]
    async fn a_free_permit_is_taken_immediately() {
        let sem = Arc::new(tokio::sync::Semaphore::new(1));
        let started = tokio::time::Instant::now();
        let permit = acquire_session_permit(sem, 1, SESSION_PERMIT_WAIT, "job-3", Vec::new())
            .await
            .expect("a free permit");
        assert_eq!(started.elapsed(), Duration::ZERO);
        drop(permit);
    }

    /// The holder list is the only thing an operator sees when the box is full, so
    /// "nobody" must read as a sentence rather than as an empty tail.
    #[test]
    fn an_empty_holder_list_still_says_something() {
        assert_eq!(describe_holders(&[]), "no session this runner still tracks");
    }

    /// The incident's own shape: jobs claimed seconds apart, each holding a permit
    /// but none of them far enough through `start` to have a `Session` row yet. Read
    /// `self.sessions` alone and the loser is told the box is held by nobody.
    #[tokio::test]
    async fn a_permit_held_before_its_session_row_exists_still_counts_as_a_holder() {
        let runner = ClaudeCodeRunner::new("http://core.invalid", "tok", 3);
        assert!(runner.permit_holders().await.is_empty());

        let a = PendingPermit::register(&runner.pending_permits, "job-a", Some("codemap"));
        let b = PendingPermit::register(&runner.pending_permits, "job-b", Some("forge-dev"));
        assert_eq!(runner.permit_holders().await, vec!["codemap", "forge-dev"]);

        drop(a);
        assert_eq!(runner.permit_holders().await, vec!["forge-dev"]);
        drop(b);
        assert!(
            runner.permit_holders().await.is_empty(),
            "an early return between the permit and the session row must not leak a holder"
        );
    }

    async fn never_ending() -> tokio::task::JoinHandle<()> {
        tokio::spawn(async { std::future::pending::<()>().await })
    }

    /// A reader whose task is already complete — `is_finished()` is true and the
    /// next poll of it panics.
    async fn already_finished() -> tokio::task::JoinHandle<()> {
        let h = tokio::spawn(async {});
        while !h.is_finished() {
            tokio::task::yield_now().await;
        }
        h
    }

    #[tokio::test]
    async fn the_caller_may_not_await_a_reader_the_turn_loop_already_consumed() {
        let Harness {
            sessions,
            outcome,
            result_notify,
            turn_tx,
            turn_started,
            turn_done,
            rx: _rx,
        } = resident_harness();
        let mut reader = already_finished().await;
        let reported = duplex_turns(
            TurnLoop {
                sessions: &sessions,
                job_id: "job-1",
                core: None,
                outcome: &outcome,
                result_notify: &result_notify,
                turn_tx: &turn_tx,
                turn_started: &turn_started,
                turn_done: &turn_done,
                is_issue_job: false,
                residency: SESSION_IDLE_TIMEOUT,
            },
            &mut reader,
        )
        .await;
        assert!(!reported, "no turn ran, so nothing was reported");
        // What `consume`'s spawn does next, and the only thing that makes it safe.
        assert!(reader.is_finished(), "the loop left the handle spent");
        join_reader(&mut reader, Duration::from_secs(2)).await;
    }

    #[tokio::test]
    async fn join_reader_waits_on_a_live_reader_and_gives_up_at_the_ceiling() {
        let mut live = never_ending().await;
        let start = tokio::time::Instant::now();
        join_reader(&mut live, Duration::from_millis(50)).await;
        assert!(start.elapsed() >= Duration::from_millis(50), "it waited");
        assert!(!live.is_finished(), "and left the reader running");
        live.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_finished_turn_reports_and_the_session_stays_open() {
        let Harness {
            sessions,
            outcome,
            result_notify,
            turn_tx,
            turn_started,
            turn_done,
            mut rx,
        } = resident_harness();
        let mut reader = never_ending().await;
        let loop_handle = {
            let (s, o, rn, tt, ts, td) = (
                sessions.clone(),
                outcome.clone(),
                result_notify.clone(),
                turn_tx.clone(),
                turn_started.clone(),
                turn_done.clone(),
            );
            tokio::spawn(async move {
                duplex_turns(
                    TurnLoop {
                        sessions: &s,
                        job_id: "j1",
                        core: None,
                        outcome: &o,
                        result_notify: &rn,
                        turn_tx: &tt,
                        turn_started: &ts,
                        turn_done: &td,
                        residency: SESSION_IDLE_TIMEOUT,
                        is_issue_job: false,
                    },
                    &mut reader,
                )
                .await
            })
        };

        outcome.lock().await.succeeded = Some(true);
        result_notify.notify_one();
        let first = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("a finished turn must report")
            .expect("channel open");
        assert!(
            matches!(first, RunnerEvent::StateChanged("awaiting_input")),
            "{first:?}"
        );
        let second = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("the turn must also report its verdict")
            .expect("channel open");
        assert!(matches!(second, RunnerEvent::Done { .. }), "{second:?}");
        assert!(
            !loop_handle.is_finished(),
            "the session must outlive its turn"
        );
        loop_handle.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn the_idle_ceiling_does_not_arm_while_a_turn_is_running() {
        let Harness {
            sessions,
            outcome,
            result_notify,
            turn_tx,
            turn_started,
            turn_done,
            rx: _rx,
        } = resident_harness();
        let mut reader = never_ending().await;
        let loop_handle = tokio::spawn(async move {
            duplex_turns(
                TurnLoop {
                    sessions: &sessions,
                    job_id: "j1",
                    core: None,
                    outcome: &outcome,
                    result_notify: &result_notify,
                    turn_tx: &turn_tx,
                    turn_started: &turn_started,
                    turn_done: &turn_done,
                    is_issue_job: false,
                    residency: SESSION_IDLE_TIMEOUT,
                },
                &mut reader,
            )
            .await
        });
        tokio::time::sleep(SESSION_IDLE_TIMEOUT * 3).await;
        assert!(
            !loop_handle.is_finished(),
            "a turn that has not produced a result yet is not an idle session"
        );
        loop_handle.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn an_abandoned_session_is_closed_by_the_idle_ceiling() {
        let Harness {
            sessions,
            outcome,
            result_notify,
            turn_tx,
            turn_started,
            turn_done,
            mut rx,
        } = resident_harness();
        let mut reader = never_ending().await;
        let loop_handle = {
            let (s, o, rn, tt, ts, td) = (
                sessions.clone(),
                outcome.clone(),
                result_notify.clone(),
                turn_tx.clone(),
                turn_started.clone(),
                turn_done.clone(),
            );
            tokio::spawn(async move {
                duplex_turns(
                    TurnLoop {
                        sessions: &s,
                        job_id: "j1",
                        core: None,
                        outcome: &o,
                        result_notify: &rn,
                        turn_tx: &tt,
                        turn_started: &ts,
                        turn_done: &td,
                        residency: SESSION_IDLE_TIMEOUT,
                        is_issue_job: false,
                    },
                    &mut reader,
                )
                .await
            })
        };
        outcome.lock().await.succeeded = Some(true);
        result_notify.notify_one();
        let _ = rx.recv().await;
        tokio::time::sleep(SESSION_IDLE_TIMEOUT + Duration::from_secs(1)).await;
        let reported = tokio::time::timeout(Duration::from_secs(1), loop_handle)
            .await
            .expect("the ceiling must close an abandoned session")
            .expect("loop panicked");
        assert!(
            reported,
            "the last turn was reported, so exit must not report again"
        );
    }

    /// A resident session around a trivial child, so the checkpoint path has a
    /// real stdin to write to without spawning claude.
    async fn parked_runner() -> (
        ClaudeCodeRunner,
        mpsc::Receiver<RunnerEvent>,
        Arc<tokio::sync::Notify>,
    ) {
        let mut child = tokio::process::Command::new("cat")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("cat must spawn");
        let stdin = child.stdin.take();
        let (tx, rx) = mpsc::channel(16);
        let turn_done = Arc::new(tokio::sync::Notify::new());
        let runner = ClaudeCodeRunner::new("http://127.0.0.1:1", "tok", 1);
        runner.sessions.lock().await.insert(
            "j1".to_string(),
            Session {
                status: RunnerStatus::Running,
                child: Some(child),
                claude_session_id: None,
                stdin,
                turn_tx: Arc::new(Mutex::new(tx)),
                turn_started: Arc::new(tokio::sync::Notify::new()),
                pending_inbox: None,
                turns: 0,
                turn_done: turn_done.clone(),
                is_issue_job: true,
                model: None,
                head_sha: None,
                permit: None,
                project_slug: None,
            },
        );
        (runner, rx, turn_done)
    }

    #[tokio::test]
    async fn an_aborted_session_is_no_longer_resident() {
        let (runner, _rx, _done) = parked_runner().await;
        let id = "j1".to_string();
        assert!(runner.resident(&id).await.is_some());
        Runner::abort(&runner, &id).await.expect("abort");
        assert!(runner.resident(&id).await.is_none());
        assert!(
            runner.send_resident(&id, "hello", None).await.is_err(),
            "an aborted session must refuse a send rather than write into a corpse"
        );
    }

    #[tokio::test]
    async fn an_aborted_session_is_not_checkpointed() {
        let (runner, _rx, _done) = parked_runner().await;
        Runner::abort(&runner, &"j1".to_string())
            .await
            .expect("abort");
        let started = std::time::Instant::now();
        assert!(runner
            .checkpoint_and_close(std::time::Duration::from_secs(30))
            .await
            .is_empty());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[tokio::test]
    async fn a_checkpoint_waits_for_the_turn_it_asked_for() {
        let (runner, _rx, _done) = parked_runner().await;
        let started = std::time::Instant::now();
        let closed = runner
            .checkpoint_and_close(std::time::Duration::from_millis(300))
            .await;
        assert_eq!(closed, vec!["j1".to_string()]);
        assert!(
            started.elapsed() >= std::time::Duration::from_millis(300),
            "a session that never finished its checkpoint must hold the full budget: {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_finished_checkpoint_does_not_hold_the_restart_for_its_whole_budget() {
        let (runner, _rx, done) = parked_runner().await;
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            done.notify_waiters();
        });
        let started = std::time::Instant::now();
        runner
            .checkpoint_and_close(std::time::Duration::from_secs(30))
            .await;
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the turn reported done, so the budget must not be waited out: {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_session_that_never_answers_is_still_closed() {
        let (runner, _rx, _done) = parked_runner().await;
        runner
            .checkpoint_and_close(std::time::Duration::from_millis(50))
            .await;
        assert!(
            runner.resident(&"j1".to_string()).await.is_none(),
            "the budget elapsing must not leave the session resident"
        );
    }

    #[test]
    fn a_zero_or_absent_residency_is_the_default_and_not_no_residency() {
        assert_eq!(resolve_residency(None), SESSION_IDLE_TIMEOUT);
        assert_eq!(resolve_residency(Some(0)), SESSION_IDLE_TIMEOUT);
        assert_eq!(resolve_residency(Some(3600)), Duration::from_secs(3600));
        assert_eq!(resolve_residency(Some(1)), Duration::from_secs(1));
    }

    #[tokio::test]
    async fn an_issue_job_reports_its_close_on_the_job_channel() {
        let (tx, mut rx) = mpsc::channel(4);
        let turn_tx: TurnTx = Arc::new(Mutex::new(tx));
        report_session_closed(true, &turn_tx, None, "j1").await;
        let ev = rx.try_recv().expect("the close must reach the job channel");
        assert!(matches!(ev, RunnerEvent::StateChanged("closed")), "{ev:?}");
    }

    #[tokio::test]
    async fn a_chat_session_does_not_report_its_close_on_the_job_channel() {
        let (tx, mut rx) = mpsc::channel(4);
        let turn_tx: TurnTx = Arc::new(Mutex::new(tx));
        report_session_closed(false, &turn_tx, None, "s1").await;
        assert!(
            rx.try_recv().is_err(),
            "chat has no job to post an event against — it reports over the session PATCH"
        );
    }

    #[test]
    fn a_turn_that_ends_with_no_result_is_not_a_success() {
        let ev = turn_verdict(&Outcome::default(), false);
        match ev {
            RunnerEvent::Failed { error, .. } => {
                assert!(error.starts_with("[NO_RESULT]"), "{error}")
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_usage_limit_outranks_a_successful_result() {
        let o = Outcome {
            succeeded: Some(true),
            usage_limit: Some("out of extra usage".into()),
            ..Default::default()
        };
        match turn_verdict(&o, false) {
            RunnerEvent::Failed { kind, .. } => assert_eq!(kind, FailureKind::UsageLimit),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn zero_turns_on_an_issue_job_is_no_work_and_on_chat_is_not() {
        let o = Outcome {
            succeeded: Some(true),
            num_turns: Some(0),
            ..Default::default()
        };
        match turn_verdict(&o, true) {
            RunnerEvent::Failed { error, .. } => assert!(error.starts_with("[NO_WORK]"), "{error}"),
            other => panic!("{other:?}"),
        }
        assert!(matches!(turn_verdict(&o, false), RunnerEvent::Done { .. }));
    }

    #[test]
    fn resetting_a_turn_keeps_what_belongs_to_the_process() {
        let mut o = Outcome {
            succeeded: Some(true),
            num_turns: Some(3),
            mcp_failed: vec!["forge(failed)".into()],
            ..Default::default()
        };
        o.reset_turn();
        assert_eq!(o.succeeded, None);
        assert_eq!(o.num_turns, None);
        assert!(!o.result_seen);
        assert_eq!(o.mcp_failed, vec!["forge(failed)".to_string()]);
    }

    #[test]
    fn the_turn_envelope_is_the_one_the_cli_accepts() {
        let line = user_message_line("hi");
        assert!(line.ends_with('\n'), "{line:?}");
        let v: Value = serde_json::from_str(line.trim()).expect("one JSON object per line");
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"][0]["type"], "text");
        assert_eq!(v["message"]["content"][0]["text"], "hi");
    }

    #[test]
    fn a_prompt_that_would_break_the_line_is_escaped_not_embedded() {
        let line = user_message_line("a\nb\"c");
        assert_eq!(
            line.matches('\n').count(),
            1,
            "a raw newline splits the message: {line:?}"
        );
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["message"]["content"][0]["text"], "a\nb\"c");
    }

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
