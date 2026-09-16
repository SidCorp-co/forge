//! What starts work now that nothing pushes it, and what ends it.
//!
//! Core wakes this box and keeps jobs `queued`; this loop is the only thing on
//! the box that notices. It asks core which projects this device serves, reads
//! each pool, and keeps one RESIDENT master per project — a Claude session
//! running the `forge-master` skill, which decides order and batch size and
//! claims through the control socket.
//!
//! Resident, and parented by tmux rather than by this daemon (ISS-919): an
//! attachable pane, a master that survives a `forge-runner` restart.
//!
//! Nothing here supervises that master any more (ISS-933). A pane's byte count
//! cannot tell a master idle on purpose from one that has stopped, so the
//! silence ceiling, the quiet gate, the transcript reads and the crashloop
//! breaker are gone — leaving one detector, the pane exists or it does not,
//! and one exit the master earns for itself out of the ledger.
//!
//! The daemon deliberately makes NO routing decision. It answers one question
//! per project, "is there anything at all", and hands the rest to judgement.
//!

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::daemon::agent_activity;
use crate::daemon::checkpoint;
use crate::daemon::dispatch::resolve_repo;
use crate::daemon::held_report;
use crate::daemon::master_exit::{self, Verdict};
use crate::daemon::master_limit;
use crate::daemon::recovery;
use crate::daemon::recovery_ports::{CoreBeat, CoreRunState, PaneMasters, SignalProbe};
use crate::daemon::run_exit;
use crate::daemon::run_record;
use crate::daemon::session_tokens;
use crate::daemon::terminal;
use crate::runner::close_loop;
use crate::runner::ledger::{Ledger, Run};
use crate::runner::terminate;
use crate::transport::admissible::{self, AdmissibleIssue};
use crate::transport::{master as master_api, mcp_servers, runners, CoreClient};
use tokio::sync::mpsc;

/// How often the box asks whether any work exists.
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// The closest together two wake-driven sweeps may run.
const WAKE_FLOOR: Duration = Duration::from_secs(5);

/// The longest a master may go un-nudged while the work in front of it is unchanged.
pub(crate) const NUDGE_REFRESH: Duration = Duration::from_secs(5 * 60);

/// Sweep spacing once every project this box serves is rate-limited.
pub(crate) const LIMITED_POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// The first thing a resident master is told, once, when its session starts.
fn standing_prompt(
    project: &str,
    base_branch: Option<&str>,
    master_policy: Option<&str>,
    dropped: &[String],
    servers_unreadable: bool,
) -> String {
    let mut out = format!(
        "Use the `forge-master` skill. You are the resident master for project `{project}` on \
this box. You will be woken repeatedly, in this same session: each waking is one wave — hand it to \
the `forge:dispatch` skill, and end the pass by saying what you dispatched and what you did not.\n"
    );
    if let Some(base) = base_branch {
        out.push_str(&format!(
            "\nYou are standing in this project's checkout, on its base branch `{base}`. Every \
run you dispatch works in a worktree of its own cut from `origin/{base}`, never in this tree.\n"
        ));
    }
    out.push_str(
        "\nA run is a subagent dispatched through a shipped role — `runner`, `reviewer`, `qa`, \
`triage`, `evaluator` — and the role decides its model, its effort and its tools. `forge doctor` \
prints which roles the loaded copy ships. There is no job pool and no second terminal: the lease \
`forge claim` takes on the issue is the whole record of a run.\n",
    );
    out.push_str(
        "\nBetween passes you stay open. Keep what you concluded — what you grouped, what you \
deliberately did not dispatch and why — where the next pass can read it, and say it out loud rather \
than only thinking it: this pane is the record.\n",
    );
    if servers_unreadable {
        out.push_str(
            "\nThis box could NOT read this project's declared MCP servers from core, so this \
pane carries none of them whatever the project declares. Treat the tool inventory you can see as \
incomplete: an issue whose work needs a project MCP server cannot be judged buildable here until a \
master starts on a pane that could read them.\n",
        );
    }
    if !dropped.is_empty() {
        out.push_str(&format!(
            "\nThis project declares MCP server(s) this box could NOT supply: {}. Runs you \
dispatch will not have their tools. An issue whose work needs one of them cannot be built here — \
say so on the issue rather than parking it as a run that failed.\n",
            dropped.join(", ")
        ));
    }
    if let Some(policy) = master_policy {
        out.push_str(
            "\n## The project owner's standing policy\n\nThis is the owner's own instruction for \
this project, and it OUTRANKS the `forge-master` skill wherever the two differ — the skill holds \
the defaults for a project that has set none. It is set as this project's `master-policy` fact and \
is re-sent to every master this box starts, so it survives this session.\n\n",
        );
        out.push_str(policy);
        out.push('\n');
    }
    out
}

/// What this box knows about each project's resident master.
#[derive(Default)]
pub struct Masters(Arc<Mutex<Registry>>);

/// The live masters, and what this box has seen the dead ones do.
#[derive(Default)]
struct Registry {
    live: HashMap<String, MasterState>,
}

struct MasterState {
    session_id: String,
    name: String,
    /// When this project's pool last held anything at all.
    last_work: Instant,
    /// The work this master was last nudged about, and when.
    last_nudge: Option<(u64, Instant)>,
    /// Whether this process has already said that the live pane's MCP
    /// configuration is behind what core resolves.
    mcp_stale_reported: bool,
}

/// What the master is being asked to look at, as one comparable value.
///
/// Identity only — an issue id, never a title, a priority or a status. Those
/// change while the decision does not, and a digest that moves on them
/// re-nudges for nothing.
fn work_digest(admissible: &[AdmissibleIssue]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut ids: Vec<String> = Vec::with_capacity(admissible.len());
    ids.extend(admissible.iter().map(|a| format!("issue:{}", a.issue_id)));
    ids.sort_unstable();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for id in ids {
        id.hash(&mut h);
    }
    h.finish()
}

/// Whether the master should hear about this pool now.
fn nudge_due(prev: Option<(u64, Instant)>, digest: u64, now: Instant) -> bool {
    match prev {
        None => true,
        Some((seen, at)) => seen != digest || now.saturating_duration_since(at) >= NUDGE_REFRESH,
    }
}

impl Masters {
    pub fn new() -> Self {
        Self::default()
    }

    /// The session id and pane of the master this box has up for a project.
    pub fn live_for_project(&self, project_id: &str) -> Option<(String, String)> {
        self.get(project_id)
    }

    fn get(&self, project_id: &str) -> Option<(String, String)> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .get(project_id)
            .map(|m| (m.session_id.clone(), m.name.clone()))
    }

    fn remember(&self, project_id: &str, state: MasterState) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.live.insert(project_id.to_string(), state);
    }

    /// This project's pool held something; the idle clock restarts.
    fn note_work(&self, project_id: &str) {
        let mut reg = self.0.lock().expect("masters poisoned");
        if let Some(m) = reg.live.get_mut(project_id) {
            m.last_work = Instant::now();
        }
    }

    /// True the first time a project's live pane is found behind its config,
    /// and false every sweep after, until the pane matches again.
    fn claim_mcp_stale(&self, project_id: &str) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let Some(m) = reg.live.get_mut(project_id) else {
            // Not in this process's registry — a pane it did not start, and one
            // it has therefore never reported. Say it.
            return true;
        };
        if m.mcp_stale_reported {
            return false;
        }
        m.mcp_stale_reported = true;
        true
    }

    /// The pane matches again; the next mismatch is worth saying.
    fn clear_mcp_stale(&self, project_id: &str) {
        let mut reg = self.0.lock().expect("masters poisoned");
        if let Some(m) = reg.live.get_mut(project_id) {
            m.mcp_stale_reported = false;
        }
    }

    /// Decide whether to nudge this project now, and record having done so.
    ///
    /// One call, because a check that did not record would nudge on every
    /// sweep exactly as before.
    fn claim_nudge(&self, project_id: &str, digest: u64) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let Some(m) = reg.live.get_mut(project_id) else {
            return false;
        };
        let now = Instant::now();
        if !nudge_due(m.last_nudge, digest, now) {
            return false;
        }
        m.last_nudge = Some((digest, now));
        true
    }

    /// How long this project has had nothing, or `None` if it has no master.
    fn idle_for(&self, project_id: &str) -> Option<Duration> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live.get(project_id).map(|m| m.last_work.elapsed())
    }

    fn forget(&self, project_id: &str) -> Option<String> {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.live.remove(project_id).map(|m| m.session_id)
    }

    /// Which project's master a session id is, for a declaration this box is
    /// about to bound.
    pub fn project_for_session(&self, session_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .iter()
            .find(|(_, m)| m.session_id == session_id)
            .map(|(project_id, _)| project_id.clone())
    }

    /// The pane name for a master session id, for the inbox's terminal arm.
    pub fn pane_for_session(&self, session_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .values()
            .find(|m| m.session_id == session_id)
            .map(|m| m.name.clone())
    }
}

/// Why a sweep is happening now, when it is not the timer.
#[derive(Debug, Clone)]
pub enum Wake {
    /// Core published `master.wake` on this box's device room (ISS-933).
    Core { project_id: Option<String> },
    /// This box's websocket came back up, so anything published while it was
    /// down is gone — `rooms.ts:publish` has no buffer and no replay.
    Reconnect,
}

impl Wake {
    fn describe(&self) -> String {
        match self {
            Wake::Core {
                project_id: Some(p),
            } => format!("core, project {p}"),
            Wake::Core { project_id: None } => "core".into(),
            Wake::Reconnect => "websocket reconnected — catch-up read".into(),
        }
    }
}

/// A sender for [`Wake`], sized so a burst coalesces instead of queueing.
pub fn wake_channel() -> (mpsc::Sender<Wake>, mpsc::Receiver<Wake>) {
    mpsc::channel(1)
}

/// Keep every served project's master alive, on the timer OR on a wake.
///
/// The timer is the floor and the wake is the latency cut. Both call the same
/// `sweep`; there is no second path and no second dispatcher.
pub async fn run(
    client: CoreClient,
    cfg: Config,
    masters: Arc<Masters>,
    activity: Arc<agent_activity::Activities>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    mut wake: mpsc::Receiver<Wake>,
) {
    let mut delay = POLL_INTERVAL;
    let mut last_sweep = Instant::now();
    let mut account_limit_said: Option<String> = None;
    let mut ledger = match Ledger::default_path().and_then(|p| Ledger::open(&p)) {
        Ok(l) => Some(l),
        Err(e) => {
            tracing::error!("[master] ledger unavailable ({e}) — no master will retire itself");
            None
        }
    };
    loop {
        tokio::select! {
            _ = tokio::time::sleep(delay) => {
                delay = sweep(&client, &cfg, &masters, &activity, &mut ledger, &mut account_limit_said)
                    .await;
                last_sweep = Instant::now();
            }
            Some(w) = wake.recv() => {
                let since = last_sweep.elapsed();
                if since < WAKE_FLOOR {
                    tokio::time::sleep(WAKE_FLOOR - since).await;
                }
                tracing::info!("[master] wake ({}) — sweeping now", w.describe());
                delay = sweep(&client, &cfg, &masters, &activity, &mut ledger, &mut account_limit_said)
                    .await;
                last_sweep = Instant::now();
            }
            _ = cancel.changed() => { if *cancel.borrow() { break; } }
        }
    }
}

/// Whether a project's runner row on this box still wants new work.
///
/// The drain an operator reaches for when moving a project onto another box:
/// set the runner `draining` (or `disabled`), and this box stops STARTING work
/// while everything already running finishes untouched.
fn accepts_new_work(status: &str) -> bool {
    !matches!(status, "draining" | "disabled")
}

