//! Device heartbeat: `POST /api/devices/heartbeat` (~every 30s).

use super::CoreClient;
use crate::error::{Error, Result};
use serde::Deserialize;

pub const INTERVAL_SECS: u64 = 30;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
    #[serde(default)]
    server_time: Option<String>,
}

pub async fn beat(client: &CoreClient) -> Result<()> {
    beat_verbose(client).await.map(|_| ())
}

/// Like [`beat`] but returns the core's `serverTime` so callers (e.g. `doctor`)
/// can prove core reachability with a concrete value. `401` maps to a clear
/// `UNAUTHORIZED` error so callers can prompt a re-login.
pub async fn beat_verbose(client: &CoreClient) -> Result<String> {
    let url = client.url("/api/devices/heartbeat");
    let body = serde_json::json!({ "agentVersion": env!("CARGO_PKG_VERSION") });
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("heartbeat request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Other("UNAUTHORIZED".into()));
    }
    if !resp.status().is_success() {
        return Err(Error::Other(format!("heartbeat failed: {}", resp.status())));
    }
    let parsed = resp
        .json::<HeartbeatResponse>()
        .await
        .map_err(|e| Error::Other(format!("heartbeat decode: {e}")))?;
    Ok(parsed.server_time.unwrap_or_default())
}
