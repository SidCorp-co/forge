//! The local socket a session on this box talks to, and why it carries one verb.
//!
//! It used to be how a master claimed work: `prepare`, `start`, `discard`,
//! `release`, `run_open`, `ask`, `decide` — a job pool reached through a unix
//! socket so the claim and the spawn happened in one process. None of that
//! exists now. A run is a subagent the master dispatches inside its own
//! session, so there is nothing on this box left to claim, hold or hand back.
//! This paragraph used to end "and the lease `forge claim` takes on the issue
//! is the whole record of it". That stopped being true on 2026-09-13, when a
//! declaration became the record of what was handed out; the sentence stood
//! here unread until ISS-1094.
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

mod client;
pub use client::*;
#[cfg(unix)]
mod hooks;
#[cfg(unix)]
mod runs;
pub const RESUME_CHOICES: &[&str] = &["continue", "restart", "leave"];
#[cfg(unix)]
use hooks::*;
#[cfg(unix)]
use runs::*;

#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};

#[cfg(unix)]
use crate::session_tokens::Holder;
use crate::session_tokens::SessionTokens;

pub fn socket_path() -> Option<PathBuf> {
    Some(
        runner_platform::config::base_dir()
            .ok()?
            .join("control.sock"),
    )
}

/// What a hook payload names beside its event, carried from the pane's hook to
/// the daemon as one value, so a field the payload gains is added in one place.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct HookNames {
    /// `agent_id` for a child event; `teammate_name` on `TeammateIdle`.
    pub agent_id: Option<String>,
    /// Claude Code's own `session_id` — the conversation, not Forge's session.
    pub conversation_id: Option<String>,
    pub agent_type: Option<String>,
    /// Claude Code's own `transcript_path`.
    pub transcript_path: Option<String>,
}

