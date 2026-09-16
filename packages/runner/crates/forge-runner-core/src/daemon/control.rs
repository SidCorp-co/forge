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
pub fn socket_path() -> Option<PathBuf> {
    let cfg = Config::path().ok()?;
    Some(cfg.with_file_name("control.sock"))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    /// What this session's own hooks say it is doing (turn boundaries).
    #[serde(rename_all = "camelCase")]
    AgentEvent {
        token: String,
        event: String,
        #[serde(default)]
        at_ms: Option<i64>,
        /// The child this event is about: `agent_id`, or `teammate_name` on `TeammateIdle`.
        #[serde(default)]
        agent_id: Option<String>,
        /// Claude Code's own `session_id` — which conversation these claims belong to.
        #[serde(default)]
        conversation_id: Option<String>,
    },
    /// "I am about to hand these issues to a subagent."
    #[serde(rename_all = "camelCase")]
    RunDeclare {
        token: String,
        project_id: String,
        issue_keys: Vec<String>,
        worktree_path: String,
    },
    /// "I have decided what to do about a run I inherited when this pane was resumed."
    #[serde(rename_all = "camelCase")]
    RunChoice {
        token: String,
        run_id: String,
        /// `continue`, `restart` or `leave`, and nothing else.
        choice: String,
        /// Why, in the master's own words. Stored and printed, never parsed.
        why: String,
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
            | Request::RunChoice { token, .. }
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
pub struct Control {
    /// Which session is on the other end of a frame.
    pub tokens: SessionTokens,
    /// What each session's hooks have reported about itself.
    pub activity: Arc<crate::daemon::agent_activity::Activities>,
    /// Which project each live master pane serves, for bounding a declaration.
    pub masters: Arc<crate::daemon::master::Masters>,
    /// This box's own registry of what its masters have handed out.
    pub ledger: Arc<std::sync::Mutex<Option<crate::runner::ledger::Ledger>>>,
    /// The boot this daemon is in, which scopes every row it writes.
    pub boot_id: String,
}

/// Serve until `cancel` flips.
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
    note_master_pane(ctl, session_id, conversation_id);
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

/// The three words a resumed master may write about a run it inherited.
pub const RESUME_CHOICES: &[&str] = &["continue", "restart", "leave"];

/// Record what a resumed master decided about one run it inherited.
///
/// Writes a word and a reason. Starts nothing, kills nothing, reopens nothing.
fn run_choice(
    ctl: &Arc<Control>,
    run_id: &str,
    choice: &str,
    why: &str,
    session_id: &str,
) -> ClaimReply {
    if !RESUME_CHOICES.contains(&choice) {
        return ClaimReply::refused(format!(
            "`{choice}` is not one of the three choices a resumed master may record: {}",
            RESUME_CHOICES.join(", ")
        ));
    }
    if why.trim().is_empty() {
        return ClaimReply::refused(
            "a choice needs its reason — say why in your own words, because the record is what the next reader has",
        );
    }
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else {
        return ClaimReply::refused("this daemon has no ledger open, so it can record nothing");
    };
    match led.record_resume_choice(run_id, session_id, choice, why) {
        Ok(true) => {
            tracing::info!("[control] run {run_id}: this master chose to {choice} — {why}");
            ClaimReply {
                ok: true,
                job_id: Some(run_id.to_string()),
                agent_session_id: Some(session_id.to_string()),
                issue_key: None,
                reason: Some(choice.to_string()),
            }
        }
        Ok(false) => ClaimReply::refused(format!(
            "run {run_id} is not one this pane inherited, so it is not this pane's to answer for"
        )),
        Err(e) => ClaimReply::refused(e.to_string()),
    }
}

/// Record that a master is about to hand these issues to a subagent.
///
/// Writes a row and answers its id. Starts nothing, selects nothing, and moves
/// no issue's status.
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
    if let Some(bad) = issue_keys.iter().find(|k| !is_issue_key(k)) {
        return ClaimReply::refused(format!(
            "`{bad}` is not an issue reference — a declaration takes one per issue the subagent is being given, each a display id such as `ISS-42` or your project's own prefix, or the bare number. Nothing was recorded"
        ));
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else {
        return ClaimReply::refused("this daemon has no ledger open, so it can record nothing");
    };
    match led.runs_awaiting_choice(session_id, &ctl.boot_id) {
        Ok(pending) if !pending.is_empty() => {
            let names: Vec<String> = pending
                .iter()
                .map(|r| {
                    let keys = led
                        .issues(&r.run_id)
                        .map(|m| {
                            m.iter()
                                .map(|i| i.issue_key.clone())
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    format!("{} ({keys})", r.run_id)
                })
                .collect();
            return ClaimReply::refused(format!(
                "this pane was resumed holding {} run(s) it has not answered for yet: {}. Say what happens to each — `continue`, `restart` or `leave`, with your reason — before declaring new work.",
                pending.len(),
                names.join("; ")
            ));
        }
        Ok(_) => {}
        Err(e) => {
            return ClaimReply::refused(format!("cannot read this pane's inherited runs: {e}"));
        }
    }
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
        Err(e) => ClaimReply::refused(e.to_string()),
    }
}

/// Whether a string is shaped like an issue reference core will parse.
fn is_issue_key(s: &str) -> bool {
    let body = match s.split_once('-') {
        Some((prefix, rest)) => {
            let len = prefix.chars().count();
            if !(2..=6).contains(&len) || !prefix.chars().all(|c| c.is_ascii_alphanumeric()) {
                return false;
            }
            if !prefix
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
            {
                return false;
            }
            rest
        }
        None => s,
    };
    !body.is_empty() && body.len() <= 10 && body.chars().all(|c| c.is_ascii_digit())
}

/// Record that a declared run is over, whether it ran or never started.
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
        Event::SubagentStarted => match led.unbound_run_for_master(session_id, &ctl.boot_id) {
            Ok(Some(run)) => match led.bind_agent(&run.run_id, child) {
                Ok(true) => tracing::info!("[control] run {} is subagent {child}", run.run_id),
                Ok(false) => tracing::debug!(
                    "[control] run {} was already bound when {child} started",
                    run.run_id
                ),
                Err(e) => tracing::warn!("[control] cannot bind {child}: {e}"),
            },
            Ok(None) => {
                tracing::debug!("[control] subagent {child} answers to no declared run")
            }
            Err(e) => tracing::warn!("[control] cannot read declared runs: {e}"),
        },
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

/// Keep the ledger's `masters` row current for the pane this event came from.
///
/// This is the only writer of that row, and what it stores is what a rebuilt
/// pane is resumed from.
#[cfg(unix)]
fn note_master_pane(ctl: &Arc<Control>, session_id: &str, conversation_id: Option<&str>) {
    let Some(project_id) = ctl.masters.project_for_session(session_id) else {
        return;
    };
    let Some(pane) = ctl.masters.pane_for_session(session_id) else {
        return;
    };
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else { return };
    if let Err(e) = led.note_master(&project_id, &pane, conversation_id, &ctl.boot_id) {
        tracing::warn!("[control] cannot record {project_id}'s master pane: {e}");
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
        Request::RunChoice {
            run_id,
            choice,
            why,
            ..
        } => run_choice(ctl, &run_id, &choice, &why, session_id),
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

    #[test]
    fn a_refusal_carries_a_reason_and_no_job() {
        let out = serde_json::to_string(&ClaimReply::refused("unknown_event: Nope")).unwrap();
        assert!(out.contains("\"reason\":\"unknown_event: Nope\""));
        assert!(!out.contains("jobId"));
        assert!(out.contains("\"ok\":false"));
    }

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

    /// The `Request` enum's body, as source text.
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

    /// The half of this socket that only exists on a unix box.
    ///
    #[cfg(unix)]
    mod unix {
        use super::*;

        #[test]
        fn a_choice_outside_the_three_words_is_refused_naming_them() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
            let run_id = declared_and_inherited(&ctl, "proj-1", "sess-a");

            let reply = run_choice(&ctl, &run_id, "contineu", "typo", "sess-a");

            assert!(!reply.ok);
            let reason = reply.reason.unwrap_or_default();
            for word in RESUME_CHOICES {
                assert!(reason.contains(word), "say what is valid: {reason}");
            }
        }

        #[test]
        fn a_choice_with_no_reason_is_refused() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
            let run_id = declared_and_inherited(&ctl, "proj-1", "sess-a");

            let reply = run_choice(&ctl, &run_id, "leave", "   ", "sess-a");

            assert!(!reply.ok, "a choice needs its reason");
        }

        #[test]
        fn a_pane_cannot_answer_for_a_run_it_did_not_inherit() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
            let run_id = declared_and_inherited(&ctl, "proj-1", "sess-a");

            let reply = run_choice(&ctl, &run_id, "leave", "not mine", "some-other-session");

            assert!(
                !reply.ok,
                "another pane's run is not this pane's to answer for"
            );
        }

        #[test]
        fn a_frame_carrying_no_known_token_names_nobody() {
            let dir = std::env::temp_dir().join(format!("ct-{}", uuid::Uuid::new_v4()));
            let tokens = SessionTokens::at(dir.join("control-tokens.json"));
            tokens.mint("sess-a").unwrap();
            assert_eq!(tokens.session_for("forged"), None);
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
        /// Declare a run, then mark it the way a resume does: owed a choice.
        fn declared_and_inherited(
            ctl: &Arc<Control>,
            project_id: &str,
            session_id: &str,
        ) -> String {
            let run_id = run_declare(ctl, project_id, &["ISS-7".into()], "/w/seven", session_id)
                .job_id
                .expect("declared");
            let mut held = ctl.ledger.lock().unwrap();
            let led = held.as_mut().unwrap();
            // bind and end nothing: this is a run left open, which is what a resume inherits
            led.owe_resume_choices(session_id, &ctl.boot_id).unwrap();
            run_id
        }
        #[test]
        fn a_key_that_is_not_an_issue_key_is_refused_by_name_and_writes_no_row() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");

            let reply = run_declare(
                &ctl,
                "proj-1",
                &["ISS-7".into(), "the whole backlog".into()],
                "/w/seven",
                "sess-a",
            );

            assert!(
                !reply.ok,
                "a declaration carrying a non-key must be refused"
            );
            let reason = reply.reason.unwrap_or_default();
            assert!(
                reason.contains("the whole backlog"),
                "the refusal must name the value it refused: {reason}"
            );
            assert!(
                reason.contains("ISS-"),
                "and the shape it wanted instead: {reason}"
            );
            let mut held = ctl.ledger.lock().unwrap();
            let led = held.as_mut().unwrap();
            assert!(
                led.unclosed_runs().unwrap().is_empty(),
                "a refused declaration writes nothing, or the box holds a run core will never open"
            );
        }

        #[test]
        fn a_project_own_prefix_and_a_bare_number_are_references_the_box_does_not_refuse() {
            for good in ["ISS-42", "FD-977", "42", "ab-1"] {
                assert!(
                    super::is_issue_key(good),
                    "`{good}` is a reference core resolves, so the box may not refuse it"
                );
            }
            for bad in [
                "",
                "-1",
                "ISS-",
                "ISS-x",
                "the whole backlog",
                "a-1",
                "TOOLONGP-1",
                "ISS-12345678901",
            ] {
                assert!(!super::is_issue_key(bad), "`{bad}` is not a reference");
            }
        }

        #[test]
        fn a_resumed_pane_cannot_declare_new_work_before_answering_for_what_it_inherited() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
            declared_and_inherited(&ctl, "proj-1", "sess-a");

            let reply = run_declare(&ctl, "proj-1", &["ISS-8".into()], "/w/eight", "sess-a");

            assert!(!reply.ok, "the declaration must be refused");
            let reason = reply.reason.unwrap_or_default();
            assert!(reason.contains("ISS-7"), "name the run's issues: {reason}");
            assert!(
                reason.contains("continue"),
                "name the three words: {reason}"
            );
        }
        #[test]
        fn once_every_inherited_run_is_answered_for_the_next_declaration_is_allowed() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
            let run_id = declared_and_inherited(&ctl, "proj-1", "sess-a");

            let choice = run_choice(&ctl, &run_id, "restart", "the branch is empty", "sess-a");
            assert!(choice.ok, "{:?}", choice.reason);
            // The pre-existing one-unbound-row rule is a separate gate; bind this one so the assertion
            // below is about the resume gate and not about that.
            bind_or_release(
                &ctl,
                crate::daemon::agent_activity::Event::SubagentStarted,
                Some("child-1"),
                "sess-a",
            );

            let reply = run_declare(&ctl, "proj-1", &["ISS-8".into()], "/w/eight", "sess-a");
            assert!(reply.ok, "{:?}", reply.reason);
        }
        #[test]
        fn a_pane_that_was_never_resumed_declares_freely() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
            let first = run_declare(&ctl, "proj-1", &["ISS-7".into()], "/w/seven", "sess-a");
            assert!(first.ok, "{:?}", first.reason);
            bind_or_release(
                &ctl,
                crate::daemon::agent_activity::Event::SubagentStarted,
                Some("child-1"),
                "sess-a",
            );

            let second = run_declare(&ctl, "proj-1", &["ISS-8".into()], "/w/eight", "sess-a");

            assert!(second.ok, "{:?}", second.reason);
        }
        #[test]
        fn a_master_pane_event_puts_that_pane_and_its_conversation_in_the_ledger() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");

            agent_event(&ctl, "Stop", None, None, Some("conv-abc"), "sess-a");

            let held = ctl.ledger.lock().unwrap();
            let row = held
                .as_ref()
                .unwrap()
                .master_for_project("proj-1")
                .unwrap()
                .expect("the master row a resume reads");
            assert_eq!(row.pane_name, "pane-1");
            assert_eq!(row.conversation_id.as_deref(), Some("conv-abc"));
        }
        #[test]
        fn an_event_without_a_conversation_leaves_the_stored_one_alone() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");

            agent_event(&ctl, "Stop", None, None, Some("conv-abc"), "sess-a");
            agent_event(&ctl, "Stop", None, None, None, "sess-a");

            let held = ctl.ledger.lock().unwrap();
            let row = held
                .as_ref()
                .unwrap()
                .master_for_project("proj-1")
                .unwrap()
                .expect("the master row");
            assert_eq!(
                row.conversation_id.as_deref(),
                Some("conv-abc"),
                "the only thing a resume can be built from may not be erased by an event that carries none"
            );
        }
        #[test]
        fn a_session_that_is_not_a_registered_master_writes_no_row() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");

            agent_event(
                &ctl,
                "Stop",
                None,
                None,
                Some("conv-zzz"),
                "some-other-session",
            );

            let held = ctl.ledger.lock().unwrap();
            let row = held.as_ref().unwrap().master_for_project("proj-1").unwrap();
            assert!(
                row.is_none(),
                "an unregistered session is not a master pane: {row:?}"
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
        #[test]
        fn a_replayed_start_from_a_child_already_bound_never_takes_the_next_row() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
            let run_a = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a")
                .job_id
                .unwrap();
            let start = crate::daemon::agent_activity::Event::SubagentStarted;
            bind_or_release(&ctl, start, Some("child-a"), "sess-a");
            let run_b = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/two", "sess-a")
                .job_id
                .unwrap();
            bind_or_release(&ctl, start, Some("child-a"), "sess-a");
            let held = ctl.ledger.lock().unwrap();
            let led = held.as_ref().unwrap();
            assert_eq!(
                led.run(&run_a).unwrap().unwrap().agent_id.as_deref(),
                Some("child-a")
            );
            assert!(
                led.run(&run_b).unwrap().unwrap().agent_id.is_none(),
                "the row declared for the next subagent must still be waiting for it"
            );
            assert_eq!(led.run_for_agent("child-a").unwrap().unwrap().run_id, run_a);
        }
        #[test]
        fn a_start_replayed_after_its_own_run_ended_takes_no_other_row() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
            let run_a = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a")
                .job_id
                .unwrap();
            let start = crate::daemon::agent_activity::Event::SubagentStarted;
            bind_or_release(&ctl, start, Some("child-a"), "sess-a");
            bind_or_release(
                &ctl,
                crate::daemon::agent_activity::Event::SubagentStopped,
                Some("child-a"),
                "sess-a",
            );
            let run_b = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/two", "sess-a")
                .job_id
                .unwrap();
            bind_or_release(&ctl, start, Some("child-a"), "sess-a");
            let held = ctl.ledger.lock().unwrap();
            assert!(
                held.as_ref()
                    .unwrap()
                    .run(&run_b)
                    .unwrap()
                    .unwrap()
                    .agent_id
                    .is_none(),
                "a name already spent on a closed run cannot claim a new one"
            );
            let _ = run_a;
        }
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
    }
}
