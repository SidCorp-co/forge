//! A core that is rolling over, waited out instead of failed on (ISS-1022).
//!
//! A forge-dev deploy removes the old core before the new one serves, and for
//! about 20 s every call is answered `503` by one of three: Traefik with no
//! backend (`no available server`), the old core draining (`CORE_DRAINING`,
//! `lib/drain.ts`), or a core whose statement got no Postgres connection
//! (`DB_CONNECTIONS_EXHAUSTED`, `middleware/error.ts:connectionsExhausted`).
//! Every request a [`crate::CoreClient`] builds is sent through [`send`], so each
//! caller waits that window out the same way, and a caller that gives up says
//! which of the three it met, how often and for how long.
//!
//! Which may be sent again, by method:
//! - Traefik's `no available server` and `CORE_DRAINING` for ANY method: the
//!   first is the proxy answering with no backend to hand the request to, and the
//!   second is core's listener refusing it before any route runs (`drain.ts:gate`).
//!   Neither request reached a handler, so a write cannot have landed.
//! - `DB_CONNECTIONS_EXHAUSTED` for an idempotent method only: it is answered
//!   from inside a handler, which may already have run a statement on another
//!   connection, so a POST or PATCH is handed back as the 503 it got.
//!
//! Any other 5xx, and a 503 naming anything else, is handed back at once.
//!
//! Every answer's body is read here, whole, before it is handed back (ISS-1025): a core stopping
//! mid-answer sends a status and then drops the connection, and a caller that read the body after
//! `send` turned the failed read into an empty body and judged the call by its status alone, so a
//! `200` cut short read as an empty success. A body that breaks off is [`SendError::Cut`], for
//! any status, and an idempotent call cut so is sent again within the same budget as a rollover's
//! `503`; a POST or PATCH is not, since its write may have landed.

use std::time::{Duration, Instant};

use reqwest::{Method, Response, StatusCode};

/// How long the window is waited out, and the pauses between attempts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rollover {
    /// From the first attempt to the last: past it the call gives up.
    pub budget: Duration,
    /// The pause after the first refusal, doubled each time up to `longest_pause`.
    pub first_pause: Duration,
    pub longest_pause: Duration,
}

/// forge-dev answered again about 20 s after the old core stopped (`drain.ts`), so 30 s covers a
/// deploy's window with room; a core that still refuses past it is down, not rolling over.
pub const ROLLOVER: Rollover = Rollover {
    budget: Duration::from_secs(30),
    first_pause: Duration::from_millis(250),
    longest_pause: Duration::from_secs(2),
};

/// The three answers a rollover gives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unready {
    /// Traefik's bare `no available server`: no container is serving.
    NoServer,
    /// `CORE_DRAINING`: the old core takes no new request.
    Draining,
    /// `DB_CONNECTIONS_EXHAUSTED`: no Postgres connection came free.
    NoConnection,
}

impl Unready {
    /// The code the caller is told: core's own, and Traefik's words as one for the proxy.
    pub fn code(self) -> &'static str {
        match self {
            Unready::NoServer => "NO_AVAILABLE_SERVER",
            Unready::Draining => "CORE_DRAINING",
            Unready::NoConnection => "DB_CONNECTIONS_EXHAUSTED",
        }
    }

    /// Whether the request never reached a handler, so sending it again cannot repeat a write.
    fn unhandled(self) -> bool {
        matches!(self, Unready::NoServer | Unready::Draining)
    }

    /// The `503` a rollover answers, read off its body; `None` for every other answer.
    pub fn of(status: StatusCode, body: &str) -> Option<Unready> {
        if status != StatusCode::SERVICE_UNAVAILABLE {
            return None;
        }
        if body.trim().eq_ignore_ascii_case("no available server") {
            return Some(Unready::NoServer);
        }
        match crate::status::refusal_code(body).as_deref() {
            Some("CORE_DRAINING") => Some(Unready::Draining),
            Some("DB_CONNECTIONS_EXHAUSTED") => Some(Unready::NoConnection),
            _ => None,
        }
    }
}

/// A call that rolled over for its whole budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GaveUp {
    pub last: Unready,
    pub attempts: u32,
    pub elapsed: Duration,
}

impl std::fmt::Display for GaveUp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "core answered 503 {} and stayed unready through {} attempts over {:.1}s; a deploy \
             rolls core over in about 20s, so this one is down rather than restarting",
            self.last.code(),
            self.attempts,
            self.elapsed.as_secs_f64()
        )
    }
}

