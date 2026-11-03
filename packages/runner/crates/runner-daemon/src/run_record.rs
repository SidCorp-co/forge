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
        said: run_sessions::Said<'_>,
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
        said: run_sessions::Said<'_>,
    ) -> runner_platform::error::Result<(String, String)> {
        run_sessions::open(self.0, project_id, run_id, issue_keys, name, gate, said).await
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

/// A run's session name: its issues, or for a judge run over a requirement, that requirement (ISS-735).
fn session_name_of(run: &runner_core::ledger::Run, keys: &[String]) -> String {
    match &run.requirement {
        Some(req) => run_sessions::session_name(std::slice::from_ref(req)),
        None => run_sessions::session_name(keys),
    }
}

fn said_of(run: &runner_core::ledger::Run) -> run_sessions::Said<'_> {
    run_sessions::Said {
        role: run.role.as_deref(),
        requirement: run.requirement.as_deref(),
    }
}

/// One sweep's account to core of this box's runs: the ended ones closed, THEN the declared ones
/// opened, answering `(opened, closed)`.
///
/// Close first, because a run this box just ended may hold the very lease its successor's open
/// asks for. Opened first, the successor was refused `ISSUE_LEASE_HELD` by its predecessor's
/// still-open session, backed off five minutes, and the predecessor's close went out 344 ms
/// later in the same sweep: the reviewer run over adminhub-fe ISS-123 waited six minutes behind a
/// run the box had already printed `closed` for (ISS-929).
pub async fn settle_at_core<S: SessionOpener + SessionCloser>(
    core: &S,
    ledger: &mut Option<Ledger>,
    boot_id: &str,
    gate: Option<&runner_proto::gate::Condition>,
    now_ms: i64,
) -> (usize, usize) {
    let closed = close_ended_runs(core, ledger, boot_id).await;
    let opened = open_declared_runs_at(core, ledger, boot_id, gate, now_ms).await;
    (opened, closed)
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
        if keys.is_empty() && run.requirement.is_none() {
            tracing::warn!(
                "[run-record] run {} carries no issues and no requirement, which the ledger should have refused",
                run.run_id
            );
            continue;
        }
        let (name, said) = (session_name_of(&run, &keys), said_of(&run));
        match opener.open(&project_id, &run.run_id, &keys, &name, gate, said).await {
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
                end_refused(led, &run.run_id, &format!("{said} — {why}"), &why);
            }
            // A take on an issue at rest is refused at declare (FB-273); one reaching the open was
            // moved to rest after its declaration, or declared while core could not be asked. A
            // run over issues all closed takes nothing and core opens it (ISS-576). Core
            // queues nothing behind it and no sweep lifts it, so the row ends here as the
            // malformed one does: no core session was minted, and the release that follows
            // keeps a checkout a live subagent is working in (`terminate::live_subagent`).
            Err(runner_platform::error::Error::AtRest { said }) => {
                let why = format!(
                    "core refuses a run over an issue at rest: {said}. Declare again once the issue is back in work"
                );
                end_refused(led, &run.run_id, &why, &why);
            }
            // A hold is not a fault of the payload and not of the moment: it stands until
            // its holder moves. Core has already recorded the declaration as a queued run
            // behind this refusal, which is where the master reads it (`runs/standing`,
            // `waiting_gate`), so the box names it once, here, and then asks again only
            // when `SESSION_RETRY_MS` has gone, which also keeps that queued row alive.
            Err(runner_platform::error::Error::Held {
                said,
                code,
                holders,
            }) => match held_by_our_ended_run(led, boot_id, &code, &holders) {
                // The holder is a run this box ended and has not yet closed at core: the close
                // leg sends that close on this sweep or the next, and the lease goes with it, so
                // waiting five minutes for it is waiting on ourselves (ISS-929).
                Some(ours) => tracing::info!(
                    "[run-record] run {}: core would not open a session ({code}) while run {ours} still holds the issue; this box ended {ours} and its close at core is owed, so the open is sent again next sweep",
                    run.run_id
                ),
                None => note_session_held(led, &run, &code, &said, now_ms),
            },
            Err(e) => tracing::warn!(
                "[run-record] run {}: core would not open a session: {e} — the row stands and the next sweep tries again",
                run.run_id
            ),
        }
    }
    opened
}

