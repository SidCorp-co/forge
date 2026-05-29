//! Device heartbeat: `POST /api/devices/heartbeat` (~every 30s).

use super::CoreClient;
use crate::error::{Error, Result};

pub const INTERVAL_SECS: u64 = 30;

pub async fn beat(client: &CoreClient) -> Result<()> {
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
    Ok(())
}
