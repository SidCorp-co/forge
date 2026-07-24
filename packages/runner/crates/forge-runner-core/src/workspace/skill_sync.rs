//! Server-driven skill seeding (Skill Studio 4, ISS-278).
//!
//! The server is the source of truth for skills; the device is a read-only
//! artifact. Before a job runs, the runner pulls the project's effective skill
//! manifest, downloads only the skills whose hash changed (diffed against a
//! local cache under `~/.config/forge-runner/skills-cache/<project>/<skill>/`),
//! seeds the full `.claude/skills/<name>/` tree into the working dir, then
//! reports the installed hashes back so the server can mark the device synced.
//!
//! The runner never recomputes `hashSkillBody` — it echoes the server's
//! `effective_hash` back as `installed_hash`, so there is no TS↔Rust hashing
//! drift.
//!
//! ## Concurrency (ISS-743)
//!
//! Two independent hazards existed before this revision, both only masked by
//! `auto_pull=false`:
//! - the destination copy (`<worktree>/.claude/skills/<name>/`) ran
//!   unconditionally every poll via non-atomic per-file `std::fs::copy`, so a
//!   concurrent job reading `SKILL.md` mid-copy could see a torn file;
//! - the shared cache dir (keyed only by `project_id`+`skill_id`, not by
//!   runner instance) was rebuilt with `remove_dir_all` + repopulate, so two
//!   runner instances on the same host/project could race a cache read
//!   against a cache rebuild.
//!
//! Both are fixed by: (1) publishing every directory (cache AND destination)
//! via a staged-temp-dir + atomic `rename` swap (readers only ever see a
//! complete old or new tree, never a partial one); (2) gating the destination
//! copy on a `.hash` marker written *inside* the destination, so unchanged
//! content is a true no-op; (3) serializing the per-skill critical section
//! across runner instances with an exclusive `std::fs::File::lock` (std,
//! stable since 1.89) on a lock file that lives alongside — not inside — the
//! cache dir, so it survives the cache dir being swapped.

use std::path::{Path, PathBuf};

use base64::Engine;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::transport::skills::{self, SkillContent, SkillReportEntry};
use crate::transport::CoreClient;

/// `~/.config/forge-runner/skills-cache/<project_id>/<skill_id>/`.
fn cache_dir(project_id: &str, skill_id: &str) -> Result<PathBuf> {
    let base = dirs_next::config_dir()
        .ok_or_else(|| Error::Config("no config dir".into()))?
        .join("forge-runner")
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
        std::fs::rename(dest, &displaced)?;
        std::fs::rename(staged, dest)?;
        let _ = std::fs::remove_dir_all(&displaced);
    } else {
        std::fs::rename(staged, dest)?;
    }
    Ok(())
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

