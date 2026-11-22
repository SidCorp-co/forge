//! When a job pane has ended, and when this box ends one (ISS-1351).
//!
//! A pane is reported ended only on evidence that holds: tmux reading it gone on two sweeps in a
//! row, and the process it ran no longer running. One reading is not an ending: a daemon that read
//! every job pane gone at its first tick failed the job, and core handed out the next attempt while
//! the first session still pushed its release.
//!
//! The other half is the pane of a job that is over: it is closed once it has gone idle, and a
//! job pane standing on this box that no slot holds is taken back under supervision and named, so
//! panes of ended jobs do not pile up until the box runs out of memory.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use super::*;

/// A pane whose job is over is closed once it has written nothing for this long. An agent at work
/// redraws its pane, so this is an agent waiting at its prompt, with no turn left to cut short.
pub const IDLE_BEFORE_CLOSE: Duration = Duration::from_secs(120);

/// The process a pane runs, as this box read it while tmux held the pane: its pid, and where the
/// platform can say, when it started, so a pid the kernel handed to another process is not it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneProcess {
    pub pid: u32,
    pub start: Option<String>,
}

impl PaneProcess {
    pub fn of(pid: u32) -> Self {
        Self {
            pid,
            start: runner_platform::proc::start_ticks(pid),
        }
    }

    /// Whether this same process still runs.
    pub fn runs(&self) -> bool {
        if !runner_platform::proc::pid_alive(self.pid) {
            return false;
        }
        match &self.start {
            Some(start) => runner_platform::proc::start_ticks(self.pid).as_ref() == Some(start),
            None => true,
        }
    }
}

/// What the sweeps have read of the panes beyond their slots.
#[derive(Debug, Default)]
pub struct PaneReads {
    /// Jobs whose pane tmux read gone, by how many sweeps in a row.
    gone_reads: HashMap<String, u32>,
    /// The process each held job's pane runs.
    processes: HashMap<String, PaneProcess>,
    /// Job panes the last sweep found standing with no slot holding them.
    strays: HashSet<String>,
    /// Jobs that are over whose pane has been told to wait until it idles.
    waiting_idle: HashSet<String>,
}

impl PaneReads {
    pub(crate) fn let_go(&mut self, job_id: &str) {
        self.gone_reads.remove(job_id);
        self.processes.remove(job_id);
        self.waiting_idle.remove(job_id);
    }
}

/// What one sweep read of a held pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneReading {
    Present,
    /// Read gone, without the evidence an ending needs yet: nothing is concluded this sweep.
    Doubted,
    /// Gone on two sweeps in a row, and its process does not run.
    Ended,
}

impl JobPanes {
    fn with_reads<T>(&self, f: impl FnOnce(&mut PaneReads) -> T) -> Option<T> {
        self.reads.lock().ok().map(|mut r| f(&mut r))
    }

    /// The process this box read the job's pane running, where it read one.
    pub fn process_of(&self, job_id: &str) -> Option<PaneProcess> {
        self.with_reads(|r| r.processes.get(job_id).cloned())
            .flatten()
    }
}

/// Read a held pane: present, ended, or read gone without the evidence an ending needs.
pub(crate) async fn read_pane(panes: &dyn Panes, registry: &JobPanes, live: &Live) -> PaneReading {
    let job = live.job_id.as_str();
    if !panes.gone(&live.pane).await {
        let known = registry
            .with_reads(|r| {
                r.gone_reads.remove(job);
                r.processes.contains_key(job)
            })
            .unwrap_or(true);
        if !known {
            if let Some(pid) = panes.pid(&live.pane).await {
                registry.with_reads(|r| r.processes.insert(job.to_string(), PaneProcess::of(pid)));
            }
        }
        return PaneReading::Present;
    }
    let reads = registry
        .with_reads(|r| {
            let n = r.gone_reads.entry(job.to_string()).or_insert(0);
            *n += 1;
            *n
        })
        .unwrap_or(1);
    if reads < 2 {
        tracing::warn!(
            "[pool] job {job}: tmux reads its pane {} gone once — not an ending until the next sweep reads it gone too and its process has ended",
            live.pane
        );
        return PaneReading::Doubted;
    }
    if let Some(process) = registry.process_of(job).filter(PaneProcess::runs) {
        if reads == 2 {
            tracing::warn!(
                "[pool] job {job}: tmux reads its pane {} gone, but the process it ran (pid {}) still runs — the job is not failed while it does",
                live.pane,
                process.pid
            );
        }
        return PaneReading::Doubted;
    }
    PaneReading::Ended
}

/// Close the pane of a job core says is over, once it has gone idle. `true` once the slot is back.
pub(crate) async fn close_over(
    panes: &dyn Panes,
    records: &dyn Records,
    registry: &JobPanes,
    live: &Live,
) -> bool {
    if let Some(idle) = panes.idle_for(&live.pane).await {
        if idle < IDLE_BEFORE_CLOSE {
            let first = registry
                .with_reads(|r| r.waiting_idle.insert(live.job_id.clone()))
                .unwrap_or(false);
            if first {
                tracing::warn!(
                    "[pool] job {} is over, but its pane {} wrote to its terminal {}s ago — it is closed once idle for {}s",
                    live.job_id,
                    live.pane,
                    idle.as_secs(),
                    IDLE_BEFORE_CLOSE.as_secs()
                );
            }
            return false;
        }
    }
    if let Err(e) = panes.kill(&live.pane).await {
        tracing::warn!(
            "[pool] job {} is terminal but {} would not close: {e} — keeping it under supervision, and the next tick closes it",
            live.job_id,
            live.pane
        );
        return false;
    }
    panes.released(&live.pane).await;
    registry.forget(&live.job_id);
    records.forget(&live.job_id).await;
    tracing::info!(
        "[pool] job {} is terminal — {} closed",
        live.job_id,
        live.pane
    );
    true
}

/// Take back under supervision every job pane standing on this box that no slot holds and that the
/// sweep before found the same way, so the next heartbeat closes it once its job is over. A pane
/// is given one sweep first, because a pane being opened stands for a moment before its slot is
/// taken. Answers the panes taken back.
pub(crate) async fn take_back_strays(
    panes: &dyn Panes,
    records: &dyn Records,
    registry: &JobPanes,
) -> Vec<String> {
    let held: HashSet<String> = registry.live().into_iter().map(|l| l.pane).collect();
    let strays: HashSet<String> = panes
        .names()
        .await
        .into_iter()
        .filter(|n| !held.contains(n) && job_id_of(n).is_some())
        .collect();
    let before = registry
        .with_reads(|r| std::mem::replace(&mut r.strays, strays.clone()))
        .unwrap_or_default();
    let mut again: Vec<String> = strays.intersection(&before).cloned().collect();
    if again.is_empty() {
        return again;
    }
    again.sort();
    let recorded = records.all().await;
    for name in &again {
        hold_pane(name, &recorded, records, registry).await;
    }
    registry.with_reads(|r| {
        for name in &again {
            r.strays.remove(name);
        }
    });
    tracing::warn!(
        "[pool] {} job pane(s) stood on this box with no slot holding them: {} — taken back under supervision, and each is closed once its job is over and it is idle",
        again.len(),
        again.join(", ")
    );
    again
}

#[cfg(test)]
#[path = "pane_end_tests.rs"]
mod tests;
