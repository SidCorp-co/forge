//! Per-(project, skill) sync-state tracker for ISS-278 conflict detection.
//!
//! `last_installed[<slug>::<name>]` stores the SHA-256 of the SKILL.md body the
//! daemon last wrote into `<repoPath>/.claude/skills/<name>/`. On the next
//! `refresh_enabled_skills`, the current on-disk hash is compared against this
//! value: if they differ, a human edited the file outside the app and the
//! incoming overwrite is held for explicit user review (`skill-conflict`).
//!
//! `local_overrides` carries the user's "Keep local" decision for a given
//! (slug, name) — refresh skips that pair until cleared via
//! `clear_skill_local_override`.

use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillState {
    /// SHA-256 hex of the SKILL.md body last written by the daemon, keyed by
    /// `"<slug>::<skill_name>"`.
    #[serde(default)]
    pub last_installed: HashMap<String, String>,
    /// `"<slug>::<skill_name>"` pairs the user opted to keep local — refresh
    /// will skip them until removed.
    #[serde(default)]
    pub local_overrides: HashSet<String>,
}

pub fn key(slug: &str, name: &str) -> String {
    format!("{}::{}", slug, name)
}

pub fn hash_body(body: &str) -> String {
    let mut h = Sha256::new();
    h.update(body.as_bytes());
    hex::encode(h.finalize())
}

fn state_path() -> PathBuf {
    let mut path = dirs_next::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("forge-beta");
    fs::create_dir_all(&path).ok();
    path.push("skill-state.json");
    path
}

pub fn load_state() -> SkillState {
    let path = state_path();
    fs::read_to_string(&path)
        .ok()
        .and_then(|data| serde_json::from_str::<SkillState>(&data).ok())
        .unwrap_or_default()
}

pub fn save_state(state: &SkillState) -> Result<(), String> {
    let path = state_path();
    let data = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    super::atomic_write(&path, &data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_format_is_stable() {
        assert_eq!(key("demo", "forge-code"), "demo::forge-code");
    }

    #[test]
    fn hash_body_is_deterministic_and_distinct() {
        let a = hash_body("hello\n");
        let b = hash_body("hello\n");
        let c = hash_body("hello");
        assert_eq!(a, b);
        assert_ne!(a, c);
        // sha256 hex is 64 chars
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn round_trip_serde() {
        let mut s = SkillState::default();
        s.last_installed.insert(key("p", "n"), "abc".into());
        s.local_overrides.insert(key("p", "n2"));
        let json = serde_json::to_string(&s).unwrap();
        let back: SkillState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.last_installed.get("p::n").map(String::as_str), Some("abc"));
        assert!(back.local_overrides.contains("p::n2"));
    }
}
