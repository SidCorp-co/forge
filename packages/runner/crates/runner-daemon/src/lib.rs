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
mod actors;
pub mod control;
pub mod dispatch;
pub mod drain;
pub mod handover;
pub mod inbox;
pub mod master;
pub mod master_build;
pub mod master_exit;
pub mod master_handed;
pub mod master_inbox;
pub mod master_limit;
pub mod master_pass;
pub mod pool_jobs;
pub mod pool_reads;
pub mod recovery;
pub mod recovery_ports;
pub mod run_record;
pub mod serving;
pub mod session_ledger;
pub mod session_tokens;
pub mod skill_pull;

use runner_agent::chat;
use runner_core::agent_activity;
use runner_core::degraded;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::{mpsc, watch};

use runner_agent::claude_code::ClaudeCodeRunner;
use runner_agent::Runner;
use runner_core::inflight;
use runner_platform::config::Config;
use runner_platform::error::Result;
use runner_proto::frames::{job_id_of, session_id_of, Frame};
use runner_transport::runners::{self, MeRunner};
use runner_transport::ws::{self, WsConfig};
use runner_transport::{heartbeat, lifecycle, CoreClient};

use dispatch::resolve_repo;

pub(crate) const POOL_SUPERVISE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

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

/// What a handover carries across its exec besides the control listener.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) struct HandOver {
    /// The build this process serves, kept beside the install path once an
    /// update installed another there, which a handover that does not happen
    /// puts back.
    pub(crate) served: Arc<runner_update::ServedBuild>,
    /// The master panes declarations are checked against, which the next
    /// image serves at once rather than after its first sweep.
    pub(crate) masters: Arc<master::Masters>,
}

/// Replace this process's image with the build installed on disk, the control
/// listener carried, once `drain_to_idle` has closed the window for it.
/// Returns only where the exec did not happen: the build this process serves
/// goes back on disk where an update had replaced it, admission opens again
/// and this process goes on serving that build, until `next`.
fn hand_over(
    drain: &drain::Drain,
    carry: &HandOver,
    what: &str,
    cause: &str,
    next: drain::NextAttempt,
) {
    #[cfg(unix)]
    {
        let why = match runner_platform::exe::own() {
            Ok(own) => {
                let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
                tracing::warn!(
                    "[{what}] handing over for {cause}: replacing this process's image with {} — pid {} stays, and every pane, run and job stays where it is",
                    own.path.display(),
                    std::process::id()
                );
                let dir = runner_platform::config::config_dir();
                if let Some(dir) = &dir {
                    write_handed_masters(dir, &carry.masters, what);
                }
                let err = handover::replace_image(&own.path, &args, drain.socket().listener());
                if let Some(dir) = &dir {
                    master_handed::withdraw(dir);
                }
                format!("could not exec {}: {err}", own.path.display())
            }
            Err(e) => format!("could not name the build installed on disk: {e}"),
        };
        handover_did_not_happen(drain, &carry.served, what, cause, why, &next);
    }
    #[cfg(not(unix))]
    {
        let _ = carry;
        let why = handover::NO_HANDOVER_HERE.to_string();
        tracing::error!(
            "[{what}] the handover for {cause} did not happen — {why}. Admission is open again and this process goes on serving the build it started with"
        );
        drain.handover_failed(&why, &next);
    }
}

/// Write the master panes this process serves for the image that follows.
#[cfg(unix)]
fn write_handed_masters(dir: &std::path::Path, masters: &master::Masters, what: &str) {
    let (served, masters) = masters.hand_on();
    let handed = master_handed::Handed {
        pid: std::process::id(),
        boot_id: runner_core::inflight::boot_identity(),
        written_at_ms: agent_activity::now_ms(),
        served,
        masters,
    };
    if let Err(e) = master_handed::write(dir, &handed) {
        tracing::warn!(
            "[{what}] the master panes this process serves could not be written for the image that follows ({e}); it serves them from its first sweep, refusing their declarations until then"
        );
    }
}

/// Serve the master panes the image before this one handed on, where this
/// process is that image's exec, and say what was found.
fn take_handed_masters(masters: &master::Masters) {
    let Some(dir) = runner_platform::config::config_dir() else {
        return;
    };
    let boot = runner_core::inflight::boot_identity();
    match master_handed::take(
        &dir,
        std::process::id(),
        boot.as_deref(),
        agent_activity::now_ms(),
    ) {
        master_handed::Taken::Nothing => {}
        master_handed::Taken::Handed(handed) => {
            let n = masters.take_handed(handed);
            tracing::info!(
                "[master] serving the {n} master pane(s) the build before this one handed over, so their declarations are answered from now rather than from this image's first sweep"
            );
        }
        master_handed::Taken::Refused(why) => tracing::warn!(
            "[master] a handed-over masters registry was found and not taken: {why}. This image serves its master panes from its first sweep"
        ),
    }
}

