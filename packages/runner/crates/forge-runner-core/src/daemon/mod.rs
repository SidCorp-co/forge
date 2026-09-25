//! Daemon orchestration.
//!
//! Loop: connect WS → subscribe `device:<id>` (+ `runner:register` when
//! enabled) → heartbeat every 30s → ask which issues are admissible, keep a
//! resident master up for each project that has some, and nudge it. The runs
//! are the master's own subagents and never reach this process. Interactive
//! chat (`agent:start` / `agent:send` / `agent:abort`) is handled out-of-band
//! by `chat`, under its own concurrency budget (ISS-321).
//!
//! The four job kinds with no issue to rank — `release_batch`, `smoke`,
//! `reconcile`, `verify_skill` — do NOT go to a master. They sit in the JOBS
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
pub mod held_report;
pub mod hook_install;
pub mod inbox;
pub mod job_exit;
pub mod job_unheard;
pub mod master;
pub mod master_exit;
pub mod master_limit;
pub mod pool_jobs;
pub mod pool_reads;
pub mod recovery;
pub mod recovery_ports;
pub mod run_exit;
pub mod run_record;
pub mod serving;
pub mod session_tokens;
pub mod setup_agent;
pub mod skill_pull;
pub mod subagent_end;
pub mod terminal;
pub mod transcript_age;
pub mod turn_evidence;

