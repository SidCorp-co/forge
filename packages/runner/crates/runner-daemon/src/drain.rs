//! The handover a new build waits on, and the admission it closes for the
//! seconds the handover itself takes.
//!
//! Masters, the runs inside them and job panes live on tmux servers placed as
//! units of their own, and the next daemon adopts every one of them, so none
//! of them is a reason for a new build to wait (ISS-1379). What a handover
//! does cut is the work held in THIS process: a chat turn, a message being
//! typed into a pane, an admission between its gate and its ledger write, and
//! a control request between its read and its reply. The handover waits for
//! those with admission open, then closes it only for the window in which the
//! requests in flight are answered and the image is replaced.
//!
//! One `Drain` is shared by every place that admits long work — the control
//! socket's run declarations and the master sweep's pool jobs, placements and
//! nudges — and by the control socket's server, which pauses accepting for the
//! closing window and counts the requests it is serving.
//!
//! Interactive turns are not gated here. A chat turn and a message into a
//! master pane have no refusal path that reaches the person waiting on them,
//! so refusing one would drop it without a word; they are counted as holders
//! instead, and each lasts a turn.

use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time::Instant;

use crate::serving::{self, DrainState, Record};
use runner_core::agent_activity::now_ms;

/// How long a handover waits for its in-process work before it gives up. 879
/// completed sessions since 2026-09-01 ran p90 at 45 minutes, so this clears
/// the longest chat turn the box has measured.
pub(crate) const DRAIN_TIMEOUT_SECS: u64 = 2 * 3600;
pub(crate) const DRAIN_POLL_SECS: u64 = 30;
/// How often a waiting handover says what it is still waiting on.
pub(crate) const DRAIN_REPORT_SECS: u64 = 10 * 60;
/// How long after a give-up no other handover begins. Admission stays open
/// either way; this spaces the attempts, so the credential loop, which asks
/// every thirty seconds, does not start a two-hour wait again at once.
pub(crate) const DRAIN_REOPEN_SECS: u64 = 2 * 3600;
/// The most the closing window waits for the requests in flight to be
/// answered before it reopens admission and goes back to waiting.
pub(crate) const HANDOVER_QUIET_SECS: u64 = 10;
/// How often the closing window reads the requests in flight.
const QUIET_POLL_MS: u64 = 50;

/// Why a handover that was asked for did not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotNow {
    /// Another attempt is under way. Its handover execs whatever build stands
    /// on disk, which reads whatever token the store holds, so it answers for
    /// this request too, and its deadline is not moved by it.
    UnderWay { cause: String },
    /// A handover gave up this recently, and no other begins for the rest of
    /// the interval.
    Reopened { remaining: Duration },
}

impl std::fmt::Display for NotNow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnderWay { cause } => write!(
                f,
                "a handover for {cause} is already under way, and the build it hands over to answers for this too — no second handover is started"
            ),
            Self::Reopened { remaining } => write!(
                f,
                "the last handover gave up, and no other begins for another {}; admission is open all the while",
                serving::span_secs(remaining.as_secs())
            ),
        }
    }
}

/// The attempt under way. Only its holder moves it on.
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
    /// Whether the closing window is open: the one state in which admission
    /// is refused.
    closed: bool,
    /// Admissions past the gate whose work is not yet where the next daemon
    /// would read it. A handover counts them as holders, so a declaration that
    /// passed the gate an instant before the window closed is written before
    /// the image is replaced.
    admitting: usize,
}

/// Leave to admit one piece of work, held until that work is recorded. Taken
/// under the same lock the closing window takes, so no admission passes the
/// gate once the window is closed.
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

/// The control socket's half of a handover: the listener a new image is
/// handed, whether the server may accept, and the requests it is serving.
pub struct Socket {
    /// The listener's descriptor, or -1 where the server has none.
    listener: AtomicI64,
    accepting: tokio::sync::watch::Sender<bool>,
    serving: Arc<AtomicUsize>,
    /// How many times accepting has been stopped, and the latest of those the
    /// server has acknowledged standing still for. A stop is a notification
    /// and not a fact: the server can be between an accept and the guard that
    /// counts it when the stop is sent, so the window reads the count only
    /// once the server says it has stopped (ISS-1379, review F1).
    stops: AtomicU64,
    stood: AtomicU64,
}

/// One control request between its accept and its reply.
#[must_use = "a request guard dropped at once counts nothing"]
pub struct Serving(Arc<AtomicUsize>);

