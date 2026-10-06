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
//! - `git_credential` — POST `/api/devices/me/git-credential`: one git ask, one token
//! - `pool`           — GET `/me/pool` and the prepare/start/release claim (ISS-1080)
//! - `channel_inbox`  — GET `/me/channel/unanswered`: what a project's channel owes (ISS-38)
//! - `comment_inbox`  — GET `/me/comments/unanswered`: what a project's issue threads owe a person
//! - `requirement_inbox` — GET `/me/requirements/owed` and `/me/requirements/returned`: which agreed
//!   requirements owe a breakdown, and which returned revisions owe a revise
//! - `feedback_inbox` — GET `/me/feedback/owed`: which feedback items owe the master a triage
//! - `design_inbox` — GET `/me/designs/owed`: which returned designs owe the master a revision
//! - `master_verdict` — POST `/me/master-session/verdict`: core's verdict on a project's master
pub mod admissible;
pub mod agent_sessions;
pub mod api;
pub mod channel_inbox;
pub mod checkout_head;
pub mod comment_inbox;
pub mod design_inbox;
pub mod events;
pub mod feedback_inbox;
pub mod git_credential;
pub mod heartbeat;
pub mod inbox;
pub mod lifecycle;
pub mod master;
pub mod master_verdict;
pub mod mcp_servers;
pub mod plugins;
pub mod pool;
pub mod provision;
pub mod questions;
pub mod requirement_inbox;
pub mod run_sessions;
pub mod runners;
pub mod skills;
pub mod status;
pub mod ws;

/// How long one call to core may take before it is a failed call rather than a
/// wait. [`CoreClient`] carries no deadline of its own, so a peer that accepts
/// the connection and never answers held the call, and the sweep behind it, for
/// as long as the socket stayed open: nothing was recorded, and every heartbeat
/// in the meantime told core the box had read cleanly (ISS-1234, ISS-1233).
/// Shorter than the heartbeat's 30s, so the beat after a hung call already
/// carries it.
pub const CALL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15);

/// Shared HTTP client + auth context for the REST surface.
#[derive(Clone)]
pub struct CoreClient {
    base: String,
    device_token: String,
    http: reqwest::Client,
}

impl CoreClient {
    pub fn new(core_url: impl Into<String>, device_token: impl Into<String>) -> Self {
        Self {
            base: core_url.into().trim_end_matches('/').to_string(),
            device_token: device_token.into(),
            http: reqwest::Client::new(),
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn device_token(&self) -> &str {
        &self.device_token
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// A call to `path` on core, carrying the device token.
    pub fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, self.url(path))
            .bearer_auth(&self.device_token)
    }

    pub fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(reqwest::Method::GET, path)
    }

    pub fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(reqwest::Method::POST, path)
    }

    pub fn patch(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(reqwest::Method::PATCH, path)
    }

    pub fn delete(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(reqwest::Method::DELETE, path)
    }
}
