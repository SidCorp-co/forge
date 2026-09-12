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
use crate::daemon::dispatch::resolve_repo;
use crate::daemon::master_exit::{self, Verdict};
use crate::daemon::recovery;
use crate::daemon::recovery_ports::{CoreBeat, CoreRunState, PaneMasters, SignalProbe};
use crate::daemon::run_exit;
use crate::daemon::session_tokens;
use crate::daemon::terminal;
use crate::runner::close_loop;
use crate::runner::ledger::Ledger;
use crate::runner::terminate;
use crate::transport::{master as master_api, pool, runners, CoreClient};
use tokio::sync::mpsc;

/// How often the box asks whether any work exists.
// cm:why this interval IS the latency from an issue opening to an agent touching it, and it is the whole budget: nothing pushes any more, so a job queued one tick after a poll waits a full interval before anything looks. 30s was chosen against the old push path's measured dispatch lag on epodsystem (queue→dispatch of 17m, 23m, 46m and 2h08 on 2026-09-04) — an order of magnitude of headroom, at one cheap request per project per half minute.
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// The closest together two wake-driven sweeps may run.
// cm:guard this is a COALESCING FLOOR, never a rate limit that drops work. A wake inside the window waits out the remainder and then sweeps; it is not discarded. Core publishes one `master.wake` per issue arrival, so promoting five drafts or closing a batch delivers five frames in about as many milliseconds, and a sweep per frame would be five `/me/runners` reads plus five pool reads per project to find what the first one already found. The channel is capacity 1 and extra frames are dropped ON PURPOSE while one is pending — the sweep that follows reads the WHOLE pool, so a dropped frame costs nothing a later read does not already cover.
const WAKE_FLOOR: Duration = Duration::from_secs(5);

/// The longest a master may go un-nudged while the work in front of it is unchanged.
// cm:guard a CEILING ON SILENCE, never a gate: an unchanged pool still reaches the master on this period, so a pass lost to a wedged pane, an ignored line or a limit cleared out of band is retried without an operator. The same reason `LIMITED_POLL_INTERVAL` is a backoff and not a blackout — read it as permission to stop nudging and the fleet cannot self-heal.
// cm:guard the pane costs REAL MONEY per nudge, which is why this exists at all: one nudge is one full agent pass, measured at ~$0.18 on forge-vm 2026-09-08, and 1,354 nudges over 95 minutes bought 0 claims and $245 while every runner sat rate-limited. An unconditional nudge on every sweep is a spend proportional to sweeps rather than to work.
const NUDGE_REFRESH: Duration = Duration::from_secs(5 * 60);

/// Sweep spacing once every project this box serves is rate-limited.
// cm:guard this is a BACKOFF, never a blackout, and the distinction is the whole design. Core clears a limit only when a job SUCCEEDS (`clearRunnerLimit`), so a master that declines to sweep while limited removes the only thing that can clear the stamp, and an operator who fixes the account out of band is left watching an idle fleet forever. Slowing down costs a few minutes of latency; stopping costs the self-heal.
const LIMITED_POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// The first thing a resident master is told, once, when its session starts.
// cm:guard name the skill and STOP. Restating its RULES here creates a second copy of the master's process, and the copies drift in silence because nothing compares them — the skill file is where a reader looks and this string is what a master is actually told. The two ship together (see the include_str edge below), so there is no version where inlining the rules here is even the safer half. The owner policy block below is the one thing that is not a copy: the skill holds the defaults and defers to it by name, and it exists nowhere in the binary.
// cm:guard this is the STANDING brief and the pass prompt is the pool read, and the split is what makes residency worth anything. Folding the two back together sends the whole brief every 30 seconds — the cold start this change removed, arriving as tokens instead of as a process.
// cm:guard the policy is spliced VERBATIM and is never summarised, reordered or merged into the sentences around it. It is the project owner speaking, this box is a courier, and a courier that paraphrases is how an instruction that was typed correctly arrives wrong. The heading is what lets the skill defer to it by name.
// cm:edge contract -> packages/core/src/devices/me-runners.ts — the text arrives as `masterPolicy` on `/me/runners`, from the `master-policy` projectFact. `None` means the project set none, and the skill's own defaults stand; it never means "brief nothing".
fn standing_prompt(
    project: &str,
    base_branch: Option<&str>,
    master_policy: Option<&str>,
) -> String {
    let mut out = format!(
        "Use the `forge-master` skill. You are the resident master for project `{project}` on \
this box. You will be given the claimable pool repeatedly, in this same session: read it, decide \
what runs and how much, claim through `forge-runner pool claim`, and end each pass by releasing \
anything you claimed but did not start.\n"
    );
    if let Some(base) = base_branch {
        out.push_str(&format!(
            "\nYou are standing in this project's checkout, on its base branch `{base}`. Every \
agent you start works in a worktree cut from `origin/{base}`, never in this tree.\n"
        ));
    }
    out.push_str(
        "\nYou NAME every agent you start: `forge-runner pool claim <jobId> --agent <name>`. The name becomes that agent's git branch and its worktree, so it must read as \
the work — `ISS-175` when an agent takes one issue, something like `catalog-eav` when you group \
several into one. Give two jobs the SAME name deliberately and they share one checkout and one \
branch; give them different names and they cannot see each other's work. A claim with no name is \
refused.\n",
    );
    out.push_str(
        "\nTaking a job and starting it are two acts. `forge-runner pool prepare` gives you the \
job row and its token with nothing running; `forge-runner pool start` spawns it and \
`forge-runner pool discard` hands it back. `pool claim` is those first two in order, for when \
you have already decided.\n",
    );
    out.push_str(
        "\nBetween passes you stay open. Keep what you concluded — what you grouped, what you \
deliberately did not claim and why — where the next pass can read it, and say it out loud rather \
than only thinking it: this pane is the record.\n",
    );
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
// cm:guard one master per PROJECT, and the key is the project id rather than the box. Two masters on one project read the same pool and both claim: core's L1 refuses the second for the same ISSUE, but two jobs on two issues sharing that project's checkout would both start and collide on the same tree, which the repo lock then serialises into a stall neither master understands. Two masters on DIFFERENT projects are fine and are the point — they share no tree.
// cm:guard this map is now an OPTIMISATION, not the bound. The bound moved to two places that survive this process: tmux refuses a second session under a name that exists, and core refuses a second live `agent_sessions` row for the same (device, project). It had to move, because a session parented by the multiplexer is invisible to any in-process set — which is exactly the hole ISS-919 B1 names. Never re-derive the bound from this map alone: a daemon restart empties it while every master is still running.
// cm:guard this bounds masters and NOTHING ELSE. `duplex_max_sessions` (default 3) is the box's only process ceiling and it covers duplex PIPELINE jobs alone — a master takes no permit, and neither does a one-shot job. Adding a project therefore adds a claude process with nothing counting it; measured on dev1 2026-09-05 at load 17.26 on 12 cores with CPU pressure some=52%. A box-level bound is owed and is not this map.
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
}

