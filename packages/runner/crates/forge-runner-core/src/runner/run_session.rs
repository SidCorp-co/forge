//! Creating a run session (ISS-933 step 2).
//!
//! A run is a worktree, a group of issues and a terminal session — and the
//! order those three come into being in is the whole of this module. The
//! ledger row is committed FIRST, before git is touched and long before a
//! process exists, so every later reader is answering from a record that was
//! written when nothing could yet have gone wrong.
//!
//! The inverse order is the one that looks natural and is wrong: spawn, then
//! record. A crash in that window leaves a live agent writing a worktree that
//! nothing on the box knows about, which is how two sessions ended up in one
//! tree (pids 334254 and 335001, same cwd).

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::runner::ledger::{Ledger, NewRun, Run};

/// How a run's terminal session is started. Production is tmux; a test
/// supplies one that fails, so the crash-between-steps case is reachable.
#[async_trait::async_trait]
pub trait Spawner: Send + Sync {
    async fn spawn(&self, session_name: &str, cwd: &Path, argv: &[String]) -> Result<u32>;
}

/// What the master decided: a group, a branch, and where the repo is.
pub struct RunRequest {
    pub run_id: String,
    pub master_session_id: String,
    pub boot_id: String,
    pub issue_keys: Vec<String>,
    pub repo: String,
    pub branch: String,
    pub start_point: Option<String>,
    pub argv: Vec<String>,
}

/// Create the worktree, record the run, then start it — in that order.
// cm:guard the three steps are ordered LEDGER, WORKTREE, SPAWN and the order is the deliverable, not an implementation detail. Recording first means a crash anywhere after it leaves a row a recovery can act on; recording last means a live process nothing knows about. The ledger's own refusals also run inside step one, which is what makes criterion 12 true — a worktree path another live run holds is refused BEFORE `git worktree add` can produce the `.worktrees/<name> already exists` failure that killed ISS-593's first job.
pub async fn start(ledger: &mut Ledger, req: RunRequest, spawner: &dyn Spawner) -> Result<Run> {
    let worktree_path = crate::workspace::worktree::path(&req.repo, &req.branch);
    let run = ledger.create_run_group(NewRun {
        run_id: req.run_id.clone(),
        master_session_id: req.master_session_id,
        worktree_path: worktree_path.clone(),
        boot_id: req.boot_id,
        issue_keys: req.issue_keys,
    })?;

    let created: PathBuf =
        crate::workspace::worktree::create(&req.repo, &req.branch, req.start_point.as_deref())
            .await?;

    let name =
        crate::daemon::terminal::session_name(crate::daemon::terminal::RUN_PREFIX, &req.branch);
    let pid = spawner.spawn(&name, &created, &req.argv).await?;
    ledger.attach_pid(&run.run_id, pid)?;

    ledger
        .run(&req.run_id)?
        .ok_or_else(|| Error::Other("run_session: run vanished after start".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::terminal::{session_name, MASTER_PREFIX, RUN_PREFIX};

    const TERMINAL_SOURCE: &str = include_str!("../daemon/terminal.rs");
    const THIS_SOURCE: &str = include_str!("run_session.rs");

    struct Failing;

    #[async_trait::async_trait]
    impl Spawner for Failing {
        async fn spawn(&self, _: &str, _: &Path, _: &[String]) -> Result<u32> {
            Err(Error::Other("tmux refused".into()))
        }
    }

    fn req() -> RunRequest {
        RunRequest {
            run_id: "run-1".into(),
            master_session_id: "master-1".into(),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-957".into(), "ISS-963".into()],
            repo: "/repo".into(),
            branch: "grp-1".into(),
            start_point: None,
            argv: vec!["claude".into()],
        }
    }

    #[tokio::test]
    async fn the_run_is_recorded_before_anything_can_spawn_it() {
        let mut led = Ledger::open_in_memory().unwrap();
        let r = req();
        let run_id = r.run_id.clone();
        let _ = start(&mut led, r, &Failing).await;

        let row = led
            .run(&run_id)
            .unwrap()
            .expect("a run that failed to spawn must still be ON the ledger — recording after the spawn leaves a live agent in a worktree nothing knows about (ISS-933 criterion 3)");
        assert_eq!(row.pid, None, "an unstarted run must carry no pid");
        assert_eq!(led.issues(&run_id).unwrap().len(), 2);
    }

    #[test]
    fn a_run_pane_and_a_master_pane_differ_only_by_the_prefix() {
        assert_eq!(session_name(RUN_PREFIX, "grp-1"), "forge-run-grp-1");
        assert_eq!(session_name(MASTER_PREFIX, "grp-1"), "forge-master-grp-1");
        assert_ne!(RUN_PREFIX, MASTER_PREFIX);
    }

    #[test]
    fn there_is_one_spawn_primitive_and_runs_reuse_it() {
        let ensures = TERMINAL_SOURCE
            .lines()
            .filter(|l| l.trim_start().starts_with("pub async fn ensure"))
            .count();
        assert_eq!(
            ensures, 1,
            "a second `ensure` is a second spawn path, and the one that runs less often is the one that rots (ISS-933 criterion 1)"
        );
        for verb in [
            "pub async fn alive",
            "pub async fn kill",
            "pub async fn send_line",
        ] {
            assert_eq!(
                TERMINAL_SOURCE
                    .lines()
                    .filter(|l| l.trim_start().starts_with(verb))
                    .count(),
                1,
                "`{verb}` must exist once and take the name a caller built from a prefix"
            );
        }
    }

    #[test]
    fn a_run_mints_no_credential_of_its_own() {
        let production = THIS_SOURCE
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for banned in ["mint", "job_token", "session_token", "run_token"] {
            assert!(
                !production.contains(banned),
                "a run authenticates with the box's own credential and mints nothing of its own (ISS-933 criterion 5); found `{banned}` in the production half of this module"
            );
        }
    }
}
