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
//! `<repo>/.worktrees/` did not exist at all, while six agent worktrees sat
//! under `.claude/worktrees/`, one of them the very job this work came from. A
//! salvage that derived a path from a branch name would have been a silent
//! no-op on the whole fleet. This box cuts no checkout of its own, so where a
//! run's worktree sits is whatever its dispatcher chose, several conventions
//! can be live on one box at once, and only `git worktree list` sees them all.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

const PICK_BUDGET: Duration = Duration::from_secs(10);
const LOCAL_BUDGET: Duration = Duration::from_secs(15);
const PUSH_BUDGET: Duration = Duration::from_secs(45);

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

const FETCH_BUDGET: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Publication {
    /// Every commit here is reachable from a remote ref, proven by a fresh fetch.
    Published,
    /// This many commits are on no remote ref.
    Unpublished { commits: u32 },
    /// The question could not be answered, in the reader's words.
    Unknown { why: String },
}

pub async fn publication_of(worktree: &Path) -> Publication {
    let fetched = tokio::time::timeout(
        FETCH_BUDGET,
        git(worktree, &["fetch", "--prune", "--quiet", "--all"]),
    );
    match fetched.await {
        Ok(Some(out)) if out.status.success() => {}
        Ok(Some(out)) => {
            return Publication::Unknown {
                why: format!("`git fetch --all` failed: {}", stderr_brief(&out)),
            };
        }
        Ok(None) => {
            return Publication::Unknown {
                why: "`git fetch --all` could not be spawned".into(),
            };
        }
        Err(_) => {
            return Publication::Unknown {
                why: format!(
                    "`git fetch --all` did not answer within {}s",
                    FETCH_BUDGET.as_secs()
                ),
            };
        }
    }
    let Some(out) = git(
        worktree,
        &["rev-list", "--count", "HEAD", "--not", "--remotes"],
    )
    .await
    else {
        return Publication::Unknown {
            why: "`git rev-list --count HEAD --not --remotes` could not be spawned".into(),
        };
    };
    if !out.status.success() {
        return Publication::Unknown {
            why: format!(
                "`git rev-list --count HEAD --not --remotes` failed: {}",
                stderr_brief(&out)
            ),
        };
    }
    match stdout_trim(&out).parse::<u32>() {
        Ok(0) => Publication::Published,
        Ok(commits) => Publication::Unpublished { commits },
        Err(e) => Publication::Unknown {
            why: format!("could not read the unpublished count: {e}"),
        },
    }
}

pub async fn publish(worktree: &Path, branch: &str) -> Publication {
    let refspec = format!("HEAD:refs/heads/{branch}");
    let argv = ["push", "origin", refspec.as_str()];
    let _ = tokio::time::timeout(PUSH_BUDGET, git(worktree, &argv)).await;
    publication_of(worktree).await
}

/// The namespace [`keep_at`] writes into, so a commit nothing else names is
/// still findable by a person: `git for-each-ref refs/forge/kept`.
const KEPT_REFS: &str = "refs/forge/kept";

/// The refs that outlive `git worktree remove`. `--all` cannot stand here: it
/// lists HEAD alongside the refs, which is the very thing being asked about, so
/// it answers "nothing at risk" for every input including the one that is.
const SURVIVING_REFS: [&str; 4] = ["--branches", "--tags", "--remotes", "--glob=refs/forge"];

/// Whether the commits in a checkout outlive the checkout itself.
///
/// This is the question a release actually turns on, and it is a different one
/// from [`Publication`]. A remote is one way for work to survive this box; a
/// ref in this repository is another, and `git worktree remove` touches neither
/// — it takes the directory and its administrative entry, and leaves every ref
/// where it was. Asking it by sha rather than by branch name is what lets a
/// detached HEAD answer at all (ISS-1188).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Retention {
    /// Every commit at HEAD is reachable from a ref the repository keeps.
    Kept,
    /// This many commits are named by this checkout's HEAD and by nothing else.
    AtRisk { commits: u32 },
    /// The question could not be answered, in the reader's words.
    Unknown { why: String },
}

pub async fn retention_of(worktree: &Path) -> Retention {
    let mut argv = vec!["rev-list", "--count", "HEAD", "--not"];
    argv.extend_from_slice(&SURVIVING_REFS);
    let Some(out) = git(worktree, &argv).await else {
        return Retention::Unknown {
            why: "`git rev-list --count HEAD --not <refs>` could not be spawned".into(),
        };
    };
    if !out.status.success() {
        return Retention::Unknown {
            why: format!(
                "`git rev-list --count HEAD --not <refs>` failed: {}",
                stderr_brief(&out)
            ),
        };
    }
    match stdout_trim(&out).parse::<u32>() {
        Ok(0) => Retention::Kept,
        Ok(commits) => Retention::AtRisk { commits },
        Err(e) => Retention::Unknown {
            why: format!("could not read the at-risk count: {e}"),
        },
    }
}

