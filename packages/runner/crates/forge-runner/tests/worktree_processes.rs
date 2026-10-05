//! The issue's own reproduction, against real processes and a real checkout.
//!
//! Every other test of this behaviour plants a `/proc` and a hand that signals
//! nothing, which proves the reading and the order and says nothing about
//! whether a signal this box really sends reaches a process really living in a
//! worktree. The state ISS-1271 was filed from is a process that outlived its
//! tree, and only a real one can be watched not outliving it.
//!
//! It is its own test binary because it makes real children and really kills
//! them: a child left behind by a panicking case would be reaped by this
//! process's exit rather than by another test's.
//!
//! Every child is made through [`Kept`], which takes it on the way out however
//! this case leaves. Measured while this test was being written: a case that
//! panicked before its own `wait` left `sleep 100000` and a trapping `sh`
//! running, each holding the harness's captured stdout open, and `cargo test`
//! then waited on a pipe nothing would ever close — a red case read as a hung
//! run. A test about processes outliving their owner cannot be one that does
//! it.
//!
//! # The one platform this file can speak for
//!
//! The reading below is `living_in`, and it walks `/proc` directly rather than
//! calling `residents_of` — the whole point of a real reproduction is a
//! measurement the code under test did not produce. `/proc` is Linux's, so
//! this file runs on Linux and nowhere else: on a box with no such table this
//! reading cannot be taken at all, which is `residents_of`'s own `NoTable`
//! case, priced in this issue's plan as a gap that stays open until the first
//! orphan is observed on a non-Linux box. A `cfg` that leaves the file
//! uncompiled there is what that price already buys: `cargo test` shows
//! nothing standing in for a claim that was never measured, neither a pass
//! earned by skipping the read nor a failure this platform cannot help. What
//! `residents_of` and `end_residents` do with a planted `/proc` is proved
//! platform-independently by this crate's own unit tests, which this file
//! does not repeat.

#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use forge_runner_core::test_scratch::Scratch;
use forge_runner_core::workspace::worktree;

/// Every pid on this box whose working directory is `at` or lies beneath it,
/// read the way the issue's measurement reads it and not through the code
/// under test — a reading taken with `residents_of` would pass whatever that
/// function did.
fn living_in(at: &Path) -> Vec<u32> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        panic!("this test measures nothing on a box with no /proc");
    };
    for e in entries.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(raw) = std::fs::read_link(e.path().join("cwd")) else {
            continue;
        };
        let text = raw.to_string_lossy();
        let base = Path::new(text.strip_suffix(" (deleted)").unwrap_or(&text)).to_path_buf();
        if base == at || base.starts_with(at) {
            found.push(pid);
        }
    }
    found.sort_unstable();
    found
}

/// A named pipe nobody ever writes to.
fn mkfifo(at: &Path) {
    let out = Command::new("mkfifo")
        .arg(at)
        .output()
        .expect("mkfifo runs");
    assert!(
        out.status.success(),
        "mkfifo {}: {}",
        at.display(),
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Whether this pid names a process that is still RUNNING.
///
/// A pid entry is not the answer: this test is the children's parent and has
/// not waited for them, so a child that has gone leaves a zombie behind, whose
/// `/proc/<pid>` directory is there and whose `kill(0)` succeeds. Written out
/// here rather than called from the crate: a liveness reading that asked the
/// code under test would pass whatever that code did.
fn still_running(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    // The command sits in parens and may hold spaces and parens of its own.
    stat.rsplit_once(") ")
        .and_then(|(_, rest)| rest.split(' ').next())
        .is_some_and(|state| state != "Z")
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A repository with one commit and one linked worktree cut from it.
fn a_repo_with_a_worktree(root: &Path) -> (PathBuf, PathBuf) {
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).expect("a repository");
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "t@example.invalid"]);
    git(&repo, &["config", "user.name", "t"]);
    std::fs::write(repo.join("a"), "a\n").expect("a file");
    git(&repo, &["add", "a"]);
    git(&repo, &["commit", "-qm", "one"]);
    let wt = repo.join(".claude/worktrees/iss-1271");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            &wt.to_string_lossy(),
            "-b",
            "iss-1271",
        ],
    );
    (repo, wt)
}

