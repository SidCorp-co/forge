//! Transport to core.
//!
//! - `ws`             — connect `/ws`, Bearer device token, subscribe, reconnect (M1)
//! - `events`         — POST `/api/jobs/:id/events` (batch + retry) (M3)
//! - `lifecycle`      — POST `/api/jobs/:id/ack`, `/fail`, `/kill-ack` (M3)
//! - `heartbeat`      — POST `/api/devices/heartbeat` every 30s (M1)
//! - `runners`        — GET `/api/devices/me/runners` discovery + self PATCH (ISS-271)
//! - `skills`         — device skill sync: manifest/content pull + install report (ISS-278)
//! - `agent_sessions` — GET/PATCH `/api/agent-sessions/:id` for interactive chat (ISS-321)
//! - `checkout_head`  — POST `/me/checkout-heads/:id`: a project's default-branch head, read here
//! - `checkout_ancestry` — POST `/me/checkout-ancestry/:id`: whether commits are ancestors, read here
//! - `git_credential` — POST `/api/devices/me/git-credential`: one git ask, one token
//! - `pool`           — GET `/me/pool` and the prepare/start/release claim (ISS-1080)
//! - `master_verdict` — POST `/me/master-session/verdict`: core's verdict on a project's master,
//!   and the work core read the project owes it
//! - `run_verdict` — POST `/me/run-sessions/verdict`: core's verdict on a run the ledger holds open
pub mod agent_sessions;
pub mod api;
pub mod checkout_ancestry;
pub mod checkout_head;
pub mod events;
pub mod feedback_answers;
pub mod git_credential;
pub mod heartbeat;
pub mod host_command;
pub mod inbox;
pub mod lifecycle;
pub mod master;
pub mod master_verdict;
pub mod mcp_servers;
pub mod ops_read;
pub mod plugins;
pub mod pool;
pub mod provision;
pub mod questions;
pub mod rollover;
pub mod run_sessions;
pub mod run_verdict;
pub mod runners;
pub mod skills;
pub mod status;
pub mod support_build;
pub mod ws;

pub use rollover::{Rollover, SendError, ROLLOVER};

/// How long one call to core may take before it is a failed call rather than a
/// wait. Before [`DEFAULT_DEADLINE`] a [`CoreClient`] carried none, so a peer that accepts
/// the connection and never answers held the call, and the sweep behind it, for
/// as long as the socket stayed open: nothing was recorded, and every heartbeat
/// in the meantime told core the box had read cleanly (ISS-1234, ISS-1233).
/// Shorter than the heartbeat's 30s, so the beat after a hung call already
/// carries it.
pub const CALL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15);

/// The bound every request through a [`CoreClient`] carries unless its route
/// names another: the client is built with it, so a new route inherits a
/// deadline instead of having to remember one. Whole-request, body included.
pub const DEFAULT_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

/// The longer bound a route that moves a payload names for itself (skill and
/// plugin bundles, attachments, an `api` upload): a bundle on a slow link is
/// not a hung peer. Applied with `.timeout(LONG_DEADLINE)` on the request.
pub const LONG_DEADLINE: std::time::Duration = std::time::Duration::from_secs(120);

/// Shared HTTP client + auth context for the REST surface.
#[derive(Clone)]
pub struct CoreClient {
    base: String,
    device_token: String,
    http: reqwest::Client,
    rollover: Rollover,
}

impl CoreClient {
    pub fn new(core_url: impl Into<String>, device_token: impl Into<String>) -> Self {
        Self::with_deadline(core_url, device_token, DEFAULT_DEADLINE)
    }

    /// A client whose requests carry `deadline` unless the route names its own.
    pub fn with_deadline(
        core_url: impl Into<String>,
        device_token: impl Into<String>,
        deadline: std::time::Duration,
    ) -> Self {
        let http = reqwest::Client::builder()
            .timeout(deadline)
            .build()
            .expect("a reqwest client with only a timeout set always builds");
        Self {
            base: core_url.into().trim_end_matches('/').to_string(),
            device_token: device_token.into(),
            http,
            rollover: ROLLOVER,
        }
    }

