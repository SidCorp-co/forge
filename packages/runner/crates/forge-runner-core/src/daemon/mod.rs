//! Daemon orchestration.
//!
//! Loop: connect WS → subscribe `device:<id>` → heartbeat every 30s → ask
//! which issues are admissible, keep a resident master up for each project
//! that has some, and nudge it. The runs
//! are the master's own subagents and never reach this process. Interactive
//! chat (`agent:start` / `agent:send` / `agent:abort`) is handled out-of-band
//! by `chat`, under its own concurrency budget (ISS-321).
//!
//! The job kinds with no issue to rank — `release_batch` and `smoke` — do NOT
//! go to a master. They sit in the JOBS
//! pool and reach this box through `pool_jobs`, which opens a pane per job and
//! supervises it here (ISS-1080).

pub mod agent_activity;
pub mod chat;
pub mod checkpoint;
pub mod composer;
pub mod control;
pub mod degraded;
pub mod dispatch;
pub mod dispatch_gate;
pub mod drain;
pub mod git_exclude;
pub mod headroom;
pub mod held_report;
pub mod hook_install;
pub mod inbox;
pub mod job_exit;
pub mod job_unheard;
pub mod master;
pub mod master_exit;
pub mod master_inbox;
pub mod master_limit;
pub mod master_pass;
pub mod master_skill;
pub mod pane_exit;
pub mod pool_jobs;
pub mod pool_reads;
pub mod recovery;
pub mod recovery_ports;
pub mod run_exit;
pub mod run_record;
pub mod serving;
pub mod session_tokens;
pub mod skill_pull;
pub mod subagent_end;
pub mod subagent_host;
pub mod terminal;
pub mod transcript_age;
pub mod turn_evidence;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::{mpsc, watch};

use crate::config::Config;
use crate::error::Result;
use crate::runner::claude_code::ClaudeCodeRunner;
use crate::runner::inflight;
use crate::runner::Runner;
use crate::transport::frames::{job_id_of, session_id_of, Frame};
use crate::transport::runners::{self, MeRunner};
use crate::transport::ws::{self, WsConfig};
use crate::transport::{heartbeat, lifecycle, CoreClient};

use dispatch::resolve_repo;

pub(crate) const POOL_SUPERVISE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// What core would not take off this box's heartbeat, said where an operator
/// reads: a report core refuses is reaching nobody but this box.
fn warn_refused(refused: &heartbeat::Refused) {
    if let Some(r) = &refused.gate {
        tracing::warn!(
            "[gate] core refused this box's gate condition: {r} — the gate's state is reaching \
             nobody but this box, which is the silence the report exists to end"
        );
    }
    if let Some(r) = &refused.pool {
        tracing::warn!(
            "[pool] core refused this box's pool-read report: {r} — which projects this box \
             cannot read is reaching nobody but this box's own status and log"
        );
    }
}

/// Say once, at a level somebody watches, that this box's declaration gate has
/// started admitting work it never judged.
///
/// The hook that writes most of these marks is a short-lived process whose
/// output reaches nobody, so before this the journal was silent through 278 of
/// them (ISS-1192). `shouted` is what stops it being said every thirty seconds.
///
/// Returns whether it spoke, so the rule can be asserted rather than read off a
/// log somebody has to capture.
fn announce_gate(gate: &crate::proto_gate::Condition, shouted: &mut Option<crate::proto_gate::Verdict>) -> bool {
    let speak = gate.verdict == crate::proto_gate::Verdict::FailingOpen && *shouted != Some(gate.verdict);
    if speak {
        tracing::warn!(
            "[gate] this box's declaration gate is FAILING OPEN: {} dispatch(es) admitted without \
             a decision at {}/day, newest {}s ago. Every one of them ran with the declaration \
             instruction as advice. Last reason: {}",
            gate.count,
            gate.per_day.unwrap_or_default().round(),
            gate.since_last_ms.unwrap_or_default() / 1000,
            gate.last
                .as_ref()
                .map_or("none recorded", |l| l.detail.as_str()),
        );
    }
    *shouted = Some(gate.verdict);
    speak
}

/// RAII counter for in-flight work (pipeline jobs + interactive chat turns).
/// Incremented when a unit of work is spawned, decremented on drop — so the
/// auto-update loop can drain to idle before restarting the service (ISS-392),
/// rather than killing a job or chat session mid-flight. Drop fires on both the
/// success and error paths, so a panicking task still releases its slot.
pub(crate) struct InflightGuard(Arc<AtomicUsize>);

