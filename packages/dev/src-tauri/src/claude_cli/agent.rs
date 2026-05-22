use super::{log, AgentStatus, Sessions};
use super::mcp::write_mcp_config;
use super::spawn::{graceful_kill, spawn_and_stream};
use super::worktree;
#[cfg(target_os = "windows")]
use super::spawn::to_wsl_path;
use crate::config;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

/// Per-skill allowed-tools whitelist. Applied only to skills with a provably
/// bounded tool set — forge-triage, forge-staging, forge-release. Returning None
/// means "no whitelist, CLI default applies" (which lets all tools through).
///
/// Note: server-side `appConfig.pipeline.states[state].allowedTools` can also
/// override this — the server passes its choice via the `skill` parameter
/// resolving to a different whitelist, OR via passing the literal list. For
/// now this stays as a static map; PR-4b adds the override plumbing.
fn allowed_tools_for(skill: &str) -> Option<&'static str> {
    match skill {
        "forge-triage" => Some("mcp__forge__forge_issues,mcp__forge__forge_comments,mcp__forge__forge_memory"),
        "forge-staging" | "forge-release" => Some(
            "Bash,mcp__forge__forge_issues,mcp__forge__forge_comments,mcp__forge__forge_config,mcp__forge__forge_coolify_deploy",
        ),
        _ => None,
    }
}

/// Build the base CLI args. `system_prompt` is forwarded verbatim from the
/// server (built by `@forge/core` `src/prompt/system.ts`) — Rust no longer
/// owns any prompt content. When `system_prompt` is empty or None, the CLI
/// runs with no `--append-system-prompt` flag, matching the bare interactive
/// `claude` invocation.
fn build_base_args(
    permission_mode: Option<&str>,
    system_prompt: Option<&str>,
    allowed_tools_override: Option<&str>,
    skill: Option<&str>,
    model: Option<&str>,
) -> Vec<String> {
    let mode = permission_mode.unwrap_or("bypassPermissions");

    let mut args: Vec<String> = vec![
        "--output-format".into(), "stream-json".into(), "--verbose".into(),
        "--permission-mode".into(), mode.into(),
    ];

    // Forward the server-built system prompt as-is (empty string suppresses
    // the flag — matches bare `claude` interactive behavior).
    if let Some(sp) = system_prompt {
        if !sp.is_empty() {
            // Debug log so operators can inspect exactly what reached the CLI.
            log(&format!(
                "[build_base_args] --append-system-prompt ({} chars)",
                sp.len(),
            ));
            args.push("--append-system-prompt".into());
            args.push(sp.to_string());
        }
    }

    // Tool whitelist precedence: explicit server override > per-skill default.
    let allowed = allowed_tools_override
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| skill.and_then(allowed_tools_for).map(|s| s.to_string()));
    if let Some(tools) = allowed {
        args.push("--allowed-tools".into());
        args.push(tools);
    }

    // Model override (e.g. sonnet for forge-code).
    if let Some(m) = model {
        if !m.is_empty() {
            args.push("--model".into());
            args.push(m.into());
        }
    }

    args
}

/// Resolve MCP servers into a temp config file and return (config_path_string, original_path).
/// Always includes the built-in Forge MCP server with the given project slug.
fn resolve_mcp_config(project_slug: &str, mcp_servers: Option<&Value>) -> Result<(Option<String>, Option<std::path::PathBuf>), String> {
    let cfg = config::load_config();
    // Forge MCP server now auths via device token (ISS-202 → `requireDevice()`);
    // pre-Phase-2.7 it used a user JWT read from config.auth_token. Token is
    // now sourced from the OS keychain — if not yet paired, fall back to an
    // empty string; the MCP server will reject the request and the UI will
    // surface the pair prompt.
    let device_token = crate::keychain::load().ok().flatten().unwrap_or_default();
    let path = write_mcp_config(&cfg.core_url, &device_token, project_slug, mcp_servers)?;
    let path_str = {
        #[cfg(target_os = "windows")]
        {
            let claude_mode = cfg.claude_mode.as_deref().unwrap_or("auto");
            let use_native = match claude_mode {
                "native" => true,
                "wsl" => false,
                _ => !super::spawn::has_wsl_claude() && super::spawn::has_native_claude(),
            };
            if use_native {
                // Native Windows claude needs a Windows path
                path.to_string_lossy().to_string()
            } else {
                to_wsl_path(&path.to_string_lossy())
            }
        }
        #[cfg(not(target_os = "windows"))]
        { path.to_string_lossy().to_string() }
    };
    Ok((Some(path_str), Some(path)))
}

/// Resolve the effective repo path: if a worktree branch is given, create/reuse a worktree.
async fn resolve_worktree(repo_path: &str, worktree_branch: Option<&str>) -> Result<(String, Option<String>), String> {
    if let Some(branch) = worktree_branch {
        let wt_path = worktree::create_worktree(repo_path, branch).await?;
        Ok((wt_path.clone(), Some(wt_path)))
    } else {
        Ok((repo_path.to_string(), None))
    }
}

