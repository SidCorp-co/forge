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

use super::{JobSpec, Runner, RunnerEvent, SessionId};
use runner_core::inflight;
use runner_platform::error::{Error, Result};
use runner_platform::process::{build_command, graceful_kill};
use runner_workspace::mcp;

fn user_message_line(text: &str) -> String {
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    });
    format!("{msg}\n")
}

struct Session {
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
    }
}

struct TurnLoop<'a> {
    sessions: &'a Sessions,
    job_id: &'a str,
    /// Where to report `closed` when the ceiling ends a session nobody is
    /// consuming. `None` on a path with no agent-session row to report against.
    core: Option<&'a runner_transport::CoreClient>,
    outcome: &'a Arc<Mutex<Outcome>>,
    result_notify: &'a Arc<tokio::sync::Notify>,
    turn_tx: &'a TurnTx,
    turn_started: &'a Arc<tokio::sync::Notify>,
    turn_done: &'a Arc<tokio::sync::Notify>,
    residency: Duration,
}

async fn join_reader(reader: &mut tokio::task::JoinHandle<()>, within: Duration) {
    if reader.is_finished() {
        return;
    }
    let _ = tokio::time::timeout(within, reader).await;
}

async fn report_session_closed(core: Option<&runner_transport::CoreClient>, job_id: &str) {
    if let Some(client) = core {
        runner_transport::agent_sessions::report_runtime_state(client, job_id, "closed").await;
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
        residency,
    } = r;
    let mut reported = false;
    loop {
        tokio::select! {
            _ = result_notify.notified() => {
                let ev = {
                    let mut o = outcome.lock().await;
                    let ev = turn_verdict(&o);
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
                    runner_transport::inbox::applied(client, &sid, seq, turn).await;
                }
                {
                    let tx = turn_tx.lock().await;
                    let _ = tx.send(RunnerEvent::StateChanged("awaiting_input")).await;
                    let _ = tx.send(ev).await;
                }
                turn_done.notify_waiters();
                reported = true;
            }
            _ = &mut *reader => return reported,
        }
        tokio::select! {
            _ = turn_started.notified() => {}
            _ = &mut *reader => return reported,
            _ = tokio::time::sleep(residency) => {
                tracing::info!("[claude] job={job_id} idle past the session ceiling — closing");
                report_session_closed(core, job_id).await;
                if let Some(s) = sessions.lock().await.get_mut(job_id) {
                    s.stdin = None;
                }
                return reported;
            }
        }
    }
}

fn turn_verdict(o: &Outcome) -> RunnerEvent {
    if let Some(msg) = o.usage_limit.clone() {
        return RunnerEvent::Failed {
            error: format!("[USAGE_LIMIT] {msg}"),
        };
    }
    if o.succeeded == Some(true) {
        return RunnerEvent::Done;
    }
    RunnerEvent::Failed {
        error: o
            .result_error
            .clone()
            .map(|e| format!("[RESULT_ERROR] {e}"))
            .unwrap_or_else(|| "[NO_RESULT] the turn ended without a result event".into()),
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
            runner_transport::CoreClient::new(self.core_url.clone(), self.device_token.clone());
        for id in &closed {
            if !self.sessions.lock().await.contains_key(id) {
                continue;
            }
            report_session_closed(Some(&core), id).await;
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
        let credential = match &spec.credential {
            Some(handed) => handed.0.clone(),
            None => mcp::config::job_credential()?,
        };

        let invoked_with_resume = spec.resume_id.is_some();
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
                child: Some(child),
                claude_session_id: None,
                stdin: session_stdin,
                turn_tx: turn_tx.clone(),
                turn_started: turn_started.clone(),
                pending_inbox: None,
                turns: 0,
                turn_done: turn_done.clone(),
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
        let core_for_state = Some(runner_transport::CoreClient::new(
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
                    residency: SESSION_IDLE_TIMEOUT,
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

            let (succeeded_opt, usage_limit, result_seen, result_error, mcp_failed, polled_exit) = {
                let o = outcome.lock().await;
                (
                    o.succeeded,
                    o.usage_limit.clone(),
                    o.result_seen,
                    o.result_error.clone(),
                    o.mcp_failed.clone(),
                    o.exit,
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

            let succeeded = usage_limit.is_none() && succeeded_opt.unwrap_or(false);

            let resume_failed = invoked_with_resume && !succeeded && {
                let b = stderr.to_lowercase();
                b.contains("session not found")
                    || b.contains("could not resume")
                    || b.contains("no such session")
                    || b.contains("session file missing")
                    || b.contains("session id not found")
            };

            // Emit the terminal event.
            let _ = std::fs::remove_file(&mcp_path);

            let emit = turn_tx.lock().await.clone();
            if !already_reported {
                if succeeded {
                    let _ = emit.send(RunnerEvent::Done).await;
                } else if let Some(msg) = usage_limit {
                    let _ = tx
                        .send(RunnerEvent::Failed {
                            error: format!("[USAGE_LIMIT] {msg}"),
                        })
                        .await;
                } else if resume_failed {
                    let body: String = stderr.trim().chars().take(500).collect();
                    let _ = tx
                        .send(RunnerEvent::Failed {
                            error: format!("[RESUME_FAILED] {body}"),
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
                    let _ = tx.send(RunnerEvent::Failed { error }).await;
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
            Ok(())
        } else {
            Err(Error::Other("session not found".into()))
        }
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
