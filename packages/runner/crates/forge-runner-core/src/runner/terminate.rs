//! The external way out of every state (ISS-964 criteria 32, 33).
//!
//! Four states — `incarnation` × `work` — and two verbs. `Kill` where a
//! process exists, `Abandon` where none does; which one applies follows from
//! `incarnation` and is never a caller's choice, because a caller that could
//! pick would eventually pick `Abandon` over a live agent and leave it writing
//! git into a worktree the record says is free.
//!
//! Both verbs are enforced on the RECORD. Neither asks the agent to stop and
//! neither waits for it to agree. What they do wait for is the diff: the work a
//! parked agent left is the only thing here that cannot be recreated, so the
//! preserve step runs BEFORE the worktree is released and a preserve that could
//! not be trusted refuses the whole verb rather than releasing anyway.

use std::path::Path;

use crate::error::{Error, Result};
use crate::runner::close_loop::{self, CloseState, LeaseKeeper, SessionReader};
use crate::runner::inflight::Reaped;
use crate::runner::ledger::{Incarnation, Ledger, Run};
use crate::workspace::salvage::{self, Outcome, Salvage};

/// How a run's process group is stopped. A port so the verb is testable
/// without a real agent on the box.
#[async_trait::async_trait]
pub trait ProcessGroup: Send + Sync {
    async fn kill(&self, pid: u32) -> Reaped;
}

/// The box's own process table.
pub struct SystemProcesses;

#[async_trait::async_trait]
impl ProcessGroup for SystemProcesses {
    async fn kill(&self, pid: u32) -> Reaped {
        crate::runner::inflight::kill_group(pid).await
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    Kill,
    Abandon,
}

/// What forcing a run terminal actually did.
#[derive(Debug)]
pub struct Forced {
    pub verb: Verb,
    /// `None` when the worktree was already off the disk.
    pub salvage: Option<Salvage>,
    pub close: CloseState,
}

/// Which verb this run's state admits, or why neither does.
pub fn verb_for(run: &Run, this_boot: &str) -> Result<Verb> {
    match run.incarnation {
        Incarnation::Exited => Ok(Verb::Abandon),
        Incarnation::Live | Incarnation::Starting if run.boot_id == this_boot => Ok(Verb::Kill),
        _ => Err(Error::Other(format!(
            "run {} is `{:?}` from boot {} and this box is {} — liveness is unknown, \
             so nothing may be reclaimed; resolve the boot first",
            run.run_id, run.incarnation, run.boot_id, this_boot
        ))),
    }
}

/// The branch the worktree is on, asked of the worktree itself.
async fn branch_of(worktree: &Path) -> Option<String> {
    let out = tokio::process::Command::new("git")
        .args(["symbolic-ref", "--short", "HEAD"])
        .current_dir(worktree)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!name.is_empty()).then_some(name)
}

fn committed(outcome: Outcome) -> bool {
    matches!(outcome, Outcome::Pushed | Outcome::CommittedNotPushed)
}

/// Put this checkout's commits somewhere other than this box, or refuse the release.
///
/// Answers `Ok(())` only when a fresh fetch says every commit here is on a remote.
async fn publish_before_release(
    run_id: &str,
    verb: Verb,
    worktree: &Path,
    branch: &str,
) -> Result<()> {
    match salvage::publication_of(worktree).await {
        salvage::Publication::Published => return Ok(()),
        salvage::Publication::Unpublished { .. } | salvage::Publication::Unknown { .. } => {}
    }
    match salvage::publish(worktree, branch).await {
        salvage::Publication::Published => Ok(()),
        salvage::Publication::Unpublished { commits } => Err(Error::Other(format!(
            "refusing to {verb:?} run {run_id}: {commits} commit(s) on `{branch}` in {} are on no \
             remote, and the push did not change that — the worktree stays until they land, \
             because releasing it would declare this run over while its only copy is on this box",
            worktree.display()
        ))),
        salvage::Publication::Unknown { why } => Err(Error::Other(format!(
            "refusing to {verb:?} run {run_id}: this box cannot tell whether `{branch}` in {} is \
             on a remote ({why}) — the worktree stays, because not knowing is not the same as \
             knowing it is safe",
            worktree.display()
        ))),
    }
}