impl InflightGuard {
    pub(crate) fn enter(counter: &Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::AcqRel);
        Self(counter.clone())
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

const CHECKPOINT_BUDGET: std::time::Duration = std::time::Duration::from_secs(120);

const SESSION_LEDGER_INTERVAL: std::time::Duration = std::time::Duration::from_secs(20);

/// How often the update loop asks whether a newer release exists.
const UPDATE_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(6 * 3600);

/// Every run session the drain must assume is live, each by name.
fn live_run_sessions() -> Vec<String> {
    let boot = crate::runner::inflight::boot_identity().unwrap_or_default();
    let led = match crate::runner::ledger::Ledger::default_path()
        .and_then(|p| crate::runner::ledger::Ledger::open(&p))
    {
        Ok(led) => led,
        Err(err) => return vec![unreadable_ledger(&err)],
    };
    live_sessions_from(led.unclosed_runs(), &boot, pid_alive, |run_id| {
        led.issues(run_id)
            .map(|m| m.into_iter().map(|i| i.issue_key).collect())
            .unwrap_or_default()
    })
}

/// Whether a subagent run reads quiet on its own evidence: its last turn ended
/// an hour or more ago and nothing but that turn-end's own records, or an
/// entry left an hour unanswered, was written after it; or the master pane its
/// subagent lived in has ended since anything was heard from it. A restart
/// touches neither the subagent, which lives in its master's process, nor its
/// tree, so a quiet run does not hold one. One still working, or one whose
/// transcript this box cannot read, still does (ISS-1246, ISS-1312).
///
/// A run declared and never bound is its declaring pane's, so that pane
/// ending is the end of it too: nothing that pane would have started can bind
/// it now.
fn reads_quiet(run: &crate::runner::ledger::Run, now: i64) -> bool {
    if run.pid.is_some() {
        return false;
    }
    let evidence = subagent_end::of_run(run, now);
    match run.agent_id {
        Some(_) => subagent_end::is_quiet(evidence),
        None => matches!(evidence, subagent_end::Evidence::HostEnded { .. }),
    }
}

/// Why the drain counts `run` as work a restart would stop, in its own line.
fn why_held(run: &crate::runner::ledger::Run, now: i64) -> String {
    match (run.pid, run.agent_id.as_deref()) {
        (Some(pid), _) => format!("its process {pid} is alive"),
        (None, Some(_)) => subagent_end::held_because(
            subagent_end::of_run(run, now),
            run.agent_transcript.as_deref(),
        ),
        (None, None) => "declared, and no subagent or process is bound to it yet".to_string(),
    }
}

/// The holder a ledger that will not answer stands for.
///
/// A ledger this cannot read is not an empty one. Answering nought there told
/// the drain the box was idle, and the drain's whole job is to decide whether a
/// restart would kill work — so the one reply it could not check became the one
/// that restarts over every run in flight. The path that reaches it is the
/// first start after an upgrade, which is exactly where the ledger was
/// unreadable in the first place (ISS-1201). So it holds the drain like any
/// other holder, and is named like one.
fn unreadable_ledger(err: &crate::error::Error) -> String {
    tracing::error!(
        "[drain] the run ledger will not answer ({err}) — this box counts as busy rather than idle, so a restart is deferred instead of taken over work nothing can see"
    );
    format!("the run ledger, which will not answer ({err})")
}

/// The live runs among `runs`, each named by id and the issues it was given.
fn live_sessions_from(
    runs: Result<Vec<crate::runner::ledger::Run>>,
    this_boot: &str,
    alive: impl Fn(u32) -> bool,
    issue_keys: impl Fn(&str) -> Vec<String>,
) -> Vec<String> {
    match runs {
        Ok(runs) => {
            let now = agent_activity::now_ms();
            live_runs(&runs, this_boot, alive, |r| reads_quiet(r, now))
                .into_iter()
                .map(|r| {
                    let keys = issue_keys(&r.run_id);
                    let keys = if keys.is_empty() {
                        "no issue recorded".to_string()
                    } else {
                        keys.join(", ")
                    };
                    format!("run {} ({keys}): {}", r.run_id, why_held(r, now))
                })
                .collect()
        }
        Err(err) => vec![unreadable_ledger(&err)],
    }
}

fn live_runs<'a>(
    runs: &'a [crate::runner::ledger::Run],
    this_boot: &str,
    alive: impl Fn(u32) -> bool,
    quiet: impl Fn(&crate::runner::ledger::Run) -> bool,
) -> Vec<&'a crate::runner::ledger::Run> {
    use crate::runner::ledger::{Ledger, Liveness};
    runs.iter()
        .filter(|r| !r.is_parked_on_human())
        .filter(|r| r.boot_id == this_boot)
        .filter(|r| !quiet(r))
        .filter(|r| {
            let pid_refuted = r.pid.is_some_and(|p| !alive(p));
            !matches!(Ledger::liveness(r, this_boot, pid_refuted), Liveness::Dead)
        })
        .collect()
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    crate::proc::pid_alive(pid)
}

#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool {
    false
}

/// Run `check` now and then once every `every`, measured from the start of
/// each check, until `cancel` says stop.
///
/// The wait comes before the check, so the interval's first tick — which
/// completes at once — is the first check and not a second one straight after
/// it. Checked the other way round, a first check whose drain gave up after two
/// hours was followed at once by another, which downloaded the release again
/// and was refused by the reopen interval the line before it had announced
/// (ISS-1223).
async fn update_checks<F, Fut>(
    every: std::time::Duration,
    mut cancel: watch::Receiver<bool>,
    mut check: F,
) where
    F: FnMut(tokio::time::Instant) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = cancel.changed() => {
                if *cancel.borrow() { break; }
                continue;
            }
        }
        check(tokio::time::Instant::now()).await;
    }
}

