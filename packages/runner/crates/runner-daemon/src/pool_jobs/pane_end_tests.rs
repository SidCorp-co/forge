//! A job pane is ended on evidence that holds, and the pane of a job that is over does not stand
//! (ISS-1351). Each double is scripted per sweep and writes to one log.

use std::sync::Arc;

use super::*;

type Log = Arc<Mutex<Vec<String>>>;

/// A terminal whose readings the test scripts sweep by sweep.
struct Scripted {
    /// What `gone` answers, one per call; the last one repeats.
    gone: Mutex<Vec<bool>>,
    pid: Option<u32>,
    idle: Mutex<Option<Duration>>,
    names: Mutex<Vec<String>>,
    log: Log,
}

impl Scripted {
    fn new(gone: Vec<bool>, pid: Option<u32>, idle: Option<Duration>, log: &Log) -> Self {
        Self {
            gone: Mutex::new(gone),
            pid,
            idle: Mutex::new(idle),
            names: Mutex::new(Vec::new()),
            log: log.clone(),
        }
    }
}

#[async_trait::async_trait]
impl Panes for Scripted {
    async fn open(
        &self,
        _name: &str,
        _cwd: &Path,
        _prompt: &str,
        _env: &[(String, String)],
        _launch: &Launch<'_>,
    ) -> Result<()> {
        unreachable!("a sweep opens nothing")
    }
    async fn released(&self, _name: &str) {}
    async fn gone(&self, _name: &str) -> bool {
        let mut gone = self.gone.lock().unwrap();
        if gone.len() > 1 {
            gone.remove(0)
        } else {
            gone[0]
        }
    }
    async fn kill(&self, name: &str) -> Result<()> {
        self.log.lock().unwrap().push(format!("kill {name}"));
        self.names.lock().unwrap().retain(|n| n != name);
        Ok(())
    }
    async fn pid(&self, _name: &str) -> Option<u32> {
        self.pid
    }
    async fn idle_for(&self, _name: &str) -> Option<Duration> {
        *self.idle.lock().unwrap()
    }
    async fn names(&self) -> Vec<String> {
        self.names.lock().unwrap().clone()
    }
    async fn send_line(
        &self,
        _name: &str,
        _text: &str,
    ) -> std::result::Result<terminal::Prompt, terminal::NotTyped> {
        unreachable!("a sweep types nothing")
    }
}

/// Core answering every heartbeat with one standing, and logging each failure it is told.
struct Core {
    standing: Standing,
    log: Log,
}

#[async_trait::async_trait]
impl Report for Core {
    async fn ack(&self, _job_id: &str) -> Result<()> {
        Ok(())
    }
    async fn progress(&self, _job_id: &str, _runtime_state: Option<&str>) -> Result<Standing> {
        Ok(self.standing)
    }
    async fn fail(&self, job_id: &str, error: &str) -> Result<bool> {
        self.log
            .lock()
            .unwrap()
            .push(format!("fail {job_id}: {error}"));
        Ok(true)
    }
    async fn kill_ack(&self, job_id: &str, outcome: &str) -> Result<()> {
        self.log
            .lock()
            .unwrap()
            .push(format!("kill-ack {job_id} {outcome}"));
        Ok(())
    }
}

const JOB: &str = "job-e";

fn holding() -> JobPanes {
    let registry = JobPanes::new();
    registry.hold(JOB, &pane_name(JOB), Watch::Unhooked, None, None, None);
    registry
}

async fn sweep(panes: &Scripted, core: &Core, registry: &JobPanes) {
    supervise(panes, core, &NoRecords, registry, &Activities::new()).await;
}

fn failures(log: &Log) -> Vec<String> {
    log.lock()
        .unwrap()
        .iter()
        .filter(|l| l.starts_with("fail "))
        .cloned()
        .collect()
}

fn core(standing: Standing, log: &Log) -> Core {
    Core {
        standing,
        log: log.clone(),
    }
}

