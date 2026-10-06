//! `run brief <run id>` — the message a master dispatches a declared run with, generated rather than
//! typed: the facts a run cannot read for itself at the moment it starts, and nothing else.
//!
//! Every fact has one source. The run, its tree and its issues come from this box's ledger, which
//! `run declare` wrote; the base branch and the issues' ids from the project's core; what the other
//! trees hold from git, read now against `origin/<baseBranch>`. Never against `origin/HEAD`: that
//! records the remote's default, which on a project whose base is another branch reports every file
//! the two branches differ by as held (ISS-294, from the ISS-253 run that skipped its changelog).

use std::path::{Path, PathBuf};
use std::process::Command;

use runner_core::ledger::Ledger;
use runner_transport::CoreClient;
use serde_json::Value;

use crate::cmd::api::get_json;

/// The method a dispatched run reads, as `forge-runner api` takes the path.
pub const METHOD: &str = "forge-runner api guides/issue-flow.md";

/// One worktree as `git worktree list --porcelain` names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tree {
    pub path: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    /// git has it marked prunable: its directory is gone.
    pub prunable: bool,
}

/// What one other tree holds against the base, `None` for a reading git would not give — which is
/// not the same as empty, and is said as `not read`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    pub tree: Tree,
    pub keys: Vec<String>,
    pub committed: Option<Vec<String>>,
    pub uncommitted: Option<Vec<String>>,
}

/// Everything the brief says, read before a line of it is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    pub run_id: String,
    pub issues: Vec<(String, String)>,
    pub project_slug: String,
    pub project_id: String,
    pub base: String,
    pub base_sha: String,
    pub tree: Tree,
    pub others: Vec<Held>,
}

fn short(sha: &str) -> &str {
    sha.get(..9).unwrap_or(sha)
}

/// Who holds a tree, each fact under its own label: issue keys and a branch
/// in one unlabelled bracket read as one list (ISS-294's judge).
fn holder(h: &Held) -> String {
    let mut who = Vec::new();
    match h.keys.as_slice() {
        [] => {}
        [one] => who.push(format!("issue {one}")),
        many => who.push(format!("issues {}", many.join(", "))),
    }
    who.push(match &h.tree.branch {
        Some(b) => format!("branch {b}"),
        None => "detached HEAD".to_string(),
    });
    who.join(" · ")
}

fn held_line(h: &Held) -> String {
    let who = holder(h);
    if h.tree.prunable {
        return format!(
            "  {} ({who}): not read: the directory is gone",
            h.tree.path.display()
        );
    }
    let part = |label: &str, files: &Option<Vec<String>>| match files {
        None => Some(format!("{label}: not read")),
        Some(f) if f.is_empty() => None,
        Some(f) => Some(format!("{label}: {}", f.join(", "))),
    };
    let parts: Vec<String> = [
        part("committed", &h.committed),
        part("uncommitted", &h.uncommitted),
    ]
    .into_iter()
    .flatten()
    .collect();
    let said = if parts.is_empty() {
        "nothing held".to_string()
    } else {
        parts.join("; ")
    };
    format!("  {} ({who}): {said}", h.tree.path.display())
}

/// The brief's text. A pure function of the readings, so every line it can say is testable without
/// a box, a core or a repository.
pub fn compose(f: &Facts) -> String {
    let mut lines = Vec::new();
    for (key, id) in &f.issues {
        lines.push(format!("{key} · issue {id}"));
    }
    lines.push(format!("Project: {} · {}", f.project_slug, f.project_id));
    lines.push(format!("Run: {} (declared on this box)", f.run_id));
    lines.push(format!(
        "Tree: {} · branch {} · head {}",
        f.tree.path.display(),
        f.tree.branch.as_deref().unwrap_or("detached"),
        f.tree.head.as_deref().map(short).unwrap_or("none")
    ));
    lines.push(format!(
        "Base branch: {} (the project's baseBranch); held trees read against origin/{} at {}",
        f.base,
        f.base,
        short(&f.base_sha)
    ));
    if f.others.is_empty() {
        lines.push("Held by the other trees: there are no other trees in this checkout.".into());
    } else {
        lines.push(
            "Held by the other trees, read now — committed against the base, and uncommitted:"
                .into(),
        );
        lines.extend(f.others.iter().map(held_line));
    }
    lines.push(format!("Method: {METHOD}"));
    lines.join("\n")
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The trees `git worktree list --porcelain` prints, bare entries left out.
pub fn parse_worktrees(porcelain: &str) -> Vec<Tree> {
    porcelain
        .split("\n\n")
        .filter_map(|block| {
            let field = |name: &str| {
                block
                    .lines()
                    .find_map(|l| l.strip_prefix(name)?.strip_prefix(' ').map(str::to_string))
            };
            let has = |name: &str| {
                block
                    .lines()
                    .any(|l| l == name || l.starts_with(&format!("{name} ")))
            };
            let path = field("worktree")?;
            if has("bare") {
                return None;
            }
            Some(Tree {
                path: PathBuf::from(path),
                head: field("HEAD"),
                branch: field("branch").map(|b| b.trim_start_matches("refs/heads/").to_string()),
                prunable: has("prunable"),
            })
        })
        .collect()
}

/// `-z` output split into its paths. `status --porcelain -z --no-renames` prefixes each with two
/// status letters and a space; `diff --name-only -z` prints the path alone.
fn nul_paths(text: &str, status: bool) -> Vec<String> {
    text.split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| if status { s.get(3..).unwrap_or(s) } else { s }.to_string())
        .collect()
}

