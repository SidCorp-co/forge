//! Say on the issue when this box is holding a checkout nothing else has.
//!
//! `runner/terminate.rs` refuses to release a worktree whose commits it cannot
//! find on a remote. That refusal is correct and it is silent: the tree stays,
//! the run stays open, and the only record is a `tracing::warn` in this box's
//! journal. A hold nobody can see is the same shape as the failure this whole
//! issue is about — work that exists and no surface says so.
//!
//! This pass carries that refusal to the issues the run holds. It reports and
//! moves nothing: refusing to release is already the strongest act available to
//! a box, and what happens to the work belongs to whoever reads the issue.
//!
//! It is deliberately not a retry mechanism and deliberately does not ask for
//! one. The master sweep already retries the release every thirty seconds, so a
//! remote that comes back releases the tree with nobody involved; this exists
//! for the remote that does not come back.

use crate::runner::ledger::{Incarnation, Ledger, Run};
use crate::transport::{run_sessions, CoreClient};
use crate::workspace::salvage::{self, Publication};

/// What the box says about a checkout it is keeping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    pub worktree: String,
    pub branch: Option<String>,
    pub head: String,
    pub commits_unpushed: Option<u32>,
    pub reason: String,
}

impl Held {
    pub fn to_json(&self) -> serde_json::Value {
        let mut v = serde_json::json!({
            "worktree": self.worktree,
            "head": self.head,
            "reason": self.reason,
        });
        let obj = v.as_object_mut().expect("json! object");
        if let Some(b) = &self.branch {
            obj.insert("branch".into(), b.clone().into());
        }
        if let Some(c) = self.commits_unpushed {
            obj.insert("commitsUnpushed".into(), c.into());
        }
        v
    }
}

/// What reporting a held checkout needs of core.
#[allow(async_fn_in_trait)]
pub trait HeldReporter {
    async fn report(&self, session_id: &str, held: &Held) -> crate::error::Result<()>;
}

/// The live implementation, over this box's device credential.
pub struct CoreHeld<'a>(pub &'a CoreClient);

impl HeldReporter for CoreHeld<'_> {
    async fn report(&self, session_id: &str, held: &Held) -> crate::error::Result<()> {
        run_sessions::report_held_worktree(self.0, session_id, held.to_json()).await
    }
}

