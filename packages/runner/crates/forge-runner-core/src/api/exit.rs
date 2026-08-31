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

/// Printed by `--help`, because an exit code nobody can look up is a number.
// cm:edge contract -> packages/core/src/middleware/error.ts — `statusToCode` is the other half: the `code` in the JSON body comes from there, and these rows map it to a number. A new status handled there with no row here still exits 1, which is the honest default, but the pair should move together.
pub const EXIT_TAXONOMY: &str = "\
EXIT CODES
  0   success (2xx)
  2   usage — bad arguments, or --data that is not JSON
  3   UNAUTHORIZED (401)          not retryable — re-run `forge-runner login`
  4   FORBIDDEN (403)             not retryable
  5   NOT_FOUND (404)             not retryable
  6   client error (400/409/422)  not retryable — the request is wrong
  7   TOO_MANY_REQUESTS (429)     RETRYABLE after a wait
  8   server error (5xx)          RETRYABLE
  9   transport — DNS, connect, TLS, timeout   RETRYABLE
  1   anything else

`retryable` is repeated as JSON on stderr, so a caller can parse the reason
instead of memorising the table.";

/// Map a status to the taxonomy. `body_code` is core's own `code` when the
/// response carried one.
// cm:guard RETRYABLE means "the same request, unchanged, could succeed later" — nothing else. A 409 is a conflict with state the caller must re-read, and a 422 is a request that is wrong; marking either retryable turns a skill's retry loop into a spin that ends in the step's timeout with no new information. Only 429, 5xx and a transport failure qualify.
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

/// A request that never reached core: DNS, connect, TLS, timeout.
pub fn transport_failure(message: impl Into<String>) -> (Outcome, String) {
    (
        Outcome {
            exit_code: 9,
            retryable: true,
            code: "TRANSPORT".to_string(),
        },
        message.into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_is_zero_and_not_retryable() {
        for s in [200u16, 201, 204, 299] {
            let o = classify(s, None);
            assert_eq!(o.exit_code, 0, "status {s}");
            assert!(!o.retryable, "status {s}");
        }
    }

    // cm:guard this is the assertion that stops a skill's retry loop from spinning on a request that can never succeed. Flip 409 or 422 to retryable in `classify` and only this goes red.
    #[test]
    fn only_429_5xx_are_retryable_among_errors() {
        let retryable: Vec<u16> = [400u16, 401, 403, 404, 409, 422, 429, 500, 502, 503]
            .into_iter()
            .filter(|s| classify(*s, None).retryable)
            .collect();
        assert_eq!(retryable, vec![429, 500, 502, 503]);
    }

    #[test]
    fn cores_own_code_wins_over_the_status_derived_one() {
        let o = classify(403, Some("PM_REQUIRES_DEVICE"));
        assert_eq!(o.code, "PM_REQUIRES_DEVICE");
        assert_eq!(o.exit_code, 4);
    }

    #[test]
    fn an_empty_body_code_falls_back_instead_of_reporting_nothing() {
        assert_eq!(classify(404, Some("")).code, "NOT_FOUND");
        assert_eq!(classify(404, None).code, "NOT_FOUND");
    }

    #[test]
    fn a_usage_failure_is_two_and_never_retryable() {
        let (o, line) = usage_failure("--data is not valid JSON");
        assert_eq!(o.exit_code, 2);
        assert!(!o.retryable);
        assert!(line.contains(r#""code":"USAGE""#));
        assert!(line.contains("--data is not valid JSON"));
    }

    #[test]
    fn is_json_accepts_what_core_accepts_and_rejects_a_bare_word() {
        assert!(is_json(r#"{"a":1}"#));
        assert!(is_json("[]"));
        assert!(!is_json("{title: x}"));
        assert!(!is_json(""));
    }

    #[test]
    fn every_documented_exit_code_is_reachable() {
        let reachable: std::collections::BTreeSet<i32> =
            [200u16, 401, 403, 404, 400, 409, 422, 429, 500, 418]
                .into_iter()
                .map(|s| classify(s, None).exit_code)
                .chain(std::iter::once(transport_failure("x").0.exit_code))
                .collect();
        assert_eq!(
            reachable,
            [0, 1, 3, 4, 5, 6, 7, 8, 9].into_iter().collect(),
            "a documented row nothing can produce is a lie in --help"
        );
    }

    // cm:guard the help text and the match arms are one contract read by a human under time pressure; a row that names a code the code never returns is worse than no table.
    #[test]
    fn the_help_table_lists_the_codes_the_matcher_produces() {
        for line_code in [0, 2, 3, 4, 5, 6, 7, 8, 9, 1] {
            assert!(
                EXIT_TAXONOMY.contains(&format!("  {line_code}   ")),
                "exit code {line_code} is produced but absent from EXIT_TAXONOMY"
            );
        }
    }
}
