//! WebSocket client to core `/ws`.
//!
//! Connects with `Authorization: Bearer <deviceToken>`, subscribes to the
//! `device:<id>` room, optionally sends `runner:register` per project, then
//! forwards every text frame (parsed to [`Frame`]) on `frame_tx`.
//! Auto-reconnects with 1s→30s jittered backoff and a 25s ping / 15s pong
//! liveness check. Stops when `cancel` flips to `true`.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::header, Message},
};

use super::frames::Frame;

const PING_INTERVAL: Duration = Duration::from_secs(25);
const PONG_TIMEOUT: Duration = Duration::from_secs(15);

/// A `runner:register` payload sent on connect (one per bound project).
#[derive(Clone)]
pub struct RunnerRegistration {
    pub project_id: String,
    pub name: String,
    pub runner_type: String,
}

pub struct WsConfig {
    pub url: String,
    pub device_token: String,
    pub device_id: String,
    pub registrations: Vec<RunnerRegistration>,
    pub register_enabled: bool,
}

pub async fn connect(
    cfg: WsConfig,
    frame_tx: mpsc::Sender<Frame>,
    mut cancel: watch::Receiver<bool>,
) {
    let mut retry_delay = 1u64;
    loop {
        if *cancel.borrow() {
            break;
        }

        // Reload the device token on every connect attempt so a fresh
        // `forge-runner login` (which rewrites the cred store) is picked up by
        // the RUNNING daemon without a restart — this is what lets the 401 path
        // below self-heal. Fall back to the token captured at startup if the
        // store read is empty/errors (ISS-467).
        let token = match crate::auth::cred_store::load_device_token() {
            Ok(Some(t)) => t,
            _ => cfg.device_token.clone(),
        };

        let request = match cfg.url.as_str().into_client_request() {
            Ok(mut req) => {
                if let Ok(v) = format!("Bearer {token}").parse() {
                    req.headers_mut().insert(header::AUTHORIZATION, v);
                }
                req
            }
            Err(e) => {
                tracing::error!("[ws] bad url: {e}");
                break;
            }
        };

        match connect_async(request).await {
            Ok((ws_stream, _)) => {
                retry_delay = 1;
                tracing::info!("[ws] connected");
                let (mut write, mut read) = ws_stream.split();

                // Subscribe to the device room.
                let sub = serde_json::json!({
                    "type": "subscribe",
                    "room": format!("device:{}", cfg.device_id)
                })
                .to_string();
                let _ = write.send(Message::Text(sub.into())).await;

                // Register one runner per bound project (gated by the flag).
                if cfg.register_enabled {
                    for reg in &cfg.registrations {
                        let msg = serde_json::json!({
                            "type": "runner:register",
                            "data": {
                                "type": reg.runner_type,
                                "name": reg.name,
                                "projectId": reg.project_id,
                                "capabilities": { "maxConcurrent": 1 }
                            }
                        })
                        .to_string();
                        let _ = write.send(Message::Text(msg.into())).await;
                    }
                }

                let mut ping_interval = tokio::time::interval(PING_INTERVAL);
                ping_interval.tick().await; // skip immediate tick
                let mut awaiting_pong = false;
                let mut pong_deadline = tokio::time::Instant::now() + PONG_TIMEOUT;

                loop {
                    let timeout = if awaiting_pong {
                        tokio::time::sleep_until(pong_deadline)
                    } else {
                        tokio::time::sleep_until(
                            tokio::time::Instant::now() + Duration::from_secs(86400),
                        )
                    };

                    tokio::select! {
                        msg = read.next() => match msg {
                            Some(Ok(Message::Text(text))) => {
                                awaiting_pong = false;
                                if let Ok(frame) = serde_json::from_str::<Frame>(&text) {
                                    if frame_tx.send(frame).await.is_err() {
                                        return; // consumer gone — stop entirely
                                    }
                                }
                            }
                            Some(Ok(Message::Ping(data))) => {
                                awaiting_pong = false;
                                let _ = write.send(Message::Pong(data)).await;
                            }
                            Some(Ok(Message::Pong(_))) => { awaiting_pong = false; }
                            Some(Ok(Message::Close(_))) | None => break,
                            Some(Err(_)) => break,
                            _ => {}
                        },
                        _ = ping_interval.tick() => {
                            if write.send(Message::Ping(vec![].into())).await.is_err() { break; }
                            awaiting_pong = true;
                            pong_deadline = tokio::time::Instant::now() + PONG_TIMEOUT;
                        }
                        _ = timeout => {
                            tracing::warn!("[ws] pong timeout — reconnecting");
                            break;
                        }
                        _ = cancel.changed() => {
                            if *cancel.borrow() { return; }
                        }
                    }
                }

                if *cancel.borrow() {
                    break;
                }
                tracing::warn!("[ws] disconnected");
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("401") {
                    // Don't exit the process (that left systemd to fast-restart
                    // every RestartSec with the same dead token — ISS-467).
                    // Stay up, log loudly, and fall through to the jittered
                    // backoff; the token is reloaded on the next attempt, so a
                    // fresh `forge-runner login` recovers us without a restart.
                    tracing::error!(
                        "[ws] auth failed (401) — re-pair with `forge-runner login`; \
                         retrying with backoff (no restart needed once re-paired)"
                    );
                } else {
                    tracing::warn!("[ws] connect error: {msg}");
                }
            }
        }

        // Jittered backoff 1s → 30s.
        let jitter_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_millis() as u64
            % 1000;
        let sleep_ms = retry_delay * 1000 + jitter_ms;
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(sleep_ms)) => {}
            _ = cancel.changed() => { if *cancel.borrow() { break; } }
        }
        retry_delay = (retry_delay * 2).min(30);
    }
}
