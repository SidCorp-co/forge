use crate::*;

/// Reclaim what runs left in the daemon's scratch root, keeping whatever a live
/// run holds. What it removed is a log line: the heartbeat's disk report has no
/// slot for it.
pub(super) async fn scratch_reap(mut cancel_rx: watch::Receiver<bool>) {
    use runner_workspace::scratch_reap::{reap_scratch, MIN_AGE, SWEEP_PERIOD};
    let root = std::env::temp_dir();
    let mut wait = std::time::Duration::from_secs(120);
    loop {
        tokio::select! {
            _ = tokio::time::sleep(wait) => {
                wait = SWEEP_PERIOD;
                let held_by = runner_core::ledger::Ledger::default_path()
                    .and_then(|p| runner_core::ledger::Ledger::open(&p))
                    .and_then(|l| runner_workspace::worktree_reap::HeldTrees::from_ledger(&l));
                let held_by = match held_by {
                    Ok(h) => h,
                    Err(err) => {
                        tracing::error!(
                            "[scratch-reap] the ledger will not open ({err}) — what a live run holds cannot be told, so nothing under {} is removed this pass",
                            root.display()
                        );
                        continue;
                    }
                };
                let swept = reap_scratch(&root, MIN_AGE, &held_by).await;
                if let Some(why) = &swept.refused {
                    tracing::error!("[scratch-reap] {} not swept: {why}", root.display());
                    continue;
                }
                if !swept.removed.is_empty() {
                    tracing::info!(
                        "[scratch-reap] removed {} scratch tree(s) under {}: {}",
                        swept.removed.len(),
                        root.display(),
                        swept.removed.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
                    );
                }
                for (path, why) in &swept.kept {
                    tracing::warn!("[scratch-reap] kept {}: {why}", path.display());
                }
                tracing::debug!(
                    "[scratch-reap] {} entries under {} are attributed to no run and were left",
                    swept.unattributed,
                    root.display()
                );
            }
            _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
        }
    }
}
