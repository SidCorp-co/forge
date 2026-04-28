use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use super::atomic_write;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub slug: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionData {
    pub id: String,
    pub title: String,
    pub slug: String,
    pub claude_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strapi_session_id: Option<String>,
    pub updated_at: String,
    pub messages: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
}

fn sessions_dir() -> PathBuf {
    let mut path = dirs_next::config_dir().unwrap_or_else(|| {
        eprintln!("[config] WARNING: config_dir() returned None, falling back to current directory");
        PathBuf::from(".")
    });
    path.push("forge-beta");
    path.push("sessions");
    fs::create_dir_all(&path).ok();
    path
}

fn index_path() -> PathBuf {
    sessions_dir().join("_index.json")
}

fn load_index() -> Vec<SessionMeta> {
    if let Ok(data) = fs::read_to_string(index_path()) {
        if let Ok(index) = serde_json::from_str::<Vec<SessionMeta>>(&data) {
            return index;
        }
    }
    // Index missing or corrupt — rebuild from session files
    rebuild_index()
}

fn save_index(index: &[SessionMeta]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    atomic_write(&index_path(), &json)
}

fn rebuild_index() -> Vec<SessionMeta> {
    let dir = sessions_dir();
    let mut sessions: Vec<SessionMeta> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false)
                && path.file_name().map(|n| n != "_index.json").unwrap_or(true)
            {
                if let Ok(data) = fs::read_to_string(&path) {
                    if let Ok(meta) = serde_json::from_str::<SessionMeta>(&data) {
                        sessions.push(meta);
                    }
                }
            }
        }
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    save_index(&sessions).ok();
    sessions
}

pub fn list_sessions(slug: Option<String>) -> Vec<SessionMeta> {
    let mut sessions = load_index();
    if let Some(s) = slug {
        sessions.retain(|m| m.slug == s);
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

pub fn save_session(data: &SessionData) -> Result<(), String> {
    let mut path = sessions_dir();
    path.push(format!("{}.json", data.id));
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    atomic_write(&path, &json)?;

    // Update index
    let mut index = load_index();
    let meta = SessionMeta {
        id: data.id.clone(),
        title: data.title.clone(),
        slug: data.slug.clone(),
        updated_at: data.updated_at.clone(),
    };
    if let Some(existing) = index.iter_mut().find(|m| m.id == data.id) {
        *existing = meta;
    } else {
        index.push(meta);
    }
    index.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    save_index(&index)?;
    Ok(())
}

pub fn load_session(id: &str) -> Result<SessionData, String> {
    let mut path = sessions_dir();
    path.push(format!("{}.json", id));
    let data = fs::read_to_string(&path).map_err(|e| format!("Session not found: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse session: {e}"))
}

pub fn delete_session(id: &str) -> Result<(), String> {
    let mut path = sessions_dir();
    path.push(format!("{}.json", id));
    fs::remove_file(&path).map_err(|e| format!("Failed to delete session: {e}"))?;

    // Update index
    let mut index = load_index();
    index.retain(|m| m.id != id);
    save_index(&index)?;
    Ok(())
}