/// An answer whose status arrived and whose body broke off before its end: core stopping
/// mid-answer during a deploy, a reset, or the call's deadline falling inside the body.
#[derive(Debug)]
pub struct Cut {
    /// The status core answered before the body broke off.
    pub status: StatusCode,
    /// How much of the body arrived.
    pub received: usize,
    /// The length the answer's `Content-Length` named, where it named one.
    pub expected: Option<u64>,
    /// Whether the method may be sent again; a cut POST or PATCH reached a handler and is not.
    pub idempotent: bool,
    /// How many times the call was sent; each one was answered and cut.
    pub attempts: u32,
    /// The transport's error that ended the read.
    pub source: reqwest::Error,
}

impl std::fmt::Display for Cut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let expected = self
            .expected
            .map_or_else(|| "its length unnamed".to_string(), |n| n.to_string());
        let why = if self.source.is_timeout() {
            "the call's deadline fell inside it".to_string()
        } else {
            crate::status::innermost(&self.source).unwrap_or_else(|| self.source.to_string())
        };
        write!(
            f,
            "core answered {} and its body broke off after {} of {expected} bytes ({why})",
            self.status, self.received
        )?;
        if self.attempts > 1 {
            write!(f, ", on each of {} attempts", self.attempts)?;
        }
        if !self.idempotent {
            write!(
                f,
                "; the write may have landed, so read the state back before sending it again"
            )?;
        }
        Ok(())
    }
}

/// Why a call to core has no answer to hand back.
#[derive(Debug)]
pub enum SendError {
    /// No status at all: the transport's own error.
    Unanswered(reqwest::Error),
    /// A rollover's `503` on every attempt within the budget.
    RolledOver(GaveUp),
    /// A status, and a body that never arrived whole.
    Cut(Cut),
}

impl SendError {
    pub fn is_timeout(&self) -> bool {
        self.transport().is_some_and(reqwest::Error::is_timeout)
    }

    /// The transport's error, where the call got no answer or only part of one.
    pub fn transport(&self) -> Option<&reqwest::Error> {
        match self {
            SendError::Unanswered(e) => Some(e),
            SendError::Cut(cut) => Some(&cut.source),
            SendError::RolledOver(_) => None,
        }
    }

    /// The same sentence with no url in it, for a caller that never prints one.
    pub fn without_url(self) -> Self {
        match self {
            SendError::Unanswered(e) => SendError::Unanswered(e.without_url()),
            SendError::Cut(cut) => SendError::Cut(Cut {
                source: cut.source.without_url(),
                ..cut
            }),
            other => other,
        }
    }
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::Unanswered(e) => e.fmt(f),
            SendError::RolledOver(g) => g.fmt(f),
            SendError::Cut(cut) => cut.fmt(f),
        }
    }
}

impl std::error::Error for SendError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.transport()
            .map(|e| e as &(dyn std::error::Error + 'static))
    }
}

impl From<reqwest::Error> for SendError {
    fn from(e: reqwest::Error) -> Self {
        SendError::Unanswered(e)
    }
}

/// `builder` sent through [`send`]: the door for a call to core that no [`crate::CoreClient`]
/// builds (pairing, before there is a device token; a judge's sign-in at the deployment).
pub async fn send_builder(
    builder: reqwest::RequestBuilder,
    rollover: Rollover,
) -> Result<Response, SendError> {
    let (http, req) = builder.build_split();
    send(&http, req?, rollover).await
}

