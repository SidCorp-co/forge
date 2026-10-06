//! The two tasks one Claude Code session runs on: the stdout reader, and the
//! completion task that races the reader's end against the child's exit and
//! the definitive `{type:result}` marker, then reaps, classifies and emits the
//! terminal event.

use super::*;

/// The stdout reader: records the session id, the MCP servers that did not
/// connect, a usage limit and each turn's result, and forwards every line to
/// the current turn's sink.
pub(crate) fn spawn_reader(
    stdout: tokio::process::ChildStdout,
    turn_tx: TurnTx,
    sessions: Sessions,
    outcome: Arc<Mutex<Outcome>>,
    result_notify: Arc<tokio::sync::Notify>,
    job_id: String,
) -> tokio::task::JoinHandle<()> {
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
                    // Cloned under the lock and sent outside it: a
                    // full channel must not hold the lock a resident
                    // send takes to swap in the next turn's sender.
                    let tx = turn_tx.lock().await.clone();
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
                    if is_error {
                        o.result_error = Some(result_error_detail(&json));
                    }
                }
                // Definitive done marker — wake the completion task.
                result_notify.notify_one();
            }
            let tx = turn_tx.lock().await.clone();
            let _ = tx.send(RunnerEvent::Stdout(json)).await;
        }
    })
}

/// Everything the completion task owns once the session is spawned.
pub(crate) struct Completion {
    pub(crate) sessions: Sessions,
    pub(crate) job_id: String,
    pub(crate) core: Option<runner_transport::CoreClient>,
    pub(crate) outcome: Arc<Mutex<Outcome>>,
    pub(crate) result_notify: Arc<tokio::sync::Notify>,
    pub(crate) turn_tx: TurnTx,
    pub(crate) turn_started: Arc<tokio::sync::Notify>,
    pub(crate) turn_done: Arc<tokio::sync::Notify>,
    pub(crate) reader: tokio::task::JoinHandle<()>,
    pub(crate) stderr: tokio::task::JoinHandle<String>,
    pub(crate) mcp_path: std::path::PathBuf,
    pub(crate) invoked_with_resume: bool,
    pub(crate) tx: mpsc::Sender<RunnerEvent>,
}

/// Run the session's turns, then wait for the process to end (MCP
/// grandchildren can hold the pipe open), reap it and emit the terminal event
/// no turn already reported.
pub(crate) async fn complete(c: Completion) {
    let mut reader = c.reader;
    let already_reported = duplex_turns(
        TurnLoop {
            sessions: &c.sessions,
            job_id: &c.job_id,
            core: c.core.as_ref(),
            outcome: &c.outcome,
            result_notify: &c.result_notify,
            turn_tx: &c.turn_tx,
            turn_started: &c.turn_started,
            turn_done: &c.turn_done,
        },
        &mut reader,
    )
    .await;
    if !reader.is_finished() {
        let on_result = c.result_notify.notified();
        tokio::select! {
            _ = &mut reader => {}
            _ = exit_poll(&c.sessions, &c.outcome, &c.job_id) => { join_reader(&mut reader, Duration::from_secs(2)).await; }
            _ = on_result => { join_reader(&mut reader, RESULT_EXIT_GRACE).await; }
        }
    }
    reader.abort();
    // Reap the child + group, capturing its exit status if the exit poll
    // didn't already.
    let killed_exit = match c.sessions.lock().await.get_mut(&c.job_id) {
        Some(s) => match s.child.take() {
            Some(mut child) => graceful_kill(&mut child).await,
            None => None,
        },
        None => None,
    };
    let stderr = tokio::time::timeout(Duration::from_secs(3), c.stderr)
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();
    let _ = std::fs::remove_file(&c.mcp_path);
    if !already_reported {
        let o = c.outcome.lock().await;
        let terminal = terminal_event(&o, killed_exit, &stderr, c.invoked_with_resume);
        drop(o);
        let sink = match terminal {
            RunnerEvent::Done => c.turn_tx.lock().await.clone(),
            _ => c.tx.clone(),
        };
        let _ = sink.send(terminal).await;
    }
    c.sessions.lock().await.remove(&c.job_id);
    inflight::forget(&c.job_id);
}

/// Wait until the session's child exits, recording its status.
async fn exit_poll(sessions: &Sessions, outcome: &Arc<Mutex<Outcome>>, job_id: &str) {
    loop {
        // Snapshot try_wait WITHOUT holding the sessions lock
        // across the outcome lock (avoids a lock-order cycle).
        let polled = {
            let mut s = sessions.lock().await;
            match s.get_mut(job_id).and_then(|x| x.child.as_mut()) {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => Some(Some(status)),
                    Err(_) => Some(None),
                    Ok(None) => None,
                },
                None => Some(None),
            }
        };
        match polled {
            Some(Some(status)) => {
                outcome.lock().await.exit = Some(status);
                return;
            }
            Some(None) => return,
            None => {}
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// The session's terminal event, from what its stream and its exit said.
fn terminal_event(
    o: &Outcome,
    killed_exit: Option<ExitStatus>,
    stderr: &str,
    invoked_with_resume: bool,
) -> RunnerEvent {
    let usage_limit = o.usage_limit.clone().or_else(|| {
        stderr
            .to_lowercase()
            .contains("out of extra usage")
            .then(|| stderr.trim().chars().take(500).collect())
    });
    let succeeded = usage_limit.is_none() && o.succeeded.unwrap_or(false);
    if succeeded {
        return RunnerEvent::Done;
    }
    if let Some(msg) = usage_limit {
        return RunnerEvent::Failed {
            error: format!("[USAGE_LIMIT] {msg}"),
        };
    }
    let resume_failed = invoked_with_resume && {
        let b = stderr.to_lowercase();
        b.contains("session not found")
            || b.contains("could not resume")
            || b.contains("no such session")
            || b.contains("session file missing")
            || b.contains("session id not found")
    };
    if resume_failed {
        let body: String = stderr.trim().chars().take(500).collect();
        return RunnerEvent::Failed {
            error: format!("[RESUME_FAILED] {body}"),
        };
    }
    let (exit_code, signal) = match o.exit.or(killed_exit) {
        Some(ref st) => split_exit(st),
        None => (None, None),
    };
    RunnerEvent::Failed {
        error: classify_failure_reason(
            exit_code,
            signal,
            o.result_seen,
            o.result_error.as_deref(),
            &o.mcp_failed,
            stderr,
        ),
    }
}