/// How long to wait before the next sweep, given what core just reported.
///
/// Fast by default; stretched only when EVERY project that would take work is
/// rate-limited, so one limited project never slows down a healthy one.
fn next_poll_delay(served: &[runners::MeRunner]) -> Duration {
    let mut soonest: Option<u64> = None;
    for r in served.iter().filter(|r| accepts_new_work(&r.status)) {
        match r.rate_limited_for_seconds {
            Some(secs) if secs > 0 => {
                soonest = Some(soonest.map_or(secs, |s: u64| s.min(secs)));
            }
            _ => return POLL_INTERVAL,
        }
    }
    match soonest {
        None => POLL_INTERVAL,
        Some(secs) => Duration::from_secs(secs).clamp(POLL_INTERVAL, LIMITED_POLL_INTERVAL),
    }
}

/// One look at every project this device serves.
async fn sweep(
    client: &CoreClient,
    cfg: &Config,
    masters: &Arc<Masters>,
    activity: &agent_activity::Activities,
    ledger: &mut Option<Ledger>,
    account_limit_said: &mut Option<String>,
) -> Duration {
    let now_unix = master_limit::now_unix();
    let mut account_said: Vec<master_limit::Decisive> = Vec::new();
    let served = match runners::list_me(client).await {
        Ok(rs) => rs,
        Err(e) => {
            tracing::warn!("[master] cannot read this box's projects: {e}");
            return POLL_INTERVAL;
        }
    };
    match crate::mcp::config::sweep_orphaned_sessions(
        &served.iter().map(|r| r.slug.clone()).collect::<Vec<_>>(),
    ) {
        Ok(left) => {
            for (path, why) in left {
                tracing::error!(
                    "[master] {} belongs to a project this box no longer serves and could not be removed: {why} — it holds that project's rendered integration credentials",
                    path.display()
                );
            }
        }
        Err(e) => tracing::error!(
            "[master] could not read {} to check for the configs of projects this box no longer serves: {e} — rendered integration credentials may be sitting there and this pass did not look",
            crate::mcp::config::session_dir().display()
        ),
    }
    let delay = next_poll_delay(&served);
    if delay > POLL_INTERVAL {
        for r in served.iter().filter(|r| accepts_new_work(&r.status)) {
            tracing::info!(
                "[master] {}: rate-limited ({}) — still sweeping, next pass in {}s",
                r.slug,
                r.limit_reason.as_deref().unwrap_or("unknown"),
                delay.as_secs()
            );
        }
    }

    for runner in &served {
        if !accepts_new_work(&runner.status) {
            tracing::info!(
                "[master] {}: runner is {} — taking no new work; anything already running finishes",
                runner.slug,
                runner.status
            );
            supervise(client, masters, &runner.project_id, &runner.slug).await;
            continue;
        }
        supervise(client, masters, &runner.project_id, &runner.slug).await;

        let admissible = admissible::admissible(client, Some(&runner.project_id))
            .await
            .unwrap_or_default();
        if admissible.is_empty() {
            if retire_if_idle(client, masters, ledger, &runner.project_id, &runner.slug).await
                || masters.get(&runner.project_id).is_none()
            {
                continue;
            }
        } else {
            masters.note_work(&runner.project_id);
        }

        let resolved = match resolve_repo(&served, cfg, &runner.project_id) {
            Ok(r) => r,
            Err(slug) => {
                tracing::error!(
                    "[master] {slug} has claimable work but no repo path on this box — no master will run for it; bind it or set the runner's repo_path"
                );
                continue;
            }
        };

        let stored_conversation = ledger
            .as_ref()
            .and_then(|led| led.master_for_project(&runner.project_id).ok().flatten())
            .and_then(|row| row.conversation_id);
        let inherited: Vec<InheritedRun> = masters
            .get(&runner.project_id)
            .map(|(sid, _)| sid)
            .and_then(|sid| {
                ledger
                    .as_ref()
                    .map(|led| inherited_runs(led, &sid, &runner.project_id))
            })
            .unwrap_or_default();
        let pane = ensure_master(
            client,
            masters,
            &runner.project_id,
            &resolved,
            stored_conversation.as_deref(),
            &inherited,
        )
        .await;
        if pane == PaneState::Absent {
            continue;
        }
        if let Some(said) = account_verdict(
            &resolved.repo_path,
            stored_conversation.as_deref(),
            now_unix,
        ) {
            account_said.push(said);
        }
        if pane == PaneState::Resumed {
            let pane_boot = crate::runner::inflight::boot_identity().unwrap_or_default();
            if let (Some(led), Some((session_id, _))) =
                (ledger.as_mut(), masters.get(&runner.project_id))
            {
                match led.owe_resume_choices(&session_id, &pane_boot) {
                    Ok(0) => {}
                    Ok(n) => tracing::info!(
                        "[master] {}: resumed holding {n} run(s) — it must say what happens to each before declaring new work",
                        resolved.slug
                    ),
                    Err(e) => tracing::warn!(
                        "[master] {}: cannot mark the runs this pane inherited: {e}",
                        resolved.slug
                    ),
                }
            }
        }

        if admissible.is_empty() {
            continue;
        }

        if masters.claim_nudge(&runner.project_id, work_digest(&admissible)) {
            nudge_master(masters, &runner.project_id, &resolved.slug).await;
        }
    }

    report_account_limit(client, &served, &account_said, account_limit_said, now_unix).await;

    let boot = crate::runner::inflight::boot_identity().unwrap_or_default();
    let sessions = run_record::CoreSessions(client);
    let opened = run_record::open_declared_runs(&sessions, ledger, &boot).await;
    let closed = run_record::close_ended_runs(&sessions, ledger, &boot).await;
    let choices_said = say_resume_choices(&CoreChoice(client), ledger, &boot).await;
    if choices_said > 0 {
        tracing::info!("[master] {choices_said} resume choice(s) said on their issues");
    }
    let held_said =
        held_report::report_held_worktrees(&held_report::CoreHeld(client), ledger, &boot).await;
    if held_said > 0 {
        tracing::info!("[master] {held_said} held checkout(s) reported onto their issues");
    }
    if opened > 0 || closed > 0 {
        tracing::info!("[run-record] {opened} run(s) opened at core, {closed} closed");
    }

    give_back_lost_runs(
        boot.as_str(),
        &PaneMasters { masters },
        &Reclaim {
            served: &served,
            cfg,
            procs: &SignalProbe,
            killer: &terminate::SystemProcesses,
            closer: &CoreRunState { client },
        },
        &CoreRunState { client },
        &CoreRunState { client },
        recovery::RunWatch {
            beat: &CoreBeat { client },
            idle: &PaneActivity { activity },
        },
        ledger,
    )
    .await;
    delay
}

/// What this project's master's own conversation says about the account now.
///
/// `None` where the box has no conversation recorded for the pane yet, which is
/// every sweep between a cold start and that pane's first hook event.
fn account_verdict(
    repo: &std::path::Path,
    conversation: Option<&str>,
    now_unix: i64,
) -> Option<master_limit::Decisive> {
    let id = conversation.filter(|c| !c.is_empty())?;
    let path = conversation_transcript(repo, id)?;
    let tail = master_limit::read_tail(&path)?;
    master_limit::newest_decisive(&tail, now_unix)
}

/// Longest either half of a limit report may hold the sweep.
///
/// Derived rather than chosen: it has to be comfortably under [`POLL_INTERVAL`],
/// because a report that outlasts the sweep spacing has stopped being a report
/// and started being the thing that decides how often this box sweeps at all.
const REPORT_TIMEOUT: Duration = Duration::from_secs(10);

/// One limit call, with the deadline the client itself does not impose.
async fn bounded<F>(call: F) -> crate::error::Result<()>
where
    F: std::future::Future<Output = crate::error::Result<()>>,
{
    match tokio::time::timeout(REPORT_TIMEOUT, call).await {
        Ok(result) => result,
        Err(_) => Err(crate::error::Error::Other(format!(
            "core did not answer within {}s",
            REPORT_TIMEOUT.as_secs()
        ))),
    }
}

/// Tell core what this box's Claude account said, once for the whole device.
async fn report_account_limit(
    client: &CoreClient,
    served: &[runners::MeRunner],
    said: &[master_limit::Decisive],
    memo: &mut Option<String>,
    now_unix: i64,
) {
    let core_limited = served.iter().any(|r| r.limit_reason.is_some());
    match master_limit::decide(said, core_limited, memo.as_deref(), now_unix) {
        master_limit::Action::Nothing => {}
        master_limit::Action::Unreadable(slug) => tracing::warn!(
            "[master] this box's Claude account refused a turn with `{slug}`, which this binary has not been taught to read — nothing was reported, so core will go on calling this box healthy until it is taught that name"
        ),
        master_limit::Action::Report(r, uuid) => {
            let sent = bounded(master_api::report_limit(
                client,
                r.reason.wire(),
                r.resets_in_seconds,
                &r.detail,
            ))
            .await;
            match sent {
                Ok(()) => {
                    tracing::warn!(
                        "[master] this box's Claude account is capped ({}{}) — reported to core: {}",
                        r.reason.wire(),
                        match r.resets_in_seconds {
                            Some(secs) => format!(", {secs}s to go"),
                            None => String::new(),
                        },
                        r.detail
                    );
                    *memo = Some(uuid);
                }
                Err(e) => tracing::warn!(
                    "[master] could not tell core this box's account is capped: {e} — sending it again next sweep"
                ),
            }
        }
        master_limit::Action::Clear => match bounded(master_api::clear_limit(client)).await {
            Ok(()) => {
                tracing::info!(
                    "[master] this box's Claude account answered a turn — the limit core was holding is lifted"
                );
                *memo = None;
            }
            Err(e) => tracing::warn!(
                "[master] could not lift this box's account limit at core: {e} — trying again next sweep"
            ),
        },
    }
}

/// What a sweep needs to take a run back: who this box serves (so a project's
/// repo can be resolved), and the two separate process questions.
struct Reclaim<'a> {
    served: &'a [runners::MeRunner],
    cfg: &'a Config,
    procs: &'a dyn recovery::ProcessLiveness,
    killer: &'a dyn terminate::ProcessGroup,
    closer: &'a dyn close_loop::RunCloser,
}

/// Give back the worktree a dead run still holds, so its close loop can finish.
async fn release_held_tree(
    led: &mut Ledger,
    r: &recovery::Recovered,
    boot_id: &str,
    world: &Reclaim<'_>,
    sessions: &dyn close_loop::SessionReader,
    leases: &dyn close_loop::LeaseKeeper,
) -> bool {
    let Some(project) = r.project_id.as_deref() else {
        tracing::warn!(
            "[master] run {} is owed its worktree back but names no project, so no repo can be resolved for it",
            r.run_id
        );
        return false;
    };
    let resolved = match resolve_repo(world.served, world.cfg, project) {
        Ok(v) => v,
        Err(slug) => {
            tracing::warn!(
                "[master] run {} holds a worktree but {slug} has no repo path on this box — bind it or set the runner's repo_path; the tree stays until it does",
                r.run_id
            );
            return false;
        }
    };
    match terminate::force_terminal(
        led,
        &r.run_id,
        terminate::Forcing {
            this_boot: boot_id,
            repo_root: &resolved.repo_path,
            base_branch: resolved.base_branch.as_deref(),
            by: "recovery",
            reason: "the run's process is gone and core's session row is terminal",
        },
        terminate::Ports {
            procs: world.killer,
            sessions,
            leases,
        },
    )
    .await
    {
        Ok(forced) => {
            tracing::info!(
                "[master] run {} reclaimed by {:?}: diff {:?}, close {:?}",
                r.run_id,
                forced.verb,
                forced.salvage.as_ref().map(|s| s.outcome),
                forced.close
            );
            forced.close.is_closed()
        }
        Err(e) => {
            tracing::warn!("[master] run {} could not be released: {e}", r.run_id);
            false
        }
    }
}

