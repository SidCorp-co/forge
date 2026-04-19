use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use super::{SkillLibraryEntry, load_config, save_config};

/// Reject names/paths containing path traversal or separators.
fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && !name.contains('/')
        && !name.contains('\\')
        && name != "."
}

fn is_safe_path(path: &str) -> bool {
    !path.is_empty() && !path.contains("..")
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let filtered: Vec<u8> = input.bytes().filter(|b| !b" \t\n\r".contains(b)).collect();
    let mut out = Vec::with_capacity(filtered.len() * 3 / 4);
    let table = |c: u8| -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("invalid base64 char: {}", c as char)),
        }
    };
    let mut i = 0;
    while i < filtered.len() {
        if filtered[i] == b'=' { break; }
        let a = table(filtered[i])?;
        let b = if i + 1 < filtered.len() && filtered[i + 1] != b'=' { table(filtered[i + 1])? } else { 0 };
        out.push((a << 2) | (b >> 4));
        if i + 2 >= filtered.len() || filtered[i + 2] == b'=' { break; }
        let c = table(filtered[i + 2])?;
        out.push((b << 4) | (c >> 2));
        if i + 3 >= filtered.len() || filtered[i + 3] == b'=' { break; }
        let d = table(filtered[i + 3])?;
        out.push((c << 6) | d);
        i += 4;
    }
    Ok(out)
}

fn skills_dir() -> PathBuf {
    let mut path = dirs_next::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("forge-dev");
    path.push("skills");
    fs::create_dir_all(&path).ok();
    path
}

pub(crate) fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name == ".git" { continue; }
        let src_path = entry.path();
        let dst_path = dst.join(&name);
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn default_encoding() -> String { "utf8".to_string() }

#[derive(serde::Deserialize)]
#[allow(dead_code)]
pub struct StrapiSkillFile {
    pub path: String,
    pub content: String,
    #[serde(default = "default_encoding")]
    pub encoding: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrapiSkillData {
    pub name: String,
    pub description: String,
    pub version: String,
    pub skill_md: String,
    #[serde(default)]
    pub files: Vec<StrapiSkillFile>,
    #[serde(default)]
    pub content_hash: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrapiSkillGuideData {
    pub name: String,
    pub description: String,
    pub version: String,
    pub local_guide: String,
    #[serde(default)]
    pub content_hash: Option<String>,
}

pub fn install_skill_from_strapi(data: StrapiSkillData) -> Result<SkillLibraryEntry, String> {
    if !is_safe_name(&data.name) {
        return Err(format!("Unsafe skill name: {}", data.name));
    }

    let dest = skills_dir().join(&data.name);
    if dest.exists() {
        fs::remove_dir_all(&dest).ok();
    }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;

    // Write SKILL.md
    fs::write(dest.join("SKILL.md"), &data.skill_md).map_err(|e| e.to_string())?;

    // Write bundled files
    for file in &data.files {
        if !is_safe_path(&file.path) {
            return Err(format!("Unsafe file path in skill {}: {}", data.name, file.path));
        }
        let file_path = dest.join(&file.path);
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if file.encoding == "base64" {
            let bytes = decode_base64(&file.content)
                .map_err(|e| format!("base64 decode error for {}: {}", file.path, e))?;
            fs::write(&file_path, bytes).map_err(|e| e.to_string())?;
        } else {
            fs::write(&file_path, &file.content).map_err(|e| e.to_string())?;
        }
    }

    let entry = SkillLibraryEntry {
        name: data.name.clone(),
        description: data.description,
        version: data.version,
        git_url: None,
        subfolder: None,
        source_path: dest.to_string_lossy().to_string(),
        content_hash: data.content_hash,
        skill_type: "full".to_string(),
    };

    // Save to config
    let mut config = load_config();
    let library = config.skill_library.get_or_insert_with(HashMap::new);
    library.insert(data.name, entry.clone());
    save_config(&config)?;

    Ok(entry)
}

/// Install a thin guide SKILL.md for cloud-target skills.
/// The guide instructs the agent to call `forge_skills get` for full content.
pub fn install_skill_guide(data: StrapiSkillGuideData) -> Result<SkillLibraryEntry, String> {
    if !is_safe_name(&data.name) {
        return Err(format!("Unsafe skill name: {}", data.name));
    }

    let dest = skills_dir().join(&data.name);
    if dest.exists() {
        fs::remove_dir_all(&dest).ok();
    }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;

    // Write thin SKILL.md (the guide content)
    fs::write(dest.join("SKILL.md"), &data.local_guide).map_err(|e| e.to_string())?;

    let entry = SkillLibraryEntry {
        name: data.name.clone(),
        description: data.description,
        version: data.version,
        git_url: None,
        subfolder: None,
        source_path: dest.to_string_lossy().to_string(),
        content_hash: data.content_hash,
        skill_type: "guide".to_string(),
    };

    let mut config = load_config();
    let library = config.skill_library.get_or_insert_with(HashMap::new);
    library.insert(data.name, entry.clone());
    save_config(&config)?;

    Ok(entry)
}

/// Returns a map of skill name → contentHash for all library skills.
pub fn get_skill_hashes() -> HashMap<String, String> {
    let config = load_config();
    let library = config.skill_library.unwrap_or_default();
    library.into_iter()
        .filter_map(|(name, entry)| entry.content_hash.map(|h| (name, h)))
        .collect()
}

/// Sync log entry for a single skill install/skip.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSyncLogEntry {
    pub skill: String,
    pub action: String, // "installed", "guide", "skipped", "refreshed", "error"
    pub detail: String,
}

/// Full sync log — replaced on each sync.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSyncLog {
    pub timestamp: u64,
    pub entries: Vec<SkillSyncLogEntry>,
}