/// Force a run terminal from outside it.
pub async fn force_terminal(
    ledger: &mut Ledger,
    run_id: &str,
    what: Forcing<'_>,
    ports: Ports<'_>,
) -> Result<Forced> {
    let Some(run) = ledger.run(run_id)? else {
        return Err(Error::Other(format!("run {run_id} is not in this ledger")));
    };
    let verb = verb_for(&run, what.this_boot)?;

    if verb == Verb::Kill {
        if let Some(pid) = run.pid {
            ports.procs.kill(pid).await;
        }
    }

    let worktree = Path::new(&run.worktree_path);
    let salvage = if worktree.exists()
        && crate::workspace::worktree_reap::holds_work(worktree).await
    {
        let branch = branch_of(worktree).await.ok_or_else(|| {
            Error::Other(format!(
                "cannot read the branch of {} — refusing to release a worktree whose diff \
                 could not be preserved",
                run.worktree_path.display()
            ))
        })?;
        let report = salvage::salvage_wip(salvage::SalvageInput {
            repo_root: what.repo_root,
            base_branch: what.base_branch,
            agent_branch: &branch,
            job_id: run_id,
            attempt: 0,
            failure: what.reason,
        })
        .await;
        if !committed(report.outcome)
            && crate::workspace::worktree_reap::has_unsaved_changes(worktree).await
        {
            return Err(Error::Other(format!(
                "refusing to {verb:?} run {run_id}: the diff in {} was not preserved ({})",
                run.worktree_path.display(),
                report.detail.as_deref().unwrap_or("no detail")
            )));
        }
        publish_before_release(run_id, verb, worktree, &branch).await?;
        crate::workspace::worktree::remove_at(&what.repo_root.to_string_lossy(), worktree).await?;
        Some(report)
    } else {
        if worktree.exists() {
            let branch = branch_of(worktree).await.ok_or_else(|| {
                Error::Other(format!(
                    "refusing to {verb:?} run {run_id}: cannot read the branch of {} — the \
                     worktree stays, because a checkout whose branch this box cannot name is one \
                     whose commits it cannot ask any remote about",
                    run.worktree_path.display()
                ))
            })?;
            publish_before_release(run_id, verb, worktree, &branch).await?;
            crate::workspace::worktree::remove_at(&what.repo_root.to_string_lossy(), worktree)
                .await?;
        }
        None
    };

    let close = close_loop::close(ledger, run_id, ports.sessions, ports.leases).await?;
    if close.is_closed() {
        ledger.end_run(run_id, what.by, what.reason)?;
    }
    Ok(Forced {
        verb,
        salvage,
        close,
    })
}

/// What is being forced, and by whom.
pub struct Forcing<'a> {
    pub this_boot: &'a str,
    pub repo_root: &'a Path,
    pub base_branch: Option<&'a str>,
    pub by: &'a str,
    pub reason: &'a str,
}