/// Rewrite the hook commands of every project bound on this box that name a
/// program nothing can run. `server` is `/me/runners` as this box last read it,
/// and `None` where it could not be asked at all — which the sweep reports,
/// because the checkouts it then cannot see are exactly the ones it exists for.
///
/// Fixing where the path comes from reaches only panes prepared from now on.
/// A project this daemon does not dispatch to keeps whatever a pre-fix daemon
/// wrote into it — a dead declaration gate and eight dead reporters — until
/// somebody opens a session in it by hand. `when` names the moment this ran, so
/// the journal distinguishes the sweep at boot from the one an update triggered.
fn repair_installed_hooks(server: Option<&[MeRunner]>, cfg: &Config, when: &str) {
    let exe = match crate::exe::own() {
        Ok(exe) => exe,
        Err(e) => {
            tracing::error!(
                "[hooks] {when}: {e} — no project's hooks can be repaired, and any already naming a dead path stay dead"
            );
            return;
        }
    };
    if let Some(was) = &exe.replaced_from {
        tracing::warn!(
            "[hooks] {when}: the binary this daemon started on ({}) was replaced while it ran — every hook it writes from here names {}, the build standing there now",
            was.display(),
            exe.path.display()
        );
    }
    let bound = bound_checkouts(server.unwrap_or_default(), cfg);
    if server.is_none() {
        tracing::warn!(
            "[hooks] {when}: this box could not ask core which projects are assigned to it, so the sweep covers only the {} checkout(s) config.toml names — a project bound from the web UI and absent from that file keeps whatever hooks it holds, a dead declaration gate included",
            bound.checkouts.len()
        );
    }
    for slug in &bound.pathless {
        tracing::warn!(
            "[hooks] {when}: {slug} is assigned to this box and names a checkout on neither side, so it has no settings file to sweep — `forge-runner bind {slug} --path <dir>`"
        );
    }
    for (slug, repo) in &bound.checkouts {
        match crate::daemon::hook_install::repair(repo, &exe.path) {
            Ok(unrunnable) if unrunnable.is_empty() => {}
            Ok(unrunnable) => tracing::warn!(
                "[hooks] {when}: {slug}'s settings named {}, which nothing can run — that file's hook commands now name {}, and a session already open in that checkout keeps the dead ones until it is restarted, Claude Code having read the file at startup",
                unrunnable.join(", "),
                exe.path.display()
            ),
            Err(e) => tracing::warn!(
                "[hooks] {when}: {slug}'s hooks in {} could not be repaired: {e}",
                repo.display()
            ),
        }
    }
}

/// Write the running build's forge-master skill into every checkout this box
/// is bound to, whether or not a master is placed or adopted there (ISS-1357).
/// Run at start only: the process an update replaces carries the old build's
/// asset, and the restart that applies the update is a start.
///
/// `census_from` is taken before `cfg` was read, so a `bind` that `cfg` does not
/// show is one recorded after it and survives the census; `None` where `cfg`
/// is not a fresh read, which prunes nothing.
fn install_master_skills(
    server: Option<&[MeRunner]>,
    cfg: &Config,
    census_from: Option<i64>,
    record_dir: Option<&std::path::Path>,
) {
    let bound = bound_checkouts(server.unwrap_or_default(), cfg);
    if server.is_none() {
        tracing::warn!(
            "[skill] this box could not ask core which projects are assigned to it, so the forge-master skill is written only into the {} checkout(s) config.toml names",
            bound.checkouts.len()
        );
    }
    crate::daemon::master_skill::install_every(
        &bound.every,
        &bound.pathless,
        census_from.filter(|_| server.is_some()),
        record_dir,
    );
}

/// Every checkout this box is bound to, and every assignment that names none.
struct BoundCheckouts {
    /// Slug and working directory, one per distinct path, sorted.
    checkouts: Vec<(String, std::path::PathBuf)>,
    /// Every distinct slug and working directory, so two projects sharing a
    /// checkout are each named where a per-project record is kept.
    every: Vec<(String, std::path::PathBuf)>,
    /// Slugs assigned to this device that name a checkout on neither side, so
    /// there is no settings file to sweep and the daemon cannot make one.
    pathless: Vec<String>,
}

/// The checkouts a sweep has to cover: the server's assignments, resolved the
/// way a dispatch resolves them, unioned with the local `config.toml` bindings.
///
/// `cfg.bindings` alone is not that set. `config.toml` is only a local fallback
/// now (ISS-271): a project bound to this device from the web UI lives in the
/// `runners` table with its `repo_path` and need never appear in that file, and
/// `resolve_repo` prefers the server's path over a local binding's. A sweep
/// over the fallback therefore reaches the projects this box happens to hold a
/// local binding for rather than the ones it writes hooks into, and a
/// server-bound checkout kept a dead `PreToolUse` gate through every boot with
/// the journal never naming it (ISS-1200).
///
/// The union rather than the resolution alone, because both paths are ones this
/// daemon has written hooks into: a project whose server path was set after a
/// local binding already existed has a poisoned file at the old path too, and
/// the sweep is the only thing that reaches a checkout no pane is prepared for.
fn bound_checkouts(server: &[MeRunner], cfg: &Config) -> BoundCheckouts {
    let mut checkouts: Vec<(String, std::path::PathBuf)> = Vec::new();
    let mut every: Vec<(String, std::path::PathBuf)> = Vec::new();
    let mut pathless: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();
    for r in server {
        match resolve_repo(server, cfg, &r.project_id) {
            Ok(resolved) => {
                every.push((resolved.slug.clone(), resolved.repo_path.clone()));
                if seen.insert(resolved.repo_path.clone()) {
                    checkouts.push((resolved.slug, resolved.repo_path));
                }
            }
            Err(slug) => pathless.push(slug),
        }
    }
    for (slug, binding) in &cfg.bindings {
        every.push((slug.clone(), binding.repo_path.clone()));
        if seen.insert(binding.repo_path.clone()) {
            checkouts.push((slug.clone(), binding.repo_path.clone()));
        }
    }
    checkouts.sort();
    every.sort();
    every.dedup();
    pathless.sort();
    pathless.dedup();
    BoundCheckouts {
        checkouts,
        every,
        pathless,
    }
}

async fn close_parked_sessions(runner: &Arc<ClaudeCodeRunner>) -> usize {
    runner.checkpoint_and_close(CHECKPOINT_BUDGET).await.len()
}

