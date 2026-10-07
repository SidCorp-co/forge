//! The frame handling `checkout.head.read` and `checkout.ancestry.read` share.
//!
//! Core asks, this box reads and answers under the request's id: the decode, the answer to a frame
//! this build cannot decode, the refusal body, and the post. What each channel reads and the shape
//! of its success body stay in `head_read` and `ancestry_read`.

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use runner_platform::git::strip_userinfo;
use runner_transport::{checkout_ancestry, checkout_head, CoreClient};

#[derive(Debug, Clone, Copy)]
pub(crate) enum Channel {
    Head,
    Ancestry,
}

impl Channel {
    /// The log prefix.
    fn tag(self) -> &'static str {
        match self {
            Self::Head => "head",
            Self::Ancestry => "ancestry",
        }
    }

    /// The frame's name on the wire.
    fn frame(self) -> &'static str {
        match self {
            Self::Head => "checkout.head.read",
            Self::Ancestry => "checkout.ancestry.read",
        }
    }

    async fn send(
        self,
        client: &CoreClient,
        request_id: &str,
        body: &Value,
    ) -> runner_platform::error::Result<()> {
        match self {
            Self::Head => checkout_head::answer(client, request_id, body).await,
            Self::Ancestry => checkout_ancestry::answer(client, request_id, body).await,
        }
    }
}

/// What every read frame carries: the id its answer is filed under, the project, and the runner
/// row core chose (logged, so a refusal names the row it was asked through).
pub(crate) trait Frame: DeserializeOwned {
    fn request_id(&self) -> &str;
    fn project_id(&self) -> &str;
    fn runner_id(&self) -> Option<&str>;
}

/// Decode `data`, read it with `answer` (the success body, or why it could not be read), and post
/// the result under the frame's request id.
pub(crate) async fn serve<F: Frame>(
    client: &CoreClient,
    channel: Channel,
    data: Value,
    answer: impl AsyncFnOnce(&F) -> Result<Value, String>,
) {
    let frame: F = match serde_json::from_value(data.clone()) {
        Ok(f) => f,
        Err(e) => return answer_undecodable(client, channel, &data, &e).await,
    };
    let body = match answer(&frame).await {
        Ok(body) => body,
        Err(error) => {
            let error = strip_userinfo(&error);
            tracing::warn!(
                "[{}] project={} runner={}: {error}",
                channel.tag(),
                frame.project_id(),
                frame.runner_id().unwrap_or("-")
            );
            json!({ "projectId": frame.project_id(), "error": error })
        }
    };
    post(
        client,
        channel,
        frame.request_id(),
        frame.project_id(),
        &body,
    )
    .await;
}

async fn post(
    client: &CoreClient,
    channel: Channel,
    request_id: &str,
    project_id: &str,
    body: &Value,
) {
    if let Err(e) = channel.send(client, request_id, body).await {
        tracing::warn!(
            "[{}] project={project_id}: the answer did not reach core: {e}",
            channel.tag()
        );
    }
}

/// A frame this build cannot read is answered, naming what failed to decode, so core settles it
/// with that and not with its wait's "this runner is older than core". Only a frame without the
/// `requestId` and `projectId` an answer is filed under goes unanswered, and that is said here.
async fn answer_undecodable(
    client: &CoreClient,
    channel: Channel,
    data: &Value,
    e: &serde_json::Error,
) {
    let field = |name: &str| data.get(name).and_then(Value::as_str).map(str::to_string);
    let (Some(request_id), Some(project_id)) = (field("requestId"), field("projectId")) else {
        tracing::warn!(
            "[{}] undecodable {} with no requestId and projectId to answer it under, so core waits it out: {e}",
            channel.tag(),
            channel.frame()
        );
        return;
    };
    let error = format!(
        "the {} frame could not be decoded by forge-runner {}: {e} — this core sends a frame this runner does not read",
        channel.frame(),
        runner_update::CURRENT_VERSION
    );
    tracing::warn!("[{}] project={project_id}: {error}", channel.tag());
    post(
        client,
        channel,
        &request_id,
        &project_id,
        &json!({ "projectId": project_id, "error": error }),
    )
    .await;
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A fake core taking every POST, recording path and body.
    pub(crate) async fn fake_core() -> (
        CoreClient,
        std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let len = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if body.len() >= len {
                            let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                            log.lock().unwrap().push((path, body.to_string()));
                            break;
                        }
                    }
                }
                let reply = "{\"settled\":true}";
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    reply.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(reply.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (CoreClient::new(format!("http://{addr}"), "token"), seen)
    }

    /// Both read frames answer an undecodable request under their own path with their own wording.
    /// This pins the wire shape both handlers had before they shared one frame helper.
    #[tokio::test]
    async fn an_undecodable_frame_is_answered_on_each_channels_own_path() {
        let (client, seen) = fake_core().await;
        crate::head_read::handle(
            &client,
            json!({ "requestId": "r-1", "projectId": "p-1", "branch": null }),
        )
        .await;
        crate::ancestry_read::handle(
            &client,
            json!({ "requestId": "r-2", "projectId": "p-2", "pairs": 3 }),
        )
        .await;
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert_eq!(seen[0].0, "/api/devices/me/checkout-heads/r-1");
        assert_eq!(seen[1].0, "/api/devices/me/checkout-ancestry/r-2");
        for (i, (frame, project)) in [
            ("checkout.head.read", "p-1"),
            ("checkout.ancestry.read", "p-2"),
        ]
        .into_iter()
        .enumerate()
        {
            let body: Value = serde_json::from_str(&seen[i].1).unwrap();
            assert_eq!(body.as_object().unwrap().len(), 2, "{body}");
            assert_eq!(body["projectId"], project);
            let error = body["error"].as_str().unwrap();
            if frame == "checkout.head.read" {
                assert!(error.contains("string"), "names the field type: {error}");
            }
            assert!(
                error.starts_with(&format!(
                    "the {frame} frame could not be decoded by forge-runner {}: ",
                    runner_update::CURRENT_VERSION
                )) && error.ends_with(" — this core sends a frame this runner does not read"),
                "{error}"
            );
        }
    }

    #[tokio::test]
    async fn a_frame_with_nothing_to_answer_under_posts_nothing() {
        let (client, seen) = fake_core().await;
        crate::head_read::handle(&client, json!({ "projectId": "p-1" })).await;
        crate::ancestry_read::handle(&client, json!({ "requestId": "r-1" })).await;
        assert!(seen.lock().unwrap().is_empty());
    }
}