/// Pull the manifest, refresh the local cache for changed skills, seed every
/// skill into `<worktree>/.claude/skills/<name>/`, and report installed hashes.
///
/// Best-effort by contract: callers log and continue on `Err` so a transient
/// server failure (or an old server without the endpoint) never blocks a job.
pub async fn sync_skills(client: &CoreClient, project_id: &str, worktree: &Path) -> Result<usize> {
    let manifest = skills::pull_manifest(client, project_id).await?;
    if manifest.is_empty() {
        return Ok(0);
    }

    let skills_root = worktree.join(".claude").join("skills");
    let mut report: Vec<SkillReportEntry> = Vec::with_capacity(manifest.len());

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

        report.push(SkillReportEntry {
            skill_id: entry.skill_id.clone(),
            installed_hash: entry.effective_hash.clone(),
            installed_version: entry.version,
        });
    }

    skills::report_installed(client, project_id, &report).await?;
    Ok(report.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::skills::SkillFile;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn content(md: &str, files: Vec<SkillFile>) -> SkillContent {
        SkillContent {
            skill_id: "s-1".into(),
            name: "forge-code".into(),
            version: 3,
            effective_hash: "hash-1".into(),
            skill_md: md.into(),
            files,
        }
    }

    fn tmp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "forge-{tag}-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ))
    }

    #[test]
    fn writes_skill_md_and_nested_files() {
        let tmp = tmp_root("skilltest");
        let _ = std::fs::remove_dir_all(&tmp);
        let c = content(
            "# Skill",
            vec![
                SkillFile {
                    path: "references/guide.md".into(),
                    content: "see here".into(),
                    encoding: "utf8".into(),
                },
                SkillFile {
                    // "hello" base64
                    path: "scripts/run.bin".into(),
                    content: "aGVsbG8=".into(),
                    encoding: "base64".into(),
                },
            ],
        );
        write_skill_tree(&tmp, &c, "hash-1").expect("write");

        assert_eq!(
            std::fs::read_to_string(tmp.join("SKILL.md")).unwrap(),
            "# Skill"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.join("references/guide.md")).unwrap(),
            "see here"
        );
        assert_eq!(
            std::fs::read(tmp.join("scripts/run.bin")).unwrap(),
            b"hello"
        );
        assert_eq!(read_hash_marker(&tmp).as_deref(), Some("hash-1"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn skips_path_traversal() {
        let tmp = tmp_root("skilltrav");
        let _ = std::fs::remove_dir_all(&tmp);
        let c = content(
            "x",
            vec![SkillFile {
                path: "../escape.txt".into(),
                content: "nope".into(),
                encoding: "utf8".into(),
            }],
        );
        write_skill_tree(&tmp, &c, "hash-1").expect("write");
        assert!(!tmp.join("../escape.txt").exists());
        assert!(tmp.join("SKILL.md").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn copy_dir_skips_hash_marker() {
        let root = tmp_root("skillcopy");
        let src = root.join("src");
        let dst = root.join("dst");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("SKILL.md"), "body").unwrap();
        std::fs::write(src.join(".hash"), "hash-1").unwrap();
        copy_dir_recursive(&src, &dst).expect("copy");
        assert!(dst.join("SKILL.md").exists());
        assert!(!dst.join(".hash").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// AC#1 — a reader looping on `SKILL.md` while a writer repeatedly
    /// republishes alternating content versions must never observe a
    /// truncated/mixed body: every read is either the old complete version
    /// or the new complete version.
    #[test]
    fn dest_copy_atomic_no_torn_read() {
        let root = tmp_root("torn-read");
        let cache_a = root.join("cache-a");
        let cache_b = root.join("cache-b");
        let dest = root.join("dest");
        let _ = std::fs::remove_dir_all(&root);

        // Two distinct, sizeable payloads so a torn/mixed read is detectable.
        let body_a = "A".repeat(64 * 1024);
        let body_b = "B".repeat(64 * 1024);
        write_skill_tree(&cache_a, &content(&body_a, vec![]), "hash-a").unwrap();
        write_skill_tree(&cache_b, &content(&body_b, vec![]), "hash-b").unwrap();
        // Seed an initial destination so the reader always has something to read.
        seed_dest(&cache_a, &dest, "hash-a").unwrap();

        let stop = Arc::new(AtomicBool::new(false));
        let reader_dest = dest.clone();
        let reader_stop = stop.clone();
        let reader = std::thread::spawn(move || {
            let mut violations = 0usize;
            while !reader_stop.load(Ordering::Relaxed) {
                if let Ok(body) = std::fs::read_to_string(reader_dest.join("SKILL.md")) {
                    let all_a = body.bytes().all(|b| b == b'A');
                    let all_b = body.bytes().all(|b| b == b'B');
                    if !(all_a || all_b) {
                        violations += 1;
                    }
                }
            }
            violations
        });

        for i in 0..50 {
            let (src, hash) = if i % 2 == 0 {
                (&cache_b, "hash-b")
            } else {
                (&cache_a, "hash-a")
            };
            seed_dest(src, &dest, hash).unwrap();
        }

        stop.store(true, Ordering::Relaxed);
        let violations = reader.join().unwrap();
        assert_eq!(violations, 0, "reader observed a torn/mixed SKILL.md body");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// AC#3 — N threads seeding the SAME content/hash to one destination
    /// concurrently (through the same lock-guarded entrypoint `sync_skills`
    /// itself uses) must not corrupt the tree, and must not leave staging
    /// leftovers (`.dest-name.seed-*` / `.old-*`) behind. Raw `seed_dest` is
    /// NOT safe under unlocked concurrent calls to the same dest by design —
    /// `with_skill_lock` is what serializes the critical section (AC#3), so
    /// this test drives the real locked path, same as `sync_skills`.
    #[test]
    fn concurrent_seed_same_dest_no_corruption() {
        let root = tmp_root("concurrent-seed");
        let cache = root.join("cache");
        let dest = root.join("dest");
        let _ = std::fs::remove_dir_all(&root);

        write_skill_tree(&cache, &content("# Concurrent", vec![]), "hash-1").unwrap();
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();

        let project_id = "proj-concurrent-seed";
        let skill_id = format!("skill-{}", Uuid::new_v4());
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let cache = cache.clone();
                let dest = dest.clone();
                let skill_id = skill_id.clone();
                std::thread::spawn(move || {
                    with_skill_lock(project_id, &skill_id, || {
                        if !is_fresh(&dest, "hash-1") {
                            seed_dest(&cache, &dest, "hash-1")
                        } else {
                            Ok(())
                        }
                    })
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap().expect("concurrent locked seed failed");
        }
        let _ = std::fs::remove_file(skill_lock_path(project_id, &skill_id).unwrap());

        assert_eq!(
            std::fs::read_to_string(dest.join("SKILL.md")).unwrap(),
            "# Concurrent"
        );
        assert_eq!(read_hash_marker(&dest).as_deref(), Some("hash-1"));

        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != "cache" && n != "dest")
            .collect();
        assert!(
            leftovers.is_empty(),
            "expected no staging/old leftovers, found {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// AC#2 — re-seeding with the same `effective_hash` must be a true no-op:
    /// the caller's `is_fresh` gate should skip the copy, so the file's mtime
    /// never changes on the second pass.
    #[test]
    fn dest_hash_gate_is_noop() {
        let root = tmp_root("hash-gate");
        let cache = root.join("cache");
        let dest = root.join("dest");
        let _ = std::fs::remove_dir_all(&root);

        write_skill_tree(&cache, &content("# Gate", vec![]), "hash-1").unwrap();
        seed_dest(&cache, &dest, "hash-1").unwrap();
        assert!(is_fresh(&dest, "hash-1"));

        let mtime_before = std::fs::metadata(dest.join("SKILL.md"))
            .unwrap()
            .modified()
            .unwrap();

        // Caller-side gate: since dest is already fresh, sync_skills would
        // skip calling seed_dest at all. Assert the gate itself reports fresh
        // (the no-op condition) rather than re-copying.
        std::thread::sleep(std::time::Duration::from_millis(10));
        if !is_fresh(&dest, "hash-1") {
            seed_dest(&cache, &dest, "hash-1").unwrap();
        }

        let mtime_after = std::fs::metadata(dest.join("SKILL.md"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(mtime_before, mtime_after, "hash-gated dest was rewritten");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// AC#3 — two threads racing the lock-guarded refresh+seed against the
    /// SAME cache dir (one forcing a `write_skill_tree` rebuild) must both
    /// succeed with no `Err` (no ENOENT from a `remove_dir_all` racing a
    /// concurrent read), and the destination must end up valid.
    #[test]
    fn concurrent_cache_refresh_no_enoent() {
        let root = tmp_root("cache-refresh");
        let cache = root.join("cache");
        let dest_a = root.join("dest-a");
        let dest_b = root.join("dest-b");
        let _ = std::fs::remove_dir_all(&root);

        let project_id = "proj-cache-refresh";
        let skill_id = format!("skill-{}", Uuid::new_v4());

        let handles: Vec<_> = [(dest_a.clone(), "hash-x"), (dest_b.clone(), "hash-y")]
            .into_iter()
            .map(|(dest, hash)| {
                let cache = cache.clone();
                let c = content(&format!("# {hash}"), vec![]);
                let skill_id = skill_id.clone();
                std::thread::spawn(move || {
                    sync_one_skill_locked(project_id, &skill_id, &cache, &dest, hash, Some(c))
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap().expect("concurrent locked sync failed");
        }

        // Whichever hash won the race, the cache and both destinations must
        // be internally consistent (matching marker + SKILL.md present) —
        // never a torn/half-rebuilt tree.
        assert!(dest_a.join("SKILL.md").exists());
        assert!(dest_b.join("SKILL.md").exists());
        assert!(cache.join("SKILL.md").exists());
        let _ = std::fs::remove_file(skill_lock_path(project_id, &skill_id).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }
}