/// Tell core a run's process is gone, so its session stops being guessed at.
async fn report_run_death(run: Option<Run>, r: &recovery::Recovered, world: &Reclaim<'_>) {
    let Some(session_id) = r.session_id.as_deref() else {
        return;
    };
    let checkpoint = match run {
        Some(run) => Some(checkpoint::reconstruct_within_budget(&run).await.to_json()),
        None => None,
    };
    if let Err(e) = world
        .closer
        .close(
            session_id,
            close_loop::Outcome::Died,
            "the run's process is gone from this box",
            checkpoint,
        )
        .await
    {
        tracing::warn!(
            "[master] run {} is gone but core was not told ({e}) — its session falls to the ten-minute sweep",
            r.run_id
        );
    }
}

/// The box's own activity map, read as the run-liveness port.
struct PaneActivity<'a> {
    activity: &'a agent_activity::Activities,
}

#[async_trait::async_trait]
impl recovery::RunActivity for PaneActivity<'_> {
    async fn reported(&self, session_id: &str) -> Option<run_exit::Reported> {
        let a = self.activity.get(session_id)?;
        Some(run_exit::Reported {
            doing: a.doing(),
            at: a.last_event_at,
        })
    }
}

/// End a run that reported itself finished, so its close loop can start.
async fn end_idle_run(led: &mut Ledger, run_id: &str, world: &Reclaim<'_>) {
    let Ok(Some(run)) = led.run(run_id) else {
        return;
    };
    let Some(pid) = run.pid else {
        return;
    };
    world.killer.kill(pid).await;
    tracing::info!(
        "[master] run {run_id} reported idle for over {}m and its work is done — ending pid {pid}; its close loop starts on the next sweep",
        run_exit::RUN_IDLE_BEFORE_EXIT.as_secs() / 60
    );
    let Some(session_id) = run.session_id.as_deref() else {
        return;
    };
    if let Err(e) = world
        .closer
        .close(
            session_id,
            close_loop::Outcome::KilledIdle,
            "idle past the run's exit boundary; the box ended it",
            Some(checkpoint::reconstruct_within_budget(&run).await.to_json()),
        )
        .await
    {
        tracing::warn!(
            "[master] run {run_id} was ended but core was not told why ({e}) — its session falls to the ten-minute sweep"
        );
    }
}

/// Beat what this box still holds, and close the loop on what it does not.
async fn give_back_lost_runs(
    boot_id: &str,
    live: &dyn recovery::MasterLiveness,
    world: &Reclaim<'_>,
    sessions: &dyn close_loop::SessionReader,
    leases: &dyn close_loop::LeaseKeeper,
    watch: recovery::RunWatch<'_>,
    ledger: &mut Option<Ledger>,
) {
    let Some(led) = ledger.as_mut() else { return };
    if boot_id.is_empty() {
        tracing::warn!("[master] this box reports no boot id — leaving unclosed runs alone");
        return;
    }
    match recovery::reconcile(led, boot_id, live, world.procs, sessions, leases, watch).await {
        Ok(done) => {
            for r in done {
                if r.owed_idle_exit {
                    end_idle_run(led, &r.run_id, world).await;
                    continue;
                }
                if r.owed_death_report {
                    report_run_death(led.run(&r.run_id).ok().flatten(), &r, world).await;
                }
                if r.owed_release
                    && release_held_tree(led, &r, boot_id, world, sessions, leases).await
                {
                    continue;
                }
                if r.state.is_closed() {
                    continue;
                }
                tracing::warn!(
                    "[master] run {} is partially closed: session_terminal={} worktree_gone={} leases={}/{}",
                    r.run_id,
                    r.state.session_terminal,
                    r.state.worktree_gone,
                    r.state.leases_returned,
                    r.state.leases_total
                );
            }
        }
        Err(e) => tracing::warn!("[master] reconcile failed: {e}"),
    }
}

/// The master's own process, versioned with this binary.
const MASTER_SKILL: &str = include_str!("../../assets/forge-master-skill.md");

/// Write the skill where the session about to start will look for it.
fn install_skill(repo: &std::path::Path) -> std::io::Result<()> {
    let dir = repo.join(".claude/skills/forge-master");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("SKILL.md"), MASTER_SKILL)
}

/// Register the daemon's hooks for the session about to start, and say so.
fn install_hooks_logged(repo: &std::path::Path, slug: &str) {
    let Ok(exe) = std::env::current_exe() else {
        tracing::warn!("[master] {slug}: cannot name this binary — starting without hooks, so this session reports no turn boundaries");
        return;
    };
    match crate::daemon::hook_install::install(repo, &exe) {
        Ok(path) => tracing::info!("[master] {slug}: hooks registered in {}", path.display()),
        Err(e) => tracing::warn!(
            "[master] {slug}: could not register hooks in {}: {e} — starting anyway, blind to this session's turn boundaries",
            repo.display()
        ),
    }
}

/// What telling core about a resume choice needs of it.
#[allow(async_fn_in_trait)]
pub trait ChoiceReporter {
    async fn report(
        &self,
        session_id: &str,
        run_id: &str,
        choice: &str,
        why: &str,
    ) -> crate::error::Result<()>;
}

/// The live implementation, over this box's device credential.
pub struct CoreChoice<'a>(pub &'a CoreClient);

impl ChoiceReporter for CoreChoice<'_> {
    async fn report(
        &self,
        session_id: &str,
        run_id: &str,
        choice: &str,
        why: &str,
    ) -> crate::error::Result<()> {
        crate::transport::run_sessions::report_resume_choice(
            self.0,
            session_id,
            serde_json::json!({ "runId": run_id, "choice": choice, "why": why }),
        )
        .await
    }
}

/// Carry every recorded resume choice onto the issues its run holds.
///
/// Answers how many it said. Never fails: one core would not take is tried
/// again next sweep, because the obligation is still recorded.
pub(crate) async fn say_resume_choices(
    reporter: &impl ChoiceReporter,
    ledger: &mut Option<Ledger>,
    boot_id: &str,
) -> usize {
    if boot_id.is_empty() {
        return 0;
    }
    let owed = {
        let Some(led) = ledger.as_ref() else { return 0 };
        match led.choices_awaiting_report(boot_id) {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("[master] cannot read recorded resume choices: {e}");
                return 0;
            }
        }
    };
    let mut said = 0;
    for run in owed {
        let (Some(session_id), Some(choice)) = (run.session_id.clone(), run.resume_choice.clone())
        else {
            continue;
        };
        let why = run.resume_choice_why.clone().unwrap_or_default();
        match reporter.report(&session_id, &run.run_id, &choice, &why).await {
            Ok(()) => {
                if let Some(led) = ledger.as_mut() {
                    if let Err(e) = led.mark_resume_choice_said(&run.run_id) {
                        tracing::warn!(
                            "[master] run {}: core has the choice and the mark did not land: {e} — it will be said again",
                            run.run_id
                        );
                        continue;
                    }
                }
                said += 1;
            }
            Err(e) => tracing::warn!(
                "[master] run {}: core would not take the resume choice ({e}) — the next sweep tries again",
                run.run_id
            ),
        }
    }
    said
}

/// Every run still open under this master, as raw fields.
fn inherited_runs(led: &Ledger, master_session_id: &str, _project_id: &str) -> Vec<InheritedRun> {
    let Ok(runs) = led.unclosed_runs() else {
        return Vec::new();
    };
    runs.into_iter()
        .filter(|r| r.master_session_id == master_session_id && r.ended_by.is_none())
        .map(|r| InheritedRun {
            issue_keys: led
                .issues(&r.run_id)
                .map(|m| m.into_iter().map(|i| i.issue_key).collect())
                .unwrap_or_default(),
            run_id: r.run_id,
            worktree_path: r.worktree_path.display().to_string(),
            incarnation: r.incarnation.wire(),
            work: r.work.wire(),
            agent_id: r.agent_id,
            ended_by: r.ended_by,
        })
        .collect()
}

/// One run a resumed pane inherited, as the fields the box can state and nothing else.
pub(crate) struct InheritedRun {
    pub run_id: String,
    pub issue_keys: Vec<String>,
    pub worktree_path: String,
    pub incarnation: &'static str,
    pub work: &'static str,
    pub agent_id: Option<String>,
    pub ended_by: Option<String>,
}

/// The block a resumed pane is handed: every run still open under it, raw.
pub(crate) fn resumed_brief(conversation: &str, runs: &[InheritedRun]) -> String {
    let mut out = format!(
        "\nThis pane was RESUMED, not started fresh: it is continuing conversation `{conversation}`, \
so what you remember of this project may be from before the interruption that ended the last pane.\n"
    );
    if runs.is_empty() {
        out.push_str(
            "\nNo run rows were left open under this master, so there is nothing to decide before \
you carry on.\n",
        );
        return out;
    }
    out.push_str(&format!(
        "\n{} run(s) were left open under this master. For EACH of them, before you declare any new \
work, record one of `continue`, `restart` or `leave` with your reason — the declaration will be \
refused until you have. These are the fields this box can state about each. It states them and \
judges none of them; the judgement is yours:\n",
        runs.len()
    ));
    for r in runs {
        out.push_str(&format!(
            "\n- run `{}`\n  issues: {}\n  worktree: {}\n  incarnation: {}\n  work: {}\n  subagent: {}\n  ended: {}\n",
            r.run_id,
            if r.issue_keys.is_empty() { "none recorded".to_string() } else { r.issue_keys.join(", ") },
            r.worktree_path,
            r.incarnation,
            r.work,
            r.agent_id.as_deref().unwrap_or("never bound"),
            r.ended_by.as_deref().unwrap_or("not ended"),
        ));
    }
    out.push_str(
        "\nRead the worktree and the issue before you choose. `continue` means the work stands and \
you will carry it on; `restart` means it does not and you will cut it again; `leave` means it is \
somebody else's to settle and you will touch neither. Whichever you pick, say why in your own \
words: the record is what the next reader has.\n",
    );
    out
}

/// What `ensure_master` did about this project's pane on this pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PaneState {
    /// No master is up for this project and none could be started.
    Absent,
    /// A pane was already running and this daemon adopted it.
    Adopted,
    /// A pane was started with no conversation behind it.
    ColdStarted,
    /// A pane was started on the conversation its predecessor had.
    Resumed,
}

/// Where Claude Code keeps the conversation for a directory, if it keeps one.
///
/// Answers the path it would be at, which may not exist.
pub(crate) fn conversation_transcript(
    cwd: &std::path::Path,
    conversation_id: &str,
) -> Option<std::path::PathBuf> {
    let encoded: String = cwd
        .to_string_lossy()
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    Some(
        dirs_next::home_dir()?
            .join(".claude")
            .join("projects")
            .join(encoded)
            .join(format!("{conversation_id}.jsonl")),
    )
}

