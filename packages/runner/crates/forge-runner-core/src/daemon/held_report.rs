//! Say on the issue when this box is holding a checkout nothing else has.
//!
//! `runner/terminate.rs` refuses to release a worktree when it cannot establish
//! that the commits there are named by some ref that outlives the directory.
//! That refusal is correct and it is silent: the tree stays, the run stays
//! open, and the only record is a `tracing::warn` in this box's journal. A hold
//! nobody can see is the same shape as the failure this whole issue is about —
//! work that exists and no surface says so.
//!
//! Which question that is matters, and this module got it wrong for a while.
//! It asked `salvage::publication_of` — is the work on a remote — and wrote
//! "run X keeps <path>" off the answer. The release stopped turning on that at
//! ISS-1188 and turns on `salvage::fate_of` instead, so this module was saying
//! "keeps" about directories the release removed seconds later, and did, twice
//! in one day (ISS-1250). The directory's fate is read from the predicate the
//! release reads; publication is still reported, because work on no remote is
//! exactly the thing this module exists to surface, but it is reported as what
//! it is and never as a decision to keep anything.
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
use crate::workspace::repo_cred::RepoCred;
use crate::workspace::salvage::{self, Fate, Publication};

/// What the box says about a checkout it is keeping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    pub worktree: String,
    pub branch: Option<String>,
    pub head: String,
    pub commits_unpushed: Option<u32>,
    pub reason: String,
    /// Whether the reading this report took REFUSES the checkout's removal.
    /// Not part of what core declares, and not sent.
    ///
    /// It is one half of the release's decision and never the whole of it:
    /// `false` says retention does not hold the directory here, not that the
    /// directory goes. `runner/terminate.rs` preserves a repository's own main
    /// working tree whatever retention says, and refuses a checkout whose diff
    /// it could not preserve, so a report that read `false` as "released" would
    /// be making the opposite mistake to the one this issue is about
    /// (consult 754b50 F1).
    pub kept: bool,
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

