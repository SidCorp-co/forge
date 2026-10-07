//! Telling core about the runs this box has declared.
//!
//! A master declares a run over the control socket, which writes a row in this
//! box's registry, after asking core one read-only question (`control::runs::preflight_refusal`:
//! would the open be refused by a hold?) and nothing else is written at core. This is the
//! other half: once a sweep,
//! every declared row core has not been told about gets a run session opened for
//! it, and the session id core minted is written back onto the row.
//!
//! That write-back is what starts everything else. `recovery::reconcile` beats a
//! run session core's verdict keeps, so the session stops being beaten the moment this
//! box's master dies; core's `reapDeadRunSessions` then fails the session and
//! `returnIssuesForRun` puts every issue back at the status it held when the run
//! opened. None of that machinery is new — it ran 358 times out of 358 before
//! 2026-09-13 and has had nothing to read since.

use runner_core::checkpoint;
use runner_core::ledger::Ledger;
use runner_transport::{run_sessions, CoreClient};

#[expect(
    async_fn_in_trait,
    reason = "a test seam implemented only inside this workspace; no caller needs its future to be Send"
)]
pub trait SessionOpener {
    async fn open(
        &self,
        project_id: &str,
        run_id: &str,
        issue_keys: &[String],
        name: &str,
        gate: Option<&runner_proto::gate::Condition>,
    ) -> runner_platform::error::Result<(String, String)>;
}

pub struct CoreSessions<'a>(pub &'a CoreClient);

impl SessionOpener for CoreSessions<'_> {
    async fn open(
        &self,
        project_id: &str,
        run_id: &str,
        issue_keys: &[String],
        name: &str,
        gate: Option<&runner_proto::gate::Condition>,
    ) -> runner_platform::error::Result<(String, String)> {
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

/// How long a run core refused to open waits before its open is sent again.
///
/// A hold on a run's issues (a `blocks` edge, an unapproved design, an unsettled
/// contract wait, another run's lease) lifts when its holder moves, which is hours for a
/// blocker resting at `awaiting_release`, so re-sending every sweep was nineteen identical
/// refusals in ten minutes. But core keeps the refused declaration as a queued run only
/// while the box keeps sending it, and reaps it after ten minutes of silence
/// (`SESSION_SILENCE_REAP_MS`), so the interval is half of that: the queued row stays
/// where the master reads it, and the open still lands within five minutes of the hold lifting.
pub const SESSION_RETRY_MS: i64 = 5 * 60_000;

pub async fn open_declared_runs(
    opener: &impl SessionOpener,
    ledger: &mut Option<Ledger>,
    boot_id: &str,
    gate: Option<&runner_proto::gate::Condition>,
) -> usize {
    open_declared_runs_at(
        opener,
        ledger,
        boot_id,
        gate,
        runner_core::agent_activity::now_ms(),
    )
    .await
}

pub async fn open_declared_runs_at(
    opener: &impl SessionOpener,
    ledger: &mut Option<Ledger>,
    boot_id: &str,
    gate: Option<&runner_proto::gate::Condition>,
    now_ms: i64,
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
        // A run core refused over a hold waits out its interval; it stands on the row and
        // at core as a queued run, so nothing is lost by not sending it this pass.
        if let Some(last) = run.session_retry_at {
            if now_ms.saturating_sub(last) < SESSION_RETRY_MS {
                continue;
            }
        }
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
            Err(runner_platform::error::Error::Malformed { said, named })
                if named.iter().all(|n| n.starts_with(RECOMPUTED_EACH_SWEEP)) =>
            {
                tracing::warn!(
                    "[run-record] run {}: {said} — that field is the one this sweep computes \
                     fresh, so the row stands and the next sweep tries again",
                    run.run_id
                );
            }
            Err(runner_platform::error::Error::Malformed { said, named }) => {
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
            // A hold is not a fault of the payload and not of the moment: it stands until
            // its holder moves. Core has already recorded the declaration as a queued run
            // behind this refusal, which is where the master reads it (`runs/standing`,
            // `waiting_gate`), so the box names it once, here, and then asks again only
            // when `SESSION_RETRY_MS` has gone, which also keeps that queued row alive.
            Err(runner_platform::error::Error::Held { said, code }) => {
                note_session_held(led, &run, &code, &said, now_ms);
            }
            Err(e) => tracing::warn!(
                "[run-record] run {}: core would not open a session: {e} — the row stands and the next sweep tries again",
                run.run_id
            ),
        }
    }
    opened
}