/// Run the daemon until Ctrl-C. `device_token` comes from the cred store.
pub async fn run(
    cfg: Config,
    core_url: String,
    device_id: String,
    device_token: String,
) -> Result<()> {
    // Surface which credential store the daemon resolved, so the journal makes
    // recovery unambiguous (ISS-467) — interactive/headless/systemd contexts can
    // otherwise disagree about where the token lives.
    tracing::info!(
        "[cred] device token store: {}",
        crate::auth::cred_store::active_backend()
    );
    let client = Arc::new(CoreClient::new(core_url.clone(), device_token.clone()));
    let runner = Arc::new(ClaudeCodeRunner::new(
        core_url.clone(),
        device_token.clone(),
        (cfg.runner.duplex_max_sessions as usize).max(1),
    ));

    // Discover server-side assignments (`/me/runners`). This is the source of
    // truth for which projects route to this device and for their repo paths;
    // config.toml is only a local fallback now (ISS-271). Best-effort: an old
    // server or transient failure falls back to config-only behaviour.
    let server: Option<Vec<MeRunner>> = match runners::list_me(&client).await {
        Ok(rows) => Some(rows),
        Err(e) => {
            tracing::warn!(
                "[me/runners] discovery failed ({e}) — using local config bindings only"
            );
            None
        }
    };
    let assigned: &[MeRunner] = server.as_deref().unwrap_or_default();

    for r in assigned {
        // AC 5 — warn when assigned on the server but no usable repo path
        // (neither server nor local), with the exact command to fix it.
        if resolve_repo(assigned, &cfg, &r.project_id).is_err() {
            tracing::warn!(
                "[me/runners] project '{}' is assigned but has no local repo path — run `forge-runner bind {} --path <dir>`",
                r.slug,
                r.slug
            );
        }
    }
    if assigned.is_empty() && cfg.bindings.values().all(|b| b.project_id.is_none()) {
        tracing::warn!(
            "no project assignments — jobs cannot be routed. Bind a device in the web UI, then run `forge-runner bind <slug> --path <dir>`."
        );
    }

    // Before any pane is prepared: whatever the daemon this one replaced wrote
    // into these checkouts is still there, and this process CAN name itself.
    repair_installed_hooks(server.as_deref(), &cfg, "boot");
    let census_from = agent_activity::now_ms();
    let (fresh, census_from) = match Config::load() {
        Ok(fresh) => (fresh, Some(census_from)),
        Err(e) => {
            tracing::warn!(
                "[skill] config.toml could not be read again ({e}), so the forge-master install covers the bindings read at start and prunes no line of its record"
            );
            (cfg.clone(), None)
        }
    };
    install_master_skills(
        server.as_deref(),
        &fresh,
        census_from,
        crate::config::config_dir().as_deref(),
    );

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (frame_tx, mut frame_rx) = mpsc::channel::<Frame>(256);
    let (ledger_tx, ledger_rx) = watch::channel::<Option<String>>(None);

    // WebSocket connect loop.
    {
        // tungstenite needs a ws:// / wss:// scheme, not http(s)://.
        let ws_base = core_url
            .trim_end_matches('/')
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        let ws_cfg = WsConfig {
            url: format!("{ws_base}/ws"),
            device_token: device_token.clone(),
            device_id: device_id.clone(),
        };
        let cancel_rx = cancel_rx.clone();
        tokio::spawn(async move { ws::connect(ws_cfg, frame_tx, ledger_rx, cancel_rx).await });
    }

    {
        let mut cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            let boot_id = crate::runner::inflight::boot_identity().unwrap_or_default();
            let mut tick = tokio::time::interval(SESSION_LEDGER_INTERVAL);
            loop {
                tokio::select! {
                    _ = tick.tick() => {}
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } else { continue; } }
                }
                let snapshot = crate::runner::ledger::Ledger::default_path()
                    .and_then(|p| crate::runner::ledger::Ledger::open(&p))
                    .and_then(|led| crate::transport::session_ledger::snapshot(&led));
                match snapshot {
                    Ok(runs) => {
                        let _ = ledger_tx.send(Some(crate::transport::session_ledger::frame(
                            &boot_id, &runs,
                        )));
                    }
                    Err(e) => tracing::warn!("[ledger] snapshot unavailable: {e}"),
                }
            }
        });
    }

    // In-flight work counter (pipeline jobs + chat turns). The update loop
    // drains this to zero before restarting so auto-update never kills running
    // work (ISS-392). Created before any spawn so every worker can register.
    let inflight = Arc::new(AtomicUsize::new(0));

    // Whether this daemon admits long work, shared by everything that admits
    // it, and the record `forge-runner status` reads of the build it serves.
    let drain = Arc::new(drain::Drain::new(crate::config::config_dir()));

    // Update check loop: warn when a newer release exists; auto-apply +
    // restart when `update.auto` is set. Checks ~30s after start, then every 6h.
    if let Some(url) =
        crate::update::manifest_url(cfg.update.manifest_url.as_deref(), Some(&core_url))
    {
        let auto = cfg.update.auto;
        let inflight = inflight.clone();
        let drain = drain.clone();
        let runner = runner.clone();
        let bound = cfg.clone();
        let assignments = client.clone();
        let cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            update_checks(UPDATE_CHECK_INTERVAL, cancel_rx, move |checked_at| {
                let (url, inflight, drain, runner, bound, assignments) = (
                    url.clone(),
                    inflight.clone(),
                    drain.clone(),
                    runner.clone(),
                    bound.clone(),
                    assignments.clone(),
                );
                async move {
                match crate::update::fetch_manifest(&url).await {
                    Ok(m)
                        if crate::update::is_newer(&m.version, crate::update::CURRENT_VERSION) =>
                    {
                        tracing::warn!(
                            "[update] available: {} → {}",
                            crate::update::CURRENT_VERSION,
                            m.version
                        );
                        if auto {
                            match crate::update::apply(&m).await {
                                Ok(Some(o)) => {
                                    // The new binary is already swapped on disk;
                                    // drain in-flight jobs/chat to idle before
                                    // restarting so we never kill running work.
                                    tracing::warn!(
                                        "[update] applied {} → {} — draining before restart",
                                        o.from,
                                        o.to
                                    );
                                    // From this instant `current_exe()` in this
                                    // process reads `<path> (deleted)`, and the
                                    // restart that would end that waits on an
                                    // idle window a working box never reaches.
                                    // So every bound checkout is repointed at
                                    // the build just installed, now, rather
                                    // than at the next pane preparation.
                                    // Which checkouts those are is asked for
                                    // again rather than carried from boot: an
                                    // assignment made since is one this daemon
                                    // has been preparing panes in, and its
                                    // settings file names the binary this
                                    // update just replaced.
                                    let assigned = runners::list_me(&assignments).await.ok();
                                    repair_installed_hooks(
                                        assigned.as_deref(),
                                        &bound,
                                        "after an update",
                                    );
                                    let cause = format!("update {} → {}", o.from, o.to);
                                    let outcome = drain::drain_to_idle(
                                        &drain,
                                        "update",
                                        &cause,
                                        &inflight,
                                        live_run_sessions,
                                        || close_parked_sessions(&runner),
                                        || drain::NextAttempt {
                                            by: "the next update check".into(),
                                            due_in: UPDATE_CHECK_INTERVAL
                                                .saturating_sub(checked_at.elapsed()),
                                        },
                                    )
                                    .await;
                                    if let drain::Drained::NotNow(why) = &outcome {
                                        tracing::warn!(
                                            "[update] {} stands on disk and this process keeps serving {} — {why}; the next update check tries again",
                                            o.to,
                                            o.from
                                        );
                                    }
                                    if outcome == drain::Drained::Idle {
                                        tracing::warn!(
                                            "[update] idle — restarting to apply update"
                                        );
                                        // Exit 0 → systemd Restart=always relaunches THIS
                                        // unit, which re-execs the freshly-swapped binary.
                                        // Name-agnostic, so it works for multi-instance
                                        // forge-runner-<id> units too — same mechanism as the
                                        // credential-watch path below. The old hardcoded
                                        // `systemctl --user restart forge-runner` only bounced
                                        // the default unit, so any instance under a different
                                        // unit name (forge-runner-aiNNN) downloaded the new
                                        // binary but never re-execed it, re-applying the same
                                        // update every cycle forever while staying on the old
                                        // in-memory build.
                                        std::process::exit(0);
                                    }
                                }
                                Ok(None) => {}
                                Err(e) => tracing::warn!("[update] apply failed: {e}"),
                            }
                        }
                    }
                    Ok(_) => tracing::debug!("[update] up to date"),
                    Err(e) => tracing::debug!("[update] check failed: {e}"),
                }
                }
            })
            .await;
        });
    }

    // Credential-watch loop (ISS-467): a fresh `forge-runner login` rotates the
    // device token in the cred store, but the HTTP `CoreClient` and the WS were
    // built with the token captured at startup and can't swap it in place. When
    // the stored token changes from what we booted with, drain in-flight work
    // and exit — systemd's `Restart=always` relaunches us and `start` rebuilds
    // every client (WS + HTTP) with the new token. This fires ONLY on an actual
    // change (never on a still-dead token with no re-login), so it can't become
    // the old 401 fast-restart hammer; the WS backoff covers the dead window.
    {
        let startup_token = device_token.clone();
        let inflight = inflight.clone();
        let drain = drain.clone();
        let runner = runner.clone();
        let mut cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
            // The interval's first tick completes at once; this loop waits a
            // full thirty seconds before its first look.
            tick.tick().await;

            // What this loop last said about a drain it could not start, so a
            // refusal it meets every thirty seconds is said once.
            let mut said: Option<String> = None;
            loop {
                tokio::select! {
                    _ = tick.tick() => {}
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
                }
                // Only act on a confirmed, changed token. None/Err (a transient
                // read during the atomic rename, or a cleared store) is left
                // alone so a blip never triggers a restart.
                if let Ok(Some(current)) = crate::auth::cred_store::load_device_token() {
                    if current != startup_token {
                        if said.is_none() {
                            tracing::warn!(
                                "[cred] device token changed (re-login detected) — draining in-flight work, then restarting to apply it"
                            );
                        }
                        match drain::drain_to_idle(
                            &drain,
                            "cred",
                            "a new device token",
                            &inflight,
                            live_run_sessions,
                            || close_parked_sessions(&runner),
                            || drain::NextAttempt {
                                by: "this loop's next drain".into(),
                                due_in: std::time::Duration::from_secs(drain::DRAIN_REOPEN_SECS),
                            },
                        )
                        .await
                        {
                            drain::Drained::Idle => {}
                            drain::Drained::GaveUp => {
                                said = Some("gave up".into());
                                continue;
                            }
                            drain::Drained::NotNow(why) => {
                                // Keyed on the kind, not the sentence: the
                                // time remaining in it changes every minute.
                                let kind = match &why {
                                    drain::NotNow::UnderWay { cause } => {
                                        format!("under way: {cause}")
                                    }
                                    drain::NotNow::Reopened { .. } => "reopened".to_string(),
                                };
                                if said.as_deref() != Some(kind.as_str()) {
                                    tracing::warn!("[cred] the new device token waits: {why}");
                                }
                                said = Some(kind);
                                continue;
                            }
                        }
                        tracing::warn!("[cred] restarting to pick up new credentials");
                        // Exit 0 → systemd Restart=always relaunches THIS unit
                        // (name-agnostic, so it works for multi-instance
                        // forge-runner-<id> units too).
                        std::process::exit(0);
                    }
                }
            }
        });
    }

    // Heartbeat loop.
    {
        let client = client.clone();
        let mut cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            let mut tick =
                tokio::time::interval(std::time::Duration::from_secs(heartbeat::INTERVAL_SECS));
            // The verdict this loop last shouted about, so a gate that is
            // failing open says so once rather than every thirty seconds. It is
            // held here and not on disk: a daemon that starts into a gate
            // already failing open states the condition it inherited, which is
            // what a new process owes an operator, and a second state file
            // beside the marks would buy one suppressed line at the cost of
            // another thing that can be unreadable exactly when it is owed.
            let mut shouted: Option<crate::proto_gate::Verdict> = None;
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let conditions = heartbeat_conditions(
                            crate::config::config_dir().as_deref(),
                            agent_activity::now_ms(),
                        );
                        if let Some(g) = conditions.gate.as_ref() {
                            let _ = announce_gate(g, &mut shouted);
                        }
                        match heartbeat::beat(&client, &conditions).await {
                            Err(e) => tracing::warn!("[heartbeat] {e}"),
                            Ok(refused) => warn_refused(&refused),
                        }
                    }
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
                }
            }
        });
    }

    // Ctrl-C → cancel.
    {
        let cancel_tx = cancel_tx.clone();
        tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down…");
            let _ = cancel_tx.send(true);
        });
    }

    tracing::info!(
        "runner online — device {device_id}, {} binding(s)",
        cfg.bindings.len()
    );

    let cfg = Arc::new(cfg);

    // Workspace-provisioning sweep. Runs once at startup then periodically so a
    // device that was offline when a project was assigned catches up on its own;
    // the `provision.request` WS event below makes a fresh bind prompt. Server
    // only returns `queued` rows, so this is a no-op once everything is ready.
    {
        let (client, cfg) = (client.clone(), cfg.clone());
        let mut cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(90));
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        crate::workspace::provision::run_pending(&client, &cfg).await;
                    }
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
                }
            }
        });
    }

    {
        let cfg = cfg.clone();
        let mut cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            use crate::workspace::worktree_reap::{SweepClock, SWEEP_PERIOD};
            let mut clock = SweepClock::default();
            let mut wait = std::time::Duration::ZERO;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {
                        let held_by = crate::runner::ledger::Ledger::default_path()
                            .and_then(|p| crate::runner::ledger::Ledger::open(&p))
                            .and_then(|l| crate::workspace::worktree_reap::HeldTrees::from_ledger(&l));
                        let held_by = match held_by {
                            Ok(h) => h,
                            Err(err) => {
                                let outage = clock.unreadable(std::time::Instant::now());
                                if outage.announce {
                                    tracing::error!(
                                        "[worktree-reap] the ledger will not open ({err}) — this sweep is the only thing that removes a finished run's checkout, so none is reclaimed while that holds; retrying in {}s",
                                        outage.retry_in.as_secs()
                                    );
                                }
                                wait = outage.retry_in;
                                continue;
                            }
                        };
                        wait = SWEEP_PERIOD;
                        if let Some(off_for) = clock.readable(std::time::Instant::now()) {
                            tracing::warn!(
                                "[worktree-reap] the ledger opens again — the sweep was off for {}s, and any checkout that fell due in that time is reclaimed by this one",
                                off_for.as_secs()
                            );
                        }
                        for (slug, b) in &cfg.bindings {
                            let swept = crate::workspace::worktree_reap::reap_repo(
                                &b.repo_path,
                                crate::workspace::worktree_reap::MIN_AGE,
                                &held_by,
                            )
                            .await;
                            if !swept.removed.is_empty() {
                                tracing::info!(
                                    "[worktree-reap] {slug}: removed {} stale worktree(s)",
                                    swept.removed.len()
                                );
                            }
                            for (path, run_id) in &swept.held {
                                tracing::info!(
                                    "[worktree-reap] {slug}: kept {} for run {run_id}",
                                    path.display()
                                );
                            }
                        }
                    }
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
                }
            }
        });
    }

    // What the box has left, on its own clock rather than the sweep's: a sweep
    // period is six hours, and the box that raised ISS-1260 crossed both
    // thresholds and the ceiling inside four.
    {
        let mut cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            use crate::daemon::headroom::{self, TICK};
            let roots = headroom::scratch_roots();
            let mut watch = headroom::Watch::default();
            let mut tick = tokio::time::interval(TICK);
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        // `statvfs` blocks, and a scratch root on an
                        // unresponsive network or FUSE mount blocks for as
                        // long as that mount does. On a worker thread that
                        // stalls the daemon's other tasks, so it goes to the
                        // blocking pool, where waiting on it yields and every
                        // other task keeps running (consult 404196 F1).
                        //
                        // Awaited plainly, so at most one reading is ever out:
                        // a select that let this task walk away would abandon
                        // the handle and start another on the next tick, which
                        // is one hung thread per tick instead of one
                        // (consult 825bfe F1). What that costs, and why a
                        // killable probe is not taken here, is priced in
                        // `headroom`'s own note on `read`.
                        let here = roots.clone();
                        let survey =
                            tokio::task::spawn_blocking(move || headroom::survey(&here))
                                .await
                                .unwrap_or_else(|e| headroom::Survey {
                                    at: std::path::PathBuf::from("<none>"),
                                    reading: headroom::Reading::Refused(format!(
                                        "the reading did not finish ({e})"
                                    )),
                                    beside: Vec::new(),
                                });
                        if let Some(report) =
                            watch.tick(std::time::Instant::now(), survey.reading.verdict())
                        {
                            headroom::say(&survey, &report);
                        }
                    }
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
                }
            }
        });
    }

    // Background skill auto-pull (ISS-736) — OFF by default (canary gate).
    // Independent poller; `skill.sync` above stays the immediate, explicit path.
    if cfg.skills.auto_pull {
        let (client, cfg) = (client.clone(), cfg.clone());
        let cancel_rx = cancel_rx.clone();
        tokio::spawn(async move { skill_pull::run(client, cfg, cancel_rx).await });
        tracing::info!("[skills] background auto-pull enabled");
    } else {
        tracing::debug!(
            "[skills] background auto-pull disabled (set skills.auto_pull=true to enable)"
        );
    }

    // Shared-skill plugin-marketplace sweep (ISS-739, 3rd delivery channel).
    // Jittered <=10min initial delay (avoids every device in a fleet hammering
    // the marketplace git remote at the same instant on a simultaneous restart),
    // then a periodic tick at `plugins.poll_interval_secs`. Cheap no-op when
    // `plugins.enabled == false` — `ensure_plugins` early-returns immediately.
    {
        let (client, cfg) = (client.clone(), cfg.clone());
        let mut cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            let jitter_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_millis() as u64
                % 1000;
            let initial_delay_ms = jitter_ms * 600; // spreads across ~0-600s (<=10min)
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(initial_delay_ms)) => {}
                _ = cancel_rx.changed() => { if *cancel_rx.borrow() { return; } }
            }
            sweep_plugins(&client, &cfg).await;

            let mut tick = tokio::time::interval(std::time::Duration::from_secs(
                cfg.plugins.poll_interval_secs.max(1),
            ));
            tick.tick().await; // skip the immediate tick — we just ran above
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        sweep_plugins(&client, &cfg).await;
                    }
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
                }
            }
        });
    }

    let masters = Arc::new(master::Masters::new());

    let activity = Arc::new(agent_activity::Activities::new());

    let job_panes = Arc::new(pool_jobs::JobPanes::new());
    let job_records: Arc<dyn pool_jobs::Records> = match pool_jobs::FileRecords::default_dir() {
        Some(dir) => Arc::new(pool_jobs::FileRecords { dir }),
        None => {
            tracing::error!(
                "[pool] no config directory to record started jobs in — a job whose pane dies with this daemon will wait out core's result timeout instead of being reported dead"
            );
            Arc::new(pool_jobs::NoRecords)
        }
    };
    let (adopted_tx, adopted_rx) = tokio::sync::watch::channel(false);
    {
        let client = (*client).clone();
        let job_panes = job_panes.clone();
        let job_records = job_records.clone();
        let activity = activity.clone();
        let mut cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            let report = pool_jobs::CoreReport { client: &client };
            pool_jobs::adopt(
                &pool_jobs::TmuxPanes,
                &report,
                job_records.as_ref(),
                &job_panes,
            )
            .await;
            let _ = adopted_tx.send(true);
            let mut tick = tokio::time::interval(POOL_SUPERVISE_INTERVAL);
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        pool_jobs::supervise(
                            &pool_jobs::TmuxPanes,
                            &report,
                            job_records.as_ref(),
                            &job_panes,
                            activity.as_ref(),
                        ).await;
                    }
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
                }
            }
        });
    }
    #[cfg(unix)]
    {
        let Some(tokens_path) = session_tokens::default_path() else {
            return Err(crate::error::Error::Other(
                "cannot resolve the control token map path".into(),
            ));
        };
        let ctl_ledger = Arc::new(std::sync::Mutex::new(
            match crate::runner::ledger::Ledger::default_path()
                .and_then(|p| crate::runner::ledger::Ledger::open(&p))
            {
                Ok(l) => Some(l),
                Err(e) => {
                    tracing::error!(
                        "[control] cannot open the run ledger: {e} — declarations will be refused"
                    );
                    None
                }
            },
        ));
        let ctl = Arc::new(control::Control {
            tokens: session_tokens::SessionTokens::at(tokens_path),
            activity: activity.clone(),
            masters: masters.clone(),
            ledger: ctl_ledger,
            boot_id: crate::runner::inflight::boot_identity().unwrap_or_default(),
            config_dir: crate::config::config_dir(),
            promises: std::sync::Mutex::new(control::GateMemory::default()),
            drain: drain.clone(),
            hosts: Arc::new(subagent_host::ProcHosts::system()),
        });
        let cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            if let Err(e) = control::serve(ctl, cancel_rx).await {
                tracing::error!("[control] {e}");
            }
        });
    }
    let (wake_tx, wake_rx) = master::wake_channel();
    {
        let (client, cfg) = ((*client).clone(), (*cfg).clone());
        let cancel_rx = cancel_rx.clone();
        let masters = masters.clone();
        let activity = activity.clone();
        let job_panes = job_panes.clone();
        let job_records = job_records.clone();
        let adopted_rx = adopted_rx.clone();
        let drain = drain.clone();
        tokio::spawn(async move {
            master::run(
                client,
                cfg,
                master::Shared {
                    masters,
                    activity,
                    job_panes,
                    job_records,
                    drain,
                },
                adopted_rx,
                cancel_rx,
                wake_rx,
            )
            .await
        });
    }

    let mut cancel_rx = cancel_rx.clone();
    loop {
        tokio::select! {
            frame = frame_rx.recv() => {
                let Some(frame) = frame else { break };
                match frame.event.as_str() {
                    "job.cancel" | "job.cancelRequested" => {
                        if let Some(jid) = job_id_of(&frame.data) {
                            tracing::info!("[cancel] job={jid}");
                            // ISS-785 — core's kill-before-reap gate waits on this ack
                            // (or a runner_gone/terminal-report fallback) before it
                            // allows a retry; report the real outcome instead of
                            // silently discarding it, but never block the frame loop
                            // on the ack POST.
                            let (client, runner) = (client.clone(), runner.clone());
                            tokio::spawn(async move {
                                let outcome = match runner.abort(&jid).await {
                                    Ok(_) => {
                                        inflight::forget(&jid);
                                        "killed"
                                    }
                                    Err(_) => inflight::reap_orphan(&jid).await.wire(),
                                };
                                if let Err(e) = lifecycle::kill_ack(&client, &jid, outcome).await {
                                    tracing::warn!("[cancel] kill-ack job={jid}: {e}");
                                }
                            });
                        }
                    }
                    "agent:start" => {
                        let (client, runner) = (client.clone(), runner.clone());
                        let guard = InflightGuard::enter(&inflight);
                        tokio::spawn(async move {
                            let _guard = guard; // released when the chat turn finishes (drain gate)
                            if let Err(e) = chat::handle_start(&client, runner, frame.data).await {
                                tracing::error!("[chat] start: {e}");
                            }
                        });
                    }
                    "agent:send" => {
                        let (client, runner) = (client.clone(), runner.clone());
                        let guard = InflightGuard::enter(&inflight);
                        tokio::spawn(async move {
                            let _guard = guard; // released when the chat turn finishes (drain gate)
                            if let Err(e) = chat::handle_send(&client, runner, frame.data).await {
                                tracing::error!("[chat] send: {e}");
                            }
                        });
                    }
                    "session.send" => {
                        let (client, runner, masters) =
                            (client.clone(), runner.clone(), masters.clone());
                        let guard = InflightGuard::enter(&inflight);
                        tokio::spawn(async move {
                            let _guard = guard;
                            inbox::handle_session_send(&client, runner, masters, frame.data).await;
                        });
                    }
                    "agent:abort" => {
                        if let Some(sid) = session_id_of(&frame.data) {
                            tracing::info!("[chat] abort session={sid}");
                            let runner = runner.clone();
                            tokio::spawn(async move { chat::handle_abort(runner, &sid).await });
                        }
                    }
                    "skill.sync" => {
                        let (client, cfg) = (client.clone(), cfg.clone());
                        tokio::spawn(async move {
                            if let Err(e) = dispatch::handle_skill_sync(&client, &cfg, frame.data).await {
                                tracing::warn!("[skill.sync] {e}");
                            }
                        });
                    }
                    "provision.request" => {
                        // Wake → run the pending-provision sweep (server returns
                        // only `queued` rows, so this provisions the requested one).
                        let (client, cfg) = (client.clone(), cfg.clone());
                        tokio::spawn(async move {
                            if let Err(e) = crate::workspace::provision::handle_request(&client, &cfg).await {
                                tracing::warn!("[provision] {e}");
                            }
                        });
                    }
                    "master.wake" => match master::Wake::of_frame(&frame.data) {
                        Ok(wake) => {
                            if wake_tx.try_send(wake).is_err() {
                                tracing::debug!("[ws] master.wake coalesced — a sweep is already pending");
                            }
                        }
                        // A source this box cannot read is said, never folded into a sweep it
                        // did not ask for; the next poll reads the same state either way.
                        Err(why) => tracing::warn!(
                            "[ws] master.wake refused: {why} — no sweep is started for it (frame: {})",
                            frame.data
                        ),
                    },
                    "ws.connected" => {
                        if wake_tx.try_send(master::Wake::Reconnect).is_err() {
                            tracing::debug!("[ws] catch-up read coalesced — a sweep is already pending");
                        }
                    }
                    other => tracing::debug!("[ws] ignored event {other}"),
                }
            }
            _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
        }
    }

    Ok(())
}

