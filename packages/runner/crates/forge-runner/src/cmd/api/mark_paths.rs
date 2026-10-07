//! The paths a merge mark's commit changed, read from this box's checkout and sent with the mark.
//!
//! A project whose source host Forge cannot read has no way for core to learn what a landing
//! changed, and its release then reads every issue as unclassified. The box holds the checkout, so
//! when `forge-runner api` carries a mark (`POST issues/<id>/merge`) naming a `commit` this checkout
//! holds, it adds `changedPaths`: `git diff --name-status <first parent> <commit>`, paths and what
//! became of each, never content. Core classifies them by the project's `surfaces` map and labels
//! them box-read (`packages/core/src/issues/landing-evidence.ts:markReadPaths`).

use std::path::Path;
use std::process::Command;

use serde_json::{json, Value};

/// At most this many files go with one mark; core refuses more (`CHANGED_PATHS_MAX`).
const CHANGED_PATHS_MAX: usize = 2000;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Attach {
    /// Not a mark naming a commit, or one that already carries paths: the body goes as written.
    Untouched,
    /// The body with `changedPaths` added.
    Sent(String),
    /// A mark the paths could not be read for, and the line saying why; the body goes as written.
    Skipped(String),
}

/// Whether `method path` is the merge mark: `POST issues/<id>/merge`, spelled any way `api` takes.
fn is_merge_mark(method: &str, path: &str) -> bool {
    if !method.eq_ignore_ascii_case("POST") {
        return false;
    }
    let path = path.split(['?', '#']).next().unwrap_or("");
    let path = path.trim_start_matches('/');
    let path = path.strip_prefix("api/").unwrap_or(path);
    let segments: Vec<&str> = path.trim_end_matches('/').split('/').collect();
    matches!(segments.as_slice(), ["issues", id, "merge"] if !id.is_empty())
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("git could not be run: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// One `--name-status` line as the files it names and what became of each.
fn changes_of_line(line: &str) -> Vec<Value> {
    let mut parts = line.split('\t');
    let status = parts.next().unwrap_or("");
    let paths: Vec<&str> = parts.collect();
    let entry = |path: &str, change: &str| json!({ "path": path, "change": change });
    match (status.chars().next(), paths.as_slice()) {
        (Some('R'), [from, to]) => vec![entry(from, "removed"), entry(to, "added")],
        (Some('C'), [_, to]) => vec![entry(to, "added")],
        (Some('A'), [path]) => vec![entry(path, "added")],
        (Some('D'), [path]) => vec![entry(path, "removed")],
        (Some(_), [path]) => vec![entry(path, "changed")],
        _ => vec![],
    }
}

/// The full sha and the files `commit` changed against its first parent, read from `repo`.
pub(crate) fn changed_paths(repo: &Path, commit: &str) -> Result<(String, Vec<Value>), String> {
    let sha = git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{commit}^{{commit}}"),
        ],
    )
    .map_err(|_| {
        format!(
            "commit {commit} is not in this checkout ({})",
            repo.display()
        )
    })?
    .trim()
    .to_string();
    let parent = git(
        repo,
        &["rev-parse", "--verify", "--quiet", &format!("{sha}^1")],
    )
    .ok();
    let listing = match parent.as_deref().map(str::trim) {
        Some(parent) => git(
            repo,
            &["diff", "--no-color", "--name-status", "-M", parent, &sha],
        )?,
        None => git(
            repo,
            &[
                "diff-tree",
                "--root",
                "-r",
                "--no-commit-id",
                "--name-status",
                "-M",
                &sha,
            ],
        )?,
    };
    let changes: Vec<Value> = listing
        .lines()
        .filter(|l| !l.trim().is_empty())
        .flat_map(changes_of_line)
        .collect();
    Ok((sha, changes))
}

