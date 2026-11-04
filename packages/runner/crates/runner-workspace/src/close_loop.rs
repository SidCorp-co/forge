//! Closing a run (ISS-933 step 4): three marks, none of them declared.
//!
//! A run is done when its session is terminal, its worktree is off the disk,
//! and every issue's lease is back. The measured failure is not that a master
//! forgets to do those things — it is that a master reports having done them.
//! One did, having finished one and a half of three.
//!
//! So no mark here is set by doing the work. Each is set by READING THE WORLD
//! BACK afterwards, by its own protocol, and the response to the write that
//! did the work is discarded in every case. That cuts both ways on purpose: a
//! dropped response over work that landed still ends with the mark set, and a
//! cheerful `200` over work that did not land does not.

use std::path::Path;

use crate::worktree::Residence;
use runner_core::ledger::{CheckoutReturn, Ledger};
use runner_platform::clock::now_secs;
use runner_platform::error::Result;
pub use runner_transport::run_sessions::Outcome;

/// Reads back the authoritative session row. Never the ack of a write.
#[async_trait::async_trait]
pub trait SessionReader: Send + Sync {
    async fn is_terminal(&self, agent_session_id: &str) -> Result<bool>;
}

#[async_trait::async_trait]
pub trait RunCloser: Send + Sync {
    async fn close(
        &self,
        agent_session_id: &str,
        outcome: Outcome,
        detail: &str,
        checkpoint: Option<serde_json::Value>,
    ) -> Result<()>;
}

/// Returns a lease, and separately reads back whether it is actually returned.
///
/// Both carry the project the run belongs to: a lease is keyed by project and
/// issue, and a box serving two projects holds two rows under one key, so a
/// call naming only the key is a question core cannot answer (ISS-1139).
///
/// Both carry the run's session too. Two runs on one box can name one key —
/// an ended judge's and the build that took the issue after it — and a call
/// naming only the box read the newer run's lease as the older one's, gave it
/// back, and left the newer run refused `NO_HOLDER` on its own move (ISS-752).
#[async_trait::async_trait]
pub trait LeaseKeeper: Send + Sync {
    async fn release(
        &self,
        project_id: Option<&str>,
        session_id: Option<&str>,
        issue_key: &str,
    ) -> Result<()>;
    async fn is_returned(
        &self,
        project_id: Option<&str>,
        session_id: Option<&str>,
        issue_key: &str,
    ) -> Result<bool>;
}

/// What the ledger says, with no process inspected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseState {
    pub session_terminal: bool,
    /// The run no longer holds a checkout it owes back. Not the same claim as
    /// *a directory went*, which is `worktree_gone_at`'s and only overlaps
    /// with this one (ISS-1193).
    pub checkout_returned: bool,
    pub leases_returned: usize,
    pub leases_total: usize,
}

impl CloseState {
    /// Every mark set. Anything else is a run still owed work.
    pub fn is_closed(&self) -> bool {
        self.session_terminal && self.checkout_returned && self.leases_returned == self.leases_total
    }
}

pub fn state(ledger: &Ledger, run_id: &str) -> Result<CloseState> {
    let run = ledger.run(run_id)?;
    let issues = ledger.issues(run_id)?;
    Ok(CloseState {
        session_terminal: run
            .as_ref()
            .is_some_and(|r| r.session_terminal_at.is_some()),
        checkout_returned: run.as_ref().is_some_and(|r| r.released_as.is_some()),
        leases_returned: issues
            .iter()
            .filter(|m| m.lease_returned_at.is_some())
            .count(),
        leases_total: issues.len(),
    })
}

