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

/// One `--input-format stream-json` user message, newline-terminated.
// cm:guard the CLI accepts exactly this envelope and rejects a bare string — verified on claude 2.1.251, 2026-08-29. A malformed line is not an error: the process stays alive with nothing to answer, so the turn hangs until the job timeout with no diagnosis anywhere.
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
    /// `(agent-session id, seq)` of the inbox message the CURRENT turn is
    /// consuming, if this turn came from one. Reported back as `applied` when
    /// the turn completes — RFC 0003's commit point.
    // cm:guard the SESSION id, carried from the frame, never the map key: a pipeline session is keyed by `job_id` here, and the applied route is session-keyed, so reporting the key would 404 and leave core waiting on a commit that already happened.
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
    // cm:guard the permit is held by the SESSION, not by the turn — that is invariant 3 of ISS-873. A turn-scoped permit bounds turns, and once a process outlives its turn the same count bounds nothing: three abandoned resident sessions would sit at zero held permits while three processes ran.
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
    /// Which project this session is spent on, for naming the holders when the
    /// box's permits run out.
    // cm:guard read together with `permit` and never alone — a chat session sits in this map holding NO permit (`counts_against_session_cap: false`), so a holder list built from the slug alone names projects that are not on the ceiling and hides the one that is (ISS-920 B4).
    project_slug: Option<String>,
}

/// The current turn's event sink. Shared by the stdout reader, the completion
/// task and [`Runner::send`], because a resident process outlives any one of them.
type TurnTx = Arc<Mutex<mpsc::Sender<RunnerEvent>>>;

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

/// Grace period after the definitive `{type:result}` marker for the CLI to
/// exit on its own before we kill it + report terminal. Guards the
/// hang-after-result bug (anthropics/claude-code#25629).
// cm:guard PRINT ONLY. On the duplex path a `{type:result}` ends the TURN and the process is expected to stay alive, so applying this grace there would kill every resident session five seconds after its first answer — the exact behaviour residency exists to remove.
const RESULT_EXIT_GRACE: Duration = Duration::from_secs(5);

/// How long a duplex session may sit between turns before it is closed.
// cm:guard a resident session with nobody talking to it is a leaked process holding a permit, and nothing else reaps it: the daemon's drain counter tracks TURNS (`InflightGuard` is scoped to the frame task), so an idle session reads as idle and a restart would exit(0) leaving a setsid-detached survivor. This ceiling is the only thing that closes it. `sessionResidencySeconds` gets its reader in phase 3 and replaces this const with a per-project value.
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// How long this session may sit parked between turns.
// cm:edge lockstep -> packages/core/src/jobs/park-deadline.ts — core's backstop resolves the SAME field with a COALESCE onto the same default, and fires at that value plus a grace. Resolving `0` differently here is what would make the two race: core reaping a park this side still considers live, with `residency_expired` no longer meaning "the runner is gone".
// cm:guard `Some(0)` means "use the default", NOT "no residency". The config key defaults to 0 and no project has set it, so reading 0 literally would turn residency off for the entire fleet the moment this reader shipped — a regression against the phase 1b const it replaces, and exactly why ISS-873 moved this reader out of phase 3.
/// Whether this spawn must hold one of the box's duplex session permits.
// cm:guard the cap covers duplex PIPELINE jobs ONLY. Chat opts out at the spec (`counts_against_session_cap: false`) and must keep doing so. The reason is the SWEEPER, not the shape of the wait: core kills a chat turn that has not acked in 90s, and `SESSION_PERMIT_WAIT` is 600s, so a chat turn queued behind parked pipeline sessions dies before it ever spawns whether the wait is bounded or not (session 1af837da, 2026-09-04). ISS-920 gave the wait a bound and that argument did not move — widening this to `spec.duplex` alone still restores the defect.
fn takes_session_permit(spec: &JobSpec) -> bool {
    spec.duplex && spec.counts_against_session_cap
}

