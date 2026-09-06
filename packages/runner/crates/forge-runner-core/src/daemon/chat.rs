//! Interactive chat over the device room (ISS-321).
//!
//! Makes the CLI runner a second implementer of the chat device-room contract
//! the desktop app already fulfils. Core resolves an online `claude-code`
//! runner via `findAvailableDeviceForProject`, opens a one-shot
//! `pipeline_run kind='interactive'`, and publishes:
//!   - `agent:start` `{ sessionId, prompt, projectSlug, repoPath, systemPrompt, model, sessionToken }`
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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::config::Config;
use crate::error::{Error, Result};
use crate::runner::claude_code::ClaudeCodeRunner;
use crate::runner::{JobSpec, Runner, RunnerEvent};
use crate::transport::agent_sessions::{self, SessionPatch};
use crate::transport::frames::JobToken;
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
    /// The session-scoped PAT core minted for this session (ISS-927). Optional
    /// because a mint that fails must not stop the session dispatching, and
    /// because a session whose owner row is gone has no principal to mint for.
    // cm:guard `JobToken`, never `String` — this struct derives `Debug`, and `frames.rs` records why that combination is the whole reason the newtype exists: a plain `String` here writes a live credential into the daemon log and into Sentry the day anyone adds a `tracing::debug!("{f:?}")`. The runner has no Sentry scrubber to catch it afterwards; core's `PAT_STRING_PATTERN` only covers core.
    #[serde(default)]
    session_token: Option<JobToken>,
}

/// `agent:send` payload (a follow-up turn on an existing session).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendFrame {
    session_id: String,
    message: String,
    #[serde(default)]
    claude_session_id: Option<String>,
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
    /// The session's own credential, exported to `claude` as `$FORGE_PAT`.
    session_token: Option<JobToken>,
}

// cm:guard the token arrives ONCE, on `agent:start`, and every later turn of the session reads it from here. Core does not re-send it on `agent:send` and must not be made to: a re-mint revokes the credential an in-flight turn is spending. A migration or a re-pin cold-starts the session, which sends a fresh `agent:start` and overwrites this entry — that is the only way an entry is ever replaced.
// cm:edge lockstep -> packages/core/src/agent-sessions/chat-turn.ts — the mint happens on the cold-start branch there, so this map is populated exactly when that branch runs. Move the mint onto `agent:send` and every session ends up holding a token this map has already forgotten.
static SESSION_TOKENS: OnceLock<Mutex<HashMap<String, JobToken>>> = OnceLock::new();

fn session_tokens() -> &'static Mutex<HashMap<String, JobToken>> {
    SESSION_TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_session_token(session_id: &str, token: Option<JobToken>) {
    let Some(token) = token.filter(|t| !t.expose().is_empty()) else {
        return;
    };
    if let Ok(mut map) = session_tokens().lock() {
        map.insert(session_id.to_string(), token);
    }
}

fn session_token_for(session_id: &str) -> Option<JobToken> {
    session_tokens()
        .lock()
        .ok()
        .and_then(|m| m.get(session_id).cloned())
}

