//! FB-273, against real repositories: a reclaim over a run whose subagent is
//! working, and over commits a local branch already names.
//!
//! Measured on this box 2026-10-23 (forge-runner 3332976): a run declared over
//! a closed issue was reclaimed by `Kill` a minute after its subagent bound.
//! The release pushed the run's branch to `origin`, a customer's GitLab, though
//! it read `commits Some(AlreadyNamed)`, and removed the checkout the subagent
//! was working in.

use super::*;
use runner_core::ledger::NewRun;
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
    led.create_run_group(NewRun {
        run_id: run_id.into(),
        project_id: "proj-1".into(),
        master_session_id: "master-1".into(),
        worktree_path: wt.to_path_buf(),
        boot_id: "boot-1".into(),
        issue_keys: vec!["ISS-23".into()],
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

/// The commits are on `iss-23`, a branch this repository keeps, so the
/// release has nothing to preserve and nothing to publish. It used to push the
/// branch to `origin` first.
#[tokio::test]
async fn a_release_publishes_nothing_a_local_branch_already_names() {
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
    .expect("a clean checkout whose commits a branch names is released");
    assert_eq!(forced.commits, Some(Commits::AlreadyNamed));
    assert!(
        !on_origin(&bare).await.contains("refs/heads/iss-23"),
        "the release pushed `iss-23` to origin although a local branch already named its commits \
         — a reclaim never publishes what is already preserved (FB-273)"
    );
    assert!(!wt.exists(), "released");
    let _ = std::fs::remove_dir_all(&base);
}

/// A dirty checkout's diff is committed onto its own branch, which names it,
/// and goes nowhere else.
#[tokio::test]
async fn a_salvaged_diff_is_committed_locally_and_never_pushed() {
    let (base, root, wt, mut led) = a_repo_with_an_origin("salvage-no-push").await;
    let bare = base.join("origin.git");
    std::fs::write(wt.join("c.txt"), "uncommitted").unwrap();
    declare(&mut led, "run-1", &wt);
    led.end_run("run-1", "master", "done").unwrap();

    let forced = force_terminal(
        &mut led,
        "run-1",
        forcing(&root),
        ports(&Table(HostRead::Gone)),
    )
    .await
    .expect("a diff committed onto its branch is preserved");
    assert_eq!(
        forced.salvage.map(|s| s.outcome),
        Some(salvage::Outcome::Committed)
    );
    assert!(
        !on_origin(&bare).await.contains("refs/heads/iss-23"),
        "the salvage pushed `iss-23` to origin — a reclaim never publishes (FB-273)"
    );
    let kept = git(&root, &["log", "--format=%s", "iss-23"]).await;
    assert!(kept.contains("wip(salvage)"), "{kept}");
    let _ = std::fs::remove_dir_all(&base);
}

/// A detached checkout's commits are given a ref of their own in this
/// repository, and are published nowhere.
#[tokio::test]
async fn unnamed_commits_are_named_by_a_local_ref_not_a_push() {
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
    .expect("unnamed commits are given a ref and released");
    let Some(Commits::NamedBy(name)) = forced.commits else {
        panic!("expected a kept ref, got {:?}", forced.commits);
    };
    assert!(name.starts_with("refs/forge/kept/run-1-"), "{name}");
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