/// How long a spawn may wait for one of the box's duplex session permits.
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/dispatch.rs — `PRE_SPAWN_BEAT_BUDGET` is derived from this plus `REPO_LOCK_WAIT`, so the runner still gives up before core condemns the session. Change this and that budget moves with it; the `const _: () = assert!` over there fails the build if it stops.
// cm:guard equal to `SESSION_IDLE_TIMEOUT` on purpose. A permit is released by a session ending or by its residency deadline expiring, so a wait longer than one residency window cannot learn anything new, and a shorter one fails jobs a parked session was about to release. Both halves are the reason — a number picked for either alone drifts the moment the other changes.
pub const SESSION_PERMIT_WAIT: Duration = SESSION_IDLE_TIMEOUT;

/// Take a duplex session permit, or fail naming the box that is full.
///
/// Split out of [`Runner::start`] so the bound can be tested without spawning
/// `claude`: the wait is the whole behaviour, and the only way to exercise it
/// through `start` is to hold real sessions.
// cm:guard the failure text is the ONLY routing lever this has. `session_permit_saturated` is matched by `packages/core/src/pipeline/failure-patterns.ts`, which routes it `infra` + `failover` + `box_session_saturated` — so the job goes to a DIFFERENT box instead of re-claiming this one and meeting the same full semaphore (ISS-920 B3). Rewording the prefix silently returns it to `unclassified`, and the spin comes back.
// cm:guard `holders` is a SNAPSHOT taken by the caller before this is entered, never read from inside. Reading `self.sessions` while parked on `self.session_sem` orders the two locks against every path that takes them the other way round.
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
    // cm:guard a parked `awaiting_input` session keeps its permit until its residency deadline, so "no permit" here usually means the ceiling is spent on sessions doing nothing — say so, or the job's silence reads as a hang.
    tracing::warn!(
        "[job {job_id}] waiting for a duplex session slot — all {cap} permits held by {} (parked awaiting_input sessions keep theirs until residency ends)",
        describe_holders(&holders)
    );
    match tokio::time::timeout(wait, sem.acquire_owned()).await {
        Ok(Ok(permit)) => Ok(permit),
        Ok(Err(e)) => Err(Error::Other(format!("session semaphore closed: {e}"))),
        Err(_) => Err(Error::Other(format!(
            "session_permit_saturated: all {cap} duplex permits on this box held after {}s; holders: {}",
            wait.as_secs(),
            describe_holders(&holders)
        ))),
    }
}

/// The holder list as it goes into a log line and into the failure text.
// cm:guard one renderer for both, because the failure string is asserted byte-for-byte by core's classifier tests and the log line is what an operator greps. Two formatters is two things to keep in step.
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
    /// Clear what belongs to ONE turn, keeping what belongs to the process.
    // cm:guard `mcp_failed` and `exit` are process-scoped and must survive the reset — an MCP server that failed at `system/init` is still failed on turn 4, and clearing it would let a session that never reached its tools report every later turn as healthy.
    fn reset_turn(&mut self) {
        self.succeeded = None;
        self.usage_limit = None;
        self.result_seen = false;
        self.result_error = None;
        self.num_turns = None;
        self.result_text = None;
    }
}

/// Drive a resident session turn-by-turn until the process ends or the idle
/// ceiling closes it. Returns whether the LAST turn already got a terminal
/// event, so the process-level path does not report the same turn twice.
// cm:guard the idle ceiling applies only BETWEEN turns. Arming it during a turn would reap a long one — a 15-minute build is silent on this channel and indistinguishable from an abandoned session by clock alone, which is the same mistake the 25s beat exists to paper over on the print path.
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

