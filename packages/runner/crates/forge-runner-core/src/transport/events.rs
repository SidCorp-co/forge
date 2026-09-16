//! Batch POST of job events to `POST /api/jobs/:id/events`.

use serde::Serialize;

use super::CoreClient;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize)]
pub struct JobEventInput {
    pub kind: String,
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<String>,
}

impl JobEventInput {
    pub fn new(kind: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            kind: kind.into(),
            data,
            ts: None,
        }
    }
}

#[derive(Serialize)]
struct Batch<'a> {
    events: &'a [JobEventInput],
}

const MAX_BATCH: usize = 100;
const MAX_ATTEMPTS: u32 = 4;

/// Marks the two answers that mean "this job is not yours any more".
pub const DISOWNED: &str = "JOB_DISOWNED";

/// True when core has answered that this runner no longer owns the job.
pub fn is_disowned(e: &Error) -> bool {
    e.to_string().contains(DISOWNED)
}

/// Post events for a job, chunked to <=100 per request with exponential-backoff
/// retry on 5xx / transport errors.
pub async fn post_job_events(
    client: &CoreClient,
    job_id: &str,
    events: &[JobEventInput],
) -> Result<usize> {
    let mut accepted = 0usize;
    for chunk in events.chunks(MAX_BATCH) {
        accepted += post_batch(client, job_id, chunk).await?;
    }
    Ok(accepted)
}

async fn post_batch(client: &CoreClient, job_id: &str, events: &[JobEventInput]) -> Result<usize> {
    let url = client.url(&format!("/api/jobs/{job_id}/events"));
    let body = Batch { events };

    let mut delay_ms: u64 = 1000;
    for attempt in 1..=MAX_ATTEMPTS {
        let resp = client
            .http()
            .post(&url)
            .bearer_auth(client.device_token())
            .json(&body)
            .send()
            .await;

        match resp {
            Ok(r) => {
                let status = r.status();
                if status.is_success() {
                    return Ok(events.len());
                }
                if status.as_u16() == 409 || status.as_u16() == 403 {
                    return Err(Error::Other(format!("{DISOWNED}: {status}")));
                }
                if status.is_client_error() {
                    return Err(Error::Other(format!("events client error: {status}")));
                }
                if attempt == MAX_ATTEMPTS {
                    return Err(Error::Other(format!(
                        "post_job_events failed after {attempt} attempts: {status}"
                    )));
                }
            }
            Err(e) => {
                if attempt == MAX_ATTEMPTS {
                    return Err(Error::Other(format!("post_job_events transport: {e}")));
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        delay_ms = delay_ms.saturating_mul(2);
    }
    Err(Error::Other("post_job_events: exhausted retries".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Answers every request with `status`, so a caller that retries keeps
    /// getting the same answer rather than falling through to a fresh one.
    async fn always(status: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let body = "{}";
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        format!("http://{addr}")
    }

    fn one() -> Vec<JobEventInput> {
        vec![JobEventInput::new("progress", serde_json::json!({}))]
    }

    async fn post_err(status: &'static str) -> Error {
        let url = always(status).await;
        let client = CoreClient::new(url, String::from("tok"));
        post_job_events(&client, "job-1", &one())
            .await
            .expect_err("a non-2xx must not report success")
    }

    #[tokio::test]
    async fn a_forbidden_job_is_disowned() {
        assert!(is_disowned(&post_err("403 Forbidden").await));
    }

    #[tokio::test]
    async fn a_conflicting_job_is_disowned() {
        assert!(is_disowned(&post_err("409 Conflict").await));
    }

    #[tokio::test]
    async fn an_ordinary_client_error_is_not_disowned() {
        let e = post_err("400 Bad Request").await;
        assert!(!is_disowned(&e), "{e}");
    }
}
