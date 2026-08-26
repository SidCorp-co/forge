//! Commit and push whatever a failed job left uncommitted, so the next attempt
//! starts from that work instead of from nothing.
//!
//! Runner-side by necessity: core has no working copy, and the agent that would
//! have committed is the thing that died. Every path here — including refusal —
//! produces a [`Salvage`] report rather than an error, because the report is
//! what core forwards to the retry's prompt; "there is no salvage" and "salvage
//! was refused because HEAD was detached" are different facts to the next agent.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

// cm:guard these two budgets bound how long `lifecycle::fail` is delayed, and that is the only thing they are for — a failure core never hears about is worse than a lost diff. 60s worst case is deliberate and safe: core's own quiet-reap tolerance is RESULT_QUIET_MINUTES = 60, so a minute is invisible to it, while the 20s a network push can exceed would throw away exactly the large diffs worth saving.
const LOCAL_BUDGET: Duration = Duration::from_secs(15);
const PUSH_BUDGET: Duration = Duration::from_secs(45);

/// What became of the failed attempt's uncommitted work.
// cm:edge contract -> packages/core/src/jobs/prior-attempts.ts — `salvageSchema` there is `.strict()` and its `outcome` enum is these five strings. A variant added here without adding it there is a 400 on `POST /api/jobs/:id/fail`, which loses the WHOLE failure report, not just the salvage half.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Pushed,
    CommittedNotPushed,
    None,
    Refused,
    Failed,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pushed => "pushed",
            Self::CommittedNotPushed => "committed_not_pushed",
            Self::None => "none",
            Self::Refused => "refused",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Salvage {
    pub outcome: Outcome,
    pub branch: Option<String>,
    pub sha: Option<String>,
    pub files: Option<u32>,
    pub insertions: Option<u32>,
    pub detail: Option<String>,
}

impl Salvage {
    fn bare(outcome: Outcome) -> Self {
        Self {
            outcome,
            branch: None,
            sha: None,
            files: None,
            insertions: None,
            detail: None,
        }
    }

    fn refused(detail: impl Into<String>) -> Self {
        Self {
            detail: Some(detail.into()),
            ..Self::bare(Outcome::Refused)
        }
    }

    fn failed(detail: impl Into<String>) -> Self {
        Self {
            detail: Some(detail.into()),
            ..Self::bare(Outcome::Failed)
        }
    }

