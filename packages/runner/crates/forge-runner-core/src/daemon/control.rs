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
        /// `agent_type` on a child event: the role the child was dispatched through.
        // cm:guard OPTIONAL and read only to tell a hand-off from a helper. It is not a second way to name a run and nothing routes on it — a child whose role this box ships but has no declaration is REPORTED, never bound, because binding on a label would give a row to work nobody declared (ISS-1094).
        #[serde(default)]
        agent_type: Option<String>,
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
    /// "I am about to hand work to this subagent — has it been declared?"
    // cm:guard this frame ASKS and the answer it gets back is advice to the pane's own hook, which is what turns the declaration from advice into a condition without putting a second actor on this socket. It writes one thing — the promise binding a declaration to the tool call it authorised — and that write is what stops two dispatches riding one row (ISS-1094 invariant 1).
    // cm:edge contract -> packages/runner/crates/forge-runner/src/cmd/gate.rs — the only sender, and the shape of `Dispatch` is what a `PreToolUse` payload from claude actually carries, measured rather than composed.
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
    /// Where this box's marks and its plugin clones live.
    // cm:guard resolved ONCE, at construction, and carried — the same rule `mcp/config.rs` states for the credential and for the same reason: a second resolution is how one path on a box starts reading a different directory from another. It is also the seam the tests need, since a handler resolving it itself would write this daemon's marks into the operator's real config directory during `cargo test`.
    pub config_dir: Option<PathBuf>,
    /// What the gate has decided this daemon lifetime, promises and answers both.
    // cm:guard in MEMORY, so it lasts exactly as long as this daemon process and no longer. That is NOT the same scope the ledger has: `unbound_run_for_master` is keyed on `boot_identity()`, which is the OS boot and survives a daemon restart, so a declaration outlives this map. The consequence is stated on ISS-1094 as criteria 41 and 42 rather than engineered around: after a restart the declaration is still the master's and the next dispatch is ALLOWED, because refusing would force a second row for work already declared and leave an orphan core reaps in ten minutes. Single-use across a restart is held by `ledger::bind_agent`'s `agent_id IS NULL` and by the denunciation, not by this map.
    pub promises: std::sync::Mutex<GateMemory>,
}

/// What the declaration gate remembers for as long as this daemon runs.
// cm:guard the two maps are under ONE lock, and that is what makes single-use hold. Reading the promise and writing it under separate locks is a check followed by a create: two dispatches racing on one declaration both read no promise and both are allowed, which is the invariant this was built to defend arriving through the back door (ISS-1094, review F2).
#[derive(Default)]
pub struct GateMemory {
    /// Which tool call each pending declaration has been promised to.
    promised: std::collections::HashMap<String, String>,
    /// Tool calls this daemon has already allowed.
    // cm:guard OUTLIVES the promise on purpose. The promise is released when the subagent binds, but the hook that asked may be replayed after that — the harness promises nothing about delivering once — and a replay finding its promise gone would either be refused or would eat the master's NEXT declaration. Criterion 6's guarantee is for the whole daemon lifetime, not until the bind (ISS-1094, review F4).
    allowed: std::collections::HashSet<String>,
}

/// Whether a session on this box can report a turn at all.
// cm:guard the SAME fact `serve` states below with its `cfg`, carried as a VALUE so a caller can take it as a parameter. `socket_path`, `hook_install::install` and `SessionTokens::mint` are all platform-independent, so without this a windows box mints a capability, installs hooks, records the job `Hooked` and then never receives a frame — and `turn_evidence` fails every healthy pool job on it at the window. Inert in the dangerous direction, on the one platform no test here runs.
// cm:guard a value and NOT a `#[cfg(not(unix))]` arm in the caller, which is the whole reason it exists: `cargo check --target x86_64-pc-windows-msvc` dies in `ring` and `libsqlite3-sys` build scripts before this crate is reached, and every test on this box runs where `cfg(unix)` is true — so a mutation planted in such an arm fires nowhere anybody can run it, and the green means nothing. As a parameter both arms are reachable from a linux test (ISS-1096).
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/daemon/control.rs:serve — if the socket ever grows a non-unix transport, this moves with `serve`'s gate or the two disagree silently, in the direction that kills healthy releases.
pub const HOOKS_CAN_REPORT: bool = cfg!(unix);

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
    agent_type: Option<&str>,
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
    bind_or_release(ctl, parsed, agent_id, agent_type, session_id);
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