/// A run's open core refused over a hold, written onto the row. Core has already recorded the
/// declaration as a queued run behind the refusal, which is where the master reads it
/// (`runs/standing`, `waiting_gate`), so the box names it once and then asks again only when
/// `SESSION_RETRY_MS` has gone, which also keeps that queued row alive.
fn note_session_held(
    led: &Ledger,
    run: &runner_core::ledger::Run,
    code: &str,
    said: &str,
    now_ms: i64,
) {
    let first = run.session_refused_at.is_none();
    if let Err(e) = led.mark_session_refused(&run.run_id, &format!("{code}: {said}"), now_ms) {
        tracing::warn!(
            "[run-record] run {}: {said}; the refusal could not be written onto the row: {e} — the next sweep sends it again",
            run.run_id
        );
    } else if first {
        tracing::warn!(
            "[run-record] run {}: core would not open a session ({code}): {said} — the run waits at core as a queued run, and this box asks again every {} minutes rather than every sweep",
            run.run_id,
            SESSION_RETRY_MS / 60_000
        );
    }
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
            // The close's bytes are the row's and nothing between sweeps changes
            // them, so a constraint answer is final for them. Core has no door
            // for a device to report this through, so it is recorded on the
            // row (which takes it out of this sweep) and named here once.
            Err(runner_platform::error::Error::Malformed { said, named }) => {
                let why = named.join("; ");
                match led.mark_close_refused(&run.run_id, &why) {
                    Ok(()) => tracing::error!(
                        "[run-record] run {}: {said} — core refused this close as malformed and will refuse it again unchanged ({why}). The close is not re-sent; the run's session stays open at core until core closes it",
                        run.run_id
                    ),
                    Err(e) => tracing::warn!(
                        "[run-record] run {}: {said}; the refusal could not be written onto the row: {e} — the next sweep sends it again",
                        run.run_id
                    ),
                }
            }
            Err(e) => tracing::warn!(
                "[run-record] run {}: core would not take the close: {e} — the next sweep tries again",
                run.run_id
            ),
        }
    }
    closed
}

/// What closing a run needs of core.
#[expect(
    async_fn_in_trait,
    reason = "a test seam implemented only inside this workspace; no caller needs its future to be Send"
)]
pub trait SessionCloser {
    async fn close(
        &self,
        session_id: &str,
        detail: &str,
        checkpoint: Option<serde_json::Value>,
    ) -> runner_platform::error::Result<()>;
}

