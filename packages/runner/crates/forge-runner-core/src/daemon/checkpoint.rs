//! What a dead run left, reconstructed from the box.
//!
//! This is ONE of the two blocks a resumed master is handed, and it is the box
//! half: branch, head, base, the files the run touched, and why the run ended.
//! Every field here is read off the disk or out of the ledger — nothing in it
//! is anything the run said.
//!
//! The other block is testimony — the `next` the run wrote onto its own lease,
//! read back from the tracker byte for byte — and it is assembled in core
//! (`devices/run-evidence.ts`), because the box has no route that reads an
//! issue. The two are never merged and neither is summarised into the other.
//!
//! There is deliberately no verdict field, no recommendation, and no "looks
//! resumable" flag. Whether work continues or restarts is the master's call
//! (ISS-1050): a surface that hands down a pre-computed answer has moved that
//! judgement into the kernel through a second door, and a master reading a
//! recommendation stops reading the evidence.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::runner::ledger::Run;

pub const RECONSTRUCT_BUDGET: Duration = Duration::from_secs(20);

/// The branch a run's worktree is on and what is on it, as the box sees it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reconstructed {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub base: Option<String>,
    /// Paths changed between `base` and the working tree, committed or not.
    pub files_touched: Vec<String>,
    /// Commits on `branch` that `base` does not have.
    pub commits_ahead: Option<u32>,
    /// Commits on `branch` that no remote has.
    pub commits_unpushed: Option<u32>,
    pub working_tree_dirty: Option<bool>,
    pub ended_by: Option<String>,
    pub ended_reason: Option<String>,
    pub unread: Vec<String>,
}

impl Reconstructed {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "source": "reconstructed_from_box",
            "branch": self.branch,
            "head": self.head,
            "base": self.base,
            "filesTouched": self.files_touched,
            "commitsAhead": self.commits_ahead,
            "commitsUnpushed": self.commits_unpushed,
            "workingTreeDirty": self.working_tree_dirty,
            "endedBy": self.ended_by,
            "endedReason": self.ended_reason,
            "unread": self.unread,
        })
    }
}

async fn git(dir: &Path, args: &[&str]) -> Option<std::process::Output> {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()
}

/// stdout when the command succeeded, `None` when it did not run or failed.
async fn git_line(dir: &Path, args: &[&str]) -> Option<String> {
    let out = git(dir, args).await?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

async fn git_lines(dir: &Path, args: &[&str]) -> Option<Vec<String>> {
    let out = git(dir, args).await?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
    )
}

async fn base_of(dir: &Path, branch: &str) -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(u) = git_line(
        dir,
        &["rev-parse", "--abbrev-ref", &format!("{branch}@{{u}}")],
    )
    .await
    {
        candidates.push(u);
    }
    candidates.push("origin/HEAD".into());
    candidates.push("origin/main".into());
    candidates.push("origin/master".into());
    for c in candidates {
        if let Some(base) = git_line(dir, &["merge-base", "HEAD", &c]).await {
            return Some(base);
        }
    }
    None
}

async fn count(dir: &Path, rev_args: &[&str]) -> Option<u32> {
    let mut args: Vec<&str> = vec!["rev-list", "--count"];
    args.extend_from_slice(rev_args);
    git_line(dir, &args).await.and_then(|s| s.parse().ok())
}

