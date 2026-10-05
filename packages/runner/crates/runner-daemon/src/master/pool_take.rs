//! Taking this box's pool jobs, and saying when its slots are full.

use super::*;

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

/// Take one pool job for `runner`'s project under the master session core
/// issued this box for it, answering whether a job waits for that session.
pub(crate) async fn take_pool_job(
    client: &CoreClient,
    cfg: &Config,
    shared: &SweepShared<'_>,
    adopted: &tokio::sync::watch::Receiver<bool>,
    tokens: Option<&session_tokens::SessionTokens>,
    runner: &runners::MeRunner,
) -> bool {
    let SweepShared {
        masters,
        job_panes,
        job_records,
        ..
    } = *shared;
    if !*adopted.borrow() {
        return false;
    }
    let master_session = masters.get(&runner.project_id).map(|(session, _)| session);
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
        master_session.as_deref(),
        bound,
        tokens,
    )
    .await;
    // What this pass learned about the read itself, on disk where `status`, the
    // heartbeat and a restart all find it (ISS-1234).
    if let Some(dir) = runner_platform::config::config_dir() {
        pool_reads::note(&dir, &runner.project_id, &took, agent_activity::now_ms());
    }
    match (&took, master_session.as_deref()) {
        (pool_jobs::Took::NoMasterSession(job), _) => {
            if job_panes.note_master_session(&runner.project_id, false) {
                tracing::warn!(
                    "[pool] {}: job {job} waits and no master session is registered with core for project {} on this box — core holds a pool job only under that session, so none is taken until the project's master is placed",
                    runner.slug,
                    runner.project_id
                );
            }
            return true;
        }
        (_, Some(session)) if job_panes.note_master_session(&runner.project_id, true) => {
            tracing::info!(
                "[pool] {}: master session {session} registered — pool jobs are taken under it",
                runner.slug
            );
        }
        _ => {}
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
    false
}
