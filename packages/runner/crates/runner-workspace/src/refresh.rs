//! Bring a provisioned workspace up to date before an agent reads it.
//!
//! Provisioning clones once and nothing refreshed the folder afterwards, so
//! every lane inherited whatever HEAD it was left at. Measured on agent session
//! 228cdf03 (ceo-dashboard): the checkout predated by 2.5h the merge it was
//! later asked about, it then idled 28h, and its answer had 6 of 7 claims wrong.
//!
//! A bare `git fetch` does NOT fix that: it moves remote-tracking refs while the
//! working tree stays old, and an agent that reads files is still wrong. So this
//! fast-forwards the tree, and reports what it actually ended up on.

use std::path::Path;
use std::time::Duration;

use runner_platform::git::{git, git_line};
use tokio::process::Command;

/// Cap for the network hop: a slow remote must not hold a job or a chat turn
/// open indefinitely. It matched `daemon::preflight`'s `ls-remote` budget until
/// ISS-1047 deleted that module — nothing called it — so this 20s is now the
/// only statement of the budget rather than the second copy of one.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

const FORGE_OWNED_PATHS: [&str; 3] = [".forge/orientation.md", "CLAUDE.md", ".gitignore"];

/// What the workspace was sitting on when the agent got it. Recorded even when
/// the refresh could not run — an unrefreshed workspace that says so is
/// auditable; one that says nothing is the defect this module exists for.
#[derive(Debug, Clone, Default)]
pub struct WorkspaceGit {
    pub head_sha: Option<String>,
    pub base_branch: Option<String>,
    /// Resolved `origin/<base>` after the fetch.
    pub base_sha: Option<String>,
    pub refreshed: bool,
    /// Why the refresh did not happen. `None` when it did.
    pub detail: Option<String>,
    /// The refresh backed off because the tree carried uncommitted work that is
    /// not Forge's. Distinct from every other `!refreshed` reason: nothing is
    /// broken here and there is nothing to repair.
    pub foreign_work: bool,
}

fn stderr_brief(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr)
        .trim()
        .chars()
        .take(300)
        .collect()
}

/// Dirty tracked paths, excluding the ones Forge owns. Empty means the tree
/// carries no work of anyone else's.
async fn foreign_dirty_paths(repo: &Path) -> Vec<String> {
    let Some(out) = git(repo, &["status", "--porcelain", "--untracked-files=no"]).await else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            // porcelain v1: XY<space>path — take everything past the status pair.
            let path = line.get(3..)?.trim();
            if path.is_empty() || FORGE_OWNED_PATHS.contains(&path) {
                None
            } else {
                Some(path.to_string())
            }
        })
        .collect()
}

/// What the working tree holds at one Forge-owned path.
enum Change {
    Clean,
    /// Only what an older runner wrote there: reverting it loses nothing of anyone's.
    Forges,
    /// Somebody's own change, or one this cannot tell from it; why, for the log.
    Kept(String),
}

/// Whether the change at `path` is wholly one Forge used to make. Anything
/// else is left in place, and the fast-forward refuses over it as git would.
async fn forge_own_change(repo: &Path, path: &str) -> Change {
    let dirty = git_line(
        repo,
        &["status", "--porcelain", "--untracked-files=no", "--", path],
    )
    .await;
    if dirty.is_none() {
        return Change::Clean;
    }
    let Some(head) = git(repo, &["show", &format!("HEAD:{path}")])
        .await
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    else {
        return Change::Kept("HEAD holds no copy of it to compare against".into());
    };
    let Ok(work) = std::fs::read_to_string(repo.join(path)) else {
        return Change::Kept("the working copy is missing or unreadable".into());
    };
    let forges = match path {
        "CLAUDE.md" => crate::orientation::without_import_block(&work) == Some(head.as_str()),
        ".forge/orientation.md" => crate::orientation::is_generated(&work) && work != head,
        ".gitignore" => work.strip_prefix(head.as_str()).is_some_and(|added| {
            added.lines().any(|l| l.trim() == ".worktrees")
                && added
                    .lines()
                    .all(|l| l.trim().is_empty() || l.trim() == ".worktrees")
        }),
        _ => false,
    };
    if forges {
        Change::Forges
    } else {
        Change::Kept(match path {
            "CLAUDE.md" => "it differs from HEAD by more than the forge:orientation block an older runner prepended".into(),
            ".forge/orientation.md" => "the working copy is not an orientation Forge generated".into(),
            ".gitignore" => "it adds lines other than the `.worktrees` an older runner appended".into(),
            other => format!("{other} is not a path whose Forge change this can recognise"),
        })
    }
}

