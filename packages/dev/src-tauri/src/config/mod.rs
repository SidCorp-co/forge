use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

mod sessions;
mod mcp;
mod skills;
pub(crate) mod merge;
pub(crate) mod skill_state;
pub(crate) mod wsl;

// Re-export public items from submodules
pub use sessions::{SessionMeta, SessionData, list_sessions, save_session, load_session, delete_session};
pub use mcp::{detect_mcp_servers, read_knowledge_index, read_conventions, read_agent_files, seed_agent_files, install_mcp_to_cli, list_library_mcp, add_library_mcp, remove_library_mcp, toggle_mcp};
pub use skills::{install_skill_from_strapi, install_skill_guide, StrapiSkillData, StrapiSkillGuideData, get_skill_hashes, refresh_enabled_skills, read_sync_log, SkillSyncLog, force_install_skill_to_project, accept_local_skill, clear_skill_local_override, get_skill_state, library_skill_body_ok, copy_dir_recursive};

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
    /// URL of `packages/core` (the Hono+Drizzle backend). Replaces the
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

/// Build-time default for `coreUrl`. Official release artifacts bake the
/// production API origin via the CI variable `FORGE_DEFAULT_CORE_URL`
/// (forwarded to the build env in `.github/workflows/release.yml`).
/// Source builds without the var fall back to the Strapi dev port so
/// `npm run tauri dev` keeps working out of the box.
fn default_core_url() -> String {
    option_env!("FORGE_DEFAULT_CORE_URL")
        .filter(|s| !s.is_empty())
        .unwrap_or("http://localhost:1337")
        .to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            core_url: default_core_url(),
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
    // Renamed from `forge-dev` to `forge-beta` so this build coexists with the
    // legacy stable Forge binary (which keeps writing `~/.config/forge-dev/`).
    path.push("forge-beta");
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
    save_config_at(&config_path(), config)
}

/// Read-modify-write save: load the on-disk JSON, deep-merge the snapshot
/// over it, write atomically. Keys present on disk but absent from the
/// snapshot survive (see ISS-282 — users hand-edit `config.json` and the
/// previous snapshot-overwrite obliterated those edits).
///
/// Corrupt JSON is backed up to `config.json.corrupt-<unix_ts>` and treated
/// as an empty object so we never silently lose user data.
pub(crate) fn save_config_at(path: &std::path::Path, config: &AppConfig) -> Result<(), String> {
    let mut existing = match fs::read_to_string(path) {
        Ok(data) => match serde_json::from_str::<serde_json::Value>(&data) {
            Ok(v) if v.is_object() => v,
            Ok(_) => serde_json::Value::Object(Default::default()),
            Err(e) => {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let backup = path.with_file_name(format!(
                    "{}.corrupt-{ts}",
                    path.file_name().and_then(|s| s.to_str()).unwrap_or("config.json")
                ));
                eprintln!(
                    "[config] existing config is not valid JSON ({e}); backing up to {} and starting fresh",
                    backup.display()
                );
                let _ = fs::rename(path, &backup);
                serde_json::Value::Object(Default::default())
            }
        },
        Err(_) => serde_json::Value::Object(Default::default()),
    };
    let patch = serde_json::to_value(config).map_err(|e| e.to_string())?;
    merge::deep_merge(&mut existing, patch);
    let data = serde_json::to_string_pretty(&existing).map_err(|e| e.to_string())?;
    atomic_write(path, &data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_config_path() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("forge-beta-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p.push("config.json");
        p
    }

    fn base_config() -> AppConfig {
        AppConfig {
            core_url: "http://localhost:1337".into(),
            auth_token: String::new(),
            device_id: "dev-1".into(),
            projects_root: Some("/old".into()),
            claude_mode: None,
            projects: HashMap::new(),
            skill_library: None,
            mcp_library: None,
        }
    }

    #[test]
    fn preserves_unknown_top_level_key() {
        let path = tmp_config_path();
        fs::write(
            &path,
            r#"{"coreUrl":"http://localhost:1337","customField":"x","deviceId":"dev-1","projects":{}}"#,
        )
        .unwrap();
        save_config_at(&path, &base_config()).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["customField"], "x");
        assert_eq!(v["deviceId"], "dev-1");
    }

    #[test]
    fn preserves_hand_added_project() {
        let path = tmp_config_path();
        fs::write(
            &path,
            r#"{
                "coreUrl": "http://localhost:1337",
                "deviceId": "dev-1",
                "projects": {
                    "apiflow": { "slug": "apiflow", "repoPath": "/Users/me/apiflow", "branch": null, "instructions": null, "repos": null, "mcpServers": null }
                }
            }"#,
        )
        .unwrap();
        save_config_at(&path, &base_config()).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["projects"]["apiflow"]["repoPath"], "/Users/me/apiflow");
    }

    #[test]
    fn overwrites_known_field() {
        let path = tmp_config_path();
        fs::write(
            &path,
            r#"{"coreUrl":"http://localhost:1337","deviceId":"dev-1","projectsRoot":"/old","projects":{}}"#,
        )
        .unwrap();
        let mut cfg = base_config();
        cfg.projects_root = Some("/new".into());
        save_config_at(&path, &cfg).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["projectsRoot"], "/new");
    }

    #[test]
    fn adds_new_field() {
        let path = tmp_config_path();
        fs::write(
            &path,
            r#"{"coreUrl":"http://localhost:1337","deviceId":"dev-1","projects":{}}"#,
        )
        .unwrap();
        let mut cfg = base_config();
        cfg.claude_mode = Some("auto".into());
        save_config_at(&path, &cfg).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["claudeMode"], "auto");
    }

    #[test]
    fn corrupt_existing_is_backed_up() {
        let path = tmp_config_path();
        fs::write(&path, "{ not valid json").unwrap();
        save_config_at(&path, &base_config()).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["coreUrl"], "http://localhost:1337");
        let parent = path.parent().unwrap();
        let entries = fs::read_dir(parent).unwrap();
        assert!(entries
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains(".corrupt-")));
    }

    #[test]
    fn missing_file_is_treated_as_empty() {
        let mut p = std::env::temp_dir();
        p.push(format!("forge-beta-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p.push("config.json");
        save_config_at(&p, &base_config()).unwrap();
        let raw = fs::read_to_string(&p).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["deviceId"], "dev-1");
    }
}
