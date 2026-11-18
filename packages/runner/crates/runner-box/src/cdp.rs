//! The attach door's CDP proxy (ISS-1322): what an agent on this device is handed by
//! `forge-runner box attach` / forge_box `attach` for a browser box, so Playwright
//! (`connectOverCDP`) or chrome-devtools-mcp (`--browserUrl`) drive the same Chrome the live view
//! shows, while the person's hold still binds and the feed still sees it.
//!
//! It listens on its own loopback port and serves Chrome's discovery reads (`/json/version`,
//! `/json/list`) with every endpoint rewritten to itself, and relays each `/devtools/*` WebSocket
//! to Chrome's. Chrome's own port is found again for every connection (`agent-browser get
//! cdp-url`), so a browser that restarted is followed. On the WebSocket each call is weighed by
//! [`methods::is_read`]: while a person holds the box (`box.take` until `box.release`) a write is
//! answered with a CDP error naming `BOX_HELD_BY_PERSON` and never reaches Chrome, so the page does
//! not move; a read passes. Every write, passed or refused, is reported into the box's act feed
//! (`box-wire.ts` report `cdp`) by its method name. Built on tokio-tungstenite, which the box's
//! input stream already uses, and reqwest for the discovery reads: only the weighing is ours.

pub mod methods;
#[cfg(test)]
pub(crate) mod tests;

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::Message;

use crate::core::{Core, Fut};

/// Where Chrome's own CDP answers now (`127.0.0.1:<port>`), found again for each connection.
pub type Upstream = Arc<dyn Fn() -> Fut<'static, Result<String, String>> + Send + Sync>;

/// The CDP error code Chrome uses for a call the server refuses.
const REFUSED: i64 = -32000;
/// How long the acts seen are gathered before one report carries them.
const FLUSH: Duration = Duration::from_millis(500);
/// The most feed lines one report carries (`box-wire.ts` `cdp.acts`).
pub const REPORT_ACTS: usize = 100;
/// The longest method name reported (`box-wire.ts`).
const METHOD_CHARS: usize = 120;
/// The longest request head read before a connection is refused.
const HEAD_BYTES: usize = 16 * 1024;

/// A running proxy. Dropping it stops the listener and every attached connection.
pub struct Proxy {
    port: u16,
    task: tokio::task::JoinHandle<()>,
}

impl Proxy {
    /// What an agent is handed: the URL Playwright's `connectOverCDP` and chrome-devtools-mcp's
    /// `--browserUrl` take.
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// One method an attached session called that is not a read, and whether the hold refused it.
#[derive(Debug, Clone, PartialEq)]
struct Seen {
    method: String,
    refused: bool,
}

/// Start the proxy for box `box_id`: `held` is the hold core said (`box.take`/`box.release`), and
/// the writes it sees are reported to `core`.
pub async fn serve(
    box_id: &str,
    upstream: Upstream,
    held: watch::Receiver<bool>,
    core: Arc<dyn Core>,
) -> Result<Proxy, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("the CDP proxy found no loopback port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("the CDP proxy's port: {e}"))?
        .port();
    let (seen, feed) = mpsc::unbounded_channel();
    tokio::spawn(report(box_id.to_string(), feed, core));
    let id = box_id.to_string();
    let task = tokio::spawn(async move {
        let mut open = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((sock, _)) => {
                        let one = Conn {
                            box_id: id.clone(),
                            upstream: upstream.clone(),
                            held: held.clone(),
                            seen: seen.clone(),
                            port,
                        };
                        open.spawn(async move {
                            if let Err(why) = one.serve(sock).await {
                                tracing::warn!("[box] {}: an attached CDP connection ended: {why}", one.box_id);
                            }
                        });
                    }
                    Err(e) => tracing::warn!("[box] {id}: the CDP proxy could not accept: {e}"),
                },
                Some(_) = open.join_next(), if !open.is_empty() => {}
            }
        }
    });
    Ok(Proxy { port, task })
}

struct Conn {
    box_id: String,
    upstream: Upstream,
    held: watch::Receiver<bool>,
    seen: mpsc::UnboundedSender<Seen>,
    port: u16,
}

