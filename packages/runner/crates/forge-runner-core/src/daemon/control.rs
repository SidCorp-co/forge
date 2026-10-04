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
pub(crate) fn acting_session(masters: &crate::daemon::master::Masters, holder: &Holder) -> String {
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
fn names_minted_project(m: &crate::daemon::session_tokens::Minted, named: &str) -> bool {
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
    masters: &crate::daemon::master::Masters,
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
    // A record was matched by id or slug in `declaring_project`; a capability
    // minted before the record names an id or nothing.
    if !matches!(holder, Holder::Minted(_)) && serves != project_id {
        return ClaimReply::refused(format!(
            "this pane is the master for {serves} and cannot declare a run for {project_id}"
        ));
    }
    // Every row below is keyed by the project's id, never by the slug it was named by.
    let project_id = serves.as_str();
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

    // A tool call this daemon has already answered gets that answer again, whether
    // or not its declaration has since been bound.
    if let Some(tool_use) = d.tool_use_id.as_deref() {
        if memory.allowed.contains(tool_use) {
            return gate_allows(None);
        }
    }

    let promised = pending
        .as_deref()
        .and_then(|run| memory.promised.get(run).cloned());
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
                memory.promised.insert(run_id.clone(), tool_use.clone());
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
            // Failing open for a run declared before the drain admits nothing
            // new only while that run is spent once, so while draining the
            // promise is recorded the way `Covered` records it, and a second
            // tool call against the same run is refused.
            if let (Some(run), Some(cause)) = (pending.as_deref(), ctl.drain.draining_for()) {
                // cm:guard a dispatch carrying no tool call id cannot be limited here: nothing
                // names it to promise the run to or to tell a second hand-off from a replay, so
                // that case still fails open once per call, and the drain counts only the one row.
                if let Some(tool_use) = d.tool_use_id.clone() {
                    if let Some(spent) = memory.promised.get(run).filter(|t| **t != tool_use) {
                        tracing::warn!(
                            "[control] refusing a second hand-off of run {run} while draining: it was spent on {spent}"
                        );
                        return ClaimReply::refused(format!(
                            "this box is draining before a restart ({cause}) and run {run}, declared before the drain, was already handed off to tool call {spent}; a second subagent against it would be work the drain never counted. Declare it again once the box has turned over, or once the drain gives up and admission reopens"
                        ));
                    }
                    memory.promised.insert(run.to_string(), tool_use.clone());
                    memory.allowed.insert(tool_use);
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
        "[control] refusing a hand-off the gate could not decide ({why}): the box is draining for {cause}"
    );
    let known = match declared {
        Some(_) => "and this master has declared no run for it",
        None => "and whether a run was declared for it cannot be read",
    };
    Some(ClaimReply::refused(format!(
        "this box is draining before a restart ({cause}) and admits no hand-off it cannot account for: the dispatch gate could not check this one against a declaration ({why}), {known}. Hand it off again once the box has turned over, or once the drain gives up and admission reopens"
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

/// A subagent started: it takes the run its master declared for it.
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
    let transcript = lead
        .map(Path::new)
        .filter(|p| p.is_absolute())
        .and_then(|p| crate::daemon::transcript_age::child_transcript(p, child))
        .map(|p| p.to_string_lossy().into_owned());
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else { return };
    let heard = |led: &crate::runner::ledger::Ledger, run_id: &str| {
        if let Err(e) = led.note_subagent_started(run_id, at_ms, transcript.as_deref()) {
            tracing::warn!("[control] run {run_id}: cannot note that {child} started: {e}");
        }
    };
    match led.unbound_run_for_master(session_id, &ctl.boot_id) {
        Ok(Some(run)) => match led.bind_agent(&run.run_id, child) {
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
        },
        Ok(None) => match classify_start(
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
            StartKind::Undeclared => undeclared_child(ctl, child, agent_type),
            StartKind::Unreadable(e) => unreadable_ledger(ctl, child, &e),
        },
        Err(e) => tracing::warn!("[control] cannot read declared runs: {e}"),
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

#[cfg(unix)]
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

#[cfg(unix)]
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

#[cfg(unix)]
fn undeclared_child(ctl: &Arc<Control>, child: &str, agent_type: Option<&str>) {
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
    let detail = format!("subagent {child} started as `{role}` with nothing declared for it");
    tracing::error!(
        "[control] UNDECLARED HAND-OFF: {detail} — this box holds no row for that work, so nothing \
         will reap it, the load count is short, and those issues will never be offered again. The \
         master was required to run `forge-runner run declare` first."
    );
    if let Some(dir) = dir.as_deref() {
        crate::daemon::degraded::mark(
            dir,
            &crate::daemon::degraded::Mark::new(
                crate::daemon::degraded::Kind::Undeclared,
                crate::daemon::degraded::Source::Daemon,
                &detail,
                crate::daemon::degraded::Run::Unknown("nothing was declared for it"),
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
            ..
        } => dispatch_gate_reply(
            ctl,
            crate::daemon::dispatch_gate::Dispatch {
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
        "toolUseId": d.tool_use_id
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
