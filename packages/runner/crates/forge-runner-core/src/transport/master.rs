//! The master's own row in core: registration, liveness, and its ending.
//!
//! A master used to invent its own session id, so `jobs.held_by` pointed at
//! nothing and core had no record the process ever existed. These three calls
//! are what put it on the same rail chat and schedule already run on.

use std::time::Duration;

use serde::Deserialize;

use super::{status, CoreClient, CALL_DEADLINE};
use crate::error::{Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterSession {
    pub session_id: String,
    pub name: String,
    #[serde(default)]
    pub created: bool,
}

pub async fn register(client: &CoreClient, project_id: &str, name: &str) -> Result<MasterSession> {
    register_within(client, project_id, name, CALL_DEADLINE).await
}

/// [`register`], with the deadline a test can shorten.
pub async fn register_within(
    client: &CoreClient,
    project_id: &str,
    name: &str,
    deadline: Duration,
) -> Result<MasterSession> {
    let url = client.url("/api/devices/me/master-session");
    let body = serde_json::json!({ "projectId": project_id, "name": name });
    let resp = post(client, "master-session", &url, body, deadline).await?;
    resp.json()
        .await
        .map_err(|e| Error::Other(format!("master-session decode: {e}")))
}

pub async fn close(client: &CoreClient, session_id: &str, reason: &str) -> Result<()> {
    let url = client.url("/api/devices/me/master-session/close");
    let body = serde_json::json!({ "sessionId": session_id, "reason": reason });
    post(client, "master-session", &url, body, CALL_DEADLINE)
        .await
        .map(|_| ())
}

pub async fn report_limit(
    client: &CoreClient,
    reason: &str,
    resets_in_seconds: Option<u64>,
    detail: &str,
) -> Result<()> {
    let mut body = serde_json::json!({ "reason": reason, "detail": detail });
    if let Some(secs) = resets_in_seconds {
        body["resetsInSeconds"] = serde_json::json!(secs);
    }
    let url = client.url("/api/devices/me/limit");
    post(client, "me/limit", &url, body, CALL_DEADLINE)
        .await
        .map(|_| ())
}

pub async fn clear_limit(client: &CoreClient) -> Result<()> {
    let url = client.url("/api/devices/me/limit");
    let resp = client
        .http()
        .delete(&url)
        .bearer_auth(client.device_token())
        .timeout(CALL_DEADLINE)
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "me/limit request: {}",
                status::unanswered(&e, CALL_DEADLINE)
            ))
        })?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(status::refused("me/limit", code, &text)));
    }
    Ok(())
}

