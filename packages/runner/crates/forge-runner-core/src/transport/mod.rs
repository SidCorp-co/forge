//! Transport to core.
//!
//! - `frames`         — WS frame envelope + `job.assigned` shape
//! - `ws`             — connect `/ws`, Bearer device token, subscribe, reconnect (M1)
//! - `events`         — POST `/api/jobs/:id/events` (batch + retry) (M3)
//! - `lifecycle`      — POST `/complete`, `/fail` (M3)
//! - `heartbeat`      — POST `/api/devices/heartbeat` every 30s (M1)
//! - `runners`        — GET `/api/devices/me/runners` discovery + self PATCH (ISS-271)
//! - `skills`         — device skill sync: manifest/content pull + install report (ISS-278)
//! - `agent_sessions` — GET/PATCH `/api/agent-sessions/:id` for interactive chat (ISS-321)

pub mod agent_sessions;
pub mod events;
pub mod frames;
pub mod heartbeat;
pub mod lifecycle;
pub mod runners;
pub mod skills;
pub mod ws;

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
}