/// The conversation this project's pane should be resumed from, if this box can
/// actually reach it.
///
/// Says so in the log when it cannot, naming the conversation and the path.
pub(crate) fn resume_for(
    slug: &str,
    repo: &std::path::Path,
    stored: Option<&str>,
) -> Option<String> {
    let id = stored.filter(|s| !s.is_empty())?;
    let path = conversation_transcript(repo, id)?;
    if path.is_file() {
        tracing::info!("[master] {slug}: resuming conversation {id}");
        return Some(id.to_string());
    }
    tracing::warn!(
        "[master] {slug}: conversation {id} is recorded for this project but this box has no transcript for it at {} — starting cold, so this pane begins with no memory of what its predecessor was doing",
        path.display()
    );
    None
}

/// Where a project's master keeps what only it can say.
fn transcript_path(slug: &str) -> Option<std::path::PathBuf> {
    let dir = Config::path().ok()?.with_file_name("master").join(slug);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("transcript.log"))
}

/// This project's declared MCP servers, resolved by core, or `None` when the
/// box could not ask.
///
/// A failure is NOT fatal and is NOT silent: the box carries on and starts a
/// master with no project servers, having said which project lost them and
/// why. Refusing to start over this would take the reader off the box along
/// with the tools.
async fn project_mcp_servers(
    client: &CoreClient,
    project_id: &str,
    slug: &str,
) -> Option<mcp_servers::ProjectMcpServers> {
    match mcp_servers::fetch(client, project_id).await {
        Ok(found) => Some(found),
        Err(e) => {
            tracing::error!(
                "[master] {slug}: could not read this project's declared MCP servers from core: {e} — any master started now has NONE of them, whatever the project declares"
            );
            None
        }
    }
}

/// Whether this box can honestly describe what it is about to hand a pane.
#[derive(Debug, PartialEq, Eq)]
enum LaunchRecord {
    /// The file on disk says exactly what the pane will be given.
    Truthful,
    /// The config could not be written, but the record now says the pane gets
    /// nothing — which is what will happen.
    NoneAndSaysSo,
    /// A record of OTHER servers survives that the pane will not carry.
    Lying,
}

/// The launch decision, separated from the filesystem and the log so the one
/// state that must refuse can be asserted.
fn launch_record(wrote: bool, cleared: bool) -> LaunchRecord {
    match (wrote, cleared) {
        (true, _) => LaunchRecord::Truthful,
        (false, true) => LaunchRecord::NoneAndSaysSo,
        (false, false) => LaunchRecord::Lying,
    }
}

/// What a sweep may conclude about a live pane's MCP configuration.
#[derive(Debug, PartialEq, Eq)]
enum PaneConfig {
    /// Core could not be asked, so nothing about this pane is known.
    Unknown,
    /// The pane carries what core resolves now.
    Current,
    /// The pane cannot carry what core resolves now: an operator must end it.
    Stale,
}

/// The whole decision, separated from the filesystem and the log so the one
/// case that costs a live master can be asserted.
fn pane_config(
    asked: Option<&mcp_servers::ProjectMcpServers>,
    on_disk_matches: bool,
) -> PaneConfig {
    match asked {
        None => PaneConfig::Unknown,
        Some(_) if on_disk_matches => PaneConfig::Current,
        Some(_) => PaneConfig::Stale,
    }
}

/// Say, once, that a pane already running does not carry what core now resolves.
///
/// A pane reads `--mcp-config` at startup and can never be told a new one, and
/// this daemon does not kill a live master to re-spawn it: a pass in flight is
/// worth more than a same-sweep correction. So the answer is a line an operator
/// can act on, repeated only when what it says changes.
fn report_stale_pane_config(
    masters: &Arc<Masters>,
    project_id: &str,
    name: &str,
    slug: &str,
    asked: Option<&mcp_servers::ProjectMcpServers>,
) {
    let on_disk_matches = asked
        .map(|d| crate::mcp::config::session_matches(slug, &d.mcp_servers))
        .unwrap_or(false);
    let declared = match pane_config(asked, on_disk_matches) {
        PaneConfig::Unknown => return,
        PaneConfig::Current => {
            if let Some(d) = asked {
                let _ = crate::mcp::config::write_session(slug, &d.mcp_servers);
            }
            masters.clear_mcp_stale(project_id);
            return;
        }
        PaneConfig::Stale => asked.expect("Stale is only reachable with an answer"),
    };
    if !masters.claim_mcp_stale(project_id) {
        return;
    }
    tracing::error!(
        "[master] {slug}: the resident session {name} was started before this project's MCP servers were resolved, or before they last changed, so its runs do NOT have {}. A pane cannot be told a new MCP config — end it with `tmux kill-session -t {name}` and the next sweep starts one that carries them.",
        if declared.resolved_names.is_empty() {
            "the servers it now declares".to_string()
        } else {
            declared.resolved_names.join(", ")
        }
    );
}

/// Make sure this project has a live, registered master, and return its id.
async fn ensure_master(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    resolved: &crate::daemon::dispatch::Resolved,
    stored_conversation: Option<&str>,
    inherited: &[InheritedRun],
) -> PaneState {
    let name = terminal::session_name(terminal::MASTER_PREFIX, &resolved.slug);
    if !terminal::available() {
        tracing::error!(
            "[master] {}: tmux is not installed on this box — no master will run for it; install tmux (`forge-runner doctor` checks for it)",
            resolved.slug
        );
        return PaneState::Absent;
    }

    let session = match master_api::register(client, project_id, &name).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("[master] {}: cannot register with core: {e}", resolved.slug);
            return PaneState::Absent;
        }
    };

    let asked = project_mcp_servers(client, project_id, &resolved.slug).await;
    let declared = asked.clone().unwrap_or_default();

    if terminal::alive(&name).await {
        report_stale_pane_config(masters, project_id, &name, &resolved.slug, asked.as_ref());
        if masters.get(project_id).is_none() {
            tracing::info!(
                "[master] {}: adopting the resident session {name}",
                resolved.slug
            );
            remember(masters, project_id, &session);
        }
        return PaneState::Adopted;
    }

    if let Err(e) = install_skill(&resolved.repo_path) {
        tracing::error!(
            "[master] {}: could not install the forge-master skill into {}: {e} — not starting a master",
            resolved.slug,
            resolved.repo_path.display()
        );
        return PaneState::Absent;
    }

    install_hooks_logged(&resolved.repo_path, &resolved.slug);

    crate::workspace::trust::pre_trust_logged(&resolved.repo_path, &resolved.slug);

    let transcript = transcript_path(&resolved.slug);
    let mut env = terminal::pane_env();
    match session_tokens::default_path().map(session_tokens::SessionTokens::at) {
        Some(store) => match store.mint(&session.session_id) {
            Ok(token) => env.push((session_tokens::TOKEN_ENV.to_string(), token)),
            Err(e) => {
                tracing::error!(
                    "[master] {}: cannot mint a control capability: {e} — not starting a master",
                    resolved.slug
                );
                return PaneState::Absent;
            }
        },
        None => {
            tracing::error!(
                "[master] {}: cannot resolve the control token map — not starting a master",
                resolved.slug
            );
            return PaneState::Absent;
        }
    }
    let mcp_config = match crate::mcp::config::write_session(&resolved.slug, &declared.mcp_servers)
    {
        Ok(path) => path,
        Err(e) => {
            let cleared = crate::mcp::config::clear_session(&resolved.slug);
            tracing::error!(
                "[master] {}: could not write the pane's MCP config: {e} — {}",
                resolved.slug,
                if cleared.is_ok() {
                    format!(
                        "starting WITHOUT the project's declared servers ({})",
                        declared.resolved_names.join(", ")
                    )
                } else {
                    "and the previous config could not be removed either".to_string()
                }
            );
            if let (LaunchRecord::Lying, Err(ce)) =
                (launch_record(false, cleared.is_ok()), &cleared)
            {
                tracing::error!(
                    "[master] {}: refusing to start a master this box could not describe: {ce} — a pane started now would carry none of this project's servers while the file on disk still claims it carries them, so no later sweep could report it. Make {} writable and the next sweep starts one.",
                    resolved.slug,
                    crate::mcp::config::session_dir().display()
                );
                return PaneState::Absent;
            }
            None
        }
    };
    if let Some(path) = mcp_config.as_deref() {
        tracing::info!(
            "[master] {}: pane declares {} from {}",
            resolved.slug,
            declared.resolved_names.join(", "),
            path.display()
        );
    }
    let resume = resume_for(&resolved.slug, &resolved.repo_path, stored_conversation);
    match terminal::ensure(
        &name,
        &resolved.repo_path,
        &terminal::pane_argv(mcp_config.as_deref(), resume.as_deref()),
        &env,
        transcript.as_deref(),
    )
    .await
    {
        Ok(_) => {}
        Err(e) => {
            tracing::error!("[master] {}: could not start {name}: {e}", resolved.slug);
            return PaneState::Absent;
        }
    }
    tracing::info!(
        "[master] {}: resident session {name} {} in {} — `tmux attach -t {name}` to watch it",
        resolved.slug,
        match resume.as_deref() {
            Some(id) => format!("resumed from conversation {id}"),
            None => "cold-started".to_string(),
        },
        resolved.repo_path.display()
    );
    remember(masters, project_id, &session);

    let brief = standing_prompt(
        &resolved.slug,
        resolved.base_branch.as_deref(),
        resolved.master_policy.as_deref(),
        &declared.dropped_names,
        asked.is_none(),
    );
    let brief = match resume.as_deref() {
        Some(conv) => format!("{brief}{}", resumed_brief(conv, inherited)),
        None => brief,
    };
    if let Err(e) = terminal::brief_new_pane(&name, &brief).await {
        tracing::warn!("[master] {}: could not brief {name}: {e}", resolved.slug);
    }
    match resume {
        Some(_) => PaneState::Resumed,
        None => PaneState::ColdStarted,
    }
}

fn remember(masters: &Arc<Masters>, project_id: &str, session: &master_api::MasterSession) {
    masters.remember(
        project_id,
        MasterState {
            session_id: session.session_id.clone(),
            name: session.name.clone(),
            last_work: Instant::now(),
            last_nudge: None,
            mcp_stale_reported: false,
        },
    );
}

/// The whole of one pass prompt: go, and who you are.
fn nudge() -> String {
    "Pass. Hand it to the dispatch skill, and say what you dispatched and what you did not.".into()
}

/// Tell a master there is something to look at.
async fn nudge_master(masters: &Arc<Masters>, project_id: &str, slug: &str) {
    let Some((_, name)) = masters.get(project_id) else {
        return;
    };
    tracing::info!("[master] {slug}: admissible work — nudging {name}");
    if let Err(e) = terminal::send_line(&name, &nudge()).await {
        tracing::warn!("[master] {slug}: could not nudge {name}: {e}");
    }
}

/// The dead-master detector, re-homed from the control socket to the pane.
///
/// B3: the daemon is no longer the master's parent, so a dead master drops no
/// socket. What it does do is stop existing as a tmux session, and this is the
/// thing that notices — one sweep, not the three minutes core's reaper costs.
async fn supervise(client: &CoreClient, masters: &Arc<Masters>, project_id: &str, slug: &str) {
    let Some((session_id, name)) = masters.get(project_id) else {
        return;
    };

    if !terminal::alive(&name).await {
        tracing::warn!("[master] {slug}: resident session {name} is gone — closing its row");
        end_master(
            client,
            masters,
            project_id,
            &session_id,
            "terminal session vanished",
        )
        .await;
    }
}