pub async fn at_risk(run: &Run, cred: &RepoCred) -> Option<Held> {
    let worktree = run.worktree_path.as_path();
    if !worktree.is_absolute() || !worktree.exists() {
        return None;
    }
    let head = git_line(worktree, &["rev-parse", "HEAD"]).await?;
    let branch = git_line(worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
    let fate = salvage::fate_of(worktree).await;
    let publication = salvage::publication_of(worktree, cred).await;
    let kept = matches!(fate, Fate::Kept { .. });
    if !kept && publication == Publication::Published {
        return None;
    }
    Some(Held {
        worktree: worktree.display().to_string(),
        branch,
        head,
        commits_unpushed: match &publication {
            Publication::Unpublished { commits } => Some(*commits),
            _ => None,
        },
        reason: why(&fate, &publication),
        kept,
    })
}

/// One sentence carrying both facts, in the order a reader needs them: what
/// this box's reading says about the directory first, because that is what the
/// last one of these got wrong, then what is true of the work.
///
/// Every clause here is an observation and none is an outcome. What becomes of
/// the directory is the release's to say and `worktree::remove_at`'s to log:
/// this pass runs before it, reads one half of what it decides on, and a
/// sentence promising a removal would be the same defect wearing the other
/// face (consult 754b50 F1, F2).
fn why(fate: &Fate, publication: &Publication) -> String {
    let directory = match fate {
        Fate::Kept { why } => format!(
            "this box keeps this checkout: it cannot tell whether the commits here are named by \
             any ref besides this checkout's own HEAD ({why}), and not knowing is not the same as \
             knowing it is safe"
        ),
        Fate::NeedsARef { commits } => format!(
            "{commits} commit(s) here are named by this checkout's HEAD and by nothing else, so a \
             release must give them a ref of their own before it may take this directory"
        ),
        Fate::Named => "the commits here are named by a ref this repository keeps, so they do not \
                        depend on this directory"
            .to_string(),
    };
    let work = match publication {
        Publication::Published => "the work here is on a remote".to_string(),
        Publication::Unpublished { commits } => format!(
            "{commits} commit(s) here are on no remote, and the push to publish them did not land"
        ),
        Publication::Unknown { why } => {
            format!("this box cannot tell whether the work here is on a remote ({why})")
        }
    };
    format!("{work} — {directory}")
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
        let cred = RepoCred::of(run.project_id.as_deref(), &run.worktree_path).await;
        let Some(held) = at_risk(&run, &cred).await else {
            continue;
        };
        match reporter.report(&session_id, &held).await {
            Ok(()) => {
                tracing::warn!(
                    "[held-report] run {} {} {} — {}",
                    run.run_id,
                    // "keeps" is a claim about the directory and is made only
                    // where this reading refuses its removal. Everything else
                    // "holds", which is the premise of this whole pass and
                    // promises nothing about what the release then does.
                    if held.kept { "keeps" } else { "holds" },
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

    fn temp_path(name: &str) -> crate::test_scratch::InScratch {
        crate::test_scratch::Scratch::new(&format!("held-{name}")).at(name)
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
    fn a_box_with_a_worktree(name: &str) -> (crate::test_scratch::InScratch, PathBuf) {
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
        assert!(
            !held.kept,
            "the branch this commit sits on survives `git worktree remove`, so the release takes \
             the directory and nothing here may say it is kept: {}",
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
            held.reason
                .contains("cannot tell whether the work here is on a remote"),
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

    /// ISS-1250 — the sentence that cost an operator four hours.
    ///
    /// Both checkouts this box reported as kept were gone: the release asks
    /// whether a surviving ref names HEAD, and a local branch is one, so it
    /// took the directory in the same sweep. The word has to follow the
    /// predicate the release reads, and the only way to be sure it does is to
    /// drive a checkout the release WOULD take and read the word back.
    #[tokio::test]
    async fn a_checkout_the_release_may_take_is_never_reported_as_kept() {
        let (root, wt) = a_box_with_a_worktree("nevekept");
        std::fs::write(wt.join("work.txt"), "work\n").expect("write");
        sh(&wt, &["add", "-A"]);
        sh(&wt, &["commit", "-qm", "work"]);
        refuse_pushes(&root);

        let run = a_run_at(&wt);
        let cred = crate::workspace::repo_cred::RepoCred::of(None, &wt).await;
        let held = at_risk(&run, &cred).await.expect("the work is at risk");
        let fate = crate::workspace::salvage::fate_of(&wt).await;
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(
            fate,
            crate::workspace::salvage::Fate::Named,
            "the premise: the release is entitled to this directory"
        );
        assert!(
            !held.kept,
            "the release will take this directory, so nothing may say the box keeps it: {}",
            held.reason
        );
        assert!(
            held.reason.contains("do not depend on this directory"),
            "and the sentence a person reads says what was read, not what will happen: {}",
            held.reason
        );
    }

    /// The other side of the same rule: where the release really does refuse,
    /// the word is "keeps" and the directory outlives the sweep.
    #[tokio::test]
    async fn a_checkout_whose_retention_cannot_be_read_is_reported_as_kept() {
        let (root, wt) = a_box_with_a_worktree("unreadable");
        std::fs::write(wt.join("work.txt"), "work\n").expect("write");
        sh(&wt, &["add", "-A"]);
        sh(&wt, &["commit", "-qm", "work"]);
        // `fate_of` asks `rev-list HEAD --not --branches ... --glob=refs/forge`.
        // A ref file holding something that is not an object makes that call
        // fail while `rev-parse HEAD` still answers, which is the shape a box
        // whose refs are being rewritten underneath it produces.
        let forge_refs = root.join("work").join(".git").join("refs").join("forge");
        std::fs::create_dir_all(&forge_refs).expect("refs dir");
        std::fs::write(forge_refs.join("broken"), "not-a-sha\n").expect("ref");

        let run = a_run_at(&wt);
        let cred = crate::workspace::repo_cred::RepoCred::of(None, &wt).await;
        let held = at_risk(&run, &cred)
            .await
            .expect("a kept checkout is reported");
        let _ = std::fs::remove_dir_all(&root);

        assert!(
            held.kept,
            "the release refuses this one, so the box really is keeping it: {}",
            held.reason
        );
        assert!(
            held.reason.contains("this box keeps this checkout"),
            "and says so in the words that reach the issue: {}",
            held.reason
        );
    }

    /// consult 754b50 F2 — the wildcard told an operator a ref already held
    /// commits that nothing but this checkout's HEAD named.
    ///
    /// A detached checkout that committed is the one shape where the release
    /// has to WRITE a ref before it may take the directory, and a report saying
    /// the commits are already named is the assurance that stops anybody
    /// looking when `keep_at` then fails.
    #[tokio::test]
    async fn commits_no_ref_yet_names_are_not_reported_as_already_kept_somewhere() {
        let (root, wt) = a_box_with_a_worktree("needsaref");
        sh(&wt, &["switch", "--detach", "-q"]);
        std::fs::write(wt.join("work.txt"), "work\n").expect("write");
        sh(&wt, &["add", "-A"]);
        sh(&wt, &["commit", "-qm", "on no branch at all"]);

        let run = a_run_at(&wt);
        let cred = crate::workspace::repo_cred::RepoCred::of(None, &wt).await;
        let held = at_risk(&run, &cred).await.expect("the work is at risk");
        let fate = crate::workspace::salvage::fate_of(&wt).await;
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(
            fate,
            crate::workspace::salvage::Fate::NeedsARef { commits: 1 },
            "the premise: nothing but this checkout's HEAD names the commit"
        );
        assert!(
            held.reason
                .contains("a release must give them a ref of their own"),
            "the operator must not be told a ref already holds what nothing holds: {}",
            held.reason
        );
        assert!(
            !held.reason.contains("named by a ref this repository keeps"),
            "and the sentence for the case where one does must not be reused here: {}",
            held.reason
        );
    }

    /// consult 754b50 F1 — `kept == false` is not a removal.
    ///
    /// `terminate::force_terminal` preserves a repository's own main working
    /// tree whatever retention says, and refuses a checkout whose diff it could
    /// not preserve. So the journal line for everything that is not kept says
    /// the run HOLDS the checkout — the premise of this pass — and promises
    /// nothing about what the release does next.
    #[test]
    fn a_report_that_is_not_a_keep_claims_no_removal_either() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let (root, wt) = a_box_with_a_worktree("noclaim");
        std::fs::write(wt.join("work.txt"), "work\n").expect("write");
        sh(&wt, &["add", "-A"]);
        sh(&wt, &["commit", "-qm", "work"]);
        refuse_pushes(&root);
        let mut led = a_ledger_holding(&wt, Incarnation::Exited);
        let spy = Spy::default();

        let said = crate::workspace::worktree::tests::logged_while(|| {
            assert_eq!(
                rt.block_on(report_held_worktrees(&spy, &mut led, "boot-a")),
                1
            );
        });
        let _ = std::fs::remove_dir_all(&root);

        assert!(
            said.contains("holds"),
            "the line says what this pass knows — the run holds the checkout: {said}"
        );
        assert!(
            !said.contains("releases"),
            "and never what only the release may say: {said}"
        );
    }

    /// One `Run` at a path, without the ledger ceremony the reporting loop
    /// needs — these three assert `at_risk` itself.
    fn a_run_at(worktree: &Path) -> crate::runner::ledger::Run {
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
        led.run("run-1").expect("read").expect("the row")
    }

    #[test]
    fn the_payload_carries_only_what_core_declares() {
        let held = Held {
            worktree: "/w".into(),
            branch: Some("ISS-9".into()),
            head: "abc".into(),
            commits_unpushed: Some(2),
            reason: "because".into(),
            kept: true,
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
        assert!(
            json.get("kept").is_none(),
            "`kept` is this box's own reading and not a field core declares: {json}"
        );
    }
}
