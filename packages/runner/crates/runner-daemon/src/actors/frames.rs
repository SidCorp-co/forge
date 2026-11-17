//! Routing what core sends this box over its WebSocket: each frame goes to the component that
//! handles it, off the frame loop.

use crate::*;

/// What a WebSocket frame handler reaches.
pub(crate) struct FrameCtx {
    pub(crate) client: Arc<CoreClient>,
    pub(crate) runner: Arc<ClaudeCodeRunner>,
    pub(crate) masters: Arc<master::Masters>,
    pub(crate) inflight: Arc<AtomicUsize>,
    pub(crate) cfg: Arc<Config>,
    pub(crate) wake_tx: tokio::sync::mpsc::Sender<master::Wake>,
    /// The job panes the supervisor works, which a `job.cancel` closes first (ISS-252).
    pub(crate) pool: pool_jobs::PoolPanes,
    /// The live previews this box serves (REQ-39).
    pub(crate) previews: runner_preview::Previews,
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
        pool,
        previews,
    } = ctx;
    match frame.event.as_str() {
        "job.cancel" => {
            if let Some(jid) = job_id_of(&frame.data) {
                tracing::info!("[cancel] job={jid}");
                // ISS-785 — core's kill-before-reap gate waits on this ack
                // (or a runner_gone/terminal-report fallback) before it
                // allows a retry, and a person's cancel settles on it
                // (ISS-252); report the real outcome instead of silently
                // discarding it, but never block the frame loop on the ack
                // POST. A pool pane is this box's to close first: neither
                // the CLI abort nor the orphan reap can see one.
                let (client, runner, pool) = (client.clone(), runner.clone(), pool.clone());
                tokio::spawn(async move {
                    let report = pool_jobs::CoreReport { client: &client };
                    pool_jobs::answer_cancel(&pool, &report, &jid, || async {
                        match runner.abort(&jid).await {
                            Ok(_) => {
                                inflight::forget(&jid);
                                "killed"
                            }
                            Err(_) => inflight::reap_orphan(&jid).await.wire(),
                        }
                    })
                    .await;
                });
            }
        }
        "agent:start" | "agent:send" => {
            let (client, runner) = (client.clone(), runner.clone());
            let guard = InflightGuard::enter(inflight);
            // held from here, in the order core sent its frames, so an inbox write that follows
            // this turn waits for it rather than reaching the resident it may close
            let placing = session_id_of(&frame.data).map(|sid| runner.place_turn(&sid));
            let start = frame.event == "agent:start";
            tokio::spawn(async move {
                let _guard = guard; // released when the chat turn finishes (drain gate)
                let ran = if start {
                    chat::handle_start(&client, runner, frame.data, placing).await
                } else {
                    chat::handle_send(&client, runner, frame.data, placing).await
                };
                if let Err(e) = ran {
                    let which = if start { "start" } else { "send" };
                    tracing::error!("[chat] {which}: {e}");
                }
            });
        }
        "session.send" => {
            let (client, runner, masters, pool) =
                (client.clone(), runner.clone(), masters.clone(), pool.clone());
            let guard = InflightGuard::enter(inflight);
            tokio::spawn(async move {
                let _guard = guard;
                inbox::handle_session_send(&client, runner, masters, &pool, frame.data).await;
            });
        }
        "agent:close" | "agent:interrupt" | "agent:steer" => on_chat_control(frame, client, runner),
        event if box_frames::takes(event) => box_frames::on_frame(frame, client, cfg),
        event if runner_preview::FRAMES.contains(&event) => previews.on_frame(event, frame.data),
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

/// A chat session's control frame: core ended its residency, a person stopped its running turn, or
/// a message goes into that turn (ISS-1268).
fn on_chat_control(frame: Frame, client: &Arc<CoreClient>, runner: &Arc<ClaudeCodeRunner>) {
    match frame.event.as_str() {
        "agent:close" => match session_id_of(&frame.data) {
            Some(sid) => {
                let (client, runner) = (client.clone(), runner.clone());
                tokio::spawn(async move { chat::handle_close(&client, runner, &sid).await });
            }
            None => tracing::warn!(
                "[chat] agent:close names no sessionId, so no session is closed (frame: {})",
                frame.data
            ),
        },
        "agent:interrupt" => match session_id_of(&frame.data) {
            Some(sid) => {
                tracing::info!("[chat] interrupt session={sid}");
                let runner = runner.clone();
                tokio::spawn(async move { chat::handle_interrupt(runner, &sid).await });
            }
            None => tracing::warn!(
                "[chat] agent:interrupt names no sessionId, so no turn is stopped (frame: {})",
                frame.data
            ),
        },
        "agent:steer" => {
            let runner = runner.clone();
            tokio::spawn(async move { chat::handle_steer(runner, frame.data).await });
        }
        other => tracing::debug!("[ws] {other} is not a chat control frame"),
    }
}
