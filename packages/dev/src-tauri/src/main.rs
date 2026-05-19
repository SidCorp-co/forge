#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod claude_cli;
mod config;
mod devices;
mod env_path;
mod jobs;
mod keychain;
mod websocket;

use claude_cli::worktree::BranchDiff;
use claude_cli::{new_sessions, Sessions, WorktreeInfo};
use config::{
    AppConfig, McpServerConfig, SessionData, SessionMeta, SkillLibraryEntry, StrapiSkillData,
    StrapiSkillGuideData,
};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tokio::sync::{mpsc, watch, Mutex as TokioMutex};

/// Tauri event emitted to the React frontend when the OS hands us a
/// `forge-beta://...` URL — either at app launch (cold start) or while the
/// app is already running (forwarded by the single-instance plugin).
/// Frontend listens via `listen('deep-link://received', ...)`.
const DEEP_LINK_EVENT: &str = "deep-link://received";

struct AppState {
    sessions: Sessions,
    ws_cancel: Arc<TokioMutex<Option<watch::Sender<bool>>>>,
    /// Outbound WS frame sender — populated by `connect_ws`, drained by the
    /// Rust WS loop, written to by `ws_send`. Recreated on every connect so a
    /// reconnect drops any buffered frames (callers re-emit on `ws:connected`).
    ws_outbound: Arc<TokioMutex<Option<mpsc::UnboundedSender<String>>>>,
}

#[tauri::command]
async fn connect_ws(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
    device_token: Option<String>,
    device_id: Option<String>,
) -> Result<(), String> {
    // Cancel previous WS connection if any
    let mut guard = state.ws_cancel.lock().await;
    if let Some(old_tx) = guard.take() {
        let _ = old_tx.send(true);
    }
    let (tx, rx) = watch::channel(false);
    *guard = Some(tx);
    drop(guard);

    let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();
    {
        let mut out_guard = state.ws_outbound.lock().await;
        *out_guard = Some(out_tx);
    }

    tokio::spawn(websocket::connect_ws(
        app,
        url,
        device_token,
        device_id,
        rx,
        out_rx,
    ));
    Ok(())
}

#[tauri::command]
async fn ws_send(state: State<'_, AppState>, payload: String) -> Result<(), String> {
    let guard = state.ws_outbound.lock().await;
    match guard.as_ref() {
        Some(tx) => tx.send(payload).map_err(|e| e.to_string()),
        None => Err("ws not connected".to_string()),
    }
}

#[tauri::command]
fn load_device_token() -> Result<Option<String>, String> {
    keychain::load()
}

#[tauri::command]
fn clear_device_token() -> Result<(), String> {
    keychain::clear()
}

// === User JWT — stored in OS keychain, not config.json (ADR 0004 / ISS-214 §5).
// Persists across reloads so users don't re-login on every launch.

#[tauri::command]
fn store_user_jwt(token: String) -> Result<(), String> {
    keychain::store_jwt(&token)
}

#[tauri::command]
fn load_user_jwt() -> Result<Option<String>, String> {
    keychain::load_jwt()
}

