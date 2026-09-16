//! The local socket a session on this box talks to, and why it carries one verb.
//!
//! It used to be how a master claimed work: `prepare`, `start`, `discard`,
//! `release`, `run_open`, `ask`, `decide` — a job pool reached through a unix
//! socket so the claim and the spawn happened in one process. None of that
//! exists now. A run is a subagent the master dispatches inside its own
//! session, and the lease `forge claim` takes on the issue is the whole record
//! of it, so there is nothing on this box left to claim, hold or hand back.
//!
//! What survived that removal was the one verb that never acted: a session
//! telling the daemon what its own hooks just reported.
//!
//! Since ISS-1050 there are two more, and they are DECLARATIONS rather than
//! claims. A master says "I am about to hand these issues to a subagent" and
//! "that one is finished". Neither selects work from a queue, neither spawns a
//! process, and neither moves an issue's status — they write a row in this
//! box's own registry so that, when the master dies, something on disk still
//! says what it was carrying. The old `run_open` took a job from a pool and
//! then started it; these take nothing and start nothing.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};

use crate::config::Config;
use crate::daemon::session_tokens::SessionTokens;

/// Where the daemon listens and the CLI connects: beside `config.toml`.
// cm:guard derive this from `Config::path()` and nothing else. dev1 runs several runner services that differ ONLY by `XDG_CONFIG_HOME`, so the config dir is already the thing that separates them; a socket keyed on anything else (a fixed name, the hostname, `XDG_RUNTIME_DIR`) puts two daemons on one path, and a session then reports its turns to whichever bound first.
pub fn socket_path() -> Option<PathBuf> {
    let cfg = Config::path().ok()?;
    Some(cfg.with_file_name("control.sock"))
}

// cm:guard every variant carries `token` and NONE declares a session. The daemon maps token -> session and an unknown field on the frame is dropped by serde, so a session that names another session is served as itself (ISS-964 criteria 29-31).
// cm:guard what may be added here is a frame that RECORDS, and what may never be is one that selects work or starts a process. This guard used to say no second verb at all, on the premise that the lease on the issue was the whole record of a run; ISS-1050 made that premise false — nothing was recording what a master handed out, so a master dying took its issues with it — and the premise, not the caution, is what changed. The caution is kept as a bound: a declaration names the project it is for and is refused unless that is the project whose master this token's session is, so a pane whose hooks are noisy or forged can still move no work that is not already its own.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    /// What this session's own hooks say it is doing (turn boundaries).
    // cm:guard the ONLY verb on this socket, and it REPORTS rather than acts: it takes no run id, claims nothing and releases nothing, so a pane whose hooks are noisy or forged can move no work. A verb added here that acts is a second way to reach work that the lease on the issue is supposed to be the whole record of.
    // cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/agent_activity.rs — `event` is a Claude Code hook event NAME and that module owns the closed set; an unknown one is refused by name rather than recorded as something adjacent.
    #[serde(rename_all = "camelCase")]
    AgentEvent {
        token: String,
        event: String,
        #[serde(default)]
        at_ms: Option<i64>,
        /// The child this event is about: `agent_id`, or `teammate_name` on `TeammateIdle`.
        // cm:guard OPTIONAL and never defaulted to anything: measured against claude 2.1.257, a child event carries `agent_id` and a lead event carries none, so an absent field is the discriminator rather than a gap to fill.
        #[serde(default)]
        agent_id: Option<String>,
        /// Claude Code's own `session_id` — which conversation these claims belong to.
        #[serde(default)]
        conversation_id: Option<String>,
    },
    /// "I am about to hand these issues to a subagent."
    // cm:guard `project_id` is on the frame AND checked against the one this token's session is master of, rather than simply derived from the token. Derived, a master that named the wrong project would be served silently under the right one, and the mistake would surface as a run recorded against issues nobody meant; named and checked, it is refused saying which project the pane actually serves (ISS-1050 criterion 7).
    #[serde(rename_all = "camelCase")]
    RunDeclare {
        token: String,
        project_id: String,
        issue_keys: Vec<String>,
        worktree_path: String,
    },
    /// "That run is finished" — or "the subagent I declared never started".
    #[serde(rename_all = "camelCase")]
    RunClose {
        token: String,
        run_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
}