/// A child whose working directory is the checkout, and which has exactly no
/// children of its own.
///
/// No child of a child, deliberately: a `while :; do sleep 1; done` respawns
/// its `sleep` after each one is signalled, so the tree grows a resident the
/// reading never saw and the case turns on which of them the clock caught —
/// a case that fails one way and passes the other proves nothing either way.
///
/// `traps` makes it ignore `SIGTERM`. `read` is a shell builtin and a fifo
/// nobody writes to blocks it for ever, so the process waits without spawning
/// anything and without spinning a core while it waits.
///
/// The trapping one touches `ready` AFTER installing the trap and before it
/// blocks. Residence alone would not do: a shell that has entered the checkout
/// but has not yet run `trap` dies on the SIGTERM this removal sends, the case
/// then fails its SIGKILL assertion, and a case that fails on the scheduler
/// rather than on the source says nothing about either (consult 8064e5 F3).
fn a_child_in(wt: &Path, fifo: &Path, ready: &Path, traps: bool) -> Kept {
    if !traps {
        return Kept(
            Command::new("sleep")
                .arg("100000")
                .current_dir(wt)
                .spawn()
                .expect("a child in the checkout"),
        );
    }
    Kept(
        Command::new("sh")
            .arg("-c")
            .arg(format!(
                "trap '' TERM; : > {}; read x < {}",
                ready.display(),
                fifo.display()
            ))
            .current_dir(wt)
            .spawn()
            .expect("a child in the checkout that will not be asked"),
    )
}