impl Drop for Serving {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Socket {
    fn new() -> Self {
        Self {
            listener: AtomicI64::new(-1),
            accepting: tokio::sync::watch::channel(true).0,
            serving: Arc::new(AtomicUsize::new(0)),
            stops: AtomicU64::new(0),
            stood: AtomicU64::new(0),
        }
    }

    /// The server says which descriptor it listens on, for the handover to
    /// carry.
    pub fn publish_listener(&self, fd: i64) {
        self.listener.store(fd, Ordering::Release);
    }

    /// The listener the server published, where it published one.
    pub fn listener(&self) -> Option<i64> {
        let fd = self.listener.load(Ordering::Acquire);
        (fd >= 0).then_some(fd)
    }

    /// Whether the server may accept, and every change to it.
    pub fn accepting(&self) -> tokio::sync::watch::Receiver<bool> {
        self.accepting.subscribe()
    }

    /// Count one request from its accept until the guard drops.
    pub fn serving(&self) -> Serving {
        self.serving.fetch_add(1, Ordering::AcqRel);
        Serving(self.serving.clone())
    }

    pub(crate) fn in_flight(&self) -> usize {
        self.serving.load(Ordering::Acquire)
    }

    /// The server read `accepting` as stopped and will accept nothing until
    /// it reads it open: every connection it accepted before has its guard.
    /// Called with nothing between the read and this call but registering
    /// what the last accept took.
    pub fn stand_still(&self) {
        let stops = self.stops.load(Ordering::Acquire);
        self.stood.fetch_max(stops, Ordering::AcqRel);
    }

    /// The server is gone, so nothing will accept and nothing will answer.
    pub fn withdraw_listener(&self) {
        self.listener.store(-1, Ordering::Release);
    }

    /// Whether stop `stop` has been acknowledged, or there is no server to
    /// acknowledge it.
    fn stood_for(&self, stop: u64) -> bool {
        self.listener().is_none() || self.stood.load(Ordering::Acquire) >= stop
    }

