/*
 * Giving back a run session the box is still recorded as holding.
 *
 * A run outlives the master that started it: the ledger row is written before
 * anything spawns, so a master that dies mid-run leaves marks nobody will set.
 * This is the local half — fast, and blind to the box's own death. The half
 * that survives losing power lives at core, keyed on the heartbeat.
 */

use crate::error::Result;
use crate::runner::close_loop::{self, CloseState, LeaseKeeper, SessionReader};
use crate::runner::ledger::Ledger;

/// Whether the master that started a run is still there to finish it.
#[async_trait::async_trait]
pub trait MasterLiveness: Send + Sync {
    async fn is_alive(&self, master_session_id: &str) -> bool;
}

/// Telling core this box still holds a run.
// cm:edge contract -> packages/core/src/devices/run-session-reaper.ts — the beat this sends is the ONLY thing that keeps a run out of that sweep, and it asserts "this box still holds this run", never progress. A wedged-but-alive pane keeps beating on purpose; that case belongs to the close loop and the idle self-exit, not to a reaper pretending to be a liveness detector.
#[async_trait::async_trait]
pub trait Heartbeat: Send + Sync {
    async fn beat(&self, session_id: &str) -> Result<()>;
}

/// One run recovery attempted, and how far its loop got.
#[derive(Debug, Clone)]
pub struct Recovered {
    pub run_id: String,
    pub state: CloseState,
}

/// One pass over what this box holds: beat what lives, close what does not.
// cm:guard the beat and the recovery are ONE sweep on purpose. Core reaps a run session that stops beating, so a build that could wire recovery without wiring the beat would reap every healthy run on the box after ten minutes — split them and nothing but review stands between here and that (ISS-933 criteria 16 and 25a).
// cm:edge protocol -> packages/core/src/devices/run-session-reaper.ts — the same release on the other axis, and the two are deliberately not symmetric: this one is fast and cannot fire when the box itself is gone, that one waits out a heartbeat and always can (ISS-933 criterion 25a).
pub async fn reconcile(
    ledger: &mut Ledger,
    boot_id: &str,
    masters: &dyn MasterLiveness,
    sessions: &dyn SessionReader,
    leases: &dyn LeaseKeeper,
    core: &dyn Heartbeat,
) -> Result<Vec<Recovered>> {
    let mut out = Vec::new();
    for run in ledger.unclosed_runs()? {
        // cm:guard a DIFFERENT boot short-circuits the liveness question rather than answering it — a pid or a pane name recorded before a reboot may belong to something else entirely by now, so asking whether it is alive is asking about a stranger. Keying on the boot ALONE, though, never fires for a master that died within this one, which is the failure recovery exists to repair (ISS-933 criterion 16).
        let orphaned = run.boot_id != boot_id || !masters.is_alive(&run.master_session_id).await;
        if !orphaned {
            if let Some(id) = run.session_id.as_deref() {
                let _ = core.beat(id).await;
            }
            continue;
        }
        let state = close_loop::close(ledger, &run.run_id, sessions, leases).await?;
        out.push(Recovered {
            run_id: run.run_id,
            state,
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

    #[derive(Default)]
    struct Beats(Mutex<Vec<String>>);
    #[async_trait::async_trait]
    impl Heartbeat for Beats {
        async fn beat(&self, session_id: &str) -> Result<()> {
            self.0.lock().unwrap().push(session_id.to_string());
            Ok(())
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

    #[tokio::test]
    async fn a_master_that_died_mid_run_has_its_run_closed_from_the_ledger() {
        let mut led = seeded("run-1", "master-dead", "boot-a", &["ISS-957", "ISS-958"]);
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
            &Beats::default(),
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
            &Beats::default(),
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
            &Beats::default(),
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
            &Sessions,
            &leases,
            &Beats::default(),
        )
        .await
        .unwrap();
        let again = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &Sessions,
            &leases,
            &Beats::default(),
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
            &Sessions,
            &Leases(Mutex::new(HashSet::new())),
            &beats,
        )
        .await
        .unwrap();
        assert_eq!(
            beats.0.lock().unwrap().as_slice(),
            ["core-sess-1"],
            "a sweep that leaves a live run alone but never tells core so has handed that run to core's ten-minute reaper — the beat and the recovery are one pass precisely so this cannot be built apart (ISS-933 criteria 16 and 25a)"
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
}
