//! A chat turn's transcript on its way to core (ISS-321, ISS-977, ISS-1268).
//!
//! Drains the runner event stream of one turn: its raw stream-json lines go to core in batches,
//! numbered from the seq core handed the turn; its partial messages go to the live-only channel;
//! a beat says the turn is alive while it runs; and one terminal write closes it, `completed` or
//! `failed` naming why.

use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc;

use crate::chat_live::{self, LiveBatch, LiveSender};
use crate::RunnerEvent;
use runner_transport::agent_sessions::{self, SessionPatch, WriteFailure};
use runner_transport::CoreClient;

/// Cadence for streaming assistant turns back to core while a turn runs.
/// Mirrors the desktop incremental-flush feel; core tail-debounces the
/// resulting `turn.appended` broadcast at 100ms so this stays cheap.
const FLUSH_INTERVAL: Duration = Duration::from_millis(750);

/// How often a running turn tells core it is working. Core reads an in-flight
/// chat turn's liveness from this beat (`pipeline/one-shot-reap.ts`), as it
/// reads a run session's from `run_sessions::beat`; well inside its 3-minute
/// silence window.
const TURN_BEAT_INTERVAL: Duration = Duration::from_secs(60);

/// Drain the runner event stream for one chat turn: deliver its raw stream-json
/// lines to core in batches, then a terminal PATCH that closes the interactive
/// run.
///
/// Nothing here reads what a line MEANS. `parse_assistant_message` used to live
/// beside this loop and kept assistant text alone, so a chat session's stored
/// transcript held no tool call, no todo list, no run total and no pause —
/// measured on forge-dev, session 5250d5e1: 17 assistant turns over dozens of
/// tool calls, zero tool frames stored. The lines go to core whole and
/// `agent-sessions/session-transcript.ts` folds them with the parser every other producer
/// already goes through.
///
/// A batch core refuses because a seq it was numbered into holds a row core wrote, naming its next
/// free seq, is numbered again from that seq with every line after it (ISS-977), at most
/// [`MAX_RENUMBERS`] times a turn. Answers the last seq this turn numbered a line with.
pub(crate) async fn consume(
    client: &CoreClient,
    session_id: &str,
    event_seq_base: u64,
    mut rx: mpsc::Receiver<RunnerEvent>,
) -> u64 {
    let mut seq = event_seq_base;
    let mut renumbered = 0usize;
    let mut pending: Vec<agent_sessions::LineEvent> = Vec::new();
    let mut claude_sid: Option<String> = None;
    let mut runtime_state: Option<String> = None;

    let mut flush = tokio::time::interval(FLUSH_INTERVAL);
    flush.tick().await;
    let mut beat = tokio::time::interval(TURN_BEAT_INTERVAL);
    beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let mut terminal: Option<Terminal> = None;
    // a partial message is shown as it is generated and never stored (ISS-1268)
    let live = LiveSender::start(client, session_id);
    let mut live_batch = LiveBatch::default();
    let mut live_tick = tokio::time::interval(chat_live::LIVE_INTERVAL);
    live_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Some(RunnerEvent::ClaudeSessionId(sid)) => { claude_sid = Some(sid); }
                Some(RunnerEvent::StateChanged(state)) => { runtime_state = Some(state.to_string()); }
                Some(RunnerEvent::Stdout(json)) => {
                    chat_live::live_items(&json).into_iter().for_each(|i| live_batch.push(i));
                    if is_partial_stream_event(&json) { continue; }
                    seq += 1;
                    pending.push(agent_sessions::LineEvent::stdout(seq, json));
                }
                Some(RunnerEvent::Done) => { terminal = Some(Terminal::Done); break; }
                Some(RunnerEvent::Failed { error }) => { terminal = Some(Terminal::Failed(error)); break; }
                None => break,
            },
            _ = live_tick.tick() => live.send(&mut live_batch),
            _ = beat.tick() => {
                if let Err(WriteFailure::Ended { code, said }) = beat_turn(client, session_id).await {
                    tracing::info!("[chat {session_id}] core ended this session ({code}) — stopping stream: {said}");
                    return seq;
                }
            }
            _ = flush.tick() => {
                if pending.is_empty() { continue; }
                match agent_sessions::post_events(client, session_id, &pending).await {
                    Ok(()) => pending.clear(),
                    Err(WriteFailure::Ended { code, said }) => {
                        tracing::info!("[chat {session_id}] core ended this session ({code}) — stopping stream: {said}");
                        return seq;
                    }
                    Err(WriteFailure::SeqTaken { next_seq, stored, said }) if renumbered < MAX_RENUMBERS => {
                        renumbered += 1;
                        seq = renumber(&mut pending, stored, next_seq);
                        tracing::warn!("[chat {session_id}] core holds a row inside this turn's seqs; the {} unstored line(s) go again from core's next seq {next_seq}: {said}", pending.len());
                    }
                    Err(refused @ (WriteFailure::Refused { .. } | WriteFailure::SeqTaken { .. })) => {
                        let msg = format!(
                            "[TRANSCRIPT_REFUSED] core refused a batch of this turn's transcript and stored none of that batch: {refused}"
                        );
                        tracing::error!("[chat {session_id}] {msg}");
                        patch_failed(client, session_id, claude_sid.clone(), &msg).await;
                        return seq;
                    }
                    Err(unreached @ WriteFailure::Unreached(_)) => {
                        // Transport or 5xx, already retried: keep the batch and try again next tick.
                        tracing::warn!("[chat {session_id}] stream events: {unreached}");
                    }
                }
            }
        }
    }

    live.send(&mut live_batch);
    if matches!(terminal, Some(Terminal::Done)) {
        chat_live::watch_suggestion(live, rx);
    }

    while !pending.is_empty() {
        match agent_sessions::post_events(client, session_id, &pending).await {
            Ok(()) => pending.clear(),
            Err(WriteFailure::Ended { code, said }) => {
                tracing::info!("[chat {session_id}] core ended this session ({code}) before the last lines landed: {said}");
                return seq;
            }
            Err(WriteFailure::SeqTaken {
                next_seq,
                stored,
                said,
            }) if renumbered < MAX_RENUMBERS => {
                renumbered += 1;
                seq = renumber(&mut pending, stored, next_seq);
                tracing::warn!("[chat {session_id}] core holds a row inside this turn's last seqs; the {} unstored line(s) go again from core's next seq {next_seq}: {said}", pending.len());
            }
            Err(e) => {
                let msg = format!(
                    "[TRANSCRIPT_INCOMPLETE] this turn's transcript was not delivered in full ({} line(s) pending at the end): {e}",
                    pending.len()
                );
                tracing::error!("[chat {session_id}] {msg}");
                patch_failed(client, session_id, claude_sid.clone(), &msg).await;
                return seq;
            }
        }
    }

    close_turn(client, session_id, terminal, claude_sid, runtime_state).await;
    seq
}

