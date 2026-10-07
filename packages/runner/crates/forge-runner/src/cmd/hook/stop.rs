//! The stop gate: the facts `runner_core::stop_gate` decides a run's stop on,
//! read from the box and from core, never from the plugin.
//!
//! The subject is found in this box's ledger: a `SubagentStop` whose
//! `agent_id` the box bound to a declared, unended run. Anything else — the
//! pane's own `Stop`, a subagent bound to no run — is not judged, and leaves
//! no line.
//!
//! The rule `cmd/hook.rs` holds every event to still holds here: no path may
//! break the agent. A refusal is the answer, not a failure; a reading that
//! cannot be made refuses nothing, and is written to the journal with why.

use std::path::Path;
use std::time::Duration;

use runner_core::ledger::Ledger;
use runner_core::stop_gate::{
    decide, journal_line, porcelain_paths, refused_in_a_row, written_since, Activity, Facts, Issue,
    Outcome, Since, Verdict, JOURNAL,
};
use runner_platform::standing;
use runner_transport::CoreClient;
use serde_json::Value;

use crate::cmd::api::{get_json, rest_client};
use crate::cmd::Ctx;

/// How long core is given for every read of one stop, together.
const CORE_WITHIN: Duration = Duration::from_secs(20);
/// How many pages of an issue's activity are read before it is called unread.
const PAGES: usize = 4;
const PAGE_ROWS: u32 = 50;

/// What a judged stop came to, and the run it was judged for.
pub struct Judged {
    pub run_id: String,
    pub verdict: Verdict,
}

/// The JSON a refused stop is answered with.
pub fn block(reason: &str) -> String {
    serde_json::json!({ "decision": "block", "reason": reason }).to_string()
}

/// Judge one `SubagentStop`, journal it, and answer the reason to refuse it
/// with, if it is refused. `None` for a stop that is not a run's or passes.
pub async fn gate(ctx: &Ctx, agent_id: Option<&str>) -> Option<String> {
    let dir = runner_platform::config::config_dir();
    let judged = judge(ctx, agent_id, dir.as_deref()).await?;
    if let Some(dir) = dir.as_deref() {
        let line = journal_line(
            runner_core::agent_activity::now_ms(),
            &judged.run_id,
            &judged.verdict,
        );
        append(&dir.join(JOURNAL), &line);
    }
    for why in &judged.verdict.unread {
        eprintln!("forge-runner stop gate: not read, and not held on: {why}");
    }
    match judged.verdict.outcome {
        Outcome::Refused(reason) => Some(reason),
        Outcome::Passed | Outcome::LetGo => None,
    }
}

fn append(path: &Path, line: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{line}");
    }
}

async fn judge(ctx: &Ctx, agent_id: Option<&str>, dir: Option<&Path>) -> Option<Judged> {
    let agent_id = agent_id?;
    let led = match Ledger::default_path().and_then(|p| Ledger::open_read_only(&p)) {
        Ok(led) => led,
        Err(e) => {
            if let Some(dir) = dir {
                let unread = serde_json::json!({
                    "at": runner_core::agent_activity::now_ms(), "run": null, "agent": agent_id,
                    "outcome": "passed", "conditions": [],
                    "unread": [format!("the ledger: {e}, so whether this subagent is a run could not be read")],
                });
                append(&dir.join(JOURNAL), &unread.to_string());
            }
            return None;
        }
    };
    let run = led.run_for_agent(agent_id).ok().flatten()?;
    let keys: Vec<String> = led
        .issues(&run.run_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m.lease_returned_at.is_none())
        .map(|m| m.issue_key)
        .collect();
    let declared_ms = run.created_at.saturating_mul(1000);
    let issues = read_issues(ctx, run.project_id.as_deref(), &keys, declared_ms).await;
    let refused_before = dir
        .and_then(|d| std::fs::read_to_string(d.join(JOURNAL)).ok())
        .map_or(0, |j| refused_in_a_row(&j, &run.run_id));
    let verdict = decide(&Facts {
        run_id: &run.run_id,
        tree: &run.worktree_path,
        issues,
        dirty: dirty_in(&run.worktree_path),
        standing: standing_here(&run.worktree_path, run.created_at),
        refused_in_a_row: refused_before,
    });
    Some(Judged {
        run_id: run.run_id,
        verdict,
    })
}

