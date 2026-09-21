//! Telling core about the runs this box has declared.
//!
//! A master declares a run over the control socket, which writes a row in this
//! box's registry and nothing else — the socket holds no core client, and that
//! is deliberate (`daemon/control.rs`). This is the other half: once a sweep,
//! every declared row core has not been told about gets a run session opened for
//! it, and the session id core minted is written back onto the row.
//!
//! That write-back is what starts everything else. `recovery::reconcile` beats a
//! run session it can name, so the session stops being beaten the moment this
//! box's master dies; core's `reapDeadRunSessions` then fails the session and
//! `returnIssuesForRun` puts every issue back at the status it held when the run
//! opened. None of that machinery is new — it ran 358 times out of 358 before
//! 2026-09-13 and has had nothing to read since.

use crate::daemon::checkpoint;
use crate::runner::ledger::Ledger;
use crate::transport::{run_sessions, CoreClient};

#[allow(async_fn_in_trait)]
pub trait SessionOpener {
    async fn open(
        &self,
        project_id: &str,
        run_id: &str,
        issue_keys: &[String],
        name: &str,
    ) -> crate::error::Result<(String, String)>;
}

pub struct CoreSessions<'a>(pub &'a CoreClient);

impl SessionOpener for CoreSessions<'_> {
    async fn open(
        &self,
        project_id: &str,
        run_id: &str,
        issue_keys: &[String],
        name: &str,
    ) -> crate::error::Result<(String, String)> {
        run_sessions::open(self.0, project_id, run_id, issue_keys, name).await
    }
}

pub async fn open_declared_runs(
    opener: &impl SessionOpener,
    ledger: &mut Option<Ledger>,
    boot_id: &str,
) -> usize {
    if boot_id.is_empty() {
        return 0;
    }
    let Some(led) = ledger.as_mut() else {
        return 0;
    };
    let declared = match led.declared_without_session(boot_id) {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("[run-record] cannot read declared runs: {e}");
            return 0;
        }
    };
    let mut opened = 0;
    for run in declared {
        let Some(project_id) = run.project_id.clone() else {
            tracing::warn!(
                "[run-record] run {} names no project, so core cannot be told about it",
                run.run_id
            );
            continue;
        };
        let keys: Vec<String> = match led.issues(&run.run_id) {
            Ok(m) => m.into_iter().map(|i| i.issue_key).collect(),
            Err(e) => {
                tracing::warn!("[run-record] run {}: cannot read issues: {e}", run.run_id);
                continue;
            }
        };
        if keys.is_empty() {
            tracing::warn!(
                "[run-record] run {} carries no issues, which the ledger should have refused",
                run.run_id
            );
            continue;
        }
        let name = keys.join("+");
        match opener.open(&project_id, &run.run_id, &keys, &name).await {
            Ok((session_id, _)) => match led.attach_session(&run.run_id, &session_id) {
                Ok(()) => {
                    tracing::info!(
                        "[run-record] run {} is now core session {session_id} over {keys:?}",
                        run.run_id
                    );
                    opened += 1;
                }
                Err(e) => tracing::error!(
                    "[run-record] run {} opened core session {session_id} and the id could not be written back: {e} — that session will be reaped in ten minutes and its issues returned from under a live run",
                    run.run_id
                ),
            },
            Err(e) => tracing::warn!(
                "[run-record] run {}: core would not open a session: {e} — the row stands and the next sweep tries again",
                run.run_id
            ),
        }
    }
    opened
}

pub async fn close_ended_runs(
    closer: &impl SessionCloser,
    ledger: &mut Option<Ledger>,
    boot_id: &str,
) -> usize {
    if boot_id.is_empty() {
        return 0;
    }
    let Some(led) = ledger.as_mut() else {
        return 0;
    };
    let ended = match led.ended_with_open_session(boot_id) {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("[run-record] cannot read ended runs: {e}");
            return 0;
        }
    };
    let mut closed = 0;
    for run in ended {
        let Some(session_id) = run.session_id.clone() else {
            continue;
        };
        let detail = run.ended_reason.clone().unwrap_or_default();
        let checkpoint = Some(checkpoint::reconstruct_within_budget(&run).await.to_json());
        match closer.close(&session_id, &detail, checkpoint).await {
            Ok(()) => match led.mark_session_terminal_observed(&run.run_id) {
                Ok(()) => {
                    tracing::info!("[run-record] run {} is closed at core", run.run_id);
                    closed += 1;
                }
                Err(e) => tracing::warn!(
                    "[run-record] run {} closed at core and the mark did not land: {e} — it will be reported again",
                    run.run_id
                ),
            },
            Err(e) => tracing::warn!(
                "[run-record] run {}: core would not take the close: {e} — the next sweep tries again",
                run.run_id
            ),
        }
    }
    closed
}

