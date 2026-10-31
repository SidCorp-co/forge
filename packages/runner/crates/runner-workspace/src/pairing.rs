//! Device pairing against core: the browser-approve device login (`/api/devices/login/{init,poll}`).

use serde::Deserialize;

use runner_platform::error::{Error, Result};

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
// Mints a *device token* and (optionally) returns a git push credential. Endpoints: `POST /api/devices/login/init`,
// `GET /api/devices/login/poll`. The `/login/approve` step happens in the
// browser, not here. Response bodies are snake_case.

/// `POST /api/devices/login/init` response.
#[derive(Debug, Clone, Deserialize)]
pub struct LoginInitResponse {
    pub pairing_code: String,
    /// Relative verify URL, e.g. `/pair?code=XXX-XXXX`.
    pub verify_url: String,
    pub expires_at: String,
}

/// `GET /api/devices/login/poll` success body (HTTP 200).
#[derive(Debug, Clone, Deserialize)]
pub struct LoginApproved {
    pub device_token: String,
    pub device_id: String,
}

/// Outcome of one poll tick.
#[derive(Debug, Clone)]
pub enum LoginPoll {
    /// 204 — not approved yet; keep polling.
    Pending,
    /// 200 — approved + consumed (single-use).
    Approved(Box<LoginApproved>),
    /// 404 / 409 / 422 naming a `PAIRING_CODE_*` — unknown / already consumed / expired.
    Gone(String),
    /// 5xx / 429 / transport error — transient; caller should back off and keep polling.
    Retry(String),
}

/// Classification of a poll HTTP status code, decoupled from `LoginPoll` so it
/// can be unit-tested without a mock server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PollClass {
    Pending,
    Approved,
    /// A refusal status (404, 409, 422): `Gone` where its body names a `PAIRING_CODE_*`, else fatal.
    Refused,
    Retry,
    Fatal,
}

/// Pure classifier: 5xx/429 are transient (retry), 404/409/422 are refusals whose
/// body says whether the pairing code is the cause (a graceful stop), 204 is "not
/// yet", 2xx is success, everything else (4xx) is fatal.
fn classify_poll_status(code: u16) -> PollClass {
    match code {
        204 => PollClass::Pending,
        404 | 409 | 422 => PollClass::Refused,
        429 => PollClass::Retry,
        500..=599 => PollClass::Retry,
        200..=299 => PollClass::Approved,
        _ => PollClass::Fatal,
    }
}

/// The refusal code of a core error body (`error.code`, or the top-level `code`).
fn refusal_code(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v["error"]["code"]
        .as_str()
        .or_else(|| v["code"].as_str())
        .map(str::to_owned)
}

/// True where a poll refusal names the pairing code itself: `PAIRING_CODE_GONE` (404),
/// `PAIRING_CODE_CONSUMED` (409) or `PAIRING_CODE_EXPIRED` (422).
fn names_pairing_code(body: &str) -> bool {
    refusal_code(body).is_some_and(|c| c.starts_with("PAIRING_CODE_"))
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

/// Poll once for approval. Maps HTTP 204/200 and a `PAIRING_CODE_*` refusal to [`LoginPoll`]; 5xx/429/
/// transport errors classify as [`LoginPoll::Retry`] instead of a fatal `Err`
/// so a transient edge blip doesn't kill the whole pairing session.
pub async fn login_poll(core_url: &str, pairing_code: &str) -> Result<LoginPoll> {
    let url = format!(
        "{}/api/devices/login/poll?pairing_code={}",
        core_url.trim_end_matches('/'),
        urlencoding(pairing_code),
    );
    let resp = match reqwest::Client::new().get(&url).send().await {
        Ok(resp) => resp,
        Err(e) => return Ok(LoginPoll::Retry(format!("transport error: {e}"))),
    };
    let status = resp.status();
    match classify_poll_status(status.as_u16()) {
        PollClass::Pending => Ok(LoginPoll::Pending),
        PollClass::Refused => {
            let text = resp.text().await.unwrap_or_default();
            if names_pairing_code(&text) {
                Ok(LoginPoll::Gone(text))
            } else {
                Err(Error::Other(format!(
                    "login poll failed ({status}): {text}"
                )))
            }
        }
        PollClass::Retry => {
            let text = resp.text().await.unwrap_or_default();
            Ok(LoginPoll::Retry(format!("{status}: {text}")))
        }
        PollClass::Fatal => {
            let text = resp.text().await.unwrap_or_default();
            Err(Error::Other(format!(
                "login poll failed ({status}): {text}"
            )))
        }
        PollClass::Approved => {
            let approved = resp
                .json::<LoginApproved>()
                .await
                .map_err(|e| Error::Other(format!("login poll decode: {e}")))?;
            Ok(LoginPoll::Approved(Box::new(approved)))
        }
    }
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

#[cfg(test)]
mod poll_tests {
    use super::*;

    #[test]
    fn a_pairing_refusal_status_is_refused_not_gone() {
        for code in [404u16, 409, 422] {
            assert_eq!(classify_poll_status(code), PollClass::Refused, "{code}");
        }
        assert_eq!(classify_poll_status(410), PollClass::Fatal);
        assert_eq!(classify_poll_status(204), PollClass::Pending);
        assert_eq!(classify_poll_status(503), PollClass::Retry);
    }

    #[test]
    fn only_a_body_naming_the_pairing_code_stops_gracefully() {
        let gone = r#"{"code":"PAIRING_CODE_GONE","error":{"code":"PAIRING_CODE_GONE","message":"m","refusals":[]}}"#;
        let consumed = r#"{"error":{"code":"PAIRING_CODE_CONSUMED"}}"#;
        let expired = r#"{"code":"PAIRING_CODE_EXPIRED"}"#;
        assert!(names_pairing_code(gone));
        assert!(names_pairing_code(consumed));
        assert!(names_pairing_code(expired));
        assert!(!names_pairing_code(r#"{"error":{"code":"NOT_FOUND"}}"#));
        assert!(!names_pairing_code("<html>404</html>"));
        assert!(!names_pairing_code(""));
    }
}
