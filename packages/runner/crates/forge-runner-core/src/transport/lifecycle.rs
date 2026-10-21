//! Job lifecycle: `POST /api/jobs/:id/ack`, `/complete` and `/fail`.

use super::CoreClient;
use crate::error::{Error, Result};

pub async fn ack(
    client: &CoreClient,
    job_id: &str,
    skills_ran_with: Option<serde_json::Value>,
) -> Result<()> {
    let url = client.url(&format!("/api/jobs/{job_id}/ack"));
    let body = if let Some(srw) = skills_ran_with {
        serde_json::json!({ "skillsRanWith": srw })
    } else {
        serde_json::json!({})
    };
    send(client, &url, body).await
}

/// Complete a job. `exit_code` 0 = done, -1 = cancelled, else failed (core maps).
pub async fn complete(
    client: &CoreClient,
    job_id: &str,
    exit_code: i32,
    error: Option<&str>,
) -> Result<()> {
    let url = client.url(&format!("/api/jobs/{job_id}/complete"));
    let body = serde_json::json!({ "exitCode": exit_code, "error": error });
    send(client, &url, body).await
}

/// Force-fail a job with an error message.
pub async fn fail(client: &CoreClient, job_id: &str, error: &str) -> Result<()> {
    fail_with_salvage(client, job_id, error, None).await
}

pub async fn fail_with_salvage(
    client: &CoreClient,
    job_id: &str,
    error: &str,
    salvage: Option<serde_json::Value>,
) -> Result<()> {
    let url = client.url(&format!("/api/jobs/{job_id}/fail"));
    let mut body = serde_json::json!({ "error": error });
    if let Some(s) = salvage {
        body["salvage"] = s;
    }
    send(client, &url, body).await
}

/// ISS-785 — answer a `job.cancel` frame with the real outcome (`"killed"` or
/// `"not_found"`). Core's kill-before-reap gate treats `not_found` as
/// positive confirmation the job is safe to fail-and-retry (no process exists
/// to kill) — without it, every ordinary reap on an online runner would park
/// at `waiting` forever. ISS-862 made that word earn its meaning: the caller
/// asks `runner::inflight` before saying it, so an empty session map after a
/// restart no longer passes for a dead process.
pub async fn kill_ack(client: &CoreClient, job_id: &str, outcome: &str) -> Result<()> {
    let url = client.url(&format!("/api/jobs/{job_id}/kill-ack"));
    let body = serde_json::json!({ "outcome": outcome });
    send(client, &url, body).await
}

async fn send(client: &CoreClient, url: &str, body: serde_json::Value) -> Result<()> {
    let resp = client
        .http()
        .post(url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::transport::status::not_reached("lifecycle request", &e))?;
    if !resp.status().is_success() {
        return Err(Refused::read(resp).await.error);
    }
    Ok(())
}

/// A non-2xx answer from a lifecycle route: its status and body, and the error
/// it is, with a job taken away from this box marked as disowned. The one place
/// a lifecycle response body is read, so every site says it the same way.
struct Refused {
    code: u16,
    text: String,
    error: Error,
}

impl Refused {
    async fn read(resp: reqwest::Response) -> Self {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        let said = super::status::refused("lifecycle", code, &text);
        let error = if code == 403 || code == 409 {
            Error::Other(format!("{}: {said}", crate::transport::events::DISOWNED))
        } else {
            Error::Other(said)
        };
        Self { code, text, error }
    }
}

/// What core did with a blocked report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockedDoor {
    /// Core took the question and ended the job.
    Recorded,
    /// This core has no such route, so nothing was recorded and nothing ended.
    Absent,
}

/// Whether a refusal is core saying it serves no such route; a missing job
/// answers `NOT_FOUND` instead.
fn route_absent(refused: &Refused) -> bool {
    super::status::route_absent(refused.code, &refused.text)
}