/// End a run whose open core refused for good, saying `said` and recording `why` on the row. No
/// core session was minted, so nothing at core has to be told.
fn end_refused(led: &Ledger, run_id: &str, said: &str, why: &str) {
    tracing::error!("[run-record] run {run_id}: {said}. The run is ended here rather than re-sent");
    if let Err(e) = led.end_run(run_id, "run-record", why) {
        tracing::error!(
            "[run-record] run {run_id}: the refusal could not be written onto the row: {e} — the next sweep will send it again"
        );
    }
}

/// The code core answers when a live run session holds an issue an open asks for.
const LEASE_HELD: &str = "ISSUE_LEASE_HELD";

/// The run of this box's own that holds every issue a lease refusal names, where each holder is
/// a run this box has ended and whose close at core is still owed (`close_ended_runs` sends it).
/// `None` for any other hold, a holder that is another box's or a live run's, and a refusal
/// naming no holder (a core before ISS-929): those keep `SESSION_RETRY_MS`.
fn held_by_our_ended_run(
    led: &Ledger,
    boot_id: &str,
    code: &str,
    holders: &[runner_platform::error::LeaseHolder],
) -> Option<String> {
    if code != LEASE_HELD || holders.is_empty() {
        return None;
    }
    let owed = match led.ended_with_open_session(boot_id) {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("[run-record] cannot read ended runs to tell a lease's holder: {e}");
            return None;
        }
    };
    let mut ours = Vec::new();
    for h in holders {
        let run = owed.iter().find(|r| {
            r.session_id.as_deref() == Some(h.session_id.as_str())
                || h.box_run_id.as_deref() == Some(r.run_id.as_str())
        })?;
        if !ours.contains(&run.run_id) {
            ours.push(run.run_id.clone());
        }
    }
    Some(ours.join(", "))
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
        if run.session_id.is_none() {
            continue;
        }
        let standing = led
            .open_run_at_tree(&run.worktree_path)
            .ok()
            .flatten()
            .map(|next| next.run_id);
        let sent = send_close(closer, &run, standing.as_deref()).await;
        if record_close(led, &run.run_id, sent) == CloseAtCore::Closed {
            closed += 1;
        }
    }
    closed
}

/// What one ended run's close at core came to, once recorded on its row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseAtCore {
    /// Core closed the session; the row says so.
    Closed,
    /// Core refused this close as malformed and will refuse it again unchanged; the row says so
    /// and no sweep re-sends it.
    Refused(String),
    /// Core did not take it now (unreachable, a 5xx, a mark that did not land); the next sweep
    /// sends it again.
    Owed(String),
    /// The run has no core session to close.
    NoSession,
}

/// Send one ended run's close to core: its reason, its checkpoint and the claim holders its
/// master's close gives back. `standing` is the run now standing in its tree, if any. The one
/// sender of a close, for the sweep and for `run close` alike (ISS-929).
pub async fn send_close(
    closer: &impl SessionCloser,
    run: &runner_core::ledger::Run,
    standing: Option<&str>,
) -> runner_platform::error::Result<()> {
    let Some(session_id) = run.session_id.as_deref() else {
        return Ok(());
    };
    // Built to what `closeBodySchema` states rather than sent and refused:
    // an operator's `run close --reason` writes this field and nothing
    // bounded it on this side, and a close core refuses is retried on every
    // sweep the same way a declaration was (ISS-1284).
    let detail = run_sessions::fit(
        &run.ended_reason.clone().unwrap_or_default(),
        run_sessions::MAX_DETAIL_CODE_UNITS,
    );
    let checkpoint = Some(checkpoint::reconstruct_within_budget(run).await.to_json());
    let holders = claim_holders(run, standing).await;
    closer
        .close(session_id, &detail, checkpoint, &holders)
        .await
}

