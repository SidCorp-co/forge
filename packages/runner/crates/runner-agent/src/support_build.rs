//! A support room's build (`build.push`, REQ-75 r5 BC-27): what the session changed in the room's
//! working copy, committed on a feat/ or fix/ branch and pushed, once a confirmer confirmed it in
//! the room. The box does it outside the session's sandbox, with its own git access; the session
//! itself never holds a way to commit or push.
//!
//! Two lines it never crosses, whatever core asks: it pushes no branch but a feat/ or fix/ one,
//! never the base the working copy was made from, and never with force. A base that production
//! deploys from is refused by core before the frame is sent; a push the remote refuses as a
//! non-fast-forward fails here and is said, never retried with force.

use std::path::Path;

use crate::chat_checkout::{branch_refusal, git};

/// What core asked this box to build.
pub struct BuildRequest<'a> {
    pub working_copy: &'a Path,
    pub base: &'a str,
    pub branch: &'a str,
    pub title: &'a str,
    pub body: &'a str,
}

/// What was pushed: the branch, its head, and the files it changes against `origin/<base>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Built {
    pub branch: String,
    pub base: String,
    pub sha: String,
    pub files: Vec<String>,
}

/// Whether `branch` is one a build pushes: `feat/<slug>` or `fix/<slug>`, lower case.
pub fn build_branch_ok(branch: &str) -> bool {
    let Some(slug) = branch
        .strip_prefix("feat/")
        .or_else(|| branch.strip_prefix("fix/"))
    else {
        return false;
    };
    let mut chars = slug.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    (2..=61).contains(&slug.len())
        && first_ok
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
        && !slug.contains("..")
        && !slug.ends_with(".lock")
}

/// Commit the working copy on `branch` and push it, or say why not.
pub async fn push(req: &BuildRequest<'_>) -> Result<Built, String> {
    let wc = req.working_copy;
    if !wc.join(".git").exists() {
        return Err(format!(
            "this box keeps no working copy at {}: no turn of this room has run with the build view yet",
            wc.display()
        ));
    }
    if let Some(why) = branch_refusal(req.base) {
        return Err(format!("the base: {why}"));
    }
    if !build_branch_ok(req.branch) {
        return Err(format!(
            "{:?} is not a branch a build pushes: feat/<slug> or fix/<slug>, lower case",
            req.branch
        ));
    }
    if req.branch == req.base {
        return Err(format!(
            "a build never pushes the base {} it was made from",
            req.base
        ));
    }
    let name = git(wc, &["config", "user.name"]).await.ok();
    let email = git(wc, &["config", "user.email"]).await.ok();
    let (Some(name), Some(email)) = (
        name.filter(|n| !n.is_empty()),
        email.filter(|e| !e.is_empty()),
    ) else {
        return Err(
            "the checkout names no git user.name and user.email, so a commit would be nobody's"
                .into(),
        );
    };
    git(wc, &["fetch", "origin", req.base]).await?;
    on_branch(wc, req.base, req.branch).await?;
    git(wc, &["add", "-A"]).await?;
    let staged = git(wc, &["diff", "--cached", "--name-only"]).await?;
    let remote_base = format!("origin/{}", req.base);
    if !staged.is_empty() {
        let user = format!("user.name={name}");
        let mail = format!("user.email={email}");
        git(
            wc,
            &[
                "-c", &user, "-c", &mail, "commit", "-m", req.title, "-m", req.body,
            ],
        )
        .await?;
    } else {
        let ahead = git(
            wc,
            &["rev-list", "--count", &format!("{remote_base}..HEAD")],
        )
        .await?;
        if ahead.trim() == "0" {
            return Err(format!(
                "nothing to build: the working copy changes nothing against {remote_base}"
            ));
        }
    }
    let refspec = format!("refs/heads/{0}:refs/heads/{0}", req.branch);
    git(wc, &["push", "origin", &refspec]).await?;
    let sha = git(wc, &["rev-parse", "HEAD"]).await?;
    let files = git(
        wc,
        &["diff", "--name-only", &format!("{remote_base}...HEAD")],
    )
    .await?
    .lines()
    .map(str::to_string)
    .filter(|l| !l.is_empty())
    .collect();
    Ok(Built {
        branch: req.branch.to_string(),
        base: req.base.to_string(),
        sha,
        files,
    })
}

