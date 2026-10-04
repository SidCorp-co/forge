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
        gate: Option<&crate::proto_gate::Condition>,
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
        gate: Option<&crate::proto_gate::Condition>,
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
    gate: Option<&crate::proto_gate::Condition>,
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
