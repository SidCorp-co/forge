use super::*;
use runner_core::ledger::NewRun;
use runner_platform::error::Error;
use runner_workspace::close_loop::LeaseKeeper;
use std::sync::Mutex;

struct Masters(MasterPresence);

#[async_trait::async_trait]
impl MasterLiveness for Masters {
    async fn state(&self, _master_session_id: &str) -> MasterPresence {
        self.0
    }
    async fn live_master_for_project(&self, _project_id: &str) -> Option<String> {
        None
    }
}

struct Procs;

#[async_trait::async_trait]
impl ProcessLiveness for Procs {
    async fn is_gone(&self, _pid: u32) -> bool {
        false
    }
}

struct World;

#[async_trait::async_trait]
impl SessionReader for World {
    async fn is_terminal(&self, _agent_session_id: &str) -> Result<bool> {
        Ok(true)
    }
}

#[async_trait::async_trait]
impl LeaseKeeper for World {
    async fn release(&self, _project_id: Option<&str>, _issue_key: &str) -> Result<()> {
        Ok(())
    }
    async fn is_returned(&self, _project_id: Option<&str>, _issue_key: &str) -> Result<bool> {
        Ok(true)
    }
}

impl RepoRoots for World {
    fn root_for(&self, _project_id: &str) -> Option<PathBuf> {
        None
    }
}

struct Quiet;

#[async_trait::async_trait]
impl RunActivity for Quiet {
    async fn reported(&self, _session_id: &str) -> Option<Reported> {
        None
    }
}

/// A core that answers each ask from a script, in order, and records what it
/// was asked and which sessions it was told are held.
struct Core {
    answers: Mutex<Vec<Result<Verdict>>>,
    asked: Mutex<Vec<Facts>>,
    beaten: Mutex<Vec<String>>,
}

impl Core {
    fn answering(answers: Vec<Result<Verdict>>) -> Self {
        Self {
            answers: Mutex::new(answers.into_iter().rev().collect()),
            asked: Mutex::new(Vec::new()),
            beaten: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait::async_trait]
impl RunCore for Core {
    async fn beat(&self, session_id: &str) -> Result<()> {
        self.beaten.lock().unwrap().push(session_id.to_string());
        Ok(())
    }
    async fn verdict(&self, _project_id: Option<&str>, facts: &Facts) -> Result<Verdict> {
        self.asked.lock().unwrap().push(facts.clone());
        self.answers
            .lock()
            .unwrap()
            .pop()
            .expect("core was asked more often than this case scripted")
    }
}

const BOOT: &str = "boot-1";

fn ledger_with_one_run() -> (Ledger, PathBuf) {
    let dir = std::env::temp_dir().join(format!("forge-recovery-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut ledger = Ledger::open(&dir.join("ledger.db")).unwrap();
    ledger
        .create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: dir.join("tree"),
            boot_id: BOOT.into(),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
    ledger.attach_session("run-1", "session-1").unwrap();
    (ledger, dir)
}

async fn sweep(ledger: &mut Ledger, core: &Core) -> Vec<Recovered> {
    let world = World;
    reconcile(
        ledger,
        BOOT,
        &Masters(MasterPresence::Gone),
        &Procs,
        Closing {
            sessions: &world,
            leases: &world,
            roots: &world,
        },
        RunWatch { core, idle: &Quiet },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_run_core_gives_no_verdict_on_is_held_as_it_stands_and_never_decided_here() {
    let (mut ledger, dir) = ledger_with_one_run();
    let core = Core::answering(vec![Err(Error::Other("404 no such route".into()))]);
    let owed = sweep(&mut ledger, &core).await;
    assert!(
        owed.is_empty(),
        "a run core did not judge was acted on: {owed:?}"
    );
    let run = ledger.run("run-1").unwrap().unwrap();
    assert!(
        run.ended_by.is_none(),
        "the box ended a run on its own word"
    );
    assert!(
        run.session_terminal_at.is_none(),
        "the box ran a close nobody ordered"
    );
    assert_eq!(*core.beaten.lock().unwrap(), vec!["session-1".to_string()]);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_close_core_orders_ends_the_run_closes_it_and_asks_again_with_the_marks() {
    let (mut ledger, dir) = ledger_with_one_run();
    let core = Core::answering(vec![
        Ok(Verdict::Close {
            end: Some("declared and never bound".into()),
            because: "b".into(),
        }),
        Ok(Verdict::Settle {
            release: Some(run_verdict::Release {
                reason: "the run's process is gone".into(),
                notice: None,
            }),
            death_report: false,
            standing: None,
            release_after_minutes: 60,
            because: "b".into(),
        }),
    ]);
    let owed = sweep(&mut ledger, &core).await;
    let run = ledger.run("run-1").unwrap().unwrap();
    assert_eq!(run.ended_by.as_deref(), Some(ENDED_BY_BOX));
    assert_eq!(
        run.ended_reason.as_deref(),
        Some("declared and never bound")
    );
    let asked = core.asked.lock().unwrap();
    assert!(asked[0].close.is_none() && !asked[0].ended);
    let second = asked
        .get(1)
        .expect("core was not asked what the close left owed");
    assert!(second.ended && second.ledger_dead && second.close.is_some());
    assert_eq!(owed.len(), 1);
    assert_eq!(
        owed[0].release.as_deref(),
        Some("the run's process is gone")
    );
    assert!(core.beaten.lock().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_keep_without_a_beat_beats_nothing() {
    let (mut ledger, dir) = ledger_with_one_run();
    let core = Core::answering(vec![Ok(Verdict::Keep {
        beat: false,
        reparent: false,
        say_kept: false,
        because: "b".into(),
    })]);
    assert!(sweep(&mut ledger, &core).await.is_empty());
    assert!(core.beaten.lock().unwrap().is_empty());
    let facts = &core.asked.lock().unwrap()[0];
    assert_eq!((facts.master, facts.process), ("gone", "none"));
    let _ = std::fs::remove_dir_all(dir);
}
