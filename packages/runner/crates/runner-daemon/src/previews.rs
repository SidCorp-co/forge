//! The daemon's part in live previews (REQ-39): it starts `runner_preview` with this box's ledger
//! as the map from run session to worktree, hands it the control frames, and stops its dev servers
//! when the frame loop ends.

use std::sync::Arc;

use runner_transport::CoreClient;
use tokio::sync::{mpsc, watch};

use crate::actors;
use runner_proto::frames::Frame;

/// Hand each control frame to its actor until the socket closes or the daemon is cancelled, then
/// stop the previews' dev servers: they are this daemon's, and nothing else would.
pub(crate) async fn serve_frames(
    ctx: &actors::FrameCtx,
    mut frame_rx: mpsc::Receiver<Frame>,
    mut cancel_rx: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            frame = frame_rx.recv() => {
                let Some(frame) = frame else { break };
                actors::on_frame(frame, ctx);
            }
            _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
        }
    }
    ctx.previews.stop_all().await;
}

/// This box's previews (REQ-39), recording their dev servers beside the ledger so the image after a
/// handover stops the ones this one left.
pub(crate) fn start(
    client: &CoreClient,
    core_url: &str,
    device_token: &str,
    cancel_rx: &watch::Receiver<bool>,
) -> runner_preview::Previews {
    let record = runner_core::ledger::Ledger::default_path()
        .ok()
        .map(|p| p.with_file_name("preview-groups.json"));
    runner_preview::Previews::start(
        client.clone(),
        core_url,
        device_token,
        Arc::new(LedgerWorktrees),
        record,
        cancel_rx.clone(),
    )
}

/// A run's worktree, read from this box's own ledger by the session core names (REQ-39): a run
/// still holding its checkout. A preview frame never carries a path.
struct LedgerWorktrees;

impl runner_preview::Worktrees for LedgerWorktrees {
    fn of_session(&self, session_id: &str) -> Option<std::path::PathBuf> {
        let ledger = runner_core::ledger::Ledger::default_path()
            .and_then(|p| runner_core::ledger::Ledger::open_read_only(&p))
            .ok()?;
        ledger
            .unclosed_runs()
            .ok()?
            .into_iter()
            .find(|r| {
                r.session_id.as_deref() == Some(session_id)
                    && r.worktree_gone_at.is_none()
                    && r.session_terminal_at.is_none()
            })
            .map(|r| r.worktree_path)
    }
}
