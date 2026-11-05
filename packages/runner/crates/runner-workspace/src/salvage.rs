//! What a release reads before it may take a run's checkout: whether the commits in it outlive
//! the directory, and whether anything in it exists nowhere else.
//!
//! The release used to commit a dirty checkout's diff onto its branch as a `wip(salvage)` commit
//! and then remove the directory. A checkout holding work nothing else carries is now kept and
//! named instead (ISS-1016): a commit made by a release is work nobody wrote, on a branch a
//! person may be standing on, and the directory was the one place the files were whole.
//!
//! Runner-side by necessity: core has no working copy. Nothing here pushes: a push from a release
//! published a run's branch to the project's `origin`, a customer's repository, from a release
//! nobody asked to ship anything (FB-273).

use std::path::Path;
use std::time::Duration;

use tokio::process::Command;

use crate::repo_cred::RepoCred;
use runner_platform::git::git;

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
    runner_platform::git::non_interactive(cmd.args(args).current_dir(dir));
    cred.apply(&mut cmd);
    cmd.output().await.ok()
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

/// How many uncommitted files a line names before it says how many more there are.
const FILES_NAMED: usize = 5;

/// How many unlanded commits a line names by sha before it says how many more there are.
const COMMITS_NAMED: usize = 3;

/// The work in `worktree` that has not landed, in words a journal line and a run's close can
/// carry, or `None` where everything in it is already in `base` — the ref the tree was cut from.
///
/// Two readings, and either keeps the directory (ISS-1016):
/// - a file git has not been told to keep — modified, staged, or untracked and not ignored. Files
///   `.gitignore` claims are build output and hold nothing, which is what keeps them from pinning
///   a checkout for ever;
/// - a commit at HEAD whose CONTENT `base` does not hold, as `git cherry <base> HEAD` marks it `+`.
///   Content, not sha: a branch landed by a rebase lands as other commits with the same patches,
///   and asking by sha kept every such tree for ever.
///
/// A base that cannot be read — none recorded, or a ref this repository no longer holds — keeps
/// the directory too, and says so: not knowing whether work landed is not knowing it did.
pub async fn work_only_here(worktree: &Path, base: Option<&str>) -> Option<String> {
    match git(
        worktree,
        &["status", "--porcelain", "--untracked-files=all"],
    )
    .await
    {
        Some(out) if out.status.success() => {
            let listed = String::from_utf8_lossy(&out.stdout);
            let files: Vec<&str> = listed
                .lines()
                .filter_map(|l| l.get(3..))
                .filter(|f| !f.is_empty())
                .collect();
            if !files.is_empty() {
                return Some(format!(
                    "{} uncommitted file(s): {}",
                    files.len(),
                    named(&files, FILES_NAMED)
                ));
            }
        }
        Some(out) => {
            return Some(format!(
                "git would not say whether anything in it is uncommitted ({})",
                stderr_brief(&out)
            ))
        }
        None => return Some("git could not be asked whether anything in it is uncommitted".into()),
    }
    match base {
        Some(base) => unlanded(worktree, base).await,
        None => {
            Some("no base was recorded for it, so whether its commits landed cannot be read".into())
        }
    }
}

/// The first `max` of `items`, and how many more there are.
fn named(items: &[&str], max: usize) -> String {
    let shown = items[..items.len().min(max)].join(", ");
    match items.len().saturating_sub(max) {
        0 => shown,
        more => format!("{shown} and {more} more"),
    }
}

/// The commits at HEAD whose patch `base` does not hold, said as [`work_only_here`] says them.
async fn unlanded(worktree: &Path, base: &str) -> Option<String> {
    let at = format!("{base}^{{commit}}");
    match git(worktree, &["rev-parse", "--verify", "--quiet", &at]).await {
        Some(out) if out.status.success() => {}
        Some(_) => {
            return Some(format!(
                "its base {base} is no ref this repository holds, so whether its commits landed \
                 cannot be read"
            ))
        }
        None => {
            return Some(format!(
                "git could not be asked whether its base {base} is a ref this repository holds"
            ))
        }
    }
    match git(worktree, &["cherry", base, "HEAD"]).await {
        Some(out) if out.status.success() => {
            let listed = String::from_utf8_lossy(&out.stdout);
            let missing: Vec<&str> = listed
                .lines()
                .filter_map(|l| l.strip_prefix("+ "))
                .map(|sha| sha.get(..9).unwrap_or(sha))
                .collect();
            (!missing.is_empty()).then(|| {
                format!(
                    "{} commit(s) at its HEAD whose change is not in {base}: {}",
                    missing.len(),
                    named(&missing, COMMITS_NAMED)
                )
            })
        }
        Some(out) => Some(format!(
            "git would not compare its commits with {base} ({})",
            stderr_brief(&out)
        )),
        None => Some(format!(
            "git could not be asked which of its commits are in {base}"
        )),
    }
}