/// What the master is being asked to look at, as one comparable value.
///
/// Identity only — a job id or an issue id, never a title, a priority or a
/// status. Those change while the decision does not, and a digest that moves
/// on them re-nudges for nothing.
// cm:guard ORDER-INDEPENDENT by construction (the ids are sorted before hashing) because neither route promises a stable order: `readPool` ranks and `readAdmissibleIssues` runs one query per project, so hashing the sequence would report new work every time two rows swapped.
// cm:guard the `job:`/`issue:` prefix is part of the identity, not decoration: the two routes carry different id spaces, and hashing bare strings made one job indistinguishable from one admissible issue that happened to share an id — caught by this function's own test while it was being written.
fn work_digest(items: &[pool::PoolEntry], admissible: &[pool::AdmissibleIssue]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut ids: Vec<String> = Vec::with_capacity(items.len() + admissible.len());
    ids.extend(items.iter().map(|i| format!("job:{}", i.job_id)));
    ids.extend(admissible.iter().map(|a| format!("issue:{}", a.issue_id)));
    ids.sort_unstable();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for id in ids {
        id.hash(&mut h);
    }
    h.finish()
}

/// Whether the master should hear about this pool now.
// cm:guard TRUE is the safe answer and every unknown returns it: a master with no recorded nudge is nudged, and changed work is nudged immediately rather than waiting out the period. Only the exact case "same ids, seen recently" is held back, so a mistake here costs a duplicate pass, never a missed one.
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
    // cm:guard returns the pane NAME with the session id rather than the id alone, because every caller has to ask tmux whether that pane is still there — a registry entry outlives the process it names by design (the ISS-919 B1 hole), so an answer that could not be checked would be a claim this struct cannot make.
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

    /// The pane name for a master session id, for the inbox's terminal arm.
    // cm:guard keyed by SESSION id, not project id. Core addresses a master by the `agent_sessions` row it registered, which is the only identity a `session.send` frame carries — a lookup by project would need core to know which project a session belongs to and to say so on the frame, and it does neither.
    pub fn pane_for_session(&self, session_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .values()
            .find(|m| m.session_id == session_id)
            .map(|m| m.name.clone())
    }
}

