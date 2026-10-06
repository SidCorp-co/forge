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
use crate::daemon::session_tokens::Holder;
use crate::daemon::session_tokens::SessionTokens;

pub fn socket_path() -> Option<PathBuf> {
    Some(crate::config::base_dir().ok()?.join("control.sock"))
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

#[cfg(any(unix, test))]
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
        #[serde(default)]
        resumes: Option<String>,
        #[serde(default)]
        transcript_path: Option<String>,
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

#[cfg(any(unix, test))]
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

#[cfg(any(unix, test))]
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
    pub activity: Arc<crate::daemon::agent_activity::Activities>,
    /// Which project each live master pane serves, for bounding a declaration.
    pub masters: Arc<crate::daemon::master::Masters>,
    pub ledger: Arc<std::sync::Mutex<Option<crate::runner::ledger::Ledger>>>,
    /// The boot this daemon is in, which scopes every row it writes.
    pub boot_id: String,
    pub config_dir: Option<PathBuf>,
    pub promises: std::sync::Mutex<GateMemory>,
    /// Whether this daemon is admitting new runs at all.
    pub drain: Arc<crate::daemon::drain::Drain>,
    /// The box's process table, read for the Claude Code process above
    /// whatever connects, which is the process a subagent runs in.
    pub hosts: Arc<dyn crate::daemon::subagent_host::Hosts>,
}

#[derive(Default)]
pub struct GateMemory {
    /// Which tool call each pending declaration has been promised to. The
    /// gate reads it only over the control socket, which is unix's.
    #[cfg(unix)]
    promised: std::collections::HashMap<String, Promise>,
    #[cfg(unix)]
    allowed: std::collections::HashSet<String>,
    /// Subagents a master resumed with `SendMessage` whose `SubagentStart`
    /// has not been heard yet: a resume fires one too, and what it says of
    /// the subagent is that it was resumed, not that it started.
    #[cfg(unix)]
    resumed: std::collections::HashSet<String>,
    /// The last role inventory this daemon read whole, kept for the sweep
    /// that cannot read one: what decides which dispatch an unread
    /// inventory's promise may go to (ISS-1390 review F2).
    #[cfg(unix)]
    last_roles: Option<std::collections::BTreeSet<String>>,
}

/// What the gate promised a pending declaration to: the tool call, and the
/// role that call dispatched through, which is the only role the subagent
/// that binds the run may start as (ISS-1378).
#[cfg(unix)]
#[derive(Debug, Clone)]
struct Promise {
    tool_use: String,
    role: Option<String>,
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
    let listener = match crate::daemon::handover::inherited_listener(&path) {
        crate::daemon::handover::Inherited::Taken(held) => {
            let listener = UnixListener::from_std(held)?;
            tracing::info!(
                "[control] listening on {}, carried across the handover from the build before this one",
                path.display()
            );
            listener
        }
        crate::daemon::handover::Inherited::Refused(why) => {
            tracing::error!(
                "[control] {} named a listener this process will not take: {why} — binding a fresh socket at {}",
                crate::daemon::handover::LISTENER_ENV,
                path.display()
            );
            bind_fresh(&path)?
        }
        crate::daemon::handover::Inherited::None => bind_fresh(&path)?,
    };
    {
        use std::os::fd::AsRawFd;
        ctl.drain
            .socket()
            .publish_listener(i64::from(listener.as_raw_fd()));
    }
    let mut accepting = ctl.drain.socket().accepting();

    loop {
        let open = *accepting.borrow_and_update();
        if !open {
            // Every accept before this read has its guard, and nothing is
            // accepted until the next read finds it open: say so, so the
            // handover's window may count what is in flight.
            ctl.drain.socket().stand_still();
        }
        tokio::select! {
            accepted = listener.accept(), if open => {
                match accepted {
                    Ok((stream, _)) => {
                        let ctl = ctl.clone();
                        let serving = ctl.drain.socket().serving();
                        tokio::spawn(async move {
                            serve_one(ctl, stream).await;
                            drop(serving);
                        });
                    }
                    Err(e) => tracing::warn!("[control] accept: {e}"),
                }
            }
            _ = accepting.changed() => {}
            _ = cancel.changed() => {
                if *cancel.borrow() { break; }
            }
        }
    }
    ctl.drain.socket().withdraw_listener();
    let _ = std::fs::remove_file(&path);
    Ok(())
}

#[cfg(unix)]
fn bind_fresh(path: &std::path::Path) -> std::io::Result<UnixListener> {
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let listener = UnixListener::bind(path)?;
    tracing::info!("[control] listening on {}", path.display());
    Ok(listener)
}

