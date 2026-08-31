//! Commit and push whatever a failed job left uncommitted, so the next attempt
//! starts from that work instead of from nothing.
//!
//! Runner-side by necessity: core has no working copy, and the agent that would
//! have committed is the thing that died. Every path here — including refusal —
//! produces a [`Salvage`] report rather than an error, because the report is
//! what core forwards to the retry's prompt; "there is no salvage" and "salvage
//! was refused because the checkout was ambiguous" are different facts to the
//! next agent.
//!
//! The dirty checkout is FOUND, never assumed. Measured on dev1 2026-08-26:
//! `<repo>/.worktrees/` — the directory `worktree::create` owns — did not exist
//! at all, while six agent worktrees sat under `.claude/worktrees/`, one of them
//! the very job this work came from — core sent no `worktreeBranch` then, so
//! every job ran in the repo root and the agent cut its own checkout wherever it
//! liked. A salvage that derived a path from a branch name would have been a
//! silent no-op on the whole fleet. Core drives `.worktrees/` now, but the
//! finding stays: both conventions can be live on one box at once, and only
//! `git worktree list` sees both.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

// cm:guard these two budgets bound how long `lifecycle::fail` is delayed, and that is the only thing they are for — a failure core never hears about is worse than a lost diff. 60s worst case is deliberate and safe: core's own quiet-reap tolerance is RESULT_QUIET_MINUTES = 60, so a minute is invisible to it, while the 20s a network push can exceed would throw away exactly the large diffs worth saving.
const PICK_BUDGET: Duration = Duration::from_secs(10);
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

/// One candidate checkout: a worktree of this repo sitting on its own branch.
#[derive(Debug, Clone)]
struct Target {
    path: PathBuf,
    branch: String,
}

/// Parse `git worktree list --porcelain` into (path, branch) pairs, dropping
/// detached entries — a detached checkout is nobody's branch, and the agent's
/// `_merge` worktree is exactly that.
fn parse_worktrees(porcelain: &str) -> Vec<Target> {
    let mut out = Vec::new();
    let mut path: Option<PathBuf> = None;
    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(PathBuf::from(p.trim()));
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            if let Some(p) = path.take() {
                out.push(Target {
                    path: p,
                    branch: b.trim().to_string(),
                });
            }
        } else if line.trim() == "detached" {
            path = None;
        }
    }
    out
}

/// True when `branch` is the checkout the issue's agent would have cut —
/// `ISS-862-runner-health` for `ISS-862`, and not `ISS-8620-…`.
fn belongs_to_issue(branch: &str, issue_key: &str) -> bool {
    let b = branch.to_ascii_lowercase();
    let k = issue_key.to_ascii_lowercase();
    let last = b.rsplit('/').next().unwrap_or(b.as_str());
    match last.strip_prefix(k.as_str()) {
        Some(rest) => rest.is_empty() || rest.starts_with('-'),
        None => false,
    }
}

fn modified_at(p: &Path) -> std::time::SystemTime {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
}

async fn is_dirty(wt: &Path) -> bool {
    git(wt, &["status", "--porcelain"])
        .await
        .is_some_and(|o| o.status.success() && !o.stdout.is_empty())
}

/// What the runner needs to preserve one failed job's work.
pub struct SalvageInput<'a> {
    /// The job's repo root — the checkout core handed it, NOT the agent's.
    pub repo_root: &'a Path,
    /// The project's base branch per the server, when it has one.
    pub base_branch: Option<&'a str>,
    /// `ISS-<seq>` for the issue this job serves, when it serves one.
    pub issue_key: Option<&'a str>,
    pub job_id: &'a str,
    pub attempt: u32,
    pub failure: &'a str,
}

