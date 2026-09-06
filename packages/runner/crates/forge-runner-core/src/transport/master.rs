//! The master's own row in core: registration, liveness, and its ending.
//!
//! A master used to invent its own session id, so `jobs.held_by` pointed at
//! nothing and core had no record the process ever existed. These three calls
//! are what put it on the same rail chat and schedule already run on.

use serde::Deserialize;

use super::CoreClient;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterSession {
    pub session_id: String,
    pub name: String,
    #[serde(default)]
    pub created: bool,
}

/// Register this box's master for one project, or find the one already there.
// cm:guard idempotent on core's side, and this call must be made on EVERY sweep rather than once at startup. The row is what `jobs.held_by` carries, so a daemon that registered once and cached the id would keep claiming onto a session core had already reaped — holds nobody can see, under an identity nobody is beating for.
pub async fn register(client: &CoreClient, project_id: &str, name: &str) -> Result<MasterSession> {
    let url = client.url("/api/devices/me/master-session");
    let body = serde_json::json!({ "projectId": project_id, "name": name });
    let resp = post(client, &url, body).await?;
    resp.json()
        .await
        .map_err(|e| Error::Other(format!("master-session decode: {e}")))
}

/// Tell core a master this box was hosting is gone, and why.
// cm:guard this closes the ROW only. The holds are given back by `pool::release`, which the caller runs alongside it — see the guard on the route. Reporting the death without the release leaves claimable work parked for three minutes on a master everyone already knows is dead.
pub async fn close(client: &CoreClient, session_id: &str, reason: &str) -> Result<()> {
    let url = client.url("/api/devices/me/master-session/close");
    let body = serde_json::json!({ "sessionId": session_id, "reason": reason });
    post(client, &url, body).await.map(|_| ())
}

async fn post(
    client: &CoreClient,
    url: &str,
    body: serde_json::Value,
) -> Result<reqwest::Response> {
    let resp = client
        .http()
        .post(url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("master-session request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("master-session {status}: {text}")));
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    // cm:guard `created` must default to false rather than failing the decode. Core may stop reporting it, and a runner that could not parse the reply would re-register on every sweep against a core that was answering correctly.
    #[test]
    fn a_registration_reply_decodes_and_created_is_optional() {
        let v = serde_json::json!({ "sessionId": "s1", "name": "forge-master-forge-dev" });
        let m: MasterSession = serde_json::from_value(v).expect("core's reply must decode");
        assert_eq!(m.session_id, "s1");
        assert!(!m.created);
    }
}