    /// The same client waiting a rollover out by `rollover` instead of [`ROLLOVER`].
    pub fn with_rollover(mut self, rollover: Rollover) -> Self {
        self.rollover = rollover;
        self
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn device_token(&self) -> &str {
        &self.device_token
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// A call to `path` on core, carrying the device token. Its `send` waits a rollover out
    /// ([`rollover`]); there is no way to send one that does not.
    pub fn request(&self, method: reqwest::Method, path: &str) -> CoreRequest {
        CoreRequest {
            builder: self
                .http
                .request(method, self.url(path))
                .bearer_auth(&self.device_token),
            rollover: self.rollover,
        }
    }

    pub fn get(&self, path: &str) -> CoreRequest {
        self.request(reqwest::Method::GET, path)
    }

    pub fn post(&self, path: &str) -> CoreRequest {
        self.request(reqwest::Method::POST, path)
    }

    pub fn patch(&self, path: &str) -> CoreRequest {
        self.request(reqwest::Method::PATCH, path)
    }

    pub fn delete(&self, path: &str) -> CoreRequest {
        self.request(reqwest::Method::DELETE, path)
    }
}

/// One call to core being built: `reqwest::RequestBuilder`'s setters, and a `send` that goes
/// through [`rollover::send`].
pub struct CoreRequest {
    builder: reqwest::RequestBuilder,
    rollover: Rollover,
}

impl CoreRequest {
    fn map(self, f: impl FnOnce(reqwest::RequestBuilder) -> reqwest::RequestBuilder) -> Self {
        Self {
            builder: f(self.builder),
            rollover: self.rollover,
        }
    }

    pub fn json<T: serde::Serialize + ?Sized>(self, json: &T) -> Self {
        self.map(|b| b.json(json))
    }

    pub fn query<T: serde::Serialize + ?Sized>(self, query: &T) -> Self {
        self.map(|b| b.query(query))
    }

    pub fn header<K, V>(self, key: K, value: V) -> Self
    where
        reqwest::header::HeaderName: TryFrom<K>,
        <reqwest::header::HeaderName as TryFrom<K>>::Error: Into<http::Error>,
        reqwest::header::HeaderValue: TryFrom<V>,
        <reqwest::header::HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        self.map(|b| b.header(key, value))
    }

    pub fn headers(self, headers: reqwest::header::HeaderMap) -> Self {
        self.map(|b| b.headers(headers))
    }

    pub fn body<T: Into<reqwest::Body>>(self, body: T) -> Self {
        self.map(|b| b.body(body))
    }

    /// This call's own bound, per attempt, in place of the client's.
    pub fn timeout(self, timeout: std::time::Duration) -> Self {
        self.map(|b| b.timeout(timeout))
    }

    pub async fn send(self) -> Result<reqwest::Response, SendError> {
        rollover::send_builder(self.builder, self.rollover).await
    }
}

#[cfg(test)]
mod deadline_tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    /// A peer that accepts the connection and never answers.
    async fn silent_peer() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                held.push(sock);
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn a_request_that_names_no_deadline_gives_up_on_a_peer_that_never_answers() {
        let client =
            CoreClient::with_deadline(silent_peer().await, "t", Duration::from_millis(200));
        let outcome = tokio::time::timeout(Duration::from_secs(10), client.get("/x").send())
            .await
            .expect("CoreClient request carries no deadline of its own: the call outlived 10s");
        assert!(outcome.unwrap_err().is_timeout());
    }

    #[tokio::test]
    async fn a_route_naming_its_own_deadline_overrides_the_client_default() {
        let client = CoreClient::with_deadline(silent_peer().await, "t", Duration::from_secs(60));
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            client.get("/x").timeout(Duration::from_millis(200)).send(),
        )
        .await
        .expect("the route's own deadline did not replace the client's");
        assert!(outcome.unwrap_err().is_timeout());
    }

    #[test]
    fn the_long_deadline_is_longer_than_the_default() {
        assert!(LONG_DEADLINE > DEFAULT_DEADLINE && DEFAULT_DEADLINE > CALL_DEADLINE);
    }
}
