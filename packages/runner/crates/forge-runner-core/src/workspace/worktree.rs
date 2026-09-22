//! Git worktrees under `<repo>/.worktrees/<branch>`, so a code job runs on an
//! isolated branch checkout. Ported from the Tauri app's worktree helper.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command;

use crate::error::{Error, Result};

fn sanitize(branch: &str) -> String {
    branch.replace('/', "-")
}

async fn git(repo: &str, args: &[&str]) -> Result<std::process::Output> {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| Error::Other(format!("git {}: {e}", args.join(" "))))
}

fn create_argv<'a>(rel: &'a str, branch: &'a str, start_point: Option<&'a str>) -> Vec<&'a str> {
    let mut argv = vec!["worktree", "add", rel, "-b", branch];
    argv.extend(start_point);
    argv
}

/// Where `create` puts (or finds) the worktree for `branch`. Split out so the
/// sanitising rule has one home.
pub fn path(repo: &str, branch: &str) -> PathBuf {
    PathBuf::from(repo).join(format!(".worktrees/{}", sanitize(branch)))
}

/// Create (or reuse) a worktree for `branch` and return its absolute path.
///
/// `start_point` is the commit-ish a NEW branch is cut from; `None` falls back
/// to the main worktree's HEAD.
pub async fn create(repo: &str, branch: &str, start_point: Option<&str>) -> Result<PathBuf> {
    ensure_gitignore(repo).await;
    let rel = format!(".worktrees/{}", sanitize(branch));

    let abs = path(repo, branch);

    if let Some(existing) = reusable(repo, &abs, branch).await {
        let _ = copy_skills(repo, &existing).await;
        return Ok(existing);
    }

    let out = git(repo, &create_argv(&rel, branch, start_point)).await?;
    if !out.status.success() {
        let _ = git(repo, &["worktree", "prune"]).await;
        let retry = git(repo, &["worktree", "add", &rel, branch]).await?;
        if !retry.status.success() {
            return Err(Error::Other(format!(
                "git worktree add failed: {}",
                String::from_utf8_lossy(&retry.stderr).trim()
            )));
        }
    }

    // Carry skills into the worktree (mirrors the Tauri behavior).
    let _ = copy_skills(repo, &abs).await;
    Ok(abs)
}

/// `abs` when it is ALREADY this branch's registered worktree, else `None`.
///
/// Both halves are load-bearing. HEAD must be the branch asked for, or a stage
/// would resume in a tree holding some other issue's work; and the path must be
/// one git lists for THIS repo, so a stray directory left by a deleted worktree
/// falls through to the create path rather than being handed to an agent as a
/// checkout git does not track.
async fn reusable(repo: &str, abs: &Path, branch: &str) -> Option<PathBuf> {
    if !abs.is_dir() {
        return None;
    }
    let out = git(
        &abs.to_string_lossy(),
        &["rev-parse", "--abbrev-ref", "HEAD"],
    )
    .await
    .ok()?;
    if !out.status.success() || String::from_utf8_lossy(&out.stdout).trim() != branch {
        return None;
    }
    let want = abs.canonicalize().ok()?;
    let listed = list(repo).await.ok()?;
    listed
        .iter()
        .any(|p| PathBuf::from(p).canonicalize().ok().as_ref() == Some(&want))
        .then(|| abs.to_path_buf())
}

/// What git says is at a path.
///
/// `git worktree remove` refuses a main working tree by design, so a caller
/// that learns this from a failed removal cannot tell a refusal that will
/// never succeed from one that might, and retries it forever (ISS-1183). The
/// question is put to git at the path itself rather than derived from the
/// path's shape, which is why it needs no repo root and why it holds wherever
/// the worktree sits: a checkout under `<repo>/.claude/worktrees/` answers
/// `Linked` exactly as one under `<repo>/.worktrees/` does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A linked worktree. `git worktree remove` takes it.
    Linked,
    /// The repository's main working tree. It is nobody's to remove.
    MainWorkingTree,
    /// Git names no worktree here.
    NotAWorktree,
    /// Git could not be asked, which is not an answer.
    Unknown,
}

/// Ask git what `worktree` is.
///
/// A main working tree's `--git-dir` and `--git-common-dir` are the same
/// directory; a linked worktree's `--git-dir` is `<common>/worktrees/<name>`
/// and differs. Both are resolved against the checkout before they are
/// compared, because git answers either one relatively.
pub async fn kind_at(worktree: &Path) -> Kind {
    if !worktree.is_dir() {
        return Kind::NotAWorktree;
    }
    let out = Command::new("git")
        .args(["rev-parse", "--git-dir", "--git-common-dir"])
        .current_dir(worktree)
        .stdin(Stdio::null())
        .output()
        .await;
    let Ok(out) = out else {
        return Kind::Unknown;
    };
    if !out.status.success() {
        return Kind::NotAWorktree;
    }
    kind_of(worktree, &String::from_utf8_lossy(&out.stdout))
}

