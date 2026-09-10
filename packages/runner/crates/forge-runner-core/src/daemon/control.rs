//! The local socket a master talks to, and why a master may not talk to core.
//!
//! A master is a Claude session on this box. It decides WHICH job runs; the
//! daemon is what actually runs one. Both halves of that have to happen in the
//! same process: the repo lock (`daemon/repo_lock.rs`) and the in-flight map
//! (`runner/inflight.rs`) are in-memory, so a claim made from a second process
//! takes a lock this daemon cannot see and runs a job it cannot cancel, reap or
//! salvage.
//!
//! So the CLI does not claim — it asks here, and the daemon claims and starts
//! the work in one place.
//!
//! Two ops, not one (ISS-919 B2). `prepare` takes the job row and the job token
//! and starts NOTHING; `start` is the spawn. A master can hold a preparation,
//! decide against it and hand it back, which the single irreversible verb this
//! replaced made impossible. The daemon holds the preparation in between and
//! owes the release either way — `Preparations` below is where that debt lives.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};

use crate::config::Config;
#[cfg(unix)]
use crate::daemon::dispatch;
use crate::daemon::repo_lock::RepoLocks;
use crate::daemon::session_tokens::SessionTokens;
#[cfg(unix)]
use crate::daemon::InflightGuard;
use crate::runner::claude_code::ClaudeCodeRunner;
use crate::transport::pool;
use crate::transport::CoreClient;

/// Where the daemon listens and the CLI connects: beside `config.toml`.
// cm:guard derive this from `Config::path()` and nothing else. dev1 runs several runner services that differ ONLY by `XDG_CONFIG_HOME`, so the config dir is already the thing that separates them; a socket keyed on anything else (a fixed name, the hostname, `XDG_RUNTIME_DIR`) puts two daemons on one path, and a master then reaches whichever bound first — claiming for a project that box is not bound to.
pub fn socket_path() -> Option<PathBuf> {
    let cfg = Config::path().ok()?;
    Some(cfg.with_file_name("control.sock"))
}

// cm:guard every variant carries `token` and NONE declares a session. The daemon maps token -> session and an unknown field on the frame is dropped by serde, so a master that names another master's session is served as itself — one box runs one master per project, which made a declared id a way ACROSS projects (ISS-964 criteria 29-31).
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    /// Take one job — job row and job token — WITHOUT starting anything.
    // cm:guard the FIELDS need their own `rename_all` — the one on the enum renames variants, not fields. Without it these read `job_id`/`session_id` while the CLI sends camelCase, and every claim comes back "undecodable request".
    #[serde(rename_all = "camelCase")]
    Prepare {
        job_id: String,
        token: String,
        // cm:guard the master NAMES the agent, and the name is the worktree branch — core no longer sends one. Keep this `Option` rather than making serde require it: a missing name must come back as `agent_required`, which tells a master what to do, where a required field fails the whole frame as "undecodable request" and names nothing.
        #[serde(default)]
        agent: Option<String>,
    },
    /// Start a job this session already prepared.
    #[serde(rename_all = "camelCase")]
    Start { job_id: String, token: String },
    /// Hand back a preparation that will never start.
    #[serde(rename_all = "camelCase")]
    Discard { job_id: String, token: String },
    /// Hand back one job, or everything this session holds.
    // cm:guard release travels the socket like the other three rather than going straight to core, because it names a session and the token is now the only thing that may. A CLI flag here would leave one verb able to release another master's holds — the same hole, on the one op whose whole effect is to take work away from somebody (ISS-964 criterion 30).
    #[serde(rename_all = "camelCase")]
    Release {
        token: String,
        #[serde(default)]
        job_id: Option<String>,
    },
    /// Open one run session over a GROUP of issues.
    // cm:guard `issue_keys` is a list and there is no scalar sibling — a group of one takes the same path as a group of three, which is what `ledger::create_run_group` exists to enforce and what two sessions in one worktree came from (ISS-933 criterion 8).
    #[serde(rename_all = "camelCase")]
    RunOpen {
        token: String,
        project_id: String,
        issue_keys: Vec<String>,
        agent: String,
        #[serde(default)]
        start_point: Option<String>,
    },
    /// Park one run this session owns on a human, releasing its process.
    // cm:guard this verb carries the HUMAN park alone. The bounded arms cannot live behind a socket call: `blocked::arm_bounded` returns the run's ear and the caller owns its lifetime, so a per-call handler would open the door and drop it, leaving the ledger advertising a listener that every later ring meets with `ENXIO` (ISS-964 criteria 5, 11).
    #[serde(rename_all = "camelCase")]
    Ask {
        token: String,
        run_id: String,
        prompt: String,
        #[serde(default = "human_blocker")]
        blocker_kind: String,
        #[serde(default)]
        options: Option<serde_json::Value>,
        #[serde(default)]
        recommended_option_id: Option<String>,
        #[serde(default)]
        round: Option<i64>,
        #[serde(default)]
        resume_id: Option<String>,
    },
    /// What this session's own hooks say it is doing (turn boundaries).
    // cm:guard the ONLY verb on this socket that reports rather than acts, and it stays a report: it takes no run id, claims nothing and releases nothing, so a pane whose hooks are noisy or forged can move no work. What it can do is describe itself, which is exactly the authority a session should have over its own state.
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
    /// Record a decision this session took instead of asking about it.
    // cm:guard the counterpart of `Ask` and the reason it can be judged: tier 0 says a reversible write is TAKEN and recorded, so without this verb the only thing a box records is the questions it did ask and every master looks equally talkative (ISS-964 criteria 1, 2).
    #[serde(rename_all = "camelCase")]
    Decide {
        token: String,
        decision_id: String,
        verb: String,
    },
}