fn same_path(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b)
}

/// The run's own tree and what every other tree of its checkout holds against `origin/<base>`, or
/// the refusal naming what could not be read.
pub fn read_trees(
    worktree: &Path,
    base: &str,
    keys_of: &dyn Fn(&Path) -> Vec<String>,
) -> Result<(Tree, String, Vec<Held>), String> {
    let listed = git(worktree, &["worktree", "list", "--porcelain"]).ok_or_else(|| {
        format!(
            "{} is not a git checkout this box can read — the run was declared over a tree that is gone or was never one",
            worktree.display()
        )
    })?;
    let trees = parse_worktrees(&listed);
    let target = trees
        .iter()
        .find(|t| same_path(&t.path, worktree))
        .cloned()
        .ok_or_else(|| {
            format!(
                "git lists no worktree at {} — `git worktree list` names the ones this checkout has",
                worktree.display()
            )
        })?;
    let base_ref = format!("origin/{base}");
    let base_sha = git(
        worktree,
        &["rev-parse", "--verify", "--quiet", &format!("{base_ref}^{{commit}}")],
    )
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .ok_or_else(|| {
        format!(
            "{base_ref} is not a ref in this checkout, and the project's base branch is {base} — `git fetch origin {base}` and brief again; the held trees are never read against another branch"
        )
    })?;
    let range = format!("{base_ref}...HEAD");
    let others = trees
        .into_iter()
        .filter(|t| !same_path(&t.path, &target.path))
        .map(|tree| {
            let readable = !tree.prunable && tree.path.is_dir();
            let committed = readable
                .then(|| git(&tree.path, &["diff", "--name-only", "-z", &range]))
                .flatten()
                .map(|t| nul_paths(&t, false));
            let uncommitted = readable
                .then(|| git(&tree.path, &["status", "--porcelain", "-z", "--no-renames"]))
                .flatten()
                .map(|t| nul_paths(&t, true));
            Held {
                keys: keys_of(&tree.path),
                tree: Tree {
                    prunable: tree.prunable || !tree.path.is_dir(),
                    ..tree
                },
                committed,
                uncommitted,
            }
        })
        .collect();
    Ok((target, base_sha, others))
}

fn text_field(v: &Value, field: &str, path: &str) -> Result<String, String> {
    v.get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("GET {path} carries no `{field}`"))
}

/// The refusal for a run this box cannot brief, or the run with its project and issue keys.
pub fn declared(led: &Ledger, run_id: &str) -> anyhow::Result<(PathBuf, String, Vec<String>)> {
    let Some(run) = led.run(run_id)? else {
        anyhow::bail!(
            "no run {run_id} on this box — a brief is for a run `forge-runner run declare` answered; declare the run first, then brief the id it prints"
        );
    };
    if let Some(by) = &run.ended_by {
        anyhow::bail!(
            "run {run_id} has ended (by {by}: {}) — a brief is for a run about to be dispatched; declare a new one",
            run.ended_reason.as_deref().unwrap_or("no reason recorded")
        );
    }
    let Some(project_id) = run.project_id.clone() else {
        anyhow::bail!("run {run_id} records no project, so there is no base branch to read for it");
    };
    let keys = led
        .issues(run_id)?
        .into_iter()
        .map(|m| m.issue_key)
        .collect();
    Ok((run.worktree_path, project_id, keys))
}