/// What the world says about the checkout this run was declared against, or
/// `None` where it still holds one and the mark is not owed yet.
///
/// An absent path used to answer this on its own, and it is not an answer.
/// `git worktree move` leaves a live, registered worktree behind a path that
/// no longer resolves, and a sweep reading that absence as removal recorded
/// three runs on sid-xeon-1 as having given back checkouts that were sitting
/// on disk holding a `wip(salvage)` commit (ISS-1193). So the filesystem
/// decides nothing here: git's registry is asked, through `residence_of`, and
/// every reading but its two conclusive ones leaves the run holding.
///
/// The main working tree is the other way to hold none, and it earns its own
/// value rather than the `gone` one: a run declared against a repository's own
/// checkout never took it from the pool and it has to outlive the run
/// (ISS-1183), so nothing about it went anywhere.
///
/// `repo` is the repository whose registry answers. Without one there is no
/// registry to ask and the run keeps holding — which is the conservative half
/// of this change and not a gap: the release path always has the repo root,
/// and a run whose project this box cannot resolve is one an operator is
/// already being warned about.
async fn checkout_returned(
    run_id: &str,
    repo: Option<&Path>,
    path: &Path,
) -> Option<CheckoutReturn> {
    let repo = repo?;
    match crate::worktree::residence_of(repo, path).await {
        Residence::Gone => Some(CheckoutReturn::Gone),
        Residence::MainWorkingTree => Some(CheckoutReturn::MainWorkingTreeKept),
        // Git answered for the checkout around this path, which says nothing
        // about this one: the path stands and nothing established that it is
        // back. Recording it as the repository's own tree is how sid-desk's
        // ISS-689 checkout was called "left standing" and then went (ISS-1250).
        Residence::Enclosed(top) => {
            tracing::warn!(
                "[close] run={run_id}: {} stands, but git, asked at the path, answers for the \
                 enclosing checkout {} — it is no checkout of its own, so the run keeps holding \
                 it until git registers it or it is gone",
                path.display(),
                top.display()
            );
            None
        }
        Residence::Linked
        | Residence::NotAWorktree
        | Residence::MovedTo(_)
        | Residence::RegisteredButMissing(_)
        | Residence::Ambiguous(_) => None,
        Residence::Unknown(why) => {
            tracing::warn!(
                "[close] run={run_id}: {}: git could not be asked whether this checkout is still registered ({why}) — the run keeps holding it",
                path.display()
            );
            None
        }
    }
}

pub async fn close(
    ledger: &mut Ledger,
    run_id: &str,
    repo: Option<&Path>,
    sessions: &dyn SessionReader,
    leases: &dyn LeaseKeeper,
) -> Result<CloseState> {
    let judge_root = runner_core::judge_dir::root();
    close_under(ledger, run_id, repo, sessions, leases, &judge_root).await
}

