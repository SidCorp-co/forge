//! A removal over a checkout a live agent works in (ISS-1378, ported to the
//! split crates), over a planted process table.
#![cfg(unix)]

use super::*;
use std::sync::Mutex;

struct Scratch(PathBuf);
impl Scratch {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "forge-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A process as `/proc` shows one: where it works, and what it runs.
fn plant(proc: &Path, pid: u32, cwd: &Path, cmd: &str) {
    let dir = proc.join(pid.to_string());
    std::fs::create_dir_all(&dir).unwrap();
    std::os::unix::fs::symlink(cwd, dir.join("cwd")).unwrap();
    std::fs::write(dir.join("cmdline"), cmd.replace(' ', "\0")).unwrap();
    std::fs::write(dir.join("status"), "Name:\tx\nPPid:\t1\n").unwrap();
}

fn parent(proc: &Path, pid: u32, ppid: u32) {
    std::fs::write(
        proc.join(pid.to_string()).join("status"),
        format!("Name:\tx\nPPid:\t{ppid}\n"),
    )
    .unwrap();
}

/// A hand that records what it was asked to signal and takes the pid off
/// the planted table, as a process that obeys would leave it.
struct Ends<'a> {
    proc: &'a Path,
    sent: Mutex<Vec<u32>>,
}
impl Hand for Ends<'_> {
    fn signal(&self, pid: u32, _sig: Sig) -> std::result::Result<(), String> {
        self.sent.lock().unwrap().push(pid);
        let _ = std::fs::remove_dir_all(self.proc.join(pid.to_string()));
        Ok(())
    }
    fn present(&self, pid: u32) -> bool {
        self.proc.join(pid.to_string()).exists()
    }
    fn identity(&self, _pid: u32) -> Option<String> {
        None
    }
}

const NO_WAIT: Grace = Grace {
    after_term: Duration::ZERO,
    after_kill: Duration::ZERO,
};

fn cleared(proc: &Path, wt: &Path) -> (Ending, Vec<u32>) {
    let hand = Ends {
        proc,
        sent: Mutex::new(Vec::new()),
    };
    let clearing = Clearing {
        proc_root: proc,
        grace: NO_WAIT,
        hand: &hand,
    };
    let outcome = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(clearing.clear(wt));
    let sent = hand.sent.lock().unwrap().clone();
    (outcome, sent)
}

/// A live agent's gate, and the stranger living beside it, are both left
/// alone, and the checkout is refused by name.
#[test]
fn a_resident_beneath_a_live_agent_refuses_the_removal_and_nothing_is_signalled() {
    let s = Scratch::new("wtproc-agent");
    let (proc, wt) = (s.0.join("proc"), s.0.join("wt"));
    std::fs::create_dir_all(&wt).unwrap();
    plant(&proc, 801, &wt, "node jest");
    parent(&proc, 801, 800);
    plant(&proc, 800, Path::new("/"), "bash -c pnpm test");
    parent(&proc, 800, 777);
    plant(
        &proc,
        777,
        Path::new("/"),
        "/home/someone/.local/share/claude/versions/2.1.289",
    );
    plant(&proc, 802, &wt, "next-server");

    let (outcome, sent) = cleared(&proc, &wt);
    assert!(
        sent.is_empty(),
        "a live agent's work was signalled: {sent:?}"
    );
    let Verdict::Refuse(why) = outcome.verdict(&wt) else {
        panic!("a live agent's checkout was cleared to be taken: {outcome:?}");
    };
    assert!(
        why.contains("pid 801") && why.contains("Claude Code pid 777"),
        "the refusal names the agent and its work: {why}"
    );
}

/// Residents beneath no Claude Code process are still ended (ISS-1271).
#[test]
fn residents_beneath_no_agent_are_still_ended() {
    let s = Scratch::new("wtproc-orphan");
    let (proc, wt) = (s.0.join("proc"), s.0.join("wt"));
    std::fs::create_dir_all(&wt).unwrap();
    plant(&proc, 811, &wt, "next-server");
    plant(&proc, 812, &wt, "node server.js");
    parent(&proc, 812, 810);
    plant(
        &proc,
        810,
        Path::new("/"),
        "/usr/lib/systemd/systemd --user",
    );

    let (outcome, sent) = cleared(&proc, &wt);
    assert!(
        matches!(&outcome, Ending::Clear { ended, .. } if ended.len() == 2),
        "{outcome:?}"
    );
    assert_eq!(sent, vec![811, 812]);
}

/// The walk stops at the reaper's own ancestry: a Claude Code process this
/// process runs under is not an agent living in the checkout.
#[test]
fn a_claude_code_process_the_reaper_runs_under_is_not_an_agent_in_the_tree() {
    let s = Scratch::new("wtproc-ours");
    let (proc, wt) = (s.0.join("proc"), s.0.join("wt"));
    std::fs::create_dir_all(&wt).unwrap();
    let me = std::process::id();
    plant(&proc, me, Path::new("/"), "cargo test");
    parent(&proc, me, 950);
    plant(&proc, 950, Path::new("/"), "claude");
    plant(&proc, 821, &wt, "sleep 100000");
    parent(&proc, 821, 950);

    let (outcome, sent) = cleared(&proc, &wt);
    assert!(
        matches!(&outcome, Ending::Clear { ended, .. } if ended.len() == 1),
        "{outcome:?}"
    );
    assert_eq!(sent, vec![821]);
}

/// An ancestor whose arguments cannot be read is one nobody can say is
/// not an agent: the removal is refused and nothing signalled.
#[test]
fn an_ancestor_nobody_can_identify_refuses_the_removal_unsignalled() {
    let s = Scratch::new("wtproc-noargs");
    let (proc, wt) = (s.0.join("proc"), s.0.join("wt"));
    std::fs::create_dir_all(&wt).unwrap();
    plant(&proc, 841, &wt, "node jest");
    parent(&proc, 841, 840);
    std::fs::create_dir_all(proc.join("840/cmdline")).unwrap();
    std::fs::write(proc.join("840/status"), "Name:\tx\nPPid:\t1\n").unwrap();

    let (outcome, sent) = cleared(&proc, &wt);
    assert!(sent.is_empty(), "{sent:?}");
    let Verdict::Refuse(why) = outcome.verdict(&wt) else {
        panic!("an ancestor nobody could identify was read as nobody's: {outcome:?}");
    };
    assert!(why.contains("pid 840"), "{why}");
}
