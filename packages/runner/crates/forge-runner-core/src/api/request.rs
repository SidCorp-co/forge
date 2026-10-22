//! Build one REST call from CLI arguments, execute it, and report the result
//! through stdout / stderr / exit code.

use serde_json::Value;

use super::exit::{classify, transport_failure, Outcome};
use crate::transport::status::not_reached_words;
use crate::transport::CoreClient;

/// One `forge-runner api` invocation, already parsed.
#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub body: Option<String>,
    pub project_slug: Option<String>,
    pub headers: Vec<(String, String)>,
    /// Print the status line and response headers to stderr.
    pub include_headers: bool,
}

/// What `run` produced, so the caller can print it and pick an exit code.
pub struct Response {
    /// The body as the server sent it, byte for byte: a PNG downloaded through this command must
    /// come out as the PNG, not as its lossy UTF-8 reading.
    pub stdout: Vec<u8>,
    /// Text is printed with a trailing newline, as it always was; a binary body gets none.
    pub stdout_is_text: bool,
    pub stderr: String,
    pub outcome: Outcome,
}

pub fn normalize_path(path: &str) -> String {
    let p = path.trim();
    if p.starts_with("/api/") || p == "/api" {
        return p.to_string();
    }
    let rest = p.strip_prefix('/').unwrap_or(p);
    format!("/api/{rest}")
}

/// `{ code, message, details }` is what `middleware/error.ts` emits; anything
/// else (a proxy's HTML 502, an empty body) yields `None` and the status
/// decides.
fn body_code(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("code")?
        .as_str()
        .map(str::to_string)
}

/// The machine-readable half of a failure, on stderr beside the human half.
fn failure_json(outcome: &Outcome, status: Option<u16>, message: &str) -> String {
    let mut obj = serde_json::Map::new();
    obj.insert("code".into(), Value::String(outcome.code.clone()));
    obj.insert("message".into(), Value::String(message.to_string()));
    if let Some(s) = status {
        obj.insert("status".into(), Value::from(s));
    }
    obj.insert("retryable".into(), Value::Bool(outcome.retryable));
    obj.insert("exitCode".into(), Value::from(outcome.exit_code));
    Value::Object(obj).to_string()
}

/// Whether a body is text to print with a newline, or bytes to write as they came: a content type
/// that names text, JSON or XML, and bytes that are UTF-8. A response that names no type is bytes,
/// since a newline added to a download that happens to be UTF-8 is a different file.
fn reads_as_text(content_type: Option<&str>, bytes: &[u8]) -> bool {
    if std::str::from_utf8(bytes).is_err() {
        return false;
    }
    let Some(kind) = content_type else {
        return false;
    };
    let kind = kind.split(';').next().unwrap_or("").trim().to_lowercase();
    kind.starts_with("text/")
        || kind == "application/json"
        || kind == "application/xml"
        || kind.ends_with("+json")
        || kind.ends_with("+xml")
}