/// The exec did not happen: put the build this process serves back on the path
/// an update installed another at, so every hook and command on the box runs
/// it again, then reopen admission naming why.
#[cfg(unix)]
fn handover_did_not_happen(
    drain: &drain::Drain,
    served: &runner_update::ServedBuild,
    what: &str,
    cause: &str,
    mut why: String,
    next: &drain::NextAttempt,
) {
    match served.restore() {
        Ok(Some(kept)) => why.push_str(&format!(
            "; the build this process serves is back at {} from {}, so every hook and command on this box runs it again",
            kept.exe.display(),
            kept.at.display()
        )),
        Ok(None) => {}
        Err(e) => why.push_str(&format!(
            "; {e}, so every hook and command on this box runs a build that did not start until one that runs is installed there"
        )),
    }
    tracing::error!(
        "[{what}] the handover for {cause} did not happen — {why}. Admission is open again and this process goes on serving the build it started with; the next attempt is {}",
        next.by
    );
    drain.handover_failed(&why, next);
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
    let exe = match runner_platform::exe::own() {
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
        match runner_workspace::hook_install::repair(repo, &exe.path) {
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
    runner_workspace::master_skill::install_every(
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

/// What a daemon reconciles before it starts anything: which projects route here, the hooks the
/// daemon it replaced installed, and the forge-master skill in every checkout.
async fn boot(cfg: &Config, client: &CoreClient) {
    // Discover server-side assignments (`/me/runners`). This is the source of
    // truth for which projects route to this device and for their repo paths;
    // config.toml is only a local fallback now (ISS-271). Best-effort: an old
    // server or transient failure falls back to config-only behaviour.
    let server: Option<Vec<MeRunner>> = match runners::list_me(client).await {
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
        if resolve_repo(assigned, cfg, &r.project_id).is_err() {
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
    repair_installed_hooks(server.as_deref(), cfg, "boot");
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
        runner_platform::config::config_dir().as_deref(),
    );
}

/// Run the daemon until Ctrl-C. `device_token` comes from the cred store.
#[expect(
    clippy::too_many_lines,
    reason = "the daemon wiring: one spawn per actor, in start order (ISS-218 amnesty)"
)]
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
        runner_platform::cred_store::active_backend()
    );
    let client = Arc::new(CoreClient::new(core_url.clone(), device_token.clone()));
    let runner = Arc::new(ClaudeCodeRunner::new(
        core_url.clone(),
        device_token.clone(),
        (cfg.runner.duplex_max_sessions as usize).max(1),
    ));

    boot(&cfg, &client).await;

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

    tokio::spawn(actors::ledger_snapshot(ledger_tx, cancel_rx.clone()));

    // In-flight work counter (pipeline jobs + chat turns). The update loop
    // drains this to zero before restarting so auto-update never kills running
    // work (ISS-392). Created before any spawn so every worker can register.
    let inflight = Arc::new(AtomicUsize::new(0));

    // Whether this daemon admits long work, shared by everything that admits
    // it, and the record `forge-runner status` reads of the build it serves.
    let drain = Arc::new(drain::Drain::new(runner_platform::config::config_dir()));

    // The build this process serves, kept where an update installs another,
    // and the master panes it serves, both carried by a handover's exec.
    let served = Arc::new(runner_update::ServedBuild::new());
    let masters = Arc::new(master::Masters::new());
    take_handed_masters(&masters);

    // Update check loop: warn when a newer release exists; auto-apply +
    // restart when `update.auto` is set.
    if let Some(url) =
        runner_update::manifest_url(cfg.update.manifest_url.as_deref(), Some(&core_url))
    {
        let u = actors::Updates {
            url,
            auto: cfg.update.auto,
            inflight: inflight.clone(),
            drain: drain.clone(),
            runner: runner.clone(),
            bound: cfg.clone(),
            assignments: client.clone(),
            carry: HandOver {
                served: served.clone(),
                masters: masters.clone(),
            },
        };
        tokio::spawn(actors::updates(u, cancel_rx.clone()));
    }

    tokio::spawn(actors::cred_watch(
        device_token.clone(),
        inflight.clone(),
        drain.clone(),
        runner.clone(),
        HandOver {
            served: served.clone(),
            masters: masters.clone(),
        },
        cancel_rx.clone(),
    ));
    tokio::spawn(actors::heartbeat(client.clone(), cancel_rx.clone()));

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

    tokio::spawn(actors::provision_sweep(
        client.clone(),
        cfg.clone(),
        cancel_rx.clone(),
    ));
    tokio::spawn(actors::worktree_reap(cfg.clone(), cancel_rx.clone()));
    tokio::spawn(actors::headroom(cancel_rx.clone()));

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

    tokio::spawn(actors::plugin_sweep(
        client.clone(),
        cfg.clone(),
        cancel_rx.clone(),
    ));

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
    let (adopted_tx, adopted_rx) = watch::channel(false);
    tokio::spawn(actors::job_panes(
        (*client).clone(),
        job_panes.clone(),
        job_records.clone(),
        activity.clone(),
        adopted_tx,
        cancel_rx.clone(),
    ));
    #[cfg(unix)]
    actors::control(&activity, &masters, &drain, cancel_rx.clone())?;
    let (wake_tx, wake_rx) = master::wake_channel();
    tokio::spawn(master::run(
        (*client).clone(),
        (*cfg).clone(),
        master::Shared {
            masters: masters.clone(),
            activity: activity.clone(),
            job_panes,
            job_records,
            drain,
        },
        adopted_rx,
        cancel_rx.clone(),
        wake_rx,
    ));

    let ctx = actors::FrameCtx {
        client,
        runner,
        masters,
        inflight,
        cfg,
        wake_tx,
    };
    let mut cancel_rx = cancel_rx.clone();
    loop {
        tokio::select! {
            frame = frame_rx.recv() => {
                let Some(frame) = frame else { break };
                actors::on_frame(frame, &ctx);
            }
            _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
        }
    }

    Ok(())
}
