//! Interactive chat over the device room (ISS-321).
//!
//! Makes the CLI runner a second implementer of the chat device-room contract
//! the desktop app already fulfils. Core resolves an online `claude-code`
//! runner via `findAvailableDeviceForProject`, opens a one-shot
//! `pipeline_run kind='interactive'`, and publishes:
//!   - `agent:start` `{ sessionId, prompt, projectSlug, repoPath, systemPrompt }`
//!   - `agent:send`  `{ sessionId, message, claudeSessionId, repoPath, projectSlug }`
//!   - `agent:abort` `{ sessionId }`
//!
//! A chat turn is a ONE-SHOT `claude -p <text>` invocation (with `--resume
//! <claudeSessionId>` for follow-ups) — there is no long-lived stdin. Multi-turn
//! context is carried entirely by Claude's own `--resume`. We reuse the existing
//! [`ClaudeCodeRunner::start`] (session key = `sessionId`, so `agent:abort` maps
//! straight onto the right process) and stream the reply back with
//! `PATCH /api/agent-sessions/:id`, exactly like the desktop.
//!
//! Chat deliberately never goes through the `jobs` table or `dispatch::handle`,
//! so it cannot consume the pipeline `job.assigned` cap. It has its own
//! `chat_max_concurrent` budget (a semaphore owned by the daemon).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Semaphore};
use uuid::Uuid;

use crate::config::Config;
use crate::error::{Error, Result};
use crate::runner::claude_code::ClaudeCodeRunner;
use crate::runner::{JobSpec, Runner, RunnerEvent};
use crate::transport::agent_sessions::{self, SessionPatch};
use crate::transport::CoreClient;

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
    sem: Arc<Semaphore>,
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
        sem,
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
    sem: Arc<Semaphore>,
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
    run_turn(
        client,
        runner,
        sem,
        Turn {
            session_id: f.session_id,
            prompt,
            repo_path,
            project_slug: f.project_slug,
            // No system prompt on follow-ups — `--resume` keeps the original.
            system_prompt: None,
            model: None,
            resume_id: f.claude_session_id.filter(|s| !s.is_empty()),
            mcp_servers_override: f.mcp_servers_override,
            attachment_dir,
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

async fn run_turn(
    client: &CoreClient,
    runner: Arc<ClaudeCodeRunner>,
    sem: Arc<Semaphore>,
    turn: Turn,
) -> Result<()> {
    // Separate chat budget — never blocks on / consumes the pipeline cap.
    let _permit = sem
        .acquire_owned()
        .await
        .map_err(|e| Error::Other(format!("chat semaphore closed: {e}")))?;

    let session_id = turn.session_id.clone();
    tracing::info!(
        "[chat {session_id}] turn start (resume={})",
        turn.resume_id.is_some()
    );

    // Session key = sessionId so `agent:abort` → `runner.abort(sessionId)` hits
    // the right process. step="chat" / job_id=sessionId only label the run.
    let spec = JobSpec {
        job_id: session_id.clone(),
        project_id: String::new(),
        project_slug: turn.project_slug.clone(),
        issue_id: None,
        step: "chat".into(),
        repo_path: turn.repo_path.clone().into(),
        prompt: Some(turn.prompt.clone()),
        system_prompt: turn.system_prompt.clone(),
        model: turn.model.clone(),
        allowed_tools: None,
        disallowed_tools: None,
        permission_mode: None,
        timeout_seconds: None,
        mcp_servers_override: turn.mcp_servers_override.clone(),
        worktree_branch: None,
        resume_id: turn.resume_id.clone(),
        agent_session_id: Some(session_id.clone()),
    };

    let (tx, rx) = mpsc::channel::<RunnerEvent>(200);
    if let Err(e) = runner.start(spec, tx).await {
        let msg = format!("failed to start chat turn: {e}");
        tracing::error!("[chat {session_id}] {msg}");
        let _ = patch_failed(client, &session_id, &[], None, &msg).await;
        cleanup_attachments(turn.attachment_dir.as_deref()).await;
        return Ok(());
    }

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
                Some(RunnerEvent::Stdout(json)) => {
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
            };
            if let Err(e) = agent_sessions::patch_session(client, session_id, &patch).await {
                tracing::warn!("[chat {session_id}] final patch: {e}");
            } else {
                tracing::info!("[chat {session_id}] turn done");
            }
        }
        Some(Terminal::Failed(err)) => {
            let _ = patch_failed(client, session_id, &baseline, claude_sid.clone(), &err).await;
            tracing::info!("[chat {session_id}] turn failed: {err}");
        }
        None => {
            let _ = patch_failed(
                client,
                session_id,
                &baseline,
                claude_sid.clone(),
                "runner ended without a result",
            )
            .await;
        }
    }
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
