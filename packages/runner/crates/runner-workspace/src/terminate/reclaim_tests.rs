//! FB-273 and ISS-1016, against real repositories: a reclaim over a run whose subagent is
//! working, and over commits a local branch already names.
//!
//! Measured on this box 2026-10-23 (forge-runner 3332976): a run declared over
//! a closed issue was reclaimed by `Kill` a minute after its subagent bound.
//! The release pushed the run's branch to `origin`, a customer's GitLab, though
//! it read `commits Some(AlreadyNamed)`, and removed the checkout the subagent
//! was working in.

use super::*;
use runner_core::ledger::{NewRun, TreeOrigin};
use runner_platform::subagent_host::{Host, HostRead, Hosts, Running};
use std::path::PathBuf;

struct Procs;
#[async_trait::async_trait]
impl ProcessGroup for Procs {
    async fn kill(&self, _pid: u32) -> Reaped {
        Reaped::NotFound
    }
}
struct World;
#[async_trait::async_trait]
impl SessionReader for World {
    async fn is_terminal(&self, _id: &str) -> Result<bool> {
        Ok(true)
    }
}
#[async_trait::async_trait]
impl LeaseKeeper for World {
    async fn release(&self, _p: Option<&str>, _s: Option<&str>, _k: &str) -> Result<()> {
        Ok(())
    }
    async fn is_returned(&self, _p: Option<&str>, _s: Option<&str>, _k: &str) -> Result<bool> {
        Ok(true)
    }
}

/// A process table answering one fixed reading for every host.
struct Table(HostRead);
impl Hosts for Table {
    fn read(&self, _pid: u32, _start: &str) -> HostRead {
        self.0
    }
    fn above(&self, _peer: u32) -> Option<Host> {
        None
    }
    fn running(&self, _conversation: &str) -> Running {
        Running::Unreadable
    }
    fn beneath(&self, _pid: u32, _start: &str, _ancestor: u32) -> HostRead {
        self.0
    }
}

fn ports(hosts: &dyn Hosts) -> Ports<'_> {
    Ports {
        procs: &Procs,
        sessions: &World,
        leases: &World,
        hosts,
    }
}

async fn git(dir: &Path, args: &[&str]) -> String {
    let out = tokio::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .await
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8_lossy(&out.stdout).to_string()
}

/// A repository whose `origin` is a bare repository on disk holding `main`,
/// with one linked checkout on `iss-23` carrying one commit `origin` has not
/// seen, and a ledger.
async fn a_repo_with_an_origin(tag: &str) -> (PathBuf, PathBuf, PathBuf, Ledger) {
    let base = std::env::temp_dir().join(format!(
        "forge-{tag}-{}-{}",
        std::process::id(),
        runner_core::agent_activity::now_ms()
    ));
    let (root, bare) = (base.join("repo"), base.join("origin.git"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "-q", "--bare", "-b", "main"]).await;
    git(&root, &["init", "-q", "-b", "main"]).await;
    git(&root, &["config", "user.email", "t@t"]).await;
    git(&root, &["config", "user.name", "t"]).await;
    std::fs::write(root.join("a.txt"), "a").unwrap();
    git(&root, &["add", "a.txt"]).await;
    git(&root, &["commit", "-q", "-m", "a"]).await;
    git(&root, &["remote", "add", "origin", &bare.to_string_lossy()]).await;
    git(&root, &["push", "-q", "origin", "main"]).await;
    let wt = root.join(".worktrees/iss-23");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "iss-23",
            &wt.to_string_lossy(),
        ],
    )
    .await;
    std::fs::write(wt.join("b.txt"), "b").unwrap();
    git(&wt, &["add", "b.txt"]).await;
    git(&wt, &["commit", "-q", "-m", "b"]).await;
    let led = Ledger::open(&root.join("ledger.db")).unwrap();
    (base, root, wt, led)
}

fn declare(led: &mut Ledger, run_id: &str, wt: &Path) {
    declare_as(led, run_id, wt, TreeOrigin::Created);
}

fn declare_as(led: &mut Ledger, run_id: &str, wt: &Path, origin: TreeOrigin) {
    led.create_run_group(NewRun {
        run_id: run_id.into(),
        project_id: "proj-1".into(),
        master_session_id: "master-1".into(),
        worktree_path: wt.to_path_buf(),
        boot_id: "boot-1".into(),
        issue_keys: vec!["ISS-23".into()],
        role: None,
        requirement: None,
        worktree_origin: origin,
    })
    .unwrap();
}