impl Conn {
    async fn serve(&self, mut sock: TcpStream) -> Result<(), String> {
        let head = read_head(&sock).await?;
        let (path, upgrade) = parse_head(&head)?;
        let upstream = match (self.upstream)().await {
            Ok(u) => u,
            Err(why) => {
                let said = format!("the box's browser answers no CDP endpoint: {why}");
                return answer(&mut sock, "502 Bad Gateway", &said).await;
            }
        };
        if upgrade && path.starts_with("/devtools/") {
            return self.relay(sock, &upstream, &path).await;
        }
        let mut consumed = vec![0u8; head.len()];
        sock.read_exact(&mut consumed)
            .await
            .map_err(|e| e.to_string())?;
        match discovery(&path) {
            Some(p) if !upgrade => self.discover(&mut sock, &upstream, p).await,
            _ => {
                let said = "the attach proxy serves /json/version, /json/list and /devtools/* WebSockets; open or close a page over CDP (Target.createTarget), where the person's hold binds";
                answer(&mut sock, "404 Not Found", said).await
            }
        }
    }

    /// Chrome's discovery read, every endpoint in it pointed at this proxy.
    async fn discover(
        &self,
        sock: &mut TcpStream,
        upstream: &str,
        path: &str,
    ) -> Result<(), String> {
        let got = reqwest::Client::new()
            .get(format!("http://{upstream}{path}"))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| format!("Chrome's {path}: {e}"))?;
        let status = got.status();
        let body = got
            .text()
            .await
            .map_err(|e| format!("Chrome's {path}: {e}"))?;
        let body = body.replace(upstream, &format!("127.0.0.1:{}", self.port));
        let line = format!(
            "{} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        );
        respond(sock, &line, "application/json; charset=UTF-8", &body).await
    }

    /// One attached WebSocket, relayed to Chrome's, each call weighed against the hold.
    async fn relay(&self, sock: TcpStream, upstream: &str, path: &str) -> Result<(), String> {
        let theirs = tokio_tungstenite::accept_async(sock)
            .await
            .map_err(|e| format!("the attach handshake: {e}"))?;
        let (chrome, _) = tokio_tungstenite::connect_async(format!("ws://{upstream}{path}"))
            .await
            .map_err(|e| format!("Chrome's CDP socket {path}: {e}"))?;
        let (mut to_them, mut from_them) = theirs.split();
        let (mut to_chrome, mut from_chrome) = chrome.split();
        loop {
            tokio::select! {
                m = from_them.next() => match m {
                    Some(Ok(Message::Text(text))) => {
                        let held = *self.held.borrow();
                        match self.weigh(&text, held) {
                            Weighed::Pass => to_chrome.send(Message::Text(text)).await,
                            Weighed::Refuse(said) => to_them.send(Message::Text(said.into())).await,
                            Weighed::Drop => Ok(()),
                        }
                        .map_err(|e| e.to_string())?;
                    }
                    Some(Ok(Message::Close(f))) => {
                        let _ = to_chrome.send(Message::Close(f)).await;
                        return Ok(());
                    }
                    Some(Ok(m @ (Message::Ping(_) | Message::Pong(_)))) => {
                        to_chrome.send(m).await.map_err(|e| e.to_string())?;
                    }
                    Some(Ok(_)) => tracing::warn!(
                        "[box] {}: an attached session sent a binary frame, which names no CDP method: not forwarded",
                        self.box_id
                    ),
                    Some(Err(e)) => return Err(e.to_string()),
                    None => return Ok(()),
                },
                m = from_chrome.next() => match m {
                    Some(Ok(m)) => to_them.send(m).await.map_err(|e| e.to_string())?,
                    _ => {
                        let _ = to_them.close().await;
                        return Ok(());
                    }
                },
            }
        }
    }

