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

pub async fn register(
    client: &CoreClient,
    project_id: &str,
    name: &str,
    max_job_panes: u32,
) -> Result<MasterSession> {
    register_within(client, project_id, name, max_job_panes, CALL_DEADLINE).await
}

/// [`register`], with the deadline a test can shorten.
pub async fn register_within(
    client: &CoreClient,
    project_id: &str,
    name: &str,
    max_job_panes: u32,
    deadline: Duration,
) -> Result<MasterSession> {
    let url = client.url("/api/devices/me/master-session");
    let body = serde_json::json!({
        "projectId": project_id,
        "name": name,
        "maxJobPanes": max_job_panes,
    });
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PassError {
    Refused { code: String, detail: String },
    Unreached(String),
}

impl std::fmt::Display for PassError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused { code, detail } => write!(f, "{code}: {detail}"),
            Self::Unreached(said) => f.write_str(said),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct PassReply {
    pass: PassRow,
}

#[derive(Debug, Clone, Deserialize)]
struct PassRow {
    id: String,
}

pub async fn open_pass(
    client: &CoreClient,
    session_id: &str,
    verb: &str,
    issue_key: Option<&str>,
) -> std::result::Result<String, PassError> {
    let body = serde_json::json!({
        "op": "open",
        "sessionId": session_id,
        "verb": verb,
        "issueKey": issue_key,
    });
    pass_call(client, body).await
}

pub async fn close_pass(
    client: &CoreClient,
    session_id: &str,
    pass_id: &str,
    dispatched: &[String],
) -> std::result::Result<String, PassError> {
    let body = serde_json::json!({
        "op": "close",
        "sessionId": session_id,
        "passId": pass_id,
        "dispatched": dispatched,
        "skipped": [],
        "parked": [],
    });
    pass_call(client, body).await
}

async fn pass_call(
    client: &CoreClient,
    body: serde_json::Value,
) -> std::result::Result<String, PassError> {
    const WHAT: &str = "master-session/pass";
    let resp = client
        .http()
        .post(client.url("/api/devices/me/master-session/pass"))
        .bearer_auth(client.device_token())
        .json(&body)
        .timeout(CALL_DEADLINE)
        .send()
        .await
        .map_err(|e| {
            PassError::Unreached(format!(
                "{WHAT} request: {}",
                status::unanswered(&e, CALL_DEADLINE)
            ))
        })?;
    let code = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if (200..300).contains(&code) {
        return serde_json::from_str::<PassReply>(&text)
            .map(|r| r.pass.id)
            .map_err(|e| PassError::Unreached(format!("{WHAT} decode: {e}")));
    }
    Err(pass_refusal(code, &text)
        .unwrap_or_else(|| PassError::Unreached(status::refused(WHAT, code, &text))))
}

pub(crate) fn pass_refusal(status: u16, text: &str) -> Option<PassError> {
    if !(400..500).contains(&status) || matches!(status, 401 | 408 | 429) {
        return None;
    }
    let body: serde_json::Value = serde_json::from_str(text).ok()?;
    let error = body.get("error").unwrap_or(&body);
    let code = error.get("code")?.as_str()?.to_string();
    let detail = error
        .get("refusals")
        .and_then(|r| r.get(0))
        .and_then(|r| r.get("detail"))
        .or_else(|| error.get("message"))
        .and_then(|d| d.as_str())
        .unwrap_or_default()
        .to_string();
    Some(PassError::Refused { code, detail })
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

    /// An address whose connection is refused for as long as the first value
    /// is held.
    ///
    /// Linux and Windows refuse a connection to a socket that is bound and not
    /// listening, and keep the port from being handed to anything else while
    /// it stays bound. A port released instead can be taken by a sibling
    /// test's listener before the call reaches it, and that listener answers
    /// with a reset, not a refusal (seen once on ISS-1316's run). macOS drops
    /// a connection to a bound socket that is not listening, so the call
    /// times out after 15s rather than being refused (seen on ISS-1316's CI).
    /// There the port is released, as before, and the race stays open.
    fn refusing_addr() -> (Option<tokio::net::TcpSocket>, std::net::SocketAddr) {
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let addr = socket.local_addr().unwrap();
        if cfg!(not(target_os = "macos")) {
            (Some(socket), addr)
        } else {
            drop(socket);
            (None, addr)
        }
    }

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
        let (_held, addr) = refusing_addr();
        let c = client(format!("http://{addr}"));
        // A refusal, by name: an error any listener could also produce (a
        // sibling test's, holding a port released on macOS) is not this one.
        let reported = report_limit(&c, "usage_limit", Some(1), "x")
            .await
            .unwrap_err()
            .to_string();
        assert!(
            reported.starts_with("me/limit request: could not connect"),
            "{reported}"
        );
        let cleared = clear_limit(&c).await.unwrap_err().to_string();
        assert!(
            cleared.starts_with("me/limit request: could not connect"),
            "{cleared}"
        );
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
        let said = register(&client(url), "p1", "forge-master-pixelight", 2)
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
            let said = register(&client(url), "p1", "m", 2)
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
        let said = register(&client(url), "p1", "m", 2)
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
            register_within(&client(url), "p1", "m", 2, deadline),
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
        let (_held, addr) = refusing_addr();
        let said = register(&client(format!("http://{addr}")), "p1", "m", 2)
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

    async fn answering(
        status: &'static str,
        body: &'static str,
    ) -> (String, tokio::sync::oneshot::Receiver<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
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

    const OPENED: &str = r#"{"pass":{"id":"7c1d2e3f-0000-4000-8000-000000000001","sessionId":"s1","verb":"dispatch","startedAt":"2026-10-04T08:00:00.000Z","issueKey":null}}"#;
    const ALREADY_OPEN: &str = r#"{"error":{"code":"MASTER_PASS_ALREADY_OPEN","message":"refused, nothing written: MASTER_PASS_ALREADY_OPEN at /op","refusals":[{"code":"MASTER_PASS_ALREADY_OPEN","path":"/op","detail":"this master already has the dispatch pass started 2026-10-04T08:22:15.048Z on ISS-1 open, id c9d772dd-fae2-43c0-b9d6-65f367e9127d; close it before opening the next"}]}}"#;
    const NOT_OPEN: &str = r#"{"error":{"code":"MASTER_PASS_NOT_OPEN","message":"refused, nothing written: MASTER_PASS_NOT_OPEN at /passId","refusals":[{"code":"MASTER_PASS_NOT_OPEN","path":"/passId","detail":"the dispatch pass started 2026-10-04T08:22:15.048Z ended 2026-10-04T08:22:16.996Z, and a closed pass is final, so this close changed nothing."}]}}"#;

    #[tokio::test]
    async fn a_registration_declares_the_slots_from_the_runner_config() {
        let (url, rx) = answering("200 OK", r#"{"sessionId":"s1","name":"m"}"#).await;
        register(&client(url), "p1", "forge-master-forge", 3)
            .await
            .expect("core answered 200");
        let req = rx.await.unwrap();
        assert!(
            req.starts_with("POST /api/devices/me/master-session "),
            "{req}"
        );
        let body = sent_body(&req);
        assert_eq!(body["maxJobPanes"], 3, "{body}");
        assert_eq!(body["projectId"], "p1", "{body}");
    }

    #[tokio::test]
    async fn an_open_names_the_session_the_verb_and_the_issue_and_answers_the_pass_id() {
        let (url, rx) = answering("201 Created", OPENED).await;
        let id = open_pass(&client(url), "s1", "dispatch", Some("ISS-7"))
            .await
            .expect("core answered 201");
        assert_eq!(id, "7c1d2e3f-0000-4000-8000-000000000001");
        let req = rx.await.unwrap();
        assert!(
            req.starts_with("POST /api/devices/me/master-session/pass "),
            "{req}"
        );
        let body = sent_body(&req);
        assert_eq!(body["op"], "open");
        assert_eq!(body["sessionId"], "s1");
        assert_eq!(body["verb"], "dispatch");
        assert_eq!(body["issueKey"], "ISS-7");
    }

    #[tokio::test]
    async fn a_close_names_the_pass_its_open_answered_so_a_replay_never_closes_the_next() {
        let (url, rx) = answering("200 OK", OPENED).await;
        close_pass(
            &client(url),
            "s1",
            "7c1d2e3f-0000-4000-8000-000000000001",
            &["ISS-7".to_string()],
        )
        .await
        .expect("core answered 200");
        let body = sent_body(&rx.await.unwrap());
        assert_eq!(body["op"], "close");
        assert_eq!(
            body["passId"], "7c1d2e3f-0000-4000-8000-000000000001",
            "a close that names no pass would close whichever pass is open when it lands: {body}"
        );
        assert_eq!(body["dispatched"], serde_json::json!(["ISS-7"]));
        assert_eq!(body["skipped"], serde_json::json!([]));
        assert_eq!(body["parked"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn each_pass_refusal_comes_back_by_its_code_and_core_s_own_detail() {
        let (url, _rx) = answering("422 Unprocessable Entity", ALREADY_OPEN).await;
        match open_pass(&client(url), "s1", "dispatch", None).await {
            Err(PassError::Refused { code, detail }) => {
                assert_eq!(code, "MASTER_PASS_ALREADY_OPEN");
                assert!(
                    detail.contains("c9d772dd-fae2-43c0-b9d6-65f367e9127d"),
                    "{detail}"
                );
            }
            other => panic!("expected the refusal by name, got {other:?}"),
        }
        let (url, _rx) = answering("422 Unprocessable Entity", NOT_OPEN).await;
        match close_pass(&client(url), "s1", "p1", &[]).await {
            Err(PassError::Refused { code, detail }) => {
                assert_eq!(code, "MASTER_PASS_NOT_OPEN");
                assert!(detail.contains("changed nothing"), "{detail}");
            }
            other => panic!("expected the refusal by name, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_gateway_or_an_unreachable_core_is_not_a_refusal_so_the_close_is_kept_for_retry() {
        let (url, _rx) = answering("503 Service Unavailable", "no available server").await;
        assert!(matches!(
            close_pass(&client(url), "s1", "p1", &[]).await,
            Err(PassError::Unreached(_))
        ));
        let (_held, addr) = refusing_addr();
        assert!(matches!(
            close_pass(&client(format!("http://{addr}")), "s1", "p1", &[]).await,
            Err(PassError::Unreached(_))
        ));
        assert_eq!(
            pass_refusal(
                404,
                r#"{"code":"NOT_FOUND","message":"master session s1 not found on this device"}"#
            ),
            Some(PassError::Refused {
                code: "NOT_FOUND".into(),
                detail: "master session s1 not found on this device".into()
            })
        );
        assert_eq!(pass_refusal(429, r#"{"code":"RATE_LIMITED"}"#), None);
    }
}