/// [`close`] for a daemon whose `$TMPDIR` is `judge_root`: where a closed run with no judge login
/// recorded on it is looked for.
pub(crate) async fn close_under(
    ledger: &mut Ledger,
    run_id: &str,
    repo: Option<&Path>,
    sessions: &dyn SessionReader,
    leases: &dyn LeaseKeeper,
    judge_root: &Path,
) -> Result<CloseState> {
    let Some(run) = ledger.run(run_id)? else {
        return state(ledger, run_id);
    };

    let session_terminal = match run.session_id.as_deref() {
        Some(id) => matches!(sessions.is_terminal(id).await, Ok(true)),
        None => true,
    };
    if run.session_terminal_at.is_none() && session_terminal {
        ledger.mark_session_terminal_observed(run_id)?;
    }

    let mut checkout_is_back = run.released_as.is_some();
    if !checkout_is_back {
        if let Some(how) = checkout_returned(run_id, repo, Path::new(&run.worktree_path)).await {
            ledger.mark_checkout_returned_observed(run_id, how)?;
            // The one writer of `worktree_gone_at`, so the one place a line
            // covers every checkout recorded gone — including the ones a
            // master or a person removed, which no removal line of this box's
            // could ever name (ISS-1250, judge finding 5).
            match how {
                CheckoutReturn::Gone => tracing::info!(
                    "[close] run={run_id}: {} is no longer a checkout git registers, so it is \
                     recorded as gone",
                    run.worktree_path.display()
                ),
                // What git answered and what the run is recorded as, and
                // nothing about the directory's future (ISS-1250, judge j3).
                CheckoutReturn::MainWorkingTreeKept => tracing::info!(
                    "[close] run={run_id}: git answers that {} is the repository's own working \
                     tree, so the run holds no checkout of the pool's and is recorded as having \
                     none to return",
                    run.worktree_path.display()
                ),
                // Never read off the world here: only the release decides a
                // checkout is left to another open run, and it says so itself.
                CheckoutReturn::KeptForOpenRun => {}
            }
            checkout_is_back = true;
        }
    }

    // A checkout that is back overtakes a refusal the release left standing:
    // the thing the refusal was about is gone, so the refusal will never be
    // taken again and will never reach its own decision. The condition is that
    // the checkout IS back, not that this call was the one that saw it — the
    // rows ISS-1242 names were all marked returned by an earlier sweep, so a
    // settle guarded by the observation would miss every one of them.
    if checkout_is_back
        && run.release_refused_at.is_some()
        && run.release_terminal_at.is_none()
        && ledger.settle_release_refusal(run_id, now_secs())?
    {
        tracing::info!(
            "[close] run={run_id}: its checkout is back, so the release refusal standing over \
                 it ({}) is settled rather than left open — it was never decided and will never \
                 be taken again",
            run.release_refusal.as_deref().unwrap_or("no text recorded")
        );
    }

    let project = run.project_id.clone();
    let session = run.session_id.clone();
    for m in ledger.issues(run_id)? {
        if m.lease_returned_at.is_some() {
            continue;
        }
        if !matches!(
            leases
                .is_returned(project.as_deref(), session.as_deref(), &m.issue_key)
                .await,
            Ok(true)
        ) {
            // The mark answers to the read-back below and never to this
            // response, so the outcome decides nothing here. What it carries
            // does: a refusal names the way out — the project to send, the key
            // that reaches no lease — and a run whose release is refused says
            // so rather than passing in silence (ISS-1139).
            if let Err(e) = leases
                .release(project.as_deref(), session.as_deref(), &m.issue_key)
                .await
            {
                tracing::warn!(
                    "[close] run={run_id} {}: lease release refused: {e}",
                    m.issue_key
                );
            }
        }
        if matches!(
            leases
                .is_returned(project.as_deref(), session.as_deref(), &m.issue_key)
                .await,
            Ok(true)
        ) {
            ledger.mark_lease_returned_observed(run_id, &m.issue_key)?;
        }
    }

    let closed = state(ledger, run_id)?;
    if closed.is_closed() {
        remove_judge_login(ledger, judge_root, run_id);
    }
    Ok(closed)
}

/// Every ending reaches this loop — a master's close, a pane that ended, a reap of a run whose
/// tree is gone, a run core said is over, a release refused for good — so a closed run's judge
/// logins go here (ISS-920): each directory `judge-login` recorded on the run, wherever the pane's
/// `$TMPDIR` put it, and for a run with none recorded `forge-judge-<run>` under `root`, this
/// daemon's own `$TMPDIR`.
pub(crate) fn remove_judge_login(ledger: &Ledger, root: &Path, run_id: &str) {
    use runner_core::judge_dir::{remove_for_run, Removal};
    let recorded = ledger.judge_dirs(run_id).map_err(|e| e.to_string());
    for removal in remove_for_run(recorded, root, run_id) {
        match (&removal, removal.said()) {
            (Removal::Absent, _) | (_, None) => {}
            (Removal::Removed(_), Some(line)) => tracing::info!("[close] run={run_id}: {line}"),
            (_, Some(line)) => tracing::warn!("[close] run={run_id}: {line}"),
        }
    }
}

