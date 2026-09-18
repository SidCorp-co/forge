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
    /// "I have decided what to do about a run I inherited when this pane was resumed."
    // cm:guard this records a CHOICE and performs none of it. `continue`, `restart` and `leave` are
    // three words a master writes down; nothing here starts, kills or reopens anything, because
    // deciding what happens to work whose owner cannot be asked is the master's, and a verb that
    // also acted would move that judgement into the box (ISS-1050 criterion 28).
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
    note_master_pane(ctl, session_id, conversation_id);
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

/// The three words a resumed master may write about a run it inherited.
// cm:guard a CLOSED set, refused by name. The master is handed raw fields and asked to judge; the
// judgement is its own, but the vocabulary is not, because a gate that accepts any string cannot
// tell a decision from a typo and would let "contineu" satisfy it silently (ISS-1050 criterion 29).
pub const RESUME_CHOICES: &[&str] = &["continue", "restart", "leave"];

/// Record what a resumed master decided about one run it inherited.
///
/// Writes a word and a reason. Starts nothing, kills nothing, reopens nothing.
// cm:guard the reason is REQUIRED and is not checked for content. Criterion 29 asks for the choice
// AND why; a choice with an empty reason is a record nobody can act on six hours later, and a box
// that judged the prose would be marking the master's homework.
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
// cm:guard the project is CHECKED and never derived, and an unknown pane is refused rather than served. `Masters` is an in-process optimisation and a daemon restart empties it while every master is still running, so a declaration in that window has to be refused. What that refusal may NOT do is promise a re-adoption on a deadline: the sweep places a pane only where its preconditions hold, and `why_unplaced` names the one that did not rather than naming a number of seconds (ISS-1092). Serving it anyway, from the frame's own claim or from the only entry present, is how a pane on one project opens a run over another's issue (ISS-1050 criterion 7).
#[cfg(unix)]
fn run_declare(
    ctl: &Arc<Control>,
    project_id: &str,
    issue_keys: &[String],
    worktree_path: &str,
    session_id: &str,
) -> ClaimReply {
    // cm:guard the refusal is BUILT from what the sweep recorded, and the project id above is read
    // for that diagnosis only — `why_unplaced` answers a string and never a project, so this arm
    // still serves nothing from the caller's own claim (ISS-1050 criterion 7). What changed in
    // ISS-1092 is the second half of the sentence: this used to promise re-adoption "within thirty
    // seconds" on every path, including ones where no sweep would ever place the pane, and a master
    // holding a stale capability waited out a deadline that could not arrive.
    let Some(serves) = ctl.masters.project_for_session(session_id) else {
        return ClaimReply::refused(ctl.masters.why_unplaced(project_id));
    };
    if serves != project_id {
        return ClaimReply::refused(format!(
            "this pane is the master for {serves} and cannot declare a run for {project_id}"
        ));
    }
    // cm:guard the keys are checked for SHAPE before a row exists, because criterion 7 says a refused
    // declaration writes nothing and the ledger row is written before core is ever asked. A key core
    // cannot resolve is refused at `POST /me/run-sessions` — by which time this box is holding a
    // declared run over it, retried by `open_declared_runs` every sweep for the life of the boot,
    // pinning the worktree it names (ISS-1050 finding F12). What this CANNOT answer is whether a
    // well-formed key exists in this project: that mapping is core's alone, and a box that guessed
    // at it would be inventing the answer it is refusing to guess.
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
    // cm:guard the gate for criterion 29, and it is a REFUSAL rather than a reminder. A resumed
    // pane is handed the runs it inherited and asked to say what happens to each; a brief that only
    // asks is one a master can read past, and the issues under those runs then sit claimed by work
    // nobody decided to continue while the pane starts something new. Refusing the next declaration
    // is the only place that can be made to hold.
    // cm:guard it names the runs and the three words rather than saying "answer first". A refusal
    // that does not say what it wants is one the caller retries.
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
        // cm:guard the ledger's own refusal text is passed through WHOLE. Each of the three names what a master has to do next — which issue collided, which tree is held, which declared row to close — and a handler that replaced them with one word of its own would take that away.
        Err(e) => ClaimReply::refused(e.to_string()),
    }
}

/// Whether a string is shaped like an issue reference core will parse.
// cm:guard SHAPE only, and deliberately no more. Whether a well-formed reference names a real issue
// in this project is a question only core can answer — the key is a per-project sequence and the box
// holds no index of them — and the refusal that matters there is core's own. Widening this to guess
// would be the second live path this repository refuses everywhere else.
// cm:edge contract -> packages/core/src/lib/issue-ref.ts — `REF_SHAPE` is the rule this mirrors:
// an OPTIONAL prefix of two to six alphanumerics, then a sequence number. The prefix is optional
// because a bare number is a reference core accepts, and it is not fixed to `ISS` because a project
// answers to its own prefix as well as the legacy one — a check spelling `ISS-` into the box would
// refuse `FD-977` here and be told it was valid one process away (ISS-1050 finding F12).
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