    /// The `salvage` object on `POST /api/jobs/:id/fail`. Fields core's schema
    /// declares optional are omitted rather than sent null.
    pub fn to_json(&self) -> serde_json::Value {
        let mut v = serde_json::json!({ "outcome": self.outcome.as_str() });
        let obj = v.as_object_mut().expect("json! object");
        if let Some(b) = &self.branch {
            obj.insert("branch".into(), b.clone().into());
        }
        if let Some(s) = &self.sha {
            obj.insert("sha".into(), s.clone().into());
        }
        if let Some(f) = self.files {
            obj.insert("files".into(), f.into());
        }
        if let Some(i) = self.insertions {
            obj.insert("insertions".into(), i.into());
        }
        if let Some(d) = &self.detail {
            obj.insert("detail".into(), truncate(d, 2000).into());
        }
        v
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
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

fn stdout_trim(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn stderr_brief(out: &std::process::Output) -> String {
    let text = String::from_utf8_lossy(&out.stderr);
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if line.is_empty() {
        format!("git exited with {}", out.status)
    } else {
        line.to_string()
    }
}

/// `git diff --cached --numstat` → (files, insertions). Binary files report `-`
/// for both columns and so count toward `files` without adding insertions.
fn count_staged(numstat: &str) -> (u32, u32) {
    let mut files = 0;
    let mut insertions = 0;
    for line in numstat.lines().filter(|l| !l.trim().is_empty()) {
        files += 1;
        if let Some(first) = line.split('\t').next() {
            insertions += first.parse::<u32>().unwrap_or(0);
        }
    }
    (files, insertions)
}

/// Trailers rather than prose so `git log --grep='forge-salvage: true'` is exact,
/// and so a review step can refuse to treat a salvage commit as a deliverable.
fn commit_message(branch: &str, job_id: &str, attempt: u32, failure: &str) -> String {
    let subject = format!("wip(salvage): {branch} failed attempt — uncommitted work preserved");
    let mut body = format!("forge-salvage: true\nforge-job-id: {job_id}\n");
    if attempt > 0 {
        body.push_str(&format!("forge-attempt: {attempt}\n"));
    }
    let reason = failure.lines().next().unwrap_or("").trim();
    if !reason.is_empty() {
        body.push_str(&format!("forge-failure: {}\n", truncate(reason, 300)));
    }
    format!("{subject}\n\n{body}")
}

/// `-c user.*` args to inject when the box has no git identity, so a salvage is
/// not lost to `Please tell me who you are` on a freshly provisioned runner.
async fn identity_args(dir: &Path) -> Vec<String> {
    let configured = git(dir, &["config", "--get", "user.email"])
        .await
        .is_some_and(|o| o.status.success() && !stdout_trim(&o).is_empty());
    if configured {
        return Vec::new();
    }
    vec![
        "-c".into(),
        "user.name=forge-runner".into(),
        "-c".into(),
        "user.email=runner@forge.local".into(),
    ]
}

/// Preserve the working copy of a failed job. `worktree` must be the job's own
/// worktree and `branch` the branch core cut for it; both are refused rather
/// than guessed at when the checkout has moved (see the guards below).
pub async fn salvage_wip(
    worktree: &Path,
    branch: &str,
    job_id: &str,
    attempt: u32,
    failure: &str,
) -> Salvage {
    let local = tokio::time::timeout(
        LOCAL_BUDGET,
        stage_and_commit(worktree, branch, job_id, attempt, failure),
    );
    let committed = match local.await {
        Ok(Committed::Done(c)) => c,
        Ok(Committed::Stop(s)) => return s,
        Err(_) => return Salvage::failed("timed out staging the working copy"),
    };
    let refspec = format!("HEAD:refs/heads/{branch}");
    let argv = ["push", "origin", refspec.as_str()];
    let push = git(worktree, &argv);
    // cm:guard a push that fails, times out, or finds the remote branch moved is `committed_not_pushed`, never an error and never a `--force`: the network may be the very reason the job failed, and the commit is still on the box for an operator. L2 renders that outcome as "treat that work as lost and redo it", which is the honest instruction — the next attempt runs on a different checkout and cannot reach it.
    match tokio::time::timeout(PUSH_BUDGET, push).await {
        Ok(Some(out)) if out.status.success() => Salvage {
            outcome: Outcome::Pushed,
            ..committed
        },
        Ok(Some(out)) => Salvage {
            outcome: Outcome::CommittedNotPushed,
            detail: Some(stderr_brief(&out)),
            ..committed
        },
        Ok(None) => Salvage {
            outcome: Outcome::CommittedNotPushed,
            detail: Some("git push could not be spawned".into()),
            ..committed
        },
        Err(_) => Salvage {
            outcome: Outcome::CommittedNotPushed,
            detail: Some(format!("push timed out after {}s", PUSH_BUDGET.as_secs())),
            ..committed
        },
    }
}

enum Committed {
    /// A commit exists; the caller decides `pushed` vs `committed_not_pushed`.
    Done(Salvage),
    /// Nothing to push, ever — report this verbatim.
    Stop(Salvage),
}

async fn stage_and_commit(
    worktree: &Path,
    branch: &str,
    job_id: &str,
    attempt: u32,
    failure: &str,
) -> Committed {
    if !worktree.is_dir() {
        return Committed::Stop(Salvage::refused(format!(
            "worktree {} does not exist",
            worktree.display()
        )));
    }
    // cm:guard the checkout must still be on the branch core cut for this job. A reprovision, a stale reused worktree or an agent that switched branches mid-run all leave it somewhere else, and committing there puts unreviewed WIP on whatever ref that is — `main` in the worst case. Detached HEAD reports as the literal string `HEAD`, which no branch name can collide with.
    let head = match git(worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
        Some(out) if out.status.success() => stdout_trim(&out),
        Some(out) => return Committed::Stop(Salvage::failed(stderr_brief(&out))),
        None => return Committed::Stop(Salvage::failed("git could not be spawned")),
    };
    if head != branch {
        return Committed::Stop(Salvage::refused(format!(
            "worktree is on `{head}`, not the job's branch `{branch}`"
        )));
    }

    match git(worktree, &["status", "--porcelain"]).await {
        Some(out) if out.status.success() && out.stdout.is_empty() => {
            return Committed::Stop(Salvage::bare(Outcome::None));
        }
        Some(out) if !out.status.success() => {
            return Committed::Stop(Salvage::failed(stderr_brief(&out)));
        }
        None => return Committed::Stop(Salvage::failed("git status could not be spawned")),
        Some(_) => {}
    }

    // cm:guard `add -A`, NEVER `-f`: `.gitignore` is the only thing between a salvage and a committed `.env`, and a failed job's worktree is full of exactly the untracked scratch a run leaves behind. An ignored file the next attempt needs is a gitignore bug to fix in the repo, not something to override from here.
    if let Some(out) = git(worktree, &["add", "-A"]).await {
        if !out.status.success() {
            return Committed::Stop(Salvage::failed(stderr_brief(&out)));
        }
    } else {
        return Committed::Stop(Salvage::failed("git add could not be spawned"));
    }

    let (files, insertions) = match git(worktree, &["diff", "--cached", "--numstat"]).await {
        Some(out) if out.status.success() => count_staged(&String::from_utf8_lossy(&out.stdout)),
        _ => (0, 0),
    };
    if files == 0 {
        // Everything dirty was ignored — nothing to preserve, and an empty
        // commit per failed attempt is noise on every branch.
        return Committed::Stop(Salvage::bare(Outcome::None));
    }

    let message = commit_message(branch, job_id, attempt, failure);
    let mut argv: Vec<String> = identity_args(worktree).await;
    // cm:guard `--no-verify` is load-bearing, not a shortcut: a pre-commit hook that fails is a likely REASON the job failed, and `core.hooksPath` pointing at a missing dir already refuses every commit on some boxes (see daemon/preflight.rs). A salvage blocked by the repo's own hooks preserves nothing.
    argv.extend(["commit", "--no-verify", "-m", &message].map(str::to_string));
    let argv_ref: Vec<&str> = argv.iter().map(String::as_str).collect();
    if let Some(out) = git(worktree, &argv_ref).await {
        if !out.status.success() {
            return Committed::Stop(Salvage::failed(stderr_brief(&out)));
        }
    } else {
        return Committed::Stop(Salvage::failed("git commit could not be spawned"));
    }

    let sha = git(worktree, &["rev-parse", "--short", "HEAD"])
        .await
        .filter(|o| o.status.success())
        .map(|o| stdout_trim(&o));

    Committed::Done(Salvage {
        outcome: Outcome::CommittedNotPushed,
        branch: Some(branch.to_string()),
        sha,
        files: Some(files),
        insertions: Some(insertions),
        detail: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    async fn run(dir: &Path, args: &[&str]) {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .await
            .unwrap();
    }

    /// A repo with a bare remote and an `ISS-*` worktree checked out on its own
    /// branch — the shape a code job runs in.
    async fn repo(tag: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "forge-salvage-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        run(&root, &["init", "-b", "main"]).await;
        run(&root, &["config", "user.email", "t@t"]).await;
        run(&root, &["config", "user.name", "t"]).await;
        std::fs::write(root.join("f.txt"), "one\n").unwrap();
        run(&root, &["add", "."]).await;
        run(&root, &["commit", "-m", "init"]).await;
        let remote = root.with_extension("remote.git");
        let _ = std::fs::remove_dir_all(&remote);
        std::fs::create_dir_all(&remote).unwrap();
        run(&remote, &["init", "--bare", "-b", "main"]).await;
        run(
            &root,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        )
        .await;
        run(&root, &["push", "-u", "origin", "main"]).await;
        let wt = root.join(".worktrees").join(tag);
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        run(
            &root,
            &["worktree", "add", &wt.to_string_lossy(), "-b", tag],
        )
        .await;
        (root, wt)
    }

    fn cleanup(root: &Path) {
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(root.with_extension("remote.git"));
    }

    #[tokio::test]
    async fn commits_and_pushes_the_uncommitted_work() {
        let (root, wt) = repo("ISS-1-push").await;
        std::fs::write(wt.join("new.txt"), "salvaged\n").unwrap();
        std::fs::write(wt.join("f.txt"), "one\ntwo\n").unwrap();
        let s = salvage_wip(&wt, "ISS-1-push", "job-1", 2, "spend limit").await;
        assert_eq!(s.outcome, Outcome::Pushed);
        assert_eq!(s.files, Some(2));
        assert_eq!(s.insertions, Some(2));
        assert!(s.sha.is_some());
        let remote = root.with_extension("remote.git");
        let out = Command::new("git")
            .args(["log", "-1", "--format=%B", "ISS-1-push"])
            .current_dir(&remote)
            .output()
            .await
            .unwrap();
        let body = String::from_utf8_lossy(&out.stdout);
        assert!(body.contains("forge-salvage: true"), "{body}");
        assert!(body.contains("forge-job-id: job-1"), "{body}");
        assert!(body.contains("forge-attempt: 2"), "{body}");
        assert!(body.contains("forge-failure: spend limit"), "{body}");
        cleanup(&root);
    }

    #[tokio::test]
    async fn reports_none_on_a_clean_worktree_rather_than_an_empty_commit() {
        let (root, wt) = repo("ISS-2-clean").await;
        let s = salvage_wip(&wt, "ISS-2-clean", "job-2", 1, "x").await;
        assert_eq!(s.outcome, Outcome::None);
        assert!(s.sha.is_none());
        cleanup(&root);
    }

    #[tokio::test]
    async fn refuses_when_the_checkout_is_not_on_the_job_branch() {
        let (root, wt) = repo("ISS-3-moved").await;
        std::fs::write(wt.join("new.txt"), "x\n").unwrap();
        run(&wt, &["checkout", "-b", "somewhere-else"]).await;
        let s = salvage_wip(&wt, "ISS-3-moved", "job-3", 1, "x").await;
        assert_eq!(s.outcome, Outcome::Refused);
        assert!(s.detail.unwrap().contains("somewhere-else"));
        cleanup(&root);
    }

    #[tokio::test]
    async fn refuses_a_detached_head() {
        let (root, wt) = repo("ISS-4-detached").await;
        std::fs::write(wt.join("new.txt"), "x\n").unwrap();
        run(&wt, &["checkout", "--detach"]).await;
        let s = salvage_wip(&wt, "ISS-4-detached", "job-4", 1, "x").await;
        assert_eq!(s.outcome, Outcome::Refused);
        assert!(s.detail.unwrap().contains("`HEAD`"));
        cleanup(&root);
    }

    #[tokio::test]
    async fn never_commits_an_ignored_file() {
        let (root, wt) = repo("ISS-5-ignored").await;
        std::fs::write(wt.join(".gitignore"), ".env\n").unwrap();
        std::fs::write(wt.join(".env"), "SECRET=1\n").unwrap();
        let s = salvage_wip(&wt, "ISS-5-ignored", "job-5", 1, "x").await;
        assert_eq!(s.outcome, Outcome::Pushed);
        let out = Command::new("git")
            .args(["show", "--name-only", "--format=", "HEAD"])
            .current_dir(&wt)
            .output()
            .await
            .unwrap();
        let names = String::from_utf8_lossy(&out.stdout);
        assert!(names.contains(".gitignore"), "{names}");
        assert!(!names.contains(".env"), "{names}");
        cleanup(&root);
    }

    #[tokio::test]
    async fn reports_committed_not_pushed_when_the_remote_is_unreachable() {
        let (root, wt) = repo("ISS-6-nopush").await;
        std::fs::write(wt.join("new.txt"), "x\n").unwrap();
        let _ = std::fs::remove_dir_all(root.with_extension("remote.git"));
        let s = salvage_wip(&wt, "ISS-6-nopush", "job-6", 1, "x").await;
        assert_eq!(s.outcome, Outcome::CommittedNotPushed);
        assert!(s.sha.is_some());
        assert!(s.detail.is_some());
        cleanup(&root);
    }

    #[tokio::test]
    async fn refuses_a_worktree_that_is_not_there() {
        let s = salvage_wip(Path::new("/nonexistent/forge/wt"), "ISS-7", "job-7", 1, "x").await;
        assert_eq!(s.outcome, Outcome::Refused);
    }

    #[tokio::test]
    async fn commits_even_when_a_pre_commit_hook_refuses() {
        let (root, wt) = repo("ISS-8-hook").await;
        let hooks = root.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::write(wt.join("new.txt"), "x\n").unwrap();
        let s = salvage_wip(&wt, "ISS-8-hook", "job-8", 1, "x").await;
        assert_eq!(s.outcome, Outcome::Pushed);
        cleanup(&root);
    }

    #[test]
    fn counts_a_binary_file_without_adding_insertions() {
        assert_eq!(count_staged("3\t0\ta.txt\n-\t-\tb.png\n"), (2, 3));
    }

    #[test]
    fn omits_optional_fields_rather_than_sending_null() {
        let v = Salvage::bare(Outcome::None).to_json();
        assert_eq!(v, serde_json::json!({ "outcome": "none" }));
    }
}