/// `req` sent on `http`, again while a rollover answers it or an idempotent call's body is cut,
/// until `rollover.budget` runs out. The answer handed back carries its whole body, already read.
/// A request whose body cannot be copied (a stream) is sent once.
pub async fn send(
    http: &reqwest::Client,
    req: reqwest::Request,
    rollover: Rollover,
) -> Result<Response, SendError> {
    let started = Instant::now();
    let idempotent = idempotent(req.method());
    let mut pause = rollover.first_pause;
    let mut attempts = 0u32;
    loop {
        let Some(this) = req.try_clone() else {
            let resp = http.execute(req).await?;
            return read_whole(resp)
                .await
                .map(|(resp, _)| resp)
                .map_err(|read| SendError::Cut(read.cut(idempotent, 1)));
        };
        attempts += 1;
        let resp = http.execute(this).await?;
        let asked = retry_after(&resp);
        let (resp, body) = match read_whole(resp).await {
            Ok(whole) => whole,
            Err(read) => {
                // A body the deadline cut is slow, not cut by a restart: sending it again doubles
                // the wait the call's own bound was set to end.
                let again = idempotent && !read.source.is_timeout();
                let cut = read.cut(idempotent, attempts);
                let Some(wait) = again
                    .then(|| next_wait(started, rollover, pause, None))
                    .flatten()
                else {
                    return Err(SendError::Cut(cut));
                };
                tracing::debug!(
                    "{} {}: {cut}; trying again in {}ms",
                    req.method(),
                    req.url().path(),
                    wait.as_millis()
                );
                tokio::time::sleep(wait).await;
                pause = (pause * 2).min(rollover.longest_pause);
                continue;
            }
        };
        if resp.status() != StatusCode::SERVICE_UNAVAILABLE {
            if attempts > 1 {
                tracing::debug!(
                    "{} {}: answered {} on attempt {attempts}, {}ms after the first",
                    req.method(),
                    req.url().path(),
                    resp.status().as_u16(),
                    started.elapsed().as_millis()
                );
            }
            return Ok(resp);
        }
        let Some(unready) = Unready::of(StatusCode::SERVICE_UNAVAILABLE, &body) else {
            return Ok(resp);
        };
        if !idempotent && !unready.unhandled() {
            return Ok(resp);
        }
        let Some(wait) = next_wait(started, rollover, pause, asked) else {
            return Err(SendError::RolledOver(GaveUp {
                last: unready,
                attempts,
                elapsed: started.elapsed(),
            }));
        };
        tracing::debug!(
            "{} {}: 503 {} on attempt {attempts}; trying again in {}ms",
            req.method(),
            req.url().path(),
            unready.code(),
            wait.as_millis()
        );
        tokio::time::sleep(wait).await;
        pause = (pause * 2).min(rollover.longest_pause);
    }
}

/// The pause before the next attempt, the longer of `pause` and what core `asked` for and never
/// past the budget; `None` once the budget is spent.
fn next_wait(
    started: Instant,
    rollover: Rollover,
    pause: Duration,
    asked: Option<Duration>,
) -> Option<Duration> {
    let left = rollover.budget.saturating_sub(started.elapsed());
    (!left.is_zero()).then(|| asked.map_or(pause, |a| a.max(pause)).min(left))
}

fn idempotent(method: &Method) -> bool {
    matches!(
        *method,
        Method::GET | Method::HEAD | Method::PUT | Method::DELETE | Method::OPTIONS | Method::TRACE
    )
}

/// `Retry-After` in seconds, where the answer names one.
fn retry_after(resp: &Response) -> Option<Duration> {
    resp.headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

/// A body read that broke off: what arrived of it, and why it stopped.
struct BrokenRead {
    status: StatusCode,
    received: usize,
    expected: Option<u64>,
    source: reqwest::Error,
}

impl BrokenRead {
    fn cut(self, idempotent: bool, attempts: u32) -> Cut {
        Cut {
            status: self.status,
            received: self.received,
            expected: self.expected,
            idempotent,
            attempts,
            source: self.source,
        }
    }
}

/// The body read to its end, and the response rebuilt around the same bytes with its status,
/// headers and url, so a caller handed it reads exactly what core sent and its own read cannot
/// fail; the body as text beside it. A read that breaks off is the [`BrokenRead`], never a shorter
/// or empty body.
async fn read_whole(mut resp: Response) -> Result<(Response, String), BrokenRead> {
    use reqwest::ResponseBuilderExt;
    let status = resp.status();
    let expected = resp.content_length();
    let mut bytes = Vec::with_capacity(expected.map_or(0, |n| n.min(1 << 20) as usize));
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => bytes.extend_from_slice(&chunk),
            Ok(None) => break,
            Err(source) => {
                return Err(BrokenRead {
                    status,
                    received: bytes.len(),
                    expected,
                    source,
                })
            }
        }
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let url = resp.url().clone();
    let (parts, _) = http::Response::<reqwest::Body>::from(resp).into_parts();
    // The url rides in an extension the conversion out of `reqwest::Response` drops.
    let (with_url, ()) = http::Response::builder()
        .url(url)
        .body(())
        .expect("a response with only a url set always builds")
        .into_parts();
    let mut parts = parts;
    parts.extensions.extend(with_url.extensions);
    Ok((
        Response::from(http::Response::from_parts(parts, bytes)),
        text,
    ))
}

#[cfg(test)]
#[path = "rollover_tests.rs"]
mod tests;