    /// Stop or resume accepting. A stop answers its number, which the window
    /// waits to see acknowledged.
    fn set_accepting(&self, open: bool) -> u64 {
        let stop = if open {
            self.stops.load(Ordering::Acquire)
        } else {
            self.stops.fetch_add(1, Ordering::AcqRel) + 1
        };
        self.accepting.send_replace(open);
        stop
    }
}

/// Whether this daemon is admitting work, and the record it keeps of that.
pub struct Drain {
    inner: Mutex<Inner>,
    record_dir: Option<PathBuf>,
    identity: Record,
    socket: Socket,
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
                closed: false,
                admitting: 0,
            }),
            record_dir,
            identity: Record::this_process(now_ms()),
            socket: Socket::new(),
        };
        drain.publish(None);
        drain
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The control socket's half of a handover.
    pub fn socket(&self) -> &Socket {
        &self.socket
    }

    /// Take the one attempt, or be told why not. Admission stays open: an
    /// attempt waits with the box working, and only [`Drain::close_window`]
    /// refuses anything.
    pub fn begin(&self, cause: &str) -> Result<Attempt, NotNow> {
        let mut inner = self.lock();
        if inner.attempt.is_some() {
            let under_way = match &inner.state {
                Some(DrainState::Waiting { cause, .. } | DrainState::Draining { cause, .. }) => {
                    cause.clone()
                }
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
        let state = DrainState::Waiting {
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

    /// Close admission and stop the control server accepting, for the window
    /// in which the requests in flight are answered.
    fn close_window(&self, attempt: &Attempt) -> Option<u64> {
        let mut inner = self.lock();
        if inner.attempt != Some(attempt.id) {
            return None;
        }
        inner.closed = true;
        let state = DrainState::Draining {
            cause: attempt.cause.clone(),
            since_ms: now_ms(),
            bound_secs: HANDOVER_QUIET_SECS,
            outstanding: Vec::new(),
        };
        inner.state = Some(state.clone());
        drop(inner);
        let stop = self.socket.set_accepting(false);
        self.publish(Some(state));
        Some(stop)
    }

    /// Open admission again and go back to waiting, keeping the attempt.
    fn release_window(&self, attempt: &Attempt, outstanding: &[String]) {
        let mut inner = self.lock();
        if inner.attempt != Some(attempt.id) {
            return;
        }
        inner.closed = false;
        let state = DrainState::Waiting {
            cause: attempt.cause.clone(),
            since_ms: attempt.since_ms,
            bound_secs: DRAIN_TIMEOUT_SECS,
            outstanding: outstanding.to_vec(),
        };
        inner.state = Some(state.clone());
        drop(inner);
        self.socket.set_accepting(true);
        self.publish(Some(state));
    }

    fn closed_in(inner: &Inner) -> Option<Closed> {
        if !inner.closed {
            return None;
        }
        inner.attempt?;
        let Some(DrainState::Draining { cause, .. }) = &inner.state else {
            return None;
        };
        Some(Closed {
            cause: cause.clone(),
            refusal: format!(
                "this box is handing over to a new build ({cause}) and declares no new run for the few seconds that takes, at most {}. Nothing was recorded — declare it again in a moment, and the new build will take it",
                serving::span_secs(HANDOVER_QUIET_SECS)
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

    /// The cause of the handover holding admission closed, where one is.
    pub fn draining_for(&self) -> Option<String> {
        Self::closed_in(&self.lock()).map(|c| c.cause)
    }

    pub(crate) fn admitting(&self) -> usize {
        self.lock().admitting
    }

    fn report(&self, attempt: &Attempt, outstanding: &[String]) {
        let mut inner = self.lock();
        if inner.attempt != Some(attempt.id) || inner.closed {
            return;
        }
        let state = DrainState::Waiting {
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
        Self::defer(&mut inner, attempt.cause, outstanding, next);
        let state = inner.state.clone();
        drop(inner);
        self.socket.set_accepting(true);
        self.publish(state);
    }

    /// The handover reached its last step and the new image could not be
    /// started: admission opens again, the server accepts again, and this
    /// process goes on serving the build it started with.
    pub fn handover_failed(&self, why: &str, next: &NextAttempt) {
        let mut inner = self.lock();
        let cause = match &inner.state {
            Some(DrainState::Waiting { cause, .. } | DrainState::Draining { cause, .. }) => {
                cause.clone()
            }
            _ => "a new build".to_string(),
        };
        if inner.attempt.is_none() {
            return;
        }
        Self::defer(&mut inner, cause, vec![why.to_string()], next);
        let state = inner.state.clone();
        drop(inner);
        self.socket.set_accepting(true);
        self.publish(state);
    }

    fn defer(inner: &mut Inner, cause: String, outstanding: Vec<String>, next: &NextAttempt) {
        inner.attempt = None;
        inner.closed = false;
        inner.reopened_at = Some(Instant::now());
        let now = now_ms();
        let due_in = next.due_in.max(Duration::from_secs(DRAIN_REOPEN_SECS));
        inner.state = Some(DrainState::Deferred {
            cause,
            gave_up_at_ms: now,
            outstanding,
            next_attempt: next.by.clone(),
            next_attempt_at_ms: now + due_in.as_millis() as i64,
        });
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
                "[serving] cannot write {}: {e} — `forge-runner status` cannot say which build this daemon serves, or whether it is handing over",
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

/// How a handover's wait ended.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Drained {
    /// Nothing in this process holds it: parked sessions are closed, no
    /// request is in flight, and the caller replaces the image. Admission
    /// stays closed and the server does not accept, so nothing is taken
    /// between here and the exec.
    Idle,
    /// The bound passed with in-process work outstanding. Nothing was stopped,
    /// and admission was open throughout.
    GaveUp,
    /// No attempt was started.
    NotNow(NotNow),
}

/// What in this process a handover waits for with admission open. Control
/// requests are not among them: each lasts a moment and another follows, so
/// they are waited for inside the closing window, where none can begin.
fn holders(drain: &Drain, inflight: &Arc<AtomicUsize>) -> Vec<String> {
    let mut out = Vec::new();
    let admitting = drain.admitting();
    if admitting > 0 {
        out.push(format!(
            "{admitting} admission(s) between the gate and their ledger write"
        ));
    }
    let turns = inflight.load(Ordering::Acquire);
    if turns > 0 {
        out.push(format!(
            "{turns} interactive turn(s) — a chat turn or a message into a master pane"
        ));
    }
    out
}

/// What the closing window waits for: the holders, and the control requests
/// accepted before the server stopped accepting.
fn window_holders(drain: &Drain, inflight: &Arc<AtomicUsize>) -> Vec<String> {
    let mut out = holders(drain, inflight);
    let requests = drain.socket.in_flight();
    if requests > 0 {
        out.push(format!(
            "{requests} control request(s) between their accept and their reply"
        ));
    }
    out
}

fn waiting_line(what: &str, cause: &str, waited: u64, holding: &[String]) -> String {
    format!(
        "[{what}] handing over for {cause} once this process's own work ends: {} of {} waited, {} outstanding — {}. Admission stays open meanwhile, and the runs in the ledger hold nothing: they live in their panes, which the next build adopts",
        serving::span_secs(waited),
        serving::span_secs(DRAIN_TIMEOUT_SECS),
        holding.len(),
        holding.join("; ")
    )
}

/// The give-up, and what it costs: time on the build this process started
/// with, and nothing else — admission was open throughout.
fn give_up_line(what: &str, cause: &str, holding: &[String], next: &NextAttempt) -> String {
    let due_in = next.due_in.max(Duration::from_secs(DRAIN_REOPEN_SECS));
    format!(
        "[{what}] gave up handing over for {cause} after {} with {} outstanding — {}. Admission was never closed while it waited, and nothing was stopped; this process goes on serving the build it started with. The next attempt is {}, in {}",
        serving::span_secs(DRAIN_TIMEOUT_SECS),
        holding.len(),
        holding.join("; "),
        next.by,
        serving::span_secs(due_in.as_secs())
    )
}

/// Wait, with admission open, until nothing in this process would be cut by
/// replacing its image; then close admission for the window in which the
/// requests in flight are answered. `Idle` leaves that window closed for the
/// caller's exec.
pub(crate) async fn drain_to_idle<F, Fut>(
    drain: &Drain,
    what: &str,
    cause: &str,
    inflight: &Arc<AtomicUsize>,
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
        let mut holding = holders(drain, inflight);
        if holding.is_empty() {
            if let Some(close) = close_parked.take() {
                let closed = close().await;
                if closed > 0 {
                    tracing::warn!(
                        "[{what}] closed {closed} parked session(s) before handing over"
                    );
                }
                // Closing takes up to the checkpoint budget with admission
                // open, so the box is read again before the window closes.
                holding = holders(drain, inflight);
            }
            if holding.is_empty() {
                match closing_window(drain, &attempt, inflight).await {
                    Ok(()) => return Drained::Idle,
                    Err(left) => {
                        tracing::warn!(
                            "[{what}] the closing window for {cause} still found {} — admission is open again and the handover goes on waiting",
                            left.join("; ")
                        );
                        holding = left;
                    }
                }
            }
        }
        if waited >= DRAIN_TIMEOUT_SECS {
            let next = next();
            tracing::warn!("{}", give_up_line(what, cause, &holding, &next));
            drain.give_up(attempt, holding, &next);
            return Drained::GaveUp;
        }
        if waited >= report_at && !holding.is_empty() {
            tracing::warn!("{}", waiting_line(what, cause, waited, &holding));
            drain.report(&attempt, &holding);
            report_at += DRAIN_REPORT_SECS;
        }
        tokio::time::sleep(Duration::from_secs(DRAIN_POLL_SECS)).await;
        waited += DRAIN_POLL_SECS;
    }
}

/// Close admission, stop accepting, and wait for what is in flight to be
/// answered. `Err` carries what was still there at the bound, with the window
/// already released.
async fn closing_window(
    drain: &Drain,
    attempt: &Attempt,
    inflight: &Arc<AtomicUsize>,
) -> Result<(), Vec<String>> {
    let stop = drain.close_window(attempt);
    let bound = Duration::from_secs(HANDOVER_QUIET_SECS);
    let started = Instant::now();
    loop {
        // The acknowledgement is read BEFORE the count. Every accept the
        // server took has its guard by the time it acknowledges, so a count
        // read after an acknowledgement sees them all; read the other way
        // round, a request counted in between is missed (review F1, recheck).
        let still = stop.is_some_and(|stop| !drain.socket.stood_for(stop));
        let mut holding = window_holders(drain, inflight);
        if still {
            holding.push(
                "the control server, which has not yet said it stopped accepting".to_string(),
            );
        }
        if holding.is_empty() {
            return Ok(());
        }
        if started.elapsed() >= bound {
            drain.release_window(attempt, &holding);
            return Err(holding);
        }
        tokio::time::sleep(Duration::from_millis(QUIET_POLL_MS)).await;
    }
}