pub async fn brief(client: &CoreClient, run_id: &str) -> anyhow::Result<String> {
    let led = Ledger::open_read_only(&Ledger::default_path()?)?;
    let run_id = &super::full_id(&led, run_id)?;
    let (worktree, project_id, keys) = declared(&led, run_id)?;

    let project_path = format!("/api/projects/{project_id}");
    let project = get_json(client, &project_path)
        .await
        .map_err(anyhow::Error::msg)?;
    let base = text_field(&project, "baseBranch", &project_path).map_err(anyhow::Error::msg)?;
    let project_slug = text_field(&project, "slug", &project_path).map_err(anyhow::Error::msg)?;

    let mut issues = Vec::new();
    for key in keys {
        let path = format!("/api/issues/{key}?projectId={project_id}");
        let issue = get_json(client, &path).await.map_err(anyhow::Error::msg)?;
        issues.push((
            key,
            text_field(&issue, "id", &path).map_err(anyhow::Error::msg)?,
        ));
    }

    let open_runs = led.unclosed_runs()?;
    let keys_of = |path: &Path| -> Vec<String> {
        open_runs
            .iter()
            .filter(|r| r.ended_by.is_none() && same_path(&r.worktree_path, path))
            .flat_map(|r| led.issues(&r.run_id).unwrap_or_default())
            .map(|m| m.issue_key)
            .collect()
    };
    let (tree, base_sha, others) =
        read_trees(&worktree, &base, &keys_of).map_err(anyhow::Error::msg)?;

    Ok(compose(&Facts {
        run_id: run_id.to_string(),
        issues,
        project_slug,
        project_id,
        base,
        base_sha,
        tree,
        others,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(path: &str, branch: Option<&str>) -> Tree {
        Tree {
            path: path.into(),
            head: Some("1aae01978374e30b3c35f799789b4441a9798a78".into()),
            branch: branch.map(str::to_string),
            prunable: false,
        }
    }

    #[test]
    fn porcelain_names_each_tree_its_branch_and_whether_it_is_gone() {
        let listed = "worktree /r\nHEAD aaa\nbranch refs/heads/dev\n\n\
                      worktree /r/.claude/worktrees/ISS-1\nHEAD bbb\nbranch refs/heads/dev-ISS-1\n\n\
                      worktree /r/.claude/worktrees/ISS-2\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location\n\n\
                      worktree /bare.git\nbare\n";
        let trees = parse_worktrees(listed);
        assert_eq!(trees.len(), 3, "{trees:?}");
        assert_eq!(trees[0].branch.as_deref(), Some("dev"));
        assert_eq!(trees[1].branch.as_deref(), Some("dev-ISS-1"));
        assert_eq!(
            (trees[2].branch.as_deref(), trees[2].prunable),
            (None, true)
        );
    }

    #[test]
    fn the_brief_says_every_fact_and_the_method() {
        let text = compose(&Facts {
            run_id: "70d69d6e".into(),
            issues: vec![("ISS-294".into(), "6d86898e".into())],
            project_slug: "forge".into(),
            project_id: "d1bb4907".into(),
            base: "dev".into(),
            base_sha: "1aae01978374e30b3c35f799789b4441a9798a78".into(),
            tree: tree("/r/.claude/worktrees/ISS-294", Some("dev-ISS-294")),
            others: vec![
                Held {
                    tree: tree("/r", Some("dev")),
                    keys: vec![],
                    committed: Some(vec![]),
                    uncommitted: Some(vec![]),
                },
                Held {
                    tree: tree("/r/.claude/worktrees/ISS-280", Some("dev-ISS-280")),
                    keys: vec!["ISS-280".into()],
                    committed: Some(vec!["a.rs".into(), "b.rs".into()]),
                    uncommitted: None,
                },
                Held {
                    tree: tree("/r/.claude/worktrees/ISS-261", None),
                    keys: vec!["ISS-261".into(), "ISS-262".into()],
                    committed: Some(vec![]),
                    uncommitted: Some(vec![]),
                },
            ],
        });
        for want in [
            "ISS-294 · issue 6d86898e",
            "Project: forge · d1bb4907",
            "Run: 70d69d6e",
            "Tree: /r/.claude/worktrees/ISS-294 · branch dev-ISS-294 · head 1aae01978",
            "Base branch: dev (the project's baseBranch); held trees read against origin/dev at 1aae01978",
            "  /r (branch dev): nothing held",
            "  /r/.claude/worktrees/ISS-280 (issue ISS-280 · branch dev-ISS-280): committed: a.rs, b.rs; uncommitted: not read",
            "  /r/.claude/worktrees/ISS-261 (issues ISS-261, ISS-262 · detached HEAD): nothing held",
            "Method: forge-runner api guides/issue-flow.md",
        ] {
            assert!(text.contains(want), "missing `{want}` in:\n{text}");
        }
    }

    /// A scratch repository whose base branch (`dev`) is ahead of the remote's default (`main`), with
    /// one more tree holding a committed and an uncommitted file.
    fn scratch_repo() -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("forge-brief-{}-{stamp}", std::process::id()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |dir: &Path, args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args([
                    "-c",
                    "user.email=t@t",
                    "-c",
                    "user.name=t",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&repo, &["init", "-q", "-b", "dev"]);
        std::fs::write(repo.join("base.txt"), "base").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-qm", "base"]);
        // origin/main is the remote's default and lags dev by one landed commit, the shape this
        // checkout has: a reading against it names `landed.txt` as held by every tree.
        run(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run(
            &repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        std::fs::write(repo.join("landed.txt"), "l").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-qm", "landed"]);
        run(&repo, &["update-ref", "refs/remotes/origin/dev", "HEAD"]);
        let one = root.join("one");
        let two = root.join("two");
        run(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "dev-one",
                one.to_str().unwrap(),
                "dev",
            ],
        );
        run(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "dev-two",
                two.to_str().unwrap(),
                "dev",
            ],
        );
        std::fs::write(two.join("committed.rs"), "c").unwrap();
        run(&two, &["add", "."]);
        run(&two, &["commit", "-qm", "work"]);
        std::fs::write(two.join("open file.rs"), "u").unwrap();
        root
    }

    #[test]
    fn other_trees_are_read_against_the_projects_base_and_never_origin_head() {
        let root = scratch_repo();
        let none = |_: &Path| Vec::new();
        let (target, base_sha, others) = read_trees(&root.join("one"), "dev", &none).unwrap();
        assert_eq!(target.branch.as_deref(), Some("dev-one"));
        assert_eq!(base_sha.len(), 40);
        let two = others
            .iter()
            .find(|h| h.tree.branch.as_deref() == Some("dev-two"))
            .expect("the other tree is listed");
        assert_eq!(two.committed, Some(vec!["committed.rs".to_string()]));
        assert_eq!(two.uncommitted, Some(vec!["open file.rs".to_string()]));
        let main = others
            .iter()
            .find(|h| h.tree.branch.as_deref() == Some("dev"))
            .expect("the checkout's own tree is listed");
        assert_eq!(main.committed, Some(vec![]), "{main:?}");
        assert!(others
            .iter()
            .all(|h| h.tree.branch.as_deref() != Some("dev-one")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_base_with_no_remote_ref_is_refused_by_name() {
        let root = scratch_repo();
        let none = |_: &Path| Vec::new();
        let why = read_trees(&root.join("one"), "release", &none).unwrap_err();
        assert!(why.contains("origin/release is not a ref"), "{why}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_run_this_box_never_declared_or_already_ended_is_refused_naming_it() {
        let dir = std::env::temp_dir().join(format!("forge-brief-ledger-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut led = Ledger::open(&dir.join("ledger.sqlite")).unwrap();
        let why = declared(&led, "no-such-run").unwrap_err().to_string();
        assert!(why.contains("no run no-such-run on this box"), "{why}");

        let run = led
            .create_run_group(runner_core::ledger::NewRun {
                run_id: "run-1".into(),
                project_id: "p-1".into(),
                master_session_id: "m".into(),
                worktree_path: "/r/one".into(),
                boot_id: "b".into(),
                issue_keys: vec!["ISS-9".into()],
            })
            .unwrap();
        let (path, project, keys) = declared(&led, &run.run_id).unwrap();
        assert_eq!(
            (path, project.as_str(), keys),
            ("/r/one".into(), "p-1", vec!["ISS-9".to_string()])
        );

        led.end_run("run-1", "master", "landed").unwrap();
        let why = declared(&led, "run-1").unwrap_err().to_string();
        assert!(
            why.contains("run run-1 has ended (by master: landed)"),
            "{why}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