/// The mark body with the paths its commit changed, where this is a mark this checkout can read.
pub(crate) fn attach(method: &str, path: &str, body: &str, repo: &Path) -> Attach {
    if !is_merge_mark(method, path) {
        return Attach::Untouched;
    }
    let Ok(Value::Object(mut object)) = serde_json::from_str::<Value>(body) else {
        return Attach::Untouched;
    };
    if object.contains_key("changedPaths") {
        return Attach::Untouched;
    }
    let Some(commit) = object
        .get("commit")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return Attach::Untouched;
    };
    let (sha, changes) = match changed_paths(repo, &commit) {
        Ok(read) => read,
        Err(why) => {
            return Attach::Skipped(format!(
                "note: the mark carries no changed paths, so its release reads them unclassified unless Forge observes the merge: {why}"
            ))
        }
    };
    if changes.len() > CHANGED_PATHS_MAX {
        return Attach::Skipped(format!(
            "note: the mark carries no changed paths: commit {sha} changed {} files, and a mark carries at most {CHANGED_PATHS_MAX}",
            changes.len()
        ));
    }
    object.insert(
        "changedPaths".to_string(),
        json!({ "commit": sha, "changes": changes }),
    );
    Attach::Sent(Value::Object(object).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn run(dir: &Path, args: &[&str]) -> String {
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
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repository whose second commit adds, changes, removes and renames one file each.
    fn scratch_repo() -> (PathBuf, String) {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let repo =
            std::env::temp_dir().join(format!("forge-mark-paths-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(repo.join("web")).unwrap();
        run(&repo, &["init", "-q", "-b", "dev"]);
        std::fs::write(repo.join("web/page.tsx"), "one").unwrap();
        std::fs::write(repo.join("old.sql"), "drop me").unwrap();
        std::fs::write(
            repo.join("moved-from.txt"),
            "a long enough body to be seen as a rename\n",
        )
        .unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-qm", "base"]);
        std::fs::write(repo.join("web/page.tsx"), "two").unwrap();
        std::fs::write(repo.join("new.sql"), "create").unwrap();
        std::fs::remove_file(repo.join("old.sql")).unwrap();
        run(&repo, &["mv", "moved-from.txt", "moved-to.txt"]);
        run(&repo, &["add", "-A"]);
        run(&repo, &["commit", "-qm", "ISS-7 the change"]);
        let sha = run(&repo, &["rev-parse", "HEAD"]);
        (repo, sha)
    }

    #[test]
    fn a_mark_naming_a_commit_in_the_checkout_carries_the_paths_it_changed() {
        let (repo, sha) = scratch_repo();
        let body = json!({ "target": "dev", "commit": &sha[..12] }).to_string();
        let Attach::Sent(sent) = attach("POST", "/api/issues/abc/merge", &body, &repo) else {
            panic!("the mark went without its paths");
        };
        let sent: Value = serde_json::from_str(&sent).unwrap();
        assert_eq!(sent["target"], "dev");
        assert_eq!(sent["commit"], &sha[..12]);
        assert_eq!(sent["changedPaths"]["commit"], sha.as_str());
        let mut changes: Vec<(String, String)> = sent["changedPaths"]["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c["path"].as_str().unwrap().to_string(),
                    c["change"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        changes.sort();
        assert_eq!(
            changes,
            [
                ("moved-from.txt", "removed"),
                ("moved-to.txt", "added"),
                ("new.sql", "added"),
                ("old.sql", "removed"),
                ("web/page.tsx", "changed"),
            ]
            .map(|(p, c)| (p.to_string(), c.to_string()))
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_commit_the_checkout_does_not_hold_leaves_the_body_as_written_and_says_why() {
        let (repo, _) = scratch_repo();
        let body = json!({ "target": "dev", "commit": "0123456789abcdef" }).to_string();
        let Attach::Skipped(why) = attach("POST", "issues/abc/merge", &body, &repo) else {
            panic!("an unread commit was not said");
        };
        assert!(
            why.contains("0123456789abcdef") && why.contains("not in this checkout"),
            "{why}"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn only_a_mark_naming_a_commit_is_touched() {
        let repo = std::env::temp_dir();
        let with_commit = json!({ "commit": "abc1234" }).to_string();
        for (method, path, body) in [
            ("GET", "issues/abc/merge", with_commit.as_str()),
            ("DELETE", "issues/abc/merge", with_commit.as_str()),
            ("POST", "issues/abc/comments", with_commit.as_str()),
            ("POST", "issues/abc/merge", r#"{"target":"dev"}"#),
            (
                "POST",
                "issues/abc/merge",
                r#"{"commit":"abc1234","changedPaths":{"commit":"abc1234","changes":[]}}"#,
            ),
        ] {
            assert_eq!(
                attach(method, path, body, &repo),
                Attach::Untouched,
                "{method} {path} {body}"
            );
        }
    }
}
