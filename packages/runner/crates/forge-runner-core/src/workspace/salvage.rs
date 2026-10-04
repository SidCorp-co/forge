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

use crate::workspace::repo_cred::RepoCred;

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

/// In the words an operator's journal line carries, never the enum's own
/// shape: `Unpublished { commits: 1 }` is a program talking to itself.
impl std::fmt::Display for Publication {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Publication::Published => f.write_str("every commit here is on a remote"),
            Publication::Unpublished { commits } => {
                write!(f, "{commits} commit(s) here are on no remote")
            }
            Publication::Unknown { why } => {
                write!(f, "whether the work here is on a remote is unknown ({why})")
            }
        }
    }
}

pub async fn publication_of(worktree: &Path, cred: &RepoCred) -> Publication {
    let fetched = tokio::time::timeout(
        FETCH_BUDGET,
        git_over_network(worktree, &["fetch", "--prune", "--quiet", "--all"], cred),
    );
    match fetched.await {
        Ok(Some(out)) if out.status.success() => {}
        Ok(Some(out)) => {
            return Publication::Unknown {
                why: format!(
                    "`git fetch --all`, offering {}, failed: {}",
                    cred.source(),
                    stderr_brief(&out)
                ),
            };
        }
        Ok(None) => {
            return Publication::Unknown {
                why: format!(
                    "`git fetch --all`, offering {}, could not be spawned",
                    cred.source()
                ),
            };
        }
        Err(_) => {
            return Publication::Unknown {
                why: format!(
                    "`git fetch --all`, offering {}, did not answer within {}s",
                    cred.source(),
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

/// What a push to publish a branch came to: the publication read afterwards,
/// and, where git did not take the push, why in its own words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pushed {
    pub publication: Publication,
    /// `None` where git took the push. Otherwise the refusal, carrying git's
    /// first line and the credential the push offered — a key that reads and
    /// cannot write passes the check and fails here, and a line that dropped
    /// either half is the split this module's credential exists to diagnose.
    pub refused: Option<String>,
}

pub async fn publish(worktree: &Path, branch: &str, cred: &RepoCred) -> Pushed {
    let refspec = format!("HEAD:refs/heads/{branch}");
    let argv = ["push", "origin", refspec.as_str()];
    let push = tokio::time::timeout(PUSH_BUDGET, git_over_network(worktree, &argv, cred)).await;
    let refused = match push {
        Ok(Some(out)) if out.status.success() => None,
        Ok(Some(out)) => Some(format!(
            "`git push origin {refspec}`, offering {}, was refused: {}",
            cred.source(),
            stderr_brief(&out)
        )),
        Ok(None) => Some(format!(
            "`git push origin {refspec}`, offering {}, could not be spawned",
            cred.source()
        )),
        Err(_) => Some(format!(
            "`git push origin {refspec}`, offering {}, did not answer within {}s",
            cred.source(),
            PUSH_BUDGET.as_secs()
        )),
    };
    Pushed {
        publication: publication_of(worktree, cred).await,
        refused,
    }
}

/// One ref, among those that outlive `git worktree remove`, that names HEAD —
/// so a line saying the commits are safe can say where they are. `None` where
/// none does or git could not say; the caller's own predicate is what decides,
/// and this only names what it found.
///
/// Which one matters to the reader: in refname order the first was, on every
/// forge-core release at ff38a38, another issue's branch that happened to
/// contain the run's commits (ISS-1250, judge j2 finding 1). So the checkout's
/// own branch comes first, then a remote-tracking ref, then the rest by name.
pub async fn named_by(worktree: &Path) -> Option<String> {
    let out = git(
        worktree,
        &[
            "for-each-ref",
            "--contains",
            "HEAD",
            "--format=%(refname)",
            "refs/heads/",
            "refs/tags/",
            "refs/remotes/",
            "refs/forge/",
        ],
    )
    .await?;
    if !out.status.success() {
        return None;
    }
    let listed = stdout_trim(&out);
    let names: Vec<&str> = listed
        .lines()
        .filter(|n| !n.is_empty() && !n.ends_with("/HEAD"))
        .collect();
    let own = match git(worktree, &["symbolic-ref", "-q", "HEAD"]).await {
        Some(o) if o.status.success() => Some(stdout_trim(&o)),
        _ => None,
    };
    own.filter(|b| names.contains(&b.as_str()))
        .or_else(|| {
            names
                .iter()
                .find(|n| n.starts_with("refs/remotes/"))
                .map(|n| n.to_string())
        })
        .or_else(|| names.first().map(|n| n.to_string()))
}

/// Whether this repository names any remote at all. `None` where git could not
/// say, so a caller never reads "could not ask" as "has none".
pub async fn has_a_remote(worktree: &Path) -> Option<bool> {
    let out = git(worktree, &["remote"]).await?;
    out.status.success().then(|| !stdout_trim(&out).is_empty())
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

/// What a release may do about the DIRECTORY, which is the decision
/// [`retention_of`] is only the reading for.
///
/// One predicate, because two callers asking two different questions is what
/// this is here to end: `daemon/held_report.rs` used to ask [`publication_of`]
/// and print "run X keeps <path>" about a checkout `runner/terminate.rs` was
/// entitled to remove seconds later, and did (ISS-1250). Whatever the answer,
/// both now read it from here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fate {
    /// Every commit at HEAD is already named by a ref that outlives the
    /// directory. The release may take it.
    Named,
    /// This many commits are named by this checkout's HEAD and nothing else, so
    /// a ref of their own is written before the directory goes.
    NeedsARef { commits: u32 },
    /// This box could not establish either, so the directory stays.
    Kept { why: String },
}

pub async fn fate_of(worktree: &Path) -> Fate {
    match retention_of(worktree).await {
        Retention::Kept => Fate::Named,
        Retention::AtRisk { commits } => Fate::NeedsARef { commits },
        Retention::Unknown { why } => Fate::Kept { why },
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

/// A git call that reaches a remote, and therefore names the credential it
/// offers rather than taking whatever the child resolves.
async fn git_over_network(
    dir: &Path,
    args: &[&str],
    cred: &RepoCred,
) -> Option<std::process::Output> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    cred.apply(&mut cmd);
    cmd.output().await.ok()
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
    /// The credential this project's pushes are made with.
    pub cred: &'a RepoCred,
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
    let push = git_over_network(&target.path, &argv, input.cred);
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
