//! Build one REST call from CLI arguments, execute it, and report the result
//! through stdout / stderr / exit code.

use serde_json::Value;

use super::exit::{classify, transport_failure, Outcome};
use crate::transport::CoreClient;

/// One `forge-runner api` invocation, already parsed.
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
    pub stdout: String,
    pub stderr: String,
    pub outcome: Outcome,
}

/// `issues` and `/issues` and `/api/issues` all mean the same endpoint.
// cm:why a skill writes the path it read in a route file (`/api/issues`), a human writes the short form; refusing either would make the escape hatch something you have to look up
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
                stdout: String::new(),
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

    // cm:edge contract -> packages/core/src/middleware/require-pat-or-device.ts — the slug header is how a device token, which is not itself scoped to a project, tells core which project the call is for; omit it and every project-scoped route 403s with the token still perfectly valid
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

    let resp = match rb.send().await {
        Ok(r) => r,
        Err(e) => {
            let (outcome, msg) = transport_failure(format!("{url}: {e}"));
            return Response {
                stdout: String::new(),
                stderr: failure_json(&outcome, None, &msg),
                outcome,
            };
        }
    };

    let status = resp.status().as_u16();
    let mut header_dump = String::new();
    if req.include_headers {
        header_dump.push_str(&format!("HTTP {status}\n"));
        for (k, v) in resp.headers() {
            header_dump.push_str(&format!("{k}: {}\n", v.to_str().unwrap_or("<binary>")));
        }
    }
    let text = resp.text().await.unwrap_or_default();
    let outcome = classify(status, body_code(&text).as_deref());

    if outcome.exit_code == 0 {
        return Response {
            stdout: text,
            stderr: header_dump,
            outcome,
        };
    }

    // cm:guard the body goes to STDERR on a failure, never stdout — a skill that does `forge-runner api ... > out.json` and only then checks `$?` must not find an error object sitting where the data was supposed to be. Route it to stdout and a caller that forgets the status check silently parses the error as the answer.
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
        stdout: String::new(),
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
        assert_eq!(r.stdout, r#"{"items":[]}"#);
        assert_eq!(r.stderr, "");
    }

    // cm:guard this is the assertion that keeps `api ... > out.json` honest. Move the error body to `stdout` in `run` and only this goes red — every other test here still passes, because they read the outcome rather than the stream.
    #[tokio::test]
    async fn an_error_body_never_reaches_stdout() {
        let (url, _rx) =
            serve_once("404 Not Found", r#"{"code":"NOT_FOUND","message":"no"}"#).await;
        let c = CoreClient::new(url, "tok".to_string());
        let r = run(&c, &req("issues/nope")).await;
        assert_eq!(
            r.stdout, "",
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
    async fn an_unreachable_core_is_retryable_and_never_zero() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        let c = CoreClient::new(format!("http://{addr}"), "tok".to_string());
        let r = run(&c, &req("issues")).await;
        assert_eq!(r.outcome.exit_code, 9);
        assert!(r.outcome.retryable);
        assert_eq!(r.stdout, "");
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
}
