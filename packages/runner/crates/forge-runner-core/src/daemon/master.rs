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
use crate::daemon::pool_jobs::{self, JobPanes, Records};
use crate::daemon::recovery;
use crate::daemon::recovery_ports::{CoreBeat, CoreRunState, PaneMasters, SignalProbe};
use crate::daemon::run_exit;
use crate::daemon::run_record;
use crate::daemon::session_tokens;
use crate::daemon::terminal;
use crate::runner::close_loop;
use crate::runner::ledger::{Ledger, Run};
use crate::runner::terminate;
use crate::transport::admissible::{self, AdmissibleIssue, DISPATCH_GATING_KIND};
use crate::transport::{master as master_api, mcp_servers, runners, CoreClient};
use tokio::sync::mpsc;

const POLL_INTERVAL: Duration = Duration::from_secs(30);

const WAKE_FLOOR: Duration = Duration::from_secs(5);

pub(crate) const NUDGE_REFRESH: Duration = Duration::from_secs(5 * 60);

pub(crate) const LIMITED_POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);

fn standing_prompt(
    project: &str,
    base_branch: Option<&str>,
    master_policy: Option<&str>,
    dropped: &[String],
    servers_unreadable: bool,
    reach: &crate::mcp::config::PaneReach,
) -> String {
    let mut out = format!(
        "Use the `forge-master` skill. You are the resident master for project `{project}` on \
this box, and you will be woken again in this same session rather than started fresh.\n"
    );
    if let Some(base) = base_branch {
        out.push_str(&format!(
            "\nYou are standing in this project's checkout, on its base branch `{base}`.\n"
        ));
    }
    // The reach is what this pane HOLDS, read off the two files it will be
    // started with. `dropped` and `servers_unreadable` below are what core
    // ASKED for; a pane told only those two still cannot say what it has.
    out.push_str(&reach.brief());
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
            "\nThis project declares MCP server(s) this box could NOT supply: {}. Work you hand \
out will not have their tools. An issue whose work needs one of them cannot be built here — say so \
on the issue rather than parking it as a run that failed.\n",
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

#[derive(Default)]
pub struct Masters(Arc<Mutex<Registry>>);

/// The live masters, and what this box has seen the dead ones do.
#[derive(Default)]
struct Registry {
    live: HashMap<String, MasterState>,
    /// What the last sweep read as this box's projects.
    served: Served,
    /// Why each project's master pane was not placed on the last sweep.
    unplaced: HashMap<String, Unplaced>,
}

#[derive(Default, Clone, PartialEq, Eq)]
pub(crate) enum Served {
    /// No sweep has read the list yet.
    #[default]
    Unread,
    /// The last read failed, and this is what it said.
    Unreadable(String),
    /// The project ids core last answered for this device.
    Read(Vec<String>),
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum Unplaced {
    /// The runner row refuses new work, so this sweep placed no pane for it.
    Draining {
        status: String,
    },
    /// Core serves this project to this box but nothing here says where the
    /// checkout is.
    NoRepoPath,
    /// This box has no terminal multiplexer, so it can host no master at all.
    NoTerminal,
    /// Core refused the registration this pane's identity comes from.
    RegisterFailed {
        detail: String,
    },
    /// The pane could not be given the skill it runs on, so none was started.
    SkillMissing {
        detail: String,
    },
    NothingAdmissible,
}

impl std::fmt::Display for Unplaced {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Draining { status } => write!(
                f,
                "this box's runner for it is `{status}`, so it starts no work and places no master until that changes"
            ),
            Self::NoRepoPath => write!(
                f,
                "core serves it to this box but nothing here says where its checkout is — bind it, or set the runner's repo_path"
            ),
            Self::NoTerminal => write!(
                f,
                "this box has no tmux, so it can host no master pane for any project"
            ),
            Self::RegisterFailed { detail } => write!(
                f,
                "core refused this box's master registration for it: {detail}"
            ),
            Self::SkillMissing { detail } => write!(
                f,
                "the forge-master skill could not be installed into its checkout: {detail}"
            ),
            Self::NothingAdmissible => write!(
                f,
                "it has nothing claimable and no pane of its own running, so this box started none"
            ),
        }
    }
}

struct MasterState {
    session_id: String,
    name: String,
    /// When this project's pool last held anything at all.
    last_work: Instant,
    /// The work this master was last nudged about, when, and what its own hooks
    /// had reported by then.
    last_nudge: Option<Nudge>,
    mcp_stale_reported: bool,
}

/// One nudge, and the evidence a later sweep judges it by.
#[derive(Debug, Clone, Copy)]
struct Nudge {
    digest: u64,
    at: Instant,
    /// The master's submitted-prompt count at the moment it was nudged, or `None`
    /// where the session had never reported to `agent_activity` at all. A later
    /// count strictly above this one is the proof that a turn BEGAN after the
    /// nudge, which is the only thing that makes the nudge answered.
    prompts: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SinceNudge {
    Unreported,
    /// Not one prompt submitted since the nudge: it is sitting in a composer, or
    /// the pane never ran it.
    NoTurn,
    /// A turn began after the nudge and is still running, or a child of it is.
    Working,
    /// A turn began after the nudge and stopped on a question a human owes.
    AwaitingPermission,
    /// A turn began after the nudge and ended on an API or model error.
    Failed,
    /// A turn began after the nudge and ended.
    Ran,
}

/// Read the evidence for one master, off what that session reported.
fn since_nudge(seen: Option<&agent_activity::Activity>, sent_at: Option<u64>) -> SinceNudge {
    let (Some(now), Some(then)) = (seen, sent_at) else {
        return SinceNudge::Unreported;
    };
    if now.prompts <= then {
        return SinceNudge::NoTurn;
    }
    match now.doing() {
        agent_activity::Doing::Working => SinceNudge::Working,
        agent_activity::Doing::AwaitingPermission => SinceNudge::AwaitingPermission,
        agent_activity::Doing::Idle => {
            if now.turn_ended_failed {
                SinceNudge::Failed
            } else {
                SinceNudge::Ran
            }
        }
    }
}

fn retry_owed(since: SinceNudge) -> bool {
    match since {
        SinceNudge::Unreported | SinceNudge::NoTurn | SinceNudge::Failed => true,
        SinceNudge::Working | SinceNudge::AwaitingPermission | SinceNudge::Ran => false,
    }
}

fn work_digest(admissible: &[AdmissibleIssue]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut lines: Vec<String> = Vec::with_capacity(admissible.len());
    for a in admissible {
        let mut rels: Vec<String> = a
            .relations
            .iter()
            .filter(|r| r.kind == DISPATCH_GATING_KIND)
            .map(|r| {
                format!(
                    "{}|{}",
                    r.depends_on_key.as_deref().unwrap_or(""),
                    r.blocker_status.as_deref().unwrap_or(""),
                )
            })
            .collect();
        rels.sort_unstable();
        lines.push(format!(
            "issue:{}|{}|{}",
            a.issue_id,
            a.status,
            rels.join(";")
        ));
    }
    lines.sort_unstable();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for line in lines {
        line.hash(&mut h);
    }
    h.finish()
}

fn nudge_due(prev: Option<Nudge>, digest: u64, now: Instant, since: SinceNudge) -> bool {
    match prev {
        None => true,
        Some(last) if last.digest != digest => true,
        Some(last) => now.saturating_duration_since(last.at) >= NUDGE_REFRESH && retry_owed(since),
    }
}

impl Masters {
    pub fn new() -> Self {
        Self::default()
    }

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

    fn claim_nudge(
        &self,
        project_id: &str,
        digest: u64,
        seen: Option<&agent_activity::Activity>,
    ) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let Some(m) = reg.live.get_mut(project_id) else {
            return false;
        };
        let now = Instant::now();
        let since = since_nudge(seen, m.last_nudge.and_then(|n| n.prompts));
        if !nudge_due(m.last_nudge, digest, now, since) {
            return false;
        }
        m.last_nudge = Some(Nudge {
            digest,
            at: now,
            prompts: seen.map(|a| a.prompts),
        });
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

    pub fn project_for_session(&self, session_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .iter()
            .find(|(_, m)| m.session_id == session_id)
            .map(|(project_id, _)| project_id.clone())
    }

