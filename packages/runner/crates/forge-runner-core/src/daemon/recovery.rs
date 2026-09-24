/*
 * Giving back a run session the box is still recorded as holding.
 *
 * A run outlives the master that started it: the ledger row is written before
 * anything spawns, so a master that dies mid-run leaves marks nobody will set.
 * This is the local half — fast, and blind to the box's own death. The half
 * that survives losing power lives at core, keyed on the heartbeat.
 */

use crate::daemon::agent_activity::now_ms;
use crate::daemon::run_exit::{self, Reported, Verdict};
use crate::error::Result;
use crate::runner::close_loop::{self, CloseState, LeaseKeeper, SessionReader};
use crate::runner::ledger::{Ledger, Liveness};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MasterPresence {
    /// The registry named a pane and tmux answered for it.
    Alive,
    /// The registry named a pane and tmux has no such pane — a positive observation.
    Gone,
    /// This box has no entry for that master, which is not the same as it being over.
    Unknown,
}

/// Whether the master that started a run is still there to finish it.
#[async_trait::async_trait]
pub trait MasterLiveness: Send + Sync {
    async fn state(&self, master_session_id: &str) -> MasterPresence;
    async fn live_master_for_project(&self, project_id: &str) -> Option<String>;
}

#[async_trait::async_trait]
pub trait ProcessLiveness: Send + Sync {
    async fn is_gone(&self, pid: u32) -> bool;
}

#[async_trait::async_trait]
pub trait Heartbeat: Send + Sync {
    async fn beat(&self, session_id: &str) -> Result<()>;
}

#[async_trait::async_trait]
pub trait RunActivity: Send + Sync {
    async fn reported(&self, session_id: &str) -> Option<Reported>;
}

/// Where a project's repository is on this box.
///
/// The close loop's third mark is a question about git's registry — is this
/// run's checkout registered anywhere? — and a registry lives in a
/// repository. Without one the sweep can read the filesystem and nothing
/// else, and a filesystem answers *the path is not there*, which is not the
/// question and was never an answer to it (ISS-1193). A project this box
/// cannot resolve therefore leaves its runs holding, which is the same
/// standing an operator is already warned about by name.
pub trait RepoRoots: Send + Sync {
    fn root_for(&self, project_id: &str) -> Option<PathBuf>;
}

/// The three the close loop reaches the world through: the session row it
/// reads back, the leases it returns and reads back, and the repository whose
/// registry says what became of the run's checkout.
#[derive(Clone, Copy)]
pub struct Closing<'a> {
    pub sessions: &'a dyn SessionReader,
    pub leases: &'a dyn LeaseKeeper,
    pub roots: &'a dyn RepoRoots,
}

pub struct RunWatch<'a> {
    pub beat: &'a dyn Heartbeat,
    pub idle: &'a dyn RunActivity,
}

/// One run recovery attempted, and how far its loop got.
#[derive(Debug, Clone)]
pub struct Recovered {
    pub run_id: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub state: CloseState,
    /// This run's own close loop cannot advance without someone taking its
    /// worktree back first, and nothing else on the box will.
    pub owed_release: bool,
    pub owed_idle_exit: bool,
    pub owed_death_report: bool,
}