/// The directory this box's marks and its plugin clones sit in.
pub fn config_dir() -> Option<PathBuf> {
    crate::config::Config::path()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

/// Answer one pane's question: may it hand this work out?
// cm:guard the REFUSAL is the deliverable of this whole issue, so it travels whole from `dispatch_gate::REFUSAL` and is never summarised here. A master told "refused" with no verb to run is a master that stops, which is worse than the advice it replaces.
// cm:guard an `Unknown` verdict answers OK and marks. Refusing on a box whose plugin clone is missing would wedge every master on it, and the dispatch this lets through is still named twice: once in the mark here, and again by `bind_or_release` when the subagent starts.
#[cfg(unix)]
fn dispatch_gate_reply(
    ctl: &Arc<Control>,
    d: crate::daemon::dispatch_gate::Dispatch,
    session_id: &str,
) -> ClaimReply {
    use crate::daemon::dispatch_gate::{decide, Facts, Verdict, REFUSAL};

    let dir = ctl.config_dir.clone();
    let roles = dir.as_deref().and_then(dispatch_gate_roles);

    // cm:guard the ledger lock is taken BEFORE the gate memory and never the other way round, the
    // same order `bind_or_release` takes them in. Two orders on two locks is a deadlock that only
    // appears under the concurrency this critical section exists to survive.
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let pending = match held.as_mut() {
        // cm:guard a ledger ERROR is not "nothing is declared". Collapsing the two refuses a
        // master because this box could not read its own registry, which is an uncertain state
        // answered with a certain denial — the shape this whole issue is about, inverted
        // (ISS-1094, review F5).
        Some(led) => match led.unbound_run_for_master(session_id, &ctl.boot_id) {
            Ok(run) => run.map(|r| r.run_id),
            Err(e) => {
                let why = "this box's own registry of declared runs could not be read";
                tracing::error!("[control] the dispatch gate could not decide: {why}: {e}");
                if let Some(dir) = dir.as_deref() {
                    crate::daemon::degraded::mark(
                        dir,
                        crate::daemon::degraded::Kind::Degraded,
                        why,
                    );
                }
                return gate_allows(Some(why));
            }
        },
        None => {
            let why = "this box holds no registry of declared runs";
            if let Some(dir) = dir.as_deref() {
                crate::daemon::degraded::mark(dir, crate::daemon::degraded::Kind::Degraded, why);
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
                crate::daemon::degraded::mark(dir, crate::daemon::degraded::Kind::Degraded, why);
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
    agent_type: Option<&str>,
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
                    Ok(true) => {
                        // cm:guard the promise is released HERE, at the bind, and by the same
                        // event that consumes the declaration. Released anywhere later, the next
                        // dispatch is refused although its row is free; released anywhere earlier,
                        // two dispatches ride one row again.
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
                // cm:limit a child is correlated to a declaration by MASTER SESSION and by nothing
                // else, which is ISS-1050's model and not this change's to replace: measured
                // against claude 2.1.276, a `SubagentStart` payload carries `agent_id`,
                // `agent_type`, `session_id`, `cwd`, `prompt_id` and `transcript_path` — and
                // `prompt_id` is per TURN, so two dispatches in one turn share it. There is no key
                // in what the harness gives that names the tool call a child came from. The
                // consequence has one narrow shape: where a daemon restart let two dispatches
                // through on one declaration (ISS-1094 criteria 41, 42) AND the master declares
                // again between the first child binding and the second starting, the second binds
                // the new row instead of being named here. Closing it needs a correlation key the
                // payloads do not carry; it is bounded on the issue rather than papered over.
                // cm:guard the two cases here are NOT one, and reading them as one is what left
                // sid-desk with four issues nobody was working. A master runs subagents this box
                // knows nothing about — a search, a review — and those are the ordinary case and
                // stay silent. A child started under a role this box's plugin SHIPS is a unit of
                // work the master was required to declare and did not: the gate should have
                // refused that dispatch, so each one here got past it. That is kernel input — a
                // run with no row — and it breaks loudly and countably rather than into a
                // `debug!` nobody reads (ISS-1094).
                // cm:guard a child that ALREADY has a run is not undeclared, and asking the
                // ledger is the only way to tell: `unbound_run_for_master` answers `None` both
                // when nothing was declared and when this child's own declaration has already
                // been bound and nothing new is pending. The harness makes no promise that a
                // `SubagentStart` arrives once, so a replay would otherwise raise a false alarm
                // on the one counter whose whole value is that it moves only when something is
                // wrong (ISS-1094, review F3).
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

// cm:guard the third case is NOT the second. A failed read of this box's own ledger establishes
// nothing, and answering it with `UNDECLARED HAND-OFF: ... this box holds no row for that work`
// asserts a fact nobody measured, on the one counter whose entire value is that it moves only when
// something is wrong. `dispatch_gate_reply` already carries this rule for the other ledger read in
// this file — a ledger ERROR is not "nothing is declared" — and the two reads answer it the same
// way or the file contradicts itself (ISS-1094, review F3 recheck).
pub(crate) fn classify_start(read: Result<Option<String>, String>) -> StartKind {
    match read {
        Ok(Some(run_id)) => StartKind::Replay(run_id),
        Ok(None) => StartKind::Undeclared,
        Err(e) => StartKind::Unreadable(e),
    }
}

// cm:guard `#[cfg(unix)]` binds to the NEXT item, so anything inserted between one and the function
// it was written for silently re-gates the wrong thing. That is how this file shipped `StartKind`
// as unix-only and `undeclared_child` as unconditional in one edit: every local gate was green,
// because `cfg(unix)` is true on the box, and only ci.yml's windows leg could see it. Add an item
// here by writing its own attribute, never by landing above someone else's (ISS-1094).
#[cfg(unix)]
fn unreadable_ledger(ctl: &Arc<Control>, child: &str, e: &str) {
    let detail = format!("could not read the declared runs when subagent {child} started: {e}");
    tracing::warn!("[control] {detail} — this box knows neither that the work was declared nor that it was not");
    if let Some(dir) = ctl.config_dir.as_deref() {
        crate::daemon::degraded::mark(dir, crate::daemon::degraded::Kind::Degraded, &detail);
    }
}

/// A subagent that started under a shipped role with nothing declared for it.
// cm:guard the role set is read here again rather than passed in from the gate: this path runs when the gate did not, which is precisely when a value carried from it would be missing.
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
        crate::daemon::degraded::mark(dir, crate::daemon::degraded::Kind::Undeclared, &detail);
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
            agent_type,
            ..
        } => agent_event(
            ctl,
            &event,
            at_ms,
            agent_id.as_deref(),
            conversation_id.as_deref(),
            agent_type.as_deref(),
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
    _agent_type: Option<&str>,
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
    agent_id: Option<&str>,
    conversation_id: Option<&str>,
    agent_type: Option<&str>,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({
            "op": "agent_event", "token": token, "event": event,
            "agentId": agent_id, "conversationId": conversation_id,
            "agentType": agent_type
        }),
    )
    .await
}

/// Ask whether the work about to be handed out has been declared.
#[cfg(unix)]
pub async fn request_dispatch_gate(
    path: &std::path::Path,
    token: &str,
    d: &crate::daemon::dispatch_gate::Dispatch,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({
            "op": "dispatch_gate", "token": token,
            "agentId": d.agent_id, "subagentType": d.subagent_type,
            "toolUseId": d.tool_use_id
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
    // cm:guard `config_dir` points INTO that scratch directory and never at this machine's own. Without it every one of these tests writes a mark into the operator's real `~/.config/forge-runner`, and `forge-runner status` on a developer box starts reporting undeclared hand-offs that were `cargo test`.
    fn declaring_control(session_id: &str, project_id: &str) -> (Arc<Control>, String) {
        let dir = std::env::temp_dir().join(format!("ct-decl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
                config_dir: Some(dir),
                promises: std::sync::Mutex::new(GateMemory::default()),
            }),
            token,
        )
    }

    fn asking(role: &str, tool_use: &str) -> crate::daemon::dispatch_gate::Dispatch {
        crate::daemon::dispatch_gate::Dispatch {
            agent_id: None,
            subagent_type: Some(role.into()),
            tool_use_id: Some(tool_use.into()),
        }
    }

    /// Ask the gate the way the socket asks it.
    ///
    // cm:guard this CALLS `dispatch_gate_reply`. It used to re-implement it — read the ledger,
    // read the roles, call `decide`, insert the promise — and a faithful reconstruction passes
    // every review while producing assertions that cannot fail: planting inside the shipped
    // function left these tests green, which is how ISS-1094's re-judge found it. A helper that
    // rebuilds its subject is the arm being judged instead of the door, the exact shape ISS-1075
    // was caught on, rebuilt inside the change meant to have learned from it (ISS-1094).
    // cm:guard `#[cfg(unix)]` on this helper is SCOPING and not an amnesty, and ISS-1096 deleted the
    // `cm:hack` that called it one after measuring the platform: there is no trade to price here.
    // cm:guard the gate handler has NO `#[cfg(not(unix))]` twin — `dispatch_gate_reply` exists on
    // unix alone, because `serve` refuses outright on a platform with no unix socket to host it.
    // cm:guard so on Windows the gate is not "asserted by nothing": it is a compile-time absence at
    // the server and `request_dispatch_gate` -> `Err(no_socket())`, refusing by name, at the client.
    // cm:guard the hack's `until:` could never have discharged it either. It named `open_channel`,
    // which is `pool_jobs.rs`'s, and no value there makes a `#[cfg(unix)]` item exist on Windows.
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

    /// Which declaration the socket's own answer named, if any.
    ///
    // cm:guard `job_id` is the ONLY thing in the reply that tells `Covered` from `Replay` — both
    // answer `ok: true`, and a caller reading `ok` alone cannot tell a dispatch that reserved a row
    // from one told about a row it already held. It was also, until this assertion, written and
    // read by nothing: planting `reply.job_id = None` left the whole workspace green (ISS-1094,
    // retrospective review of #518).
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

    /// Criteria 1, 4, 5, 6, 7 — the whole life of one declaration, in order.
    // cm:guard the sequence is the test. Each assertion alone is satisfiable by a wrong implementation: "refuse with nothing declared" passes a gate that always refuses, "allow with one declared" passes one that always allows, and only running them against one ledger in this order pins the behaviour to the declaration.
    // cm:guard gated `unix` because the functions under test are: `dispatch_gate_reply`,
    // `bind_or_release` and `run_declare` all carry `#[cfg(unix)]`, and a test that names them
    // without the same attribute does not fail on this box -- `cfg(unix)` is true here -- it fails
    // the windows leg with `cannot find function` and takes the whole crate's build with it. What
    // windows actually does is not skipped with them: `classify_start` is pure and its test runs
    // everywhere (ISS-1094).
    #[cfg(unix)]
    #[test]
    fn one_declaration_authorises_one_dispatch_and_is_freed_when_its_subagent_starts() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
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
        bind_or_release(
            &ctl,
            crate::daemon::agent_activity::Event::SubagentStarted,
            Some("child-1"),
            Some("runner"),
            "sess-a",
        );
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

    /// Criteria 41, 42, corrected. What a daemon restart with the pane still
    /// alive actually does, measured rather than assumed.
    // cm:guard this test used to mint a different `boot_id` and call that a restart. It is not one: `runner::inflight::boot_identity` reads the OS boot identity (`/proc/sys/kernel/random/boot_id` on linux), which a daemon restart does NOT change — only rebooting the machine does. So a declaration made before the restart is still pending afterwards, and that is right: the master declared it, nothing consumed it, and refusing would force a second row for work already declared. The criteria were written against a wrong model of that function and are corrected on the issue rather than the behaviour being bent to match them (ISS-1094, review F1).
    // cm:guard what single-use actually rests on is the BIND, not the gate. `ledger::bind_agent` updates only where `agent_id IS NULL`, so two dispatches allowed across a restart still produce exactly one bound row — and the second child is denounced by `undeclared_child`, loudly and countably. The gate is the early refusal; the ledger is the invariant.
    #[cfg(unix)]
    #[test]
    fn a_daemon_restart_leaves_the_declaration_standing_and_the_second_child_is_named() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
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
                std::env::temp_dir().join(format!("ct-restart-{}.json", uuid::Uuid::new_v4())),
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
            bind_or_release(
                &restarted,
                crate::daemon::agent_activity::Event::SubagentStarted,
                Some(child),
                Some("runner"),
                "sess-a",
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
        assert!(undeclared.last.unwrap_or_default().contains("child-2"));
    }

    /// Criterion 6, across the bind, which is where it was broken.
    // cm:guard the replay is asked AFTER the subagent has started, because that is the case the promise map cannot answer: it is released at the bind, and a hook replayed a moment later would have found nothing and either been refused or eaten the master's next declaration (ISS-1094, review F4).
    #[cfg(unix)]
    #[test]
    fn a_replayed_hook_gets_its_answer_back_even_after_its_subagent_started() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
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

        bind_or_release(
            &ctl,
            crate::daemon::agent_activity::Event::SubagentStarted,
            Some("child-1"),
            Some("runner"),
            "sess-a",
        );

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

    /// Criterion 14. An uncertain box does not deny.
    // cm:guard the ledger being absent is not "nothing is declared". This is the inversion that would have turned a box with an unreadable registry into a box that refuses every master on it, which is a certain answer given to an uncertain question (ISS-1094, review F5).
    #[cfg(unix)]
    #[test]
    fn a_box_that_cannot_read_its_own_registry_allows_and_marks() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
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

    /// Criteria 24, 25. A hand-off that got past the gate breaks loudly and
    /// countably, because the gate fails OPEN and this is what says it did.
    // cm:guard this is kernel input — a run with no row — so the bar is zero tolerance. Before ISS-1094 this path was a `tracing::debug!` under a guard declaring it the ordinary case, and four issues on sid-desk stood in-progress with nobody on them because of it.
    #[cfg(unix)]
    #[test]
    fn a_subagent_started_under_a_shipped_role_with_nothing_declared_is_named_and_counted() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner", "reviewer"]);

        bind_or_release(
            &ctl,
            crate::daemon::agent_activity::Event::SubagentStarted,
            Some("child-nobody-declared"),
            Some("runner"),
            "sess-a",
        );

        let (_, undeclared) = crate::daemon::degraded::tally(&dir);
        assert_eq!(undeclared.count, 1, "the count an operator reads must move");
        let said = undeclared.last.unwrap_or_default();
        assert!(said.contains("child-nobody-declared"), "{said}");
        assert!(
            said.contains("runner"),
            "which role it was dispatched through is half of what makes it actionable: {said}"
        );
    }

    /// Criterion 27. A search helper is still the ordinary case and stays quiet.
    // cm:guard the silence here is as load-bearing as the noise above. A master runs subagents this box knows nothing about on every pass, and a line for each one is a count nobody can read and an alert nobody keeps.
    #[cfg(unix)]
    #[test]
    fn a_subagent_that_is_not_a_shipped_role_stays_silent() {
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner", "reviewer"]);

        for role in [Some("general-purpose"), Some("Explore"), None] {
            bind_or_release(
                &ctl,
                crate::daemon::agent_activity::Event::SubagentStarted,
                Some("a-search"),
                role,
                "sess-a",
            );
        }

        let (_, undeclared) = crate::daemon::degraded::tally(&dir);
        assert_eq!(
            undeclared.count, 0,
            "a helper is not a hand-off: {undeclared:?}"
        );
    }

    /// Review F3. A repeated start for a child that already has its run.
    // cm:guard no second declaration is made here, which is what separates this from the tests above it: with one pending, a replay binds that instead and the alarm is silent for the wrong reason. With nothing pending, the old code called the child undeclared and moved the operator's counter for a run that was recorded correctly.
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
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner"]);
        let _ = run_declare(&ctl, "proj-1", &["ISS-7".into()], "/w/seven", "sess-a")
            .job_id
            .expect("declared");

        for _ in 0..3 {
            bind_or_release(
                &ctl,
                crate::daemon::agent_activity::Event::SubagentStarted,
                Some("child-1"),
                Some("runner"),
                "sess-a",
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
        let (ctl, _t) = declaring_control("sess-a", "proj-1");
        let dir = ship_roles(&ctl, &["runner"]);
        let _ = run_declare(&ctl, "proj-1", &["ISS-7".into()], "/w/seven", "sess-a")
            .job_id
            .expect("declared");

        bind_or_release(
            &ctl,
            crate::daemon::agent_activity::Event::SubagentStarted,
            Some("child-1"),
            Some("runner"),
            "sess-a",
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

    // cm:guard the frame the gate sends is round-tripped through the daemon's OWN `Request`, in the
    // one file that holds both, so a field renamed on either side fails here rather than as a gate
    // that silently answers `ok` to everything. The end-to-end door test asserts the same names off
    // the wire; this is what makes the two agree without a literal copied between them.
    #[test]
    fn the_frame_the_gate_sends_decodes_as_the_daemon_reads_it() {
        let frame = r#"{"op":"dispatch_gate","token":"t1","agentId":null,"subagentType":"runner","toolUseId":"toolu_1"}"#;
        let req: Request = serde_json::from_str(frame).expect("the gate frame must decode");
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
                None,
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
                None,
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

            agent_event(&ctl, "Stop", None, None, Some("conv-abc"), None, "sess-a");

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

            agent_event(&ctl, "Stop", None, None, Some("conv-abc"), None, "sess-a");
            agent_event(&ctl, "Stop", None, None, None, None, "sess-a");

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
                None,
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
                None,
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
                None,
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
            bind_or_release(&ctl, start, Some("child-a"), None, "sess-a");
            let run_b = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/two", "sess-a")
                .job_id
                .unwrap();
            bind_or_release(&ctl, start, Some("child-a"), None, "sess-a");
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
            bind_or_release(&ctl, start, Some("child-a"), None, "sess-a");
            bind_or_release(
                &ctl,
                crate::daemon::agent_activity::Event::SubagentStopped,
                Some("child-a"),
                None,
                "sess-a",
            );
            let run_b = run_declare(&ctl, "proj-1", &["ISS-2".into()], "/w/two", "sess-a")
                .job_id
                .unwrap();
            bind_or_release(&ctl, start, Some("child-a"), None, "sess-a");
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
                None,
                "sess-a",
            );
            bind_or_release(
                &ctl,
                crate::daemon::agent_activity::Event::SubagentStopped,
                Some("stranger"),
                None,
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
