//! What a cancel does with a job pane whose close, ack or heartbeat answer is scripted. Every
//! double writes to one log, so a test reads the order the box did things in, not only the end.

use super::*;
use std::sync::Mutex;

type Log = Arc<Mutex<Vec<String>>>;

fn said(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

/// A terminal whose one pane closes, or refuses to, as the test says.
struct ScriptedPanes {
    closes: bool,
    gone: bool,
    log: Log,
    /// A registry a cancel elsewhere lets go of the job in, the moment a sweep asks whether
    /// the pane is gone: the frame handler racing the supervisor.
    cancelled_meanwhile: Option<Arc<JobPanes>>,
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
        self.log.lock().unwrap().push(format!("released {name}"));
    }
    async fn gone(&self, _name: &str) -> bool {
        if let Some(registry) = &self.cancelled_meanwhile {
            registry.forget(JOB);
        }
        self.gone
    }
    async fn kill(&self, name: &str) -> Result<()> {
        self.log.lock().unwrap().push(format!("kill {name}"));
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
    log: Log,
    /// The registry whose hold on the job an ack is logged with, so a test can say the slot was
    /// still held when the ack went.
    registry: Option<Arc<JobPanes>>,
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
        self.log.lock().unwrap().push(format!("fail {job_id}"));
        Ok(true)
    }
    async fn kill_ack(&self, job_id: &str, outcome: &str) -> Result<()> {
        let held = match &self.registry {
            Some(r) => format!(" (holding {})", r.count()),
            None => String::new(),
        };
        self.log
            .lock()
            .unwrap()
            .push(format!("kill-ack {job_id} {outcome}{held}"));
        if self.takes_acks {
            Ok(())
        } else {
            Err(Error::Other("lifecycle request 502 Bad Gateway".into()))
        }
    }
}

struct LoggedRecords {
    log: Log,
}

#[async_trait::async_trait]
impl Records for LoggedRecords {
    async fn note(&self, live: &Live) {
        self.log
            .lock()
            .unwrap()
            .push(format!("record {}", live.job_id));
    }
    async fn forget(&self, job_id: &str) {
        self.log.lock().unwrap().push(format!("forget {job_id}"));
    }
    async fn all(&self) -> Vec<Live> {
        Vec::new()
    }
}

const JOB: &str = "job-c";

fn holding() -> Arc<JobPanes> {
    let registry = Arc::new(JobPanes::new());
    registry.hold(JOB, &pane_name(JOB), Watch::Unhooked, None, None, None);
    registry
}

/// One box: a pane that closes or not, a core that answers as scripted, one log for all three.
struct World {
    log: Log,
    panes: ScriptedPanes,
    core: ScriptedCore,
    records: LoggedRecords,
    registry: Arc<JobPanes>,
}

fn world(closes: bool, standing: Standing, takes_acks: bool, registry: Arc<JobPanes>) -> World {
    let log: Log = Arc::default();
    World {
        panes: ScriptedPanes {
            closes,
            gone: false,
            log: log.clone(),
            cancelled_meanwhile: None,
        },
        core: ScriptedCore {
            standing,
            takes_acks,
            log: log.clone(),
            registry: Some(registry.clone()),
        },
        records: LoggedRecords { log: log.clone() },
        registry,
        log,
    }
}

impl World {
    async fn cancel(&self) -> Cancelled {
        cancel(&self.panes, &self.core, &self.records, &self.registry, JOB).await
    }
    async fn sweep(&self, activity: &Activities) {
        supervise(
            &self.panes,
            &self.core,
            &self.records,
            &self.registry,
            activity,
        )
        .await;
    }
}

#[tokio::test]
async fn a_held_pane_is_closed_then_acked_killed_and_only_then_its_slot_and_record_given_back() {
    let w = world(true, Standing::Ours, true, holding());
    assert_eq!(w.cancel().await, Cancelled::Closed);
    let pane = pane_name(JOB);
    assert_eq!(
        said(&w.log),
        vec![
            format!("kill {pane}"),
            format!("kill-ack {JOB} killed (holding 1)"),
            format!("released {pane}"),
            format!("forget {JOB}"),
        ]
    );
    assert_eq!(w.registry.count(), 0, "the slot is still held");
}

#[tokio::test]
async fn a_pane_that_will_not_close_sends_no_ack_and_keeps_its_slot_and_record() {
    let w = world(false, Standing::Ours, true, holding());
    let did = w.cancel().await;
    assert!(matches!(did, Cancelled::WouldNotClose(_)), "{did:?}");
    assert_eq!(said(&w.log), vec![format!("kill {}", pane_name(JOB))]);
    assert_eq!(
        w.registry.count(),
        1,
        "the slot was given back while the pane runs"
    );
}

#[tokio::test]
async fn an_ack_core_does_not_take_keeps_the_slot_and_record_for_the_next_tick_to_report() {
    let mut w = world(true, Standing::Ours, false, holding());
    let did = w.cancel().await;
    assert!(matches!(did, Cancelled::Unacked(_)), "{did:?}");
    assert_eq!(
        w.registry.count(),
        1,
        "the slot was given back with the ack untaken"
    );
    assert!(
        !said(&w.log).contains(&format!("forget {JOB}")),
        "{:?}",
        said(&w.log)
    );

    // The next tick finds the pane gone and says so, which core settles `cancelled`.
    w.panes.gone = true;
    w.sweep(&Activities::new()).await;
    assert!(
        said(&w.log).contains(&format!("fail {JOB}")),
        "{:?}",
        said(&w.log)
    );
    assert_eq!(w.registry.count(), 0);
}