/// Write what core answered a close onto the run's row, and say it once.
pub fn record_close(
    led: &Ledger,
    run_id: &str,
    sent: runner_platform::error::Result<()>,
) -> CloseAtCore {
    match sent {
        Ok(()) => match led.mark_session_terminal_observed(run_id) {
            Ok(()) => {
                tracing::info!("[run-record] run {run_id} is closed at core");
                CloseAtCore::Closed
            }
            Err(e) => {
                tracing::warn!(
                    "[run-record] run {run_id} closed at core and the mark did not land: {e} — it will be reported again"
                );
                CloseAtCore::Owed(format!("core closed it and the mark did not land: {e}"))
            }
        },
        // The close's bytes are the row's and nothing between sweeps changes
        // them, so a constraint answer is final for them. Core has no door
        // for a device to report this through, so it is recorded on the
        // row (which takes it out of this sweep) and named here once.
        Err(runner_platform::error::Error::Malformed { said, named }) => {
            let why = named.join("; ");
            match led.mark_close_refused(run_id, &why) {
                Ok(()) => {
                    tracing::error!(
                        "[run-record] run {run_id}: {said} — core refused this close as malformed and will refuse it again unchanged ({why}). The close is not re-sent; the run's session stays open at core until core closes it"
                    );
                    CloseAtCore::Refused(format!("{said} ({why})"))
                }
                Err(e) => {
                    tracing::warn!(
                        "[run-record] run {run_id}: {said}; the refusal could not be written onto the row: {e} — the next sweep sends it again"
                    );
                    CloseAtCore::Owed(format!("{said}; the refusal could not be written: {e}"))
                }
            }
        }
        Err(e) => {
            tracing::warn!(
                "[run-record] run {run_id}: core would not take the close: {e} — the next sweep tries again"
            );
            CloseAtCore::Owed(e.to_string())
        }
    }
}

/// The file beside a tree's git directory naming the id a run standing in it holds its issue
/// claims under, minted by the plugin's `forge brief`.
///
/// contract -> github.com/SidCorp-co/forge-plugin:plugin/src/resolve/session/run-id.mjs (`RUN_ID`).
pub const RUN_ID_FILE: &str = "forge-run-id";

/// The ids a run its master closed held its issue claims under, read off its tree before the box
/// gives the tree back, so the close gives those claims back with it (ISS-737). Before, the claim
/// outlived the run for its whole duration: the run's subagent ran inside the master's process, so
/// the pid the claim records stayed alive, and the next run on the issue was refused every write.
///
/// Only a master's close: a run the box ended (its pane gone, its master lost) may be one whose
/// work a person has to see. A tree that is gone, or names no id, gives nothing back, and says so.
/// `standing` is the run now standing in the tree, if any.
pub async fn claim_holders(run: &runner_core::ledger::Run, standing: Option<&str>) -> Vec<String> {
    if run.ended_by.as_deref() != Some("master") {
        return Vec::new();
    }
    // Read when its master closed it (ISS-787); the tree is read now only for a
    // row an older build closed, and never while another run stands in it, whose
    // brief has written its own id there.
    if let Some(held) = &run.claim_holder {
        return vec![held.clone()];
    }
    let tree = &run.worktree_path;
    if let Some(next) = standing {
        tracing::warn!(
            "[run-record] run {}: its tree {} now holds run {next}, whose id it names, so this close gives no claim back; the closed run's claim lapses with its lease",
            run.run_id,
            tree.display()
        );
        return Vec::new();
    }
    let asked = tokio::process::Command::new("git")
        .arg("-C")
        .arg(tree)
        .args(["rev-parse", "--absolute-git-dir"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    let git_dir = match tokio::time::timeout(std::time::Duration::from_secs(5), asked).await {
        Ok(Ok(out)) if out.status.success() => {
            std::path::PathBuf::from(String::from_utf8_lossy(&out.stdout).trim())
        }
        _ => {
            tracing::info!(
                "[run-record] run {}: its tree {} could not be read for the id its claims were taken under, so its close gives no claim back",
                run.run_id,
                tree.display()
            );
            return Vec::new();
        }
    };
    let Ok(text) = std::fs::read_to_string(git_dir.join(RUN_ID_FILE)) else {
        return Vec::new();
    };
    let id = text.trim();
    if id.is_empty() || id.chars().count() > 120 || id.chars().any(char::is_whitespace) {
        tracing::warn!(
            "[run-record] run {}: {} holds no id a claim is taken under, so its close gives no claim back",
            run.run_id,
            git_dir.join(RUN_ID_FILE).display()
        );
        return Vec::new();
    }
    vec![id.to_string()]
}

/// The id a run standing in `tree` holds its claims under, read now and
/// without a process, for `run close` to keep on the row (ISS-787). A linked
/// worktree's `.git` is a file naming its git directory; a main checkout's is
/// that directory.
pub fn tree_claim_holder(tree: &std::path::Path) -> Option<String> {
    let dot_git = tree.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let text = std::fs::read_to_string(&dot_git).ok()?;
        let named = text.trim().strip_prefix("gitdir:")?.trim();
        let path = std::path::PathBuf::from(named);
        if path.is_absolute() {
            path
        } else {
            tree.join(path)
        }
    };
    let text = std::fs::read_to_string(git_dir.join(RUN_ID_FILE)).ok()?;
    let id = text.trim();
    (!id.is_empty() && id.chars().count() <= 120 && !id.chars().any(char::is_whitespace))
        .then(|| id.to_string())
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
        claim_holders: &[String],
    ) -> runner_platform::error::Result<()>;
}

