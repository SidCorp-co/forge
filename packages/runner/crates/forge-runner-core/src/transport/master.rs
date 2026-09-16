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
pub async fn register(client: &CoreClient, project_id: &str, name: &str) -> Result<MasterSession> {
    let url = client.url("/api/devices/me/master-session");
    let body = serde_json::json!({ "projectId": project_id, "name": name });
    let resp = post(client, "master-session", &url, body).await?;
    resp.json()
        .await
        .map_err(|e| Error::Other(format!("master-session decode: {e}")))
}

/// Tell core a master this box was hosting is gone, and why.
pub async fn close(client: &CoreClient, session_id: &str, reason: &str) -> Result<()> {
    let url = client.url("/api/devices/me/master-session/close");
    let body = serde_json::json!({ "sessionId": session_id, "reason": reason });
    post(client, "master-session", &url, body).await.map(|_| ())
}

/// Tell core this box's Claude account has refused, so every runner binding of
/// the device stops being prompted into it.
///
/// A TYPED verdict and never text: core classifies nothing on this route.
// cm:guard the runner owns the classification and core owns the record, and that split is load bearing rather than tidy. A master's pane carries issue bodies, plans and comments, so a raw-text door would let anyone who can write an issue plant a refusal banner, have the master echo it, and hard-exclude this box from dispatch. `detail` is display-only for exactly that reason.
// cm:edge contract -> packages/core/src/devices/pool-routes.ts — `masterLimitSchema` is the validator these three field names answer to, and it refuses `auth` carrying a reset BY NAME (`AUTH_LIMIT_HAS_NO_RESET`), which `Refusal::new` is what keeps this side from ever sending.
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/assets/master-limit-wire.json — the body this builds from the captured `429_five_hour` record, asserted byte for byte on this side and read off disk by `packages/core/src/devices/pool-routes.test.ts` on the other. One file, two readers: a field renamed on either side stops matching it.
pub async fn report_limit(
    client: &CoreClient,
    reason: &str,
    resets_in_seconds: Option<u64>,
    detail: &str,
) -> Result<()> {
    let mut body = serde_json::json!({ "reason": reason, "detail": detail });
    // cm:guard OMITTED rather than sent as null when there is none. Core reads the field as `nullish`, so both forms parse — but an `auth` report is refused outright if the key carries a number, and building the object one way for every reason is what keeps that impossible.
    if let Some(secs) = resets_in_seconds {
        body["resetsInSeconds"] = serde_json::json!(secs);
    }
    let url = client.url("/api/devices/me/limit");
    post(client, "me/limit", &url, body).await.map(|_| ())
}

/// Lift the limit core is holding for this device: the master's own next
/// successful turn is the proof its account works again.
// cm:why a DELETE on the same path rather than a flag on the report, which is core's own shape: the two carry opposite evidence, and one door taking both is how a caller ends up clearing a limit by omitting a field.
pub async fn clear_limit(client: &CoreClient) -> Result<()> {
    let url = client.url("/api/devices/me/limit");
    let resp = client
        .http()
        .delete(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("me/limit request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("me/limit {status}: {text}")));
    }
    Ok(())
}

// cm:guard the caller names the ROUTE in `what`, because this helper now serves three of them and an error saying `master-session` over a `/me/limit` refusal sends whoever reads the log to the wrong half of the daemon.
async fn post(
    client: &CoreClient,
    what: &str,
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
        .map_err(|e| Error::Other(format!("{what} request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("{what} {status}: {text}")));
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// The request body core is actually handed by the call under test, plus a
    /// canned answer. One request, then the socket closes.
    async fn capture(status: &'static str) -> (String, tokio::sync::oneshot::Receiver<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            let body = "{}";
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
            let _ = tx.send(req);
        });
        (format!("http://{addr}"), rx)
    }

    fn client(url: String) -> CoreClient {
        CoreClient::new(url, String::from("tok"))
    }

    fn sent_body(req: &str) -> serde_json::Value {
        let body = req.split("\r\n\r\n").nth(1).unwrap_or("");
        serde_json::from_str(body).expect("the request carried a JSON body")
    }

    #[tokio::test]
    async fn a_usage_limit_is_sent_with_the_three_fields_cores_validator_takes() {
        let (url, rx) = capture("200 OK").await;
        report_limit(&client(url), "usage_limit", Some(900), "hit the window")
            .await
            .expect("core answered 200");
        let req = rx.await.unwrap();
        assert!(req.starts_with("POST /api/devices/me/limit "), "{req}");
        let body = sent_body(&req);
        let mut keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["detail", "reason", "resetsInSeconds"]);
        assert_eq!(body["reason"], "usage_limit");
        assert_eq!(body["resetsInSeconds"], 900);
    }

    // cm:guard the key is ABSENT rather than null. Core refuses an `auth` report carrying a reset by name, so a body that always wrote the field would report nothing at all for the one limit an operator has to fix by hand.
    #[tokio::test]
    async fn an_auth_report_carries_no_reset_key_at_all() {
        let (url, rx) = capture("200 OK").await;
        report_limit(&client(url), "auth", None, "Login expired")
            .await
            .unwrap();
        let body = sent_body(&rx.await.unwrap());
        assert!(body.get("resetsInSeconds").is_none(), "{body}");
    }

    #[tokio::test]
    async fn the_clear_is_a_delete_on_the_same_path() {
        let (url, rx) = capture("200 OK").await;
        clear_limit(&client(url)).await.unwrap();
        let req = rx.await.unwrap();
        assert!(req.starts_with("DELETE /api/devices/me/limit "), "{req}");
    }

    // cm:guard a refusal must come back as an Err rather than as a silent success, because the sweep memoises a refusal ONLY on the Ok — an error swallowed here would record the report as sent and the cap would never reach core.
    #[tokio::test]
    async fn a_core_that_refuses_the_report_is_an_error_the_caller_can_see() {
        let (url, _rx) = capture("500 Internal Server Error").await;
        assert!(report_limit(&client(url), "usage_limit", Some(1), "x")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn a_core_that_cannot_be_reached_is_an_error_rather_than_a_hang() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        let c = client(format!("http://{addr}"));
        assert!(report_limit(&c, "usage_limit", Some(1), "x").await.is_err());
        assert!(clear_limit(&c).await.is_err());
    }

    #[tokio::test]
    async fn the_route_names_itself_in_its_own_failure() {
        let (url, _rx) = capture("500 Internal Server Error").await;
        let e = report_limit(&client(url), "usage_limit", Some(1), "x")
            .await
            .unwrap_err()
            .to_string();
        assert!(e.contains("me/limit"), "{e}");
    }

    #[test]
    fn a_registration_reply_decodes_and_created_is_optional() {
        let v = serde_json::json!({ "sessionId": "s1", "name": "forge-master-forge-dev" });
        let m: MasterSession = serde_json::from_value(v).expect("core's reply must decode");
        assert_eq!(m.session_id, "s1");
        assert!(!m.created);
    }
}
