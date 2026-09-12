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

/// Whether the master that started a run is still there to finish it.
#[async_trait::async_trait]
pub trait MasterLiveness: Send + Sync {
    async fn is_alive(&self, master_session_id: &str) -> bool;
    /// The master now serving this project, if one is up.
    // cm:guard asked ONLY for a park, and the reason is the asymmetry below: a live run whose master died is genuinely orphaned and must be closed, while a park is a question already put to a human and has to outlive the process that asked it. Re-parenting a live run would hand a new master a pane it never spawned and cannot address (ISS-964 criterion 28).
    async fn live_master_for_project(&self, project_id: &str) -> Option<String>;
}

/// Whether a pid this box recorded is gone from THIS boot's process table.
// cm:guard only a positive refutation may answer true: "cannot tell" and "not permitted to ask" are both false, because `Ledger::liveness` turns a true into `Dead` and a `Dead` run has its worktree released and its leases returned. An EPERM from a process another user owns says it EXISTS (ISS-964 criterion 35).
#[async_trait::async_trait]
pub trait ProcessLiveness: Send + Sync {
    async fn is_gone(&self, pid: u32) -> bool;
}

/// Telling core this box still holds a run.
// cm:edge contract -> packages/core/src/devices/run-session-reaper.ts — the beat this sends is the ONLY thing that keeps a run out of that sweep, and it asserts "this box still holds this run", never progress. A wedged-but-alive pane keeps beating on purpose; that case belongs to the close loop and to `RunActivity` below, not to a reaper pretending to be a liveness detector.
#[async_trait::async_trait]
pub trait Heartbeat: Send + Sync {
    async fn beat(&self, session_id: &str) -> Result<()>;
}

/// What a run's own session last reported about itself.
// cm:guard the ONLY evidence of doneness this loop may read, and it is the session's own word rather than a screen, a byte count or a cost. Everything else the box can observe about a finished run pane is identical to a working one — same process, same pane, same prompt drawn — which is why a reader built on any of those was wrong every time (ISS-933 criteria 17 and 18).
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/agent_activity.rs — `None` here MUST mean "never reported" and never "idle", because that module answers `None` for a pane whose hooks never fired and the two readings differ by whether live agents get killed.
#[async_trait::async_trait]
pub trait RunActivity: Send + Sync {
    async fn reported(&self, session_id: &str) -> Option<Reported>;
}

/// What decides whether a run keeps living: what core is told, and what the
/// session says of itself.
// cm:guard ONE struct because the beat and the report are ONE decision, taken together every pass. Passed separately they can be wired apart, and a sweep that beats without reading the report is precisely the box that beat 32 finished panes for 22 hours (forge-vm 2026-09-12).
pub struct RunWatch<'a> {
    pub beat: &'a dyn Heartbeat,
    pub idle: &'a dyn RunActivity,
}

/// One run recovery attempted, and how far its loop got.
#[derive(Debug, Clone)]
pub struct Recovered {
    pub run_id: String,
    pub project_id: Option<String>,
    pub state: CloseState,
    /// This run's own close loop cannot advance without someone taking its
    /// worktree back first, and nothing else on the box will.
    pub owed_release: bool,
    /// This run reported itself finished and its process is still up. Ending
    /// it is what starts every other mark moving; nothing here has done it.
    // cm:guard NAMED here and performed by the caller, exactly as `owed_release` is. This module holds no port that can signal a process — `ProcessLiveness` may only ask whether a pid is gone — and giving it one would let a pass that decides a run is finished also kill it, with no separate reader between the judgement and the signal.
    pub owed_idle_exit: bool,
}

