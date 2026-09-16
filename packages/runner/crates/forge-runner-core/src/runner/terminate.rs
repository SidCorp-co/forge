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
// cm:guard the verb follows from `incarnation` and a caller cannot pass one: `Abandon` over a live process leaves an agent writing git into a tree the record has released, and that is the one outcome neither verb may produce (criterion 32).
// cm:guard a LIVE row from another boot is `Unknown`, not `Abandon`, and it is refused by name — criterion 35 permits no reclamation from unknown. Its pid means nothing after a reboot, so killing it could signal a stranger's process, while abandoning it would release a worktree on a claim nobody checked. `daemon/recovery.rs` resolves the boot first.
// cm:guard the parked state is `Incarnation::Exited`, which is what ISS-964's criteria call `none` — `declare_parked_human` writes `exited` and the ledger's enum has no `none` at all. Anything written here against the criteria's word instead of the column's would match no run on any box.
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
// cm:guard read from git, never derived from the path: `workspace::worktree::path` SANITIZES the branch into the directory name, so a branch containing a character sanitize rewrites would produce a name `salvage::pick_target` matches against nothing — and pick_target matching nothing reports `refused`, which this module turns into a refusal of the whole verb.
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

// cm:guard this answers ONE question — did salvage get the uncommitted diff into a commit — and it
// deliberately no longer answers whether that commit is safe. It used to: `committed_not_pushed`
// counted as preserved because `git worktree remove` leaves the branch ref and its objects in the
// shared `.git`, so the commits outlive the checkout. That is true and is still true, and it is
// about THIS box. ISS-1050 is about the commit being lost WITH the box — a master's death taking
// its issues with it is the whole subject — and a commit no remote has is exactly the record that
// dies with the machine. Durability is now asked separately, of the remote, by
// `publication_of` below, and this predicate is only the first half of the answer.
// cm:guard `none` still does not count: it is reachable here only when salvage found nothing to
// commit in a tree `holds_work` had just said was holding some, which is a disagreement between two
// readers and no basis for deleting anything.
fn committed(outcome: Outcome) -> bool {
    matches!(outcome, Outcome::Pushed | Outcome::CommittedNotPushed)
}

