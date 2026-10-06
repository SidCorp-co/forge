//! Interactive chat over the device room (ISS-321).
//!
//! Makes the CLI runner a second implementer of the chat device-room contract
//! the desktop app already fulfils. Core resolves an online `claude-code`
//! runner via `findAvailableDeviceForProject`, opens a one-shot
//! `pipeline_run kind='interactive'`, and publishes:
//!   - `agent:start` `{ sessionId, prompt, projectSlug, repoPath, systemPrompt, model }`
//!   - `agent:send`  `{ sessionId, message, claudeSessionId, repoPath, projectSlug, model }`
//!   - `agent:abort` `{ sessionId }`
//!   - `agent:close` `{ sessionId, reason }`: core ended the session's residency
//!
//! A chat session is RESIDENT (ISS-873 phase 1): the first turn spawns a
//! duplex process whose stdin stays open and every follow-up is written into
//! it. `--resume` is the fallback for a session this daemon no longer holds —
//! a restart, core ending its residency, or a model change. Session key = `sessionId`,
//! so `agent:abort` still maps onto the right process; replies stream back
//! with `PATCH /api/agent-sessions/:id`, exactly like the desktop.
//!
//! Chat never goes through `jobs` or `dispatch::handle`, so it takes no
//! pipeline slot, and since 2026-09-04 no budget of its own either: a turn
//! never queues. Its residency, which core ends (ADR 0009, Idle verdict), is
//! the only bound.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::claude_code::{ClaudeCodeRunner, Resident};
use crate::JobSpec; // UNRESOLVED
use crate::Runner; // UNRESOLVED
use crate::RunnerEvent; // UNRESOLVED
use crate::TurnCredential; // UNRESOLVED
use runner_platform::error::{Error, Result};
use runner_transport::agent_sessions::{self, SessionPatch, WriteFailure};
use runner_transport::CoreClient;
use runner_workspace::refresh;

/// Cadence for streaming assistant turns back to core while a turn runs.
/// Mirrors the desktop incremental-flush feel; core tail-debounces the
/// resulting `turn.appended` broadcast at 100ms so this stays cheap.
const FLUSH_INTERVAL: Duration = Duration::from_millis(750);

/// A file attached to a chat turn (ISS-499). Core sends these on the
/// `agent:start` / `agent:send` frame; `url` is a core-relative download path
/// the runner pulls with its device token (the download route is auth-gated).
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AttachmentRef {
    id: String,
    name: String,
    url: String,
}

/// `agent:start` payload (the chat START command from core).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartFrame {
    session_id: String,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    event_seq_base: Option<u64>,
    #[serde(default)]
    project_slug: Option<String>,
    #[serde(default)]
    repo_path: Option<String>,
    #[serde(default)]
    system_prompt: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    mcp_servers_override: Option<serde_json::Value>,
    #[serde(default)]
    attachments: Option<Vec<AttachmentRef>>,
    /// The token core minted for the person this session answers (ISS-17); absent on a session
    /// that answers nobody but the box's own holder.
    #[serde(default)]
    forge_token: Option<String>,
}

/// `agent:send` payload (a follow-up turn on an existing session).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendFrame {
    session_id: String,
    message: String,
    #[serde(default)]
    claude_session_id: Option<String>,
    /// See `StartFrame::event_seq_base`.
    #[serde(default)]
    event_seq_base: Option<u64>,
    #[serde(default)]
    project_slug: Option<String>,
    #[serde(default)]
    repo_path: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    mcp_servers_override: Option<serde_json::Value>,
    #[serde(default)]
    attachments: Option<Vec<AttachmentRef>>,
    /// See `StartFrame::forge_token`. A web session's every turn carries its own (ISS-27): the
    /// previous turn's was revoked when that turn stopped.
    #[serde(default)]
    forge_token: Option<String>,
}

/// Resolved per-turn parameters fed into one `claude` invocation.
struct Turn {
    session_id: String,
    prompt: String,
    repo_path: String,
    project_slug: Option<String>,
    system_prompt: Option<String>,
    model: Option<String>,
    resume_id: Option<String>,
    mcp_servers_override: Option<serde_json::Value>,
    /// Temp dir holding this turn's downloaded attachments; removed after the
    /// turn completes. `None` when the turn carried no attachments.
    attachment_dir: Option<PathBuf>,
    /// The `seq` core's own row for this turn took; this turn's lines follow it.
    event_seq_base: Option<u64>,
    /// See `StartFrame::forge_token`. A turn that carries one never reuses a resident process:
    /// that process's MCP config holds the token of the turn that spawned it, revoked since.
    credential: Option<TurnCredential>,
}