/// Fetch `origin` and fast-forward `base_branch` (or the currently checked-out
/// branch when no base is known), then report the resulting git identity.
///
/// Never panics and never returns `Err`: a workspace that could not be
/// refreshed is a fact the caller must act on, not an error to unwrap. Callers
/// decide the policy — both lanes now run and tell the agent what it is looking
/// at; the pipeline lane additionally tells it to fix the checkout, which it is
/// the only lane in a position to do.
pub async fn refresh(repo_path: &Path, base_branch: Option<&str>) -> WorkspaceGit {
    let mut state = WorkspaceGit::default();

    if git_line(repo_path, &["rev-parse", "--is-inside-work-tree"])
        .await
        .as_deref()
        != Some("true")
    {
        state.detail = Some("not a git work tree".into());
        return state;
    }

    state.head_sha = git_line(repo_path, &["rev-parse", "HEAD"]).await;
    let current = git_line(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
    let base = base_branch
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| current.clone().filter(|b| b != "HEAD"));
    let Some(base) = base else {
        state.detail = Some("no base branch resolvable (detached HEAD, no configured base)".into());
        return state;
    };
    state.base_branch = Some(base.clone());

    let mut fetch = Command::new("git");
    runner_platform::git::non_interactive(
        fetch
            .args(["-C"])
            .arg(repo_path)
            .args(["fetch", "origin", &base]),
    );
    let fetch = fetch.output();
    match tokio::time::timeout(FETCH_TIMEOUT, fetch).await {
        Err(_) => {
            state.detail = Some(format!(
                "fetch timed out after {}s",
                FETCH_TIMEOUT.as_secs()
            ));
            return state;
        }
        Ok(Err(e)) => {
            state.detail = Some(format!("fetch could not run: {e}"));
            return state;
        }
        Ok(Ok(out)) if !out.status.success() => {
            state.detail = Some(format!("fetch failed: {}", stderr_brief(&out)));
            return state;
        }
        Ok(Ok(_)) => {}
    }

    state.base_sha = git_line(repo_path, &["rev-parse", &format!("origin/{base}")]).await;

    // A worktree-less stage runs in the repo root, so the tree must actually be
    // on the base branch for a fast-forward to mean anything.
    if current.as_deref() != Some(base.as_str()) {
        state.detail = Some(format!(
            "checked out {} , not the base branch {base} — left alone",
            current.as_deref().unwrap_or("an unknown ref")
        ));
        return state;
    }

    let foreign = foreign_dirty_paths(repo_path).await;
    if !foreign.is_empty() {
        state.foreign_work = true;
        state.detail = Some(format!(
            "tree has uncommitted changes outside the Forge-owned paths ({}) — left alone",
            foreign.join(", ").chars().take(200).collect::<String>()
        ));
        return state;
    }
    for path in FORGE_OWNED_PATHS {
        match forge_own_change(repo_path, path).await {
            Change::Clean => {}
            Change::Forges => {
                let _ = git(repo_path, &["checkout", "--", path]).await;
            }
            Change::Kept(why) => tracing::warn!(
                "[refresh] {}: kept {path} as it stands, not reverted: {why}",
                repo_path.display()
            ),
        }
    }

    match git(
        repo_path,
        &["merge", "--ff-only", &format!("origin/{base}")],
    )
    .await
    {
        Some(out) if out.status.success() => {
            state.refreshed = true;
            state.head_sha = git_line(repo_path, &["rev-parse", "HEAD"]).await;
        }
        Some(out) => {
            state.detail = Some(format!("fast-forward refused: {}", stderr_brief(&out)));
        }
        None => {
            state.detail = Some("fast-forward could not run".into());
        }
    }
    state
}

