//! The daemon's long-lived tasks, one per component: each owns its state and
//! stops when `cancel` says so.

use crate::*;

/// A tick now and then once every `period`, measured from the start of each
/// tick, until `cancel` says stop.
///
/// The wait comes before the work, so the interval's first tick — which
/// completes at once — is the first run and not a second one straight after
/// it. Run the other way round, a first update check whose drain gave up after
/// two hours was followed at once by another (ISS-1223).
pub(crate) struct Ticks {
    tick: tokio::time::Interval,
    cancel: watch::Receiver<bool>,
}

impl Ticks {
    pub(crate) fn new(period: std::time::Duration, cancel: watch::Receiver<bool>) -> Self {
        let mut tick = tokio::time::interval(period);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        Self { tick, cancel }
    }

    /// The next tick's instant, or `None` once cancelled.
    pub(crate) async fn next(&mut self) -> Option<tokio::time::Instant> {
        loop {
            tokio::select! {
                _ = self.tick.tick() => return Some(tokio::time::Instant::now()),
                _ = self.cancel.changed() => {
                    if *self.cancel.borrow() { return None; }
                }
            }
        }
    }
}

/// Publish the box ledger's run snapshot for the WebSocket to send.
pub(crate) async fn ledger_snapshot(
    tx: watch::Sender<Option<String>>,
    cancel: watch::Receiver<bool>,
) {
    let mut ticks = Ticks::new(SESSION_LEDGER_INTERVAL, cancel);
    while ticks.next().await.is_some() {
        let snapshot = runner_core::ledger::Ledger::default_path()
            .and_then(|p| runner_core::ledger::Ledger::open(&p))
            .and_then(|led| crate::session_ledger::snapshot(&led));
        match snapshot {
            Ok(runs) => {
                let _ = tx.send(Some(crate::session_ledger::frame(&runs)));
            }
            Err(e) => tracing::warn!("[ledger] snapshot unavailable: {e}"),
        }
    }
}

/// What the update loop needs to apply a release and drain before restarting.
pub(crate) struct Updates {
    pub(crate) url: String,
    pub(crate) auto: bool,
    pub(crate) inflight: Arc<AtomicUsize>,
    pub(crate) drain: Arc<drain::Drain>,
    pub(crate) runner: Arc<ClaudeCodeRunner>,
    pub(crate) bound: Config,
    pub(crate) assignments: Arc<CoreClient>,
    pub(crate) carry: HandOver,
}

/// Warn when a newer release exists; with `update.auto`, apply it and restart
/// once idle. First check ~30s after start, then every six hours.
pub(crate) async fn updates(u: Updates, cancel: watch::Receiver<bool>) {
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    let mut ticks = Ticks::new(UPDATE_CHECK_INTERVAL, cancel);
    while let Some(checked_at) = ticks.next().await {
        check_update(&u, checked_at).await;
    }
}

