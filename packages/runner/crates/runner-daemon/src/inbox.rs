//! RFC 0003 — `session.send`: the one message vocabulary a live session takes.
//!
//! Five kinds, one arm. `work`, `answer` and `inject` are the same act with
//! different provenance — text becomes the session's next turn. `checkpoint`
//! asks the agent to write down where it is before anything ends it, and
//! `cancel` ends the session between turns by EOF rather than by signal.
//!
//! A session lives in one of three places on a box: a master pane, a pool
//! job's pane, or the in-process runner. Each answers only for what it holds.
//!
//! What the runner reports back is deliberately narrow: `delivered` or `gone`,
//! and SILENCE for anything it cannot honestly claim — a session none of the
//! three holds included. Core reads silence as
//! `unknown`, the one outcome no caller may act on, so a message the runner is
//! unsure of waits instead of being replaced.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::master::Masters;
use crate::pool_jobs::{self, Cancelled, PoolPanes};
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

/// Where on this box a session core addressed lives. Each registry answers only for what it
/// holds, and a session none of them holds is one this box can say nothing about: not in a map
/// is not gone.
enum Held {
    /// A master pane core issued the session to.
    Master(String),
    /// A pool job's pane, by job id and pane name (ISS-1080's reader).
    PoolJob { job_id: String, pane: String },
    /// A session the in-process runner holds, resident or closed.
    Resident,
    /// None of the three.
    Nowhere,
}

async fn held(
    runner: &ClaudeCodeRunner,
    masters: &Masters,
    pool: &PoolPanes,
    frame: &SendFrame,
    key: &str,
) -> Held {
    if let Some(pane) = masters.pane_for_session(&frame.session_id) {
        return Held::Master(pane);
    }
    if let Some((job_id, pane)) = pool
        .registry
        .held_for_send(frame.job_id.as_deref(), &frame.session_id)
    {
        return Held::PoolJob { job_id, pane };
    }
    if runner.holds(&key.to_string()).await {
        return Held::Resident;
    }
    Held::Nowhere
}

/// Said, never acked: core reads the silence as `unknown`, which is the one answer true of a
/// session this box holds no record of.
fn unheld(frame: &SendFrame) {
    tracing::error!(
        "[inbox] session={} seq={} kind={} job={}: no master pane, pool job pane or resident session on this box holds it — NO ack is being sent, because `gone` would say the session ended and this box only knows it is not in its maps. Core reads the silence as `unknown`",
        frame.session_id,
        frame.seq,
        frame.kind,
        frame.job_id.as_deref().unwrap_or("none")
    );
}

pub async fn handle_session_send(
    client: &CoreClient,
    runner: Arc<ClaudeCodeRunner>,
    masters: Arc<Masters>,
    pool: &PoolPanes,
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

    let body = match frame.kind.as_str() {
        "cancel" => return cancel(client, &runner, &masters, pool, &frame, &key).await,
        "checkpoint" => ClaudeCodeRunner::CHECKPOINT_PROMPT.to_string(),
        "work" | "answer" | "inject" => match frame.body.clone().filter(|b| !b.trim().is_empty()) {
            Some(body) => body,
            None => {
                tracing::error!(
                    "[inbox] {} with no body — session={sid} seq={seq}",
                    frame.kind
                );
                return;
            }
        },
        other => {
            tracing::warn!("[inbox] unknown kind {other:?} — session={sid} seq={seq}");
            return;
        }
    };
    match held(&runner, &masters, pool, &frame, &key).await {
        // Both kinds of pane are typed into through the one terminal the job panes are driven
        // by, so what a pane answers is read the same way whichever it is.
        Held::Master(pane) | Held::PoolJob { pane, .. } => {
            let typed = pool.panes.send_line(&pane, &body).await;
            answer_from_pane(client, &frame, &pane, typed).await;
        }
        Held::Resident => deliver_resident(client, &runner, &frame, &key, &body).await,
        Held::Nowhere => unheld(&frame),
    }
}

