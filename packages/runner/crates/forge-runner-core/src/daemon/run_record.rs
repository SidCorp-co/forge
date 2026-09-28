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
        gate: Option<&crate::daemon::degraded::Condition>,
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
        gate: Option<&crate::daemon::degraded::Condition>,
    ) -> crate::error::Result<(String, String)> {
        run_sessions::open(self.0, project_id, run_id, issue_keys, name, gate).await
    }
}

/// The one part of a declaration this box computes fresh on every sweep.
///
/// Everything else in the payload is read off the run's own row, so a
/// constraint core names on it is as true at the 223rd attempt as at the 1st.
/// The gate condition is not: `degraded::report` recounts it each sweep, and a
/// count that has rolled out of its window or a reason list that has shrunk
/// makes a refusal of it one a later sweep may legitimately get past. Ending
/// the run on that would trade this defect for its mirror image — a run killed
/// over a telemetry field. ISS-1192 keeps the two sides' bounds in one fixture,
/// so this is a narrow door rather than an open one, and it is a door because
/// the rule this file follows is *the payload cannot change*, which is a claim
/// about this field and not about the status code (ISS-1284).
const RECOMPUTED_EACH_SWEEP: &str = "gate: ";

pub async fn open_declared_runs(
    opener: &impl SessionOpener,
    ledger: &mut Option<Ledger>,
    boot_id: &str,
    gate: Option<&crate::daemon::degraded::Condition>,
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
        let name = run_sessions::session_name(&keys);
        match opener
            .open(&project_id, &run.run_id, &keys, &name, gate)
            .await
        {
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
            // Core named a constraint on the payload, so the payload is
            // finished: the row it is built from is not touched between
            // sweeps, and the 223rd attempt carries what the 1st did. One run
            // spent 240 attempts on this and five more appeared within the
            // hour (ISS-1284). Ending the row here is honest because no core
            // session was minted: nothing at core has to be told, and the
            // close path already reads a run with no session as one whose
            // session is over.
            Err(crate::error::Error::Malformed { said, named })
                if named.iter().all(|n| n.starts_with(RECOMPUTED_EACH_SWEEP)) =>
            {
                tracing::warn!(
                    "[run-record] run {}: {said} — that field is the one this sweep computes \
                     fresh, so the row stands and the next sweep tries again",
                    run.run_id
                );
            }
            Err(crate::error::Error::Malformed { said, named }) => {
                let why = format!(
                    "core refused this declaration and will refuse it again unchanged: {}",
                    named.join("; ")
                );
                tracing::error!(
                    "[run-record] run {}: {said} — {why}. The run is ended here rather than re-sent",
                    run.run_id
                );
                if let Err(e) = led.end_run(&run.run_id, "run-record", &why) {
                    tracing::error!(
                        "[run-record] run {}: the refusal could not be written onto the row: {e} — the next sweep will send it again",
                        run.run_id
                    );
                }
            }
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
        // Built to what `closeBodySchema` states rather than sent and refused:
        // an operator's `run close --reason` writes this field and nothing
        // bounded it on this side, and a close core refuses is retried on every
        // sweep the same way a declaration was (ISS-1284).
        let detail = run_sessions::fit(
            &run.ended_reason.clone().unwrap_or_default(),
            run_sessions::MAX_DETAIL_CODE_UNITS,
        );
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
    use crate::transport::{fake_core, CoreClient};
    use std::cell::RefCell;

    /// A core answering one status and one body. The refusal is built by the
    /// transport's own classifier rather than by hand, so a test that says
    /// "core answered 503" is exercising the same decision the wire does.
    struct Spy {
        answer: Result<(String, String), (u16, &'static str)>,
        seen: RefCell<Vec<(String, String, Vec<String>)>>,
        gates: RefCell<Vec<Option<crate::daemon::degraded::Verdict>>>,
    }

    impl SessionOpener for Spy {
        async fn open(
            &self,
            project_id: &str,
            run_id: &str,
            issue_keys: &[String],
            _name: &str,
            gate: Option<&crate::daemon::degraded::Condition>,
        ) -> crate::error::Result<(String, String)> {
            self.seen.borrow_mut().push((
                project_id.to_string(),
                run_id.to_string(),
                issue_keys.to_vec(),
            ));
            self.gates.borrow_mut().push(gate.map(|g| g.verdict));
            self.answer.clone().map_err(|(code, body)| {
                crate::transport::status::refusal("run-session open", code, body)
            })
        }
    }

    fn spy(answer: Result<(String, String), (u16, &'static str)>) -> Spy {
        Spy {
            answer,
            seen: RefCell::new(Vec::new()),
            gates: RefCell::new(Vec::new()),
        }
    }

    fn failing_open() -> crate::daemon::degraded::Condition {
        crate::daemon::degraded::Condition {
            verdict: crate::daemon::degraded::Verdict::FailingOpen,
            count: 278,
            per_day: Some(75.0),
            ..crate::daemon::degraded::Condition::none()
        }
    }

    /// Criterion 18. The run carries what was true THEN. The device's own
    /// report says what is true now, and a window that has rolled over answers
    /// nothing about a run that ended weeks ago.
    #[tokio::test]
    async fn a_run_is_opened_carrying_the_gate_condition_of_the_box_that_declared_it() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared(led.as_mut().unwrap(), "run-1", "boot-a", &["ISS-1"]);
        let s = spy(Ok(("sess-9".into(), "core-run-9".into())));
        let gate = failing_open();
        assert_eq!(
            open_declared_runs(&s, &mut led, "boot-a", Some(&gate)).await,
            1
        );
        assert_eq!(
            s.gates.borrow().as_slice(),
            [Some(crate::daemon::degraded::Verdict::FailingOpen)]
        );
    }

    /// Criterion 19. A box that sent none records none. A run stamped `clear`
    /// by default would be the state lying about itself.
    #[tokio::test]
    async fn a_box_that_could_not_read_its_own_gate_stamps_none_rather_than_clear() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared(led.as_mut().unwrap(), "run-1", "boot-a", &["ISS-1"]);
        let s = spy(Ok(("sess-9".into(), "core-run-9".into())));
        assert_eq!(open_declared_runs(&s, &mut led, "boot-a", None).await, 1);
        assert_eq!(s.gates.borrow().as_slice(), [None]);
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
        assert_eq!(open_declared_runs(&s, &mut led, "boot-a", None).await, 1);
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
        let s = spy(Err((503, fake_core::UNAVAILABLE)));
        assert_eq!(open_declared_runs(&s, &mut led, "boot-a", None).await, 0);
        assert!(led
            .as_ref()
            .unwrap()
            .run("run-1")
            .unwrap()
            .unwrap()
            .session_id
            .is_none());
        let s2 = spy(Ok(("sess-9".into(), "core-run-9".into())));
        assert_eq!(open_declared_runs(&s2, &mut led, "boot-a", None).await, 1);
    }

    #[tokio::test]
    async fn a_run_core_already_knows_is_not_opened_twice() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared(led.as_mut().unwrap(), "run-1", "boot-a", &["ISS-1"]);
        let s = spy(Ok(("sess-9".into(), "core-run-9".into())));
        assert_eq!(open_declared_runs(&s, &mut led, "boot-a", None).await, 1);
        let s2 = spy(Ok(("sess-other".into(), "core-other".into())));
        assert_eq!(open_declared_runs(&s2, &mut led, "boot-a", None).await, 0);
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
        assert_eq!(open_declared_runs(&s, &mut led, "boot-a", None).await, 0);
        assert!(s.seen.borrow().is_empty());
    }

    #[tokio::test]
    async fn a_row_from_a_previous_boot_is_never_told_to_core() {
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared(led.as_mut().unwrap(), "run-1", "boot-old", &["ISS-1"]);
        let s = spy(Ok(("sess-9".into(), "core-run-9".into())));
        assert_eq!(open_declared_runs(&s, &mut led, "boot-a", None).await, 0);
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
        assert_eq!(open_declared_runs(&s, led, "boot-a", None).await, 1);
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
        assert_eq!(open_declared_runs(&s, &mut led, "", None).await, 0);
        assert!(s.seen.borrow().is_empty());
    }

    /// What this box puts on the wire and how often, against a core that
    /// answers what the real one answered on 2026-09-26.
    async fn declared_against(
        status: &'static str,
        body: &'static str,
        keys: &[&str],
    ) -> (
        Option<Ledger>,
        String,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        let (url, sent) = fake_core::serve_recording(status, body).await;
        let mut led = Some(Ledger::open_in_memory().unwrap());
        declared(led.as_mut().unwrap(), "run-1", "boot-a", keys);
        (led, url, sent)
    }

    /// Criteria 1, 2, 3, 4 and 20. The run this issue was filed for was
    /// declared once and sent 240 times, one attempt every twenty seconds for
    /// an hour and forty-seven minutes, because a `400` was read as a failure
    /// that might pass later. It cannot pass later: the answer names the
    /// payload, and the payload is rebuilt from a row nothing between sweeps
    /// touches.
    #[tokio::test]
    async fn a_declaration_core_refuses_as_malformed_is_sent_once_and_never_again() {
        let (mut led, url, sent) =
            declared_against("400 Bad Request", fake_core::NAME_TOO_LONG, &["ISS-1"]).await;
        let client = CoreClient::new(url, String::from("tok"));
        let core = CoreSessions(&client);

        assert_eq!(open_declared_runs(&core, &mut led, "boot-a", None).await, 0);
        assert_eq!(open_declared_runs(&core, &mut led, "boot-a", None).await, 0);
        assert_eq!(open_declared_runs(&core, &mut led, "boot-a", None).await, 0);

        assert_eq!(
            sent.lock().unwrap().len(),
            1,
            "three sweeps, one attempt: a payload core named a constraint on is finished, and \
             re-sending it is 240 calls that cannot succeed"
        );
        let run = led.as_ref().unwrap().run("run-1").unwrap().unwrap();
        assert_eq!(
            run.ended_by.as_deref(),
            Some("run-record"),
            "a row that never reaches terminal is the other half of this defect: it stands open \
             for ever and holds its leases"
        );
        let why = run.ended_reason.unwrap_or_default();
        assert!(
            why.contains("name: Too big: expected string to have <=60 characters"),
            "the reason has to name the field core refused, or whoever reads the row knows only \
             that something was wrong: {why}"
        );
    }

    /// Criterion 17. A refusal of the object rather than of a field is as
    /// fixed as one naming a field, and a classifier reading only `fieldErrors`
    /// would leave exactly this shape looping.
    #[tokio::test]
    async fn a_refusal_naming_only_the_request_ends_the_run_too() {
        let (mut led, url, sent) =
            declared_against("400 Bad Request", fake_core::FORM_REFUSED, &["ISS-1"]).await;
        let client = CoreClient::new(url, String::from("tok"));
        let core = CoreSessions(&client);

        assert_eq!(open_declared_runs(&core, &mut led, "boot-a", None).await, 0);
        assert_eq!(open_declared_runs(&core, &mut led, "boot-a", None).await, 0);

        assert_eq!(sent.lock().unwrap().len(), 1);
        let run = led.as_ref().unwrap().run("run-1").unwrap().unwrap();
        assert!(run.ended_by.is_some());
        assert!(run
            .ended_reason
            .unwrap_or_default()
            .contains("the request itself"));
    }

    /// The mirror image of this issue's defect, and the reason the rule is
    /// written about the payload rather than about the status code. The gate
    /// condition is recomputed every sweep, so a refusal naming only it is one
    /// a later sweep may get past — and a run ended over a telemetry field is
    /// a run killed for something nobody was working on.
    #[tokio::test]
    async fn a_refusal_naming_only_the_field_this_sweep_recomputes_is_not_the_run_s_fault() {
        let (mut led, url, sent) =
            declared_against("400 Bad Request", fake_core::GATE_REFUSED, &["ISS-1"]).await;
        let client = CoreClient::new(url, String::from("tok"));
        let core = CoreSessions(&client);

        assert_eq!(open_declared_runs(&core, &mut led, "boot-a", None).await, 0);
        assert_eq!(open_declared_runs(&core, &mut led, "boot-a", None).await, 0);

        assert_eq!(sent.lock().unwrap().len(), 2, "the row is still being sent");
        assert!(
            led.as_ref()
                .unwrap()
                .run("run-1")
                .unwrap()
                .unwrap()
                .ended_by
                .is_none(),
            "the declaration itself was never refused, and the run stands"
        );

        let answering = spy(Ok(("sess-9".into(), "core-run-9".into())));
        assert_eq!(
            open_declared_runs(&answering, &mut led, "boot-a", None).await,
            1,
            "the gate clears and the run opens"
        );
    }

    /// A refusal naming the gate AND something else is still the payload's:
    /// the other constraint stands however the gate settles, so a run kept
    /// alive for it would be the original loop wearing one extra field.
    #[tokio::test]
    async fn a_refusal_naming_the_recomputed_field_and_a_fixed_one_still_ends_the_run() {
        let both = r#"{"code":"BAD_REQUEST","message":"Invalid input","details":{"formErrors":[],"fieldErrors":{"gate":["Too big: expected array to have <=24 items"],"name":["Too big: expected string to have <=60 characters"]}}}"#;
        let (mut led, url, sent) = declared_against("400 Bad Request", both, &["ISS-1"]).await;
        let client = CoreClient::new(url, String::from("tok"));
        let core = CoreSessions(&client);

        assert_eq!(open_declared_runs(&core, &mut led, "boot-a", None).await, 0);
        assert_eq!(open_declared_runs(&core, &mut led, "boot-a", None).await, 0);

        assert_eq!(sent.lock().unwrap().len(), 1);
        let run = led.as_ref().unwrap().run("run-1").unwrap().unwrap();
        assert!(run.ended_by.is_some());
        let why = run.ended_reason.unwrap_or_default();
        assert!(why.contains("gate:"), "both are reported: {why}");
        assert!(why.contains("name:"), "both are reported: {why}");
    }

    /// Criteria 5, 6 and 7. Three refusals that say nothing about the payload.
    /// A `409` was observed twice on the same box on the same day, clearing on
    /// retry within thirty seconds, and a sweep that gave up on it would trade
    /// this defect for its mirror image.
    #[tokio::test]
    async fn a_refusal_that_names_no_constraint_is_tried_again_on_the_next_sweep() {
        for (code, body, what) in [
            (409u16, fake_core::LEASE_HELD, "a lease another box holds"),
            (503, fake_core::UNAVAILABLE, "core being down"),
            (
                400,
                r#"{"code":"BAD_REQUEST","message":"Invalid input"}"#,
                "a 400 that names no constraint",
            ),
        ] {
            let mut led = Some(Ledger::open_in_memory().unwrap());
            declared(led.as_mut().unwrap(), "run-1", "boot-a", &["ISS-1"]);
            let refused = spy(Err((code, body)));
            assert_eq!(
                open_declared_runs(&refused, &mut led, "boot-a", None).await,
                0
            );
            assert!(
                led.as_ref()
                    .unwrap()
                    .run("run-1")
                    .unwrap()
                    .unwrap()
                    .ended_by
                    .is_none(),
                "{what} is not the payload's fault and the run must stand"
            );
            let answering = spy(Ok(("sess-9".into(), "core-run-9".into())));
            assert_eq!(
                open_declared_runs(&answering, &mut led, "boot-a", None).await,
                1,
                "{what} clears, and the next sweep opens the run it was holding"
            );
        }
    }

    /// Criterion 8. The name that goes on the wire is built to the 60 units
    /// core counts. Eight full keys join to 63 characters, which is what turned
    /// five ordinary declarations into five permanent loops in fifty minutes.
    #[tokio::test]
    async fn the_name_this_box_sends_is_one_core_accepts() {
        let keys = [
            "ISS-1000", "ISS-1001", "ISS-1002", "ISS-1003", "ISS-1004", "ISS-1005", "ISS-1006",
            "ISS-1007",
        ];
        let (mut led, url, sent) =
            declared_against("503 Service Unavailable", fake_core::UNAVAILABLE, &keys).await;
        let client = CoreClient::new(url, String::from("tok"));
        let core = CoreSessions(&client);
        assert_eq!(open_declared_runs(&core, &mut led, "boot-a", None).await, 0);

        let body = sent.lock().unwrap().first().cloned().expect("one request");
        let parsed: serde_json::Value = serde_json::from_str(&body).expect("core is sent json");
        let name = parsed["name"].as_str().expect("a name rides on every open");
        assert!(
            name.encode_utf16().count() <= crate::transport::run_sessions::MAX_NAME_CODE_UNITS,
            "{} units went on the wire against a cap of 60: {name}",
            name.encode_utf16().count()
        );
        assert_eq!(
            parsed["issueKeys"].as_array().map(|a| a.len()),
            Some(8),
            "the keys are the run's own and every one of them is sent; only the label gives way"
        );
        assert!(
            name.ends_with(" more"),
            "and it says what it left out: {name}"
        );
    }

    struct Terminal;

    #[async_trait::async_trait]
    impl crate::runner::close_loop::SessionReader for Terminal {
        async fn is_terminal(&self, _session_id: &str) -> crate::error::Result<bool> {
            panic!("a run that never opened a core session has none to ask core about")
        }
    }

    struct Given(RefCell<Vec<String>>);

    // The ledger is not `Sync`, so this double lives on one thread with it.
    unsafe impl Sync for Given {}

    #[async_trait::async_trait]
    impl crate::runner::close_loop::LeaseKeeper for Given {
        async fn release(&self, _project: Option<&str>, key: &str) -> crate::error::Result<()> {
            self.0.borrow_mut().push(key.to_string());
            Ok(())
        }
        async fn is_returned(
            &self,
            _project: Option<&str>,
            key: &str,
        ) -> crate::error::Result<bool> {
            Ok(self.0.borrow().iter().any(|k| k == key))
        }
    }

    /// Criteria 16 and 21. Ending the row is not dropping it. The run stays on
    /// the list the sweep that finishes a run reads, its leases go back, and
    /// core is never asked to close a session it never opened — which is the
    /// whole reason `end_run` is an honest terminal here and would not be on
    /// the close path.
    #[tokio::test]
    async fn the_run_a_malformed_declaration_ended_is_still_finished_by_the_close_path() {
        let (mut led, url, _sent) =
            declared_against("400 Bad Request", fake_core::NAME_TOO_LONG, &["ISS-1"]).await;
        let client = CoreClient::new(url, String::from("tok"));
        let core = CoreSessions(&client);
        assert_eq!(open_declared_runs(&core, &mut led, "boot-a", None).await, 0);

        assert!(
            led.as_ref()
                .unwrap()
                .run("run-1")
                .unwrap()
                .unwrap()
                .ended_by
                .is_some(),
            "the refusal ended the row, which is the state everything below is about"
        );

        let closer = closer(Ok(()));
        assert_eq!(close_ended_runs(&closer, &mut led, "boot-a").await, 0);
        assert!(
            closer.seen.borrow().is_empty(),
            "there is no session at core to close, and a close sent for one would be this box \
             telling core about a session core never minted"
        );

        let led = led.as_mut().unwrap();
        assert!(
            led.unclosed_runs()
                .unwrap()
                .iter()
                .any(|r| r.run_id == "run-1"),
            "the row is ended, not finished: the sweep still owes it its leases"
        );
        let leases = Given(RefCell::new(Vec::new()));
        let state = crate::runner::close_loop::close(led, "run-1", None, &Terminal, &leases)
            .await
            .unwrap();
        assert!(state.session_terminal);
        assert_eq!(state.leases_returned, 1);
        assert_eq!(state.leases_total, 1);
        assert_eq!(leases.0.borrow().as_slice(), ["ISS-1".to_string()]);
    }
}