/// Two runs on one box over one key (ISS-752): the close of the older one,
/// whose session took no lease, against a core that answers per session.
#[cfg(test)]
mod tests {
    use super::*;
    use runner_core::ledger::NewRun;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// Core's lease store as one box sees it: rows of (session, key). A
    /// give-back naming a session reaches that session's row; one naming none
    /// is refused over a live lease, as core refuses `ISSUE_LEASE_RUN_UNNAMED`.
    struct Core {
        rows: Mutex<Vec<(String, String)>>,
        released: Mutex<Vec<(Option<String>, String)>>,
    }

    #[async_trait::async_trait]
    impl SessionReader for Core {
        async fn is_terminal(&self, _id: &str) -> Result<bool> {
            Ok(true)
        }
    }

    #[async_trait::async_trait]
    impl LeaseKeeper for Core {
        async fn release(&self, _p: Option<&str>, session: Option<&str>, key: &str) -> Result<()> {
            self.released
                .lock()
                .unwrap()
                .push((session.map(str::to_string), key.to_string()));
            let mut rows = self.rows.lock().unwrap();
            match session {
                Some(s) => rows.retain(|(rs, rk)| !(rs == s && rk == key)),
                None if rows.iter().any(|(_, rk)| rk == key) => {
                    return Err(runner_platform::error::Error::Other(
                        "ISSUE_LEASE_RUN_UNNAMED".into(),
                    ))
                }
                None => {}
            }
            Ok(())
        }
        async fn is_returned(
            &self,
            _p: Option<&str>,
            session: Option<&str>,
            key: &str,
        ) -> Result<bool> {
            let rows = self.rows.lock().unwrap();
            Ok(!rows
                .iter()
                .any(|(rs, rk)| rk == key && session.is_none_or(|s| s == rs)))
        }
    }

    fn declare(led: &mut Ledger, run_id: &str, key: &str) {
        led.create_run_group(NewRun {
            run_id: run_id.into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: PathBuf::from(format!("/nonexistent/{run_id}")),
            boot_id: "boot-1".into(),
            issue_keys: vec![key.into()],
            role: None,
            requirement: None,
        })
        .unwrap();
    }