/// Download a turn's attachments to a fresh temp dir, authenticated with the
/// runner's device token (the download route is auth-gated — `WebFetch` can't
/// pull anonymously). Returns `(staged_dir, local_paths)`. Best-effort: a file
/// that fails to download is logged and skipped, never fatal to the turn.
async fn stage_attachments(
    client: &CoreClient,
    session_id: &str,
    refs: &[AttachmentRef],
) -> Option<(PathBuf, Vec<PathBuf>)> {
    if refs.is_empty() {
        return None;
    }
    let dir = std::env::temp_dir().join(format!("forge-attach-{session_id}-{}", Uuid::new_v4()));
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!("[chat {session_id}] attach: mkdir failed: {e}");
        return None;
    }
    let mut paths: Vec<PathBuf> = Vec::new();
    for att in refs {
        let url = client.url(&att.url);
        let bytes = match client
            .http()
            .get(&url)
            .bearer_auth(client.device_token())
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!("[chat {session_id}] attach {}: read body: {e}", att.name);
                    continue;
                }
            },
            Ok(r) => {
                tracing::warn!(
                    "[chat {session_id}] attach {}: http {}",
                    att.name,
                    r.status()
                );
                continue;
            }
            Err(e) => {
                tracing::warn!("[chat {session_id}] attach {}: {e}", att.name);
                continue;
            }
        };
        // Keep the original extension (claude infers image type from it) and
        // prefix with a short id slice so same-named files don't collide.
        let safe = att.name.replace(['/', '\\'], "_");
        let prefix = &att.id[..att.id.len().min(8)];
        let path = dir.join(format!("{prefix}_{safe}"));
        if let Err(e) = tokio::fs::write(&path, &bytes).await {
            tracing::warn!("[chat {session_id}] attach {}: write: {e}", att.name);
            continue;
        }
        paths.push(path);
    }
    if paths.is_empty() {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return None;
    }
    Some((dir, paths))
}

/// Append a trailing section to the prompt pointing claude at the local files,
/// so it `Read`s them (image vision + text/PDF) within the turn. When the user
/// sent files with no caption (files-only turn), seed a default instruction so
/// claude has something to act on instead of an empty prompt.
fn augment_prompt(prompt: &str, paths: &[PathBuf]) -> String {
    let mut out = if prompt.trim().is_empty() {
        String::from("The user attached the following file(s) with no message. Look at each and describe / summarize its contents.")
    } else {
        String::from(prompt)
    };
    out.push_str(
        "\n\n[Attached files — read each with the Read tool; these are local paths on this machine]\n",
    );
    for p in paths {
        out.push_str("- ");
        out.push_str(&p.to_string_lossy());
        out.push('\n');
    }
    out
}

/// The working dir for a chat turn: the checkout this device's binding names, which core sends
/// on the frame and refuses the turn without. Nothing on this box stands in for it.
fn resolve_repo(repo_path: Option<&str>, slug: Option<&str>) -> Result<String> {
    if let Some(p) = repo_path.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(p.to_string());
    }
    let slug = slug.unwrap_or("<no slug>");
    Err(Error::Other(format!(
        "chat turn for {slug} refused: core sent no checkout, and the device binding for {slug} must name one — run `forge-runner bind {slug} --path <dir>`"
    )))
}

/// Handle `agent:start`: begin a fresh chat turn.
pub async fn handle_start(
    client: &CoreClient,
    runner: Arc<ClaudeCodeRunner>,
    data: Value,
) -> Result<()> {
    let f: StartFrame =
        serde_json::from_value(data).map_err(|e| Error::Other(format!("bad agent:start: {e}")))?;
    let prompt = f
        .prompt
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Other("agent:start has no prompt".into()))?;
    let repo_path = resolve_repo(f.repo_path.as_deref(), f.project_slug.as_deref())?;
    let staged = stage_attachments(
        client,
        &f.session_id,
        f.attachments.as_deref().unwrap_or(&[]),
    )
    .await;
    let (prompt, attachment_dir) = match staged {
        Some((dir, paths)) => (augment_prompt(&prompt, &paths), Some(dir)),
        None => (prompt, None),
    };
    run_turn(
        client,
        runner,
        Turn {
            session_id: f.session_id,
            prompt,
            repo_path,
            project_slug: f.project_slug,
            system_prompt: f.system_prompt,
            model: f.model,
            resume_id: None,
            mcp_servers_override: f.mcp_servers_override,
            attachment_dir,
            event_seq_base: f.event_seq_base,
            credential: handed_credential(f.forge_token),
        },
    )
    .await
}