#[tauri::command]
fn clear_user_jwt() -> Result<(), String> {
    keychain::clear_jwt()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PairDeviceResponse {
    device_id: String,
    project_id: Option<String>,
}

#[tauri::command]
async fn pair_device(
    core_url: String,
    code: String,
    name: String,
) -> Result<PairDeviceResponse, String> {
    let platform = devices::detected_platform();
    let agent_version = Some(env!("CARGO_PKG_VERSION"));
    let pair = devices::pair(&core_url, &code, &name, platform, agent_version).await?;
    keychain::store(&pair.device_token)?;
    Ok(PairDeviceResponse {
        device_id: pair.device_id,
        project_id: pair.project_id,
    })
}

#[tauri::command]
async fn heartbeat(core_url: String, device_token: String) -> Result<(), String> {
    devices::heartbeat(&core_url, &device_token, Some(env!("CARGO_PKG_VERSION"))).await
}

#[tauri::command]
async fn post_job_events(
    core_url: String,
    device_token: String,
    job_id: String,
    events: Vec<jobs::JobEventInput>,
) -> Result<usize, String> {
    jobs::post_job_events(&core_url, &device_token, &job_id, events).await
}

#[tauri::command]
async fn run_agent(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    prompt: String,
    project_slug: Option<String>,
    permission_mode: Option<String>,
    mcp_servers: Option<serde_json::Value>,
    worktree_branch: Option<String>,
    system_prompt: Option<String>,
    skill: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    claude_cli::run_agent(
        app,
        state.sessions.clone(),
        repo_path,
        prompt,
        project_slug,
        permission_mode,
        mcp_servers,
        worktree_branch,
        system_prompt,
        skill,
        model,
    )
    .await
}

#[tauri::command]
async fn abort_agent(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    claude_cli::abort_agent(app, state.sessions.clone(), &session_id).await
}

#[tauri::command]
async fn get_agent_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<claude_cli::AgentStatus, String> {
    claude_cli::get_status(state.sessions.clone(), &session_id).await
}

#[tauri::command]
async fn get_claude_session_id(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<String>, String> {
    claude_cli::get_claude_session_id(state.sessions.clone(), &session_id).await
}

#[tauri::command]
async fn open_terminal(
    repo_path: String,
    system_prompt: Option<String>,
    claude_session_id: Option<String>,
) -> Result<(), String> {
    claude_cli::open_terminal(repo_path, system_prompt, claude_session_id).await
}

#[tauri::command]
async fn send_chat(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    message: String,
    session_id: String,
    claude_session_id: Option<String>,
    project_slug: Option<String>,
    permission_mode: Option<String>,
    mcp_servers: Option<serde_json::Value>,
    worktree_branch: Option<String>,
    system_prompt: Option<String>,
    skill: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    claude_cli::send_chat(
        app,
        state.sessions.clone(),
        repo_path,
        message,
        session_id,
        claude_session_id,
        project_slug,
        permission_mode,
        mcp_servers,
        worktree_branch,
        system_prompt,
        skill,
        model,
    )
    .await
}

#[tauri::command]
async fn start_session(
    repo_path: String,
    branch_name: String,
    selected_issues: Vec<claude_cli::SelectedIssue>,
    selected_tasks: Vec<claude_cli::SelectedTask>,
    forge_url: String,
    forge_token: String,
    project_slug: String,
) -> Result<(), String> {
    claude_cli::start_session(
        repo_path,
        branch_name,
        selected_issues,
        selected_tasks,
        forge_url,
        forge_token,
        project_slug,
    )
    .await
}

#[tauri::command]
fn fe_log(msg: String) {
    claude_cli::log_pub(&msg);
}

#[tauri::command]
fn get_config() -> AppConfig {
    config::load_config()
}

#[tauri::command]
fn save_config(config: AppConfig) -> Result<(), String> {
    config::save_config(&config)
}

#[tauri::command]
fn list_sessions(slug: Option<String>) -> Vec<SessionMeta> {
    config::list_sessions(slug)
}

#[tauri::command]
fn save_session_cmd(data: SessionData) -> Result<(), String> {
    config::save_session(&data)
}

#[tauri::command]
fn load_session(id: String) -> Result<SessionData, String> {
    config::load_session(&id)
}

#[tauri::command]
fn delete_session(id: String) -> Result<(), String> {
    config::delete_session(&id)
}

#[tauri::command]
fn detect_mcp_servers(repo_path: String) -> std::collections::HashMap<String, McpServerConfig> {
    config::detect_mcp_servers(&repo_path)
}

#[tauri::command]
fn read_knowledge_index(repo_path: String) -> Option<serde_json::Value> {
    config::read_knowledge_index(&repo_path)
}

#[tauri::command]
fn read_conventions(repo_path: String) -> Option<String> {
    config::read_conventions(&repo_path)
}

#[tauri::command]
fn read_agent_files(repo_path: String, agent_type: String) -> serde_json::Value {
    config::read_agent_files(&repo_path, &agent_type)
}

#[tauri::command]
fn seed_agent_files(
    repo_path: String,
    agent_type: String,
    knowledge: Option<String>,
    memory: Option<String>,
) -> Result<(), String> {
    config::seed_agent_files(
        &repo_path,
        &agent_type,
        knowledge.as_deref(),
        memory.as_deref(),
    )
}

#[tauri::command]
fn install_mcp_to_cli(
    name: String,
    server: McpServerConfig,
    repo_path: String,
    target: Option<String>,
    custom_path: Option<String>,
) -> Result<(), String> {
    // Default to claude-cli so older renderer builds that pre-date the
    // multi-target picker keep working unchanged.
    let target = target.as_deref().unwrap_or("claude-cli");
    config::install_mcp_to_cli(&name, &server, &repo_path, target, custom_path.as_deref())
}

// Skills — execution only (UI managed via web app)
// All async so they run on Tauri's threadpool, not blocking the main/UI thread.

#[tauri::command]
async fn install_skill_from_strapi(data: StrapiSkillData) -> Result<SkillLibraryEntry, String> {
    tokio::task::spawn_blocking(move || config::install_skill_from_strapi(data))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn install_skill_guide(data: StrapiSkillGuideData) -> Result<SkillLibraryEntry, String> {
    tokio::task::spawn_blocking(move || config::install_skill_guide(data))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_skill_hashes() -> Result<std::collections::HashMap<String, String>, String> {
    tokio::task::spawn_blocking(config::get_skill_hashes)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn refresh_enabled_skills() -> Result<config::SkillSyncLog, String> {
    tokio::task::spawn_blocking(config::refresh_enabled_skills)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn library_skill_body_ok(name: String) -> bool {
    config::library_skill_body_ok(&name)
}

#[tauri::command]
async fn read_sync_log() -> Result<Option<config::SkillSyncLog>, String> {
    tokio::task::spawn_blocking(config::read_sync_log)
        .await
        .map_err(|e| e.to_string())
}

// ISS-278 conflict-resolution commands. The dialog calls these in response to
// `skill-conflict` events emitted by the JS sync layer.

#[tauri::command]
async fn force_install_skill_to_project(slug: String, name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || config::force_install_skill_to_project(slug, name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn accept_local_skill(slug: String, name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || config::accept_local_skill(slug, name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn clear_skill_local_override(slug: String, name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || config::clear_skill_local_override(slug, name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_skill_state() -> Result<config::skill_state::SkillState, String> {
    tokio::task::spawn_blocking(config::get_skill_state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_library_mcp() -> std::collections::HashMap<String, McpServerConfig> {
    config::list_library_mcp()
}

#[tauri::command]
fn add_library_mcp(name: String, mcp_config: McpServerConfig) -> Result<(), String> {
    config::add_library_mcp(name, mcp_config)
}

#[tauri::command]
fn remove_library_mcp(name: String) -> Result<(), String> {
    config::remove_library_mcp(name)
}

#[tauri::command]
fn toggle_mcp(project_slug: String, name: String, enabled: bool) -> Result<(), String> {
    config::toggle_mcp(project_slug, name, enabled)
}

#[tauri::command]
fn get_hostname() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "Desktop".to_string())
}

#[tauri::command]
fn get_homedir() -> String {
    dirs_next::home_dir()
        .map(|p: std::path::PathBuf| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Get the WSL home directory as a Windows UNC path (\\wsl.localhost\<distro>\home\<user>).
/// Returns empty string if WSL is not available.
#[tauri::command]
fn get_wsl_home() -> String {
    claude_cli::platform::wsl_home()
        .map(|h| claude_cli::platform::to_windows_path(&h))
        .unwrap_or_default()
}

#[tauri::command]
async fn ensure_directory(path: String) -> Result<(), String> {
    // Sanitize: strip newlines, NULs, and surrounding whitespace
    let clean_path = path
        .replace('\n', "")
        .replace('\r', "")
        .replace('\0', "")
        .trim()
        .to_string();
    tokio::fs::create_dir_all(&clean_path)
        .await
        .map_err(|e| format!("Failed to create directory {}: {}", clean_path, e))
}

#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder.map(|f| f.to_string()));
    });
    rx.await.map_err(|_| "Dialog cancelled".to_string())
}

#[tauri::command]
async fn create_worktree(repo_path: String, branch_name: String) -> Result<String, String> {
    claude_cli::worktree::create_worktree(&repo_path, &branch_name).await
}

#[tauri::command]
async fn remove_worktree(repo_path: String, branch_name: String) -> Result<(), String> {
    claude_cli::worktree::remove_worktree(&repo_path, &branch_name).await
}

#[tauri::command]
async fn list_worktrees(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
    claude_cli::worktree::list_worktrees(&repo_path).await
}

#[tauri::command]
async fn cleanup_merged_worktrees(
    repo_path: String,
    main_branch: String,
) -> Result<Vec<String>, String> {
    claude_cli::worktree::cleanup_merged_worktrees(&repo_path, &main_branch).await
}

#[tauri::command]
async fn get_branch_diff(
    repo_path: String,
    branch: String,
    base: String,
) -> Result<BranchDiff, String> {
    claude_cli::worktree::get_branch_diff(&repo_path, &branch, &base).await
}

fn main() {
    // Inherit the user's real PATH from their login shell before anything
    // else spawns subprocesses. macOS/Linux GUI launches start with a
    // minimal PATH that misses Homebrew, nvm, ~/.local/bin, etc., so
    // `Command::new("claude")` (and git, gh) would ENOENT. This call is
    // a no-op on Windows. See env_path.rs for the full rationale.
    env_path::fix_gui_path();

    // Opt-in Sentry init. `option_env!` reads at compile time — official
    // release builds set FORGE_SENTRY_DSN_RUST in CI, source builds leave it
    // unset and the guard returns None so the SDK never attaches. The
    // returned `_guard` must outlive `main` for events to flush on panic.
    let _sentry_guard = option_env!("FORGE_SENTRY_DSN_RUST")
        .filter(|s| !s.is_empty())
        .map(|dsn| {
            sentry::init((
                dsn,
                sentry::ClientOptions {
                    release: Some(env!("CARGO_PKG_VERSION").into()),
                    environment: Some(if cfg!(debug_assertions) {
                        "development".into()
                    } else {
                        "production".into()
                    }),
                    send_default_pii: false,
                    attach_stacktrace: true,
                    ..Default::default()
                },
            ))
        });

    tauri::Builder::default()
        // single-instance MUST be first per Tauri docs. With the `deep-link`
        // feature the secondary process forwards its launch URL into the
        // primary so the running window receives the OAuth callback —
        // otherwise on Windows / Linux a fresh process would pick up the
        // URL while the user's existing window stays unauthed.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // single-instance with deep-link feature passes the URL as an arg.
            for arg in args.iter().skip(1) {
                if arg.starts_with("forge-beta://") {
                    let _ = app.emit(DEEP_LINK_EVENT, arg);
                }
            }
            // Also wake the primary window so the user sees the result.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
                let _ = w.unminimize();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Linux + Windows dev mode: register the URL scheme at runtime
            // (production installers register via .desktop file / NSIS).
            // No-op on macOS, where the OS handles registration via Info.plist.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                if let Err(e) = app.deep_link().register("forge-beta") {
                    eprintln!("deep-link register error: {e}");
                }
            }

            // Stream incoming URLs to the frontend. on_open_url fires for both
            // cold-start (launch via URL) and warm runs (single-instance fan-in
            // already covered above; this handler additionally covers macOS,
            // where single-instance args are not used).
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let _ = app_handle.emit(DEEP_LINK_EVENT, url.as_str());
                }
            });

            Ok(())
        })
        .manage(AppState {
            sessions: new_sessions(),
            ws_cancel: Arc::new(TokioMutex::new(None)),
            ws_outbound: Arc::new(TokioMutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            connect_ws,
            ws_send,
            load_device_token,
            clear_device_token,
            store_user_jwt,
            load_user_jwt,
            clear_user_jwt,
            pair_device,
            heartbeat,
            post_job_events,
            run_agent,
            abort_agent,
            get_agent_status,
            get_claude_session_id,
            open_terminal,
            send_chat,
            start_session,
            fe_log,
            get_config,
            save_config,
            list_sessions,
            save_session_cmd,
            load_session,
            delete_session,
            detect_mcp_servers,
            read_knowledge_index,
            read_conventions,
            read_agent_files,
            seed_agent_files,
            install_mcp_to_cli,
            install_skill_from_strapi,
            install_skill_guide,
            get_skill_hashes,
            refresh_enabled_skills,
            library_skill_body_ok,
            read_sync_log,
            force_install_skill_to_project,
            accept_local_skill,
            clear_skill_local_override,
            get_skill_state,
            list_library_mcp,
            add_library_mcp,
            remove_library_mcp,
            toggle_mcp,
            create_worktree,
            remove_worktree,
            list_worktrees,
            cleanup_merged_worktrees,
            get_branch_diff,
            get_hostname,
            get_homedir,
            get_wsl_home,
            ensure_directory,
            pick_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