/// Choose the checkout to salvage, or explain why there is none.
async fn pick_target(input: &SalvageInput<'_>) -> std::result::Result<Target, Salvage> {
    let listing = match git(input.repo_root, &["worktree", "list", "--porcelain"]).await {
        Some(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
        Some(out) => return Err(Salvage::failed(stderr_brief(&out))),
        None => return Err(Salvage::failed("git worktree list could not be spawned")),
    };
    let root = input.repo_root.canonicalize();
    // cm:guard the repo ROOT is excluded unconditionally, and that is the whole safety of this: the root sits on the project's BASE branch, so committing its leftovers would put unreviewed WIP straight onto `main`. Excluding the base branch by name as well covers a second worktree someone attached to it. This held when core sent no `worktreeBranch` and the root was the only checkout a job ever had; it holds for the same reason now that core sends one, because the worktree lane moves the job OFF the root rather than putting an ISS-* branch on it.
    let candidates: Vec<Target> = parse_worktrees(&listing)
        .into_iter()
        .filter(|t| {
            let is_root = match (&root, t.path.canonicalize()) {
                (Ok(r), Ok(p)) => &p == r,
                _ => t.path == input.repo_root,
            };
            !is_root && Some(t.branch.as_str()) != input.base_branch
        })
        .collect();
    let mut dirty: Vec<Target> = Vec::new();
    for t in candidates {
        if is_dirty(&t.path).await {
            dirty.push(t);
        }
    }
    // cm:guard scope to the job's OWN issue whenever core told us which one. dev1 carried five agent worktrees on 2026-08-26, two of them dirty since 2026-08-12 — the reaper spares a dirty worktree by design, so "the one dirty checkout" is not a thing that exists on a real box. Salvaging a stranger's branch would push a commit onto work nobody asked us to touch.
    if let Some(key) = input.issue_key {
        let seen: Vec<String> = dirty.iter().map(|t| t.branch.clone()).collect();
        dirty.retain(|t| belongs_to_issue(&t.branch, key));
        // cm:guard filtering everything away must NOT report `none`. `none` means the checkout was clean, and the five outcomes exist so that "why is there no salvage?" stays answerable — an agent that named its branch something this key does not match would otherwise look identical to one that committed everything.
        if dirty.is_empty() && !seen.is_empty() {
            return Err(Salvage::refused(format!(
                "no dirty worktree matches {key}; saw {}",
                seen.join(", ")
            )));
        }
    }
    match dirty.len() {
        0 => Err(Salvage::bare(Outcome::None)),
        1 => Ok(dirty.remove(0)),
        _ if input.issue_key.is_none() => Err(Salvage::refused(format!(
            "{} dirty worktrees and no issue key to choose between them",
            dirty.len()
        ))),
        _ => {
            dirty.sort_by_key(|t| std::cmp::Reverse(modified_at(&t.path)));
            Ok(dirty.remove(0))
        }
    }
}

/// Preserve the working copy of a failed job, best-effort. Finds the agent's own
/// checkout for this issue, commits what is uncommitted there, and pushes it.
pub async fn salvage_wip(input: SalvageInput<'_>) -> Salvage {
    let target = match tokio::time::timeout(PICK_BUDGET, pick_target(&input)).await {
        Ok(Ok(t)) => t,
        Ok(Err(s)) => return s,
        Err(_) => return Salvage::failed("timed out looking for the job's checkout"),
    };
    let local = tokio::time::timeout(
        LOCAL_BUDGET,
        stage_and_commit(&target, input.job_id, input.attempt, input.failure),
    );
    let committed = match local.await {
        Ok(Committed::Done(c)) => c,
        Ok(Committed::Stop(s)) => return s,
        Err(_) => return Salvage::failed("timed out staging the working copy"),
    };
    let refspec = format!("HEAD:refs/heads/{}", target.branch);
    let argv = ["push", "origin", refspec.as_str()];
    let push = git(&target.path, &argv);
    // cm:guard a push that fails, times out, or finds the remote branch moved is `committed_not_pushed`, never an error and never a `--force`: the network may be the very reason the job failed, and the commit is still on the box for an operator. L2 renders that outcome as "treat that work as lost and redo it", which is the honest instruction — the next attempt may run on another box and cannot reach it.
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

async fn stage_and_commit(target: &Target, job_id: &str, attempt: u32, failure: &str) -> Committed {
    let wt = target.path.as_path();
    let branch = target.branch.as_str();
    // cm:guard re-read HEAD rather than trusting the listing: `pick_target` and this run seconds apart, and a checkout that moved between them would take the commit with it. Detached HEAD reports as the literal string `HEAD`, which no branch name can collide with.
    let head = match git(wt, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
        Some(out) if out.status.success() => stdout_trim(&out),
        Some(out) => return Committed::Stop(Salvage::failed(stderr_brief(&out))),
        None => return Committed::Stop(Salvage::failed("git could not be spawned")),
    };
    if head != branch {
        return Committed::Stop(Salvage::refused(format!(
            "worktree moved to `{head}` while it was being salvaged, expected `{branch}`"
        )));
    }

    // cm:guard `add -A`, NEVER `-f`: `.gitignore` is the only thing between a salvage and a committed `.env`, and a failed job's worktree is full of exactly the untracked scratch a run leaves behind. An ignored file the next attempt needs is a gitignore bug to fix in the repo, not something to override from here.
    if let Some(out) = git(wt, &["add", "-A"]).await {
        if !out.status.success() {
            return Committed::Stop(Salvage::failed(stderr_brief(&out)));
        }
    } else {
        return Committed::Stop(Salvage::failed("git add could not be spawned"));
    }

    let (files, insertions) = match git(wt, &["diff", "--cached", "--numstat"]).await {
        Some(out) if out.status.success() => count_staged(&String::from_utf8_lossy(&out.stdout)),
        _ => (0, 0),
    };
    if files == 0 {
        // Everything dirty was ignored — nothing to preserve, and an empty
        // commit per failed attempt is noise on every branch.
        return Committed::Stop(Salvage::bare(Outcome::None));
    }

    let message = commit_message(branch, job_id, attempt, failure);
    let mut argv: Vec<String> = identity_args(wt).await;
    // cm:guard `--no-verify` is load-bearing, not a shortcut: a pre-commit hook that fails is a likely REASON the job failed, and `core.hooksPath` pointing at a missing dir already refuses every commit on some boxes (see daemon/preflight.rs). A salvage blocked by the repo's own hooks preserves nothing.
    argv.extend(["commit", "--no-verify", "-m", &message].map(str::to_string));
    let argv_ref: Vec<&str> = argv.iter().map(String::as_str).collect();
    if let Some(out) = git(wt, &argv_ref).await {
        if !out.status.success() {
            return Committed::Stop(Salvage::failed(stderr_brief(&out)));
        }
    } else {
        return Committed::Stop(Salvage::failed("git commit could not be spawned"));
    }

    let sha = git(wt, &["rev-parse", "--short", "HEAD"])
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

    async fn run(dir: &Path, args: &[&str]) {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .await
            .unwrap();
    }

    /// A repo root on `main` with a bare remote, plus one agent worktree under
    /// `.claude/worktrees/` on its own branch — the shape a code job leaves.
    async fn repo(tag: &str, branch: &str) -> (PathBuf, PathBuf) {
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
        let wt = add_worktree(&root, branch).await;
        (root, wt)
    }

    async fn add_worktree(root: &Path, branch: &str) -> PathBuf {
        let wt = root
            .join(".claude/worktrees")
            .join(branch.to_ascii_lowercase());
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        run(
            root,
            &["worktree", "add", &wt.to_string_lossy(), "-b", branch],
        )
        .await;
        wt
    }

    fn cleanup(root: &Path) {
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(root.with_extension("remote.git"));
    }

    fn input<'a>(root: &'a Path, key: Option<&'a str>) -> SalvageInput<'a> {
        SalvageInput {
            repo_root: root,
            base_branch: Some("main"),
            issue_key: key,
            job_id: "job-1",
            attempt: 2,
            failure: "spend limit",
        }
    }

    #[tokio::test]
    async fn finds_the_agents_own_checkout_and_pushes_it() {
        let (root, wt) = repo("push", "ISS-1-alpha").await;
        std::fs::write(wt.join("new.txt"), "salvaged\n").unwrap();
        std::fs::write(wt.join("f.txt"), "one\ntwo\n").unwrap();
        let s = salvage_wip(input(&root, Some("ISS-1"))).await;
        assert_eq!(s.outcome, Outcome::Pushed, "{s:?}");
        assert_eq!(s.branch.as_deref(), Some("ISS-1-alpha"));
        assert_eq!(s.files, Some(2));
        assert_eq!(s.insertions, Some(2));
        let remote = root.with_extension("remote.git");
        let out = Command::new("git")
            .args(["log", "-1", "--format=%B", "ISS-1-alpha"])
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

    // cm:guard the repo root sits on the BASE branch, so a salvage that reached it would commit unreviewed WIP onto `main`. This test is the only thing standing between that guard and a refactor.
    #[tokio::test]
    async fn never_touches_a_dirty_repo_root() {
        let (root, _wt) = repo("root", "ISS-2-beta").await;
        std::fs::write(root.join("dirty.txt"), "x\n").unwrap();
        let s = salvage_wip(input(&root, Some("ISS-2"))).await;
        assert_eq!(s.outcome, Outcome::None, "{s:?}");
        let out = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert!(!out.stdout.is_empty(), "root must still be dirty");
        cleanup(&root);
    }

    #[tokio::test]
    async fn says_it_found_nothing_matching_rather_than_calling_the_tree_clean() {
        let (root, _mine) = repo("nomatch", "ISS-10-mine").await;
        let theirs = add_worktree(&root, "ISS-99-theirs").await;
        std::fs::write(theirs.join("stale.txt"), "old\n").unwrap();
        let s = salvage_wip(input(&root, Some("ISS-10"))).await;
        assert_eq!(s.outcome, Outcome::Refused, "{s:?}");
        let d = s.detail.unwrap();
        assert!(d.contains("ISS-10"), "{d}");
        assert!(d.contains("ISS-99-theirs"), "{d}");
        cleanup(&root);
    }

    #[tokio::test]
    async fn ignores_another_issues_dirty_worktree() {
        let (root, mine) = repo("scope", "ISS-3-mine").await;
        let theirs = add_worktree(&root, "ISS-99-theirs").await;
        std::fs::write(theirs.join("stale.txt"), "old\n").unwrap();
        std::fs::write(mine.join("new.txt"), "x\n").unwrap();
        let s = salvage_wip(input(&root, Some("ISS-3"))).await;
        assert_eq!(s.branch.as_deref(), Some("ISS-3-mine"), "{s:?}");
        let out = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&theirs)
            .output()
            .await
            .unwrap();
        assert!(
            !out.stdout.is_empty(),
            "the other issue's work must be left alone"
        );
        cleanup(&root);
    }

    #[tokio::test]
    async fn refuses_when_several_are_dirty_and_no_issue_key_narrows_them() {
        let (root, a) = repo("ambig", "ISS-4-a").await;
        let b = add_worktree(&root, "ISS-5-b").await;
        std::fs::write(a.join("x.txt"), "x\n").unwrap();
        std::fs::write(b.join("y.txt"), "y\n").unwrap();
        let s = salvage_wip(input(&root, None)).await;
        assert_eq!(s.outcome, Outcome::Refused, "{s:?}");
        assert!(s.detail.unwrap().contains("2 dirty worktrees"));
        cleanup(&root);
    }

    #[tokio::test]
    async fn reports_none_on_a_clean_worktree_rather_than_an_empty_commit() {
        let (root, _wt) = repo("clean", "ISS-6-c").await;
        let s = salvage_wip(input(&root, Some("ISS-6"))).await;
        assert_eq!(s.outcome, Outcome::None);
        assert!(s.sha.is_none());
        cleanup(&root);
    }

    #[tokio::test]
    async fn never_commits_an_ignored_file() {
        let (root, wt) = repo("ignored", "ISS-7-d").await;
        std::fs::write(wt.join(".gitignore"), ".env\n").unwrap();
        std::fs::write(wt.join(".env"), "SECRET=1\n").unwrap();
        let s = salvage_wip(input(&root, Some("ISS-7"))).await;
        assert_eq!(s.outcome, Outcome::Pushed, "{s:?}");
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
        let (root, wt) = repo("nopush", "ISS-8-e").await;
        std::fs::write(wt.join("new.txt"), "x\n").unwrap();
        let _ = std::fs::remove_dir_all(root.with_extension("remote.git"));
        let s = salvage_wip(input(&root, Some("ISS-8"))).await;
        assert_eq!(s.outcome, Outcome::CommittedNotPushed, "{s:?}");
        assert!(s.sha.is_some());
        assert!(s.detail.is_some());
        cleanup(&root);
    }

    #[tokio::test]
    async fn commits_even_when_a_pre_commit_hook_refuses() {
        let (root, wt) = repo("hook", "ISS-9-f").await;
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
        let s = salvage_wip(input(&root, Some("ISS-9"))).await;
        assert_eq!(s.outcome, Outcome::Pushed, "{s:?}");
        cleanup(&root);
    }

    #[test]
    fn skips_a_detached_worktree_such_as_the_agents_merge_checkout() {
        let listing = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/.claude/worktrees/_merge\nHEAD bbb\ndetached\n\nworktree /r/.claude/worktrees/iss-1\nHEAD ccc\nbranch refs/heads/ISS-1-x\n";
        let got = parse_worktrees(listing);
        assert_eq!(got.len(), 2);
        assert_eq!(got[1].branch, "ISS-1-x");
    }

    #[test]
    fn matches_an_issue_key_only_on_a_segment_boundary() {
        assert!(belongs_to_issue("ISS-862-runner-health", "ISS-862"));
        assert!(belongs_to_issue("iss-862", "ISS-862"));
        assert!(belongs_to_issue("feature/ISS-862-x", "ISS-862"));
        assert!(!belongs_to_issue("ISS-8620-other", "ISS-862"));
        assert!(!belongs_to_issue("ISS-86", "ISS-862"));
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