/// Why a sweep is happening now, when it is not the timer.
// cm:guard a wake carries NO work — not a job, not a token, not a decision. It says "look now", and the box then reads the pool through the same path the timer uses and decides for itself. A wake that carried the work would be a second dispatcher, and this box would hold two sources of truth about what to run with nothing reconciling them.
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
// cm:guard the TIMER MUST STAY, and this is the only place that says so on this side. Core's publish is fire-and-forget — `ws/rooms.ts:publish` skips any socket that is not OPEN and buffers nothing — so a wake sent while this box's websocket is down is gone with nothing recording that it happened. Deleting the timer here turns one dropped frame into work that sits forever with nothing reporting why; keeping it makes the same drop cost 30 seconds. The reconnect catch-up covers the same hole from the other end and is not a substitute for either.
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
    // cm:guard a ledger that will not open is announced and the box keeps sweeping. It is the input to ONE decision — whether an idle master may leave — and a daemon that refused to dispatch over it would trade every project's work for a housekeeping question.
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
                delay = sweep(&client, &cfg, &masters, &activity, &mut ledger).await;
                last_sweep = Instant::now();
            }
            Some(w) = wake.recv() => {
                let since = last_sweep.elapsed();
                if since < WAKE_FLOOR {
                    tokio::time::sleep(WAKE_FLOOR - since).await;
                }
                tracing::info!("[master] wake ({}) — sweeping now", w.describe());
                delay = sweep(&client, &cfg, &masters, &activity, &mut ledger).await;
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
// cm:guard only an EXPLICIT stop counts, and `offline` deliberately does not. That status is written by the heartbeat and lags a live box by up to its interval, so gating on `online` would have a box refuse its own work over a stale row. Two statuses mean an operator decided; every other value, known or added later, keeps working.
// cm:guard this is the ONLY thing that reads the status, and until 2026-09-05 nothing did: `/me/runners` returned it, `MeRunner` parsed it, and no code looked. `retire` and every status change were therefore silent no-ops against a box that kept claiming — measured on epodsystem while moving it off dev1. Core cannot enforce this instead: `pool.ts` joins `runners` on (project, device) with no status filter, and adding one there would hide work from a master rather than let the box decline it.
fn accepts_new_work(status: &str) -> bool {
    !matches!(status, "draining" | "disabled")
}

/// How long to wait before the next sweep, given what core just reported.
///
/// Fast by default; stretched only when EVERY project that would take work is
/// rate-limited, so one limited project never slows down a healthy one.
// cm:guard the stretch requires ALL of them, and `any` here would be a throughput bug rather than a pacing one: this box serves several projects, and one account hitting its window would idle the rest for five minutes at a time.
// cm:guard `Some(0)` counts as NOT limited. An expired stamp is the normal steady state, because core only clears the column on a successful job — treating a lapsed limit as live is how a backoff becomes permanent.
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
// cm:guard the project list comes from `/me/runners`, NEVER from `config.toml` bindings. Core is the source of truth for what a device serves and for where the checkout lives (`resolve_repo` reads the local binding only as a fallback), and the two disagree in practice: dev1 serves epodsystem-core with no local binding for it at all, so a sweep driven by the config file would leave that project's pool unread forever with nothing reporting why.
async fn sweep(
    client: &CoreClient,
    cfg: &Config,
    masters: &Arc<Masters>,
    activity: &agent_activity::Activities,
    ledger: &mut Option<Ledger>,
) -> Duration {
    let served = match runners::list_me(client).await {
        Ok(rs) => rs,
        Err(e) => {
            tracing::warn!("[master] cannot read this box's projects: {e}");
            return POLL_INTERVAL;
        }
    };
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
            // cm:guard a drained runner still gets `supervise`, and only the START of new work is skipped. A master already running on a project being moved off this box must still be watched and still give its holds back when it dies — a drain that stopped watching would leave a dead master's work unclaimable with nothing reporting why, which is the drain doing damage rather than nothing.
            supervise(client, masters, &runner.project_id, &runner.slug).await;
            continue;
        }
        supervise(client, masters, &runner.project_id, &runner.slug).await;

        let view = match pool::pool(client, 20, Some(&runner.project_id)).await {
            Ok(view) => view,
            Err(e) => {
                tracing::warn!("[master] pool unreadable for {}: {e}", runner.slug);
                continue;
            }
        };
        let items = view.items;
        // cm:guard read the admissible issues too, and never gate on `items` alone. The pool holds jobs for the four kinds that have no issue to rank; a project whose entire content is issues would otherwise get a master, a brief and never a single pass, leaving `pipelineConfig.poolBacklog` configurable, savable and dead (ISS-933 criterion 26).
        // cm:guard an unreadable admissible read is EMPTY, not fatal. It is the newer of the two routes, so a box talking to an older core must still serve that core's pool rather than going quiet on every project at once.
        let admissible = pool::admissible(client, Some(&runner.project_id))
            .await
            .unwrap_or_default();
        // cm:guard an EMPTY pool starts no master, and that bound survives residency. A resident session is a `claude` process that lives until something ends it, and nothing counts it — `duplex_max_sessions` covers duplex pipeline jobs alone, so a box serving six projects would carry six permanent processes for however many of them never have work. A master that already exists is kept and still supervised; residency is for a project doing something, not for every row `/me/runners` returns.
        if items.is_empty() && admissible.is_empty() {
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
                // cm:guard refuse by NAME rather than falling back to some other directory. A master started in the wrong tree reads one repo and claims work for another, and every diff it produces lands where nobody looks — the silent substitution this repo forbids, and unrecoverable by the time anyone notices.
                tracing::error!(
                    "[master] {slug} has claimable work but no repo path on this box — no master will run for it; bind it or set the runner's repo_path"
                );
                continue;
            }
        };

        if !ensure_master(client, masters, &runner.project_id, &resolved).await {
            continue;
        }

        if items.is_empty() && admissible.is_empty() {
            continue;
        }

        if masters.claim_nudge(&runner.project_id, work_digest(&items, &admissible)) {
            nudge_master(masters, &runner.project_id, &resolved.slug).await;
        }
    }

    give_back_lost_runs(
        crate::runner::inflight::boot_identity()
            .unwrap_or_default()
            .as_str(),
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

/// What a sweep needs to take a run back: who this box serves (so a project's
/// repo can be resolved), and the two separate process questions.
// cm:guard `procs` and `killer` are DIFFERENT ports and merging them would be a category error with teeth: one answers "is this pid gone" where only a positive refutation may say yes, the other signals a process group. A single port would let a box that cannot ask about a pid still kill one.
struct Reclaim<'a> {
    served: &'a [runners::MeRunner],
    cfg: &'a Config,
    procs: &'a dyn recovery::ProcessLiveness,
    killer: &'a dyn terminate::ProcessGroup,
    closer: &'a dyn close_loop::RunCloser,
}

/// Give back the worktree a dead run still holds, so its close loop can finish.
// cm:why the deadlock this breaks, and why nothing already in the loop breaks it: `end_run` is reached only through `close.is_closed()`, that needs `worktree_gone`, that mark is set only by observing the tree gone, and the sole remover — the reap — refuses every tree whose run is `ended_by IS NULL`. Nothing lowers that for a session that ended outside `terminate`, so the run keeps its checkout and its leases forever (forge-vm 2026-09-10: 24 runs, 24 trees, the pool empty under them).
// cm:guard the release lives HERE rather than in `recovery` because it needs the project's repo path, and `resolve_repo` is the one reader of that: a repo derived from the worktree path instead would answer differently across a symlink or a bind mount than every other caller on this box, and the fleet's checkouts are bind-mounted.
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
    // cm:guard refuse by NAME and reclaim nothing when the repo is unknown, exactly as the dispatch half does. Releasing a tree through some other repo runs `git worktree remove` against a checkout that never owned it.
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
        // cm:guard a refused release leaves the run exactly as it was and says so — `force_terminal` aborts before touching the tree when the diff could not be preserved, and an operator who reads "reclaimed" over that has lost the diff and does not know it yet.
        Err(e) => {
            tracing::warn!("[master] run {} could not be released: {e}", r.run_id);
            false
        }
    }
}