/// Read everything the box can say about what this run left.
///
/// Never fails: an unreadable field comes back `None` and named in `unread`.
pub async fn reconstruct(run: &Run) -> Reconstructed {
    let dir = run.worktree_path.as_path();
    let mut out = Reconstructed {
        ended_by: run.ended_by.clone(),
        ended_reason: run.ended_reason.clone(),
        ..Default::default()
    };

    if !dir.is_absolute() {
        out.unread.push(format!(
            "the worktree path `{}` is not absolute, so nothing was read: a relative path resolves against the daemon's own directory and would describe some other checkout",
            dir.display()
        ));
        return out;
    }
    if !dir.exists() {
        out.unread.push(format!(
            "the worktree {} is no longer on this box",
            dir.display()
        ));
        return out;
    }

    out.branch = git_line(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
    if out.branch.is_none() {
        out.unread.push(format!(
            "`git rev-parse --abbrev-ref HEAD` did not answer in {} — nothing below could be read either",
            dir.display()
        ));
        return out;
    }
    out.head = git_line(dir, &["rev-parse", "HEAD"]).await;
    if out.head.is_none() {
        out.unread
            .push("`git rev-parse HEAD` did not answer: the branch has no commit yet".into());
    }

    let branch = out.branch.clone().unwrap_or_default();
    out.base = base_of(dir, &branch).await;
    match &out.base {
        Some(base) => {
            out.commits_ahead = count(dir, &[&format!("{base}..HEAD")]).await;
            match git_lines(dir, &["diff", "--name-only", base]).await {
                Some(files) => out.files_touched = files,
                None => out
                    .unread
                    .push(format!("`git diff --name-only {base}` did not answer")),
            }
            match git_lines(dir, &["ls-files", "--others", "--exclude-standard"]).await {
                Some(untracked) => {
                    for f in untracked {
                        if !out.files_touched.contains(&f) {
                            out.files_touched.push(f);
                        }
                    }
                }
                None => out.unread.push(
                    "`git ls-files --others --exclude-standard` did not answer: a file the run created but never added would be missing from what it touched".into(),
                ),
            }
            out.files_touched.sort();
        }
        None => out.unread.push(
            "no base could be found: neither the branch's upstream nor `origin/HEAD` gave a merge base, so the files touched are unknown rather than none".into(),
        ),
    }

    out.commits_unpushed = count(dir, &["HEAD", "--not", "--remotes"]).await;

    out.working_tree_dirty = match git_lines(dir, &["status", "--porcelain"]).await {
        Some(lines) => Some(!lines.is_empty()),
        None => {
            out.unread
                .push("`git status --porcelain` did not answer".into());
            None
        }
    };

    out
}

/// The same, given up after {@link RECONSTRUCT_BUDGET}.
pub async fn reconstruct_within_budget(run: &Run) -> Reconstructed {
    match tokio::time::timeout(RECONSTRUCT_BUDGET, reconstruct(run)).await {
        Ok(r) => r,
        Err(_) => Reconstructed {
            ended_by: run.ended_by.clone(),
            ended_reason: run.ended_reason.clone(),
            unread: vec![format!(
                "reading the worktree {} took longer than {}s and was given up on",
                run.worktree_path.display(),
                RECONSTRUCT_BUDGET.as_secs()
            )],
            ..Default::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ledger::{Incarnation, Run, Work};
    use std::path::PathBuf;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "forge-checkpoint-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ))
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    fn sh(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).expect("write");
    }

    /// A repo with a remote, a base commit pushed to it, and a branch cut from it.
    fn a_repo_with_a_remote(name: &str) -> (PathBuf, PathBuf) {
        let root = temp_path(name);
        cleanup(&root);
        let remote = root.join("remote.git");
        let work = root.join("work");
        std::fs::create_dir_all(&remote).expect("mkdir remote");
        std::fs::create_dir_all(&work).expect("mkdir work");
        sh(&remote, &["init", "-q", "--bare", "-b", "main"]);
        sh(&work, &["init", "-q", "-b", "main"]);
        sh(&work, &["config", "user.email", "t@example.com"]);
        sh(&work, &["config", "user.name", "t"]);
        write(&work, "base.txt", "base\n");
        sh(&work, &["add", "-A"]);
        sh(&work, &["commit", "-qm", "base"]);
        sh(
            &work,
            &["remote", "add", "origin", remote.to_str().expect("utf8")],
        );
        sh(&work, &["push", "-q", "-u", "origin", "main"]);
        (root, work)
    }

    fn a_run_at(worktree: &Path) -> Run {
        Run {
            run_id: "run-a".into(),
            project_id: Some("proj".into()),
            master_session_id: "master".into(),
            session_id: None,
            worktree_path: worktree.to_path_buf(),
            pid: None,
            boot_id: "boot".into(),
            incarnation: Incarnation::Exited,
            work: Work::Done,
            blocker_kind: None,
            waiting_on: None,
            resume_id: None,
            session_terminal_at: None,
            worktree_gone_at: None,
            claim_owner: None,
            claim_generation: 0,
            claim_expires_at: None,
            revival_token: None,
            revival_deadline_at: None,
            ended_by: Some("subagent".into()),
            ended_reason: Some("stopped".into()),
            agent_id: Some("child-1".into()),
            resume_choice: None,
            resume_choice_why: None,
            resume_owed_at: None,
        }
    }

    #[tokio::test]
    async fn reports_the_branch_its_head_its_base_and_what_it_changed() {
        let (root, work) = a_repo_with_a_remote("full");
        sh(&work, &["checkout", "-qb", "feature"]);
        write(&work, "one.txt", "one\n");
        sh(&work, &["add", "-A"]);
        sh(&work, &["commit", "-qm", "one"]);
        write(&work, "dirty.txt", "not committed\n");

        let got = reconstruct(&a_run_at(&work)).await;
        cleanup(&root);

        assert_eq!(got.branch.as_deref(), Some("feature"));
        assert!(got.head.is_some(), "a branch with a commit has a head");
        assert!(got.base.is_some(), "origin/HEAD gives a merge base");
        assert_eq!(got.commits_ahead, Some(1));
        assert_eq!(
            got.working_tree_dirty,
            Some(true),
            "an uncommitted file is what a salvage exists to save, so it must be visible here"
        );
        assert!(
            got.files_touched.contains(&"one.txt".to_string()),
            "committed since the base: {:?}",
            got.files_touched
        );
        assert!(
            got.files_touched.contains(&"dirty.txt".to_string()),
            "uncommitted is still touched — a diff against the base and not against HEAD is what makes that true: {:?}",
            got.files_touched
        );
        assert_eq!(got.ended_by.as_deref(), Some("subagent"));
        assert!(
            got.unread.is_empty(),
            "nothing was unreadable: {:?}",
            got.unread
        );
    }

    #[tokio::test]
    async fn counts_as_unpushed_only_what_no_remote_has() {
        let (root, work) = a_repo_with_a_remote("unpushed");
        sh(&work, &["checkout", "-qb", "feature"]);
        write(&work, "one.txt", "one\n");
        sh(&work, &["add", "-A"]);
        sh(&work, &["commit", "-qm", "one"]);

        let before = reconstruct(&a_run_at(&work)).await;
        assert_eq!(before.commits_unpushed, Some(1), "nothing has it yet");

        sh(&work, &["push", "-q", "origin", "feature"]);
        let after = reconstruct(&a_run_at(&work)).await;
        cleanup(&root);

        assert_eq!(
            after.commits_unpushed,
            Some(0),
            "a commit a remote ref has is not at risk and must not be reported as such"
        );
    }

    #[tokio::test]
    async fn names_what_it_could_not_read_instead_of_reporting_nothing_touched() {
        let dir = temp_path("gone");
        cleanup(&dir);

        let got = reconstruct(&a_run_at(&dir)).await;

        assert!(got.files_touched.is_empty());
        assert!(
            got.unread
                .iter()
                .any(|u| u.contains("no longer on this box")),
            "an absent worktree must say so rather than read as a run that touched nothing: {:?}",
            got.unread
        );
        assert!(
            got.branch.is_none(),
            "nothing was read, so nothing is claimed"
        );
    }

    #[tokio::test]
    async fn a_repo_with_no_remote_says_the_base_is_unknown_rather_than_guessing() {
        let dir = temp_path("noremote");
        cleanup(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        sh(&dir, &["init", "-q", "-b", "main"]);
        sh(&dir, &["config", "user.email", "t@example.com"]);
        sh(&dir, &["config", "user.name", "t"]);
        write(&dir, "a.txt", "a\n");
        sh(&dir, &["add", "-A"]);
        sh(&dir, &["commit", "-qm", "a"]);

        let got = reconstruct(&a_run_at(&dir)).await;
        cleanup(&dir);

        assert!(got.base.is_none());
        assert!(
            got.files_touched.is_empty(),
            "with no base there is nothing to diff against"
        );
        assert!(
            got.unread.iter().any(|u| u.contains("unknown rather than none")),
            "the difference between `touched nothing` and `could not tell` is the whole point: {:?}",
            got.unread
        );
    }

    #[test]
    fn the_payload_labels_itself_as_reconstruction() {
        let got = Reconstructed {
            branch: Some("feature".into()),
            ..Default::default()
        };
        let json = got.to_json();
        assert_eq!(json["source"], "reconstructed_from_box");
        assert!(
            json.get("next").is_none() && json.get("recommendation").is_none(),
            "this block carries nothing the run said and nothing resembling a verdict: {json}"
        );
    }
}