#[tokio::test]
async fn a_job_this_box_holds_no_pane_for_is_answered_by_the_path_that_knows_other_processes() {
    let w = world(true, Standing::Ours, true, Arc::new(JobPanes::new()));
    let pool = PoolPanes {
        panes: Arc::new(w.panes),
        records: Arc::new(w.records),
        registry: w.registry,
    };
    let asked = Mutex::new(false);
    answer_cancel(&pool, &w.core, JOB, || async {
        *asked.lock().unwrap() = true;
        "not_found"
    })
    .await;
    assert!(
        *asked.lock().unwrap(),
        "the abort/reap path was never asked"
    );
    assert_eq!(
        said(&w.log),
        vec![format!("kill-ack {JOB} not_found (holding 0)")]
    );
}

#[tokio::test]
async fn a_held_pane_never_reaches_the_path_that_knows_other_processes() {
    let w = world(true, Standing::Ours, true, holding());
    let pool = PoolPanes {
        panes: Arc::new(w.panes),
        records: Arc::new(w.records),
        registry: w.registry,
    };
    answer_cancel(&pool, &w.core, JOB, || async {
        unreachable!("a held pool pane was handed to the abort/reap path")
    })
    .await;
    assert!(
        said(&w.log).contains(&format!("kill-ack {JOB} killed (holding 1)")),
        "{:?}",
        said(&w.log)
    );
}

#[tokio::test]
async fn a_heartbeat_core_refuses_for_a_cancel_closes_the_pane_and_acks_it() {
    let w = world(true, Standing::CancelRequested, true, holding());
    w.sweep(&Activities::new()).await;
    let log = said(&w.log);
    assert!(
        log.contains(&format!("kill-ack {JOB} killed (holding 1)")),
        "{log:?}"
    );
    assert!(
        !log.contains(&format!("fail {JOB}")),
        "a cancel was reported as a failure: {log:?}"
    );
    assert_eq!(w.registry.count(), 0);
}

#[tokio::test]
async fn a_heartbeat_core_refuses_as_over_closes_the_pane_and_acks_nothing() {
    let w = world(true, Standing::Over, true, holding());
    w.sweep(&Activities::new()).await;
    let log = said(&w.log);
    assert!(log.contains(&format!("kill {}", pane_name(JOB))), "{log:?}");
    assert!(!log.iter().any(|l| l.starts_with("kill-ack")), "{log:?}");
    assert_eq!(w.registry.count(), 0);
}

/// The supervisor reads its snapshot of the registry, then a frame's cancel closes the pane and
/// gives the slot back, then the supervisor writes what it read of the agent: the slot stays
/// given back.
#[tokio::test]
async fn a_sweep_that_read_a_job_before_a_cancel_let_it_go_does_not_take_its_slot_back() {
    let registry = Arc::new(JobPanes::new());
    let now = runner_core::agent_activity::now_ms();
    let watch = Watch::Hooked {
        session_id: "s".into(),
        delivered_at: now,
    };
    registry.hold(JOB, &pane_name(JOB), watch, None, None, None);
    let activity = Activities::new();
    activity.record(
        "s",
        runner_core::agent_activity::Report {
            event: runner_core::agent_activity::Event::PromptSubmitted,
            at: now,
            subject: None,
            conversation: Some("c"),
            transcript: None,
        },
    );
    let mut w = world(true, Standing::Ours, true, registry.clone());
    w.panes.cancelled_meanwhile = Some(registry);
    w.sweep(&activity).await;
    assert_eq!(w.registry.count(), 0, "the sweep took the slot back");
    assert!(
        !said(&w.log).contains(&format!("record {JOB}")),
        "the sweep wrote the record back: {:?}",
        said(&w.log)
    );
}

/// The whole heartbeat path over the real HTTP client: core refuses the beat
/// `JOB_CANCEL_REQUESTED`, and the box closes the pane and posts kill-ack `killed`.
#[tokio::test]
async fn a_heartbeat_core_refuses_with_job_cancel_requested_reaches_the_cancel() {
    fn answer(path: &str) -> (u16, &'static str) {
        if path.ends_with("/events") {
            (
                422,
                r#"{"code":"JOB_CANCEL_REQUESTED","error":{"code":"JOB_CANCEL_REQUESTED","message":"a cancel was requested"}}"#,
            )
        } else {
            (200, "{}")
        }
    }
    let (client, seen) = crate::test_core::fake_core(answer).await;
    let w = world(true, Standing::Ours, true, holding());
    let report = CoreReport { client: &client };
    supervise(
        &w.panes,
        &report,
        &w.records,
        &w.registry,
        &Activities::new(),
    )
    .await;
    assert!(
        said(&w.log).contains(&format!("kill {}", pane_name(JOB))),
        "{:?}",
        said(&w.log)
    );
    let acks: Vec<String> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(path, _)| path.ends_with(&format!("/{JOB}/kill-ack")))
        .map(|(_, body)| body.clone())
        .collect();
    assert_eq!(acks, vec![r#"{"outcome":"killed"}"#.to_string()]);
    assert_eq!(w.registry.count(), 0);
}
