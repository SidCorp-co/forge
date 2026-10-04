//! Server-driven skill seeding (Skill Studio 4, ISS-278).
//!
//! The server is the source of truth for skills; the device is a read-only
//! artifact. The runner pulls the project's effective skill manifest via the
//! background poller (`daemon/skill_pull.rs`) or an explicit `skill.sync` push
//! — NOT on each job dispatch. It downloads only the skills whose hash changed
//! (diffed against a local cache under
//! `~/.config/forge-runner/skills-cache/<project>/<skill>/`), seeds the full
//! `.claude/skills/<name>/` tree into the working dir, then reports the
//! installed hashes back so the server can mark the device synced.
//!
//! The runner never recomputes `hashSkillBody` — it echoes the server's
//! `effective_hash` back as `installed_hash`, so there is no TS↔Rust hashing
//! drift.
//!
//! Concurrency safety: a staged temp dir promoted by atomic rename, under a
//! per-skill file lock (ISS-743).

use std::path::{Path, PathBuf};

use base64::Engine;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::transport::skills::{self, SkillContent};
use crate::transport::CoreClient;

/// `~/.config/forge-runner/skills-cache/<project_id>/<skill_id>/`.
fn cache_dir(project_id: &str, skill_id: &str) -> Result<PathBuf> {
    let base = crate::config::base_dir()?
        .join("skills-cache")
        .join(project_id)
        .join(skill_id);
    Ok(base)
}

/// Cross-instance lock file for one skill: a SIBLING of its cache dir (not
/// inside it), so the lock survives the cache dir being swapped out from
/// under it by `publish_dir_atomically`.
fn skill_lock_path(project_id: &str, skill_id: &str) -> Result<PathBuf> {
    let dir = cache_dir(project_id, skill_id)?;
    let parent = dir
        .parent()
        .ok_or_else(|| Error::Config("skill cache dir has no parent".into()))?;
    std::fs::create_dir_all(parent)?;
    Ok(parent.join(format!("{skill_id}.lock")))
}

/// Hold an exclusive lock for the duration of `f`, serializing this skill's
/// filesystem critical section across concurrent runner instances (and
/// concurrent tasks within one instance). Blocking — call from a context that
/// can afford to wait for the flock (e.g. `tokio::task::spawn_blocking`).
fn with_skill_lock<T>(
    project_id: &str,
    skill_id: &str,
    f: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let lock_path = skill_lock_path(project_id, skill_id)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)?;
    file.lock()?; // exclusive, blocking; released on drop
    f()
}

/// Read the hash marker (`.hash`) at the root of a published dir, if present.
fn read_hash_marker(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(".hash"))
        .ok()
        .map(|s| s.trim().to_string())
}

/// A dir is "fresh" for `effective_hash` when its `.hash` marker matches AND
/// the tree actually landed (`SKILL.md` present) — guards against a marker
/// surviving a partial/interrupted write from a pre-atomic-publish version.
fn is_fresh(dir: &Path, effective_hash: &str) -> bool {
    read_hash_marker(dir).as_deref() == Some(effective_hash) && dir.join("SKILL.md").exists()
}

