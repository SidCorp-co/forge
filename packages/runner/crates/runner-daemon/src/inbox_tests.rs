//! `session.send` reaching a pool job's pane, through `handle_session_send` as the frame loop
//! calls it: a terminal double that records what was typed and answers as the test says, and a
//! core on a loopback port that records every ack the box sent. Nothing here starts tmux.

use super::*;
use crate::pool_jobs::{self, JobPanes, PoolPanes};
use runner_core::turn_evidence::Watch;
use runner_platform::error::{Error, Result};
use std::path::Path;
use std::sync::Mutex;

const JOB: &str = "7f194db7-0000-4000-8000-000000000001";
const SESSION: &str = "2850dda7-0000-4000-8000-000000000002";

/// How the job's pane answers a message typed into it.
#[derive(Clone)]
enum Answers {
    Takes,
    Gone,
    Refuses,
    Unsubmitted,
}

struct TypingPanes {
    answers: Answers,
    typed: Mutex<Vec<(String, String)>>,
    killed: Mutex<Vec<String>>,
}

impl TypingPanes {
    fn new(answers: Answers) -> Arc<Self> {
        Arc::new(Self {
            answers,
            typed: Mutex::new(Vec::new()),
            killed: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait::async_trait]
impl pool_jobs::Panes for TypingPanes {
    async fn open(
        &self,
        _name: &str,
        _cwd: &Path,
        _prompt: &str,
        _env: &[(String, String)],
        _launch: &pool_jobs::Launch<'_>,
    ) -> Result<()> {
        unreachable!("a session.send opens nothing")
    }
    async fn released(&self, _name: &str) {}
    async fn gone(&self, _name: &str) -> bool {
        false
    }
    async fn kill(&self, name: &str) -> Result<()> {
        self.killed.lock().unwrap().push(name.to_string());
        match self.answers {
            Answers::Refuses => Err(Error::Other("tmux kill-session: refused".into())),
            _ => Ok(()),
        }
    }
    async fn names(&self) -> Vec<String> {
        Vec::new()
    }
    async fn send_line(
        &self,
        name: &str,
        text: &str,
    ) -> std::result::Result<terminal::Prompt, terminal::NotTyped> {
        self.typed
            .lock()
            .unwrap()
            .push((name.to_string(), text.to_string()));
        match self.answers {
            Answers::Takes => Ok(terminal::Prompt::Empty),
            Answers::Gone => Err(terminal::NotTyped::Gone(name.to_string())),
            Answers::Refuses => Err(terminal::NotTyped::Refused(format!(
                "{name}: nothing was typed — its prompt already holds unsent text"
            ))),
            Answers::Unsubmitted => Err(terminal::NotTyped::Unsubmitted(format!(
                "{name}: the message was typed and its prompt still holds it unsent"
            ))),
        }
    }
}

/// A box holding the pool job's pane, watched under the job's agent session.
fn holding(panes: Arc<TypingPanes>) -> (PoolPanes, Arc<JobPanes>) {
    let registry = Arc::new(JobPanes::new());
    registry.hold(
        JOB,
        &pool_jobs::pane_name(JOB),
        Watch::Hooked {
            session_id: SESSION.into(),
            delivered_at: 0,
        },
        None,
        None,
        None,
    );
    (
        PoolPanes {
            panes,
            records: Arc::new(pool_jobs::NoRecords),
            registry: registry.clone(),
        },
        registry,
    )
}

/// Send one frame as the frame loop does and return every ack core was sent for it, as its
/// outcome, and every other path the box called.
async fn send(pool: &PoolPanes, frame: Value) -> (Vec<String>, Vec<String>) {
    send_with(pool, Arc::new(Masters::new()), frame).await
}

/// A box whose master for one project runs under the session the frames name.
fn mastered() -> Arc<Masters> {
    let masters = Arc::new(Masters::new());
    masters.remember(
        "project",
        crate::master::MasterState {
            session_id: SESSION.into(),
            name: "forge-master-project".into(),
            last_work: std::time::Instant::now(),
            last_nudge: None,
            mcp_stale_reported: false,
        },
    );
    masters
}

async fn send_with(
    pool: &PoolPanes,
    masters: Arc<Masters>,
    frame: Value,
) -> (Vec<String>, Vec<String>) {
    let (client, seen) = crate::test_core::fake_core(crate::test_core::takes_everything).await;
    let runner = Arc::new(ClaudeCodeRunner::new(
        client.base().to_string(),
        "device-token",
        1,
    ));
    handle_session_send(&client, runner, masters, pool, frame).await;
    let seen = seen.lock().unwrap().clone();
    let ack = format!("/api/agent-sessions/{SESSION}/inbox/1/ack");
    let acks = seen
        .iter()
        .filter(|(path, _)| *path == ack)
        .map(|(_, body)| {
            serde_json::from_str::<Value>(body).unwrap()["outcome"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    let others = seen
        .into_iter()
        .filter(|(path, _)| *path != ack)
        .map(|(path, _)| path)
        .collect();
    (acks, others)
}

fn frame(kind: &str, job_id: Option<&str>) -> Value {
    let mut f = serde_json::json!({
        "sessionId": SESSION,
        "seq": 1,
        "kind": kind,
        "body": "Release approval 998ef035 was APPROVED.",
        "deadlineMs": 10_000,
    });
    if let Some(j) = job_id {
        f["jobId"] = j.into();
    }
    f
}

#[tokio::test]
async fn an_answer_to_a_pool_job_is_typed_into_its_pane_and_acked_delivered() {
    let panes = TypingPanes::new(Answers::Takes);
    let (pool, _) = holding(panes.clone());
    let (acks, _) = send(&pool, frame("answer", Some(JOB))).await;
    assert_eq!(
        *panes.typed.lock().unwrap(),
        vec![(
            pool_jobs::pane_name(JOB),
            "Release approval 998ef035 was APPROVED.".to_string()
        )],
        "the release-approval wake never reached the job's pane"
    );
    assert_eq!(acks, vec!["delivered"]);
}

#[tokio::test]
async fn work_for_a_pool_job_named_only_by_its_agent_session_reaches_its_pane() {
    let panes = TypingPanes::new(Answers::Takes);
    let (pool, _) = holding(panes.clone());
    let (acks, _) = send(&pool, frame("work", None)).await;
    assert_eq!(panes.typed.lock().unwrap().len(), 1);
    assert_eq!(acks, vec!["delivered"]);
}

#[tokio::test]
async fn a_checkpoint_for_a_pool_job_types_the_checkpoint_prompt_into_its_pane() {
    let panes = TypingPanes::new(Answers::Takes);
    let (pool, _) = holding(panes.clone());
    let (acks, _) = send(&pool, frame("checkpoint", Some(JOB))).await;
    assert_eq!(
        *panes.typed.lock().unwrap(),
        vec![(
            pool_jobs::pane_name(JOB),
            ClaudeCodeRunner::CHECKPOINT_PROMPT.to_string()
        )]
    );
    assert_eq!(acks, vec!["delivered"]);
}

#[tokio::test]
async fn a_session_no_registry_on_this_box_holds_gets_no_ack_at_all() {
    let panes = TypingPanes::new(Answers::Takes);
    let pool = PoolPanes {
        panes: panes.clone(),
        records: Arc::new(pool_jobs::NoRecords),
        registry: Arc::new(JobPanes::new()),
    };
    let (acks, _) = send(&pool, frame("answer", Some(JOB))).await;
    assert!(
        acks.is_empty(),
        "core was told {acks:?} about a session this box holds nothing of — not in a map is not gone"
    );
    assert!(panes.typed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_cancel_for_a_session_no_registry_holds_gets_no_ack_at_all() {
    let pool = PoolPanes {
        panes: TypingPanes::new(Answers::Takes),
        records: Arc::new(pool_jobs::NoRecords),
        registry: Arc::new(JobPanes::new()),
    };
    let (acks, _) = send(&pool, frame("cancel", Some(JOB))).await;
    assert!(
        acks.is_empty(),
        "core was told {acks:?} about a session this box holds nothing of"
    );
}

#[tokio::test]
async fn a_pool_job_whose_pane_tmux_says_is_gone_is_acked_gone() {
    let (pool, _) = holding(TypingPanes::new(Answers::Gone));
    let (acks, _) = send(&pool, frame("answer", Some(JOB))).await;
    assert_eq!(acks, vec!["gone"]);
}

#[tokio::test]
async fn a_live_pool_pane_that_refused_the_message_gets_no_ack() {
    let (pool, _) = holding(TypingPanes::new(Answers::Refuses));
    let (acks, _) = send(&pool, frame("answer", Some(JOB))).await;
    assert!(
        acks.is_empty(),
        "a live pane that refused was acked {acks:?}"
    );
}

#[tokio::test]
async fn a_message_left_unsubmitted_at_the_prompt_is_not_acked_delivered() {
    let (pool, _) = holding(TypingPanes::new(Answers::Unsubmitted));
    let (acks, _) = send(&pool, frame("answer", Some(JOB))).await;
    assert!(
        acks.is_empty(),
        "a message sitting unsent at the prompt was acked {acks:?}"
    );
}

#[tokio::test]
async fn a_cancel_for_a_pool_job_closes_its_pane_through_the_one_cancel_path_and_acks_gone() {
    let panes = TypingPanes::new(Answers::Takes);
    let (pool, registry) = holding(panes.clone());
    let (acks, others) = send(&pool, frame("cancel", Some(JOB))).await;
    assert_eq!(
        *panes.killed.lock().unwrap(),
        vec![pool_jobs::pane_name(JOB)]
    );
    assert_eq!(
        others,
        vec![format!("/api/jobs/{JOB}/kill-ack")],
        "the pane was closed by a path that did not say so with a kill-ack"
    );
    assert_eq!(registry.count(), 0, "the cancelled pane still holds a slot");
    assert_eq!(acks, vec!["gone"]);
}

#[tokio::test]
async fn a_cancel_whose_pool_pane_will_not_close_gets_no_ack() {
    let (pool, registry) = holding(TypingPanes::new(Answers::Refuses));
    let (acks, _) = send(&pool, frame("cancel", Some(JOB))).await;
    assert!(acks.is_empty(), "a pane still running was acked {acks:?}");
    assert_eq!(
        registry.count(),
        1,
        "the slot of a pane still running was given back"
    );
}

fn unheld_pool(panes: Arc<TypingPanes>) -> PoolPanes {
    PoolPanes {
        panes,
        records: Arc::new(pool_jobs::NoRecords),
        registry: Arc::new(JobPanes::new()),
    }
}

#[tokio::test]
async fn an_answer_to_a_master_session_is_typed_into_the_master_pane() {
    let panes = TypingPanes::new(Answers::Takes);
    let (acks, _) = send_with(
        &unheld_pool(panes.clone()),
        mastered(),
        frame("answer", None),
    )
    .await;
    assert_eq!(panes.typed.lock().unwrap()[0].0, "forge-master-project");
    assert_eq!(acks, vec!["delivered"]);
}

#[tokio::test]
async fn a_cancel_whose_master_pane_will_not_end_gets_no_ack() {
    let panes = TypingPanes::new(Answers::Refuses);
    let (acks, _) = send_with(
        &unheld_pool(panes.clone()),
        mastered(),
        frame("cancel", None),
    )
    .await;
    assert_eq!(*panes.killed.lock().unwrap(), vec!["forge-master-project"]);
    assert!(
        acks.is_empty(),
        "core was told {acks:?} about a master pane still running"
    );
}

#[tokio::test]
async fn a_cancel_that_ended_the_master_pane_is_acked_gone() {
    let panes = TypingPanes::new(Answers::Takes);
    let (acks, _) = send_with(&unheld_pool(panes), mastered(), frame("cancel", None)).await;
    assert_eq!(acks, vec!["gone"]);
}