pub async fn reconcile(
    ledger: &mut Ledger,
    boot_id: &str,
    masters: &dyn MasterLiveness,
    procs: &dyn ProcessLiveness,
    closing: Closing<'_>,
    watch: RunWatch<'_>,
) -> Result<Vec<Recovered>> {
    let mut out = Vec::new();
    for run in ledger.unclosed_runs()? {
        if run.is_parked_on_human() {
            if masters.state(&run.master_session_id).await != MasterPresence::Alive {
                if let Some(project) = run.project_id.as_deref() {
                    if let Some(parent) = masters.live_master_for_project(project).await {
                        ledger.reparent_run(&run.run_id, &parent)?;
                    }
                }
            }
            if let Some(id) = run.session_id.as_deref() {
                let _ = watch.beat.beat(id).await;
            }
            continue;
        }
        let pid_refuted = match run.pid {
            Some(pid) => procs.is_gone(pid).await,
            None => false,
        };
        let master = masters.state(&run.master_session_id).await;
        let dead_in_the_ledger =
            matches!(Ledger::liveness(&run, boot_id, pid_refuted), Liveness::Dead);
        let agent_gone = dead_in_the_ledger || master == MasterPresence::Gone;
        let orphaned =
            run.boot_id != boot_id || dead_in_the_ledger || master != MasterPresence::Alive;
        if !orphaned {
            let Some(id) = run.session_id.as_deref() else {
                continue;
            };
            if run_exit::verdict(watch.idle.reported(id).await, now_ms()) == Verdict::Exit {
                out.push(Recovered {
                    run_id: run.run_id.clone(),
                    project_id: run.project_id.clone(),
                    session_id: Some(id.to_string()),
                    state: close_loop::state(ledger, &run.run_id)?,
                    owed_release: false,
                    owed_idle_exit: true,
                    owed_death_report: false,
                });
                continue;
            }
            let _ = watch.beat.beat(id).await;
            continue;
        }
        let repo = run
            .project_id
            .as_deref()
            .and_then(|p| closing.roots.root_for(p));
        let state = close_loop::close(
            ledger,
            &run.run_id,
            repo.as_deref(),
            closing.sessions,
            closing.leases,
        )
        .await?;
        // A run whose release was decided terminal is NOT owed one. Its
        // checkout is staying on disk by decision, so `checkout_returned` will
        // never go true and the three marks alone would put it back on the
        // release path every sweep for ever — which is the loop that held its
        // leases in the first place (ISS-1188). The one act that puts it back
        // is an operator's `run release`.
        let owed_release = agent_gone
            && run.boot_id == boot_id
            && state.session_terminal
            && !state.checkout_returned
            && run.release_terminal_at.is_none();
        let owed_death_report = agent_gone
            && run.ended_by.is_none()
            && run.boot_id == boot_id
            && !state.session_terminal;
        let session_id = run.session_id.clone();
        out.push(Recovered {
            run_id: run.run_id,
            project_id: run.project_id,
            session_id,
            state,
            owed_release,
            owed_idle_exit: false,
            owed_death_report,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ledger::NewRun;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::Mutex;

    const SOURCE: &str = include_str!("recovery.rs");

    /// Masters this box has a registry entry for: in the set is up, out of it is positively gone.
    struct Masters(HashSet<String>);
    #[async_trait::async_trait]
    impl MasterLiveness for Masters {
        async fn state(&self, master_session_id: &str) -> MasterPresence {
            if self.0.contains(master_session_id) {
                MasterPresence::Alive
            } else {
                MasterPresence::Gone
            }
        }
        async fn live_master_for_project(&self, _: &str) -> Option<String> {
            None
        }
    }

    /// A box that has never heard of this master — a restarted daemon, or a project that has left
    /// `/me/runners` and is therefore never re-adopted into the registry.
    struct NoRegistryEntry;
    #[async_trait::async_trait]
    impl MasterLiveness for NoRegistryEntry {
        async fn state(&self, _: &str) -> MasterPresence {
            MasterPresence::Unknown
        }
        async fn live_master_for_project(&self, _: &str) -> Option<String> {
            None
        }
    }

    struct Respawned(&'static str);
    #[async_trait::async_trait]
    impl MasterLiveness for Respawned {
        async fn state(&self, master_session_id: &str) -> MasterPresence {
            if master_session_id == self.0 {
                MasterPresence::Alive
            } else {
                MasterPresence::Gone
            }
        }
        async fn live_master_for_project(&self, _: &str) -> Option<String> {
            Some(self.0.to_string())
        }
    }

    struct Sessions;
    #[async_trait::async_trait]
    impl SessionReader for Sessions {
        async fn is_terminal(&self, _: &str) -> Result<bool> {
            Ok(true)
        }
    }

    /// Core's row still says the session is running, which is what a master that just died leaves.
    struct SessionCoreStillHolds;
    #[async_trait::async_trait]
    impl SessionReader for SessionCoreStillHolds {
        async fn is_terminal(&self, _: &str) -> Result<bool> {
            Ok(false)
        }
    }

    struct Leases(Mutex<HashSet<String>>);
    #[async_trait::async_trait]
    impl LeaseKeeper for Leases {
        async fn release(&self, _project_id: Option<&str>, issue_key: &str) -> Result<()> {
            self.0.lock().unwrap().insert(issue_key.to_string());
            Ok(())
        }
        async fn is_returned(&self, _project_id: Option<&str>, issue_key: &str) -> Result<bool> {
            Ok(self.0.lock().unwrap().contains(issue_key))
        }
    }

    struct Gone(HashSet<u32>);
    #[async_trait::async_trait]
    impl ProcessLiveness for Gone {
        async fn is_gone(&self, pid: u32) -> bool {
            self.0.contains(&pid)
        }
    }

    fn nothing_refuted() -> Gone {
        Gone(HashSet::new())
    }

    #[derive(Default)]
    struct Beats(Mutex<Vec<String>>);
    #[async_trait::async_trait]
    impl Heartbeat for Beats {
        async fn beat(&self, session_id: &str) -> Result<()> {
            self.0.lock().unwrap().push(session_id.to_string());
            Ok(())
        }
    }

    struct NeverReports;
    #[async_trait::async_trait]
    impl RunActivity for NeverReports {
        async fn reported(&self, _: &str) -> Option<Reported> {
            None
        }
    }

    struct Reports(Reported);
    #[async_trait::async_trait]
    impl RunActivity for Reports {
        async fn reported(&self, _: &str) -> Option<Reported> {
            Some(self.0)
        }
    }

    fn finished_long_ago() -> Reports {
        Reports(Reported {
            doing: crate::daemon::agent_activity::Doing::Idle,
            at: now_ms() - run_exit::RUN_IDLE_BEFORE_EXIT.as_millis() as i64 - 1,
            written_at: None,
        })
    }

    /// A repository whose registry answers. Every test here asks it the same
    /// read-only question — *do you register a worktree at this path?* — so one
    /// serves them all.
    fn a_repository() -> PathBuf {
        static ONCE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        ONCE.get_or_init(|| {
            let root =
                std::env::temp_dir().join(format!("forge-recovery-repo-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            let _ = std::process::Command::new("git")
                .args(["init", "-q", "-b", "main"])
                .current_dir(&root)
                .output();
            root
        })
        .clone()
    }

    struct Roots;
    impl RepoRoots for Roots {
        fn root_for(&self, _project_id: &str) -> Option<PathBuf> {
            Some(a_repository())
        }
    }

    fn gone() -> PathBuf {
        PathBuf::from("/tmp/forge-recovery-absent-by-construction")
    }

    fn seeded(run_id: &str, master: &str, boot: &str, issues: &[&str]) -> Ledger {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: run_id.into(),
            project_id: "proj-1".into(),
            master_session_id: master.into(),
            worktree_path: gone(),
            boot_id: boot.into(),
            issue_keys: issues.iter().map(|s| (*s).to_string()).collect(),
        })
        .unwrap();
        led.attach_session(run_id, "core-sess-1").unwrap();
        led
    }

    /// A ledger whose run points at a worktree that is REALLY on the disk, and
    /// whose pid is recorded — the shape every stuck run on the fleet has.
    fn seeded_holding_a_tree(pid: u32, boot: &str) -> (Ledger, PathBuf) {
        let wt = std::env::temp_dir().join(format!(
            "forge-recovery-held-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&wt).unwrap();
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-dead".into(),
            worktree_path: wt.clone(),
            boot_id: boot.into(),
            issue_keys: vec!["ISS-957".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        led.attach_pid("run-1", pid).unwrap();
        (led, wt)
    }

    async fn reconcile_held(
        pid: u32,
        refuted: &[u32],
        boot: &str,
        this_boot: &str,
    ) -> Vec<Recovered> {
        let (mut led, wt) = seeded_holding_a_tree(pid, boot);
        let done = reconcile(
            &mut led,
            this_boot,
            &Masters(HashSet::new()),
            &Gone(refuted.iter().copied().collect()),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        let _ = std::fs::remove_dir_all(&wt);
        done
    }

    #[tokio::test]
    async fn a_run_whose_release_was_given_up_on_is_never_handed_back_to_it() {
        let (mut led, wt) = seeded_holding_a_tree(424_242, "boot-a");
        led.note_release_refusal(
            "run-1",
            "the diff in the checkout was not preserved",
            1_790_000_000,
        )
        .unwrap();
        led.conclude_release_refusal(
            "run-1",
            1_790_000_300,
            "recovery",
            "the diff in the checkout was not preserved",
        )
        .unwrap();

        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &Gone([424_242].into_iter().collect()),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        let _ = std::fs::remove_dir_all(&wt);

        assert_eq!(
            done.len(),
            1,
            "the run is still read, so its leases keep being chased"
        );
        assert!(
            !done[0].owed_release,
            "its checkout is staying on disk by decision, so the three marks alone would put it \
             back on the release path every sweep for ever — which is the loop that held its \
             leases in the first place"
        );
    }

    #[tokio::test]
    async fn a_dead_run_still_holding_its_tree_is_owed_a_release() {
        let done = reconcile_held(424_242, &[424_242], "boot-a", "boot-a").await;
        assert_eq!(done.len(), 1);
        assert!(
            !done[0].state.is_closed() && done[0].state.session_terminal,
            "the state under test is terminal-but-holding, got {:?}",
            done[0].state
        );
        assert!(
            done[0].owed_release,
            "a run whose own pid is refuted, whose session core calls terminal, and whose worktree is still on the disk is in the one state that cannot resolve itself"
        );
        assert_eq!(
            done[0].project_id.as_deref(),
            Some("proj-1"),
            "the release needs the project to resolve a repo path"
        );
    }

    #[tokio::test]
    async fn a_run_whose_master_is_gone_is_owed_its_release_whatever_its_pid_says() {
        let done = reconcile_held(424_243, &[], "boot-a", "boot-a").await;
        assert_eq!(
            done.len(),
            1,
            "a dead master still leaves the run to recovery"
        );
        assert!(
            done[0].owed_release,
            "a run whose master's session is gone has no agent — a subagent runs inside that process and cannot outlive it — so the release it is owed may not wait on a pid nothing writes"
        );
    }

    #[tokio::test]
    async fn a_finished_run_under_a_live_master_is_still_owed_its_checkout_back() {
        let (mut led, wt) = seeded_holding_a_tree(0, "boot-a");
        led.end_run("run-1", "subagent", "the subagent finished")
            .unwrap();
        let done = reconcile(
            &mut led,
            "boot-a",
            // the fixture's master, named ALIVE here on purpose: the master term must answer
            // `Alive` so that only the ledger half of `agent_gone` can carry this case
            &Masters(HashSet::from(["master-dead".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        let _ = std::fs::remove_dir_all(&wt);
        assert_eq!(done.len(), 1, "a finished run is reconciled");
        assert!(
            done[0].owed_release,
            "the run is over and core agrees its session is; nothing else will ever take this checkout back"
        );
    }

    #[tokio::test]
    async fn a_run_that_ended_itself_is_never_reported_as_one_that_died() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        led.end_run("run-1", "subagent", "the subagent finished")
            .unwrap();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &SessionCoreStillHolds,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(done.len(), 1, "an ended run is still reconciled");
        assert!(
            !done[0].owed_death_report,
            "this run said it was finished; a core that would not take the close is a reason to try the close again, never a reason to call it a death"
        );
    }

    #[tokio::test]
    async fn a_master_this_box_has_no_record_of_is_not_read_as_a_master_that_ended() {
        let mut led = seeded("run-1", "master-unknown", "boot-a", &["ISS-957"]);
        let done = reconcile(
            &mut led,
            "boot-a",
            &NoRegistryEntry,
            &nothing_refuted(),
            Closing {
                sessions: &SessionCoreStillHolds,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            done.len(),
            1,
            "an unknown master still leaves the run to recovery, as it did before this change"
        );
        assert!(
            !done[0].owed_death_report,
            "this box has no record of that master — saying the run died would be an absence reported as a fact"
        );
        assert!(
            !done[0].owed_release,
            "and it may certainly not license removing a checkout a live subagent may be writing into"
        );
    }

    #[tokio::test]
    async fn a_run_with_no_pid_at_all_whose_master_died_is_reported_dead_rather_than_waited_out() {
        let mut led = seeded("run-1", "master-dead", "boot-a", &["ISS-957"]);
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &SessionCoreStillHolds,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(done.len(), 1, "a run whose master died is recovered");
        assert!(
            done[0].owed_death_report,
            "core is told this run died by the box; waiting for the ten-minute silence is what this pass exists to replace"
        );
    }

    #[tokio::test]
    async fn a_run_from_a_previous_boot_is_owed_no_release() {
        let done = reconcile_held(424_244, &[424_244], "boot-old", "boot-new").await;
        assert_eq!(done.len(), 1);
        assert!(
            !done[0].owed_release,
            "the pid is from another boot — reclaiming on it is reclaiming on a claim nobody checked"
        );
    }

    #[tokio::test]
    async fn a_park_is_never_owed_a_release() {
        let (mut led, wt) = seeded_holding_a_tree(424_245, "boot-a");
        led.declare_parked_human("run-1", Some("resume-1"), None)
            .unwrap();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &Gone(HashSet::from([424_245])),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        let _ = std::fs::remove_dir_all(&wt);
        assert!(
            done.is_empty(),
            "a park satisfies both orphan premises by design — recovery must not even report it, let alone owe its tree back"
        );
    }

    #[tokio::test]
    async fn a_master_that_died_mid_run_has_its_run_closed_from_the_ledger() {
        let mut led = seeded("run-1", "master-dead", "boot-a", &["ISS-957", "ISS-958"]);
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            done.len(),
            1,
            "a master that died WITHIN this boot leaves a run nothing else will close — recovery keyed only on a reboot never fires for the failure it exists to repair (ISS-933 criterion 16)"
        );
        assert!(
            done[0].state.is_closed(),
            "all three marks must reach their terminal value, got {:?} (ISS-933 criterion 16)",
            done[0].state
        );
    }

    #[tokio::test]
    async fn a_run_left_by_a_previous_boot_is_recovered_too() {
        let mut led = seeded("run-1", "master-old", "boot-old", &["ISS-957"]);
        let done = reconcile(
            &mut led,
            "boot-new",
            &Masters(HashSet::from(["master-old".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            done.len(),
            1,
            "a run recorded under a boot id that is not this one cannot have a live master however the liveness port answers — a pid or a pane name from a previous boot may belong to something else entirely (ISS-933 criterion 16)"
        );
        assert!(done[0].state.is_closed());
    }

    #[tokio::test]
    async fn a_run_whose_master_is_still_there_is_left_alone() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(
            done.is_empty(),
            "recovery that closes a LIVE master's run takes work away mid-decision — the failure `master-reaper.ts` names in its own timeout guard (ISS-933 criterion 16); recovered {done:?}"
        );
        assert_eq!(close_loop::state(&led, "run-1").unwrap().leases_returned, 0);
    }

    #[tokio::test]
    async fn recovering_twice_returns_no_lease_twice() {
        let mut led = seeded("run-1", "master-dead", "boot-a", &["ISS-957"]);
        let leases = Leases(Mutex::new(HashSet::new()));
        reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &leases,
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        let again = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &leases,
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(
            again.is_empty(),
            "a run whose loop is closed is no longer unclosed, so a second sweep must find nothing to do (ISS-933 criterion 16); found {again:?}"
        );
    }

    #[tokio::test]
    async fn a_live_run_is_beaten_in_the_same_sweep_that_would_have_closed_it() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let beats = Beats::default();
        reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            beats.0.lock().unwrap().as_slice(),
            ["core-sess-1"],
            "a sweep that leaves a live run alone but never tells core so has handed that run to core's ten-minute reaper — the beat and the recovery are one pass precisely so this cannot be built apart (ISS-933 criteria 16 and 25a)"
        );
    }

    #[tokio::test]
    async fn a_run_that_reported_itself_finished_is_named_and_not_beaten() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let beats = Beats::default();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &finished_long_ago(),
            },
        )
        .await
        .unwrap();
        assert!(
            beats.0.lock().unwrap().is_empty(),
            "a finished run that is still beaten is held out of core's reaper by this box forever — 32 panes on forge-vm 2026-09-12, the oldest 22 hours; beats were {:?}",
            beats.0.lock().unwrap()
        );
        assert_eq!(
            done.iter().filter(|r| r.owed_idle_exit).count(),
            1,
            "stopping the beat without naming the run leaves its process up with nothing on the box able to end it; got {done:?}"
        );
    }

    #[tokio::test]
    async fn a_run_that_has_reported_nothing_is_beaten_like_any_other() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let beats = Beats::default();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(beats.0.lock().unwrap().as_slice(), ["core-sess-1"]);
        assert!(
            !done.iter().any(|r| r.owed_idle_exit),
            "silence is not idleness; got {done:?}"
        );
    }

    #[test]
    fn reconcile_takes_no_session_id_from_its_caller() {
        let sig = SOURCE
            .split("pub async fn reconcile(")
            .nth(1)
            .and_then(|rest| rest.split(')').next())
            .unwrap_or_default();
        assert!(
            !sig.contains("session_id") && !sig.contains("agent_session"),
            "recovery must read the run's session from the LEDGER, not from a caller — a caller that could name it is a caller that could name the wrong one, and the ledger is the only thing that survives the master that knew it (ISS-933 criterion 16); signature was: {sig}"
        );
    }
    fn parked(run_id: &str, master: &str, boot: &str) -> Ledger {
        let mut led = seeded(run_id, master, boot, &["ISS-964"]);
        led.begin_question("q-1", run_id, 1, "q-1").unwrap();
        led.declare_parked_human(run_id, Some("resume-1"), None)
            .unwrap();
        led
    }

    #[tokio::test]
    async fn a_park_is_not_closed_because_its_master_died() {
        let mut led = parked("run-1", "master-dead", "boot-a");
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(
            done.is_empty(),
            "a park whose master is gone is waiting, not abandoned — closing it throws away the answer somebody is about to give"
        );
        let run = led.run("run-1").unwrap().unwrap();
        assert!(run.ended_by.is_none(), "the run must still be open");
        assert_eq!(run.resume_id.as_deref(), Some("resume-1"));
    }

    #[tokio::test]
    async fn a_park_survives_the_box_rebooting_under_it() {
        let mut led = parked("run-1", "master-dead", "boot-before");
        let done = reconcile(
            &mut led,
            "boot-after",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(done.is_empty(), "a reboot is not an abandonment of a park");
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_none());
    }

    #[tokio::test]
    async fn a_park_whose_master_respawned_is_reparented_onto_it() {
        let mut led = parked("run-1", "master-old", "boot-a");
        reconcile(
            &mut led,
            "boot-a",
            &Respawned("master-new"),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(
            run.master_session_id, "master-new",
            "the new master must be able to find this run: `runs_for_master` is what `master_exit::children` reads, so a stale parent leaves the master free to exit over a live park"
        );
    }

    #[tokio::test]
    async fn a_park_keeps_beating_so_cores_reaper_leaves_it_alone() {
        let mut led = parked("run-1", "master-dead", "boot-a");
        let beats = Beats::default();
        reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            beats.0.lock().unwrap().as_slice(),
            ["core-sess-1"],
            "a park the box is preserving must go on asserting that the box holds it"
        );
    }

    fn with_pid(run_id: &str, master: &str, boot: &str, pid: u32) -> Ledger {
        let led = seeded(run_id, master, boot, &["ISS-957"]);
        led.attach_pid(run_id, pid).unwrap();
        led
    }

    #[tokio::test]
    async fn a_run_whose_own_process_is_gone_is_closed_under_a_master_that_lives() {
        let mut led = with_pid("run-1", "master-live", "boot-a", 4242);
        let beats = Beats::default();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &Gone(HashSet::from([4242])),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            done.len(),
            1,
            "a run whose pane died while its master lived is closed by nothing else on this box, and it goes on beating — core's reaper never fires and every lease it holds stays held by derivation, which is a pool that reads empty with nothing running"
        );
        assert!(done[0].state.is_closed());
        assert!(
            beats.0.lock().unwrap().is_empty(),
            "a run being given back must not also be asserted as held in the same sweep"
        );
    }

    #[tokio::test]
    async fn a_run_whose_process_answers_is_beaten_and_left_alone() {
        let mut led = with_pid("run-1", "master-live", "boot-a", 4242);
        let beats = Beats::default();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(
            done.is_empty(),
            "a pid the kernel still answers for is a live agent, and closing its loop takes the worktree out from under it mid-write; recovered {done:?}"
        );
        assert_eq!(beats.0.lock().unwrap().as_slice(), ["core-sess-1"]);
    }

    #[tokio::test]
    async fn a_run_that_has_not_recorded_a_pid_yet_is_left_to_finish_starting() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &Gone(HashSet::from([0, 1])),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(
            done.is_empty(),
            "a run with no pid has not started, not died — the ledger row is written BEFORE anything spawns, so this window is a normal one; recovered {done:?}"
        );
    }

    #[tokio::test]
    async fn a_park_is_not_closed_by_the_pid_term_that_every_park_satisfies() {
        let mut led = parked("run-1", "master-live", "boot-a");
        led.attach_pid("run-1", 4242).unwrap();
        let beats = Beats::default();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &Gone(HashSet::from([4242])),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(
            done.is_empty(),
            "a park releases its process by design, so a liveness term that reaped it would destroy every question a human has been asked; recovered {done:?}"
        );
        assert_eq!(beats.0.lock().unwrap().as_slice(), ["core-sess-1"]);
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_none());
    }

    #[tokio::test]
    async fn a_live_pid_does_not_save_a_run_from_a_dead_master_or_a_foreign_boot() {
        let mut led = with_pid("run-1", "master-dead", "boot-a", 4242);
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(done.len(), 1, "the master term must still fire on its own");

        let mut old = with_pid("run-2", "master-live", "boot-old", 4243);
        let done = reconcile(
            &mut old,
            "boot-new",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            done.len(),
            1,
            "the boot term must still fire on its own: a pid recorded before a reboot names whatever the kernel has since handed it to, so an answer of `alive` about it is an answer about a stranger"
        );
    }
}