/// End a job that was stopped on a question, carrying what it asked
/// (`daemon::job_asked::Asked::to_json`) so core can put it before a person.
pub async fn blocked(
    client: &CoreClient,
    job_id: &str,
    error: &str,
    asked: &serde_json::Value,
) -> Result<BlockedDoor> {
    let url = client.url(&format!("/api/jobs/{job_id}/blocked"));
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&serde_json::json!({ "error": error, "asked": asked }))
        .send()
        .await
        .map_err(|e| crate::transport::status::not_reached("lifecycle request", &e))?;
    if resp.status().is_success() {
        return Ok(BlockedDoor::Recorded);
    }
    let refused = Refused::read(resp).await;
    if route_absent(&refused) {
        return Ok(BlockedDoor::Absent);
    }
    Err(refused.error)
}

pub async fn turn_is_job_end(client: &CoreClient, job_id: &str) -> bool {
    let url = client.url(&format!("/api/jobs/{job_id}/turn-verdict"));
    let resp = match client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            tracing::warn!(
                "[job {job_id}] turn-verdict {}: finishing the job",
                r.status()
            );
            return true;
        }
        Err(e) => {
            tracing::warn!("[job {job_id}] turn-verdict: {e} — finishing the job");
            return true;
        }
    };
    match resp.json::<serde_json::Value>().await {
        Ok(v) => v
            .get("done")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        Err(e) => {
            tracing::warn!("[job {job_id}] turn-verdict body: {e} — finishing the job");
            true
        }
    }
}

/// What a test reaching an unreachable core needs: an address whose connect is refused.
#[cfg(test)]
pub(crate) mod testing {
    use std::io::ErrorKind;
    use std::time::{Duration, Instant};

    /// How long one probe waits for an answer before reading silence as one.
    const PROBE_WAITS: Duration = Duration::from_millis(500);

    /// How long a connect may keep being accepted before the test fails,
    /// naming the address and what the connect got instead.
    const UNANSWERED_WITHIN: Duration = Duration::from_secs(10);