/// How many times one turn numbers its unstored lines again from core's next seq before a clash
/// is its failure: each renumbering follows a row core wrote inside the turn's seqs — a message a
/// person sent into the running turn writes one (ISS-1268) — and a core that keeps writing them
/// past this is not one this turn can outnumber.
const MAX_RENUMBERS: usize = 12;

/// Drop the `stored` lines core took, and number the rest from `next_seq` on; the last seq used.
pub(crate) fn renumber(
    pending: &mut Vec<agent_sessions::LineEvent>,
    stored: usize,
    next_seq: u64,
) -> u64 {
    pending.drain(..stored.min(pending.len()));
    let mut seq = next_seq.saturating_sub(1);
    for line in pending.iter_mut() {
        seq += 1;
        line.seq = seq;
    }
    seq
}

/// The turn's beat: `working`, which core takes as the box's word that the
/// turn is alive. A failure other than an ended session is left to the next
/// beat; three missed in a row is core's to read as a dead box.
async fn beat_turn(client: &CoreClient, session_id: &str) -> std::result::Result<(), WriteFailure> {
    let patch = SessionPatch {
        runtime_state: Some("working".into()),
        ..Default::default()
    };
    let beat = agent_sessions::write_session(client, session_id, &patch).await;
    if let Err(e @ (WriteFailure::Refused { .. } | WriteFailure::Unreached(_))) = &beat {
        tracing::warn!("[chat {session_id}] turn beat: {e}");
    }
    beat
}