impl Request {
    fn token(&self) -> &str {
        match self {
            Request::AgentEvent { token, .. }
            | Request::RunDeclare { token, .. }
            | Request::RunClose { token, .. } => token,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimReply {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ClaimReply {
    fn refused(reason: impl Into<String>) -> Self {
        Self {
            ok: false,
            job_id: None,
            agent_session_id: None,
            issue_key: None,
            reason: Some(reason.into()),
        }
    }
}

/// What serving one frame needs, and deliberately nothing more.
// cm:guard still NO core client, no repo lock and no runner, and that is the line rather than the count of fields. The two below let a frame write a row in this box's own registry and read which project a pane serves; neither can reach core, so nothing served here can move an issue, take a lease or start a process. A core client added to this struct is how a verb that acts gets written next, because there would be something here to act WITH — the ledger is not that, and the core-side half of a declaration is opened by the daemon's own tick, which already has a client (ISS-1050).
pub struct Control {
    /// Which session is on the other end of a frame.
    pub tokens: SessionTokens,
    /// What each session's hooks have reported about itself.
    pub activity: Arc<crate::daemon::agent_activity::Activities>,
    /// Which project each live master pane serves, for bounding a declaration.
    pub masters: Arc<crate::daemon::master::Masters>,
    /// This box's own registry of what its masters have handed out.
    // cm:guard a `Mutex` and not a second `Ledger` per frame: `rusqlite::Connection` is not `Sync`, and one connection per frame would open and migrate the file on every hook call.
    pub ledger: Arc<std::sync::Mutex<Option<crate::runner::ledger::Ledger>>>,
    /// The boot this daemon is in, which scopes every row it writes.
    pub boot_id: String,
}

/// Serve until `cancel` flips.
// cm:guard REFUSE on a platform with no unix socket, never degrade to a daemon that starts without one. Turn boundaries are how everything on this box tells a working pane from a stopped one, and a daemon that came up with no socket would report healthy while every liveness reader on it went blind.
#[cfg(not(unix))]
pub async fn serve(
    _ctl: Arc<Control>,
    _cancel: tokio::sync::watch::Receiver<bool>,
) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "the control socket needs a unix socket; this platform cannot host a runner whose sessions report their turns",
    ))
}

#[cfg(unix)]
// cm:guard bind by REPLACING a stale socket file, never by refusing to start. A daemon killed by SIGKILL leaves the file behind, and a runner that then declines to listen is a box whose panes report nothing with nothing in its log naming the socket as the cause.
pub async fn serve(
    ctl: Arc<Control>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> std::io::Result<()> {
    let Some(path) = socket_path() else {
        return Err(std::io::Error::other(
            "cannot resolve the control socket path",
        ));
    };
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let listener = UnixListener::bind(&path)?;
    tracing::info!("[control] listening on {}", path.display());

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let ctl = ctl.clone();
                        tokio::spawn(async move { serve_one(ctl, stream).await });
                    }
                    Err(e) => tracing::warn!("[control] accept: {e}"),
                }
            }
            _ = cancel.changed() => {
                if *cancel.borrow() { break; }
            }
        }
    }
    let _ = std::fs::remove_file(&path);
    Ok(())
}

#[cfg(unix)]
async fn serve_one(ctl: Arc<Control>, stream: UnixStream) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).await.is_err() {
        return;
    }
    let reply = match serde_json::from_str::<Request>(&line) {
        Ok(req) => match ctl.tokens.session_for(req.token()) {
            // cm:guard resolve the token ONCE, here, and pass the session id down. A handler that took the token and resolved it itself would be a second place the mapping can be got wrong, and the refusal below is the only thing standing between the socket and an unauthenticated caller.
            Some(session_id) => serve_request(&ctl, req, &session_id),
            None => ClaimReply::refused("unknown_token"),
        },
        Err(e) => ClaimReply::refused(format!("undecodable request: {e}")),
    };
    let mut out = serde_json::to_string(&reply).unwrap_or_else(|_| "{\"ok\":false}".into());
    out.push('\n');
    let _ = reader.get_mut().write_all(out.as_bytes()).await;
}

