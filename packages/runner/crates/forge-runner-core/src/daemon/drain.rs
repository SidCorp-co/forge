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

use crate::daemon::agent_activity::now_ms;
use crate::daemon::serving::{self, DrainState, Record};

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
    /// The last update not installed, carried on every record written.
    refused: Mutex<Option<serving::UpdateRefused>>,
    /// The release a probation put back, which no update installs again.
    held_back: Mutex<Option<serving::UpdateRefused>>,
}

impl Drain {
    /// The drain of this process, which writes the serving record into
    /// `record_dir` now and at every change after.
    pub fn new(record_dir: Option<PathBuf>) -> Self {
        // A refusal outlives a restart of the same box: it is settled by the
        // next update check, not by the daemon starting again.
        let refused = record_dir
            .as_deref()
            .and_then(|dir| serving::read(dir).ok().flatten())
            .and_then(|r| r.update_refused);
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
            refused: Mutex::new(refused),
            held_back: Mutex::new(None),
        };
        drain.publish(None);
        drain
    }

    /// A drain that writes no record, for a test.
    #[cfg(test)]
    pub(crate) fn unrecorded() -> Self {
        Self::new(None)
    }

    /// Put this drain inside a handover's closing window, for a test of a
    /// reader that has to refuse there. Its readers are the control socket's
    /// and the master sweep's, which exist on unix only.
    #[cfg(all(test, unix))]
    pub(crate) fn close_for_test(&self, cause: &str) -> Attempt {
        let attempt = self.begin(cause).expect("no attempt is under way");
        self.close_window(&attempt);
        attempt
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

    /// Why admission is closed, where it is, without taking leave.
    pub fn refusal(&self) -> Option<String> {
        Self::closed_in(&self.lock()).map(|c| c.refusal)
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
        Self::defer(&mut inner, cause, Vec::new(), next);
        if let Some(DrainState::Deferred { failed, .. }) = &mut inner.state {
            *failed = Some(why.to_string());
        }
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
            failed: None,
        });
    }

    /// An update to `version` was downloaded and not installed, for `why`:
    /// `status` says so until a later check settles it.
    pub fn update_refused(&self, version: &str, why: &str) {
        *self.refused.lock().unwrap_or_else(|p| p.into_inner()) = Some(serving::UpdateRefused {
            version: version.to_string(),
            why: why.to_string(),
            at_ms: now_ms(),
        });
        let state = self.lock().state.clone();
        self.publish(state);
    }

    /// The release a probation put back, which the update checks skip, or
    /// `None` once another release is installed: `status` says so while it
    /// stands.
    pub fn update_held_back(&self, held: Option<serving::UpdateRefused>) {
        let mut at = self.held_back.lock().unwrap_or_else(|p| p.into_inner());
        if *at == held {
            return;
        }
        *at = held;
        drop(at);
        let state = self.lock().state.clone();
        self.publish(state);
    }

    /// A later check installed an update or found none newer, so the last
    /// refusal no longer describes this box.
    pub fn update_settled(&self) {
        let had = self
            .refused
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
            .is_some();
        if had {
            let state = self.lock().state.clone();
            self.publish(state);
        }
    }

    fn publish(&self, drain: Option<DrainState>) {
        let Some(dir) = &self.record_dir else {
            return;
        };
        let record = Record {
            drain,
            update_refused: self
                .refused
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
            update_held_back: self
                .held_back
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn next() -> NextAttempt {
        NextAttempt {
            by: "the next update check".into(),
            due_in: Duration::from_secs(4 * 3600),
        }
    }

    fn spy(closed: usize) -> (Arc<AtomicUsize>, impl FnOnce() -> std::future::Ready<usize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        (calls, move || {
            seen.fetch_add(1, Ordering::AcqRel);
            std::future::ready(closed)
        })
    }

    async fn drain_with(drain: &Drain, inflight: &Arc<AtomicUsize>) -> Drained {
        drain_to_idle(
            drain,
            "test",
            "update 0.1.0 → 0.1.1",
            inflight,
            || std::future::ready(0),
            next,
        )
        .await
    }

    /// Captures what the drain logs on this thread while `f` runs.
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Capture {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn capture() -> (Arc<Mutex<Vec<u8>>>, tracing::subscriber::DefaultGuard) {
        crate::daemon::keep_tracing_capturable();
        let buf = Arc::new(Mutex::new(Vec::new()));
        let made = buf.clone();
        let sub = tracing_subscriber::fmt()
            .with_writer(move || Capture(made.clone()))
            .with_ansi(false)
            .finish();
        (buf, tracing::subscriber::set_default(sub))
    }

    fn text(buf: &Arc<Mutex<Vec<u8>>>) -> String {
        String::from_utf8_lossy(&buf.lock().unwrap()).into_owned()
    }

    #[test]
    fn the_drain_ceiling_clears_the_measured_ninetieth_percentile() {
        const {
            assert!(
                DRAIN_TIMEOUT_SECS >= 45 * 60,
                "879 completed sessions since 2026-09-01 run p90 at 45 minutes; a ceiling under that gives up on a tenth of all work by construction"
            )
        };
    }

    /// Criterion 1: with nothing in this process, the handover is ready at
    /// once — the first read, not the first poll.
    #[tokio::test(start_paused = true)]
    async fn idle_hands_over_at_once() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(0));
        let started = Instant::now();
        let (_calls, close) = spy(0);
        let out = drain_to_idle(&drain, "test", "c", &inflight, close, next).await;
        assert_eq!(out, Drained::Idle);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_idle_handover_still_closes_the_parked_sessions() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(0));
        let (calls, close) = spy(2);
        let out = drain_to_idle(&drain, "test", "c", &inflight, close, next).await;
        assert_eq!(out, Drained::Idle);
        assert_eq!(calls.load(Ordering::Acquire), 1);
    }

    /// Criterion 2: parked sessions are closed with admission open — a
    /// declaration made while they checkpoint is admitted.
    #[tokio::test(start_paused = true)]
    async fn parked_sessions_close_with_admission_open() {
        let drain = Arc::new(Drain::unrecorded());
        let inflight = Arc::new(AtomicUsize::new(0));
        let during = drain.clone();
        let admitted = Arc::new(Mutex::new(None));
        let seen = admitted.clone();
        let close = move || {
            *seen.lock().unwrap() = Some(during.admit().is_ok());
            std::future::ready(1)
        };
        let out = drain_to_idle(&drain, "test", "c", &inflight, close, next).await;
        assert_eq!(out, Drained::Idle);
        assert_eq!(*admitted.lock().unwrap(), Some(true));
    }

    /// An idle handover leaves admission closed and the server not accepting
    /// for the exec: reopening either here would let work in between the last
    /// read and the replaced image.
    #[tokio::test(start_paused = true)]
    async fn an_idle_handover_leaves_admission_closed_for_the_exec() {
        let drain = Drain::unrecorded();
        let accepting = drain.socket().accepting();
        let inflight = Arc::new(AtomicUsize::new(0));
        assert_eq!(drain_with(&drain, &inflight).await, Drained::Idle);
        assert!(drain.refusal().is_some());
        assert!(!*accepting.borrow());
    }

    /// Criteria 4 and 14: while in-process work holds it, a handover waits
    /// with admission open the whole bound, and a give-up says so.
    #[tokio::test(start_paused = true)]
    async fn a_waiting_handover_admits_work_until_it_gives_up() {
        let drain = Arc::new(Drain::unrecorded());
        let inflight = Arc::new(AtomicUsize::new(1));
        let watcher = drain.clone();
        let seen = tokio::spawn(async move {
            let mut admitted = 0;
            for _ in 0..(DRAIN_TIMEOUT_SECS / 600) {
                tokio::time::sleep(Duration::from_secs(600)).await;
                if watcher.admit().is_ok() && watcher.refusal().is_none() {
                    admitted += 1;
                }
            }
            admitted
        });
        assert_eq!(drain_with(&drain, &inflight).await, Drained::GaveUp);
        assert_eq!(
            seen.await.unwrap(),
            (DRAIN_TIMEOUT_SECS / 600) as usize,
            "admitted at every read across the bound"
        );
        assert!(drain.refusal().is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_handover_closes_nothing() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(1));
        let (calls, close) = spy(1);
        let out = drain_to_idle(&drain, "test", "c", &inflight, close, next).await;
        assert_eq!(out, Drained::GaveUp);
        assert_eq!(calls.load(Ordering::Acquire), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn the_close_waits_for_the_turn_to_finish() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(1));
        let finisher = inflight.clone();
        let (calls, close) = spy(1);
        let observed = calls.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(DRAIN_POLL_SECS * 3)).await;
            assert_eq!(observed.load(Ordering::Acquire), 0, "closed mid-turn");
            finisher.fetch_sub(1, Ordering::AcqRel);
        });
        let out = drain_to_idle(&drain, "test", "c", &inflight, close, next).await;
        assert_eq!(out, Drained::Idle);
        assert_eq!(calls.load(Ordering::Acquire), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn work_that_finishes_inside_the_ceiling_allows_the_handover() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(1));
        let finisher = inflight.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(DRAIN_POLL_SECS * 3)).await;
            finisher.fetch_sub(1, Ordering::AcqRel);
        });
        assert_eq!(drain_with(&drain, &inflight).await, Drained::Idle);
    }

    #[tokio::test(start_paused = true)]
    async fn the_ceiling_is_a_ceiling_and_not_a_wait_forever() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(1));
        let started = Instant::now();
        let _ = drain_with(&drain, &inflight).await;
        assert!(started.elapsed().as_secs() <= DRAIN_TIMEOUT_SECS + DRAIN_POLL_SECS);
    }

    /// Criterion 5: the closing window refuses a declaration naming its cause,
    /// and lasts no longer than its bound when a request will not finish.
    #[tokio::test(start_paused = true)]
    async fn the_closing_window_refuses_by_cause_and_is_bounded() {
        let drain = Arc::new(Drain::unrecorded());
        let inflight = Arc::new(AtomicUsize::new(0));
        let stuck = drain.socket().serving();
        let watcher = drain.clone();
        let during = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            watcher.refusal()
        });
        let d = drain.clone();
        let handing = tokio::spawn(async move { drain_with(&d, &inflight).await });
        let refused = during.await.unwrap().expect("refused inside the window");
        assert!(refused.contains("update 0.1.0 → 0.1.1"), "{refused}");
        assert!(refused.contains("Nothing was recorded"), "{refused}");
        tokio::time::sleep(Duration::from_secs(HANDOVER_QUIET_SECS + 1)).await;
        assert!(
            drain.refusal().is_none(),
            "the window releases at its bound while a request will not finish"
        );
        assert!(*drain.socket().accepting().borrow(), "and accepts again");
        drop(stuck);
        assert_eq!(handing.await.unwrap(), Drained::Idle);
    }

    /// Criterion 10: a request in flight is answered before the window hands
    /// over — the handover does not return while one is being served.
    #[tokio::test(start_paused = true)]
    async fn a_request_in_flight_is_answered_before_the_handover() {
        let drain = Arc::new(Drain::unrecorded());
        let inflight = Arc::new(AtomicUsize::new(0));
        let request = drain.socket().serving();
        let d = drain.clone();
        let handing = tokio::spawn(async move { drain_with(&d, &inflight).await });
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(!handing.is_finished(), "handed over mid-request");
        assert!(
            drain.refusal().is_some(),
            "with the window closed meanwhile"
        );
        drop(request);
        assert_eq!(handing.await.unwrap(), Drained::Idle);
    }

    /// Criterion 10, the race review F1 named: the stop reaches a server that
    /// has accepted a connection and not yet counted it. The window counts
    /// nothing until the server says it stands still, so that connection is
    /// answered before the image is replaced.
    #[tokio::test(start_paused = true)]
    async fn the_window_counts_requests_only_once_the_server_stands_still() {
        let drain = Arc::new(Drain::unrecorded());
        drain.socket().publish_listener(3);
        let inflight = Arc::new(AtomicUsize::new(0));
        let d = drain.clone();
        let handing = tokio::spawn(async move { drain_with(&d, &inflight).await });
        let mut accepting = drain.socket().accepting();
        accepting.wait_for(|open| !open).await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(
            !handing.is_finished(),
            "the window read zero requests before the server stood still"
        );
        let late = drain.socket().serving();
        drain.socket().stand_still();
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(
            !handing.is_finished(),
            "handed over with the connection accepted before the stop unanswered"
        );
        drop(late);
        assert_eq!(handing.await.unwrap(), Drained::Idle);
    }

    /// ISS-1378 criterion 16: the record carries a refused update until a
    /// later check settles it.
    #[test]
    fn a_refused_update_stays_on_the_record_until_a_later_check_settles_it() {
        let dir = crate::test_scratch::Scratch::new("drain-refused");
        let drain = Drain::new(Some(dir.path().to_path_buf()));
        drain.update_refused("0.17.91", "the pre-flight refused it");
        let read = serving::read(dir.path()).unwrap().unwrap();
        let refused = read.update_refused.expect("on the record");
        assert_eq!(refused.version, "0.17.91");
        assert_eq!(refused.why, "the pre-flight refused it");
        let restarted = Drain::new(Some(dir.path().to_path_buf()));
        assert_eq!(
            serving::read(dir.path())
                .unwrap()
                .unwrap()
                .update_refused
                .map(|u| u.version),
            Some("0.17.91".to_string()),
            "review F1: a restart before a later check does not take the refusal off the record"
        );
        restarted.update_settled();
        assert_eq!(
            serving::read(dir.path()).unwrap().unwrap().update_refused,
            None
        );
    }

    /// ISS-1378 criterion 15: a release a probation put back is on the
    /// record while it is held back, a check finding nothing newer does not
    /// take it off, and an install of another release does.
    #[test]
    fn a_held_back_release_stays_on_the_record_until_another_is_installed() {
        let dir = crate::test_scratch::Scratch::new("drain-held");
        let drain = Drain::new(Some(dir.path().to_path_buf()));
        let held = serving::UpdateRefused {
            version: "0.17.99".into(),
            why: "it started 3 times on probation without staying up".into(),
            at_ms: 1,
        };
        drain.update_held_back(Some(held.clone()));
        let read = || serving::read(dir.path()).unwrap().unwrap();
        assert_eq!(read().update_held_back, Some(held.clone()));
        drain.update_settled();
        assert_eq!(
            read().update_held_back,
            Some(held),
            "nothing newer is not another release"
        );
        drain.update_held_back(None);
        assert_eq!(read().update_held_back, None);
    }

    /// The interleaving no paused clock can stop at: the server counts a
    /// request and acknowledges between two reads inside one loop turn of
    /// `closing_window`. Only reading the acknowledgement first makes a count
    /// read after it complete, so the order is asserted on the source itself.
    #[test]
    fn the_window_reads_the_acknowledgement_before_the_count() {
        let source = crate::test_scratch::lf(include_str!("drain.rs"));
        let production = source.split("#[cfg(test)]\nmod tests").next().unwrap();
        let body = production
            .split("async fn closing_window(")
            .nth(1)
            .expect("closing_window");
        let ack = body.find("stood_for(").expect("reads the acknowledgement");
        let count = body.find("window_holders(").expect("reads the count");
        assert!(ack < count, "the count is read before the acknowledgement");
    }

    /// A server that never stands still holds the window only for its bound,
    /// and is named as what held it.
    #[tokio::test(start_paused = true)]
    async fn a_server_that_never_stands_still_releases_the_window_at_its_bound() {
        let drain = Arc::new(Drain::unrecorded());
        drain.socket().publish_listener(3);
        let attempt = drain.begin("update 0.1.0 → 0.1.1").unwrap();
        let inflight = Arc::new(AtomicUsize::new(0));
        let held = closing_window(&drain, &attempt, &inflight)
            .await
            .expect_err("released at the bound");
        assert!(
            held.iter()
                .any(|h| h.contains("has not yet said it stopped accepting")),
            "{held:?}"
        );
        assert!(drain.refusal().is_none());
        assert!(*drain.socket().accepting().borrow());
        drain.socket().withdraw_listener();
        assert!(
            closing_window(&drain, &attempt, &inflight).await.is_ok(),
            "with no server there is nothing to wait for"
        );
    }

    /// Criteria 4 and 14: a line once there is something to wait on and one at
    /// least every ten minutes, each naming it, and a give-up that names it,
    /// says when the next attempt comes, and says admission was never closed.
    #[tokio::test(start_paused = true)]
    async fn the_handover_speaks_while_it_waits_and_names_what_holds_it() {
        let (buf, _guard) = capture();
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(1));
        let out = drain_with(&drain, &inflight).await;
        assert_eq!(out, Drained::GaveUp);
        let log = text(&buf);
        let waiting: Vec<&str> = log
            .lines()
            .filter(|l| l.contains("] handing over for update 0.1.0 → 0.1.1"))
            .collect();
        let want = (DRAIN_TIMEOUT_SECS / DRAIN_REPORT_SECS) as usize;
        assert_eq!(waiting.len(), want, "{log}");
        assert!(waiting[0].contains("0s of 2h waited"), "{}", waiting[0]);
        assert!(waiting[1].contains("10m of 2h waited"), "{}", waiting[1]);
        for line in &waiting {
            assert!(line.contains("1 interactive turn(s)"), "{line}");
            assert!(line.contains("Admission stays open"), "{line}");
        }
        let gave_up = log
            .lines()
            .find(|l| l.contains("gave up handing over"))
            .expect("a give-up line");
        assert!(gave_up.contains("1 interactive turn(s)"), "{gave_up}");
        assert!(
            gave_up.contains("the next update check, in 4h"),
            "{gave_up}"
        );
        assert!(gave_up.contains("Admission was never closed"), "{gave_up}");
    }

    /// After a give-up no handover begins for the reopen interval, whichever
    /// loop asks — and one may once it has passed. Admission is open all along.
    #[tokio::test(start_paused = true)]
    async fn a_give_up_spaces_the_next_attempt_by_the_reopen_interval() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(1));
        assert_eq!(drain_with(&drain, &inflight).await, Drained::GaveUp);
        tokio::time::advance(Duration::from_secs(30)).await;
        let again = drain_to_idle(
            &drain,
            "cred",
            "a new device token",
            &inflight,
            || std::future::ready(0),
            next,
        )
        .await;
        match again {
            Drained::NotNow(NotNow::Reopened { remaining }) => {
                assert!(remaining > Duration::from_secs(DRAIN_REOPEN_SECS - 60))
            }
            other => panic!("a handover 30s after a give-up must not start: {other:?}"),
        }
        assert!(drain.refusal().is_none(), "admission stays open");
        tokio::time::advance(Duration::from_secs(DRAIN_REOPEN_SECS)).await;
        assert!(drain.begin("a new device token").is_ok());
    }

    /// A second request while one attempt is under way starts nothing and
    /// leaves the first attempt's deadline where it was.
    #[tokio::test(start_paused = true)]
    async fn a_second_request_joins_nothing_and_moves_no_deadline() {
        let drain = Arc::new(Drain::unrecorded());
        let inflight = Arc::new(AtomicUsize::new(1));
        let second = drain.clone();
        let asked = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(DRAIN_TIMEOUT_SECS - 60)).await;
            second.begin("a new device token")
        });
        let started = Instant::now();
        let out = drain_with(&drain, &inflight).await;
        assert_eq!(out, Drained::GaveUp);
        assert!(
            started.elapsed().as_secs() <= DRAIN_TIMEOUT_SECS + DRAIN_POLL_SECS,
            "the first attempt's deadline did not move"
        );
        match asked.await.unwrap() {
            Err(NotNow::UnderWay { cause }) => assert_eq!(cause, "update 0.1.0 → 0.1.1"),
            other => panic!("a second request must be refused naming the first: {other:?}"),
        }
    }

    /// An admission that passed the gate before the window closed holds the
    /// handover until its work is recorded, and none passes inside the window.
    #[tokio::test(start_paused = true)]
    async fn an_admission_already_past_the_gate_holds_the_handover_until_it_lands() {
        let drain = Arc::new(Drain::unrecorded());
        let permit_holder = drain.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let landed = tokio::spawn(async move {
            let permit = permit_holder.admit().expect("the gate is open");
            let _ = rx.await;
            drop(permit);
        });
        tokio::task::yield_now().await;
        let d = drain.clone();
        let inflight = Arc::new(AtomicUsize::new(0));
        let handing = tokio::spawn(async move { drain_with(&d, &inflight).await });
        tokio::time::sleep(Duration::from_secs(5 * 60)).await;
        assert!(
            !handing.is_finished(),
            "the handover may not read the box idle while an admission is between the gate and its write"
        );
        tx.send(()).unwrap();
        landed.await.unwrap();
        assert_eq!(handing.await.unwrap(), Drained::Idle);
        let refused = drain
            .admit()
            .err()
            .expect("no admission passes once the window closed");
        assert_eq!(refused.cause, "update 0.1.0 → 0.1.1");
    }

    /// An interactive turn arriving while parked sessions close is read before
    /// the window that would take it.
    #[tokio::test(start_paused = true)]
    async fn a_turn_that_arrives_while_parked_sessions_close_is_not_handed_over() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(0));
        let arriving = inflight.clone();
        let close = move || {
            arriving.fetch_add(1, Ordering::AcqRel);
            std::future::ready(0)
        };
        let out = drain_to_idle(&drain, "test", "c", &inflight, close, next).await;
        assert_eq!(
            out,
            Drained::GaveUp,
            "a turn that stays past the bound holds the handover it arrived during"
        );
    }

    /// Criterion 12: a handover whose new image could not be started opens
    /// admission and the server again, and says what the next attempt is.
    #[tokio::test(start_paused = true)]
    async fn a_failed_handover_reopens_everything() {
        let dir = crate::test_scratch::Scratch::new("drain-failed");
        let drain = Drain::new(Some(dir.to_path_buf()));
        let inflight = Arc::new(AtomicUsize::new(0));
        assert_eq!(drain_with(&drain, &inflight).await, Drained::Idle);
        drain.handover_failed("could not exec /x/forge-runner: not found", &next());
        assert!(drain.refusal().is_none());
        assert!(drain.admit().is_ok());
        assert!(*drain.socket().accepting().borrow());
        match serving::read(&dir).unwrap().unwrap().drain {
            Some(DrainState::Deferred {
                outstanding,
                failed,
                ..
            }) => {
                assert!(
                    outstanding.is_empty(),
                    "a failed exec leaves nothing outstanding: {outstanding:?}"
                );
                assert_eq!(
                    failed.as_deref(),
                    Some("could not exec /x/forge-runner: not found")
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_handover_writes_the_serving_record_at_each_change() {
        let dir = crate::test_scratch::Scratch::new("drain-rec");
        let drain = Drain::new(Some(dir.to_path_buf()));
        let boot = serving::read(&dir).unwrap().expect("written at start");
        assert_eq!(boot.pid, std::process::id());
        assert_eq!(boot.drain, None);
        let attempt = drain.begin("update 0.1.0 → 0.1.1").unwrap();
        drain.report(&attempt, &["1 interactive turn(s)".to_string()]);
        match serving::read(&dir).unwrap().unwrap().drain {
            Some(DrainState::Waiting {
                cause, outstanding, ..
            }) => {
                assert_eq!(cause, "update 0.1.0 → 0.1.1");
                assert_eq!(outstanding, ["1 interactive turn(s)"]);
            }
            other => panic!("{other:?}"),
        }
        drain.close_window(&attempt);
        assert!(matches!(
            serving::read(&dir).unwrap().unwrap().drain,
            Some(DrainState::Draining { .. })
        ));
        drain.give_up(attempt, vec!["1 interactive turn(s)".into()], &next());
        assert!(matches!(
            serving::read(&dir).unwrap().unwrap().drain,
            Some(DrainState::Deferred { .. })
        ));
    }
}
