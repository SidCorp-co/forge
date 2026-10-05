//! HTTP outcome → exit code, and whether trying again could change it.

/// What the caller learns from one `api` invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub exit_code: i32,
    pub retryable: bool,
    /// `{ code }` from the error body when core sent one, else derived from
    /// the status so a proxy's bare 502 still names something.
    pub code: String,
}

pub const EXIT_TAXONOMY: &str = "\
EXIT CODES
  0   success (2xx)
  2   usage — bad arguments, or --data that is not JSON
  3   UNAUTHORIZED (401)          not retryable — the PAT is missing, revoked or
      expired. `forge-runner login --pat <token>`, or export FORGE_PAT.
  4   FORBIDDEN (403)             not retryable
  5   NOT_FOUND (404)             not retryable
  6   client error (400/409/422)  not retryable — the request is wrong
  7   TOO_MANY_REQUESTS (429)     RETRYABLE after a wait
  8   server error (5xx)          RETRYABLE
  9   transport on an idempotent method        RETRYABLE
 10   DELIVERY_UNKNOWN — the connection dropped on a POST or PATCH.
      NOT retryable: the write may already have landed. Read the state back
      before deciding.
  1   anything else

`retryable` is repeated as JSON on stderr, so a caller can parse the reason
instead of memorising the table.";

pub fn classify(status: u16, body_code: Option<&str>) -> Outcome {
    let code = body_code
        .filter(|c| !c.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| derive_code(status));
    let (exit_code, retryable) = match status {
        200..=299 => (0, false),
        401 => (3, false),
        403 => (4, false),
        404 => (5, false),
        400 | 409 | 422 => (6, false),
        429 => (7, true),
        500..=599 => (8, true),
        _ => (1, false),
    };
    Outcome {
        exit_code,
        retryable,
        code,
    }
}

fn derive_code(status: u16) -> String {
    match status {
        400 => "BAD_REQUEST",
        401 => "UNAUTHORIZED",
        403 => "FORBIDDEN",
        404 => "NOT_FOUND",
        409 => "CONFLICT",
        422 => "UNPROCESSABLE_ENTITY",
        429 => "TOO_MANY_REQUESTS",
        s if s >= 500 => "INTERNAL_ERROR",
        _ => "ERROR",
    }
    .to_string()
}

/// A caller mistake, decided before anything is sent. Returns the stderr line.
pub fn usage_failure(message: &str) -> (Outcome, String) {
    let outcome = Outcome {
        exit_code: 2,
        retryable: false,
        code: "USAGE".to_string(),
    };
    let line = serde_json::json!({
        "code": outcome.code,
        "message": message,
        "retryable": outcome.retryable,
        "exitCode": outcome.exit_code,
    })
    .to_string();
    (outcome, line)
}

/// Is this a JSON document core could parse?
pub fn is_json(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body).is_ok()
}

pub fn transport_failure(method: &str, message: impl Into<String>) -> (Outcome, String) {
    let idempotent = matches!(
        method.to_uppercase().as_str(),
        "GET" | "HEAD" | "PUT" | "DELETE" | "OPTIONS" | "TRACE"
    );
    let outcome = if idempotent {
        Outcome {
            exit_code: 9,
            retryable: true,
            code: "TRANSPORT".to_string(),
        }
    } else {
        Outcome {
            exit_code: 10,
            retryable: false,
            code: "DELIVERY_UNKNOWN".to_string(),
        }
    };
    (outcome, message.into())
}