/// Let an idle master go, if the ledger says its children are done.
async fn retire_if_idle(
    client: &CoreClient,
    masters: &Arc<Masters>,
    ledger: &mut Option<Ledger>,
    project_id: &str,
    slug: &str,
) -> bool {
    let (Some(led), Some(idle), Some((session_id, name))) = (
        ledger.as_ref(),
        masters.idle_for(project_id),
        masters.get(project_id),
    ) else {
        return false;
    };
    let kids = match master_exit::children(led, &session_id) {
        Ok(k) => k,
        Err(e) => {
            tracing::warn!("[master] {slug}: ledger unreadable ({e}) — keeping the master");
            return false;
        }
    };
    match master_exit::verdict(idle, &kids) {
        Verdict::Stay(_) => false,
        Verdict::Exit => {
            tracing::info!(
                "[master] {slug}: nothing for {}m and every child run closed — retiring {name}",
                idle.as_secs() / 60
            );
            let _ = terminal::kill(&name).await;
            end_master(
                client,
                masters,
                project_id,
                &session_id,
                "idle, children done",
            )
            .await;
            true
        }
    }
}

async fn end_master(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    session_id: &str,
    reason: &str,
) {
    if let Err(e) = master_api::close(client, session_id, reason).await {
        tracing::warn!("[master] could not close session {session_id}: {e}");
    }
    if let Some(store) = session_tokens::default_path().map(session_tokens::SessionTokens::at) {
        store.retire(session_id);
    }
    masters.forget(project_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    const THIS_SOURCE: &str = include_str!("master.rs");

    #[test]
    fn nothing_here_infers_liveness_from_a_pane() {
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        for banned in [
            "SILENCE_CEILING",
            "QUIET_BEFORE_PROMPT",
            "pass_prompt",
            "fn observe",
            "DEATH_LIMIT",
            "DEATH_WINDOW",
            "BREAKER_COOLDOWN",
            "transcript_len",
            "seen_len",
            "last_growth",
        ] {
            assert!(
                !production.contains(banned),
                "`{banned}` is part of the supervision cluster this issue deletes: every one of them inferred a process's state from a pane's byte count, and the pane is where a master that is idle ON PURPOSE looks identical to one that has stopped (ISS-933 criteria 17 and 18)"
            );
        }
        assert!(
            production.contains("fn nudge("),
            "the cluster is replaced, not merely removed — a master still has to be told there is work"
        );
    }

    #[test]
    fn the_retirement_path_asks_the_ledger_and_not_just_the_clock() {
        let body = THIS_SOURCE
            .split("async fn retire_if_idle(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .unwrap_or_default();
        assert!(
            body.contains("master_exit::children("),
            "the wiring must read the children out of the ledger — a caller that passed an empty slice would satisfy `verdict` and retire a master over live runs, which is criterion 19's failure arriving through the call site rather than the decision (ISS-933 criteria 19 and 20)"
        );
    }

    fn served(entries: &[(&str, Option<u64>)]) -> Vec<runners::MeRunner> {
        entries
            .iter()
            .map(|(status, limited)| runners::MeRunner {
                project_id: "p".into(),
                runner_id: "r".into(),
                slug: "s".into(),
                base_branch: None,
                repo_path: None,
                branch: None,
                status: (*status).into(),
                workspace_setup: None,
                master_policy: None,
                rate_limited_for_seconds: *limited,
                limit_reason: None,
            })
            .collect()
    }

    /// The body this box sends core for the captured refusal — the same file the
    /// receiving suite reads.
    const WIRE: &str = include_str!("../../assets/master-limit-wire.json");

    #[test]
    fn the_stamp_a_master_reports_is_what_widens_this_boxs_own_sweep() {
        let wire: serde_json::Value = serde_json::from_str(WIRE).unwrap();
        let secs = wire["resetsInSeconds"]
            .as_u64()
            .expect("the wire carries a reset");
        assert_eq!(
            next_poll_delay(&served(&[("online", Some(secs))])),
            LIMITED_POLL_INTERVAL,
            "a row stamped from this report is what makes the sweep back off"
        );
        assert_eq!(
            next_poll_delay(&served(&[("online", None)])),
            POLL_INTERVAL,
            "and a row the clear emptied is what brings it back"
        );
    }

    #[test]
    fn a_wake_cuts_latency_rather_than_adding_it() {
        assert!(WAKE_FLOOR < POLL_INTERVAL);
    }

    #[tokio::test]
    async fn a_burst_of_wakes_coalesces_into_one_pending_sweep() {
        let (tx, mut rx) = wake_channel();

        assert!(tx
            .try_send(Wake::Core {
                project_id: Some("p1".into())
            })
            .is_ok());
        assert!(
            tx.try_send(Wake::Core {
                project_id: Some("p2".into())
            })
            .is_err(),
            "a second wake while one is pending must be dropped, not queued"
        );
        assert!(
            tx.try_send(Wake::Reconnect).is_err(),
            "the catch-up read coalesces onto a pending wake too — one sweep covers both"
        );

        assert!(matches!(rx.recv().await, Some(Wake::Core { .. })));
        assert!(
            tx.try_send(Wake::Reconnect).is_ok(),
            "once the pending wake is taken, the next one must get through"
        );
    }

    #[test]
    fn a_wake_says_which_trigger_fired() {
        assert!(Wake::Core {
            project_id: Some("forge-dev".into())
        }
        .describe()
        .contains("forge-dev"));
        assert!(Wake::Reconnect.describe().contains("catch-up"));
    }

    #[test]
    fn a_limited_fleet_is_slowed_down_and_never_stopped() {
        let d = next_poll_delay(&served(&[("online", Some(3600))]));
        assert!(d > POLL_INTERVAL, "a limited fleet should back off");
        assert!(
            d <= LIMITED_POLL_INTERVAL,
            "the backoff must stay bounded: {d:?}"
        );
    }

    #[test]
    fn one_limited_project_does_not_slow_a_healthy_one() {
        let mixed = served(&[("online", Some(3600)), ("online", None)]);
        assert_eq!(next_poll_delay(&mixed), POLL_INTERVAL);
    }

    #[test]
    fn an_expired_limit_polls_at_full_speed() {
        assert_eq!(
            next_poll_delay(&served(&[("online", Some(0))])),
            POLL_INTERVAL
        );
    }

    #[test]
    fn a_core_that_does_not_report_limits_polls_at_full_speed() {
        assert_eq!(next_poll_delay(&served(&[("online", None)])), POLL_INTERVAL);
    }

    #[test]
    fn a_drained_runner_is_not_counted_either_way() {
        let mix = served(&[("draining", None), ("online", Some(3600))]);
        assert!(next_poll_delay(&mix) > POLL_INTERVAL);
    }

    #[test]
    fn one_master_per_project_and_projects_do_not_block_each_other() {
        let masters = Masters::new();
        let session = master_api::MasterSession {
            session_id: "s1".into(),
            name: "forge-master-p1".into(),
            created: true,
        };
        let masters = Arc::new(masters);
        remember(&masters, "p1", &session);
        assert_eq!(masters.get("p1").map(|m| m.0), Some("s1".into()));
        assert!(
            masters.get("p2").is_none(),
            "one project's master is not another's"
        );
        assert_eq!(masters.forget("p1"), Some("s1".into()));
        assert!(masters.get("p1").is_none());
    }

    /// Criterion 5, the half that decides how often it is said. The comparison
    /// itself lives in `mcp::config::session_matches` and is tested there; this
    /// is the gate that keeps a true report from becoming a line every sweep.
    #[test]
    fn a_stale_pane_is_reported_once_per_process_and_an_adopted_one_is_always_reported() {
        let masters = Arc::new(Masters::new());

        // Never registered here: an adopted pane, and nothing has spoken for it.
        assert!(masters.claim_mcp_stale("p-adopted"));
        assert!(masters.claim_mcp_stale("p-adopted"));

        remember(
            &masters,
            "p1",
            &master_api::MasterSession {
                session_id: "s1".into(),
                name: "forge-master-p1".into(),
                created: true,
            },
        );
        assert!(masters.claim_mcp_stale("p1"), "the first mismatch is news");
        assert!(
            !masters.claim_mcp_stale("p1"),
            "every sweep after is the same news"
        );

        // One project's silence is not another's.
        remember(
            &masters,
            "p2",
            &master_api::MasterSession {
                session_id: "s2".into(),
                name: "forge-master-p2".into(),
                created: true,
            },
        );
        assert!(masters.claim_mcp_stale("p2"));

        // The pane matches again, so the NEXT mismatch is worth saying.
        masters.clear_mcp_stale("p1");
        assert!(masters.claim_mcp_stale("p1"));
    }

    #[test]
    fn the_brief_tells_the_master_to_record_what_it_decided_rather_than_asked() {
        assert!(
            MASTER_SKILL.contains("forge record decision"),
            "the brief must name the verb that records a decision; without it the ratio's denominator is zero for every master (ISS-964 criteria 1, 2)"
        );
        assert!(
            MASTER_SKILL.contains("reversible"),
            "tier 0 is the rule that a reversible write is TAKEN and recorded — the brief is where the master reads it"
        );
    }

    #[test]
    fn the_owner_policy_reaches_the_brief_verbatim() {
        let policy = "Budget: 5 sessions.\nDrafts are eligible work.\nGroup related issues.";
        let brief = standing_prompt("forge-dev", Some("main"), Some(policy), &[], false);
        assert!(
            brief.contains(policy),
            "the policy must be spliced whole: {brief}"
        );
        assert!(
            brief.contains("OUTRANKS"),
            "the brief must say the policy beats the skill's defaults: {brief}"
        );
    }

    #[test]
    fn no_policy_leaves_the_brief_untouched() {
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], false);
        assert!(!brief.contains("standing policy"), "{brief}");
        assert!(
            brief.trim_end().ends_with("this pane is the record."),
            "{brief}"
        );
    }

    #[test]
    fn a_project_whose_servers_all_resolved_is_told_nothing_about_them() {
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], false);
        assert!(!brief.contains("MCP server"), "{brief}");
    }

    /// F1. The one launch state that refuses, and the two that must not.
    #[test]
    fn only_a_record_that_would_lie_about_a_pane_refuses_the_spawn() {
        assert_eq!(launch_record(true, false), LaunchRecord::Truthful);
        assert_eq!(launch_record(true, true), LaunchRecord::Truthful);
        assert_eq!(launch_record(false, true), LaunchRecord::NoneAndSaysSo);
        assert_eq!(launch_record(false, false), LaunchRecord::Lying);

        // and only `Lying` is the refusal.
        for (wrote, cleared) in [(true, true), (true, false), (false, true)] {
            assert_ne!(
                launch_record(wrote, cleared),
                LaunchRecord::Lying,
                "wrote={wrote} cleared={cleared} must still start a master"
            );
        }
    }

    /// The three verdicts, and the one that must NOT be the kill instruction.
    #[test]
    fn a_pane_core_could_not_be_asked_about_is_unknown_and_never_stale() {
        let declared = mcp_servers::ProjectMcpServers {
            resolved_names: vec!["playwright".into()],
            ..Default::default()
        };
        let declares_nothing = mcp_servers::ProjectMcpServers::default();

        // Could not ask: nothing is known, whatever the file on disk says.
        assert_eq!(pane_config(None, false), PaneConfig::Unknown);
        assert_eq!(pane_config(None, true), PaneConfig::Unknown);

        // Core answered: the file on disk decides, and it decides both ways.
        assert_eq!(pane_config(Some(&declared), true), PaneConfig::Current);
        assert_eq!(pane_config(Some(&declared), false), PaneConfig::Stale);

        // A project core says declares nothing is still an ANSWER, so a pane
        // holding a file it should not have is still reported.
        assert_eq!(
            pane_config(Some(&declares_nothing), false),
            PaneConfig::Stale
        );
        assert_eq!(
            pane_config(Some(&declares_nothing), true),
            PaneConfig::Current
        );
    }

    #[test]
    fn a_box_that_could_not_read_the_declaration_says_so_in_its_own_words() {
        let unreadable = standing_prompt("mowment", Some("main"), None, &[], true);
        assert!(
            unreadable.contains("could NOT read this project's declared MCP servers"),
            "{unreadable}"
        );
        assert!(
            !unreadable.contains("could NOT supply"),
            "an unreadable declaration must not be reported as a named shortfall: {unreadable}"
        );

        let readable = standing_prompt("mowment", Some("main"), None, &[], false);
        assert!(
            !readable.contains("could NOT read"),
            "a project core answered for must be told nothing about readability: {readable}"
        );
    }

    #[test]
    fn a_declared_server_this_box_cannot_supply_is_named_in_the_brief() {
        let dropped = vec!["epodsystem".to_string(), "postman".to_string()];
        let brief = standing_prompt("mowment", Some("main"), None, &dropped, false);
        assert!(brief.contains("epodsystem, postman"), "{brief}");
        assert!(
            brief.contains("could NOT supply"),
            "the master must be told this is a shortfall, not an inventory: {brief}"
        );
        assert!(
            brief.contains("rather than parking it as a run that failed"),
            "the brief must say what to do instead of discovering it as an empty park: {brief}"
        );
    }
}

