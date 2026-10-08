//! The two ends of a sandbox's egress: the proxy outside, the bridge inside.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream};

use super::{Host, Upstream, BRIDGE_PORT, REFUSAL};

/// A request head is refused past this size rather than buffered without end.
const MAX_HEAD: usize = 64 * 1024;

struct Rules {
    allow: Vec<Host>,
    upstream: Option<Upstream>,
}

/// The proxy one sandbox reaches the network through, listening until it is dropped. Dropping
/// it stops new connections and removes its socket and directory.
#[derive(Debug)]
pub struct Proxy {
    dir: PathBuf,
    task: tokio::task::JoinHandle<()>,
}

impl Proxy {
    /// Listen at `socket`, whose directory is created owner-only and must not exist yet, opening
    /// connections to `allow` only, through `upstream` where this box has one.
    pub fn start(
        socket: &Path,
        allow: Vec<Host>,
        upstream: Option<Upstream>,
    ) -> std::io::Result<Self> {
        use std::os::unix::fs::DirBuilderExt;
        let dir = socket
            .parent()
            .ok_or_else(|| std::io::Error::other("the egress socket has no directory"))?
            .to_path_buf();
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        let listener = match UnixListener::bind(socket) {
            Ok(l) => l,
            Err(e) => {
                let _ = std::fs::remove_dir(&dir);
                return Err(e);
            }
        };
        let rules = Arc::new(Rules { allow, upstream });
        let task = tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                tokio::spawn(serve(client, rules.clone()));
            }
        });
        Ok(Self { dir, task })
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// What a client asked for: a tunnel (`CONNECT`) or one plain HTTP request.
struct Asked {
    host: Host,
    tunnel: bool,
}

fn parse_request(head: &[u8]) -> Result<Asked, String> {
    let text = String::from_utf8_lossy(head);
    let line = text.lines().next().unwrap_or_default();
    let mut parts = line.split(' ');
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if method.eq_ignore_ascii_case("CONNECT") {
        let host = Host::parse(target)?;
        if !target.contains(':') {
            return Err(format!("CONNECT `{target}` names no port"));
        }
        return Ok(Asked { host, tunnel: true });
    }
    if target.len() > 7 && target[..7].eq_ignore_ascii_case("http://") {
        return Ok(Asked {
            host: Host::parse(target)?,
            tunnel: false,
        });
    }
    Err(format!(
        "`{method} {target}` is neither CONNECT nor an absolute http:// request"
    ))
}

