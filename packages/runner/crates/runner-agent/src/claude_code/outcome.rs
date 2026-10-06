use super::*;

/// Signals captured from the claude stream + process exit, written
/// incrementally by the reader/completion tasks so they survive a reader abort
/// and let us emit a precise, diagnosable failure reason.
#[derive(Default)]
pub(crate) struct Outcome {
    /// `Some(true/false)` once a `{type:result}` event arrived (`!is_error`).
    pub(crate) succeeded: Option<bool>,
    /// Usage-limit message, if detected mid-stream.
    pub(crate) usage_limit: Option<String>,
    /// True once a `{type:result}` event was seen (the definitive done marker).
    pub(crate) result_seen: bool,
    /// Error detail from a `{type:result}` with `is_error=true`.
    pub(crate) result_error: Option<String>,
    /// MCP servers that did NOT reach a connected status at `system/init`.
    pub(crate) mcp_failed: Vec<String>,
    /// Captured child exit status (carries exit code / terminating signal).
    pub(crate) exit: Option<ExitStatus>,
}

impl Outcome {
    pub(crate) fn reset_turn(&mut self) {
        self.succeeded = None;
        self.usage_limit = None;
        self.result_seen = false;
        self.result_error = None;
    }
}

pub(crate) struct TurnLoop<'a> {
    pub(crate) sessions: &'a Sessions,
    pub(crate) job_id: &'a str,
    /// Where to report `closed` when the ceiling ends a session nobody is
    /// consuming. `None` on a path with no agent-session row to report against.
    pub(crate) core: Option<&'a runner_transport::CoreClient>,
    pub(crate) outcome: &'a Arc<Mutex<Outcome>>,
    pub(crate) result_notify: &'a Arc<tokio::sync::Notify>,
    pub(crate) turn_tx: &'a TurnTx,
    pub(crate) turn_started: &'a Arc<tokio::sync::Notify>,
    pub(crate) turn_done: &'a Arc<tokio::sync::Notify>,
}

pub(crate) async fn join_reader(reader: &mut tokio::task::JoinHandle<()>, within: Duration) {
    if reader.is_finished() {
        return;
    }
    let _ = tokio::time::timeout(within, reader).await;
}

pub(crate) async fn report_session_closed(
    core: Option<&runner_transport::CoreClient>,
    job_id: &str,
) {
    if let Some(client) = core {
        runner_transport::agent_sessions::report_runtime_state(client, job_id, "closed").await;
    }
}

pub(crate) async fn duplex_turns(
    r: TurnLoop<'_>,
    reader: &mut tokio::task::JoinHandle<()>,
) -> bool {
    let TurnLoop {
        sessions,
        job_id,
        core,
        outcome,
        result_notify,
        turn_tx,
        turn_started,
        turn_done,
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
                    let tx = turn_tx.lock().await.clone();
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
        }
    }
}

pub(crate) fn turn_verdict(o: &Outcome) -> RunnerEvent {
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
pub(crate) fn split_exit(status: &ExitStatus) -> (Option<i32>, Option<i32>) {
    use std::os::unix::process::ExitStatusExt;
    (status.code(), status.signal())
}

#[cfg(not(unix))]
pub(crate) fn split_exit(status: &ExitStatus) -> (Option<i32>, Option<i32>) {
    (status.code(), None)
}

/// From a `{type:result}` event with `is_error=true`, extract a short detail
/// string (`subtype: message`).
pub(crate) fn result_error_detail(json: &Value) -> String {
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
pub(crate) fn is_transient_mcp_status(status: &str) -> bool {
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
pub(crate) fn mcp_failed_servers(json: &Value) -> Option<Vec<String>> {
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
pub(crate) fn classify_failure_reason(
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

/// Detect an "out of extra usage" message in a JSONL line.
pub(crate) fn detect_usage_limit(json: &Value) -> Option<String> {
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
