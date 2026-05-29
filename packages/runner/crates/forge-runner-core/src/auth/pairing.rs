//! Device pairing against core: `POST /api/devices/pair` (paste-code).

use serde::Deserialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub device_id: String,
    pub device_token: String,
    #[serde(default)]
    pub project_id: Option<String>,
}

pub fn detected_platform() -> &'static str {
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

/// Default device name: the machine hostname.
pub fn default_device_name() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "forge-runner".to_string())
}

pub async fn pair(core_url: &str, code: &str, name: &str) -> Result<PairResponse> {
    let body = serde_json::json!({
        "code": code,
        "name": name,
        "platform": detected_platform(),
        "agentVersion": env!("CARGO_PKG_VERSION"),
    });
    let url = format!("{}/api/devices/pair", core_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("pair request: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("pair failed ({status}): {text}")));
    }
    resp.json::<PairResponse>()
        .await
        .map_err(|e| Error::Other(format!("pair decode: {e}")))
}