/// How the CLI's own stream ended, as far as this turn saw it.
enum Terminal {
    Done,
    Failed(String),
}

/// The turn's one terminal write, once every line has landed: `completed`, or
/// `failed` naming why. A completion core refuses by name is recorded as the
/// turn's failure rather than left for the reaper to call generic.
async fn close_turn(
    client: &CoreClient,
    session_id: &str,
    terminal: Option<Terminal>,
    claude_sid: Option<String>,
    runtime_state: Option<String>,
) {
    match terminal {
        Some(Terminal::Done) => {
            let patch = SessionPatch {
                status: Some("completed".into()),
                claude_session_id: claude_sid.clone(),
                runtime_state,
                turn_error: None,
            };
            match agent_sessions::write_session(client, session_id, &patch).await {
                Ok(()) => tracing::info!("[chat {session_id}] turn done"),
                Err(WriteFailure::Ended { code, said }) => {
                    tracing::info!("[chat {session_id}] core ended this session ({code}) before the turn closed: {said}");
                }
                Err(refused @ (WriteFailure::Refused { .. } | WriteFailure::SeqTaken { .. })) => {
                    let msg = format!(
                        "[TURN_CLOSE_REFUSED] core refused this turn's completion: {refused}"
                    );
                    tracing::error!("[chat {session_id}] {msg}");
                    patch_failed(client, session_id, claude_sid.clone(), &msg).await;
                }
                Err(unreached @ WriteFailure::Unreached(_)) => {
                    tracing::warn!("[chat {session_id}] final patch: {unreached}");
                }
            }
        }
        Some(Terminal::Failed(err)) => {
            patch_failed(client, session_id, claude_sid.clone(), &err).await;
            tracing::info!("[chat {session_id}] turn failed: {err}");
        }
        None => {
            patch_failed(
                client,
                session_id,
                claude_sid.clone(),
                "runner ended without a result",
            )
            .await;
        }
    }
}

fn is_partial_stream_event(line: &Value) -> bool {
    line.get("type").and_then(Value::as_str) == Some("stream_event")
}

pub(crate) async fn patch_failed(
    client: &CoreClient,
    session_id: &str,
    claude_sid: Option<String>,
    error: &str,
) {
    let patch = SessionPatch {
        status: Some("failed".into()),
        claude_session_id: claude_sid,
        turn_error: Some(error.to_string()),
        runtime_state: Some("closed".into()),
    };
    // A session-state write is kernel input: a failure core did not take is
    // said, never dropped. Only an unanswered write is tried once more — a
    // refusal names the same bytes again — and what is still not taken is left
    // to core's zombie reaper, with this line where the turn's real error stays.
    for attempt in 1..=2 {
        match agent_sessions::write_session(client, session_id, &patch).await {
            Ok(()) => return,
            Err(WriteFailure::Ended { code, .. }) => {
                tracing::info!(
                    "[chat {session_id}] core had already ended this session ({code}), so this turn's failure is not recorded there: {error}"
                );
                return;
            }
            Err(e @ WriteFailure::Refused { .. }) => {
                tracing::error!(
                    "[chat {session_id}] core refused this turn's failure ({e}), so the session stays open at core until its reaper ends it under a generic reason. The failure it carried: {error}"
                );
                return;
            }
            Err(e) if attempt == 1 => {
                tracing::warn!(
                    "[chat {session_id}] core did not take this turn's failure ({e}); trying once more. The failure it carried: {error}"
                );
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Err(e) => tracing::error!(
                "[chat {session_id}] core did not answer this turn's failure twice ({e}), so the session stays open at core until its reaper ends it under a generic reason. The failure it carried: {error}"
            ),
        }
    }
}
