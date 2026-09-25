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

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};

use crate::config::Config;
use crate::daemon::session_tokens::SessionTokens;

pub fn socket_path() -> Option<PathBuf> {
    let cfg = Config::path().ok()?;
    Some(cfg.with_file_name("control.sock"))
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
}

#[derive(Default)]
pub struct GateMemory {
    /// Which tool call each pending declaration has been promised to.
    promised: std::collections::HashMap<String, String>,
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

#[cfg(unix)]
fn agent_event(
    ctl: &Arc<Control>,
    event: &str,
    at_ms: Option<i64>,
    names: &HookNames,
    session_id: &str,
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
            bind_declared(ctl, agent_id, agent_type, session_id)
        }
        (crate::daemon::agent_activity::Event::SubagentStopped, Some(child)) => {
            note_subagent_stop(ctl, child, at, names.transcript_path.as_deref())
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

#[cfg(unix)]
fn run_declare(
    ctl: &Arc<Control>,
    project_id: &str,
    issue_keys: &[String],
    worktree_path: &str,
    session_id: &str,
) -> ClaimReply {
    let Some(serves) = ctl.masters.project_for_session(session_id) else {
        return ClaimReply::refused(ctl.masters.why_unplaced(project_id));
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
    crate::config::Config::path()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
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
#[cfg(unix)]
fn bind_declared(
    ctl: &Arc<Control>,
    agent_id: Option<&str>,
    agent_type: Option<&str>,
    session_id: &str,
) {
    let Some(child) = agent_id else { return };
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else { return };
    match led.unbound_run_for_master(session_id, &ctl.boot_id) {
        Ok(Some(run)) => match led.bind_agent(&run.run_id, child) {
            Ok(true) => {
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
            StartKind::Replay(run_id) => tracing::debug!(
                "[control] subagent {child} is already run {run_id}, so its start is a replay"
            ),
            StartKind::Undeclared => undeclared_child(ctl, child, agent_type),
            StartKind::Unreadable(e) => unreadable_ledger(ctl, child, &e),
        },
        Err(e) => tracing::warn!("[control] cannot read declared runs: {e}"),
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
fn serve_request(ctl: &Arc<Control>, req: Request, session_id: &str) -> ClaimReply {
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

    /// The third value is the control's config dir, which the caller holds for the test's life.
    fn declaring_control(
        session_id: &str,
        project_id: &str,
    ) -> (Arc<Control>, String, crate::test_scratch::Scratch) {
        let dir = crate::test_scratch::Scratch::new("ct-decl");
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
                config_dir: Some(dir.to_path_buf()),
                promises: std::sync::Mutex::new(GateMemory::default()),
            }),
            token,
            dir,
        )
    }

    fn asking(role: &str, tool_use: &str) -> crate::daemon::dispatch_gate::Dispatch {
        crate::daemon::dispatch_gate::Dispatch {
            agent_id: None,
            subagent_type: Some(role.into()),
            tool_use_id: Some(tool_use.into()),
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
        ctl.promises.lock().unwrap().promised.get(run_id).cloned()
    }

    #[cfg(unix)]
    #[test]
    fn one_declaration_authorises_one_dispatch_and_is_freed_when_its_subagent_starts() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        ship_roles(&ctl, &["runner", "reviewer"]);

        // 1. Nothing declared: refused, in the declaration's own words.
        assert!(
            refused_as_undeclared(&gate_on(&ctl, &asking("runner", "toolu_1"), "sess-a")),
            "a hand-off with nothing declared is refused by the socket, not merely by `decide`"
        );

        // 4. Declared: the next dispatch goes through, and the row it reserved is
        // named — which is what a re-implementation of this path could not show.
        let run_id = run_declare(&ctl, "proj-1", &["ISS-7".into()], "/w/seven", "sess-a")
            .job_id
            .expect("declared");
        let covered = gate_on(&ctl, &asking("runner", "toolu_1"), "sess-a");
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
        let replay = gate_on(&ctl, &asking("runner", "toolu_1"), "sess-a");
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
            refused_as_undeclared(&gate_on(&ctl, &asking("reviewer", "toolu_2"), "sess-a")),
            "two subagents under one declared row is two units of work with one record"
        );

        // 7. The subagent starts: the row is bound, the promise is released, and
        // the master is back to needing a fresh declaration.
        bind_declared(&ctl, Some("child-1"), Some("runner"), "sess-a");
        assert_eq!(
            promised_to(&ctl, &run_id),
            None,
            "a bound run must not stay promised, or the next declaration is refused on a free row"
        );
        assert!(refused_as_undeclared(&gate_on(
            &ctl,
            &asking("runner", "toolu_3"),
            "sess-a"
        )));
    }

    #[cfg(unix)]
    #[test]
    fn a_daemon_restart_leaves_the_declaration_standing_and_the_second_child_is_named() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner"]);
        let run_id = run_declare(&ctl, "proj-1", &["ISS-7".into()], "/w/seven", "sess-a")
            .job_id
            .expect("declared");
        assert!(allowed(&gate_on(
            &ctl,
            &asking("runner", "toolu_1"),
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
        });

        // The declaration is still the master's, so the dispatch is allowed.
        assert!(
            allowed(&gate_on(&restarted, &asking("runner", "toolu_2"), "sess-a")),
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
            bind_declared(&restarted, Some(child), Some("runner"), "sess-a");
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
        let _ = run_declare(&ctl, "proj-1", &["ISS-7".into()], "/w/seven", "sess-a")
            .job_id
            .expect("declared");
        let ask = crate::daemon::dispatch_gate::Dispatch {
            agent_id: None,
            subagent_type: Some("runner".into()),
            tool_use_id: Some("toolu_1".into()),
        };
        assert!(dispatch_gate_reply(&ctl, ask.clone(), "sess-a").ok);

        bind_declared(&ctl, Some("child-1"), Some("runner"), "sess-a");

        assert!(
            dispatch_gate_reply(&ctl, ask.clone(), "sess-a").ok,
            "the same tool call must get the same answer for this daemon's whole life"
        );

        // and it must not have eaten the next declaration.
        let next = run_declare(&ctl, "proj-1", &["ISS-8".into()], "/w/eight", "sess-a")
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
                subagent_type: Some("runner".into()),
                tool_use_id: Some("toolu_1".into()),
            },
            "sess-a",
        );
        assert!(reply.ok, "an uncertain box must not refuse: {reply:?}");
        assert_eq!(crate::daemon::degraded::tally(&dir).0.count, 1);
    }

    /// Put a plugin clone shipping these roles inside this Control's own config
    /// directory, which is where both the gate and the denunciation read it.
    #[cfg(unix)]
    fn ship_roles(ctl: &Arc<Control>, roles: &[&str]) -> std::path::PathBuf {
        let dir = ctl.config_dir.clone().expect("a scratch config dir");
        let agents = dir.join("marketplaces/sidcorp-co__forge-plugin/plugin/agents");
        std::fs::create_dir_all(&agents).unwrap();
        for r in roles {
            std::fs::write(agents.join(format!("{r}.md")), "---\n").unwrap();
        }
        dir
    }

    #[cfg(unix)]
    #[test]
    fn a_subagent_started_under_a_shipped_role_with_nothing_declared_is_named_and_counted() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner", "reviewer"]);

        bind_declared(
            &ctl,
            Some("child-nobody-declared"),
            Some("runner"),
            "sess-a",
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
            Some("runner"),
            "the role is a field a reader can filter on, not only a phrase in a sentence"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_subagent_that_is_not_a_shipped_role_stays_silent() {
        let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner", "reviewer"]);

        for role in [Some("general-purpose"), Some("Explore"), None] {
            bind_declared(&ctl, Some("a-search"), role, "sess-a");
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
        let _ = run_declare(&ctl, "proj-1", &["ISS-7".into()], "/w/seven", "sess-a")
            .job_id
            .expect("declared");

        for _ in 0..3 {
            bind_declared(&ctl, Some("child-1"), Some("runner"), "sess-a");
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
        let _ = run_declare(&ctl, "proj-1", &["ISS-7".into()], "/w/seven", "sess-a")
            .job_id
            .expect("declared");

        bind_declared(&ctl, Some("child-1"), Some("runner"), "sess-a");

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
            },
        )
        .to_string();
        let req: Request = serde_json::from_str(&frame).expect("the gate frame must decode");
        let Request::DispatchGate {
            agent_id,
            subagent_type,
            tool_use_id,
            ..
        } = &req
        else {
            panic!("a frame whose op is `dispatch_gate` must decode as one");
        };
        assert!(agent_id.is_none());
        assert_eq!(subagent_type.as_deref(), Some("runner"));
        assert_eq!(tool_use_id.as_deref(), Some("toolu_1"));
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

    #[cfg(unix)]
    mod unix {
        use super::*;

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

        #[test]
        fn a_frame_carrying_no_known_token_names_nobody() {
            let dir = crate::test_scratch::Scratch::new("ct");
            let tokens = SessionTokens::at(dir.join("control-tokens.json"));
            tokens.mint("sess-a").unwrap();
            assert_eq!(tokens.session_for("forged"), None);
        }
        #[test]
        fn a_declaration_writes_a_row_and_answers_its_id() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
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
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
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
        fn a_pane_this_daemon_has_not_adopted_is_refused_with_what_the_sweep_recorded() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let reply = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-UNKNOWN");
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

        #[test]
        fn no_refusal_for_an_unplaced_pane_promises_a_number_of_seconds() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            ctl.masters
                .note_served(crate::daemon::master::Served::Read(vec!["proj-9".into()]));
            for project in ["proj-1", "proj-9", "proj-ABSENT"] {
                let reply = run_declare(&ctl, project, &["ISS-1".into()], "/w/one", "sess-UNKNOWN");
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
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let first = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a");
            let run_id = first.job_id.unwrap();
            assert!(run_close(&ctl, &run_id, Some("it never started"), "sess-a").ok);
            let again = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/two", "sess-a");
            assert!(again.ok, "{:?}", again.reason);
        }
        #[test]
        fn one_master_cannot_close_another_masters_run() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
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
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");

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
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
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
        fn the_refusal_names_the_command_that_answers_it() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            declared_and_inherited(&ctl, "proj-1", "sess-a");

            let reply = run_declare(&ctl, "proj-1", &["ISS-8".into()], "/w/eight", "sess-a");

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

            let reply = run_declare(&ctl, "proj-1", &["ISS-8".into()], "/w/eight", "sess-a");

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

            let reply = run_declare(&ctl, "proj-1", &["ISS-8".into()], "/w/eight", "sess-a");
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
            let run_id = declared_and_inherited(&ctl, "proj-1", "sess-a");

            let choice = run_choice(&ctl, &run_id, "restart", "the branch is empty", "sess-a");
            assert!(choice.ok, "{:?}", choice.reason);
            // The pre-existing one-unbound-row rule is a separate gate; bind this one so the assertion
            // below is about the resume gate and not about that.
            bind_declared(&ctl, Some("child-1"), None, "sess-a");

            let reply = run_declare(&ctl, "proj-1", &["ISS-8".into()], "/w/eight", "sess-a");
            assert!(reply.ok, "{:?}", reply.reason);
        }
        #[test]
        fn a_pane_that_was_never_resumed_declares_freely() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let first = run_declare(&ctl, "proj-1", &["ISS-7".into()], "/w/seven", "sess-a");
            assert!(first.ok, "{:?}", first.reason);
            bind_declared(&ctl, Some("child-1"), None, "sess-a");

            let second = run_declare(&ctl, "proj-1", &["ISS-8".into()], "/w/eight", "sess-a");

            assert!(second.ok, "{:?}", second.reason);
        }
        #[test]
        fn a_master_pane_event_puts_that_pane_and_its_conversation_in_the_ledger() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");

            agent_event(&ctl, "Stop", None, &conv("conv-abc"), "sess-a");

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

            agent_event(&ctl, "Stop", None, &conv("conv-abc"), "sess-a");
            agent_event(&ctl, "Stop", None, &HookNames::default(), "sess-a");

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

            agent_event(&ctl, "UserPromptSubmit", None, &names, "sess-job");

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

            agent_event(&ctl, "Stop", None, &conv("conv-zzz"), "some-other-session");

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
            let run_id = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a")
                .job_id
                .unwrap();
            bind_declared(&ctl, Some("child-1"), None, "sess-a");
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
            let run_id = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a")
                .job_id
                .unwrap();
            bind_declared(&ctl, Some("child-1"), None, "sess-a");
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
            let run_id = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a")
                .job_id
                .unwrap();
            bind_declared(&ctl, Some("child-1"), None, "sess-a");
            note_subagent_stop(&ctl, "child-1", 1_000, Some("conv.jsonl"));
            let run = run_of(&ctl, &run_id);
            assert_eq!(run.turn_ended_at_ms, Some(1_000));
            assert_eq!(run.agent_transcript, None);
        }
        #[test]
        fn a_stop_heard_through_the_socket_reaches_the_run_with_its_time_and_path() {
            let (ctl, _t, _dir) = declaring_control("sess-a", "proj-1");
            let run_id = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a")
                .job_id
                .unwrap();
            let lead = crate::daemon::transcript_age::absolute_fixture("conv-live.jsonl");
            let names = HookNames {
                agent_id: Some("child-9".into()),
                conversation_id: Some("conv-live".into()),
                agent_type: Some("runner".into()),
                transcript_path: Some(lead.clone()),
            };
            agent_event(&ctl, "SubagentStart", Some(1_000), &names, "sess-a");
            agent_event(&ctl, "SubagentStop", Some(2_000), &names, "sess-a");
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
            let run_a = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a")
                .job_id
                .unwrap();
            bind_declared(&ctl, Some("child-a"), None, "sess-a");
            let run_b = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/two", "sess-a")
                .job_id
                .unwrap();
            bind_declared(&ctl, Some("child-a"), None, "sess-a");
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
            let run_a = run_declare(&ctl, "proj-1", &["ISS-1".into()], "/w/one", "sess-a")
                .job_id
                .unwrap();
            bind_declared(&ctl, Some("child-a"), None, "sess-a");
            assert!(run_close(&ctl, &run_a, None, "sess-a").ok);
            let run_b = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/two", "sess-a")
                .job_id
                .unwrap();
            bind_declared(&ctl, Some("child-a"), None, "sess-a");
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
            bind_declared(&ctl, Some("stranger"), None, "sess-a");
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