/// Await the stdout reader for at most `within`, unless it has already finished.
// cm:guard the `is_finished` check is the whole function. A `JoinHandle` yields its output ONCE; polling it after that panics `JoinHandle polled after completion`, which aborts the process rather than the task. Measured on dev1: 8 core-dumps in the 17 hours after duplex shipped, first 2026-08-29 23:55 and none before, each killing the pipeline job in flight — ISS-880 and ISS-886 both died `session_lost` this way. The path was `duplex_turns` returning through its reader arm (a cancel or the idle ceiling ends the CLI), which spends the handle, and then the caller awaiting it again.
async fn join_reader(reader: &mut tokio::task::JoinHandle<()>, within: Duration) {
    if reader.is_finished() {
        return;
    }
    let _ = tokio::time::timeout(within, reader).await;
}

/// Tell core the idle ceiling ended this session.
// cm:guard the two paths report by DIFFERENT doors and neither one serves both: an issue job's session key is a `job_id`, which the session-keyed PATCH 404s on, and chat has no job to post an event against. Sending an issue job's state over the PATCH is the bug that left `runtime_state` NULL for every duplex pipeline session while three hops read the column — the quiet-clock exemption, the residency deadline and the result guard.
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
                // cm:guard RFC 0003's commit point, and it is reported HERE rather than at the write because those are different claims: a message on the CLI's stdin whose session then dies was never read by the model. Core stands its durable path down on this report alone.
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
                // cm:guard ISS-873 phase 3 — a turn ending is not a JOB ending, and the runner cannot tell the two apart: the park is an issue-status move the driver made over MCP DURING the turn, so core holds the answer. `is_issue_job` is the discriminator and `core` is NOT — `core_for_state` is Some for every duplex spawn including chat, so keying on it would put a 404 on the hot path of every chat turn.
                let job_ended = match (is_issue_job, core) {
                    (true, Some(client)) => {
                        crate::transport::lifecycle::turn_is_job_end(client, job_id).await
                    }
                    // cm:guard chat's every turn end IS its park — there is no job to finish, and residency between turns is the whole feature.
                    _ => true,
                };
                {
                    let tx = turn_tx.lock().await;
                    // cm:guard the park is announced whether or not the job ended, and BEFORE the terminal event — core reads it to exempt the session from the quiet clock, and a state sent after the consumer breaks lands in a receiver nobody is reading.
                    let _ = tx.send(RunnerEvent::StateChanged("awaiting_input")).await;
                    if job_ended {
                        let _ = tx.send(ev).await;
                    }
                }
                // cm:guard raised AFTER the verdict is on the channel, so a caller woken by it sees a turn that is fully reported. Raising it before would let `checkpoint_and_close` drop stdin between the turn ending and its result being sent, losing the very checkpoint it waited for.
                turn_done.notify_waiters();
                // cm:guard `reported` stays FALSE for a turn that did not end the job — the process exit path reads it to decide whether to classify, and marking a parked turn reported would leave a session that later dies with no terminal event at all.
                reported = job_ended;
                // cm:guard a FINISHED issue job must not sit resident to the idle ceiling: core has its terminal event, and every second after it holds one of the box's job slots (per-device now, `devices.max_concurrent`) for a job nobody will send another turn to. Chat does the opposite on purpose — its residency between turns is the feature, and since 2026-09-04 chat holds no slot at all.
                if is_issue_job && job_ended {
                    if let Some(s) = sessions.lock().await.get_mut(job_id) {
                        s.stdin = None;
                    }
                    return reported;
                }
            }
            // cm:guard returning through THIS arm consumes the handle's output, so `reader` is spent for every caller after it — which is why the process-level select in `consume`'s spawn is guarded by `is_finished()` and its grace waits go through `join_reader`. Polling it again panics `JoinHandle polled after completion` and aborts the daemon, not the turn.
            _ = &mut *reader => return reported,
        }
        tokio::select! {
            _ = turn_started.notified() => {}
            _ = &mut *reader => return reported,
            _ = tokio::time::sleep(residency) => {
                tracing::info!("[claude] job={job_id} idle past the session ceiling — closing");
                // Dropping stdin is EOF, which ends the CLI session; the
                // process-level path below then reaps and cleans up.
                // cm:guard announced BEFORE stdin is dropped, while `consume` is still reading this channel — a parked turn sent no terminal event, so the consumer is alive until EOF reaps the process. After the drop it is a race against that reap.
                report_session_closed(is_issue_job, turn_tx, core, job_id).await;
                if let Some(s) = sessions.lock().await.get_mut(job_id) {
                    s.stdin = None;
                }
                return reported;
            }
        }
    }
}