/// Put this checkout's commits somewhere other than this box, or refuse the release.
///
/// Answers `Ok(())` only when a fresh fetch says every commit here is on a remote.
// cm:guard the refusal leaves the tree, leaves the run non-terminal, and names the commits at
// risk. That is a real cost — the issue stays unavailable to every box until somebody acts — and it
// is taken deliberately: releasing instead declares the run over while its only copy is on one
// machine, and the next box picks the issue up with none of the work. The cost is bounded by the
// two things that make this different from a silent hold: the master sweep retries it every thirty
// seconds, so a network that comes back releases the tree with no human at all, and the box-side
// report puts the held tree and this message on the issue, so a network that does not come back is
// somebody's to see rather than nobody's.
// cm:guard `Unknown` refuses too. A box that cannot reach its remote has not learned that its work
// is safe; it has learned nothing, and releasing on nothing is the same act as releasing on a
// commit only that box can see.
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
// cm:guard the ORDER is preserve → release the worktree → close the marks → `end_run`, and `end_run` is last because it is what un-holds the tree: `Ledger::held_worktrees` is `ended_by IS NULL`, so writing it earlier lets a worktree-reap tick delete, inside that window, exactly the diff criterion 33 says must survive. Every test here would still pass, because none of them runs a reaper between two writes.
// cm:guard a preserve that was REFUSED or FAILED aborts before the worktree is touched, and the run stays non-terminal on purpose: a partial abandon that released anyway is a lost diff wearing a success, and the operator can retry this verb once the fault salvage named is fixed.
// cm:guard the three marks are `close_loop::close`'s to set and are NOT written here — each is set by reading the world back, so a verb that stamped them would be the master's declaration this repo replaced (ISS-933 criterion 13, criterion 37's one writer per resource).
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
    // cm:guard the run's OWN tree is probed first, with the reaper's own reader, and salvage is called only when that says there is something to lose. Handing every abandon to salvage looked equivalent and is not: `pick_target` answers `refused` when it finds dirt it cannot attribute, so a CLEAN park would have been refused because some stranger's worktree on the same box was dirty.
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
        // cm:guard the refusal is conditioned on the tree STILL holding uncommitted work, asked of that tree directly. Salvage answers `none` both when it could not preserve a diff and when there was no diff to preserve — a clean checkout carrying commits of its own arrives as the second, and reading it as the first refuses the release forever: the tree stays, the run never reaches terminal, and its issue is unavailable to every box. Measured on forge-vm 2026-09-11, six runs sat there. A removal cannot lose a commit, so a clean tree is safe to release whatever salvage made of it.
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
        // cm:guard a tree holding nothing UNCOMMITTED is still asked whether what it holds is
        // published, and this is where the real hole was. An agent that committed its work and
        // never pushed leaves a CLEAN checkout, so `holds_work` is false, salvage never runs, no
        // push is ever attempted, and the tree was removed as though the work had been published.
        // The commits did survive on this box, which is what the old reading was right about — and
        // nothing ever put them anywhere else.
        // cm:guard the SAME `None` as the salvage path thirty lines above, and it is a refusal here
        // for the same reason: a branch this box cannot read is a checkout whose publication cannot
        // be asked about, and removing it anyway spends the one thing `publish_before_release`
        // exists to check. It read `if let Some(branch)` until ISS-1050 finding F9 — the publish was
        // skipped and the removal happened regardless, silently, on a path whose whole subject is
        // work that only looks published because `@{u}` is a local memory of a push.
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

    // cm:guard the verb is derived, and these four cases are the four states criterion 32 names. A caller-chosen verb is what this refuses to allow, so the mapping is asserted directly rather than only through `force_terminal`.
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

    // cm:guard a LIVE row from a FOREIGN boot is refused by name rather than being read as either verb: its pid names whatever the kernel has since reused, so `Kill` could signal a stranger and `Abandon` would release a worktree on a claim nobody checked (criterion 35).
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
        // cm:guard the diff is STAGED, because that is what makes this tree hold work under the one definition both readers share: an untracked file does not, or every build artifact would pin a checkout forever. Until 2026-09-11 this test reached salvage through the branch having no upstream instead, which is not what it is about.
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
        // cm:guard no process is signalled on the abandon path — there is none by definition, and a kill here would mean the verb was chosen without reading the state.
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

    // cm:guard the file `git has never been told about`, which is the case ISS-1050 criterion 19
    // names and finding F8 found open. The fixture deliberately does NOT stage `work.txt`: an
    // agent's new file is untracked until somebody adds it, and `--untracked-files=no` made
    // `holds_work` answer false over it, so salvage never ran and `remove_at` took the only copy.
    // The sibling test above reaches salvage by staging first, which is why this one had to exist.
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

    // cm:guard the SILENT half of the same door, and it is finding F9. Thirty lines apart the same
    // `None` from `branch_of` was a hard refusal naming the tree on the salvage path and a skipped
    // publish on the clean one. The clean path is where it costs the most: `holds_work` is false
    // because `@{u}` and the remote-tracking refs are a MEMORY of a push, and the fresh fetch inside
    // `publish_before_release` is the only thing that re-asks — so skipping it removed the checkout
    // on the strength of the very memory the publication check exists to distrust.
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

    // cm:guard THE ordering hazard    // cm:guard THE ordering hazard, and it cannot be caught by any assertion on the end state: `held_worktrees` is `ended_by IS NULL`, so a reap tick between `end_run` and the release would delete the diff. Read from the SOURCE because what is under test is the order of two statements, and both orders produce the same final row.
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

    // cm:guard a preserve that FAILED must abort the verb before the worktree is touched, asserted with no branching on the outcome: the earlier version of this test accepted either answer, which made it a test that could not fail — a mutation widening `preserved` to admit `refused` left it green.
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

    // cm:guard a CLEAN park is released, and this is the case that caught a real defect: handing every abandon to salvage looked equivalent, but `pick_target` answers `refused` on dirt it cannot attribute, so a clean park was refused because a STRANGER's worktree on the same box was dirty.
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

    // cm:guard a run whose worktree is already off the disk must still reach terminal, and with no salvage attempted — that is the shape a box comes back to after someone removed a tree by hand, and a verb that needed the tree to exist would leave the run open forever.
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

    // cm:guard the marks are `close_loop`'s and this verb writes none of them itself. A verb that stamped `session_terminal_at` would be exactly the master's declaration ISS-933 replaced with a read-back.
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
    // cm:guard released by the PATH the ledger recorded. A path rebuilt from the branch made git answer `is not a working tree`, the release errored, and the run stayed open forever — three of them on forge-vm on 2026-09-11, one `.worktrees/ISS-972` carrying branch `ISS-972-uploads-inertness-claim`.
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
    // cm:guard this is the ONLY state that reaches the clean-checkout branch of the release, and
    // building it took a planted counterexample that passed to notice. `holds_work` already asks
    // whether HEAD is on a remote, so a clean tree with plainly unpushed commits goes down the
    // salvage path instead — the clean branch is reached only when the box's own refs SAY the work
    // is published. That is precisely the case a push exit code cannot be trusted for, and it is
    // why the check fetches with `--prune` rather than reading what this box last saw.
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
    // cm:guard this is the case the release rule exists for, and it costs something real — the
    // issue is unavailable to every box until somebody acts. That is deliberate. Releasing instead
    // declares the run over while its only copy is on this machine, and the next box picks the
    // issue up with none of the work and no way to know any existed (ISS-1050 criterion 21).
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
    // cm:guard not knowing is NOT the same as knowing the work is safe, and the two must not
    // collapse into one another. A box whose network is down has learned nothing about durability;
    // releasing on that is releasing on a commit only this box can see, by a longer road.
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
    // cm:guard salvage reports `none` for this tree because there was nothing uncommitted to
    // commit, and until 2026-09-11 that was read as a failed preserve and refused forever — six
    // runs on forge-vm. Releasing it is still right and this test still asserts it.
    // cm:guard what changed in ISS-1050 is the last assertion, and the old version of this test did
    // not make it: it proved the commit was still reachable on the branch IN THIS REPO after the
    // checkout was gone, which is a fact about this box. Nothing here ever pushed, so a clean
    // checkout whose work had never been published was released as though it had been — the
    // commits survived exactly as long as the machine did. The release now publishes first, and the
    // assertion is against the REMOTE.
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
