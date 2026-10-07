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
mod ancestry_read;
mod checkout_frame;
pub mod control;
pub mod dispatch;
pub mod drain;
pub mod handover;
mod head_read;
pub mod inbox;
pub mod master;
pub mod master_build;
pub mod master_exit;
pub mod master_handed;
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
pub mod standing_dialogs;
pub mod wake_source;

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
use runner_transport::{heartbeat, CoreClient};

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
/// daemon it replaced installed, and the forge-master skill and orientation in every checkout.
async fn boot(cfg: &Config, client: &CoreClient) {
    serve_probation();
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
    let record_dir = runner_platform::config::config_dir();
    let lock_dir = record_dir.as_deref().map(|d| d.join("locks"));
    reconcile_checkouts(
        server.as_deref(),
        &fresh,
        census_from,
        record_dir.as_deref(),
        lock_dir.as_deref(),
    )
    .await;
}

/// What every start writes into every bound checkout, whatever the daemon it
/// replaced left there: the running build's forge-master skill and its
/// orientation. `record_dir` is where `forge-runner status` reads each outcome
/// back, and `lock_dir` where each checkout's provision lock lives.
async fn reconcile_checkouts(
    server: Option<&[MeRunner]>,
    cfg: &Config,
    census_from: Option<i64>,
    record_dir: Option<&std::path::Path>,
    lock_dir: Option<&std::path::Path>,
) {
    install_master_skills(server, cfg, census_from, record_dir);
    converge_orientations(server, cfg, census_from, record_dir, lock_dir).await;
}

/// Write the running build's orientation into every checkout this box is
/// bound to, once per checkout, so a box that upgraded onto a build that
/// moves it converges without anybody re-binding each checkout. A start is
/// the one moment every build change passes through: an update's handover
/// execs a new process.
async fn converge_orientations(
    server: Option<&[MeRunner]>,
    cfg: &Config,
    census_from: Option<i64>,
    record_dir: Option<&std::path::Path>,
    lock_dir: Option<&std::path::Path>,
) {
    use runner_workspace::orientation_record::{converge_every, Bound};
    let rows = server.unwrap_or_default();
    let bound = bound_checkouts(rows, cfg);
    if server.is_none() {
        tracing::warn!(
            "[orientation] this box could not ask core which projects are assigned to it, so core served no orientation and none of the {} checkout(s) config.toml names is written",
            bound.checkouts.len()
        );
    }
    let checkouts: Vec<Bound> = bound
        .checkouts
        .into_iter()
        .map(|(slug, repo)| {
            let row = rows.iter().find(|r| r.slug == slug);
            let project_id = row
                .map(|r| r.project_id.clone())
                .or_else(|| cfg.bindings.get(&slug).and_then(|b| b.project_id.clone()));
            Bound {
                orientation: row.and_then(|r| r.orientation.clone()),
                slug,
                project_id,
                repo,
            }
        })
        .collect();
    converge_every(
        &checkouts,
        lock_dir,
        record_dir,
        census_from.filter(|_| server.is_some()),
    )
    .await;
}

/// Where this daemon's WebSocket connects, as the device it is.
fn ws_config(core_url: &str, device_token: &str, device_id: &str) -> WsConfig {
    // tungstenite needs a ws:// / wss:// scheme, not http(s)://.
    let ws_base = core_url
        .trim_end_matches('/')
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    WsConfig {
        url: format!("{ws_base}/ws"),
        device_token: device_token.to_string(),
        device_id: device_id.to_string(),
    }
}

/// The WebSocket connect loop.
fn spawn_ws(
    ws_cfg: WsConfig,
    frame_tx: mpsc::Sender<Frame>,
    ledger_rx: watch::Receiver<Option<String>>,
    cancel_rx: watch::Receiver<bool>,
) {
    tokio::spawn(async move { ws::connect(ws_cfg, frame_tx, ledger_rx, cancel_rx).await });
}

/// Ctrl-C → cancel.
fn spawn_ctrl_c(cancel_tx: watch::Sender<bool>) {
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("shutting down…");
        let _ = cancel_tx.send(true);
    });
}

