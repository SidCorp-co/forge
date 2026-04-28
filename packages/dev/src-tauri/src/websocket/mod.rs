use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;
use tokio_tungstenite::{
    connect_async, tungstenite::client::IntoClientRequest, tungstenite::http::header,
    tungstenite::Message,
};
use std::time::Duration;

const PING_INTERVAL: Duration = Duration::from_secs(25);
const PONG_TIMEOUT: Duration = Duration::from_secs(15);

/// Connect to packages/core `/ws` with optional device-token authentication and
/// automatic reconnect (1s→30s jittered backoff). On successful connect the
/// client subscribes to its `device:<id>` room so the server can route
/// dispatched-job events.
///
/// `device_token` — when present, sent as `Authorization: Bearer <token>`.
///   Server auth is a placeholder today (Phase 2.2 enforcement flip);
///   including it now is a no-op on the server but correct on the client.
/// `device_id` — used to subscribe to the `device:<id>` room.
pub async fn connect_ws(
    app: AppHandle,
    url: String,
    device_token: Option<String>,
    device_id: Option<String>,
    mut cancel: watch::Receiver<bool>,
) {
    let mut retry_delay = 1u64;
    loop {
        if *cancel.borrow() { break; }

        // Build a request so we can attach the Authorization header.
        let request = match url.as_str().into_client_request() {
            Ok(mut req) => {
                if let Some(ref tok) = device_token {
                    if let Ok(v) = format!("Bearer {tok}").parse() {
                        req.headers_mut().insert(header::AUTHORIZATION, v);
                    }
                }
                req
            }
            Err(e) => {
                let _ = app.emit("ws:error", format!("bad url: {e}"));
                break;
            }
        };

        match connect_async(request).await {
            Ok((ws_stream, _)) => {
                retry_delay = 1;
                if let Err(e) = app.emit("ws:connected", ()) {
                    eprintln!("Failed to emit ws:connected: {e}");
                }
                let (mut write, mut read) = ws_stream.split();

                // Subscribe to device room so server broadcasts route here.
                if let Some(ref did) = device_id {
                    let subscribe = serde_json::json!({
                        "type": "subscribe",
                        "room": format!("device:{did}")
                    })
                    .to_string();
                    let _ = write.send(Message::Text(subscribe)).await;
                }

                let mut ping_interval = tokio::time::interval(PING_INTERVAL);
                ping_interval.tick().await; // skip immediate first tick
                let mut awaiting_pong = false;
                let mut pong_deadline = tokio::time::Instant::now() + PONG_TIMEOUT;

                loop {
                    let timeout = if awaiting_pong {
                        tokio::time::sleep_until(pong_deadline)
                    } else {
                        tokio::time::sleep_until(tokio::time::Instant::now() + Duration::from_secs(86400))
                    };

                    tokio::select! {
                        msg = read.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    awaiting_pong = false;
                                    if let Ok(json) = serde_json::from_str::<Value>(&text) {
                                        if let Err(e) = app.emit("ws:message", json) {
                                            eprintln!("Failed to emit ws:message: {e}");
                                        }
                                    }
                                }
                                Some(Ok(Message::Ping(data))) => {
                                    awaiting_pong = false;
                                    let _ = write.send(Message::Pong(data)).await;
                                }
                                Some(Ok(Message::Pong(_))) => {
                                    awaiting_pong = false;
                                }
                                Some(Ok(Message::Close(_))) | None => break,
                                Some(Err(_)) => break,
                                _ => {}
                            }
                        }
                        _ = ping_interval.tick() => {
                            if write.send(Message::Ping(vec![])).await.is_err() {
                                break;
                            }
                            awaiting_pong = true;
                            pong_deadline = tokio::time::Instant::now() + PONG_TIMEOUT;
                        }
                        _ = timeout => {
                            eprintln!("[ws] Pong timeout — reconnecting");
                            break;
                        }
                        _ = cancel.changed() => {
                            if *cancel.borrow() { break; }
                        }
                    }
                }

                if *cancel.borrow() { break; }

                if let Err(e) = app.emit("ws:disconnected", ()) {
                    eprintln!("Failed to emit ws:disconnected: {e}");
                }
            }
            Err(e) => {
                // 401 during handshake means the device token is invalid or revoked.
                // Surface as ws:auth-failed so the UI can direct the user to re-pair
                // rather than busy-looping reconnects.
                let msg = e.to_string();
                if msg.contains("401") {
                    let _ = app.emit("ws:auth-failed", msg.clone());
                    break;
                }
                if let Err(emit_err) = app.emit("ws:error", msg) {
                    eprintln!("Failed to emit ws:error: {emit_err}");
                }
            }
        }

        // Jittered backoff 1s → 30s.
        let jitter_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_millis() as u64 % 1000;
        let sleep_ms = retry_delay * 1000 + jitter_ms;
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)) => {}
            _ = cancel.changed() => {
                if *cancel.borrow() { break; }
            }
        }
        retry_delay = (retry_delay * 2).min(30);
    }
}
