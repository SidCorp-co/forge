//! Device lifecycle against `forge/core`: pair + heartbeat.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub device_id: String,
    pub device_token: String,
    #[serde(default)]
    pub project_id: Option<String>,
}

pub async fn pair(
    core_url: &str,
    code: &str,
    name: &str,
    platform: &str,
    agent_version: Option<&str>,
) -> Result<PairResponse, String> {
    let body = serde_json::json!({
        "code": code,
        "name": name,
        "platform": platform,
        "agentVersion": agent_version,
    });

    let url = format!("{}/api/devices/pair", core_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("pair request: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("pair failed ({status}): {text}"));
    }

    resp.json::<PairResponse>().await.map_err(|e| format!("pair decode: {e}"))
}

pub async fn heartbeat(
    core_url: &str,
    device_token: &str,
    agent_version: Option<&str>,
) -> Result<(), String> {
    let body = serde_json::json!({ "agentVersion": agent_version });
    let url = format!("{}/api/devices/heartbeat", core_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .post(&url)
        .bearer_auth(device_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("heartbeat request: {e}"))?;

    if resp.status().as_u16() == 401 {
        return Err("UNAUTHORIZED".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("heartbeat failed: {}", resp.status()));
    }
    Ok(())
}

fn platform_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "linux"
    }
}

pub fn detected_platform() -> &'static str {
    platform_name()
}