// cm:guard forgetting here is HYGIENE, not the revoke. The credential dies because core revokes it on the session's terminal write — both of them, the kernel chokepoint and the runner's own happy-path PATCH. This map only stops a long-lived daemon accumulating one entry per session it ever served; a daemon that skipped it would leak memory, never authority.
fn forget_session_token(session_id: &str) {
    if let Ok(mut map) = session_tokens().lock() {
        map.remove(session_id);
    }
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
    remember_session_token(&f.session_id, f.session_token);
    let session_token = session_token_for(&f.session_id);
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
            session_token,
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
    let session_token = session_token_for(&f.session_id);
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
            session_token,
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
    forget_session_token(session_id);
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
        duplex: true,
        // cm:guard chat NEVER takes a session-cap permit, and ISS-920 giving that wait a 600s bound does not change it: core's `no_client_ack` sweeper kills an unacked chat turn at 90s, so a bounded queue still ends the turn before it spawns (session 1af837da, 2026-09-04: five user messages, no reply). Owner decision: chat has no limit.
        counts_against_session_cap: false,
        // cm:guard chat takes the DEFAULT and no project value, because the field is `pipelineConfig.sessionResidencySeconds` and chat has no pipeline behind it. A chat session's residency is bounded by the same const it always was; giving it a pipeline project's number would make a project setting silently change how long an unrelated chat window stays warm.
        session_residency_seconds: None,
        // cm:guard chat now DOES get a token, and this line is the one that was waiting on ISS-927. It used to say chat could not have one because the mint is keyed on a `jobs` row's `created_by` and a chat session has no job — true, and the reason the 8 cron schedules held a device token permanently. The missing pieces named there, "its own principal and its own revoke trigger", are the session's `user_id` and the pair of terminal writers core revokes on. `None` here is now only the honest answer for a session core could not mint for, never the design.
        pat_token: turn.session_token.clone(),
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
        let _ = patch_failed(client, &session_id, &[], None, &msg, None).await;
        cleanup_attachments(turn.attachment_dir.as_deref()).await;
        return Ok(());
    }
    runner
        .note_head(&session_id, git_state.head_sha.clone())
        .await;

    consume(client, &session_id, rx).await;
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

/// Drain the runner event stream for one chat turn, streaming the assistant
/// reply back via incremental PATCH, then a terminal PATCH that closes the
/// interactive run.
async fn consume(client: &CoreClient, session_id: &str, mut rx: mpsc::Receiver<RunnerEvent>) {
    // Baseline = whatever core already persisted (the user turn[s]). We only
    // ever APPEND assistant messages, and a PATCH replaces the whole array, so
    // starting from the baseline keeps history intact and never duplicates the
    // user turn (which core seeds with the clean, un-enriched prompt).
    let baseline = agent_sessions::get_messages(client, session_id)
        .await
        .unwrap_or_default();

    let mut turn_msgs: Vec<Value> = Vec::new();
    let mut claude_sid: Option<String> = None;
    let mut runtime_state: Option<String> = None;
    let mut tool_calls: u32 = 0;
    let mut dirty = false;

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
                Some(RunnerEvent::ClaudeSessionId(sid)) => { claude_sid = Some(sid); dirty = true; }
                // cm:guard recorded, NOT flushed on its own — a state change is not new transcript, and marking it dirty would post a whole-transcript PATCH per turn end on top of the terminal one that already carries it.
                Some(RunnerEvent::StateChanged(state)) => { runtime_state = Some(state.to_string()); }
                Some(RunnerEvent::Stdout(json)) => {
                    // cm:guard counting must NOT set `dirty` — a tool-heavy stretch emits no assistant text, so marking it dirty turns a silent period into one full-transcript PATCH every FLUSH_INTERVAL. Session 5250d5e1 (15 min, 17 text turns, dozens of tool calls) would have gone from ~17 writes to ~1200, each carrying the whole growing messages array. The count rides the next text flush and the terminal patch, which always fires; nothing reads the interim value.
                    tool_calls = tool_calls.saturating_add(count_tool_uses(&json));
                    if let Some(msg) = parse_assistant_message(&json) {
                        turn_msgs.push(msg);
                        dirty = true;
                    }
                }
                Some(RunnerEvent::Done { .. }) => { terminal = Some(Terminal::Done); break; }
                Some(RunnerEvent::Failed { error, .. }) => { terminal = Some(Terminal::Failed(error)); break; }
                Some(_) => {}
                None => break,
            },
            _ = flush.tick() => {
                if dirty {
                    let patch = SessionPatch {
                        status: Some("running".into()),
                        messages: Some(merged(&baseline, &turn_msgs)),
                        claude_session_id: claude_sid.clone(),
                        tool_call_count: Some(tool_calls),
                        runtime_state: runtime_state.clone(),
                    };
                    if let Err(e) = agent_sessions::patch_session(client, session_id, &patch).await {
                        if e.to_string().contains("SESSION_TERMINATED") {
                            tracing::info!("[chat {session_id}] session terminated by user — stopping stream");
                            return;
                        }
                        tracing::warn!("[chat {session_id}] stream patch: {e}");
                    } else {
                        dirty = false;
                    }
                }
            }
        }
    }

    match terminal {
        Some(Terminal::Done) => {
            let patch = SessionPatch {
                status: Some("completed".into()),
                messages: Some(merged(&baseline, &turn_msgs)),
                claude_session_id: claude_sid.clone(),
                tool_call_count: Some(tool_calls),
                runtime_state: runtime_state.clone(),
            };
            if let Err(e) = agent_sessions::patch_session(client, session_id, &patch).await {
                tracing::warn!("[chat {session_id}] final patch: {e}");
            } else {
                tracing::info!("[chat {session_id}] turn done");
            }
        }
        Some(Terminal::Failed(err)) => {
            let _ = patch_failed(
                client,
                session_id,
                &baseline,
                claude_sid.clone(),
                &err,
                Some(tool_calls),
            )
            .await;
            tracing::info!("[chat {session_id}] turn failed: {err}");
        }
        None => {
            let _ = patch_failed(
                client,
                session_id,
                &baseline,
                claude_sid.clone(),
                "runner ended without a result",
                Some(tool_calls),
            )
            .await;
        }
    }

    // The PATCH above is a terminal write, so core has already revoked this
    // session's token — only unattended, single-turn sessions ever hold one.
    // Dropping the entry keeps a long-lived daemon from carrying one dead
    // credential per session it has ever served.
    forget_session_token(session_id);
}