/// Tell core a run's process is gone, so its session stops being guessed at.
// cm:guard `Died` is the outcome, and `closeRunSession` returns this run's issues to the status they were claimed from on exactly that value — which is the point: the work stopped mid-turn, so leaving the issues at `in_progress` strands them behind a run nothing is doing (ISS-457 stood there 18 hours).
// cm:guard this sets NO local mark. `session_terminal` is still earned by `close_loop` reading core's row back on the next sweep, so a report whose response was dropped and one that never landed are indistinguishable here, as criterion 13 requires.
async fn report_run_death(r: &recovery::Recovered, world: &Reclaim<'_>) {
    let Some(session_id) = r.session_id.as_deref() else {
        return;
    };
    if let Err(e) = world
        .closer
        .close(
            session_id,
            close_loop::Outcome::Died,
            "the run's process is gone from this box",
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
// cm:guard reads the SHARED map the control socket writes into, never a copy. A second `Activities` here would answer `None` for every session forever, which `run_exit` reads as "never reported" — so every run would keep being beaten and the fix would be inert, green, and indistinguishable from working.
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
// cm:guard the process is signalled and NOTHING else is written here. The three marks are `close_loop`'s and each is set by reading the world back, so a kill that also stamped `session_terminal` would be this repo's one forbidden move — a box declaring an outcome core has not confirmed. The next sweep sees the pid refuted and takes the run through the same path a crashed run takes.
// cm:guard `&mut` and not `&`, though nothing here writes: the borrow is held across the kill, and `&Ledger` is `Send` only if `Ledger` is `Sync` — which rusqlite's `RefCell` connection is not, so the shared borrow makes the whole master loop's future non-`Send` and the daemon stops compiling at `tokio::spawn`.
// cm:guard the KILL happens first and the close is told afterwards, never the reverse. A close that lands over a pane the kill then fails to end leaves core reading `completed` while the agent is still writing to the worktree; this order's failure mode is the one this box already survives — the close does not land, and core's ten-minute sweep closes the row as it did before this verb existed.
// cm:guard the outcome is `KilledIdle` and NOT `Died`: this box decided to end a run whose work was finished, so returning its issues would undo whatever the last turn landed. `closeRunSession` keys the issue return off exactly this distinction.
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
        )
        .await
    {
        tracing::warn!(
            "[master] run {run_id} was ended but core was not told why ({e}) — its session falls to the ten-minute sweep"
        );
    }
}

