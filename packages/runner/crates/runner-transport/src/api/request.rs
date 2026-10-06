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
    pub stdout: String,
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
                    return Response {
                        stdout: String::new(),
                        stderr,
                        outcome,
                    };
                }
            };
            let (content_type, bytes) = encode(&parts);
            rb = rb.header("Content-Type", content_type).body(bytes);
        }
        None => {}
    }

    let resp = match rb.timeout(crate::LONG_DEADLINE).send().await {
        Ok(r) => r,
        Err(e) => {
            let (outcome, msg) = transport_failure(&req.method, format!("{url}: {e}"));
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
    let outcome = classify(status, crate::status::refusal_code(&text).as_deref());

    if outcome.exit_code == 0 {
        return Response {
            stdout: text,
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
        stdout: String::new(),
        stderr,
        outcome,
    }
}
