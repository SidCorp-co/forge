//! Device heartbeat: `POST /api/devices/heartbeat` (~every 30s).
//!
//! It also carries this box's declaration-gate condition. The heartbeat is the
//! carrier because the degraded case is DEFINED by the control socket or the
//! role list having failed, and neither is on this path — so it is up exactly
//! when the thing being reported is down (ISS-1192).
//!
//! It carries this box's pool reads for the same reason: a read answered 520 at
//! the gateway never reaches core, and this route answered normally around every
//! one measured (ISS-1234).

use super::{status, CoreClient, CALL_DEADLINE};
use crate::error::{Error, Result};
use serde::Deserialize;

pub const INTERVAL_SECS: u64 = 30;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
    #[serde(default)]
    server_time: Option<String>,
    #[serde(default)]
    gate: Option<GateAck>,
    #[serde(default)]
    pool: Option<GateAck>,
}

/// What core says it did with the gate condition. A refusal is carried back
/// rather than swallowed: a box reporting into nothing and not knowing it is
/// the defect this report exists to end, arriving from inside the fix.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GateAck {
    #[serde(default)]
    accepted: bool,
    #[serde(default)]
    reason: Option<String>,
}

/// What core said about the gate, separated from the request so the refusal
/// path can be asserted without a server.
fn gate_refusal(parsed: Option<GateAck>) -> Option<String> {
    parsed.and_then(|g| {
        if g.accepted {
            None
        } else {
            Some(g.reason.unwrap_or_else(|| "no reason given".to_string()))
        }
    })
}

/// What this box says about itself on every beat, read in one place so the
/// tick and a test build the same body.
#[derive(Debug, Default)]
pub struct Conditions {
    pub gate: Option<crate::daemon::degraded::Condition>,
    /// `None` sends no `pool` key, which core reads as "changes nothing"; a list,
    /// even an empty one, is the box's whole picture. A record that exists and
    /// cannot be read is no picture, so it is `None`, never an empty list.
    pub pool: Option<Vec<crate::daemon::pool_reads::Condition>>,
}

impl Conditions {
    /// Both conditions off the files beside `config.toml`; nothing where there
    /// is no such directory to read.
    pub fn read(config_dir: Option<&std::path::Path>, now_ms: i64) -> Self {
        let Some(dir) = config_dir else {
            return Self::default();
        };
        Self {
            gate: Some(crate::daemon::degraded::report(dir, now_ms).degraded),
            pool: crate::daemon::pool_reads::report(dir, now_ms).ok(),
        }
    }
}

/// Core's reasons for refusing either condition while taking the heartbeat.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Refused {
    pub gate: Option<String>,
    pub pool: Option<String>,
}

pub async fn beat(client: &CoreClient, conditions: &Conditions) -> Result<Refused> {
    beat_with(client, conditions)
        .await
        .map(|(_, refused)| refused)
}

/// Like [`beat`] but returns the core's `serverTime` so callers (e.g. `doctor`)
/// can prove core reachability with a concrete value. `401` maps to a clear
/// `UNAUTHORIZED` error so callers can prompt a re-login.
pub async fn beat_verbose(client: &CoreClient) -> Result<String> {
    beat_with(client, &Conditions::default())
        .await
        .map(|(time, _)| time)
}

async fn beat_with(client: &CoreClient, conditions: &Conditions) -> Result<(String, Refused)> {
    let url = client.url("/api/devices/heartbeat");
    // The RELEASED identity, not Cargo's — core compares a box against both halves,
    // and a box that answered with Cargo's number reported the same 0.17.0 as the
    // release while running seven commits of different code (ISS-1165).
    let body = heartbeat_body(
        crate::update::CURRENT_VERSION,
        crate::update::build_commit(),
        conditions,
    );
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&body)
        .timeout(CALL_DEADLINE)
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "heartbeat request: {}",
                status::unanswered(&e, CALL_DEADLINE)
            ))
        })?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(status::refused("heartbeat", code, &text)));
    }
    let parsed = resp
        .json::<HeartbeatResponse>()
        .await
        .map_err(|e| Error::Other(format!("heartbeat decode: {e}")))?;
    Ok((
        parsed.server_time.unwrap_or_default(),
        Refused {
            gate: gate_refusal(parsed.gate),
            pool: gate_refusal(parsed.pool),
        },
    ))
}

/// The gate object exactly as it rides on the heartbeat body, separated from
/// the request so the shape can be asserted without a server.
pub fn gate_body(gate: &crate::daemon::degraded::Condition) -> serde_json::Value {
    serde_json::json!({ "degraded": gate })
}

/// The whole body, built where it can be read without a server. Only the
/// degraded half of the gate travels: `undeclared` shares the box's file, is a
/// different fact with its own treatment owed, and sending it with nothing
/// reading it would be the unread counter this ends (ISS-1192).
pub(crate) fn heartbeat_body(
    version: &str,
    commit: Option<&str>,
    conditions: &Conditions,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "agentVersion": version,
        // A session handed a `forgeToken` on `agent:start` runs under it (ISS-17), and so does
        // a follow-up handed one on `agent:send` (ISS-27); core picks only a box that says so
        // for a turn that answers a person.
        "capabilities": { "turnCredential": true, "followUpCredential": true },
    });
    if let Some(commit) = commit {
        body["agentCommit"] = serde_json::Value::String(commit.to_string());
    }
    if let Some(gate) = &conditions.gate {
        body["gate"] = gate_body(gate);
    }
    if let Some(pool) = &conditions.pool {
        body["pool"] = pool_body(pool);
    }
    body
}

/// The pool object exactly as it rides on the heartbeat body.
pub fn pool_body(pool: &[crate::daemon::pool_reads::Condition]) -> serde_json::Value {
    serde_json::json!({ "projects": pool })
}
