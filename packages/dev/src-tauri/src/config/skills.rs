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
    path.push("forge-beta");
    path.push("skills");
    fs::create_dir_all(&path).ok();
    path
}

pub fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
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

    // Defence in depth: never write a 0-byte SKILL.md. The TS layer already
    // skips skills with empty bodies, but a malformed server response or a
    // direct invoke from a future caller would otherwise wipe the existing
    // skill via remove_dir_all + write("") and break /forge-* commands until
    // a re-sync. Refuse the call so the caller sees the failure explicitly.
    if data.skill_md.trim().is_empty() {
        return Err(format!("install_skill_from_strapi: empty skill_md for {}", data.name));
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

    // Mirror the guard in install_skill_from_strapi — empty body must not wipe
    // an existing local skill. See note there.
    if data.local_guide.trim().is_empty() {
        return Err(format!("install_skill_guide: empty local_guide for {}", data.name));
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
    pub action: String, // "installed", "guide", "skipped", "refreshed", "error", "conflict"
    pub detail: String,
    /// Project slug — only set for per-project log entries (refresh_enabled_skills).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub project_slug: Option<String>,
    /// On `action="conflict"`, the SKILL.md body currently on disk in the
    /// repo. Sent to the JS layer so the dialog can show a diff without an
    /// extra round-trip.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub local_content: Option<String>,
    /// On `action="conflict"`, the SKILL.md body the daemon would have
    /// written from the library.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub server_content: Option<String>,
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
    path.push("forge-beta");
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

/// Read the SKILL.md body from a project's local skill copy. Returns None if
/// the file doesn't exist (first-time sync) so callers can short-circuit
/// conflict detection.
fn read_local_skill_body(repo_path: &str, skill_name: &str) -> Option<String> {
    super::wsl::read_file(
        repo_path,
        &format!(".claude/skills/{}/SKILL.md", skill_name),
    )
}

/// Read the SKILL.md body from the library copy. Returns None if missing.
fn read_library_skill_body(source: &std::path::Path) -> Option<String> {
    fs::read_to_string(source.join("SKILL.md")).ok()
}

/// Copy the library skill dir into the project repo, replacing whatever was
/// there. Returns the result of the copy.
fn write_skill_to_repo(
    source: &std::path::Path,
    repo_path: &str,
    skill_name: &str,
) -> Result<(), String> {
    let rel_path = format!(".claude/skills/{}", skill_name);
    super::wsl::rm_rf(repo_path, &rel_path).ok();
    super::wsl::copy_dir(source, repo_path, &rel_path)
}

/// Sync all library skills to all configured project repos.
/// Copies every skill from library to {repoPath}/.claude/skills/{name}/.
/// Called after WebSocket skills:push to ensure updated skills reach the repos.
///
/// Per ISS-278 conflict resolution: before overwriting a project copy, the
/// daemon compares the on-disk SKILL.md hash against the
/// last-known-installed hash from `skill-state.json`. If the local file has
/// drifted (user edited it outside the app) AND the library content also
/// differs from the local file, the entry is logged with `action="conflict"`
/// and skipped — the JS layer then surfaces the dialog. Pairs in
/// `local_overrides` are skipped silently with `action="skipped"`.
pub fn refresh_enabled_skills() -> SkillSyncLog {
    let mut config = load_config();
    let library = config.skill_library.clone().unwrap_or_default();
    let mut state = super::skill_state::load_state();
    let mut entries = Vec::new();
    let mut changed = false;
    let mut state_changed = false;

    for (slug, project) in config.projects.iter_mut() {
        let repo_path = project.repo_path.clone();
        if repo_path.is_empty() { continue; }

        let enabled = project.enabled_skills.get_or_insert_with(Vec::new);

        for (skill_name, entry) in &library {
            let state_key = super::skill_state::key(slug, skill_name);

            if state.local_overrides.contains(&state_key) {
                entries.push(SkillSyncLogEntry {
                    skill: skill_name.clone(),
                    action: "skipped".to_string(),
                    detail: format!("[{}] kept local — clear via clear_skill_local_override", slug),
                    project_slug: Some(slug.clone()),
                    local_content: None,
                    server_content: None,
                });
                continue;
            }

            let source = PathBuf::from(&entry.source_path);
            if !source.exists() {
                entries.push(SkillSyncLogEntry {
                    skill: skill_name.clone(),
                    action: "error".to_string(),
                    detail: format!("[{}] source path missing", slug),
                    project_slug: Some(slug.clone()),
                    local_content: None,
                    server_content: None,
                });
                continue;
            }

            let library_body = match read_library_skill_body(&source) {
                Some(b) => b,
                None => {
                    entries.push(SkillSyncLogEntry {
                        skill: skill_name.clone(),
                        action: "error".to_string(),
                        detail: format!("[{}] library SKILL.md missing", slug),
                        project_slug: Some(slug.clone()),
                        local_content: None,
                        server_content: None,
                    });
                    continue;
                }
            };
            let library_hash = super::skill_state::hash_body(&library_body);

            // Check for human-edited local file before clobbering it.
            let local_body_opt = read_local_skill_body(&repo_path, skill_name);
            if let Some(local_body) = &local_body_opt {
                let local_hash = super::skill_state::hash_body(local_body);
                let last = state.last_installed.get(&state_key).cloned();
                let local_drifted = match &last {
                    Some(h) => &local_hash != h,
                    // No baseline → treat as drifted only if local differs from library
                    // (covers configs where the file pre-existed before sync ever ran).
                    None => local_hash != library_hash,
                };
                if local_drifted && local_hash != library_hash {
                    entries.push(SkillSyncLogEntry {
                        skill: skill_name.clone(),
                        action: "conflict".to_string(),
                        detail: format!("[{}] local SKILL.md edited; sync held for review", slug),
                        project_slug: Some(slug.clone()),
                        local_content: Some(local_body.clone()),
                        server_content: Some(library_body.clone()),
                    });
                    continue;
                }
                if local_hash == library_hash {
                    // Already in sync — no-op write avoided. Update state so future
                    // refreshes have a baseline even if no install ever occurred.
                    if state.last_installed.get(&state_key) != Some(&library_hash) {
                        state.last_installed.insert(state_key.clone(), library_hash.clone());
                        state_changed = true;
                    }
                    entries.push(SkillSyncLogEntry {
                        skill: skill_name.clone(),
                        action: "skipped".to_string(),
                        detail: format!("[{}] already up to date", slug),
                        project_slug: Some(slug.clone()),
                        local_content: None,
                        server_content: None,
                    });
                    continue;
                }
            }

            // Safe to overwrite.
            match write_skill_to_repo(&source, &repo_path, skill_name) {
                Ok(_) => {
                    if !enabled.contains(skill_name) {
                        enabled.push(skill_name.clone());
                        changed = true;
                    }
                    state.last_installed.insert(state_key, library_hash);
                    state_changed = true;
                    entries.push(SkillSyncLogEntry {
                        skill: skill_name.clone(),
                        action: "refreshed".to_string(),
                        detail: format!("[{}] → .claude/skills/{} (v{})", slug, skill_name, entry.version),
                        project_slug: Some(slug.clone()),
                        local_content: None,
                        server_content: None,
                    });
                }
                Err(e) => {
                    entries.push(SkillSyncLogEntry {
                        skill: skill_name.clone(),
                        action: "error".to_string(),
                        detail: format!("[{}] copy failed: {}", slug, e),
                        project_slug: Some(slug.clone()),
                        local_content: None,
                        server_content: None,
                    });
                }
            }
        }
    }

    if changed {
        save_config(&config).ok();
    }
    if state_changed {
        super::skill_state::save_state(&state).ok();
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

/// Force-install a single library skill into a project repo, bypassing the
/// conflict guard. Called when the user picks "Overwrite" in the conflict
/// dialog. Updates `last_installed` so subsequent refreshes treat the new
/// content as the baseline.
pub fn force_install_skill_to_project(slug: String, name: String) -> Result<(), String> {
    let config = load_config();
    let repo_path = config
        .projects
        .get(&slug)
        .map(|p| p.repo_path.clone())
        .ok_or_else(|| format!("unknown project slug: {}", slug))?;
    if repo_path.is_empty() {
        return Err(format!("project {} has no repoPath configured", slug));
    }
    let library = config.skill_library.clone().unwrap_or_default();
    let entry = library
        .get(&name)
        .ok_or_else(|| format!("skill {} not in library", name))?;
    let source = PathBuf::from(&entry.source_path);
    let body = read_library_skill_body(&source)
        .ok_or_else(|| format!("library SKILL.md missing for {}", name))?;
    let library_hash = super::skill_state::hash_body(&body);

    write_skill_to_repo(&source, &repo_path, &name)?;

    let mut state = super::skill_state::load_state();
    state
        .last_installed
        .insert(super::skill_state::key(&slug, &name), library_hash);
    state
        .local_overrides
        .remove(&super::skill_state::key(&slug, &name));
    super::skill_state::save_state(&state)?;
    Ok(())
}

/// Mark a (project, skill) pair as "keep local". Future refreshes will skip
/// it with `action="skipped"` until cleared via `clear_skill_local_override`.
/// Does not touch the on-disk file — the user's edits stay where they are.
pub fn accept_local_skill(slug: String, name: String) -> Result<(), String> {
    let mut state = super::skill_state::load_state();
    state
        .local_overrides
        .insert(super::skill_state::key(&slug, &name));
    super::skill_state::save_state(&state)
}

/// Re-enable sync for a previously kept-local skill. Next refresh will treat
/// the local file as a fresh baseline candidate.
pub fn clear_skill_local_override(slug: String, name: String) -> Result<(), String> {
    let mut state = super::skill_state::load_state();
    state
        .local_overrides
        .remove(&super::skill_state::key(&slug, &name));
    super::skill_state::save_state(&state)
}

/// Snapshot the current sync state — surfaced to the UI so settings can show
/// which skills are kept-local + their last-installed baseline.
pub fn get_skill_state() -> super::skill_state::SkillState {
    super::skill_state::load_state()
}

/// Returns true if the library SKILL.md for `name` exists and has non-zero size.
/// The JS sync layer calls this to decide whether the hash-equality short
/// circuit is safe — pre-guard installs left some files at 0 bytes, and
/// without this check the skip-on-hash-match path keeps them broken forever
/// (server hash matches the cached local hash, install never re-fires).
pub fn library_skill_body_ok(name: &str) -> bool {
    let path = skills_dir().join(name).join("SKILL.md");
    std::fs::metadata(&path).map(|m| m.len() > 0).unwrap_or(false)
}