    #[tokio::test]
    async fn criterion_3_an_older_runs_close_completes_while_a_newer_run_holds_the_key() {
        let dir = std::env::temp_dir().join(format!(
            "forge-iss752-{}-{}",
            std::process::id(),
            runner_core::agent_activity::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut led = Ledger::open(&dir.join("ledger.db")).unwrap();

        // ISS-572's shape: the judge over the closed issue took no lease and
        // ended; the build declared after it took the issue's lease.
        declare(&mut led, "judge", "ISS-572");
        led.attach_session("judge", "session-judge").unwrap();
        led.end_run("judge", "test", "the judge ended").unwrap();
        declare(&mut led, "build", "ISS-572");
        led.attach_session("build", "session-build").unwrap();
        let core = Core {
            rows: Mutex::new(vec![("session-build".into(), "ISS-572".into())]),
            released: Mutex::new(vec![]),
        };

        let closed = close(&mut led, "judge", None, &core, &core).await.unwrap();

        assert_eq!(
            (closed.leases_returned, closed.leases_total),
            (1, 1),
            "the judge's close stayed owed a lease the build holds"
        );
        assert_eq!(
            *core.rows.lock().unwrap(),
            vec![("session-build".to_string(), "ISS-572".to_string())],
            "the judge's close gave back the build's lease"
        );
        assert!(
            core.released.lock().unwrap().is_empty(),
            "a lease the judge never took was given back: {:?}",
            core.released.lock().unwrap()
        );
        let build = state(&led, "build").unwrap();
        assert_eq!(build.leases_returned, 0);

        // The build's own close still gives back what it took, by its session.
        let closed = close(&mut led, "build", None, &core, &core).await.unwrap();
        assert_eq!((closed.leases_returned, closed.leases_total), (1, 1));
        assert!(core.rows.lock().unwrap().is_empty());
        assert_eq!(
            *core.released.lock().unwrap(),
            vec![(Some("session-build".to_string()), "ISS-572".to_string())]
        );
        std::fs::remove_dir_all(&dir).ok();
    }
    /// Every ending reaches this loop, so a run it closes loses the judge login written for it
    /// under `$TMPDIR`; a run still owed its checkout keeps its own (ISS-920).
    #[tokio::test]
    async fn a_run_the_loop_closes_loses_its_judge_login_and_an_open_one_keeps_it() {
        /// What the test made under `$TMPDIR`, gone when it ends, passed or failed.
        struct Made(Vec<PathBuf>);
        impl Drop for Made {
            fn drop(&mut self) {
                for p in &self.0 {
                    let _ = std::fs::remove_dir_all(p);
                }
            }
        }
        let dir = std::env::temp_dir().join(format!("forge-iss920-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut led = Ledger::open(&dir.join("ledger.db")).unwrap();
        let ended = uuid::Uuid::new_v4().to_string();
        let open = uuid::Uuid::new_v4().to_string();
        let plant = |run: &str| {
            let d = runner_core::judge_dir::dir(&runner_core::judge_dir::root(), run).unwrap();
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("x.json"), "{}").unwrap();
            d
        };
        let (ended_login, open_login) = (plant(&ended), plant(&open));
        let _made = Made(vec![dir.clone(), ended_login.clone(), open_login.clone()]);
        declare(&mut led, &ended, "ISS-1");
        led.attach_session(&ended, "session-ended").unwrap();
        // a pane that ended over a tree that is gone: the reap's shape
        led.mark_checkout_returned_observed(&ended, CheckoutReturn::Gone)
            .unwrap();
        led.end_run(&ended, "recovery", "its pane ended").unwrap();
        declare(&mut led, &open, "ISS-2");
        let core = Core {
            rows: Mutex::new(vec![]),
            released: Mutex::new(vec![]),
        };

        let closed = close(&mut led, &ended, None, &core, &core).await.unwrap();
        let still = close(&mut led, &open, None, &core, &core).await.unwrap();

        assert!(closed.is_closed(), "{closed:?}");
        assert!(
            !ended_login.exists(),
            "the closed run's judge login is still on disk"
        );
        assert!(!still.is_closed(), "{still:?}");
        assert!(
            open_login.join("x.json").exists(),
            "an open run's login was removed"
        );
    }
    /// The two roots ISS-920's follow-up measured on forge-dev: the daemon's `$TMPDIR`
    /// (`forge-tmp-dev`) and the pane's (`forge-tmp`, from `~/.zshenv`), as two sibling directories
    /// under this test's own `$TMPDIR`, with a ledger beside them. All of it goes when the test ends.
    struct TwoRoots {
        top: PathBuf,
        daemon: PathBuf,
        pane: PathBuf,
        led: Ledger,
    }
    impl TwoRoots {
        fn new() -> Self {
            let top = std::env::temp_dir().join(format!("forge-iss920-{}", uuid::Uuid::new_v4()));
            let (daemon, pane) = (top.join("forge-tmp-dev"), top.join("forge-tmp"));
            std::fs::create_dir_all(&daemon).unwrap();
            std::fs::create_dir_all(&pane).unwrap();
            let led = Ledger::open(&top.join("ledger.db")).unwrap();
            Self {
                top,
                daemon,
                pane,
                led,
            }
        }
        /// A run declared, ended over a tree that is gone, its session terminal: one the loop closes.
        fn ended_run(&mut self) -> String {
            let run = uuid::Uuid::new_v4().to_string();
            declare(&mut self.led, &run, "ISS-1");
            self.led.attach_session(&run, "session-1").unwrap();
            self.led
                .mark_checkout_returned_observed(&run, CheckoutReturn::Gone)
                .unwrap();
            self.led
                .end_run(&run, "recovery", "its pane ended")
                .unwrap();
            run
        }
        /// What `judge-login` leaves under `root` for `run`.
        fn login(root: &Path, run: &str) -> PathBuf {
            let d = runner_core::judge_dir::dir(root, run).unwrap();
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("dev-actor-member.json"), "{}").unwrap();
            d
        }
        async fn close(&mut self, run: &str) -> CloseState {
            let core = Core {
                rows: Mutex::new(vec![]),
                released: Mutex::new(vec![]),
            };
            let daemon = self.daemon.clone();
            close_under(&mut self.led, run, None, &core, &core, &daemon)
                .await
                .unwrap()
        }
    }
    impl Drop for TwoRoots {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.top);
        }
    }

