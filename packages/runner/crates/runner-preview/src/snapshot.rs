//! What a preview serves, read when a person approves it (BC-9, BC-7): the patch id of the
//! worktree's change against its base, uncommitted and untracked edits included, and the files it
//! touches. Read through a throwaway index, so the run's own index is never written.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub base: String,
    pub patch_id: String,
    pub files: Vec<String>,
}

async fn git(dir: &Path, index: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir).args(args).stdin(Stdio::null());
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The commit the run's change is measured against: where HEAD left its upstream, else origin's
/// default branch.
async fn base_of(dir: &Path) -> Result<String, String> {
    for upstream in ["@{upstream}", "origin/HEAD"] {
        if let Ok(base) = git(dir, None, &["merge-base", "HEAD", upstream]).await {
            return Ok(base.trim().to_string());
        }
    }
    Err("the worktree's branch has no upstream and origin names no default branch, so its change has no base".into())
}

struct TempIndex(PathBuf);

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// `git patch-id --stable` of `diff`: the id of the change, whatever its commits.
async fn patch_id(dir: &Path, diff: &str) -> Result<String, String> {
    let mut child = Command::new("git")
        .current_dir(dir)
        .args(["patch-id", "--stable"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git patch-id: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(diff.as_bytes())
            .await
            .map_err(|e| format!("git patch-id: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("git patch-id: {e}"))?;
    let id = String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
    if id.len() == 40 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(id)
    } else {
        Err("the worktree holds no change against its base, so there is nothing to approve".into())
    }
}

/// The change the worktree at `dir` serves now.
pub async fn read(dir: &Path) -> Result<Snapshot, String> {
    let base = base_of(dir).await?;
    let index = TempIndex(
        std::env::temp_dir().join(format!("forge-preview-index-{}", uuid::Uuid::new_v4())),
    );
    git(dir, Some(&index.0), &["read-tree", "HEAD"]).await?;
    git(dir, Some(&index.0), &["add", "-A"]).await?;
    let diff = git(
        dir,
        Some(&index.0),
        &["diff", "--cached", "--binary", &base],
    )
    .await?;
    let names = git(
        dir,
        Some(&index.0),
        &["diff", "--cached", "--name-only", &base],
    )
    .await?;
    let patch_id = patch_id(dir, &diff).await?;
    Ok(Snapshot {
        base,
        patch_id,
        files: names.lines().map(str::to_string).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn sh(dir: &Path, script: &str) {
        let ok = Command::new("sh")
            .current_dir(dir)
            .args(["-c", script])
            .status()
            .await
            .expect("sh runs")
            .success();
        assert!(ok, "{script}");
    }

    #[tokio::test]
    async fn a_snapshot_counts_uncommitted_and_untracked_edits_and_leaves_the_index_alone() {
        let root = std::env::temp_dir().join(format!("forge-snap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        sh(&root, "git init -q -b main origin && cd origin && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m base && echo a > a.txt && git add a.txt && git -c user.email=a@b -c user.name=a commit -q -m a").await;
        sh(
            &root,
            "git clone -q origin work && cd work && git checkout -q -b run origin/main",
        )
        .await;
        let work = root.join("work");
        assert!(read(&work).await.unwrap_err().contains("no change"));
        sh(
            &work,
            "echo b >> a.txt && mkdir -p web && echo new > web/new.tsx",
        )
        .await;
        let first = read(&work).await.expect("a snapshot of the edits");
        assert_eq!(first.files, vec!["a.txt", "web/new.tsx"]);
        assert_eq!(first.patch_id.len(), 40);
        let status = git(&work, None, &["status", "--porcelain"]).await.unwrap();
        assert!(
            status.contains("?? web/"),
            "the run's index is untouched: {status}"
        );
        sh(
            &work,
            "git add -A && git -c user.email=a@b -c user.name=a commit -q -m change",
        )
        .await;
        let committed = read(&work).await.expect("the same change, committed");
        assert_eq!(
            committed.patch_id, first.patch_id,
            "committing does not change what was seen"
        );
        sh(&work, "echo c >> a.txt").await;
        assert_ne!(read(&work).await.unwrap().patch_id, first.patch_id);
        let _ = std::fs::remove_dir_all(&root);
    }
}