fn human_blocker() -> String {
    crate::runner::ledger::BlockerKind::Human.wire().to_string()
}

impl Request {
    fn token(&self) -> &str {
        match self {
            Request::Prepare { token, .. }
            | Request::Start { token, .. }
            | Request::Discard { token, .. }
            | Request::Release { token, .. }
            | Request::RunOpen { token, .. }
            | Request::Ask { token, .. }
            | Request::Decide { token, .. }
            | Request::AgentEvent { token, .. } => token,
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
    pub client: CoreClient,
    pub runner: Arc<ClaudeCodeRunner>,
    pub cfg: Config,
    pub locks: RepoLocks,
    pub inflight: Arc<std::sync::atomic::AtomicUsize>,
    /// Jobs taken and not yet started. See [`Preparations`].
    pub prepared: Preparations,
    /// Which session is on the other end of a frame.
    pub tokens: SessionTokens,
    /// What each session's hooks have reported about itself.
    pub activity: Arc<crate::daemon::agent_activity::Activities>,
}

/// How long a preparation may sit before this daemon hands it back.
// cm:guard STRICTLY below core's `MASTER_HOLD_TIMEOUT_MS` (3 minutes), so the daemon that holds the preparation is the one that releases it and the reaper stays the backstop. Above it and the reaper wins the race: the hold comes back while this map still believes it owns the job, and `start` then stamps a job core has already offered to somebody else.
pub const PREPARE_TTL: std::time::Duration = std::time::Duration::from_secs(120);

/// The preparations this daemon is holding on a master's behalf.
///
/// B2's debt made explicit: a `prepare` that never becomes a `start` owes the
/// release, and the only process that knows it happened is this one.
// cm:guard the sweep must release through CORE (`pool::release`), not merely drop the entry. Forgetting the map is invisible; forgetting the HOLD parks claimable work on a master that never ran it, which is the exact failure B2 names and the reason a new verb was allowed at all.
#[derive(Clone, Default)]
pub struct Preparations(Arc<std::sync::Mutex<std::collections::HashMap<String, Held>>>);

pub struct Held {
    session_id: String,
    job: pool::ClaimedJob,
    at: std::time::Instant,
}

impl Preparations {
    pub fn new() -> Self {
        Self::default()
    }

    fn put(&self, job: pool::ClaimedJob, session_id: &str) {
        let mut map = self.0.lock().expect("preparations poisoned");
        map.insert(
            job.job_id.clone(),
            Held {
                session_id: session_id.to_string(),
                job,
                at: std::time::Instant::now(),
            },
        );
    }

    // cm:guard the session id is checked HERE, not by the caller. A `start` naming a job another master prepared would spawn that master's work under this one's name, and core cannot catch it: the two look identical on the wire because both hold a valid device token on the same box.
    fn take(&self, job_id: &str, session_id: &str) -> Option<pool::ClaimedJob> {
        let mut map = self.0.lock().expect("preparations poisoned");
        match map.get(job_id) {
            Some(h) if h.session_id == session_id => map.remove(job_id).map(|h| h.job),
            _ => None,
        }
    }

    fn expired(&self, ttl: std::time::Duration) -> Vec<(String, String)> {
        let mut map = self.0.lock().expect("preparations poisoned");
        let now = std::time::Instant::now();
        let stale: Vec<String> = map
            .iter()
            .filter(|(_, h)| now.duration_since(h.at) >= ttl)
            .map(|(k, _)| k.clone())
            .collect();
        stale
            .into_iter()
            .filter_map(|k| map.remove(&k).map(|h| (k, h.session_id)))
            .collect()
    }
}

/// Give back every preparation nobody started, forever.
// cm:guard this loop is not optional bookkeeping — it is the half of B2 that keeps the split from parking work. A daemon that offered `prepare` without it would let a master take ten jobs, start two and strand eight until core's reaper noticed, three minutes at a time.
pub async fn reap_preparations(
    client: CoreClient,
    prepared: Preparations,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(15));
    loop {
        tokio::select! {
            _ = tick.tick() => {
                for (job_id, session_id) in prepared.expired(PREPARE_TTL) {
                    tracing::warn!(
                        "[control] preparation for job {job_id} was never started — returning it to the pool"
                    );
                    let _ = pool::release(&client, Some(&job_id), &session_id).await;
                }
            }
            _ = cancel.changed() => { if *cancel.borrow() { break; } }
        }
    }
}

/// Serve until `cancel` flips.
// cm:guard REFUSE on a platform with no unix socket, never degrade to a daemon that polls the pool and cannot be claimed from. Under the pool a box runs work only when a master claims through this socket, so a Windows daemon that started anyway would sit online, report healthy, and never run a single job — the exact silent shape `daemon/mod.rs` starts both loops to avoid.
#[cfg(not(unix))]
pub async fn serve(
    _ctl: Arc<Control>,
    _cancel: tokio::sync::watch::Receiver<bool>,
) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "the master control socket needs a unix socket; this platform cannot host a runner that claims work",
    ))
}

