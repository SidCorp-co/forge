use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tokio::sync::watch;
use std::time::Duration;

const PING_INTERVAL: Duration = Duration::from_secs(25);
const PONG_TIMEOUT: Duration = Duration::from_secs(15);

pub async fn connect_ws(app: AppHandle, url: String, device_id: Option<String>, mut cancel: watch::Receiver<bool>) {
    let mut retry_delay = 1u64;
    loop {
        // Check cancellation before each connection attempt
        if *cancel.borrow() { break; }

        match connect_async(&url).await {
            Ok((ws_stream, _)) => {
                retry_delay = 1;
                if let Err(e) = app.emit("ws:connected", ()) {
                    eprintln!("Failed to emit ws:connected: {e}");
                }
                let (mut write, mut read) = ws_stream.split();

                // Register as desktop client so Strapi routes agent commands to this device.
                // Also re-sent on every ping tick as a keepalive identity beacon, so the
                // server-side deviceClients map is restored after Strapi restarts or if
                // the initial register message was dropped by a reverse proxy.
                let register_msg = if let Some(ref did) = device_id {
                    serde_json::json!({"type": "desktop:register", "deviceId": did}).to_string()
                } else {
                    serde_json::json!({"type": "desktop:register"}).to_string()
                };
                let _ = write.send(Message::Text(register_msg.clone())).await;

                let mut ping_interval = tokio::time::interval(PING_INTERVAL);
                ping_interval.tick().await; // skip immediate first tick
                let mut awaiting_pong = false;
                let mut pong_deadline = tokio::time::Instant::now() + PONG_TIMEOUT;

                loop {
                    let timeout = if awaiting_pong {
                        tokio::time::sleep_until(pong_deadline)
                    } else {
                        // Far future — effectively disabled
                        tokio::time::sleep_until(tokio::time::Instant::now() + Duration::from_secs(86400))
                    };

                    tokio::select! {
                        msg = read.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    // Any data from server means connection is alive
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
                            // Client-side keepalive ping
                            if write.send(Message::Ping(vec![])).await.is_err() {
                                break; // connection dead
                            }
                            // Re-send desktop:register so the server restores its
                            // deviceClients entry after a restart or dropped frame.
                            if write.send(Message::Text(register_msg.clone())).await.is_err() {
                                break;
                            }
                            awaiting_pong = true;
                            pong_deadline = tokio::time::Instant::now() + PONG_TIMEOUT;
                        }
                        _ = timeout => {
                            // Pong not received in time — connection is dead
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
                if let Err(emit_err) = app.emit("ws:error", e.to_string()) {
                    eprintln!("Failed to emit ws:error: {emit_err}");
                }
            }
        }

        // Wait with jitter to avoid thundering herd
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