/// One plugin sweep: ask the server which plugins this device's bound projects designate, then
/// reconcile. A server error degrades to local-only config rather than skipping the sweep — the
/// device must keep converging on its own `[plugins]` block when core is unreachable.
async fn sweep_plugins(client: &CoreClient, cfg: &Config) {
    if !cfg.plugins.enabled {
        return;
    }

    let designated = match crate::transport::plugins::list_designated(client).await {
        Ok(list) => list,
        Err(e) => {
            tracing::warn!(
                "[plugins] server designation fetch failed, using local config only: {e}"
            );
            Vec::new()
        }
    };

    let server: Vec<crate::workspace::plugin_sync::PluginTarget> = designated
        .iter()
        .map(|d| {
            if let Some(conflict) = &d.pinned_ref_conflict {
                tracing::warn!(
                    "[plugins] {}/{} — bound projects pinned different refs {:?}; server sent no pin",
                    d.marketplace,
                    d.name,
                    conflict
                );
            }
            tracing::info!(
                "[plugins] designated {}/{} by project(s) {:?}",
                d.marketplace,
                d.name,
                d.projects
            );
            crate::workspace::plugin_sync::PluginTarget {
                marketplace: d.marketplace.clone(),
                name: d.name.clone(),
                pinned_ref: d.pinned_ref.clone(),
                auto_update: true,
            }
        })
        .collect();

    crate::workspace::plugin_sync::ensure_plugins(&cfg.plugins, &server).await;
}

/// Both heartbeat conditions off the files beside `config.toml`; nothing where
/// there is no such directory to read.
fn heartbeat_conditions(config_dir: Option<&std::path::Path>, now_ms: i64) -> heartbeat::Conditions {
    let Some(dir) = config_dir else {
        return heartbeat::Conditions::default();
    };
    heartbeat::Conditions {
        gate: Some(degraded::report(dir, now_ms).degraded),
        pool: pool_reads::report(dir, now_ms).ok(),
    }
}
