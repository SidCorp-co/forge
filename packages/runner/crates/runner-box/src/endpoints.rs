//! The tunnel's way to a box (`runner_preview::tunnel::BoxEndpoints`): a `view` stream to the box's
//! own loopback screen, an `input` stream to its translator. The box is named by core's frame; the
//! endpoint is this runner's own record of it. An input stream for a box core has not said a person
//! holds (`box.open` or `box.assign` as a person's, or `box.take`) is refused. A browser whose stream port is gone fails the box `STREAM_LOST`,
//! loudly, and closes it.

use std::time::Duration;

use runner_preview::codec::{Channel, ResetCode};
use runner_preview::tunnel::{BoxEndpoints, Connecting};
use serde_json::json;
use tokio::sync::watch;

use crate::mode::ViewFault;
use crate::slots::Boxes;

/// How long an input stream waits for the hold's own frame: core moves the record and writes the
/// frame in one transaction, so a page can connect a moment before the frame lands here.
const HOLD_GRACE: Duration = Duration::from_secs(2);

/// Whether a person holds the box now, or comes to within `grace`.
async fn held_within(held: &mut watch::Receiver<bool>, grace: Duration) -> bool {
    matches!(
        tokio::time::timeout(grace, held.wait_for(|h| *h)).await,
        Ok(Ok(_))
    )
}

impl BoxEndpoints for Boxes {
    fn connect(&self, box_id: &str, channel: Channel) -> Connecting {
        let (this, id) = (self.clone(), box_id.to_string());
        Box::pin(async move {
            let (running, held) = {
                let slots = this.slots();
                let Some(slot) = slots.get(&id) else {
                    return Err(ResetCode::PreviewNotRunning);
                };
                (slot.running.clone(), slot.held.subscribe())
            };
            let Some(running) = running else {
                return Err(ResetCode::PreviewNotRunning);
            };
            match channel {
                Channel::View { fps } => match running.view(&id, fps).await {
                    Ok(conn) => Ok(conn),
                    Err(ViewFault::Lost(detail)) => {
                        tracing::error!("[box] {id}: STREAM_LOST: {detail}");
                        let body = json!({ "kind": "state", "state": "failed", "failure": "STREAM_LOST", "detail": detail });
                        this.report(&id, body).await;
                        let closing = this.clone();
                        tokio::spawn(async move { closing.close(&id).await });
                        Err(ResetCode::ConnectRefused)
                    }
                    Err(f @ ViewFault::Refused(_)) => {
                        if let ViewFault::Refused(why) = &f {
                            tracing::warn!("[box] {id}: a view was refused: {why}");
                        }
                        Err(f.reset())
                    }
                },
                Channel::Input if !held_within(&mut held.clone(), HOLD_GRACE).await => {
                    tracing::warn!(
                        "[box] {id}: an input stream for a box no person holds is refused"
                    );
                    Err(ResetCode::ConnectRefused)
                }
                Channel::Input => running.input(&id, held).await.map_err(|why| {
                    tracing::warn!("[box] {id}: input refused: {why}");
                    ResetCode::ConnectRefused
                }),
            }
        })
    }
}