    /// What one call from the attached session does: passes, is refused by the hold, or is
    /// dropped as no CDP call at all. A write is reported either way.
    fn weigh(&self, text: &str, held: bool) -> Weighed {
        let call: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(_) => return self.unreadable(),
        };
        let Some(method) = call["method"].as_str() else {
            return self.unreadable();
        };
        if methods::is_read(method) {
            return Weighed::Pass;
        }
        let method: String = method.chars().take(METHOD_CHARS).collect();
        let _ = self.seen.send(Seen {
            method: method.clone(),
            refused: held,
        });
        if !held {
            return Weighed::Pass;
        }
        let mut said = json!({
            "id": call["id"],
            "error": {
                "code": REFUSED,
                "message": format!(
                    "BOX_HELD_BY_PERSON: a person holds this box, so {method} is refused and the page does not move. Reads still answer. Wait until the box reads agent again, then read what they did: forge-runner api boxes/{}/acts?by=person",
                    self.box_id
                ),
            },
        });
        if let Some(s) = call.get("sessionId") {
            said["sessionId"] = s.clone();
        }
        Weighed::Refuse(said.to_string())
    }

    fn unreadable(&self) -> Weighed {
        tracing::warn!(
            "[box] {}: an attached session sent a message naming no CDP method: not forwarded",
            self.box_id
        );
        Weighed::Drop
    }
}

enum Weighed {
    Pass,
    Refuse(String),
    Drop,
}

/// The discovery path Chrome's reads answer at, or none.
fn discovery(path: &str) -> Option<&'static str> {
    let bare = path.split('?').next().unwrap_or("").trim_end_matches('/');
    match bare {
        "/json/version" => Some("/json/version"),
        "/json" | "/json/list" => Some("/json/list"),
        _ => None,
    }
}

/// The request head, peeked: a WebSocket's handshake reads it again itself.
async fn read_head(sock: &TcpStream) -> Result<String, String> {
    let mut buf = vec![0u8; HEAD_BYTES];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let n = sock.peek(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("the connection closed before its request".into());
        }
        if let Some(end) = buf[..n].windows(4).position(|w| w == b"\r\n\r\n") {
            return Ok(String::from_utf8_lossy(&buf[..end + 4]).into_owned());
        }
        if n == HEAD_BYTES || tokio::time::Instant::now() > deadline {
            return Err("no whole request head arrived".into());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The request's path and whether it asks for a WebSocket.
fn parse_head(head: &str) -> Result<(String, bool), String> {
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or_default();
    let mut parts = first.split(' ');
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if method != "GET" || !path.starts_with('/') {
        return Err(format!("not a CDP request: {first:?}"));
    }
    let upgrade = lines.any(|l| {
        l.split_once(':').is_some_and(|(k, v)| {
            k.trim().eq_ignore_ascii_case("upgrade") && v.trim().eq_ignore_ascii_case("websocket")
        })
    });
    Ok((path.to_string(), upgrade))
}

async fn answer(sock: &mut TcpStream, status: &str, said: &str) -> Result<(), String> {
    respond(sock, status, "text/plain; charset=UTF-8", said).await
}

async fn respond(sock: &mut TcpStream, status: &str, kind: &str, body: &str) -> Result<(), String> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let said = |e: std::io::Error| e.to_string();
    sock.write_all(head.as_bytes()).await.map_err(said)?;
    sock.write_all(body.as_bytes()).await.map_err(said)?;
    sock.shutdown().await.map_err(said)
}

/// The writes attached sessions made, gathered for [`FLUSH`] and reported in order, a run of one
/// method collapsed into one line with its count. Ends once the proxy and its connections are gone.
async fn report(box_id: String, mut feed: mpsc::UnboundedReceiver<Seen>, core: Arc<dyn Core>) {
    while let Some(first) = feed.recv().await {
        let mut acts = vec![(first, 1u64)];
        let until = tokio::time::Instant::now() + FLUSH;
        while acts.len() < REPORT_ACTS {
            match tokio::time::timeout_at(until, feed.recv()).await {
                Ok(Some(s)) => match acts.last_mut() {
                    Some((last, n)) if *last == s => *n += 1,
                    _ => acts.push((s, 1)),
                },
                _ => break,
            }
        }
        let acts: Vec<Value> = acts
            .into_iter()
            .map(|(s, n)| json!({ "method": s.method, "count": n, "refused": s.refused }))
            .collect();
        core.report(&box_id, json!({ "kind": "cdp", "acts": acts }))
            .await;
    }
}