#[tokio::test]
async fn a_pane_read_gone_once_that_answers_again_is_not_failed_and_keeps_its_slot() {
    let log: Log = Arc::default();
    let panes = Scripted::new(vec![true, false], None, None, &log);
    let core = core(Standing::Ours, &log);
    let registry = holding();
    sweep(&panes, &core, &registry).await;
    sweep(&panes, &core, &registry).await;
    sweep(&panes, &core, &registry).await;
    assert_eq!(
        failures(&log),
        Vec::<String>::new(),
        "one gone-read failed a running job, and core hands its next attempt out"
    );
    assert_eq!(
        registry.count(),
        1,
        "the slot of a live pane was given back"
    );
}

#[tokio::test]
async fn a_pane_read_gone_on_two_sweeps_whose_process_still_runs_is_not_failed() {
    let log: Log = Arc::default();
    // This test's own process stands in for the pane's agent: it runs for the whole test.
    let panes = Scripted::new(
        vec![false, true, true, true],
        Some(std::process::id()),
        None,
        &log,
    );
    let core = core(Standing::Ours, &log);
    let registry = holding();
    for _ in 0..4 {
        sweep(&panes, &core, &registry).await;
    }
    assert_eq!(failures(&log), Vec::<String>::new());
    assert_eq!(registry.count(), 1);
    assert_eq!(
        registry.process_of(JOB).map(|p| p.pid),
        Some(std::process::id())
    );
}

#[tokio::test]
async fn a_pane_read_gone_on_two_sweeps_with_no_process_left_is_failed_once() {
    let log: Log = Arc::default();
    let panes = Scripted::new(vec![true], None, None, &log);
    let core = core(Standing::Ours, &log);
    let registry = holding();
    sweep(&panes, &core, &registry).await;
    assert_eq!(failures(&log), Vec::<String>::new(), "failed on one read");
    sweep(&panes, &core, &registry).await;
    let failed = failures(&log);
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert!(failed[0].contains("ended without reporting an outcome"));
    assert_eq!(registry.count(), 0);
}

#[tokio::test]
async fn a_job_that_is_over_leaves_no_pane_once_its_pane_is_idle() {
    let log: Log = Arc::default();
    let panes = Scripted::new(vec![false], None, Some(Duration::from_secs(10)), &log);
    let core = core(Standing::Over, &log);
    let registry = holding();
    sweep(&panes, &core, &registry).await;
    assert!(
        log.lock().unwrap().is_empty(),
        "a pane still writing was closed mid-turn: {:?}",
        log.lock().unwrap()
    );
    assert_eq!(registry.count(), 1);
    *panes.idle.lock().unwrap() = Some(IDLE_BEFORE_CLOSE);
    sweep(&panes, &core, &registry).await;
    assert_eq!(
        *log.lock().unwrap(),
        vec![format!("kill {}", pane_name(JOB))]
    );
    assert_eq!(registry.count(), 0);
}

#[tokio::test]
async fn a_job_pane_no_slot_holds_is_taken_back_and_closed_once_its_job_is_over() {
    let log: Log = Arc::default();
    let stray = pane_name("job-stray");
    let panes = Scripted::new(vec![false], None, Some(Duration::from_secs(3600)), &log);
    panes.names.lock().unwrap().push(stray.clone());
    let core = core(Standing::Over, &log);
    let registry = JobPanes::new();
    sweep(&panes, &core, &registry).await;
    assert_eq!(
        registry.count(),
        0,
        "a pane seen once with no slot may be one being opened"
    );
    sweep(&panes, &core, &registry).await;
    assert_eq!(
        *log.lock().unwrap(),
        vec![format!("kill {stray}")],
        "the pane of an ended job stood with no slot holding it, and nothing will ever close it"
    );
    assert_eq!(registry.count(), 0);
    assert!(panes.names().await.is_empty());
}

#[tokio::test]
async fn a_stray_pane_whose_job_still_runs_is_held_again_not_closed() {
    let log: Log = Arc::default();
    let stray = pane_name("job-mine");
    let panes = Scripted::new(vec![false], None, Some(Duration::from_secs(3600)), &log);
    panes.names.lock().unwrap().push(stray.clone());
    let core = core(Standing::Ours, &log);
    let registry = JobPanes::new();
    sweep(&panes, &core, &registry).await;
    sweep(&panes, &core, &registry).await;
    assert!(log.lock().unwrap().is_empty(), "{:?}", log.lock().unwrap());
    assert_eq!(registry.count(), 1);
}