impl SessionCloser for CoreSessions<'_> {
    async fn close(
        &self,
        session_id: &str,
        detail: &str,
        checkpoint: Option<serde_json::Value>,
    ) -> runner_platform::error::Result<()> {
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
mod close_refusal_tests {
    use super::*;
    use runner_core::ledger::NewRun;
    use runner_platform::error::Error;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Closer {
        sent: AtomicUsize,
        answer: fn() -> runner_platform::error::Result<()>,
    }

    impl SessionCloser for Closer {
        async fn close(
            &self,
            _session_id: &str,
            _detail: &str,
            _checkpoint: Option<serde_json::Value>,
        ) -> runner_platform::error::Result<()> {
            self.sent.fetch_add(1, Ordering::SeqCst);
            (self.answer)()
        }
    }

    fn ended_run() -> (Option<Ledger>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("forge-close-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut led = Ledger::open(&dir.join("ledger.db")).unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: dir.join("tree"),
            boot_id: "boot-1".into(),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
        led.attach_session("run-1", "session-1").unwrap();
        led.end_run("run-1", "test", "done").unwrap();
        (Some(led), dir)
    }

    fn malformed() -> runner_platform::error::Result<()> {
        Err(Error::Malformed {
            said: "run-session close 400".into(),
            named: vec!["checkpoint: too big".into()],
        })
    }

    #[tokio::test]
    async fn a_close_core_refuses_as_malformed_is_sent_once_and_the_refusal_is_on_the_row() {
        let (mut led, dir) = ended_run();
        let closer = Closer {
            sent: AtomicUsize::new(0),
            answer: malformed,
        };
        for _ in 0..3 {
            close_ended_runs(&closer, &mut led, "boot-1").await;
        }
        assert_eq!(
            closer.sent.load(Ordering::SeqCst),
            1,
            "a close core refused as malformed was re-sent on a later sweep"
        );
        let run = led.as_ref().unwrap().run("run-1").unwrap().unwrap();
        assert!(run.close_refused_at.is_some());
        assert_eq!(run.close_refusal.as_deref(), Some("checkpoint: too big"));
        assert!(
            run.session_terminal_at.is_none(),
            "a close core refused was recorded as a session core closed"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_close_that_fails_for_the_moment_is_sent_again() {
        let (mut led, dir) = ended_run();
        let closer = Closer {
            sent: AtomicUsize::new(0),
            answer: || Err(Error::Other("run-session close 503".into())),
        };
        for _ in 0..3 {
            close_ended_runs(&closer, &mut led, "boot-1").await;
        }
        assert_eq!(closer.sent.load(Ordering::SeqCst), 3);
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod session_hold_tests {
    use super::*;
    use runner_core::ledger::NewRun;
    use runner_platform::error::Error;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Opener {
        sent: AtomicUsize,
        held: std::sync::atomic::AtomicBool,
    }

    impl Opener {
        fn new(held: bool) -> Self {
            Opener {
                sent: AtomicUsize::new(0),
                held: held.into(),
            }
        }
    }

    impl SessionOpener for Opener {
        async fn open(
            &self,
            _project_id: &str,
            _run_id: &str,
            _issue_keys: &[String],
            _name: &str,
            _gate: Option<&runner_proto::gate::Condition>,
        ) -> runner_platform::error::Result<(String, String)> {
            self.sent.fetch_add(1, Ordering::SeqCst);
            if self.held.load(Ordering::SeqCst) {
                Err(Error::Held {
                    said: "run-session open 422 ISSUE_BLOCKED: ISS-46: a live blocks edge holds it, ISS-44 is at awaiting_release".into(),
                    code: "ISSUE_BLOCKED".into(),
                })
            } else {
                Ok(("session-1".into(), "run-1".into()))
            }
        }
    }

    fn declared() -> (Option<Ledger>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("forge-hold-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut led = Ledger::open(&dir.join("ledger.db")).unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: dir.join("tree"),
            boot_id: "boot-1".into(),
            issue_keys: vec!["ISS-46".into()],
        })
        .unwrap();
        (Some(led), dir)
    }

    const SWEEP_MS: i64 = 30_000;
    const T0: i64 = 1_000_000_000;

    #[tokio::test]
    async fn an_open_core_refused_over_a_hold_is_sent_once_per_interval_not_every_sweep() {
        let (mut led, dir) = declared();
        let opener = Opener::new(true);
        let sweeps = 20; // ten minutes of 30 s sweeps
        for n in 0..sweeps {
            open_declared_runs_at(&opener, &mut led, "boot-1", None, T0 + n * SWEEP_MS).await;
        }
        // The first at minute 0, the second at minute 5, the third at minute 10 (not reached).
        assert_eq!(
            opener.sent.load(Ordering::SeqCst),
            2,
            "a run refused ISSUE_BLOCKED was re-sent on sweeps inside the retry interval"
        );
        let run = led.as_ref().unwrap().run("run-1").unwrap().unwrap();
        assert_eq!(
            run.session_refused_at,
            Some(T0),
            "the first refusal is kept"
        );
        assert!(run.session_refusal.unwrap().contains("ISSUE_BLOCKED"));
        assert_eq!(run.session_retry_at, Some(T0 + 10 * 30_000));
        assert!(
            run.session_id.is_none() && run.ended_by.is_none(),
            "the run stands"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn the_hold_lifting_opens_the_session_at_the_next_interval() {
        let (mut led, dir) = declared();
        let opener = Opener::new(true);
        open_declared_runs_at(&opener, &mut led, "boot-1", None, T0).await;
        opener.held.store(false, Ordering::SeqCst);
        let early =
            open_declared_runs_at(&opener, &mut led, "boot-1", None, T0 + SESSION_RETRY_MS - 1)
                .await;
        assert_eq!(early, 0, "inside the interval nothing is sent");
        let at =
            open_declared_runs_at(&opener, &mut led, "boot-1", None, T0 + SESSION_RETRY_MS).await;
        assert_eq!(at, 1);
        let run = led.as_ref().unwrap().run("run-1").unwrap().unwrap();
        assert_eq!(run.session_id.as_deref(), Some("session-1"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_unheld_declaration_opens_on_its_first_sweep() {
        let (mut led, dir) = declared();
        let opener = Opener::new(false);
        let n = open_declared_runs_at(&opener, &mut led, "boot-1", None, T0).await;
        assert_eq!(n, 1);
        assert_eq!(opener.sent.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_failure_that_is_not_a_hold_is_still_sent_every_sweep() {
        struct Down(AtomicUsize);
        impl SessionOpener for Down {
            async fn open(
                &self,
                _: &str,
                _: &str,
                _: &[String],
                _: &str,
                _: Option<&runner_proto::gate::Condition>,
            ) -> runner_platform::error::Result<(String, String)> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(Error::Other("run-session open 503".into()))
            }
        }
        let (mut led, dir) = declared();
        let opener = Down(AtomicUsize::new(0));
        for n in 0..5 {
            open_declared_runs_at(&opener, &mut led, "boot-1", None, T0 + n * SWEEP_MS).await;
        }
        assert_eq!(opener.0.load(Ordering::SeqCst), 5);
        let _ = std::fs::remove_dir_all(dir);
    }
}