/// What git's two-line answer means, split from the asking so the reading is
/// testable without a git that can be made to answer wrongly.
///
/// An answer that is not two paths is `Unknown` rather than a guess: the
/// caller refuses on that, and refusing costs an operator a sweep where
/// guessing could cost them a checkout.
fn kind_of(worktree: &Path, answer: &str) -> Kind {
    let mut lines = answer.lines();
    let (Some(git_dir), Some(common_dir)) = (lines.next(), lines.next()) else {
        return Kind::Unknown;
    };
    let resolve = |p: &str| {
        let p = Path::new(p);
        let abs = if p.is_absolute() {
            p.to_path_buf()
        } else {
            worktree.join(p)
        };
        abs.canonicalize().unwrap_or(abs)
    };
    if resolve(git_dir) == resolve(common_dir) {
        Kind::MainWorkingTree
    } else {
        Kind::Linked
    }
}

pub async fn remove_at(repo: &str, worktree: &std::path::Path) -> Result<()> {
    let out = git(
        repo,
        &["worktree", "remove", &worktree.to_string_lossy(), "--force"],
    )
    .await?;
    if !out.status.success() {
        return Err(Error::Other(format!(
            "git worktree remove failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// List worktree paths under `.worktrees/`.
pub async fn list(repo: &str) -> Result<Vec<String>> {
    let out = git(repo, &["worktree", "list", "--porcelain"]).await?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .filter(|p| p.contains("/.worktrees/"))
        .map(str::to_string)
        .collect())
}

async fn ensure_gitignore(repo: &str) {
    let p = PathBuf::from(repo).join(".gitignore");
    let has = std::fs::read_to_string(&p)
        .map(|c| c.lines().any(|l| l.trim() == ".worktrees"))
        .unwrap_or(false);
    if !has {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
        {
            let _ = writeln!(f, ".worktrees");
        }
    }
}

async fn copy_skills(repo: &str, worktree: &Path) -> Result<()> {
    let src = PathBuf::from(repo).join(".claude").join("skills");
    if !src.is_dir() {
        return Ok(());
    }
    let dst = worktree.join(".claude").join("skills");
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Best-effort recursive copy via `cp -r` (Unix) / robocopy is overkill here.
    #[cfg(unix)]
    {
        let _ = Command::new("cp")
            .arg("-r")
            .arg(&src)
            .arg(dst.parent().unwrap())
            .output()
            .await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_point_is_the_last_arg_so_the_new_branch_is_cut_from_it() {
        let argv = create_argv(".worktrees/ISS-1", "ISS-1", Some("origin/release/stg"));
        assert_eq!(
            argv,
            [
                "worktree",
                "add",
                ".worktrees/ISS-1",
                "-b",
                "ISS-1",
                "origin/release/stg"
            ]
        );
    }

    #[test]
    fn without_a_start_point_git_falls_back_to_head() {
        let argv = create_argv(".worktrees/ISS-1", "ISS-1", None);
        assert_eq!(argv, ["worktree", "add", ".worktrees/ISS-1", "-b", "ISS-1"]);
    }

    async fn run(dir: &Path, args: &[&str]) {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .stdin(Stdio::null())
            .output()
            .await
            .unwrap();
    }

    /// Unique temp repo per test on `main` with one commit (no tempfile dep in
    /// this crate — same pattern as `refresh.rs` and `salvage.rs`).
    async fn repo(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "forge-worktree-{tag}-{}-{:?}",
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
        root
    }

    async fn branch_of(dir: &Path) -> String {
        let out = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(dir)
            .output()
            .await
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[tokio::test]
    async fn cuts_the_branch_and_puts_it_where_path_says() {
        let root = repo("cuts").await;
        let r = root.to_string_lossy().to_string();
        let wt = create(&r, "ISS-1", None).await.unwrap();
        assert_eq!(wt, path(&r, "ISS-1"));
        assert!(
            wt.join("f.txt").is_file(),
            "worktree has the repo's content"
        );
        assert_eq!(branch_of(&wt).await, "ISS-1");
        assert_eq!(branch_of(&root).await, "main", "the root did not move");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn the_second_stage_of_an_issue_reuses_the_first_stages_checkout() {
        let root = repo("reuse").await;
        let r = root.to_string_lossy().to_string();
        let first = create(&r, "ISS-2", None).await.unwrap();
        std::fs::write(first.join("code-stage.txt"), "written by code\n").unwrap();

        let second = create(&r, "ISS-2", None).await.unwrap();
        assert_eq!(second, first, "same issue, same tree");
        assert!(
            second.join("code-stage.txt").is_file(),
            "the test stage must see what the code stage wrote"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn two_issues_get_two_independent_checkouts() {
        let root = repo("two").await;
        let r = root.to_string_lossy().to_string();
        let a = create(&r, "ISS-3", None).await.unwrap();
        let b = create(&r, "ISS-4", None).await.unwrap();
        assert_ne!(a, b);
        std::fs::write(a.join("only-a.txt"), "a\n").unwrap();
        assert!(!b.join("only-a.txt").exists(), "b cannot see a's work");
        assert_eq!(branch_of(&a).await, "ISS-3");
        assert_eq!(branch_of(&b).await, "ISS-4");
        let listed = list(&r).await.unwrap();
        assert_eq!(listed.len(), 2, "both are real worktrees to git");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_slash_in_the_branch_becomes_a_directory_name_not_a_directory() {
        let root = repo("slash").await;
        let r = root.to_string_lossy().to_string();
        let wt = create(&r, "feat/ISS-5", None).await.unwrap();
        assert!(wt.ends_with(".worktrees/feat-ISS-5"));
        assert_eq!(
            branch_of(&wt).await,
            "feat/ISS-5",
            "the BRANCH keeps its slash"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn git_names_the_repo_root_a_main_working_tree_and_its_worktrees_linked() {
        let root = repo("kind").await;
        let r = root.to_string_lossy().to_string();
        let linked = create(&r, "ISS-8", None).await.unwrap();

        assert_eq!(
            kind_at(&root).await,
            Kind::MainWorkingTree,
            "the repo root is the one path `git worktree remove` refuses by design"
        );
        assert_eq!(kind_at(&linked).await, Kind::Linked);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn where_a_worktree_sits_does_not_change_what_it_is() {
        let root = repo("kindnested").await;
        let nested = root.join(".claude/worktrees/ISS-9");
        std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
        run(
            &root,
            &["worktree", "add", &nested.to_string_lossy(), "-b", "ISS-9"],
        )
        .await;

        assert_eq!(
            kind_at(&nested).await,
            Kind::Linked,
            "a worktree nested INSIDE the repository is still a linked worktree — \
             the answer comes from git, not from the shape of the path"
        );
        assert_eq!(
            kind_at(&root).await,
            Kind::MainWorkingTree,
            "and the repository holding it is still the main working tree"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_answer_that_is_not_two_paths_identifies_nothing() {
        let wt = Path::new("/repo");
        assert_eq!(kind_of(wt, ""), Kind::Unknown, "no answer at all");
        assert_eq!(
            kind_of(wt, "/repo/.git\n"),
            Kind::Unknown,
            "one path cannot say whether it is the common dir or this tree's own"
        );
        assert_eq!(
            kind_of(wt, "/repo/.git\n/repo/.git\n"),
            Kind::MainWorkingTree
        );
        assert_eq!(
            kind_of(wt, "/repo/.git/worktrees/a\n/repo/.git\n"),
            Kind::Linked
        );
        assert_eq!(
            kind_of(wt, ".git\n.git\n"),
            Kind::MainWorkingTree,
            "git answers relatively in the main tree, and both sides resolve the same way"
        );
    }

    #[tokio::test]
    async fn a_directory_that_is_no_repository_is_named_as_such_and_an_absent_one_too() {
        let plain = std::env::temp_dir().join(format!(
            "forge-worktree-kind-plain-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&plain);
        std::fs::create_dir_all(&plain).unwrap();

        assert_eq!(kind_at(&plain).await, Kind::NotAWorktree);
        assert_eq!(kind_at(&plain.join("nope")).await, Kind::NotAWorktree);
        let _ = std::fs::remove_dir_all(&plain);
    }

    #[tokio::test]
    async fn the_ignore_line_is_written_once_not_once_per_job() {
        let root = repo("ignore").await;
        let r = root.to_string_lossy().to_string();
        create(&r, "ISS-6", None).await.unwrap();
        create(&r, "ISS-7", None).await.unwrap();
        let body = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert_eq!(
            body.lines().filter(|l| l.trim() == ".worktrees").count(),
            1,
            "a repeated append would grow a tracked file on every job"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