/// Beat what this box still holds, and close the loop on what it does not.
// cm:guard runs AFTER the per-project loop, and the order is the assertion. `ensure_master` re-registers every live master into `Masters` on each pass, and `PaneMasters` reads that map for the pane NAME — placed before the loop, a daemon restart would meet an empty map and read every live run on the box as orphaned (ISS-933 criterion 16).
// cm:guard the beat rides in this same call and is not separable: core reaps a run session silent for ten minutes, so a sweep that reconciled without beating would take back every healthy run on the box (ISS-933 criteria 16 and 25a).
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
    // cm:guard an unreadable boot id means NO reconcile, and that refusal is the safe direction. The boot is what separates "the master died within this boot" from "everything recorded before a reboot belongs to a stranger"; an empty one matches nothing recorded, so every live run on the box would read as orphaned and lose its worktree (ISS-933 criterion 16). Windows is not hypothetical here: `boot_identity` answers `None` there.
    if boot_id.is_empty() {
        tracing::warn!("[master] this box reports no boot id — leaving unclosed runs alone");
        return;
    }
    match recovery::reconcile(led, boot_id, live, world.procs, sessions, leases, watch).await {
        Ok(done) => {
            for r in done {
                // cm:guard answered FIRST and with a `continue`, because a run named for the idle exit has none of the other marks yet by construction — its process is still up, so `owed_release` is false and `is_closed` is false, and falling through to the report below would file a "partially closed" complaint about a run this sweep is in the middle of ending.
                if r.owed_idle_exit {
                    end_idle_run(led, &r.run_id, world).await;
                    continue;
                }
                // cm:guard reported BEFORE the release is attempted and WITHOUT a `continue`: `owed_release` needs `session_terminal`, core alone writes that mark, and until this report lands the only writer is core's ten-minute silence sweep — so every orphan on this box waited it out and landed in `runner_unreachable` whether or not the box was reachable (forge-vm 2026-09-12, ~95% of 203 sessions over 7 days on two projects). The release still waits for the next sweep to read the row back, which is criterion 13 and not a delay worth trading away.
                if r.owed_death_report {
                    report_run_death(&r, world).await;
                }
                // cm:guard the release is attempted BEFORE the report and its result decides whether one is printed, because a run recovery just reclaimed is not a run an operator has anything to do about. Report first and every reclaimed run also files a complaint about the state it was reclaimed out of.
                if r.owed_release
                    && release_held_tree(led, &r, boot_id, world, sessions, leases).await
                {
                    continue;
                }
                if r.state.is_closed() {
                    continue;
                }
                // cm:guard say WHICH marks are missing, never "partially closed". A run holding two of three leases and one holding none are different operator problems, and a line that does not separate them is the report this whole loop exists to replace.
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
// cm:guard the skill text ships INSIDE the runner and is written to the project checkout before every session starts. Nothing else delivers it — `skill_sync` seeds only what a project's manifest lists — and a master told to "use the forge-master skill" with nothing on disk loads nothing and improvises the one process this design depends on, silently. It SURVIVES `skill_sync`'s converge-on-delete only because `find_prunable` skips a directory with no `.hash` marker and this writes none; seed it through `write_skill_tree` and the next sync deletes it as an unmanifested skill. The price of embedding is real and is the trade: editing the master's process now needs a runner release, where a project skill needs only a push. The checkout copy is GENERATED OUTPUT and `.claude/` is ignored wholesale — an edit made there is overwritten by the next spawn.
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/assets/forge-master-skill.md — that file is SOURCE for this binary, not local config, and it lives under `packages/runner/**` so ci.yml's `runner` path filter and check-runner-gates.mjs's own scope both reach it with no special case: a skill-only edit that skipped the runner job would ship an unbuilt master through a green `ci-passed`.
const MASTER_SKILL: &str = include_str!("../../assets/forge-master-skill.md");

/// Write the skill where the session about to start will look for it.
fn install_skill(repo: &std::path::Path) -> std::io::Result<()> {
    let dir = repo.join(".claude/skills/forge-master");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("SKILL.md"), MASTER_SKILL)
}

/// Register the daemon's hooks for the session about to start, and say so.
// cm:guard the exe is read from `current_exe` and never hardcoded, because the hook command has to name a binary that will still be there: this box runs `forge-runner` out of `~/.local/bin`, an update replaces it in place, and a command naming anything else is a hook that fires into nothing.
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

/// Where a project's master keeps what only it can say.
// cm:guard per PROJECT, never one file for the box. Masters on two projects run at the same time by design, and a single log would interleave two sessions into a transcript that reads as one confused master.
// cm:guard APPEND, and the filename says so. This used to be `last-pass.log`, truncated on every spawn — measured 2026-09-05, the master's account of why it claimed ISS-917 was gone three minutes later, overwritten by the ISS-918 pass. B5 is that fix: a pane piped with `>>` into one file per project, so the judgement layer this design calls its entire value outlives the pass that produced it.
fn transcript_path(slug: &str) -> Option<std::path::PathBuf> {
    let dir = Config::path().ok()?.with_file_name("master").join(slug);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("transcript.log"))
}

/// Make sure this project has a live, registered master, and return its id.
// cm:guard register with core on EVERY sweep, not only when the pane is created. The row is what `jobs.held_by` carries, so a cached id would keep claiming onto a session core had already reaped — holds nobody can see, under an identity nobody is beating for. `ensureMasterSession` is idempotent precisely so this can be unconditional.
async fn ensure_master(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    resolved: &crate::daemon::dispatch::Resolved,
) -> bool {
    let name = terminal::session_name(terminal::MASTER_PREFIX, &resolved.slug);
    // cm:guard refuse by name when tmux is missing rather than falling back to the per-pass `claude -p` this replaced. A box that quietly reverted would look identical in the log to one that is working, while none of the liveness, the transcript or the addressable pane exist on it.
    if !terminal::available() {
        tracing::error!(
            "[master] {}: tmux is not installed on this box — no master will run for it; install tmux (`forge-runner doctor` checks for it)",
            resolved.slug
        );
        return false;
    }

    let session = match master_api::register(client, project_id, &name).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("[master] {}: cannot register with core: {e}", resolved.slug);
            return false;
        }
    };

    if terminal::alive(&name).await {
        if masters.get(project_id).is_none() {
            // cm:guard adopt a pane this daemon did not create rather than killing it. The master survives a `forge-runner` restart by design, and a daemon that started by clearing what it does not remember would make every deploy an outage for every project on the box.
            tracing::info!(
                "[master] {}: adopting the resident session {name}",
                resolved.slug
            );
            remember(masters, project_id, &session);
        }
        return true;
    }

    // cm:guard refuse to start when the skill cannot be written, rather than starting without it. A master with no skill still starts, still claims, and runs the whole orchestration off a four-line prompt — work that looks like it is being managed and is not.
    if let Err(e) = install_skill(&resolved.repo_path) {
        tracing::error!(
            "[master] {}: could not install the forge-master skill into {}: {e} — not starting a master",
            resolved.slug,
            resolved.repo_path.display()
        );
        return false;
    }

    // cm:guard hooks are installed but a failure does NOT stop the master, and the asymmetry with the skill above is deliberate: a master with no skill improvises the whole process, while a master with no hooks is exactly what every box ran before this channel existed — blind, and working. Trading the pass for the telemetry would be the wrong way round.
    // cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/runner/run_session.rs — a RUN pane installs the same hooks into its own worktree, and the two spawn paths are the only places this can happen: settings are read once at startup, so a path that spawns without installing produces a session that reports nothing for its whole life and cannot be repaired in flight.
    install_hooks_logged(&resolved.repo_path, &resolved.slug);

    // cm:guard the pane is the ONE session this runner opens on a TTY, and a TTY is the only place Claude Code shows the workspace-trust prompt. An unanswered prompt is a session that ends without doing anything and takes the breaker above with it, so the stamp belongs immediately before the spawn — `workspace::provision` covers a fresh box, this covers every box provisioned before it shipped (ISS-928, forge-vm 2026-09-06).
    crate::workspace::trust::pre_trust_logged(&resolved.repo_path, &resolved.slug);

    let transcript = transcript_path(&resolved.slug);
    // cm:guard mint on the SPAWN path only, never on the adopt path above. A pane carries its capability in its environment and cannot be told a new one, so re-minting for a master this daemon merely adopted would refuse every frame that master sends for the rest of its life (ISS-964 criterion 29).
    let mut env = terminal::pane_env();
    match session_tokens::default_path().map(session_tokens::SessionTokens::at) {
        Some(store) => match store.mint(&session.session_id) {
            Ok(token) => env.push((session_tokens::TOKEN_ENV.to_string(), token)),
            Err(e) => {
                tracing::error!(
                    "[master] {}: cannot mint a control capability: {e} — not starting a master",
                    resolved.slug
                );
                return false;
            }
        },
        None => {
            tracing::error!(
                "[master] {}: cannot resolve the control token map — not starting a master",
                resolved.slug
            );
            return false;
        }
    }
    match terminal::ensure(
        &name,
        &resolved.repo_path,
        &terminal::pane_argv(),
        &env,
        transcript.as_deref(),
    )
    .await
    {
        Ok(_) => {}
        Err(e) => {
            tracing::error!("[master] {}: could not start {name}: {e}", resolved.slug);
            return false;
        }
    }
    tracing::info!(
        "[master] {}: resident session {name} started in {} — `tmux attach -t {name}` to watch it",
        resolved.slug,
        resolved.repo_path.display()
    );
    remember(masters, project_id, &session);

    // cm:guard the standing brief is typed ONCE, into a pane that has just started, and the wait inside `brief_new_pane` is not decoration — the next sweep would otherwise prompt a master that was never briefed.
    let brief = standing_prompt(
        &resolved.slug,
        resolved.base_branch.as_deref(),
        resolved.master_policy.as_deref(),
    );
    if let Err(e) = terminal::brief_new_pane(&name, &brief).await {
        tracing::warn!("[master] {}: could not brief {name}: {e}", resolved.slug);
    }
    true
}