/// Record one hook report and answer with the state it produced.
// cm:guard synchronous and allocation-light on purpose: this runs on EVERY tool call of every pane on the box, and the hook that calls it is in the agent's critical path. A handler that awaited core here would put this daemon's network latency between an agent and its next tool.
// cm:guard an unknown event NAME is refused rather than recorded as adjacent — a Claude Code release that renames an event must show up as a named refusal in the log, not as a pane that quietly stops reporting turn boundaries while every reader keeps trusting the last one.
#[cfg(unix)]
fn agent_event(
    ctl: &Arc<Control>,
    event: &str,
    at_ms: Option<i64>,
    agent_id: Option<&str>,
    conversation_id: Option<&str>,
    session_id: &str,
) -> ClaimReply {
    let Some(parsed) = crate::daemon::agent_activity::Event::from_wire(event) else {
        return ClaimReply::refused(format!("unknown_event: {event}"));
    };
    let after = ctl.activity.record(
        session_id,
        crate::daemon::agent_activity::Report {
            event: parsed,
            at: at_ms.unwrap_or_else(crate::daemon::agent_activity::now_ms),
            subject: agent_id,
            conversation: conversation_id,
        },
    );
    bind_or_release(ctl, parsed, agent_id, session_id);
    // cm:guard a permission wait is the ONE state that leaves this box at WARN, because it is the only one nothing on the box can clear: a turn that runs ends, a turn that fails ends, and a question put to a human ends when a human answers it. Measured forge-vm 2026-09-10: one run pane sat on a dangerous-command prompt for hours while every liveness reader called it healthy, because the pane emitted no boundary anything here could hear.
    match after.doing() {
        crate::daemon::agent_activity::Doing::AwaitingPermission => tracing::warn!(
            "[control] session {session_id} is stopped on a question only a human can answer"
        ),
        doing => tracing::debug!("[control] session {session_id} reports {event} -> {doing:?}"),
    }
    ClaimReply {
        ok: true,
        job_id: None,
        agent_session_id: Some(session_id.to_string()),
        issue_key: None,
        reason: Some(format!("{:?}", after.doing())),
    }
}

