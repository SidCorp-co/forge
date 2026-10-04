//! Interactive chat over the device room (ISS-321).
//!
//! Makes the CLI runner a second implementer of the chat device-room contract
//! the desktop app already fulfils. Core resolves an online `claude-code`
//! runner via `findAvailableDeviceForProject`, opens a one-shot
//! `pipeline_run kind='interactive'`, and publishes:
//!   - `agent:start` `{ sessionId, prompt, projectSlug, repoPath, systemPrompt, model }`
//!   - `agent:send`  `{ sessionId, message, claudeSessionId, repoPath, projectSlug, model }`
//!   - `agent:abort` `{ sessionId }`
//!
//! A chat session is RESIDENT (ISS-873 phase 1): the first turn spawns a
//! duplex process whose stdin stays open and every follow-up is written into
//! it. `--resume` is the fallback for a session this daemon no longer holds —
//! a restart, the idle ceiling, or a model change. Session key = `sessionId`,
//! so `agent:abort` still maps onto the right process; replies stream back
//! with `PATCH /api/agent-sessions/:id`, exactly like the desktop.
//!
//! Chat never goes through `jobs` or `dispatch::handle`, so it takes no
//! pipeline slot, and since 2026-09-04 no budget of its own either: a turn
//! never queues. Its residency ceiling is the only bound.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::runner::claude_code::{ClaudeCodeRunner, Resident};
use crate::runner::{JobSpec, Runner, RunnerEvent, TurnCredential};
use crate::transport::agent_sessions::{self, SessionPatch};
use crate::transport::CoreClient;
use crate::workspace::refresh;

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
        timeout_seconds: None,
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
        let _ = patch_failed(client, &session_id, None, &msg).await;
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
        let _ = patch_failed(client, &session_id, None, &msg).await;
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

    enum Terminal {
        Done,
        Failed(String),
    }
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
                    Err(e) if e.to_string().contains("SESSION_TERMINATED") => {
                        tracing::info!("[chat {session_id}] session terminated by user — stopping stream");
                        return;
                    }
                    Err(e) if agent_sessions::is_refused(&e) => {
                        let msg = format!(
                            "[TRANSCRIPT_REFUSED] core refused a batch of this turn's transcript and stored none of that batch: {e}"
                        );
                        tracing::error!("[chat {session_id}] {msg}");
                        let _ = patch_failed(client, session_id, claude_sid.clone(), &msg).await;
                        return;
                    }
                    Err(e) => {
                        // Transport or 5xx, already retried: keep the batch and try again next tick.
                        tracing::warn!("[chat {session_id}] stream events: {e}");
                    }
                }
            }
        }
    }

    if !pending.is_empty() {
        if let Err(e) = agent_sessions::post_events(client, session_id, &pending).await {
            let msg = format!(
                "[TRANSCRIPT_INCOMPLETE] this turn's transcript was not delivered in full ({} line(s) pending at the end): {e}",
                pending.len()
            );
            tracing::error!("[chat {session_id}] {msg}");
            let _ = patch_failed(client, session_id, claude_sid.clone(), &msg).await;
            return;
        }
        pending.clear();
    }

    match terminal {
        Some(Terminal::Done) => {
            let patch = SessionPatch {
                status: Some("completed".into()),
                claude_session_id: claude_sid.clone(),
                runtime_state: runtime_state.clone(),
                turn_error: None,
            };
            if let Err(e) = agent_sessions::patch_session(client, session_id, &patch).await {
                tracing::warn!("[chat {session_id}] final patch: {e}");
            } else {
                tracing::info!("[chat {session_id}] turn done");
            }
        }
        Some(Terminal::Failed(err)) => {
            let _ = patch_failed(client, session_id, claude_sid.clone(), &err).await;
            tracing::info!("[chat {session_id}] turn failed: {err}");
        }
        None => {
            let _ = patch_failed(
                client,
                session_id,
                claude_sid.clone(),
                "runner ended without a result",
            )
            .await;
        }
    }

    // The PATCH above is a terminal write, so core has already revoked this
    // session's token — only unattended, single-turn sessions ever hold one.
    // Dropping the entry keeps a long-lived daemon from carrying one dead
    // credential per session it has ever served.
}

fn is_partial_stream_event(line: &Value) -> bool {
    line.get("type").and_then(Value::as_str) == Some("stream_event")
}

async fn patch_failed(
    client: &CoreClient,
    session_id: &str,
    claude_sid: Option<String>,
    error: &str,
) -> Result<()> {
    let patch = SessionPatch {
        status: Some("failed".into()),
        claude_session_id: claude_sid,
        turn_error: Some(error.to_string()),
        runtime_state: Some("closed".into()),
    };
    agent_sessions::patch_session(client, session_id, &patch).await
}