/// Publish `staged` (a fully-built tree) into `dest` atomically: readers of
/// any file under `dest` always see either the complete old tree or the
/// complete new one, never a partial write. `staged` MUST live on the same
/// filesystem as `dest` (its parent) for `rename` to be atomic rather than a
/// cross-device copy.
fn publish_dir_atomically(staged: &Path, dest: &Path) -> Result<()> {
    let parent = dest
        .parent()
        .ok_or_else(|| Error::Config("publish destination has no parent".into()))?;
    std::fs::create_dir_all(parent)?;

    if dest.exists() {
        let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("skill");
        let displaced = parent.join(format!(".{name}.old-{}", Uuid::new_v4()));
        rename_settling(dest, &displaced)?;
        rename_settling(staged, dest)?;
        let _ = std::fs::remove_dir_all(&displaced);
    } else {
        rename_settling(staged, dest)?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn rename_settling(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
}

#[cfg(windows)]
fn rename_settling(from: &Path, to: &Path) -> std::io::Result<()> {
    const ATTEMPTS: u32 = 40;
    const PAUSE: std::time::Duration = std::time::Duration::from_millis(25);
    let mut outcome = std::fs::rename(from, to);
    for _ in 1..ATTEMPTS {
        match outcome {
            Ok(()) => return Ok(()),
            Err(ref e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                std::thread::sleep(PAUSE);
                outcome = std::fs::rename(from, to);
            }
            Err(_) => return outcome,
        }
    }
    outcome
}

/// Build a staged sibling dir of `dest` to publish into later. Using a
/// sibling (not a shared tmp dir) keeps the eventual `rename` on the same
/// filesystem.
fn staging_dir_for(dest: &Path, tag: &str) -> Result<PathBuf> {
    let parent = dest
        .parent()
        .ok_or_else(|| Error::Config("staging target has no parent".into()))?;
    let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("skill");
    Ok(parent.join(format!(".{name}.{tag}-{}", Uuid::new_v4())))
}

/// Write one skill body into a directory tree: `SKILL.md` at the root plus
/// every `files[]` entry at its relative path (decoding base64 binaries), and
/// the `.hash` marker recording `effective_hash`. Refuses paths that escape
/// the target dir (`..`, absolute) to avoid a path-traversal write outside the
/// skill folder. Publishes atomically into `dir` (temp-build + rename-swap)
/// so a concurrent reader of `dir` never observes a torn write.
fn write_skill_tree(dir: &Path, content: &SkillContent, effective_hash: &str) -> Result<()> {
    let staged = staging_dir_for(dir, "staged")?;
    let result = (|| -> Result<()> {
        std::fs::create_dir_all(&staged)?;
        std::fs::write(staged.join("SKILL.md"), content.skill_md.as_bytes())?;

        for f in &content.files {
            let rel = Path::new(&f.path);
            if f.path.is_empty()
                || rel.is_absolute()
                || rel
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                tracing::warn!("[skills] skipping unsafe skill file path: {}", f.path);
                continue;
            }
            let dest = staged.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if f.encoding == "base64" {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(f.content.as_bytes())
                    .map_err(|e| {
                        Error::Other(format!("skill file base64 decode ({}): {e}", f.path))
                    })?;
                std::fs::write(&dest, bytes)?;
            } else {
                std::fs::write(&dest, f.content.as_bytes())?;
            }
        }

        std::fs::write(staged.join(".hash"), effective_hash.as_bytes())?;
        publish_dir_atomically(&staged, dir)
    })();

    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staged);
    }
    result
}

/// Copy a cached skill tree into a staged dir (skipping the internal `.hash`
/// marker), then publish it into `dst` atomically and write `dst`'s own
/// `.hash` marker for `effective_hash`. Returns `Ok(())` unconditionally —
/// callers gate on [`is_fresh`] first so this only runs on real content
/// changes.
fn seed_dest(cache_dir: &Path, dst: &Path, effective_hash: &str) -> Result<()> {
    let staged = staging_dir_for(dst, "seed")?;
    let result = (|| -> Result<()> {
        copy_dir_recursive(cache_dir, &staged)?;
        std::fs::write(staged.join(".hash"), effective_hash.as_bytes())?;
        publish_dir_atomically(&staged, dst)
    })();

    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staged);
    }
    result
}

/// Copy a directory tree, skipping the internal `.hash` marker (the caller
/// writes a fresh one at the destination root instead).
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        // Don't carry the internal `.hash` marker — the caller writes its own.
        if name == std::ffi::OsStr::new(".hash") {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// The lock-guarded filesystem critical section for one skill: refresh the
/// cache if still stale (content pulled by the caller, outside the lock),
/// then seed the destination if it isn't already fresh. Both steps are
/// atomic-publish, so a concurrent reader/instance never observes a torn or
/// half-rebuilt tree.
fn sync_one_skill_locked(
    project_id: &str,
    skill_id: &str,
    cache_dir: &Path,
    dest: &Path,
    effective_hash: &str,
    content: Option<SkillContent>,
) -> Result<()> {
    with_skill_lock(project_id, skill_id, || {
        if !is_fresh(cache_dir, effective_hash) {
            let content = content.ok_or_else(|| {
                Error::Other(format!(
                    "skill cache stale but no content pulled ({skill_id})"
                ))
            })?;
            write_skill_tree(cache_dir, &content, effective_hash)?;
        }

        if !is_fresh(dest, effective_hash) {
            seed_dest(cache_dir, dest, effective_hash)?;
        }

        Ok(())
    })
}

/// Directory names under `skills_root` that Forge manages (carry the internal
/// `.hash` marker written by [`write_skill_tree`]/[`seed_dest`]) but are no
/// longer in `keep` — the converge-on-delete set (ISS-802 stage ③ prune). A
/// dir with no `.hash` marker is left alone: it was never seeded by Forge (a
/// user-created folder under `.claude/skills/`), so pruning must not touch it.
fn find_prunable(skills_root: &Path, keep: &std::collections::HashSet<&str>) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(skills_root) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|dir| {
            let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
            !keep.contains(name) && read_hash_marker(dir).is_some()
        })
        .collect()
}

