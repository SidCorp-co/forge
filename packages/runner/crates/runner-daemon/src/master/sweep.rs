use super::*;

#[derive(Debug, Clone)]
pub enum Wake {
    /// Core published `master.wake` on this box's device room (ISS-933), for
    /// the reason `source` names (ISS-38).
    Core {
        project_id: Option<String>,
        source: WakeSource,
    },
    /// This box's websocket came back up, so anything published while it was
    /// down is gone — `rooms.ts:publish` has no buffer and no replay.
    Reconnect,
}

impl Wake {
    /// The wake a `master.wake` frame's data is, or why it is refused.
    pub fn of_frame(data: &serde_json::Value) -> Result<Self, String> {
        let source = WakeSource::of_frame(data)?;
        let project_id = data
            .get("projectId")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        Ok(Wake::Core { project_id, source })
    }

    pub(crate) fn describe(&self) -> String {
        match self {
            Wake::Core {
                project_id: Some(p),
                source,
            } => format!("core, {}, project {p}", source.label()),
            Wake::Core {
                project_id: None,
                source,
            } => format!("core, {}", source.label()),
            Wake::Reconnect => "websocket reconnected — catch-up read".into(),
        }
    }
}

/// A sender for [`Wake`], sized so a burst coalesces instead of queueing.
pub fn wake_channel() -> (mpsc::Sender<Wake>, mpsc::Receiver<Wake>) {
    mpsc::channel(1)
}

/// The registries the master loop shares with the rest of the daemon.
pub struct Shared {
    pub masters: Arc<Masters>,
    pub activity: Arc<agent_activity::Activities>,
    pub job_panes: Arc<JobPanes>,
    pub job_records: Arc<dyn Records>,
    pub drain: Arc<crate::drain::Drain>,
}

impl Shared {
    pub(crate) fn borrowed(&self) -> SweepShared<'_> {
        SweepShared {
            masters: &self.masters,
            activity: &self.activity,
            job_panes: &self.job_panes,
            job_records: self.job_records.as_ref(),
            drain: &self.drain,
        }
    }
}

/// [`Shared`] as one sweep reads it.
#[derive(Clone, Copy)]
pub(crate) struct SweepShared<'a> {
    pub(crate) masters: &'a Arc<Masters>,
    pub(crate) activity: &'a agent_activity::Activities,
    pub(crate) job_panes: &'a Arc<JobPanes>,
    pub(crate) job_records: &'a dyn Records,
    pub(crate) drain: &'a crate::drain::Drain,
}

pub async fn run(
    client: CoreClient,
    cfg: Config,
    shared: Shared,
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
    let tokens = session_tokens::default_path().map(session_tokens::SessionTokens::at);
    if tokens.is_none() {
        tracing::error!(
            "[master] the control capability map cannot be resolved on this box — no master pane can be minted a capability, and none will be started"
        );
    }
    let mut passes = tokio::time::interval(master_pass::TICK);
    passes.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let sweep_due = tokio::time::sleep(delay);
    tokio::pin!(sweep_due);
    loop {
        tokio::select! {
            _ = passes.tick() => {
                if let Some(led) = ledger.as_mut() {
                    master_pass::reconcile(&client, &shared.masters, &shared.activity, led, master_pass::this_process(), None).await;
                }
            }
            _ = &mut sweep_due => {
                delay = sweep(&client, &cfg, &shared.borrowed(), &adopted, &mut ledger, tokens.as_ref(), &mut account_limit_said)
                    .await;
                last_sweep = Instant::now();
                sweep_due.as_mut().reset(tokio::time::Instant::now() + delay);
            }
            Some(w) = wake.recv() => {
                let since = last_sweep.elapsed();
                if since < WAKE_FLOOR {
                    tokio::time::sleep(WAKE_FLOOR - since).await;
                }
                tracing::info!("[master] wake ({}) — sweeping now", w.describe());
                delay = sweep(&client, &cfg, &shared.borrowed(), &adopted, &mut ledger, tokens.as_ref(), &mut account_limit_said)
                    .await;
                last_sweep = Instant::now();
                sweep_due.as_mut().reset(tokio::time::Instant::now() + delay);
            }
            _ = cancel.changed() => { if *cancel.borrow() { break; } }
        }
    }
}

/// Whether a runner row's status lets this box take work for its project, and
/// so whether it places a master for it at all.
///
/// Public because `forge-runner master status` answers the same question to an
/// operator, and two copies of this rule is a box that says one thing and does
/// another. `draining` and `disabled` both land here, which is why neither is
/// the control that stops a resident master (ISS-1118).
pub fn accepts_new_work(status: &str) -> bool {
    !matches!(status, "draining" | "disabled")
}