/// Record that a master is about to hand these issues to a subagent.
///
/// Writes a row and answers its id. Starts nothing, selects nothing, and moves
/// no issue's status.
// cm:guard the project is CHECKED and never derived, and an unknown pane is refused rather than served. `Masters` is an in-process optimisation and a daemon restart empties it while every master is still running, so a declaration in that window must be told this box does not yet know which project its pane serves — the next sweep re-adopts the pane and restores the answer. Serving it anyway, from the frame's own claim or from the only entry present, is how a pane on one project opens a run over another's issue (ISS-1050 criterion 7).
#[cfg(unix)]
fn run_declare(
    ctl: &Arc<Control>,
    project_id: &str,
    issue_keys: &[String],
    worktree_path: &str,
    session_id: &str,
) -> ClaimReply {
    let Some(serves) = ctl.masters.project_for_session(session_id) else {
        return ClaimReply::refused(
            "this daemon does not yet know which project your pane serves — it re-adopts live panes on its next sweep, within thirty seconds",
        );
    };
    if serves != project_id {
        return ClaimReply::refused(format!(
            "this pane is the master for {serves} and cannot declare a run for {project_id}"
        ));
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else {
        return ClaimReply::refused("this daemon has no ledger open, so it can record nothing");
    };
    match led.create_run_group(crate::runner::ledger::NewRun {
        run_id: run_id.clone(),
        project_id: project_id.to_string(),
        master_session_id: session_id.to_string(),
        worktree_path: std::path::PathBuf::from(worktree_path),
        boot_id: ctl.boot_id.clone(),
        issue_keys: issue_keys.to_vec(),
    }) {
        Ok(run) => {
            tracing::info!(
                "[control] {project_id}: run {} declared over {:?}",
                run.run_id,
                issue_keys
            );
            ClaimReply {
                ok: true,
                job_id: Some(run.run_id),
                agent_session_id: Some(session_id.to_string()),
                issue_key: issue_keys.first().cloned(),
                reason: None,
            }
        }
        // cm:guard the ledger's own refusal text is passed through WHOLE. Each of the three names what a master has to do next — which issue collided, which tree is held, which declared row to close — and a handler that replaced them with one word of its own would take that away.
        Err(e) => ClaimReply::refused(e.to_string()),
    }
}

/// Record that a declared run is over, whether it ran or never started.
// cm:guard the run must belong to THIS session. A close keyed on the run id alone would let any pane on the box end another master's run, and the close is what releases the issues.
#[cfg(unix)]
fn run_close(
    ctl: &Arc<Control>,
    run_id: &str,
    reason: Option<&str>,
    session_id: &str,
) -> ClaimReply {
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else {
        return ClaimReply::refused("this daemon has no ledger open, so it can record nothing");
    };
    match led.run(run_id) {
        Ok(Some(run)) if run.master_session_id == session_id => {
            if let Err(e) = led.end_run(run_id, "master", reason.unwrap_or("the master said so")) {
                return ClaimReply::refused(e.to_string());
            }
            tracing::info!("[control] run {run_id} closed by its master");
            ClaimReply {
                ok: true,
                job_id: Some(run_id.to_string()),
                agent_session_id: Some(session_id.to_string()),
                issue_key: None,
                reason: None,
            }
        }
        Ok(Some(_)) => ClaimReply::refused(format!("run {run_id} belongs to another master")),
        Ok(None) => ClaimReply::refused(format!("no run {run_id} on this box")),
        Err(e) => ClaimReply::refused(e.to_string()),
    }
}

/// Tie a subagent's life to the run its master declared for it.
///
/// `SubagentStart` binds the one row this master has declared and nothing has
/// claimed; `SubagentStop` ends the row that child was bound to. Both are ledger
/// writes and neither reaches core — the core-side close is the daemon's own
/// pass, which has a client.
// cm:guard this runs INSIDE the hook path and must never fail it: every branch is a log line, because a pane whose bind was refused must keep reporting its turn boundaries. The cost of a missed bind is a row core's reaper returns in ten minutes, which is the same safe direction as a master that died between declaring and dispatching (ISS-1050 criterion 13).
// cm:guard `SubagentStop` ends the row rather than releasing anything here. The ledger says the run is over; the leases and core's session are closed by the pass that owns them, so there is exactly one writer of each.
#[cfg(unix)]
fn bind_or_release(
    ctl: &Arc<Control>,
    event: crate::daemon::agent_activity::Event,
    agent_id: Option<&str>,
    session_id: &str,
) {
    use crate::daemon::agent_activity::Event;
    let Some(child) = agent_id else { return };
    if !matches!(event, Event::SubagentStarted | Event::SubagentStopped) {
        return;
    }
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else { return };
    match event {
        Event::SubagentStarted => {
            match led.unbound_run_for_master(session_id, &ctl.boot_id) {
                Ok(Some(run)) => match led.bind_agent(&run.run_id, child) {
                    Ok(true) => tracing::info!("[control] run {} is subagent {child}", run.run_id),
                    Ok(false) => tracing::debug!(
                        "[control] run {} was already bound when {child} started",
                        run.run_id
                    ),
                    Err(e) => tracing::warn!("[control] cannot bind {child}: {e}"),
                },
                // cm:guard NOT a warning. A master runs subagents this box knows nothing about — a
                // search, a review, anything it dispatches without declaring — and every one of
                // them arrives here. Only a declared run has a row, and a child with none is the
                // ordinary case rather than a fault.
                Ok(None) => {
                    tracing::debug!("[control] subagent {child} answers to no declared run")
                }
                Err(e) => tracing::warn!("[control] cannot read declared runs: {e}"),
            }
        }
        Event::SubagentStopped => match led.run_for_agent(child) {
            Ok(Some(run)) => match led.end_run(&run.run_id, "subagent", "the subagent finished") {
                Ok(()) => tracing::info!("[control] run {} ended with {child}", run.run_id),
                Err(e) => tracing::warn!("[control] cannot end run {}: {e}", run.run_id),
            },
            Ok(None) => tracing::debug!("[control] subagent {child} answered to no declared run"),
            Err(e) => tracing::warn!("[control] cannot read the run for {child}: {e}"),
        },
        _ => {}
    }
}

#[cfg(unix)]
fn serve_request(ctl: &Arc<Control>, req: Request, session_id: &str) -> ClaimReply {
    match req {
        Request::AgentEvent {
            event,
            at_ms,
            agent_id,
            conversation_id,
            ..
        } => agent_event(
            ctl,
            &event,
            at_ms,
            agent_id.as_deref(),
            conversation_id.as_deref(),
            session_id,
        ),
        Request::RunDeclare {
            project_id,
            issue_keys,
            worktree_path,
            ..
        } => run_declare(ctl, &project_id, &issue_keys, &worktree_path, session_id),
        Request::RunClose { run_id, reason, .. } => {
            run_close(ctl, &run_id, reason.as_deref(), session_id)
        }
    }
}

/// Declare a run from a pane, over the control socket.
#[cfg(unix)]
pub async fn request_run_declare(
    path: &std::path::Path,
    token: &str,
    project_id: &str,
    issue_keys: &[String],
    worktree_path: &str,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({
            "op": "run_declare", "token": token, "projectId": project_id,
            "issueKeys": issue_keys, "worktreePath": worktree_path
        }),
    )
    .await
}