/// Make this test binary's `tracing` events survive long enough to be captured.
///
/// `tracing` keeps ONE process-wide max-level, recomputed from the CURRENT
/// thread's dispatcher whenever a callsite is registered or the interest cache
/// is rebuilt. A thread with no subscriber hints `OFF`, so any test that first
/// reaches a new `info!`/`warn!` callsite drops that ceiling to `OFF` for every
/// thread at once — including one sitting inside `with_default`, whose buffer
/// then comes back empty. Single-threaded runs never see it; this crate's suite
/// failed 20 times in 200 runs of `cargo test give_back_tests` before this.
///
/// Installing a permissive global subscriber once makes `OFF` unreachable: it
/// answers `true` to everything and hints no ceiling, so the recomputation
/// lands on `TRACE` whichever thread does it. It records nothing — a scoped
/// subscriber still takes every event on the thread that installs one, and on
/// every other thread the event is discarded here rather than printed.
#[cfg(test)]
pub(crate) fn keep_tracing_capturable() {
    struct Permissive;
    impl tracing::Subscriber for Permissive {
        fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
            None
        }
        fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::Id {
            tracing::Id::from_u64(1)
        }
        fn record(&self, _: &tracing::Id, _: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _: &tracing::Id, _: &tracing::Id) {}
        fn event(&self, _: &tracing::Event<'_>) {}
        fn enter(&self, _: &tracing::Id) {}
        fn exit(&self, _: &tracing::Id) {}
    }
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = tracing::subscriber::set_global_default(Permissive);
    });
}

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
use crate::transport::ws::{self, RunnerRegistration, WsConfig};
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
fn announce_gate(gate: &degraded::Condition, shouted: &mut Option<degraded::Verdict>) -> bool {
    let speak = gate.verdict == degraded::Verdict::FailingOpen && *shouted != Some(gate.verdict);
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
/// an hour or more ago and nothing was written after it. A restart touches
/// neither the subagent, which lives in its master's process, nor its tree, so
/// a quiet run does not hold one. One still working, or one whose transcript
/// this box cannot read, still does (ISS-1246).
fn reads_quiet(run: &crate::runner::ledger::Run, now: i64) -> bool {
    if run.agent_id.is_none() || run.pid.is_some() {
        return false;
    }
    let written = run
        .agent_transcript
        .as_deref()
        .and_then(|p| transcript_age::written_at(std::path::Path::new(p)));
    matches!(
        subagent_end::read(run.turn_ended_at_ms, written, now),
        subagent_end::Evidence::Quiet { .. }
    )
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
        Ok(runs) => live_runs(&runs, this_boot, alive, |r| {
            reads_quiet(r, agent_activity::now_ms())
        })
        .into_iter()
        .map(|r| {
            let keys = issue_keys(&r.run_id);
            if keys.is_empty() {
                format!("run {} (no issue recorded)", r.run_id)
            } else {
                format!("run {} ({})", r.run_id, keys.join(", "))
            }
        })
        .collect(),
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
    serving::pid_alive(pid)
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

/// Every checkout this box is bound to, and every assignment that names none.
struct BoundCheckouts {
    /// Slug and working directory, one per distinct path, sorted.
    checkouts: Vec<(String, std::path::PathBuf)>,
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
    let mut pathless: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();
    for r in server {
        match resolve_repo(server, cfg, &r.project_id) {
            Ok(resolved) => {
                if seen.insert(resolved.repo_path.clone()) {
                    checkouts.push((resolved.slug, resolved.repo_path));
                }
            }
            Err(slug) => pathless.push(slug),
        }
    }
    for (slug, binding) in &cfg.bindings {
        if seen.insert(binding.repo_path.clone()) {
            checkouts.push((slug.clone(), binding.repo_path.clone()));
        }
    }
    checkouts.sort();
    pathless.sort();
    pathless.dedup();
    BoundCheckouts {
        checkouts,
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

    // One runner registration per assigned project. Union the server
    // assignments (authoritative project_id + slug) with any local config
    // binding that already has a project_id, deduped by project_id.
    let device_name = crate::auth::pairing::default_device_name();
    let mut seen_project_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut registrations: Vec<RunnerRegistration> = Vec::new();

    for r in assigned {
        if seen_project_ids.insert(r.project_id.clone()) {
            registrations.push(RunnerRegistration {
                project_id: r.project_id.clone(),
                name: format!("{device_name} ({})", r.slug),
                runner_type: "claude-code".into(),
            });
        }
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
    for (slug, b) in &cfg.bindings {
        if let Some(pid) = b.project_id.clone() {
            if seen_project_ids.insert(pid.clone()) {
                registrations.push(RunnerRegistration {
                    project_id: pid,
                    name: format!("{device_name} ({slug})"),
                    runner_type: "claude-code".into(),
                });
            }
        }
    }

    if registrations.is_empty() {
        tracing::warn!(
            "no project assignments — jobs cannot be routed. Bind a device in the web UI, then run `forge-runner bind <slug> --path <dir>`."
        );
    }

    // Before any pane is prepared: whatever the daemon this one replaced wrote
    // into these checkouts is still there, and this process CAN name itself.
    repair_installed_hooks(server.as_deref(), &cfg, "boot");

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
            registrations,
            register_enabled: cfg.runner.register_enabled,
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
    let drain = Arc::new(drain::Drain::new(control::config_dir()));

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
            let mut shouted: Option<degraded::Verdict> = None;
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let conditions = heartbeat::Conditions::read(
                            control::config_dir().as_deref(),
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
            config_dir: control::config_dir(),
            promises: std::sync::Mutex::new(control::GateMemory::default()),
            drain: drain.clone(),
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
                masters,
                activity,
                job_panes,
                job_records,
                adopted_rx,
                cancel_rx,
                wake_rx,
                drain,
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
                        let (client, runner, cfg) =
                            (client.clone(), runner.clone(), cfg.clone());
                        let guard = InflightGuard::enter(&inflight);
                        tokio::spawn(async move {
                            let _guard = guard; // released when the chat turn finishes (drain gate)
                            if let Err(e) = chat::handle_start(&client, runner, &cfg, frame.data).await {
                                tracing::error!("[chat] start: {e}");
                            }
                        });
                    }
                    "agent:send" => {
                        let (client, runner, cfg) =
                            (client.clone(), runner.clone(), cfg.clone());
                        let guard = InflightGuard::enter(&inflight);
                        tokio::spawn(async move {
                            let _guard = guard; // released when the chat turn finishes (drain gate)
                            if let Err(e) = chat::handle_send(&client, runner, &cfg, frame.data).await {
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
                    "master.wake" => {
                        let project_id = frame
                            .data
                            .get("projectId")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        if wake_tx.try_send(master::Wake::Core { project_id }).is_err() {
                            tracing::debug!("[ws] master.wake coalesced — a sweep is already pending");
                        }
                    }
                    "ws.connected" => {
                        if wake_tx.try_send(master::Wake::Reconnect).is_err() {
                            tracing::debug!("[ws] catch-up read coalesced — a sweep is already pending");
                        }
                    }
                    "runner.registered" => tracing::info!("[ws] runner registered"),
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
                auto_update: d.auto_update,
            }
        })
        .collect();

    crate::workspace::plugin_sync::ensure_plugins(&cfg.plugins, &server).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ISS-1234 criterion 25. The tick sends what `Conditions::read` builds,
    /// which is where the box's pool reads join the beat; a tick that built its
    /// own body would leave them on disk and reaching nobody.
    #[test]
    fn the_heartbeat_tick_sends_the_conditions_read_off_the_box() {
        let src = include_str!("mod.rs");
        let tick = src
            .split("// Heartbeat loop.")
            .nth(1)
            .and_then(|r| r.split("// Ctrl-C").next())
            .unwrap_or_default();
        let read = tick
            .find("heartbeat::Conditions::read(")
            .expect("the tick reads both conditions in one place");
        let beat = tick
            .find("heartbeat::beat(&client, &conditions)")
            .expect("the tick sends what it read");
        assert!(read < beat);
    }

    fn gate_at(verdict: degraded::Verdict) -> degraded::Condition {
        degraded::Condition {
            verdict,
            count: 278,
            per_day: Some(75.0),
            since_last_ms: Some(240_000),
            ..degraded::Condition::none()
        }
    }

    /// Criterion 23. A gate failing open is said once, and the ticks behind it
    /// are silent: a warning every thirty seconds is a warning nobody reads.
    #[test]
    fn a_gate_failing_open_is_announced_once_and_not_every_tick() {
        let mut shouted = None;
        let failing = gate_at(degraded::Verdict::FailingOpen);
        assert!(announce_gate(&failing, &mut shouted));
        assert!(!announce_gate(&failing, &mut shouted));
        assert!(!announce_gate(&failing, &mut shouted));
    }

    /// A gate that recovers and fails open again is a second incident, and is
    /// said again — the rule is one line per transition, not one per lifetime.
    #[test]
    fn a_gate_that_recovers_and_fails_again_is_announced_again() {
        let mut shouted = None;
        assert!(announce_gate(
            &gate_at(degraded::Verdict::FailingOpen),
            &mut shouted
        ));
        assert!(!announce_gate(
            &gate_at(degraded::Verdict::Marked),
            &mut shouted
        ));
        assert!(announce_gate(
            &gate_at(degraded::Verdict::FailingOpen),
            &mut shouted
        ));
    }

    /// A daemon starting into a gate already failing open has no prior verdict,
    /// and states the condition it inherited rather than inheriting a silence.
    #[test]
    fn a_fresh_process_states_the_condition_it_inherited() {
        let mut shouted = None;
        assert!(announce_gate(
            &gate_at(degraded::Verdict::FailingOpen),
            &mut shouted
        ));
    }

    #[test]
    fn a_gate_that_is_merely_marked_is_not_announced_as_a_fault() {
        let mut shouted = None;
        assert!(!announce_gate(
            &gate_at(degraded::Verdict::Marked),
            &mut shouted
        ));
        assert!(!announce_gate(
            &gate_at(degraded::Verdict::Clear),
            &mut shouted
        ));
    }

    /// A supervision tick has to fit inside core's result hop, with room to spare.
    ///
    /// `jobs/loop-monitor.ts:reapResultMisses` fails a `dispatched` job whose
    /// newest evidence is older than `RESULT_QUIET_MINUTES` (60), computed as
    /// the greatest of its last job event, its last phase row and `dispatched_at`
    /// — and a release runs longer than that. This tick is the only thing that
    /// refreshes the first of those for a pool job, so an interval anywhere near
    /// the hour would let a healthy release be reaped between two beats.
    #[test]
    fn a_healthy_job_outlives_cores_quiet_threshold_between_two_beats() {
        const CORE_RESULT_QUIET: std::time::Duration = std::time::Duration::from_secs(60 * 60);
        assert!(
            POOL_SUPERVISE_INTERVAL.as_secs() > 0,
            "a zero interval is a busy loop against core, not supervision"
        );
        assert!(
            POOL_SUPERVISE_INTERVAL * 4 < CORE_RESULT_QUIET,
            "leave room for missed beats: three ticks may fail against an unreachable core and the job must still outlive the hop"
        );
    }

    use crate::runner::ledger::{Ledger, NewRun};

    fn count_live_runs(
        runs: &[crate::runner::ledger::Run],
        this_boot: &str,
        alive: impl Fn(u32) -> bool,
        quiet: impl Fn(&crate::runner::ledger::Run) -> bool,
    ) -> usize {
        live_runs(runs, this_boot, alive, quiet).len()
    }

    /// Each live run is named by its id and the issues it was given, so the
    /// drain's line says which work it waits on and not only how much.
    #[test]
    fn a_live_run_is_named_by_its_id_and_its_issues() {
        let mut led = Ledger::open_in_memory().unwrap();
        seeded_run(&mut led, "run-1", "boot-a", Some(4242));
        let held = live_sessions_from(
            led.unclosed_runs(),
            "boot-a",
            |_| true,
            |id| {
                led.issues(id)
                    .unwrap()
                    .into_iter()
                    .map(|i| i.issue_key)
                    .collect()
            },
        );
        assert_eq!(held, ["run run-1 (ISS-run-1)"]);
    }

    fn seeded_run(led: &mut Ledger, run_id: &str, boot: &str, pid: Option<u32>) {
        led.create_run_group(NewRun {
            run_id: run_id.into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: std::path::PathBuf::from(format!("/tmp/forge-drain-absent-{run_id}")),
            boot_id: boot.into(),
            issue_keys: vec![format!("ISS-{run_id}")],
        })
        .unwrap();
        // A declared run is bound to its subagent the moment `SubagentStart` arrives, and a master
        // may hold only ONE unbound row at a time (ISS-1050), so a helper that seeds several runs
        // under one master has to bind each before seeding the next. Binding changes nothing any
        // assertion in this module reads — `unclosed_runs` predicates on the three marks and the
        // terminal-refusal stamp, never on `agent_id` — it only makes the setup a shape the
        // ledger will still accept.
        led.bind_agent(run_id, &format!("child-{run_id}")).unwrap();
        if let Some(p) = pid {
            led.attach_pid(run_id, p).unwrap();
        }
    }

    /// The reply the drain cannot check is the one that used to read as safest:
    /// a ledger that would not open answered nought, the drain read the box as
    /// idle, and the restart went over every run in flight. The path that
    /// reaches it is the first start after an upgrade, which is where the
    /// ledger was unreadable to begin with (ISS-1201).
    #[test]
    fn a_ledger_that_will_not_answer_holds_the_restart_rather_than_clearing_it() {
        let held = live_sessions_from(
            Err(crate::error::Error::Other("ledger: no such column".into())),
            "boot-a",
            |_| true,
            |_| Vec::new(),
        );
        assert_eq!(
            held.len(),
            1,
            "a ledger nothing can read says nothing about what is running, and the drain's whole \
             job is to decide whether a restart would kill work — nought is the answer that restarts"
        );
        assert!(
            held[0].contains("run ledger") && held[0].contains("no such column"),
            "the holder is named as what it is, so the drain's line says why it waits: {held:?}"
        );
    }

    #[test]
    fn a_ledger_that_answers_with_nothing_running_does_clear_the_restart() {
        let led = Ledger::open_in_memory().unwrap();
        assert_eq!(
            live_sessions_from(led.unclosed_runs(), "boot-a", |_| true, |_| Vec::new()).len(),
            0,
            "an empty ledger is an idle box, and holding the restart for it would pin the box on a \
             stale binary for ever"
        );
    }

    #[test]
    fn a_box_full_of_run_sessions_is_not_idle() {
        let mut led = Ledger::open_in_memory().unwrap();
        seeded_run(&mut led, "run-1", "boot-a", Some(4242));
        seeded_run(&mut led, "run-2", "boot-a", Some(4243));
        let runs = led.unclosed_runs().unwrap();
        assert_eq!(
            count_live_runs(&runs, "boot-a", |_| true, |r| reads_quiet(r, 0)),
            2,
            "a run session holds no `InflightGuard`, so the ledger is the only thing that can report the box is busy — reading zero here is what restarts through live work"
        );
    }

    #[test]
    fn a_park_does_not_hold_the_restart() {
        let mut led = Ledger::open_in_memory().unwrap();
        seeded_run(&mut led, "run-1", "boot-a", Some(4242));
        led.begin_question("q-1", "run-1", 1, "q-1").unwrap();
        led.declare_parked_human("run-1", Some("resume-1"), None)
            .unwrap();
        let runs = led.unclosed_runs().unwrap();
        assert_eq!(
            count_live_runs(&runs, "boot-a", |_| true, |r| reads_quiet(r, 0)),
            0,
            "a park releases its process and waits on a person; holding the restart for it pins the box on a stale binary indefinitely"
        );
    }

    #[test]
    fn a_row_from_a_previous_boot_holds_nothing() {
        let mut led = Ledger::open_in_memory().unwrap();
        seeded_run(&mut led, "run-1", "boot-old", Some(4242));
        let runs = led.unclosed_runs().unwrap();
        assert_eq!(
            count_live_runs(&runs, "boot-new", |_| true, |r| reads_quiet(r, 0)),
            0
        );
    }

    #[test]
    fn a_dead_pid_is_not_work() {
        let mut led = Ledger::open_in_memory().unwrap();
        seeded_run(&mut led, "run-1", "boot-a", Some(4242));
        seeded_run(&mut led, "run-2", "boot-a", Some(4243));
        let runs = led.unclosed_runs().unwrap();
        assert_eq!(
            count_live_runs(&runs, "boot-a", |pid| pid == 4243, |r| reads_quiet(r, 0)),
            1,
            "only the pid the process table still answers for is work in flight"
        );
    }

    #[test]
    fn a_subagent_run_with_no_pid_is_work_in_flight() {
        let mut led = Ledger::open_in_memory().unwrap();
        seeded_run(&mut led, "run-1", "boot-a", None);
        let runs = led.unclosed_runs().unwrap();
        assert_eq!(
            count_live_runs(&runs, "boot-a", |_| true, |r| reads_quiet(r, 0)),
            1,
            "a subagent has no pid of its own, so a counter that requires one reads an occupied box as idle and restarts through it"
        );
    }

    /// A subagent run bound to its child, with that child's transcript last
    /// written at `written_ms` (`None`: no file at all) and its turn ended at
    /// `stop_ms`.
    fn a_stopped_subagent(
        stop_ms: i64,
        written_ms: Option<i64>,
    ) -> (Ledger, crate::test_scratch::InScratch) {
        let mut led = Ledger::open_in_memory().unwrap();
        seeded_run(&mut led, "run-1", "boot-a", None);
        let dir = crate::test_scratch::Scratch::new("drain-transcript").at("transcripts");
        let transcript = dir.join("agent-child-run-1.jsonl");
        if let Some(at) = written_ms {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(&transcript, "{}\n").unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(&transcript)
                .unwrap()
                .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(at as u64))
                .unwrap();
        }
        let path = transcript.to_string_lossy().into_owned();
        assert!(led.note_turn_end("run-1", stop_ms, Some(&path)).unwrap());
        (led, dir)
    }

    const HOUR_MS: i64 = 60 * 60_000;
    const NOW_MS: i64 = 1_800_000_000_000;

    #[test]
    fn a_subagent_that_ended_a_turn_still_holds_the_restart() {
        let (led, dir) = a_stopped_subagent(NOW_MS - 60_000, Some(NOW_MS - 60_000));
        let runs = led.unclosed_runs().unwrap();
        assert_eq!(
            count_live_runs(&runs, "boot-a", |_| true, |r| reads_quiet(r, NOW_MS)),
            1,
            "a turn-end is not a finish — a subagent ends one to wait on its own background work (ISS-1246)"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_quiet_subagent_does_not_hold_the_restart() {
        let (led, dir) = a_stopped_subagent(NOW_MS - HOUR_MS, Some(NOW_MS - HOUR_MS));
        let runs = led.unclosed_runs().unwrap();
        assert_eq!(
            count_live_runs(&runs, "boot-a", |_| true, |r| reads_quiet(r, NOW_MS)),
            0,
            "an hour silent since its last turn-end: a restart touches neither it nor its tree, and a run nobody closes must not defer every restart for ever"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_subagent_that_wrote_after_its_stop_holds_the_restart_however_long_ago() {
        let (led, dir) = a_stopped_subagent(NOW_MS - 2 * HOUR_MS, Some(NOW_MS - HOUR_MS - 60_000));
        let runs = led.unclosed_runs().unwrap();
        assert_eq!(
            count_live_runs(&runs, "boot-a", |_| true, |r| reads_quiet(r, NOW_MS)),
            1,
            "a write after the stop is a resumed turn whose own end has not been heard"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_subagent_whose_transcript_cannot_be_read_holds_the_restart() {
        let (led, dir) = a_stopped_subagent(NOW_MS - 10 * HOUR_MS, None);
        let runs = led.unclosed_runs().unwrap();
        assert_eq!(
            count_live_runs(&runs, "boot-a", |_| true, |r| reads_quiet(r, NOW_MS)),
            1,
            "no transcript to read is no evidence, and never silence"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_subagent_its_master_closed_does_not_hold_the_restart() {
        let mut led = Ledger::open_in_memory().unwrap();
        seeded_run(&mut led, "run-1", "boot-a", None);
        led.end_run("run-1", "master", "its report is in").unwrap();
        let runs = led.unclosed_runs().unwrap();
        assert_eq!(
            count_live_runs(&runs, "boot-a", |_| true, |r| reads_quiet(r, NOW_MS)),
            0,
            "its master's close writes `exited`, and that is what says this run is over"
        );
    }

    #[test]
    fn a_run_with_a_pid_is_never_read_as_a_quiet_subagent() {
        let (led, dir) = a_stopped_subagent(NOW_MS - 10 * HOUR_MS, Some(NOW_MS - 10 * HOUR_MS));
        led.attach_pid("run-1", 4242).unwrap();
        let runs = led.unclosed_runs().unwrap();
        assert_eq!(
            count_live_runs(&runs, "boot-a", |_| true, |r| reads_quiet(r, NOW_MS)),
            1,
            "a run pane has a process the drain can ask; the subagent reading is not its rule"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Review finding 3: one check per interval, the first at once, however
    /// long a check (a drain that gives up after two hours) takes.
    #[tokio::test(start_paused = true)]
    async fn the_update_loop_checks_once_per_interval_even_after_a_long_drain() {
        const EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 3600);
        const DRAIN: std::time::Duration = std::time::Duration::from_secs(2 * 3600);
        let started = tokio::time::Instant::now();
        let at = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = at.clone();
        let (_cancel_tx, cancel) = watch::channel(false);
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(13 * 3600),
            update_checks(EVERY, cancel, move |checked_at| {
                seen.lock().unwrap().push(checked_at - started);
                tokio::time::sleep(DRAIN)
            }),
        )
        .await;
        let hours: Vec<u64> = at
            .lock()
            .unwrap()
            .iter()
            .map(|d| d.as_secs() / 3600)
            .collect();
        assert_eq!(
            hours,
            [0, 6, 12],
            "a check at start and one every six hours; a second check straight after the first drain is the double check"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_update_loop_stops_when_cancelled() {
        let (cancel_tx, cancel) = watch::channel(false);
        let calls = Arc::new(AtomicUsize::new(0));
        let n = calls.clone();
        let run = tokio::spawn(update_checks(
            std::time::Duration::from_secs(60),
            cancel,
            move |_| {
                n.fetch_add(1, Ordering::AcqRel);
                std::future::ready(())
            },
        ));
        tokio::time::sleep(std::time::Duration::from_secs(90)).await;
        cancel_tx.send(true).unwrap();
        run.await.unwrap();
        assert_eq!(calls.load(Ordering::Acquire), 2);
    }

    #[test]
    fn the_registry_is_republished_well_inside_the_freshness_this_surface_promises() {
        assert!(
            SESSION_LEDGER_INTERVAL <= std::time::Duration::from_secs(30),
            "a box must speak at least every 30s; this one waits {:?}",
            SESSION_LEDGER_INTERVAL
        );
    }
}

/// The sweep that repoints hook commands a pre-fix daemon left dead, and the
/// two moments it has to run at (ISS-1200).
#[cfg(test)]
mod hook_repair_tests {
    use super::*;

    const SOURCE: &str = include_str!("mod.rs");

    /// Everything above this module, which is where the calls live. Splitting
    /// at the first `#[cfg(test)]` would stop at `keep_tracing_capturable`,
    /// hundreds of lines before `run`; splitting at nothing would match this
    /// module's own literals and pass whatever the daemon does.
    fn production() -> &'static str {
        SOURCE.split("\nmod hook_repair_tests {").next().unwrap()
    }

    fn scratch(label: &str) -> crate::test_scratch::Scratch {
        crate::test_scratch::Scratch::new(&format!("hook-repair-{label}"))
    }

    /// A file `is_runnable` accepts, on every platform this crate builds for:
    /// the sweep this proves reads and rewrites files, and has no shell in it.
    fn runnable(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "#!/bin/sh\nexit 0\n").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        p
    }

    /// A checkout whose settings file names a program nothing can run.
    fn poisoned_checkout(root: &std::path::Path, slug: &str) -> std::path::PathBuf {
        let repo = root.join(slug);
        let settings = crate::daemon::hook_install::settings_path(&repo);
        std::fs::create_dir_all(settings.parent().expect("parent")).expect("dot claude");
        let gone = root.join(format!("forge-runner{}", crate::exe::DELETED_SUFFIX));
        std::fs::write(
            &settings,
            crate::daemon::hook_install::merged(None, gone.to_str().expect("utf-8"))
                .expect("poisoned settings"),
        )
        .expect("write");
        repo
    }

    /// The same, plus a managed hook command for an event this build does not
    /// install. The daemon's own marker is what makes an entry ours, and the
    /// scan that decides what is unrunnable reads every event in the file, so
    /// this entry is counted — and until ISS-1200's second round the rewrite
    /// did not cover it, which is how a project was reported repaired at every
    /// boot and stayed dead.
    fn poisoned_checkout_with_an_event_this_build_does_not_install(
        root: &std::path::Path,
        slug: &str,
        event: &str,
    ) -> std::path::PathBuf {
        let repo = poisoned_checkout(root, slug);
        let settings = crate::daemon::hook_install::settings_path(&repo);
        let gone = root.join(format!("forge-runner{}", crate::exe::DELETED_SUFFIX));
        let mut doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).expect("read")).expect("json");
        doc["hooks"][event] = serde_json::json!([{
            "hooks": [{
                "type": "command",
                "command": format!("'{}' hook --event {event}", gone.display()),
            }]
        }]);
        std::fs::write(
            &settings,
            serde_json::to_string_pretty(&doc).expect("serialize"),
        )
        .expect("write");
        repo
    }

    /// Criterion 8, at the shape the judging run failed it on: the sweep's two
    /// halves derived their answers separately, so a project could be named in
    /// the journal as repaired at every boot and still hold, afterwards, the
    /// very commands that line said had been rewritten.
    #[test]
    fn a_managed_hook_for_an_event_this_build_does_not_install_is_repaired_too() {
        let root = scratch("event-outside-all");
        let _installed = runnable(&root, "forge-runner");
        let mut cfg = Config::default();
        cfg.bindings.insert(
            "gamma".into(),
            crate::config::Binding {
                repo_path: poisoned_checkout_with_an_event_this_build_does_not_install(
                    &root,
                    "gamma",
                    "SessionStart",
                ),
                branch: None,
                project_id: None,
            },
        );

        repair_installed_hooks(Some(&[]), &cfg, "a test");

        let text = std::fs::read_to_string(crate::daemon::hook_install::settings_path(
            &root.join("gamma"),
        ))
        .expect("read back");
        assert!(
            !text.contains(crate::exe::DELETED_SUFFIX),
            "the sweep reported gamma repaired and left commands nothing can run: {text}"
        );
    }

    /// And it settles: a second sweep over a file the first one repaired finds
    /// nothing owed, rather than reporting the same repair forever.
    #[test]
    fn the_sweep_over_an_event_this_build_does_not_install_settles_after_one_pass() {
        let root = scratch("event-outside-all-settles");
        let installed = runnable(&root, "forge-runner");
        let repo = poisoned_checkout_with_an_event_this_build_does_not_install(
            &root,
            "gamma",
            "Notification",
        );

        let first = crate::daemon::hook_install::repair(&repo, &installed).expect("first pass");
        assert!(!first.is_empty(), "nothing was owed on a poisoned checkout");
        let second = crate::daemon::hook_install::repair(&repo, &installed).expect("second pass");
        assert!(
            second.is_empty(),
            "the sweep reported the same repair a second time: {second:?}"
        );
    }

    #[test]
    fn every_bound_project_is_swept_and_not_only_the_one_being_dispatched_to() {
        let root = scratch("all-bindings");
        let _installed = runnable(&root, "forge-runner");
        let mut cfg = Config::default();
        for slug in ["alpha", "beta", "gamma"] {
            cfg.bindings.insert(
                slug.to_string(),
                crate::config::Binding {
                    repo_path: poisoned_checkout(&root, slug),
                    branch: None,
                    project_id: None,
                },
            );
        }

        repair_installed_hooks(Some(&[]), &cfg, "a test");

        for slug in ["alpha", "beta", "gamma"] {
            let text = std::fs::read_to_string(crate::daemon::hook_install::settings_path(
                &root.join(slug),
            ))
            .expect("read back");
            assert!(
                !text.contains(crate::exe::DELETED_SUFFIX),
                "{slug} was left with commands nothing can run: {text}"
            );
        }
    }

    #[test]
    fn a_binding_whose_checkout_is_not_there_does_not_stop_the_rest_of_the_sweep() {
        let root = scratch("missing-checkout");
        let _installed = runnable(&root, "forge-runner");
        let mut cfg = Config::default();
        cfg.bindings.insert(
            "absent".into(),
            crate::config::Binding {
                repo_path: root.join("no-such-checkout"),
                branch: None,
                project_id: None,
            },
        );
        cfg.bindings.insert(
            "present".into(),
            crate::config::Binding {
                repo_path: poisoned_checkout(&root, "present"),
                branch: None,
                project_id: None,
            },
        );

        repair_installed_hooks(Some(&[]), &cfg, "a test");

        let text = std::fs::read_to_string(crate::daemon::hook_install::settings_path(
            &root.join("present"),
        ))
        .expect("read back");
        assert!(
            !text.contains(crate::exe::DELETED_SUFFIX),
            "a binding with no checkout took the sweep down with it: {text}"
        );
    }

    /// One row of `/me/runners`: a project this device is assigned, with the
    /// checkout the server holds for it.
    fn assignment(project_id: &str, slug: &str, repo_path: Option<&std::path::Path>) -> MeRunner {
        MeRunner {
            project_id: project_id.into(),
            runner_id: format!("runner-{slug}"),
            slug: slug.into(),
            base_branch: None,
            repo_path: repo_path.map(|p| p.to_str().expect("utf-8").to_string()),
            branch: None,
            status: "online".into(),
            workspace_setup: None,
            master_policy: None,
            rate_limited_for_seconds: None,
            limit_reason: None,
        }
    }

    /// Criterion 8's quantifier, at the shape the third judging run failed it
    /// on: a project bound to this device from the web UI lives in the
    /// `runners` table and need never appear in `config.toml`, so a sweep over
    /// `cfg.bindings` alone leaves its declaration gate dead through every
    /// boot — and the journal never names it.
    #[test]
    fn a_project_the_server_binds_and_config_does_not_is_swept() {
        let root = scratch("server-bound");
        let _installed = runnable(&root, "forge-runner");
        let repo = poisoned_checkout(&root, "serverbound");
        let cfg = Config::default();

        repair_installed_hooks(
            Some(&[assignment("p-1", "serverbound", Some(&repo))]),
            &cfg,
            "a test",
        );

        let text = std::fs::read_to_string(crate::daemon::hook_install::settings_path(&repo))
            .expect("read back");
        assert!(
            !text.contains(crate::exe::DELETED_SUFFIX),
            "a project this box is assigned, bound on the server and absent from config.toml, kept its dead commands: {text}"
        );
    }

    /// What the sweep wrote to the journal while `f` ran.
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
        // Why a capture needs this: `crate::daemon::keep_tracing_capturable`.
        crate::daemon::keep_tracing_capturable();
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    fn binding(repo_path: std::path::PathBuf, project_id: Option<&str>) -> crate::config::Binding {
        crate::config::Binding {
            repo_path,
            branch: None,
            project_id: project_id.map(str::to_string),
        }
    }

    /// The repair a sweep reports is read off the settings file, so a project
    /// it never opened is indistinguishable from one that needed nothing —
    /// which is how a dead declaration gate stood through every boot with the
    /// journal green. The slug goes in the line that says what was rewritten.
    #[test]
    fn the_server_bound_project_it_repairs_is_named_in_the_journal() {
        let root = scratch("server-bound-named");
        let _installed = runnable(&root, "forge-runner");
        let repo = poisoned_checkout(&root, "serverbound");
        let cfg = Config::default();

        let said = logged_while(|| {
            repair_installed_hooks(
                Some(&[assignment("p-1", "serverbound", Some(&repo))]),
                &cfg,
                "boot",
            );
        });

        assert!(
            said.contains("serverbound's settings named"),
            "the project the sweep rewrote is not named, so a reader cannot tell it was reached: {said}"
        );
    }

    /// A project the server binds and `config.toml` also binds, at two
    /// different directories: a dispatch goes to the server's, but the local
    /// one holds whatever a pre-fix daemon wrote there and no pane will ever
    /// be prepared in it again.
    #[test]
    fn both_checkouts_are_swept_where_the_server_and_config_name_different_ones() {
        let root = scratch("two-paths");
        let _installed = runnable(&root, "forge-runner");
        let on_server = poisoned_checkout(&root, "server-side");
        let in_config = poisoned_checkout(&root, "config-side");
        let mut cfg = Config::default();
        cfg.bindings
            .insert("acme".into(), binding(in_config.clone(), Some("p-1")));

        repair_installed_hooks(
            Some(&[assignment("p-1", "acme", Some(&on_server))]),
            &cfg,
            "a test",
        );

        for repo in [&on_server, &in_config] {
            let text = std::fs::read_to_string(crate::daemon::hook_install::settings_path(repo))
                .expect("read back");
            assert!(
                !text.contains(crate::exe::DELETED_SUFFIX),
                "{} kept its dead commands: {text}",
                repo.display()
            );
        }
    }

    /// The ordinary case — one project, one directory, named on both sides —
    /// is one checkout and not two, so the journal does not report the same
    /// repair twice and the file is not rewritten under itself.
    #[test]
    fn a_checkout_both_sides_name_is_swept_once() {
        let root = scratch("one-path");
        let repo = root.join("acme");
        let mut cfg = Config::default();
        cfg.bindings
            .insert("acme".into(), binding(repo.clone(), Some("p-1")));

        let bound = bound_checkouts(&[assignment("p-1", "acme", Some(&repo))], &cfg);

        assert_eq!(
            bound.checkouts,
            vec![("acme".to_string(), repo)],
            "one project at one path came back more than once"
        );
        assert!(bound.pathless.is_empty());
    }

    /// An assignment with no path on either side has no settings file to
    /// sweep. It is named — the daemon cannot repair what it cannot find —
    /// and the checkouts that do have one are still swept.
    #[test]
    fn an_assignment_naming_no_checkout_is_named_and_the_sweep_goes_on() {
        let root = scratch("pathless");
        let _installed = runnable(&root, "forge-runner");
        let repo = poisoned_checkout(&root, "present");
        let cfg = Config::default();

        let said = logged_while(|| {
            repair_installed_hooks(
                Some(&[
                    assignment("p-1", "unbound", None),
                    assignment("p-2", "present", Some(&repo)),
                ]),
                &cfg,
                "boot",
            );
        });

        assert!(
            said.contains("unbound is assigned to this box and names a checkout on neither side"),
            "an assignment with nowhere to sweep went unsaid: {said}"
        );
        let text = std::fs::read_to_string(crate::daemon::hook_install::settings_path(&repo))
            .expect("read back");
        assert!(
            !text.contains(crate::exe::DELETED_SUFFIX),
            "an assignment with no checkout took the rest of the sweep down with it: {text}"
        );
    }

    /// A sweep that could not ask which projects are assigned has covered the
    /// local fallback and nothing else. Reporting that as a sweep is the same
    /// silence this issue is about, one level up: the checkouts it cannot see
    /// are exactly the ones it exists to reach.
    #[test]
    fn a_box_that_could_not_ask_what_is_assigned_says_the_sweep_is_partial() {
        let root = scratch("no-discovery");
        let _installed = runnable(&root, "forge-runner");
        let mut cfg = Config::default();
        cfg.bindings.insert(
            "local".into(),
            binding(poisoned_checkout(&root, "local"), Some("p-1")),
        );

        let said = logged_while(|| repair_installed_hooks(None, &cfg, "boot"));

        assert!(
            said.contains("could not ask core which projects are assigned to it"),
            "the sweep reported a whole pass over a set it could not see: {said}"
        );
        let text = std::fs::read_to_string(crate::daemon::hook_install::settings_path(
            &root.join("local"),
        ))
        .expect("read back");
        assert!(
            !text.contains(crate::exe::DELETED_SUFFIX),
            "the local fallback was not swept either: {text}"
        );
    }

    /// The sweep exists to reach a project no pane is being prepared for, so
    /// where it is CALLED is the whole of what it buys. Both moments are read
    /// out of this module's own source: a call quietly dropped from either one
    /// leaves every test above green.
    #[test]
    fn the_sweep_runs_at_boot_and_again_the_moment_an_update_replaces_the_binary() {
        let src = production();
        assert!(
            src.contains(r#"repair_installed_hooks(server.as_deref(), &cfg, "boot")"#),
            "nothing sweeps at boot with the assignments this box just read, so a project bound only on the server is not in the set swept"
        );

        let applied = src
            .find("— draining before restart")
            .expect("the line the update writes once it has replaced the binary");
        let after_applied = &src[applied..];
        let next_sweep = after_applied
            .find(r#""after an update""#)
            .expect("nothing sweeps once the binary has been replaced under this process");
        let asked = after_applied
            .find("list_me(&assignments)")
            .expect("the sweep after an update is handed the local bindings alone, so a server-bound checkout keeps the binary this update just deleted");
        let next_drain = after_applied
            .find("drain_to_idle")
            .expect("the drain the restart waits on");
        assert!(
            asked < next_sweep,
            "the assignments are read after the sweep that needs them"
        );
        assert!(
            after_applied[..next_sweep].contains("assigned.as_deref()"),
            "the sweep after an update is not given what the request above it fetched"
        );
        assert!(
            next_sweep < next_drain,
            "the sweep is behind the drain, which is the wait that never ends on a busy box — so it never runs"
        );
    }
}