pub async fn run_agent(
    app: AppHandle,
    sessions: Sessions,
    repo_path: String,
    prompt: String,
    project_slug: Option<String>,
    permission_mode: Option<String>,
    mcp_servers: Option<Value>,
    worktree_branch: Option<String>,
    system_prompt: Option<String>,
    skill: Option<String>,
    model: Option<String>,
    allowed_tools: Option<String>,
    timeout_seconds: Option<u64>,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    log(&format!("[run_agent] repo_path={repo_path} slug={project_slug:?} worktree_branch={worktree_branch:?} skill={skill:?} model={model:?} timeout_seconds={timeout_seconds:?}"));

    let (effective_repo, wt_path) = resolve_worktree(&repo_path, worktree_branch.as_deref()).await?;

    let mut args = build_base_args(
        permission_mode.as_deref(),
        system_prompt.as_deref(),
        allowed_tools.as_deref(),
        skill.as_deref(),
        model.as_deref(),
    );
    let slug = project_slug.as_deref().unwrap_or("");
    let (mcp_path_str, mcp_temp_path) = resolve_mcp_config(slug, mcp_servers.as_ref())?;
    if let Some(p) = mcp_path_str {
        args.push("--mcp-config".into());
        args.push(p);
    }
    args.push("-p".into());
    args.push(prompt);

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    spawn_and_stream(app, sessions, &arg_refs, &effective_repo, session_id.clone(), mcp_temp_path, wt_path, timeout_seconds).await?;
    Ok(session_id)
}

pub async fn send_chat(
    app: AppHandle,
    sessions: Sessions,
    repo_path: String,
    message: String,
    session_id: String,
    claude_session_id: Option<String>,
    project_slug: Option<String>,
    permission_mode: Option<String>,
    mcp_servers: Option<Value>,
    worktree_branch: Option<String>,
    system_prompt: Option<String>,
    skill: Option<String>,
    model: Option<String>,
    allowed_tools: Option<String>,
    timeout_seconds: Option<u64>,
) -> Result<(), String> {
    log(&format!("[send_chat] session={session_id}, slug={project_slug:?} worktree_branch={worktree_branch:?} skill={skill:?} model={model:?} timeout_seconds={timeout_seconds:?} resuming={}", claude_session_id.is_some()));

    // If a CLI process is already running for this session, kill it before starting a new one.
    // This prevents orphaned processes when pipeline triggers overlap with manual sends.
    {
        let mut s = sessions.lock().await;
        if let Some(existing) = s.get_mut(&session_id) {
            if existing.status == AgentStatus::Running {
                log(&format!("[send_chat] session={session_id} already running, killing old process"));
                if let Some(mut child) = existing.child.take() {
                    graceful_kill(&mut child).await;
                }
                s.remove(&session_id);
            }
        }
    }

    let (effective_repo, wt_path) = resolve_worktree(&repo_path, worktree_branch.as_deref()).await?;

    // Always pass full flags — including on --resume. CLI behavior with
    // override flags on resume is undocumented; server-side embeds the state's
    // own system prompt redundantly as turn-level rules in the user prompt
    // body (see core/src/prompt/user.ts `turnLevelSystemPrompt`) so the agent
    // sees the right rules whether or not the CLI honors --append-system-prompt
    // on resume.
    let mut args = build_base_args(
        permission_mode.as_deref(),
        system_prompt.as_deref(),
        allowed_tools.as_deref(),
        skill.as_deref(),
        model.as_deref(),
    );

    let slug = project_slug.as_deref().unwrap_or("");
    let (mcp_path_str, mcp_temp_path) = resolve_mcp_config(slug, mcp_servers.as_ref())?;
    if let Some(p) = mcp_path_str {
        args.push("--mcp-config".into());
        args.push(p);
    }
    if let Some(cid) = claude_session_id {
        args.push("--resume".into());
        args.push(cid);
    }
    args.push("-p".into());
    args.push(message);

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    spawn_and_stream(app, sessions, &arg_refs, &effective_repo, session_id, mcp_temp_path, wt_path, timeout_seconds).await
}

pub async fn abort_agent(app: AppHandle, sessions: Sessions, session_id: &str) -> Result<(), String> {
    let mut s = sessions.lock().await;
    if let Some(session) = s.get_mut(session_id) {
        if let Some(mut child) = session.child.take() {
            graceful_kill(&mut child).await;
        }
        session.status = AgentStatus::Failed;
        let _ = app.emit("agent:complete", serde_json::json!({
            "sessionId": session_id,
            "error": Some("Agent aborted by user"),
        }));
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

pub async fn get_status(sessions: Sessions, session_id: &str) -> Result<AgentStatus, String> {
    let s = sessions.lock().await;
    s.get(session_id)
        .map(|sess| sess.status.clone())
        .ok_or_else(|| "Session not found".to_string())
}

pub async fn get_claude_session_id(sessions: Sessions, session_id: &str) -> Result<Option<String>, String> {
    let s = sessions.lock().await;
    s.get(session_id)
        .map(|sess| sess.claude_session_id.clone())
        .ok_or_else(|| "Session not found".to_string())
}

