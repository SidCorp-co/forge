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
use crate::daemon::dispatch::resolve_repo;
use crate::daemon::master_exit::{self, Verdict};
use crate::daemon::recovery;
use crate::daemon::recovery_ports::{CoreBeat, CoreRunState, PaneMasters};
use crate::daemon::terminal;
use crate::runner::ledger::Ledger;
use crate::transport::{master as master_api, pool, runners, CoreClient};
use tokio::sync::mpsc;

/// How often the box asks whether any work exists.
// cm:why this interval IS the latency from an issue opening to an agent touching it, and it is the whole budget: nothing pushes any more, so a job queued one tick after a poll waits a full interval before anything looks. 30s was chosen against the old push path's measured dispatch lag on epodsystem (queue→dispatch of 17m, 23m, 46m and 2h08 on 2026-09-04) — an order of magnitude of headroom, at one cheap request per project per half minute.
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// The closest together two wake-driven sweeps may run.
// cm:guard this is a COALESCING FLOOR, never a rate limit that drops work. A wake inside the window waits out the remainder and then sweeps; it is not discarded. Core publishes one `master.wake` per issue arrival, so promoting five drafts or closing a batch delivers five frames in about as many milliseconds, and a sweep per frame would be five `/me/runners` reads plus five pool reads per project to find what the first one already found. The channel is capacity 1 and extra frames are dropped ON PURPOSE while one is pending — the sweep that follows reads the WHOLE pool, so a dropped frame costs nothing a later read does not already cover.
const WAKE_FLOOR: Duration = Duration::from_secs(5);

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
        "\nYou NAME every agent you start: `forge-runner pool claim <jobId> --session-id <id> \
--agent <name>`. The name becomes that agent's git branch and its worktree, so it must read as \
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
}

impl Masters {
    pub fn new() -> Self {
        Self::default()
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
                delay = sweep(&client, &cfg, &masters, &mut ledger).await;
                last_sweep = Instant::now();
            }
            Some(w) = wake.recv() => {
                let since = last_sweep.elapsed();
                if since < WAKE_FLOOR {
                    tokio::time::sleep(WAKE_FLOOR - since).await;
                }
                tracing::info!("[master] wake ({}) — sweeping now", w.describe());
                delay = sweep(&client, &cfg, &masters, &mut ledger).await;
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

        let Some(session) = ensure_master(client, masters, &runner.project_id, &resolved).await
        else {
            continue;
        };

        if items.is_empty() && admissible.is_empty() {
            continue;
        }

        nudge_master(masters, &runner.project_id, &resolved.slug, &session).await;
    }

    give_back_lost_runs(
        &PaneMasters { masters },
        &CoreRunState { client },
        &CoreRunState { client },
        &CoreBeat { client },
        ledger,
    )
    .await;
    delay
}