#[cfg(unix)]
// cm:guard bind by REPLACING a stale socket file, never by refusing to start. A daemon killed by SIGKILL leaves the file behind, and a runner that then declines to listen is a box that accepts no work with nothing in its log naming the socket as the cause.
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
            Some(session_id) => serve_request(&ctl, req, &session_id).await,
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
async fn serve_request(ctl: &Arc<Control>, req: Request, session_id: &str) -> ClaimReply {
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
        Request::Prepare { job_id, agent, .. } => {
            prepare(ctl, &job_id, session_id, agent.as_deref()).await
        }
        Request::Start { job_id, .. } => start(ctl, &job_id, session_id).await,
        Request::Discard { job_id, .. } => discard(ctl, &job_id, session_id).await,
        Request::Release { job_id, .. } => release(ctl, job_id.as_deref(), session_id).await,
        // cm:guard the run's parent is the session the TOKEN resolved to, never a field on the frame. It is what `runs_for_master` and `master_exit::children` match on and what `recovery` calls `is_alive` with, so a caller able to name it could orphan another master's runs or adopt them (ISS-934 criterion 1, ISS-964 criterion 30).
        Request::RunOpen {
            project_id,
            issue_keys,
            agent,
            start_point,
            ..
        } => {
            run_open(
                ctl,
                &project_id,
                &issue_keys,
                &agent,
                session_id,
                start_point.as_deref(),
            )
            .await
        }
        Request::Ask {
            run_id,
            prompt,
            blocker_kind,
            options,
            recommended_option_id,
            round,
            resume_id,
            ..
        } => {
            park(
                ctl,
                AskArgs {
                    run_id: &run_id,
                    prompt: &prompt,
                    blocker_kind: &blocker_kind,
                    options: options.unwrap_or_else(|| serde_json::json!([])),
                    recommended_option_id: recommended_option_id.as_deref().unwrap_or_default(),
                    round: round.unwrap_or(1),
                    resume_id: resume_id.as_deref(),
                },
                session_id,
            )
            .await
        }
        Request::Decide {
            decision_id, verb, ..
        } => decide(&decision_id, &verb, session_id),
    }
}

/// Record the decision under the session the TOKEN named.
// cm:guard the ledger is the store and never a counter in this process: the master that took the decisions has exited by the time anybody reads the ratio, and a count that dies with it is no denominator (ISS-964 criterion 2).
fn decide(decision_id: &str, verb: &str, session_id: &str) -> ClaimReply {
    if verb.trim().is_empty() {
        return ClaimReply::refused("verb_required");
    }
    let ledger = match crate::runner::ledger::Ledger::default_path()
        .and_then(|p| crate::runner::ledger::Ledger::open(&p))
    {
        Ok(l) => l,
        Err(e) => return ClaimReply::refused(format!("ledger unavailable: {e}")),
    };
    match ledger.record_decision(decision_id, session_id, verb) {
        Ok(()) => ClaimReply {
            ok: true,
            job_id: None,
            agent_session_id: Some(session_id.to_string()),
            issue_key: Some(decision_id.to_string()),
            reason: None,
        },
        Err(e) => ClaimReply::refused(e.to_string()),
    }
}

/// What the caller sends with a park, once the token has named the asker.
struct AskArgs<'a> {
    run_id: &'a str,
    prompt: &'a str,
    blocker_kind: &'a str,
    options: serde_json::Value,
    recommended_option_id: &'a str,
    round: i64,
    resume_id: Option<&'a str>,
}

/// Everything about a park that is decidable without touching core or a process.
// cm:guard split out so the refusals are reachable by a test: the handler below cannot run without a core client and a live pid, and a refusal nothing can exercise is a refusal nobody knows is gone (ISS-964 criteria 30, 60).
fn plan_park(
    run: Option<&crate::runner::ledger::Run>,
    asker: &str,
    blocker_wire: &str,
) -> Result<crate::runner::ledger::BlockerKind, String> {
    let run = run.ok_or("unknown_run")?;
    if run.master_session_id != asker {
        return Err("not_your_run".into());
    }
    if run.ended_by.is_some() {
        return Err("run_ended".into());
    }
    crate::runner::ledger::BlockerKind::from_wire(blocker_wire).ok_or("blocker_kind_unknown".into())
}

