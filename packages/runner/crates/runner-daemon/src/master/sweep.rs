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

#[expect(
    clippy::too_many_lines,
    reason = "the master sweep, whose verdicts core should take (ADR 0009 moveToCore); deleted rather than split once core owns them (ISS-218 amnesty)"
)]
pub(crate) async fn sweep(
    client: &CoreClient,
    cfg: &Config,
    shared: &SweepShared<'_>,
    adopted: &tokio::sync::watch::Receiver<bool>,
    ledger: &mut Option<Ledger>,
    tokens: Option<&session_tokens::SessionTokens>,
    account_limit_said: &mut Option<String>,
) -> Duration {
    let SweepShared {
        masters,
        activity,
        job_panes,
        drain,
        ..
    } = *shared;
    let now_unix = master_limit::now_unix();
    let mut account_said: Vec<master_limit::Decisive> = Vec::new();
    let mut deaf_found: Vec<Deaf> = Vec::new();
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
        // Leave is taken per project and held to the end of its iteration, so
        // a drain that begins part-way through a sweep waits for the project
        // in hand to finish admitting and stops the sweep at the next one.
        let _admitting = match drain.admit() {
            Ok(permit) => permit,
            Err(closed) => {
                let read = read_standing(ledger.as_ref(), &runner.project_id);
                let verdict =
                    standing_verdict(masters, read, &runner.project_id, &runner.slug).await;
                if matches!(verdict, Some((Placed::Proceed | Placed::Withheld, _))) {
                    masters.note_unplaced(
                        &runner.project_id,
                        Unplaced::Restarting {
                            cause: closed.cause,
                        },
                    );
                }
                supervise(client, masters, tokens, &runner.project_id, &runner.slug).await;
                continue;
            }
        };
        if !accepts_new_work(&runner.status) {
            tracing::info!(
                "[master] {}: runner is {} — taking no new work; anything already running finishes",
                runner.slug,
                runner.status
            );
            // A box taking no work still meets the contradiction, and the
            // louder reason wins the one slot this project has: `draining`
            // explains an absent pane, never a pane that is up and never a
            // standing this box could not read. Overwriting either would hide
            // it AND make every unchanged sweep look like a change, which is
            // the repetition `note_unplaced` exists to stop.
            let read = read_standing(ledger.as_ref(), &runner.project_id);
            let verdict = standing_verdict(masters, read, &runner.project_id, &runner.slug).await;
            if matches!(verdict, Some((Placed::Proceed | Placed::Withheld, _))) {
                masters.note_unplaced(
                    &runner.project_id,
                    Unplaced::Draining {
                        status: runner.status.clone(),
                    },
                );
            }
            supervise(client, masters, tokens, &runner.project_id, &runner.slug).await;
            continue;
        }
        supervise(client, masters, tokens, &runner.project_id, &runner.slug).await;
        take_pool_job(client, cfg, shared, adopted, tokens, runner).await;

        // The owner's veto, read off the ledger this sweep already holds and
        // decided before anything is asked of core. A stand-down governs the
        // resident master and nothing else, which is why it sits AFTER
        // `take_pool_job`: the box goes on taking pool jobs for a project whose
        // master is stood down (ISS-1118).
        let read = read_standing(ledger.as_ref(), &runner.project_id);
        let Some((placed, standing)) =
            standing_verdict(masters, read, &runner.project_id, &runner.slug).await
        else {
            continue;
        };
        match placed {
            Placed::Proceed => {}
            Placed::Withheld => {
                say_unplaced(
                    masters,
                    &runner.project_id,
                    &runner.slug,
                    stood_down_reason(standing.as_ref(), &runner.slug, None),
                );
                continue;
            }
            Placed::Contradicted => continue,
        }
        let pane_name = terminal::session_name(terminal::MASTER_PREFIX, &runner.slug);
        let lifted_episode = standing.as_ref().and_then(lifted_from);

        let admissible = admissible::admissible(client, Some(&runner.project_id))
            .await
            .unwrap_or_default();
        let inbox = read_inbox(client, masters, &runner.project_id, &runner.slug).await;
        let placement = placement_for(&admissible, &inbox);
        if placement == Placement::AdoptOnly {
            if retire_if_idle(
                client,
                masters,
                activity,
                ledger,
                tokens,
                &runner.project_id,
                &runner.slug,
            )
            .await
            {
                continue;
            }
        } else {
            masters.note_work(&runner.project_id);
        }

        let resolved = match resolve_repo(&served, cfg, &runner.project_id) {
            Ok(r) => r,
            Err(slug) => {
                if !admissible.is_empty() || !inbox.is_empty() {
                    tracing::error!(
                        "[master] {slug} has claimable work but no repo path on this box — no master will run for it; bind it or set the runner's repo_path"
                    );
                }
                say_unplaced(masters, &runner.project_id, &slug, Unplaced::NoRepoPath);
                continue;
            }
        };

        // A pane an update left on the build it was placed under is judged
        // before the placement below, so one that may be replaced is ended in
        // time for this same sweep to place its successor (ISS-1379).
        let outdated_left = outdated_resident(
            client,
            masters,
            ledger,
            tokens,
            activity,
            &pane_name,
            &resolved,
            &runner.project_id,
            placement,
        )
        .await;

        let stored_conversation = ledger
            .as_ref()
            .and_then(|led| led.master_for_project(&runner.project_id).ok().flatten())
            .and_then(|row| row.conversation_id);
        // Read by project and boot, not off the session this process last
        // registered: a pane placed again is given a new master session, and a
        // run declared under the one it replaced was otherwise listed by
        // nobody after a restart and answerable by nobody after a resume
        // (ISS-1312).
        let inherited: Vec<InheritedRun> = ledger
            .as_ref()
            .and_then(|led| {
                let boot = inheritance_boot(
                    runner_core::inflight::boot_identity(),
                    led,
                    &runner.project_id,
                    &runner.slug,
                )?;
                Some(inherited_runs(led, &runner.project_id, &boot))
            })
            .unwrap_or_default();
        let told = std::sync::atomic::AtomicBool::new(false);
        let started = std::sync::atomic::AtomicBool::new(false);
        let authority = AuthoritySink::default();
        let deaf = DeafSink::default();
        let hosts = subagent_host::ProcHosts::system();
        let pane = ensure_master(
            client,
            masters,
            &runner.project_id,
            &resolved,
            &Carryover {
                conversation: stored_conversation.as_deref(),
                inherited: &inherited,
                lifted: lifted_episode.as_ref(),
                stood_down_told: &told,
                started: &started,
                hosts: &hosts,
                slots: cfg.runner.max_job_panes.max(1),
            },
            placement,
            &CapabilityPorts {
                tokens,
                authority: &authority,
                deaf: &deaf,
            },
        )
        .await;
        // Written before the `Absent` gate below, because a verdict reached and
        // dropped is the defect this issue was reopened for: the sweep that
        // learns a pane is refused is the only one that knows it.
        let heard = match authority.take() {
            Some(said) => {
                write_authority(ledger.as_ref(), &runner.project_id, &resolved.slug, &said);
                said.verdict == MasterAuthority::CURRENT
            }
            None => false,
        };
        // Gathered here rather than reported here: one project's deaf pane is a
        // line, and a box whose whole fleet went deaf at once is a condition
        // nobody reads four quarters of (ISS-1208).
        if let Some(found) = deaf.take() {
            deaf_found.push(found);
        }
        if let (true, Some((successor, name))) = (
            pane == PaneState::Adopted && heard,
            masters.get(&runner.project_id),
        ) {
            let pane_pid = terminal::pane_pid(&name).await;
            if let Some(led) = ledger.as_mut() {
                carry_and_record(
                    led,
                    &runner.project_id,
                    &name,
                    &successor,
                    pane_pid,
                    &hosts,
                    &resolved.slug,
                );
            }
        }
        let placed = started.load(std::sync::atomic::Ordering::Relaxed)
            && matches!(pane, PaneState::ColdStarted | PaneState::Resumed);
        if placed {
            if let Some(led) = ledger.as_ref() {
                note_placement(led, &runner.project_id, &pane_name, &resolved);
            }
            if let (Some(led), Some((successor, _))) =
                (ledger.as_mut(), masters.get(&runner.project_id))
            {
                placed_again(
                    led,
                    &inherited,
                    &successor,
                    pane == PaneState::Resumed,
                    agent_activity::now_ms(),
                    &resolved.slug,
                    &hosts,
                );
            }
        }
        if pane == PaneState::Absent {
            continue;
        }
        if told.load(std::sync::atomic::Ordering::Relaxed) {
            let stamped = ledger.as_ref().zip(lifted_episode.as_ref());
            if let Some((led, lifted)) = stamped {
                if let Err(e) = led.note_standing_told(&runner.project_id, lifted.episode) {
                    tracing::warn!(
                        "[master] {}: cannot mark the lifted stand-down a pane has now been told about: {e} — the next pane placed will be told the same interval again",
                        resolved.slug
                    );
                }
            }
        }
        // A stand-down can be written while this sweep is starting a pane. The
        // owner's act was already on the record when the placement finished, so
        // this sweep withdraws the pane IT placed rather than leaving one
        // running until the next pass. A pane it merely adopted is not ended
        // here: that one is somebody else's and ISS-933 took this daemon out of
        // the business of killing panes it did not start. The single condition
        // under which it does end an adopted pane is in the adopt branch of
        // `ensure_master` — a capability this box can prove it never minted,
        // which no later sweep can repair.
        let mut standing_unknown = false;
        if matches!(pane, PaneState::ColdStarted | PaneState::Resumed) {
            // An unreadable standing withholds a placement but never withdraws
            // one: withholding places nothing, and withdrawing ends a pane
            // nobody may have stood down. The next sweep meets the same
            // unreadable ledger at the gate above and withholds there. What it
            // does forfeit is the nudge, below — driving a pane while unable to
            // say whether the project is stood down is the fail-open this whole
            // read exists to close, one step later.
            let since = match read_standing(ledger.as_ref(), &runner.project_id) {
                StandingRead::Known(s) => s,
                StandingRead::Unreadable(detail) => {
                    tracing::error!(
                        "[master] {}: {pane_name} was just placed and this box cannot read back whether its owner stood the project down ({detail}). It is NOT being withdrawn — ending a pane on an unreadable record would take work nobody decided to end — and it is NOT being nudged either. If it was stood down, `forge-runner master kill {}` — a bare `tmux kill-session` typed in your own shell reaches a different tmux server than the one masters run on.",
                        runner.slug,
                        runner.slug
                    );
                    standing_unknown = true;
                    None
                }
            };
            if since.as_ref().is_some_and(MasterStanding::stands) {
                tracing::error!(
                    "[master] {}: {pane_name} was stood down while this sweep was starting it — withdrawing the pane this sweep placed. `forge-runner master stand-up {}` puts the project back under this box's authority.",
                    resolved.slug,
                    resolved.slug
                );
                // A withdrawal that failed leaves the pane up, so the reason
                // recorded against the project has to be the one that says a
                // pane is running — not the one that says none was placed.
                let mut left_running = None;
                if let Err(e) = terminal::kill(&pane_name).await {
                    tracing::error!(
                        "[master] {}: could not withdraw {pane_name}: {e} — it is running against a stand-down and `forge-runner master kill {}` is what ends it, a bare `tmux kill-session` in your own shell reaching a different tmux server than the one masters run on",
                        resolved.slug,
                        resolved.slug
                    );
                    left_running = Some(pane_name.clone());
                }
                if let Some((session_id, _)) = masters.get(&runner.project_id) {
                    end_master(
                        client,
                        masters,
                        tokens,
                        &runner.project_id,
                        &session_id,
                        "stood down while this sweep was placing it",
                    )
                    .await;
                }
                say_unplaced(
                    masters,
                    &runner.project_id,
                    &resolved.slug,
                    stood_down_reason(since.as_ref(), &resolved.slug, left_running.as_deref()),
                );
                continue;
            }
        }
        let last_said = account_record(
            &resolved.repo_path,
            stored_conversation.as_deref(),
            now_unix,
        );
        if let Some(said) = last_said
            .as_ref()
            .filter(|d| master_limit::is_fresh(d, now_unix))
        {
            account_said.push(said.clone());
        }
        if pane == PaneState::Resumed {
            let pane_boot = runner_core::inflight::boot_identity().unwrap_or_default();
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

        let reported = masters
            .get(&runner.project_id)
            .and_then(|(session_id, _)| activity.get(&session_id));
        let held = held_by_limit(
            last_said.as_ref(),
            stored_conversation.as_deref(),
            reported.as_ref(),
        );

        if !asked_this_sweep(&admissible, &inbox, held.as_ref()) {
            continue;
        }

        if pane == PaneState::StaleCapability {
            continue;
        }

        if standing_unknown {
            continue;
        }

        // An outdated pane left running is not driven: the work it would take
        // up waits for the successor placed once it holds nothing (ISS-1379).
        if outdated_left && pane == PaneState::Adopted {
            continue;
        }

        let digest = work_digest(&admissible).wrapping_add(master_inbox::inbox_digest(&inbox));
        let pass = NudgePass {
            client,
            shared: *shared,
            project_id: &runner.project_id,
            issue_key: master_pass::nudged_issue(&admissible, inbox.is_empty()),
        };
        let claimed = masters.claim_nudge(
            &runner.project_id,
            digest,
            reported.as_ref(),
            held.is_some(),
        );
        if claimed {
            pass.open(ledger).await;
        }
        if types_nudge(pane, claimed) {
            let slug = &resolved.slug;
            nudge_master(masters, &runner.project_id, slug, held.as_ref(), &inbox).await;
        }
    }

    report_deaf_fleet(masters, &deaf_found);
    report_account_limit(client, &served, &account_said, account_limit_said, now_unix).await;
    report_job_capacity(cfg, job_panes, activity);

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

/// Say, once, that this box can take no more work — and once again when it can.
///
/// Measured sid-xeon-1 2026-09-23: two finished job panes held both slots and
/// the daemon refused all eight bound projects 48 times in two minutes, one
/// `info!` at a time, each naming only the project it had just refused. Nothing
/// anywhere said the box as a whole had stopped, what was holding it, or
/// whether the sweep that returns a slot was still running — so the condition
/// was legible only to somebody who already suspected it.
///
/// The sweep's own last run is in the line because the slot comes back on that
/// sweep and nowhere else: a reader meeting this needs to know whether the
/// panes are working or the supervisor is not.
pub(crate) fn report_job_capacity(
    cfg: &Config,
    job_panes: &Arc<JobPanes>,
    activity: &agent_activity::Activities,
) {
    let bound = cfg.runner.max_job_panes.max(1) as usize;
    let holding = job_panes.holding();
    if holding.len() < bound {
        if job_panes.said_at_bound(None).is_some() {
            tracing::warn!(
                "[master] this box is under its job-pane ceiling again ({} of {bound} held) — the pool is claimable",
                holding.len()
            );
        }
        return;
    }
    let mark = holding
        .iter()
        .map(|h| h.job_id.as_str())
        .collect::<Vec<_>>()
        .join(",");
    if job_panes.said_at_bound(Some(mark.clone())).as_deref() == Some(mark.as_str()) {
        return;
    }
    let now = agent_activity::now_ms();
    let who = holding
        .iter()
        .map(|h| {
            // The same precedence the sweep itself reads on: what this daemon
            // has heard, and otherwise what the last one recorded.
            let said = h.watch.session_id().and_then(|s| activity.get(s));
            let seen = said.as_ref().map(job_exit::Reported::of).or(h.seen);
            let written_at = pool_jobs::written_at(said.as_ref(), h.transcript.as_deref());
            // A pane the next sweep is about to let go for having said nothing
            // at all must not read here as one merely waiting to be heard from:
            // that is the second answer to one question this line exists to
            // avoid giving.
            let phrase = match job_unheard::verdict(seen, h.noted_at, now) {
                job_unheard::Verdict::Unheard { .. } => job_unheard::HOLDING_PHRASE,
                job_unheard::Verdict::Keep => {
                    job_exit::holding_phrase(&h.watch, seen, written_at, now)
                }
            };
            // How long the slot has been held, from the pane's opening on its
            // record. A record with none was written by an older daemon, and
            // all this one can say is that the pane is older than its adoption.
            let held_for = match h.opened_at {
                Some(at) => job_exit::minutes(now.saturating_sub(at)),
                None => format!(
                    "at least {}",
                    job_exit::minutes(now.saturating_sub(h.noted_at))
                ),
            };
            format!("{} in {} for {held_for}, {}", h.job_id, h.pane, phrase)
        })
        .collect::<Vec<_>>()
        .join("; ");
    let swept = match job_panes.last_swept() {
        Some(at) => format!("{}s ago", now.saturating_sub(at) / 1000),
        None => "never since this daemon started".to_string(),
    };
    tracing::warn!(
        "[master] every project bound to this box is being refused the pool: all {bound} job slot(s) are held (max_job_panes = {bound}) — {who}. The job supervisor last swept {swept}."
    );
}

pub(crate) async fn take_pool_job(
    client: &CoreClient,
    cfg: &Config,
    shared: &SweepShared<'_>,
    adopted: &tokio::sync::watch::Receiver<bool>,
    tokens: Option<&session_tokens::SessionTokens>,
    runner: &runners::MeRunner,
) {
    let SweepShared {
        job_panes,
        job_records,
        ..
    } = *shared;
    if !*adopted.borrow() {
        return;
    }
    let bound = cfg.runner.max_job_panes.max(1) as usize;
    let took = pool_jobs::take_one(
        &pool_jobs::JobPorts {
            pool: &pool_jobs::CorePool {
                client,
                limit: 20,
                deadline: runner_transport::pool::CALL_DEADLINE,
            },
            panes: &pool_jobs::TmuxPanes,
            report: &pool_jobs::CoreReport { client },
            records: job_records,
        },
        job_panes,
        pool_jobs::ServedProject {
            id: &runner.project_id,
            slug: &runner.slug,
        },
        job_panes.session_id(),
        bound,
        tokens,
    )
    .await;
    // What this pass learned about the read itself, on disk where `status`, the
    // heartbeat and a restart all find it (ISS-1234).
    if let Some(dir) = runner_platform::config::config_dir() {
        pool_reads::note(&dir, &runner.project_id, &took, agent_activity::now_ms());
    }
    if let pool_jobs::Took::AtBound = took {
        // Per project and per pass, which is eight projects times six passes a
        // minute on the box this was measured on. What an operator reads is
        // `report_job_capacity`, once on the edge, for the box as a whole.
        tracing::debug!(
            "[master] {}: {} job pane(s) already open on this box (max_job_panes = {bound}) — taking no more this pass",
            runner.slug,
            job_panes.count()
        );
    }
}
