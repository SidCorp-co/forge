//! Build one REST call from CLI arguments, execute it, and report the result
//! through stdout / stderr / exit code.

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::RequestBuilder;
use serde_json::Value;

use crate::api::exit::{classify, transport_failure, usage_failure, Outcome};
use crate::api::form::{encode, read_parts, FormField};
use crate::CoreClient;

/// What a request carries: JSON text, or form fields whose files are read when it is sent.
#[derive(Debug, PartialEq, Eq)]
pub enum Body {
    Json(String),
    Form(Vec<FormField>),
}

/// One `forge-runner api` invocation, already parsed.
#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub body: Option<Body>,
    pub project_slug: Option<String>,
    pub headers: Vec<(String, String)>,
    /// Print the status line and response headers to stderr.
    pub include_headers: bool,
}

/// What `run` produced, so the caller can print it and pick an exit code.
pub struct Response {
    /// The response body exactly as core sent it: an attachment downloaded
    /// through here is bytes, and a `String` would have replaced any that are
    /// not UTF-8.
    pub stdout: Vec<u8>,
    /// Whether core said the body is JSON.
    pub json: bool,
    pub stderr: String,
    pub outcome: Outcome,
}

impl Response {
    fn failed(stderr: String, outcome: Outcome) -> Self {
        Self {
            stdout: Vec::new(),
            json: false,
            stderr,
            outcome,
        }
    }

    /// What `forge-runner api` writes to stdout: the body byte for byte, with
    /// a newline after a JSON body that does not end in one, so a terminal
    /// prompt does not run on after it. Any other body — a download — gets
    /// nothing added, or the file a caller saves is not the file uploaded.
    pub fn printed(&self) -> Vec<u8> {
        let mut out = self.stdout.clone();
        if self.json && !out.is_empty() && !out.ends_with(b"\n") {
            out.push(b'\n');
        }
        out
    }
}

pub fn normalize_path(path: &str) -> String {
    let p = path.trim();
    if p.starts_with("/api/") || p == "/api" {
        return p.to_string();
    }
    let rest = p.strip_prefix('/').unwrap_or(p);
    format!("/api/{rest}")
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

/// The caller's `-H` headers as one map, a name given twice keeping both values. A name or value no
/// HTTP header can carry is refused here, by name, rather than failing the send as a transport
/// error; the value is never echoed, since a header may carry a secret.
fn caller_headers(headers: &[(String, String)]) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        let name = HeaderName::from_bytes(k.as_bytes())
            .map_err(|_| format!("-H `{k}` is not a valid header name"))?;
        let value = HeaderValue::from_str(v)
            .map_err(|_| format!("-H `{k}` carries a value no HTTP header can hold"))?;
        map.append(name, value);
    }
    Ok(map)
}