async fn check_update(u: &Updates, checked_at: tokio::time::Instant) {
    let Updates {
        url,
        auto,
        inflight,
        drain,
        runner,
        bound,
        assignments,
        carry,
    } = u;
    let auto = *auto;
    match runner_update::fetch_manifest(url).await {
        Ok(m) if runner_update::is_newer(&m.version, runner_update::CURRENT_VERSION) => {
            tracing::warn!(
                "[update] available: {} → {}",
                runner_update::CURRENT_VERSION,
                m.version
            );
            if auto && cfg!(not(unix)) {
                // Renaming over the running image is refused here, and nothing
                // would start the new build after it, so the download is not
                // even taken: the release is named and left to the operator.
                tracing::error!(
                    "[update] {} is available and auto-update is refused on this platform: {}. Stop forge-runner, install {} by hand, and start it again",
                    m.version,
                    handover::NO_HANDOVER_HERE,
                    m.version
                );
            } else if auto {
                match runner_update::apply(&m, Some(&carry.served)).await {
                    Ok(Some(o)) => {
                        // The new binary is already swapped on disk; this
                        // process hands over to it once its own in-process
                        // work has ended.
                        tracing::warn!(
                            "[update] applied {} → {} — handing over to it once this process's own work ends",
                            o.from,
                            o.to
                        );
                        // From this instant `current_exe()` in this process
                        // reads `<path> (deleted)`, and the handover that ends
                        // that may wait on a chat turn for as long as it runs.
                        // So every bound checkout is repointed at the build
                        // just installed, now, rather than at the next pane
                        // preparation. Which checkouts those are is asked for
                        // again rather than carried from boot: an assignment
                        // made since is one this daemon has been preparing
                        // panes in, and its settings file names the binary
                        // this update just replaced.
                        let assigned = runners::list_me(assignments).await.ok();
                        repair_installed_hooks(assigned.as_deref(), bound, "after an update");
                        let cause = format!("update {} → {}", o.from, o.to);
                        let next = || drain::NextAttempt {
                            by: "the next update check".into(),
                            due_in: UPDATE_CHECK_INTERVAL.saturating_sub(checked_at.elapsed()),
                        };
                        let outcome = drain::drain_to_idle(
                            drain,
                            "update",
                            &cause,
                            inflight,
                            || close_parked_sessions(runner),
                            next,
                        )
                        .await;
                        match outcome {
                            drain::Drained::NotNow(why) => tracing::warn!(
                                "[update] {} stands on disk and this process keeps serving {} — {why}; the next update check tries again",
                                o.to,
                                o.from
                            ),
                            drain::Drained::GaveUp => {}
                            drain::Drained::Idle => {
                                hand_over(drain, carry, "update", &cause, next());
                            }
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

/// Credential watch (ISS-467): a fresh `forge-runner login` rotates the device
/// token in the cred store, but the HTTP client and the WebSocket were built
/// with the token captured at startup. When the stored token changes, drain
/// in-flight work and exit so systemd relaunches with every client rebuilt.
/// It fires only on an actual change, so it cannot become the old 401
/// fast-restart hammer.
pub(crate) async fn cred_watch(
    startup_token: String,
    inflight: Arc<AtomicUsize>,
    drain: Arc<drain::Drain>,
    runner: Arc<ClaudeCodeRunner>,
    carry: HandOver,
    cancel: watch::Receiver<bool>,
) {
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    // What this loop last said about a drain it could not start, so a refusal
    // it meets every thirty seconds is said once.
    let mut said: Option<String> = None;
    let mut ticks = Ticks::new(std::time::Duration::from_secs(30), cancel);
    while ticks.next().await.is_some() {
        // Only act on a confirmed, changed token. None/Err (a transient
        // read during the atomic rename, or a cleared store) is left
        // alone so a blip never triggers a restart.
        if let Ok(Some(current)) = runner_platform::cred_store::load_device_token() {
            if current != startup_token {
                if cfg!(not(unix)) {
                    if said.is_none() {
                        tracing::error!(
                            "[cred] the device token changed (re-login detected), and this daemon cannot take it: {}. Restart forge-runner by hand so it reads the new token; until then it goes on with the token it started with",
                            handover::NO_HANDOVER_HERE
                        );
                    }
                    said = Some("no handover here".into());
                    continue;
                }
                if said.is_none() {
                    tracing::warn!(
                                "[cred] device token changed (re-login detected) — handing over to a fresh image of this build once this process's own work ends, which reads the new token"
                            );
                }
                let next = || drain::NextAttempt {
                    by: "this loop's next handover".into(),
                    due_in: std::time::Duration::from_secs(drain::DRAIN_REOPEN_SECS),
                };
                match drain::drain_to_idle(
                    &drain,
                    "cred",
                    "a new device token",
                    &inflight,
                    || close_parked_sessions(&runner),
                    next,
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
                hand_over(&drain, &carry, "cred", "a new device token", next());
                said = Some("handover failed".into());
            }
        }
    }
}

/// The heartbeat, carrying the gate and pool-read conditions.
pub(crate) async fn heartbeat(client: Arc<CoreClient>, cancel: watch::Receiver<bool>) {
    // The verdict this loop last shouted about, so a gate failing open says so
    // once rather than every thirty seconds. Held here and not on disk: a daemon
    // that starts into a gate already failing open states what it inherited.
    let mut shouted: Option<runner_proto::gate::Verdict> = None;
    let period = std::time::Duration::from_secs(heartbeat::INTERVAL_SECS);
    let mut ticks = Ticks::new(period, cancel);
    while ticks.next().await.is_some() {
        let conditions = heartbeat_conditions(
            runner_platform::config::config_dir().as_deref(),
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
}

/// The workspace-provisioning sweep: catches up a device that was offline when
/// a project was assigned. Core returns only `queued` rows.
pub(crate) async fn provision_sweep(
    client: Arc<CoreClient>,
    cfg: Arc<Config>,
    cancel: watch::Receiver<bool>,
) {
    let mut ticks = Ticks::new(std::time::Duration::from_secs(90), cancel);
    while ticks.next().await.is_some() {
        runner_workspace::provision::run_pending(&client, &cfg).await;
    }
}

/// Reclaim finished runs' checkouts the ledger no longer holds.
pub(crate) async fn worktree_reap(cfg: Arc<Config>, mut cancel_rx: watch::Receiver<bool>) {
    use runner_workspace::worktree_reap::{SweepClock, SWEEP_PERIOD};
    let mut clock = SweepClock::default();
    let mut wait = std::time::Duration::ZERO;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(wait) => {
                let held_by = runner_core::ledger::Ledger::default_path()
                    .and_then(|p| runner_core::ledger::Ledger::open(&p))
                    .and_then(|l| runner_workspace::worktree_reap::HeldTrees::from_ledger(&l));
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
                    let swept = runner_workspace::worktree_reap::reap_repo(
                        &b.repo_path,
                        runner_workspace::worktree_reap::MIN_AGE,
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
}

/// What the box has left, on its own clock rather than the reap sweep's: the
/// box that raised ISS-1260 crossed both thresholds inside four hours.
pub(crate) async fn headroom(cancel: watch::Receiver<bool>) {
    use runner_workspace::headroom::{self, TICK};
    let roots = headroom::scratch_roots();
    let mut watch = headroom::Watch::default();
    let mut ticks = Ticks::new(TICK, cancel);
    while ticks.next().await.is_some() {
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
        let survey = tokio::task::spawn_blocking(move || headroom::survey(&here))
            .await
            .unwrap_or_else(|e| headroom::Survey {
                at: std::path::PathBuf::from("<none>"),
                reading: headroom::Reading::Refused(format!("the reading did not finish ({e})")),
                beside: Vec::new(),
            });
        if let Some(report) = watch.tick(std::time::Instant::now(), survey.reading.verdict()) {
            headroom::say(&survey, &report);
        }
    }
}

/// The shared-skill plugin-marketplace sweep (ISS-739), after a jittered delay
/// of up to ten minutes so a fleet restarting together does not hit the remote
/// at once.
pub(crate) async fn plugin_sweep(
    client: Arc<CoreClient>,
    cfg: Arc<Config>,
    mut cancel: watch::Receiver<bool>,
) {
    let jitter_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_millis() as u64
        % 1000;
    tokio::select! {
        _ = tokio::time::sleep(std::time::Duration::from_millis(jitter_ms * 600)) => {}
        _ = cancel.changed() => { if *cancel.borrow() { return; } }
    }
    let period = std::time::Duration::from_secs(cfg.plugins.poll_interval_secs.max(1));
    let mut ticks = Ticks::new(period, cancel);
    while ticks.next().await.is_some() {
        sweep_plugins(&client, &cfg).await;
    }
}

/// Adopt the job panes a previous daemon left, then supervise them.
pub(crate) async fn job_panes(
    client: CoreClient,
    panes: Arc<pool_jobs::JobPanes>,
    records: Arc<dyn pool_jobs::Records>,
    activity: Arc<agent_activity::Activities>,
    adopted: watch::Sender<bool>,
    cancel: watch::Receiver<bool>,
) {
    let report = pool_jobs::CoreReport { client: &client };
    pool_jobs::adopt(&pool_jobs::TmuxPanes, &report, records.as_ref(), &panes).await;
    let _ = adopted.send(true);
    let mut ticks = Ticks::new(POOL_SUPERVISE_INTERVAL, cancel);
    while ticks.next().await.is_some() {
        pool_jobs::supervise(
            &pool_jobs::TmuxPanes,
            &report,
            records.as_ref(),
            &panes,
            activity.as_ref(),
        )
        .await;
    }
}

/// The control socket a pane's hooks and `forge-runner run` talk to.
#[cfg(unix)]
pub(crate) fn control(
    activity: &Arc<agent_activity::Activities>,
    masters: &Arc<master::Masters>,
    drain: &Arc<drain::Drain>,
    cancel_rx: watch::Receiver<bool>,
) -> Result<()> {
    let Some(tokens_path) = session_tokens::default_path() else {
        return Err(runner_platform::error::Error::Other(
            "cannot resolve the control token map path".into(),
        ));
    };
    let ctl_ledger = Arc::new(std::sync::Mutex::new(
        match runner_core::ledger::Ledger::default_path()
            .and_then(|p| runner_core::ledger::Ledger::open(&p))
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
        boot_id: runner_core::inflight::boot_identity().unwrap_or_default(),
        config_dir: runner_platform::config::config_dir(),
        promises: std::sync::Mutex::new(control::GateMemory::default()),
        drain: drain.clone(),
        hosts: Arc::new(runner_platform::subagent_host::ProcHosts::system()),
    });
    tokio::spawn(async move {
        if let Err(e) = control::serve(ctl, cancel_rx).await {
            tracing::error!("[control] {e}");
        }
    });
    Ok(())
}

/// What a WebSocket frame handler reaches.
pub(crate) struct FrameCtx {
    pub(crate) client: Arc<CoreClient>,
    pub(crate) runner: Arc<ClaudeCodeRunner>,
    pub(crate) masters: Arc<master::Masters>,
    pub(crate) inflight: Arc<AtomicUsize>,
    pub(crate) cfg: Arc<Config>,
    pub(crate) wake_tx: tokio::sync::mpsc::Sender<master::Wake>,
}

/// Route one frame from core. Nothing here blocks the frame loop.
pub(crate) fn on_frame(frame: Frame, ctx: &FrameCtx) {
    let FrameCtx {
        client,
        runner,
        masters,
        inflight,
        cfg,
        wake_tx,
    } = ctx;
    match frame.event.as_str() {
        "job.cancel" => {
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
            let guard = InflightGuard::enter(inflight);
            tokio::spawn(async move {
                let _guard = guard; // released when the chat turn finishes (drain gate)
                if let Err(e) = chat::handle_start(&client, runner, frame.data).await {
                    tracing::error!("[chat] start: {e}");
                }
            });
        }
        "agent:send" => {
            let (client, runner) = (client.clone(), runner.clone());
            let guard = InflightGuard::enter(inflight);
            tokio::spawn(async move {
                let _guard = guard; // released when the chat turn finishes (drain gate)
                if let Err(e) = chat::handle_send(&client, runner, frame.data).await {
                    tracing::error!("[chat] send: {e}");
                }
            });
        }
        "session.send" => {
            let (client, runner, masters) = (client.clone(), runner.clone(), masters.clone());
            let guard = InflightGuard::enter(inflight);
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
        "skill.sync" | "checkout.head.read" | "provision.request" => {
            on_workspace_frame(frame, client, cfg);
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
        // Core stored the rest of the snapshot; these runs it would not, and says why.
        "runner:sessions.refused" => tracing::warn!(
            "[ledger] core refused runs of this box's snapshot, and keeps their last stored rows: {}",
            frame.data
        ),
        other => tracing::debug!("[ws] ignored event {other}"),
    }
}

/// The frames that read or set up a project's checkout on this box.
fn on_workspace_frame(frame: Frame, client: &Arc<CoreClient>, cfg: &Arc<Config>) {
    match frame.event.as_str() {
        "skill.sync" => {
            let (client, cfg) = (client.clone(), cfg.clone());
            tokio::spawn(async move {
                if let Err(e) = dispatch::handle_skill_sync(&client, &cfg, frame.data).await {
                    tracing::warn!("[skill.sync] {e}");
                }
            });
        }
        "checkout.head.read" => {
            let client = client.clone();
            tokio::spawn(async move { crate::head_read::handle(&client, frame.data).await });
        }
        "provision.request" => {
            // Wake → run the pending-provision sweep (server returns
            // only `queued` rows, so this provisions the requested one).
            let (client, cfg) = (client.clone(), cfg.clone());
            tokio::spawn(async move {
                if let Err(e) = runner_workspace::provision::handle_request(&client, &cfg).await {
                    tracing::warn!("[provision] {e}");
                }
            });
        }
        _ => {}
    }
}

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
fn announce_gate(
    gate: &runner_proto::gate::Condition,
    shouted: &mut Option<runner_proto::gate::Verdict>,
) -> bool {
    let speak =
        gate.verdict == runner_proto::gate::Verdict::FailingOpen && *shouted != Some(gate.verdict);
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

/// One plugin sweep: ask the server which plugins this device's bound projects designate, then
/// reconcile. A server error degrades to local-only config rather than skipping the sweep — the
/// device must keep converging on its own `[plugins]` block when core is unreachable.
async fn sweep_plugins(client: &CoreClient, cfg: &Config) {
    if !cfg.plugins.enabled {
        return;
    }

    let designated = match runner_transport::plugins::list_designated(client).await {
        Ok(list) => list,
        Err(e) => {
            tracing::warn!(
                "[plugins] server designation fetch failed, using local config only: {e}"
            );
            Vec::new()
        }
    };

    let server: Vec<runner_workspace::plugin_sync::PluginTarget> = designated
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
            runner_workspace::plugin_sync::PluginTarget {
                marketplace: d.marketplace.clone(),
                name: d.name.clone(),
                pinned_ref: d.pinned_ref.clone(),
                auto_update: true,
            }
        })
        .collect();

    runner_workspace::plugin_sync::ensure_plugins(&cfg.plugins, &server).await;
}

/// Both heartbeat conditions off the files beside `config.toml`; nothing where
/// there is no such directory to read.
fn heartbeat_conditions(
    config_dir: Option<&std::path::Path>,
    now_ms: i64,
) -> heartbeat::Conditions {
    let Some(dir) = config_dir else {
        return heartbeat::Conditions::default();
    };
    heartbeat::Conditions {
        gate: Some(degraded::report(dir, now_ms).degraded),
        pool: pool_reads::report(dir, now_ms).ok(),
    }
}