/// Final PATCH for a failed turn: append a visible error turn so the chat shows
/// what went wrong (e.g. `[RESUME_FAILED] …`) instead of sitting silent, and
/// mark the session `failed` so the interactive run is closed.
async fn patch_failed(
    client: &CoreClient,
    session_id: &str,
    baseline: &[Value],
    claude_sid: Option<String>,
    error: &str,
    tool_calls: Option<u32>,
) -> Result<()> {
    let mut msgs = baseline.to_vec();
    msgs.push(json!({
        "id": Uuid::new_v4().to_string(),
        "type": "system",
        "timestamp": now_ms(),
        "content": error,
    }));
    let patch = SessionPatch {
        status: Some("failed".into()),
        messages: Some(msgs),
        claude_session_id: claude_sid,
        tool_call_count: tool_calls,
        // cm:guard a failed turn reports `closed`, never the park — a session that died is not waiting for anyone, and `awaiting_input` is the one value that exempts a row from the heartbeat hop.
        runtime_state: Some("closed".into()),
    };
    agent_sessions::patch_session(client, session_id, &patch).await
}

fn merged(baseline: &[Value], turn_msgs: &[Value]) -> Vec<Value> {
    let mut out = Vec::with_capacity(baseline.len() + turn_msgs.len());
    out.extend_from_slice(baseline);
    out.extend_from_slice(turn_msgs);
    out
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Count the `tool_use` blocks on one `stream-json` line.
///
/// This is the ONLY record that a chat/schedule turn used a tool. The
/// transcript is not one: [`parse_assistant_message`] keeps assistant TEXT and
/// discards every tool frame, so `agent_sessions.messages` contains no
/// tool_use entry for any run, working or not. Measured 2026-08-26 on
/// forge-dev: session 5250d5e1 ran 17 assistant turns over dozens of tool
/// calls and stored zero tool frames, while 98692d6b (2 turns, wrote two
/// issue comments and a memory note) and b2f63f9c (2 turns, fabricated its
/// findings) are byte-identical in shape. Core cannot tell those two apart
/// without this counter.
fn count_tool_uses(json: &Value) -> u32 {
    if json.get("type").and_then(Value::as_str) != Some("assistant") {
        return 0;
    }
    let Some(content) = json
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return 0;
    };
    content
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
        .count() as u32
}