/// The tree's uncommitted paths, untracked ones among them and ignored ones not.
pub fn dirty_in(tree: &Path) -> Result<Vec<String>, String> {
    if !tree.is_dir() {
        return Err(format!("{} is no longer on this box", tree.display()));
    }
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(tree)
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=normal"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("git could not be run in {}: {e}", tree.display()))?;
    if !out.status.success() {
        return Err(format!(
            "git status in {} failed: {}",
            tree.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(porcelain_paths(&String::from_utf8_lossy(&out.stdout)))
}

/// The processes standing in the tree since the run was declared, this hook's
/// own chain left out.
fn standing_here(tree: &Path, since: i64) -> Result<Vec<standing::Standing>, String> {
    let Some(root) = standing::system_root() else {
        return Err("this platform has no process table this runner reads".into());
    };
    let own = standing::chain_at(&root, std::process::id());
    match standing::standing_in(&root, tree, since, &own) {
        standing::Reading::Read(found) => Ok(found),
        standing::Reading::Unreadable(why) => Err(why),
    }
}

async fn read_issues(
    ctx: &Ctx,
    project_id: Option<&str>,
    keys: &[String],
    declared_ms: i64,
) -> Vec<(String, Issue)> {
    let all = |why: String| -> Vec<(String, Issue)> {
        keys.iter()
            .map(|k| (k.clone(), Issue::Unread(why.clone())))
            .collect()
    };
    if keys.is_empty() {
        return Vec::new();
    }
    let Some(project_id) = project_id else {
        return all("the run records no project, so its issues cannot be looked up".into());
    };
    let client = match rest_client(ctx) {
        Ok(Ok(c)) => c,
        Ok(Err(why)) => return all(format!("core could not be asked: {why}")),
        Err(e) => return all(format!("core could not be asked: {e}")),
    };
    let reads = async {
        let mut out = Vec::new();
        for key in keys {
            out.push((
                key.clone(),
                read_issue(&client, project_id, key, declared_ms).await,
            ));
        }
        out
    };
    match tokio::time::timeout(CORE_WITHIN, reads).await {
        Ok(out) => out,
        Err(_) => all(format!(
            "core did not answer within {}s",
            CORE_WITHIN.as_secs()
        )),
    }
}

async fn read_issue(client: &CoreClient, project_id: &str, key: &str, declared_ms: i64) -> Issue {
    let path = format!("/api/issues/{key}?projectId={project_id}");
    let issue = match get_json(client, &path).await {
        Ok(v) => v,
        Err(why) => return Issue::Unread(why),
    };
    let (Some(id), Some(status)) = (
        issue.get("id").and_then(Value::as_str),
        issue.get("status").and_then(Value::as_str),
    ) else {
        return Issue::Unread(format!("GET {path} carries no `id` and `status`"));
    };
    if status != "in_progress" {
        return Issue::NotHeld;
    }
    let mut before: Option<String> = None;
    for _ in 0..PAGES {
        let mut page = format!("/api/issues/{id}/activity?limit={PAGE_ROWS}");
        if let Some(b) = &before {
            page.push_str(&format!("&before={b}"));
        }
        let (rows, next) = match get_json(client, &page)
            .await
            .and_then(|v| activity_page(&v))
        {
            Ok(read) => read,
            Err(why) => return Issue::Unread(why),
        };
        match written_since(&rows, declared_ms) {
            Since::Written => return Issue::HeldWritten,
            Since::Unwritten => return Issue::HeldUnwritten { id: id.to_string() },
            Since::ReadFurther => {}
        }
        match next {
            Some(n) => before = Some(n),
            None => {
                return Issue::Unread(
                    "it is in_progress and its activity holds no move to in_progress".into(),
                )
            }
        }
    }
    Issue::Unread(format!(
        "{PAGES} pages of its activity held neither a write nor the take"
    ))
}

/// One page of `GET /api/issues/:id/activity`: its rows, newest first, and the
/// cursor to the page before it.
pub fn activity_page(v: &Value) -> Result<(Vec<Activity>, Option<String>), String> {
    let items = v
        .get("items")
        .and_then(Value::as_array)
        .ok_or("the activity page carries no `items`")?;
    let rows = items
        .iter()
        .map(|item| {
            let action = item.get("action").and_then(Value::as_str);
            let at = item.get("createdAt").and_then(Value::as_str);
            match (action, at.and_then(runner_platform::clock::rfc3339_ms)) {
                (Some(action), Some(at_ms)) => Ok(Activity {
                    action: action.to_string(),
                    at_ms,
                    to: item
                        .pointer("/payload/to")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                }),
                _ => Err(format!(
                    "an activity row carries no readable `action` and `createdAt`: {item}"
                )),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let next = v
        .get("nextBefore")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok((rows, next))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("stop-gate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn a_tree_with_uncommitted_work_reads_dirty_and_reads_clean_once_committed() {
        let tree = scratch("dirty");
        git(&tree, &["init", "-q"]);
        std::fs::write(tree.join(".gitignore"), "target/\n").unwrap();
        git(&tree, &["add", "-A"]);
        git(&tree, &["commit", "-qm", "base"]);
        assert_eq!(dirty_in(&tree), Ok(vec![]));

        std::fs::create_dir_all(tree.join("target")).unwrap();
        std::fs::write(tree.join("target/out.o"), "ignored").unwrap();
        assert_eq!(dirty_in(&tree), Ok(vec![]), "an ignored file is not work");

        std::fs::write(tree.join("new.rs"), "fn main() {}").unwrap();
        std::fs::write(tree.join(".gitignore"), "target/\n*.tmp\n").unwrap();
        assert_eq!(
            dirty_in(&tree),
            Ok(vec![".gitignore".to_string(), "new.rs".to_string()])
        );

        git(&tree, &["add", "-A"]);
        git(&tree, &["commit", "-qm", "work"]);
        assert_eq!(dirty_in(&tree), Ok(vec![]));
        let _ = std::fs::remove_dir_all(&tree);
    }

    /// The refusal's `git` command, run as written by `sh` with no terminal and
    /// an editor that writes nothing, in a tree whose path needs quoting: it
    /// must leave the tree clean, as a run copying it would expect.
    #[cfg(unix)]
    #[test]
    fn the_dirty_refusals_command_commits_the_tree_with_no_terminal() {
        let root = scratch("hint");
        let tree = root.join("a tree");
        std::fs::create_dir_all(&tree).unwrap();
        git(&tree, &["init", "-q"]);
        git(&tree, &["commit", "-q", "--allow-empty", "-m", "base"]);
        std::fs::write(tree.join("work.rs"), "fn main() {}").unwrap();
        let dirty = dirty_in(&tree).unwrap();
        let verdict = decide(&Facts {
            run_id: "296f5496-870e-428f-b386-d1c6007bfd9c",
            tree: &tree,
            issues: vec![],
            dirty: Ok(dirty),
            standing: Ok(vec![]),
            refused_in_a_row: 0,
        });
        let Outcome::Refused(reason) = verdict.outcome else {
            panic!("a dirty tree was not refused: {:?}", verdict.outcome);
        };
        let cmd = reason
            .split('`')
            .skip(1)
            .step_by(2)
            .find(|c| c.starts_with("git -C"))
            .unwrap_or_else(|| panic!("no git command in {reason}"));
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .env("GIT_EDITOR", "true")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "`{cmd}` failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(dirty_in(&tree), Ok(vec![]), "`{cmd}` left the tree dirty");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_tree_that_is_gone_or_no_checkout_is_unread_not_clean() {
        let gone = scratch("gone").join("nowhere");
        assert!(matches!(dirty_in(&gone), Err(why) if why.contains("no longer on this box")));
        let plain = scratch("plain");
        assert!(matches!(dirty_in(&plain), Err(why) if why.contains("git status")));
        let _ = std::fs::remove_dir_all(plain);
    }

    #[test]
    fn an_activity_page_reads_as_rows_and_its_cursor() {
        let v: Value = serde_json::json!({
            "items": [
                {"action": "record.wave", "createdAt": "2026-10-06T23:17:15.706Z", "payload": {}},
                {"action": "issue.statusChanged", "createdAt": "2026-10-06T23:21:19.185Z",
                 "payload": {"to": "in_progress", "from": "open"}}
            ],
            "nextBefore": "2026-10-06T23:17:15.706Z"
        });
        let (rows, next) = activity_page(&v).unwrap();
        assert_eq!(rows[1].to.as_deref(), Some("in_progress"));
        assert_eq!(rows[1].at_ms, 1_791_328_879_185);
        assert_eq!(next.as_deref(), Some("2026-10-06T23:17:15.706Z"));
        let bad = serde_json::json!({"items": [{"action": "x", "createdAt": "yesterday"}]});
        assert!(activity_page(&bad).is_err());
        assert!(activity_page(&serde_json::json!({})).is_err());
    }

    #[test]
    fn a_refused_stop_is_answered_with_a_block_decision() {
        let v: Value = serde_json::from_str(&block("why")).unwrap();
        assert_eq!(v["decision"], "block");
        assert_eq!(v["reason"], "why");
    }
}
