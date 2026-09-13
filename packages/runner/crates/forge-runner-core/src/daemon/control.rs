//! The local socket a session on this box talks to, and why it carries one verb.
//!
//! It used to be how a master claimed work: `prepare`, `start`, `discard`,
//! `release`, `run_open`, `ask`, `decide` — a job pool reached through a unix
//! socket so the claim and the spawn happened in one process. None of that
//! exists now. A run is a subagent the master dispatches inside its own
//! session, and the lease `forge claim` takes on the issue is the whole record
//! of it, so there is nothing on this box left to claim, hold or hand back.
//!
//! What survives is the one verb that never acted: a session telling the daemon
//! what its own hooks just reported. It takes no run id, claims nothing and
//! releases nothing — the authority a session has over its own state, and
//! nothing wider.

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
}

impl Request {
    fn token(&self) -> &str {
        match self {
            Request::AgentEvent { token, .. } => token,
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
// cm:guard the socket reports and does not act, so this holds no core client, no repo lock and no runner. Re-adding one is how a verb that acts gets written next: there would be something here to act WITH.
pub struct Control {
    /// Which session is on the other end of a frame.
    pub tokens: SessionTokens,
    /// What each session's hooks have reported about itself.
    pub activity: Arc<crate::daemon::agent_activity::Activities>,
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
    }
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
        } = &req;
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
        let Request::AgentEvent { at_ms, .. } = &req;
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
        let Request::AgentEvent { token, .. } = &req;
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

    fn source() -> String {
        include_str!("control.rs").to_string()
    }

    // cm:guard scans the source rather than the types, because the claim is about what CANNOT be written: a variant that reintroduces `session_id` compiles, passes every behavioural test, and silently restores the weakness (ISS-964 criterion 31).
    #[test]
    fn no_frame_declares_a_session_and_every_frame_carries_a_token() {
        let src = source();
        let body = src
            .split("enum Request {")
            .nth(1)
            .and_then(|s| s.split("\n}\n").next())
            .expect("the Request enum must be findable");
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

    // cm:guard the socket carries REPORTS and nothing else now that the pool is gone. A verb that acts — claiming, starting, parking, releasing — is a second record of a run beside the lease on the issue, which is the split this runner was rebuilt to remove.
    #[test]
    fn the_socket_offers_no_verb_that_acts_on_work() {
        let src = source();
        let body = src
            .split("enum Request {")
            .nth(1)
            .and_then(|s| s.split("\n}\n").next())
            .expect("the Request enum must be findable");
        for gone in [
            "Prepare", "Start", "Discard", "Release", "RunOpen", "Ask", "Decide",
        ] {
            assert!(
                !body.contains(gone),
                "`{gone}` is a pool verb: a run is a subagent in the master's own session now, and the lease `forge claim` takes on the issue is the whole record of it"
            );
        }
    }
}