#[cfg(test)]
mod give_back_tests {
    use super::*;
    use crate::runner::close_loop::{LeaseKeeper, SessionReader};
    use crate::runner::ledger::{Ledger, NewRun};
    use std::sync::Mutex;

    const THIS_SOURCE: &str = include_str!("master.rs");

    type R<T> = crate::error::Result<T>;

    #[derive(Default)]
    struct ChoiceSpy {
        seen: std::sync::Mutex<Vec<(String, String, String, String)>>,
        refuse: bool,
    }

    impl ChoiceReporter for ChoiceSpy {
        async fn report(
            &self,
            session_id: &str,
            run_id: &str,
            choice: &str,
            why: &str,
        ) -> crate::error::Result<()> {
            self.seen.lock().unwrap().push((
                session_id.to_string(),
                run_id.to_string(),
                choice.to_string(),
                why.to_string(),
            ));
            if self.refuse {
                return Err(crate::error::Error::Other("503".into()));
            }
            Ok(())
        }
    }

    fn a_run_that_chose(choice: &str, why: &str) -> Option<Ledger> {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(crate::runner::ledger::NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: std::path::PathBuf::from("/w/one"),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-7".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        led.owe_resume_choices("master-1", "boot-a").unwrap();
        led.record_resume_choice("run-1", "master-1", choice, why)
            .unwrap();
        Some(led)
    }

    #[tokio::test]
    async fn a_recorded_choice_is_carried_to_core_with_its_reason() {
        let mut led = a_run_that_chose("restart", "the branch has nothing on it");
        let spy = ChoiceSpy::default();

        let said = say_resume_choices(&spy, &mut led, "boot-a").await;

        assert_eq!(said, 1);
        let seen = spy.seen.lock().unwrap();
        let (session, run, choice, why) = seen.first().expect("one report");
        assert_eq!(session, "core-sess-1");
        assert_eq!(run, "run-1");
        assert_eq!(choice, "restart");
        assert_eq!(why, "the branch has nothing on it");
    }

    #[tokio::test]
    async fn a_choice_core_has_taken_is_not_said_again() {
        let mut led = a_run_that_chose("leave", "somebody else's to settle");
        let spy = ChoiceSpy::default();

        assert_eq!(say_resume_choices(&spy, &mut led, "boot-a").await, 1);
        assert_eq!(say_resume_choices(&spy, &mut led, "boot-a").await, 0);

        assert_eq!(spy.seen.lock().unwrap().len(), 1, "one report, one comment");
    }

    #[tokio::test]
    async fn a_choice_core_refused_is_said_again_on_the_next_sweep() {
        let mut led = a_run_that_chose("continue", "the work stands");
        let refusing = ChoiceSpy {
            refuse: true,
            ..Default::default()
        };

        assert_eq!(say_resume_choices(&refusing, &mut led, "boot-a").await, 0);

        let taking = ChoiceSpy::default();
        assert_eq!(say_resume_choices(&taking, &mut led, "boot-a").await, 1);
        assert_eq!(taking.seen.lock().unwrap().len(), 1);
    }

    fn three_inherited() -> Vec<InheritedRun> {
        (1..=3)
            .map(|n| InheritedRun {
                run_id: format!("run-{n}"),
                issue_keys: vec![format!("ISS-{n}")],
                worktree_path: format!("/w/{n}"),
                incarnation: "starting",
                work: "runnable",
                agent_id: None,
                ended_by: None,
            })
            .collect()
    }

    #[test]
    fn a_resumed_pane_is_told_that_it_was_resumed() {
        let brief = resumed_brief("conv-abc", &three_inherited());
        assert!(brief.contains("RESUMED"), "{brief}");
        assert!(brief.contains("conv-abc"), "{brief}");
    }

    #[test]
    fn the_inherited_block_carries_no_recommendation_and_no_suggested_action() {
        let brief = resumed_brief("conv-abc", &three_inherited());
        for verdict in [
            "recommend",
            "suggest",
            "you should",
            "probably",
            "advise",
            "best to",
            "likely wants",
        ] {
            assert!(
                !brief.to_lowercase().contains(verdict),
                "the block must hand over raw fields, not a verdict — found `{verdict}`:\n{brief}"
            );
        }
    }

    #[test]
    fn every_inherited_run_appears_as_raw_fields() {
        let brief = resumed_brief("conv-abc", &three_inherited());
        for n in 1..=3 {
            assert!(brief.contains(&format!("run-{n}")), "{brief}");
            assert!(brief.contains(&format!("ISS-{n}")), "{brief}");
            assert!(brief.contains(&format!("/w/{n}")), "{brief}");
        }
        assert!(
            brief.contains("never bound"),
            "an unbound run says so: {brief}"
        );
        assert!(brief.contains("continue"), "{brief}");
        assert!(brief.contains("restart"), "{brief}");
        assert!(brief.contains("leave"), "{brief}");
    }

    #[test]
    fn a_resumed_pane_holding_nothing_is_asked_for_nothing() {
        let brief = resumed_brief("conv-abc", &[]);
        assert!(brief.contains("RESUMED"), "{brief}");
        assert!(brief.contains("nothing to decide"), "{brief}");
    }

    /// What the daemon log SAYS when a recorded conversation cannot be resumed.
    fn logged_while(f: impl FnOnce()) -> String {
        use std::sync::{Arc, Mutex};
        #[derive(Clone)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf(Arc::new(Mutex::new(Vec::new())));
        let made = buf.clone();
        let sub = tracing_subscriber::fmt()
            .with_writer(move || made.clone())
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn a_conversation_this_box_cannot_reach_is_named_in_the_log_it_starts_cold_from() {
        let repo = std::env::temp_dir().join("forge-resume-log");
        let out = logged_while(|| {
            assert_eq!(
                resume_for("some-slug", &repo, Some("conv-9f3a-unreachable")),
                None
            );
        });

        assert!(
            out.contains("conv-9f3a-unreachable.jsonl"),
            "the transcript it could not reach must be named by PATH, so an operator can go and \
             look for it rather than guess where it should have been; log was: {out}"
        );
        assert!(
            out.contains("some-slug"),
            "and which project's pane it was, since one box runs several; log was: {out}"
        );
        assert!(
            out.contains("WARN"),
            "at WARN: starting cold means the pane has lost its predecessor's memory, which is not \
             routine information; log was: {out}"
        );
    }

    #[test]
    fn a_pane_with_nothing_recorded_starts_cold_quietly() {
        let repo = std::env::temp_dir().join("forge-resume-log-quiet");
        let out = logged_while(|| {
            assert_eq!(resume_for("some-slug", &repo, None), None);
        });
        assert!(
            !out.contains("WARN"),
            "nothing stored is not a fault; log was: {out}"
        );
    }

    #[test]
    fn a_conversation_with_no_transcript_on_this_box_starts_cold() {
        let repo = std::env::temp_dir().join("forge-resume-none");
        assert_eq!(
            resume_for("slug", &repo, Some("conv-that-was-never-here")),
            None,
            "a conversation with no transcript may not be handed to --resume"
        );
    }

    #[test]
    fn a_conversation_whose_transcript_is_here_is_resumed() {
        let repo = std::env::temp_dir().join(format!("forge-resume-{}", std::process::id()));
        let id = format!("conv-{}", std::process::id());
        let path = conversation_transcript(&repo, &id).expect("a home directory");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, "{}\n").expect("write");

        let got = resume_for("slug", &repo, Some(&id));

        let _ = std::fs::remove_file(&path);
        assert_eq!(got.as_deref(), Some(id.as_str()));
    }

    #[test]
    fn nothing_stored_is_a_cold_start_and_so_is_an_empty_string() {
        let repo = std::env::temp_dir().join("forge-resume-empty");
        assert_eq!(resume_for("slug", &repo, None), None);
        assert_eq!(resume_for("slug", &repo, Some("")), None);
    }

    #[test]
    fn the_transcript_path_is_the_one_claude_code_actually_uses() {
        let home = dirs_next::home_dir().expect("a home directory");
        let got = conversation_transcript(
            std::path::Path::new("/home/forge/projects/apiflow/.worktrees/ISS-16"),
            "conv-1",
        )
        .expect("a path");
        assert_eq!(
            got,
            home.join(".claude")
                .join("projects")
                .join("-home-forge-projects-apiflow--worktrees-ISS-16")
                .join("conv-1.jsonl")
        );
    }

    struct Alive(bool);
    #[async_trait::async_trait]
    impl recovery::MasterLiveness for Alive {
        async fn state(&self, _id: &str) -> recovery::MasterPresence {
            if self.0 {
                recovery::MasterPresence::Alive
            } else {
                recovery::MasterPresence::Gone
            }
        }
        async fn live_master_for_project(&self, _: &str) -> Option<String> {
            None
        }
    }

    struct ReportsIdleSince(i64);
    #[async_trait::async_trait]
    impl recovery::RunActivity for ReportsIdleSince {
        async fn reported(&self, _: &str) -> Option<run_exit::Reported> {
            Some(run_exit::Reported {
                doing: crate::daemon::agent_activity::Doing::Idle,
                at: self.0,
            })
        }
    }

    struct NeverReports;
    #[async_trait::async_trait]
    impl recovery::RunActivity for NeverReports {
        async fn reported(&self, _: &str) -> Option<run_exit::Reported> {
            None
        }
    }

    #[derive(Default)]
    struct Beats(Mutex<Vec<String>>);
    #[async_trait::async_trait]
    impl recovery::Heartbeat for Beats {
        async fn beat(&self, session_id: &str) -> R<()> {
            self.0.lock().unwrap().push(session_id.to_string());
            Ok(())
        }
    }

    struct NoPids;
    #[async_trait::async_trait]
    impl recovery::ProcessLiveness for NoPids {
        async fn is_gone(&self, _pid: u32) -> bool {
            false
        }
    }

    /// No pid in these tests is ever refuted, so nothing may reach a kill.
    struct NoKill;
    #[async_trait::async_trait]
    impl terminate::ProcessGroup for NoKill {
        async fn kill(&self, _pid: u32) -> crate::runner::inflight::Reaped {
            unreachable!("a run no test refutes must never be killed")
        }
    }

    struct Terminal(bool);
    #[async_trait::async_trait]
    impl SessionReader for Terminal {
        async fn is_terminal(&self, _id: &str) -> R<bool> {
            Ok(self.0)
        }
    }

    #[derive(Default)]
    struct Closes(Mutex<Vec<(String, close_loop::Outcome, Option<serde_json::Value>)>>);
    #[async_trait::async_trait]
    impl close_loop::RunCloser for Closes {
        async fn close(
            &self,
            agent_session_id: &str,
            outcome: close_loop::Outcome,
            _detail: &str,
            checkpoint: Option<serde_json::Value>,
        ) -> R<()> {
            self.0
                .lock()
                .unwrap()
                .push((agent_session_id.to_string(), outcome, checkpoint));
            Ok(())
        }
    }

    #[derive(Default)]
    struct Leases(Mutex<Vec<String>>);
    #[async_trait::async_trait]
    impl LeaseKeeper for Leases {
        async fn release(&self, issue_key: &str) -> R<()> {
            self.0.lock().unwrap().push(issue_key.to_string());
            Ok(())
        }
        async fn is_returned(&self, issue_key: &str) -> R<bool> {
            Ok(self.0.lock().unwrap().iter().any(|k| k == issue_key))
        }
    }

    const BOOT: &str = "boot-under-test";

    fn a_ledger_holding_one_run() -> Ledger {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: "/nonexistent/wt".into(),
            boot_id: BOOT.into(),
            issue_keys: vec!["ISS-1".into(), "ISS-2".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        led
    }

    #[tokio::test]
    async fn ending_an_idle_run_tells_core_the_box_did_it() {
        let led = a_ledger_holding_one_run();
        led.attach_pid("run-1", 424_248).unwrap();
        let mut ledger = Some(led);
        let killed = CountedKill(std::sync::atomic::AtomicUsize::new(0));
        let closes = Closes::default();
        let idle_since = crate::daemon::agent_activity::now_ms()
            - run_exit::RUN_IDLE_BEFORE_EXIT.as_millis() as i64;

        give_back_lost_runs(
            BOOT,
            &Alive(true),
            &Reclaim {
                served: &[],
                cfg: &Config::default(),
                procs: &NoPids,
                killer: &killed,
                closer: &closes,
            },
            &Terminal(false),
            &Leases::default(),
            recovery::RunWatch {
                beat: &Beats::default(),
                idle: &ReportsIdleSince(idle_since),
            },
            &mut ledger,
        )
        .await;

        let seen = closes.0.lock().unwrap();
        let (sess, outcome, checkpoint) = seen.first().expect("one close");
        assert_eq!(
            (sess.as_str(), *outcome),
            ("core-sess-1", close_loop::Outcome::KilledIdle),
            "an idle reap must reach core as its own outcome, not as silence"
        );
        assert_eq!(
            checkpoint.as_ref().and_then(|c| c["source"].as_str()),
            Some("reconstructed_from_box"),
            "the close must carry the box's half, labelled as reconstruction: {checkpoint:?}"
        );
        assert_eq!(killed.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_sweep_beats_the_runs_this_box_still_holds() {
        let mut ledger = Some(a_ledger_holding_one_run());
        let beats = Beats::default();

        give_back_lost_runs(
            BOOT,
            &Alive(true),
            &Reclaim {
                served: &[],
                cfg: &Config::default(),
                procs: &NoPids,
                killer: &NoKill,
                closer: &Closes::default(),
            },
            &Terminal(false),
            &Leases::default(),
            recovery::RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
            &mut ledger,
        )
        .await;

        assert_eq!(
            beats.0.lock().unwrap().as_slice(),
            ["core-sess-1"],
            "a live run this box holds must be beaten every sweep, or core's ten-minute reaper takes its worktree back"
        );
    }

    #[tokio::test]
    async fn a_dead_master_leaves_its_leases_returned_and_no_beat_sent() {
        let mut ledger = Some(a_ledger_holding_one_run());
        let beats = Beats::default();
        let leases = Leases::default();

        give_back_lost_runs(
            BOOT,
            &Alive(false),
            &Reclaim {
                served: &[],
                cfg: &Config::default(),
                procs: &NoPids,
                killer: &NoKill,
                closer: &Closes::default(),
            },
            &Terminal(true),
            &leases,
            recovery::RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
            &mut ledger,
        )
        .await;

        assert!(
            beats.0.lock().unwrap().is_empty(),
            "beating for a master that is gone tells core this box still holds a run nobody is running"
        );
        let mut returned = leases.0.lock().unwrap().clone();
        returned.sort();
        assert_eq!(
            returned,
            ["ISS-1", "ISS-2"],
            "every issue of the group comes back, per issue — a run carrying two that returned one is not closed"
        );
    }

    #[tokio::test]
    async fn a_box_that_cannot_name_its_boot_reconciles_nothing() {
        let mut ledger = Some(a_ledger_holding_one_run());
        let beats = Beats::default();
        let leases = Leases::default();

        give_back_lost_runs(
            "",
            &Alive(false),
            &Reclaim {
                served: &[],
                cfg: &Config::default(),
                procs: &NoPids,
                killer: &NoKill,
                closer: &Closes::default(),
            },
            &Terminal(true),
            &leases,
            recovery::RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
            &mut ledger,
        )
        .await;

        assert!(
            leases.0.lock().unwrap().is_empty() && beats.0.lock().unwrap().is_empty(),
            "an unreadable boot id must leave every run alone — an empty one matches nothing recorded, so reconciling on it gives back the leases of runs that are still live"
        );
    }

    struct GonePid(u32);
    #[async_trait::async_trait]
    impl recovery::ProcessLiveness for GonePid {
        async fn is_gone(&self, pid: u32) -> bool {
            pid == self.0
        }
    }

    struct CountedKill(std::sync::atomic::AtomicUsize);
    #[async_trait::async_trait]
    impl terminate::ProcessGroup for CountedKill {
        async fn kill(&self, _pid: u32) -> crate::runner::inflight::Reaped {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            crate::runner::inflight::Reaped::NotFound
        }
    }

    async fn git(dir: &std::path::Path, args: &[&str]) {
        tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .await
            .unwrap();
    }

    /// A real repo with a real `git worktree` on a branch — the only way to
    /// watch a checkout actually leave the disk.
    async fn a_repo_with_a_live_worktree() -> (std::path::PathBuf, std::path::PathBuf) {
        let repo = std::env::temp_dir().join(format!(
            "forge-master-reclaim-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]).await;
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        std::fs::write(repo.join("f.txt"), "one").unwrap();
        git(&repo, &["add", "."]).await;
        git(&repo, &["commit", "-m", "init"]).await;
        // A bare remote so `@{u}` resolves: `holds_work` counts a branch with no
        // upstream as holding work, because commits that were never pushed exist
        // nowhere else — and a tree holding work is refused, not released.
        let remote = repo.with_extension("remote.git");
        let _ = std::fs::remove_dir_all(&remote);
        std::fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "--bare", "-b", "main"]).await;
        git(
            &repo,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        )
        .await;
        git(&repo, &["push", "-u", "origin", "main"]).await;
        let wt = crate::workspace::worktree::create(&repo.to_string_lossy(), "ISS-957", None)
            .await
            .unwrap();
        git(&wt, &["push", "-u", "origin", "ISS-957"]).await;
        (repo, wt)
    }

    #[tokio::test]
    async fn reclaiming_a_dead_run_tells_core_it_died_rather_than_waiting_to_be_reaped() {
        let (repo, wt) = a_repo_with_a_live_worktree().await;
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-dead".into(),
            worktree_path: wt.clone(),
            boot_id: BOOT.into(),
            issue_keys: vec!["ISS-957".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        led.attach_pid("run-1", 424_249).unwrap();

        let mut cfg = Config::default();
        cfg.bindings.insert(
            "proj-1".into(),
            crate::config::Binding {
                repo_path: repo.clone(),
                branch: None,
                project_id: Some("proj-1".into()),
            },
        );
        let closes = Closes::default();
        let mut ledger = Some(led);

        give_back_lost_runs(
            BOOT,
            &Alive(false),
            &Reclaim {
                served: &[],
                cfg: &cfg,
                procs: &GonePid(424_249),
                killer: &CountedKill(std::sync::atomic::AtomicUsize::new(0)),
                closer: &closes,
            },
            &Terminal(false),
            &Leases::default(),
            recovery::RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
            &mut ledger,
        )
        .await;

        let seen = closes.0.lock().unwrap();
        let (sess, outcome, checkpoint) = seen.first().expect("one close");
        assert_eq!(
            (sess.as_str(), *outcome),
            ("core-sess-1", close_loop::Outcome::Died),
            "a run whose process this box refuted must reach core as a death, from the box, now"
        );
        let cp = checkpoint.as_ref().expect("a death carries the box's half");
        assert_eq!(cp["source"].as_str(), Some("reconstructed_from_box"));
        assert_eq!(
            cp["branch"].as_str(),
            Some("ISS-957"),
            "the reconstruction must be of the run's own worktree: {cp}"
        );
        let unread = cp["unread"].as_array().expect("unread is a list");
        assert!(
            unread.is_empty(),
            "a worktree that is still on disk reconstructs completely: {cp}"
        );
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(repo.with_extension("remote.git"));
    }

    #[tokio::test]
    async fn a_dead_runs_worktree_is_given_back_and_its_run_ended() {
        let (repo, wt) = a_repo_with_a_live_worktree().await;
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-dead".into(),
            worktree_path: wt.clone(),
            boot_id: BOOT.into(),
            issue_keys: vec!["ISS-957".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        led.attach_pid("run-1", 424_246).unwrap();

        let mut cfg = Config::default();
        cfg.bindings.insert(
            "proj-1".into(),
            crate::config::Binding {
                repo_path: repo.clone(),
                branch: None,
                project_id: Some("proj-1".into()),
            },
        );
        let killed = CountedKill(std::sync::atomic::AtomicUsize::new(0));
        let leases = Leases::default();
        let mut ledger = Some(led);

        give_back_lost_runs(
            BOOT,
            &Alive(false),
            &Reclaim {
                served: &[],
                cfg: &cfg,
                procs: &GonePid(424_246),
                killer: &killed,
                closer: &Closes::default(),
            },
            &Terminal(true),
            &leases,
            recovery::RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
            &mut ledger,
        )
        .await;

        assert!(
            !wt.exists(),
            "the checkout must actually leave the disk: while it is there the `worktree_gone` mark cannot be observed, so `end_run` is never reached and the reap refuses the tree because the run is `ended_by IS NULL` — the cycle has no other exit"
        );
        let run = ledger.as_ref().unwrap().run("run-1").unwrap().unwrap();
        assert_eq!(
            run.ended_by.as_deref(),
            Some("recovery"),
            "a released tree that leaves the run open re-enters the same deadlock on the next sweep, now with the diff already gone"
        );
        assert_eq!(
            leases.0.lock().unwrap().as_slice(),
            ["ISS-957"],
            "the lease is what another box needs back — a reclaimed worktree whose issue stays leased frees disk and no work"
        );
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(repo.with_extension("remote.git"));
    }

    #[tokio::test]
    async fn a_dead_run_carrying_uncommitted_work_has_it_preserved_before_the_tree_goes() {
        let (repo, wt) = a_repo_with_a_live_worktree().await;
        std::fs::write(wt.join("f.txt"), "the agent got this far").unwrap();
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-dead".into(),
            worktree_path: wt.clone(),
            boot_id: BOOT.into(),
            issue_keys: vec!["ISS-957".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        led.attach_pid("run-1", 424_247).unwrap();

        let mut cfg = Config::default();
        cfg.bindings.insert(
            "proj-1".into(),
            crate::config::Binding {
                repo_path: repo.clone(),
                branch: None,
                project_id: Some("proj-1".into()),
            },
        );
        let mut ledger = Some(led);

        give_back_lost_runs(
            BOOT,
            &Alive(false),
            &Reclaim {
                served: &[],
                cfg: &cfg,
                procs: &GonePid(424_247),
                killer: &CountedKill(std::sync::atomic::AtomicUsize::new(0)),
                closer: &Closes::default(),
            },
            &Terminal(true),
            &Leases::default(),
            recovery::RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
            &mut ledger,
        )
        .await;

        let log = tokio::process::Command::new("git")
            .args(["log", "--oneline", "origin/ISS-957", "-2"])
            .current_dir(&repo)
            .output()
            .await
            .unwrap();
        let landed = String::from_utf8_lossy(&log.stdout);
        assert!(
            landed.lines().count() >= 2,
            "the agent's work must be on the remote before the checkout is released, got:\n{landed}"
        );
        assert!(
            !wt.exists()
                && ledger
                    .as_ref()
                    .unwrap()
                    .run("run-1")
                    .unwrap()
                    .unwrap()
                    .ended_by
                    .is_some(),
            "with the diff preserved there is nothing left to hold the tree or the run"
        );
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(repo.with_extension("remote.git"));
    }

    /// The brace depth every statement of `sweep`'s own body sits at.
    fn depth_of_call_in_sweep(needle: &str) -> Option<usize> {
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        let sweep = production
            .split("async fn sweep(")
            .nth(1)
            .expect("sweep is gone");
        let body = &sweep[sweep.find('{')?..];
        let mut depth = 0usize;
        for (i, ch) in body.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return None;
                    }
                }
                _ => {}
            }
            if body[i..].starts_with(needle) {
                return Some(depth);
            }
        }
        None
    }

    #[test]
    fn the_sweep_reconciles_unconditionally() {
        assert_eq!(
            depth_of_call_in_sweep("give_back_lost_runs("),
            Some(1),
            "the sweep must reconcile what this box holds on EVERY pass; behind a condition, or gone, nothing beats a run session and core reaps every healthy one after ten minutes"
        );
    }

    #[test]
    fn the_sweep_tells_core_about_declared_runs_unconditionally() {
        assert_eq!(
            depth_of_call_in_sweep("run_record::open_declared_runs("),
            Some(1),
            "a declared run reaches core only from this call; behind a condition it reaches core on some sweeps and not others"
        );
        assert_eq!(
            depth_of_call_in_sweep("run_record::close_ended_runs("),
            Some(1),
            "a finished run is released only from this call; behind a condition its issues wait out core's ten-minute reaper instead"
        );
    }

    #[test]
    fn a_declaration_reaches_core_before_the_reconciler_reads_it() {
        let body = THIS_SOURCE
            .split("async fn sweep(")
            .nth(1)
            .expect("sweep must exist");
        let opens = body
            .find("run_record::open_declared_runs(")
            .expect("the sweep must tell core about declared runs");
        let reconciles = body
            .find("give_back_lost_runs(")
            .expect("the sweep must reconcile");
        assert!(
            opens < reconciles,
            "a run declared this sweep must reach core before the reconciler reads it as one that never started"
        );
    }

    #[test]
    fn the_account_is_reported_once_for_the_box_and_never_per_project() {
        assert_eq!(
            depth_of_call_in_sweep("report_account_limit("),
            Some(1),
            "the report must sit at the top level of the sweep, outside the project loop and under no condition"
        );
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        let sweep = production
            .split("async fn sweep(")
            .nth(1)
            .and_then(|r| r.split("\n/// ").next())
            .expect("sweep is gone");
        assert_eq!(
            sweep.matches("report_account_limit(").count(),
            1,
            "one decision per sweep means one call site"
        );
    }

    #[test]
    fn a_verdict_is_read_for_every_project_whose_pane_is_up() {
        assert!(
            depth_of_call_in_sweep("account_verdict(").unwrap_or(0) > 1,
            "the read belongs inside the project loop; only the decision is device-wide"
        );
    }

    /// The reporting path's own source, bounded to it.
    fn reporting_path() -> &'static str {
        THIS_SOURCE
            .split("async fn report_account_limit(")
            .nth(1)
            .and_then(|r| r.split("\n/// ").next())
            .expect("the reporting path is gone")
    }

    #[test]
    fn reporting_a_cap_ends_no_master() {
        for banned in [
            "end_master(",
            "master_api::close(",
            "terminal::kill(",
            "retire_if_idle(",
            "masters.forget(",
        ] {
            assert!(
                !reporting_path().contains(banned),
                "`{banned}` on the reporting path would make a cap a fault: work already running finishes, and only the STARTING of new turns backs off"
            );
        }
    }

    #[test]
    fn reporting_a_cap_changes_no_runner_status() {
        for banned in [
            "patch_runner(",
            "runners::patch",
            "\"draining\"",
            "\"disabled\"",
        ] {
            assert!(
                !reporting_path().contains(banned),
                "`{banned}` on the reporting path would quarantine the box; the limit column is what core stamps, and the status is an operator's decision"
            );
        }
    }

    #[test]
    fn the_decision_is_taken_against_the_sweeps_own_instant() {
        assert!(
            !reporting_path().contains("now_unix()"),
            "the reporting path must take the sweep's `now_unix` as an argument, never re-read the clock: re-read, every verdict silently ages by however long the project loop took"
        );
        assert!(
            reporting_path().contains("now_unix: i64"),
            "and it takes that instant as a parameter, so there is exactly one place the sweep's clock is read"
        );
    }

    #[test]
    fn every_limit_call_on_the_reporting_path_carries_a_deadline() {
        let path: String = reporting_path()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        for call in ["master_api::report_limit(", "master_api::clear_limit("] {
            assert!(
                path.contains(&format!("bounded({call}")),
                "`{call}` must go through `bounded`, or a core that accepts and never answers stops this box sweeping at all"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_core_that_accepts_and_never_answers_does_not_hold_the_sweep() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _held = listener.accept().await;
            std::future::pending::<()>().await;
        });
        let client = CoreClient::new(format!("http://{addr}"), String::from("tok"));

        match tokio::time::timeout(
            REPORT_TIMEOUT * 3,
            bounded(master_api::clear_limit(&client)),
        )
        .await
        {
            Ok(Err(e)) => assert!(
                e.to_string().contains("did not answer"),
                "the deadline must say what happened, got {e}"
            ),
            Ok(Ok(())) => panic!("core never answered, so this cannot have succeeded"),
            Err(_) => panic!(
                "the call outlived three times its own deadline — this box is stopped, not slowed"
            ),
        }
    }

    #[test]
    fn reporting_a_cap_touches_no_issue() {
        assert!(
            !reporting_path().contains("issue"),
            "nothing here may move, claim or release an issue: a cap says something about the account and nothing about the work"
        );
    }

    #[test]
    fn a_box_that_reported_a_cap_still_nudges_its_masters() {
        let nudge = depth_of_call_in_sweep("nudge_master(").expect("the nudge is gone");
        let report = depth_of_call_in_sweep("report_account_limit(").unwrap();
        assert!(
            nudge > report,
            "the nudge is inside the project loop and the report is not, so a limited sweep still prompts every master"
        );
    }

    fn admiss(issue_id: &str) -> AdmissibleIssue {
        serde_json::from_value(serde_json::json!({ "issueId": issue_id }))
            .expect("admissible fixture")
    }

    #[test]
    fn a_master_with_no_recorded_nudge_is_nudged() {
        assert!(nudge_due(None, 7, Instant::now()));
    }

    #[test]
    fn the_same_work_twice_in_a_row_is_not_nudged_twice() {
        let now = Instant::now();
        assert!(!nudge_due(Some((7, now)), 7, now));
    }

    #[test]
    fn changed_work_is_nudged_without_waiting_out_the_period() {
        let now = Instant::now();
        assert!(nudge_due(Some((7, now)), 8, now));
    }

    #[test]
    fn unchanged_work_is_nudged_again_once_the_period_is_up() {
        let now = Instant::now();
        let then = now
            .checked_sub(NUDGE_REFRESH)
            .expect("clock older than the refresh window");
        assert!(nudge_due(Some((7, then)), 7, now));
    }

    #[test]
    fn the_digest_does_not_move_when_the_rows_merely_swap_places() {
        let a = work_digest(&[admiss("i1"), admiss("i2")]);
        let b = work_digest(&[admiss("i2"), admiss("i1")]);
        assert_eq!(a, b);
    }

    #[test]
    fn the_digest_moves_when_a_row_arrives_or_leaves() {
        let one = work_digest(&[admiss("i1")]);
        assert_ne!(one, work_digest(&[admiss("i1"), admiss("i2")]));
        assert_ne!(one, work_digest(&[]));
    }

    #[test]
    fn the_digest_ignores_everything_but_the_ids() {
        let plain: AdmissibleIssue =
            serde_json::from_value(serde_json::json!({ "issueId": "i1" })).unwrap();
        let dressed: AdmissibleIssue = serde_json::from_value(serde_json::json!({
            "issueId": "i1", "title": "renamed", "priority": "critical",
            "status": "in_progress"
        }))
        .unwrap();
        assert_eq!(work_digest(&[plain]), work_digest(&[dressed]));
    }

    #[test]
    fn claim_nudge_records_so_the_next_sweep_is_held_back() {
        let masters = Arc::new(Masters::new());
        let session = master_api::MasterSession {
            session_id: "s1".into(),
            name: "forge-master-p1".into(),
            created: true,
        };
        remember(&masters, "p1", &session);

        assert!(
            masters.claim_nudge("p1", 7),
            "the first sight of work nudges"
        );
        assert!(
            !masters.claim_nudge("p1", 7),
            "the same work on the next sweep must not spend another pass"
        );
        assert!(masters.claim_nudge("p1", 8), "new work nudges at once");
    }

    #[test]
    fn a_project_with_no_master_is_never_nudged() {
        let masters = Masters::new();
        assert!(!masters.claim_nudge("nobody", 7));
    }

    #[test]
    fn every_nudge_in_the_sweep_is_gated_on_claim_nudge() {
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        let sites: Vec<&str> = production
            .match_indices("nudge_master(")
            .map(|(i, _)| &production[i.saturating_sub(260)..i])
            .filter(|before| !before.ends_with("async fn ") && !before.ends_with("fn "))
            .collect();
        let calls = sites.len();
        assert_eq!(
            calls, 1,
            "expected exactly one nudge_master call site in production; found {calls}"
        );
        for before in sites {
            assert!(
                before.contains("claim_nudge("),
                "a nudge_master call must sit inside a claim_nudge gate — an ungated one spends a full agent pass on every sweep (~$0.18, measured 2026-09-08)"
            );
        }
    }
}

#[cfg(test)]
impl Masters {
    /// Put a master in the registry without spawning one.
    pub fn remember_for_test(&self, project_id: &str, session_id: &str, name: &str) {
        self.remember(
            project_id,
            MasterState {
                session_id: session_id.to_string(),
                name: name.to_string(),
                last_work: Instant::now(),
                last_nudge: None,
                mcp_stale_reported: false,
            },
        );
    }
}
