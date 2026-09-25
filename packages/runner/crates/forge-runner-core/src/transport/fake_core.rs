//! A core that answers every request the same way, for one test.
//!
//! What the lease transports decide is which of core's answers becomes an
//! error, and that decision reads the status line and the body's `code`. A
//! stub serving one pair is therefore the whole input, and the bodies below are
//! copied from core's own refusals so a rename on that side shows up here.

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Binds a port and answers `status` with `body` for as long as the test runs.
pub async fn serve_always(status: &'static str, body: &'static str) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
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

/// Answers each request by its path: the first `(path, status, body)` whose path
/// the request line names, and `404` where none does. For a caller that makes
/// two calls which have to be answered differently.
pub async fn serve_routes(routes: &'static [(&'static str, &'static str, &'static str)]) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]);
                let path = head.split_whitespace().nth(1).unwrap_or("");
                let (status, body) = routes
                    .iter()
                    .find(|(route, _, _)| path.split('?').next() == Some(*route))
                    .map(|(_, status, body)| (*status, *body))
                    .unwrap_or(("404 Not Found", ROUTE_ABSENT));
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

/// Accepts every connection and never answers it, holding the socket open for
/// as long as the test runs: the peer a call with no deadline waits on forever.
pub async fn serve_silent() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((sock, _)) = listener.accept().await {
            held.push(sock);
        }
    });
    format!("http://{addr}")
}

/// Answers `status` with headers promising a body, sends half of it, and
/// stalls: the peer that is slow after the status line rather than before it.
pub async fn serve_stalled_body(status: &'static str) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(
                    format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n{{\"items\":["
                    )
                    .as_bytes(),
                )
                .await;
            held.push(sock);
        }
    });
    format!("http://{addr}")
}

/// Like [`serve_always`], and keeps every request body it was sent, so a test
/// can read what a box actually put on the wire rather than what it built.
pub async fn serve_recording(
    status: &'static str,
    body: &'static str,
) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let kept = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let kept = kept.clone();
            tokio::spawn(async move {
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let Ok(n) = sock.read(&mut buf).await else {
                        return;
                    };
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&raw);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text[..end]
                            .lines()
                            .find_map(|l| {
                                let (k, v) = l.split_once(':')?;
                                k.eq_ignore_ascii_case("content-length")
                                    .then(|| v.trim().parse::<usize>().ok())
                                    .flatten()
                            })
                            .unwrap_or(0);
                        if raw.len() >= end + 4 + len {
                            kept.lock().unwrap().push(
                                String::from_utf8_lossy(&raw[end + 4..end + 4 + len]).into_owned(),
                            );
                            break;
                        }
                    }
                }
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    (format!("http://{addr}"), seen)
}

/// `404` — the key names a prefix no project answers to.
///
/// A deleted project leaves this state standing: `issue_prefix_aliases` keeps
/// the row with a null project, and every lease of that project went with it
/// through the cascade on `issue_leases.project_id`.
pub const UNKNOWN_PREFIX: &str = r#"{"code":"ISSUE_LEASE_KEY_UNKNOWN_PREFIX","message":"`FD-880` names the issue prefix `FD`, which no project answers to, so it reaches no lease."}"#;

/// `400` — the key is not an issue reference, so it names no stored key.
pub const KEY_SHAPE: &str =
    r#"{"code":"ISSUE_LEASE_KEY_SHAPE","message":"`ISS-x` is not an issue reference"}"#;

/// `400` — the key's prefix names one project and `projectId` names another.
pub const PROJECT_MISMATCH: &str = r#"{"code":"ISSUE_LEASE_KEY_PROJECT_MISMATCH","message":"`FD-880` names project p-2 through the prefix `FD`, and `projectId` names p-1."}"#;

/// `409` — this box holds the key in more than one project.
pub const AMBIGUOUS: &str = r#"{"code":"ISSUE_LEASE_AMBIGUOUS","message":"this box holds 2 leases on ISS-880, one per project; send `?projectId=<id>`"}"#;

/// `404` from a core that does not serve the route at all.
pub const ROUTE_ABSENT: &str =
    r#"{"code":"NOT_FOUND","message":"Not Found: GET /api/devices/me/issue-leases/ISS-880"}"#;