/// Put the working copy on `branch`, keeping the session's uncommitted edits. A detached copy
/// starts it where it stands; one on another branch carries the edits onto a fresh `branch` from
/// `origin/<base>`, and a conflict puts everything back and is refused naming the files.
async fn on_branch(wc: &Path, base: &str, branch: &str) -> Result<(), String> {
    let current = git(wc, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    if current == branch {
        return Ok(());
    }
    if current == "HEAD" {
        return git(wc, &["switch", "-c", branch]).await.map(|_| ());
    }
    let stashed = git(wc, &["stash", "push", "-u", "-m", "support-build"]).await?;
    let held = !stashed.contains("No local changes");
    git(wc, &["switch", "-c", branch, &format!("origin/{base}")]).await?;
    if !held {
        return Ok(());
    }
    if git(wc, &["stash", "pop"]).await.is_ok() {
        return Ok(());
    }
    let conflicted = git(wc, &["diff", "--name-only", "--diff-filter=U"])
        .await
        .unwrap_or_default();
    // back as it was: the edits on the branch they were made on, the new branch gone
    let _ = git(wc, &["reset", "--hard", "HEAD"]).await;
    let _ = git(wc, &["switch", &current]).await;
    let _ = git(wc, &["branch", "-D", branch]).await;
    let _ = git(wc, &["stash", "pop"]).await;
    Err(format!(
        "the working copy is on {current}, and its edits conflict with origin/{base} on a fresh \
         {branch}: {}. Nothing was committed; finish {current}, or build on it",
        conflicted.lines().collect::<Vec<_>>().join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_checkout::ensure_working_copy;
    use crate::chat_checkout_test_repo::Repos;

    async fn copy(t: &Repos) -> std::path::PathBuf {
        ensure_working_copy(&t.clone, &t.root.join("base"), "room-1", "dev")
            .await
            .unwrap()
    }

    fn req<'a>(wc: &'a Path, branch: &'a str) -> BuildRequest<'a> {
        BuildRequest {
            working_copy: wc,
            base: "dev",
            branch,
            title: "fix: say hello louder",
            body: "Asked in the room.",
        }
    }

    #[test]
    fn only_feat_and_fix_branches_are_built() {
        for ok in ["feat/louder", "fix/a1", "fix/mta6-ptr.v2"] {
            assert!(build_branch_ok(ok), "{ok}");
        }
        for bad in [
            "dev",
            "master",
            "feat/",
            "feat/x",
            "Feat/louder",
            "feat/-x",
            "chore/x",
            "feat/a/b",
            "fix/a..b",
        ] {
            assert!(!build_branch_ok(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn a_build_commits_on_its_branch_and_pushes_it_leaving_the_base_alone() {
        let t = Repos::new();
        let wc = copy(&t).await;
        let base_before = t.origin_head("dev");
        std::fs::write(wc.join("README"), "HELLO\n").unwrap();
        let built = push(&req(&wc, "fix/louder"))
            .await
            .expect("the build was refused");
        assert_eq!(built.files, vec!["README".to_string()]);
        assert_eq!(t.origin_head("fix/louder"), Some(built.sha.clone()));
        assert_eq!(t.origin_head("dev"), base_before, "the base moved");
        let author = t.git(&wc, &["log", "-1", "--format=%an <%ae>%n%s"]);
        assert_eq!(
            author,
            "Box Owner <box@example.test>\nfix: say hello louder"
        );
    }

    #[tokio::test]
    async fn a_second_build_on_the_same_branch_adds_a_commit_and_pushes_without_force() {
        let t = Repos::new();
        let wc = copy(&t).await;
        std::fs::write(wc.join("a.txt"), "1").unwrap();
        let first = push(&req(&wc, "feat/two-steps")).await.unwrap();
        std::fs::write(wc.join("b.txt"), "2").unwrap();
        let second = push(&req(&wc, "feat/two-steps")).await.unwrap();
        assert_ne!(first.sha, second.sha);
        let parent = t.git(&wc, &["rev-parse", "HEAD~1"]);
        assert_eq!(parent, first.sha, "the second build rewrote the first");
        assert_eq!(second.files, vec!["a.txt".to_string(), "b.txt".to_string()]);
    }

    #[tokio::test]
    async fn a_branch_someone_else_moved_is_not_forced_over() {
        let t = Repos::new();
        let wc = copy(&t).await;
        std::fs::write(wc.join("a.txt"), "1").unwrap();
        push(&req(&wc, "fix/raced")).await.unwrap();
        // another clone moves the branch on origin
        let other = t.root.join("other");
        t.git(
            &t.root,
            &[
                "clone",
                "-b",
                "fix/raced",
                t.origin.to_str().unwrap(),
                "other",
            ],
        );
        t.git(&other, &["config", "user.name", "Other"]);
        t.git(&other, &["config", "user.email", "o@example.test"]);
        std::fs::write(other.join("c.txt"), "3").unwrap();
        t.git(&other, &["add", "c.txt"]);
        t.git(&other, &["commit", "-m", "theirs"]);
        t.git(&other, &["push", "origin", "fix/raced"]);
        let theirs = t.origin_head("fix/raced");
        std::fs::write(wc.join("b.txt"), "2").unwrap();
        let err = push(&req(&wc, "fix/raced")).await.unwrap_err();
        assert!(err.contains("push"), "{err}");
        assert_eq!(
            t.origin_head("fix/raced"),
            theirs,
            "their commit was forced over"
        );
    }

    #[tokio::test]
    async fn the_base_and_any_other_branch_shape_are_refused_and_nothing_is_pushed() {
        let t = Repos::new();
        let wc = copy(&t).await;
        std::fs::write(wc.join("a.txt"), "1").unwrap();
        for branch in ["dev", "master", "release/x"] {
            let err = push(&req(&wc, branch)).await.unwrap_err();
            assert!(
                err.contains("not a branch a build pushes"),
                "{branch}: {err}"
            );
        }
        let mut base_is_branch = req(&wc, "fix/same");
        base_is_branch.base = "fix/same";
        let err = push(&base_is_branch).await.unwrap_err();
        assert!(err.contains("never pushes the base"), "{err}");
        assert_eq!(t.origin_head("fix/same"), None);
    }

    #[tokio::test]
    async fn a_working_copy_that_changes_nothing_is_nothing_to_build() {
        let t = Repos::new();
        let wc = copy(&t).await;
        let err = push(&req(&wc, "fix/empty")).await.unwrap_err();
        assert!(err.starts_with("nothing to build"), "{err}");
        assert_eq!(t.origin_head("fix/empty"), None);
    }

    #[tokio::test]
    async fn a_new_branch_carries_the_edits_from_a_fresh_base() {
        let t = Repos::new();
        let wc = copy(&t).await;
        std::fs::write(wc.join("a.txt"), "1").unwrap();
        push(&req(&wc, "fix/first")).await.unwrap();
        std::fs::write(wc.join("b.txt"), "2").unwrap();
        let next = push(&req(&wc, "feat/second")).await.unwrap();
        assert_eq!(
            next.files,
            vec!["b.txt".to_string()],
            "the new branch carried the first build's commit"
        );
    }

    #[tokio::test]
    async fn no_working_copy_is_refused() {
        let t = Repos::new();
        let missing = t.root.join("nowhere");
        let err = push(&req(&missing, "fix/x1")).await.unwrap_err();
        assert!(err.contains("keeps no working copy"), "{err}");
    }
}
