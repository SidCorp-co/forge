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

use std::path::{Path, PathBuf};

use base64::Engine;

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

/// Read the cached hash marker (`.hash`) if present.
fn read_cached_hash(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(".hash"))
        .ok()
        .map(|s| s.trim().to_string())
}

/// Write one skill body into a directory tree: `SKILL.md` at the root plus
/// every `files[]` entry at its relative path (decoding base64 binaries).
/// Refuses paths that escape the target dir (`..`, absolute) to avoid a
/// path-traversal write outside the skill folder.
fn write_skill_tree(dir: &Path, content: &SkillContent) -> Result<()> {
    // Start clean so a removed file in a new version doesn't linger.
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join("SKILL.md"), content.skill_md.as_bytes())?;

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
        let dest = dir.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if f.encoding == "base64" {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(f.content.as_bytes())
                .map_err(|e| Error::Other(format!("skill file base64 decode ({}): {e}", f.path)))?;
            std::fs::write(&dest, bytes)?;
        } else {
            std::fs::write(&dest, f.content.as_bytes())?;
        }
    }
    Ok(())
}

/// Copy a cached skill tree into `<worktree>/.claude/skills/<name>/`.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        // Don't carry the internal `.hash` marker into the worktree.
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
        let cached = read_cached_hash(&dir);
        let fresh = cached.as_deref() == Some(entry.effective_hash.as_str())
            && dir.join("SKILL.md").exists();

        if !fresh {
            let content = skills::pull_content(client, project_id, &entry.skill_id).await?;
            write_skill_tree(&dir, &content)?;
            std::fs::write(dir.join(".hash"), entry.effective_hash.as_bytes())?;
        }

        // Seed into the working dir under the skill's name.
        let dest = skills_root.join(&entry.name);
        copy_dir_recursive(&dir, &dest)?;

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

    #[test]
    fn writes_skill_md_and_nested_files() {
        let tmp = std::env::temp_dir().join(format!("forge-skilltest-{}", std::process::id()));
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
        write_skill_tree(&tmp, &c).expect("write");

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
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn skips_path_traversal() {
        let tmp = std::env::temp_dir().join(format!("forge-skilltrav-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let c = content(
            "x",
            vec![SkillFile {
                path: "../escape.txt".into(),
                content: "nope".into(),
                encoding: "utf8".into(),
            }],
        );
        write_skill_tree(&tmp, &c).expect("write");
        assert!(!tmp.join("../escape.txt").exists());
        assert!(tmp.join("SKILL.md").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn copy_dir_skips_hash_marker() {
        let root = std::env::temp_dir().join(format!("forge-skillcopy-{}", std::process::id()));
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
}