/// What closing a run needs of core.
#[allow(async_fn_in_trait)]
pub trait SessionCloser {
    async fn close(
        &self,
        session_id: &str,
        detail: &str,
        checkpoint: Option<serde_json::Value>,
    ) -> crate::error::Result<()>;
}

impl SessionCloser for CoreSessions<'_> {
    async fn close(
        &self,
        session_id: &str,
        detail: &str,
        checkpoint: Option<serde_json::Value>,
    ) -> crate::error::Result<()> {
        run_sessions::close(
            self.0,
            session_id,
            run_sessions::Outcome::Ended,
            Some(detail),
            checkpoint,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ledger::NewRun;
    use std::cell::RefCell;

    struct Spy {
        answer: Result<(String, String), &'static str>,
        seen: RefCell<Vec<(String, String, Vec<String>)>>,
    }

    impl SessionOpener for Spy {
        async fn open(
            &self,
            project_id: &str,
            run_id: &str,
            issue_keys: &[String],
            _name: &str,
        ) -> crate::error::Result<(String, String)> {
            self.seen.borrow_mut().push((
                project_id.to_string(),
                run_id.to_string(),
                issue_keys.to_vec(),
            ));
            self.answer
                .clone()
                .map_err(|e| crate::error::Error::Other(e.into()))
        }
    }

    fn spy(answer: Result<(String, String), &'static str>) -> Spy {
        Spy {
            answer,
            seen: RefCell::new(Vec::new()),
        }
    }

    fn declared(led: &mut Ledger, run_id: &str, boot: &str, issues: &[&str]) {
        led.create_run_group(NewRun {
            run_id: run_id.into(),
            project_id: "proj-1".into(),
            master_session_id: format!("master-{run_id}"),
            worktree_path: std::path::PathBuf::from(format!("/w/{run_id}")),
            boot_id: boot.into(),
            issue_keys: issues.iter().map(|s| (*s).to_string()).collect(),
        })
        .unwrap();
    }

    #[tokio::test]
    async fn a_declared_run_is_told_to_core_and_carries_the_session_id_core_minted() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared(
            led.as_mut().unwrap(),
            "run-1",
            "boot-a",
            &["ISS-1", "ISS-2"],
        );
        let s = spy(Ok(("sess-9".into(), "core-run-9".into())));
        assert_eq!(open_declared_runs(&s, &mut led, "boot-a").await, 1);
        assert_eq!(
            s.seen.borrow().as_slice(),
            [(
                "proj-1".to_string(),
                "run-1".to_string(),
                vec!["ISS-1".to_string(), "ISS-2".to_string()]
            )],
            "core is told the BOX's run id and the whole group, not one issue"
        );
        assert_eq!(
            led.as_ref()
                .unwrap()
                .run("run-1")
                .unwrap()
                .unwrap()
                .session_id
                .as_deref(),
            Some("sess-9")
        );
    }

    #[tokio::test]
    async fn a_core_that_refuses_leaves_the_row_for_the_next_sweep() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared(led.as_mut().unwrap(), "run-1", "boot-a", &["ISS-1"]);
        let s = spy(Err("503"));
        assert_eq!(open_declared_runs(&s, &mut led, "boot-a").await, 0);
        assert!(led
            .as_ref()
            .unwrap()
            .run("run-1")
            .unwrap()
            .unwrap()
            .session_id
            .is_none());
        let s2 = spy(Ok(("sess-9".into(), "core-run-9".into())));
        assert_eq!(open_declared_runs(&s2, &mut led, "boot-a").await, 1);
    }

    #[tokio::test]
    async fn a_run_core_already_knows_is_not_opened_twice() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared(led.as_mut().unwrap(), "run-1", "boot-a", &["ISS-1"]);
        let s = spy(Ok(("sess-9".into(), "core-run-9".into())));
        assert_eq!(open_declared_runs(&s, &mut led, "boot-a").await, 1);
        let s2 = spy(Ok(("sess-other".into(), "core-other".into())));
        assert_eq!(open_declared_runs(&s2, &mut led, "boot-a").await, 0);
        assert!(s2.seen.borrow().is_empty());
    }

    #[tokio::test]
    async fn a_declaration_its_master_cancelled_is_never_told_to_core() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared(led.as_mut().unwrap(), "run-1", "boot-a", &["ISS-1"]);
        led.as_ref()
            .unwrap()
            .end_run("run-1", "master", "the subagent never started")
            .unwrap();
        let s = spy(Ok(("sess-9".into(), "core-run-9".into())));
        assert_eq!(open_declared_runs(&s, &mut led, "boot-a").await, 0);
        assert!(s.seen.borrow().is_empty());
    }

    #[tokio::test]
    async fn a_row_from_a_previous_boot_is_never_told_to_core() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared(led.as_mut().unwrap(), "run-1", "boot-old", &["ISS-1"]);
        let s = spy(Ok(("sess-9".into(), "core-run-9".into())));
        assert_eq!(open_declared_runs(&s, &mut led, "boot-a").await, 0);
        assert!(s.seen.borrow().is_empty());
    }

    struct Closer {
        answer: Result<(), &'static str>,
        seen: RefCell<Vec<(String, String)>>,
        checkpoints: RefCell<Vec<Option<serde_json::Value>>>,
    }

    impl SessionCloser for Closer {
        async fn close(
            &self,
            session_id: &str,
            detail: &str,
            checkpoint: Option<serde_json::Value>,
        ) -> crate::error::Result<()> {
            self.seen
                .borrow_mut()
                .push((session_id.to_string(), detail.to_string()));
            self.checkpoints.borrow_mut().push(checkpoint);
            self.answer
                .map_err(|e| crate::error::Error::Other(e.into()))
        }
    }

    fn closer(answer: Result<(), &'static str>) -> Closer {
        Closer {
            answer,
            seen: RefCell::new(Vec::new()),
            checkpoints: RefCell::new(Vec::new()),
        }
    }

    async fn declared_and_opened(led: &mut Option<Ledger>, run_id: &str, issues: &[&str]) {
        declared(led.as_mut().unwrap(), run_id, "boot-a", issues);
        let s = spy(Ok((format!("sess-{run_id}"), "core-run".into())));
        assert_eq!(open_declared_runs(&s, led, "boot-a").await, 1);
    }

    #[tokio::test]
    async fn a_run_whose_subagent_finished_is_closed_at_core_as_ended() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared_and_opened(&mut led, "run-1", &["ISS-1"]).await;
        led.as_ref()
            .unwrap()
            .end_run("run-1", "subagent", "the subagent finished")
            .unwrap();
        let c = closer(Ok(()));
        assert_eq!(close_ended_runs(&c, &mut led, "boot-a").await, 1);
        assert_eq!(
            c.seen.borrow().as_slice(),
            [(
                "sess-run-1".to_string(),
                "the subagent finished".to_string()
            )]
        );
    }

    #[tokio::test]
    async fn a_run_reported_closed_is_not_reported_again() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared_and_opened(&mut led, "run-1", &["ISS-1"]).await;
        led.as_ref()
            .unwrap()
            .end_run("run-1", "subagent", "done")
            .unwrap();
        assert_eq!(
            close_ended_runs(&closer(Ok(())), &mut led, "boot-a").await,
            1
        );
        let again = closer(Ok(()));
        assert_eq!(close_ended_runs(&again, &mut led, "boot-a").await, 0);
        assert!(again.seen.borrow().is_empty());
    }

    #[tokio::test]
    async fn a_core_that_will_not_take_the_close_leaves_the_run_to_be_reported_again() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared_and_opened(&mut led, "run-1", &["ISS-1"]).await;
        led.as_ref()
            .unwrap()
            .end_run("run-1", "subagent", "done")
            .unwrap();
        assert_eq!(
            close_ended_runs(&closer(Err("503")), &mut led, "boot-a").await,
            0
        );
        assert!(led
            .as_ref()
            .unwrap()
            .run("run-1")
            .unwrap()
            .unwrap()
            .session_terminal_at
            .is_none());
        assert_eq!(
            close_ended_runs(&closer(Ok(())), &mut led, "boot-a").await,
            1
        );
    }

    #[tokio::test]
    async fn a_run_still_going_is_never_closed() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared_and_opened(&mut led, "run-1", &["ISS-1"]).await;
        let c = closer(Ok(()));
        assert_eq!(close_ended_runs(&c, &mut led, "boot-a").await, 0);
        assert!(c.seen.borrow().is_empty());
    }

    #[tokio::test]
    async fn a_box_that_cannot_name_its_boot_tells_core_nothing() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared(led.as_mut().unwrap(), "run-1", "", &["ISS-1"]);
        let s = spy(Ok(("sess-9".into(), "core-run-9".into())));
        assert_eq!(open_declared_runs(&s, &mut led, "").await, 0);
        assert!(s.seen.borrow().is_empty());
    }
}