/// Background skill auto-pull (ISS-736) — OFF by default (canary gate).
/// Independent poller; `skill.sync` stays the immediate, explicit path.
fn spawn_skill_pull(
    client: &Arc<CoreClient>,
    cfg: &Arc<Config>,
    cancel_rx: &watch::Receiver<bool>,
) {
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
}

/// Where started pool jobs are recorded, so a job whose pane dies with this daemon is reported dead.
fn job_records() -> Arc<dyn pool_jobs::Records> {
    match pool_jobs::FileRecords::default_dir() {
        Some(dir) => Arc::new(pool_jobs::FileRecords { dir }),
        None => {
            tracing::error!(
                "[pool] no config directory to record started jobs in — a job whose pane dies with this daemon will wait out core's result timeout instead of being reported dead"
            );
            Arc::new(pool_jobs::NoRecords)
        }
    }
}

/// The pool's job panes and the master loop that reads them; answers the sender that wakes the
/// master, and the job panes a `job.cancel` frame closes.
fn spawn_panes_and_master(
    client: &Arc<CoreClient>,
    cfg: &Arc<Config>,
    masters: &Arc<master::Masters>,
    drain: Arc<drain::Drain>,
    activity: &Arc<agent_activity::Activities>,
    cancel_rx: &watch::Receiver<bool>,
) -> Result<(
    tokio::sync::mpsc::Sender<master::Wake>,
    pool_jobs::PoolPanes,
)> {
    let job_panes = Arc::new(pool_jobs::JobPanes::new());
    let job_records = job_records();
    let (adopted_tx, adopted_rx) = watch::channel(false);
    tokio::spawn(actors::job_panes(
        (**client).clone(),
        job_panes.clone(),
        job_records.clone(),
        activity.clone(),
        adopted_tx,
        cancel_rx.clone(),
    ));
    #[cfg(unix)]
    actors::control(client, activity, masters, &drain, cancel_rx.clone())?;
    let pool = pool_jobs::PoolPanes {
        panes: Arc::new(pool_jobs::TmuxPanes),
        records: job_records.clone(),
        registry: job_panes.clone(),
    };
    let (wake_tx, wake_rx) = master::wake_channel();
    tokio::spawn(master::run(
        (**client).clone(),
        (**cfg).clone(),
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
    Ok((wake_tx, pool))
}

/// Run the daemon until Ctrl-C. `device_token` comes from the cred store.
/// Say what a probation holds back, and confirm this build's own probation
/// once it has stayed up for its period (ISS-1378).
fn serve_probation() {
    say_what_is_held_back();
    tokio::spawn(async {
        tokio::time::sleep(runner_update::probation::PERIOD).await;
        confirm_probation();
    });
}

/// End the probation of the build this process serves, which has stayed up.
fn confirm_probation() {
    let exe = match runner_platform::exe::own() {
        Ok(own) => own.path,
        Err(e) => {
            tracing::warn!("[update] this build's probation cannot be confirmed: {e}");
            return;
        }
    };
    match runner_update::probation::confirm(&exe, runner_update::CURRENT_VERSION) {
        Ok(true) => tracing::info!(
            "[update] {} has served {}s and is confirmed: its probation is over",
            runner_update::CURRENT_VERSION,
            runner_update::probation::PERIOD.as_secs()
        ),
        Ok(false) => {}
        Err(e) => tracing::warn!(
            "[update] the probation of {} at {} could not be ended ({e}); a later restart counts against it as though this one had not stayed up",
            runner_update::CURRENT_VERSION,
            runner_update::probation::path(&exe).display()
        ),
    }
}

/// Say, from this process's first moment, a release a probation put back from
/// the build it serves: the first update check is half a minute away.
fn say_what_is_held_back() {
    let exe = match runner_platform::exe::own() {
        Ok(own) => own.path,
        Err(e) => {
            tracing::warn!("[update] whether a release is held back cannot be read: {e}");
            return;
        }
    };
    match runner_update::probation::rejected(&exe) {
        Ok(Some(r)) => tracing::warn!("[update] {} is held back: {}", r.version, r.why(&exe)),
        Ok(None) => {}
        Err(why) => tracing::warn!(
            "[update] the record of a release a probation put back is unreadable, so no update is installed until it is: {why}"
        ),
    }
}

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

    spawn_ws(
        ws_config(&core_url, &device_token, &device_id),
        frame_tx,
        ledger_rx,
        cancel_rx.clone(),
    );

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
    let disk = actors::spawn_headroom(cancel_rx.clone());
    tokio::spawn(actors::heartbeat(client.clone(), disk, cancel_rx.clone()));

    spawn_ctrl_c(cancel_tx.clone());

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

    spawn_skill_pull(&client, &cfg, &cancel_rx);

    tokio::spawn(actors::plugin_sweep(
        client.clone(),
        cfg.clone(),
        cancel_rx.clone(),
    ));

    let activity = Arc::new(agent_activity::Activities::new());

    let (wake_tx, pool) =
        spawn_panes_and_master(&client, &cfg, &masters, drain, &activity, &cancel_rx)?;

    let ctx = actors::FrameCtx {
        client,
        runner,
        masters,
        inflight,
        cfg,
        wake_tx,
        pool,
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

#[cfg(test)]
mod start_tests {
    use super::*;
    use runner_platform::config::Binding;
    use runner_workspace::orientation::ORIENTATION;
    use runner_workspace::orientation_record::{self, Outcome};
    use std::path::{Path, PathBuf};

    const PROD: &str = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
    const DEV: &str = "d1bb4907-74d9-4228-85ff-76121523af7d";

    /// An orientation of the shape core serves (`prompt/checkout-orientation.ts`).
    fn orientation_body(project_id: &str, slug: &str) -> String {
        format!(
            "# Forge orientation — {slug}\n\n<!-- Generated by Forge on device provision. Forge-owned; manual edits are overwritten. -->\n\n- **projectId:** `{project_id}`\n"
        )
    }

    /// What core answers `me/runners` with for the checkout at `co`.
    fn served(co: &Path) -> Vec<MeRunner> {
        vec![serde_json::from_value(serde_json::json!({
            "projectId": DEV,
            "runnerId": "r",
            "slug": "forge",
            "status": "online",
            "repoPath": co.to_str().unwrap(),
            "orientation": orientation_body(DEV, "forge"),
        }))
        .unwrap()]
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.email=t@example.invalid", "-c", "user.name=t"])
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A clone an older runner provisioned: the committed orientation (another
    /// instance's) held under skip-worktree with this instance's written over it.
    fn old_shape_checkout(root: &Path) -> PathBuf {
        let seed = root.join("seed");
        std::fs::create_dir_all(seed.join(".forge")).unwrap();
        git(&seed, &["init", "-q"]);
        // `* -text` is committed so every checkout or worktree of this repo, including ones the product cuts, restores the committed bytes whatever `core.autocrlf` the box ships (Windows: true).
        std::fs::write(
            seed.join(".gitattributes"),
            "* -text
",
        )
        .unwrap();
        std::fs::write(seed.join(ORIENTATION), orientation_body(PROD, "forge-dev")).unwrap();
        std::fs::write(
            seed.join("CLAUDE.md"),
            "@.forge/orientation.md\n\n# Forge\n",
        )
        .unwrap();
        git(&seed, &["add", "-A"]);
        git(&seed, &["commit", "-q", "-m", "committed"]);
        let co = root.join("co");
        git(
            root,
            &[
                "clone",
                "-q",
                "-c",
                "core.autocrlf=false",
                seed.to_str().unwrap(),
                co.to_str().unwrap(),
            ],
        );
        git(&co, &["update-index", "--skip-worktree", ORIENTATION]);
        std::fs::write(co.join(ORIENTATION), orientation_body(DEV, "forge")).unwrap();
        co
    }

    fn snapshot(co: &Path) -> Vec<(String, Option<(String, std::time::SystemTime)>)> {
        [
            "CLAUDE.local.md",
            ".claude/settings.local.json",
            ".git/info/exclude",
            ORIENTATION,
        ]
        .iter()
        .map(|p| {
            let at = co.join(p);
            let held = std::fs::read_to_string(&at)
                .ok()
                .zip(std::fs::metadata(&at).and_then(|m| m.modified()).ok());
            (p.to_string(), held)
        })
        .collect()
    }

    fn outcomes(dir: &Path) -> Vec<(String, Outcome)> {
        match orientation_record::read(dir) {
            orientation_record::Read::Record(r) => {
                r.entries.into_iter().map(|e| (e.slug, e.outcome)).collect()
            }
            other => panic!("no orientation record a daemon start wrote: {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_daemon_start_converts_a_checkout_an_older_runner_held_under_skip_worktree_and_a_second_start_writes_nothing(
    ) {
        let root =
            std::env::temp_dir().join(format!("forge-start-orient-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let co = old_shape_checkout(&root);
        let (records, locks) = (root.join("config"), root.join("config/locks"));
        let mut cfg = Config::default();
        let bind = |path: PathBuf, project_id: Option<&str>| Binding {
            repo_path: path,
            branch: None,
            project_id: project_id.map(str::to_string),
        };
        cfg.bindings
            .insert("forge".into(), bind(co.clone(), Some(DEV)));
        cfg.bindings
            .insert("unnamed".into(), bind(root.join("unnamed"), None));
        cfg.bindings
            .insert("uncloned".into(), bind(root.join("uncloned"), Some("p-2")));
        std::fs::create_dir_all(root.join("unnamed")).unwrap();

        let rows = served(&co);
        reconcile_checkouts(Some(&rows), &cfg, None, Some(&records), Some(&locks)).await;

        assert!(
            git(&co, &["ls-files", "-v", ORIENTATION]).starts_with("H "),
            "ORIENTATION_NOT_CONVERGED_AT_START: a daemon start left {ORIENTATION} under the older runner's skip-worktree mark"
        );
        assert_eq!(
            std::fs::read_to_string(co.join(ORIENTATION)).unwrap(),
            orientation_body(PROD, "forge-dev"),
            "the committed file is restored"
        );
        let local = std::fs::read_to_string(co.join("CLAUDE.local.md")).unwrap();
        assert!(local.contains(DEV) && !local.contains(PROD), "{local}");
        assert_eq!(
            git(&co, &["status", "--porcelain"]),
            "",
            "nothing tracked is left changed"
        );
        let first = outcomes(&records);
        assert!(
            matches!(&first[0], (s, Outcome::Converted { note }) if s == "forge" && note.contains("skip-worktree")),
            "{first:?}"
        );
        assert!(
            !root.join("uncloned").exists(),
            "a start creates no checkout"
        );
        assert_eq!(
            first[1],
            ("uncloned".into(), Outcome::NoCheckout),
            "{first:?}"
        );
        assert_eq!(
            first[2],
            ("unnamed".into(), Outcome::NoProject),
            "{first:?}"
        );

        let before = snapshot(&co);
        reconcile_checkouts(Some(&rows), &cfg, None, Some(&records), Some(&locks)).await;
        assert_eq!(snapshot(&co), before, "a second start rewrites nothing");
        assert_eq!(outcomes(&records)[0], ("forge".into(), Outcome::Current));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_start_core_did_not_answer_writes_no_orientation_and_says_why() {
        let root =
            std::env::temp_dir().join(format!("forge-start-unserved-{}", uuid::Uuid::new_v4()));
        let co = root.join("co");
        std::fs::create_dir_all(&co).unwrap();
        git(&co, &["init", "-q"]);
        let (records, locks) = (root.join("config"), root.join("config/locks"));
        let mut cfg = Config::default();
        cfg.bindings.insert(
            "forge".into(),
            Binding {
                repo_path: co.clone(),
                branch: None,
                project_id: Some(DEV.into()),
            },
        );

        converge_orientations(None, &cfg, None, Some(&records), Some(&locks)).await;

        assert!(
            !co.join("CLAUDE.local.md").exists(),
            "a box guessed an orientation core never sent"
        );
        let said = outcomes(&records);
        assert!(
            matches!(&said[0], (s, Outcome::Refused { detail }) if s == "forge" && detail.starts_with("PROVISION_ORIENTATION_NOT_SERVED")),
            "{said:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod test_core;