    /// An address no listener answers, and the socket that keeps it so for as
    /// long as the caller holds it.
    ///
    /// A listener that is bound and dropped is not closed while a process
    /// forked in that moment (any sibling test's `Command::spawn`, tmux, git
    /// or sh) holds its descriptor until exec: the port stays LISTEN and a
    /// connect is accepted. So nothing here ever listens. On Linux and Windows
    /// the port stays bound, so no sibling's listener can take it. macOS
    /// answers a connect to such a socket by timing out (ISS-1316's CI), so
    /// there the port is released.
    ///
    /// The address is handed out once a probe connect is not accepted: Linux
    /// and macOS refuse it at once, while Windows retries the SYN after each
    /// reset for about two seconds before it says refused, so a probe that
    /// hears nothing within `PROBE_WAITS` is one no listener answered either.
    /// Only an accepted connect means something listens there, and it is
    /// probed again until `UNANSWERED_WITHIN`.
    pub(crate) async fn refused_addr() -> (Option<tokio::net::TcpSocket>, std::net::SocketAddr) {
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let addr = socket.local_addr().unwrap();
        let held = if cfg!(target_os = "macos") {
            drop(socket);
            None
        } else {
            Some(socket)
        };
        let deadline = Instant::now() + UNANSWERED_WITHIN;
        loop {
            let probe =
                tokio::time::timeout(PROBE_WAITS, tokio::net::TcpStream::connect(addr)).await;
            let answered = match probe {
                Ok(Err(e)) if e.kind() == ErrorKind::ConnectionRefused => return (held, addr),
                Err(_) => return (held, addr),
                Ok(Err(e)) => format!("failed with {e}"),
                Ok(Ok(_)) => String::from("was accepted"),
            };
            assert!(
                Instant::now() < deadline,
                "a connect to {addr} still {answered} {}s after nothing listened on it",
                UNANSWERED_WITHIN.as_secs()
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// One-shot HTTP server: answers the first request with `status` + `body`.
    async fn serve_once(status: &'static str, body: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf).await;
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
        });
        format!("http://{addr}")
    }

    fn client(url: String) -> CoreClient {
        CoreClient::new(url, String::from("tok"))
    }

    #[tokio::test]
    async fn a_parked_job_keeps_its_session() {
        let url = serve_once("200 OK", r#"{"done":false}"#).await;
        assert!(!turn_is_job_end(&client(url), "job-1").await);
    }

    #[tokio::test]
    async fn a_finished_job_ends() {
        let url = serve_once("200 OK", r#"{"done":true}"#).await;
        assert!(turn_is_job_end(&client(url), "job-1").await);
    }

    #[tokio::test]
    async fn a_renamed_key_finishes_the_job_rather_than_holding_the_slot() {
        let url = serve_once("200 OK", r#"{"finished":false}"#).await;
        assert!(turn_is_job_end(&client(url), "job-1").await);
    }

    #[tokio::test]
    async fn a_server_error_finishes_the_job() {
        let url = serve_once("500 Internal Server Error", r#"{"error":"boom"}"#).await;
        assert!(turn_is_job_end(&client(url), "job-1").await);
    }

    #[tokio::test]
    async fn an_unreachable_core_finishes_the_job() {
        let (_held, addr) = testing::refused_addr().await;
        assert!(turn_is_job_end(&client(format!("http://{addr}")), "job-1").await);
    }

    #[tokio::test]
    async fn a_body_that_is_not_json_finishes_the_job() {
        let url = serve_once("200 OK", "not json at all").await;
        assert!(turn_is_job_end(&client(url), "job-1").await);
    }

    #[tokio::test]
    async fn a_terminal_job_refusing_a_fail_reads_as_disowned() {
        let url = serve_once(
            "409 Conflict",
            r#"{"code":"INVALID_STATE","message":"job is not in a runnable state"}"#,
        )
        .await;
        let e = fail(&client(url), "job-1", "pane ended")
            .await
            .expect_err("a 409 must not report success");
        assert!(crate::transport::events::is_disowned(&e), "{e}");
    }

    #[tokio::test]
    async fn a_job_on_another_device_reads_as_disowned() {
        let url = serve_once("403 Forbidden", "{}").await;
        let e = fail(&client(url), "job-1", "pane ended")
            .await
            .expect_err("a 403 must not report success");
        assert!(crate::transport::events::is_disowned(&e), "{e}");
    }

    #[tokio::test]
    async fn an_ordinary_client_error_is_not_disowned() {
        let url = serve_once("400 Bad Request", "{}").await;
        let e = fail(&client(url), "job-1", "pane ended")
            .await
            .expect_err("a 400 must not report success");
        assert!(!crate::transport::events::is_disowned(&e), "{e}");
    }

    #[tokio::test]
    async fn a_core_with_no_blocked_route_is_absent_and_a_missing_job_is_not() {
        let asked = serde_json::json!({"kind":"unread","why":"x"});
        let url = serve_once(
            "404 Not Found",
            r#"{"code":"ROUTE_ABSENT","message":"No route answers POST /api/jobs/job-1/blocked."}"#,
        )
        .await;
        assert_eq!(
            blocked(&client(url), "job-1", "ended", &asked)
                .await
                .unwrap(),
            BlockedDoor::Absent
        );
        // The sentence is not the signal: a 404 under another code is a missing job, whatever it says.
        let url = serve_once(
            "404 Not Found",
            r#"{"code":"NOT_FOUND","message":"No route answers POST /api/jobs/job-1/blocked."}"#,
        )
        .await;
        blocked(&client(url), "job-1", "ended", &asked)
            .await
            .expect_err("only the code says the route is absent");
        let url = serve_once(
            "404 Not Found",
            r#"{"code":"NOT_FOUND","message":"job not found"}"#,
        )
        .await;
        let e = blocked(&client(url), "job-1", "ended", &asked)
            .await
            .expect_err("a missing job is not a missing route");
        assert!(!crate::transport::events::is_disowned(&e), "{e}");
    }

    #[tokio::test]
    async fn a_recorded_blocked_report_says_so_and_a_taken_job_is_disowned() {
        let asked = serde_json::json!({"kind":"unread","why":"x"});
        let url = serve_once("200 OK", r#"{"jobId":"job-1"}"#).await;
        assert_eq!(
            blocked(&client(url), "job-1", "ended", &asked)
                .await
                .unwrap(),
            BlockedDoor::Recorded
        );
        let url = serve_once(
            "409 Conflict",
            r#"{"code":"INVALID_STATE","message":"job is not in a runnable state"}"#,
        )
        .await;
        let e = blocked(&client(url), "job-1", "ended", &asked)
            .await
            .expect_err("a 409 must not report success");
        assert!(crate::transport::events::is_disowned(&e), "{e}");
    }
}
