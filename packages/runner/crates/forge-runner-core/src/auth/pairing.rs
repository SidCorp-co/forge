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

/// Stable per-machine identity. The server dedups devices by
/// `(owner, sha256(machine_id))` and rotates the token in place, so two runners
/// sharing one machine-id collapse onto a single device row. Set
/// `FORGE_RUNNER_MACHINE_ID` (unique, non-empty) to run several instances as
/// distinct devices on one box (ISS-467); when unset, falls back to systemd's
/// `/etc/machine-id` (then D-Bus's `/var/lib/dbus/machine-id`). The server
/// hashes it before storage, so sending it raw is fine. `None` when no source
/// resolves (e.g. macOS) — the server then keeps its legacy always-insert
/// pairing behaviour.
pub fn machine_id() -> Option<String> {
    if let Ok(v) = std::env::var("FORGE_RUNNER_MACHINE_ID") {
        let v = v.trim();
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(s) = std::fs::read_to_string(path) {
            let v = s.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

// === ISS-305 — browser-approve device login (OAuth device-authorization) ===
//
// Mirrors the desktop pairing flow but mints a *device token* and (optionally)
// returns a git push credential. Endpoints: `POST /api/devices/login/init`,
// `GET /api/devices/login/poll`. The `/login/approve` step happens in the
// browser, not here. Response bodies are snake_case (unlike `/pair`).

/// `POST /api/devices/login/init` response.
#[derive(Debug, Clone, Deserialize)]
pub struct LoginInitResponse {
    pub pairing_code: String,
    /// Relative verify URL, e.g. `/pair?code=XXX-XXXX`.
    pub verify_url: String,
    pub expires_at: String,
}

/// Git push credential handed to the runner at poll time (flag-gated server-side).
#[derive(Debug, Clone, Deserialize)]
pub struct GitCredential {
    pub transport: String,
    pub host: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub instructions: Option<String>,
}

/// `GET /api/devices/login/poll` success body (HTTP 200).
#[derive(Debug, Clone, Deserialize)]
pub struct LoginApproved {
    pub device_token: String,
    pub device_id: String,
    #[serde(default)]
    pub git_credential: Option<GitCredential>,
}

/// Outcome of one poll tick.
#[derive(Debug, Clone)]
pub enum LoginPoll {
    /// 204 — not approved yet; keep polling.
    Pending,
    /// 200 — approved + consumed (single-use).
    Approved(Box<LoginApproved>),
    /// 410 — expired / already consumed / unknown.
    Gone(String),
}

/// Start a browser-approve device login. Returns the code + verify URL.
pub async fn login_init(core_url: &str, name: &str) -> Result<LoginInitResponse> {
    let mut body = serde_json::json!({
        "device_label": name,
        "device_platform": detected_platform(),
        "device_hostname": hostname::get().ok().and_then(|h| h.into_string().ok()),
    });
    if let Some(mid) = machine_id() {
        body["machine_id"] = serde_json::Value::String(mid);
    }
    let url = format!("{}/api/devices/login/init", core_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("login init request: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!(
            "login init failed ({status}): {text}"
        )));
    }
    resp.json::<LoginInitResponse>()
        .await
        .map_err(|e| Error::Other(format!("login init decode: {e}")))
}

/// Poll once for approval. Maps HTTP 204/200/410 to [`LoginPoll`].
pub async fn login_poll(core_url: &str, pairing_code: &str) -> Result<LoginPoll> {
    let url = format!(
        "{}/api/devices/login/poll?pairing_code={}",
        core_url.trim_end_matches('/'),
        urlencoding(pairing_code),
    );
    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| Error::Other(format!("login poll request: {e}")))?;
    let status = resp.status();
    if status.as_u16() == 204 {
        return Ok(LoginPoll::Pending);
    }
    if status.as_u16() == 410 {
        let text = resp.text().await.unwrap_or_default();
        return Ok(LoginPoll::Gone(text));
    }
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!(
            "login poll failed ({status}): {text}"
        )));
    }
    let approved = resp
        .json::<LoginApproved>()
        .await
        .map_err(|e| Error::Other(format!("login poll decode: {e}")))?;
    Ok(LoginPoll::Approved(Box::new(approved)))
}

/// Minimal percent-encoding for the pairing code query param (alnum + `-`).
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub async fn pair(core_url: &str, code: &str, name: &str) -> Result<PairResponse> {
    let mut body = serde_json::json!({
        "code": code,
        "name": name,
        "platform": detected_platform(),
        "agentVersion": env!("CARGO_PKG_VERSION"),
    });
    if let Some(mid) = machine_id() {
        body["machineId"] = serde_json::Value::String(mid);
    }
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