fn remember(masters: &Arc<Masters>, project_id: &str, session: &master_api::MasterSession) {
    masters.remember(
        project_id,
        MasterState {
            session_id: session.session_id.clone(),
            name: session.name.clone(),
            last_work: Instant::now(),
            last_nudge: None,
        },
    );
}

/// The whole of one pass prompt: go, and who you are.
// cm:guard the pool is NOT embedded here, and that absence is what let the quiet gate go. The skill's own first step is `pool list`, so a snapshot typed at the master is a second copy that is already stale by the time the turn reaches it — and a prompt that queued behind a turn then acted on that copy is exactly what the deleted quiet gate existed to prevent (ISS-933 criterion 17).
// cm:edge contract -> packages/runner/crates/forge-runner-core/assets/forge-master-skill.md — the skill is told it never names itself, and this prompt is what must not contradict it. A pass that handed a master its session id would invite it back onto a flag no command has (ISS-964 criterion 29).
fn nudge() -> String {
    "Pass. Read the pool, decide, claim what you are confident about, report, and stop.".into()
}

/// Tell a master there is something to look at.
// cm:guard nothing gates this on the master looking idle. Residency used to be policed from outside — transcript growth read as liveness, a quiet window before prompting, a ceiling that killed — and every one of those inferred a process state from a pane's byte count (ISS-933 criteria 17 and 18). `claim_nudge` is NOT that gate and must not become it: it reads the POOL's identity, never the pane, so it cannot be wrong about whether the master is alive or working.
// cm:guard an extra nudge costs a full agent pass, NOT a line in a composer — ~$0.18 measured on forge-vm 2026-09-08, where 1,354 unconditional nudges over 95 minutes bought 0 claims and $245. That is why the caller gates on `claim_nudge`; a new call site that skips it reinstates a spend proportional to sweeps.
async fn nudge_master(masters: &Arc<Masters>, project_id: &str, slug: &str) {
    let Some((_, name)) = masters.get(project_id) else {
        return;
    };
    tracing::info!("[master] {slug}: work in the pool — nudging {name}");
    if let Err(e) = terminal::send_line(&name, &nudge()).await {
        tracing::warn!("[master] {slug}: could not nudge {name}: {e}");
    }
}