/// Close a declared run from a pane, over the control socket.
#[cfg(unix)]
pub async fn request_run_close(
    path: &std::path::Path,
    token: &str,
    run_id: &str,
    reason: Option<&str>,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({ "op": "run_close", "token": token, "runId": run_id, "reason": reason }),
    )
    .await
}

#[cfg(not(unix))]
pub async fn request_run_declare(
    _path: &std::path::Path,
    _token: &str,
    _project_id: &str,
    _issue_keys: &[String],
    _worktree_path: &str,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

#[cfg(not(unix))]
pub async fn request_run_close(
    _path: &std::path::Path,
    _token: &str,
    _run_id: &str,
    _reason: Option<&str>,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

#[cfg(not(unix))]
pub async fn request_agent_event(
    _path: &std::path::Path,
    _token: &str,
    _event: &str,
    _agent_id: Option<&str>,
    _conversation_id: Option<&str>,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

#[cfg(not(unix))]
fn no_socket() -> std::io::Error {
    std::io::Error::other(
        "the control socket needs a unix socket; this platform cannot report a turn boundary",
    )
}

/// Tell a running daemon what this session's hooks just reported.
#[cfg(unix)]
pub async fn request_agent_event(
    path: &std::path::Path,
    token: &str,
    event: &str,
    agent_id: Option<&str>,
    conversation_id: Option<&str>,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({
            "op": "agent_event", "token": token, "event": event,
            "agentId": agent_id, "conversationId": conversation_id
        }),
    )
    .await
}

#[cfg(unix)]
async fn ask(path: &std::path::Path, body: serde_json::Value) -> std::io::Result<ClaimReply> {
    let stream = UnixStream::connect(path).await?;
    let mut reader = BufReader::new(stream);
    let mut line = serde_json::to_string(&body)?;
    line.push('\n');
    reader.get_mut().write_all(line.as_bytes()).await?;
    let mut resp = String::new();
    reader.read_line(&mut resp).await?;
    serde_json::from_str(&resp)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // cm:guard a refusal must serialise WITHOUT the success fields rather than with nulls — the caller reads this JSON, and a `jobId: null` beside `ok: false` reads as a job that exists and failed rather than a report that never landed.
    #[test]
    fn a_refusal_carries_a_reason_and_no_job() {
        let out = serde_json::to_string(&ClaimReply::refused("unknown_event: Nope")).unwrap();
        assert!(out.contains("\"reason\":\"unknown_event: Nope\""));
        assert!(!out.contains("jobId"));
        assert!(out.contains("\"ok\":false"));
    }

    // cm:guard the frame is the one the CLI actually sends, byte for byte: the enum's `rename_all` renames VARIANTS and not fields, so without the field-level rename `atMs` decodes as absent and — worse in this direction — a typo in the op name makes every hook report on the box an "undecodable request" that nothing on either side is watching for.
    #[test]
    fn a_hook_frame_from_the_cli_decodes_with_its_event_and_optional_timestamp() {
        let frame = r#"{"op":"agent_event","token":"t1","event":"Stop","atMs":1700}"#;
        let req: Request = serde_json::from_str(frame).expect("the hook frame must decode");
        let Request::AgentEvent {
            token,
            event,
            at_ms,
            ..
        } = &req
        else {
            panic!("a frame whose op is `agent_event` must decode as one");
        };
        assert_eq!(
            (token.as_str(), event.as_str(), *at_ms),
            ("t1", "Stop", Some(1700))
        );
        assert_eq!(req.token(), "t1", "the token is what resolves the session");
    }

    #[test]
    fn a_hook_frame_without_a_timestamp_still_decodes() {
        let frame = r#"{"op":"agent_event","token":"t1","event":"UserPromptSubmit"}"#;
        let req: Request = serde_json::from_str(frame).expect("must decode");
        let Request::AgentEvent { at_ms, .. } = &req else {
            panic!("a frame whose op is `agent_event` must decode as one");
        };
        assert!(at_ms.is_none(), "the daemon stamps it instead");
    }

    #[test]
    fn a_frame_naming_another_session_is_served_as_the_token_owner() {
        let dir = std::env::temp_dir().join(format!("ct-{}", uuid::Uuid::new_v4()));
        let tokens = SessionTokens::at(dir.join("control-tokens.json"));
        let a = tokens.mint("sess-a").unwrap();
        tokens.mint("sess-b").unwrap();

        let frame =
            format!(r#"{{"op":"agent_event","token":"{a}","sessionId":"sess-b","event":"Stop"}}"#);
        let req: Request = serde_json::from_str(&frame).expect("frame must decode");
        let Request::AgentEvent { token, .. } = &req else {
            panic!("a frame whose op is `agent_event` must decode as one");
        };
        assert_eq!(
            tokens.session_for(token),
            Some("sess-a".to_string()),
            "a session that can name another session can describe it as working or stopped, and every liveness reader on the box believes it (ISS-964 criterion 30)"
        );
    }

    #[test]
    fn a_frame_carrying_no_known_token_names_nobody() {
        let dir = std::env::temp_dir().join(format!("ct-{}", uuid::Uuid::new_v4()));
        let tokens = SessionTokens::at(dir.join("control-tokens.json"));
        tokens.mint("sess-a").unwrap();
        assert_eq!(tokens.session_for("forged"), None);
    }

    /// The `Request` enum's body, as source text.
    // cm:guard normalise CRLF and use `split_once`, because BOTH halves were silent failures. `str::split(..).next()` never answers `None`, so a delimiter that did not match returned the whole rest of the file and the scan below passed over `fn agent_event(.., session_id: &str)` instead of over the enum — a test that cannot fail. It only surfaced when a runner change made ci.yml's windows leg run at all; the path filter had been skipping it, and skipped is a pass to `ci-passed`.
    /// A `Control` whose ledger is in memory, so a declaration writes nowhere real.
    fn declaring_control(session_id: &str, project_id: &str) -> (Arc<Control>, String) {
        let dir = std::env::temp_dir().join(format!("ct-decl-{}", uuid::Uuid::new_v4()));
        let tokens = SessionTokens::at(dir.join("control-tokens.json"));
        let token = tokens.mint(session_id).unwrap();
        let masters = Arc::new(crate::daemon::master::Masters::new());
        masters.remember_for_test(project_id, session_id, "pane-1");
        (
            Arc::new(Control {
                tokens,
                activity: Arc::new(crate::daemon::agent_activity::Activities::new()),
                masters,
                ledger: Arc::new(std::sync::Mutex::new(Some(
                    crate::runner::ledger::Ledger::open_in_memory().unwrap(),
                ))),
                boot_id: "boot-a".into(),
            }),
            token,
        )
    }

    // cm:guard the frame is the one the CLI actually sends, byte for byte, and the op name is
    // `run_declare` rather than `run_open`: the pool's verb had that name, and a mismatch here is a
    // master whose every declaration comes back "undecodable request" (ISS-1050 criterion 1).
    #[test]
    fn a_declaration_frame_from_the_cli_decodes_with_its_project_and_group() {
        let frame = r#"{"op":"run_declare","token":"t1","projectId":"p1","issueKeys":["ISS-1","ISS-2"],"worktreePath":"/w/one"}"#;
        let req: Request = serde_json::from_str(frame).expect("the declaration frame must decode");
        let Request::RunDeclare {
            project_id,
            issue_keys,
            worktree_path,
            ..
        } = &req
        else {
            panic!("a frame whose op is `run_declare` must decode as one");
        };
        assert_eq!(project_id, "p1");
        assert_eq!(issue_keys, &["ISS-1".to_string(), "ISS-2".to_string()]);
        assert_eq!(worktree_path, "/w/one");
        assert_eq!(req.token(), "t1", "the token is what resolves the session");
    }

    #[test]
    fn a_declaration_writes_a_row_and_answers_its_id() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
        let reply = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a");
        assert!(reply.ok, "{:?}", reply.reason);
        let run_id = reply.job_id.expect("the declaration answers the row's id");
        let held = ctl.ledger.lock().unwrap();
        let run = held.as_ref().unwrap().run(&run_id).unwrap().unwrap();
        assert_eq!(run.master_session_id, "sess-a");
        assert_eq!(run.project_id.as_deref(), Some("proj-1"));
        assert!(
            run.agent_id.is_none(),
            "a declaration precedes its subagent, so the row is unbound until `SubagentStart`"
        );
        assert_eq!(
            held.as_ref()
                .unwrap()
                .issues(&run_id)
                .unwrap()
                .into_iter()
                .map(|i| i.issue_key)
                .collect::<Vec<_>>(),
            ["ISS-1"]
        );
    }

    // cm:guard the refusal must name the project this pane ACTUALLY serves. A master that typed the
    // wrong project is the only caller that ever sees this, and what it needs is the right answer
    // rather than a rejection (ISS-1050 criterion 7).
    #[test]
    fn a_declaration_for_a_project_this_pane_is_not_master_of_is_refused_and_writes_nothing() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
        let reply = run_declare(&ctl, "proj-OTHER", &["ISS-1".into()], "/w/one", "sess-a");
        assert!(!reply.ok);
        let why = reply.reason.unwrap_or_default();
        assert!(
            why.contains("proj-1") && why.contains("proj-OTHER"),
            "the refusal must name both the project asked for and the one this pane serves: {why}"
        );
        assert!(
            ctl.ledger
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .declared_without_session("boot-a")
                .unwrap()
                .is_empty(),
            "a refused declaration writes no row"
        );
    }

    // cm:guard `Masters` is an in-process optimisation and a daemon restart empties it while every
    // master is still running, so a declaration in that window has to be REFUSED and told the
    // window closes on its own. Serving it from the frame's own claim would let a pane on one
    // project open a run over another's issue (ISS-1050 criterion 7).
    #[test]
    fn a_pane_this_daemon_has_not_yet_adopted_is_refused_and_told_the_window_closes_itself() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
        let reply = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-UNKNOWN");
        assert!(!reply.ok);
        let why = reply.reason.unwrap_or_default();
        assert!(
            why.contains("sweep"),
            "a master told only `refused` would stop declaring; it has to know the next sweep fixes this: {why}"
        );
    }

    // cm:guard the ledger's own refusal text reaches the master WHOLE. It names the row to close,
    // and a handler that replaced it with one word of its own would leave the pane with a refusal
    // it cannot act on (ISS-1050 criterion 2).
    #[test]
    fn a_second_declaration_while_one_is_unbound_is_refused_naming_the_pending_row() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
        let first = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a");
        let pending = first.job_id.unwrap();
        let second = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/two", "sess-a");
        assert!(!second.ok);
        let why = second.reason.unwrap_or_default();
        assert!(
            why.contains(&pending) && why.contains("no subagent has bound it"),
            "the refusal must name the pending row: {why}"
        );
    }

    #[test]
    fn a_master_closing_its_own_unbound_declaration_may_declare_again() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
        let first = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a");
        let run_id = first.job_id.unwrap();
        assert!(run_close(&ctl, &run_id, Some("it never started"), "sess-a").ok);
        let again = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/two", "sess-a");
        assert!(again.ok, "{:?}", again.reason);
    }

    // cm:guard a close keyed on the run id ALONE would let any pane on this box end another
    // master's run, and the close is what releases its issues.
    #[test]
    fn one_master_cannot_close_another_masters_run() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
        let run_id = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a")
            .job_id
            .unwrap();
        let reply = run_close(&ctl, &run_id, None, "sess-b");
        assert!(!reply.ok);
        assert!(reply.reason.unwrap_or_default().contains("another master"));
        assert!(
            ctl.ledger
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .run(&run_id)
                .unwrap()
                .unwrap()
                .ended_by
                .is_none(),
            "a refused close ends nothing"
        );
    }

    #[test]
    fn a_subagent_starting_binds_the_row_its_master_declared_and_stopping_ends_it() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
        let run_id = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a")
            .job_id
            .unwrap();
        bind_or_release(
            &ctl,
            crate::daemon::agent_activity::Event::SubagentStarted,
            Some("child-1"),
            "sess-a",
        );
        assert_eq!(
            ctl.ledger
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .run(&run_id)
                .unwrap()
                .unwrap()
                .agent_id
                .as_deref(),
            Some("child-1")
        );
        bind_or_release(
            &ctl,
            crate::daemon::agent_activity::Event::SubagentStopped,
            Some("child-1"),
            "sess-a",
        );
        let run = ctl
            .ledger
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .run(&run_id)
            .unwrap()
            .unwrap();
        assert_eq!(run.ended_by.as_deref(), Some("subagent"));
    }

    // cm:guard a master dispatches subagents this box knows nothing about — a search, a review,
    // anything it did not declare — and every one of them reaches this path. None may bind a row
    // and none may end one, and none may fail the hook that carried it.
    #[test]
    fn a_subagent_answering_to_no_declared_run_binds_nothing_and_ends_nothing() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
        bind_or_release(
            &ctl,
            crate::daemon::agent_activity::Event::SubagentStarted,
            Some("stranger"),
            "sess-a",
        );
        bind_or_release(
            &ctl,
            crate::daemon::agent_activity::Event::SubagentStopped,
            Some("stranger"),
            "sess-a",
        );
        assert!(ctl
            .ledger
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .run_for_agent("stranger")
            .unwrap()
            .is_none());
    }

    fn request_enum_body() -> String {
        let src = include_str!("control.rs").replace("\r\n", "\n");
        let after = src
            .split_once("enum Request {")
            .expect("the Request enum must be findable")
            .1
            .to_string();
        after
            .split_once("\n}\n")
            .expect("the Request enum must be closed by a `}` in column 0")
            .0
            .to_string()
    }

    // cm:guard scans the source rather than the types, because the claim is about what CANNOT be written: a variant that reintroduces `session_id` compiles, passes every behavioural test, and silently restores the weakness (ISS-964 criterion 31).
    #[test]
    fn no_frame_declares_a_session_and_every_frame_carries_a_token() {
        let body = request_enum_body();
        assert!(
            !body.contains("session_id:"),
            "the daemon must map token -> session and ignore any session named on the frame; a declared id here is the weakness ISS-964 criterion 29 removes"
        );
        let variants = body.matches("#[serde(rename_all = \"camelCase\")]").count();
        assert_eq!(
            body.matches("token: String").count(),
            variants,
            "every verb on this socket acts on a session, so every frame needs the capability — one variant without it is a way in for all of them (ISS-964 criterion 31)"
        );
    }

    // cm:guard the seven names below are the POOL's, and none of them may come back. `RunOpen` is on that list and stays on it: ISS-1050 added a declaration to this socket and deliberately did not call it that, because the pool's `run_open` took a job from a queue and started a process while this one writes a row and starts nothing, and two different things under one name is how the distinction gets lost by the next reader rather than by this one.
    // cm:guard what this test asserts is the absence of a QUEUE verb, not the absence of a second variant. The premise it used to rest on — that the lease on the issue is the whole record of a run — was false from 2026-09-13 and is what ISS-1050 exists to fix; the caution it encodes is not, and is kept.
    #[test]
    fn the_socket_offers_no_verb_that_acts_on_work() {
        let body = request_enum_body();
        for gone in [
            "Prepare", "Start", "Discard", "Release", "RunOpen", "Ask", "Decide",
        ] {
            assert!(
                !body.contains(gone),
                "`{gone}` is a pool verb: a run is a subagent in the master's own session, and this socket may record what one was handed but may never select work or start a process. A declaration is `RunDeclare`."
            );
        }
    }
}
