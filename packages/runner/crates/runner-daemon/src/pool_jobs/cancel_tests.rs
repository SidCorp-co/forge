//! What a cancel does with a job pane whose close, ack or heartbeat answer is scripted.

use super::*;
use std::sync::Mutex;

/// A terminal whose one pane closes, or refuses to, as the test says.
struct ScriptedPanes {
    closes: bool,
    gone: bool,
    killed: Mutex<Vec<String>>,
    released: Mutex<Vec<String>>,
}

impl ScriptedPanes {
    fn new(closes: bool) -> Self {
        Self {
            closes,
            gone: false,
            killed: Mutex::new(Vec::new()),
            released: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait::async_trait]
impl Panes for ScriptedPanes {
    async fn open(
        &self,
        _name: &str,
        _cwd: &Path,
        _prompt: &str,
        _env: &[(String, String)],
        _launch: &Launch<'_>,
    ) -> Result<()> {
        unreachable!("a cancel opens nothing")
    }
    async fn released(&self, name: &str) {
        self.released.lock().unwrap().push(name.to_string());
    }
    async fn gone(&self, _name: &str) -> bool {
        self.gone
    }
    async fn kill(&self, name: &str) -> Result<()> {
        self.killed.lock().unwrap().push(name.to_string());
        if self.closes {
            Ok(())
        } else {
            Err(Error::Other("tmux kill-session: refused".into()))
        }
    }
    async fn names(&self) -> Vec<String> {
        Vec::new()
    }
}

/// Core as the test scripts it: what a heartbeat is answered with and whether an ack is taken.
struct ScriptedCore {
    standing: Standing,
    takes_acks: bool,
    acks: Mutex<Vec<(String, String)>>,
    fails: Mutex<Vec<String>>,
}

impl ScriptedCore {
    fn new(standing: Standing, takes_acks: bool) -> Self {
        Self {
            standing,
            takes_acks,
            acks: Mutex::new(Vec::new()),
            fails: Mutex::new(Vec::new()),
        }
    }
    fn acks(&self) -> Vec<(String, String)> {
        self.acks.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Report for ScriptedCore {
    async fn ack(&self, _job_id: &str) -> Result<()> {
        Ok(())
    }
    async fn progress(&self, _job_id: &str, _runtime_state: Option<&str>) -> Result<Standing> {
        Ok(self.standing)
    }
    async fn fail(&self, job_id: &str, _error: &str) -> Result<bool> {
        self.fails.lock().unwrap().push(job_id.to_string());
        Ok(true)
    }
    async fn kill_ack(&self, job_id: &str, outcome: &str) -> Result<()> {
        self.acks
            .lock()
            .unwrap()
            .push((job_id.to_string(), outcome.to_string()));
        if self.takes_acks {
            Ok(())
        } else {
            Err(Error::Other("lifecycle request 502 Bad Gateway".into()))
        }
    }
}

#[derive(Default)]
struct MemRecords {
    forgotten: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Records for MemRecords {
    async fn note(&self, _live: &Live) {}
    async fn forget(&self, job_id: &str) {
        self.forgotten.lock().unwrap().push(job_id.to_string());
    }
    async fn all(&self) -> Vec<Live> {
        Vec::new()
    }
}

const JOB: &str = "job-c";

fn holding() -> JobPanes {
    let registry = JobPanes::new();
    registry.hold(JOB, &pane_name(JOB), Watch::Unhooked, None, None, None);
    registry
}

#[tokio::test]
async fn a_held_pane_is_closed_acked_killed_and_its_slot_and_record_given_back() {
    let (panes, core, records, registry) = (
        ScriptedPanes::new(true),
        ScriptedCore::new(Standing::Ours, true),
        MemRecords::default(),
        holding(),
    );
    let did = cancel(&panes, &core, &records, &registry, JOB).await;
    assert_eq!(did, Cancelled::Closed);
    assert_eq!(*panes.killed.lock().unwrap(), vec![pane_name(JOB)]);
    assert_eq!(core.acks(), vec![(JOB.to_string(), "killed".to_string())]);
    assert_eq!(registry.count(), 0, "the slot is still held");
    assert_eq!(*records.forgotten.lock().unwrap(), vec![JOB.to_string()]);
    assert_eq!(*panes.released.lock().unwrap(), vec![pane_name(JOB)]);
}

#[tokio::test]
async fn a_pane_that_will_not_close_sends_no_ack_and_keeps_its_slot_and_record() {
    let (panes, core, records, registry) = (
        ScriptedPanes::new(false),
        ScriptedCore::new(Standing::Ours, true),
        MemRecords::default(),
        holding(),
    );
    let did = cancel(&panes, &core, &records, &registry, JOB).await;
    assert!(matches!(did, Cancelled::WouldNotClose(_)), "{did:?}");
    assert!(core.acks().is_empty(), "an ack was sent: {:?}", core.acks());
    assert_eq!(
        registry.count(),
        1,
        "the slot was given back while the pane runs"
    );
    assert!(records.forgotten.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_ack_core_does_not_take_keeps_the_slot_and_record_for_the_next_tick_to_report() {
    let (mut panes, core, records, registry) = (
        ScriptedPanes::new(true),
        ScriptedCore::new(Standing::Ours, false),
        MemRecords::default(),
        holding(),
    );
    let did = cancel(&panes, &core, &records, &registry, JOB).await;
    assert!(matches!(did, Cancelled::Unacked(_)), "{did:?}");
    assert_eq!(
        registry.count(),
        1,
        "the slot was given back with the ack untaken"
    );
    assert!(records.forgotten.lock().unwrap().is_empty());

    // The next tick finds the pane gone and says so, which core settles `cancelled`.
    panes.gone = true;
    supervise(&panes, &core, &records, &registry, &Activities::new()).await;
    assert_eq!(*core.fails.lock().unwrap(), vec![JOB.to_string()]);
    assert_eq!(registry.count(), 0);
}

#[tokio::test]
async fn a_job_this_box_holds_no_pane_for_is_answered_by_the_path_that_knows_other_processes() {
    let pool = PoolPanes {
        panes: Arc::new(ScriptedPanes::new(true)),
        records: Arc::new(MemRecords::default()),
        registry: Arc::new(JobPanes::new()),
    };
    let core = ScriptedCore::new(Standing::Ours, true);
    let asked = Mutex::new(false);
    answer_cancel(&pool, &core, JOB, || async {
        *asked.lock().unwrap() = true;
        "not_found"
    })
    .await;
    assert!(
        *asked.lock().unwrap(),
        "the abort/reap path was never asked"
    );
    assert_eq!(
        core.acks(),
        vec![(JOB.to_string(), "not_found".to_string())]
    );
}

#[tokio::test]
async fn a_held_pane_never_reaches_the_path_that_knows_other_processes() {
    let pool = PoolPanes {
        panes: Arc::new(ScriptedPanes::new(true)),
        records: Arc::new(MemRecords::default()),
        registry: Arc::new(holding()),
    };
    let core = ScriptedCore::new(Standing::Ours, true);
    answer_cancel(&pool, &core, JOB, || async {
        unreachable!("a held pool pane was handed to the abort/reap path")
    })
    .await;
    assert_eq!(core.acks(), vec![(JOB.to_string(), "killed".to_string())]);
}

#[tokio::test]
async fn a_heartbeat_core_refuses_for_a_cancel_closes_the_pane_and_acks_it() {
    let (panes, core, records, registry) = (
        ScriptedPanes::new(true),
        ScriptedCore::new(Standing::CancelRequested, true),
        MemRecords::default(),
        holding(),
    );
    supervise(&panes, &core, &records, &registry, &Activities::new()).await;
    assert_eq!(*panes.killed.lock().unwrap(), vec![pane_name(JOB)]);
    assert_eq!(core.acks(), vec![(JOB.to_string(), "killed".to_string())]);
    assert!(
        core.fails.lock().unwrap().is_empty(),
        "a cancel was reported as a failure"
    );
    assert_eq!(registry.count(), 0);
}

#[tokio::test]
async fn a_heartbeat_core_refuses_as_over_closes_the_pane_and_acks_nothing() {
    let (panes, core, records, registry) = (
        ScriptedPanes::new(true),
        ScriptedCore::new(Standing::Over, true),
        MemRecords::default(),
        holding(),
    );
    supervise(&panes, &core, &records, &registry, &Activities::new()).await;
    assert_eq!(*panes.killed.lock().unwrap(), vec![pane_name(JOB)]);
    assert!(core.acks().is_empty(), "{:?}", core.acks());
    assert_eq!(registry.count(), 0);
}
