//! A core on a loopback port, for a test that has to cross the real HTTP client: each request is
//! answered as the test says and recorded by its path and body.

use std::sync::{Arc, Mutex};

use runner_transport::CoreClient;

/// Every request the box sent, as `(path, body)`, in order.
pub(crate) type Seen = Arc<Mutex<Vec<(String, String)>>>;

/// A core answering each request with the status and JSON body `answer` gives for its path.
pub(crate) async fn fake_core(answer: fn(&str) -> (u16, &'static str)) -> (CoreClient, Seen) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let mut path = String::new();
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
                        path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                        log.lock().unwrap().push((path.clone(), body.to_string()));
                        break;
                    }
                }
            }
            let (status, reply) = answer(&path);
            let head = format!(
                "HTTP/1.1 {status} Answer\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                reply.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(reply.as_bytes()).await;
            let _ = sock.shutdown().await;
        }
    });
    (
        CoreClient::new(format!("http://{addr}"), "device-token"),
        seen,
    )
}

/// Every request answered `200 {}`.
pub(crate) fn takes_everything(_path: &str) -> (u16, &'static str) {
    (200, "{}")
}