/// One pass over what this box holds: beat what lives, close what does not.
// cm:guard the beat and the recovery are ONE sweep on purpose. Core reaps a run session that stops beating, so a build that could wire recovery without wiring the beat would reap every healthy run on the box after ten minutes — split them and nothing but review stands between here and that (ISS-933 criteria 16 and 25a).
// cm:edge protocol -> packages/core/src/devices/run-session-reaper.ts — the same release on the other axis, and the two are deliberately not symmetric: this one is fast and cannot fire when the box itself is gone, that one waits out a heartbeat and always can (ISS-933 criterion 25a).
pub async fn reconcile(
    ledger: &mut Ledger,
    boot_id: &str,
    masters: &dyn MasterLiveness,
    procs: &dyn ProcessLiveness,
    sessions: &dyn SessionReader,
    leases: &dyn LeaseKeeper,
    watch: RunWatch<'_>,
) -> Result<Vec<Recovered>> {
    let mut out = Vec::new();
    for run in ledger.unclosed_runs()? {
        // cm:guard the park is answered BEFORE either orphan premise is read, because a park satisfies both of them by design: its process is gone, so a reboot changes the boot it recorded, and its master may well have exited over it. Read in the other order, the death of a master — or any reboot of the box — releases the worktree and returns the lease of a question a human has already been asked (ISS-964 criterion 28).
        if run.is_parked_on_human() {
            if !masters.is_alive(&run.master_session_id).await {
                if let Some(project) = run.project_id.as_deref() {
                    if let Some(parent) = masters.live_master_for_project(project).await {
                        ledger.reparent_run(&run.run_id, &parent)?;
                    }
                }
            }
            // cm:guard the beat is NOT skipped by this exemption: `run-session-reaper.ts` gives back a run whose heartbeat stops for ten minutes, so a park the box preserves while going silent is one core takes anyway — the exemption would move the reaping rather than prevent it.
            if let Some(id) = run.session_id.as_deref() {
                let _ = watch.beat.beat(id).await;
            }
            continue;
        }
        // cm:guard a DIFFERENT boot short-circuits the liveness question rather than answering it — a pid or a pane name recorded before a reboot may belong to something else entirely by now, so asking whether it is alive is asking about a stranger. Keying on the boot ALONE, though, never fires for a master that died within this one, which is the failure recovery exists to repair (ISS-933 criterion 16).
        // cm:guard the run's OWN process is a term here beside its master's, and it is the one that fires for the failure neither other term can see: `POST /me/master-session` re-FINDS an existing session, so a master id survives killing and respawning that pane, `is_alive` then answers true over runs whose panes died in the same restart, and the box beats dead runs forever — core's reaper never fires and every lease they hold stays held by derivation. Measured forge-vm 2026-09-09: 19 of 22 unclosed runs dead-pid and beating, 24 leases over 5 projects, pool empty.
        let pid_refuted = match run.pid {
            Some(pid) => procs.is_gone(pid).await,
            None => false,
        };
        let orphaned = run.boot_id != boot_id
            || matches!(Ledger::liveness(&run, boot_id, pid_refuted), Liveness::Dead)
            || !masters.is_alive(&run.master_session_id).await;
        if !orphaned {
            let Some(id) = run.session_id.as_deref() else {
                continue;
            };
            // cm:guard the verdict is read BEFORE the beat and the two are exclusive, which is the whole repair: beating a run that reported itself finished is what kept core's reaper off it, and a build that beat first and ended second would renew the ten minutes it is trying to stop. Measured forge-vm 2026-09-12 — 32 idle panes, the oldest 22 hours, every one beaten every thirty seconds.
            if run_exit::verdict(watch.idle.reported(id).await, now_ms()) == Verdict::Exit {
                out.push(Recovered {
                    run_id: run.run_id.clone(),
                    project_id: run.project_id.clone(),
                    state: close_loop::state(ledger, &run.run_id)?,
                    owed_release: false,
                    owed_idle_exit: true,
                });
                continue;
            }
            let _ = watch.beat.beat(id).await;
            continue;
        }
        let state = close_loop::close(ledger, &run.run_id, sessions, leases).await?;
        // cm:why the deadlock this term exists to break: `end_run` is reached only through `close.is_closed()`, that needs the `worktree_gone` mark, the mark is set only by OBSERVING the tree gone, and the sole remover — the reap — refuses every tree whose run is `ended_by IS NULL`. A run whose session ends outside `terminate` therefore holds its checkout and its leases forever. Measured forge-vm 2026-09-10: 24 runs, 24 trees, every mark in that cycle true and nothing on the box able to advance one of them.
        // cm:guard all four terms are load-bearing and none may be dropped for the others: `pid_refuted` is a POSITIVE refutation of the run's own process (unknown and not-permitted both answer false), the boot must be THIS one because a pid recorded before a reboot names a stranger, `session_terminal` is core's row rather than this box's opinion, and a tree already gone is owed nothing. Weaken any one and recovery deletes the checkout of a run still writing into it.
        // cm:edge protocol -> packages/runner/crates/forge-runner-core/src/runner/terminate.rs — this only NAMES the runs owed a release; performing it is `force_terminal`'s (preserve → remove → close → `end_run`, in that order), and it belongs to the caller because resolving a project's repo path is `resolve_repo`'s alone.
        let owed_release =
            pid_refuted && run.boot_id == boot_id && state.session_terminal && !state.worktree_gone;
        out.push(Recovered {
            run_id: run.run_id,
            project_id: run.project_id,
            state,
            owed_release,
            owed_idle_exit: false,
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

    struct Masters(HashSet<String>);
    #[async_trait::async_trait]
    impl MasterLiveness for Masters {
        async fn is_alive(&self, master_session_id: &str) -> bool {
            self.0.contains(master_session_id)
        }
        async fn live_master_for_project(&self, _: &str) -> Option<String> {
            None
        }
    }

    struct Respawned(&'static str);
    #[async_trait::async_trait]
    impl MasterLiveness for Respawned {
        async fn is_alive(&self, master_session_id: &str) -> bool {
            master_session_id == self.0
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
        })
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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

    // cm:guard the run here is one NOTHING else on the box can advance, and that is the whole point: its tree is on the disk, so `worktree_gone` cannot be observed; without the mark `is_closed` is false, so `end_run` is never called; and `held_worktrees` is `ended_by IS NULL`, so the reap refuses the tree forever. The assertion is that recovery NAMES it, because a sweep that merely logged this state is what left 24 runs and 24 trees held on forge-vm (2026-09-10).
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

    // cm:guard the pid answering is the ONLY difference from the test above, and it must be enough on its own: everything downstream of `owed_release` kills a process group and removes a checkout, so a build that owed a release here would delete the tree an agent is writing into.
    #[tokio::test]
    async fn a_run_whose_own_pid_still_answers_is_owed_no_release() {
        let done = reconcile_held(424_243, &[], "boot-a", "boot-a").await;
        assert_eq!(
            done.len(),
            1,
            "a dead master still leaves the run to recovery"
        );
        assert!(
            !done[0].owed_release,
            "an unrefuted pid may not license a kill and a worktree removal — `is_gone` answers false for both 'alive' and 'cannot tell'"
        );
    }

    // cm:guard a pid recorded under a DIFFERENT boot names a stranger, so it may not be killed however the liveness port answers. `terminate::verb_for` refuses this row by name; owing a release for it would send it there for nothing every sweep.
    #[tokio::test]
    async fn a_run_from_a_previous_boot_is_owed_no_release() {
        let done = reconcile_held(424_244, &[424_244], "boot-old", "boot-new").await;
        assert_eq!(done.len(), 1);
        assert!(
            !done[0].owed_release,
            "the pid is from another boot — reclaiming on it is reclaiming on a claim nobody checked"
        );
    }

    // cm:guard a park holds its tree deliberately and must never be owed a release; it is answered before either orphan premise and emits no `Recovered` at all (ISS-964 criterion 28).
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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
            &Sessions,
            &leases,
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
            &Sessions,
            &leases,
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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

    // cm:guard the two halves are asserted together because either alone is the bug: naming the run while still beating it renews the ten minutes that would have reaped it, and stopping the beat without naming it leaves a live process nobody ends.
    #[tokio::test]
    async fn a_run_that_reported_itself_finished_is_named_and_not_beaten() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let beats = Beats::default();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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

    // cm:guard a run whose session never reported is the pane whose hooks failed to install, and it must be beaten like any other: this is the arm that decides whether an upgrade that loses the hook channel kills every live agent on the box.
    #[tokio::test]
    async fn a_run_that_has_reported_nothing_is_beaten_like_any_other() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let beats = Beats::default();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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

    // cm:guard the defect this exempts is not hypothetical: a master crash-loop is a routine event on a box, and a park is `unclosed` by design — so before this, the death of the master released the worktree, returned the lease and destroyed a question a human had already been asked (ISS-964 criterion 28).
    #[tokio::test]
    async fn a_park_is_not_closed_because_its_master_died() {
        let mut led = parked("run-1", "master-dead", "boot-a");
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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

    // cm:guard a park is exempt from the BOOT premise too, and this is the case that premise cannot express: the process being gone is what a park IS, so a reboot makes every park on the box look exactly like the state recovery exists to clean up.
    #[tokio::test]
    async fn a_park_survives_the_box_rebooting_under_it() {
        let mut led = parked("run-1", "master-dead", "boot-before");
        let done = reconcile(
            &mut led,
            "boot-after",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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

    // cm:guard the park must keep BEATING while it is exempt here, and the two halves are one rule: `run-session-reaper.ts` releases a run session whose heartbeat stops for ten minutes, so an exemption that skipped the beat would have core destroy the park from the other side while the box carefully preserved it.
    #[tokio::test]
    async fn a_park_keeps_beating_so_cores_reaper_leaves_it_alone() {
        let mut led = parked("run-1", "master-dead", "boot-a");
        let beats = Beats::default();
        reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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

    // cm:guard the master here is LIVE and the boot MATCHES, so this run is invisible to both of the other two terms — the row is the whole reason the pid term exists (forge-vm 2026-09-09: 19 of 22, 24 leases, 5 projects).
    #[tokio::test]
    async fn a_run_whose_own_process_is_gone_is_closed_under_a_master_that_lives() {
        let mut led = with_pid("run-1", "master-live", "boot-a", 4242);
        let beats = Beats::default();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &Gone(HashSet::from([4242])),
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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

    // cm:guard `pid: None` is the mid-start window — the row exists, the pane does not yet — and it must read as UNKNOWN, never dead. `run_session::start` writes the ledger first on purpose, so a sweep landing in that window would close the loop over a run about to spawn (ISS-964 criterion 35).
    #[tokio::test]
    async fn a_run_that_has_not_recorded_a_pid_yet_is_left_to_finish_starting() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &Gone(HashSet::from([0, 1])),
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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

    // cm:guard EVERY park is `Dead` to `Ledger::liveness` — `is_parked_on_human` requires `Incarnation::Exited` and liveness answers `Dead` for `(Exited, _)` — so the exemption holds ONLY because the park branch returns before the orphan terms are read. This test is what stops the two being reordered (ISS-964 criterion 28).
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
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
