//! `forge-runner release range` — the run that cut a release reports what its commit range
//! ships, from the checkout it cut it in (REQ-40 BC-7, BC-9).
//!
//! Thin by design: core says where the range starts and which changed files it reads
//! (`release-batch/shipped-range.ts:rangeReads`); this box only names the files `git` says changed
//! and sends those files' text at both ends. Every decision about what a migration, an API contract,
//! a dependency or a setting is stays in core's one reader, so a project with no source host binding
//! reads its release the same way as one with one.

use std::path::{Path, PathBuf};
use std::process::Command;

use clap::{Args as ClapArgs, Subcommand};
use runner_transport::CoreClient;
use serde_json::{json, Value};

use super::api::{get_json, rest_client};
use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub cmd: ReleaseCommand,
}

#[derive(Subcommand)]
pub enum ReleaseCommand {
    /// Report what this release's commit range ships, read from this checkout, before `finish`.
    Range(RangeArgs),
}

#[derive(ClapArgs)]
pub struct RangeArgs {
    /// The project's id, as the release run's task prompt names it.
    #[arg(long = "project-id")]
    pub project_id: String,
    /// The release run's id.
    #[arg(long)]
    pub run: String,
    /// The commit this release deploys: the one `finish` will name.
    #[arg(long)]
    pub head: String,
    /// The checkout to read; the current directory when left out.
    #[arg(long)]
    pub repo: Option<PathBuf>,
}