/// The outside world this verb reaches through.
pub struct Ports<'a> {
    pub procs: &'a dyn ProcessGroup,
    pub sessions: &'a dyn SessionReader,
    pub leases: &'a dyn LeaseKeeper,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ledger::NewRun;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::Mutex;

    const SOURCE: &str = include_str!("terminate.rs");

    struct Sessions;
    #[async_trait::async_trait]
    impl SessionReader for Sessions {
        async fn is_terminal(&self, _: &str) -> Result<bool> {
            Ok(true)
        }
    }

    struct Leases(Mutex<HashSet<String>>);
    #[async_trait::async_trait]
    impl LeaseKeeper for Leases {
        async fn release(&self, issue_key: &str) -> Result<()> {
            self.0.lock().unwrap().insert(issue_key.to_string());
            Ok(())
        }
        async fn is_returned(&self, issue_key: &str) -> Result<bool> {
            Ok(self.0.lock().unwrap().contains(issue_key))
        }
    }

    struct Procs(Mutex<Vec<u32>>);
    #[async_trait::async_trait]
    impl ProcessGroup for Procs {
        async fn kill(&self, pid: u32) -> Reaped {
            self.0.lock().unwrap().push(pid);
            Reaped::Killed
        }
    }

    async fn git(dir: &Path, args: &[&str]) {
        tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .stdin(std::process::Stdio::null())
            .output()
            .await
            .unwrap();
    }

    /// A repo with a remote and one agent worktree on `ISS-964`, dirty.
    async fn repo(tag: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "forge-terminate-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-b", "main"]).await;
        git(&root, &["config", "user.email", "t@t"]).await;
        git(&root, &["config", "user.name", "t"]).await;
        std::fs::write(root.join("f.txt"), "base").unwrap();
        git(&root, &["add", "."]).await;
        git(&root, &["commit", "-m", "base"]).await;

        let remote = root.with_extension("remote.git");
        let _ = std::fs::remove_dir_all(&remote);
        std::fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "--bare", "-b", "main"]).await;
        git(
            &root,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        )
        .await;
        git(&root, &["push", "-u", "origin", "main"]).await;

        let wt = root.join(".worktrees/ISS-964");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(
            &root,
            &["worktree", "add", &wt.to_string_lossy(), "-b", "ISS-964"],
        )
        .await;
        std::fs::write(wt.join("work.txt"), "the diff a park left").unwrap();
        (root, wt)
    }

    /// Make the fixture's bare remote reject every push, as a protected branch would.
    async fn refuse_pushes(root: &Path) {
        let hooks = root.with_extension("remote.git").join("hooks");
        std::fs::create_dir_all(&hooks).expect("hooks dir");
        let hook = hooks.join("pre-receive");
        std::fs::write(&hook, "#!/bin/sh\necho 'refused by policy' >&2\nexit 1\n").expect("hook");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755))
                .expect("hook mode");
        }
    }

    fn ledger_for(wt: &Path, incarnation: Incarnation, boot: &str) -> Ledger {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: wt.to_path_buf(),
            boot_id: boot.into(),
            issue_keys: vec!["ISS-964".into()],
        })
        .unwrap();
        led.attach_session("run-1", "sess-1").unwrap();
        led.attach_pid("run-1", 4242).unwrap();
        if incarnation == Incarnation::Exited {
            led.begin_question("q-1", "run-1", 1, "q-1").unwrap();
            led.declare_parked_human("run-1", Some("resume-1"), None)
                .unwrap();
        }
        led
    }

    fn ports<'a>(p: &'a Procs, s: &'a Sessions, l: &'a Leases) -> Ports<'a> {
        Ports {
            procs: p,
            sessions: s,
            leases: l,
        }
    }

    fn forcing<'a>(root: &'a Path, boot: &'a str) -> Forcing<'a> {
        Forcing {
            this_boot: boot,
            repo_root: root,
            base_branch: Some("main"),
            by: "operator",
            reason: "the park was abandoned by hand",
        }
    }

    #[test]
    fn the_verb_follows_from_the_state_and_never_from_the_caller() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "p".into(),
            master_session_id: "m".into(),
            worktree_path: PathBuf::from("/tmp/wt"),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
        let live = led.run("run-1").unwrap().unwrap();
        assert_eq!(verb_for(&live, "boot-a").unwrap(), Verb::Kill);

        led.begin_question("q", "run-1", 1, "q").unwrap();
        led.declare_parked_human("run-1", None, None).unwrap();
        let parked = led.run("run-1").unwrap().unwrap();
        assert_eq!(verb_for(&parked, "boot-a").unwrap(), Verb::Abandon);
        // A park outlives the boot it was made in, and it is still Abandon.
        assert_eq!(verb_for(&parked, "boot-b").unwrap(), Verb::Abandon);
    }

    #[test]
    fn a_live_run_from_another_boot_admits_neither_verb() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "p".into(),
            master_session_id: "m".into(),
            worktree_path: PathBuf::from("/tmp/wt"),
            boot_id: "boot-before-the-reboot".into(),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
        let run = led.run("run-1").unwrap().unwrap();
        let err = verb_for(&run, "boot-now")
            .expect_err("unknown liveness must be refused, never reclaimed")
            .to_string();
        assert!(err.contains("unknown"), "{err}");
        assert!(err.contains("boot-before-the-reboot"), "{err}");
    }

    #[tokio::test]
    async fn abandon_preserves_the_diff_then_releases_the_worktree() {
        let (root, wt) = repo("abandon").await;
        git(&wt, &["add", "work.txt"]).await;
        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .unwrap();

        assert_eq!(out.verb, Verb::Abandon);
        assert!(p.0.lock().unwrap().is_empty(), "{:?}", p.0.lock().unwrap());
        assert!(!wt.exists(), "the worktree must be released");
        assert!(out.close.is_closed(), "{:?}", out.close);

        // The diff is on the branch, which outlives the checkout.
        let log = tokio::process::Command::new("git")
            .args([
                "log",
                "--oneline",
                "refs/remotes/origin/ISS-964",
                "--",
                "work.txt",
            ])
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert!(
            !log.stdout.is_empty(),
            "the diff must be committed on the branch BEFORE the worktree goes"
        );

        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(run.ended_by.as_deref(), Some("operator"));
        assert_eq!(
            run.ended_reason.as_deref(),
            Some("the park was abandoned by hand")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn an_untracked_file_is_work_and_is_preserved_before_the_checkout_goes() {
        let (root, wt) = repo("untracked").await;
        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect("a tree holding an untracked file must reach terminal, not refuse");

        assert!(
            committed(out.salvage.expect("salvage ran").outcome),
            "salvage must have RUN and committed — a release that reached the clean branch never looked at the file"
        );
        assert!(
            !wt.exists(),
            "the worktree must still be released once it is safe"
        );
        let log = tokio::process::Command::new("git")
            .args([
                "log",
                "--oneline",
                "refs/remotes/origin/ISS-964",
                "--",
                "work.txt",
            ])
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert!(
            !log.stdout.is_empty(),
            "the untracked file must be committed and published BEFORE the checkout goes — git cannot see a file it has never been told about, and the checkout was its only copy"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_clean_checkout_whose_branch_cannot_be_read_is_refused_by_name() {
        let (root, wt) = repo("nobranch").await;
        git(&wt, &["add", "work.txt"]).await;
        git(&wt, &["commit", "-qm", "work"]).await;
        git(&wt, &["push", "-q", "-u", "origin", "ISS-964"]).await;
        // The remote loses the ref; this box keeps `refs/remotes/origin/ISS-964`, so every local
        // reader still calls this tree clean and published.
        git(
            &root.with_extension("remote.git"),
            &["update-ref", "-d", "refs/heads/ISS-964"],
        )
        .await;
        // `symbolic-ref` is what `branch_of` asks, and a detached HEAD is what it cannot answer.
        git(&wt, &["checkout", "--detach", "-q"]).await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let err = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect_err("a branch this box cannot read is not a licence to remove the checkout");

        let said = format!("{err}");
        assert!(
            said.contains(&wt.to_string_lossy().to_string()),
            "the refusal must name the tree it is refusing, or an operator cannot act on it: {said}"
        );
        assert!(
            wt.exists(),
            "the checkout must still be there after the refusal"
        );
        assert!(
            led.run("run-1").unwrap().unwrap().ended_by.is_none(),
            "a run whose tree was not released has not ended"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_release_is_written_before_the_run_is_ended() {
        let body = SOURCE
            .split("pub async fn force_terminal(")
            .nth(1)
            .expect("force_terminal must be findable");
        let salvage = body.find("salvage_wip").expect("the preserve step");
        let release = body.find("worktree::remove").expect("the release");
        let ended = body.find("end_run").expect("the terminal write");
        assert!(
            salvage < release,
            "the diff is preserved BEFORE the worktree is released (criterion 33)"
        );
        assert!(
            release < ended,
            "`end_run` un-holds the tree for the reaper, so it must come last"
        );
    }

    #[tokio::test]
    async fn a_diff_that_could_not_be_preserved_refuses_the_whole_verb() {
        let (root, wt) = repo("refuse").await;
        git(&wt, &["add", "work.txt"]).await;
        // The repo root salvage is given is not a git checkout, so
        // `git worktree list` there fails and salvage answers `failed`: it
        // cannot find, let alone commit, the tree holding the diff.
        let not_a_repo = root.with_extension("not-a-repo");
        std::fs::create_dir_all(&not_a_repo).unwrap();

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let err = force_terminal(
            &mut led,
            "run-1",
            forcing(&not_a_repo, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect_err("a diff that could not be preserved must refuse the verb")
        .to_string();

        assert!(err.contains("not preserved"), "{err}");
        assert!(wt.exists(), "a refused abandon must not touch the worktree");
        assert!(
            led.run("run-1").unwrap().unwrap().ended_by.is_none(),
            "and must leave the run non-terminal so the tree stays held"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_clean_park_is_released_even_with_a_strangers_dirty_tree_on_the_box() {
        let (root, wt) = repo("clean").await;
        git(&wt, &["add", "-A"]).await;
        git(&wt, &["commit", "-qm", "the agent committed its own work"]).await;
        git(&wt, &["push", "-q", "-u", "origin", "ISS-964"]).await;

        let decoy = root.join(".worktrees/ISS-999");
        git(
            &root,
            &["worktree", "add", &decoy.to_string_lossy(), "-b", "ISS-999"],
        )
        .await;
        std::fs::write(decoy.join("stranger.txt"), "not this run's work").unwrap();

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .unwrap();

        assert!(
            out.salvage.is_none(),
            "nothing to preserve: {:?}",
            out.salvage
        );
        assert!(!wt.exists(), "a clean park's tree is still released");
        assert!(decoy.exists(), "and a stranger's tree is left alone");
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn kill_signals_the_process_group_before_anything_is_released() {
        let (root, wt) = repo("kill").await;
        let mut led = ledger_for(&wt, Incarnation::Live, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .unwrap();

        assert_eq!(out.verb, Verb::Kill);
        assert_eq!(*p.0.lock().unwrap(), vec![4242]);
        assert!(!wt.exists());
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_run_whose_tree_is_already_gone_still_reaches_terminal() {
        let gone = std::env::temp_dir().join("forge-terminate-absent-by-construction");
        let _ = std::fs::remove_dir_all(&gone);
        let mut led = ledger_for(&gone, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(Path::new("/nonexistent-repo"), "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .unwrap();

        assert!(out.salvage.is_none(), "{:?}", out.salvage);
        assert!(out.close.is_closed(), "{:?}", out.close);
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_some());
    }

    #[test]
    fn the_verb_stamps_no_mark_of_its_own() {
        let body = SOURCE
            .split("pub async fn force_terminal(")
            .nth(1)
            .expect("force_terminal must be findable");
        for mark in [
            "mark_session_terminal_observed",
            "mark_worktree_gone_observed",
            "mark_lease_returned_observed",
        ] {
            assert!(
                !body.contains(mark),
                "{mark} is close_loop's to set by reading the world back"
            );
        }
    }
    /// The forge-vm shape: the checkout's directory and its branch had diverged.
    #[tokio::test]
    async fn a_checkout_whose_directory_is_not_named_after_its_branch_is_still_released() {
        let (root, _other) = repo("renamed").await;
        let wt = root.join(".worktrees/short");
        git(
            &root,
            &[
                "worktree",
                "add",
                &wt.to_string_lossy(),
                "-b",
                "a-much-longer-branch-name",
            ],
        )
        .await;
        git(
            &wt,
            &["push", "-q", "-u", "origin", "a-much-longer-branch-name"],
        )
        .await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect("a clean checkout must be released whatever its directory is called");

        assert!(!wt.exists(), "the worktree must be released");
        assert!(out.close.is_closed(), "{:?}", out.close);
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }
    /// A checkout that believes it pushed, over a remote that no longer has the ref.
    #[tokio::test]
    async fn a_ref_this_box_remembers_pushing_is_not_taken_as_a_ref_the_remote_has() {
        let (root, wt) = repo("stale").await;
        git(&wt, &["add", "work.txt"]).await;
        git(&wt, &["commit", "-qm", "work"]).await;
        git(&wt, &["push", "-q", "-u", "origin", "ISS-964"]).await;
        // The remote loses the ref and will not take it back; this box still has
        // `refs/remotes/origin/ISS-964` and an upstream that looks satisfied.
        git(
            &root.with_extension("remote.git"),
            &["update-ref", "-d", "refs/heads/ISS-964"],
        )
        .await;
        refuse_pushes(&root).await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let err = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect_err("a ref only this box remembers is not a published ref");

        assert!(wt.exists(), "the worktree must be left where it was");
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_none());
        let _ = std::fs::remove_dir_all(&root);
        let _ = err;
    }

    /// A remote that refuses the push: the tree stays, and the run stays open.
    #[tokio::test]
    async fn a_push_the_remote_refuses_leaves_the_worktree_held_and_the_run_open() {
        let (root, wt) = repo("refused").await;
        git(&wt, &["add", "work.txt"]).await;
        git(&wt, &["commit", "-qm", "work the remote will not take"]).await;
        refuse_pushes(&root).await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let err = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect_err("a release over work no remote will take is a refusal");

        let said = format!("{err}");
        assert!(
            said.contains("on no remote"),
            "the refusal must name what is at risk: {said}"
        );
        assert!(wt.exists(), "the worktree must be left where it was");
        assert!(
            led.run("run-1").unwrap().unwrap().ended_by.is_none(),
            "the run must stay open so the next sweep tries again"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A remote this box cannot reach at all: the same refusal, for a different reason.
    #[tokio::test]
    async fn a_remote_this_box_cannot_reach_is_not_read_as_work_that_is_safe() {
        let (root, wt) = repo("unreachable").await;
        git(&wt, &["add", "work.txt"]).await;
        git(&wt, &["commit", "-qm", "work"]).await;
        git(
            &wt,
            &["remote", "set-url", "origin", "/nonexistent/remote.git"],
        )
        .await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let err = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect_err("a box that cannot ask the remote may not conclude the work is safe");

        let said = format!("{err}");
        assert!(
            said.contains("cannot tell"),
            "the refusal must say it does not know, not that the work is unsafe: {said}"
        );
        assert!(wt.exists(), "the worktree must be left where it was");
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A clean checkout carrying commits no remote had: PUBLISHED, then released.
    #[tokio::test]
    async fn a_clean_checkout_whose_commits_are_only_local_is_released_and_keeps_them() {
        let (root, wt) = repo("localonly").await;
        git(&wt, &["add", "work.txt"]).await;
        git(&wt, &["commit", "-qm", "work no remote has"]).await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect("a clean checkout must be released even when salvage had nothing to do");

        assert!(!wt.exists(), "the worktree must be released");
        assert!(out.close.is_closed(), "{:?}", out.close);
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_some());

        let log = tokio::process::Command::new("git")
            .args(["log", "--oneline", "ISS-964", "--", "work.txt"])
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert!(
            !log.stdout.is_empty(),
            "the commit must survive on the branch after the checkout is gone"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