impl SessionCloser for CoreSessions<'_> {
    async fn close(
        &self,
        session_id: &str,
        detail: &str,
        checkpoint: Option<serde_json::Value>,
        claim_holders: &[String],
    ) -> runner_platform::error::Result<()> {
        run_sessions::close(
            self.0,
            session_id,
            run_sessions::Outcome::Ended,
            Some(detail),
            checkpoint,
            claim_holders,
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
        holders: std::sync::Mutex<Vec<Vec<String>>>,
    }

    impl SessionCloser for Closer {
        async fn close(
            &self,
            _session_id: &str,
            _detail: &str,
            _checkpoint: Option<serde_json::Value>,
            claim_holders: &[String],
        ) -> runner_platform::error::Result<()> {
            self.sent.fetch_add(1, Ordering::SeqCst);
            self.holders.lock().unwrap().push(claim_holders.to_vec());
            (self.answer)()
        }
    }

    fn closer(answer: fn() -> runner_platform::error::Result<()>) -> Closer {
        Closer {
            sent: AtomicUsize::new(0),
            answer,
            holders: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A run over ISS-1 in a linked worktree whose git directory names `id`, ended by `by`.
    fn ended_in_a_tree(by: &str, id: &str) -> (Option<Ledger>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("forge-close-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(
            &repo,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "one",
            ],
        );
        let tree = repo.join(".claude/worktrees/iss-1");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "iss-1",
                tree.to_str().unwrap(),
            ],
        );
        std::fs::write(
            repo.join(".git/worktrees/iss-1").join(RUN_ID_FILE),
            format!("{id}\n"),
        )
        .unwrap();
        let mut led = Ledger::open(&dir.join("ledger.db")).unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: tree,
            boot_id: "boot-1".into(),
            issue_keys: vec!["ISS-1".into()],
            role: None,
            requirement: None,
        })
        .unwrap();
        led.attach_session("run-1", "session-1").unwrap();
        led.end_run("run-1", by, "done").unwrap();
        (Some(led), dir)
    }

    /// ISS-737: a run its master closed names on its close the id its tree held, so core gives
    /// back the issue claims taken under it; a run the box ended names none.
    #[tokio::test]
    async fn a_master_close_names_the_id_its_claims_were_taken_under() {
        let (mut led, dir) = ended_in_a_tree("master", "iss-1-5c7c8139");
        let c = closer(|| Ok(()));
        assert_eq!(close_ended_runs(&c, &mut led, "boot-1").await, 1);
        assert_eq!(
            *c.holders.lock().unwrap(),
            vec![vec!["iss-1-5c7c8139".to_string()]]
        );
        let _ = std::fs::remove_dir_all(dir);

        let (mut led, dir) = ended_in_a_tree("box", "iss-1-5c7c8139");
        let c = closer(|| Ok(()));
        close_ended_runs(&c, &mut led, "boot-1").await;
        assert_eq!(
            *c.holders.lock().unwrap(),
            vec![Vec::<String>::new()],
            "a run the box ended gave its claims back as though its master had closed it"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// ISS-787's plant: a master closes a run, and before the sweep sends the
    /// close it declares the reopened issue's next run in the same tree, whose
    /// brief writes its own id there. The close gives back the closed run's
    /// claim, kept as `run close` ended it, never the new run's.
    #[tokio::test]
    async fn a_close_gives_back_the_closed_runs_claim_not_the_next_runs_in_its_tree() {
        for keep in [false, true] {
            let (mut led, dir) = ended_in_a_tree("master", "iss-43-a2492724");
            let l = led.as_mut().unwrap();
            let tree = l.run("run-1").unwrap().unwrap().worktree_path;
            if keep {
                // What `run close` keeps on the row as it ends the run.
                let kept = tree_claim_holder(&tree).expect("the tree names an id");
                l.note_claim_holder("run-1", &kept).unwrap();
            }
            l.create_run_group(NewRun {
                run_id: "run-2".into(),
                project_id: "proj-1".into(),
                master_session_id: "master-1".into(),
                worktree_path: tree.clone(),
                boot_id: "boot-1".into(),
                issue_keys: vec!["ISS-1".into()],
                role: None,
                requirement: None,
            })
            .unwrap();
            std::fs::write(
                dir.join("repo/.git/worktrees/iss-1").join(RUN_ID_FILE),
                "iss-43-8da0784a\n",
            )
            .unwrap();
            let c = closer(|| Ok(()));
            close_ended_runs(&c, &mut led, "boot-1").await;
            let sent = c.holders.lock().unwrap().clone();
            assert!(
                !sent.iter().flatten().any(|h| h == "iss-43-8da0784a"),
                "the close gave back the claim of the run now standing in the tree: {sent:?}"
            );
            let want = if keep {
                vec!["iss-43-a2492724".to_string()]
            } else {
                Vec::new()
            };
            assert_eq!(sent, vec![want], "keep={keep}");
            let _ = std::fs::remove_dir_all(dir);
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
            role: None,
            requirement: None,
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
        let closer = closer(malformed);
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
        let closer = closer(|| Err(Error::Other("run-session close 503".into())));
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
            _said: run_sessions::Said<'_>,
        ) -> runner_platform::error::Result<(String, String)> {
            self.sent.fetch_add(1, Ordering::SeqCst);
            if self.held.load(Ordering::SeqCst) {
                Err(Error::Held {
                    said: "run-session open 422 ISSUE_BLOCKED: ISS-46: a live blocks edge holds it, ISS-44 is at awaiting_release".into(),
                    code: "ISSUE_BLOCKED".into(),
                    holders: Vec::new(),
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
            role: None,
            requirement: None,
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
                _: run_sessions::Said<'_>,
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

    /// FB-273: an open core refuses because an issue is at rest ends the row, once. Nothing
    /// queues behind it at core and no sweep lifts it, so re-sending it is a loop.
    #[tokio::test]
    async fn an_open_refused_over_an_issue_at_rest_ends_the_run_and_is_not_resent() {
        struct Resting(AtomicUsize);
        impl SessionOpener for Resting {
            async fn open(
                &self,
                _: &str,
                _: &str,
                _: &[String],
                _: &str,
                _: Option<&runner_proto::gate::Condition>,
                _: run_sessions::Said<'_>,
            ) -> runner_platform::error::Result<(String, String)> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(Error::AtRest {
                    said: "run-session open 422: ISS-46 is at `closed`".into(),
                })
            }
        }
        let (mut led, dir) = declared();
        let opener = Resting(AtomicUsize::new(0));
        for n in 0..3 {
            open_declared_runs_at(&opener, &mut led, "boot-1", None, T0 + n * SWEEP_MS).await;
        }
        assert_eq!(
            opener.0.load(Ordering::SeqCst),
            1,
            "a run over a closed issue was re-sent"
        );
        let run = led.as_ref().unwrap().run("run-1").unwrap().unwrap();
        assert_eq!(run.ended_by.as_deref(), Some("run-record"));
        assert!(run.ended_reason.unwrap().contains("back in work"));
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// ISS-929: a run this box ended holds its issue's lease at core until its close lands, so the
/// sweep closes before it opens, and a lease refusal whose holder is that run is not backed off.
#[cfg(test)]
mod settle_tests {
    use super::*;
    use runner_core::ledger::NewRun;
    use runner_platform::error::{Error, LeaseHolder};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    const SWEEP_MS: i64 = 30_000;
    const T0: i64 = 1_000_000_000;

    /// A core holding ISS-1's lease under `session-1` until that session is closed, refusing every
    /// other open over ISS-1 the way `issue-lease.ts:takeIssueLeases` does, naming the holder as
    /// `holders` says.
    struct Core {
        session_one_open: AtomicBool,
        /// Closes answered 503 before one is taken.
        closes_down: AtomicUsize,
        holders: Vec<LeaseHolder>,
        said: Mutex<Vec<String>>,
    }

    impl Core {
        fn new(holders: Vec<LeaseHolder>, closes_down: usize) -> Self {
            Core {
                session_one_open: AtomicBool::new(true),
                closes_down: AtomicUsize::new(closes_down),
                holders,
                said: Mutex::new(Vec::new()),
            }
        }
        fn said(&self) -> Vec<String> {
            self.said.lock().unwrap().clone()
        }
    }

    impl SessionOpener for Core {
        async fn open(
            &self,
            _project_id: &str,
            run_id: &str,
            _issue_keys: &[String],
            _name: &str,
            _gate: Option<&runner_proto::gate::Condition>,
            _said: run_sessions::Said<'_>,
        ) -> runner_platform::error::Result<(String, String)> {
            self.said.lock().unwrap().push(format!("open {run_id}"));
            if self.session_one_open.load(Ordering::SeqCst) {
                return Err(Error::Held {
                    said: "run-session open 409 ISSUE_LEASE_HELD: ISS-1 is held".into(),
                    code: "ISSUE_LEASE_HELD".into(),
                    holders: self.holders.clone(),
                });
            }
            Ok(("session-2".into(), "core-run-2".into()))
        }
    }

    impl SessionCloser for Core {
        async fn close(
            &self,
            session_id: &str,
            _detail: &str,
            _checkpoint: Option<serde_json::Value>,
            _claim_holders: &[String],
        ) -> runner_platform::error::Result<()> {
            self.said.lock().unwrap().push(format!("close {session_id}"));
            if self
                .closes_down
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok()
            {
                return Err(Error::Other(
                    "run-session close 503 Service Unavailable".into(),
                ));
            }
            if session_id == "session-1" {
                self.session_one_open.store(false, Ordering::SeqCst);
            }
            Ok(())
        }
    }

    fn ours() -> LeaseHolder {
        LeaseHolder {
            session_id: "session-1".into(),
            box_run_id: Some("run-1".into()),
        }
    }

    fn new_run(dir: &std::path::Path, run_id: &str) -> NewRun {
        NewRun {
            run_id: run_id.into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: dir.join(run_id),
            boot_id: "boot-1".into(),
            issue_keys: vec!["ISS-1".into()],
            role: None,
            requirement: None,
        }
    }

    /// run-1 over ISS-1 opened at core as `session-1` and ended by its master; run-2 then
    /// declared over ISS-1, not yet opened.
    fn ended_then_declared() -> (Option<Ledger>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("forge-settle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut led = Ledger::open(&dir.join("ledger.db")).unwrap();
        led.create_run_group(new_run(&dir, "run-1")).unwrap();
        led.attach_session("run-1", "session-1").unwrap();
        led.end_run("run-1", "master", "done").unwrap();
        led.create_run_group(new_run(&dir, "run-2")).unwrap();
        (Some(led), dir)
    }

    fn row(led: &Option<Ledger>, run_id: &str) -> runner_core::ledger::Run {
        led.as_ref().unwrap().run(run_id).unwrap().unwrap()
    }

    /// (a) One sweep: the ended run's close goes to core before the successor's open, so the
    /// open meets a lease already given back and the successor opens in that same sweep.
    #[tokio::test]
    async fn a_sweep_closes_the_ended_run_before_it_opens_its_successor() {
        let (mut led, dir) = ended_then_declared();
        let core = Core::new(vec![ours()], 0);
        let (opened, closed) = settle_at_core(&core, &mut led, "boot-1", None, T0).await;
        assert_eq!(
            core.said(),
            vec!["close session-1".to_string(), "open run-2".to_string()],
            "the sweep sent the successor's open before the ended run's close"
        );
        assert_eq!((opened, closed), (1, 1));
        assert_eq!(row(&led, "run-2").session_id.as_deref(), Some("session-2"));
        assert!(row(&led, "run-1").session_terminal_at.is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// (b) The ended run's close meets a 503, so its lease still stands when the successor's
    /// open is refused naming it. That holder is this box's own owed close: the open is sent
    /// again on the very next sweep and opens there, not five minutes on.
    #[tokio::test]
    async fn a_lease_held_by_a_run_this_box_ended_is_asked_again_next_sweep() {
        for holder in [
            ours(),
            // Matched by its session alone, as a core that has no box run id for it names it.
            LeaseHolder {
                session_id: "session-1".into(),
                box_run_id: None,
            },
        ] {
            let (mut led, dir) = ended_then_declared();
            let core = Core::new(vec![holder.clone()], 1);
            let (opened, _) = settle_at_core(&core, &mut led, "boot-1", None, T0).await;
            assert_eq!(opened, 0, "{holder:?}");
            let run = row(&led, "run-2");
            assert!(
                run.session_retry_at.is_none(),
                "a refusal held by this box's own ended run started the {} minute wait: {holder:?}",
                SESSION_RETRY_MS / 60_000
            );
            let (opened, closed) =
                settle_at_core(&core, &mut led, "boot-1", None, T0 + SWEEP_MS).await;
            assert_eq!((opened, closed), (1, 1), "{holder:?}");
            assert_eq!(
                core.said(),
                vec![
                    "close session-1".to_string(),
                    "open run-2".to_string(),
                    "close session-1".to_string(),
                    "open run-2".to_string(),
                ]
            );
            assert_eq!(row(&led, "run-2").session_id.as_deref(), Some("session-2"));
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// (c) A lease held by another box's run, or by a refusal from a core that names no holder,
    /// keeps today's wait: the open is not sent again inside `SESSION_RETRY_MS`.
    #[tokio::test]
    async fn a_lease_held_by_another_boxs_run_keeps_the_wait() {
        let elsewhere = LeaseHolder {
            session_id: "session-elsewhere".into(),
            box_run_id: Some("run-elsewhere".into()),
        };
        for holders in [vec![elsewhere.clone()], vec![], vec![ours(), elsewhere]] {
            let (mut led, dir) = ended_then_declared();
            // run-1's close never lands, so its lease stands for the whole test.
            let core = Core::new(holders.clone(), usize::MAX);
            for n in 0..3 {
                settle_at_core(&core, &mut led, "boot-1", None, T0 + n * SWEEP_MS).await;
            }
            let opens = core.said().iter().filter(|s| *s == "open run-2").count();
            assert_eq!(opens, 1, "the open was re-sent inside the wait: {holders:?}");
            assert_eq!(row(&led, "run-2").session_retry_at, Some(T0), "{holders:?}");
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// A holder that is this box's run but whose close core refused as malformed is not owed
    /// by any sweep, so waiting on it next sweep would loop: it keeps the wait.
    #[tokio::test]
    async fn a_holder_whose_close_core_refused_keeps_the_wait() {
        let (led, dir) = ended_then_declared();
        let l = led.as_ref().unwrap();
        l.mark_close_refused("run-1", "checkpoint: too big").unwrap();
        assert_eq!(
            held_by_our_ended_run(l, "boot-1", "ISSUE_LEASE_HELD", &[ours()]),
            None
        );
        assert_eq!(
            held_by_our_ended_run(l, "boot-1", "ISSUE_BLOCKED", &[ours()]),
            None,
            "a hold that is not a lease was read as one"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
