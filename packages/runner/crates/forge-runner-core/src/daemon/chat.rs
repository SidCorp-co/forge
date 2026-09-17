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

use crate::config::Config;
use crate::error::{Error, Result};
use crate::runner::claude_code::ClaudeCodeRunner;
use crate::runner::{JobSpec, Runner, RunnerEvent};
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
    // cm:edge contract -> packages/core/src/agent-sessions/chat-turn.ts — core writes
    // this turn's user entry into `agent_session_events` and hands back the `seq` it
    // took; this turn's lines are numbered from there. Absent means a core that
    // predates the raw-line route, and the turn is refused by name rather than
    // numbered from a guess: numbering from 0 would make turn two's lines collide
    // with turn one's, and `ON CONFLICT DO NOTHING` would drop the whole turn in
    // silence.
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

/// Resolve the working dir for a chat turn. Core already sends `repoPath` on the
/// frame; fall back to the local config binding for the slug if it's absent.
fn resolve_repo(cfg: &Config, repo_path: Option<&str>, slug: Option<&str>) -> Result<String> {
    if let Some(p) = repo_path.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(p.to_string());
    }
    if let Some(slug) = slug {
        if let Some(b) = cfg.bindings.get(slug) {
            return Ok(b.repo_path.to_string_lossy().to_string());
        }
    }
    Err(Error::Other(format!(
        "chat session has no repo path (slug {:?} not bound) — run `forge-runner bind <slug> --path <dir>`",
        slug
    )))
}

/// Handle `agent:start`: begin a fresh chat turn.
pub async fn handle_start(
    client: &CoreClient,
    runner: Arc<ClaudeCodeRunner>,
    cfg: &Config,
    data: Value,
) -> Result<()> {
    let f: StartFrame =
        serde_json::from_value(data).map_err(|e| Error::Other(format!("bad agent:start: {e}")))?;
    let prompt = f
        .prompt
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Other("agent:start has no prompt".into()))?;
    let repo_path = resolve_repo(cfg, f.repo_path.as_deref(), f.project_slug.as_deref())?;
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
        },
    )
    .await
}

