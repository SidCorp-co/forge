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

/// Forge system preamble appended to the default Claude CLI system prompt.
/// Two variants:
/// - `FORGE_SYSTEM_PREAMBLE_CHAT`: used for manual chat sessions where no
///   project context has been pre-loaded. Tells the agent to call
///   forge_config get_knowledge for orientation.
/// - `FORGE_SYSTEM_PREAMBLE_PIPELINE`: used for pipeline sessions where Strapi
///   has already inlined knowledge + conventions + PIPELINE_RULES via the
///   `system_prompt` parameter. Does NOT nudge the agent to call get_knowledge,
///   because the data is already in the system prompt.
const FORGE_SYSTEM_PREAMBLE_CHAT: &str = "\
You are working in a Forge-managed project. \
Forge MCP tools are available for project management: \
forge_issues, forge_comments, forge_config, forge_memory, forge_coolify_deploy, forge_projects. \
Use them when the request relates to issues, tasks, or project status.\n\n\
For codebase orientation, call forge_config with action 'get_knowledge' before exploring with search tools — \
it returns pre-indexed context (architecture, key files, conventions).";

const FORGE_SYSTEM_PREAMBLE_PIPELINE: &str = "\
You are working in a Forge-managed project. \
Forge MCP tools are available for project management: \
forge_issues, forge_comments, forge_config, forge_memory, forge_coolify_deploy, forge_projects. \
Use them when the request relates to issues, tasks, or project status.";

/// Per-skill allowed-tools whitelist. Applied only to skills with a provably
/// bounded tool set — forge-triage, forge-staging, forge-release. Returning None
/// means "no whitelist, CLI default applies" (which lets all tools through).
fn allowed_tools_for(skill: &str) -> Option<&'static str> {
    match skill {
        "forge-triage" => Some("mcp__forge__forge_issues,mcp__forge__forge_comments,mcp__forge__forge_memory"),
        "forge-staging" | "forge-release" => Some(
            "Bash,mcp__forge__forge_issues,mcp__forge__forge_comments,mcp__forge__forge_config,mcp__forge__forge_coolify_deploy",
        ),
        _ => None,
    }
}

/// Build the base CLI args with optional system prompt, allowed-tools whitelist, and model override.
/// Returns owned `Vec<String>` because the combined system prompt is dynamic.
fn build_base_args(
    permission_mode: Option<&str>,
    system_prompt: Option<&str>,
    skill: Option<&str>,
    model: Option<&str>,
) -> Vec<String> {
    let mode = permission_mode.unwrap_or("bypassPermissions");

    // Combine the static Forge preamble with any pipeline-specific system prompt
    // (knowledge + conventions + PIPELINE_RULES) into one --append-system-prompt.
    // When Strapi provides a pipeline system_prompt, use the pipeline variant
    // (no "call get_knowledge" nudge). Otherwise it's a manual chat — use the
    // chat variant which tells the agent to fetch project context itself.
    let combined_system = match system_prompt {
        Some(sp) if !sp.is_empty() => format!("{}\n\n{}", FORGE_SYSTEM_PREAMBLE_PIPELINE, sp),
        _ => FORGE_SYSTEM_PREAMBLE_CHAT.to_string(),
    };

    // Debug: log the exact --append-system-prompt payload so operators can
    // inspect what reached the CLI. Logs length + full body to the Tauri log.
    log(&format!(
        "[build_base_args] --append-system-prompt ({} chars):\n{}",
        combined_system.len(),
        combined_system,
    ));

    let mut args: Vec<String> = vec![
        "--output-format".into(), "stream-json".into(), "--verbose".into(),
        "--permission-mode".into(), mode.into(),
        "--append-system-prompt".into(), combined_system,
    ];

    // Scoped tool whitelist — only for skills with a bounded tool set.
    if let Some(s) = skill {
        if let Some(tools) = allowed_tools_for(s) {
            args.push("--allowed-tools".into());
            args.push(tools.into());
        }
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
    let path = write_mcp_config(&cfg.strapi_url, &cfg.auth_token, project_slug, mcp_servers)?;
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
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    log(&format!("[run_agent] repo_path={repo_path} slug={project_slug:?} worktree_branch={worktree_branch:?} skill={skill:?} model={model:?}"));

    let (effective_repo, wt_path) = resolve_worktree(&repo_path, worktree_branch.as_deref()).await?;

    let mut args = build_base_args(
        permission_mode.as_deref(),
        system_prompt.as_deref(),
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
    spawn_and_stream(app, sessions, &arg_refs, &effective_repo, session_id.clone(), mcp_temp_path, wt_path).await?;
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
) -> Result<(), String> {
    log(&format!("[send_chat] session={session_id}, slug={project_slug:?} worktree_branch={worktree_branch:?} skill={skill:?} model={model:?} resuming={}", claude_session_id.is_some()));

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

    // For resume (claude_session_id is Some), the Claude CLI reuses the prior
    // session's system prompt, tool whitelist, and model. Re-passing those flags
    // may be rejected or reset state, so we skip them and only pass --resume + -p.
    let is_resume = claude_session_id.is_some();
    let mut args = if is_resume {
        build_base_args(permission_mode.as_deref(), None, None, None)
    } else {
        build_base_args(
            permission_mode.as_deref(),
            system_prompt.as_deref(),
            skill.as_deref(),
            model.as_deref(),
        )
    };

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
    spawn_and_stream(app, sessions, &arg_refs, &effective_repo, session_id, mcp_temp_path, wt_path).await
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