/// Handle `agent:send`: a follow-up turn. `--resume` is driven by the
/// `claudeSessionId` core threads back from the previous turn's PATCH.
pub async fn handle_send(
    client: &CoreClient,
    runner: Arc<ClaudeCodeRunner>,
    data: Value,
) -> Result<()> {
    let f: SendFrame =
        serde_json::from_value(data).map_err(|e| Error::Other(format!("bad agent:send: {e}")))?;
    let repo_path = resolve_repo(f.repo_path.as_deref(), f.project_slug.as_deref())?;
    let staged = stage_attachments(
        client,
        &f.session_id,
        f.attachments.as_deref().unwrap_or(&[]),
    )
    .await;
    let (prompt, attachment_dir) = match staged {
        Some((dir, paths)) => (augment_prompt(&f.message, &paths), Some(dir)),
        None => (f.message, None),
    };
    run_turn(
        client,
        runner,
        Turn {
            session_id: f.session_id,
            prompt,
            repo_path,
            project_slug: f.project_slug,
            // No system prompt on follow-ups — `--resume` keeps the original.
            system_prompt: None,
            model: f.model,
            resume_id: f.claude_session_id.filter(|s| !s.is_empty()),
            mcp_servers_override: f.mcp_servers_override,
            attachment_dir,
            event_seq_base: f.event_seq_base,
            credential: handed_credential(f.forge_token),
        },
    )
    .await
}

fn handed_credential(token: Option<String>) -> Option<TurnCredential> {
    token.filter(|t| !t.trim().is_empty()).map(TurnCredential)
}

/// Handle `agent:abort`: kill the running claude process for this session, if
/// any. Between turns there is no process, so a "not found" is benign.
pub async fn handle_abort(runner: Arc<ClaudeCodeRunner>, session_id: &str) {
    if let Err(e) = runner.abort(&session_id.to_string()).await {
        tracing::debug!("[chat {session_id}] abort: {e}");
    }
}

/// Handle `agent:close`: core ended this session's residency, so the resident
/// process is closed between turns and core is told it is, which is what stops
/// core asking. A session this daemon does not hold is already closed here, and
/// is said so all the same.
pub async fn handle_close(client: &CoreClient, runner: Arc<ClaudeCodeRunner>, session_id: &str) {
    runner.close(&session_id.to_string()).await;
    tracing::info!("[chat {session_id}] core ended its residency — closed");
    agent_sessions::report_runtime_state(client, session_id, "closed").await;
}

