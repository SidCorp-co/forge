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