/// Execute the request. Never panics on a malformed response — a body that is
/// not JSON is still the caller's to see.
pub async fn run(client: &CoreClient, req: &Request) -> Response {
    let method = match reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes()) {
        Ok(m) => m,
        Err(_) => {
            let outcome = Outcome {
                exit_code: 2,
                retryable: false,
                code: "USAGE".to_string(),
            };
            let msg = format!("not an HTTP method: {}", req.method);
            return Response {
                stdout: Vec::new(),
                stdout_is_text: true,
                stderr: failure_json(&outcome, None, &msg),
                outcome,
            };
        }
    };

    let url = client.url(&normalize_path(&req.path));
    let mut rb = client
        .http()
        .request(method, &url)
        .bearer_auth(client.device_token());

    if let Some(slug) = &req.project_slug {
        rb = rb.header("X-Forge-Project-Slug", slug.as_str());
    }
    for (k, v) in &req.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    if let Some(body) = &req.body {
        rb = rb
            .header("Content-Type", "application/json")
            .body(body.clone());
    }

    // Where Forge was sought, why it was not reached and what to check, never reqwest's own
    // "error sending request for url (…)" (ISS-1421 r23, judge-94 on 214).
    let what = format!(
        "{} {}",
        req.method.to_uppercase(),
        normalize_path(&req.path)
    );
    let unreached = |e: &reqwest::Error, status: Option<u16>| {
        let (outcome, msg) = transport_failure(&req.method, not_reached_words(&what, e, None));
        Response {
            stdout: Vec::new(),
            stdout_is_text: true,
            stderr: failure_json(&outcome, status, &msg),
            outcome,
        }
    };
    let resp = match rb.send().await {
        Ok(r) => r,
        Err(e) => return unreached(&e, None),
    };

    let status = resp.status().as_u16();
    let mut header_dump = String::new();
    if req.include_headers {
        header_dump.push_str(&format!("HTTP {status}\n"));
        for (k, v) in resp.headers() {
            header_dump.push_str(&format!("{k}: {}\n", v.to_str().unwrap_or("<binary>")));
        }
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    // An answer cut off mid-body is said, never printed as an empty success.
    let answered_at = resp.url().clone();
    let bytes = match resp.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => return unreached(&e.with_url(answered_at), Some(status)),
    };
    let stdout_is_text = reads_as_text(content_type.as_deref(), &bytes);
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let outcome = classify(status, body_code(&text).as_deref());

    if outcome.exit_code == 0 {
        return Response {
            stdout: bytes,
            stdout_is_text,
            stderr: header_dump,
            outcome,
        };
    }

    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get("message")?.as_str().map(str::to_string))
        .unwrap_or_else(|| text.trim().to_string());
    let stderr = format!(
        "{header_dump}{}\n{}",
        text.trim(),
        failure_json(&outcome, Some(status), &message)
    );
    Response {
        stdout: Vec::new(),
        stdout_is_text: true,
        stderr,
        outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// One-shot server that answers once and hands back what it was sent.
    async fn serve_once(
        status: &'static str,
        body: &'static str,
    ) -> (String, tokio::sync::oneshot::Receiver<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
        });
        (format!("http://{addr}"), rx)
    }

    /// One-shot server that answers once with raw bytes and a content type.
    async fn serve_bytes_once(content_type: &'static str, body: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let _ = sock.read(&mut buf).await;
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(&body).await;
            let _ = sock.shutdown().await;
        });
        format!("http://{addr}")
    }

    fn req(path: &str) -> Request {
        Request {
            method: "GET".into(),
            path: path.into(),
            body: None,
            project_slug: None,
            headers: vec![],
            include_headers: false,
        }
    }

    #[test]
    fn the_three_spellings_of_a_path_are_one_endpoint() {
        for p in ["issues", "/issues", "/api/issues"] {
            assert_eq!(normalize_path(p), "/api/issues", "spelling {p}");
        }
    }

    #[test]
    fn a_path_that_merely_starts_with_api_is_not_mistaken_for_the_prefix() {
        assert_eq!(normalize_path("/apikeys"), "/api/apikeys");
    }

    #[tokio::test]
    async fn a_successful_body_goes_to_stdout_and_exits_zero() {
        let (url, _rx) = serve_once("200 OK", r#"{"items":[]}"#).await;
        let c = CoreClient::new(url, "tok".to_string());
        let r = run(&c, &req("issues")).await;
        assert_eq!(r.outcome.exit_code, 0);
        assert_eq!(r.stdout, br#"{"items":[]}"#);
        assert_eq!(r.stderr, "");
    }

    #[tokio::test]
    async fn an_error_body_never_reaches_stdout() {
        let (url, _rx) =
            serve_once("404 Not Found", r#"{"code":"NOT_FOUND","message":"no"}"#).await;
        let c = CoreClient::new(url, "tok".to_string());
        let r = run(&c, &req("issues/nope")).await;
        assert_eq!(
            r.stdout, b"",
            "stdout must stay empty so a redirect captures nothing"
        );
        assert_eq!(r.outcome.exit_code, 5);
        assert!(r.stderr.contains(r#""retryable":false"#));
        assert!(r.stderr.contains(r#""code":"NOT_FOUND""#));
    }

    #[tokio::test]
    async fn a_429_reports_itself_as_retryable_on_stderr() {
        let (url, _rx) = serve_once(
            "429 Too Many Requests",
            r#"{"code":"TOO_MANY_REQUESTS","message":"slow down"}"#,
        )
        .await;
        let c = CoreClient::new(url, "tok".to_string());
        let r = run(&c, &req("issues")).await;
        assert_eq!(r.outcome.exit_code, 7);
        assert!(r.stderr.contains(r#""retryable":true"#));
        assert!(r.stderr.contains(r#""status":429"#));
    }

    #[tokio::test]
    async fn a_proxy_error_with_no_json_still_names_a_code() {
        let (url, _rx) = serve_once("502 Bad Gateway", "<html>nginx</html>").await;
        let c = CoreClient::new(url, "tok".to_string());
        let r = run(&c, &req("issues")).await;
        assert_eq!(r.outcome.exit_code, 8);
        assert_eq!(r.outcome.code, "INTERNAL_ERROR");
        assert!(r.outcome.retryable);
    }

    #[tokio::test]
    async fn a_dropped_post_reports_delivery_unknown_not_a_retry() {
        let (_held, addr) = crate::transport::lifecycle::testing::refused_addr().await;
        let c = CoreClient::new(format!("http://{addr}"), "tok".to_string());
        let mut r = req("issues");
        r.method = "POST".into();
        r.body = Some("{}".into());
        let out = run(&c, &r).await;
        assert_eq!(out.outcome.exit_code, 10);
        assert!(!out.outcome.retryable);
        assert!(out.stderr.contains("DELIVERY_UNKNOWN"));
        assert_eq!(out.stdout, b"");
    }

    #[tokio::test]
    async fn an_unreachable_core_is_retryable_and_never_zero() {
        let (_held, addr) = crate::transport::lifecycle::testing::refused_addr().await;
        let c = CoreClient::new(format!("http://{addr}"), "tok".to_string());
        let r = run(&c, &req("issues")).await;
        assert_eq!(r.outcome.exit_code, 9);
        assert!(r.outcome.retryable);
        assert_eq!(r.stdout, b"");
    }

    /// Criterion 214, judge-94: `api` passed reqwest's "error sending request for url (…)" through.
    #[tokio::test]
    async fn an_unreachable_core_is_said_by_where_why_and_what_to_check() {
        let (_held, addr) = crate::transport::lifecycle::testing::refused_addr().await;
        let c = CoreClient::new(format!("http://{addr}"), "tok".to_string());
        let r = run(&c, &req("version")).await;
        let failure: Value = serde_json::from_str(&r.stderr).unwrap();
        assert_eq!(
            failure["message"],
            format!(
                "GET /api/version: Forge could not be reached at http://{addr}, as the connection \
                 was refused. Check that core is running there and that this box's core address is \
                 right."
            )
        );
        assert!(!r.stderr.contains("error sending request"), "{}", r.stderr);
    }

    /// A peer that accepts and closes before answering was said only as "the request failed".
    #[tokio::test]
    async fn a_core_that_closes_before_answering_is_said_as_a_cut_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let _ = sock.read(&mut buf).await;
            drop(sock);
        });
        let c = CoreClient::new(format!("http://{addr}"), "tok".to_string());
        let r = run(&c, &req("version")).await;
        let failure: Value = serde_json::from_str(&r.stderr).unwrap();
        assert!(
            failure["message"]
                .as_str()
                .unwrap()
                .contains(&format!("at http://{addr}, as the connection was cut.")),
            "{}",
            r.stderr
        );
    }

    /// An answer whose body is cut off was printed as an empty success with exit 0.
    #[tokio::test]
    async fn an_answer_cut_off_mid_body_is_a_failure_that_says_so() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let _ = sock.read(&mut buf).await;
            let head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{\"items\":";
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.shutdown().await;
        });
        let c = CoreClient::new(format!("http://{addr}"), "tok".to_string());
        let r = run(&c, &req("issues")).await;
        assert_ne!(r.outcome.exit_code, 0, "{}", r.stderr);
        assert_eq!(r.stdout, b"");
        let failure: Value = serde_json::from_str(&r.stderr).unwrap();
        assert_eq!(failure["status"], 200);
        let said = failure["message"].as_str().unwrap();
        assert_eq!(
            said,
            format!("GET /api/issues: Forge at http://{addr} answered, but the body did not arrive whole.")
        );
    }

    /// Serves one answer whose head and first bytes are `sent`, then closes the connection.
    async fn cut_after(sent: &'static str) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let _ = sock.read(&mut buf).await;
            let _ = sock.write_all(sent.as_bytes()).await;
            let _ = sock.shutdown().await;
        });
        addr
    }

    const CHUNKED: &str =
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n";

    /// Criterion 245, ISS-1421 r24: a chunked answer cut between two chunks said "the body did not
    /// decode: unexpected EOF during chunk size line", as if core had sent something malformed.
    #[tokio::test]
    async fn a_chunked_answer_cut_between_chunks_did_not_arrive_whole() {
        for method in ["get", "post"] {
            let sent: &'static str =
                Box::leak(format!("{CHUNKED}9\r\n{{\"items\":\r\n").into_boxed_str());
            let addr = cut_after(sent).await;
            let c = CoreClient::new(format!("http://{addr}"), "tok".to_string());
            let mut r = req("issues");
            r.method = method.into();
            if method == "post" {
                r.body = Some("{}".into());
            }
            let out = run(&c, &r).await;
            assert_ne!(out.outcome.exit_code, 0, "{}", out.stderr);
            assert_eq!(out.stdout, b"");
            let failure: Value = serde_json::from_str(&out.stderr).unwrap();
            let said = failure["message"].as_str().unwrap();
            assert_eq!(
                said,
                format!(
                    "{} /api/issues: Forge at http://{addr} answered, but the body did not arrive whole.",
                    method.to_uppercase()
                )
            );
        }
    }

    #[tokio::test]
    async fn a_chunked_answer_cut_inside_a_chunk_did_not_arrive_whole() {
        let sent: &'static str = Box::leak(format!("{CHUNKED}40\r\n{{\"items\":").into_boxed_str());
        let addr = cut_after(sent).await;
        let c = CoreClient::new(format!("http://{addr}"), "tok".to_string());
        let out = run(&c, &req("issues")).await;
        assert_ne!(out.outcome.exit_code, 0, "{}", out.stderr);
        let failure: Value = serde_json::from_str(&out.stderr).unwrap();
        assert_eq!(
            failure["message"].as_str().unwrap(),
            format!("GET /api/issues: Forge at http://{addr} answered, but the body did not arrive whole.")
        );
    }

    #[tokio::test]
    async fn the_token_and_the_project_slug_are_both_on_the_wire() {
        let (url, rx) = serve_once("200 OK", "{}").await;
        let c = CoreClient::new(url, "device-tok".to_string());
        let mut r = req("issues");
        r.project_slug = Some("forge-dev".into());
        let _ = run(&c, &r).await;
        let sent = rx.await.unwrap();
        assert!(
            sent.contains("authorization: Bearer device-tok")
                || sent.contains("Authorization: Bearer device-tok"),
            "sent: {sent}"
        );
        assert!(
            sent.to_lowercase()
                .contains("x-forge-project-slug: forge-dev"),
            "sent: {sent}"
        );
    }

    #[tokio::test]
    async fn a_body_is_sent_as_json_with_the_method_asked_for() {
        let (url, rx) = serve_once("201 Created", "{}").await;
        let c = CoreClient::new(url, "tok".to_string());
        let mut r = req("issues");
        r.method = "post".into();
        r.body = Some(r#"{"title":"x"}"#.into());
        let out = run(&c, &r).await;
        assert_eq!(out.outcome.exit_code, 0);
        let sent = rx.await.unwrap();
        assert!(sent.starts_with("POST /api/issues"), "sent: {sent}");
        assert!(
            sent.to_lowercase()
                .contains("content-type: application/json"),
            "sent: {sent}"
        );
        assert!(sent.ends_with(r#"{"title":"x"}"#), "sent: {sent}");
    }

    #[tokio::test]
    async fn a_method_that_is_not_a_method_is_a_usage_error_not_a_request() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        let c = CoreClient::new(format!("http://{addr}"), "tok".to_string());
        let mut r = req("issues");
        r.method = "GET POST".into();
        let out = run(&c, &r).await;
        assert_eq!(
            out.outcome.exit_code, 2,
            "a closed port would give 9; usage must be decided first"
        );
        assert!(out.stderr.contains("USAGE"));
    }

    /// The bytes of a PNG header and a few non-UTF-8 bytes, which a lossy decode turns into U+FFFD.
    fn png_like() -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        b.extend((0u8..=255).collect::<Vec<u8>>());
        b
    }

    #[tokio::test]
    async fn a_binary_body_comes_out_byte_for_byte() {
        let sent = png_like();
        let url = serve_bytes_once("image/png", sent.clone()).await;
        let c = CoreClient::new(url, "tok".to_string());
        let r = run(&c, &req("attachments/x/download")).await;
        assert_eq!(r.outcome.exit_code, 0);
        assert_eq!(
            r.stdout, sent,
            "the PNG must not be re-encoded as lossy UTF-8"
        );
        assert!(
            !r.stdout_is_text,
            "a binary body is written without a newline"
        );
    }

    #[tokio::test]
    async fn a_body_that_is_utf8_but_not_text_is_still_bytes() {
        let sent = b"GIF89a plain ascii".to_vec();
        let url = serve_bytes_once("image/gif", sent.clone()).await;
        let c = CoreClient::new(url, "tok".to_string());
        let r = run(&c, &req("attachments/x/download")).await;
        assert_eq!(r.stdout, sent);
        assert!(!r.stdout_is_text);
    }

    #[tokio::test]
    async fn a_body_that_names_no_type_is_bytes_even_when_it_is_utf8() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let _ = sock.read(&mut buf).await;
            let body = b"GIF89a plain ascii";
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(body).await;
            let _ = sock.shutdown().await;
        });
        let c = CoreClient::new(format!("http://{addr}"), "tok".to_string());
        let r = run(&c, &req("attachments/x/download")).await;
        assert_eq!(r.stdout, b"GIF89a plain ascii");
        assert!(
            !r.stdout_is_text,
            "no newline may be added to a body with no declared type"
        );
    }

    #[tokio::test]
    async fn json_and_text_bodies_keep_the_newline_they_always_had() {
        for (kind, body) in [
            ("application/json", "{}"),
            ("text/plain; charset=utf-8", "héllo"),
        ] {
            let url = serve_bytes_once(kind, body.as_bytes().to_vec()).await;
            let c = CoreClient::new(url, "tok".to_string());
            let r = run(&c, &req("issues")).await;
            assert_eq!(r.stdout, body.as_bytes());
            assert!(r.stdout_is_text, "{kind}");
        }
    }
}