#[cfg(unix)]
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    #[serde(rename_all = "camelCase")]
    AgentEvent {
        token: String,
        event: String,
        #[serde(default)]
        at_ms: Option<i64>,
        #[serde(default)]
        agent_id: Option<String>,
        /// Claude Code's own `session_id` — which conversation these claims belong to.
        #[serde(default)]
        conversation_id: Option<String>,
        #[serde(default)]
        agent_type: Option<String>,
        /// Claude Code's own `transcript_path` — where that conversation is written.
        #[serde(default)]
        transcript_path: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RunDeclare {
        token: String,
        project_id: String,
        issue_keys: Vec<String>,
        worktree_path: String,
    },
    #[serde(rename_all = "camelCase")]
    RunChoice {
        token: String,
        run_id: String,
        /// `continue`, `restart` or `leave`, and nothing else.
        choice: String,
        /// Why, in the master's own words. Stored and printed, never parsed.
        why: String,
    },
    #[serde(rename_all = "camelCase")]
    DispatchGate {
        token: String,
        #[serde(default)]
        agent_id: Option<String>,
        #[serde(default)]
        subagent_type: Option<String>,
        #[serde(default)]
        tool_use_id: Option<String>,
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

#[cfg(unix)]
impl Request {
    fn token(&self) -> &str {
        match self {
            Request::AgentEvent { token, .. }
            | Request::RunDeclare { token, .. }
            | Request::RunChoice { token, .. }
            | Request::DispatchGate { token, .. }
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

#[cfg(unix)]
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

pub struct Control {
    /// Which session is on the other end of a frame.
    pub tokens: SessionTokens,
    /// What each session's hooks have reported about itself.
    pub activity: Arc<runner_core::agent_activity::Activities>,
    /// Which project each live master pane serves, for bounding a declaration.
    pub masters: Arc<crate::master::Masters>,
    pub ledger: Arc<std::sync::Mutex<Option<runner_core::ledger::Ledger>>>,
    /// The boot this daemon is in, which scopes every row it writes.
    pub boot_id: String,
    pub config_dir: Option<PathBuf>,
    pub promises: std::sync::Mutex<GateMemory>,
    /// Whether this daemon is admitting new runs at all.
    pub drain: Arc<crate::drain::Drain>,
    /// The box's process table, read for the Claude Code process above
    /// whatever connects, which is the process a subagent runs in.
    pub hosts: Arc<dyn runner_platform::subagent_host::Hosts>,
}

#[derive(Default)]
pub struct GateMemory {
    /// Which tool call each pending declaration has been promised to. The
    /// gate reads it only over the control socket, which is unix's.
    #[cfg(unix)]
    promised: std::collections::HashMap<String, String>,
    #[cfg(unix)]
    allowed: std::collections::HashSet<String>,
}

pub const HOOKS_CAN_REPORT: bool = cfg!(unix);

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
    // The process on the far end, read off the socket rather than taken from
    // the frame, so a report cannot name a process it is not running under.
    let peer = stream
        .peer_cred()
        .ok()
        .and_then(|c| c.pid())
        .and_then(|p| u32::try_from(p).ok());
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).await.is_err() {
        return;
    }
    let reply = match serde_json::from_str::<Request>(&line) {
        Ok(req) => match caller_of(&ctl, req.token()) {
            Some((holder, session_id)) => serve_request(&ctl, req, &holder, &session_id, peer),
            None => ClaimReply::refused("unknown_token"),
        },
        Err(e) => ClaimReply::refused(format!("undecodable request: {e}")),
    };
    let mut out = serde_json::to_string(&reply).unwrap_or_else(|_| "{\"ok\":false}".into());
    out.push('\n');
    let _ = reader.get_mut().write_all(out.as_bytes()).await;
}

/// Who a frame's token was minted for, and the session the frame acts under.
///
/// A capability carrying its record acts under the session this daemon holds
/// for the record's project where this daemon's master pane for that project
/// is the record's pane: core can replace the row a pane was placed under, and
/// the daemon then holds the new one, which is the session every run, close and
/// choice on this box is keyed by (ISS-1316). The record itself is never
/// rewritten — what moves is which session this daemon serves the pane under.
/// Anywhere else, and for a capability minted before the record, the frame acts
/// under the session the capability names.
#[cfg(unix)]
fn caller_of(ctl: &Control, token: &str) -> Option<(Holder, String)> {
    let holder = ctl.tokens.resolve(token)?;
    let session = acting_session(&ctl.masters, &holder);
    Some((holder, session))
}

#[cfg(unix)]
pub(crate) fn acting_session(masters: &crate::master::Masters, holder: &Holder) -> String {
    match holder {
        Holder::Minted(m) => match masters.live_for_project(&m.project) {
            Some((session, pane)) if pane == m.pane => session,
            _ => m.session.clone(),
        },
        Holder::Legacy { session } => session.clone(),
    }
}

/// Whether `named` is the project a record was minted for, by the id or by the
/// slug the record carries — `--project` is what an operator types, and both
/// name one project (a slug compared against an id refused a pane minted for
/// that very project).
#[cfg(unix)]
fn names_minted_project(m: &crate::session_tokens::Minted, named: &str) -> bool {
    m.project == named || m.slug.as_deref() == Some(named)
}

/// Which project a declaring caller is the master for, or why it is none.
///
/// A record bounds it by itself: the project it was minted for, and only while
/// this daemon's master pane for that project is the pane it was minted for, so
/// a capability handed to a job pane of the same project declares nothing. The
/// declared project is compared against the record and never read off the
/// frame (ISS-1050 criterion 7, re-established here by ISS-1316). A capability
/// minted before the record keeps the bound it always had.
#[cfg(unix)]
fn declaring_project(
    masters: &crate::master::Masters,
    holder: &Holder,
    project_id: &str,
    session_id: &str,
) -> Result<String, String> {
    match holder {
        Holder::Minted(m) => {
            if !names_minted_project(m, project_id) {
                let known = m
                    .slug
                    .as_deref()
                    .map_or_else(|| m.project.clone(), |s| format!("{s} ({})", m.project));
                return Err(format!(
                    "this pane's capability was minted for pane {} as the master for {known}, and cannot declare a run for {project_id} — `--project` takes this project's id or its slug and no other. Nothing was recorded",
                    m.pane
                ));
            }
            match masters.live_for_project(&m.project) {
                Some((_, pane)) if pane == m.pane => Ok(m.project.clone()),
                Some((_, pane)) => Err(format!(
                    "this box's master for {} is pane {pane}, and your capability was minted for pane {} — only the project's master pane declares its runs. Nothing was recorded",
                    m.project, m.pane
                )),
                None => Err(masters.why_unplaced(&m.project)),
            }
        }
        Holder::Legacy { .. } => masters
            .project_for_session(session_id)
            .ok_or_else(|| masters.why_unplaced(project_id)),
    }
}

#[cfg(unix)]
fn serve_request(
    ctl: &Arc<Control>,
    req: Request,
    holder: &Holder,
    session_id: &str,
    peer: Option<u32>,
) -> ClaimReply {
    match req {
        Request::AgentEvent {
            event,
            at_ms,
            agent_id,
            conversation_id,
            agent_type,
            transcript_path,
            ..
        } => agent_event(
            ctl,
            &event,
            at_ms,
            &HookNames {
                agent_id,
                conversation_id,
                agent_type,
                transcript_path,
            },
            session_id,
            peer,
        ),
        Request::RunDeclare {
            project_id,
            issue_keys,
            worktree_path,
            ..
        } => run_declare_as(
            ctl,
            holder,
            &project_id,
            &issue_keys,
            &worktree_path,
            session_id,
            peer,
        ),
        Request::RunChoice {
            run_id,
            choice,
            why,
            ..
        } => run_choice(ctl, &run_id, &choice, &why, session_id),
        Request::DispatchGate {
            agent_id,
            subagent_type,
            tool_use_id,
            ..
        } => dispatch_gate_reply(
            ctl,
            runner_core::dispatch_gate::Dispatch {
                agent_id,
                subagent_type,
                tool_use_id,
            },
            session_id,
        ),
        Request::RunClose { run_id, reason, .. } => {
            run_close(ctl, &run_id, reason.as_deref(), session_id)
        }
    }
}
