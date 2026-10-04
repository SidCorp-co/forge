//! The drain a restart waits on, and the admission it closes while it waits.
//!
//! A drain that goes on admitting work waits on a queue it keeps refilling: on
//! a box that declares a run every few minutes it is never empty, and the
//! process serves a deleted binary for as long as the fleet stays busy
//! (ISS-1223). So one `Drain` is shared by every place that admits long work —
//! the control socket's run declarations and the master sweep's pool jobs,
//! placements and nudges — and each of them asks it before admitting.
//!
//! Interactive turns are not gated here. A chat turn and a message into a
//! master pane have no refusal path that reaches the person waiting on them,
//! so refusing one would drop it without a word; they are counted as holders
//! instead, and each lasts a turn.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time::Instant;

use crate::serving::{self, DrainState, Record};
use runner_core::agent_activity::now_ms;

/// How long a drain waits for its holders before it gives up. 879 completed
/// sessions since 2026-09-01 ran p90 at 45 minutes, so this clears it.
pub(crate) const DRAIN_TIMEOUT_SECS: u64 = 2 * 3600;
pub(crate) const DRAIN_POLL_SECS: u64 = 30;
/// How often a drain says what it is still waiting on.
pub(crate) const DRAIN_REPORT_SECS: u64 = 10 * 60;
/// How long admission stays open after a drain gives up before any drain may
/// close it again. Without it the credential loop, which asks every thirty
/// seconds, would reopen admission for thirty seconds in every two hours.
pub(crate) const DRAIN_REOPEN_SECS: u64 = 2 * 3600;

/// Why a drain that was asked for did not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotNow {
    /// Another attempt holds admission closed. Its restart re-execs whatever
    /// build stands on disk with whatever token the store holds, so it answers
    /// for this request too, and its deadline is not moved by it.
    UnderWay { cause: String },
    /// A drain gave up this recently, and admission stays open for the rest of
    /// the interval.
    Reopened { remaining: Duration },
}

impl std::fmt::Display for NotNow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnderWay { cause } => write!(
                f,
                "a drain for {cause} is already under way, and the restart it waits for answers for this too — no second drain is started"
            ),
            Self::Reopened { remaining } => write!(
                f,
                "the last drain gave up and admission stays open for another {} before any drain may close it again",
                serving::span_secs(remaining.as_secs())
            ),
        }
    }
}

/// The attempt that holds admission closed. Only its holder moves it on.
#[derive(Debug)]
pub struct Attempt {
    id: u64,
    cause: String,
    since_ms: i64,
}

struct Inner {
    attempt: Option<u64>,
    next_id: u64,
    reopened_at: Option<Instant>,
    state: Option<DrainState>,
    /// Admissions past the gate whose work is not yet where the holder scan
    /// can see it. The drain counts them as holders, so a declaration that
    /// passed the gate an instant before the attempt began is waited for
    /// rather than restarted over.
    admitting: usize,
}

/// Leave to admit one piece of work, held until that work is recorded where
/// the drain's holder scan reads it. Taken under the same lock `begin` takes,
/// so no admission passes the gate once an attempt holds it.
#[must_use = "a permit dropped at once admits nothing and protects nothing"]
pub struct Permit<'a>(&'a Drain);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut inner = self.0.lock();
        inner.admitting = inner.admitting.saturating_sub(1);
    }
}

/// Why admission is closed, for the two readers that report it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Closed {
    pub cause: String,
    /// The sentence a refused declaration carries.
    pub refusal: String,
}

/// Whether this daemon is admitting work, and the record it keeps of that.
pub struct Drain {
    inner: Mutex<Inner>,
    record_dir: Option<PathBuf>,
    identity: Record,
}

