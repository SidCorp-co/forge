//! A cancel reaching a pool job's pane (ISS-252).
//!
//! Core settles a cancelled job `cancelled` only when the box it is out on says its process is
//! over, so this closes the pane first, says so second, and gives the slot back last. A cancel
//! arrives two ways — the `job.cancel` frame, and a heartbeat core refuses with
//! `JOB_CANCEL_REQUESTED` — and both come through [`cancel`].

use std::future::Future;
use std::sync::Arc;

use super::*;

/// What a cancel did with a job this box may hold.
#[derive(Debug, PartialEq, Eq)]
pub enum Cancelled {
    /// No pane of this box's runs the job.
    NotHeld,
    /// The pane is closed, core took the kill-ack, and the slot is back.
    Closed,
    /// The pane is closed and core did not take the kill-ack. The slot and the record stay, so the
    /// next supervision tick finds the pane gone and reports it, which settles the job too.
    Unacked(String),
    /// The pane would not close. Neither ack would be true, so none is sent, and the slot stays
    /// for the next heartbeat to ask again.
    WouldNotClose(String),
}

/// The job panes a frame handler reaches: the same registry, records and terminal the supervisor
/// works, so a pane closed here is a slot the next pass can hand out.
#[derive(Clone)]
pub struct PoolPanes {
    pub panes: Arc<dyn Panes>,
    pub records: Arc<dyn Records>,
    pub registry: Arc<JobPanes>,
}

/// Close the pane this box holds for `job_id`, ack the kill, and give its slot back.
pub async fn cancel(
    panes: &dyn Panes,
    report: &dyn Report,
    records: &dyn Records,
    registry: &JobPanes,
    job_id: &str,
) -> Cancelled {
    let Some(held) = registry.live().into_iter().find(|l| l.job_id == job_id) else {
        return Cancelled::NotHeld;
    };
    if let Err(e) = panes.kill(&held.pane).await {
        tracing::warn!(
            "[pool] job {job_id} was cancelled but {} would not close: {e} — no kill-ack is true yet, so none is sent, and the slot stays until it closes",
            held.pane
        );
        return Cancelled::WouldNotClose(e.to_string());
    }
    if let Err(e) = report.kill_ack(job_id, "killed").await {
        tracing::warn!(
            "[pool] job {job_id} was cancelled and {} is closed, but core did not take the kill-ack: {e} — the record stays, and the next tick reports the pane gone",
            held.pane
        );
        return Cancelled::Unacked(e.to_string());
    }
    panes.released(&held.pane).await;
    registry.forget(job_id);
    records.forget(job_id).await;
    tracing::info!("[pool] job {job_id} cancelled — {} closed", held.pane);
    Cancelled::Closed
}

/// The whole answer to a `job.cancel` frame. A pool pane this box holds is closed and acked by
/// [`cancel`]; a job it holds no pane for goes to `elsewhere`, the path that knows CLI children and
/// orphaned pids, and its outcome is acked as that path says.
pub async fn answer_cancel<F, Fut>(
    pool: &PoolPanes,
    report: &dyn Report,
    job_id: &str,
    elsewhere: F,
) where
    F: FnOnce() -> Fut,
    Fut: Future<Output = &'static str>,
{
    let held = cancel(
        pool.panes.as_ref(),
        report,
        pool.records.as_ref(),
        &pool.registry,
        job_id,
    )
    .await;
    if held != Cancelled::NotHeld {
        return;
    }
    let outcome = elsewhere().await;
    if let Err(e) = report.kill_ack(job_id, outcome).await {
        tracing::warn!("[cancel] kill-ack job={job_id}: {e}");
    }
}

#[cfg(test)]
#[path = "cancel_tests.rs"]
mod tests;
