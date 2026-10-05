use super::*;
pub(crate) use runner_platform::clock::now_secs;

pub(crate) struct Reclaim<'a> {
    pub(crate) served: &'a [runners::MeRunner],
    pub(crate) cfg: &'a Config,
    pub(crate) procs: &'a dyn recovery::ProcessLiveness,
    pub(crate) killer: &'a dyn terminate::ProcessGroup,
    pub(crate) closer: &'a dyn close_loop::RunCloser,
}

/// The same binding the release resolves, handed to the sweep that runs before
/// it: the close loop's worktree mark is a question about a repository's
/// registry, and this is where that repository is (ISS-1193).
impl recovery::RepoRoots for Reclaim<'_> {
    fn root_for(&self, project_id: &str) -> Option<std::path::PathBuf> {
        resolve_repo(self.served, self.cfg, project_id)
            .ok()
            .map(|r| r.repo_path)
    }
}

pub(crate) async fn release_held_tree(
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
    match terminate::release(
        led,
        &r.run_id,
        terminate::Forcing {
            this_boot: boot_id,
            repo_root: &resolved.repo_path,
            base_branch: resolved.base_branch.as_deref(),
            by: "recovery",
            reason: r.release_reason(),
        },
        terminate::Ports {
            procs: world.killer,
            sessions,
            leases,
        },
        now_secs(),
    )
    .await
    {
        Ok(terminate::Release::Done(forced)) => {
            tracing::info!(
                "[master] run {} reclaimed by {:?}: diff {:?}, checkout {:?}, commits {:?}, close {:?}",
                r.run_id,
                forced.verb,
                forced.salvage.as_ref().map(|s| s.outcome),
                forced.worktree,
                forced.commits,
                forced.close
            );
            forced.close.is_closed()
        }
        // Said once at the head of the window and then left alone: the
        // sweep runs every twenty seconds, and a line per sweep is how a
        // refusal that mattered got lost among nine hundred that did not.
        Ok(terminate::Release::Refusing { why, first }) => {
            if first {
                tracing::warn!(
                    "[master] run {} could not be released: {why} — trying again each sweep for the next {}s",
                    r.run_id,
                    terminate::RELEASE_GRACE_SECS
                );
            }
            false
        }
        Ok(terminate::Release::Terminal { why, after, close }) => {
            tracing::error!(
                "[master] run {} will not be released and is over: {why}. {} — so it is not one a \
                 retry gets past. Its leases are back ({}/{}) and its checkout is still on disk, \
                 which nothing on this box will remove. Fix what the refusal names and run \
                 `forge-runner run release {}` to have the next sweep try again.",
                r.run_id,
                match after {
                    terminate::Decided::ByTheWindow { standing_secs } =>
                        format!("It stood for {standing_secs}s of retrying"),
                    terminate::Decided::ByTheAttempts { attempts } => format!(
                        "It was taken {attempts} times, and this box's clock never let the \
                         window it should have ended in arrive"
                    ),
                },
                close.leases_returned,
                close.leases_total,
                r.run_id
            );
            // Not `is_closed()`: the checkout is still there by decision, so
            // the run is over without that mark and the caller must not read
            // this as a close.
            true
        }
        Err(e) => {
            tracing::warn!("[master] run {} could not be released: {e}", r.run_id);
            false
        }
    }
}

pub(crate) async fn report_run_death(
    run: Option<Run>,
    r: &recovery::Recovered,
    world: &Reclaim<'_>,
) {
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

pub(crate) struct PaneActivity<'a> {
    pub(crate) activity: &'a agent_activity::Activities,
}

#[async_trait::async_trait]
impl recovery::RunActivity for PaneActivity<'_> {
    async fn reported(&self, session_id: &str) -> Option<run_exit::Reported> {
        let a = self.activity.get(session_id)?;
        Some(run_exit::Reported {
            doing: a.doing(),
            at: a.last_event_at,
            written_at: pool_jobs::written_at(Some(&a), None),
        })
    }
}

pub(crate) async fn end_run(
    led: &mut Ledger,
    run_id: &str,
    cause: run_exit::ExitCause,
    world: &Reclaim<'_>,
) {
    let Ok(Some(run)) = led.run(run_id) else {
        return;
    };
    let Some(pid) = run.pid else {
        return;
    };
    world.killer.kill(pid).await;
    let why = cause.reason();
    tracing::info!(
        "[master] run {run_id}: {why} — ending pid {pid}; its close loop starts on the next sweep"
    );
    let Some(session_id) = run.session_id.as_deref() else {
        return;
    };
    if let Err(e) = world
        .closer
        .close(
            session_id,
            close_loop::Outcome::KilledIdle,
            &why,
            Some(checkpoint::reconstruct_within_budget(&run).await.to_json()),
        )
        .await
    {
        tracing::warn!(
            "[master] run {run_id} was ended but core was not told why ({e}) — its session falls to the ten-minute sweep"
        );
    }
}

pub(crate) async fn give_back_lost_runs(
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
    let closing = recovery::Closing {
        sessions,
        leases,
        roots: world,
    };
    match recovery::reconcile(led, boot_id, live, world.procs, closing, watch).await {
        Ok(done) => {
            for r in done {
                if let Some(cause) = r.owed_exit {
                    end_run(led, &r.run_id, cause, world).await;
                    continue;
                }
                if r.owed_death_report {
                    report_run_death(led.run(&r.run_id).ok().flatten(), &r, world).await;
                }
                // A release owed and not finished has already said why: its
                // refusal at the head of its window, its decision at the end,
                // or the binding it could not resolve. Recovery has said once
                // why any other standing run stands. A line per sweep beside
                // either only repeats it (ISS-1220).
                if r.owed_release {
                    release_held_tree(led, &r, boot_id, world, sessions, leases).await;
                    continue;
                }
                if r.state.is_closed() || r.standing_said {
                    continue;
                }
                tracing::warn!(
                    "[master] run {} is partially closed: session_terminal={} checkout_returned={} leases={}/{}",
                    r.run_id,
                    r.state.session_terminal,
                    r.state.checkout_returned,
                    r.state.leases_returned,
                    r.state.leases_total
                );
            }
        }
        Err(e) => tracing::warn!("[master] reconcile failed: {e}"),
    }
}