pub(crate) fn next_poll_delay(served: &[runners::MeRunner]) -> Duration {
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

pub(crate) async fn sweep(
    client: &CoreClient,
    cfg: &Config,
    shared: &SweepShared<'_>,
    adopted: &tokio::sync::watch::Receiver<bool>,
    ledger: &mut Option<Ledger>,
    tokens: Option<&session_tokens::SessionTokens>,
    account_limit_said: &mut Option<String>,
) -> Duration {
    let Some(served) = read_served(client, shared.masters).await else {
        return POLL_INTERVAL;
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
    let now_unix = master_limit::now_unix();
    let sw = Sweep {
        client,
        cfg,
        shared,
        adopted,
        tokens,
        served: &served,
        now_unix,
    };
    let mut found = Found::default();
    for runner in &served {
        sweep_project(&sw, ledger, runner, &mut found).await;
    }
    report_deaf_fleet(shared.masters, &found.deaf);
    report_account_limit(
        client,
        &served,
        &found.account_said,
        account_limit_said,
        now_unix,
    )
    .await;
    report_job_capacity(cfg, shared.job_panes, shared.activity);
    settle_runs(client, shared, cfg, &served, ledger).await;
    delay
}

/// The projects core serves this box, with the configs of any it no longer
/// serves removed. `None` where core could not be asked, which is recorded.
async fn read_served(
    client: &CoreClient,
    masters: &Arc<Masters>,
) -> Option<Vec<runners::MeRunner>> {
    let served = match runners::list_me(client).await {
        Ok(rs) => rs,
        Err(e) => {
            tracing::warn!("[master] cannot read this box's projects: {e}");
            masters.note_served(Served::Unreadable(e.to_string()));
            return None;
        }
    };
    masters.note_served(Served::Read(
        served.iter().map(|r| r.project_id.clone()).collect(),
    ));
    match runner_workspace::mcp::config::sweep_orphaned_sessions(
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
            runner_workspace::mcp::config::session_dir().display()
        ),
    }
    Some(served)
}

/// What every sweep owes the runs on this box once its masters are seen to:
/// open and close their records at core, say their choices and held
/// checkouts, and give back the ones no master holds.
async fn settle_runs(
    client: &CoreClient,
    shared: &SweepShared<'_>,
    cfg: &Config,
    served: &[runners::MeRunner],
    ledger: &mut Option<Ledger>,
) {
    let boot = runner_core::inflight::boot_identity().unwrap_or_default();
    let sessions = run_record::CoreSessions(client);
    // The condition the gate is in as this run is told to core, stamped on the
    // run itself. `None` where the box cannot read its own config directory,
    // which records none rather than a gate that was clear.
    let gate = runner_platform::config::config_dir().map(|dir| {
        runner_core::degraded::report(&dir, runner_core::agent_activity::now_ms()).degraded
    });
    let opened = run_record::open_declared_runs(&sessions, ledger, &boot, gate.as_ref()).await;
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
        &PaneMasters {
            masters: shared.masters,
        },
        &Reclaim {
            served,
            cfg,
            procs: &SignalProbe,
            killer: &terminate::SystemProcesses,
            closer: &CoreRunState { client },
        },
        &CoreRunState { client },
        &CoreRunState { client },
        recovery::RunWatch {
            beat: &CoreBeat { client },
            idle: &PaneActivity {
                activity: shared.activity,
            },
        },
        ledger,
    )
    .await;
}

/// What a master's pane is stopped on that only a person answers, from the
/// pane's own drawing first and its hooks second, or `None`.
pub(crate) fn dialog_of(
    on_pane: Option<String>,
    reported: Option<&agent_activity::Activity>,
) -> Option<(String, &'static str)> {
    if let Some(text) = on_pane {
        return Some((text, "pane"));
    }
    reported
        .filter(|a| a.doing() == agent_activity::Doing::AwaitingPermission)
        .map(|_| {
            (
                "a permission prompt its hooks reported".to_string(),
                "hooks",
            )
        })
}

/// Tell core what this project's master pane is stopped on, once per change:
/// a pane frozen at a dialog reads `waiting_person` on `masters/standing` and on
/// the runs it hosts, instead of reaching only this box's log.
pub(crate) async fn report_pane_dialog(
    client: &CoreClient,
    masters: &Arc<Masters>,
    activity: &agent_activity::Activities,
    project_id: &str,
) {
    let Some((session_id, name)) = masters.get(project_id) else {
        return;
    };
    let reported = activity.get(&session_id);
    let dialog = dialog_of(terminal::pane_dialog(&name).await, reported.as_ref());
    let text = dialog.as_ref().map(|(t, _)| t.as_str());
    if !masters.claim_dialog_report(project_id, &session_id, text) {
        return;
    }
    let sent = master_api::report_dialog(
        client,
        &session_id,
        dialog.as_ref().map(|(t, src)| (t.as_str(), *src)),
    )
    .await;
    match (sent, text) {
        (Ok(()), Some(text)) => tracing::warn!(
            "[master] {project_id}: {name} is stopped on a dialog only a person answers ({text}); core now reads it waiting on a person"
        ),
        (Ok(()), None) => {}
        (Err(e), _) => {
            masters.forget_dialog_report(project_id);
            tracing::warn!(
                "[master] {project_id}: could not tell core what {name}'s pane is stopped on: {e} — the next sweep sends it again"
            );
        }
    }
}