    /// Record what core just answered for this device, or why it could not be
    /// read.
    pub(crate) fn note_served(&self, served: Served) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.served = served;
    }

    pub(crate) fn note_unplaced(&self, project_id: &str, why: Unplaced) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let changed = reg.unplaced.get(project_id) != Some(&why);
        reg.unplaced.insert(project_id.to_string(), why);
        changed
    }

    /// This project's pane was placed; nothing stands against it any more.
    pub(crate) fn clear_unplaced(&self, project_id: &str) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.unplaced.remove(project_id);
    }

    pub fn why_unplaced(&self, project_id: &str) -> String {
        let reg = self.0.lock().expect("masters poisoned");
        if let Some(m) = reg.live.get(project_id) {
            return format!(
                "this box's master for {project_id} is session {} in pane {}, and your capability names a different session — it was minted for a session core has since replaced, so this pane's capability is stale and nothing this daemon does will place it. A pane cannot be handed a new capability: end this one, and a fresh master starts for {project_id} in its place",
                m.session_id, m.name
            );
        }
        match &reg.served {
            Served::Unread => format!(
                "this box has not yet read which projects it serves, so it cannot say whether it serves {project_id} at all — nothing here has an answer for you yet"
            ),
            Served::Unreadable(why) => format!(
                "this box could not read which projects it serves ({why}), so it cannot say whether it serves {project_id} at all — nothing here has an answer for you yet"
            ),
            Served::Read(ids) if !ids.iter().any(|id| id == project_id) => format!(
                "this box does not serve {project_id} — core's last answer for this device named {} project(s) and that was not one of them, so no sweep here will place a master for it",
                ids.len()
            ),
            Served::Read(_) => match reg.unplaced.get(project_id) {
                Some(why) => format!(
                    "this daemon has placed no master for {project_id}: {why}. That is the state its last sweep found, and the next sweep finds the same until it changes"
                ),
                None => format!(
                    "this daemon does not yet hold a master session for {project_id}; its next sweep places one, and a declaration made after that is served"
                ),
            },
        }
    }

    pub fn pane_for_session(&self, session_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .values()
            .find(|m| m.session_id == session_id)
            .map(|m| m.name.clone())
    }
}

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

pub async fn run(
    client: CoreClient,
    cfg: Config,
    masters: Arc<Masters>,
    activity: Arc<agent_activity::Activities>,
    job_panes: Arc<JobPanes>,
    job_records: Arc<dyn Records>,
    adopted: tokio::sync::watch::Receiver<bool>,
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
                delay = sweep(&client, &cfg, &masters, &activity, &job_panes, job_records.as_ref(), &adopted, &mut ledger, &mut account_limit_said)
                    .await;
                last_sweep = Instant::now();
            }
            Some(w) = wake.recv() => {
                let since = last_sweep.elapsed();
                if since < WAKE_FLOOR {
                    tokio::time::sleep(WAKE_FLOOR - since).await;
                }
                tracing::info!("[master] wake ({}) — sweeping now", w.describe());
                delay = sweep(&client, &cfg, &masters, &activity, &job_panes, job_records.as_ref(), &adopted, &mut ledger, &mut account_limit_said)
                    .await;
                last_sweep = Instant::now();
            }
            _ = cancel.changed() => { if *cancel.borrow() { break; } }
        }
    }
}

fn accepts_new_work(status: &str) -> bool {
    !matches!(status, "draining" | "disabled")
}

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

