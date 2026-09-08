//! WebSocket client to core `/ws`.
//!
//! Connects with `Authorization: Bearer <deviceToken>`, subscribes to the
//! `device:<id>` room, optionally sends `runner:register` per project, then
//! forwards every text frame (parsed to [`Frame`]) on `frame_tx`.
//! Outbound, it carries whatever the latest value of `outbound` holds — one
//! snapshot at a time, latest wins.
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

/// What the box says about itself, latest-wins.
///
/// A `watch` and not an `mpsc` on purpose: the only outbound traffic is a whole
/// snapshot of state that is already true, so a value queued behind a
/// reconnect is worthless the moment a newer one exists. This is also what
/// makes a reconnect free — the loop re-reads the current value on connect and
/// nothing has to remember what it failed to send.
// cm:edge protocol -> packages/runner/crates/forge-runner-core/src/transport/session_ledger.rs — the producer. Each value is ONE complete frame body, already serialized; this transport does not know what is in it.
pub type Outbound = watch::Receiver<Option<String>>;

pub async fn connect(
    cfg: WsConfig,
    frame_tx: mpsc::Sender<Frame>,
    mut outbound: Outbound,
    mut cancel: watch::Receiver<bool>,
) {
    let mut retry_delay = 1u64;
    loop {
        if *cancel.borrow() {
            break;
        }

        let request = match cfg.url.as_str().into_client_request() {
            Ok(mut req) => {
                if let Ok(v) = format!("Bearer {}", cfg.device_token).parse() {
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

                // cm:guard emitted as a LOCAL frame on the same channel core's events arrive on, so the daemon has one place that decides what a wake means. This transport deliberately knows nothing about masters or pools — it reports that the socket came up and stops there. Sent AFTER the subscribe so a catch-up read cannot race the subscription it depends on.
                // cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/mod.rs — the `ws.connected` arm turns this into a `master::Wake::Reconnect`. The name is local to this binary and is not a core event; core must never publish it.
                if frame_tx
                    .send(Frame {
                        event: "ws.connected".into(),
                        data: serde_json::Value::Null,
                    })
                    .await
                    .is_err()
                {
                    return; // consumer gone — stop entirely
                }

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

                // cm:guard the current snapshot goes out on CONNECT, before the read loop, so a
                // reconnect does not leave core reading a box's state from before the drop until
                // the next tick (ISS-934 criterion 4).
                outbound.mark_unchanged();
                let current = outbound.borrow_and_update().clone();
                if let Some(text) = current {
                    let _ = write.send(Message::Text(text.into())).await;
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
                        _ = outbound.changed() => {
                            let next = outbound.borrow_and_update().clone();
                            if let Some(text) = next {
                                if write.send(Message::Text(text.into())).await.is_err() { break; }
                            }
                        }
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
                    // Don't exit the process here — that left systemd to
                    // fast-restart every RestartSec with the same dead token
                    // (ISS-467). Stay up, log loudly, and fall through to the
                    // jittered backoff. Recovery is handled by the daemon's
                    // credential-watch task: when a fresh `forge-runner login`
                    // writes a new token it triggers a single controlled restart
                    // that rebuilds every client (WS + HTTP) with it.
                    tracing::error!(
                        "[ws] auth failed (401) — re-pair with `forge-runner login`; \
                         the daemon auto-restarts to apply new credentials once you do"
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    /// Accept one connection and hand back every text frame the client sent.
    // cm:guard the read is bounded. A frame the client never sends is exactly what these tests are looking for, and an unbounded `next()` turns that finding into a hang the runner kills — a test that cannot go red has not been written.
    async fn collect(listener: TcpListener, want: usize) -> Vec<String> {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = accept_async(stream).await.unwrap();
        let mut out = Vec::new();
        while out.len() < want {
            let next = tokio::time::timeout(Duration::from_secs(3), ws.next()).await;
            match next {
                Ok(Some(Ok(Message::Text(t)))) => out.push(t.to_string()),
                Ok(Some(Ok(_))) => {}
                Err(_) => break,
                _ => break,
            }
        }
        out
    }

    fn cfg(port: u16) -> WsConfig {
        WsConfig {
            url: format!("ws://127.0.0.1:{port}"),
            device_token: "tok".into(),
            device_id: "dev-1".into(),
            registrations: Vec::new(),
            register_enabled: false,
        }
    }

    // cm:guard the snapshot must go out on CONNECT and not merely when it next changes. A reconnect that waits for the tick leaves core answering from the box's state before the drop, and nothing distinguishes that stale answer from a fresh one (ISS-934 criterion 4).
    #[tokio::test]
    async fn a_snapshot_already_held_goes_out_as_soon_as_the_socket_opens() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(collect(listener, 2));

        let (out_tx, out_rx) = watch::channel(Some("{\"type\":\"runner:sessions\"}".to_string()));
        let (frame_tx, _frame_rx) = mpsc::channel(8);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let client = tokio::spawn(connect(cfg(port), frame_tx, out_rx, cancel_rx));

        let frames = server.await.unwrap();
        let _ = cancel_tx.send(true);
        client.abort();
        drop(out_tx);

        assert_eq!(
            frames.len(),
            2,
            "the subscribe and the snapshot both, within the read window: {frames:?}"
        );
        assert!(
            frames[0].contains("\"type\":\"subscribe\""),
            "the device room subscribe still comes first: {frames:?}"
        );
        assert!(
            frames[1].contains("runner:sessions"),
            "the current snapshot must follow the subscribe on the same connection: {frames:?}"
        );
    }

    #[tokio::test]
    async fn a_newer_snapshot_replaces_the_last_one_on_the_live_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(collect(listener, 3));

        let (out_tx, out_rx) = watch::channel(Some("first".to_string()));
        let (frame_tx, _frame_rx) = mpsc::channel(8);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let client = tokio::spawn(connect(cfg(port), frame_tx, out_rx, cancel_rx));

        tokio::time::sleep(Duration::from_millis(200)).await;
        out_tx.send(Some("second".to_string())).unwrap();

        let frames = server.await.unwrap();
        let _ = cancel_tx.send(true);
        client.abort();

        assert_eq!(
            frames.len(),
            3,
            "subscribe, then both snapshots — a value published while the socket is up must reach it: {frames:?}"
        );
        assert_eq!(frames[2], "second");
    }
}
