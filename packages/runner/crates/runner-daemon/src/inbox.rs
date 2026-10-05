//! RFC 0003 — `session.send`: the one message vocabulary a live session takes.
//!
//! Five kinds, one arm. `work`, `answer` and `inject` are the same act with
//! different provenance — text becomes the session's next turn. `checkpoint`
//! asks the agent to write down where it is before anything ends it, and
//! `cancel` ends the session between turns by EOF rather than by signal.
//!
//! What the runner reports back is deliberately narrow: `delivered` or `gone`,
//! and SILENCE for anything it cannot honestly claim. Core reads silence as
//! `unknown`, the one outcome no caller may act on, so a message the runner is
//! unsure of waits instead of being replaced.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::master::Masters;
use runner_agent::claude_code::ClaudeCodeRunner;
use runner_transport::inbox::{self, Ack};
use runner_transport::CoreClient;
use runner_workspace::terminal;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendFrame {
    session_id: String,
    seq: u64,
    kind: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    deadline_ms: Option<u64>,
    #[serde(default)]
    job_id: Option<String>,
}

const DEFAULT_WRITE_MS: u64 = 8_000;

fn write_deadline(frame_ms: Option<u64>) -> std::time::Duration {
    let ms = frame_ms.map_or(DEFAULT_WRITE_MS, |d| (d * 4 / 5).max(1_000));
    std::time::Duration::from_millis(ms)
}

pub async fn handle_session_send(
    client: &CoreClient,
    runner: Arc<ClaudeCodeRunner>,
    masters: Arc<Masters>,
    data: Value,
) {
    let frame: SendFrame = match serde_json::from_value(data) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("[inbox] undecodable session.send: {e}");
            return;
        }
    };
    let key = frame
        .job_id
        .clone()
        .unwrap_or_else(|| frame.session_id.clone());
    let seq = frame.seq;
    let sid = frame.session_id.clone();

    match frame.kind.as_str() {
        "cancel" => {
            if let Some(pane) = masters.pane_for_session(&sid) {
                // Said rather than swallowed. `terminal::kill` answers for the
                // session being gone (ISS-1208), and `Ack` has only
                // `delivered` and `gone` — neither of which is true of a pane
                // that is still running — so core is told `gone` and the box
                // says here that it is not. A third ack kind is core's half and
                // is not this daemon's to invent.
                if let Err(e) = terminal::kill(&pane).await {
                    tracing::error!(
                        "[inbox] cancel for session {sid}: {pane} would not end ({e}) — core is being told `gone` because the ack has no other answer, and that pane is still running whatever it was running. `forge-runner master kill` on its project is what ends it"
                    );
                }
            } else {
                runner.close(&key).await;
            }
            inbox::ack(client, &sid, seq, Ack::Gone).await;
        }
        "checkpoint" => {
            deliver(
                client,
                &runner,
                &masters,
                &frame,
                &key,
                ClaudeCodeRunner::CHECKPOINT_PROMPT,
            )
            .await;
        }
        "work" | "answer" | "inject" => {
            let Some(body) = frame.body.clone().filter(|b| !b.trim().is_empty()) else {
                tracing::error!(
                    "[inbox] {} with no body — session={sid} seq={seq}",
                    frame.kind
                );
                return;
            };
            deliver(client, &runner, &masters, &frame, &key, &body).await;
        }
        other => tracing::warn!("[inbox] unknown kind {other:?} — session={sid} seq={seq}"),
    }
}

/// What became of one message at a master pane, in the three shapes core can
/// be answered in — including the one that is no answer at all.
enum AtThePane {
    /// The pane took it.
    Took,
    /// tmux says it holds no session by that name. The only shape `gone`
    /// describes.
    Gone,
    /// Nothing was typed, and nothing here establishes that the session ended:
    /// the pane was read alive and refused the message, or tmux could not be
    /// asked. `Ack` has no word for it, and RFC 0003 already defines what the
    /// runner does with what it cannot honestly claim — it says nothing, core
    /// reads that as `unknown`, and the message waits instead of being
    /// replaced. The string is why, for the log.
    Unsaid(String),
}

async fn deliver_to_pane(
    masters: &Arc<Masters>,
    session_id: &str,
    body: &str,
) -> Option<AtThePane> {
    let pane = masters.pane_for_session(session_id)?;
    Some(match terminal::send_line(&pane, body).await {
        Ok(_) => AtThePane::Took,
        Err(terminal::NotTyped::Gone(_)) => AtThePane::Gone,
        Err(why @ (terminal::NotTyped::Refused(_) | terminal::NotTyped::Failed(_))) => {
            AtThePane::Unsaid(why.to_string())
        }
    })
}

async fn deliver(
    client: &CoreClient,
    runner: &Arc<ClaudeCodeRunner>,
    masters: &Arc<Masters>,
    frame: &SendFrame,
    key: &str,
    body: &str,
) {
    if let Some(outcome) = deliver_to_pane(masters, &frame.session_id, body).await {
        match outcome {
            AtThePane::Took => {
                inbox::ack(client, &frame.session_id, frame.seq, Ack::Delivered).await
            }
            AtThePane::Gone => {
                tracing::info!(
                    "[inbox] session={} seq={}: tmux holds no such session — acking `gone`",
                    frame.session_id,
                    frame.seq
                );
                inbox::ack(client, &frame.session_id, frame.seq, Ack::Gone).await
            }
            // Said at the level the `cancel` arm uses, and for the same reason:
            // the ack vocabulary has no answer that is true here, and the half
            // of that which used to be quiet was the half that lied.
            AtThePane::Unsaid(why) => tracing::error!(
                "[inbox] session={} seq={}: {why} — NO ack is being sent, because the pane was read and `gone` would say this session ended when this box has not established that. Core reads the silence as `unknown` and waits",
                frame.session_id,
                frame.seq
            ),
        }
        return;
    }
    let pending = Some((frame.session_id.clone(), frame.seq));
    let key = key.to_string();
    let write = runner.send_resident(&key, body, pending);
    match tokio::time::timeout(write_deadline(frame.deadline_ms), write).await {
        Ok(Ok(())) => inbox::ack(client, &frame.session_id, frame.seq, Ack::Delivered).await,
        Ok(Err(e)) => {
            tracing::info!("[inbox] session={} not resident: {e}", frame.session_id);
            inbox::ack(client, &frame.session_id, frame.seq, Ack::Gone).await;
        }
        Err(_) => tracing::error!(
            "[inbox] write overran its deadline — session={} seq={}",
            frame.session_id,
            frame.seq
        ),
    }
}