/// Beat what this box still holds, and close the loop on what it does not.
// cm:guard runs AFTER the per-project loop, and the order is the assertion. `ensure_master` re-registers every live master into `Masters` on each pass, and `PaneMasters` reads that map for the pane NAME — placed before the loop, a daemon restart would meet an empty map and read every live run on the box as orphaned (ISS-933 criterion 16).
// cm:guard the beat rides in this same call and is not separable: core reaps a run session silent for ten minutes, so a sweep that reconciled without beating would take back every healthy run on the box (ISS-933 criteria 16 and 25a).
async fn give_back_lost_runs(
    live: &dyn recovery::MasterLiveness,
    sessions: &dyn crate::runner::close_loop::SessionReader,
    leases: &dyn crate::runner::close_loop::LeaseKeeper,
    beat: &dyn recovery::Heartbeat,
    ledger: &mut Option<Ledger>,
) {
    let Some(led) = ledger.as_mut() else { return };
    // cm:guard no boot id means no reconcile, and that refusal is the safe direction. The boot is what separates "the master died within this boot" from "everything recorded before a reboot belongs to a stranger"; guessing one would close the loop over live runs on a box that simply cannot report its own boot (ISS-933 criterion 16).
    let Some(boot_id) = crate::runner::inflight::boot_identity() else {
        tracing::warn!("[master] this box reports no boot id — leaving unclosed runs alone");
        return;
    };
    match recovery::reconcile(led, &boot_id, live, sessions, leases, beat).await {
        Ok(done) => {
            for r in done.iter().filter(|r| !r.state.is_closed()) {
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
) -> Option<master_api::MasterSession> {
    let name = terminal::session_name(terminal::MASTER_PREFIX, &resolved.slug);
    // cm:guard refuse by name when tmux is missing rather than falling back to the per-pass `claude -p` this replaced. A box that quietly reverted would look identical in the log to one that is working, while none of the liveness, the transcript or the addressable pane exist on it.
    if !terminal::available() {
        tracing::error!(
            "[master] {}: tmux is not installed on this box — no master will run for it; install tmux (`forge-runner doctor` checks for it)",
            resolved.slug
        );
        return None;
    }

    let session = match master_api::register(client, project_id, &name).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("[master] {}: cannot register with core: {e}", resolved.slug);
            return None;
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
        return Some(session);
    }

    // cm:guard refuse to start when the skill cannot be written, rather than starting without it. A master with no skill still starts, still claims, and runs the whole orchestration off a four-line prompt — work that looks like it is being managed and is not.
    if let Err(e) = install_skill(&resolved.repo_path) {
        tracing::error!(
            "[master] {}: could not install the forge-master skill into {}: {e} — not starting a master",
            resolved.slug,
            resolved.repo_path.display()
        );
        return None;
    }

    // cm:guard the pane is the ONE session this runner opens on a TTY, and a TTY is the only place Claude Code shows the workspace-trust prompt. An unanswered prompt is a session that ends without doing anything and takes the breaker above with it, so the stamp belongs immediately before the spawn — `workspace::provision` covers a fresh box, this covers every box provisioned before it shipped (ISS-928, forge-vm 2026-09-06).
    crate::workspace::trust::pre_trust_logged(&resolved.repo_path, &resolved.slug);

    let transcript = transcript_path(&resolved.slug);
    match terminal::ensure(
        &name,
        &resolved.repo_path,
        &terminal::pane_argv(),
        &terminal::pane_env(),
        transcript.as_deref(),
    )
    .await
    {
        Ok(_) => {}
        Err(e) => {
            tracing::error!("[master] {}: could not start {name}: {e}", resolved.slug);
            return None;
        }
    }
    tracing::info!(
        "[master] {}: resident session {name} started in {} — `tmux attach -t {name}` to watch it",
        resolved.slug,
        resolved.repo_path.display()
    );
    remember(masters, project_id, &session);

    // cm:guard the standing brief is typed ONCE, into a pane that has just started, and the sleep is not decoration: Claude Code draws its composer after a startup that takes a second or two, and a paste that lands before it is dropped on the floor with no error anywhere. The next sweep would then prompt a master that was never briefed.
    tokio::time::sleep(Duration::from_secs(5)).await;
    let brief = standing_prompt(
        &resolved.slug,
        resolved.base_branch.as_deref(),
        resolved.master_policy.as_deref(),
    );
    if let Err(e) = terminal::send_line(&name, &brief).await {
        tracing::warn!("[master] {}: could not brief {name}: {e}", resolved.slug);
    }
    Some(session)
}

fn remember(masters: &Arc<Masters>, project_id: &str, session: &master_api::MasterSession) {
    masters.remember(
        project_id,
        MasterState {
            session_id: session.session_id.clone(),
            name: session.name.clone(),
            last_work: Instant::now(),
        },
    );
}

/// The whole of one pass prompt: go, and who you are.
// cm:guard the pool is NOT embedded here, and that absence is what let the quiet gate go. The skill's own first step is `pool list`, so a snapshot typed at the master is a second copy that is already stale by the time the turn reaches it — and a prompt that queued behind a turn then acted on that copy is exactly what the deleted quiet gate existed to prevent (ISS-933 criterion 17).
// cm:edge contract -> packages/runner/crates/forge-runner-core/assets/forge-master-skill.md — the skill is told `--session-id` is GIVEN, never invented, and this line is the only thing that gives it. A pass that omitted it has the master mint a fresh uuid and split its own inbox.
fn nudge(session_id: &str) -> String {
    format!(
        "Pass. Your master session id is `{session_id}` — pass it as `--session-id`. Read the \
pool, decide, claim what you are confident about, report, and stop."
    )
}

/// Tell a master there is something to look at.
// cm:guard nothing gates this on the master looking idle. Residency used to be policed from outside — transcript growth read as liveness, a quiet window before prompting, a ceiling that killed — and every one of those inferred a process state from a pane's byte count (ISS-933 criteria 17 and 18). A wake is coalesced by `WAKE_FLOOR` and carries no work, so an extra one costs a line in a composer.
async fn nudge_master(
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
    session: &master_api::MasterSession,
) {
    let Some((_, name)) = masters.get(project_id) else {
        return;
    };
    tracing::info!("[master] {slug}: work in the pool — nudging {name}");
    if let Err(e) = terminal::send_line(&name, &nudge(&session.session_id)).await {
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

    struct Terminal(bool);
    #[async_trait::async_trait]
    impl SessionReader for Terminal {
        async fn is_terminal(&self, _id: &str) -> R<bool> {
            Ok(self.0)
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

    fn a_ledger_holding_one_run() -> (Ledger, String) {
        let mut led = Ledger::open_in_memory().unwrap();
        let boot = crate::runner::inflight::boot_identity().unwrap_or_default();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: "/nonexistent/wt".into(),
            boot_id: boot.clone(),
            issue_keys: vec!["ISS-1".into(), "ISS-2".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        (led, boot)
    }

    // cm:guard the discriminating assertion is the BEAT, not that a run was closed. Core reaps a run session silent for ten minutes, so a sweep that reconciled without beating would take every healthy run on this box back after ten minutes — a test that only watched the closing half would go green on exactly that build (ISS-933 criteria 16 and 25a).
    #[tokio::test]
    async fn a_sweep_beats_the_runs_this_box_still_holds() {
        let (led, _) = a_ledger_holding_one_run();
        let mut ledger = Some(led);
        let beats = Beats::default();

        give_back_lost_runs(
            &Alive(true),
            &Terminal(false),
            &Leases::default(),
            &beats,
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
        let (led, _) = a_ledger_holding_one_run();
        let mut ledger = Some(led);
        let beats = Beats::default();
        let leases = Leases::default();

        give_back_lost_runs(&Alive(false), &Terminal(true), &leases, &beats, &mut ledger).await;

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
}