/// One file the range changed, as core reads it; a rename is its old path removed and its new one added.
#[derive(Debug, PartialEq, Eq)]
pub struct Change {
    pub path: String,
    pub change: &'static str,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let ReleaseCommand::Range(a) = args.cmd;
    let client = match rest_client(&ctx)? {
        Ok(c) => c,
        Err(why) => anyhow::bail!("{why}"),
    };
    let repo = match a.repo {
        Some(r) => r,
        None => std::env::current_dir()?,
    };
    let at = format!(
        "/api/projects/{}/release-batches/{}/range",
        a.project_id, a.run
    );
    let start = get_json(&client, &at).await.map_err(anyhow::Error::msg)?;
    let Some(base) = start.get("base").and_then(Value::as_str) else {
        let why = start
            .get("why")
            .and_then(Value::as_str)
            .unwrap_or("core named none");
        println!("nothing to report: {why}");
        return Ok(());
    };
    let head = full_commit(&repo, &a.head)?;
    let base = full_commit(&repo, base)?;
    let changes = changes_between(&repo, &base, &head)?;
    let listed: Vec<Value> = changes
        .iter()
        .map(|c| json!({ "path": c.path, "change": c.change }))
        .collect();
    let reads = post_json(
        &client,
        &format!("{at}/reads"),
        &json!({ "changes": listed }),
    )
    .await?;
    let paths: Vec<String> = reads
        .get("reads")
        .and_then(Value::as_array)
        .map(|r| {
            r.iter()
                .filter_map(|p| p.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let files = files_at(&repo, &base, &head, &paths)?;
    let report = json!({ "base": base, "head": head, "changes": listed, "files": files });
    let reading = post_json(&client, &at, &report).await?;
    println!("{}", serde_json::to_string_pretty(&reading)?);
    Ok(())
}

/// One POST to core, answered as JSON; a refusal is the error, its body said whole.
async fn post_json(client: &CoreClient, path: &str, body: &Value) -> anyhow::Result<Value> {
    let resp = client
        .post(path)
        .json(body)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("POST {path}: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("POST {path} answered {status}: {}", text.trim());
    }
    serde_json::from_str(&text).map_err(|e| anyhow::anyhow!("POST {path} answered no JSON: {e}"))
}

fn git(repo: &Path, args: &[&str]) -> anyhow::Result<std::process::Output> {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| anyhow::anyhow!("git {}: {e}", args.join(" ")))
}

/// `rev` as the full commit this checkout holds, or the refusal naming what to fetch.
pub fn full_commit(repo: &Path, rev: &str) -> anyhow::Result<String> {
    let out = git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
    )?;
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || sha.len() != 40 {
        anyhow::bail!(
            "{rev} is not a commit in {}: fetch it (`git fetch origin`) and report again",
            repo.display()
        );
    }
    Ok(sha)
}

/// Every file `base...head` changed (from their merge base, as a compare reads it), renames split.
pub fn changes_between(repo: &Path, base: &str, head: &str) -> anyhow::Result<Vec<Change>> {
    let range = format!("{base}...{head}");
    let out = git(
        repo,
        &["diff", "--no-renames", "--name-status", "-z", &range],
    )?;
    if !out.status.success() {
        anyhow::bail!(
            "git diff {range} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    parse_name_status(&String::from_utf8_lossy(&out.stdout))
}

/// `git diff --name-status -z`: a status, then its path, each ended by NUL.
pub fn parse_name_status(text: &str) -> anyhow::Result<Vec<Change>> {
    let mut fields = text.split('\0').filter(|f| !f.is_empty());
    let mut out = Vec::new();
    while let Some(status) = fields.next() {
        let Some(path) = fields.next() else {
            anyhow::bail!("git diff named the status {status} with no path after it");
        };
        let change = match status.chars().next() {
            Some('A') => "added",
            Some('D') => "removed",
            Some('M' | 'T') => "changed",
            _ => anyhow::bail!("git diff named {path} with the status {status}, which a range report does not carry"),
        };
        out.push(Change {
            path: path.to_string(),
            change,
        });
    }
    Ok(out)
}

/// The text of `path` at `rev`, or `None` where it does not exist there.
pub fn text_at(repo: &Path, rev: &str, path: &str) -> anyhow::Result<Option<String>> {
    let spec = format!("{rev}:{path}");
    if !git(repo, &["cat-file", "-e", &spec])?.status.success() {
        return Ok(None);
    }
    let out = git(repo, &["show", &spec])?;
    if !out.status.success() {
        anyhow::bail!(
            "git show {spec} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    String::from_utf8(out.stdout)
        .map(Some)
        .map_err(|_| anyhow::anyhow!("{path} at {rev} is not UTF-8 text, so core cannot read it"))
}

/// Each path core reads, with its text at `base` and at `head`.
pub fn files_at(
    repo: &Path,
    base: &str,
    head: &str,
    paths: &[String],
) -> anyhow::Result<Vec<Value>> {
    paths
        .iter()
        .map(|p| {
            Ok(json!({
                "path": p,
                "base": text_at(repo, base, p)?,
                "head": text_at(repo, head, p)?,
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-range-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sh(repo: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
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

    fn write(repo: &Path, path: &str, text: &str) {
        let file = repo.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }

    const JOURNAL: &str = "packages/core/drizzle/migrations/meta/_journal.json";

    /// Two commits: the second adds a migration to the journal, adds a compose file, renames a
    /// source file and removes another.
    fn two_commits() -> (PathBuf, String, String) {
        let repo = scratch();
        sh(&repo, &["init", "-q", "-b", "main"]);
        write(&repo, JOURNAL, r#"{"entries":[{"tag":"0478_a"}]}"#);
        write(&repo, "src/old.ts", "old");
        write(&repo, "src/gone.ts", "gone");
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-qm", "base"]);
        let base = sh(&repo, &["rev-parse", "HEAD"]);
        write(
            &repo,
            JOURNAL,
            r#"{"entries":[{"tag":"0478_a"},{"tag":"0479_b"}]}"#,
        );
        write(&repo, "docker-compose.prod.yml", "services: {}\n");
        sh(&repo, &["mv", "src/old.ts", "src/new.ts"]);
        sh(&repo, &["rm", "-q", "src/gone.ts"]);
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-qm", "head"]);
        let head = sh(&repo, &["rev-parse", "HEAD"]);
        (repo, base, head)
    }

    fn cleanup(repo: &Path) {
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn names_every_changed_file_a_rename_as_both_its_names() {
        let (repo, base, head) = two_commits();
        let got = changes_between(&repo, &base, &head).unwrap();
        let mut seen: Vec<(String, &str)> = got.into_iter().map(|c| (c.path, c.change)).collect();
        seen.sort();
        assert_eq!(
            seen,
            vec![
                ("docker-compose.prod.yml".to_string(), "added"),
                (JOURNAL.to_string(), "changed"),
                ("src/gone.ts".to_string(), "removed"),
                ("src/new.ts".to_string(), "added"),
                ("src/old.ts".to_string(), "removed"),
            ]
        );
        cleanup(&repo);
    }

    #[test]
    fn sends_each_file_at_both_ends_null_where_it_does_not_exist() {
        let (repo, base, head) = two_commits();
        let paths = vec![JOURNAL.to_string(), "docker-compose.prod.yml".to_string()];
        let files = files_at(&repo, &base, &head, &paths).unwrap();
        assert_eq!(files[0]["base"], r#"{"entries":[{"tag":"0478_a"}]}"#);
        assert_eq!(
            files[0]["head"],
            r#"{"entries":[{"tag":"0478_a"},{"tag":"0479_b"}]}"#
        );
        assert_eq!(files[1]["base"], Value::Null);
        assert_eq!(files[1]["head"], "services: {}\n");
        cleanup(&repo);
    }

    #[test]
    fn refuses_a_commit_this_checkout_does_not_hold_naming_the_fetch() {
        let (repo, _, head) = two_commits();
        let err = full_commit(&repo, &"d".repeat(40)).unwrap_err().to_string();
        assert!(err.contains("git fetch origin"), "{err}");
        assert_eq!(full_commit(&repo, &head[..12]).unwrap(), head);
        cleanup(&repo);
    }

    #[test]
    fn refuses_a_status_a_report_does_not_carry() {
        assert!(parse_name_status("M\0a.json\0").is_ok());
        let err = parse_name_status("U\0a.json\0").unwrap_err().to_string();
        assert!(err.contains("a.json") && err.contains('U'), "{err}");
        assert!(parse_name_status("M\0").is_err());
    }
}