/// Turn one `stream-json` assistant line into the `AgentMessage` shape the web
/// chat UI renders (see `packages/dev/src/lib/types.ts` + `stream-parser.ts`).
/// Only assistant text turns are surfaced; the `usage`/`model` blocks are
/// passed through verbatim since claude already emits the field names core
/// expects. Non-assistant lines (`system`/`result`/tool frames) return `None`.
fn parse_assistant_message(json: &Value) -> Option<Value> {
    if json.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let message = json.get("message")?;
    let content = message.get("content").and_then(Value::as_array)?;

    let mut text = String::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(t) = block.get("text").and_then(Value::as_str) {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(t);
            }
        }
    }
    if text.trim().is_empty() {
        return None;
    }

    let mut msg = json!({
        "id": Uuid::new_v4().to_string(),
        "type": "assistant",
        "timestamp": now_ms(),
        "content": text,
    });
    if let Some(model) = message.get("model") {
        msg["model"] = model.clone();
    }
    if let Some(usage) = message.get("usage") {
        msg["usage"] = usage.clone();
    }
    Some(msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Binding;
    use std::path::PathBuf;

    // cm:guard the token arrives on `agent:start` and every later turn reads it from the store, because core does not re-send it on `agent:send` — a re-mint would revoke the credential an in-flight turn is spending. This asserts the round-trip that keeps a resumed turn authenticated; without it, `agent:send` silently falls back to whatever `$FORGE_PAT` the box was provisioned with, which is exactly the credential ISS-927 exists to stop relying on.
    #[test]
    fn a_session_token_survives_from_start_to_the_next_turn() {
        let sid = format!("sess-{}", Uuid::new_v4());
        assert!(session_token_for(&sid).is_none());

        remember_session_token(&sid, Some(JobToken::new("forge_pat_dev_secret".into())));
        assert_eq!(
            session_token_for(&sid).map(|t| t.expose().to_string()),
            Some("forge_pat_dev_secret".into())
        );

        forget_session_token(&sid);
        assert!(session_token_for(&sid).is_none());
    }

    // cm:guard a mint core could not perform sends no field at all, and an absent token must leave the entry ABSENT rather than storing an empty string — `claude_code.rs` sets `FORGE_PAT` whenever `pat_token` is `Some`, so an empty one would overwrite a working operator-provisioned value with nothing and break a box that was fine.
    #[test]
    fn an_absent_or_empty_token_stores_nothing() {
        let sid = format!("sess-{}", Uuid::new_v4());
        remember_session_token(&sid, None);
        assert!(session_token_for(&sid).is_none());
        remember_session_token(&sid, Some(JobToken::new(String::new())));
        assert!(session_token_for(&sid).is_none());
    }

    // cm:guard one session's token must never be handed to another. The store is process-global and shared by every session this daemon serves, and a box serving several projects would otherwise cross project-bound credentials between them.
    #[test]
    fn forgetting_one_session_leaves_another_alone() {
        let mine = format!("sess-{}", Uuid::new_v4());
        let theirs = format!("sess-{}", Uuid::new_v4());
        remember_session_token(&mine, Some(JobToken::new("mine".into())));
        remember_session_token(&theirs, Some(JobToken::new("theirs".into())));

        forget_session_token(&mine);

        assert!(session_token_for(&mine).is_none());
        assert_eq!(
            session_token_for(&theirs).map(|t| t.expose().to_string()),
            Some("theirs".into())
        );
    }

    // cm:guard the frame DERIVES `Debug`, so this is the only thing standing between a future `tracing::debug!("{f:?}")` and a live project-scoped credential in the daemon log and in Sentry. The runner has no scrubber downstream to catch it — core's `PAT_STRING_PATTERN` never sees a runner log line. Retype the field as `String` and this goes red, which is the whole reason it is written down.
    #[test]
    fn a_start_frame_cannot_debug_print_its_token() {
        let f: StartFrame = serde_json::from_value(json!({
            "sessionId": "s1",
            "sessionToken": "forge_pat_dev_live_secret",
        }))
        .expect("frame parses");

        let rendered = format!("{f:?}");
        assert!(
            !rendered.contains("forge_pat_dev_live_secret"),
            "agent:start frame leaked its token: {rendered}"
        );
        assert_eq!(
            f.session_token.as_ref().map(|t| t.expose()),
            Some("forge_pat_dev_live_secret")
        );
    }

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
            session_token: None,
        }
    }

    #[test]
    fn a_chat_turn_is_duplex_and_exempt_from_the_session_cap() {
        let spec = chat_spec("s1", "hi", &turn_for_test());
        assert!(
            spec.duplex,
            "chat is resident — a print spawn cannot take a follow-up on stdin"
        );
        assert!(
            !spec.counts_against_session_cap,
            "a chat turn must never queue for a permit: the wait has no timeout and core kills the session at 90s as `no_client_ack`, after which every send answers 200 into a cancelled session"
        );
    }

    #[test]
    fn parses_assistant_text_into_agent_message() {
        let line = json!({
            "type": "assistant",
            "message": {
                "model": "claude-opus-4-8",
                "content": [
                    { "type": "text", "text": "Hello" },
                    { "type": "text", "text": "world" }
                ],
                "usage": { "input_tokens": 10, "output_tokens": 5 }
            }
        });
        let msg = parse_assistant_message(&line).expect("assistant message");
        assert_eq!(msg["type"], "assistant");
        assert_eq!(msg["content"], "Hello\nworld");
        assert_eq!(msg["model"], "claude-opus-4-8");
        assert_eq!(msg["usage"]["output_tokens"], 5);
        assert!(msg["id"].as_str().is_some());
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
    fn counts_tool_use_blocks_the_transcript_discards() {
        let line = json!({
            "type": "assistant",
            "message": {"content": [
                {"type": "text", "text": "Let me look."},
                {"type": "tool_use", "id": "t1", "name": "Read", "input": {}},
                {"type": "tool_use", "id": "t2", "name": "Grep", "input": {}}
            ]}
        });
        assert_eq!(count_tool_uses(&line), 2);
        let msg = parse_assistant_message(&line).expect("text block still surfaces");
        assert_eq!(msg["content"], json!("Let me look."));
        assert!(msg.get("toolCalls").is_none());
    }

    #[test]
    fn counts_a_tool_only_turn_the_transcript_drops_entirely() {
        let line = json!({
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {}}]}
        });
        assert_eq!(count_tool_uses(&line), 1);
        assert!(parse_assistant_message(&line).is_none());
    }

    #[test]
    fn counts_zero_for_a_text_only_reply_and_for_non_assistant_frames() {
        assert_eq!(
            count_tool_uses(&json!({
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "Backlog reviewed: 47 issues."}]}
            })),
            0
        );
        assert_eq!(
            count_tool_uses(&json!({"type": "result", "num_turns": 1})),
            0
        );
        assert_eq!(count_tool_uses(&json!({"type": "user"})), 0);
        assert_eq!(count_tool_uses(&json!({"type": "assistant"})), 0);
    }

    #[test]
    fn ignores_non_assistant_and_empty_lines() {
        assert!(parse_assistant_message(&json!({ "type": "result", "is_error": false })).is_none());
        assert!(parse_assistant_message(&json!({ "type": "system", "subtype": "init" })).is_none());
        let no_text = json!({
            "type": "assistant",
            "message": { "content": [ { "type": "tool_use", "name": "Bash" } ] }
        });
        assert!(parse_assistant_message(&no_text).is_none());
    }

    #[test]
    fn merged_keeps_baseline_then_turn() {
        let baseline = vec![json!({ "role": "user", "content": "hi" })];
        let turn = vec![json!({ "type": "assistant", "content": "hello" })];
        let out = merged(&baseline, &turn);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["role"], "user");
        assert_eq!(out[1]["type"], "assistant");
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