/// One line for a prompt or a log: what the agent is actually looking at.
pub fn describe(state: &WorkspaceGit) -> String {
    let head = state.head_sha.as_deref().unwrap_or("unknown");
    let base = state.base_branch.as_deref().unwrap_or("unknown");
    let base_sha = state.base_sha.as_deref().unwrap_or("unknown");
    let short = |s: &str| s.chars().take(8).collect::<String>();
    if state.refreshed {
        format!("workspace refreshed: HEAD {} on {base}", short(head))
    } else {
        format!(
            "workspace NOT refreshed ({}): HEAD {}, origin/{base} {}",
            state.detail.as_deref().unwrap_or("no reason recorded"),
            short(head),
            short(base_sha)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    const OLD_BLOCK: &str = "<!-- forge:orientation -->\n<!-- Forge-managed pointer (fixed). Project orientation lives in .forge/orientation.md. -->\n@.forge/orientation.md\n<!-- /forge:orientation -->\n";

    fn run(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.email=t@example.invalid", "-c", "user.name=t"])
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A checkout of a local bare origin on `dev`, where origin is one unrelated commit ahead.
    fn checkout_with(files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("forge-refresh-{}", uuid::Uuid::new_v4()));
        let seed = root.join("seed");
        std::fs::create_dir_all(&seed).unwrap();
        run(&seed, &["init", "-q", "-b", "dev"]);
        for (path, body) in files {
            let at = seed.join(path);
            std::fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::fs::write(at, body).unwrap();
            run(&seed, &["add", "--", path]);
        }
        run(&seed, &["commit", "-q", "-m", "one"]);
        let bare = root.join("origin.git");
        run(
            &root,
            &[
                "clone",
                "-q",
                "--bare",
                seed.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
        );
        let checkout = root.join("checkout");
        run(
            &root,
            &[
                "clone",
                "-q",
                bare.to_str().unwrap(),
                checkout.to_str().unwrap(),
            ],
        );
        std::fs::write(seed.join("upstream.txt"), "ahead").unwrap();
        run(&seed, &["add", "upstream.txt"]);
        run(&seed, &["commit", "-q", "-m", "two"]);
        run(&seed, &["push", "-q", bare.to_str().unwrap(), "dev"]);
        checkout
    }

    fn read(repo: &Path, path: &str) -> String {
        std::fs::read_to_string(repo.join(path)).unwrap()
    }

    #[tokio::test]
    async fn an_older_runners_import_block_alone_is_reverted() {
        let claude = "# Catalog API\n";
        let repo = checkout_with(&[("CLAUDE.md", claude)]);
        std::fs::write(repo.join("CLAUDE.md"), format!("{OLD_BLOCK}\n{claude}")).unwrap();
        let state = refresh(&repo, Some("dev")).await;
        assert!(state.refreshed, "{state:?}");
        assert_eq!(read(&repo, "CLAUDE.md"), claude);
    }

    #[tokio::test]
    async fn a_persons_edit_to_claude_md_is_kept_byte_identical() {
        let claude = "# Catalog API\n";
        for edited in [
            format!("{claude}\nA rule a person wrote.\n"),
            format!("{OLD_BLOCK}\n{claude}\nA rule a person wrote.\n"),
            format!("@.forge/orientation.md\n{claude}"),
        ] {
            let repo = checkout_with(&[("CLAUDE.md", claude)]);
            std::fs::write(repo.join("CLAUDE.md"), &edited).unwrap();
            let _ = refresh(&repo, Some("dev")).await;
            assert_eq!(read(&repo, "CLAUDE.md"), edited);
        }
    }

    #[tokio::test]
    async fn a_generated_orientation_over_a_committed_one_is_reverted_and_an_edited_one_kept() {
        let committed = crate::orientation::orientation_body("prod", "epodsystem-core");
        let repo = checkout_with(&[(".forge/orientation.md", &committed)]);
        std::fs::write(
            repo.join(".forge/orientation.md"),
            crate::orientation::orientation_body("dev", "epod"),
        )
        .unwrap();
        assert!(refresh(&repo, Some("dev")).await.refreshed);
        assert_eq!(read(&repo, ".forge/orientation.md"), committed);

        let repo = checkout_with(&[(".forge/orientation.md", "# Our own notes\n")]);
        std::fs::write(
            repo.join(".forge/orientation.md"),
            "# Our own notes, edited\n",
        )
        .unwrap();
        let _ = refresh(&repo, Some("dev")).await;
        assert_eq!(
            read(&repo, ".forge/orientation.md"),
            "# Our own notes, edited\n"
        );
    }

    #[tokio::test]
    async fn only_the_worktrees_line_forge_added_to_gitignore_is_reverted() {
        let ignore = "node_modules\n";
        let repo = checkout_with(&[(".gitignore", ignore)]);
        std::fs::write(repo.join(".gitignore"), format!("{ignore}.worktrees\n")).unwrap();
        assert!(refresh(&repo, Some("dev")).await.refreshed);
        assert_eq!(read(&repo, ".gitignore"), ignore);

        let repo = checkout_with(&[(".gitignore", ignore)]);
        let edited = format!("{ignore}.worktrees\ndist\n");
        std::fs::write(repo.join(".gitignore"), &edited).unwrap();
        let _ = refresh(&repo, Some("dev")).await;
        assert_eq!(read(&repo, ".gitignore"), edited);
    }
}
