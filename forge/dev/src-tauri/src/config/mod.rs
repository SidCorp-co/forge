use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

mod sessions;
mod mcp;
mod skills;
pub(crate) mod wsl;

// Re-export public items from submodules
pub use sessions::{SessionMeta, SessionData, list_sessions, save_session, load_session, delete_session};
pub use mcp::{detect_mcp_servers, read_knowledge_index, read_conventions, read_agent_files, seed_agent_files, install_mcp_to_cli, list_library_mcp, add_library_mcp, remove_library_mcp, toggle_mcp};
pub use skills::{install_skill_from_strapi, install_skill_guide, StrapiSkillData, StrapiSkillGuideData, get_skill_hashes, refresh_enabled_skills, read_sync_log, SkillSyncLog};

// ── Atomic file write (write to .tmp then rename) ──

pub(crate) fn atomic_write(path: &std::path::Path, data: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    if let Some(parent) = tmp.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ── Skill & MCP library structs ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLibraryEntry {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subfolder: Option<String>,
    pub source_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(default = "default_skill_type")]
    pub skill_type: String,
}

fn default_skill_type() -> String { "full".to_string() }



#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    // Local stdio server
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    // Remote HTTP server
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub server_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    // Common
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoConfig {
    pub name: String,
    pub path: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub slug: String,
    pub repo_path: String,
    pub branch: Option<String>,
    pub instructions: Option<String>,
    pub repos: Option<Vec<RepoConfig>>,
    pub mcp_servers: Option<HashMap<String, McpServerConfig>>,
    #[serde(default)]
    pub enabled_skills: Option<Vec<String>>,
    #[serde(default)]
    pub enabled_mcp_servers: Option<Vec<String>>,
}

/// Legacy AppConfig shape used by pre-Phase-2.7 installs. Loaded permissively
/// then converted to `AppConfig` on read; the Strapi-era `authToken` is
/// dropped (user JWT has no home on-disk; device auth lives in the keychain).
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct LegacyAppConfig {
    #[serde(alias = "strapiUrl")]
    core_url: Option<String>,
    /// Accepted for backwards-compat; dropped on load (secret does not belong
    /// on disk in plaintext — ADR 0004).
    #[allow(dead_code)]
    auth_token: Option<String>,
    device_id: Option<String>,
    projects_root: Option<String>,
    claude_mode: Option<String>,
    projects: HashMap<String, ProjectConfig>,
    skill_library: Option<HashMap<String, SkillLibraryEntry>>,
    mcp_library: Option<HashMap<String, McpServerConfig>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// URL of `forge/core` (the Hono+Drizzle backend). Replaces the
    /// pre-Phase-2.7 `strapiUrl` field; legacy configs are migrated on load.
    pub core_url: String,
    /// Kept in-memory for legacy code paths (login page, pre-Phase-2.7
    /// helpers). Never persisted — `save_config` skips it when empty, and
    /// `load_config` drops it on read. Device-scoped auth lives in the OS
    /// keychain (ADR 0004 / ISS-214 §5).
    #[serde(default, skip_serializing)]
    pub auth_token: String,
    /// Non-secret device identifier assigned by the server at pair time.
    /// The actual device token lives in the OS keychain (ADR 0004).
    #[serde(default)]
    pub device_id: String,
    /// Parent directory for auto-created project folders (e.g. ~/forge-projects)
    #[serde(default)]
    pub projects_root: Option<String>,
    /// Claude CLI mode: "native" (Windows only), "wsl" (WSL only), or "auto" (default: prefer native, fall back to WSL)
    #[serde(default)]
    pub claude_mode: Option<String>,
    pub projects: HashMap<String, ProjectConfig>,
    #[serde(default)]
    pub skill_library: Option<HashMap<String, SkillLibraryEntry>>,
    #[serde(default)]
    pub mcp_library: Option<HashMap<String, McpServerConfig>>,
}

impl AppConfig {
    fn from_legacy(legacy: LegacyAppConfig) -> Self {
        let core_url = legacy
            .core_url
            .unwrap_or_else(|| "http://localhost:1337".to_string());
        Self {
            core_url,
            // Legacy auth_token is intentionally dropped on load — the user
            // JWT does not belong on disk. Runtime code will re-populate via
            // the login flow if still used.
            auth_token: String::new(),
            device_id: legacy
                .device_id
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            projects_root: legacy.projects_root,
            claude_mode: legacy.claude_mode,
            projects: legacy.projects,
            skill_library: legacy.skill_library,
            mcp_library: legacy.mcp_library,
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            core_url: "http://localhost:1337".to_string(),
            auth_token: String::new(),
            device_id: uuid::Uuid::new_v4().to_string(),
            projects_root: None,
            claude_mode: None,
            projects: HashMap::new(),
            skill_library: None,
            mcp_library: None,
        }
    }
}

fn config_path() -> PathBuf {
    let mut path = dirs_next::config_dir().unwrap_or_else(|| {
        eprintln!("[config] WARNING: config_dir() returned None, falling back to current directory");
        PathBuf::from(".")
    });
    path.push("forge-dev");
    fs::create_dir_all(&path).ok();
    path.push("config.json");
    path
}

pub fn load_config() -> AppConfig {
    let path = config_path();
    let mut config = match fs::read_to_string(&path) {
        Ok(data) => match serde_json::from_str::<LegacyAppConfig>(&data) {
            Ok(legacy) => {
                if legacy.auth_token.is_some() {
                    eprintln!(
                        "[config] dropping legacy authToken on load — credentials belong in the OS keychain"
                    );
                }
                AppConfig::from_legacy(legacy)
            }
            Err(_) => AppConfig::default(),
        },
        Err(_) => AppConfig::default(),
    };
    // Ensure device_id is always set (backfill for existing configs)
    if config.device_id.is_empty() {
        config.device_id = uuid::Uuid::new_v4().to_string();
        save_config(&config).ok();
    }
    config
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path();
    let data = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    atomic_write(&path, &data)
}