/// The verdict for ONE duplex turn, from the `{type:result}` event alone.
// cm:guard exit code, signal and stderr are deliberately NOT read here: on a resident session none of them exist yet at turn end, and a classifier that reads them would report every healthy turn as `[NO_RESULT]`. A process that dies WITHOUT a result still goes through the full classification path — that is a session failure, not a turn.
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
    // cm:edge contract -> packages/runner/crates/forge-runner-core/src/config.rs — sized from `duplex_max_sessions`, and it counts live duplex PROCESSES spawned by PIPELINE jobs only. Chat is exempt (`counts_against_session_cap: false`) since 2026-09-04, so this number no longer bounds the box's total claude processes — an abandoned chat session is reaped by its residency ceiling and by nothing else.
    session_sem: Arc<tokio::sync::Semaphore>,
    session_cap: usize,
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
        }
    }

    /// Project slugs of the sessions currently holding a duplex permit.
    ///
    /// One project's claims can exhaust a box-level ceiling that another
    /// project's jobs then fail on, and neither side can see the other from its
    /// own records (ISS-920 B4). This is what puts the holders in the loser's
    /// failure text.
    async fn permit_holders(&self) -> Vec<String> {
        let map = self.sessions.lock().await;
        let mut slugs: Vec<String> = map
            .values()
            .filter(|s| s.permit.is_some())
            .map(|s| s.project_slug.clone().unwrap_or_else(|| "?".to_string()))
            .collect();
        slugs.sort();
        slugs
    }
}

// cm:guard the print/duplex split lives HERE and nowhere else — `-p` and `--input-format` are the two halves of one decision, and while they were decided in two places a spawn could carry both, which is a process holding a prompt it will never read off a stdin it will never be given.
/// What a live duplex session was spawned with. `None` means no live session.
pub struct Resident {
    pub model: Option<String>,
    /// `head_sha` recorded at the last turn, or `None` if none was recorded.
    pub head_sha: Option<String>,
}

