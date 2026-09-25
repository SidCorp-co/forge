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

use crate::daemon::agent_activity::now_ms;
use crate::daemon::serving::{self, DrainState, Record};

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

    /// A drain that writes no record, for a test.
    #[cfg(test)]
    pub(crate) fn unrecorded() -> Self {
        Self::new(None)
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
                "this box is draining before a restart ({cause}, {} so far) and declares no new run until it has restarted or the drain gives up, at most {} after it began. Nothing was recorded — declare it again once the box has turned over",
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

    /// Why admission is closed, where it is, without taking leave.
    pub fn refusal(&self) -> Option<String> {
        Self::closed_in(&self.lock()).map(|c| c.refusal)
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

fn give_up_line(what: &str, cause: &str, holding: &[String], next: &NextAttempt) -> String {
    let due_in = next.due_in.max(Duration::from_secs(DRAIN_REOPEN_SECS));
    format!(
        "[{what}] gave up draining for {cause} after {} with {} outstanding — {}. The restart is not taken, because it would stop the work named. Admission is open again, and the next attempt is {}, in {}",
        serving::span_secs(DRAIN_TIMEOUT_SECS),
        holding.len(),
        holding.join("; "),
        next.by,
        serving::span_secs(due_in.as_secs())
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

    fn none() -> Vec<String> {
        Vec::new()
    }

    fn one_run() -> Vec<String> {
        vec!["run r-1 (ISS-7)".into()]
    }

    async fn drain_with(
        drain: &Drain,
        inflight: &Arc<AtomicUsize>,
        live: impl Fn() -> Vec<String>,
    ) -> Drained {
        drain_to_idle(
            drain,
            "test",
            "update 0.1.0 → 0.1.1",
            inflight,
            live,
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

    #[tokio::test(start_paused = true)]
    async fn idle_drains_immediately() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(0));
        let (_calls, close) = spy(0);
        let out = drain_to_idle(&drain, "test", "c", &inflight, none, close, next).await;
        assert_eq!(out, Drained::Idle);
    }

    #[tokio::test(start_paused = true)]
    async fn an_idle_drain_still_closes_the_parked_sessions() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(0));
        let (calls, close) = spy(2);
        let out = drain_to_idle(&drain, "test", "c", &inflight, none, close, next).await;
        assert_eq!(out, Drained::Idle);
        assert_eq!(calls.load(Ordering::Acquire), 1);
    }

    /// An idle drain hands the process to its exit with admission still
    /// closed: reopening it here would let a declaration in between the last
    /// poll and the restart that then kills it.
    #[tokio::test(start_paused = true)]
    async fn an_idle_drain_leaves_admission_closed_for_the_exit() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(0));
        assert_eq!(drain_with(&drain, &inflight, none).await, Drained::Idle);
        assert!(drain.refusal().is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_drain_closes_nothing() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(1));
        let (calls, close) = spy(1);
        let out = drain_to_idle(&drain, "test", "c", &inflight, none, close, next).await;
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
        let out = drain_to_idle(&drain, "test", "c", &inflight, none, close, next).await;
        assert_eq!(out, Drained::Idle);
        assert_eq!(calls.load(Ordering::Acquire), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_box_whose_run_sessions_are_live_defers_even_with_nothing_in_flight() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(0));
        assert_eq!(
            drain_with(&drain, &inflight, one_run).await,
            Drained::GaveUp,
            "a live run session is busy, however empty the in-flight counter is"
        );
    }

    // The bug this function was extracted for: the credential path drained,
    // then exited whether or not anything was still running. A detached agent
    // child survives that exit and keeps writing the worktree the relaunched
    // daemon may hand to a second agent.
    #[tokio::test(start_paused = true)]
    async fn busy_past_the_ceiling_refuses_the_restart() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(1));
        assert_eq!(drain_with(&drain, &inflight, none).await, Drained::GaveUp);
    }

    #[tokio::test(start_paused = true)]
    async fn work_that_finishes_inside_the_ceiling_allows_the_restart() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(1));
        let finisher = inflight.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(DRAIN_POLL_SECS * 3)).await;
            finisher.fetch_sub(1, Ordering::AcqRel);
        });
        assert_eq!(drain_with(&drain, &inflight, none).await, Drained::Idle);
    }

    #[tokio::test(start_paused = true)]
    async fn the_ceiling_is_a_ceiling_and_not_a_wait_forever() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(1));
        let started = Instant::now();
        let _ = drain_with(&drain, &inflight, none).await;
        assert!(started.elapsed().as_secs() <= DRAIN_TIMEOUT_SECS + DRAIN_POLL_SECS);
    }

    /// Criterion 1's half that lives here: while an attempt is under way the
    /// drain refuses, naming its cause; before and after, it does not.
    #[tokio::test(start_paused = true)]
    async fn admission_is_refused_while_the_attempt_holds_it_and_named_by_its_cause() {
        let drain = Arc::new(Drain::unrecorded());
        assert!(drain.refusal().is_none(), "no drain, no refusal");
        let inflight = Arc::new(AtomicUsize::new(1));
        let watcher = drain.clone();
        let seen = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(60)).await;
            watcher.refusal()
        });
        let d = drain.clone();
        let out = drain_with(&d, &inflight, none).await;
        let during = seen.await.unwrap().expect("refused during the drain");
        assert!(during.contains("update 0.1.0 → 0.1.1"), "{during}");
        assert!(during.contains("Nothing was recorded"), "{during}");
        assert_eq!(out, Drained::GaveUp);
        assert!(
            drain.refusal().is_none(),
            "criterion 8: the give-up reopens admission"
        );
        assert!(drain.admit().is_ok(), "and a permit is granted again");
    }

    /// Criteria 6 and 7, 9: a line at the start, one at least every ten
    /// minutes, each naming its holders, and a give-up that names them all and
    /// says when the next attempt comes rather than promising an idle window.
    #[tokio::test(start_paused = true)]
    async fn the_drain_speaks_while_it_waits_and_names_what_holds_it() {
        let (buf, _guard) = capture();
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(1));
        let out = drain_with(&drain, &inflight, one_run).await;
        assert_eq!(out, Drained::GaveUp);
        let log = text(&buf);
        let waiting: Vec<&str> = log
            .lines()
            .filter(|l| l.contains("] draining for update 0.1.0 → 0.1.1"))
            .collect();
        let want = (DRAIN_TIMEOUT_SECS / DRAIN_REPORT_SECS) as usize;
        assert_eq!(
            waiting.len(),
            want,
            "one line at the start and one every ten minutes of a two-hour bound: {log}"
        );
        assert!(waiting[0].contains("0s of 2h waited"), "{}", waiting[0]);
        assert!(waiting[1].contains("10m of 2h waited"), "{}", waiting[1]);
        for line in &waiting {
            assert!(line.contains("2 outstanding"), "{line}");
            assert!(line.contains("run r-1 (ISS-7)"), "{line}");
            assert!(line.contains("1 interactive turn(s)"), "{line}");
        }
        let gave_up = log
            .lines()
            .find(|l| l.contains("gave up draining"))
            .expect("a give-up line");
        assert!(gave_up.contains("run r-1 (ISS-7)"), "{gave_up}");
        assert!(gave_up.contains("1 interactive turn(s)"), "{gave_up}");
        assert!(
            gave_up.contains("the next update check, in 4h"),
            "{gave_up}"
        );
        assert!(gave_up.contains("Admission is open again"), "{gave_up}");
        assert!(
            !log.contains("idle window"),
            "no idle watcher exists, so no line may promise one: {log}"
        );
    }

    /// Criterion 11: after a give-up no drain closes admission for the reopen
    /// interval, whichever loop asks — and one may once it has passed.
    #[tokio::test(start_paused = true)]
    async fn a_give_up_keeps_admission_open_for_the_reopen_interval() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(1));
        assert_eq!(drain_with(&drain, &inflight, none).await, Drained::GaveUp);
        tokio::time::advance(Duration::from_secs(30)).await;
        let again = drain_to_idle(
            &drain,
            "cred",
            "a new device token",
            &inflight,
            none,
            || std::future::ready(0),
            next,
        )
        .await;
        match again {
            Drained::NotNow(NotNow::Reopened { remaining }) => {
                assert!(remaining > Duration::from_secs(DRAIN_REOPEN_SECS - 60))
            }
            other => panic!("a drain 30s after a give-up must not start: {other:?}"),
        }
        assert!(drain.refusal().is_none(), "admission stays open");
        tokio::time::advance(Duration::from_secs(DRAIN_REOPEN_SECS)).await;
        assert!(drain.begin("a new device token").is_ok());
    }

    /// Criteria 12 and 13: a second request while one attempt is under way
    /// starts nothing and leaves the first attempt's deadline where it was.
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
        let out = drain_with(&drain, &inflight, none).await;
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

    /// An admission that passed the gate before the attempt began holds the
    /// drain until its work is recorded: the drain cannot read the box idle
    /// between the gate and the write, and no admission passes after `begin`.
    #[tokio::test(start_paused = true)]
    async fn an_admission_already_past_the_gate_holds_the_drain_until_it_lands() {
        let drain = Arc::new(Drain::unrecorded());
        let permit_holder = drain.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let landed = tokio::spawn(async move {
            let permit = permit_holder
                .admit()
                .expect("the gate is open before the drain");
            let _ = rx.await;
            drop(permit);
        });
        tokio::task::yield_now().await;
        let d = drain.clone();
        let inflight = Arc::new(AtomicUsize::new(0));
        let draining = tokio::spawn(async move { drain_with(&d, &inflight, none).await });
        tokio::time::sleep(Duration::from_secs(5 * 60)).await;
        assert!(
            !draining.is_finished(),
            "the drain may not read the box idle while an admission is between the gate and its write"
        );
        let refused = drain
            .admit()
            .err()
            .expect("no admission passes once the attempt began");
        assert_eq!(refused.cause, "update 0.1.0 → 0.1.1");
        tx.send(()).unwrap();
        landed.await.unwrap();
        assert_eq!(draining.await.unwrap(), Drained::Idle);
    }

    /// An interactive turn arriving while parked sessions close is read before
    /// the exit that would take it.
    #[tokio::test(start_paused = true)]
    async fn a_turn_that_arrives_while_parked_sessions_close_is_not_restarted_over() {
        let drain = Drain::unrecorded();
        let inflight = Arc::new(AtomicUsize::new(0));
        let arriving = inflight.clone();
        let close = move || {
            arriving.fetch_add(1, Ordering::AcqRel);
            std::future::ready(0)
        };
        let out = drain_to_idle(&drain, "test", "c", &inflight, none, close, next).await;
        assert_eq!(
            out,
            Drained::GaveUp,
            "a turn that stays past the bound holds the restart it arrived during"
        );
    }

    #[test]
    fn a_drain_writes_the_serving_record_at_each_change() {
        let dir = crate::test_scratch::Scratch::new("drain-rec");
        let drain = Drain::new(Some(dir.to_path_buf()));
        let boot = serving::read(&dir).unwrap().expect("written at start");
        assert_eq!(boot.pid, std::process::id());
        assert_eq!(boot.drain, None);
        let attempt = drain.begin("update 0.1.0 → 0.1.1").unwrap();
        drain.report(&attempt, &["run r-1 (ISS-7)".to_string()]);
        match serving::read(&dir).unwrap().unwrap().drain {
            Some(DrainState::Draining {
                cause, outstanding, ..
            }) => {
                assert_eq!(cause, "update 0.1.0 → 0.1.1");
                assert_eq!(outstanding, ["run r-1 (ISS-7)"]);
            }
            other => panic!("{other:?}"),
        }
        drain.give_up(attempt, vec!["run r-1 (ISS-7)".into()], &next());
        assert!(matches!(
            serving::read(&dir).unwrap().unwrap().drain,
            Some(DrainState::Deferred { .. })
        ));
    }
}