#[cfg(unix)]
/// Park a run on a human: permit, then the ledger, then the process, then core.
// cm:guard the ORDER is permit -> park -> kill -> tell core, and each step is where it is for a different reason. The permit first because a park core cannot protect must not happen at all; the ledger before the kill because a process killed first leaves the run reading `live` behind a dead pid; core LAST because it is the only step that may fail without costing anything — the id is minted here and `INSERT OR IGNORE` makes the reconcile sweep's re-post free (ISS-964 criteria 7, 10, 27).
async fn park(ctl: &Arc<Control>, args: AskArgs<'_>, asker: &str) -> ClaimReply {
    let mut ledger = match crate::runner::ledger::Ledger::default_path()
        .and_then(|p| crate::runner::ledger::Ledger::open(&p))
    {
        Ok(l) => l,
        Err(e) => return ClaimReply::refused(format!("ledger unavailable: {e}")),
    };
    let run = match ledger.run(args.run_id) {
        Ok(r) => r,
        Err(e) => return ClaimReply::refused(format!("ledger unreadable: {e}")),
    };
    let blocker = match plan_park(run.as_ref(), asker, args.blocker_kind) {
        Ok(b) => b,
        Err(reason) => return ClaimReply::refused(reason),
    };
    let run = run.expect("plan_park refuses a missing run");
    let advertised = crate::transport::protections::park_protections(&ctl.client).await;
    let permit = match crate::runner::blocked::ParkPermit::from_advertisement(&advertised) {
        Ok(p) => p,
        Err(e) => return ClaimReply::refused(e.to_string()),
    };
    let question_id = uuid::Uuid::new_v4().to_string();
    let what = crate::runner::blocked::Wait {
        run_id: args.run_id,
        question_id: &question_id,
        round: args.round,
        blocker,
        resume_id: args.resume_id,
        park_deadline_at: None,
    };
    if let Err(e) = crate::runner::blocked::park_for_human(&mut ledger, what, &permit) {
        return ClaimReply::refused(e.to_string());
    }
    // cm:guard the pid is killed through `inflight::kill_group` and never with a bare `kill`, because what has to go is the process GROUP: a pane's shell outlives a signal sent to the agent alone, and the run then reads parked with a live tree behind it (ISS-964 criterion 7).
    if let Some(pid) = run.pid {
        crate::runner::inflight::kill_group(pid).await;
    }
    let told = crate::transport::questions::ask(
        &ctl.client,
        crate::transport::questions::Ask {
            id: &question_id,
            project_id: run.project_id.as_deref().unwrap_or_default(),
            run_id: args.run_id,
            issue_id: None,
            agent_session_id: run.session_id.as_deref(),
            prompt: args.prompt,
            blocker_kind: blocker.wire(),
            options: args.options,
            recommended_option_id: args.recommended_option_id,
            assumed: None,
            cost: None,
        },
    )
    .await;
    ClaimReply {
        ok: true,
        job_id: None,
        agent_session_id: run.session_id,
        issue_key: Some(question_id),
        // cm:guard a core that could not be told is reported and is NOT a refusal: the park has already happened, the process is already gone, and the run is recoverable by the reconcile sweep. Turning this into a failure would tell the master its run is still live (ISS-964 criterion 10).
        reason: told
            .err()
            .map(|e| format!("parked; core not yet told: {e}")),
    }
}

#[cfg(unix)]
/// Take the job through core and hold it here. Nothing is spawned.
// cm:guard a preparation that arrives and does not start MUST be released. Core clears a hold on `releaseJobFromMaster` or the 3-minute reaper and nothing else, so every early return below either never took the hold or gives it back, and anything that lands in `ctl.prepared` is owed to `reap_preparations`.
async fn prepare(
    ctl: &Arc<Control>,
    job_id: &str,
    session_id: &str,
    agent: Option<&str>,
) -> ClaimReply {
    // cm:guard refuse an unnamed or unusable agent BEFORE the claim, so there is no hold to give back. The name becomes a git branch, and `git worktree add` rejects the bad ones minutes later from inside the spawn — where the failure reads as a broken repo rather than as a master that sent a name with a space in it.
    let agent = match agent.map(str::trim).filter(|s| !s.is_empty()) {
        Some(a) if is_usable_branch_name(a) => a.to_string(),
        Some(a) => return ClaimReply::refused(format!("agent_unusable: {a}")),
        None => return ClaimReply::refused("agent_required"),
    };
    let outcome = match pool::prepare(&ctl.client, job_id, session_id).await {
        Ok(o) => o,
        Err(e) => return ClaimReply::refused(format!("prepare failed: {e}")),
    };
    if !outcome.ok {
        return ClaimReply::refused(outcome.reason.unwrap_or_else(|| "refused".into()));
    }
    let Some(prepared) = outcome.prepared else {
        // cm:guard an `ok:true` with no preparation is a core too old for this runner, and it must be refused LOUDLY with the hold given back. Running the job from the pool entry instead would be the silent substitution the repo forbids: a job started with no prompt, no overrides and no session row.
        let _ = pool::release(&ctl.client, Some(job_id), session_id).await;
        return ClaimReply::refused("core returned no preparation for this claim");
    };

    let agent_session_id = prepared.agent_session_id.clone();
    let issue_key = outcome.issue_key.clone();
    let job = prepared.into_claimed(outcome.issue_key, agent);
    let held_job_id = job.job_id.clone();
    ctl.prepared.put(job, session_id);

    ClaimReply {
        ok: true,
        job_id: Some(held_job_id),
        agent_session_id,
        issue_key,
        reason: None,
    }
}

