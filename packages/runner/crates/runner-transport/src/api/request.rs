//! Build one REST call from CLI arguments, execute it, and report the result
//! through stdout / stderr / exit code.

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
    for (k, v) in &req.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    match &req.body {
        Some(Body::Json(json)) => {
            rb = rb
                .header("Content-Type", "application/json")
                .body(json.clone());
        }
        Some(Body::Form(fields)) => {
            let parts = match read_parts(fields) {
                Ok(parts) => parts,
                Err(message) => {
                    let (outcome, stderr) = usage_failure(&message);
                    return Response::failed(stderr, outcome);
                }
            };
            let (content_type, bytes) = encode(&parts);
            rb = rb.header("Content-Type", content_type).body(bytes);
        }
        None => {}
    }

    let resp = match rb.send().await {
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

    #[test]
    fn a_json_body_ends_in_exactly_one_newline() {
        assert_eq!(ok(br#"{"a":1}"#, true).printed(), b"{\"a\":1}\n".to_vec());
        assert_eq!(ok(b"{}\n", true).printed(), b"{}\n".to_vec());
        assert!(ok(b"", true).printed().is_empty());
    }
}