/// The body, with the Content-Type the runner writes for it unless the caller names one.
fn with_body(rb: RequestBuilder, body: Option<&Body>) -> Result<RequestBuilder, String> {
    Ok(match body {
        Some(Body::Json(json)) => rb
            .header(CONTENT_TYPE, "application/json")
            .body(json.clone()),
        Some(Body::Form(fields)) => {
            let (content_type, bytes) = encode(&read_parts(fields)?);
            rb.header(CONTENT_TYPE, content_type).body(bytes)
        }
        None => rb,
    })
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
            return Response::failed(failure_json(&outcome, None, &msg), outcome);
        }
    };

    let path = normalize_path(&req.path);
    let url = client.url(&path);
    let mut rb = client.request(method, &path);

    if let Some(slug) = &req.project_slug {
        rb = rb.header("X-Forge-Project-Slug", slug.as_str());
    }
    // The runner's own headers first, the caller's last and as one map: `headers` replaces each
    // name it carries where `header` appends, so a caller's `-H Content-Type` beside `-d` went out
    // twice and core refused the call 415 (ISS-593).
    let applied = caller_headers(&req.headers)
        .and_then(|caller| with_body(rb, req.body.as_ref()).map(|rb| rb.headers(caller)));
    let rb = match applied {
        Ok(rb) => rb,
        Err(message) => {
            let (outcome, stderr) = usage_failure(&message);
            return Response::failed(stderr, outcome);
        }
    };

    let resp = match rb.timeout(crate::LONG_DEADLINE).send().await {
        Ok(r) => r,
        Err(e) => {
            let (outcome, msg) = transport_failure(&req.method, format!("{url}: {e}"));
            return Response::failed(failure_json(&outcome, None, &msg), outcome);
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
    let json = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.to_ascii_lowercase().contains("json"));
    let body = resp.bytes().await.map(|b| b.to_vec()).unwrap_or_default();
    let text = String::from_utf8_lossy(&body);
    let outcome = classify(status, crate::status::refusal_code(&text).as_deref());

    if outcome.exit_code == 0 {
        return Response {
            stdout: body,
            json,
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
    Response::failed(stderr, outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(stdout: &[u8], json: bool) -> Response {
        Response {
            stdout: stdout.to_vec(),
            json,
            stderr: String::new(),
            outcome: Outcome {
                exit_code: 0,
                retryable: false,
                code: "OK".into(),
            },
        }
    }

    #[test]
    fn a_download_is_printed_byte_for_byte_with_nothing_added() {
        let bytes = [0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x80, b'x'];
        assert_eq!(ok(&bytes, false).printed(), bytes.to_vec());
        assert_eq!(ok(b"plain text", false).printed(), b"plain text".to_vec());
        assert!(ok(b"", false).printed().is_empty());
    }

    /// A core on a loopback port that answers `200 {}` and hands back the request head it read.
    async fn recording_core() -> (CoreClient, tokio::sync::oneshot::Receiver<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 4096];
            while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = sock.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                seen.extend_from_slice(&buf[..n]);
            }
            let reply = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}";
            let _ = sock.write_all(reply).await;
            let head = String::from_utf8_lossy(&seen)
                .split("\r\n\r\n")
                .next()
                .unwrap_or("")
                .to_string();
            let _ = tx.send(head);
        });
        (
            CoreClient::new(format!("http://{addr}"), "device-token"),
            rx,
        )
    }

    /// Every value of header `name` in a request head, the name matched in any letter case.
    fn values_of(head: &str, name: &str) -> Vec<String> {
        head.lines()
            .skip(1)
            .filter_map(|l| l.split_once(':'))
            .filter(|(k, _)| k.trim().eq_ignore_ascii_case(name))
            .map(|(_, v)| v.trim().to_string())
            .collect()
    }

    fn call(body: Option<Body>, headers: &[(&str, &str)]) -> Request {
        Request {
            method: "POST".into(),
            path: "issues/x/comments".into(),
            body,
            project_slug: Some("forge".into()),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            include_headers: false,
        }
    }

    async fn sent_head(req: Request) -> String {
        let (client, head) = recording_core().await;
        let resp = run(&client, &req).await;
        assert_eq!(resp.outcome.exit_code, 0, "{}", resp.stderr);
        head.await.unwrap()
    }

    #[tokio::test]
    async fn a_callers_content_type_replaces_the_default_in_any_letter_case() {
        for name in ["Content-Type", "content-type", "CONTENT-TYPE"] {
            let json = Some(Body::Json("{}".into()));
            let head = sent_head(call(json, &[(name, "application/json")])).await;
            assert_eq!(
                values_of(&head, "content-type"),
                vec!["application/json"],
                "-H `{name}` with -d went out beside the default:\n{head}"
            );
        }
        let json = Some(Body::Json("{}".into()));
        let head = sent_head(call(
            json,
            &[("Content-Type", "application/merge-patch+json")],
        ))
        .await;
        assert_eq!(
            values_of(&head, "content-type"),
            vec!["application/merge-patch+json"]
        );
    }

    #[tokio::test]
    async fn a_callers_header_replaces_the_runners_own_of_that_name() {
        let head = sent_head(call(None, &[("x-forge-project-slug", "hop")])).await;
        assert_eq!(values_of(&head, "x-forge-project-slug"), vec!["hop"]);
        let head = sent_head(call(None, &[("X-Trace", "a"), ("X-Trace", "b")])).await;
        assert_eq!(values_of(&head, "x-trace"), vec!["a", "b"]);
        assert_eq!(
            values_of(&head, "authorization"),
            vec!["Bearer device-token"]
        );
    }

    #[tokio::test]
    async fn a_body_with_no_caller_content_type_carries_exactly_one_default() {
        let head = sent_head(call(Some(Body::Json("{}".into())), &[])).await;
        assert_eq!(values_of(&head, "content-type"), vec!["application/json"]);
        let form = Body::Form(vec![FormField::Text {
            name: "note".into(),
            value: "x".into(),
        }]);
        let head = sent_head(call(Some(form), &[("X-Trace", "a")])).await;
        let types = values_of(&head, "content-type");
        assert_eq!(types.len(), 1, "{head}");
        assert!(
            types[0].starts_with("multipart/form-data; boundary="),
            "{head}"
        );
        let head = sent_head(call(None, &[])).await;
        assert!(values_of(&head, "content-type").is_empty(), "{head}");
    }

    #[tokio::test]
    async fn a_header_no_http_request_can_carry_is_refused_by_name_without_its_value() {
        let client = CoreClient::new("http://127.0.0.1:9", "device-token");
        let resp = run(&client, &call(None, &[("Bad Name", "x")])).await;
        assert_eq!(resp.outcome.exit_code, 2, "{}", resp.stderr);
        assert!(resp
            .stderr
            .contains("-H `Bad Name` is not a valid header name"));
        let resp = run(&client, &call(None, &[("X-Key", "s3cret\u{7f}")])).await;
        assert_eq!(resp.outcome.exit_code, 2, "{}", resp.stderr);
        assert!(resp.stderr.contains("-H `X-Key` carries a value"));
        assert!(!resp.stderr.contains("s3cret"), "{}", resp.stderr);
    }

    #[test]
    fn a_json_body_ends_in_exactly_one_newline() {
        assert_eq!(ok(br#"{"a":1}"#, true).printed(), b"{\"a\":1}\n".to_vec());
        assert_eq!(ok(b"{}\n", true).printed(), b"{}\n".to_vec());
        assert!(ok(b"", true).printed().is_empty());
    }
}