#[cfg(unix)]
/// Stamp the prepared job onto this box and run it.
// cm:guard the spawn happens only AFTER core stamps, and a refused stamp leaves the preparation gone from this map with the hold given back — never a process running against a job core still calls `queued`. The one ordering that must not be inverted: spawn-then-stamp leaves a live agent whose every event comes back 403, which is the epodsystem wedge with the two halves swapped.
async fn start(ctl: &Arc<Control>, job_id: &str, session_id: &str) -> ClaimReply {
    let Some(job) = ctl.prepared.take(job_id, session_id) else {
        return ClaimReply::refused("not_prepared");
    };
    match pool::start(&ctl.client, job_id, session_id).await {
        Ok(o) if o.ok => {}
        Ok(o) => {
            let _ = pool::release(&ctl.client, Some(job_id), session_id).await;
            return ClaimReply::refused(o.reason.unwrap_or_else(|| "refused".into()));
        }
        Err(e) => {
            let _ = pool::release(&ctl.client, Some(job_id), session_id).await;
            return ClaimReply::refused(format!("start failed: {e}"));
        }
    }

    let agent_session_id = job.agent_session_id.clone();
    let issue_key = job.issue_key.clone();
    let started_job_id = job.job_id.clone();

    let (client, runner, cfg, locks) = (
        ctl.client.clone(),
        ctl.runner.clone(),
        ctl.cfg.clone(),
        ctl.locks.clone(),
    );
    let guard = InflightGuard::enter(&ctl.inflight);
    tokio::spawn(async move {
        let _guard = guard;
        if let Err(e) = dispatch::handle(&client, runner, &cfg, &locks, job).await {
            tracing::error!("[dispatch] {e}");
        }
    });

    ClaimReply {
        ok: true,
        job_id: Some(started_job_id),
        agent_session_id,
        issue_key,
        reason: None,
    }
}

#[cfg(unix)]
/// A master changing its mind: hand the preparation back now.
// cm:guard release even when the map has no entry. A master that retries a discard after a timeout must not be told the job is still held, and `releaseJobFromMaster` is a no-op on a job this session does not hold — so the unconditional call is both safe and the only one that cannot leave a hold behind.
async fn discard(ctl: &Arc<Control>, job_id: &str, session_id: &str) -> ClaimReply {
    ctl.prepared.take(job_id, session_id);
    match pool::release(&ctl.client, Some(job_id), session_id).await {
        Ok(_) => ClaimReply {
            ok: true,
            job_id: Some(job_id.to_string()),
            agent_session_id: None,
            issue_key: None,
            reason: None,
        },
        Err(e) => ClaimReply::refused(format!("release failed: {e}")),
    }
}

#[cfg(unix)]
/// Give work back: one job, or everything this session holds.
async fn release(ctl: &Arc<Control>, job_id: Option<&str>, session_id: &str) -> ClaimReply {
    if let Some(job_id) = job_id {
        ctl.prepared.take(job_id, session_id);
    }
    match pool::release(&ctl.client, job_id, session_id).await {
        Ok(n) => ClaimReply {
            ok: true,
            job_id: job_id.map(str::to_string),
            agent_session_id: None,
            issue_key: None,
            reason: Some(format!("released {n}")),
        },
        Err(e) => ClaimReply::refused(format!("release failed: {e}")),
    }
}

/// Open one run session: ledger, worktree, core, pane — in that order.
// cm:guard the daemon opens the ledger PER CALL rather than holding one. `rusqlite::Connection` is `Send` and not `Sync`, and a shared handle behind a lock would serialise every run open on this box against every other; SQLite's own file locking is what makes concurrent opens correct, and it is the thing designed for it.
// cm:edge ordering -> packages/runner/crates/forge-runner-core/src/runner/run_session.rs — `start` owns the ordering and its refusals; everything here is the two ports and the reply.
async fn run_open(
    ctl: &Arc<Control>,
    project_id: &str,
    issue_keys: &[String],
    agent: &str,
    master_session_id: &str,
    start_point: Option<&str>,
) -> ClaimReply {
    if !is_usable_branch_name(agent) {
        return ClaimReply::refused("agent_name_unusable");
    }
    if issue_keys.is_empty() {
        return ClaimReply::refused("issues_required");
    }
    // cm:guard resolve through the SAME `resolve_repo` the master loop uses, server list first. A run started in the wrong tree reads one repo and writes another, and every diff lands where nobody looks — the silent substitution this repo forbids.
    let served = crate::transport::runners::list_me(&ctl.client)
        .await
        .unwrap_or_default();
    let repo = match crate::daemon::dispatch::resolve_repo(&served, &ctl.cfg, project_id) {
        Ok(r) => r.repo_path,
        Err(slug) => return ClaimReply::refused(format!("no repo path on this box for {slug}")),
    };
    let mut ledger = match crate::runner::ledger::Ledger::default_path()
        .and_then(|p| crate::runner::ledger::Ledger::open(&p))
    {
        Ok(l) => l,
        Err(e) => return ClaimReply::refused(format!("ledger unavailable: {e}")),
    };
    let req = crate::runner::run_session::RunRequest {
        run_id: uuid::Uuid::new_v4().to_string(),
        project_id: project_id.to_string(),
        // cm:guard NOT an `Option` and no `unwrap_or_default` above it: an empty parent here is what left `runs_for_master` and `master_exit::children` matching nothing in production, and it read as a run with no master rather than as an error (ISS-934).
        master_session_id: master_session_id.to_string(),
        // cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/runner/inflight.rs — ONE boot identity for the box. A second source would have the ledger call a run from this boot foreign, or worse call a pre-reboot run current, and recovery then acts on a pid something else now owns.
        boot_id: crate::runner::inflight::boot_identity().unwrap_or_default(),
        issue_keys: issue_keys.to_vec(),
        repo: repo.to_string_lossy().to_string(),
        branch: agent.to_string(),
        start_point: start_point.map(str::to_string),
        argv: crate::daemon::terminal::pane_argv(),
    };
    let spawner = crate::runner::run_ports::TmuxSpawner {
        env: crate::daemon::terminal::pane_env(),
    };
    let core = crate::runner::run_ports::CoreRunSessions {
        client: &ctl.client,
        project_id: project_id.to_string(),
    };
    match crate::runner::run_session::start(&mut ledger, req, &spawner, &core).await {
        Ok(run) => ClaimReply {
            ok: true,
            job_id: None,
            agent_session_id: run.session_id,
            issue_key: Some(issue_keys.join(",")),
            reason: None,
        },
        Err(e) => ClaimReply::refused(e.to_string()),
    }
}