/// Handle `agent:send`: a follow-up turn. `--resume` is driven by the
/// `claudeSessionId` core threads back from the previous turn's PATCH.
pub async fn handle_send(
    client: &CoreClient,
    runner: Arc<ClaudeCodeRunner>,
    cfg: &Config,
    data: Value,
) -> Result<()> {
    let f: SendFrame =
        serde_json::from_value(data).map_err(|e| Error::Other(format!("bad agent:send: {e}")))?;
    let repo_path = resolve_repo(cfg, f.repo_path.as_deref(), f.project_slug.as_deref())?;
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
    // The session's token was delivered on `agent:start`; a follow-up never
    // carries one, and re-minting per turn would revoke the credential the
    // previous turn may still be spending.
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
            // cm:guard a follow-up DOES carry a model. Verified on claude 2.1.241: `--resume` with a changed `--model` runs the new model (haiku -> sonnet -> haiku, one session id, read back from `modelUsage`), and `--resume` with no `--model` inherits the session's last one. Hardcoding None here made the picker a lie for every turn after the first.
            model: f.model,
            resume_id: f.claude_session_id.filter(|s| !s.is_empty()),
            mcp_servers_override: f.mcp_servers_override,
            attachment_dir,
            event_seq_base: f.event_seq_base,
        },
    )
    .await
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
        issue_id: None,
        step: "chat".into(),
        repo_path: turn.repo_path.clone().into(),
        prompt: Some(prompt.to_string()),
        system_prompt: turn.system_prompt.clone(),
        model: turn.model.clone(),
        allowed_tools: None,
        disallowed_tools: None,
        permission_mode: None,
        timeout_seconds: None,
        mcp_servers_override: turn.mcp_servers_override.clone(),
        resume_id: turn.resume_id.clone(),
        agent_session_id: Some(session_id.to_string()),
        // cm:guard chat NEVER takes a session-cap permit, and ISS-920 giving that wait a 600s bound does not change it: core's `no_client_ack` sweeper kills an unacked chat turn at 90s, so a bounded queue still ends the turn before it spawns (session 1af837da, 2026-09-04: five user messages, no reply). Owner decision: chat has no limit.
        counts_against_session_cap: false,
        // cm:guard chat takes the DEFAULT and no project value, because the field is `pipelineConfig.sessionResidencySeconds` and chat has no pipeline behind it. A chat session's residency is bounded by the same const it always was; giving it a pipeline project's number would make a project setting silently change how long an unrelated chat window stays warm.
        session_residency_seconds: None,
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
    // cm:guard REFUSED BY NAME rather than numbered from a guess. A frame with no
    // base is a core that predates the raw-line route; numbering this turn from 0
    // would collide with the previous turn's lines, and core's
    // `ON CONFLICT DO NOTHING` would then drop the whole turn without a word. Core
    // ships before the daemons, so this is a misordered rollout and it says so.
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

    // cm:guard refresh HERE and not in handle_start / handle_send — both funnel through this function, and a per-caller refresh is exactly how the resume lane got forgotten. Session 228cdf03 idled 28h and answered from the checkout it was created with. Residency does NOT move it: `run_turn` is entered once per TURN, not once per spawn — the two only looked the same while a turn was a spawn.
    let git_state = refresh::refresh(Path::new(&turn.repo_path), None).await;
    tracing::info!("[chat {session_id}] {}", refresh::describe(&git_state));

    // cm:guard a session that can be reused must NOT be reused across a model change — the picker is honoured by respawning with `--model`, exactly as it was before residency. Verified 2026-08-29 that an in-band `/model` also works, but it costs its own turn and its result would be read as the answer to the user's question; that lands with the phase 4 message vocabulary, not here.
    let resident = runner.resident(&session_id).await;
    let reuse = match &resident {
        Some(r) if r.model == turn.model => true,
        Some(_) => {
            tracing::info!("[chat {session_id}] model changed — closing the resident session");
            runner.close(&session_id).await;
            false
        }
        None => false,
    };

    // cm:guard ISS-873 invariant 7 — a RESIDENT session already holds the pre-refresh file contents, so a checkout that moved under it must be announced. Under one-shot this was free: the process was always newer than the refresh. A stale checkout makes file content and `git log` agree WITH EACH OTHER, which makes "I verified by reading the files, not just history" the one check that cannot catch it.
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
    // cm:guard `send` failing must fall back to a spawn, never fail the turn. The resident session can go away between the `resident()` check and the write — the idle ceiling, an abort, a crash — and a user whose message is refused because a process died in that window has lost the turn for a reason that has nothing to do with them.
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
/// `jobs/session-transcript.ts` folds them with the parser every other producer
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
                // cm:guard recorded, NOT flushed on its own — a state change is not new transcript, and posting on it would cost a request per turn end on top of the terminal patch that already carries it.
                Some(RunnerEvent::StateChanged(state)) => { runtime_state = Some(state.to_string()); }
                Some(RunnerEvent::Stdout(json)) => {
                    // cm:guard EVERY line is numbered and delivered, and the old guard here said the
                    // opposite for a measured reason: a whole-transcript PATCH per flush turned a
                    // tool-heavy stretch into ~1200 writes each carrying the growing array, so a
                    // silent stretch had to stay silent. The reason survives and the mechanism
                    // inverts. What bounds the write count now is the BATCH — one request per flush
                    // interval whatever it holds — so every line can matter without costing a write
                    // each, which is the whole point: the silent stretches were the tool calls.
                    if is_partial_stream_event(&json) { continue; }
                    seq += 1;
                    pending.push(agent_sessions::LineEvent::stdout(seq, json));
                }
                Some(RunnerEvent::Done { .. }) => { terminal = Some(Terminal::Done); break; }
                Some(RunnerEvent::Failed { error, .. }) => { terminal = Some(Terminal::Failed(error)); break; }
                Some(_) => {}
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
                        // cm:guard a refusal ENDS the turn and says which line it was. Core stores a
                        // refused batch not at all, so carrying on would deliver the rest of this
                        // turn on the far side of a hole in the seq run — and the fold holds at a
                        // hole, so the transcript would stop there looking like a turn that simply
                        // went quiet. A turn that says it stopped recording is recoverable.
                        let msg = format!("[TRANSCRIPT_REFUSED] core refused this turn's transcript and stored none of it: {e}");
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

    // cm:guard the LAST batch is delivered BEFORE the terminal patch, and a turn
    // that cannot deliver it does not reach `completed`. Patching the status first
    // would let a turn finish clean while the tail of what it said was never
    // stored — a transcript that ends early and claims it did not.
    if !pending.is_empty() {
        if let Err(e) = agent_sessions::post_events(client, session_id, &pending).await {
            let msg = format!(
                "[TRANSCRIPT_INCOMPLETE] the last {} line(s) of this turn were never delivered: {e}",
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

/// The one stream-json frame core does not store, dropped before it is numbered.
///
/// cm:guard a DENYLIST of one proven-unread frame, never an allowlist — a frame
/// kind the CLI adds tomorrow must keep being delivered, and an allowlist would
/// drop it in silence.
/// cm:guard it is dropped BEFORE `seq` is assigned, not after. Numbering it and
/// then withholding it would leave a hole in the seq run, and core's fold holds
/// at a hole for ever — so filtering after numbering would end the transcript at
/// the first partial frame.
/// cm:edge lockstep -> packages/core/src/jobs/events-routes.ts — `isPartialStreamEvent`
/// drops the same frame on the pipeline path, for the same reason: the parser
/// answers `{messages:[]}` for one and nothing in core or web reads one. Teaching
/// any reader to consume a `stream_event` means deleting BOTH of these first,
/// because the frames it would need were never stored on either path.
fn is_partial_stream_event(line: &Value) -> bool {
    line.get("type").and_then(Value::as_str) == Some("stream_event")
}

/// Final PATCH for a failed turn: report the error so core records it on the
/// transcript, and mark the session `failed` so the interactive run is closed.
///
/// cm:guard the runner reports a STRING and core writes the entry. This used to
/// append a `system` message to a `messages` array it sent itself, which is
/// exactly the second producer ISS-1030 removed.
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
        // cm:guard a failed turn reports `closed`, never the park — a session that died is not waiting for anyone, and `awaiting_input` is the one value that exempts a row from the heartbeat hop.
        runtime_state: Some("closed".into()),
    };
    agent_sessions::patch_session(client, session_id, &patch).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Binding;
    use serde_json::json;
    use std::path::PathBuf;

    fn turn_for_test() -> Turn {
        Turn {
            session_id: "s1".into(),
            prompt: "hi".into(),
            repo_path: "/tmp".into(),
            project_slug: Some("demo".into()),
            system_prompt: None,
            model: None,
            resume_id: None,
            mcp_servers_override: None,
            attachment_dir: None,
            event_seq_base: Some(1),
        }
    }

    #[test]
    fn a_chat_turn_is_exempt_from_the_session_cap() {
        let spec = chat_spec("s1", "hi", &turn_for_test());
        assert!(
            !spec.counts_against_session_cap,
            "a chat turn must never queue for a permit: the wait has no timeout and core kills the session at 90s as `no_client_ack`, after which every send answers 200 into a cancelled session"
        );
    }

    #[test]
    fn a_line_is_delivered_whole_and_numbered_from_the_base() {
        // cm:guard the payload is the CLI's own JSON, byte for byte. The moment
        // this runner reshapes a line it is a second producer again, which is
        // what stored zero tool frames for every chat session ever run.
        let line = json!({
            "type": "assistant",
            "message": {"content": [
                {"type": "text", "text": "Let me look."},
                {"type": "tool_use", "id": "t1", "name": "Read", "input": {}}
            ]}
        });
        let ev = agent_sessions::LineEvent::stdout(42, line.clone());
        assert_eq!(ev.seq, 42);
        assert_eq!(ev.kind, "stdout");
        assert_eq!(ev.data["line"], line);
    }

    #[test]
    fn a_tool_only_turn_is_delivered_rather_than_dropped() {
        // The case the deleted parser threw away: an assistant line carrying a
        // tool call and no text. `parse_assistant_message` answered `None` for
        // exactly this, so the transcript could not say the turn used a tool.
        let line = json!({
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {}}]}
        });
        assert!(!is_partial_stream_event(&line));
        let ev = agent_sessions::LineEvent::stdout(1, line.clone());
        assert_eq!(ev.data["line"]["message"]["content"][0]["type"], "tool_use");
    }

    #[test]
    fn only_the_partial_stream_frame_is_withheld() {
        // cm:guard the `false` rows are what make this an assertion rather than a
        // tautology: a predicate that dropped anything it did not recognise would
        // silently withhold every frame kind the CLI adds next.
        assert!(is_partial_stream_event(&json!({"type": "stream_event", "event": {}})));
        assert!(!is_partial_stream_event(&json!({"type": "assistant", "message": {}})));
        assert!(!is_partial_stream_event(&json!({"type": "user", "message": {}})));
        assert!(!is_partial_stream_event(&json!({"type": "result", "num_turns": 1})));
        assert!(!is_partial_stream_event(&json!({"type": "system", "subtype": "init"})));
        assert!(!is_partial_stream_event(&json!({"type": "a_frame_added_tomorrow"})));
        assert!(!is_partial_stream_event(&json!({"no_type_at_all": true})));
    }

    #[test]
    fn a_refusal_is_told_apart_from_a_failure_to_deliver() {
        // cm:guard the second assertion is the one that matters: a predicate
        // answering true for every error would end a turn on a dropped packet,
        // and a retry is the right answer to that one.
        assert!(agent_sessions::is_refused(&Error::Other(
            "TRANSCRIPT_REFUSED: 400 Bad Request: stream-json line at seq 7 has no `type`".into()
        )));
        assert!(!agent_sessions::is_refused(&Error::Other(
            "post_events transport: connection reset".into()
        )));
        assert!(!agent_sessions::is_refused(&Error::Other(
            "post_events failed after 4 attempts: 503 Service Unavailable".into()
        )));
    }

    #[test]
    fn a_frame_without_a_sequence_base_carries_none_rather_than_a_zero() {
        // cm:guard `None`, never `Some(0)`. `run_turn` refuses a turn with no
        // base by name; a default of 0 would number turn two's lines over turn
        // one's, and core's `ON CONFLICT DO NOTHING` would drop the whole turn in
        // silence — which is the one outcome this design exists to prevent.
        let without: SendFrame = serde_json::from_value(json!({
            "sessionId": "s1",
            "message": "hi"
        }))
        .expect("frame without a base");
        assert_eq!(without.event_seq_base, None);

        let with: SendFrame = serde_json::from_value(json!({
            "sessionId": "s1",
            "message": "hi",
            "eventSeqBase": 7
        }))
        .expect("frame with a base");
        assert_eq!(with.event_seq_base, Some(7));
    }

    #[test]
    fn send_frame_carries_the_model_and_tolerates_its_absence() {
        let with_default: SendFrame = serde_json::from_value(json!({
            "sessionId": "s1",
            "message": "hi",
            "claudeSessionId": "c1",
            "model": "default"
        }))
        .expect("frame with model");
        assert_eq!(with_default.model.as_deref(), Some("default"));

        let without: SendFrame = serde_json::from_value(json!({
            "sessionId": "s1",
            "message": "hi"
        }))
        .expect("frame without model");
        assert_eq!(without.model, None);
    }

    #[test]
    fn resolve_repo_prefers_frame_path() {
        let cfg = Config::default();
        let p = resolve_repo(&cfg, Some("/srv/app"), Some("app")).expect("frame path");
        assert_eq!(p, "/srv/app");
    }

    #[test]
    fn resolve_repo_falls_back_to_binding() {
        let mut cfg = Config::default();
        cfg.bindings.insert(
            "app".into(),
            Binding {
                repo_path: PathBuf::from("/local/app"),
                branch: None,
                project_id: Some("p-1".into()),
            },
        );
        let p = resolve_repo(&cfg, None, Some("app")).expect("binding path");
        assert_eq!(p, "/local/app");
        assert!(resolve_repo(&cfg, Some("  "), Some("missing")).is_err());
    }
}