impl Drain {
    /// The drain of this process, which writes the serving record into
    /// `record_dir` now and at every change after.
    pub fn new(record_dir: Option<PathBuf>) -> Self {
        let drain = Self {
            inner: Mutex::new(Inner {
                attempt: None,
                next_id: 1,
                reopened_at: None,
                state: None,
                admitting: 0,
            }),
            record_dir,
            identity: Record::this_process(now_ms()),
        };
        drain.publish(None);
        drain
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Take the one attempt, or be told why not.
    pub fn begin(&self, cause: &str) -> Result<Attempt, NotNow> {
        let mut inner = self.lock();
        if inner.attempt.is_some() {
            let under_way = match &inner.state {
                Some(DrainState::Draining { cause, .. }) => cause.clone(),
                _ => "another cause".to_string(),
            };
            return Err(NotNow::UnderWay { cause: under_way });
        }
        if let Some(at) = inner.reopened_at {
            let open_for = Duration::from_secs(DRAIN_REOPEN_SECS);
            let elapsed = at.elapsed();
            if elapsed < open_for {
                return Err(NotNow::Reopened {
                    remaining: open_for - elapsed,
                });
            }
        }
        let id = inner.next_id;
        inner.next_id += 1;
        inner.attempt = Some(id);
        let since_ms = now_ms();
        let state = DrainState::Draining {
            cause: cause.to_string(),
            since_ms,
            bound_secs: DRAIN_TIMEOUT_SECS,
            outstanding: Vec::new(),
        };
        inner.state = Some(state.clone());
        drop(inner);
        self.publish(Some(state));
        Ok(Attempt {
            id,
            cause: cause.to_string(),
            since_ms,
        })
    }

    fn closed_in(inner: &Inner) -> Option<Closed> {
        inner.attempt?;
        let Some(DrainState::Draining {
            cause, since_ms, ..
        }) = &inner.state
        else {
            return None;
        };
        let waited = ((now_ms() - since_ms).max(0) / 1000) as u64;
        Some(Closed {
            cause: cause.clone(),
            refusal: format!(
                "this box is draining before a restart ({cause}, {} so far) and declares no new run until it has restarted or the drain gives up, at most {} after it began. Nothing was recorded — declare it again once the box has turned over, or once the drain gives up and admission reopens",
                serving::span_secs(waited),
                serving::span_secs(DRAIN_TIMEOUT_SECS)
            ),
        })
    }

    /// Leave to admit one piece of work, or why there is none.
    pub fn admit(&self) -> Result<Permit<'_>, Closed> {
        let mut inner = self.lock();
        if let Some(closed) = Self::closed_in(&inner) {
            return Err(closed);
        }
        inner.admitting += 1;
        Ok(Permit(self))
    }

    /// The cause of the drain holding admission closed, where one is.
    pub fn draining_for(&self) -> Option<String> {
        Self::closed_in(&self.lock()).map(|c| c.cause)
    }

    pub(crate) fn admitting(&self) -> usize {
        self.lock().admitting
    }

    fn report(&self, attempt: &Attempt, outstanding: &[String]) {
        let mut inner = self.lock();
        if inner.attempt != Some(attempt.id) {
            return;
        }
        let state = DrainState::Draining {
            cause: attempt.cause.clone(),
            since_ms: attempt.since_ms,
            bound_secs: DRAIN_TIMEOUT_SECS,
            outstanding: outstanding.to_vec(),
        };
        inner.state = Some(state.clone());
        drop(inner);
        self.publish(Some(state));
    }

    fn give_up(&self, attempt: Attempt, outstanding: Vec<String>, next: &NextAttempt) {
        let mut inner = self.lock();
        if inner.attempt != Some(attempt.id) {
            return;
        }
        inner.attempt = None;
        inner.reopened_at = Some(Instant::now());
        let now = now_ms();
        let due_in = next.due_in.max(Duration::from_secs(DRAIN_REOPEN_SECS));
        let state = DrainState::Deferred {
            cause: attempt.cause,
            gave_up_at_ms: now,
            outstanding,
            next_attempt: next.by.clone(),
            next_attempt_at_ms: now + due_in.as_millis() as i64,
        };
        inner.state = Some(state.clone());
        drop(inner);
        self.publish(Some(state));
    }

    fn publish(&self, drain: Option<DrainState>) {
        let Some(dir) = &self.record_dir else {
            return;
        };
        let record = Record {
            drain,
            ..self.identity.clone()
        };
        if let Err(e) = serving::write(dir, &record) {
            tracing::error!(
                "[serving] cannot write {}: {e} — `forge-runner status` cannot say which build this daemon serves, or whether it is draining",
                serving::path(dir).display()
            );
        }
    }
}

/// What the caller says about the attempt after a give-up.
pub struct NextAttempt {
    /// Which act makes it, in an operator's words.
    pub by: String,
    /// How long from the give-up until that act.
    pub due_in: Duration,
}