/// The request head up to and including its blank line, and whatever the client sent after it.
async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> std::io::Result<(Vec<u8>, Vec<u8>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(end + 4);
            return Ok((buf, rest));
        }
        if buf.len() > MAX_HEAD {
            return Err(std::io::Error::other("request head too large"));
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

async fn answer<S: AsyncWrite + Unpin>(client: &mut S, status: &str, why: &str) {
    let body = format!("{why}\n");
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = client.write_all(reply.as_bytes()).await;
    let _ = client.shutdown().await;
}

/// A plain request's head with its connection headers replaced by `Connection: close`, so the
/// client opens a new connection, and is judged again, for its next host.
fn close_after(head: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(head);
    let mut out = String::with_capacity(text.len() + 20);
    for line in text.split("\r\n").filter(|l| !l.is_empty()) {
        let name = line.split(':').next().unwrap_or("").trim();
        if name.eq_ignore_ascii_case("connection") || name.eq_ignore_ascii_case("proxy-connection")
        {
            continue;
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str("Connection: close\r\n\r\n");
    out.into_bytes()
}

async fn serve(mut client: UnixStream, rules: Arc<Rules>) {
    let Ok((head, rest)) = read_head(&mut client).await else {
        return;
    };
    let asked = match parse_request(&head) {
        Ok(asked) => asked,
        Err(why) => return answer(&mut client, "400 Bad Request", &why).await,
    };
    if !rules.allow.contains(&asked.host) {
        let allowed: Vec<String> = rules.allow.iter().map(Host::to_string).collect();
        let why = format!(
            "[{REFUSAL}] this chat session reaches only {}; {} is not one of them",
            allowed.join(", "),
            asked.host
        );
        tracing::warn!("{why}");
        return answer(&mut client, "403 Forbidden", &why).await;
    }
    let (mut server, early) = match open(&rules, &asked).await {
        Ok(opened) => opened,
        Err(why) => return answer(&mut client, "502 Bad Gateway", &why).await,
    };
    let sent = if asked.tunnel {
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
    } else {
        server.write_all(&close_after(&head)).await
    };
    if sent.is_err()
        || client.write_all(&early).await.is_err()
        || server.write_all(&rest).await.is_err()
    {
        return;
    }
    let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
}

/// A connection to the host asked for, direct or through this box's upstream proxy, and any
/// bytes the upstream sent past its own answer.
async fn open(rules: &Rules, asked: &Asked) -> Result<(TcpStream, Vec<u8>), String> {
    let host = &asked.host;
    let via = rules.upstream.as_ref().filter(|u| !u.bypasses(&host.name));
    let target = via.map_or(host, |u| &u.proxy);
    let mut stream = TcpStream::connect((target.name.as_str(), target.port))
        .await
        .map_err(|e| format!("{target} could not be reached: {e}"))?;
    let Some(upstream) = via else {
        return Ok((stream, Vec::new()));
    };
    if !asked.tunnel {
        // A plain request goes to the upstream as written: its absolute form names the host.
        return Ok((stream, Vec::new()));
    }
    let connect = format!("CONNECT {host} HTTP/1.1\r\nHost: {host}\r\n\r\n");
    stream.write_all(connect.as_bytes()).await.map_err(|e| {
        format!(
            "the upstream proxy {} dropped the CONNECT: {e}",
            upstream.proxy
        )
    })?;
    let (reply, early) = read_head(&mut stream)
        .await
        .map_err(|e| format!("the upstream proxy {} did not answer: {e}", upstream.proxy))?;
    let status = String::from_utf8_lossy(&reply);
    let status = status.lines().next().unwrap_or_default();
    if status.split(' ').nth(1) != Some("200") {
        return Err(format!(
            "the upstream proxy {} refused {host}: {status}",
            upstream.proxy
        ));
    }
    Ok((stream, early))
}

/// Inside the sandbox: listen on loopback at [`BRIDGE_PORT`], forward every connection to
/// `socket`, and run `program args` with this process's stdio until it ends. Answers the exit
/// code it ended with, or `128 + signal`.
pub async fn bridge(socket: &Path, program: &OsStr, args: &[OsString]) -> std::io::Result<i32> {
    use std::os::unix::process::ExitStatusExt;
    let listener = TcpListener::bind(("127.0.0.1", BRIDGE_PORT)).await?;
    let mut child = tokio::process::Command::new(program).args(args).spawn()?;
    loop {
        tokio::select! {
            status = child.wait() => {
                let status = status?;
                return Ok(status
                    .code()
                    .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)));
            }
            accepted = listener.accept() => {
                let Ok((mut tcp, _)) = accepted else { continue };
                let socket = socket.to_path_buf();
                tokio::spawn(async move {
                    if let Ok(mut out) = UnixStream::connect(&socket).await {
                        let _ = tokio::io::copy_bidirectional(&mut tcp, &mut out).await;
                    }
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_is_a_tunnel_or_an_absolute_plain_request_and_nothing_else() {
        let asked = parse_request(b"CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n").unwrap();
        assert!(asked.tunnel && asked.host.to_string() == "api.anthropic.com:443");
        let asked = parse_request(b"GET http://core:8080/x HTTP/1.1\r\n\r\n").unwrap();
        assert!(!asked.tunnel && asked.host.to_string() == "core:8080");
        for bad in [
            &b"GET /x HTTP/1.1\r\n\r\n"[..],
            b"CONNECT example.com HTTP/1.1\r\n\r\n",
            b"GET https://example.com/ HTTP/1.1\r\n\r\n",
        ] {
            assert!(
                parse_request(bad).is_err(),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    #[test]
    fn a_plain_request_is_closed_after_so_its_next_host_is_judged_again() {
        let head = b"GET http://core/x HTTP/1.1\r\nHost: core\r\nProxy-Connection: keep-alive\r\nconnection: keep-alive\r\n\r\n";
        let out = String::from_utf8(close_after(head)).unwrap();
        assert_eq!(
            out,
            "GET http://core/x HTTP/1.1\r\nHost: core\r\nConnection: close\r\n\r\n"
        );
    }
}