/// How long a connection may take to send its one line. A hook writes it at
/// once; a caller that does not would otherwise hold a handover's closing
/// window for its whole bound.
#[cfg(unix)]
const REQUEST_READ_BOUND: std::time::Duration = std::time::Duration::from_secs(5);

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
    match tokio::time::timeout(REQUEST_READ_BOUND, reader.read_line(&mut line)).await {
        Ok(Ok(_)) => {}
        Ok(Err(_)) => return,
        Err(_) => {
            tracing::warn!(
                "[control] a connection sent no request within {}s and was closed",
                REQUEST_READ_BOUND.as_secs()
            );
            return;
        }
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
pub(crate) fn acting_session(masters: &crate::daemon::master::Masters, holder: &Holder) -> String {
    match holder {
        Holder::Minted(m) => match masters.live_for_project(&m.project) {
            Some((session, pane)) if pane == m.pane => session,
            _ => m.session.clone(),
        },
        Holder::Legacy { session } => session.clone(),
    }
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
    masters: &crate::daemon::master::Masters,
    holder: &Holder,
    project_id: &str,
    session_id: &str,
) -> Result<String, String> {
    match holder {
        Holder::Minted(m) => {
            if m.project != project_id {
                return Err(format!(
                    "this pane's capability was minted for pane {} as the master for {}, and cannot declare a run for {project_id}. Nothing was recorded",
                    m.pane, m.project
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
fn agent_event(
    ctl: &Arc<Control>,
    event: &str,
    at_ms: Option<i64>,
    names: &HookNames,
    session_id: &str,
    peer: Option<u32>,
) -> ClaimReply {
    let agent_id = names.agent_id.as_deref();
    let conversation_id = names.conversation_id.as_deref();
    let agent_type = names.agent_type.as_deref();
    let Some(parsed) = crate::daemon::agent_activity::Event::from_wire(event) else {
        return ClaimReply::refused(format!("unknown_event: {event}"));
    };
    let at = at_ms.unwrap_or_else(crate::daemon::agent_activity::now_ms);
    let after = ctl.activity.record(
        session_id,
        crate::daemon::agent_activity::Report {
            event: parsed,
            at,
            subject: agent_id,
            conversation: conversation_id,
            transcript: names.transcript_path.as_deref(),
        },
    );
    match (parsed, agent_id) {
        (crate::daemon::agent_activity::Event::SubagentStarted, _) => {
            bind_declared(
                ctl,
                agent_id,
                agent_type,
                session_id,
                at,
                names.transcript_path.as_deref(),
            );
            note_host_of(ctl, agent_id, peer);
        }
        (crate::daemon::agent_activity::Event::SubagentStopped, Some(child)) => {
            note_subagent_stop(ctl, child, at, names.transcript_path.as_deref());
            note_host_of(ctl, Some(child), peer);
        }
        _ => {}
    }
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

pub const RESUME_CHOICES: &[&str] = &["continue", "restart", "leave"];

#[cfg(unix)]
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
    // A choice is recorded once, and core is told the one recorded: a second
    // choice answered `ok` and replaced the first with nothing said (ISS-1312).
    if let Ok(Some(run)) = led.run(run_id) {
        if let (true, Some(chosen)) = (
            run.master_session_id == session_id,
            run.resume_choice.as_deref(),
        ) {
            return ClaimReply::refused(format!(
                "run {run_id} already has `{chosen}` recorded for it: \u{ab}{}\u{bb}. A choice is recorded once, so `{choice}` changed nothing",
                run.resume_choice_why.as_deref().unwrap_or("no reason recorded")
            ));
        }
    }
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

/// A declaration as the tests make it: under the capability minted for
/// `session_id` where the map holds one, and as a pre-record capability
/// naming that session where it does not.
#[cfg(all(unix, test))]
fn run_declare(
    ctl: &Arc<Control>,
    project_id: &str,
    issue_keys: &[String],
    worktree_path: &str,
    session_id: &str,
    peer: Option<u32>,
) -> ClaimReply {
    let holder = ctl
        .tokens
        .holder_for_session(session_id)
        .unwrap_or_else(|| Holder::Legacy {
            session: session_id.to_string(),
        });
    run_declare_as(
        ctl,
        &holder,
        project_id,
        issue_keys,
        worktree_path,
        session_id,
        peer,
    )
}

#[cfg(unix)]
fn run_declare_as(
    ctl: &Arc<Control>,
    holder: &Holder,
    project_id: &str,
    issue_keys: &[String],
    worktree_path: &str,
    session_id: &str,
    peer: Option<u32>,
) -> ClaimReply {
    // First, before anything is read or written: a drain that admits a run is
    // waiting on a queue it keeps refilling (ISS-1223). The permit is held to
    // the end of this function, past the ledger write, so a drain that begins
    // meanwhile waits for this row rather than reading the box idle without it.
    let _admitted = match ctl.drain.admit() {
        Ok(permit) => permit,
        Err(closed) => return ClaimReply::refused(closed.refusal),
    };
    let serves = match declaring_project(&ctl.masters, holder, project_id, session_id) {
        Ok(serves) => serves,
        Err(why) => return ClaimReply::refused(why),
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
    // Refused here rather than trimmed to fit: the keys are what the caller
    // declared and dropping the seventeenth would be this box deciding which
    // issue the run is not about. Refused here rather than downstream because
    // core's refusal arrives at a sweep and not at this pane — one declaration
    // of 27 keys was answered `400` every twenty seconds for an hour and
    // forty-seven minutes, and the master that built it never saw one of them
    // (ISS-1284).
    let cap = crate::transport::run_sessions::MAX_ISSUE_KEYS;
    if issue_keys.len() > cap {
        return ClaimReply::refused(format!(
            "a run carries at most {cap} issues and this declaration names {}. Core refuses more by name and the refusal reaches this box's sweep rather than this pane, so the run would be opened nowhere and retried for ever. Declare the work in groups of {cap} or fewer. Nothing was recorded",
            issue_keys.len()
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
                "this pane was resumed holding {} run(s) it has not answered for yet: {}. Answer each one with `forge-runner run choice <run-id> continue|restart|leave --reason \"<why>\"` before declaring new work. Closing a run is not answering for it: the close records that the row ended, not what you decided, and a reason written there reaches no issue.",
                pending.len(),
                names.join("; ")
            ));
        }
        Ok(_) => {}
        Err(e) => {
            return ClaimReply::refused(format!("cannot read this pane's inherited runs: {e}"));
        }
    }
    let new_run = |session: &str| crate::runner::ledger::NewRun {
        run_id: run_id.clone(),
        project_id: project_id.to_string(),
        master_session_id: session.to_string(),
        worktree_path: std::path::PathBuf::from(worktree_path),
        boot_id: ctl.boot_id.clone(),
        issue_keys: issue_keys.to_vec(),
    };
    // A record's run is written while the registry is held, under the session
    // it names for the pane at that moment: an adoption between the bound
    // above and this write would otherwise leave the row under the session it
    // replaced, or let a pane that had just stopped being the master declare.
    let (recorded, written) = match holder {
        Holder::Minted(m) => {
            let under = ctl.masters.while_live(&m.project, &m.pane, |live| {
                (live.to_string(), led.create_run_group(new_run(live)))
            });
            match under {
                Some(w) => w,
                None => {
                    return ClaimReply::refused(format!(
                        "pane {} stopped being this box's master for {} while the declaration was being written. Nothing was recorded",
                        m.pane, m.project
                    ))
                }
            }
        }
        Holder::Legacy { .. } => (
            session_id.to_string(),
            led.create_run_group(new_run(session_id)),
        ),
    };
    match written {
        Ok(run) => {
            tracing::info!(
                "[control] {project_id}: run {} declared over {:?}",
                run.run_id,
                issue_keys
            );
            note_host(ctl, led, &run.run_id, peer);
            ClaimReply {
                ok: true,
                job_id: Some(run.run_id),
                agent_session_id: Some(recorded),
                issue_key: issue_keys.first().cloned(),
                reason: None,
            }
        }
        Err(e) => ClaimReply::refused(e.to_string()),
    }
}

#[cfg(unix)]
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
            // An ending is recorded once. A second close answered `ok` and
            // wrote its own reason over the first, so the row said whatever
            // the last caller typed (ISS-1312).
            if let Some(by) = run.ended_by.as_deref() {
                return ClaimReply::refused(format!(
                    "run {run_id} is already ended by {by}: \u{ab}{}\u{bb}. An ending is recorded once, so this close changed nothing",
                    run.ended_reason.as_deref().unwrap_or("no reason recorded")
                ));
            }
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

/// The directory this box's marks and its plugin clones sit in.
pub fn config_dir() -> Option<PathBuf> {
    crate::config::base_dir().ok()
}

#[cfg(unix)]
fn dispatch_gate_reply(
    ctl: &Arc<Control>,
    d: crate::daemon::dispatch_gate::Dispatch,
    session_id: &str,
) -> ClaimReply {
    use crate::daemon::dispatch_gate::{decide, Facts, Verdict, REFUSAL};

    // A resume is never refused: it starts nothing the gate counts, and the
    // subagent it reaches already exists. It is where that subagent is heard
    // to take on the work its master declared.
    if let (None, Some(child)) = (d.agent_id.as_deref(), d.resumes.as_deref()) {
        ctl.promises
            .lock()
            .expect("promises poisoned")
            .resumed
            .insert(child.to_string());
        bind_resumed(ctl, child, d.transcript_path.as_deref(), session_id);
        return gate_allows(None);
    }

    let dir = ctl.config_dir.clone();
    let roles = dir.as_deref().and_then(dispatch_gate_roles);

    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let pending = match held.as_mut() {
        Some(led) => match led.unbound_run_for_master(session_id, &ctl.boot_id) {
            Ok(run) => run.map(|r| r.run_id),
            Err(e) => {
                let why = "this box's own registry of declared runs could not be read";
                tracing::error!("[control] the dispatch gate could not decide: {why}: {e}");
                if let Some(refused) = refused_while_draining(ctl, why, None) {
                    return refused;
                }
                if let Some(dir) = dir.as_deref() {
                    crate::daemon::degraded::mark(
                        dir,
                        &crate::daemon::degraded::Mark::new(
                            crate::daemon::degraded::Kind::Degraded,
                            crate::daemon::degraded::Source::Daemon,
                            why,
                            crate::daemon::degraded::Run::Unknown(why),
                        )
                        .about(&d),
                    );
                }
                return gate_allows(Some(why));
            }
        },
        None => {
            let why = "this box holds no registry of declared runs";
            if let Some(refused) = refused_while_draining(ctl, why, None) {
                return refused;
            }
            if let Some(dir) = dir.as_deref() {
                crate::daemon::degraded::mark(
                    dir,
                    &crate::daemon::degraded::Mark::new(
                        crate::daemon::degraded::Kind::Degraded,
                        crate::daemon::degraded::Source::Daemon,
                        why,
                        crate::daemon::degraded::Run::Unknown(why),
                    )
                    .about(&d),
                );
            }
            return gate_allows(Some(why));
        }
    };
    let mut memory = ctl.promises.lock().expect("promises poisoned");
    if let Some(read) = roles.as_ref() {
        memory.last_roles = Some(read.clone());
    }

    // A tool call this daemon has already answered gets that answer again, whether
    // or not its declaration has since been bound.
    if let Some(tool_use) = d.tool_use_id.as_deref() {
        if memory.allowed.contains(tool_use) {
            return gate_allows(None);
        }
    }

    let promised = pending
        .as_deref()
        .and_then(|run| memory.promised.get(run).map(|p| p.tool_use.clone()));
    let verdict = decide(
        &d,
        &Facts {
            roles: roles.as_ref(),
            pending_run: pending.as_deref(),
            promised_to: promised.as_deref(),
        },
    );
    match verdict {
        Verdict::NotOurs => gate_allows(None),
        Verdict::Replay { .. } => gate_allows(None),
        Verdict::Covered { run_id } => {
            if let Some(tool_use) = d.tool_use_id.clone() {
                memory.promised.insert(
                    run_id.clone(),
                    Promise {
                        tool_use: tool_use.clone(),
                        role: d.subagent_type.clone(),
                    },
                );
                memory.allowed.insert(tool_use);
            }
            tracing::info!("[control] run {run_id} is promised to this dispatch");
            let mut reply = gate_allows(None);
            reply.job_id = Some(run_id);
            reply
        }
        Verdict::Undeclared => {
            tracing::warn!(
                "[control] refusing an undeclared hand-off from master session {session_id}"
            );
            ClaimReply::refused(REFUSAL)
        }
        Verdict::Unknown(why) => {
            if let Some(refused) = refused_while_draining(ctl, why, Some(pending.as_deref())) {
                return refused;
            }
            // The promise is recorded the way `Covered` records it, so the
            // subagent that starts as the role this call named binds the run
            // (ISS-1378 judging 8012bc54 #4): with the inventory unread it was
            // never bound and the box ended its run at 60m as never bound.
            // Failing open for a run declared before the drain admits nothing
            // new only while that run is spent once, so while draining a
            // second tool call against the same run is refused.
            // cm:guard a dispatch carrying no tool call id cannot be limited here: nothing
            // names it to promise the run to or to tell a second hand-off from a replay, so
            // that case still fails open once per call, and the drain counts only the one row.
            // Only a dispatch that could be the run's takes the promise: one
            // of a role the last inventory read whole names, or, where none
            // was ever read, one namespaced as a plugin's role is, which no
            // built-in helper is. Otherwise the first helper a master sends
            // would take the run meant for its worker (ISS-1390 review F2).
            let eligible =
                d.subagent_type
                    .as_deref()
                    .is_some_and(|role| match memory.last_roles.as_ref() {
                        Some(known) => known.contains(role),
                        None => role
                            .split_once(':')
                            .is_some_and(|(plugin, name)| !plugin.is_empty() && !name.is_empty()),
                    });
            if let (Some(run), Some(tool_use), true) =
                (pending.as_deref(), d.tool_use_id.clone(), eligible)
            {
                let spent = memory
                    .promised
                    .get(run)
                    .map(|p| p.tool_use.clone())
                    .filter(|t| *t != tool_use);
                match (spent, ctl.drain.draining_for()) {
                    (Some(spent), Some(cause)) => {
                        tracing::warn!(
                            "[control] refusing a second hand-off of run {run} while draining: it was spent on {spent}"
                        );
                        return ClaimReply::refused(format!(
                            "this box is handing over to a new build ({cause}) and run {run}, declared before the handover's closing window, was already handed off to tool call {spent}; a second subagent against it would be work nothing accounted for. Declare it again in a moment, and the new build will take it"
                        ));
                    }
                    // Promised to an earlier call already, which keeps it.
                    (Some(_), None) => {}
                    (None, _) => {
                        memory.promised.insert(
                            run.to_string(),
                            Promise {
                                tool_use: tool_use.clone(),
                                role: d.subagent_type.clone(),
                            },
                        );
                        memory.allowed.insert(tool_use);
                    }
                }
            }
            if let Some(dir) = dir.as_deref() {
                // The registry answered here, so the run this dispatch belonged
                // to is known even though the verdict is not.
                let run = match pending.as_deref() {
                    Some(run) => crate::daemon::degraded::Run::Declared(run),
                    None => crate::daemon::degraded::Run::Unknown(
                        "this master had declared no run for the gate to bind",
                    ),
                };
                crate::daemon::degraded::mark(
                    dir,
                    &crate::daemon::degraded::Mark::new(
                        crate::daemon::degraded::Kind::Degraded,
                        crate::daemon::degraded::Source::Daemon,
                        why,
                        run,
                    )
                    .about(&d),
                );
            }
            tracing::error!("[control] the dispatch gate could not decide: {why}");
            gate_allows(Some(why))
        }
    }
}

#[cfg(unix)]
/// Where the gate cannot decide it fails open, and a draining box does not
/// where the hand-off may be new work: an undeclared subagent let through there
/// is work the drain never counted (ISS-1223).
///
/// `declared` is what the registry answered for this master. A run declared
/// before the drain is already a holder, so failing open for it admits nothing
/// new, and refusing it would leave a row the drain waits on that no subagent
/// can ever bind — the drain could then only give up. So only `Some(None)`
/// (read, and nothing declared) and `None` (the registry could not be read, so
/// nobody can say) refuse. The sentence claims nothing about what is recorded,
/// since where the registry could not be read nobody knows. No degraded mark is
/// written for a refusal: nothing went through.
fn refused_while_draining(
    ctl: &Arc<Control>,
    why: &str,
    declared: Option<Option<&str>>,
) -> Option<ClaimReply> {
    if matches!(declared, Some(Some(_))) {
        return None;
    }
    let cause = ctl.drain.draining_for()?;
    tracing::warn!(
        "[control] refusing a hand-off the gate could not decide ({why}): the box is handing over for {cause}"
    );
    let known = match declared {
        Some(_) => "and this master has declared no run for it",
        None => "and whether a run was declared for it cannot be read",
    };
    Some(ClaimReply::refused(format!(
        "this box is handing over to a new build ({cause}) and admits no hand-off it cannot account for in the seconds that takes: the dispatch gate could not check this one against a declaration ({why}), {known}. Hand it off again in a moment, and the new build will take it"
    )))
}

#[cfg(unix)]
/// The gate's "go ahead", with an optional reason it could not do better.
fn gate_allows(why: Option<&str>) -> ClaimReply {
    ClaimReply {
        ok: true,
        job_id: None,
        agent_session_id: None,
        issue_key: None,
        reason: why.map(str::to_string),
    }
}

#[cfg(unix)]
fn dispatch_gate_roles(dir: &Path) -> Option<std::collections::BTreeSet<String>> {
    crate::daemon::dispatch_gate::shipped_roles(dir)
}

/// A subagent started: it takes the run its master declared for it, where it
/// is the subagent that run was declared for.
///
/// A master starts subagents the box knows nothing about, and the first of
/// them to start used to take the binding meant for the run, whatever it was
/// (ISS-1378). [`crate::daemon::dispatch_gate::claims_the_run`] decides; a
/// start it turns away leaves the run unbound for the subagent dispatched for
/// it and is read as any start with nothing pending is.
///
/// A start is also the subagent heard from, in a process that is running now,
/// so an end recorded for the pane it ran in before no longer speaks for it,
/// and where the lead's hook names its transcript the run keeps that path from
/// its first turn rather than from its first stop (ISS-1312).
#[cfg(unix)]
fn bind_declared(
    ctl: &Arc<Control>,
    agent_id: Option<&str>,
    agent_type: Option<&str>,
    session_id: &str,
    at_ms: i64,
    lead: Option<&str>,
) {
    let Some(child) = agent_id else { return };
    let resumed = ctl
        .promises
        .lock()
        .expect("promises poisoned")
        .resumed
        .remove(child);
    let transcript = lead
        .map(Path::new)
        .filter(|p| p.is_absolute())
        .and_then(|p| crate::daemon::transcript_age::child_transcript(p, child))
        .map(|p| p.to_string_lossy().into_owned());
    let roles = ctl.config_dir.as_deref().and_then(dispatch_gate_roles);
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else { return };
    let heard = |led: &crate::runner::ledger::Ledger, run_id: &str| {
        if let Err(e) = led.note_subagent_started(run_id, at_ms, transcript.as_deref()) {
            tracing::warn!("[control] run {run_id}: cannot note that {child} started: {e}");
        }
    };
    let pending = match led.unbound_run_for_master(session_id, &ctl.boot_id) {
        Ok(pending) => pending,
        Err(e) => {
            tracing::warn!("[control] cannot read declared runs: {e}");
            return;
        }
    };
    let mut turned_away: Option<(String, String)> = None;
    if let Some(run) = pending {
        let promised_role = ctl
            .promises
            .lock()
            .expect("promises poisoned")
            .promised
            .get(&run.run_id)
            .and_then(|p| p.role.clone());
        match crate::daemon::dispatch_gate::claims_the_run(
            agent_type,
            roles.as_ref(),
            promised_role.as_deref(),
        ) {
            Ok(()) => {
                match led.bind_agent(&run.run_id, child) {
                    Ok(true) => {
                        heard(led, &run.run_id);
                        ctl.promises
                            .lock()
                            .expect("promises poisoned")
                            .promised
                            .remove(&run.run_id);
                        tracing::info!("[control] run {} is subagent {child}", run.run_id)
                    }
                    Ok(false) => tracing::debug!(
                        "[control] run {} was already bound when {child} started",
                        run.run_id
                    ),
                    Err(e) => tracing::warn!("[control] cannot bind {child}: {e}"),
                }
                return;
            }
            Err(why) => {
                tracing::info!(
                    "[control] subagent {child} {} under master session {session_id} and is not run {}'s: {why}. The run stays unbound for the subagent dispatched for it",
                    if resumed { "was resumed" } else { "started" },
                    run.run_id
                );
                turned_away = Some((run.run_id, why));
            }
        }
    }
    match classify_start(
        led.run_for_agent(child)
            .map(|r| r.map(|run| run.run_id))
            .map_err(|e| e.to_string()),
    ) {
        StartKind::Replay(run_id) => {
            heard(led, &run_id);
            tracing::debug!(
                "[control] subagent {child} is already run {run_id}, so its start is a replay"
            )
        }
        StartKind::Undeclared => {
            undeclared_child(ctl, child, agent_type, turned_away.as_ref(), resumed)
        }
        StartKind::Unreadable(e) => unreadable_ledger(ctl, child, &e),
    }
}

/// The role Claude Code recorded for the subagent whose transcript is
/// `transcript`, off the `agent-<id>.meta.json` it writes beside it.
#[cfg(unix)]
fn agent_type_beside(transcript: &Path) -> Option<String> {
    let text = std::fs::read(transcript.with_extension("meta.json")).ok()?;
    let doc: serde_json::Value = serde_json::from_slice(&text).ok()?;
    doc.get("agentType")?.as_str().map(str::to_string)
}

/// The master resumed subagent `child` with `SendMessage`, which starts no
/// new subagent. Claude Code still fires `SubagentStart` as the subagent
/// resumes (gate-marks on sid-xeon-1, ISS-1378 judging 8012bc54 #2), and
/// [`bind_declared`] answers that with the same decision; binding here, at the
/// tool call, is what holds where the resume reaches the box first. Where the
/// master holds a declared
/// run that nothing has bound or been promised, and `child` is of a role this
/// box ships and answers to no open run, it binds that run here.
///
/// Before it, a declaration a master answered by resuming a subagent was never
/// bound, and the box ended it an hour later as one that never bound, while
/// that subagent worked in its checkout (judge iss-1378-a823d04f, run
/// b229ea3b). The role is read off the metadata Claude Code wrote when the
/// subagent first started, which is on disk by the time it can be resumed.
#[cfg(unix)]
fn bind_resumed(ctl: &Arc<Control>, child: &str, lead: Option<&str>, session_id: &str) {
    let transcript = lead
        .map(Path::new)
        .filter(|p| p.is_absolute())
        .and_then(|p| crate::daemon::transcript_age::child_transcript(p, child));
    let agent_type = transcript.as_deref().and_then(agent_type_beside);
    let roles = ctl.config_dir.as_deref().and_then(dispatch_gate_roles);
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else { return };
    let run = match led.unbound_run_for_master(session_id, &ctl.boot_id) {
        Ok(Some(run)) => run,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!("[control] cannot read declared runs: {e}");
            return;
        }
    };
    let promised = ctl
        .promises
        .lock()
        .expect("promises poisoned")
        .promised
        .get(&run.run_id)
        .map(|p| p.tool_use.clone());
    if let Some(tool_use) = promised {
        tracing::info!(
            "[control] master session {session_id} resumed subagent {child}, and run {} is promised to the dispatch {tool_use}, so the resume does not take it",
            run.run_id
        );
        return;
    }
    if let Err(why) =
        crate::daemon::dispatch_gate::claims_the_run(agent_type.as_deref(), roles.as_ref(), None)
    {
        tracing::info!(
            "[control] master session {session_id} resumed subagent {child}, which is not run {}'s: {why}. The run stays unbound",
            run.run_id
        );
        return;
    }
    match led.bind_resumed(&run.run_id, child) {
        Ok(true) => {
            let transcript = transcript.map(|p| p.to_string_lossy().into_owned());
            if let Err(e) = led.note_subagent_started(
                &run.run_id,
                crate::daemon::agent_activity::now_ms(),
                transcript.as_deref(),
            ) {
                tracing::warn!(
                    "[control] run {}: cannot note that {child} was resumed: {e}",
                    run.run_id
                );
            }
            tracing::info!(
                "[control] run {} is subagent {child}, resumed by its master",
                run.run_id
            );
        }
        Ok(false) => {
            let holder = led
                .run_for_agent(child)
                .ok()
                .flatten()
                .map(|r| r.run_id)
                .unwrap_or_else(|| "another".to_string());
            tracing::warn!(
                "[control] master session {session_id} resumed subagent {child}, which still answers to open run {holder}, so run {} stays unbound: a subagent answers to one open run, and the master closes the one it is done with",
                run.run_id
            );
        }
        Err(e) => tracing::warn!("[control] cannot bind resumed {child}: {e}"),
    }
}

/// Record on `run_id`'s row the Claude Code process above `peer`, the process
/// that just reported for it. A subagent runs in the process of the
/// conversation that dispatched it, which is the one above its own hooks and
/// above its master's `run declare`, and which may be running outside the
/// master's pane (ISS-1312, run e67c08e0). A peer with no such process above it
/// records nothing, and a row with nothing recorded is never ended by a pane.
#[cfg(unix)]
fn note_host(
    ctl: &Arc<Control>,
    led: &crate::runner::ledger::Ledger,
    run_id: &str,
    peer: Option<u32>,
) {
    let Some(host) = peer.and_then(|p| ctl.hosts.above(p)) else {
        tracing::debug!(
            "[control] run {run_id}: no Claude Code process was read above the process that reported for it, so none is recorded"
        );
        return;
    };
    if let Err(e) = led.note_host(run_id, host.pid, &host.start) {
        tracing::warn!(
            "[control] run {run_id}: cannot record the process {} its subagent runs in: {e}",
            host.pid
        );
    }
}

/// [`note_host`] for the run `child` is bound to.
#[cfg(unix)]
fn note_host_of(ctl: &Arc<Control>, child: Option<&str>, peer: Option<u32>) {
    let (Some(child), Some(_)) = (child, peer) else {
        return;
    };
    let held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_ref() else { return };
    match led.run_for_agent(child) {
        Ok(Some(run)) => note_host(ctl, led, &run.run_id, peer),
        Ok(None) => {}
        Err(e) => tracing::warn!("[control] cannot read the run for {child}: {e}"),
    }
}

/// A subagent ended a turn, which is not the end of its run: it may be waiting
/// on work of its own, and one that finished can still be resumed. The stop
/// and where its transcript is are recorded; the run stays open until its
/// master closes it or its master's pane is gone (ISS-1246).
#[cfg(unix)]
fn note_subagent_stop(ctl: &Arc<Control>, child: &str, at_ms: i64, lead: Option<&str>) {
    let transcript = lead
        .map(Path::new)
        .filter(|p| p.is_absolute())
        .and_then(|p| crate::daemon::transcript_age::child_transcript(p, child))
        .map(|p| p.to_string_lossy().into_owned());
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else { return };
    match led.run_for_agent(child) {
        Ok(Some(run)) => match led.note_turn_end(&run.run_id, at_ms, transcript.as_deref()) {
            Ok(_) => tracing::info!(
                "[control] run {}: subagent {child} ended a turn, and the run stays open until its master closes it",
                run.run_id
            ),
            Err(e) => tracing::warn!("[control] cannot note {child}'s turn end: {e}"),
        },
        Ok(None) => tracing::debug!("[control] subagent {child} answered to no declared run"),
        Err(e) => tracing::warn!("[control] cannot read the run for {child}: {e}"),
    }
}

#[cfg(any(unix, test))]
/// What a `SubagentStart` with no pending declaration turned out to be.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StartKind {
    /// This child already holds an open run, so its start is a repeat of one already handled.
    Replay(String),
    /// This box holds no row for this child's work.
    Undeclared,
    /// This box could not read its own ledger, so it knows neither of the above.
    Unreadable(String),
}

#[cfg(any(unix, test))]
pub(crate) fn classify_start(read: Result<Option<String>, String>) -> StartKind {
    match read {
        Ok(Some(run_id)) => StartKind::Replay(run_id),
        Ok(None) => StartKind::Undeclared,
        Err(e) => StartKind::Unreadable(e),
    }
}

#[cfg(unix)]
fn unreadable_ledger(ctl: &Arc<Control>, child: &str, e: &str) {
    let detail = format!("could not read the declared runs when subagent {child} started: {e}");
    tracing::warn!("[control] {detail} — this box knows neither that the work was declared nor that it was not");
    if let Some(dir) = ctl.config_dir.as_deref() {
        crate::daemon::degraded::mark(
            dir,
            &crate::daemon::degraded::Mark::new(
                crate::daemon::degraded::Kind::Degraded,
                crate::daemon::degraded::Source::Daemon,
                &detail,
                crate::daemon::degraded::Run::Unknown(
                    "the declared runs could not be read, so this box knows of none",
                ),
            )
            .by_child(child, None),
        );
    }
}

/// A subagent of a shipped role that no declared run takes. `declared` is the
/// run its master did declare and why this subagent is not that run's, where
/// there was one: the master then took the step, and the journal says what
/// did not match rather than that nothing was declared.
#[cfg(unix)]
fn undeclared_child(
    ctl: &Arc<Control>,
    child: &str,
    agent_type: Option<&str>,
    declared: Option<&(String, String)>,
    resumed: bool,
) {
    let Some(role) = agent_type else {
        tracing::debug!("[control] subagent {child} answers to no declared run");
        return;
    };
    let dir = ctl.config_dir.clone();
    let ships_it = dir
        .as_deref()
        .and_then(crate::daemon::dispatch_gate::shipped_roles)
        .is_some_and(|roles| roles.contains(role));
    if !ships_it {
        tracing::debug!("[control] subagent {child} ({role}) answers to no declared run");
        return;
    }
    let how = if resumed {
        "was resumed as"
    } else {
        "started as"
    };
    let (detail, owed) = match declared {
        None => (
            format!("subagent {child} {how} `{role}` with nothing declared for it"),
            "The master was required to run `forge-runner run declare` first.".to_string(),
        ),
        Some((run_id, why)) => (
            format!(
                "subagent {child} {how} `{role}`, and the run its master declared, {run_id}, is not its: {why}"
            ),
            format!(
                "The master did declare run {run_id}; it was for another dispatch, and it stays unbound for that one."
            ),
        ),
    };
    tracing::error!(
        "[control] UNDECLARED HAND-OFF: {detail} — this box holds no row for that work, so nothing \
         will reap it, the load count is short, and those issues will never be offered again. {owed}"
    );
    if let Some(dir) = dir.as_deref() {
        crate::daemon::degraded::mark(
            dir,
            &crate::daemon::degraded::Mark::new(
                crate::daemon::degraded::Kind::Undeclared,
                crate::daemon::degraded::Source::Daemon,
                &detail,
                crate::daemon::degraded::Run::Unknown(match declared {
                    None => "nothing was declared for it",
                    Some(_) => "the one run its master declared was for another dispatch",
                }),
            )
            .by_child(child, Some(role)),
        );
    }
}

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
    if let Err(e) = led.note_master(
        &project_id,
        &pane,
        conversation_id,
        Some(session_id),
        &ctl.boot_id,
    ) {
        tracing::warn!("[control] cannot record {project_id}'s master pane: {e}");
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
            resumes,
            transcript_path,
            ..
        } => dispatch_gate_reply(
            ctl,
            crate::daemon::dispatch_gate::Dispatch {
                agent_id,
                subagent_type,
                tool_use_id,
                resumes,
                transcript_path,
            },
            session_id,
        ),
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

#[cfg(unix)]
pub async fn request_run_choice(
    path: &std::path::Path,
    token: &str,
    run_id: &str,
    choice: &str,
    why: &str,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({
            "op": "run_choice", "token": token, "runId": run_id,
            "choice": choice, "why": why
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
pub async fn request_run_choice(
    _path: &std::path::Path,
    _token: &str,
    _run_id: &str,
    _choice: &str,
    _why: &str,
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
    _names: &HookNames,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

#[cfg(not(unix))]
pub async fn request_dispatch_gate(
    _path: &std::path::Path,
    _token: &str,
    _d: &crate::daemon::dispatch_gate::Dispatch,
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
    names: &HookNames,
) -> std::io::Result<ClaimReply> {
    ask(path, agent_event_frame(token, event, names)).await
}

/// The frame the pane's hook puts on the socket for one event, built where a
/// test can decode it into `Request` without a socket.
pub fn agent_event_frame(token: &str, event: &str, names: &HookNames) -> serde_json::Value {
    serde_json::json!({
        "op": "agent_event", "token": token, "event": event,
        "agentId": names.agent_id, "conversationId": names.conversation_id,
        "agentType": names.agent_type, "transcriptPath": names.transcript_path
    })
}

/// The frame the pane's hook puts on the socket, built where a test can decode it
/// into `Request` without a socket — a hand-written copy of it is a second wire
/// contract that parts from this one in silence.
pub fn dispatch_gate_frame(
    token: &str,
    d: &crate::daemon::dispatch_gate::Dispatch,
) -> serde_json::Value {
    serde_json::json!({
        "op": "dispatch_gate", "token": token,
        "agentId": d.agent_id, "subagentType": d.subagent_type,
        "toolUseId": d.tool_use_id, "resumes": d.resumes,
        "transcriptPath": d.transcript_path
    })
}

/// Ask whether the work about to be handed out has been declared.
#[cfg(unix)]
pub async fn request_dispatch_gate(
    path: &std::path::Path,
    token: &str,
    d: &crate::daemon::dispatch_gate::Dispatch,
) -> std::io::Result<ClaimReply> {
    ask(path, dispatch_gate_frame(token, d)).await
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
        let dir = crate::test_scratch::Scratch::new("ct");
        let tokens = SessionTokens::at(dir.join("control-tokens.json"));
        let a = tokens
            .mint("sess-a", "proj-a", "proj-a-slug", "pane-a")
            .unwrap();
        tokens
            .mint("sess-b", "proj-b", "proj-b-slug", "pane-b")
            .unwrap();

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

    #[cfg(unix)]
    /// What a lead event of one conversation names, and nothing else.
    fn conv(id: &str) -> HookNames {
        HookNames {
            conversation_id: Some(id.into()),
            ..HookNames::default()
        }
    }

    #[test]
    fn the_frame_the_hook_sends_carries_the_transcript_path_the_daemon_decodes() {
        let names = HookNames {
            agent_id: None,
            conversation_id: Some("conv-a".into()),
            agent_type: None,
            transcript_path: Some("/home/u/.claude/projects/-w/conv-a.jsonl".into()),
        };
        let frame = agent_event_frame("t1", "UserPromptSubmit", &names);
        let req: Request = serde_json::from_value(frame).expect("the hook's own frame must decode");
        let Request::AgentEvent {
            transcript_path, ..
        } = &req
        else {
            panic!("a frame whose op is `agent_event` must decode as one");
        };
        assert_eq!(
            transcript_path.as_deref(),
            Some("/home/u/.claude/projects/-w/conv-a.jsonl"),
            "without it a turn whose end was lost has nothing the daemon can age (ISS-1244)"
        );
    }

    #[test]
    fn a_frame_from_a_hook_that_names_no_transcript_still_decodes() {
        let frame = r#"{"op":"agent_event","token":"t1","event":"Stop","conversationId":"c"}"#;
        let req: Request = serde_json::from_str(frame).expect("must decode");
        let Request::AgentEvent {
            transcript_path, ..
        } = &req
        else {
            panic!("a frame whose op is `agent_event` must decode as one");
        };
        assert!(transcript_path.is_none());
    }

    /// Every name a hook's frame carries decodes under its wire spelling, on
    /// every platform the frame is built on — including the ones whose daemon
    /// hosts no control socket to read it.
    #[test]
    fn a_hook_frame_names_its_agent_its_conversation_and_its_agent_type_by_wire_name() {
        let frame = r#"{"op":"agent_event","token":"t1","event":"SubagentStart","agentId":"a-1","conversationId":"conv-1","agentType":"forge:runner"}"#;
        let req: Request = serde_json::from_str(frame).expect("must decode");
        let Request::AgentEvent {
            agent_id,
            conversation_id,
            agent_type,
            ..
        } = &req
        else {
            panic!("a frame whose op is `agent_event` must decode as one");
        };
        assert_eq!(
            (
                agent_id.as_deref(),
                conversation_id.as_deref(),
                agent_type.as_deref()
            ),
            (Some("a-1"), Some("conv-1"), Some("forge:runner"))
        );
    }

    #[test]
    fn a_close_frame_names_its_run_and_its_reason_and_the_reason_may_be_left_out() {
        let req: Request = serde_json::from_str(
            r#"{"op":"run_close","token":"t1","runId":"run-1","reason":"never started"}"#,
        )
        .expect("must decode");
        let Request::RunClose { run_id, reason, .. } = &req else {
            panic!("a frame whose op is `run_close` must decode as one");
        };
        assert_eq!(
            (run_id.as_str(), reason.as_deref()),
            ("run-1", Some("never started"))
        );
        let bare: Request =
            serde_json::from_str(r#"{"op":"run_close","token":"t1","runId":"run-2"}"#)
                .expect("a close with no reason must decode");
        let Request::RunClose { reason, .. } = &bare else {
            panic!("a frame whose op is `run_close` must decode as one");
        };
        assert!(reason.is_none());
    }

    #[cfg(unix)]
    /// The third value is the control's config dir, which the caller holds for the test's life.
    fn declaring_control(
        session_id: &str,
        project_id: &str,
    ) -> (Arc<Control>, String, crate::test_scratch::Scratch) {
        declaring_control_over(session_id, project_id, Arc::default())
    }

    #[cfg(unix)]
    /// [`declaring_control`] over a process table the test sets.
    fn declaring_control_over(
        session_id: &str,
        project_id: &str,
        hosts: Arc<crate::daemon::subagent_host::testing::FakeHosts>,
    ) -> (Arc<Control>, String, crate::test_scratch::Scratch) {
        let dir = crate::test_scratch::Scratch::new("ct-decl");
        let tokens = SessionTokens::at(dir.join("control-tokens.json"));
        let token = tokens
            .mint(session_id, project_id, "slug", "pane-1")
            .unwrap();
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
                config_dir: Some(dir.to_path_buf()),
                promises: std::sync::Mutex::new(GateMemory::default()),
                drain: Arc::new(crate::daemon::drain::Drain::unrecorded()),
                hosts,
            }),
            token,
            dir,
        )
    }

    #[cfg(unix)]
    /// A control over the map and registry a test built, with an empty ledger.
    fn control_over(
        tokens: SessionTokens,
        masters: Arc<crate::daemon::master::Masters>,
        dir: &crate::test_scratch::Scratch,
    ) -> Arc<Control> {
        Arc::new(Control {
            tokens,
            activity: Arc::new(crate::daemon::agent_activity::Activities::new()),
            masters,
            ledger: Arc::new(std::sync::Mutex::new(Some(
                crate::runner::ledger::Ledger::open_in_memory().unwrap(),
            ))),
            boot_id: "boot-a".into(),
            config_dir: Some(dir.to_path_buf()),
            promises: std::sync::Mutex::new(GateMemory::default()),
            drain: Arc::new(crate::daemon::drain::Drain::unrecorded()),
            hosts: Arc::new(crate::daemon::subagent_host::testing::FakeHosts::default()),
        })
    }

    /// A frame as the pane's CLI sends it, served the way `serve_one` serves
    /// one: resolved from its token, then answered under the session it acts as.
    #[cfg(unix)]
    fn served(ctl: &Arc<Control>, frame: serde_json::Value) -> ClaimReply {
        let req: Request = serde_json::from_value(frame).expect("the frame must decode");
        match caller_of(ctl, req.token()) {
            Some((holder, session)) => serve_request(ctl, req, &holder, &session, None),
            None => ClaimReply::refused("unknown_token"),
        }
    }

    #[cfg(unix)]
    fn declare_frame(token: &str, project: &str, key: &str) -> serde_json::Value {
        serde_json::json!({
            "op": "run_declare",
            "token": token,
            "projectId": project,
            "issueKeys": [key],
            "worktreePath": format!("/w/{key}"),
        })
    }

    #[cfg(unix)]
    fn run_count(ctl: &Arc<Control>) -> usize {
        ctl.ledger
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .unclosed_runs()
            .unwrap()
            .len()
    }

    #[cfg(unix)]
    /// The pane was placed as forge-dev's master under `PLACED`; core has
    /// since reaped that row and this box now holds `REMINT` for the pane.
    const PLACED: &str = "sess-placed-under";
    #[cfg(unix)]
    const REMINT: &str = "sess-core-reminted";
    #[cfg(unix)]
    const PANE: &str = "forge-master-forge-dev";

    #[cfg(unix)]
    fn a_pane_core_re_minted(shape: &str) -> (Arc<Control>, String, crate::test_scratch::Scratch) {
        let dir = crate::test_scratch::Scratch::new("ct-remint");
        let path = dir.join("control-tokens.json");
        let token = match shape {
            "record" => SessionTokens::at(path.clone())
                .mint(PLACED, "proj-1", "proj-1-slug", PANE)
                .unwrap(),
            _ => {
                std::fs::write(&path, format!(r#"{{"tok-before-the-record":"{PLACED}"}}"#))
                    .unwrap();
                "tok-before-the-record".to_string()
            }
        };
        let masters = Arc::new(crate::daemon::master::Masters::new());
        masters.remember_for_test("proj-1", REMINT, PANE);
        let ctl = control_over(SessionTokens::at(path), masters, &dir);
        (ctl, token, dir)
    }

    /// ISS-1316 criteria 2 and 3.
    #[cfg(unix)]
    #[test]
    fn a_pane_whose_row_core_re_minted_declares_under_the_session_this_box_now_holds() {
        let (ctl, token, _dir) = a_pane_core_re_minted("record");
        let reply = served(&ctl, declare_frame(&token, "proj-1", "ISS-7"));
        assert!(
            reply.ok,
            "the record says this pane is proj-1's master, and core re-minting the row it was placed under changes neither: {reply:?}"
        );
        assert_eq!(reply.agent_session_id.as_deref(), Some(REMINT));
        let held = ctl.ledger.lock().unwrap();
        let run = held
            .as_ref()
            .unwrap()
            .run(reply.job_id.as_deref().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            run.master_session_id, REMINT,
            "recorded under the session every other key on this box reads, not the reaped one"
        );
    }

    /// The same pane holding a capability minted before the record: this is
    /// the ISS-1099 defect, which such a pane still has, and which is what
    /// makes the test above able to fail.
    #[cfg(unix)]
    #[test]
    fn the_same_pane_on_a_capability_minted_before_the_record_is_still_refused() {
        let (ctl, token, _dir) = a_pane_core_re_minted("legacy");
        let reply = served(&ctl, declare_frame(&token, "proj-1", "ISS-7"));
        assert!(
            !reply.ok && reply.reason.as_deref().unwrap_or("").contains(REMINT),
            "a pre-record capability names only its session, which core replaced: {reply:?}"
        );
        assert_eq!(run_count(&ctl), 0);
    }

    /// Review 2e629b3's F1: the session a record's run is written under is
    /// read at the write, with the registry held, and not taken from the frame
    /// resolution that ran before it. The frame here resolved while the box
    /// still served the pane as `PLACED`; the sweep has since moved it.
    #[cfg(unix)]
    #[test]
    fn a_declaration_is_written_under_the_session_the_registry_holds_at_the_write() {
        let (ctl, token, _dir) = a_pane_core_re_minted("record");
        let holder = ctl.tokens.resolve(&token).expect("the record");
        let reply = run_declare_as(
            &ctl,
            &holder,
            "proj-1",
            &["ISS-7".into()],
            "/w/ISS-7",
            PLACED,
            None,
        );
        assert!(reply.ok, "{reply:?}");
        assert_eq!(reply.agent_session_id.as_deref(), Some(REMINT));
        let run = ctl
            .ledger
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .run(reply.job_id.as_deref().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(run.master_session_id, REMINT);
    }

    /// ISS-1316 criterion 4, which is ISS-1050 criterion 7 at the record.
    #[cfg(unix)]
    #[test]
    fn a_record_declares_nothing_for_a_project_it_was_not_minted_for() {
        let (ctl, token, _dir) = a_pane_core_re_minted("record");
        ctl.masters
            .remember_for_test("proj-2", "sess-other", "forge-master-other");
        let reply = served(&ctl, declare_frame(&token, "proj-2", "ISS-9"));
        assert!(
            !reply.ok
                && reply
                    .reason
                    .as_deref()
                    .unwrap_or("")
                    .contains("cannot declare a run for proj-2"),
            "{reply:?}"
        );
        assert_eq!(run_count(&ctl), 0, "and nothing was written");
    }

    /// ISS-1316 criterion 5: a job pane of the same project carries a record
    /// too, and a record is not a master's unless its pane is the master's.
    #[cfg(unix)]
    #[test]
    fn a_record_minted_for_a_job_pane_declares_nothing() {
        let (ctl, _master, _dir) = a_pane_core_re_minted("record");
        let job = ctl
            .tokens
            .mint("sess-job", "proj-1", "proj-1-slug", "forge-job-42")
            .unwrap();
        let reply = served(&ctl, declare_frame(&job, "proj-1", "ISS-9"));
        assert!(
            !reply.ok
                && reply
                    .reason
                    .as_deref()
                    .unwrap_or("")
                    .contains("only the project's master pane declares its runs"),
            "{reply:?}"
        );
        assert_eq!(run_count(&ctl), 0, "and nothing was written");
    }

    /// ISS-1316 criterion 13.
    #[cfg(unix)]
    #[test]
    fn every_frame_against_a_map_in_neither_shape_is_refused_as_an_unknown_token() {
        let (ctl, token, dir) = a_pane_core_re_minted("record");
        std::fs::write(dir.join("control-tokens.json"), r#"{"x":{"session":1}}"#).unwrap();
        let reply = served(&ctl, declare_frame(&token, "proj-1", "ISS-7"));
        assert_eq!(
            reply.reason.as_deref(),
            Some("unknown_token"),
            "a map this box cannot parse answers for no pane, rather than an empty map answering for none: {reply:?}"
        );
        assert_eq!(run_count(&ctl), 0);
    }

    /// ISS-1316 criterion 9, and the red it answers: before the sweep carries
    /// the pane's runs across, the pane's own close is refused as another
    /// master's.
    #[cfg(unix)]
    #[test]
    fn a_pane_closes_the_run_it_declared_before_core_re_minted_its_row_once_the_sweep_carries_it() {
        let (ctl, token, _dir) = a_pane_core_re_minted("record");
        const RUN: &str = "run-declared-before";
        const PANE_CLAUDE: u32 = 51_001;
        const PANE_PID: u32 = 51_000;
        {
            let mut held = ctl.ledger.lock().unwrap();
            let led = held.as_mut().unwrap();
            led.create_run_group(crate::runner::ledger::NewRun {
                run_id: RUN.into(),
                project_id: "proj-1".into(),
                master_session_id: PLACED.into(),
                worktree_path: "/w/before".into(),
                boot_id: "boot-a".into(),
                issue_keys: vec!["ISS-5".into()],
            })
            .unwrap();
            assert!(led.note_host(RUN, PANE_CLAUDE, "4400").unwrap());
        }
        let close = || {
            served(
                &ctl,
                serde_json::json!({"op": "run_close", "token": token, "runId": RUN, "reason": "done"}),
            )
        };
        let before = close();
        assert!(
            !before.ok
                && before
                    .reason
                    .as_deref()
                    .unwrap_or("")
                    .contains("another master"),
            "the red: {before:?}"
        );
        // The review's F1: the pane speaks between the registry moving and the
        // sweep's carry, which rewrites the session its master row names. The
        // carry must not depend on that row.
        let spoke = served(
            &ctl,
            serde_json::json!({"op": "agent_event", "token": token, "event": "Stop", "conversationId": "conv-1"}),
        );
        assert!(spoke.ok, "{spoke:?}");
        {
            let mut held = ctl.ledger.lock().unwrap();
            let hosts = crate::daemon::subagent_host::testing::FakeHosts::with(
                PANE_CLAUDE,
                crate::daemon::subagent_host::HostRead::Alive,
            );
            hosts.under.lock().unwrap().insert((PANE_CLAUDE, PANE_PID));
            let moved = crate::daemon::master::carried_across(
                held.as_mut().unwrap(),
                "proj-1",
                PANE,
                REMINT,
                Some(PANE_PID),
                &hosts,
                "forge-dev",
            );
            assert_eq!(moved.moved, 1);
        }
        let after = close();
        assert!(after.ok, "{after:?}");
    }

    /// ISS-1312, criteria 16, 19-23 and 29, over this incident's own rows: run
    /// 85be2c91 (forge-dev ISS-1314) was declared under master session
    /// 3832432d, its subagent ad5b0350ec22adc17 bound and never stopped, and
    /// the forge-dev pane was placed again and resumed under a new session. The
    /// pane was told the run was its own and was refused at all three verbs.
    /// Its subagent ran in the pane's own Claude Code process, which is gone.
    #[cfg(unix)]
    #[test]
    fn a_resumed_pane_answers_for_the_run_the_session_it_replaced_declared() {
        const PANE_CLAUDE: u32 = 3_811_204;
        const OLD: &str = "3832432d-d554-4de3-a0d7-7531f1debd39";
        const NEW: &str = "1dc7d61c-0000-4000-8000-000000000000";
        const PROJECT: &str = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
        const RUN: &str = "85be2c91-08e7-40d6-8b42-aa295d3a2e4c";
        let (ctl, _t, _dir) = declaring_control(NEW, PROJECT);
        let inherited = {
            let mut held = ctl.ledger.lock().unwrap();
            let led = held.as_mut().unwrap();
            led.create_run_group(crate::runner::ledger::NewRun {
                run_id: RUN.into(),
                project_id: PROJECT.into(),
                master_session_id: OLD.into(),
                worktree_path: "/home/dev/forge/projects/forge-core/.claude/worktrees/iss-1314-r3"
                    .into(),
                boot_id: "boot-a".into(),
                issue_keys: vec!["ISS-1314".into()],
            })
            .unwrap();
            led.attach_session(RUN, "a44e068d-e3b3-4bb8-a247-84f5c10a5b05")
                .unwrap();
            assert!(led.bind_agent(RUN, "ad5b0350ec22adc17").unwrap());
            assert!(led.note_host(RUN, PANE_CLAUDE, "4400").unwrap());
            led.note_master(PROJECT, "forge-master-forge-dev", None, Some(OLD), "boot-a")
                .unwrap();
            let boot = crate::daemon::master::inheritance_boot(None, led, PROJECT, "forge-dev")
                .expect("an unreadable boot identity falls back to the master row's");
            assert_eq!(boot, "boot-a");
            crate::daemon::master::inherited_runs(led, PROJECT, &boot)
        };
        let hosts = crate::daemon::subagent_host::testing::FakeHosts::with(
            PANE_CLAUDE,
            crate::daemon::subagent_host::HostRead::Gone,
        );
        let brief =
            crate::daemon::master::resumed_brief("conv-forge-dev", &inherited, true, &hosts);
        assert!(brief.contains(RUN), "criterion 19: {brief}");
        assert!(
            brief.contains("ended with the pane") && !brief.contains("incarnation: live"),
            "criteria 34 and 35: {brief}"
        );
        {
            let mut held = ctl.ledger.lock().unwrap();
            let led = held.as_mut().unwrap();
            crate::daemon::master::placed_again(
                led,
                &inherited,
                NEW,
                true,
                crate::daemon::agent_activity::now_ms(),
                "forge-dev",
                &hosts,
            );
            assert_eq!(
                led.run(RUN).unwrap().unwrap().master_session_id,
                NEW,
                "criterion 20"
            );
            assert_eq!(led.owe_resume_choices(NEW, "boot-a").unwrap(), 1);
        }
        let refused = run_declare(&ctl, PROJECT, &["ISS-1400".into()], "/w/other", NEW, None);
        assert!(
            !refused.ok && refused.reason.as_deref().unwrap_or("").contains(RUN),
            "an unanswered inheritance still holds new work: {refused:?}"
        );
        let chose = run_choice(&ctl, RUN, "restart", "its subagent died with the pane", NEW);
        assert!(chose.ok, "criterion 21: {chose:?}");
        let closed = run_close(&ctl, RUN, Some("restarting ISS-1314"), NEW);
        assert!(closed.ok, "criterion 22: {closed:?}");
        {
            let held = ctl.ledger.lock().unwrap();
            let run = held.as_ref().unwrap().run(RUN).unwrap().unwrap();
            assert_eq!(run.resume_choice.as_deref(), Some("restart"));
            assert_eq!(run.ended_by.as_deref(), Some("master"));
        }
        let again = run_declare(
            &ctl,
            PROJECT,
            &["ISS-1314".into()],
            "/home/dev/forge/projects/forge-core/.claude/worktrees/iss-1314-r4",
            NEW,
            None,
        );
        assert!(again.ok, "criterion 23: {again:?}");
        let held = ctl.ledger.lock().unwrap();
        let fresh = held
            .as_ref()
            .unwrap()
            .run(again.job_id.as_deref().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(fresh.master_session_id, NEW);
    }

    #[cfg(unix)]
    fn asking(role: &str, tool_use: &str) -> crate::daemon::dispatch_gate::Dispatch {
        crate::daemon::dispatch_gate::Dispatch {
            agent_id: None,
            subagent_type: Some(role.into()),
            tool_use_id: Some(tool_use.into()),
            ..Default::default()
        }
    }

    #[cfg(unix)]
    fn gate_on(
        ctl: &Arc<Control>,
        d: &crate::daemon::dispatch_gate::Dispatch,
        session_id: &str,
    ) -> ClaimReply {
        dispatch_gate_reply(ctl, d.clone(), session_id)
    }

    /// Allowed, by the answer the socket actually sends.
    #[cfg(unix)]
    fn allowed(r: &ClaimReply) -> bool {
        r.ok
    }

    #[cfg(unix)]
    fn named_run(r: &ClaimReply) -> Option<String> {
        r.job_id.clone()
    }

    /// Refused, and refused with the declaration's own words rather than any
    /// other `ok:false` the socket can produce.
    #[cfg(unix)]
    fn refused_as_undeclared(r: &ClaimReply) -> bool {
        !r.ok && r.reason.as_deref() == Some(crate::daemon::dispatch_gate::REFUSAL)
    }

    /// Which tool call, if any, this run is currently promised to.
    #[cfg(unix)]
    fn promised_to(ctl: &Arc<Control>, run_id: &str) -> Option<String> {
        ctl.promises
            .lock()
            .unwrap()
            .promised
            .get(run_id)
            .map(|p| p.tool_use.clone())
    }

    /// Criteria 11, 12 and 13. The cap is core's and the refusal is this
    /// box's: a master that hears `400` from a sweep it cannot see hears
    /// nothing, and one that hears the cap at the pane it typed into can split
    /// the batch. Both sides of the boundary, because a cap refusing the
    /// declaration it is supposed to allow is a master that cannot declare at
    /// all.
    #[cfg(unix)]
    #[test]
    fn a_declaration_over_the_cap_is_refused_at_the_pane_and_writes_nothing() {
        let cap = crate::transport::run_sessions::MAX_ISSUE_KEYS;
        let keys =
            |n: usize| -> Vec<String> { (0..n).map(|i| format!("ISS-{}", 900 + i)).collect() };

        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let over = run_declare(&ctl, "proj-1", &keys(cap + 1), "/w/over", "sess-a", None);
        assert!(!over.ok, "seventeen keys is one more than core accepts");
        let said = over.reason.clone().unwrap_or_default();
        assert!(said.contains(&cap.to_string()), "the cap is named: {said}");
        assert!(
            said.contains(&(cap + 1).to_string()),
            "and so is what was sent, so the master can see by how much: {said}"
        );
        assert!(
            over.job_id.is_none(),
            "a refused declaration reserves no run"
        );
        assert_eq!(
            ctl.ledger
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .unclosed_runs()
                .unwrap()
                .len(),
            0,
            "nothing was recorded, which is what the refusal says"
        );

        let (ctl, _t, _dir) = declaring_control("sess-b", "proj-1");
        let at_cap = run_declare(&ctl, "proj-1", &keys(cap), "/w/at-cap", "sess-b", None);
        assert!(
            at_cap.ok,
            "exactly the cap is what core accepts and must still be declarable: {:?}",
            at_cap.reason
        );
    }

    #[cfg(unix)]
    #[test]
    fn one_declaration_authorises_one_dispatch_and_is_freed_when_its_subagent_starts() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        ship_roles(&ctl, &["runner", "reviewer"]);

        // 1. Nothing declared: refused, in the declaration's own words.
        assert!(
            refused_as_undeclared(&gate_on(&ctl, &asking("forge:runner", "toolu_1"), "sess-a")),
            "a hand-off with nothing declared is refused by the socket, not merely by `decide`"
        );

        // 4. Declared: the next dispatch goes through, and the row it reserved is
        // named — which is what a re-implementation of this path could not show.
        let run_id = run_declare(
            &ctl,
            "proj-1",
            &["ISS-7".into()],
            "/w/seven",
            "sess-a",
            None,
        )
        .job_id
        .expect("declared");
        let covered = gate_on(&ctl, &asking("forge:runner", "toolu_1"), "sess-a");
        assert!(allowed(&covered));
        assert_eq!(
            named_run(&covered).as_deref(),
            Some(run_id.as_str()),
            "a dispatch that RESERVED a row is answered with that row's id"
        );
        assert_eq!(
            promised_to(&ctl, &run_id).as_deref(),
            Some("toolu_1"),
            "the declaration this dispatch rode is the one that was pending"
        );

        // 6. The same tool call again is the same answer, and consumes nothing.
        let replay = gate_on(&ctl, &asking("forge:runner", "toolu_1"), "sess-a");
        assert!(allowed(&replay));
        assert_eq!(
            named_run(&replay),
            None,
            "a replay reserved nothing, so it names no row — the only thing in the reply that \
             tells it from the dispatch that did"
        );
        assert_eq!(
            promised_to(&ctl, &run_id).as_deref(),
            Some("toolu_1"),
            "a replay must not re-reserve, or the second ride is free"
        );

        // 5. A DIFFERENT dispatch cannot ride the same declaration.
        assert!(
            refused_as_undeclared(&gate_on(
                &ctl,
                &asking("forge:reviewer", "toolu_2"),
                "sess-a"
            )),
            "two subagents under one declared row is two units of work with one record"
        );

        // 7. The subagent starts: the row is bound, the promise is released, and
        // the master is back to needing a fresh declaration.
        bind_declared(
            &ctl,
            Some("child-1"),
            Some("forge:runner"),
            "sess-a",
            0,
            None,
        );
        assert_eq!(
            promised_to(&ctl, &run_id),
            None,
            "a bound run must not stay promised, or the next declaration is refused on a free row"
        );
        assert!(refused_as_undeclared(&gate_on(
            &ctl,
            &asking("forge:runner", "toolu_3"),
            "sess-a"
        )));
    }

    #[cfg(unix)]
    #[test]
    fn a_daemon_restart_leaves_the_declaration_standing_and_the_second_child_is_named() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner"]);
        let run_id = run_declare(
            &ctl,
            "proj-1",
            &["ISS-7".into()],
            "/w/seven",
            "sess-a",
            None,
        )
        .job_id
        .expect("declared");
        assert!(allowed(&gate_on(
            &ctl,
            &asking("forge:runner", "toolu_1"),
            "sess-a"
        )));

        // A daemon restart: a new process, the same OS boot, the same ledger
        // file, the same pane. Only what was held in memory is gone.
        let restarted = Arc::new(Control {
            tokens: SessionTokens::at(
                ctl.config_dir
                    .as_deref()
                    .expect("declaring_control gives one")
                    .join("ct-restart.json"),
            ),

            activity: ctl.activity.clone(),
            masters: ctl.masters.clone(),
            ledger: ctl.ledger.clone(),
            boot_id: ctl.boot_id.clone(),
            config_dir: ctl.config_dir.clone(),
            promises: std::sync::Mutex::new(GateMemory::default()),
            drain: Arc::new(crate::daemon::drain::Drain::unrecorded()),
            hosts: ctl.hosts.clone(),
        });

        // The declaration is still the master's, so the dispatch is allowed.
        assert!(
            allowed(&gate_on(
                &restarted,
                &asking("forge:runner", "toolu_2"),
                "sess-a"
            )),
            "a declaration nothing consumed is still pending after a daemon restart"
        );
        assert_eq!(
            promised_to(&restarted, &run_id).as_deref(),
            Some("toolu_2"),
            "and it is the SAME row, reserved again by the restarted daemon from the ledger \
             rather than from the memory a restart threw away"
        );

        // Both dispatches were allowed, so two children may start. Exactly one
        // binds, and the other is named rather than quietly losing its work.
        for child in ["child-1", "child-2"] {
            bind_declared(
                &restarted,
                Some(child),
                Some("forge:runner"),
                "sess-a",
                0,
                None,
            );
        }
        let held = restarted.ledger.lock().unwrap();
        let bound = held.as_ref().unwrap().run_for_agent("child-1").unwrap();
        drop(held);
        assert!(
            bound.is_some(),
            "the first child binds the one declared row"
        );
        let (_, undeclared) = crate::daemon::degraded::tally(&dir);
        assert_eq!(
            undeclared.count, 1,
            "the child with no row left to bind is the one that must break loudly: {undeclared:?}"
        );
        let said = undeclared.last.unwrap_or_default();
        assert!(said.detail.contains("child-2"), "{said:?}");
        assert_eq!(said.agent.as_deref(), Some("child-2"));
    }

    #[cfg(unix)]
    #[test]
    fn a_replayed_hook_gets_its_answer_back_even_after_its_subagent_started() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        ship_roles(&ctl, &["runner"]);
        let _ = run_declare(
            &ctl,
            "proj-1",
            &["ISS-7".into()],
            "/w/seven",
            "sess-a",
            None,
        )
        .job_id
        .expect("declared");
        let ask = crate::daemon::dispatch_gate::Dispatch {
            agent_id: None,
            subagent_type: Some("forge:runner".into()),
            tool_use_id: Some("toolu_1".into()),
            ..Default::default()
        };
        assert!(dispatch_gate_reply(&ctl, ask.clone(), "sess-a").ok);

        bind_declared(
            &ctl,
            Some("child-1"),
            Some("forge:runner"),
            "sess-a",
            0,
            None,
        );

        assert!(
            dispatch_gate_reply(&ctl, ask.clone(), "sess-a").ok,
            "the same tool call must get the same answer for this daemon's whole life"
        );

        // and it must not have eaten the next declaration.
        let next = run_declare(
            &ctl,
            "proj-1",
            &["ISS-8".into()],
            "/w/eight",
            "sess-a",
            None,
        )
        .job_id
        .expect("declared");
        let mem = ctl.promises.lock().unwrap();
        assert!(
            !mem.promised.contains_key(&next),
            "a replay must reserve nothing: {:?}",
            mem.promised
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_box_that_cannot_read_its_own_registry_allows_and_marks() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner"]);
        *ctl.ledger.lock().unwrap() = None;

        let reply = dispatch_gate_reply(
            &ctl,
            crate::daemon::dispatch_gate::Dispatch {
                agent_id: None,
                subagent_type: Some("forge:runner".into()),
                tool_use_id: Some("toolu_1".into()),
                ..Default::default()
            },
            "sess-a",
        );
        assert!(reply.ok, "an uncertain box must not refuse: {reply:?}");
        assert_eq!(crate::daemon::degraded::tally(&dir).0.count, 1);
    }

    #[cfg(unix)]
    fn asked(tool: Option<&str>, role: &str) -> crate::daemon::dispatch_gate::Dispatch {
        crate::daemon::dispatch_gate::Dispatch {
            agent_id: None,
            subagent_type: Some(role.into()),
            tool_use_id: tool.map(str::to_string),
            ..Default::default()
        }
    }

    /// Review finding 5, where the hand-off may be new work: a draining box
    /// refuses where the gate fails open with no declared run to account for
    /// it, names the drain, claims nothing about what is recorded, and marks
    /// nothing as admitted.
    #[cfg(unix)]
    #[test]
    fn a_draining_box_refuses_an_undecided_hand_off_nothing_was_declared_for() {
        let refused_naming_the_drain = |r: &ClaimReply, door: &str| {
            assert!(
                !r.ok,
                "{door}: a draining box let an undecided, undeclared hand-off through"
            );
            let why = r.reason.clone().unwrap_or_default();
            assert!(
                why.contains("handing over to a new build") && why.contains("could not check"),
                "{door}: the refusal names the drain and why the gate could not decide: {why}"
            );
            assert!(
                !why.contains("Nothing was recorded"),
                "{door}: the refusal claims nothing about the ledger it could not decide on: {why}"
            );
        };

        // No registry at all: whether anything was declared is unknowable.
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner"]);
        *ctl.ledger.lock().unwrap() = None;
        let _attempt = ctl.drain.close_for_test("update 0.1.0 → 0.1.1");
        let r = gate_on(&ctl, &asked(Some("toolu_1"), "forge:runner"), "sess-a");
        refused_naming_the_drain(&r, "no registry");
        assert!(r.reason.unwrap_or_default().contains("cannot be read"));
        assert_eq!(
            crate::daemon::degraded::tally(&dir).0.count,
            0,
            "nothing went through, so nothing is marked"
        );

        // Roles unreadable and nothing declared: Unknown with no run to count.
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let _attempt = ctl.drain.close_for_test("update 0.1.0 → 0.1.1");
        let r = gate_on(&ctl, &asked(Some("toolu_2"), "forge:runner"), "sess-a");
        refused_naming_the_drain(&r, "unknown verdict, nothing declared");
        assert!(r.reason.unwrap_or_default().contains("declared no run"));
    }

    /// The reviewer's probe on the first cut of finding 5: a run declared
    /// before the drain is a holder already, so an Unknown verdict fails open
    /// for it exactly as it would without a drain. Refusing it left a row the
    /// drain waited on that no subagent could ever bind.
    #[cfg(unix)]
    #[test]
    fn a_hand_off_declared_before_the_drain_fails_open_at_an_unknown_verdict() {
        // Roles unreadable (checked before the pending run is looked at).
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let declared = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None);
        assert!(declared.ok, "{:?}", declared.reason);
        let _attempt = ctl.drain.close_for_test("update 0.1.0 → 0.1.1");
        let r = gate_on(&ctl, &asked(Some("toolu_1"), "forge:runner"), "sess-a");
        assert!(
            allowed(&r),
            "roles unreadable, declared before the drain: {r:?}"
        );

        // No tool call id (checked after the pending run was found).
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        ship_roles(&ctl, &["runner"]);
        let declared = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None);
        assert!(declared.ok, "{:?}", declared.reason);
        let _attempt = ctl.drain.close_for_test("update 0.1.0 → 0.1.1");
        let r = gate_on(&ctl, &asked(None, "forge:runner"), "sess-a");
        assert!(
            allowed(&r),
            "no tool call id, declared before the drain: {r:?}"
        );
    }

    /// Second delta review F8: a run declared before the drain that the gate
    /// fails open for is spent once. The same tool call again is a replay and
    /// goes through; a second tool call against that run is refused, naming the
    /// drain and the call it was spent on.
    #[cfg(unix)]
    #[test]
    fn a_pre_drain_run_the_gate_fails_open_for_is_handed_off_once() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let declared = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None);
        assert!(declared.ok, "{:?}", declared.reason);
        let run = declared.job_id.unwrap();
        let _attempt = ctl.drain.close_for_test("update 0.1.0 → 0.1.1");

        let first = gate_on(&ctl, &asked(Some("toolu_1"), "forge:runner"), "sess-a");
        assert!(
            allowed(&first),
            "the declared run's own hand-off: {first:?}"
        );
        let replay = gate_on(&ctl, &asked(Some("toolu_1"), "forge:runner"), "sess-a");
        assert!(
            allowed(&replay),
            "the same tool call again is a replay: {replay:?}"
        );

        let second = gate_on(&ctl, &asked(Some("toolu_2"), "forge:runner"), "sess-a");
        assert!(
            !second.ok,
            "a second subagent against a run spent once is work the drain never counted"
        );
        let why = second.reason.unwrap_or_default();
        assert!(
            why.contains("handing over to a new build")
                && why.contains(&run)
                && why.contains("toolu_1"),
            "the refusal names the drain, the run and the call it was spent on: {why}"
        );
    }

    /// A hand-off covered by a declaration made before the drain is work the
    /// drain already counts, so it still goes through.
    #[cfg(unix)]
    #[test]
    fn a_hand_off_declared_before_the_drain_still_goes_through() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        ship_roles(&ctl, &["runner"]);
        let declared = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None);
        assert!(declared.ok, "{:?}", declared.reason);
        let _attempt = ctl.drain.close_for_test("update 0.1.0 → 0.1.1");
        let r = gate_on(&ctl, &asked(Some("toolu_1"), "forge:runner"), "sess-a");
        assert!(allowed(&r), "{r:?}");
    }

    /// Put a plugin clone shipping these roles inside this Control's own config
    /// directory, which is where both the gate and the denunciation read it.
    #[cfg(unix)]
    fn ship_roles(ctl: &Arc<Control>, roles: &[&str]) -> std::path::PathBuf {
        let dir = ctl.config_dir.clone().expect("a scratch config dir");
        let plugin = dir.join("marketplaces/sidcorp-co__forge-plugin/plugin");
        let agents = plugin.join("agents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        std::fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            r#"{"name": "forge"}"#,
        )
        .unwrap();
        for r in roles {
            std::fs::write(agents.join(format!("{r}.md")), "---\n").unwrap();
        }
        dir
    }

    #[cfg(unix)]
    fn bound_to(ctl: &Arc<Control>, run_id: &str) -> crate::runner::ledger::Run {
        ctl.ledger
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .run(run_id)
            .unwrap()
            .unwrap()
    }

    #[cfg(unix)]
    fn hook(child: &str, agent_type: Option<&str>) -> HookNames {
        HookNames {
            agent_id: Some(child.into()),
            conversation_id: Some("conv-master".into()),
            agent_type: agent_type.map(str::to_string),
            transcript_path: None,
        }
    }

    /// ISS-1378 criteria 1, 2 and 5, the issue's own case: two subagents under
    /// one master, the undeclared one starting first and stopping first, and
    /// the declared run still bound to the declared one and not ended.
    #[cfg(unix)]
    #[test]
    fn a_sibling_helper_starting_and_stopping_first_neither_takes_nor_ends_the_declared_run() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        ship_roles(&ctl, &["runner", "reviewer"]);
        let run_id = run_declare(
            &ctl,
            "proj-1",
            &["ISS-7".into()],
            "/w/seven",
            "sess-a",
            None,
        )
        .job_id
        .expect("declared");
        assert!(allowed(&gate_on(
            &ctl,
            &asking("forge:runner", "toolu_1"),
            "sess-a"
        )));

        let said = crate::log_capture::logged_while(|| {
            agent_event(
                &ctl,
                "SubagentStart",
                Some(1_000),
                &hook("helper-1", Some("general-purpose")),
                "sess-a",
                None,
            );
        });
        assert_eq!(
            bound_to(&ctl, &run_id).agent_id,
            None,
            "criterion 1: a search helper starting first takes nothing: {said}"
        );
        assert!(
            said.contains("is not run") && said.contains("no role this box ships"),
            "and the journal says why it was turned away: {said}"
        );

        agent_event(
            &ctl,
            "SubagentStart",
            Some(2_000),
            &hook("runner-1", Some("forge:runner")),
            "sess-a",
            None,
        );
        agent_event(
            &ctl,
            "SubagentStop",
            Some(3_000),
            &hook("helper-1", Some("general-purpose")),
            "sess-a",
            None,
        );
        let run = bound_to(&ctl, &run_id);
        assert_eq!(
            run.agent_id.as_deref(),
            Some("runner-1"),
            "criterion 2: the declared run is the declared subagent's"
        );
        assert_eq!(
            run.ended_by, None,
            "criterion 5: the helper's stop ends nothing of a run it never was"
        );
        assert_eq!(
            run.turn_ended_at_ms, None,
            "and is not even recorded as the run's turn end"
        );
    }

    /// ISS-1378 criterion 3: a shipped role the run was not promised to is an
    /// undeclared hand-off, never the run.
    #[cfg(unix)]
    #[test]
    fn a_shipped_role_other_than_the_promised_one_is_named_and_does_not_bind() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner", "reviewer"]);
        let run_id = run_declare(
            &ctl,
            "proj-1",
            &["ISS-7".into()],
            "/w/seven",
            "sess-a",
            None,
        )
        .job_id
        .expect("declared");
        assert!(allowed(&gate_on(
            &ctl,
            &asking("forge:runner", "toolu_1"),
            "sess-a"
        )));

        bind_declared(
            &ctl,
            Some("rev-1"),
            Some("forge:reviewer"),
            "sess-a",
            0,
            None,
        );
        assert_eq!(bound_to(&ctl, &run_id).agent_id, None);
        let (_, undeclared) = crate::daemon::degraded::tally(&dir);
        assert_eq!(undeclared.count, 1, "{undeclared:?}");
        let last = undeclared.last.unwrap_or_default();
        assert_eq!(last.agent.as_deref(), Some("rev-1"));
        let detail = last.detail;
        assert!(
            detail.contains(&format!("the run its master declared, {run_id}, is not its"))
                && detail.contains("promised to a `forge:runner` dispatch")
                && !detail.contains("nothing declared"),
            "judge iss-1378-a823d04f: a declaration that exists is not reported as missing: {detail}"
        );

        bind_declared(&ctl, Some("run-1"), Some("forge:runner"), "sess-a", 0, None);
        assert_eq!(
            bound_to(&ctl, &run_id).agent_id.as_deref(),
            Some("run-1"),
            "the promised role still binds once it starts"
        );
    }

    /// Write the metadata Claude Code keeps for subagent `child` of the
    /// conversation whose transcript is `lead`.
    #[cfg(unix)]
    fn started_as(lead: &Path, child: &str, role: &str) {
        let t = crate::daemon::transcript_age::child_transcript(lead, child).unwrap();
        std::fs::create_dir_all(t.parent().unwrap()).unwrap();
        std::fs::write(
            t.with_extension("meta.json"),
            format!(r#"{{"agentType":"{role}","toolUseId":"toolu_first"}}"#),
        )
        .unwrap();
    }

    #[cfg(unix)]
    fn resuming(child: &str, lead: &Path) -> crate::daemon::dispatch_gate::Dispatch {
        crate::daemon::dispatch_gate::Dispatch {
            resumes: Some(child.into()),
            transcript_path: Some(lead.to_string_lossy().into_owned()),
            tool_use_id: Some(format!("toolu_resume_{child}")),
            ..Default::default()
        }
    }

    #[cfg(unix)]
    fn declare_seven(ctl: &Arc<Control>) -> String {
        run_declare(ctl, "proj-1", &["ISS-7".into()], "/w/seven", "sess-a", None)
            .job_id
            .expect("declared")
    }

    /// Judge iss-1378-a823d04f, run b229ea3b: a master that answers its
    /// declaration by resuming a subagent of a shipped role with
    /// `SendMessage` binds the run to it at the tool call, and
    /// the resume is never refused. A helper resumed the same way does not.
    #[cfg(unix)]
    #[test]
    fn a_subagent_its_master_resumes_binds_the_declared_run_and_a_helper_does_not() {
        let (ctl, _t, dir) = declaring_control("sess-a", "proj-1");
        ship_roles(&ctl, &["runner"]);
        let lead = dir.join("conv.jsonl");
        started_as(&lead, "a4301aac9619978a0", "forge:runner");
        started_as(&lead, "asearch00000000", "Explore");
        let run_id = declare_seven(&ctl);

        assert!(dispatch_gate_reply(&ctl, resuming("asearch00000000", &lead), "sess-a").ok);
        assert_eq!(
            bound_to(&ctl, &run_id).agent_id,
            None,
            "a helper is not the run's"
        );
        assert!(
            dispatch_gate_reply(&ctl, resuming("anometa00000000", &lead), "sess-a").ok,
            "a subagent whose role cannot be read is let through"
        );
        assert_eq!(
            bound_to(&ctl, &run_id).agent_id,
            None,
            "and is not taken for the run's"
        );

        assert!(dispatch_gate_reply(&ctl, resuming("a4301aac9619978a0", &lead), "sess-a").ok);
        let run = bound_to(&ctl, &run_id);
        assert_eq!(run.agent_id.as_deref(), Some("a4301aac9619978a0"));
        assert_eq!(
            run.agent_transcript.as_deref(),
            crate::daemon::transcript_age::child_transcript(&lead, "a4301aac9619978a0")
                .map(|p| p.to_string_lossy().into_owned())
                .as_deref(),
            "the run keeps where its subagent writes from the resume"
        );
    }

    /// A resumed subagent answers to one open run: while the run it already
    /// answers to is open, the new declaration stays unbound, and once that
    /// run is closed the resume binds it.
    #[cfg(unix)]
    #[test]
    fn a_resumed_subagent_still_answering_to_an_open_run_does_not_take_a_second() {
        let (ctl, _t, dir) = declaring_control("sess-a", "proj-1");
        ship_roles(&ctl, &["runner"]);
        let lead = dir.join("conv.jsonl");
        started_as(&lead, "a4301aac9619978a0", "forge:runner");
        let first = declare_seven(&ctl);
        bind_declared(
            &ctl,
            Some("a4301aac9619978a0"),
            Some("forge:runner"),
            "sess-a",
            0,
            None,
        );
        assert_eq!(
            bound_to(&ctl, &first).agent_id.as_deref(),
            Some("a4301aac9619978a0")
        );
        let second = run_declare(
            &ctl,
            "proj-1",
            &["ISS-8".into()],
            "/w/eight",
            "sess-a",
            None,
        )
        .job_id
        .expect("declared");

        assert!(dispatch_gate_reply(&ctl, resuming("a4301aac9619978a0", &lead), "sess-a").ok);
        assert_eq!(bound_to(&ctl, &second).agent_id, None);

        assert!(run_close(&ctl, &first, Some("its report is in"), "sess-a").ok);
        assert!(dispatch_gate_reply(&ctl, resuming("a4301aac9619978a0", &lead), "sess-a").ok);
        assert_eq!(
            bound_to(&ctl, &second).agent_id.as_deref(),
            Some("a4301aac9619978a0"),
            "a subagent whose run has ended may be resumed onto the next"
        );
    }

    /// ISS-1378 criterion 4.
    #[cfg(unix)]
    #[test]
    fn a_start_naming_no_agent_type_leaves_the_run_unbound_and_says_it_cannot_tell() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        ship_roles(&ctl, &["runner"]);
        let run_id = run_declare(
            &ctl,
            "proj-1",
            &["ISS-7".into()],
            "/w/seven",
            "sess-a",
            None,
        )
        .job_id
        .expect("declared");
        let said = crate::log_capture::logged_while(|| {
            bind_declared(&ctl, Some("child-x"), None, "sess-a", 0, None);
        });
        assert_eq!(bound_to(&ctl, &run_id).agent_id, None);
        assert!(
            said.contains("which agent is the run's cannot be told"),
            "{said}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_subagent_started_under_a_shipped_role_with_nothing_declared_is_named_and_counted() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner", "reviewer"]);

        bind_declared(
            &ctl,
            Some("child-nobody-declared"),
            Some("forge:runner"),
            "sess-a",
            0,
            None,
        );

        let (_, undeclared) = crate::daemon::degraded::tally(&dir);
        assert_eq!(undeclared.count, 1, "the count an operator reads must move");
        let said = undeclared.last.unwrap_or_default();
        assert!(said.detail.contains("child-nobody-declared"), "{said:?}");
        assert!(
            said.detail.contains("runner"),
            "which role it was dispatched through is half of what makes it actionable: {said:?}"
        );
        assert_eq!(said.agent.as_deref(), Some("child-nobody-declared"));
        assert_eq!(
            said.role.as_deref(),
            Some("forge:runner"),
            "the role is a field a reader can filter on, not only a phrase in a sentence"
        );
    }

    /// Review F2: an inventory read whole once is what decides, when the
    /// next read fails, which dispatch the promise may go to: another
    /// plugin's helper is not the run's however it is namespaced.
    #[cfg(unix)]
    #[test]
    fn an_inventory_read_before_decides_who_takes_the_promise_when_it_cannot_be_read() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner"]);
        assert!(allowed(&gate_on(
            &ctl,
            &asking("Explore", "toolu_read"),
            "sess-a"
        )));
        std::fs::remove_dir_all(dir.join("marketplaces")).unwrap();
        let run_id = declare_seven(&ctl);
        assert!(allowed(&gate_on(
            &ctl,
            &asking("other:helper", "toolu_h"),
            "sess-a"
        )));
        bind_declared(
            &ctl,
            Some("helper-0"),
            Some("other:helper"),
            "sess-a",
            0,
            None,
        );
        assert_eq!(bound_to(&ctl, &run_id).agent_id, None);
        assert!(allowed(&gate_on(
            &ctl,
            &asking("forge:runner", "toolu_1"),
            "sess-a"
        )));
        bind_declared(&ctl, Some("run-1"), Some("forge:runner"), "sess-a", 0, None);
        assert_eq!(bound_to(&ctl, &run_id).agent_id.as_deref(), Some("run-1"));
    }

    /// ISS-1378 judging (8012bc54 #2): a `SendMessage` resume fires
    /// `SubagentStart` too, so a resumed subagent that answers to nothing
    /// declared is named as resumed, not as started.
    #[cfg(unix)]
    #[test]
    fn a_resumed_subagent_with_nothing_declared_is_named_as_resumed() {
        let (ctl, _t, scratch) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner"]);
        let lead = scratch.join("conv.jsonl");
        started_as(&lead, "a4301aac9619978a0", "forge:runner");

        assert!(dispatch_gate_reply(&ctl, resuming("a4301aac9619978a0", &lead), "sess-a").ok);
        bind_declared(
            &ctl,
            Some("a4301aac9619978a0"),
            Some("forge:runner"),
            "sess-a",
            0,
            Some(&lead.to_string_lossy()),
        );
        let (_, undeclared) = crate::daemon::degraded::tally(&dir);
        let detail = undeclared.last.unwrap_or_default().detail;
        assert!(
            detail.contains("subagent a4301aac9619978a0 was resumed as `forge:runner`")
                && !detail.contains("started as"),
            "{detail}"
        );

        bind_declared(
            &ctl,
            Some("afresh0000000000"),
            Some("forge:runner"),
            "sess-a",
            0,
            None,
        );
        let (_, undeclared) = crate::daemon::degraded::tally(&dir);
        let detail = undeclared.last.unwrap_or_default().detail;
        assert!(
            detail.contains("subagent afresh0000000000 started as `forge:runner`"),
            "a start that followed no resume is still a start: {detail}"
        );
    }

    /// ISS-1378 judging (8012bc54 #4): where this box cannot read which roles
    /// it ships, the gate lets a dispatch through, and the subagent that
    /// starts as the role that dispatch named is the run's. Before, it was
    /// never bound and the box ended its run at 60m as never bound.
    #[cfg(unix)]
    #[test]
    fn with_no_role_inventory_the_promised_role_still_binds_its_run() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let run_id = declare_seven(&ctl);
        assert!(allowed(&gate_on(
            &ctl,
            &asking("general-purpose", "toolu_h"),
            "sess-a"
        )));
        bind_declared(
            &ctl,
            Some("helper-0"),
            Some("general-purpose"),
            "sess-a",
            0,
            None,
        );
        assert_eq!(
            bound_to(&ctl, &run_id).agent_id,
            None,
            "review F2: a helper dispatched first is let through and takes no promise"
        );
        assert!(allowed(&gate_on(
            &ctl,
            &asking("forge:runner", "toolu_1"),
            "sess-a"
        )));
        for (child, role) in [("helper-1", "general-purpose"), ("rev-1", "forge:reviewer")] {
            bind_declared(&ctl, Some(child), Some(role), "sess-a", 0, None);
            assert_eq!(
                bound_to(&ctl, &run_id).agent_id,
                None,
                "{role} is not the run's"
            );
        }
        bind_declared(&ctl, Some("run-1"), Some("forge:runner"), "sess-a", 0, None);
        assert_eq!(
            bound_to(&ctl, &run_id).agent_id.as_deref(),
            Some("run-1"),
            "the role the dispatch named binds the run it was let through for"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_subagent_that_is_not_a_shipped_role_stays_silent() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner", "reviewer"]);

        for role in [Some("general-purpose"), Some("Explore"), None] {
            bind_declared(&ctl, Some("a-search"), role, "sess-a", 0, None);
        }

        let (_, undeclared) = crate::daemon::degraded::tally(&dir);
        assert_eq!(
            undeclared.count, 0,
            "a helper is not a hand-off: {undeclared:?}"
        );
    }

    #[test]
    fn a_ledger_this_box_cannot_read_is_not_an_undeclared_hand_off() {
        // The shape: a child that IS correctly bound, whose start arrives while the ledger read
        // fails (SQLITE_BUSY outlasting `PRAGMA busy_timeout`, a corrupt page, a revoked file).
        // The read establishes nothing, so it may not assert the one thing the undeclared alarm
        // asserts. It is the same false alarm the replay check removed, coming back through the
        // error channel.
        assert_eq!(
            classify_start(Err("database is locked".to_string())),
            StartKind::Unreadable("database is locked".to_string()),
            "a failed read of our own ledger is not evidence that nothing was declared"
        );
        assert_eq!(
            classify_start(Ok(None)),
            StartKind::Undeclared,
            "a read that answered `no row` IS the evidence, and it stays loud"
        );
        assert_eq!(
            classify_start(Ok(Some("run-9".to_string()))),
            StartKind::Replay("run-9".to_string()),
            "a child that already holds a run is a replay"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_replayed_start_for_an_already_bound_child_raises_no_alarm() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner"]);
        let _ = run_declare(
            &ctl,
            "proj-1",
            &["ISS-7".into()],
            "/w/seven",
            "sess-a",
            None,
        )
        .job_id
        .expect("declared");

        for _ in 0..3 {
            bind_declared(
                &ctl,
                Some("child-1"),
                Some("forge:runner"),
                "sess-a",
                0,
                None,
            );
        }

        let (_, undeclared) = crate::daemon::degraded::tally(&dir);
        assert_eq!(
            undeclared.count, 0,
            "a replayed start for a child that already has its run is not an undeclared hand-off: {undeclared:?}"
        );
    }

    /// A child that DOES answer to a declaration is bound, not denounced.
    #[cfg(unix)]
    #[test]
    fn a_declared_hand_off_is_bound_and_nothing_is_counted_against_it() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner"]);
        let _ = run_declare(
            &ctl,
            "proj-1",
            &["ISS-7".into()],
            "/w/seven",
            "sess-a",
            None,
        )
        .job_id
        .expect("declared");

        bind_declared(
            &ctl,
            Some("child-1"),
            Some("forge:runner"),
            "sess-a",
            0,
            None,
        );

        let (_, undeclared) = crate::daemon::degraded::tally(&dir);
        assert_eq!(undeclared.count, 0, "{undeclared:?}");
        let held = ctl.ledger.lock().unwrap();
        assert!(
            held.as_ref()
                .unwrap()
                .run_for_agent("child-1")
                .unwrap()
                .is_some(),
            "the declared row must be bound to the child that started"
        );
    }

    /// ISS-1312 criteria 56 and 57: the row records the Claude Code process
    /// above whatever reported for the run, read off the socket's peer: the
    /// master's `run declare`, then its subagent's own start and stop hooks.
    /// Run e67c08e0's ran in a background session outside the pane, which is
    /// why the pane cannot stand in for it.
    #[cfg(unix)]
    #[test]
    fn a_run_records_the_claude_code_process_above_what_reported_for_it() {
        use crate::daemon::subagent_host::Host;
        let hosts = Arc::new(crate::daemon::subagent_host::testing::FakeHosts::default());
        let host = |pid: u32, start: &str| Host {
            pid,
            start: start.into(),
        };
        {
            let mut peers = hosts.peers.lock().unwrap();
            peers.insert(900_001, host(3_850_261, "901"));
            // The start's hook runs under a process other than the
            // declaration's, so the start's own record is what the row shows
            // after it (the eighth judge's J5, plant j8:P57a).
            peers.insert(900_002, host(3_860_444, "933"));
            peers.insert(900_003, host(3_990_000, "977"));
        }
        let (ctl, _t, _dir) = declaring_control_over("sess-a", "proj-1", hosts);
        ship_roles(&ctl, &["runner"]);
        let row = |ctl: &Arc<Control>| {
            let held = ctl.ledger.lock().unwrap();
            let led = held.as_ref().unwrap();
            let id = led.runs_for_master("sess-a").unwrap()[0].run_id.clone();
            let run = led.run(&id).unwrap().unwrap();
            (run.host_pid, run.host_start)
        };
        run_declare(
            &ctl,
            "proj-1",
            &["ISS-659".into()],
            "/w/659",
            "sess-a",
            Some(900_001),
        )
        .job_id
        .expect("declared");
        assert_eq!(
            row(&ctl),
            (Some(3_850_261), Some("901".into())),
            "criterion 56"
        );

        let child = HookNames {
            agent_id: Some("afb821edfc48c7694".into()),
            conversation_id: Some("19793a14".into()),
            agent_type: Some("forge:runner".into()),
            transcript_path: None,
        };
        agent_event(
            &ctl,
            "SubagentStart",
            Some(10),
            &child,
            "sess-a",
            Some(900_002),
        );
        assert_eq!(
            row(&ctl),
            (Some(3_860_444), Some("933".into())),
            "criterion 57: the start's hook ran under another process, and the start recorded it"
        );
        agent_event(
            &ctl,
            "SubagentStop",
            Some(20),
            &child,
            "sess-a",
            Some(900_003),
        );
        assert_eq!(
            row(&ctl),
            (Some(3_990_000), Some("977".into())),
            "criterion 57: the stop's hook ran under another process, and the latest stands"
        );
        agent_event(
            &ctl,
            "SubagentStop",
            Some(30),
            &child,
            "sess-a",
            Some(900_404),
        );
        agent_event(&ctl, "SubagentStop", Some(40), &child, "sess-a", None);
        assert_eq!(
            row(&ctl),
            (Some(3_990_000), Some("977".into())),
            "a report with no Claude Code process above it, or no peer at all, records nothing"
        );
    }

    /// Criterion 56 through the socket itself: the process a declaration is
    /// recorded under is the one on the far end of the connection, read off
    /// the socket, and nothing the frame says can name another.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_declaration_over_the_socket_records_the_process_on_its_far_end() {
        use crate::daemon::subagent_host::Host;
        let hosts = Arc::new(crate::daemon::subagent_host::testing::FakeHosts::default());
        hosts.peers.lock().unwrap().insert(
            std::process::id(),
            Host {
                pid: 3_850_261,
                start: "901".into(),
            },
        );
        let (ctl, token, _dir) = declaring_control_over("sess-a", "proj-1", hosts);
        let (near, far) = UnixStream::pair().unwrap();
        let served = tokio::spawn(serve_one(Arc::clone(&ctl), far));
        let mut near = BufReader::new(near);
        let frame = serde_json::json!({
            "op": "run_declare", "token": token, "projectId": "proj-1",
            "issueKeys": ["ISS-659"], "worktreePath": "/w/659"
        });
        near.get_mut()
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .unwrap();
        let mut reply = String::new();
        near.read_line(&mut reply).await.unwrap();
        served.await.unwrap();
        assert!(reply.contains("\"ok\":true"), "declared: {reply}");
        let held = ctl.ledger.lock().unwrap();
        let led = held.as_ref().unwrap();
        let id = led.runs_for_master("sess-a").unwrap()[0].run_id.clone();
        let run = led.run(&id).unwrap().unwrap();
        // Linux is the platform this peer read is measured on; elsewhere the
        // declaration must still go through, whatever it can record.
        if cfg!(target_os = "linux") {
            assert_eq!(
                (run.host_pid, run.host_start.as_deref()),
                (Some(3_850_261), Some("901")),
                "criterion 56: the row records the process above the socket's peer"
            );
        }
    }

    /// The frame under test is the one `request_dispatch_gate` actually sends,
    /// not a literal beside it: a copied wire contract parts from its original
    /// without either side going red (ISS-1192, consult 5c9471 F1).
    #[test]
    fn the_frame_the_gate_sends_decodes_as_the_daemon_reads_it() {
        let frame = dispatch_gate_frame(
            "t1",
            &crate::daemon::dispatch_gate::Dispatch {
                agent_id: None,
                subagent_type: Some("runner".into()),
                tool_use_id: Some("toolu_1".into()),
                resumes: Some("a4301aac9619978a0".into()),
                transcript_path: Some("/h/conv.jsonl".into()),
            },
        )
        .to_string();
        let req: Request = serde_json::from_str(&frame).expect("the gate frame must decode");
        let Request::DispatchGate {
            agent_id,
            subagent_type,
            tool_use_id,
            resumes,
            transcript_path,
            ..
        } = &req
        else {
            panic!("a frame whose op is `dispatch_gate` must decode as one");
        };
        assert!(agent_id.is_none());
        assert_eq!(subagent_type.as_deref(), Some("runner"));
        assert_eq!(tool_use_id.as_deref(), Some("toolu_1"));
        assert_eq!(resumes.as_deref(), Some("a4301aac9619978a0"));
        assert_eq!(transcript_path.as_deref(), Some("/h/conv.jsonl"));
    }

    #[test]
    fn a_choice_frame_from_the_cli_decodes_with_its_run_choice_and_reason() {
        let frame = r#"{"op":"run_choice","token":"t1","runId":"r-1","choice":"restart","why":"nothing was started"}"#;
        let req: Request = serde_json::from_str(frame).expect("the choice frame must decode");
        let Request::RunChoice {
            run_id,
            choice,
            why,
            ..
        } = &req
        else {
            panic!("a frame whose op is `run_choice` must decode as one");
        };
        assert_eq!(run_id, "r-1");
        assert_eq!(choice, "restart");
        assert_eq!(why, "nothing was started");
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
        let src = crate::test_scratch::lf(include_str!("control.rs"));
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

    #[cfg(unix)]
    mod unix {
        use super::*;

        /// Criteria 1 and 2: a declaration made while a drain holds admission
        /// is refused naming the drain, and leaves nothing on the ledger.
        #[test]
        fn a_declaration_during_a_drain_is_refused_naming_it_and_writes_nothing() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let _attempt = ctl.drain.close_for_test("update 0.1.0 → 0.1.1");
            let reply = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None);
            assert!(
                !reply.ok,
                "a drain that admits a run is waiting on a queue it refills"
            );
            let why = reply.reason.unwrap_or_default();
            assert!(
                why.contains("handing over to a new build") && why.contains("update 0.1.0 → 0.1.1"),
                "the refusal names the drain and its cause: {why}"
            );
            assert!(
                ctl.ledger
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .unclosed_runs()
                    .unwrap()
                    .is_empty(),
                "a refused declaration writes no row"
            );
        }

        /// The permit's lifetime, run: a declaration stuck between the gate and
        /// its ledger write still holds its permit when a drain begins, so the
        /// drain counts it, and the row it then writes is not one the drain
        /// read the box idle without.
        #[test]
        fn a_declaration_between_the_gate_and_its_write_holds_its_permit() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let held = ctl.ledger.lock().unwrap();
            let declaring = {
                let ctl = ctl.clone();
                std::thread::spawn(move || {
                    run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None)
                })
            };
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while ctl.drain.admitting() == 0 {
                assert!(std::time::Instant::now() < deadline, "the declaration waiting on the ledger holds no permit, so a drain would read the box idle without its row");
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            let _attempt = ctl.drain.close_for_test("update 0.1.0 → 0.1.1");
            std::thread::sleep(std::time::Duration::from_millis(50));
            assert_eq!(
                ctl.drain.admitting(),
                1,
                "the declaration blocked on the ledger still holds its permit once the drain has begun"
            );
            drop(held);
            let reply = declaring.join().unwrap();
            assert!(
                reply.ok,
                "it was admitted before the drain: {:?}",
                reply.reason
            );
            assert_eq!(
                ctl.drain.admitting(),
                0,
                "and the permit goes once the row is written"
            );
        }

        /// ISS-1379, criteria 3, 4 and 34, over ISS-1223's reproduction. A
        /// master declares a run every three minutes and each runs ten, so
        /// three or four are open at any moment, and one declaration is never
        /// bound at all. An update begun among them while a chat turn is in
        /// flight admits what is declared while it waits — the first a minute
        /// after it began — and hands over within a minute of that turn ending,
        /// however many runs the ledger still holds. Before ISS-1379 the same
        /// box refused every declaration from the moment the drain began, and
        /// the unbound one held it the whole two hours.
        #[tokio::test(start_paused = true)]
        async fn a_handover_among_a_declaring_master_admits_while_it_waits_and_runs_hold_nothing() {
            use crate::daemon::drain::{self, Drained, NextAttempt};
            use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
            use std::time::Duration;
            use tokio::time::Instant;

            const EVERY: Duration = Duration::from_secs(3 * 60);
            const LASTS: Duration = Duration::from_secs(10 * 60);
            const TURN: Duration = Duration::from_secs(15 * 60);

            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            // A master may hold one unbound declaration at a time, so the one
            // nothing will ever bind is planted under the pane before it.
            const UNBOUND: &str = "run-unbound";
            ctl.ledger
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .create_run_group(crate::runner::ledger::NewRun {
                    run_id: UNBOUND.into(),
                    project_id: "proj-1".into(),
                    master_session_id: "sess-before".into(),
                    worktree_path: std::path::PathBuf::from("/w/never"),
                    boot_id: ctl.boot_id.clone(),
                    issue_keys: vec!["ISS-900".into()],
                })
                .unwrap();
            let began = Arc::new(AtomicBool::new(false));
            let after = Arc::new(AtomicUsize::new(0));
            {
                let (ctl, began, after) = (ctl.clone(), began.clone(), after.clone());
                tokio::spawn(async move {
                    let mut open: Vec<(String, Instant)> = Vec::new();
                    let mut n = 0u32;
                    loop {
                        n += 1;
                        {
                            let held = ctl.ledger.lock().unwrap();
                            let led = held.as_ref().unwrap();
                            open.retain(|(id, at)| {
                                if at.elapsed() >= LASTS {
                                    led.end_run(id, "master", "its report is in").unwrap();
                                    false
                                } else {
                                    true
                                }
                            });
                        }
                        let reply = run_declare(
                            &ctl,
                            "proj-1",
                            &[format!("ISS-{n}")],
                            &format!("/w/{n}"),
                            "sess-a",
                            None,
                        );
                        if let (true, Some(id)) = (reply.ok, reply.job_id) {
                            let held = ctl.ledger.lock().unwrap();
                            held.as_ref()
                                .unwrap()
                                .bind_agent(&id, &format!("child-{n}"))
                                .unwrap();
                            open.push((id, Instant::now()));
                            if began.load(Ordering::Acquire) {
                                after.fetch_add(1, Ordering::AcqRel);
                            }
                        }
                        tokio::time::sleep(EVERY).await;
                    }
                });
            }
            tokio::time::sleep(Duration::from_secs(30 * 60)).await;
            let open_runs = || {
                ctl.ledger
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .unclosed_runs()
                    .unwrap()
                    .len()
            };
            assert!(open_runs() >= 4, "the fleet is busy when the update lands");

            let inflight = drain::Turns::new();
            let turn_ended = Arc::new(std::sync::Mutex::new(None::<Instant>));
            {
                let turn = inflight.enter("a chat turn in session chat-1");
                let turn_ended = turn_ended.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(TURN).await;
                    *turn_ended.lock().unwrap() = Some(Instant::now());
                    drop(turn);
                });
            }
            let first = {
                let ctl = ctl.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    let reply = run_declare(
                        &ctl,
                        "proj-1",
                        &["ISS-1379".into()],
                        "/w/first",
                        "sess-a",
                        None,
                    );
                    if let Some(id) = reply.job_id.as_deref() {
                        let held = ctl.ledger.lock().unwrap();
                        held.as_ref()
                            .unwrap()
                            .bind_agent(id, "child-first")
                            .unwrap();
                    }
                    reply
                })
            };
            began.store(true, Ordering::Release);
            let out = drain::drain_to_idle(
                &ctl.drain,
                "update",
                "update 0.1.0 → 0.1.1",
                &inflight,
                || std::future::ready(0),
                || NextAttempt {
                    by: "the next update check".into(),
                    due_in: Duration::from_secs(4 * 3600),
                },
            )
            .await;
            let handed_at = Instant::now();
            assert_eq!(out, Drained::Idle);
            let first = first.await.unwrap();
            assert!(
                first.ok,
                "criterion 34: a declaration a minute into the handover is admitted: {:?}",
                first.reason
            );
            assert!(
                after.load(Ordering::Acquire) >= 4,
                "criterion 4: the master's own declarations go on being admitted while the handover waits"
            );
            let ended = turn_ended.lock().unwrap().expect("the turn ended");
            assert!(
                handed_at.duration_since(ended) <= Duration::from_secs(60),
                "criterion 1: handed over {:?} after the last in-process work ended",
                handed_at.duration_since(ended)
            );
            assert!(
                open_runs() >= 4,
                "criterion 3: runs were still open, the unbound one among them, and held nothing"
            );
            let held = ctl.ledger.lock().unwrap();
            assert!(
                held.as_ref()
                    .unwrap()
                    .run(UNBOUND)
                    .unwrap()
                    .unwrap()
                    .ended_by
                    .is_none(),
                "the unbound declaration is still open, and did not hold the handover"
            );
            drop(held);
            let refused = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/late", "sess-a", None);
            assert!(
                !refused.ok
                    && refused
                        .reason
                        .as_deref()
                        .unwrap_or("")
                        .contains("handing over to a new build"),
                "criterion 5: the closing window refuses by name until the image is replaced: {refused:?}"
            );
            // criterion 5: the window is bounded at ten seconds.
            const { assert!(drain::HANDOVER_QUIET_SECS <= 10) };
        }

        #[test]
        fn a_choice_outside_the_three_words_is_refused_naming_them() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
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
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let run_id = declared_and_inherited(&ctl, "proj-1", "sess-a");

            let reply = run_choice(&ctl, &run_id, "leave", "   ", "sess-a");

            assert!(!reply.ok, "a choice needs its reason");
        }

        #[test]
        fn a_pane_cannot_answer_for_a_run_it_did_not_inherit() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let run_id = declared_and_inherited(&ctl, "proj-1", "sess-a");

            let reply = run_choice(&ctl, &run_id, "leave", "not mine", "some-other-session");

            assert!(
                !reply.ok,
                "another pane's run is not this pane's to answer for"
            );
        }

        /// ISS-1312 criteria 37 and 38: an ending is recorded once. A second
        /// close used to answer `ok` and write its own reason over the first,
        /// so the row said whatever the last caller typed.
        #[test]
        fn a_second_close_is_refused_quoting_the_first_and_changes_nothing() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let run_id = run_declare(
                &ctl,
                "proj-1",
                &["ISS-7".into()],
                "/w/seven",
                "sess-a",
                None,
            )
            .job_id
            .expect("declared");
            assert!(run_close(&ctl, &run_id, Some("its report is in"), "sess-a").ok);

            let again = run_close(&ctl, &run_id, Some("second thoughts"), "sess-a");

            assert!(!again.ok, "a run already ended cannot be ended again");
            let reason = again.reason.unwrap_or_default();
            for said in [run_id.as_str(), "master", "its report is in"] {
                assert!(
                    reason.contains(said),
                    "the refusal quotes the ending already recorded, missing `{said}`: {reason}"
                );
            }
            let held = ctl.ledger.lock().unwrap();
            let row = held.as_ref().unwrap().run(&run_id).unwrap().unwrap();
            assert_eq!(
                (row.ended_by.as_deref(), row.ended_reason.as_deref()),
                (Some("master"), Some("its report is in")),
                "the first ending stands"
            );
        }

        /// ISS-1312 criteria 39 and 40: a choice is recorded once. A second one
        /// used to answer `ok` and replace the first reason with nothing said.
        #[test]
        fn a_second_choice_is_refused_quoting_the_first_and_changes_nothing() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let run_id = declared_and_inherited(&ctl, "proj-1", "sess-a");
            assert!(run_choice(&ctl, &run_id, "continue", "the branch stands", "sess-a").ok);

            let again = run_choice(&ctl, &run_id, "restart", "on reflection", "sess-a");

            assert!(
                !again.ok,
                "a run already answered for cannot be answered for again"
            );
            let reason = again.reason.unwrap_or_default();
            for said in [run_id.as_str(), "continue", "the branch stands"] {
                assert!(
                    reason.contains(said),
                    "the refusal quotes the choice already recorded, missing `{said}`: {reason}"
                );
            }
            let held = ctl.ledger.lock().unwrap();
            let row = held.as_ref().unwrap().run(&run_id).unwrap().unwrap();
            assert_eq!(
                (
                    row.resume_choice.as_deref(),
                    row.resume_choice_why.as_deref()
                ),
                (Some("continue"), Some("the branch stands")),
                "the first choice stands"
            );
        }

        #[test]
        fn a_frame_carrying_no_known_token_names_nobody() {
            let dir = crate::test_scratch::Scratch::new("ct");
            let tokens = SessionTokens::at(dir.join("control-tokens.json"));
            tokens
                .mint("sess-a", "proj-a", "proj-a-slug", "pane-a")
                .unwrap();
            assert_eq!(tokens.session_for("forged"), None);
        }
        #[test]
        fn a_declaration_writes_a_row_and_answers_its_id() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let reply = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None);
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
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let reply = run_declare(
                &ctl,
                "proj-OTHER",
                &["ISS-1".into()],
                "/w/one",
                "sess-a",
                None,
            );
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
        fn a_pane_this_daemon_has_not_adopted_is_refused_with_what_the_sweep_recorded() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let reply = run_declare(
                &ctl,
                "proj-1",
                &["ISS-1".into()],
                "/w/one",
                "sess-UNKNOWN",
                None,
            );
            assert!(!reply.ok);
            let why = reply.reason.unwrap_or_default();
            assert_eq!(
                why,
                ctl.masters.why_unplaced("proj-1"),
                "the refusal is the registry's account of this project and nothing the handler composed itself, or the two drift and only one of them is ever read"
            );
            assert!(
                why.contains("sess-a") && why.contains("stale"),
                "this box holds a master for proj-1 under another session, which is the stale-capability state, and the pane is owed that rather than a wait: {why}"
            );
        }

        /// Judge r2's note on the Outcome's "at once": the image an exec
        /// starts refused every master's declaration until its first sweep
        /// refilled the registry. Handed the registry the image before it
        /// served, it answers the same declaration at once.
        #[test]
        fn a_declaration_right_after_a_handover_is_served_from_the_registry_handed_across() {
            use crate::daemon::master_handed;
            let dir = crate::test_scratch::Scratch::new("ct-handed");
            let tokens = SessionTokens::at(dir.join("control-tokens.json"));
            let token = tokens.mint("sess-a", "proj-1", "slug", "pane-1").unwrap();
            let declare = |ctl: &Arc<Control>| {
                served(
                    ctl,
                    serde_json::json!({
                        "op": "run_declare", "token": token, "projectId": "proj-1",
                        "issueKeys": ["ISS-1"], "worktreePath": "/w/one"
                    }),
                )
            };

            let fresh = control_over(
                SessionTokens::at(dir.join("control-tokens.json")),
                Arc::new(crate::daemon::master::Masters::new()),
                &dir,
            );
            let unread = declare(&fresh);
            assert!(!unread.ok);
            assert!(
                unread
                    .reason
                    .unwrap_or_default()
                    .contains("has not yet read which projects it serves"),
                "an image with nothing handed to it waits for its first sweep"
            );

            let old = crate::daemon::master::Masters::new();
            old.remember_for_test("proj-1", "sess-a", "pane-1");
            old.note_served(crate::daemon::master::Served::Read(vec!["proj-1".into()]));
            let (served_ids, masters) = old.hand_on();
            master_handed::write(
                &dir,
                &master_handed::Handed {
                    pid: 4242,
                    boot_id: Some("boot-a".into()),
                    written_at_ms: 1_000,
                    served: served_ids,
                    masters,
                },
            )
            .unwrap();
            let master_handed::Taken::Handed(handed) =
                master_handed::take(&dir, 4242, Some("boot-a"), 1_200)
            else {
                panic!("the registry its own pid wrote is taken");
            };
            let next = crate::daemon::master::Masters::new();
            assert_eq!(next.take_handed(handed), 1);
            let ctl = control_over(tokens, Arc::new(next), &dir);
            let reply = declare(&ctl);
            assert!(
                reply.ok,
                "declared at once, before any sweep: {:?}",
                reply.reason
            );
        }

        #[test]
        fn no_refusal_for_an_unplaced_pane_promises_a_number_of_seconds() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            ctl.masters
                .note_served(crate::daemon::master::Served::Read(vec!["proj-9".into()]));
            for project in ["proj-1", "proj-9", "proj-ABSENT"] {
                let reply = run_declare(
                    &ctl,
                    project,
                    &["ISS-1".into()],
                    "/w/one",
                    "sess-UNKNOWN",
                    None,
                );
                let why = reply.reason.unwrap_or_default();
                assert!(
                    !why.contains("thirty seconds") && !why.contains("30 seconds"),
                    "a deadline the sweep does not enforce is worse than no deadline: {why}"
                );
            }
        }
        #[test]
        fn a_second_declaration_while_one_is_unbound_is_refused_naming_the_pending_row() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let first = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None);
            let pending = first.job_id.unwrap();
            let second = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/two", "sess-a", None);
            assert!(!second.ok);
            let why = second.reason.unwrap_or_default();
            assert!(
                why.contains(&pending) && why.contains("no subagent has bound it"),
                "the refusal must name the pending row: {why}"
            );
        }
        #[test]
        fn a_master_closing_its_own_unbound_declaration_may_declare_again() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let first = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None);
            let run_id = first.job_id.unwrap();
            assert!(run_close(&ctl, &run_id, Some("it never started"), "sess-a").ok);
            let again = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/two", "sess-a", None);
            assert!(again.ok, "{:?}", again.reason);
        }
        #[test]
        fn one_master_cannot_close_another_masters_run() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let run_id = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None)
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
            let run_id = run_declare(
                ctl,
                project_id,
                &["ISS-7".into()],
                "/w/seven",
                session_id,
                None,
            )
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
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");

            let reply = run_declare(
                &ctl,
                "proj-1",
                &["ISS-7".into(), "the whole backlog".into()],
                "/w/seven",
                "sess-a",
                None,
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
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            declared_and_inherited(&ctl, "proj-1", "sess-a");

            let reply = run_declare(
                &ctl,
                "proj-1",
                &["ISS-8".into()],
                "/w/eight",
                "sess-a",
                None,
            );

            assert!(!reply.ok, "the declaration must be refused");
            let reason = reply.reason.unwrap_or_default();
            assert!(reason.contains("ISS-7"), "name the run's issues: {reason}");
            assert!(
                reason.contains("continue"),
                "name the three words: {reason}"
            );
        }
        #[test]
        fn the_refusal_names_the_command_that_answers_it() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            declared_and_inherited(&ctl, "proj-1", "sess-a");

            let reply = run_declare(
                &ctl,
                "proj-1",
                &["ISS-8".into()],
                "/w/eight",
                "sess-a",
                None,
            );

            let reason = reply.reason.unwrap_or_default();
            assert!(
                reason.contains("forge-runner run choice"),
                "the refusal must name the verb that answers it: {reason}"
            );
            for word in ["continue", "restart", "leave"] {
                assert!(reason.contains(word), "and the three words: {reason}");
            }
        }

        #[test]
        fn closing_an_inherited_run_does_not_discharge_the_choice_it_owes() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let run_id = declared_and_inherited(&ctl, "proj-1", "sess-a");

            let closed = run_close(
                &ctl,
                &run_id,
                Some("restart: the subagent died with the previous pane and left nothing anywhere"),
                "sess-a",
            );
            assert!(closed.ok, "{:?}", closed.reason);

            let reply = run_declare(
                &ctl,
                "proj-1",
                &["ISS-8".into()],
                "/w/eight",
                "sess-a",
                None,
            );

            assert!(
                !reply.ok,
                "closing the inherited row must not buy a declaration the pane never answered for"
            );
            let reason = reply.reason.unwrap_or_default();
            assert!(reason.contains("ISS-7"), "name the run's issues: {reason}");
            assert!(
                reason.contains("continue"),
                "name the three words: {reason}"
            );
        }
        #[test]
        fn a_choice_recorded_after_the_close_releases_the_gate() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let run_id = declared_and_inherited(&ctl, "proj-1", "sess-a");
            run_close(
                &ctl,
                &run_id,
                Some("the pane died before dispatch"),
                "sess-a",
            );

            let choice = run_choice(
                &ctl,
                &run_id,
                "restart",
                "nothing was started, so nothing is lost",
                "sess-a",
            );
            assert!(choice.ok, "{:?}", choice.reason);

            let reply = run_declare(
                &ctl,
                "proj-1",
                &["ISS-8".into()],
                "/w/eight",
                "sess-a",
                None,
            );
            assert!(reply.ok, "{:?}", reply.reason);
        }
        #[test]
        fn a_closed_runs_choice_is_still_owed_to_the_issue() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let run_id = declared_and_inherited(&ctl, "proj-1", "sess-a");
            run_close(
                &ctl,
                &run_id,
                Some("restart: nothing to reconcile"),
                "sess-a",
            );
            run_choice(&ctl, &run_id, "restart", "nothing to reconcile", "sess-a");

            let held = ctl.ledger.lock().unwrap();
            let waiting = held
                .as_ref()
                .unwrap()
                .choices_awaiting_report(&ctl.boot_id)
                .unwrap();
            assert!(
                waiting.iter().any(|r| r.run_id == run_id),
                "a closed run's choice must still be reported onto its issue"
            );
        }
        #[test]
        fn once_every_inherited_run_is_answered_for_the_next_declaration_is_allowed() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            ship_roles(&ctl, &["runner"]);
            let run_id = declared_and_inherited(&ctl, "proj-1", "sess-a");

            let choice = run_choice(&ctl, &run_id, "restart", "the branch is empty", "sess-a");
            assert!(choice.ok, "{:?}", choice.reason);
            // The pre-existing one-unbound-row rule is a separate gate; bind this one so the assertion
            // below is about the resume gate and not about that.
            bind_declared(
                &ctl,
                Some("child-1"),
                Some("forge:runner"),
                "sess-a",
                0,
                None,
            );

            let reply = run_declare(
                &ctl,
                "proj-1",
                &["ISS-8".into()],
                "/w/eight",
                "sess-a",
                None,
            );
            assert!(reply.ok, "{:?}", reply.reason);
        }
        #[test]
        fn a_pane_that_was_never_resumed_declares_freely() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            ship_roles(&ctl, &["runner"]);
            let first = run_declare(
                &ctl,
                "proj-1",
                &["ISS-7".into()],
                "/w/seven",
                "sess-a",
                None,
            );
            assert!(first.ok, "{:?}", first.reason);
            bind_declared(
                &ctl,
                Some("child-1"),
                Some("forge:runner"),
                "sess-a",
                0,
                None,
            );

            let second = run_declare(
                &ctl,
                "proj-1",
                &["ISS-8".into()],
                "/w/eight",
                "sess-a",
                None,
            );

            assert!(second.ok, "{:?}", second.reason);
        }
        #[test]
        fn a_master_pane_event_puts_that_pane_and_its_conversation_in_the_ledger() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");

            agent_event(&ctl, "Stop", None, &conv("conv-abc"), "sess-a", None);

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
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");

            agent_event(&ctl, "Stop", None, &conv("conv-abc"), "sess-a", None);
            agent_event(&ctl, "Stop", None, &HookNames::default(), "sess-a", None);

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
        fn an_event_puts_the_transcript_its_hook_named_on_that_sessions_activity() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let names = HookNames {
                transcript_path: Some("/h/.claude/projects/-w/conv-abc.jsonl".into()),
                ..conv("conv-abc")
            };

            agent_event(&ctl, "UserPromptSubmit", None, &names, "sess-job", None);

            assert_eq!(
                ctl.activity
                    .get("sess-job")
                    .and_then(|a| a.transcript)
                    .as_deref(),
                Some("/h/.claude/projects/-w/conv-abc.jsonl")
            );
        }
        #[test]
        fn a_session_that_is_not_a_registered_master_writes_no_row() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");

            agent_event(
                &ctl,
                "Stop",
                None,
                &conv("conv-zzz"),
                "some-other-session",
                None,
            );

            let held = ctl.ledger.lock().unwrap();
            let row = held.as_ref().unwrap().master_for_project("proj-1").unwrap();
            assert!(
                row.is_none(),
                "an unregistered session is not a master pane: {row:?}"
            );
        }
        fn run_of(ctl: &Arc<Control>, run_id: &str) -> crate::runner::ledger::Run {
            ctl.ledger
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .run(run_id)
                .unwrap()
                .unwrap()
        }
        #[test]
        fn a_subagent_starting_binds_the_row_its_master_declared_and_stopping_leaves_it_open() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            ship_roles(&ctl, &["runner"]);
            let run_id = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None)
                .job_id
                .unwrap();
            bind_declared(
                &ctl,
                Some("child-1"),
                Some("forge:runner"),
                "sess-a",
                0,
                None,
            );
            assert_eq!(run_of(&ctl, &run_id).agent_id.as_deref(), Some("child-1"));
            ctl.ledger
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .attach_session(&run_id, "core-run-1")
                .unwrap();
            let lead = crate::daemon::transcript_age::absolute_fixture("conv.jsonl");
            note_subagent_stop(&ctl, "child-1", 1_790_000_000_000, Some(&lead));
            let run = run_of(&ctl, &run_id);
            assert_eq!(
                run.ended_by, None,
                "a turn-end is not a finish: ISS-1135's subagent stopped to wait on its own monitor and was resumed 56 s later (ISS-1246)"
            );
            assert_eq!(run.turn_ended_at_ms, Some(1_790_000_000_000));
            let want = crate::daemon::transcript_age::child_transcript(Path::new(&lead), "child-1")
                .unwrap()
                .to_string_lossy()
                .into_owned();
            assert_eq!(run.agent_transcript.as_deref(), Some(want.as_str()));
            let held = ctl.ledger.lock().unwrap();
            assert!(
                held.as_ref()
                    .unwrap()
                    .ended_with_open_session("boot-a")
                    .unwrap()
                    .is_empty(),
                "nothing may close its core session, which is what hands its issue leases back"
            );
        }
        #[test]
        fn each_stop_moves_the_turn_end_forward_and_a_replayed_older_one_does_not_move_it_back() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            ship_roles(&ctl, &["runner"]);
            let run_id = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None)
                .job_id
                .unwrap();
            bind_declared(
                &ctl,
                Some("child-1"),
                Some("forge:runner"),
                "sess-a",
                0,
                None,
            );
            let lead = crate::daemon::transcript_age::absolute_fixture("conv.jsonl");
            note_subagent_stop(&ctl, "child-1", 1_000, Some(&lead));
            note_subagent_stop(&ctl, "child-1", 5_000, None);
            let run = run_of(&ctl, &run_id);
            assert_eq!(run.turn_ended_at_ms, Some(5_000));
            assert!(
                run.agent_transcript.is_some(),
                "a frame naming no transcript keeps the path an earlier one gave"
            );
            note_subagent_stop(&ctl, "child-1", 2_000, None);
            assert_eq!(run_of(&ctl, &run_id).turn_ended_at_ms, Some(5_000));
        }
        #[test]
        fn a_stop_naming_a_relative_lead_records_no_transcript_it_would_misread() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            ship_roles(&ctl, &["runner"]);
            let run_id = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None)
                .job_id
                .unwrap();
            bind_declared(
                &ctl,
                Some("child-1"),
                Some("forge:runner"),
                "sess-a",
                0,
                None,
            );
            note_subagent_stop(&ctl, "child-1", 1_000, Some("conv.jsonl"));
            let run = run_of(&ctl, &run_id);
            assert_eq!(run.turn_ended_at_ms, Some(1_000));
            assert_eq!(run.agent_transcript, None);
        }
        #[test]
        fn a_stop_heard_through_the_socket_reaches_the_run_with_its_time_and_path() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            ship_roles(&ctl, &["runner"]);
            let run_id = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None)
                .job_id
                .unwrap();
            let lead = crate::daemon::transcript_age::absolute_fixture("conv-live.jsonl");
            let names = HookNames {
                agent_id: Some("child-9".into()),
                conversation_id: Some("conv-live".into()),
                agent_type: Some("forge:runner".into()),
                transcript_path: Some(lead.clone()),
            };
            agent_event(&ctl, "SubagentStart", Some(1_000), &names, "sess-a", None);
            agent_event(&ctl, "SubagentStop", Some(2_000), &names, "sess-a", None);
            let run = run_of(&ctl, &run_id);
            assert_eq!(run.agent_id.as_deref(), Some("child-9"));
            assert_eq!(run.ended_by, None);
            assert_eq!(run.turn_ended_at_ms, Some(2_000));
            assert!(run
                .agent_transcript
                .as_deref()
                .is_some_and(|p| p.ends_with("agent-child-9.jsonl")));
        }
        #[test]
        fn a_replayed_start_from_a_child_already_bound_never_takes_the_next_row() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            ship_roles(&ctl, &["runner"]);
            let run_a = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None)
                .job_id
                .unwrap();
            bind_declared(
                &ctl,
                Some("child-a"),
                Some("forge:runner"),
                "sess-a",
                0,
                None,
            );
            let run_b = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/two", "sess-a", None)
                .job_id
                .unwrap();
            bind_declared(
                &ctl,
                Some("child-a"),
                Some("forge:runner"),
                "sess-a",
                0,
                None,
            );
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
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let run_a = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a", None)
                .job_id
                .unwrap();
            bind_declared(
                &ctl,
                Some("child-a"),
                Some("forge:runner"),
                "sess-a",
                0,
                None,
            );
            assert!(run_close(&ctl, &run_a, None, "sess-a").ok);
            let run_b = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/two", "sess-a", None)
                .job_id
                .unwrap();
            bind_declared(
                &ctl,
                Some("child-a"),
                Some("forge:runner"),
                "sess-a",
                0,
                None,
            );
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
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            bind_declared(&ctl, Some("stranger"), None, "sess-a", 0, None);
            note_subagent_stop(&ctl, "stranger", 1_790_000_000_000, None);
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
