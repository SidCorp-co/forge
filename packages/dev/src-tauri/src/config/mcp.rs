use std::collections::HashMap;

use super::{load_config, save_config, McpServerConfig};

pub fn detect_mcp_servers(repo_path: &str) -> HashMap<String, McpServerConfig> {
    let mut servers = HashMap::new();
    let candidates = [
        (".claude.json", "mcpServers"),
        (".mcp.json", "mcpServers"),
        ("claude_desktop_config.json", "mcpServers"),
    ];

    for (filename, key) in &candidates {
        let data = super::wsl::read_file(repo_path, filename);
        if let Some(data) = data {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) {
                if let Some(mcp_obj) = parsed.get(key).and_then(|v| v.as_object()) {
                    for (name, val) in mcp_obj {
                        if !servers.contains_key(name) {
                            if let Ok(cfg) = serde_json::from_value::<McpServerConfig>(val.clone())
                            {
                                servers.insert(name.clone(), cfg);
                            }
                        }
                    }
                }
            }
        }
    }

    servers
}

pub fn read_knowledge_index(repo_path: &str) -> Option<serde_json::Value> {
    let data = super::wsl::read_file(repo_path, ".forge/knowledge.json")?;
    serde_json::from_str(&data).ok()
}

pub fn read_conventions(repo_path: &str) -> Option<String> {
    super::wsl::read_file(repo_path, ".forge/conventions.md")
}

/// Read agent files (.forge/{agent_type}/knowledge.md and memory.md).
/// Returns { knowledge: string | null, memory: string | null }.
pub fn read_agent_files(repo_path: &str, agent_type: &str) -> serde_json::Value {
    let dir = format!(".forge/{}", agent_type);
    let knowledge = super::wsl::read_file(repo_path, &format!("{}/knowledge.md", dir));
    let memory = super::wsl::read_file(repo_path, &format!("{}/memory.md", dir));
    serde_json::json!({
        "knowledge": knowledge,
        "memory": memory,
    })
}

/// Seed agent files from core data. Only writes if the local file doesn't exist.
pub fn seed_agent_files(
    repo_path: &str,
    agent_type: &str,
    knowledge: Option<&str>,
    memory: Option<&str>,
) -> Result<(), String> {
    let dir = format!(".forge/{}", agent_type);
    let dir_path = std::path::PathBuf::from(super::wsl::clean(repo_path)).join(&dir);
    if !dir_path.exists() {
        std::fs::create_dir_all(&dir_path).map_err(|e| e.to_string())?;
    }

    let knowledge_path = format!("{}/knowledge.md", dir);
    if super::wsl::read_file(repo_path, &knowledge_path).is_none() {
        if let Some(content) = knowledge {
            super::wsl::write_file(repo_path, &knowledge_path, content)?;
        }
    }

    let memory_path = format!("{}/memory.md", dir);
    if super::wsl::read_file(repo_path, &memory_path).is_none() {
        if let Some(content) = memory {
            super::wsl::write_file(repo_path, &memory_path, content)?;
        }
    }

    Ok(())
}

/// Resolve the destination file + JSON key for an install target. Supported
/// targets: `claude-cli`, `cursor`, `cline`, `zed`, `custom`. The JSON key
/// may be dotted (e.g. `cline.mcpServers`) to indicate a nested object.
fn resolve_target(
    target: &str,
    repo_path: &str,
    custom_path: Option<&str>,
) -> Result<(std::path::PathBuf, &'static str), String> {
    match target {
        "claude-cli" => {
            let mut p = std::path::PathBuf::from(super::wsl::clean(repo_path));
            p.push(".mcp.json");
            Ok((p, "mcpServers"))
        }
        "cursor" => {
            let mut p = dirs_next::home_dir().ok_or("Could not resolve home directory")?;
            p.push(".cursor");
            p.push("mcp.json");
            Ok((p, "mcpServers"))
        }
        "cline" => {
            let mut p = std::path::PathBuf::from(super::wsl::clean(repo_path));
            p.push(".vscode");
            p.push("settings.json");
            Ok((p, "cline.mcpServers"))
        }
        "zed" => {
            let mut p = dirs_next::home_dir().ok_or("Could not resolve home directory")?;
            p.push(".config");
            p.push("zed");
            p.push("settings.json");
            Ok((p, "context_servers"))
        }
        "custom" => {
            let raw = custom_path.ok_or("Custom target requires customPath")?;
            let path = std::path::PathBuf::from(super::wsl::clean(raw));
            if !path.is_absolute() {
                return Err("Custom path must be absolute".to_string());
            }
            Ok((path, "mcpServers"))
        }
        other => Err(format!("Unsupported target: {}", other)),
    }
}

/// Merge `server` into the JSON at `path`, under `key`. `key` may be a
/// dotted path (e.g. `cline.mcpServers`); intermediate objects are created
/// as needed. If the file does not exist or is empty, a fresh root object
/// is written.
fn write_merged_mcp_json(
    path: &std::path::Path,
    key: &str,
    name: &str,
    server: &McpServerConfig,
) -> Result<(), String> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let mut root: serde_json::Value = if existing.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&existing).unwrap_or(serde_json::json!({}))
    };

    let server_val = serde_json::to_value(server).map_err(|e| e.to_string())?;
    let segments: Vec<&str> = key.split('.').collect();
    let mut cursor = root
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", path.display()))?;
    for (i, seg) in segments.iter().enumerate() {
        if i == segments.len() - 1 {
            let entry = cursor
                .entry((*seg).to_string())
                .or_insert(serde_json::json!({}));
            let obj = entry
                .as_object_mut()
                .ok_or_else(|| format!("{} is not an object", seg))?;
            obj.insert(name.to_string(), server_val);
            break;
        }
        let entry = cursor
            .entry((*seg).to_string())
            .or_insert(serde_json::json!({}));
        cursor = entry
            .as_object_mut()
            .ok_or_else(|| format!("{} is not an object", seg))?;
    }

    let json = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    super::atomic_write(path, &json)
}

