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
