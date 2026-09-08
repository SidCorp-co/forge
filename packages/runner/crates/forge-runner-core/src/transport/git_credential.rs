//! Ask core for a git credential — `POST /api/devices/me/git-credential`.
//!
//! One ask per git invocation. Nothing is cached here on purpose: a GitHub App
//! installation token lives an hour and a job can outlive it, so the only
//! stable place to hold one is core's own mint cache, behind the device token.
//!
//! Core's refusals are the useful half of this call (no binding, App not
//! installed, connection gone), so a non-2xx carries its message through to the
//! caller verbatim rather than being flattened into a status code.

use super::CoreClient;
use crate::error::{Error, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCredentialGrant {
    pub username: String,
    pub password: String,
    /// RFC3339 instant the token stops working. `None` on a core that predates
    /// the field.
    #[serde(default)]
    pub expires_at: Option<String>,
}

pub async fn ask(client: &CoreClient, host: &str, path: &str) -> Result<GitCredentialGrant> {
    let url = client.url("/api/devices/me/git-credential");
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&serde_json::json!({ "protocol": "https", "host": host, "path": path }))
        .send()
        .await
        .map_err(|e| Error::Other(format!("git-credential request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .or_else(|| v.get("error"))
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
            })
            .unwrap_or(text);
        return Err(Error::Other(format!("core refused ({status}): {message}")));
    }
    resp.json::<GitCredentialGrant>()
        .await
        .map_err(|e| Error::Other(format!("git-credential decode: {e}")))
}
