//! The box's tunnel against a stand-in for core's `/ws/preview-tunnel`, over real sockets: a stream
//! reaches the dev server on loopback and back, the box stops at zero credit until core grants
//! more, and an open it cannot serve is reset with the contract's reason.

use super::*;
use tokio::net::TcpListener;

const PREVIEW: &str = "6f1d3c1e-8a0b-4c55-9d43-2f3a1b0c9e11";

type ServerWs = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

struct World {
    core: ServerWs,
    _cancel: watch::Sender<bool>,
    _wanted: watch::Sender<bool>,
}

/// A dev server that answers every connection with `body` after reading its first line.
async fn dev_server(body: Vec<u8>) -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let body = body.clone();
            tokio::spawn(async move {
                let mut first = [0u8; 3];
                if sock.read_exact(&mut first).await.is_ok() {
                    let _ = sock.write_all(&body).await;
                    let _ = sock.shutdown().await;
                }
            });
        }
    });
    port
}

async fn world(ports: &[(&str, u16)]) -> World {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("ws://{}/ws/preview-tunnel", listener.local_addr().unwrap());
    let table: Ports = Arc::new(Mutex::new(
        ports
            .iter()
            .map(|(p, port)| (p.to_string(), *port))
            .collect(),
    ));
    let (wanted_tx, wanted) = watch::channel(true);
    let (cancel_tx, cancel) = watch::channel(false);
    let cfg = TunnelConfig {
        url,
        device_token: "box-token".into(),
    };
    tokio::spawn(run(cfg, table, wanted, cancel));
    let (sock, _) = listener.accept().await.unwrap();
    // the handshake, read without consuming it, then answered as core answers it
    let mut head = vec![0u8; 4096];
    let n = sock.peek(&mut head).await.unwrap();
    let head = String::from_utf8_lossy(&head[..n]).to_ascii_lowercase();
    assert!(
        head.contains("\r\nauthorization: bearer box-token\r\n"),
        "the tunnel is dialled with the device credential: {head}"
    );
    let core = tokio_tungstenite::accept_async(sock).await.unwrap();
    World {
        core,
        _cancel: cancel_tx,
        _wanted: wanted_tx,
    }
}

async fn send(core: &mut ServerWs, frame: Frame) {
    core.send(Message::Binary(codec::encode(&frame).unwrap().into()))
        .await
        .unwrap();
}

/// The next tunnel frame from the box, or None when none comes within `ms`.
async fn next(core: &mut ServerWs, ms: u64) -> Option<Frame> {
    loop {
        let msg = tokio::time::timeout(Duration::from_millis(ms), core.next())
            .await
            .ok()??
            .ok()?;
        if let Message::Binary(b) = msg {
            return Some(codec::decode(&b).expect("the box sends only contract frames"));
        }
    }
}

#[tokio::test]
async fn a_stream_carries_a_request_to_the_dev_server_and_its_answer_back() {
    let port = dev_server(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi".to_vec()).await;
    let mut w = world(&[(PREVIEW, port)]).await;
    send(
        &mut w.core,
        Frame::Open {
            stream: 1,
            preview_id: PREVIEW.into(),
        },
    )
    .await;
    send(
        &mut w.core,
        Frame::Data {
            stream: 1,
            bytes: b"GET / HTTP/1.1\r\n\r\n".to_vec(),
        },
    )
    .await;
    let mut got = Vec::new();
    loop {
        match next(&mut w.core, 5000).await.expect("the box answers") {
            Frame::Data { stream: 1, bytes } => got.extend(bytes),
            Frame::Close { stream: 1 } => break,
            other => panic!("unexpected {other:?}"),
        }
    }
    assert!(String::from_utf8_lossy(&got).ends_with("\r\n\r\nhi"));
}

#[tokio::test]
async fn the_box_stops_at_zero_credit_and_resumes_when_core_grants_more() {
    let total = 3 * codec::INITIAL_WINDOW as usize;
    let port = dev_server(vec![b'x'; total]).await;
    let mut w = world(&[(PREVIEW, port)]).await;
    send(
        &mut w.core,
        Frame::Open {
            stream: 3,
            preview_id: PREVIEW.into(),
        },
    )
    .await;
    send(
        &mut w.core,
        Frame::Data {
            stream: 3,
            bytes: b"GET".to_vec(),
        },
    )
    .await;
    let mut got = 0usize;
    while let Some(Frame::Data { bytes, .. }) = next(&mut w.core, 500).await {
        got += bytes.len();
    }
    assert_eq!(
        got,
        codec::INITIAL_WINDOW as usize,
        "the box sent exactly the first window and stopped"
    );
    let mut closed = false;
    while !closed {
        send(
            &mut w.core,
            Frame::Window {
                stream: 3,
                delta: codec::INITIAL_WINDOW,
            },
        )
        .await;
        let mut batch = 0usize;
        while let Some(frame) = next(&mut w.core, 500).await {
            match frame {
                Frame::Data { bytes, .. } => batch += bytes.len(),
                Frame::Close { .. } => {
                    closed = true;
                    break;
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        assert!(
            batch <= codec::INITIAL_WINDOW as usize,
            "never past the credit granted"
        );
        got += batch;
    }
    assert_eq!(got, total);
}

#[tokio::test]
async fn an_open_the_box_cannot_serve_is_reset_with_its_reason() {
    let free = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let dead = free.local_addr().unwrap().port();
    drop(free);
    let other = "7f1d3c1e-8a0b-4c55-9d43-2f3a1b0c9e11";
    let mut w = world(&[(PREVIEW, dead)]).await;
    send(
        &mut w.core,
        Frame::Open {
            stream: 5,
            preview_id: other.into(),
        },
    )
    .await;
    assert_eq!(
        next(&mut w.core, 2000).await,
        Some(Frame::Reset {
            stream: 5,
            code: ResetCode::PreviewNotRunning
        })
    );
    send(
        &mut w.core,
        Frame::Open {
            stream: 7,
            preview_id: PREVIEW.into(),
        },
    )
    .await;
    assert_eq!(
        next(&mut w.core, 7000).await,
        Some(Frame::Reset {
            stream: 7,
            code: ResetCode::ConnectRefused
        })
    );
    send(
        &mut w.core,
        Frame::Data {
            stream: 99,
            bytes: b"x".to_vec(),
        },
    )
    .await;
    assert_eq!(
        next(&mut w.core, 2000).await,
        Some(Frame::Reset {
            stream: 99,
            code: ResetCode::Protocol
        })
    );
}

#[tokio::test(flavor = "current_thread")]
async fn the_tunnel_ends_when_the_daemon_that_could_cancel_it_is_gone() {
    let (_wanted_tx, wanted) = watch::channel(false);
    let (cancel_tx, cancel) = watch::channel(false);
    drop(cancel_tx);
    let cfg = TunnelConfig {
        url: "ws://127.0.0.1:9/ws/preview-tunnel".into(),
        device_token: "box-token".into(),
    };
    let ended = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::spawn(run(cfg, Ports::default(), wanted, cancel)),
    )
    .await;
    assert!(
        ended.is_ok(),
        "a closed cancel channel left the tunnel actor polling it for ever"
    );
}