    /// The mismatch itself: the judge's login is written under the pane's `$TMPDIR` and recorded
    /// on its run, and the close loop, running under the daemon's, removes it from where it is.
    #[tokio::test]
    async fn a_login_written_under_the_panes_tmpdir_goes_with_the_daemons_close() {
        let mut t = TwoRoots::new();
        let run = t.ended_run();
        let login = TwoRoots::login(&t.pane, &run);
        let recorded = runner_core::judge_dir::record(&t.led, &run, &login).unwrap();
        assert_eq!(t.led.judge_dirs(&run).unwrap(), vec![recorded]);

        let closed = t.close(&run).await;

        assert!(closed.is_closed(), "{closed:?}");
        assert!(
            !login.exists(),
            "the login under the pane's $TMPDIR outlived a close under the daemon's"
        );
    }

    /// A recorded path that breaks the rule removes nothing, and the `$TMPDIR` rule does not stand
    /// in for it. Unix only: the symlink it plants needs a privilege Windows does not grant a test.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_recorded_path_that_breaks_the_rule_is_refused_and_removes_nothing() {
        let mut t = TwoRoots::new();
        let run = t.ended_run();
        // another run's login, a path with `..`, a relative path and a symlink, each recorded on
        // this run as a writer that skipped `judge_dir::record` might
        let other = TwoRoots::login(&t.pane, &uuid::Uuid::new_v4().to_string());
        let outside = t.top.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.json"), "{}").unwrap();
        let link = runner_core::judge_dir::dir(&t.pane, &run).unwrap();
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let dotted = t
            .pane
            .join("..")
            .join("forge-tmp")
            .join(format!("forge-judge-{run}"));
        let daemons = TwoRoots::login(&t.daemon, &run);
        for bad in [
            other.clone(),
            dotted,
            PathBuf::from(format!("forge-judge-{run}")),
            link.clone(),
        ] {
            t.led.note_judge_dir(&run, &bad).unwrap();
        }

        assert!(t.close(&run).await.is_closed());

        assert!(other.join("dev-actor-member.json").exists());
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(outside.join("keep.json").exists());
        assert!(
            daemons.exists(),
            "a run with a record had its daemon $TMPDIR guessed at"
        );
        for bad in runner_core::judge_dir::remove_for_run(
            t.led.judge_dirs(&run).map_err(|e| e.to_string()),
            &t.daemon,
            &run,
        ) {
            assert!(
                matches!(bad, runner_core::judge_dir::Removal::Refused(_)),
                "{bad:?}"
            );
        }
    }

    /// A run with nothing recorded — a login written by a judge-login from before the record —
    /// falls back to `forge-judge-<run>` under the daemon's own `$TMPDIR`.
    #[tokio::test]
    async fn a_run_with_no_recorded_login_falls_back_to_the_daemons_tmpdir() {
        let mut t = TwoRoots::new();
        let run = t.ended_run();
        let daemons = TwoRoots::login(&t.daemon, &run);
        let panes = TwoRoots::login(&t.pane, &run);

        assert!(t.close(&run).await.is_closed());

        assert!(!daemons.exists());
        assert!(
            panes.exists(),
            "with nothing recorded only the daemon's $TMPDIR is read"
        );
    }
}