/// One call to core, said the way a refusal has to read.
///
/// What comes back here is the `{e}` in the master sweep's warning AND the
/// `detail` of `Unplaced::RegisterFailed`, which is the reason an operator gets
/// from `forge-runner master status` when a project has no pane. It used to be
/// `reqwest::StatusCode`'s `Display` plus the body verbatim, so a gateway's 520
/// read as `<unknown status code>` and its whole HTML page was printed twice
/// (ISS-1233). Both halves are [`status`]'s to say now.
async fn post(
    client: &CoreClient,
    what: &str,
    url: &str,
    body: serde_json::Value,
    deadline: Duration,
) -> Result<reqwest::Response> {
    let resp = client
        .http()
        .post(url)
        .bearer_auth(client.device_token())
        .json(&body)
        .timeout(deadline)
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "{what} request: {}",
                status::unanswered(&e, deadline)
            ))
        })?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(status::refused(what, code, &text)));
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

    /// The page a gateway in front of core answers a refused registration with,
    /// as ISS-1235's judge drove it against a stub on 2026-09-26.
    const GATEWAY_PAGE: &str = "<!DOCTYPE html>\n<html lang=\"en-US\">\n<head>\n<title>forge-beta-api.sidcorp.co | 520: Web server is returning an unknown error</title>\n<meta charset=\"UTF-8\" />\n</head>\n<body>\n<h1>Web server is returning an unknown error</h1>\n<p>Error code 520</p>\n</body>\n</html>";

    /// A core answering one status with one body of the caller's choosing.
    async fn refusing(status: &'static str, body: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let _ = sock.read(&mut buf).await;
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
        });
        format!("http://{addr}")
    }

    /// A core that completes the connection and then says nothing at all — the
    /// peer `CoreClient` had no deadline against.
    async fn silent() -> (String, tokio::sync::oneshot::Sender<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, hold) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let accepted = listener.accept().await;
            let _ = hold.await;
            drop(accepted);
        });
        (format!("http://{addr}"), stop)
    }

    /// Criteria 1 and 2. The two halves of the line this issue was opened for:
    /// the code said by what it means, and the gateway's page said by its title
    /// rather than pasted into the warning and the master-status reason both.
    #[tokio::test]
    async fn a_gateway_refusing_the_registration_is_named_and_its_page_is_not_pasted() {
        let url = refusing("520 ", GATEWAY_PAGE).await;
        let said = register(&client(url), "p1", "forge-master-pixelight")
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(
            said,
            "master-session 520 (gateway: the origin returned an unknown error): an HTML page titled \"forge-beta-api.sidcorp.co | 520: Web server is returning an unknown error\""
        );
        assert!(!said.contains('<'), "no markup reaches an operator: {said}");
        assert!(
            !said.contains("unknown status code"),
            "the code is named, not disowned: {said}"
        );
    }

    /// The other two codes this box measured in one afternoon read as their own
    /// faults rather than as one phrase — a timed-out origin and a failed TLS
    /// handshake are not the same thing to whoever is debugging.
    #[tokio::test]
    async fn the_other_gateway_codes_measured_here_each_say_what_they_mean() {
        for (status, meaning) in [
            ("522 ", "the connection to the origin timed out"),
            ("525 ", "the TLS handshake with the origin failed"),
        ] {
            let url = refusing(status, "error code").await;
            let said = register(&client(url), "p1", "m")
                .await
                .unwrap_err()
                .to_string();
            assert!(said.contains(meaning), "{status} said: {said}");
        }
    }

    /// Criterion 3. Folding a page is not discarding a body: a core that
    /// answers a sentence still has the sentence carried.
    #[tokio::test]
    async fn a_plain_bodied_refusal_still_carries_what_core_said() {
        let url = refusing("503 Service Unavailable", "no available server").await;
        let said = register(&client(url), "p1", "m")
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(
            said,
            "master-session 503 Service Unavailable: no available server"
        );
    }

    /// Criteria 7 and 9. The registration is the one call in the sweep whose
    /// failure outlives the retry, and it had no deadline: a peer that accepted
    /// and never answered held the sweep for as long as the socket stayed open.
    #[tokio::test]
    async fn a_core_that_accepts_and_never_answers_ends_the_registration_at_the_deadline() {
        let (url, _stop) = silent().await;
        let deadline = Duration::from_millis(150);
        let said = tokio::time::timeout(
            Duration::from_secs(5),
            register_within(&client(url), "p1", "m", deadline),
        )
        .await
        .expect("the call returns rather than hanging")
        .unwrap_err()
        .to_string();
        assert_eq!(said, "master-session request: timed out after 150ms");
    }

    #[test]
    fn the_deadline_this_call_carries_is_under_the_heartbeats_own_interval() {
        assert_eq!(CALL_DEADLINE, Duration::from_secs(15));
        assert!(CALL_DEADLINE < Duration::from_secs(30));
    }

    /// Criterion 10. A call that reached no status is named by what went wrong
    /// and by the innermost cause, and carries no url: reqwest's own `Display`
    /// prints the whole address for a refused connection, a reset and a dead
    /// network alike.
    #[tokio::test]
    async fn a_core_that_cannot_be_reached_names_the_cause_and_not_the_address() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        let said = register(&client(format!("http://{addr}")), "p1", "m")
            .await
            .unwrap_err()
            .to_string();
        assert!(
            said.starts_with("master-session request: could not connect"),
            "{said}"
        );
        assert!(!said.contains(&addr.to_string()), "{said}");
        assert!(!said.contains("http"), "{said}");
    }
}