/// Block until `ready` is there, or say what was never established.
///
/// A deadline rather than a wait without one: a child that never installs its
/// trap is a broken fixture, and a fixture that hangs is read as a hung run
/// rather than as the red it is.
fn wait_for(ready: &Path) {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !ready.exists() {
        assert!(
            std::time::Instant::now() < until,
            "the trapping child never reported its trap installed ({}), so nothing below would \
             be measuring what it claims",
            ready.display()
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// A child this file made, taken on the way out however the case leaves.
struct Kept(Child);

impl Kept {
    fn pid(&self) -> u32 {
        self.0.id()
    }
}

impl Drop for Kept {
    fn drop(&mut self) {
        // Already reaped by a passing case: `kill` on a waited pid is a pid
        // this process no longer owns, and `wait` returns at once.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn a_removal_ends_the_processes_living_in_the_checkout_and_leaves_none_behind() {
    let scratch = Scratch::new("wt1271");
    let (repo, wt) = a_repo_with_a_worktree(scratch.path());

    let fifo = scratch.join("blocks-for-ever");
    mkfifo(&fifo);
    let ready = scratch.join("the-trap-is-installed");
    let mut plain = a_child_in(&wt, &fifo, &ready, false);
    let mut stubborn = a_child_in(&wt, &fifo, &ready, true);
    let (plain_pid, stubborn_pid) = (plain.pid(), stubborn.pid());

    // The control, in two halves. Without the first, a green below proves
    // nothing: a removal that ended nothing reads the same as one that had
    // nothing to end. Without the second, the SIGKILL assertion turns on which
    // of the shell and the signal got there first.
    wait_for(&ready);
    let before = living_in(&wt);
    assert!(
        before.contains(&plain_pid) && before.contains(&stubborn_pid),
        "both children are living in {} before the removal, or this test measures nothing: \
         {before:?} (plain {plain_pid}, stubborn {stubborn_pid})",
        wt.display()
    );

    let removal = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime")
        .block_on(worktree::remove_at(
            &repo.to_string_lossy(),
            &wt,
            "the test that proves ISS-1271",
        ));
    assert!(removal.is_ok(), "the removal: {removal:?}");

    assert!(
        !still_running(plain_pid),
        "the process that was asked to go is gone, not left bound to whatever it held"
    );
    assert!(
        !still_running(stubborn_pid),
        "and so is the one that ignored being asked — SIGTERM alone is what left a next-server \
         on *:3098 three days past the close of its issue"
    );
    assert_eq!(
        living_in(&wt),
        Vec::<u32>::new(),
        "the reading the issue was measured by comes back empty for this checkout"
    );
    // The same reading, over the path with the kernel's annotation on it: a
    // process whose cwd went from under it reads as `<path> (deleted)`, which
    // is exactly the twenty-odd processes this issue was filed over and exactly
    // what an assertion comparing raw link text would miss.
    assert!(
        !wt.exists(),
        "and the directory itself went, which is what the removal was for"
    );

    // Both are already dead, so these return at once and reap the zombies this
    // test's own parenthood left. The signal each carries is the finer claim:
    // one went on being asked and one had to be taken, which is the whole
    // difference between a removal that only says please and this one.
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(
        plain.0.wait().expect("the child is reaped").signal(),
        Some(libc_sigterm()),
        "a process that honours SIGTERM is asked, not taken"
    );
    assert_eq!(
        stubborn.0.wait().expect("the child is reaped").signal(),
        Some(libc_sigkill()),
        "and one that will not be asked is taken, which is what a removal owed the port it was \
         holding"
    );
}

/// The two signal numbers, named here rather than pulled from a dependency
/// this test binary does not otherwise need. They are fixed by POSIX on every
/// platform this file compiles for.
fn libc_sigterm() -> i32 {
    15
}

fn libc_sigkill() -> i32 {
    9
}

/// ISS-1378's half of the same reproduction: a gate a live agent started is
/// living in the checkout, and the removal leaves it running and the checkout
/// standing, whatever the ledger said about the run that held it.
///
/// The agent is a shell run under the name `claude`, which is how the box
/// recognises a Claude Code process by its arguments. It stays outside the
/// checkout and a subshell of it enters and becomes the gate, so the gate
/// runs BENEATH it as a real tool call's process does. It is this test's child and never an
/// ancestor of this test, so the reading cannot take it for the reaper's own.
#[test]
fn a_removal_leaves_a_live_agents_gate_running_and_its_checkout_standing() {
    let scratch = Scratch::new("wt1378");
    let (repo, wt) = a_repo_with_a_worktree(scratch.path());
    let bin = scratch.join("bin");
    std::fs::create_dir_all(&bin).expect("a bin directory");
    let claude = bin.join("claude");
    std::os::unix::fs::symlink("/bin/sh", &claude).expect("a process named claude");

    let mut agent = Kept(
        Command::new(&claude)
            .arg("-c")
            .arg(format!("(cd {} && exec sleep 100000); :", wt.display()))
            .current_dir(scratch.path())
            .spawn()
            .expect("an agent running a gate in the checkout"),
    );
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let gate = loop {
        // Exactly one resident, and it is not the agent: the subshell that
        // entered the checkout became the gate, and the agent itself never
        // stood there.
        if let [pid] = living_in(&wt)[..] {
            assert_ne!(
                pid,
                agent.pid(),
                "the gate is beneath the agent, not the agent"
            );
            break pid;
        }
        assert!(
            std::time::Instant::now() < until,
            "the agent's gate never entered {}, so nothing below would measure what it claims",
            wt.display()
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    // The gate is the agent's child and not this test's, so taking the agent
    // leaves it orphaned and holding the harness's stdout, which is the hung
    // run this file's header describes. It is taken by pid on the way out.
    let _gate = Grandchild(gate);

    let removal = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime")
        .block_on(worktree::remove_at(
            &repo.to_string_lossy(),
            &wt,
            "the ledger reads its run as ended",
        ));
    let said = removal
        .expect_err("a live agent's checkout is not given back")
        .to_string();

    assert!(
        still_running(gate),
        "the gate runs on, which is the run's own work: {said}"
    );
    assert!(wt.is_dir(), "and its checkout stands: {said}");
    assert!(
        said.contains(&format!("pid {gate}")) && said.contains("beneath Claude Code pid"),
        "and the refusal names it and the agent it runs beneath: {said}"
    );
    let _ = agent.0.kill();
    let _ = agent.0.wait();
}

/// A process this test's child made, taken by pid however the case leaves.
struct Grandchild(u32);

impl Drop for Grandchild {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-9", &self.0.to_string()])
            .status();
    }
}