/// Give the commits at HEAD a name this repository keeps, and answer with it.
///
/// For the one shape nothing else covers: a detached checkout that committed.
/// Its work is on no branch, so removing the checkout would leave the commits
/// unnamed — and refusing the release over that is what wedged the run. A ref
/// costs nothing, survives the removal, and is a place a person can look:
/// `git for-each-ref refs/forge/kept`.
///
/// The name carries the commit as well as the run, so writing one can never
/// take a name off another. A run refused, worked on by hand and released
/// again would otherwise point its one ref at the new HEAD and leave the
/// commits it had been keeping with no name at all — a preserve step that
/// loses work is worse than one that never ran.
pub async fn keep_at(worktree: &Path, run_id: &str) -> std::result::Result<String, String> {
    let head = match git(worktree, &["rev-parse", "--short=12", "HEAD"]).await {
        Some(out) if out.status.success() => stdout_trim(&out),
        Some(out) => {
            return Err(format!(
                "`git rev-parse HEAD` failed, so there is no name to keep these commits under: {}",
                stderr_brief(&out)
            ))
        }
        None => return Err("`git rev-parse HEAD` could not be spawned".into()),
    };
    let name = format!("{KEPT_REFS}/{run_id}-{head}");
    match git(worktree, &["update-ref", &name, "HEAD"]).await {
        Some(out) if out.status.success() => Ok(name),
        Some(out) => Err(format!(
            "`git update-ref {name} HEAD` failed: {}",
            stderr_brief(&out)
        )),
        None => Err(format!("`git update-ref {name} HEAD` could not be spawned")),
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

#[allow(dead_code)]
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
    pub agent_branch: &'a str,
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
    let seen: Vec<String> = dirty.iter().map(|t| t.branch.clone()).collect();
    dirty.retain(|t| t.branch == input.agent_branch);
    if dirty.is_empty() && !seen.is_empty() {
        return Err(Salvage::refused(format!(
            "no dirty worktree on {}; saw {}",
            input.agent_branch,
            seen.join(", ")
        )));
    }
    match dirty.len() {
        0 => Err(Salvage::bare(Outcome::None)),
        1 => Ok(dirty.remove(0)),
        n => Err(Salvage::refused(format!(
            "{n} worktrees claim to be {}; refusing to guess",
            input.agent_branch
        ))),
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

    fn input<'a>(root: &'a Path, agent_branch: &'a str) -> SalvageInput<'a> {
        SalvageInput {
            repo_root: root,
            base_branch: Some("main"),
            agent_branch,
            job_id: "job-1",
            attempt: 2,
            failure: "spend limit",
        }
    }

    /// The retention question is what a release turns on, and every one of
    /// these shapes is one the publication question could not answer at all.
    mod retention {
        use super::*;

        /// A repo with NO remote configured, one commit, and one worktree on
        /// its own branch — the shape every MCP-only storefront project has.
        async fn local_only(tag: &str, branch: &str) -> (PathBuf, PathBuf) {
            let root = std::env::temp_dir().join(format!(
                "forge-retention-{tag}-{}-{:?}",
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
            let wt = add_worktree(&root, branch).await;
            (root, wt)
        }

        #[tokio::test]
        async fn a_repository_with_no_remote_still_keeps_its_own_commits() {
            let (root, wt) = local_only("noremote", "ISS-43-listing").await;
            std::fs::write(wt.join("new.txt"), "work\n").unwrap();
            run(&wt, &["add", "-A"]).await;
            run(&wt, &["commit", "-qm", "work"]).await;

            assert_eq!(
                publication_of(&wt).await,
                Publication::Unpublished { commits: 2 },
                "the publication question counts every commit here, because there is no remote \
                 for any of them to be on — and no sequence of events can ever change that"
            );
            assert_eq!(
                retention_of(&wt).await,
                Retention::Kept,
                "the branch is a ref this repository keeps, and `git worktree remove` does not \
                 touch refs, so the commits outlive the checkout"
            );
            cleanup(&root);
        }

        #[tokio::test]
        async fn a_detached_head_answers_the_question_a_branch_name_cannot() {
            let (root, wt) = repo("detached", "ISS-6-detach").await;
            std::fs::write(wt.join("new.txt"), "work\n").unwrap();
            run(&wt, &["add", "-A"]).await;
            run(&wt, &["commit", "-qm", "work"]).await;
            run(&wt, &["switch", "--detach", "-q"]).await;

            assert!(
                git(&wt, &["symbolic-ref", "--short", "HEAD"])
                    .await
                    .is_some_and(|o| !o.status.success()),
                "the premise: this checkout has no branch name to give anyone"
            );
            assert_eq!(
                retention_of(&wt).await,
                Retention::Kept,
                "the commit is on `ISS-6-detach`, which the detachment did not move"
            );
            cleanup(&root);
        }

        #[tokio::test]
        async fn a_commit_no_ref_holds_is_at_risk_until_keep_at_names_it() {
            let (root, wt) = repo("atrisk", "ISS-7-loose").await;
            run(&wt, &["switch", "--detach", "-q"]).await;
            std::fs::write(wt.join("new.txt"), "work on no branch\n").unwrap();
            run(&wt, &["add", "-A"]).await;
            run(&wt, &["commit", "-qm", "loose"]).await;

            assert_eq!(
                retention_of(&wt).await,
                Retention::AtRisk { commits: 1 },
                "this commit is named by HEAD and by nothing else"
            );

            let name = keep_at(&wt, "run-1").await.expect("a ref can be written");
            assert!(
                name.starts_with("refs/forge/kept/run-1-"),
                "the ref is named after the run, so a person can find it from the refusal: {name}"
            );
            assert_eq!(
                retention_of(&wt).await,
                Retention::Kept,
                "the exact ref `keep_at` writes must be one the retention question negates — a \
                 ref set that misses it would leave the release refusing work it had just saved"
            );

            let head = stdout_trim(&git(&wt, &["rev-parse", "HEAD"]).await.unwrap());
            run(
                &root,
                &["worktree", "remove", "--force", &wt.to_string_lossy()],
            )
            .await;
            assert!(!wt.exists(), "the checkout is gone");
            let kept = stdout_trim(&git(&root, &["rev-parse", &name]).await.unwrap());
            assert_eq!(
                kept, head,
                "and the commit is still named, by the ref written for it"
            );
            cleanup(&root);
        }

        #[tokio::test]
        async fn keeping_a_second_commit_does_not_take_the_name_off_the_first() {
            let (root, wt) = repo("twokeeps", "ISS-8-twice").await;
            run(&wt, &["switch", "--detach", "-q"]).await;
            std::fs::write(wt.join("first.txt"), "the first thing kept\n").unwrap();
            run(&wt, &["add", "-A"]).await;
            run(&wt, &["commit", "-qm", "first"]).await;
            let first_head = stdout_trim(&git(&wt, &["rev-parse", "HEAD"]).await.unwrap());
            let first = keep_at(&wt, "run-1").await.expect("the first is kept");

            // The run was refused, somebody worked in the checkout by hand, and
            // the next sweep tries again — which is exactly what the window and
            // `run release` make possible.
            std::fs::write(wt.join("second.txt"), "and then a second\n").unwrap();
            run(&wt, &["add", "-A"]).await;
            run(&wt, &["commit", "-qm", "second"]).await;
            let second = keep_at(&wt, "run-1").await.expect("the second is kept");

            assert_ne!(
                first, second,
                "one name for two commits would point at the later one and leave the earlier \
                 with none — a preserve step that loses work is worse than one that never ran"
            );
            assert_eq!(
                stdout_trim(&git(&wt, &["rev-parse", &first]).await.unwrap()),
                first_head,
                "the first ref must still name what it named"
            );
            assert_eq!(retention_of(&wt).await, Retention::Kept);
            cleanup(&root);
        }

        #[tokio::test]
        async fn a_path_git_cannot_answer_for_is_unknown_and_never_kept() {
            let dir = std::env::temp_dir().join(format!(
                "forge-retention-notarepo-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            assert!(
                matches!(retention_of(&dir).await, Retention::Unknown { .. }),
                "a directory that is no repository cannot answer, and not knowing is not Kept"
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn finds_the_agents_own_checkout_and_pushes_it() {
        let (root, wt) = repo("push", "ISS-1-alpha").await;
        std::fs::write(wt.join("new.txt"), "salvaged\n").unwrap();
        std::fs::write(wt.join("f.txt"), "one\ntwo\n").unwrap();
        let s = salvage_wip(input(&root, "ISS-1-alpha")).await;
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

    #[tokio::test]
    async fn never_touches_a_dirty_repo_root() {
        let (root, _wt) = repo("root", "ISS-2-beta").await;
        std::fs::write(root.join("dirty.txt"), "x\n").unwrap();
        let s = salvage_wip(input(&root, "ISS-2-beta")).await;
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
        let s = salvage_wip(input(&root, "ISS-10-mine")).await;
        assert_eq!(s.outcome, Outcome::Refused, "{s:?}");
        let d = s.detail.unwrap();
        assert!(d.contains("ISS-10-mine"), "{d}");
        assert!(d.contains("ISS-99-theirs"), "{d}");
        cleanup(&root);
    }

    #[tokio::test]
    async fn ignores_another_issues_dirty_worktree() {
        let (root, mine) = repo("scope", "ISS-3-mine").await;
        let theirs = add_worktree(&root, "ISS-99-theirs").await;
        std::fs::write(theirs.join("stale.txt"), "old\n").unwrap();
        std::fs::write(mine.join("new.txt"), "x\n").unwrap();
        let s = salvage_wip(input(&root, "ISS-3-mine")).await;
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

    /// Replaces the old "several dirty and no key to choose" refusal. That arm
    /// existed because a prefix match could hit more than one tree and it broke
    /// the tie by mtime — which is how a stranger's branch got picked. An exact
    /// branch match cannot tie, so the named tree wins outright.
    #[tokio::test]
    async fn picks_the_named_tree_outright_when_several_are_dirty() {
        let (root, a) = repo("ambig", "ISS-4-a").await;
        let b = add_worktree(&root, "ISS-5-b").await;
        std::fs::write(a.join("x.txt"), "x\n").unwrap();
        std::fs::write(b.join("y.txt"), "y\n").unwrap();
        let s = salvage_wip(input(&root, "ISS-5-b")).await;
        assert_eq!(s.outcome, Outcome::Pushed, "{s:?}");
        assert_eq!(s.branch.as_deref(), Some("ISS-5-b"));
        cleanup(&root);
    }

    /// A master may name one agent for several issues; the branch it names is
    /// then a word no issue key predicts, and salvage must still find it.
    #[tokio::test]
    async fn finds_a_tree_whose_name_no_issue_key_would_have_matched() {
        let (root, wt) = repo("grouped", "catalog-sweep").await;
        std::fs::write(wt.join("new.txt"), "x\n").unwrap();
        let s = salvage_wip(input(&root, "catalog-sweep")).await;
        assert_eq!(s.outcome, Outcome::Pushed, "{s:?}");
        assert_eq!(s.branch.as_deref(), Some("catalog-sweep"));
        cleanup(&root);
    }

    #[tokio::test]
    async fn reports_none_on_a_clean_worktree_rather_than_an_empty_commit() {
        let (root, _wt) = repo("clean", "ISS-6-c").await;
        let s = salvage_wip(input(&root, "ISS-6-c")).await;
        assert_eq!(s.outcome, Outcome::None);
        assert!(s.sha.is_none());
        cleanup(&root);
    }

    #[tokio::test]
    async fn never_commits_an_ignored_file() {
        let (root, wt) = repo("ignored", "ISS-7-d").await;
        std::fs::write(wt.join(".gitignore"), ".env\n").unwrap();
        std::fs::write(wt.join(".env"), "SECRET=1\n").unwrap();
        let s = salvage_wip(input(&root, "ISS-7-d")).await;
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
        let s = salvage_wip(input(&root, "ISS-8-e")).await;
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
        let s = salvage_wip(input(&root, "ISS-9-f")).await;
        assert_eq!(s.outcome, Outcome::Pushed, "{s:?}");
        cleanup(&root);
    }

    #[tokio::test]
    async fn a_stale_ref_for_a_second_remote_is_not_a_remote_that_has_the_work() {
        let (root, wt) = repo("secondremote", "ISS-6-f6").await;
        let mirror = root.with_extension("mirror.git");
        let _ = std::fs::remove_dir_all(&mirror);
        std::fs::create_dir_all(&mirror).unwrap();
        run(&mirror, &["init", "--bare", "-b", "main"]).await;
        run(&wt, &["remote", "add", "mirror", &mirror.to_string_lossy()]).await;

        std::fs::write(wt.join("new.txt"), "the only copy\n").unwrap();
        run(&wt, &["add", "."]).await;
        run(&wt, &["commit", "-qm", "work"]).await;
        run(&wt, &["push", "-q", "mirror", "HEAD:refs/heads/ISS-6-f6"]).await;
        run(&wt, &["fetch", "-q", "mirror"]).await;
        // The mirror loses it. This box still holds `refs/remotes/mirror/ISS-6-f6`, and no fetch of
        // `origin` will ever prune that.
        run(&mirror, &["update-ref", "-d", "refs/heads/ISS-6-f6"]).await;

        let got = publication_of(&wt).await;
        assert!(
            matches!(got, Publication::Unpublished { .. }),
            "a ref only this box still remembers is not a remote that has the work: {got:?}"
        );

        let _ = std::fs::remove_dir_all(&mirror);
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
    fn counts_a_binary_file_without_adding_insertions() {
        assert_eq!(count_staged("3\t0\ta.txt\n-\t-\tb.png\n"), (2, 3));
    }

    #[test]
    fn omits_optional_fields_rather_than_sending_null() {
        let v = Salvage::bare(Outcome::None).to_json();
        assert_eq!(v, serde_json::json!({ "outcome": "none" }));
    }
}