fn sync_log_path() -> PathBuf {
    let mut path = dirs_next::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("forge-dev");
    path.push("skill-sync-log.json");
    path
}

pub fn save_sync_log(log: &SkillSyncLog) {
    if let Ok(json) = serde_json::to_string_pretty(log) {
        super::atomic_write(&sync_log_path(), &json).ok();
    }
}

pub fn read_sync_log() -> Option<SkillSyncLog> {
    let path = sync_log_path();
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

/// Sync all library skills to all configured project repos.
/// Copies every skill from library to {repoPath}/.claude/skills/{name}/.
/// Called after WebSocket skills:push to ensure updated skills reach the repos.
/// Returns the sync log with per-skill results.
pub fn refresh_enabled_skills() -> SkillSyncLog {
    let mut config = load_config();
    let library = config.skill_library.clone().unwrap_or_default();
    let mut entries = Vec::new();
    let mut changed = false;

    for (slug, project) in config.projects.iter_mut() {
        let repo_path = &project.repo_path;
        if repo_path.is_empty() { continue; }

        let enabled = project.enabled_skills.get_or_insert_with(Vec::new);

        for (skill_name, entry) in &library {
            let source = PathBuf::from(&entry.source_path);
            if !source.exists() {
                entries.push(SkillSyncLogEntry {
                    skill: skill_name.clone(),
                    action: "error".to_string(),
                    detail: format!("[{}] source path missing", slug),
                });
                continue;
            }
            let rel_path = format!(".claude/skills/{}", skill_name);
            super::wsl::rm_rf(repo_path, &rel_path).ok();
            match super::wsl::copy_dir(&source, repo_path, &rel_path) {
                Ok(_) => {
                    if !enabled.contains(skill_name) {
                        enabled.push(skill_name.clone());
                        changed = true;
                    }
                    entries.push(SkillSyncLogEntry {
                        skill: skill_name.clone(),
                        action: "refreshed".to_string(),
                        detail: format!("[{}] → .claude/skills/{} (v{})", slug, skill_name, entry.version),
                    });
                }
                Err(e) => {
                    entries.push(SkillSyncLogEntry {
                        skill: skill_name.clone(),
                        action: "error".to_string(),
                        detail: format!("[{}] copy failed: {}", slug, e),
                    });
                }
            }
        }
    }

    if changed {
        save_config(&config).ok();
    }

    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let log = SkillSyncLog {
        timestamp: secs as u64,
        entries,
    };
    save_sync_log(&log);
    log
}