/// How a drain ended.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Drained {
    /// Nothing held it: parked sessions are closed and the caller restarts.
    /// Admission stays closed, so nothing is taken between here and the exit.
    Idle,
    /// The bound passed with work outstanding. Nothing was stopped, and
    /// admission is open again.
    GaveUp,
    /// No attempt was started.
    NotNow(NotNow),
}

fn holders(
    drain: &Drain,
    inflight: &Arc<AtomicUsize>,
    live: &impl Fn() -> Vec<String>,
) -> Vec<String> {
    let mut out = Vec::new();
    let admitting = drain.admitting();
    if admitting > 0 {
        out.push(format!(
            "{admitting} admission(s) that passed the gate before the drain began and are not yet recorded"
        ));
    }
    let turns = inflight.load(Ordering::Acquire);
    if turns > 0 {
        out.push(format!(
            "{turns} interactive turn(s) — a chat turn or a message into a master pane"
        ));
    }
    out.extend(live());
    out
}

fn waiting_line(what: &str, cause: &str, waited: u64, holding: &[String]) -> String {
    format!(
        "[{what}] draining for {cause}: {} of {} waited, {} outstanding — {}. No run, pool job or master is admitted until the restart",
        serving::span_secs(waited),
        serving::span_secs(DRAIN_TIMEOUT_SECS),
        holding.len(),
        holding.join("; ")
    )
}

/// The give-up, and what it costs if the work named never ends: every attempt
/// closes admission for the whole bound again, so a holder that outlives the
/// box keeps it closed for the bound out of every cycle. Before ISS-1223 a
/// drain closed nothing and this cost was zero; it is said here, where an
/// operator reads the give-up, rather than left for them to work out.
fn give_up_line(what: &str, cause: &str, holding: &[String], next: &NextAttempt) -> String {
    let due_in = next.due_in.max(Duration::from_secs(DRAIN_REOPEN_SECS));
    let cycle = DRAIN_TIMEOUT_SECS + due_in.as_secs();
    format!(
        "[{what}] gave up draining for {cause} after {} with {} outstanding — {}. The restart is not taken, because it would stop the work named. Admission is open again, and the next attempt is {}, in {}. If that work is still running then, this repeats: the box admits no new run, pool job or master for {} of every {} until it ends or the service is restarted by hand",
        serving::span_secs(DRAIN_TIMEOUT_SECS),
        holding.len(),
        holding.join("; "),
        next.by,
        serving::span_secs(due_in.as_secs()),
        serving::span_secs(DRAIN_TIMEOUT_SECS),
        serving::span_secs(cycle)
    )
}

/// Hold admission closed and wait for this box's work to finish, saying what
/// it waits on as it goes.
pub(crate) async fn drain_to_idle<F, Fut>(
    drain: &Drain,
    what: &str,
    cause: &str,
    inflight: &Arc<AtomicUsize>,
    live: impl Fn() -> Vec<String>,
    close_parked: F,
    next: impl FnOnce() -> NextAttempt,
) -> Drained
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = usize>,
{
    let attempt = match drain.begin(cause) {
        Ok(a) => a,
        Err(not_now) => return Drained::NotNow(not_now),
    };
    let mut waited = 0u64;
    let mut report_at = 0u64;
    let mut close_parked = Some(close_parked);
    loop {
        let mut holding = holders(drain, inflight, &live);
        if holding.is_empty() {
            if let Some(close) = close_parked.take() {
                let closed = close().await;
                if closed > 0 {
                    tracing::warn!("[{what}] closed {closed} parked session(s) before restarting");
                }
                // Closing takes up to the checkpoint budget, and an
                // interactive turn is admitted meanwhile; the restart would
                // take it, so the box is read again before the exit.
                holding = holders(drain, inflight, &live);
            }
            if holding.is_empty() {
                return Drained::Idle;
            }
        }
        if waited >= DRAIN_TIMEOUT_SECS {
            let next = next();
            tracing::warn!("{}", give_up_line(what, cause, &holding, &next));
            drain.give_up(attempt, holding, &next);
            return Drained::GaveUp;
        }
        if waited >= report_at {
            tracing::warn!("{}", waiting_line(what, cause, waited, &holding));
            drain.report(&attempt, &holding);
            report_at += DRAIN_REPORT_SECS;
        }
        tokio::time::sleep(Duration::from_secs(DRAIN_POLL_SECS)).await;
        waited += DRAIN_POLL_SECS;
    }
}