/// The spawn spec for one chat turn.
// Session key = sessionId so `agent:abort` → `runner.abort(sessionId)` hits the
// right process. step="chat" / job_id=sessionId only label the run.
fn chat_spec(session_id: &str, prompt: &str, turn: &Turn) -> JobSpec {
    JobSpec {
        job_id: session_id.to_string(),
        project_id: String::new(),
        project_slug: turn.project_slug.clone(),
        repo_path: turn.repo_path.clone().into(),
        prompt: Some(prompt.to_string()),
        system_prompt: turn.system_prompt.clone(),
        model: turn.model.clone(),
        permission_mode: None,
        mcp_servers_override: turn.mcp_servers_override.clone(),
        resume_id: turn.resume_id.clone(),
        counts_against_session_cap: false,
        credential: turn.credential.clone(),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Disposition {
    Reuse,
    Spawn,
    Close(&'static str),
}

/// Whether a turn may be written into the session's resident process. One that carries its own
/// token may not: the resident's MCP config holds the token of the turn that spawned it.
fn resident_disposition(resident: Option<&Resident>, turn: &Turn) -> Disposition {
    match resident {
        None => Disposition::Spawn,
        Some(_) if turn.credential.is_some() => {
            Disposition::Close("this turn carries its own token")
        }
        Some(r) if r.model == turn.model => Disposition::Reuse,
        Some(_) => Disposition::Close("model changed"),
    }
}

async fn run_turn(client: &CoreClient, runner: Arc<ClaudeCodeRunner>, turn: Turn) -> Result<()> {
    // ISS-584 (C): ack the turn the moment we own it, before claude starts. Lets
    // core tell apart "no runner ever got this" (never acked) from "runner got it
    // but claude died on startup" (acked, no claudeSessionId), and fast-fail the
    // latter. Best-effort: a failed ack only forfeits the speed-up, never the turn.
    if let Err(e) = agent_sessions::ack_session(client, &turn.session_id).await {
        tracing::debug!("[chat {}] ack failed (non-fatal): {e}", turn.session_id);
    }

    let session_id = turn.session_id.clone();
    let Some(event_seq_base) = turn.event_seq_base else {
        let msg = "[EVENT_SEQ_BASE_MISSING] this turn carried no event sequence base, so its lines cannot be numbered — core is older than this runner release; upgrade core first".to_string();
        tracing::error!("[chat {session_id}] {msg}");
        patch_failed(client, &session_id, None, &msg).await;
        cleanup_attachments(turn.attachment_dir.as_deref()).await;
        return Ok(());
    };
    tracing::info!(
        "[chat {session_id}] turn start (resume={})",
        turn.resume_id.is_some()
    );

    let git_state = refresh::refresh(Path::new(&turn.repo_path), None).await;
    tracing::info!("[chat {session_id}] {}", refresh::describe(&git_state));

    let resident = runner.resident(&session_id).await;
    let reuse = match resident_disposition(resident.as_ref(), &turn) {
        Disposition::Reuse => true,
        Disposition::Spawn => false,
        Disposition::Close(why) => {
            tracing::info!("[chat {session_id}] {why} — closing the resident session");
            runner.close(&session_id).await;
            false
        }
    };

    let moved_under_us = reuse
        && resident
            .as_ref()
            .is_some_and(|r| r.head_sha.is_some() && r.head_sha != git_state.head_sha);
    let prompt = if !git_state.refreshed {
        format!(
            "[workspace notice] {}\nWhile this holds, do not state what is or is not on the base branch from local files — check the remote before any such claim.\n\n{}",
            refresh::describe(&git_state),
            turn.prompt
        )
    } else if moved_under_us {
        format!(
            "[workspace notice] the checkout moved under this session since your last turn ({}). Anything you read from these files earlier may be stale — re-read before relying on it.\n\n{}",
            refresh::describe(&git_state),
            turn.prompt
        )
    } else {
        turn.prompt.clone()
    };

    let spec = chat_spec(&session_id, &prompt, &turn);

    let (tx, rx) = mpsc::channel::<RunnerEvent>(200);
    let started = if reuse {
        match runner.send(&session_id, prompt.clone(), tx.clone()).await {
            Ok(()) => Ok(()),
            Err(e) => {
                tracing::info!("[chat {session_id}] resident send failed ({e}) — respawning");
                runner.start(spec, tx).await.map(|_| ())
            }
        }
    } else {
        runner.start(spec, tx).await.map(|_| ())
    };
    if let Err(e) = started {
        let msg = format!("failed to start chat turn: {e}");
        tracing::error!("[chat {session_id}] {msg}");
        patch_failed(client, &session_id, None, &msg).await;
        cleanup_attachments(turn.attachment_dir.as_deref()).await;
        return Ok(());
    }
    runner
        .note_head(&session_id, git_state.head_sha.clone())
        .await;

    consume(client, &session_id, event_seq_base, rx).await;
    // Best-effort temp cleanup — runs even on a failed turn (consume always
    // returns). Leaking a temp dir is harmless but we don't want to accumulate.
    cleanup_attachments(turn.attachment_dir.as_deref()).await;
    Ok(())
}

/// Remove a turn's staged-attachment temp dir (best-effort).
async fn cleanup_attachments(dir: Option<&std::path::Path>) {
    if let Some(dir) = dir {
        if let Err(e) = tokio::fs::remove_dir_all(dir).await {
            tracing::debug!("[chat] attach cleanup {}: {e}", dir.display());
        }
    }
}

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
async fn consume(
    client: &CoreClient,
    session_id: &str,
    event_seq_base: u64,
    mut rx: mpsc::Receiver<RunnerEvent>,
) {
    let mut seq = event_seq_base;
    let mut pending: Vec<agent_sessions::LineEvent> = Vec::new();
    let mut claude_sid: Option<String> = None;
    let mut runtime_state: Option<String> = None;

    let mut flush = tokio::time::interval(FLUSH_INTERVAL);
    flush.tick().await;

    let mut terminal: Option<Terminal> = None;

    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Some(RunnerEvent::ClaudeSessionId(sid)) => { claude_sid = Some(sid); }
                Some(RunnerEvent::StateChanged(state)) => { runtime_state = Some(state.to_string()); }
                Some(RunnerEvent::Stdout(json)) => {
                    if is_partial_stream_event(&json) { continue; }
                    seq += 1;
                    pending.push(agent_sessions::LineEvent::stdout(seq, json));
                }
                Some(RunnerEvent::Done) => { terminal = Some(Terminal::Done); break; }
                Some(RunnerEvent::Failed { error }) => { terminal = Some(Terminal::Failed(error)); break; }
                None => break,
            },
            _ = flush.tick() => {
                if pending.is_empty() { continue; }
                match agent_sessions::post_events(client, session_id, &pending).await {
                    Ok(()) => pending.clear(),
                    Err(WriteFailure::Ended { code, said }) => {
                        tracing::info!("[chat {session_id}] core ended this session ({code}) — stopping stream: {said}");
                        return;
                    }
                    Err(refused @ WriteFailure::Refused { .. }) => {
                        let msg = format!(
                            "[TRANSCRIPT_REFUSED] core refused a batch of this turn's transcript and stored none of that batch: {refused}"
                        );
                        tracing::error!("[chat {session_id}] {msg}");
                        patch_failed(client, session_id, claude_sid.clone(), &msg).await;
                        return;
                    }
                    Err(unreached @ WriteFailure::Unreached(_)) => {
                        // Transport or 5xx, already retried: keep the batch and try again next tick.
                        tracing::warn!("[chat {session_id}] stream events: {unreached}");
                    }
                }
            }
        }
    }

    if !pending.is_empty() {
        if let Err(e) = agent_sessions::post_events(client, session_id, &pending).await {
            if let WriteFailure::Ended { code, said } = &e {
                tracing::info!("[chat {session_id}] core ended this session ({code}) before the last lines landed: {said}");
                return;
            }
            let msg = format!(
                "[TRANSCRIPT_INCOMPLETE] this turn's transcript was not delivered in full ({} line(s) pending at the end): {e}",
                pending.len()
            );
            tracing::error!("[chat {session_id}] {msg}");
            patch_failed(client, session_id, claude_sid.clone(), &msg).await;
            return;
        }
        pending.clear();
    }

    close_turn(client, session_id, terminal, claude_sid, runtime_state).await;
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
                Err(refused @ WriteFailure::Refused { .. }) => {
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

async fn patch_failed(
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

#[cfg(test)]
mod tests {
    //! The stream loop against a fake core that answers on a real socket, so
    //! what is under test is the status and body core sends, not a stub of the
    //! transport.
    use super::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// One request the fake core received: method, path and body.
    type Seen = Arc<Mutex<Vec<(String, String, String)>>>;

    /// A fake core whose `/events` answers `events_status` with a refusal
    /// envelope carrying `code` at the top level and under `error`, as
    /// `contracts/src/refusal.ts:ProblemBody` does; every PATCH is taken.
    async fn fake_core(events_status: u16, code: &'static str) -> (CoreClient, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Seen = Arc::default();
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let (method, path, body) = read_request(&mut sock).await;
                let (status, reply) = if path.ends_with("/events") {
                    let envelope = serde_json::json!({
                        "code": code,
                        "message": "refused",
                        "error": { "code": code, "message": "refused" },
                    });
                    (events_status, envelope.to_string())
                } else {
                    (200, "{}".to_string())
                };
                log.lock().unwrap().push((method, path, body));
                let head = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    reply.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(reply.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (CoreClient::new(format!("http://{addr}"), "token"), seen)
    }

    async fn read_request(sock: &mut tokio::net::TcpStream) -> (String, String, String) {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        let header_end = loop {
            let n = sock.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                break buf.len();
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let length = head
            .lines()
            .find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.eq_ignore_ascii_case("content-length")
                    .then(|| v.trim().parse::<usize>().ok())?
            })
            .unwrap_or(0);
        while buf.len() < header_end + length {
            let n = sock.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let mut first = head.split_whitespace();
        let method = first.next().unwrap_or_default().to_string();
        let path = first.next().unwrap_or_default().to_string();
        let end = (header_end + length).min(buf.len());
        let body = String::from_utf8_lossy(&buf[header_end..end]).to_string();
        (method, path, body)
    }

    /// One stdout line queued, the sender held open so only the flush tick
    /// can deliver it, and the loop given until it returns.
    async fn stream_one_line(client: &CoreClient) {
        let (tx, rx) = mpsc::channel::<RunnerEvent>(8);
        tx.send(RunnerEvent::Stdout(
            serde_json::json!({ "type": "assistant" }),
        ))
        .await
        .unwrap();
        let ran = tokio::time::timeout(Duration::from_secs(10), consume(client, "s1", 0, rx)).await;
        drop(tx);
        assert!(ran.is_ok(), "the stream loop never returned");
    }

    /// One stdout line and the turn's end queued together, so the line goes
    /// out in the final flush rather than on a tick.
    async fn finish_with_one_line(client: &CoreClient) {
        let (tx, rx) = mpsc::channel::<RunnerEvent>(8);
        tx.send(RunnerEvent::Stdout(
            serde_json::json!({ "type": "assistant" }),
        ))
        .await
        .unwrap();
        tx.send(RunnerEvent::Done).await.unwrap();
        drop(tx);
        let ran = tokio::time::timeout(Duration::from_secs(10), consume(client, "s1", 0, rx)).await;
        assert!(ran.is_ok(), "the stream loop never returned");
    }

    fn patches(seen: &Seen) -> Vec<Value> {
        seen.lock()
            .unwrap()
            .iter()
            .filter(|(m, _, _)| m == "PATCH")
            .map(|(_, _, b)| serde_json::from_str(b).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn a_residency_core_ended_is_reported_closed_even_where_nothing_is_resident() {
        let (client, seen) = fake_core(200, "").await;
        let runner = Arc::new(ClaudeCodeRunner::new(
            "http://127.0.0.1:9",
            "device-token",
            1,
        ));
        handle_close(&client, runner, "s-1").await;
        let patches = patches(&seen);
        assert_eq!(
            patches,
            vec![serde_json::json!({ "runtimeState": "closed" })],
            "core was not told the session it ended is closed, so it would ask again every pass"
        );
    }

    #[tokio::test]
    async fn a_seq_clash_core_refuses_marks_the_session_failed_by_its_code() {
        let (client, seen) = fake_core(409, "SEQ_TAKEN_BY_CORE").await;
        stream_one_line(&client).await;
        let patches = patches(&seen);
        let failed = patches
            .iter()
            .find(|p| p["status"] == "failed")
            .unwrap_or_else(|| {
                panic!(
                    "a 409 SEQ_TAKEN_BY_CORE ended the turn with no failure written: {patches:?}"
                )
            });
        let said = failed["turnError"].as_str().unwrap_or_default();
        assert!(
            said.contains("SEQ_TAKEN_BY_CORE"),
            "the failure does not name the code core refused by: {said}"
        );
    }

    #[tokio::test]
    async fn a_session_core_has_terminated_stops_the_stream_without_a_write() {
        let (client, seen) = fake_core(422, "SESSION_TERMINATED").await;
        stream_one_line(&client).await;
        assert_eq!(patches(&seen), Vec::<Value>::new());
    }

    #[tokio::test]
    async fn a_session_the_user_cancelled_stops_the_stream_without_a_write() {
        let (client, seen) = fake_core(409, "SESSION_CANCELLED").await;
        stream_one_line(&client).await;
        assert_eq!(patches(&seen), Vec::<Value>::new());
    }

    #[tokio::test]
    async fn a_422_naming_any_other_code_is_a_failure_not_a_termination() {
        let (client, seen) = fake_core(422, "SESSION_STALE").await;
        stream_one_line(&client).await;
        let patches = patches(&seen);
        let failed = patches.iter().find(|p| p["status"] == "failed");
        assert!(
            failed.is_some_and(|p| p["turnError"]
                .as_str()
                .unwrap_or_default()
                .contains("SESSION_STALE")),
            "a 422 SESSION_STALE did not mark the session failed by name: {patches:?}"
        );
    }

    #[tokio::test]
    async fn a_final_flush_core_refuses_names_the_code_in_the_failure() {
        let (client, seen) = fake_core(409, "SEQ_TAKEN_BY_CORE").await;
        finish_with_one_line(&client).await;
        let patches = patches(&seen);
        assert_eq!(
            patches.len(),
            1,
            "one failure write, no completion: {patches:?}"
        );
        assert_eq!(patches[0]["status"], "failed");
        let said = patches[0]["turnError"].as_str().unwrap_or_default();
        assert!(
            said.contains("SEQ_TAKEN_BY_CORE"),
            "the final flush's failure does not name the code: {said}"
        );
    }

    #[tokio::test]
    async fn a_final_flush_into_a_terminated_session_writes_nothing_more() {
        let (client, seen) = fake_core(422, "SESSION_TERMINATED").await;
        finish_with_one_line(&client).await;
        assert_eq!(patches(&seen), Vec::<Value>::new());
    }
}