/// Make the checkout's git ignore every skill about to be synced before any
/// is written, so a checkout that does not ignore `.claude/` gains no
/// untracked work (owner, ISS-1357, 2026-09-30). Asked per destination: a skill
/// the checkout tracks is its own committed file, which an ignore rule cannot
/// change, and is synced into as it always was, while a new skill beside it
/// still needs the exclude line. The ignore question is put about
/// `.claude/skills/` itself, trailing slash and all: a seed is staged in a
/// sibling of its destination and the tree it replaces is moved to another,
/// so a rule covering only the skill's own directory, or only its `SKILL.md`,
/// leaves those untracked. Whether a skill is the checkout's own is asked of
/// its `SKILL.md` alone, so another tracked file beside it waives nothing.
const SKILLS_DIR: &str = ".claude/skills/";

fn ignore_skills<'a>(worktree: &Path, names: impl IntoIterator<Item = &'a str>) -> Result<()> {
    use crate::daemon::git_exclude::{ensure_ignored_as, Refused};
    for name in names {
        let own = format!(".claude/skills/{name}/SKILL.md");
        match ensure_ignored_as(worktree, &own, SKILLS_DIR) {
            Ok(_) | Err(Refused::Tracked) => {}
            Err(refused) => {
                return Err(Error::Other(format!(
                    "no skill is synced into {}: {SKILLS_DIR} for {name}: {refused}",
                    worktree.display()
                )))
            }
        }
    }
    Ok(())
}

/// Pull the manifest, refresh the local cache for changed skills, seed every
/// skill into `<worktree>/.claude/skills/<name>/`, PRUNE any Forge-managed
/// skill dir no longer in the manifest (ISS-802 converge-on-delete), and
/// report installed hashes, observation fields (ISS-798), and pruned names.
///
/// Best-effort by contract: callers log and continue on `Err` so a transient
/// server failure (or an old server without the endpoint) never blocks a job.
pub async fn sync_skills(client: &CoreClient, project_id: &str, worktree: &Path) -> Result<usize> {
    let manifest = skills::pull_manifest(client, project_id).await?;

    let skills_root = worktree.join(".claude").join("skills");

    let keep: std::collections::HashSet<&str> = manifest.iter().map(|e| e.name.as_str()).collect();
    for dir in find_prunable(&skills_root, &keep) {
        if let Some(name) = dir.file_name().and_then(|n| n.to_str()) {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => tracing::info!("[skills] pruned {name} (not in manifest)"),
                Err(e) => tracing::warn!("[skills] failed to prune {}: {e}", dir.display()),
            }
        }
    }

    if manifest.is_empty() {
        return Ok(0);
    }

    ignore_skills(worktree, manifest.iter().map(|e| e.name.as_str()))?;

    for entry in &manifest {
        let dir = cache_dir(project_id, &entry.skill_id)?;
        let dest = skills_root.join(&entry.name);

        // True no-op fast path: destination already matches, skip entirely
        // (no lock, no content pull, no fs writes).
        if !is_fresh(&dest, &entry.effective_hash) {
            let content = if is_fresh(&dir, &entry.effective_hash) {
                None
            } else {
                Some(skills::pull_content(client, project_id, &entry.skill_id).await?)
            };

            let project_id_owned = project_id.to_string();
            let skill_id = entry.skill_id.clone();
            let effective_hash = entry.effective_hash.clone();
            let dir = dir.clone();
            let dest = dest.clone();
            tokio::task::spawn_blocking(move || {
                sync_one_skill_locked(
                    &project_id_owned,
                    &skill_id,
                    &dir,
                    &dest,
                    &effective_hash,
                    content,
                )
            })
            .await
            .map_err(|e| Error::Other(format!("skill sync task join error: {e}")))??;
        }
    }

    Ok(manifest.len())
}