/// The dead-master detector, re-homed from the control socket to the pane.
///
/// B3: the daemon is no longer the master's parent, so a dead master drops no
/// socket. What it does do is stop existing as a tmux session, and this is the
/// thing that notices — one sweep, not the three minutes core's reaper costs.
// cm:guard the holds come back on BOTH arms, and that is the load-bearing half. A master that dies holding a preparation parks claimable work until core's reaper notices; `pool::release` with no job id is the same "everything this session holds" call the socket-drop path used to make, and losing it would leave the fast detector detecting and not repairing.
// cm:guard close the row AFTER releasing, never before. Core's reaper reads a terminal status as reason enough to sweep, so a close that landed with the release still to come would race the reaper for the same rows — harmless twice over, but only in that order; the reverse leaves a live row with no holds and nothing to say why.
async fn supervise(client: &CoreClient, masters: &Arc<Masters>, project_id: &str, slug: &str) {
    let Some((session_id, name)) = masters.get(project_id) else {
        return;
    };

    if !terminal::alive(&name).await {
        tracing::warn!("[master] {slug}: resident session {name} is gone — returning its holds");
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
// cm:guard both halves are asked EVERY time, and the ledger read is not skipped when the pool is empty. An empty pool is the idle half already — reading the children is the half that is easy to drop, and dropping it is what abandons a run's close loop to core's ten-minute reaper.
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
    match pool::release(client, None, session_id).await {
        Ok(n) if n > 0 => tracing::info!("[master] returned {n} hold(s) to the pool"),
        Ok(_) => {}
        Err(e) => tracing::warn!("[master] could not return holds for {session_id}: {e}"),
    }
    if let Err(e) = master_api::close(client, session_id, reason).await {
        tracing::warn!("[master] could not close session {session_id}: {e}");
    }
    // cm:guard the capability dies with the session it names. A token left in the map outlives the master and is a live way onto the socket held by whatever can still read the pane's environment — a dead master's tmux buffer among them (ISS-964 criterion 29).
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
                kind: None,
                workspace_setup: None,
                master_policy: None,
                rate_limited_for_seconds: *limited,
                limit_reason: None,
            })
            .collect()
    }

    // cm:guard the wake floor must stay BELOW the poll interval, or a wake is strictly worse than doing nothing: core publishes to cut the latency from an issue arriving to a box looking, and a floor at or above `POLL_INTERVAL` would make every wake wait longer than the timer it was meant to beat.
    #[test]
    fn a_wake_cuts_latency_rather_than_adding_it() {
        assert!(WAKE_FLOOR < POLL_INTERVAL);
    }

    // cm:guard capacity ONE is the coalescing, and this is the assertion that fails if someone widens the channel to "not lose any". Widening it queues one sweep per arriving issue, and every sweep after the first re-reads a pool the first already covered — five promoted drafts would cost five `/me/runners` reads plus five pool reads per project to learn nothing new.
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

    // cm:guard the operator has to be able to tell which trigger fired, because a box waking only on reconnect is one whose `master.wake` frames are being dropped somewhere — a fault with no other symptom, since the timer keeps the work moving.
    #[test]
    fn a_wake_says_which_trigger_fired() {
        assert!(Wake::Core {
            project_id: Some("forge-dev".into())
        }
        .describe()
        .contains("forge-dev"));
        assert!(Wake::Reconnect.describe().contains("catch-up"));
    }

    // cm:guard this is the test that has to fail if anyone turns the backoff into a skip. A limited fleet must still be swept, because core clears the limit only on a job that SUCCEEDS — the delay may grow, but it is bounded and the sweep always happens.
    #[test]
    fn a_limited_fleet_is_slowed_down_and_never_stopped() {
        let d = next_poll_delay(&served(&[("online", Some(3600))]));
        assert!(d > POLL_INTERVAL, "a limited fleet should back off");
        assert!(
            d <= LIMITED_POLL_INTERVAL,
            "the backoff must stay bounded: {d:?}"
        );
    }

    // cm:guard one limited project must not slow down a healthy sibling — this box serves several, and `any` in place of `all` would idle the rest five minutes at a time.
    #[test]
    fn one_limited_project_does_not_slow_a_healthy_one() {
        let mixed = served(&[("online", Some(3600)), ("online", None)]);
        assert_eq!(next_poll_delay(&mixed), POLL_INTERVAL);
    }

    // cm:guard an EXPIRED stamp is the normal steady state, not a live limit: core clears the column only on a successful job, so reading a lapsed limit as live turns the backoff permanent.
    #[test]
    fn an_expired_limit_polls_at_full_speed() {
        assert_eq!(
            next_poll_delay(&served(&[("online", Some(0))])),
            POLL_INTERVAL
        );
    }

    // cm:guard an older core sends no field at all, and absent must mean "poll normally" — the permissive direction, opposite to `kind`. A cautious default here would idle every box talking to a core that predates the field.
    #[test]
    fn a_core_that_does_not_report_limits_polls_at_full_speed() {
        assert_eq!(next_poll_delay(&served(&[("online", None)])), POLL_INTERVAL);
    }

    // cm:guard a drained runner must not hold the whole box at full speed, nor drag it into a backoff: it is not a candidate for work at all, so it is excluded before the decision.
    #[test]
    fn a_drained_runner_is_not_counted_either_way() {
        let mix = served(&[("draining", None), ("online", Some(3600))]);
        assert!(next_poll_delay(&mix) > POLL_INTERVAL);
    }

    // cm:guard the registry is per PROJECT, and the second assertion is the whole test: a box-wide flag would leave every project after the first unserved for as long as any one master lived.
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

    // cm:guard the policy must arrive VERBATIM and this asserts exactly that. A master briefed with a summary of the owner's instruction is a master following the summariser, and the whole failure ISS-929 fixes is an instruction that reached the pane wrong or not at all.
    // cm:edge lockstep -> packages/runner/crates/forge-runner-core/assets/forge-master-skill.md — the verb and the instruction to use it ship in one binary and are useless apart: a `decide` nothing tells the master about is a denominator that stays zero, which reads as a master that asks about everything (ISS-964 criterion 2).
    #[test]
    fn the_brief_tells_the_master_to_record_what_it_decided_rather_than_asked() {
        assert!(
            MASTER_SKILL.contains("pool decide"),
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
        let brief = standing_prompt("forge-dev", Some("main"), Some(policy));
        assert!(
            brief.contains(policy),
            "the policy must be spliced whole: {brief}"
        );
        assert!(
            brief.contains("OUTRANKS"),
            "the brief must say the policy beats the skill's defaults: {brief}"
        );
    }

    // cm:guard a project that set no policy must be briefed EXACTLY as it was before ISS-929. The absent case is every project on the fleet but one, so a stray heading or blank section here is a change to every master this repo starts.
    #[test]
    fn no_policy_leaves_the_brief_untouched() {
        let brief = standing_prompt("forge-dev", Some("main"), None);
        assert!(!brief.contains("standing policy"), "{brief}");
        assert!(
            brief.trim_end().ends_with("this pane is the record."),
            "{brief}"
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

    struct Alive(bool);
    #[async_trait::async_trait]
    impl recovery::MasterLiveness for Alive {
        async fn is_alive(&self, _id: &str) -> bool {
            self.0
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
    struct Closes(Mutex<Vec<(String, close_loop::Outcome)>>);
    #[async_trait::async_trait]
    impl close_loop::RunCloser for Closes {
        async fn close(
            &self,
            agent_session_id: &str,
            outcome: close_loop::Outcome,
            _detail: &str,
        ) -> R<()> {
            self.0
                .lock()
                .unwrap()
                .push((agent_session_id.to_string(), outcome));
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

    // cm:guard the discriminating assertion is that core is TOLD, not that the pid was killed. A build that kills the pane and says nothing still passes every other test in this file, and that build is what this box shipped for weeks: core's ten-minute sweep then wrote `runner_unreachable` over a box that had ended the run deliberately, which is ~95% of a 203-session failure bucket nobody can now decompose.
    #[tokio::test]
    async fn ending_an_idle_run_tells_core_the_box_did_it() {
        let mut led = a_ledger_holding_one_run();
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

        assert_eq!(
            closes.0.lock().unwrap().as_slice(),
            &[("core-sess-1".to_string(), close_loop::Outcome::KilledIdle)],
            "an idle reap must reach core as its own outcome, not as silence"
        );
        assert_eq!(killed.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    // cm:guard the discriminating assertion is the BEAT, not that a run was closed. Core reaps a run session silent for ten minutes, so a sweep that reconciled without beating would take every healthy run on this box back after ten minutes — a test that only watched the closing half would go green on exactly that build (ISS-933 criteria 16 and 25a).
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

    // cm:guard the branch Windows actually took: `inflight::boot_identity` answers `None` there, and `unwrap_or_default` hands this an empty string. An empty boot matches NO recorded run, so a build without this refusal reads every live run on the box as orphaned and takes its worktree — the two tests above went red on CI's windows-latest before this branch existed.
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

    // cm:guard the assertion is that core hears it FROM THE BOX. Without this call the only thing that ever flips the session is core's ten-minute silence sweep, which writes `runner_unreachable` over a box that is plainly reachable — it is talking to core in this very sweep — and holds the run's issues for those ten minutes (forge-vm 2026-09-12: every failure on two projects showed ~10 minutes between `last_heartbeat_at` and `updated_at`, ~95% of 203 sessions in that one bucket).
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

        assert_eq!(
            closes.0.lock().unwrap().as_slice(),
            &[("core-sess-1".to_string(), close_loop::Outcome::Died)],
            "a run whose process this box refuted must reach core as a death, from the box, now"
        );
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(repo.with_extension("remote.git"));
    }

    // cm:guard the assertions are the CHECKOUT off the disk and `ended_by` written, never that a warning changed: the deadlock this closes is invisible to every mark-level assertion, because all three marks are exactly what a stuck run already has. `close_loop::close` alone leaves this run untouched forever — it observes, and the tree is still there to observe (forge-vm 2026-09-10: 24 runs, 24 trees, every lease held under them).
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

    // cm:guard the DIFF is asserted on the remote, not merely that the tree went away: `force_terminal` aborts before touching a worktree whose work could not be preserved, so a build that released this one anyway would pass every assertion about disk and `ended_by` while having thrown away an agent's uncommitted work. Every stuck run measured on forge-vm 2026-09-10 was carrying one.
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

    // cm:guard depth 1 is the assertion and a mere `contains` is NOT enough: measured while writing this, `if false { give_back_lost_runs(...) }` passed a containment check, so the scan agreed with a build in which no run on the box is ever beaten. A call sitting under any condition is a call an operator cannot rely on.
    #[test]
    fn the_sweep_reconciles_unconditionally() {
        assert_eq!(
            depth_of_call_in_sweep("give_back_lost_runs("),
            Some(1),
            "the sweep must reconcile what this box holds on EVERY pass; behind a condition, or gone, nothing beats a run session and core reaps every healthy one after ten minutes"
        );
    }

    fn entry(job_id: &str) -> pool::PoolEntry {
        serde_json::from_value(serde_json::json!({ "jobId": job_id, "type": "drive" }))
            .expect("pool entry fixture")
    }

    fn admiss(issue_id: &str) -> pool::AdmissibleIssue {
        serde_json::from_value(serde_json::json!({ "issueId": issue_id }))
            .expect("admissible fixture")
    }

    #[test]
    fn a_master_with_no_recorded_nudge_is_nudged() {
        assert!(nudge_due(None, 7, Instant::now()));
    }

    // cm:guard the falsifying case: everything else here passes against the unconditional nudge this replaced.
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

    // cm:guard the ceiling on silence, and the test that has to fail if anyone turns this backoff into a skip. Unchanged work must STILL reach the master on `NUDGE_REFRESH`, because a pass lost to a wedged pane or a limit cleared out of band is otherwise never retried.
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
        let a = work_digest(&[entry("j1"), entry("j2")], &[admiss("i1"), admiss("i2")]);
        let b = work_digest(&[entry("j2"), entry("j1")], &[admiss("i2"), admiss("i1")]);
        assert_eq!(a, b);
    }

    #[test]
    fn the_digest_moves_when_a_row_arrives_or_leaves() {
        let one = work_digest(&[entry("j1")], &[]);
        assert_ne!(one, work_digest(&[entry("j1"), entry("j2")], &[]));
        assert_ne!(one, work_digest(&[], &[]));
        assert_ne!(one, work_digest(&[], &[admiss("j1")]));
    }

    // cm:guard identity ONLY. A title or a priority moving is not new work, and a digest that tracked them would nudge on every edit an operator makes in the UI.
    #[test]
    fn the_digest_ignores_everything_but_the_ids() {
        let plain: pool::PoolEntry =
            serde_json::from_value(serde_json::json!({ "jobId": "j1", "type": "drive" })).unwrap();
        let dressed: pool::PoolEntry = serde_json::from_value(serde_json::json!({
            "jobId": "j1", "type": "drive", "title": "renamed", "priority": "critical",
            "status": "queued"
        }))
        .unwrap();
        assert_eq!(work_digest(&[plain], &[]), work_digest(&[dressed], &[]));
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

    // cm:guard the ratchet on the call SITE, not the helper: `claim_nudge` is worth nothing if a later edit calls `nudge_master` beside it rather than inside it, and that mistake restores a spend proportional to sweeps with every unit test still green.
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