/// Whether a master's agent name can be a git branch and a directory.
// cm:guard this is deliberately NARROWER than git's own rules. A name that is merely legal to git — `HEAD`, a leading dash, a slash, a unicode homoglyph — still has to be a path component under `.worktrees/` and an argument on a command line, and the master is free to pick another word. Widening it to match `git check-ref-format` buys nothing and re-opens every one of those.
fn is_usable_branch_name(name: &str) -> bool {
    !name.starts_with('-')
        && !name.starts_with('.')
        && !name.contains("..")
        && name.len() <= 60
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Ask a running daemon to take one job without starting it.
#[cfg(not(unix))]
pub async fn request_prepare(
    _path: &std::path::Path,
    _job_id: &str,
    _token: &str,
    _agent: &str,
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
pub async fn request_run_open(
    _path: &std::path::Path,
    _token: &str,
    _project_id: &str,
    _issue_keys: &[String],
    _agent: &str,
    _start_point: Option<&str>,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

/// Ask a running daemon to park one of this session's runs on a human.
#[cfg(not(unix))]
pub async fn request_ask(
    _path: &std::path::Path,
    _token: &str,
    _run_id: &str,
    _prompt: &str,
    _blocker_kind: &str,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

/// Ask a running daemon to start a job this session prepared.
#[cfg(not(unix))]
pub async fn request_start(
    _path: &std::path::Path,
    _job_id: &str,
    _token: &str,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

/// Ask a running daemon to hand a preparation back.
#[cfg(not(unix))]
pub async fn request_discard(
    _path: &std::path::Path,
    _job_id: &str,
    _token: &str,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

#[cfg(not(unix))]
fn no_socket() -> std::io::Error {
    std::io::Error::other(
        "the master control socket needs a unix socket; this platform cannot claim work",
    )
}

#[cfg(unix)]
pub async fn request_prepare(
    path: &std::path::Path,
    job_id: &str,
    token: &str,
    agent: &str,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({
            "op": "prepare", "jobId": job_id, "token": token, "agent": agent
        }),
    )
    .await
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

/// Ask a running daemon to open one run session over a group of issues.
#[cfg(unix)]
pub async fn request_run_open(
    path: &std::path::Path,
    token: &str,
    project_id: &str,
    issue_keys: &[String],
    agent: &str,
    start_point: Option<&str>,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({
            "op": "run_open", "token": token, "projectId": project_id, "issueKeys": issue_keys,
            "agent": agent, "startPoint": start_point
        }),
    )
    .await
}

/// Ask a running daemon to park one of this session's runs on a human.
// cm:guard the blocker rides on the frame instead of this being two verbs, so the daemon refuses a bounded kind by the one rule that owns it (`blocked::park_for_human`) rather than the CLI deciding which arm exists. A `--machine` flag here would be a second copy of that rule, on the side that ships separately (ISS-964 criteria 4, 5).
#[cfg(unix)]
pub async fn request_ask(
    path: &std::path::Path,
    token: &str,
    run_id: &str,
    prompt: &str,
    blocker_kind: &str,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({
            "op": "ask", "token": token, "runId": run_id,
            "prompt": prompt, "blockerKind": blocker_kind
        }),
    )
    .await
}

/// Tell a running daemon a decision was taken rather than asked about.
// cm:guard the id is minted by the CALLER and the write is `INSERT OR IGNORE`, so a frame the master retries after a socket error counts once. A daemon-minted id would make every retry a second decision and inflate the denominator in the direction that flatters the master (ISS-964 criterion 2).
#[cfg(unix)]
pub async fn request_decide(
    path: &std::path::Path,
    token: &str,
    decision_id: &str,
    verb: &str,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({
            "op": "decide", "token": token, "decisionId": decision_id, "verb": verb
        }),
    )
    .await
}

#[cfg(not(unix))]
pub async fn request_decide(
    _path: &std::path::Path,
    _token: &str,
    _decision_id: &str,
    _verb: &str,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

/// Ask a running daemon to hand work back.
#[cfg(unix)]
pub async fn request_release(
    path: &std::path::Path,
    job_id: Option<&str>,
    token: &str,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({ "op": "release", "jobId": job_id, "token": token }),
    )
    .await
}

#[cfg(not(unix))]
pub async fn request_release(
    _path: &std::path::Path,
    _job_id: Option<&str>,
    _token: &str,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

#[cfg(unix)]
pub async fn request_start(
    path: &std::path::Path,
    job_id: &str,
    token: &str,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({ "op": "start", "jobId": job_id, "token": token }),
    )
    .await
}

#[cfg(unix)]
pub async fn request_discard(
    path: &std::path::Path,
    job_id: &str,
    token: &str,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({ "op": "discard", "jobId": job_id, "token": token }),
    )
    .await
}

#[cfg(unix)]
async fn ask(path: &std::path::Path, body: serde_json::Value) -> std::io::Result<ClaimReply> {
    let stream = UnixStream::connect(path).await?;
    let mut reader = BufReader::new(stream);
    let mut line = serde_json::to_string(&body).unwrap_or_default();
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
    fn a_prepare_request_parses_in_the_shape_the_cli_sends() {
        let raw = r#"{"op":"prepare","jobId":"j1","token":"t1","agent":"catalog-sweep"}"#;
        match serde_json::from_str::<Request>(raw).expect("must parse") {
            Request::Prepare {
                job_id,
                token,
                agent,
            } => {
                assert_eq!(agent.as_deref(), Some("catalog-sweep"));
                assert_eq!(job_id, "j1");
                assert_eq!(token, "t1");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    // cm:guard the two ops must stay SEPARATE on the wire, which is the whole of B2. A `start` that carried an agent name would be a claim wearing two words, and the master could no longer take a job, look at it and hand it back.
    #[test]
    fn start_and_discard_name_a_job_this_session_already_holds() {
        match serde_json::from_str::<Request>(r#"{"op":"start","jobId":"j1","token":"t1"}"#)
            .expect("must parse")
        {
            Request::Start { job_id, token } => {
                assert_eq!((job_id.as_str(), token.as_str()), ("j1", "t1"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
        match serde_json::from_str::<Request>(r#"{"op":"discard","jobId":"j1","token":"t1"}"#)
            .expect("must parse")
        {
            Request::Discard { job_id, .. } => assert_eq!(job_id, "j1"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    // cm:guard the daemon must release what it holds BEFORE core's three-minute reaper does, or the reaper hands the job to somebody else while this map still believes it owns it — and the next `start` stamps a job that is already running one box over.
    #[test]
    fn the_daemon_gives_a_preparation_back_before_cores_reaper_would() {
        assert!(
            PREPARE_TTL < std::time::Duration::from_secs(180),
            "PREPARE_TTL must stay under core's MASTER_HOLD_TIMEOUT_MS"
        );
    }

    // cm:guard a refusal must serialise WITHOUT the success fields rather than with nulls — the master reads this JSON, and a `jobId: null` beside `ok: false` reads as a job that exists and failed rather than a claim that never landed.
    #[test]
    fn a_refusal_carries_a_reason_and_no_job() {
        let out = serde_json::to_string(&ClaimReply::refused("issue_busy")).unwrap();
        assert!(out.contains("\"reason\":\"issue_busy\""));
        assert!(!out.contains("jobId"));
        assert!(out.contains("\"ok\":false"));
    }

    /// A claim with no agent name must be REFUSED, not silently run in the
    /// repo root — that was the shape core's `worktreeBranch` payload used to
    /// prevent, and nothing replaces it but this.
    #[test]
    fn a_claim_with_no_agent_name_still_parses_so_it_can_be_refused_by_name() {
        let raw = r#"{"op":"prepare","jobId":"j1","token":"t1"}"#;
        match serde_json::from_str::<Request>(raw).expect("must parse") {
            Request::Prepare { agent, .. } => assert!(agent.is_none()),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn a_name_that_would_break_git_or_the_path_is_not_usable() {
        for good in ["catalog-sweep", "ISS-175", "epod_billing.v2"] {
            assert!(is_usable_branch_name(good), "{good} should be usable");
        }
        for bad in [
            "-force",
            ".hidden",
            "a..b",
            "has space",
            "a/b",
            "héllo",
            "HEAD~1",
        ] {
            assert!(!is_usable_branch_name(bad), "{bad} must be refused");
        }
        assert!(!is_usable_branch_name(&"x".repeat(61)));
    }

    // cm:guard the frame is decoded from a LITERAL string here rather than built from `Request`, because the whole claim is about a field the struct no longer has: a planted `sessionId` must reach serde and be dropped, and a round-trip through the Rust type could not plant it (ISS-964 criterion 30).
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
            panic!("decoded as {req:?}");
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
            panic!("decoded as {req:?}");
        };
        assert!(at_ms.is_none(), "the daemon stamps it instead");
    }

    #[test]
    fn a_frame_naming_another_session_is_served_as_the_token_owner() {
        let dir = std::env::temp_dir().join(format!("ct-{}", uuid::Uuid::new_v4()));
        let tokens = SessionTokens::at(dir.join("control-tokens.json"));
        let a = tokens.mint("sess-a").unwrap();
        tokens.mint("sess-b").unwrap();

        let frame = format!(
            r#"{{"op":"prepare","jobId":"j1","token":"{a}","sessionId":"sess-b","agent":"work"}}"#
        );
        let req: Request = serde_json::from_str(&frame).expect("frame must decode");
        let Request::Prepare { token, .. } = &req else {
            panic!("wrong variant");
        };
        assert_eq!(
            tokens.session_for(token),
            Some("sess-a".to_string()),
            "a master that can name another master's session can park it, read its question and revive it — one box runs one master per project, so a declared id reaches ACROSS projects (ISS-964 criterion 30)"
        );
    }

    #[test]
    fn a_frame_carrying_no_known_token_names_nobody() {
        let dir = std::env::temp_dir().join(format!("ct-{}", uuid::Uuid::new_v4()));
        let tokens = SessionTokens::at(dir.join("control-tokens.json"));
        tokens.mint("sess-a").unwrap();
        assert_eq!(tokens.session_for("forged"), None);
    }

    fn parked_run(master: &str) -> crate::runner::ledger::Run {
        crate::runner::ledger::Run {
            run_id: "run-1".into(),
            project_id: Some("p-1".into()),
            master_session_id: master.into(),
            session_id: None,
            worktree_path: std::path::PathBuf::from("/tmp/wt"),
            pid: Some(4242),
            boot_id: "boot-a".into(),
            incarnation: crate::runner::ledger::Incarnation::Live,
            work: crate::runner::ledger::Work::Runnable,
            blocker_kind: None,
            waiting_on: None,
            resume_id: None,
            session_terminal_at: None,
            worktree_gone_at: None,
            claim_owner: None,
            claim_generation: 0,
            claim_expires_at: None,
            revival_token: None,
            revival_deadline_at: None,
            ended_by: None,
            ended_reason: None,
        }
    }

    #[test]
    fn a_park_names_the_run_it_cannot_find() {
        assert_eq!(
            plan_park(None, "master-1", "human"),
            Err("unknown_run".into())
        );
    }

    // cm:guard the authorisation claim of this verb: the asker is the session the TOKEN resolved to, and a master may park only a run whose parent it IS. Without it one master parks another's run — the same hole a declared `session_id` was (ISS-964 criterion 30).
    #[test]
    fn a_master_cannot_park_another_masters_run() {
        let run = parked_run("master-2");
        assert_eq!(
            plan_park(Some(&run), "master-1", "human"),
            Err("not_your_run".into()),
            "a run's parent is the only session that may park it"
        );
    }

    #[test]
    fn a_master_parks_its_own_run() {
        let run = parked_run("master-1");
        assert_eq!(
            plan_park(Some(&run), "master-1", "human"),
            Ok(crate::runner::ledger::BlockerKind::Human)
        );
    }

    // cm:guard a non-human blocker is NOT refused here, and that is deliberate: `blocked::park_for_human` owns that rule and names the arm to use instead, so judging it here would be a second copy of it — and the copy that drifts is the one no test reads (ISS-964 criteria 4, 5).
    #[test]
    fn the_bounded_blockers_are_left_for_the_arm_that_owns_the_rule() {
        let run = parked_run("master-1");
        assert_eq!(
            plan_park(Some(&run), "master-1", "machine"),
            Ok(crate::runner::ledger::BlockerKind::Machine)
        );
        assert_eq!(
            plan_park(Some(&run), "master-1", "sideways"),
            Err("blocker_kind_unknown".into())
        );
    }

    #[test]
    fn an_ended_run_is_not_parkable() {
        let mut run = parked_run("master-1");
        run.ended_by = Some("reaper".into());
        assert_eq!(
            plan_park(Some(&run), "master-1", "human"),
            Err("run_ended".into()),
            "a park is a promise to resume, and there is nothing left to resume"
        );
    }

    /// This file's own text, with one line ending.
    // cm:guard normalise BEFORE any structural split: a windows checkout hands `include_str!` CRLF, so `"\n}\n"` never matches, `split(..).next()` silently returns the whole rest of the file, and a scan then counts something else entirely while still compiling — three of these went red on the windows leg of ci.yml's `runner` matrix and none of them could on linux (2026-09-09).
    fn source() -> String {
        include_str!("control.rs").replace("\r\n", "\n")
    }

    // cm:guard scans the source because the claim is an ORDER between three side effects, and every ordering compiles: the permit is asked for BEFORE the ledger is written, the park is written BEFORE the process is killed, and core is told last. Killing first leaves the run reading `live` behind a dead pid — the exact state the four columns exist to make impossible (ISS-964 criteria 7, 27).
    #[test]
    fn the_park_is_written_before_the_process_is_killed() {
        let src = source();
        let body = src
            .split("async fn park(")
            .nth(1)
            .and_then(|s| s.split("\n}\n").next())
            .expect("the park handler must be findable");
        let permit = body.find("from_advertisement").expect("permit asked for");
        let park = body.find("park_for_human").expect("park written");
        let kill = body.find("kill_group").expect("process killed");
        assert!(
            permit < park && park < kill,
            "order must be permit -> park -> kill; found permit@{permit} park@{park} kill@{kill}"
        );
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
    #[test]
    fn a_decision_with_no_verb_is_refused_rather_than_counted() {
        let reply = decide("dec-1", "   ", "master-1");
        assert!(!reply.ok);
        assert_eq!(
            reply.reason.as_deref(),
            Some("verb_required"),
            "a blank row still increments the denominator, which is how a ratio is gamed without anybody lying (ISS-964 criterion 2)"
        );
    }

    // cm:guard scans the source because the claim is about which STRING is written, and both compile: the session comes from the token the daemon resolved, never from the frame. A `decision_id` a caller mints is fine — it is the dedupe key — but a session a caller names would let one master pad another's denominator (ISS-964 criteria 2, 30).
    #[test]
    fn a_decision_is_recorded_under_the_session_the_token_named() {
        let src = source();
        let body = src
            .split("fn decide(")
            .nth(1)
            .and_then(|s| s.split("\n}\n").next())
            .expect("the decide handler must be findable");
        assert!(
            body.contains("record_decision(decision_id, session_id, verb)"),
            "the recorded session must be the resolved one: {body}"
        );
    }
}
