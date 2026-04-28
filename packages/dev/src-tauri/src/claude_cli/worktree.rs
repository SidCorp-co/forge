use super::log;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub branch: String,
    pub path: String,
    pub head: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiff {
    pub path: String,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffLine {
    pub kind: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchDiff {
    pub branch: String,
    pub base: String,
    pub files: Vec<FileDiff>,
    pub total_additions: usize,
    pub total_deletions: usize,
}

/// Sanitize a branch name for use as a directory name.
fn dir_name(branch: &str) -> String {
    branch.replace('/', "-")
}

/// Create a git worktree at `.worktrees/<branch>` with a new branch.
/// If the worktree already exists, returns its path.
pub async fn create_worktree(repo_path: &str, branch_name: &str) -> Result<String, String> {
    let repo = Path::new(repo_path);
    let worktrees_dir = repo.join(".worktrees");
    let wt_path = worktrees_dir.join(dir_name(branch_name));

    // If worktree already exists, return its path
    if wt_path.exists() {
        log(&format!("[worktree] already exists: {}", wt_path.display()));
        return Ok(wt_path.to_string_lossy().to_string());
    }

    // Ensure .worktrees dir exists
    std::fs::create_dir_all(&worktrees_dir)
        .map_err(|e| format!("Failed to create .worktrees dir: {e}"))?;

    ensure_gitignore(repo_path);

    // Try creating with new branch first
    let output = Command::new("git")
        .args(["worktree", "add", &wt_path.to_string_lossy(), "-b", branch_name])
        .current_dir(repo)
        .output()
        .await
        .map_err(|e| format!("Failed to run git worktree add: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Branch may already exist — try without -b
        if stderr.contains("already exists") {
            let output2 = Command::new("git")
                .args(["worktree", "add", &wt_path.to_string_lossy(), branch_name])
                .current_dir(repo)
                .output()
                .await
                .map_err(|e| format!("Failed to run git worktree add: {e}"))?;

            if !output2.status.success() {
                let stderr2 = String::from_utf8_lossy(&output2.stderr);
                return Err(format!("git worktree add failed: {stderr2}"));
            }
        } else {
            return Err(format!("git worktree add failed: {stderr}"));
        }
    }

    log(&format!("[worktree] created: {} -> {}", branch_name, wt_path.display()));
    Ok(wt_path.to_string_lossy().to_string())
}

/// Remove a git worktree.
pub async fn remove_worktree(repo_path: &str, branch_name: &str) -> Result<(), String> {
    let repo = Path::new(repo_path);
    let wt_path = repo.join(".worktrees").join(dir_name(branch_name));

    let output = Command::new("git")
        .args(["worktree", "remove", &wt_path.to_string_lossy(), "--force"])
        .current_dir(repo)
        .output()
        .await
        .map_err(|e| format!("Failed to run git worktree remove: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree remove failed: {stderr}"));
    }

    log(&format!("[worktree] removed: {}", branch_name));
    Ok(())
}

/// List all worktrees under `.worktrees/`.
pub async fn list_worktrees(repo_path: &str) -> Result<Vec<WorktreeInfo>, String> {
    let repo = Path::new(repo_path);
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo)
        .output()
        .await
        .map_err(|e| format!("Failed to run git worktree list: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let worktrees_prefix = repo.join(".worktrees").to_string_lossy().to_string();

    let mut result = Vec::new();
    let mut current_path = String::new();
    let mut current_head = String::new();
    let mut current_branch = String::new();

    // Append a trailing blank line so the last entry is flushed by the same logic
    let lines = stdout.lines().chain(std::iter::once(""));
    for line in lines {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = path.to_string();
            current_head.clear();
            current_branch.clear();
        } else if let Some(head) = line.strip_prefix("HEAD ") {
            current_head = head.to_string();
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            current_branch = branch.to_string();
        } else if line.is_empty() && !current_path.is_empty() {
            if current_path.contains(&worktrees_prefix) {
                result.push(WorktreeInfo {
                    branch: std::mem::take(&mut current_branch),
                    path: std::mem::take(&mut current_path),
                    head: std::mem::take(&mut current_head),
                });
            }
            current_path.clear();
        }
    }

    Ok(result)
}

/// Remove worktrees whose branches have been merged into the given main branch.
pub async fn cleanup_merged_worktrees(repo_path: &str, main_branch: &str) -> Result<Vec<String>, String> {
    let repo = Path::new(repo_path);

    // Get list of merged branches
    let output = Command::new("git")
        .args(["branch", "--merged", main_branch])
        .current_dir(repo)
        .output()
        .await
        .map_err(|e| format!("Failed to list merged branches: {e}"))?;

    let merged_stdout = String::from_utf8_lossy(&output.stdout);
    let merged: Vec<String> = merged_stdout
        .lines()
        .map(|l| l.trim().trim_start_matches("* ").to_string())
        .filter(|b| !b.is_empty() && b != main_branch)
        .collect();

    let worktrees = list_worktrees(repo_path).await?;
    let mut removed = Vec::new();

    for wt in &worktrees {
        if merged.contains(&wt.branch) {
            match remove_worktree(repo_path, &wt.branch).await {
                Ok(()) => {
                    // Also delete the branch
                    let _ = Command::new("git")
                        .args(["branch", "-d", &wt.branch])
                        .current_dir(repo)
                        .output()
                        .await;
                    removed.push(wt.branch.clone());
                }
                Err(e) => log(&format!("[worktree] cleanup failed for {}: {e}", wt.branch)),
            }
        }
    }

    log(&format!("[worktree] cleanup: removed {} merged worktrees", removed.len()));
    Ok(removed)
}

/// Get diff between a branch and its base (e.g. main).
/// Returns structured diff data with per-file changes.
pub async fn get_branch_diff(repo_path: &str, branch: &str, base: &str) -> Result<BranchDiff, String> {
    let repo = Path::new(repo_path);

    // Use merge-base to find common ancestor, then diff with ..
    let merge_base_out = Command::new("git")
        .args(["merge-base", base, branch])
        .current_dir(repo)
        .output()
        .await
        .map_err(|e| format!("Failed to get merge-base: {e}"))?;

    let base_ref = if merge_base_out.status.success() {
        String::from_utf8_lossy(&merge_base_out.stdout).trim().to_string()
    } else {
        base.to_string()
    };

    let diff_range = format!("{}..{}", base_ref, branch);

    // Get diff with unified context
    let output = Command::new("git")
        .args(["diff", &diff_range, "--unified=3", "--no-color"])
        .current_dir(repo)
        .output()
        .await
        .map_err(|e| format!("Failed to get diff: {e}"))?;

    let diff_text = String::from_utf8_lossy(&output.stdout);

    // Also get numstat for file-level additions/deletions
    let stat_output = Command::new("git")
        .args(["diff", &diff_range, "--numstat"])
        .current_dir(repo)
        .output()
        .await
        .map_err(|e| format!("Failed to get numstat: {e}"))?;

    let stat_text = String::from_utf8_lossy(&stat_output.stdout);

    // Parse numstat for additions/deletions per file
    let mut file_stats = std::collections::HashMap::<String, (usize, usize)>::new();
    for line in stat_text.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 {
            let adds = parts[0].parse::<usize>().unwrap_or(0);
            let dels = parts[1].parse::<usize>().unwrap_or(0);
            let path = parts[2..].join("\t");
            file_stats.insert(path, (adds, dels));
        }
    }

    // Parse unified diff into structured hunks.
    // Diff order per file: diff --git → new/deleted/rename headers → --- → +++ → @@ hunks
    // We track pending_status from headers that appear before +++ creates the FileDiff.
    let mut files: Vec<FileDiff> = Vec::new();
    let mut current_file: Option<FileDiff> = None;
    let mut current_hunk: Option<DiffHunk> = None;
    let mut pending_status: Option<String> = None;
    let mut pending_deleted_path: Option<String> = None;

    for line in diff_text.lines() {
        if line.starts_with("diff --git") {
            // Flush previous hunk and file
            if let Some(ref mut f) = current_file {
                if let Some(h) = current_hunk.take() {
                    f.hunks.push(h);
                }
                files.push(f.clone());
            }
            current_file = None;
            current_hunk = None;
            pending_status = None;
            pending_deleted_path = None;
        } else if line.starts_with("new file mode") {
            pending_status = Some("added".to_string());
        } else if line.starts_with("deleted file mode") {
            pending_status = Some("deleted".to_string());
        } else if line.starts_with("rename from") {
            pending_status = Some("renamed".to_string());
        } else if let Some(path) = line.strip_prefix("--- a/") {
            // For deleted files, +++ will be /dev/null, so save the path here
            if pending_status.as_deref() == Some("deleted") {
                pending_deleted_path = Some(path.to_string());
            }
        } else if line.starts_with("+++ b/") {
            let path = line.strip_prefix("+++ b/").unwrap_or("").to_string();
            let (adds, dels) = file_stats.get(&path).copied().unwrap_or((0, 0));
            let status = pending_status.take().unwrap_or_else(|| "modified".to_string());
            current_file = Some(FileDiff {
                path,
                status,
                additions: adds,
                deletions: dels,
                hunks: Vec::new(),
            });
        } else if line.starts_with("+++ /dev/null") {
            // Deleted file — use path from --- line
            if let Some(path) = pending_deleted_path.take() {
                let (adds, dels) = file_stats.get(&path).copied().unwrap_or((0, 0));
                current_file = Some(FileDiff {
                    path,
                    status: pending_status.take().unwrap_or_else(|| "deleted".to_string()),
                    additions: adds,
                    deletions: dels,
                    hunks: Vec::new(),
                });
            }
        } else if line.starts_with("@@") {
            if let Some(ref mut f) = current_file {
                if let Some(h) = current_hunk.take() {
                    f.hunks.push(h);
                }
            }
            current_hunk = Some(DiffHunk {
                header: line.to_string(),
                lines: Vec::new(),
            });
        } else if let Some(ref mut h) = current_hunk {
            let kind = if line.starts_with('+') {
                "add"
            } else if line.starts_with('-') {
                "remove"
            } else {
                "context"
            };
            h.lines.push(DiffLine {
                kind: kind.to_string(),
                content: if line.len() > 1 { line[1..].to_string() } else { String::new() },
            });
        }
    }

    // Flush last file
    if let Some(ref mut f) = current_file {
        if let Some(h) = current_hunk.take() {
            f.hunks.push(h);
        }
        files.push(f.clone());
    }

    // Add binary files that appear in numstat but not in unified diff output
    for (path, (adds, dels)) in &file_stats {
        if !files.iter().any(|f| &f.path == path) {
            files.push(FileDiff {
                path: path.clone(),
                status: "modified".to_string(),
                additions: *adds,
                deletions: *dels,
                hunks: Vec::new(),
            });
        }
    }

    let total_additions = files.iter().map(|f| f.additions).sum();
    let total_deletions = files.iter().map(|f| f.deletions).sum();

    log(&format!("[worktree] diff {base}..{branch}: {} files, +{total_additions} -{total_deletions}", files.len()));

    Ok(BranchDiff {
        branch: branch.to_string(),
        base: base.to_string(),
        files,
        total_additions,
        total_deletions,
    })
}

/// Ensure `.worktrees` is in `.gitignore`.
fn ensure_gitignore(repo_path: &str) {
    let gitignore = PathBuf::from(repo_path).join(".gitignore");
    let content = std::fs::read_to_string(&gitignore).unwrap_or_default();
    if !content.lines().any(|l| l.trim() == ".worktrees") {
        let append = if content.ends_with('\n') || content.is_empty() {
            ".worktrees\n".to_string()
        } else {
            "\n.worktrees\n".to_string()
        };
        if let Err(e) = std::fs::write(&gitignore, format!("{content}{append}")) {
            log(&format!("[worktree] failed to update .gitignore: {e}"));
        }
    }
}