pub fn install_mcp_to_cli(
    name: &str,
    server: &McpServerConfig,
    repo_path: &str,
    target: &str,
    custom_path: Option<&str>,
) -> Result<(), String> {
    let (path, key) = resolve_target(target, repo_path, custom_path)?;
    write_merged_mcp_json(&path, key, name, server)
}

pub fn list_library_mcp() -> HashMap<String, McpServerConfig> {
    let config = load_config();
    config.mcp_library.unwrap_or_default()
}

pub fn add_library_mcp(name: String, mcp_config: McpServerConfig) -> Result<(), String> {
    let mut config = load_config();
    let library = config.mcp_library.get_or_insert_with(HashMap::new);
    library.insert(name, mcp_config);
    save_config(&config)
}

pub fn remove_library_mcp(name: String) -> Result<(), String> {
    let mut config = load_config();
    if let Some(library) = config.mcp_library.as_mut() {
        library.remove(&name);
    }
    save_config(&config)
}

pub fn toggle_mcp(project_slug: String, name: String, enabled: bool) -> Result<(), String> {
    let mut config = load_config();
    if let Some(project) = config.projects.get_mut(&project_slug) {
        let servers = project.enabled_mcp_servers.get_or_insert_with(Vec::new);
        if enabled {
            if !servers.contains(&name) {
                servers.push(name);
            }
        } else {
            servers.retain(|s| s != &name);
        }
        save_config(&config)
    } else {
        Err(format!("Project '{}' not found", project_slug))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::PathBuf;

    fn tmp_dir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("forge-mcp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn sample_server() -> McpServerConfig {
        serde_json::from_value(serde_json::json!({
            "type": "http",
            "url": "https://mcp.example.com/mcp",
            "enabled": true,
        }))
        .unwrap()
    }

    #[test]
    fn resolve_target_claude_cli_writes_under_repo() {
        let dir = tmp_dir();
        let (path, key) = resolve_target("claude-cli", dir.to_str().unwrap(), None).unwrap();
        assert_eq!(key, "mcpServers");
        assert_eq!(path.file_name().unwrap(), ".mcp.json");
        assert!(path.starts_with(&dir));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn resolve_target_cline_uses_vscode_settings() {
        let dir = tmp_dir();
        let (path, key) = resolve_target("cline", dir.to_str().unwrap(), None).unwrap();
        assert_eq!(key, "cline.mcpServers");
        assert_eq!(path.file_name().unwrap(), "settings.json");
        assert!(path.to_string_lossy().contains(".vscode"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn resolve_target_cursor_uses_home() {
        let (path, key) = resolve_target("cursor", "/irrelevant", None).unwrap();
        assert_eq!(key, "mcpServers");
        assert_eq!(path.file_name().unwrap(), "mcp.json");
    }

    #[test]
    fn resolve_target_zed_uses_context_servers() {
        let (path, key) = resolve_target("zed", "/irrelevant", None).unwrap();
        assert_eq!(key, "context_servers");
        assert_eq!(path.file_name().unwrap(), "settings.json");
    }

    #[test]
    fn resolve_target_custom_requires_absolute() {
        let err = resolve_target("custom", "/x", Some("relative/path.json")).unwrap_err();
        assert!(err.contains("absolute"));
        let ok = resolve_target("custom", "/x", Some("/abs/path.json")).unwrap();
        assert_eq!(ok.0, PathBuf::from("/abs/path.json"));
        assert_eq!(ok.1, "mcpServers");
    }

    #[test]
    fn resolve_target_unknown_errors() {
        let err = resolve_target("nope", "/x", None).unwrap_err();
        assert!(err.contains("Unsupported target"));
    }

    #[test]
    fn write_merged_creates_nested_keys() {
        let dir = tmp_dir();
        let path = dir.join("settings.json");
        write_merged_mcp_json(&path, "cline.mcpServers", "demo", &sample_server()).unwrap();
        let body: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(body["cline"]["mcpServers"]["demo"]["url"]
            .as_str()
            .unwrap()
            .ends_with("/mcp"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn write_merged_preserves_existing_keys() {
        let dir = tmp_dir();
        let path = dir.join(".mcp.json");
        std::fs::write(
            &path,
            r#"{"mcpServers":{"existing":{"command":"ls"}},"other":42}"#,
        )
        .unwrap();
        write_merged_mcp_json(&path, "mcpServers", "demo", &sample_server()).unwrap();
        let body: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(body["other"], 42);
        assert_eq!(body["mcpServers"]["existing"]["command"], "ls");
        assert!(body["mcpServers"]["demo"]["url"].is_string());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn install_mcp_to_cli_default_claude_writes_repo_mcp_json() {
        let dir = tmp_dir();
        install_mcp_to_cli(
            "demo",
            &sample_server(),
            dir.to_str().unwrap(),
            "claude-cli",
            None,
        )
        .unwrap();
        let body = std::fs::read_to_string(dir.join(".mcp.json")).unwrap();
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert!(parsed["mcpServers"]["demo"]["url"].is_string());
        std::fs::remove_dir_all(dir).ok();
    }
}