pub async fn at_risk(run: &Run) -> Option<Held> {
    let worktree = run.worktree_path.as_path();
    if !worktree.is_absolute() || !worktree.exists() {
        return None;
    }
    let head = git_line(worktree, &["rev-parse", "HEAD"]).await?;
    let branch = git_line(worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
    match salvage::publication_of(worktree).await {
        Publication::Published => None,
        Publication::Unpublished { commits } => Some(Held {
            worktree: worktree.display().to_string(),
            branch,
            head,
            commits_unpushed: Some(commits),
            reason: format!(
                "{commits} commit(s) here are on no remote, and the push to publish them did not land"
            ),
        }),
        Publication::Unknown { why } => Some(Held {
            worktree: worktree.display().to_string(),
            branch,
            head,
            commits_unpushed: None,
            reason: format!(
                "this box cannot tell whether the work here is on a remote ({why}), and not knowing is not the same as knowing it is safe"
            ),
        }),
    }
}

async fn git_line(dir: &std::path::Path, args: &[&str]) -> Option<String> {
    let out = tokio::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

pub async fn report_held_worktrees(
    reporter: &impl HeldReporter,
    ledger: &mut Option<Ledger>,
    boot_id: &str,
) -> usize {
    if boot_id.is_empty() {
        return 0;
    }
    let Some(led) = ledger.as_mut() else {
        return 0;
    };
    let runs = match led.unclosed_runs() {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("[held-report] cannot read unclosed runs: {e}");
            return 0;
        }
    };
    let mut said = 0;
    for run in runs {
        if run.incarnation != Incarnation::Exited {
            continue;
        }
        let Some(session_id) = run.session_id.clone() else {
            continue;
        };
        let Some(held) = at_risk(&run).await else {
            continue;
        };
        match reporter.report(&session_id, &held).await {
            Ok(()) => {
                tracing::warn!(
                    "[held-report] run {} keeps {} because {}",
                    run.run_id,
                    held.worktree,
                    held.reason
                );
                said += 1;
            }
            Err(e) => tracing::warn!(
                "[held-report] run {}: core would not take the report ({e}) — the tree is still held, so the next sweep tries again",
                run.run_id
            ),
        }
    }
    said
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ledger::NewRun;
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "forge-held-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ))
    }

    fn sh(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A repo with a bare remote, a pushed main, and a worktree branch of its own.
    fn a_box_with_a_worktree(name: &str) -> (PathBuf, PathBuf) {
        let root = temp_path(name);
        let _ = std::fs::remove_dir_all(&root);
        let remote = root.join("remote.git");
        let work = root.join("work");
        std::fs::create_dir_all(&remote).expect("mkdir remote");
        std::fs::create_dir_all(&work).expect("mkdir work");
        sh(&remote, &["init", "-q", "--bare", "-b", "main"]);
        sh(&work, &["init", "-q", "-b", "main"]);
        sh(&work, &["config", "user.email", "t@t"]);
        sh(&work, &["config", "user.name", "t"]);
        std::fs::write(work.join("base.txt"), "base\n").expect("write");
        sh(&work, &["add", "-A"]);
        sh(&work, &["commit", "-qm", "base"]);
        sh(
            &work,
            &["remote", "add", "origin", remote.to_str().expect("utf8")],
        );
        sh(&work, &["push", "-q", "-u", "origin", "main"]);
        sh(&work, &["checkout", "-qb", "ISS-9"]);
        (root, work)
    }

    fn refuse_pushes(root: &Path) {
        let hooks = root.join("remote.git").join("hooks");
        std::fs::create_dir_all(&hooks).expect("hooks");
        let hook = hooks.join("pre-receive");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").expect("hook");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).expect("mode");
        }
    }

    fn a_ledger_holding(worktree: &Path, incarnation: Incarnation) -> Option<Ledger> {
        let mut led = Ledger::open_in_memory().expect("ledger");
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj".into(),
            master_session_id: "master".into(),
            worktree_path: worktree.to_path_buf(),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-9".into()],
        })
        .expect("create");
        led.attach_session("run-1", "core-sess-1").expect("attach");
        led.attach_pid("run-1", 4242).expect("pid");
        // The only way a test reaches `Exited` is the way production does: a human park.
        if incarnation == Incarnation::Exited {
            led.begin_question("q-1", "run-1", 1, "q-1")
                .expect("question");
            led.declare_parked_human("run-1", Some("resume-1"), None)
                .expect("park");
        }
        Some(led)
    }

    #[derive(Default)]
    struct Spy {
        seen: RefCell<Vec<(String, Held)>>,
        answer: Option<&'static str>,
    }

    impl HeldReporter for Spy {
        async fn report(&self, session_id: &str, held: &Held) -> crate::error::Result<()> {
            self.seen
                .borrow_mut()
                .push((session_id.to_string(), held.clone()));
            match self.answer {
                None => Ok(()),
                Some(e) => Err(crate::error::Error::Other(e.into())),
            }
        }
    }

    #[tokio::test]
    async fn reports_a_checkout_whose_commits_no_remote_will_take() {
        let (root, wt) = a_box_with_a_worktree("refused");
        std::fs::write(wt.join("work.txt"), "work\n").expect("write");
        sh(&wt, &["add", "-A"]);
        sh(&wt, &["commit", "-qm", "work"]);
        refuse_pushes(&root);
        let mut led = a_ledger_holding(&wt, Incarnation::Exited);
        let spy = Spy::default();

        let said = report_held_worktrees(&spy, &mut led, "boot-a").await;
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(said, 1);
        let seen = spy.seen.borrow();
        let (session, held) = seen.first().expect("one report");
        assert_eq!(session, "core-sess-1");
        assert_eq!(held.branch.as_deref(), Some("ISS-9"));
        assert_eq!(held.commits_unpushed, Some(1));
        assert!(
            held.reason.contains("on no remote"),
            "the reason must name what is at risk: {}",
            held.reason
        );
    }

    #[tokio::test]
    async fn says_nothing_about_a_run_whose_process_is_still_up() {
        let (root, wt) = a_box_with_a_worktree("live");
        std::fs::write(wt.join("work.txt"), "work\n").expect("write");
        sh(&wt, &["add", "-A"]);
        sh(&wt, &["commit", "-qm", "work"]);
        refuse_pushes(&root);
        let mut led = a_ledger_holding(&wt, Incarnation::Live);
        let spy = Spy::default();

        let said = report_held_worktrees(&spy, &mut led, "boot-a").await;
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(said, 0, "a live run is not a held checkout");
        assert!(spy.seen.borrow().is_empty());
    }

    #[tokio::test]
    async fn says_nothing_about_a_checkout_whose_work_a_remote_has() {
        let (root, wt) = a_box_with_a_worktree("published");
        std::fs::write(wt.join("work.txt"), "work\n").expect("write");
        sh(&wt, &["add", "-A"]);
        sh(&wt, &["commit", "-qm", "work"]);
        sh(&wt, &["push", "-q", "-u", "origin", "ISS-9"]);
        let mut led = a_ledger_holding(&wt, Incarnation::Exited);
        let spy = Spy::default();

        let said = report_held_worktrees(&spy, &mut led, "boot-a").await;
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(
            said, 0,
            "published work is not at risk and must not be reported"
        );
        assert!(spy.seen.borrow().is_empty());
    }

    #[tokio::test]
    async fn reports_a_remote_it_cannot_reach_as_not_knowing_rather_than_as_unsafe() {
        let (root, wt) = a_box_with_a_worktree("unreachable");
        std::fs::write(wt.join("work.txt"), "work\n").expect("write");
        sh(&wt, &["add", "-A"]);
        sh(&wt, &["commit", "-qm", "work"]);
        sh(
            &wt,
            &["remote", "set-url", "origin", "/nonexistent/remote.git"],
        );
        let mut led = a_ledger_holding(&wt, Incarnation::Exited);
        let spy = Spy::default();

        let said = report_held_worktrees(&spy, &mut led, "boot-a").await;
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(said, 1);
        let seen = spy.seen.borrow();
        let held = &seen.first().expect("one report").1;
        assert!(
            held.reason.contains("cannot tell"),
            "not knowing must not be reported as knowing it is unsafe: {}",
            held.reason
        );
        assert_eq!(
            held.commits_unpushed, None,
            "a box that could not ask has no count to give"
        );
    }

    #[tokio::test]
    async fn a_report_core_refuses_is_not_counted_as_said() {
        let (root, wt) = a_box_with_a_worktree("refusedbycore");
        std::fs::write(wt.join("work.txt"), "work\n").expect("write");
        sh(&wt, &["add", "-A"]);
        sh(&wt, &["commit", "-qm", "work"]);
        refuse_pushes(&root);
        let mut led = a_ledger_holding(&wt, Incarnation::Exited);
        let spy = Spy {
            answer: Some("503"),
            ..Default::default()
        };

        let said = report_held_worktrees(&spy, &mut led, "boot-a").await;
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(said, 0, "core did not take it, so nothing was said");
        assert_eq!(spy.seen.borrow().len(), 1, "but it was attempted");
    }

    #[test]
    fn the_payload_carries_only_what_core_declares() {
        let held = Held {
            worktree: "/w".into(),
            branch: Some("ISS-9".into()),
            head: "abc".into(),
            commits_unpushed: Some(2),
            reason: "because".into(),
        };
        let json = held.to_json();
        let keys: Vec<&str> = json
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        for k in &keys {
            assert!(
                matches!(
                    *k,
                    "worktree" | "branch" | "head" | "commitsUnpushed" | "reason"
                ),
                "core's schema does not declare `{k}`"
            );
        }
        assert!(
            json.get("recommendation").is_none(),
            "this report decides nothing: {json}"
        );
    }
}