fn forcing(root: &Path) -> Forcing<'_> {
    Forcing {
        this_boot: "boot-1",
        repo_root: root,
        base_branch: Some("main"),
        by: "recovery",
        reason: "every issue it holds is over at core",
    }
}

/// The branches `origin` holds.
async fn on_origin(bare: &Path) -> String {
    git(
        bare,
        &["for-each-ref", "--format=%(refname)", "refs/heads/"],
    )
    .await
}

/// The commit on `iss-23` is one `origin` has not seen, so the release keeps the checkout — and
/// publishes nothing to make it removable. It used to push the branch to `origin` first.
#[tokio::test]
async fn a_release_publishes_nothing_and_keeps_what_no_remote_holds() {
    let (base, root, wt, mut led) = a_repo_with_an_origin("named-no-push").await;
    let bare = base.join("origin.git");
    declare(&mut led, "run-1", &wt);
    led.end_run("run-1", "master", "done").unwrap();

    let forced = force_terminal(
        &mut led,
        "run-1",
        forcing(&root),
        ports(&Table(HostRead::Gone)),
    )
    .await
    .expect("a checkout holding a commit on no remote is kept, not refused");
    assert!(
        matches!(forced.worktree, WorktreeOutcome::KeptWithWork { .. }),
        "{forced:?}"
    );
    assert_eq!(forced.commits, None);
    assert!(
        !on_origin(&bare).await.contains("refs/heads/iss-23"),
        "the release pushed `iss-23` to origin — a reclaim never publishes (FB-273)"
    );
    assert!(wt.exists(), "kept");
    let _ = std::fs::remove_dir_all(&base);
}

/// A detached checkout's commits on no remote are kept with the checkout: no ref is written for
/// them, because the directory is not taken, and they are published nowhere.
#[tokio::test]
async fn unnamed_commits_on_no_remote_keep_their_checkout_and_are_published_nowhere() {
    let (base, root, wt, mut led) = a_repo_with_an_origin("unnamed-ref").await;
    let bare = base.join("origin.git");
    git(&wt, &["checkout", "-q", "--detach"]).await;
    std::fs::write(wt.join("d.txt"), "d").unwrap();
    git(&wt, &["add", "d.txt"]).await;
    git(&wt, &["commit", "-q", "-m", "d"]).await;
    declare(&mut led, "run-1", &wt);
    led.end_run("run-1", "master", "done").unwrap();

    let forced = force_terminal(
        &mut led,
        "run-1",
        forcing(&root),
        ports(&Table(HostRead::Gone)),
    )
    .await
    .expect("unnamed commits on no remote are kept");
    let WorktreeOutcome::KeptWithWork { why } = &forced.worktree else {
        panic!("expected the checkout kept, got {forced:?}");
    };
    assert!(why.contains("2 commit(s)"), "{why}");
    assert!(wt.join("d.txt").exists());
    assert_eq!(
        git(&root, &["for-each-ref", "refs/forge/kept"]).await,
        "",
        "a ref was written for commits whose checkout stays"
    );
    assert_eq!(on_origin(&bare).await.trim(), "refs/heads/main");
    let _ = std::fs::remove_dir_all(&base);
}