/// Keep the ledger's `masters` row current for the pane this event came from.
///
/// This is the only writer of that row, and what it stores is what a rebuilt
/// pane is resumed from.
// cm:guard runs INSIDE the hook path and must never fail it, exactly as `bind_or_release` above:
// every branch is a log line at worst. A pane whose row could not be written still reports its turn
// boundaries; the cost is a cold start later, which `ensure_master` says out loud.
// cm:guard written only for a session the registry knows is a MASTER. `project_for_session` answers
// `None` for anything else, and a row minted for a subagent's session would name a pane no resume
// can address.
// cm:guard a `None` conversation is passed THROUGH rather than skipped, because `note_master`'s
// `COALESCE` is what keeps the stored handle alive across events that carry none — and the pane
// name and `last_seen_at` still need refreshing on those events. Guarding the call on a present
// conversation would leave the row's pane name stale for the whole life of a pane whose hooks
// mostly fire without one.
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

/// Record a resumed pane's choice about a run it inherited, over the control socket.
// cm:guard this client existed nowhere until ISS-1050's testing pass, and its absence is why
// `resume_choice` was 0 of 368 rows across eight days. The frame (`RunChoice`), the daemon handler
// (`run_choice`), the ledger column and the report path onto the issue were all present and
// correct; nothing could call them, so criterion 29 could never have passed however the gate was
// written. The same producer-gone shape this whole issue was filed about, one layer up.
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

    // cm:guard the frame is the one `request_run_choice` builds, byte for byte. Everything behind
    // this op — the `RunChoice` variant, the `run_choice` handler, `record_resume_choice`, the
    // column and the report onto the issue — shipped in the original change and was reachable from
    // nothing: no client function, no CLI subcommand, so `resume_choice` was 0 of 368 rows over
    // eight days and criterion 29 could not have passed however the gate was written. This test is
    // the wire half; the handler tests above it call `run_choice` directly and would not have
    // noticed the absence (ISS-1050 criterion 29).
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

    /// The half of this socket that only exists on a unix box.
    ///
    // cm:guard gated `unix`, matching the `#[cfg(unix)]` on the functions under test rather than
    // on `cfg(test)` alone. `serve`, `agent_event`, `run_declare`, `run_close` and
    // `bind_or_release` are all unix-only — the control socket is a `UnixListener` — so on Windows
    // the items these tests call are simply absent and the lib test target fails to COMPILE, which
    // is a red CI leg rather than a failing assertion. `cargo test` on a unix box can never catch
    // it, because `cfg(unix)` is true there: the windows leg is the only thing that reads this, and
    // this is the second landing to meet it (see the CRLF guard on `request_enum_body`).
    // cm:guard the gate is drawn as tightly as it can be. Everything in the PARENT module —
    // the frame decoding, the `ClaimReply` shape, the choice refusals and the three source-text
    // scans over this file — is platform-independent and keeps compiling on both, because the
    // scans in particular are the ones that hold the socket's shape and they are worth strictly
    // more on the leg that has historically been skipped.
    #[cfg(unix)]
    mod unix {
        use super::*;

        // cm:guard the vocabulary is closed and refused BY NAME. A gate that accepted any string could
        // not tell a decision from a typo, and `contineu` would satisfy it silently.
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

        // cm:guard the reason is required, because a choice with no reason is a record nobody can act
        // on six hours later — which is the silence this whole issue is about, one level up.
        #[test]
        fn a_choice_with_no_reason_is_refused() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
            let run_id = declared_and_inherited(&ctl, "proj-1", "sess-a");

            let reply = run_choice(&ctl, &run_id, "leave", "   ", "sess-a");

            assert!(!reply.ok, "a choice needs its reason");
        }

        // cm:guard a pane may only answer for runs IT inherited. Without the scope a master on one
        // project could satisfy another project's gate.
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
        // master is still running, so a declaration in that window has to be REFUSED. Serving it
        // from the frame's own claim would let a pane on one project open a run over another's
        // issue (ISS-1050 criterion 7). What that refusal SAYS is `why_unplaced`'s, and this test
        // is what makes it so: it used to assert the word "sweep", which is the promise ISS-1092
        // measured as false — the pane it was written for waited out fourteen hours of thirty
        // seconds while the daemon had adopted a session it could never reconcile with.
        #[test]
        fn a_pane_this_daemon_has_not_adopted_is_refused_with_what_the_sweep_recorded() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
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

        // cm:guard the refusal may not carry a deadline on ANY path, and this walks the paths rather
        // than one of them. The sentence this replaces was a constant, so it read correctly in the
        // one state it was written for and lied in every other (ISS-1092 criterion 9).
        #[test]
        fn no_refusal_for_an_unplaced_pane_promises_a_number_of_seconds() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
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
        // cm:guard a declaration that is refused must leave the ledger EXACTLY as it found it —
        // criterion 7 — and the row here is written before core is ever asked, so a key core will
        // reject is a row nothing can close and a worktree nothing can release. The shape is the
        // only half a box can answer on its own (ISS-1050 finding F12).
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

        // cm:guard the shapes core's own parser ACCEPTS are not refused here, and this is the half of
        // the check that costs something to get wrong: a box that refused `FD-977` would be refusing
        // a reference core resolves, one process away, with no way for the master to tell which end
        // was wrong. The prefix is a project's, not a constant (ISS-1050 finding F12).
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

        // cm:guard criterion 29's gate. A brief that only ASKS is one a master can read past, and the
        // issues under those runs then sit claimed by work nobody decided to continue while the pane
        // starts something new. The refusal is the only place this can be made to hold.
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
        // cm:guard the refusal must carry the command that ENDS it. A gate with no way out named in it
        // is one a master retries, and until this pass there was no way out at all to name.
        #[test]
        fn the_refusal_names_the_command_that_answers_it() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
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

        // cm:guard the obligation survives the CLOSE, and this is the case that broke in production
        // rather than a case the code was already shaped for. Measured on forge-vm's ledger,
        // 2026-09-16T12:34Z: four runs were stamped `resume_owed_at` and two of them were then ended
        // `ended_by = master` with the decision written into the close's own reason — one of them
        // literally `"restart: the subagent died with the previous pane and left nothing anywhere"`.
        // The word is one of the three, the reason is exactly what criterion 29 asks for, and none of
        // it reached `resume_choice`, core, or the issue: `resume_choice` is 0 of 365 across eight
        // days. Closing the row cleared `ended_by IS NULL` out from under `runs_awaiting_choice`, so
        // the gate stopped asking, and a master must close its unbound row anyway to satisfy the
        // one-unbound-row rule — which makes the escape the NORMAL path and not an exotic one
        // (ISS-1050 criterion 29, review finding F10).
        #[test]
        fn closing_an_inherited_run_does_not_discharge_the_choice_it_owes() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
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
        // cm:guard the gate the test above closes must not become a WEDGE: the pane has to be able to
        // answer for a run that has already ended, or a master that closed its inherited row can never
        // declare again for the life of the boot. `record_resume_choice` never read `ended_by`, so the
        // answer is reachable — this is the test that keeps it that way.
        #[test]
        fn a_choice_recorded_after_the_close_releases_the_gate() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
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
        // cm:guard the choice for an ENDED run still has to reach the issue, which is the half of
        // criterion 29 the ledger alone cannot satisfy. `choices_awaiting_report` is what the sweep
        // drains onto the tracker, and a run closed before its choice was written must still appear
        // there — otherwise the gate would merely be silent later instead of silent now.
        #[test]
        fn a_closed_runs_choice_is_still_owed_to_the_issue() {
            let (ctl, _t) = declaring_control("sess-a", "proj-1");
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
        // cm:guard a pane's OWN fresh declarations owe nothing. Keyed on "no choice yet" alone, the
        // second declaration of every ordinary pass would be refused — measured, that is exactly what
        // happened before the obligation was written by the resume instead.
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
        // cm:guard criterion 14 is about the LEDGER, not the in-process registry, and this is the test
        // that tells them apart. `note_master` and `master_for_project` had no production caller at all
        // when the table was added: the row existed, nothing wrote it, and a resume would have had
        // nothing to read. Asserting through `master_for_project` — a reader, on a fresh handle to the
        // same ledger — is what makes this about the stored row rather than about the call (ISS-1050).
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
        // cm:guard an event carrying NO conversation must not erase the one stored. Most hook events
        // carry none, so an overwrite would empty the row within seconds of it being written and the
        // resume would find nothing — the same silence as never writing it.
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
        // cm:guard a session the registry does not know as a master writes NOTHING. A row minted for a
        // subagent's session would name a pane no resume can address, and `masters` is keyed by project
        // so it would also displace the real master's row for that project.
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
        // cm:guard a master dispatches subagents this box knows nothing about — a search, a review,
        // anything it did not declare — and every one of them reaches this path. None may bind a row
        // and none may end one, and none may fail the hook that carried it.
        // cm:guard the harness makes no promise that a `SubagentStart` is delivered once, and this is
        // what a replay costs if nothing refuses it: the replayed child binds the row its master
        // declared for the NEXT subagent, its own `SubagentStop` then ends a run whose subagent is
        // still working, and the real child of that row finds nothing pending to bind (ISS-1050
        // criterion 1).
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
        // cm:guard an ENDED run still holds its child's name, so a start replayed after that run closed
        // must not reach into the next row either. The `NOT EXISTS` looks at every run for this reason.
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