async fn sweep(
    client: &CoreClient,
    cfg: &Config,
    masters: &Arc<Masters>,
    activity: &agent_activity::Activities,
    job_panes: &Arc<JobPanes>,
    job_records: &dyn Records,
    adopted: &tokio::sync::watch::Receiver<bool>,
    ledger: &mut Option<Ledger>,
    account_limit_said: &mut Option<String>,
) -> Duration {
    let now_unix = master_limit::now_unix();
    let mut account_said: Vec<master_limit::Decisive> = Vec::new();
    let served = match runners::list_me(client).await {
        Ok(rs) => rs,
        Err(e) => {
            tracing::warn!("[master] cannot read this box's projects: {e}");
            masters.note_served(Served::Unreadable(e.to_string()));
            return POLL_INTERVAL;
        }
    };
    masters.note_served(Served::Read(
        served.iter().map(|r| r.project_id.clone()).collect(),
    ));
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
            masters.note_unplaced(
                &runner.project_id,
                Unplaced::Draining {
                    status: runner.status.clone(),
                },
            );
            supervise(client, masters, &runner.project_id, &runner.slug).await;
            continue;
        }
        supervise(client, masters, &runner.project_id, &runner.slug).await;
        take_pool_job(
            client,
            cfg,
            &served,
            job_panes,
            job_records,
            adopted,
            runner,
        )
        .await;

        let admissible = admissible::admissible(client, Some(&runner.project_id))
            .await
            .unwrap_or_default();
        let placement = placement_for(&admissible);
        if placement == Placement::AdoptOnly {
            if retire_if_idle(client, masters, ledger, &runner.project_id, &runner.slug).await {
                continue;
            }
        } else {
            masters.note_work(&runner.project_id);
        }

        let resolved = match resolve_repo(&served, cfg, &runner.project_id) {
            Ok(r) => r,
            Err(slug) => {
                if !admissible.is_empty() {
                    tracing::error!(
                        "[master] {slug} has claimable work but no repo path on this box — no master will run for it; bind it or set the runner's repo_path"
                    );
                }
                say_unplaced(masters, &runner.project_id, &slug, Unplaced::NoRepoPath);
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
            placement,
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

        let reported = masters
            .get(&runner.project_id)
            .and_then(|(session_id, _)| activity.get(&session_id));
        if masters.claim_nudge(
            &runner.project_id,
            work_digest(&admissible),
            reported.as_ref(),
        ) {
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

const REPORT_TIMEOUT: Duration = Duration::from_secs(10);

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

async fn take_pool_job(
    client: &CoreClient,
    cfg: &Config,
    served: &[runners::MeRunner],
    job_panes: &Arc<JobPanes>,
    job_records: &dyn Records,
    adopted: &tokio::sync::watch::Receiver<bool>,
    runner: &runners::MeRunner,
) {
    if !*adopted.borrow() {
        return;
    }
    let bound = cfg.runner.max_job_panes.max(1) as usize;
    let fallback = resolve_repo(served, cfg, &runner.project_id)
        .ok()
        .map(|r| r.repo_path);
    let tokens = session_tokens::default_path().map(session_tokens::SessionTokens::at);
    let took = pool_jobs::take_one(
        &pool_jobs::CorePool { client, limit: 20 },
        &pool_jobs::TmuxPanes,
        &pool_jobs::CoreReport { client },
        job_records,
        job_panes,
        &runner.project_id,
        job_panes.session_id(),
        fallback.as_deref(),
        bound,
        tokens.as_ref(),
    )
    .await;
    if let pool_jobs::Took::AtBound = took {
        tracing::info!(
            "[master] {}: {} job pane(s) already open on this box (max_job_panes = {bound}) — taking no more this pass",
            runner.slug,
            job_panes.count()
        );
    }
}

struct Reclaim<'a> {
    served: &'a [runners::MeRunner],
    cfg: &'a Config,
    procs: &'a dyn recovery::ProcessLiveness,
    killer: &'a dyn terminate::ProcessGroup,
    closer: &'a dyn close_loop::RunCloser,
}

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

const MASTER_SKILL: &str = include_str!("../../assets/forge-master-skill.md");

/// Write the skill where the session about to start will look for it.
fn install_skill(repo: &std::path::Path) -> std::io::Result<()> {
    let dir = repo.join(".claude/skills/forge-master");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("SKILL.md"), MASTER_SKILL)
}

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
        let Some(choice) = run.resume_choice.clone() else {
            continue;
        };
        let Some(session_id) = run.session_id.clone() else {
            tracing::warn!(
                "[master] run {}: this pane chose to {choice} and the choice cannot reach its issue — the run has no core session, which is what a run whose subagent never started looks like. It stands in the box ledger and nowhere a reader will find it",
                run.run_id
            );
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

pub(crate) struct InheritedRun {
    pub run_id: String,
    pub issue_keys: Vec<String>,
    pub worktree_path: String,
    pub incarnation: &'static str,
    pub work: &'static str,
    pub agent_id: Option<String>,
    pub ended_by: Option<String>,
}

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

fn transcript_path(slug: &str) -> Option<std::path::PathBuf> {
    let dir = Config::path().ok()?.with_file_name("master").join(slug);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("transcript.log"))
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Placement {
    /// Adopt a live pane, and start one where there is none.
    AdoptOrStart,
    /// Adopt a live pane, and start nothing.
    AdoptOnly,
}

pub(crate) fn placement_for(admissible: &[AdmissibleIssue]) -> Placement {
    if admissible.is_empty() {
        Placement::AdoptOnly
    } else {
        Placement::AdoptOrStart
    }
}

async fn ensure_master(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    resolved: &crate::daemon::dispatch::Resolved,
    stored_conversation: Option<&str>,
    inherited: &[InheritedRun],
    placement: Placement,
) -> PaneState {
    let name = terminal::session_name(terminal::MASTER_PREFIX, &resolved.slug);
    if !terminal::available() {
        tracing::error!(
            "[master] {}: tmux is not installed on this box — no master will run for it; install tmux (`forge-runner doctor` checks for it)",
            resolved.slug
        );
        say_unplaced(masters, project_id, &resolved.slug, Unplaced::NoTerminal);
        return PaneState::Absent;
    }

    if placement == Placement::AdoptOnly && !terminal::alive(&name).await {
        say_unplaced(
            masters,
            project_id,
            &resolved.slug,
            Unplaced::NothingAdmissible,
        );
        return PaneState::Absent;
    }

    let session = match master_api::register(client, project_id, &name).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("[master] {}: cannot register with core: {e}", resolved.slug);
            say_unplaced(
                masters,
                project_id,
                &resolved.slug,
                Unplaced::RegisterFailed {
                    detail: e.to_string(),
                },
            );
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
            if session.created {
                tracing::error!(
                    "[master] {}: adopted the resident session {name} onto a master session core created fresh ({}) — whatever capability that pane was started with names a session this box no longer holds, so its declarations are refused until it is replaced. A pane cannot be handed a new capability: `tmux kill-session -t {name}` and the next sweep starts one that carries the current session.",
                    resolved.slug,
                    session.session_id
                );
            }
            remember(masters, project_id, &session);
        }
        masters.clear_unplaced(project_id);
        return PaneState::Adopted;
    }

    if placement == Placement::AdoptOnly {
        say_unplaced(
            masters,
            project_id,
            &resolved.slug,
            Unplaced::NothingAdmissible,
        );
        return PaneState::Absent;
    }

    if let Err(e) = install_skill(&resolved.repo_path) {
        tracing::error!(
            "[master] {}: could not install the forge-master skill into {}: {e} — not starting a master",
            resolved.slug,
            resolved.repo_path.display()
        );
        say_unplaced(
            masters,
            project_id,
            &resolved.slug,
            Unplaced::SkillMissing {
                detail: e.to_string(),
            },
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
    masters.clear_unplaced(project_id);

    let reach = crate::mcp::config::pane_reach(&resolved.repo_path, mcp_config.as_deref());
    match reach.forge() {
        crate::mcp::config::ForgeReach::Declared => {
            tracing::info!("[master] {}: pane {}", resolved.slug, reach.verdict())
        }
        _ => tracing::warn!(
            "[master] {}: pane {} — the pane is told this in its own brief, which is the only \
surface it reads",
            resolved.slug,
            reach.verdict()
        ),
    }
    let brief = standing_prompt(
        &resolved.slug,
        resolved.base_branch.as_deref(),
        resolved.master_policy.as_deref(),
        &declared.dropped_names,
        asked.is_none(),
        &reach,
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

fn say_unplaced(masters: &Arc<Masters>, project_id: &str, slug: &str, why: Unplaced) {
    if masters.note_unplaced(project_id, why.clone()) {
        tracing::warn!("[master] {slug}: no master pane placed — {why}");
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

fn nudge() -> String {
    "Pass. Hand it to the dispatch skill, and say what you dispatched and why you did not dispatch the rest.".into()
}

async fn nudge_master(masters: &Arc<Masters>, project_id: &str, slug: &str) {
    let Some((_, name)) = masters.get(project_id) else {
        return;
    };
    tracing::info!("[master] {slug}: admissible work — nudging {name}");
    if let Err(e) = terminal::send_line(&name, &nudge()).await {
        tracing::warn!("[master] {slug}: could not nudge {name}: {e}");
    }
}

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

    /// The four issue-less kinds are claimed on every sweep, not only when the
    /// admissible set has something in it.
    ///
    /// The two sets do not overlap: `devices/pool.ts:readPool` serves
    /// `release_batch`, `smoke`, `reconcile` and `verify_skill`, and
    /// `admissible` serves issues. A claim gated on a non-empty admissible set
    /// would leave a project whose only work is a release with its pool unread
    /// for ever — which is the whole of ISS-1080, arriving through the call site
    /// rather than the reader.
    #[test]
    fn the_pool_is_read_before_the_sweep_can_decide_there_is_nothing_to_do() {
        let body = THIS_SOURCE
            .split("\nasync fn sweep(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .unwrap_or_default();
        let claim = body
            .find("take_pool_job(")
            .expect("the sweep must claim from the JOBS pool");
        let admissible_empty = body
            .find("if admissible.is_empty()")
            .expect("the sweep still has its admissible branch");
        assert!(
            claim < admissible_empty,
            "the pool claim has to run BEFORE the branch that gives up on a project with nothing admissible, or a release is the one job kind no box ever reads (ISS-1080)"
        );
    }

    /// A drained runner claims nothing new.
    ///
    /// `accepts_new_work` is the box's answer to core taking a project off it,
    /// and a pool job is new work like any other. What a drain must NOT stop is
    /// the supervision of a pane already open, which lives on its own tick in
    /// `daemon/mod.rs` and never reads this flag.
    #[test]
    fn a_drained_runner_takes_no_pool_job() {
        let body = THIS_SOURCE
            .split("\nasync fn sweep(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .unwrap_or_default();
        let drain = body
            .find("if !accepts_new_work(&runner.status)")
            .expect("the sweep still has its drain branch");
        let claim = body
            .find("take_pool_job(")
            .expect("the sweep must claim from the JOBS pool");
        assert!(
            drain < claim,
            "the drain branch `continue`s before the claim, so a runner core has taken off work must reach it first"
        );
    }

    /// Nothing is claimed before adoption has run.
    ///
    /// `pool_jobs::adopt` compares what this box recorded against what it is
    /// running, as two snapshots. A claim landing between them looks to it like
    /// a job whose pane did not survive, so a box that claimed first would make
    /// a fresh release the likeliest thing it reports dead.
    #[test]
    fn no_pool_job_is_claimed_before_adoption_has_run() {
        let body = THIS_SOURCE
            .split("async fn take_pool_job(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .unwrap_or_default();
        let barrier = body
            .find("if !*adopted.borrow()")
            .expect("the claim is gated on adoption having run");
        let claim = body
            .find("pool_jobs::take_one(")
            .expect("the claim is here");
        assert!(
            barrier < claim,
            "the barrier has to precede the claim, or it gates nothing (ISS-1080)"
        );
    }

    #[test]
    fn the_job_pane_bound_comes_from_this_boxs_own_config() {
        let body = THIS_SOURCE
            .split("async fn take_pool_job(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .unwrap_or_default();
        assert!(
            body.contains("cfg.runner.max_job_panes"),
            "the ceiling is the operator's `[runner] max_job_panes`, read here — a constant would make every box on the fleet identical and unfixable without a release"
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
    fn the_skill_quotes_the_refusal_it_will_meet() {
        let first_sentence = crate::daemon::dispatch_gate::REFUSAL
            .split_once(". ")
            .map(|(head, _)| format!("{head}."))
            .expect("the refusal opens with a sentence");
        assert!(
            MASTER_SKILL.contains(&first_sentence),
            "a master reading the skill must recognise the refusal when it arrives; \
             the skill does not carry `{first_sentence}`"
        );
    }

    /// Criterion 33. The skill says the declaration is enforced, not advised.
    #[test]
    fn the_skill_says_the_declaration_is_a_condition_and_not_a_suggestion() {
        assert!(
            MASTER_SKILL.contains("no longer advice"),
            "the skill described a rule nothing enforced for four days; it must now say which it is"
        );
        assert!(MASTER_SKILL.contains("forge-runner run declare"));
        assert!(
            MASTER_SKILL.contains("forge-runner run close"),
            "a master holding a spent declaration needs the way out named where it reads"
        );
    }

    #[test]
    fn the_skill_carries_no_flags_and_points_at_the_surface_that_cannot_go_stale() {
        for flag in [
            "--project",
            "--issue",
            "--worktree",
            "--reason",
            "--decision",
        ] {
            assert!(
                !MASTER_SKILL.contains(flag),
                "`{flag}` is the CLI's to describe: it ships on a different clock from this file"
            );
        }
        assert!(
            MASTER_SKILL.contains("-h"),
            "the skill must send a master to the self-describing surface instead"
        );
    }

    #[test]
    fn the_owner_policy_reaches_the_brief_verbatim() {
        let policy = "Budget: 5 sessions.\nDrafts are eligible work.\nGroup related issues.";
        let brief = standing_prompt(
            "forge-dev",
            Some("main"),
            Some(policy),
            &[],
            false,
            &healthy_reach("the_owner_policy_reaches_the_brief_verbatim"),
        );
        assert!(
            brief.contains(policy),
            "the policy must be spliced whole: {brief}"
        );
        assert!(
            brief.contains("OUTRANKS"),
            "the brief must say the policy beats the skill's defaults: {brief}"
        );
    }

    /// A [`PaneReach`] over two real files, which is the only way one is built.
    ///
    /// The directory carries the test's own label and this process's id: two
    /// `cargo test` runs on one box must not share a path (ISS-1073).
    struct ReachFiles(std::path::PathBuf);

    impl ReachFiles {
        fn new(label: &str, repo: Option<&str>, session: Option<&str>) -> Self {
            let dir =
                std::env::temp_dir().join(format!("forge-reach-{label}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp reach dir");
            if let Some(body) = repo {
                std::fs::write(dir.join(".mcp.json"), body).expect("repo .mcp.json");
            }
            if let Some(body) = session {
                std::fs::write(dir.join("session.json"), body).expect("session config");
            }
            Self(dir)
        }

        fn reach(&self, has_pat: bool) -> crate::mcp::config::PaneReach {
            let session = self.0.join("session.json");
            crate::mcp::config::pane_reach_in(
                &self.0,
                session.exists().then_some(session.as_path()),
                has_pat,
            )
        }
    }

    impl Drop for ReachFiles {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn declares(names: &[&str]) -> String {
        let body: Vec<String> = names
            .iter()
            .map(|n| format!("\"{n}\": {{ \"type\": \"http\", \"url\": \"https://x/mcp\" }}"))
            .collect();
        format!("{{ \"mcpServers\": {{ {} }} }}", body.join(", "))
    }

    fn reach_of(
        label: &str,
        repo: Option<&[&str]>,
        session: Option<&[&str]>,
        has_pat: bool,
    ) -> crate::mcp::config::PaneReach {
        ReachFiles::new(
            label,
            repo.map(declares).as_deref(),
            session.map(declares).as_deref(),
        )
        .reach(has_pat)
    }

    /// The reach of a box that is provisioned: `forge` from the checkout,
    /// `playwright` from the session config, an operator PAT stored.
    fn healthy_reach(label: &str) -> crate::mcp::config::PaneReach {
        reach_of(label, Some(&["forge"]), Some(&["playwright"]), true)
    }

    const STANDING_BRIEF: &str = "Use the `forge-master` skill. You are the resident master for project `forge-dev` on this box, and you will be woken again in this same session rather than started fresh.\n\nYou are standing in this project's checkout, on its base branch `main`.\n";

    #[test]
    fn the_standing_brief_is_only_what_a_wave_cannot_know() {
        let reach = healthy_reach("the_standing_brief_is_only_what_a_wave_cannot_know");
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], false, &reach);
        assert_eq!(
            brief,
            format!("{STANDING_BRIEF}{}", reach.brief()),
            "the standing brief may say only what the skill cannot: which project, which box, \
             which branch, and which MCP servers this box's two config files put within this \
             pane's reach. Every rule about how a run works belongs in forge-master-skill.md, and \
             a copy here is the pair ISS-1080 broke"
        );
    }

    #[test]
    fn the_brief_no_longer_carries_the_two_claims_that_stopped_masters_declaring() {
        let brief = standing_prompt(
            "forge-dev",
            Some("main"),
            None,
            &[],
            false,
            &healthy_reach(
                "the_brief_no_longer_carries_the_two_claims_that_stopped_masters_declaring",
            ),
        );
        assert!(
            !brief.contains("no job pool") && !brief.contains("second terminal"),
            "the job pool and its second terminal came back with ISS-1080 and are on every box: {brief}"
        );
        assert!(
            !brief.contains("whole record of a run"),
            "the lease stopped being the whole record on 2026-09-13; a master told otherwise does not declare: {brief}"
        );
    }

    #[test]
    fn the_brief_states_no_rule_the_skill_file_owns() {
        let brief = standing_prompt(
            "forge-dev",
            Some("main"),
            None,
            &["playwright".into()],
            true,
            &healthy_reach("the_brief_states_no_rule_the_skill_file_owns"),
        )
        .to_lowercase();
        for owned in [
            "job pool",
            "second terminal",
            "run declare",
            "the lease",
            "worktree",
            "subagent",
            "shipped role",
        ] {
            assert!(
                !brief.contains(owned),
                "`{owned}` names how a run works, which forge-master-skill.md owns: {brief}"
            );
        }
    }

    /// Criterion 32. The owner is spliced whole, banned vocabulary and all.
    #[test]
    fn the_owner_policy_survives_words_the_brief_itself_may_not_use() {
        let policy = "Declare every run. Two subagents at a time, each in its own worktree.";
        let brief = standing_prompt(
            "forge-dev",
            Some("main"),
            Some(policy),
            &[],
            false,
            &healthy_reach("the_owner_policy_survives_words_the_brief_itself_may_not_use"),
        );
        assert!(
            brief.contains(policy),
            "the owner is a courier's cargo, not this box's prose to police: {brief}"
        );
    }

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
        let unreadable = standing_prompt(
            "mowment",
            Some("main"),
            None,
            &[],
            true,
            &healthy_reach("a_box_that_could_not_read_the_declaration_says_so_in_its_own_words"),
        );
        assert!(
            unreadable.contains("could NOT read this project's declared MCP servers"),
            "{unreadable}"
        );
        assert!(
            !unreadable.contains("could NOT supply"),
            "an unreadable declaration must not be reported as a named shortfall: {unreadable}"
        );

        let readable = standing_prompt(
            "mowment",
            Some("main"),
            None,
            &[],
            false,
            &healthy_reach("a_box_that_could_not_read_the_declaration_says_so_in_its_own_words-b"),
        );
        assert!(
            !readable.contains("could NOT read"),
            "a project core answered for must be told nothing about readability: {readable}"
        );
    }

    /// ISS-1114, the measured state: a checkout with no `.mcp.json`, a session
    /// config declaring `playwright` alone, and no operator PAT on the box.
    ///
    /// The assertions are on the EXPLANATION and not on the word `forge`, so a
    /// brief that merely announced the server would fail this too.
    #[test]
    fn the_cold_pane_is_told_forge_is_absent_and_why() {
        let reach = reach_of(
            "the_cold_pane_is_told_forge_is_absent_and_why",
            None,
            Some(&["playwright"]),
            false,
        );
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], false, &reach);
        assert!(
            brief.contains("The `forge` MCP server is in NEITHER half"),
            "a pane whose union holds no `forge` is told nothing about it: {brief}"
        );
        assert!(
            brief.contains("forge_github"),
            "the pane is not told which capability went with it: {brief}"
        );
        assert!(
            brief.contains("Absent is not refused"),
            "the pane is not told absent and refused are different, which is the whole \
             finding: {brief}"
        );
        assert!(
            brief.contains("no operator PAT is stored on this box either")
                && brief.contains("forge-runner login --pat"),
            "the pane is not given the cause or the one command that ends it: {brief}"
        );
        assert!(
            brief.contains("playwright"),
            "the pane is not told what it DOES hold: {brief}"
        );
    }

    /// The false alarm the issue body's own Rule would have shipped: this box,
    /// on the day it was measured, had `forge` in its checkout and `playwright`
    /// alone in its session config. A gate keyed to the session writer fires
    /// here, where nothing is wrong.
    #[test]
    fn a_provisioned_pane_is_told_its_union_and_nothing_is_raised() {
        let reach = healthy_reach("a_provisioned_pane_is_told_its_union_and_nothing_is_raised");
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], false, &reach);
        assert!(
            brief.contains("forge, playwright"),
            "a healthy pane is not told the union it holds: {brief}"
        );
        for alarm in [
            "NEITHER half",
            "ABSENT",
            "forge-runner login",
            "UNDETERMINED",
            "could NOT be determined",
        ] {
            assert!(
                !brief.contains(alarm),
                "`{alarm}` is an alarm on a box where `forge` is present the whole time: {brief}"
            );
        }
    }

    /// Presence is a declaration and never a working route. A `forge` entry
    /// carrying a credential that would answer 401 is still declared, and the
    /// brief must claim nothing more than that about it.
    #[test]
    fn a_declared_forge_is_never_reported_as_a_working_one() {
        let reach = healthy_reach("a_declared_forge_is_never_reported_as_a_working_one");
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], false, &reach);
        assert!(
            brief.contains("That is what those two files DECLARE")
                && brief.contains("Nothing here has checked that any of them answers"),
            "the brief must say these servers are declared, not that they work: {brief}"
        );
    }

    /// A stored PAT changes the cause and not the verdict: the entry should be
    /// in the checkout and is not, so the checkout is what has to be fixed.
    #[test]
    fn a_stored_pat_with_no_forge_entry_names_the_unprovisioned_checkout() {
        let reach = reach_of(
            "a_stored_pat_with_no_forge_entry_names_the_unprovisioned_checkout",
            Some(&["playwright"]),
            None,
            true,
        );
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], false, &reach);
        assert!(
            brief.contains("The `forge` MCP server is in NEITHER half"),
            "{brief}"
        );
        assert!(
            brief.contains("DOES hold an operator PAT")
                && brief.contains("Re-provision this checkout on this box"),
            "a box with a PAT must be sent to its checkout, not to `login`: {brief}"
        );
        assert!(
            !brief.contains("forge-runner login"),
            "a box that is already paired must not be told to pair: {brief}"
        );
    }

    /// A half that could not be read is not a half that declares nothing, and
    /// a diagnosis built on it would be the very substitution this issue is
    /// about, one layer along.
    #[test]
    fn an_unreadable_half_is_undetermined_rather_than_absent() {
        let files = ReachFiles::new(
            "an_unreadable_half_is_undetermined_rather_than_absent",
            Some("{ this is not json"),
            Some(&declares(&["playwright"])),
        );
        for has_pat in [false, true] {
            let brief = standing_prompt(
                "forge-dev",
                Some("main"),
                None,
                &[],
                false,
                &files.reach(has_pat),
            );
            assert!(
                brief.contains("could NOT be determined"),
                "an unreadable half must be reported as unknown: {brief}"
            );
            assert!(
                !brief.contains("NEITHER half") && !brief.contains("is ABSENT from this pane"),
                "an unreadable half must never be reported as an absence: {brief}"
            );
            for cause in [
                "forge-runner login",
                "Re-provision this checkout",
                "What is observed",
            ] {
                assert!(
                    !brief.contains(cause),
                    "`{cause}` is a cause for an absence nobody established: {brief}"
                );
            }
        }
    }

    #[test]
    fn a_declared_server_this_box_cannot_supply_is_named_in_the_brief() {
        let dropped = vec!["epodsystem".to_string(), "postman".to_string()];
        let brief = standing_prompt(
            "mowment",
            Some("main"),
            None,
            &dropped,
            false,
            &healthy_reach("a_declared_server_this_box_cannot_supply_is_named_in_the_brief"),
        );
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

    pub(super) fn logged_while(f: impl FnOnce()) -> String {
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
        // Why a capture needs this: `crate::daemon::keep_tracing_capturable`.
        crate::daemon::keep_tracing_capturable();
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn a_conversation_this_box_cannot_reach_is_named_in_the_log_it_starts_cold_from() {
        let repo = std::env::temp_dir().join(format!("forge-resume-log-{}", std::process::id()));
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
        let repo =
            std::env::temp_dir().join(format!("forge-resume-log-quiet-{}", std::process::id()));
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
        let repo = std::env::temp_dir().join(format!("forge-resume-none-{}", std::process::id()));
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
            .and_then(|r| r.split("\nasync fn ").next())
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

    /// One session's activity, built by feeding real hook frames through the real
    /// state machine — `awaiting_permission` is private to `agent_activity`, so a
    /// struct literal here is not available, and that is the better test anyway.
    fn reported(events: &[(agent_activity::Event, Option<&str>)]) -> agent_activity::Activity {
        let acts = agent_activity::Activities::new();
        let mut last = None;
        for (event, subject) in events {
            last = Some(acts.record(
                "s1",
                agent_activity::Report {
                    event: *event,
                    at: 0,
                    subject: *subject,
                    conversation: Some("c1"),
                },
            ));
        }
        last.expect("a fixture needs at least one event")
    }

    fn sent(digest: u64, at: Instant, prompts: Option<u64>) -> Option<Nudge> {
        Some(Nudge {
            digest,
            at,
            prompts,
        })
    }

    fn a_while_ago() -> Instant {
        Instant::now()
            .checked_sub(NUDGE_REFRESH)
            .expect("clock older than the refresh window")
    }

    #[test]
    fn a_master_with_no_recorded_nudge_is_nudged() {
        assert!(nudge_due(None, 7, Instant::now(), SinceNudge::Ran));
    }

    #[test]
    fn the_same_work_twice_in_a_row_is_not_nudged_twice() {
        let now = Instant::now();
        assert!(!nudge_due(
            sent(7, now, Some(0)),
            7,
            now,
            SinceNudge::NoTurn
        ));
    }

    #[test]
    fn changed_work_is_nudged_without_waiting_out_the_period() {
        let now = Instant::now();
        for since in [
            SinceNudge::Ran,
            SinceNudge::Working,
            SinceNudge::AwaitingPermission,
        ] {
            assert!(
                nudge_due(sent(7, now, Some(3)), 8, now, since),
                "new work must reach the master however {since:?} reads"
            );
        }
    }

    #[test]
    fn unchanged_work_is_nudged_again_where_the_last_one_produced_no_turn() {
        assert!(nudge_due(
            sent(7, a_while_ago(), Some(4)),
            7,
            Instant::now(),
            SinceNudge::NoTurn
        ));
    }

    #[test]
    fn unchanged_work_is_nudged_again_where_the_master_has_never_reported() {
        assert!(nudge_due(
            sent(7, a_while_ago(), None),
            7,
            Instant::now(),
            SinceNudge::Unreported
        ));
    }

    #[test]
    fn unchanged_work_is_nudged_again_where_the_turn_died_on_an_error() {
        assert!(nudge_due(
            sent(7, a_while_ago(), Some(4)),
            7,
            Instant::now(),
            SinceNudge::Failed
        ));
    }

    #[test]
    fn unchanged_work_is_withheld_where_the_last_nudge_produced_a_turn() {
        for since in [
            SinceNudge::Ran,
            SinceNudge::Working,
            SinceNudge::AwaitingPermission,
        ] {
            assert!(
                !nudge_due(sent(7, a_while_ago(), Some(4)), 7, Instant::now(), since),
                "a master that {since:?} has answered this work already"
            );
        }
    }

    #[test]
    fn a_master_stopped_on_a_permission_question_is_left_alone() {
        let a = reported(&[
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::PermissionRequested, None),
        ]);
        assert_eq!(
            since_nudge(Some(&a), Some(0)),
            SinceNudge::AwaitingPermission
        );
        assert!(!retry_owed(SinceNudge::AwaitingPermission));
    }

    #[test]
    fn a_session_that_never_reported_reads_as_no_evidence() {
        assert_eq!(since_nudge(None, Some(3)), SinceNudge::Unreported);
        let a = reported(&[(agent_activity::Event::Stopped, None)]);
        assert_eq!(
            since_nudge(Some(&a), None),
            SinceNudge::Unreported,
            "a nudge sent before this session ever reported has no mark to compare against"
        );
        assert!(retry_owed(SinceNudge::Unreported));
    }

    #[test]
    fn a_child_of_an_earlier_pass_is_not_a_turn_the_nudge_produced() {
        let a = reported(&[
            (agent_activity::Event::SubagentStarted, Some("child-1")),
            (agent_activity::Event::SubagentStopped, Some("child-1")),
        ]);
        assert!(a.sequence > 0, "the frames were accepted");
        assert_eq!(since_nudge(Some(&a), Some(0)), SinceNudge::NoTurn);
    }

    #[test]
    fn a_turn_that_began_and_is_still_running_reads_as_working() {
        let a = reported(&[(agent_activity::Event::PromptSubmitted, None)]);
        assert_eq!(since_nudge(Some(&a), Some(0)), SinceNudge::Working);
    }

    #[test]
    fn a_turn_that_began_and_ended_reads_as_ran() {
        let a = reported(&[
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::Stopped, None),
        ]);
        assert_eq!(since_nudge(Some(&a), Some(0)), SinceNudge::Ran);
        assert!(!retry_owed(SinceNudge::Ran));
    }

    #[test]
    fn a_turn_that_died_while_a_child_was_outstanding_still_reads_as_failed() {
        let a = reported(&[
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::SubagentStarted, Some("child-1")),
            (agent_activity::Event::StoppedFailed, None),
            (agent_activity::Event::SubagentStopped, Some("child-1")),
        ]);
        assert_eq!(a.last_event, agent_activity::Event::SubagentStopped);
        assert_eq!(since_nudge(Some(&a), Some(0)), SinceNudge::Failed);
        assert!(nudge_due(
            sent(7, a_while_ago(), Some(0)),
            7,
            Instant::now(),
            since_nudge(Some(&a), Some(0))
        ));
    }

    #[test]
    fn a_clean_turn_after_a_failed_one_reads_as_ran() {
        let a = reported(&[
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::StoppedFailed, None),
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::Stopped, None),
        ]);
        assert_eq!(since_nudge(Some(&a), Some(0)), SinceNudge::Ran);
    }

    #[test]
    fn a_turn_that_ended_on_an_error_reads_as_failed() {
        let a = reported(&[
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::StoppedFailed, None),
        ]);
        assert_eq!(since_nudge(Some(&a), Some(0)), SinceNudge::Failed);
        assert!(retry_owed(SinceNudge::Failed));
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
    fn the_digest_ignores_what_the_master_does_not_decide_on() {
        let plain: AdmissibleIssue =
            serde_json::from_value(serde_json::json!({ "issueId": "i1", "status": "confirmed" }))
                .unwrap();
        let dressed: AdmissibleIssue = serde_json::from_value(serde_json::json!({
            "issueId": "i1", "status": "confirmed",
            "title": "renamed", "priority": "critical", "category": "bug",
            "description": "rewritten", "ageMinutes": 900.0
        }))
        .unwrap();
        assert_eq!(work_digest(&[plain]), work_digest(&[dressed]));
    }

    fn with_blocker(id: &str, status: &str, blocker: serde_json::Value) -> AdmissibleIssue {
        serde_json::from_value(serde_json::json!({
            "issueId": id, "status": status, "relations": [blocker]
        }))
        .expect("admissible fixture")
    }

    #[test]
    fn the_digest_moves_when_a_rows_own_status_does() {
        let held: AdmissibleIssue =
            serde_json::from_value(serde_json::json!({ "issueId": "i1", "status": "developed" }))
                .unwrap();
        let takeable: AdmissibleIssue =
            serde_json::from_value(serde_json::json!({ "issueId": "i1", "status": "reopen" }))
                .unwrap();
        assert_ne!(work_digest(&[held]), work_digest(&[takeable]));
    }

    #[test]
    fn the_digest_moves_when_a_blockers_status_does() {
        let blocked = with_blocker(
            "i1",
            "confirmed",
            serde_json::json!({
                "kind": "blocks", "dependsOnKey": "ISS-900",
                "blockerStatus": "needs_info", "blockerMergedAt": null,
                "edgeValidUntil": "2020-01-01T00:00:00.000Z"
            }),
        );
        let freed = with_blocker(
            "i1",
            "confirmed",
            serde_json::json!({
                "kind": "blocks", "dependsOnKey": "ISS-900",
                "blockerStatus": "developed", "blockerMergedAt": null,
                "edgeValidUntil": "2020-01-01T00:00:00.000Z"
            }),
        );
        assert_ne!(work_digest(&[blocked]), work_digest(&[freed]));
    }

    #[test]
    fn the_digest_ignores_a_relation_that_orders_nothing() {
        let bare: AdmissibleIssue =
            serde_json::from_value(serde_json::json!({ "issueId": "i1", "status": "confirmed" }))
                .unwrap();
        for kind in ["relates", "decomposes", "duplicates", "parent"] {
            let related = with_blocker(
                "i1",
                "confirmed",
                serde_json::json!({
                    "kind": kind, "dependsOnKey": "ISS-900", "blockerStatus": "needs_info"
                }),
            );
            assert_eq!(
                work_digest(std::slice::from_ref(&bare)),
                work_digest(&[related]),
                "a `{kind}` edge orders nothing, so it is not news"
            );
        }
    }

    #[test]
    fn the_digest_ignores_a_blockers_merge_stamp() {
        let edge = |merged: serde_json::Value| {
            with_blocker(
                "i1",
                "confirmed",
                serde_json::json!({
                    "kind": "blocks", "dependsOnKey": "ISS-900",
                    "blockerStatus": "needs_info", "blockerMergedAt": merged
                }),
            )
        };
        assert_eq!(
            work_digest(&[edge(serde_json::Value::Null)]),
            work_digest(&[edge(serde_json::json!("2026-09-18T00:00:00.000Z"))])
        );
    }

    #[test]
    fn the_digest_ignores_an_edges_expiry() {
        let edge = |until: serde_json::Value| {
            with_blocker(
                "i1",
                "confirmed",
                serde_json::json!({
                    "kind": "blocks", "dependsOnKey": "ISS-900",
                    "blockerStatus": "needs_info", "edgeValidUntil": until
                }),
            )
        };
        assert_eq!(
            work_digest(&[edge(serde_json::Value::Null)]),
            work_digest(&[edge(serde_json::json!("2020-01-01T00:00:00.000Z"))])
        );
    }

    #[test]
    fn the_digest_does_not_move_when_two_blockers_swap_places() {
        let one = serde_json::json!({ "kind": "blocks", "dependsOnKey": "ISS-1", "blockerStatus": "waiting" });
        let two = serde_json::json!({ "kind": "blocks", "dependsOnKey": "ISS-2", "blockerStatus": "on_hold" });
        let a: AdmissibleIssue = serde_json::from_value(serde_json::json!({
            "issueId": "i1", "status": "confirmed", "relations": [one.clone(), two.clone()]
        }))
        .unwrap();
        let b: AdmissibleIssue = serde_json::from_value(serde_json::json!({
            "issueId": "i1", "status": "confirmed", "relations": [two, one]
        }))
        .unwrap();
        assert_eq!(work_digest(&[a]), work_digest(&[b]));
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
            masters.claim_nudge("p1", 7, None),
            "the first sight of work nudges"
        );
        assert!(
            !masters.claim_nudge("p1", 7, None),
            "the same work on the next sweep must not spend another pass"
        );
        assert!(
            masters.claim_nudge("p1", 8, None),
            "new work nudges at once"
        );
    }

    #[test]
    fn a_master_that_answered_the_last_nudge_is_not_nudged_again_for_the_same_work() {
        let masters = Arc::new(Masters::new());
        let session = master_api::MasterSession {
            session_id: "s1".into(),
            name: "forge-master-p1".into(),
            created: true,
        };
        remember(&masters, "p1", &session);

        let before = reported(&[(agent_activity::Event::Stopped, None)]);
        assert!(masters.claim_nudge("p1", 7, Some(&before)));
        age_last_nudge(&masters, "p1");

        let answered = reported(&[
            (agent_activity::Event::Stopped, None),
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::Stopped, None),
        ]);
        assert!(
            !masters.claim_nudge("p1", 7, Some(&answered)),
            "the ceiling came round, the work is the same, and the master's own hooks say it ran the pass"
        );

        let wedged = reported(&[(agent_activity::Event::Stopped, None)]);
        age_last_nudge(&masters, "p1");
        assert!(
            masters.claim_nudge("p1", 7, Some(&wedged)),
            "no prompt submitted since the nudge is a pass that never ran, and the ceiling exists for exactly that"
        );
    }

    /// Push a project's recorded nudge back past the refresh window.
    fn age_last_nudge(masters: &Arc<Masters>, project_id: &str) {
        let mut reg = masters.0.lock().expect("masters poisoned");
        let m = reg.live.get_mut(project_id).expect("no such master");
        let last = m.last_nudge.as_mut().expect("never nudged");
        last.at = a_while_ago();
    }

    #[test]
    fn a_project_with_no_master_is_never_nudged() {
        let masters = Masters::new();
        assert!(!masters.claim_nudge("nobody", 7, None));
    }

    #[test]
    fn the_repeat_decision_reads_only_what_the_agent_reported() {
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        let body = production
            .split("fn since_nudge(")
            .nth(1)
            .and_then(|r| r.split("fn work_digest(").next())
            .expect("the repeat decision is gone");
        for banned in [
            "capture",
            "transcript",
            "terminal::",
            "tmux",
            "len()",
            "elapsed",
        ] {
            assert!(
                !body.contains(banned),
                "`{banned}` in the repeat decision is the quiet gate coming back with a new name (ISS-933 criteria 17 and 18)"
            );
        }
        assert!(
            body.contains("agent_activity::"),
            "every input to this decision is a frame the agent sent through `forge-runner hook`"
        );
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

/// What a master pane is told when this box cannot place it, and what the sweep
/// does to make that answer true (ISS-1092).
#[cfg(test)]
mod unplaced_tests {
    use super::*;

    const SOURCE: &str = include_str!("master.rs");

    fn production() -> &'static str {
        SOURCE.split("\n#[cfg(test)]").next().unwrap()
    }

    fn sweep_body() -> &'static str {
        production()
            .split("\nasync fn sweep(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .expect("sweep must be findable")
    }

    fn ensure_master_body() -> &'static str {
        production()
            .split("\nasync fn ensure_master(")
            .nth(1)
            .and_then(|r| r.split("\n/// ").next())
            .expect("ensure_master must be findable")
    }

    fn block_end(rest: &str, indent: usize) -> Option<usize> {
        rest.find(&format!("\n{}}}", " ".repeat(indent)))
    }

    /// The drained-runner branch of the sweep, on its own.
    ///
    /// Scoped to the branch rather than to the sweep, because the sweep holds
    /// four later `continue`s and an assertion that reads any of them cannot
    /// tell this branch leaving from this branch falling through.
    fn drain_branch() -> &'static str {
        let body = sweep_body();
        let start = body
            .find("if !accepts_new_work(&runner.status) {")
            .expect("the sweep still has its drained-runner branch");
        let rest = &body[start..];
        let end = block_end(rest, 8).expect("the drained-runner branch must close");
        &rest[..end]
    }

    /// The `session.created` report inside `ensure_master`'s adopt branch, on
    /// its own.
    ///
    /// Scoped to the one `if` block. `ensure_master` holds eight further
    /// `tracing::error!` calls, and both `{name}` and `session.session_id`
    /// appear again further down it — so an assertion over the rest of the
    /// function body holds whatever this report is written as.
    fn adopt_report() -> &'static str {
        let body = ensure_master_body();
        let start = body
            .find("if session.created {")
            .expect("the adopt branch must gate its report on session.created");
        let rest = &body[start..];
        let end = block_end(rest, 12).expect("the session.created report must close");
        &rest[..end]
    }

    fn issue(id: &str) -> AdmissibleIssue {
        serde_json::from_value(serde_json::json!({ "issueId": id })).expect("admissible fixture")
    }

    /// The sentence this replaces promised thirty seconds on every path. A
    /// number here is a promise the sweep does not keep, and the pane that met
    /// it waited out fourteen hours of them.
    fn carries_no_deadline(why: &str) {
        for banned in ["thirty seconds", "30 seconds", "seconds,", " seconds."] {
            assert!(
                !why.contains(banned),
                "a refusal may not name a deadline the sweep does not enforce: {why}"
            );
        }
    }

    #[test]
    fn a_pane_whose_capability_names_a_replaced_session_is_told_that_and_not_told_to_wait() {
        let masters = Masters::new();
        masters.note_served(Served::Read(vec!["proj-1".into()]));
        masters.remember_for_test("proj-1", "sess-NEW", "pane-1");
        let why = masters.why_unplaced("proj-1");
        assert!(
            why.contains("sess-NEW") && why.contains("pane-1"),
            "the pane has to be told which session this box does hold, or it cannot tell a stale capability from a daemon that has not looked yet: {why}"
        );
        assert!(
            why.contains("stale"),
            "the reason the declaration fails is the capability, and naming anything else sends the master looking in the wrong place: {why}"
        );
        assert!(
            !why.contains("sweep"),
            "no sweep resolves this state — a pane cannot be handed a new capability, so naming one is the false promise this issue exists to remove: {why}"
        );
        carries_no_deadline(&why);
    }

    #[test]
    fn a_box_that_has_not_read_its_projects_says_so_rather_than_denying_the_project() {
        let masters = Masters::new();
        let why = masters.why_unplaced("proj-1");
        assert!(
            why.contains("has not yet read which projects it serves"),
            "an unread list is not an empty one: {why}"
        );
        assert!(
            !why.contains("does not serve"),
            "reading absence off a list this box never read is how a live master is told it was decommissioned: {why}"
        );
        assert!(!why.contains("sweep"), "nothing is promised here: {why}");
        carries_no_deadline(&why);
    }

    #[test]
    fn a_box_whose_read_failed_names_the_failure_rather_than_denying_the_project() {
        let masters = Masters::new();
        masters.note_served(Served::Unreadable("connect timeout".into()));
        let why = masters.why_unplaced("proj-1");
        assert!(
            why.contains("connect timeout"),
            "the reason core could not be read is the only thing an operator can act on: {why}"
        );
        assert!(
            !why.contains("does not serve"),
            "a failed read is not a denial: {why}"
        );
        carries_no_deadline(&why);
    }

    #[test]
    fn a_project_missing_from_a_list_this_box_did_read_is_denied_by_name() {
        let masters = Masters::new();
        masters.note_served(Served::Read(vec!["proj-2".into(), "proj-3".into()]));
        let why = masters.why_unplaced("proj-1");
        assert!(
            why.contains("does not serve") && why.contains("proj-1"),
            "a snapshot that was read and does not hold the project is the one case this box may deny: {why}"
        );
        assert!(
            why.contains("no sweep here will place"),
            "the denial has to close the door rather than leave a master waiting on one: {why}"
        );
        assert!(
            !why.contains("next sweep"),
            "no sweep adds a project core does not serve to this box: {why}"
        );
        carries_no_deadline(&why);
    }

    #[test]
    fn a_recorded_reason_reaches_the_pane_that_asked() {
        let masters = Masters::new();
        masters.note_served(Served::Read(vec!["proj-1".into()]));
        masters.note_unplaced(
            "proj-1",
            Unplaced::Draining {
                status: "draining".into(),
            },
        );
        let why = masters.why_unplaced("proj-1");
        assert!(
            why.contains("draining"),
            "the precondition the sweep recorded is the whole deliverable of this refusal: {why}"
        );
        assert!(
            !why.contains("sweep place") && !why.contains("next sweep places"),
            "a recorded obstacle is not a wait: {why}"
        );
        carries_no_deadline(&why);
    }

    #[test]
    fn only_a_served_project_with_nothing_against_it_is_promised_the_next_sweep() {
        let masters = Masters::new();
        masters.note_served(Served::Read(vec!["proj-1".into()]));
        let why = masters.why_unplaced("proj-1");
        assert!(
            why.contains("next sweep"),
            "this is the one state a wait is the right answer for, and a master told nothing here stops declaring for good: {why}"
        );
        carries_no_deadline(&why);
    }

    #[test]
    fn a_reason_is_reported_when_it_arrives_and_when_it_changes_and_never_in_between() {
        let masters = Masters::new();
        assert!(
            masters.note_unplaced("proj-1", Unplaced::NothingAdmissible),
            "a reason nothing has said yet is new"
        );
        assert!(
            !masters.note_unplaced("proj-1", Unplaced::NothingAdmissible),
            "the same reason on the next sweep says nothing"
        );
        assert!(
            masters.note_unplaced("proj-1", Unplaced::NoRepoPath),
            "a different reason is a different thing for an operator to do"
        );
        masters.clear_unplaced("proj-1");
        assert!(
            masters.note_unplaced("proj-1", Unplaced::NoRepoPath),
            "a project placed and then unplaced again is reported again — the clear is what makes the next report honest"
        );
    }

    #[test]
    fn a_placed_project_has_nothing_recorded_against_it() {
        let masters = Masters::new();
        masters.note_served(Served::Read(vec!["proj-1".into()]));
        masters.note_unplaced("proj-1", Unplaced::NothingAdmissible);
        let held = masters.why_unplaced("proj-1");
        assert!(
            held.contains("nothing claimable"),
            "while the reason stands it is what the pane is told: {held}"
        );
        masters.clear_unplaced("proj-1");
        let cleared = masters.why_unplaced("proj-1");
        assert_ne!(
            held, cleared,
            "a refusal that reads the same before and after the state changed is one nothing can learn from"
        );
        assert!(
            !cleared.contains("nothing claimable"),
            "a reason that outlives the state it described is a refusal that lies: {cleared}"
        );
    }

    #[test]
    fn an_empty_pool_still_places_a_pane_that_already_exists() {
        assert_eq!(
            placement_for(&[]),
            Placement::AdoptOnly,
            "a project with nothing claimable still has its live pane adopted and re-registered, or core reaps the row that pane's capability names"
        );
        assert_eq!(
            placement_for(&[issue("a")]),
            Placement::AdoptOrStart,
            "a project with work may have a master started for it"
        );
    }

    #[test]
    fn the_empty_pool_branch_no_longer_skips_the_registration() {
        let body = sweep_body();
        assert!(
            body.contains("placement_for(&admissible)"),
            "the sweep decides placement from the pool through the named function, so the decision is a thing a test can call"
        );
        assert!(
            !body.contains("|| masters.get(&runner.project_id).is_none()"),
            "this short-circuit is what skipped `ensure_master` for a quiet project, and with it the `register` that keeps a live pane's session row beating (ISS-1092)"
        );
        assert!(
            body.contains("ensure_master(") && body.contains("placement,"),
            "the placement has to reach `ensure_master`, or the branch decides nothing"
        );
    }

    #[test]
    fn adopt_only_answers_absent_before_it_asks_core_for_a_session() {
        let body = ensure_master_body();
        let guard = body
            .find("Placement::AdoptOnly && !terminal::alive")
            .expect("the adopt-only path must ask tmux whether a pane is there");
        let register = body
            .find("master_api::register(")
            .expect("ensure_master must register with core");
        assert!(
            guard < register,
            "a sweep that starts no master must not create a session row for one"
        );
    }

    #[test]
    fn adopt_only_cannot_fall_through_to_the_spawn_when_the_pane_dies_mid_registration() {
        let body = ensure_master_body();
        let adopted = body
            .find("return PaneState::Adopted;")
            .expect("the adopt branch must return");
        let spawn = body
            .find("install_skill(&resolved.repo_path)")
            .expect("the spawn path must start with the skill install");
        let between = &body[adopted..spawn];
        assert!(
            between.contains("if placement == Placement::AdoptOnly {"),
            "a pane that exits while `register` is awaited must not turn `AdoptOnly` into a spawn"
        );
    }

    #[test]
    fn adopting_a_pane_onto_a_freshly_created_session_is_reported() {
        let body = ensure_master_body();
        let adopt = body
            .find("adopting the resident session")
            .expect("the adopt branch must be findable");
        assert!(
            body[adopt..].contains("if session.created {"),
            "a pane adopted onto a session core created fresh holds a capability for the session that one replaced, and nothing else on this box can notice it"
        );
        let report = adopt_report();
        assert!(
            report.contains("tracing::error!"),
            "it is an error and not an info or a warn: the only recovery is an operator ending the pane, and nothing on this box will do it: {report}"
        );
        assert!(
            report.contains("{name}"),
            "the report names the pane to end, because that is what the operator acts on: {report}"
        );
        assert!(
            report.contains("session.session_id"),
            "the report names the session this box now holds, which is what tells a stale capability from a daemon that has not looked yet: {report}"
        );
    }

    #[test]
    fn a_drained_runner_has_no_master_pane_placed_for_it() {
        let branch = drain_branch();
        assert!(
            branch.contains("continue;"),
            "a drained runner must leave the iteration before placement, or core taking a project off this box still starts a master for it: {branch}"
        );
        assert!(
            !branch.contains("ensure_master("),
            "placement must sit outside the drained branch, not inside it"
        );
        let body = sweep_body();
        let drain = body
            .find("if !accepts_new_work(&runner.status) {")
            .expect("the sweep still has its drained-runner branch");
        let ensure = body
            .find("ensure_master(")
            .expect("the sweep must place panes through ensure_master");
        assert!(
            drain < ensure,
            "the drain branch has to be reached before placement, or it decides nothing"
        );
    }

    #[test]
    fn a_drained_runner_records_its_status_as_the_reason_no_pane_was_placed() {
        let branch = drain_branch();
        assert!(
            branch.contains("note_unplaced("),
            "the sweep has to record why it placed no pane, or the refusal a master gets has nothing to carry: {branch}"
        );
        assert!(
            branch.contains("Unplaced::Draining"),
            "the reason recorded for a drained runner is the drain itself: {branch}"
        );
        assert!(
            branch.contains("runner.status"),
            "the runner row's own status is what an operator changes, so it is the status that is carried and not a fixed word: {branch}"
        );
    }

    #[test]
    fn an_unplaced_pane_is_reported_once_and_names_its_project_and_reason() {
        let masters = Arc::new(Masters::new());
        let first = super::give_back_tests::logged_while(|| {
            say_unplaced(
                &masters,
                "proj-1",
                "the-slug",
                Unplaced::Draining {
                    status: "draining".into(),
                },
            );
        });
        assert!(
            first.contains("WARN"),
            "at WARN: a project this box cannot place a master for is not routine information, and \
             a reason nothing writes down is one no operator ever reads; log was: {first}"
        );
        assert!(
            first.contains("the-slug"),
            "the warning names the project, or a box serving 28 of them says only that something \
             is unplaced; log was: {first}"
        );
        assert!(
            first.contains("draining"),
            "and carries the reason, which is the whole of what an operator acts on; log was: \
             {first}"
        );

        let again = super::give_back_tests::logged_while(|| {
            say_unplaced(
                &masters,
                "proj-1",
                "the-slug",
                Unplaced::Draining {
                    status: "draining".into(),
                },
            );
        });
        assert!(
            again.is_empty(),
            "the SAME reason on the next sweep says nothing. This box sweeps every thirty seconds, \
             so a line per sweep per project is one a reader learns to scroll past — including on \
             the sweep where the reason changed; log was: {again}"
        );

        let changed = super::give_back_tests::logged_while(|| {
            say_unplaced(&masters, "proj-1", "the-slug", Unplaced::NoRepoPath);
        });
        assert!(
            changed.contains("WARN") && changed.contains("checkout"),
            "a DIFFERENT reason is a different thing for an operator to do, so it is reported \
             again; log was: {changed}"
        );
    }
}