/// A subagent run bound a minute ago and in its first turn: it has no process
/// of its own, and between two of its tool calls nothing has its working
/// directory in the checkout, so the process reading sees nobody there. Its
/// host process is alive, and the checkout is that subagent's work.
#[tokio::test]
async fn a_checkout_a_working_subagent_is_in_is_never_removed() {
    let (base, root, wt, mut led) = a_repo_with_an_origin("live-subagent").await;
    declare(&mut led, "run-1", &wt);
    assert!(led.bind_agent("run-1", "agent-1").unwrap());
    assert!(led.note_host("run-1", 4242, "777").unwrap());

    let refused = force_terminal(
        &mut led,
        "run-1",
        forcing(&root),
        ports(&Table(HostRead::Alive)),
    )
    .await;
    assert!(
        wt.exists(),
        "the release removed the checkout of a subagent working in it, whose host process is \
         alive — a worktree a live agent is using is never removed (FB-273)"
    );
    match refused {
        Err(Error::AgentInTree(why)) => {
            assert!(why.contains("agent-1") && why.contains("4242"), "{why}");
        }
        other => panic!("expected a refusal naming the live subagent, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&base);
}

/// The same subagent once it has ended its turn, or once its host is gone, is
/// released as before: the guard is about a turn in progress.
#[tokio::test]
async fn a_subagent_between_turns_or_without_its_host_is_released() {
    let (base, root, wt, mut led) = a_repo_with_an_origin("ended-subagent").await;
    git(&wt, &["push", "-q", "origin", "iss-23"]).await;
    declare(&mut led, "run-1", &wt);
    assert!(led.bind_agent("run-1", "agent-1").unwrap());
    assert!(led.note_host("run-1", 4242, "777").unwrap());
    let now = runner_core::agent_activity::now_ms();
    assert!(led.note_turn_end("run-1", now, None).unwrap());
    force_terminal(
        &mut led,
        "run-1",
        forcing(&root),
        ports(&Table(HostRead::Alive)),
    )
    .await
    .expect("a subagent that ended its turn is not working in the checkout");
    assert!(!wt.exists());
    let _ = std::fs::remove_dir_all(&base);

    let (base, root, wt, mut led) = a_repo_with_an_origin("hostless-subagent").await;
    git(&wt, &["push", "-q", "origin", "iss-23"]).await;
    declare(&mut led, "run-1", &wt);
    assert!(led.bind_agent("run-1", "agent-1").unwrap());
    assert!(led.note_host("run-1", 4242, "777").unwrap());
    force_terminal(
        &mut led,
        "run-1",
        forcing(&root),
        ports(&Table(HostRead::Gone)),
    )
    .await
    .expect("a subagent whose host process is gone cannot be working");
    assert!(!wt.exists());
    let _ = std::fs::remove_dir_all(&base);
}

/// The release a sweep makes once the run's master has closed it, as `run close` leaves it.
async fn close_and_release(led: &mut Ledger, root: &Path) -> Release {
    led.end_run("run-1", "master", "the master said so")
        .unwrap();
    release(
        led,
        "run-1",
        forcing(root),
        ports(&Table(HostRead::Gone)),
        runner_platform::clock::now_secs(),
    )
    .await
    .expect("the release answers")
}

/// What `git` says at `dir`, trimmed.
async fn said(dir: &Path, args: &[&str]) -> String {
    git(dir, args).await.trim().to_string()
}

/// FB-522, epod 2026-11-05: a master declared a run over its own batch tree, committed and pushed,
/// to read one secret, and the run's release removed that tree. A run declared over a tree that
/// already stood gives back its claim and nothing else: the directory, its branch, its HEAD and
/// its files stay, git still lists it, and the run still closes.
#[tokio::test]
async fn a_tree_that_stood_before_its_run_outlives_the_runs_close() {
    let (base, root, wt, mut led) = a_repo_with_an_origin("adopted-pushed").await;
    git(&wt, &["push", "-q", "origin", "iss-23"]).await;
    let head = said(&wt, &["rev-parse", "HEAD"]).await;
    declare_as(&mut led, "run-1", &wt, TreeOrigin::Adopted);

    let Release::Done(forced) = close_and_release(&mut led, &root).await else {
        panic!("an adopted tree's release is refused rather than made");
    };
    assert!(
        wt.join("b.txt").exists(),
        "the release removed {} — a tree the run did not create is never the release's to take",
        wt.display()
    );
    assert_eq!(forced.worktree, WorktreeOutcome::AdoptedKept);
    assert_eq!(forced.commits, None, "{forced:?}");
    assert_eq!(said(&wt, &["rev-parse", "HEAD"]).await, head);
    assert_eq!(
        said(&wt, &["symbolic-ref", "--short", "HEAD"]).await,
        "iss-23"
    );
    assert!(
        git(&root, &["worktree", "list", "--porcelain"])
            .await
            .contains(&format!("worktree {}", wt.display())),
        "git no longer lists the adopted tree"
    );
    assert!(forced.close.is_closed(), "{:?}", forced.close);
    let row = led.run("run-1").unwrap().unwrap();
    assert_eq!(row.released_as.as_deref(), Some("adopted_kept"));
    assert_eq!(row.worktree_gone_at, None, "the tree is standing");
    let _ = std::fs::remove_dir_all(&base);
}

/// The same with the adopter's work uncommitted in it: nothing is committed onto its branch and
/// nothing is removed — the file is exactly as the master left it.
#[tokio::test]
async fn an_adopted_tree_keeps_its_uncommitted_files_uncommitted() {
    let (base, root, wt, mut led) = a_repo_with_an_origin("adopted-dirty").await;
    std::fs::write(wt.join("notes.txt"), "the master's own, uncommitted").unwrap();
    let head = said(&wt, &["rev-parse", "HEAD"]).await;
    declare_as(&mut led, "run-1", &wt, TreeOrigin::Adopted);

    let Release::Done(forced) = close_and_release(&mut led, &root).await else {
        panic!("an adopted tree's release is refused rather than made");
    };
    assert_eq!(
        std::fs::read_to_string(wt.join("notes.txt"))
            .ok()
            .as_deref(),
        Some("the master's own, uncommitted"),
        "the adopter's uncommitted file is gone"
    );
    assert_eq!(said(&wt, &["status", "--porcelain"]).await, "?? notes.txt");
    assert_eq!(
        said(&wt, &["rev-parse", "HEAD"]).await,
        head,
        "the release committed onto the adopter's branch"
    );
    assert_eq!(forced.worktree, WorktreeOutcome::AdoptedKept);
    let _ = std::fs::remove_dir_all(&base);
}

/// A tree cut for the run, clean and pushed, is the run's to give back, and goes as before.
#[tokio::test]
async fn a_tree_cut_for_its_run_is_still_removed_at_its_close() {
    let (base, root, wt, mut led) = a_repo_with_an_origin("created-pushed").await;
    git(&wt, &["push", "-q", "origin", "iss-23"]).await;
    declare_as(&mut led, "run-1", &wt, TreeOrigin::Created);

    let Release::Done(forced) = close_and_release(&mut led, &root).await else {
        panic!("a clean, pushed tree cut for the run was not released");
    };
    assert_eq!(forced.worktree, WorktreeOutcome::Released);
    assert!(!wt.exists(), "the run's own tree is still on disk");
    let row = led.run("run-1").unwrap().unwrap();
    assert_eq!(row.released_as.as_deref(), Some("gone"));
    let _ = std::fs::remove_dir_all(&base);
}

/// A tree cut for the run that holds a file nobody committed is kept and named, never removed, and
/// the file is left as it was rather than committed under a salvage. The run still closes.
#[tokio::test]
async fn a_cut_tree_with_an_uncommitted_file_is_kept_and_named() {
    let (base, root, wt, mut led) = a_repo_with_an_origin("created-dirty").await;
    git(&wt, &["push", "-q", "origin", "iss-23"]).await;
    std::fs::write(wt.join("c.txt"), "uncommitted").unwrap();
    declare_as(&mut led, "run-1", &wt, TreeOrigin::Created);

    let Release::Done(forced) = close_and_release(&mut led, &root).await else {
        panic!("a dirty tree's release is refused rather than kept");
    };
    assert!(
        wt.join("c.txt").exists(),
        "the release removed a tree holding an uncommitted file"
    );
    let WorktreeOutcome::KeptWithWork { why } = &forced.worktree else {
        panic!("the dirty tree was not kept and named: {forced:?}");
    };
    assert!(why.contains("c.txt"), "{why}");
    assert_eq!(said(&wt, &["status", "--porcelain"]).await, "?? c.txt");
    assert!(
        !git(&root, &["log", "--format=%s", "iss-23"])
            .await
            .contains("wip(salvage)"),
        "the release committed the file under a salvage"
    );
    assert!(forced.close.is_closed(), "{:?}", forced.close);
    let row = led.run("run-1").unwrap().unwrap();
    assert_eq!(row.released_as.as_deref(), Some("kept_with_work"));
    assert!(row.ended_by.is_some());
    let _ = std::fs::remove_dir_all(&base);
}

/// A tree cut for the run whose commit `origin` has not seen is kept and named the same way.
#[tokio::test]
async fn a_cut_tree_with_a_commit_on_no_remote_is_kept_and_named() {
    let (base, root, wt, mut led) = a_repo_with_an_origin("created-unpushed").await;
    declare_as(&mut led, "run-1", &wt, TreeOrigin::Created);

    let Release::Done(forced) = close_and_release(&mut led, &root).await else {
        panic!("an unpushed tree's release is refused rather than kept");
    };
    assert!(
        wt.exists(),
        "the release removed a tree holding an unpushed commit"
    );
    let WorktreeOutcome::KeptWithWork { why } = &forced.worktree else {
        panic!("the unpushed tree was not kept and named: {forced:?}");
    };
    assert!(why.contains("1 commit"), "{why}");
    assert_eq!(
        led.run("run-1").unwrap().unwrap().released_as.as_deref(),
        Some("kept_with_work")
    );
    let _ = std::fs::remove_dir_all(&base);
}
