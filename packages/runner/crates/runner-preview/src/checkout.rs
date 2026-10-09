//! The checkout a preview serves where no run's worktree is (REQ-41): an idea's sketch branch,
//! edited by a sketch run and never pushed (BC-14), or a feedback item's past build, checked out
//! detached with no run at all (BC-17), seeded with demo data first where the project names it
//! (BC-22). Core names the paths, the branch and the commit; the box refuses any path outside
//! `<repoPath>/.claude/worktrees/` and decides nothing else.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use tokio::process::Command;

use crate::devserver::{tail, Failure, DETAIL_LIMIT};

/// `PreviewCheckout` as core sends it on `preview.start`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Checkout {
    #[serde(rename_all = "camelCase")]
    Sketch {
        repo_path: String,
        path: String,
        branch: String,
        #[serde(default)]
        base: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Reproduce {
        repo_path: String,
        path: String,
        sha: String,
    },
}

/// The remote a sketch branch pushes to by default: one that does not exist, so `git push` fails.
pub const NEVER_PUSHED: &str = "forge-sketch-is-never-pushed";

impl Checkout {
    fn repo(&self) -> &str {
        match self {
            Checkout::Sketch { repo_path, .. } | Checkout::Reproduce { repo_path, .. } => repo_path,
        }
    }

    pub fn path(&self) -> &str {
        match self {
            Checkout::Sketch { path, .. } | Checkout::Reproduce { path, .. } => path,
        }
    }

    /// Whether the checkout is the box's to remove when its preview closes for good: a reproduce
    /// always (nothing was made in it), a sketch only when abandoned (its run may have made work).
    pub fn removed_on(&self, why: Option<&str>) -> bool {
        match self {
            Checkout::Reproduce { .. } => true,
            Checkout::Sketch { .. } => why == Some("abandoned"),
        }
    }
}

fn refused(detail: String) -> Failure {
    Failure {
        reason: "WORKTREE_GONE",
        detail: tail(&detail, DETAIL_LIMIT),
    }
}

/// The checkout's path, when it sits inside the binding's own worktrees directory and nowhere else.
fn contained(c: &Checkout) -> Result<PathBuf, Failure> {
    let root = format!("{}/.claude/worktrees/", c.repo().trim_end_matches('/'));
    let path = c.path();
    let name = path.strip_prefix(&root).unwrap_or("");
    if !c.repo().starts_with('/')
        || name.is_empty()
        || name.contains('/')
        || name == ".."
        || name == "."
    {
        return Err(refused(format!(
            "core named the checkout {path}, which is not one directory under {root}: the box cuts a preview's checkout there and nowhere else"
        )));
    }
    if !Path::new(c.repo()).join(".git").exists() {
        return Err(refused(format!(
            "{} is not a git checkout, so no preview checkout can be cut from it: bind the project to its checkout (forge-runner bind)",
            c.repo()
        )));
    }
    Ok(PathBuf::from(path))
}

fn valid_branch(branch: &str) -> bool {
    let Some(rest) = branch.strip_prefix("sketch/") else {
        return false;
    };
    let mut parts = rest.splitn(3, '-');
    let (Some(kind), Some(num), Some(tag)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    (kind == "req" || kind == "fb")
        && !num.is_empty()
        && num.len() <= 9
        && num.bytes().all(|b| b.is_ascii_digit())
        && tag.len() == 6
        && tag
            .bytes()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
}

async fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!(
            "git {} failed ({}): {}",
            args.join(" "),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Cut the checkout, or take it as it stands where an earlier start of the same preview cut it.
pub async fn cut(c: &Checkout) -> Result<PathBuf, Failure> {
    let path = contained(c)?;
    if path.join(".git").exists() {
        return Ok(path);
    }
    let repo = c.repo();
    let at = path.to_string_lossy().into_owned();
    match c {
        Checkout::Sketch { branch, base, .. } => {
            if !valid_branch(branch) {
                return Err(refused(format!(
                    "core named the sketch branch {branch}, which is not sketch/<req|fb>-<n>-<6 base32>"
                )));
            }
            let base = match base {
                Some(b) => b.clone(),
                None => git(repo, &["rev-parse", "--verify", "--quiet", "origin/HEAD"])
                    .await
                    .unwrap_or_else(|_| "HEAD".into()),
            };
            git(repo, &["worktree", "add", "-b", branch, &at, &base])
                .await
                .map_err(refused)?;
            let key = format!("branch.{branch}.pushRemote");
            git(repo, &["config", &key, NEVER_PUSHED])
                .await
                .map_err(refused)?;
        }
        Checkout::Reproduce { sha, .. } => {
            if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(Failure {
                    reason: "REF_NOT_FOUND",
                    detail: format!("core named the commit {sha}, which is not a whole sha"),
                });
            }
            let object = format!("{sha}^{{commit}}");
            if git(repo, &["cat-file", "-e", &object]).await.is_err() {
                if let Err(out) = git(repo, &["fetch", "--quiet", "--no-tags", "origin", sha]).await
                {
                    return Err(Failure {
                        reason: "REF_NOT_FOUND",
                        detail: tail(
                            &format!("this box cannot fetch {sha} from its origin:\n{out}"),
                            DETAIL_LIMIT,
                        ),
                    });
                }
            }
            git(repo, &["worktree", "add", "--detach", &at, sha])
                .await
                .map_err(refused)?;
        }
    }
    Ok(path)
}

/// Remove the checkout from its repository's worktrees; a sketch's branch stays, local.
pub async fn remove(c: &Checkout) {
    let Ok(path) = contained(c) else { return };
    let at = path.to_string_lossy().into_owned();
    if let Err(e) = git(c.repo(), &["worktree", "remove", "--force", &at]).await {
        tracing::warn!("[preview] the checkout {at} could not be removed: {e}");
    }
}

/// The demo seed (`preview.demo.seed`), run once in the checkout before the dev server starts.
pub async fn seed(
    dir: &Path,
    command: &str,
    env: &serde_json::Map<String, serde_json::Value>,
    timeout: Duration,
) -> Result<(), Failure> {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    cmd.current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in env {
        if let Some(v) = v.as_str() {
            cmd.env(k, v);
        }
    }
    let run = cmd.output();
    let out = match tokio::time::timeout(timeout, run).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            return Err(Failure {
                reason: "DEV_SERVER_EXITED",
                detail: format!("the demo seed `{command}` could not start: {e}"),
            })
        }
        Err(_) => {
            return Err(Failure {
                reason: "DEV_SERVER_EXITED",
                detail: format!(
                    "the demo seed `{command}` did not finish within {}s",
                    timeout.as_secs()
                ),
            })
        }
    };
    if out.status.success() {
        return Ok(());
    }
    let printed = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Err(Failure {
        reason: "DEV_SERVER_EXITED",
        detail: tail(
            &format!(
                "the demo seed `{command}` exited ({}) before the dev server started:\n{printed}",
                out.status
            ),
            DETAIL_LIMIT,
        ),
    })
}

#[cfg(test)]
mod tests;