/// `cancel` for each place a session can live. A pool job goes through `pool_jobs::cancel`, the
/// one path that closes its pane, says so with a kill-ack and gives the slot back (ISS-252).
async fn cancel(
    client: &CoreClient,
    runner: &ClaudeCodeRunner,
    masters: &Masters,
    pool: &PoolPanes,
    frame: &SendFrame,
    key: &str,
) {
    let sid = &frame.session_id;
    match held(runner, masters, pool, frame, key).await {
        Held::Master(pane) => {
            // `terminal::kill` answers for the session being gone (ISS-1208).
            // A pane it could not end is still running, so neither ack is
            // true of it: none is sent, and core reads `unknown`.
            match pool.panes.kill(&pane).await {
                Ok(()) => inbox::ack(client, sid, frame.seq, Ack::Gone).await,
                Err(e) => tracing::error!(
                    "[inbox] cancel for session {sid}: {pane} would not end ({e}) — NO ack is being sent, because that pane is still running whatever it was running and `gone` would say it is not. `forge-runner master kill` on its project is what ends it"
                ),
            }
        }
        Held::PoolJob { job_id, pane } => {
            let report = pool_jobs::CoreReport { client };
            match pool_jobs::cancel(
                pool.panes.as_ref(),
                &report,
                pool.records.as_ref(),
                &pool.registry,
                &job_id,
            )
            .await
            {
                // The pane is closed either way; an unacked kill leaves the slot for the
                // supervisor, which reports the pane gone.
                Cancelled::Closed | Cancelled::Unacked(_) => {
                    inbox::ack(client, sid, frame.seq, Ack::Gone).await
                }
                Cancelled::WouldNotClose(e) => tracing::error!(
                    "[inbox] cancel for session {sid}: job {job_id}'s pane {pane} would not close ({e}) — NO ack is being sent, because the pane is still running and `gone` would say it is not. Core reads the silence as `unknown`"
                ),
                // Let go of between the read and the cancel: its pane was closed by whatever let
                // go of it, and this box no longer holds it.
                Cancelled::NotHeld => unheld(frame),
            }
        }
        Held::Resident => {
            runner.close(&key.to_string()).await;
            inbox::ack(client, sid, frame.seq, Ack::Gone).await;
        }
        Held::Nowhere => unheld(frame),
    }
}

/// What became of one message at a pane, in the three shapes core can
/// be answered in — including the one that is no answer at all.
enum AtThePane {
    /// The pane took it.
    Took,
    /// tmux says it holds no session by that name. The only shape `gone`
    /// describes.
    Gone,
    /// Nothing here establishes that the message reached the agent, nor that
    /// the session ended: the pane was read alive and refused the message, the
    /// message sits unsent at its prompt, or tmux could not be asked. `Ack`
    /// has no word for it, and RFC 0003 already defines what the runner does
    /// with what it cannot honestly claim — it says nothing, core reads that
    /// as `unknown`, and the message waits instead of being replaced. The
    /// string is why, for the log.
    Unsaid(String),
}

impl AtThePane {
    fn of(typed: std::result::Result<terminal::Prompt, terminal::NotTyped>) -> Self {
        match typed {
            Ok(_) => Self::Took,
            Err(terminal::NotTyped::Gone(_)) => Self::Gone,
            Err(
                why @ (terminal::NotTyped::Refused(_)
                | terminal::NotTyped::Failed(_)
                | terminal::NotTyped::Unsubmitted(_)),
            ) => Self::Unsaid(why.to_string()),
        }
    }
}

async fn answer_from_pane(
    client: &CoreClient,
    frame: &SendFrame,
    pane: &str,
    typed: std::result::Result<terminal::Prompt, terminal::NotTyped>,
) {
    match AtThePane::of(typed) {
        AtThePane::Took => inbox::ack(client, &frame.session_id, frame.seq, Ack::Delivered).await,
        AtThePane::Gone => {
            tracing::info!(
                "[inbox] session={} seq={}: tmux holds no session {pane} — acking `gone`",
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
}

/// A session the in-process runner holds. One it holds and cannot write to — closed, or its
/// process gone from under the pipe — has ended as far as any message is concerned.
async fn deliver_resident(
    client: &CoreClient,
    runner: &Arc<ClaudeCodeRunner>,
    frame: &SendFrame,
    key: &str,
    body: &str,
) {
    let pending = Some((frame.session_id.clone(), frame.seq));
    let key = key.to_string();
    let write = runner.send_resident(&key, body, pending);
    match tokio::time::timeout(write_deadline(frame.deadline_ms), write).await {
        Ok(Ok(())) => inbox::ack(client, &frame.session_id, frame.seq, Ack::Delivered).await,
        Ok(Err(e)) => {
            tracing::info!(
                "[inbox] session={} is held here and takes no input: {e} — acking `gone`",
                frame.session_id
            );
            inbox::ack(client, &frame.session_id, frame.seq, Ack::Gone).await;
        }
        Err(_) => tracing::error!(
            "[inbox] write overran its deadline — session={} seq={}",
            frame.session_id,
            frame.seq
        ),
    }
}

#[cfg(test)]
#[path = "inbox_tests.rs"]
mod tests;
