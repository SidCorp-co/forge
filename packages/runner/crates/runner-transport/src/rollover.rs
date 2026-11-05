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

/// Why a call to core has no answer to hand back.
#[derive(Debug)]
pub enum SendError {
    /// No status at all, or a body that never arrived: the transport's own error.
    Unanswered(reqwest::Error),
    /// A rollover's `503` on every attempt within the budget.
    RolledOver(GaveUp),
}

impl SendError {
    pub fn is_timeout(&self) -> bool {
        matches!(self, SendError::Unanswered(e) if e.is_timeout())
    }

    /// The transport's error, where the call got no answer.
    pub fn transport(&self) -> Option<&reqwest::Error> {
        match self {
            SendError::Unanswered(e) => Some(e),
            SendError::RolledOver(_) => None,
        }
    }

    /// The same sentence with no url in it, for a caller that never prints one.
    pub fn without_url(self) -> Self {
        match self {
            SendError::Unanswered(e) => SendError::Unanswered(e.without_url()),
            other => other,
        }
    }
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::Unanswered(e) => e.fmt(f),
            SendError::RolledOver(g) => g.fmt(f),
        }
    }
}

impl std::error::Error for SendError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SendError::Unanswered(e) => Some(e),
            SendError::RolledOver(_) => None,
        }
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

/// `req` sent on `http`, again while a rollover answers it, until `rollover.budget` runs out.
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
            return Ok(http.execute(req).await?);
        };
        attempts += 1;
        let resp = http.execute(this).await?;
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
        let asked = retry_after(&resp);
        let (resp, body) = read_back(resp).await?;
        let Some(unready) = Unready::of(StatusCode::SERVICE_UNAVAILABLE, &body) else {
            return Ok(resp);
        };
        if !idempotent && !unready.unhandled() {
            return Ok(resp);
        }
        let elapsed = started.elapsed();
        let left = rollover.budget.saturating_sub(elapsed);
        if left.is_zero() {
            return Err(SendError::RolledOver(GaveUp {
                last: unready,
                attempts,
                elapsed,
            }));
        }
        let wait = asked.map_or(pause, |a| a.max(pause)).min(left);
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

/// The body read, and the response rebuilt around the same bytes with its status, headers and
/// url, so a caller handed it reads exactly what core sent.
async fn read_back(resp: Response) -> Result<(Response, String), SendError> {
    use reqwest::ResponseBuilderExt;
    let url = resp.url().clone();
    let (parts, body) = http::Response::<reqwest::Body>::from(resp).into_parts();
    let bytes = Response::from(http::Response::new(body)).bytes().await?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
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