fn build_args(spec: &JobSpec, mcp_path: &str, prompt: &str) -> Vec<String> {
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
    if spec.duplex {
        args.push("--input-format".into());
        args.push("stream-json".into());
        // cm:guard the replay comes back as `type:"user"` with `isReplay:true`, and chat's `parse_assistant_message` keys on `type=="assistant"`, so it is inert there. Any future consumer that reads user turns off this stream MUST skip replays or it will persist the prompt twice.
        args.push("--replay-user-messages".into());
    }
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
    if !spec.duplex {
        args.push("-p".into());
        args.push(prompt.into());
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
        // cm:guard a session with no stdin is not resident whatever its status says — the print path and a session already closed by the idle ceiling both leave the entry behind until the completion task reaps it, and sending into either writes into a process that will never answer.
        s.stdin.as_ref()?;
        Some(Resident {
            model: s.model.clone(),
            head_sha: s.head_sha.clone(),
        })
    }

    /// Push a message into a session that is already parked, and start a turn.
    // cm:guard reuses the STORED channel rather than taking a new one. A parked pipeline session's events are still being read by `daemon/dispatch.rs#consume` — a parked turn sends no terminal event, so that loop never broke — and installing a fresh channel here would send the whole turn's output into a receiver nobody holds.
    // cm:guard `resident` is the gate, not the map entry: the print path and a session already closed by the idle ceiling both leave an entry behind, and writing into either goes to a process that will never answer, which core would then be told was `delivered`.
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

    /// What `checkpoint` asks a session for before anything ends it.
    // cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/daemon/inbox.rs — the `checkpoint` kind sends this same text. Two wordings for one kind would make a restart checkpoint and an operator checkpoint different acts under one name.
    pub const CHECKPOINT_PROMPT: &'static str = "Write down where you are before this session ends: \
        what you have changed so far, what you were about to do next, and anything you know that is \
        not already in the repository. Do not start new work.";

    /// Ask every resident session to record where it is, wait for the turn, and
    /// then end it — the checkpoint half of RFC 0003's checkpoint-then-close.
    ///
    /// Returns the ids that were closed.
    // cm:guard the wait is what makes this a checkpoint rather than a wasted write. Dropping stdin is EOF: closing straight after the write ends the session before the turn it just asked for can run, which spends a turn to produce nothing and is strictly worse than closing outright.
    // cm:guard `budget` bounds the WHOLE session, and a timeout still closes. A restart that hangs on an agent which will not answer is worse than a lost checkpoint — the daemon is exiting either way, and a session left open past it is a `setsid`-detached child writing a worktree the relaunched daemon is about to hand to a second agent.
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

    /// End every live duplex session, returning the ids that were closed.
    // cm:guard the EOF half of what ends a parked session before the daemon exits — `checkpoint_and_close` is the caller, and calling this directly on the restart path is what skips the checkpoint. A park is not in-flight (`InflightGuard` is scoped to the frame task), so `drain_to_idle` reads an idle daemon and would exit(0) leaving a `setsid`-detached child holding the worktree, which is the second-agent-on-one-checkout hazard invariant 4 exists to prevent. Never call it while a turn is generating: EOF mid-turn is survivable (measured, claude 2.1.251) but the turn's result would land in a receiver the exiting daemon no longer reads.
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

        // cm:guard NOTHING here may touch the repo ROOT. `worktree::create` used to run at this
        // point and it was the only caller that did; the dispatcher holds the root lock across
        // this whole call, so every root read left here re-nests that lock around the permit wait
        // below (ISS-920). `spec.repo_path` arrives already resolved by the caller.
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

        let invoked_with_resume = spec.resume_id.is_some();
        // ISS-570 hard-fail on a down `forge` server is scoped to reconciler-driven
        // issue jobs (see mcp_failure_is_fatal). Chat / schedule runs carry no
        // issue_id and must not be nuked by a transient `pending` at init.
        let is_issue_job = spec.issue_id.is_some();
        let timeout = spec
            .timeout_seconds
            .filter(|s| *s > 0)
            .map(Duration::from_secs);

        // cm:guard acquired BEFORE the spawn and held by the session, so the ceiling counts processes. Acquiring after would let every caller spawn first and queue second, which bounds nothing.
        // cm:guard and acquired with NO repo lock held — that is the other half, and it lives in `daemon/dispatch.rs`, which now releases the root before it calls this (ISS-920). The wait below is bounded, but a bound is not what makes this safe: for the whole of a bound the lock would still be held and the siblings would still die, just sooner.
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

        // cm:guard written AFTER the permit, and the ordering is load-bearing. `forge-mcp-<slug>.json` is one file per PROJECT, and the completion task unlinks it; while the root lock spanned this whole function two jobs on one repo could not overlap here, and ISS-920 removed that accident. Writing it while parked on the permit would let a sibling's completion unlink the path this spawn is about to name, which core reads back as `agent_startup_failed: MCP config file not found`.
        let slug = spec.project_slug.as_deref().unwrap_or("");
        let mcp_path = mcp::config::write(
            &self.core_url,
            &self.device_token,
            slug,
            spec.mcp_servers_override.as_ref(),
        )?;
        let args = build_args(&spec, &mcp_path.to_string_lossy(), &prompt);
        let turn_started = Arc::new(tokio::sync::Notify::new());
        let turn_done = Arc::new(tokio::sync::Notify::new());
        let residency_secs = spec.session_residency_seconds;

        let mut cmd = build_command(&args, &effective_repo);
        // cm:guard set it ONLY when core sent one, and never clear it otherwise — a box whose operator ran `forge-runner login --pat` keeps working against a core that does not mint yet, which is the property that lets the fleet upgrade in either order. Overwriting with an empty string here would break every already-provisioned box the moment one job frame arrived without the field.
        if let Some(tok) = spec.pat_token.as_ref() {
            cmd.env("FORGE_PAT", tok.expose());
        }
        for (k, v) in project_env(&spec) {
            cmd.env(k, v);
        }
        let stdin_mode = if spec.duplex {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        };
        cmd.stdin(stdin_mode)
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

        // cm:guard stdin is HELD, not dropped — dropping it is EOF, and EOF is how a duplex session ends. Everything downstream (the turn loop, `send`, the idle ceiling) exists because this handle stays open; closing it here would silently restore one-shot behaviour with none of the print path's reaping.
        let session_stdin = if spec.duplex {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| Error::Other("no stdin on a duplex spawn".into()))?;
            stdin
                .write_all(user_message_line(&prompt).as_bytes())
                .await
                .map_err(|e| Error::Other(format!("failed to write the first turn: {e}")))?;
            let _ = stdin.flush().await;
            Some(stdin)
        } else {
            None
        };

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Other("no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::Other("no stderr".into()))?;

        // cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/runner/inflight.rs — every path that inserts into `sessions` must record, and every path that removes must forget, or a `job.cancel` after a daemon restart answers `not_found` for a child that is still writing git
        if let Some(pid) = child.id() {
            inflight::record(&job_id, pid);
        }
        if spec.duplex {
            let _ = tx.send(RunnerEvent::StateChanged("working")).await;
        }
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
        let duplex = spec.duplex;
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
                    // cm:guard a send error is fatal on PRINT (the one consumer went away, so nothing will ever read again) and expected on DUPLEX (chat's `consume` drops its receiver at every turn end, and the next `send` installs a fresh one). Breaking here on duplex would stop reading stdout for a process that is still alive and about to be asked another question.
                    if turn_tx
                        .lock()
                        .await
                        .send(RunnerEvent::Stdout(json))
                        .await
                        .is_err()
                        && !duplex
                    {
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
        // cm:guard built for EVERY duplex spawn, and the two paths use it differently on purpose: chat's key IS its agent-session id, so it may PATCH the session directly, while a pipeline job's key is a `job_id` and every session-keyed PATCH with it 404s. The pipeline path therefore reports state as a job EVENT (core writes the column in `jobs/events-routes.ts`) and uses this client only for the job-keyed turn verdict.
        let core_for_state = spec.duplex.then(|| {
            crate::transport::CoreClient::new(self.core_url.clone(), self.device_token.clone())
        });
        let outcome_for_turns = outcome.clone();
        let result_notify_for_turns = result_notify.clone();
        let turn_tx_for_turns = turn_tx.clone();
        let turn_started_for_turns = turn_started.clone();
        let turn_done_for_turns = turn_done.clone();
        let sessions_for_turns = self.sessions.clone();
        tokio::spawn(async move {
            let job_id = job_id_task;
            let mut reader = reader;
            let already_reported = if duplex {
                duplex_turns(
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
                .await
            } else {
                false
            };
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

            // cm:guard skipped ENTIRELY when the reader is spent, because `duplex_turns` returns through its own reader arm and that consumes the output — the `_ = &mut reader` branch here would then panic on its first poll. The grace waits inside the other two arms go through `join_reader` for the same reason, one level down.
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

            // cm:guard a duplex turn that already reported must NOT be reported again here. `already_reported` is the whole reason the turn loop returns a bool: the process ends AFTER its last turn's verdict, and re-classifying at exit would emit a second terminal event for work core already recorded as finished.
            let emit = turn_tx.lock().await.clone();
            if !already_reported {
                if succeeded {
                    let _ = emit.send(RunnerEvent::Done { exit_code: 0 }).await;
                } else if let Some(msg) = usage_limit {
                    // cm:edge contract -> packages/core/src/pipeline/failure-classifier.ts — an unrecognized token degrades to infra + needsReview
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
        // cm:guard the tx is installed and `turn_started` raised only AFTER the write succeeded. Raising first stops the idle clock for a turn that never reached the CLI, and the session would then sit resident until the job timeout with no turn in it.
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

    // cm:guard the SIGNAL path stays, and `cancel` is why: core's two-phase kill gate (ISS-785) waits on a `killed` ack and a turn that is generating stops for nothing else. ISS-873 phase 4 reads as though this becomes checkpoint-then-close — it must not, on this path: a cancel that waited out a checkpoint budget would leave the gate holding a runner slot for a stop the operator asked for now. Checkpoint-then-close is the RESTART path (`checkpoint_and_close`) and the `cancel` inbox kind, both of which act between turns.
    // cm:guard stdin is dropped WITH the child, or the killed session stays `resident`: `resident()` reads stdin alone, so a `send_resident` into a corpse would write to a broken pipe and ack `delivered` for a message no model will ever see, and `checkpoint_and_close` would spend its budget waiting on a turn that cannot start.
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

// cm:guard the PAT alone does not let the agent reach REST — every project-scoped route takes the project UUID as a PATH segment, and until 2026-09-02 the agent was handed a credential with nothing to name the project it may speak for. `X-Forge-Project-Slug` does not close this: only `/mcp` resolves that header, REST does not.
// cm:edge contract -> packages/core/src/pipeline/autonomous-dispatch.ts — `buildDrivePrompt` spells `$FORGE_PROJECT_ID` into a `forge-runner api projects/<id>/...` path the agent is told to run; renaming either side makes that call resolve to `projects//...` and 404 with nothing saying why.
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

    fn spec(duplex: bool) -> JobSpec {
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
            duplex,
            counts_against_session_cap: duplex,
            session_residency_seconds: None,
            pat_token: None,
        }
    }

    #[test]
    fn a_chat_spawn_takes_no_session_permit_but_a_duplex_pipeline_job_does() {
        let mut chat = spec(true);
        chat.counts_against_session_cap = false;
        assert!(
            !takes_session_permit(&chat),
            "a chat turn that waits for a permit is reaped as `no_client_ack` at 90s"
        );

        assert!(
            takes_session_permit(&spec(true)),
            "a duplex pipeline job is what the ceiling is for"
        );
        assert!(
            !takes_session_permit(&spec(false)),
            "a print spawn holds no session"
        );
    }

    fn args_for(duplex: bool) -> Vec<String> {
        build_args(&spec(duplex), "/tmp/mcp.json", "hello")
    }

    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    #[test]
    fn a_duplex_spawn_reads_its_turn_off_stdin() {
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

    // cm:guard the output format is `--output-format stream-json` on BOTH modes and the input format only on duplex — asserting the bare string `stream-json` is present would pass on the print path too, which is why every assertion here is on the FLAG/VALUE pair.
    #[test]
    fn a_print_spawn_still_has_no_input_format() {
        let args = args_for(false);
        assert!(!args.iter().any(|a| a == "--input-format"), "{args:?}");
        assert!(
            !args.iter().any(|a| a == "--replay-user-messages"),
            "{args:?}"
        );
        assert!(
            has_pair(&args, "--output-format", "stream-json"),
            "{args:?}"
        );
        assert!(has_pair(&args, "-p", "hello"), "{args:?}");
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
        let err = acquire_session_permit(
            sem,
            2,
            SESSION_PERMIT_WAIT,
            "job-1",
            vec!["codemap".into(), "forge-dev".into()],
        )
        .await
        .expect_err("a fully held semaphore must not hand out a permit");

        // cm:guard both directions, and the upper one is the test. `>=` alone passes on a
        // wait of a day, which is the pre-fix shape this exists to catch; the paused clock
        // makes the equality exact.
        assert_eq!(
            started.elapsed(),
            SESSION_PERMIT_WAIT,
            "the wait must be the bound — no longer, and not a fail-fast either"
        );
        // cm:guard assert the WHOLE rendered string, not the prefix. It is the input
        // `packages/core/src/pipeline/failure-patterns.ts` classifies, and a digit run
        // like `503` in it would match `provider_overloaded` before the saturation
        // bucket is ever consulted.
        assert_eq!(
            err.to_string(),
            "session_permit_saturated: all 2 duplex permits on this box held after 600s; \
             holders: codemap, forge-dev"
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
            err.to_string().contains("holders: someone-elses-project"),
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

    // cm:guard this reproduces the PRODUCTION sequence in order, and the order is the defect: the turn loop returns through its reader arm — which is what a cancel or the idle ceiling does to a live duplex session — and only THEN does the caller await the same handle. Split into two tests and each half passes on the broken code, because neither poll is wrong on its own; it is the second one that aborts the daemon. 8 core-dumps on dev1 in the 17 hours after duplex shipped, first 2026-08-29 23:55 and none before.
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
        // cm:guard the park MUST arrive before the terminal event — the consumer breaks its loop on Done/Failed, so a state sent afterwards lands in a receiver nobody reads and the session stays recorded as working while it waits on a human.
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

    // cm:guard this is the discriminating test for the idle ceiling: arming it DURING a turn reaps a long one, and a 15-minute build is silent on this channel and indistinguishable from an abandoned session by clock alone.
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

    // cm:guard an aborted session must stop being `resident`. `resident()` reads stdin alone, so a session whose child was killed but whose stdin stayed in the map still answers "send to me" — the write goes to a broken pipe and the runner acks `delivered` for a message no model will ever see, which is the one ack core acts on by standing its durable path down.
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

    // cm:guard an aborted session must not cost the restart its checkpoint budget either — there is no turn left to wait for.
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

    // cm:guard the WAIT is what makes this a checkpoint rather than a wasted write. Dropping stdin is EOF: a close that does not wait ends the session before the turn it just asked for can run, spending a turn to produce nothing — which is strictly worse than closing outright, and indistinguishable from it in any test that only asserts the session ended.
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

    // cm:guard the close must survive an agent that never answers. The daemon is exiting either way, and a session left open past the budget is a `setsid`-detached child on the worktree the relaunched daemon is about to hand to a second agent.
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

    // cm:guard `Some(0)` resolves to the DEFAULT, never to zero. The config key defaults to 0 and no project has set it, so a literal reading turns residency off for the whole fleet the moment this reader ships — the arithmetic that moved this out of ISS-873 phase 3 in the first place. Core's `park-deadline.ts` COALESCEs onto the same default and fires at that value plus a grace, so the two must agree or core reaps a park this side still considers live.
    #[test]
    fn a_zero_or_absent_residency_is_the_default_and_not_no_residency() {
        assert_eq!(resolve_residency(None), SESSION_IDLE_TIMEOUT);
        assert_eq!(resolve_residency(Some(0)), SESSION_IDLE_TIMEOUT);
        assert_eq!(resolve_residency(Some(3600)), Duration::from_secs(3600));
        assert_eq!(resolve_residency(Some(1)), Duration::from_secs(1));
    }

    // cm:guard the discriminating pair for the door choice. An issue job's `runtime_state` reaches core ONLY as a job event; sending it over the session-keyed PATCH silently 404s, which is how the column stayed NULL for every duplex pipeline session with three hops reading it.
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

    // cm:guard an MCP server that failed at `system/init` is still failed on turn 4 — clearing it per turn would let a session that never reached its tools report every later turn as healthy.
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
