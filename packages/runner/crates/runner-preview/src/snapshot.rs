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
    /// The branch head after a keep committed the edits; `None` for an approval's read.
    pub head: Option<String>,
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
        head: None,
    })
}

/// Where a kept sketch's head is pinned, so the branch being deleted or its worktree pruned never
/// leaves "Reopen live" with a commit git may collect.
pub fn kept_ref(preview_id: &str) -> String {
    format!("refs/forge/kept/{preview_id}")
}

/// Keep a sketch (REQ-41 BC-16): commit everything the run left in the worktree to its sketch branch
/// (nothing, where it is already committed), pin the head under [`kept_ref`], and read the change
/// the head now holds. The commit hooks are not run: this is a snapshot, not the run's work.
pub async fn keep(dir: &Path, preview_id: &str) -> Result<Snapshot, String> {
    git(dir, None, &["add", "-A"]).await?;
    let staged = git(dir, None, &["diff", "--cached", "--name-only"]).await?;
    if !staged.trim().is_empty() {
        git(
            dir,
            None,
            &[
                "-c",
                "user.name=Forge sketch",
                "-c",
                "user.email=sketch@forge.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--no-verify",
                "-q",
                "-m",
                &format!("Forge sketch kept as preview {preview_id}"),
            ],
        )
        .await?;
    }
    let head = git(dir, None, &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_string();
    git(dir, None, &["update-ref", &kept_ref(preview_id), &head]).await?;
    let mut snapshot = read(dir).await?;
    snapshot.head = Some(head);
    Ok(snapshot)
}

/// `preview.snapshot.read`'s `settle` (REQ-44 BC-8): the branch a settled POC room merges into, and
/// the merge commit's message. Core never names main or the branch production deploys from.
#[derive(Debug, Clone, serde::Deserialize, PartialEq, Eq)]
pub struct SettleAsk {
    pub into: String,
    pub message: String,
}

/// Whether `name` is a branch name a settle may push to: `git check-ref-format --branch` rules, kept
/// to what a dev branch is named with, and never main or master whatever core said.
fn mergeable_branch(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 250
        && !matches!(name, "main" | "master")
        && !name.starts_with(['-', '/'])
        && !name.ends_with(['/', '.'])
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/'))
}

/// Settle a kept sketch (REQ-44 BC-8): fetch origin's `into`, merge the sketch branch into it `--no-ff`
/// in a checkout of its own beside the sketch's, and push the merge to origin's `into`. No hook runs
/// (`--no-verify` on the merge and the push): the gates follow the merge as their own issue. Answers
/// the merge commit, or git's own words where the merge or the push did not land; a conflict leaves
/// origin untouched. The sketch's own checkout and index are never written.
pub async fn settle(dir: &Path, branch: &str, ask: &SettleAsk) -> Result<String, String> {
    if !mergeable_branch(&ask.into) {
        return Err(format!(
            "core named {} to merge into, which a POC room never merges into: a dev branch only, never main, master or a malformed name",
            ask.into
        ));
    }
    let into = ask.into.as_str();
    let remote_ref = format!("refs/remotes/origin/{into}");
    git(
        dir,
        None,
        &[
            "fetch",
            "--quiet",
            "--no-tags",
            "origin",
            &format!("+refs/heads/{into}:{remote_ref}"),
        ],
    )
    .await?;
    let at = dir.with_file_name(format!(
        "{}-settle",
        dir.file_name().and_then(|n| n.to_str()).unwrap_or("sketch")
    ));
    let _ = std::fs::remove_dir_all(&at);
    let place = at.to_string_lossy().into_owned();
    git(dir, None, &["worktree", "prune"]).await?;
    git(dir, None, &["worktree", "add", "--detach", &place, &remote_ref]).await?;
    let merged = async {
        let identity = [
            "-c",
            "user.name=Forge POC room",
            "-c",
            "user.email=poc-room@forge.invalid",
            "-c",
            "commit.gpgsign=false",
        ];
        let mut merge: Vec<&str> = identity.to_vec();
        merge.extend(["merge", "--no-ff", "--no-verify", "-q", "-m", &ask.message, branch]);
        if let Err(e) = git(&at, None, &merge).await {
            let _ = git(&at, None, &["merge", "--abort"]).await;
            return Err(format!("the merge of {branch} into {into} conflicts: {e}"));
        }
        let sha = git(&at, None, &["rev-parse", "HEAD"]).await?.trim().to_string();
        git(
            &at,
            None,
            &[
                "push",
                "--quiet",
                "--no-verify",
                "origin",
                &format!("HEAD:refs/heads/{into}"),
            ],
        )
        .await
        .map_err(|e| format!("the merge {sha} was not pushed to origin's {into}: {e}"))?;
        Ok(sha)
    }
    .await;
    let _ = git(dir, None, &["worktree", "remove", "--force", &place]).await;
    merged
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

    #[tokio::test]
    async fn a_keep_commits_what_the_run_left_pins_the_head_and_reports_it() {
        let root = std::env::temp_dir().join(format!("forge-keep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        sh(&root, "git init -q -b main origin && cd origin && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m base && echo a > a.txt && git add a.txt && git -c user.email=a@b -c user.name=a commit -q -m a").await;
        sh(
            &root,
            "git clone -q origin work && cd work && git checkout -q -b sketch/req-1-abcdef origin/main",
        )
        .await;
        let work = root.join("work");
        sh(
            &work,
            "echo b >> a.txt && mkdir -p web && echo new > web/new.tsx",
        )
        .await;
        let before = read(&work).await.expect("a read of the edits");
        let kept = keep(&work, "p1").await.expect("a keep");
        let head = kept.head.clone().expect("a keep reports the head");
        assert_eq!(head.len(), 40);
        assert_eq!(
            kept.patch_id, before.patch_id,
            "committing the edits does not change the change that was seen"
        );
        assert_eq!(
            git(&work, None, &["status", "--porcelain"]).await.unwrap(),
            "",
            "nothing is left uncommitted"
        );
        assert_eq!(
            git(&work, None, &["rev-parse", &kept_ref("p1")])
                .await
                .unwrap()
                .trim(),
            head,
            "the head is pinned"
        );
        let again = keep(&work, "p1")
            .await
            .expect("a second keep with nothing new");
        assert_eq!(
            again.head,
            Some(head),
            "a clean worktree keeps at the same head"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// REQ-44 BC-8: a settle merges the kept sketch straight into origin's dev branch and pushes it,
    /// leaving main untouched; a conflict lands nothing; main and master are refused by name.
    #[tokio::test]
    async fn a_settle_merges_the_sketch_into_origins_dev_branch_and_nothing_else() {
        let root = std::env::temp_dir().join(format!("forge-settle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        sh(&root, "git init -q --bare origin.git && git clone -q origin.git seed 2>/dev/null && cd seed && git checkout -q -b main && echo a > a.txt && git add a.txt && git -c user.email=a@b -c user.name=a commit -q -m base && git push -q origin main && git checkout -q -b dev && echo d > dev.txt && git add dev.txt && git -c user.email=a@b -c user.name=a commit -q -m dev && git push -q origin dev").await;
        sh(&root, "git clone -q origin.git repo && cd repo && mkdir -p .claude/worktrees && git worktree add -q -b sketch/req-44-abcdef .claude/worktrees/sketch-req-44-abcdef origin/dev").await;
        let work = root.join("repo/.claude/worktrees/sketch-req-44-abcdef");
        sh(&work, "echo settled > web.txt").await;
        let kept = keep(&work, "p9").await.expect("a keep");
        let main_before = git(&root.join("origin.git"), None, &["rev-parse", "main"]).await.unwrap();
        let ask = SettleAsk { into: "dev".into(), message: "Merge POC room r1".into() };
        let sha = settle(&work, "sketch/req-44-abcdef", &ask).await.expect("the merge lands");
        let origin = root.join("origin.git");
        assert_eq!(git(&origin, None, &["rev-parse", "dev"]).await.unwrap().trim(), sha, "origin's dev is the merge");
        let parents = git(&origin, None, &["rev-list", "--parents", "-n", "1", "dev"]).await.unwrap();
        assert!(parents.contains(kept.head.as_deref().unwrap()), "the merge's second parent is the kept head: {parents}");
        assert_eq!(git(&origin, None, &["show", "dev:web.txt"]).await.unwrap().trim(), "settled");
        assert_eq!(git(&origin, None, &["rev-parse", "main"]).await.unwrap(), main_before, "main is untouched");
        assert!(!root.join("repo/.claude/worktrees/sketch-req-44-abcdef-settle").exists(), "the merge checkout is removed");

        // a conflict lands nothing and says so
        sh(&root, "cd seed && git checkout -q dev && git pull -q origin dev && echo theirs > web.txt && git add web.txt && git -c user.email=a@b -c user.name=a commit -q -m clash && git push -q origin dev").await;
        let before = git(&origin, None, &["rev-parse", "dev"]).await.unwrap();
        sh(&work, "echo ours-again > web.txt").await;
        keep(&work, "p9").await.expect("a second keep");
        let err = settle(&work, "sketch/req-44-abcdef", &ask).await.unwrap_err();
        assert!(err.contains("conflicts"), "{err}");
        assert_eq!(git(&origin, None, &["rev-parse", "dev"]).await.unwrap(), before, "a conflict pushed nothing");

        for never in ["main", "master", "-x", "a..b"] {
            let err = settle(&work, "sketch/req-44-abcdef", &SettleAsk { into: never.into(), message: "m".into() }).await.unwrap_err();
            assert!(err.contains("never merges into"), "{never}: {err}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_keep_of_a_sketch_with_no_change_is_refused_by_name() {
        let root = std::env::temp_dir().join(format!("forge-keep-none-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        sh(&root, "git init -q -b main origin && cd origin && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m base").await;
        sh(&root, "git clone -q origin work && cd work && git checkout -q -b sketch/req-1-abcdef origin/main").await;
        let err = keep(&root.join("work"), "p2").await.unwrap_err();
        assert!(err.contains("no change"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
