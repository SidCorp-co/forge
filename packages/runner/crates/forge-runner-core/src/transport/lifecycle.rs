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
        .map_err(|e| Error::Other(format!("lifecycle request: {e}")))?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        let said = super::status::refused("lifecycle", code, &text);
        if code == 403 || code == 409 {
            return Err(Error::Other(format!(
                "{}: {said}",
                crate::transport::events::DISOWNED
            )));
        }
        return Err(Error::Other(said));
    }
    Ok(())
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
        // Bind then drop, so the port is closed and the connect refuses.
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
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
}
