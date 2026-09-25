//! An HTTP status as a reader can act on it.
//!
//! `reqwest::StatusCode`'s `Display` prints `520 <unknown status code>` for
//! every code outside the IANA registry, which is exactly the family a gateway
//! in front of core answers with. 520, 522 and 525 are three different faults —
//! the origin erred, the origin never answered, the TLS handshake with it
//! failed — and all three printed under that one phrase, which labels as
//! unknown a code the message is already carrying (ISS-1234).

/// The number, then what it means: the registered reason phrase where there is
/// one, the gateway's meaning for the 52x family, and the bare number where
/// neither is known — never a phrase standing in for the number.
pub fn named(code: u16) -> String {
    if let Some(reason) = reqwest::StatusCode::from_u16(code)
        .ok()
        .and_then(|s| s.canonical_reason())
    {
        return format!("{code} {reason}");
    }
    match gateway(code) {
        Some(meaning) => format!("{code} (gateway: {meaning})"),
        None => format!("{code} (no registered name)"),
    }
}

/// The 52x family as the gateway in front of core publishes it. These codes are
/// answered by the edge and never reach core, which is why only the box that
/// received one can say which it was.
fn gateway(code: u16) -> Option<&'static str> {
    Some(match code {
        520 => "the origin returned an unknown error",
        521 => "the origin refused the connection",
        522 => "the connection to the origin timed out",
        523 => "the origin is unreachable",
        524 => "the origin accepted the connection and did not answer in time",
        525 => "the TLS handshake with the origin failed",
        526 => "the origin's TLS certificate was refused",
        530 => "the origin's name could not be resolved",
        _ => return None,
    })
}

/// A response body as one short line: a gateway answers with a whole HTML page,
/// and the status already says what it was.
fn body_line(text: &str) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = one.chars();
    let head: String = chars.by_ref().take(200).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// `<what> <status named>: <body>`, the shape every refused call to core prints.
pub(crate) fn refused(what: &str, status: u16, text: &str) -> String {
    let named = named(status);
    let body = body_line(text);
    if body.is_empty() {
        format!("{what} {named}")
    } else {
        format!("{what} {named}: {body}")
    }
}

/// A call that got no status at all, named by what went wrong and then by the
/// innermost cause the transport gave. `reqwest::Error`'s `Display` is neither:
/// it prints `error sending request for url (<the whole url>)` for a refused
/// connection, a reset and a dead network alike, and drops the source that says
/// which, so three faults read as one phrase with a query string in it — the
/// same shape as the status codes above, one level down (ISS-1234).
pub fn unanswered(e: &reqwest::Error, deadline: std::time::Duration) -> String {
    if e.is_timeout() {
        return format!("timed out after {}", span(deadline));
    }
    let what = if e.is_connect() {
        "could not connect"
    } else if e.is_decode() {
        "the body did not decode"
    } else if e.is_body() {
        "the body did not arrive whole"
    } else if e.is_redirect() {
        "the redirect could not be followed"
    } else {
        "the request failed"
    };
    match innermost(e) {
        Some(cause) => format!("{what}: {cause}"),
        None => what.to_string(),
    }
}

/// The deepest source's own words, which is where the fault is named: hyper
/// and the socket sit under reqwest's wrapper, and the wrapper names the url.
fn innermost(e: &(dyn std::error::Error + 'static)) -> Option<String> {
    let mut deepest = e.source()?;
    while let Some(next) = deepest.source() {
        deepest = next;
    }
    Some(deepest.to_string())
}

fn span(d: std::time::Duration) -> String {
    if d.subsec_millis() == 0 {
        format!("{}s", d.as_secs())
    } else {
        format!("{}ms", d.as_millis())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registered_status_carries_its_registered_phrase() {
        assert_eq!(named(503), "503 Service Unavailable");
        assert_eq!(named(404), "404 Not Found");
    }

    /// Criterion 2. The three codes measured on one project in one afternoon
    /// each read as their own fault.
    #[test]
    fn the_three_gateway_codes_measured_on_iss_1234_each_carry_a_distinct_name() {
        let names: Vec<String> = [520, 522, 525].into_iter().map(named).collect();
        for (code, name) in [520, 522, 525].iter().zip(&names) {
            assert!(name.starts_with(&format!("{code} (gateway: ")), "{name}");
            assert!(!name.contains("unknown status code"), "{name}");
        }
        let distinct: std::collections::BTreeSet<&String> = names.iter().collect();
        assert_eq!(distinct.len(), 3, "{names:?}");
    }

    #[test]
    fn a_code_nobody_names_still_leads_with_its_number() {
        assert_eq!(named(599), "599 (no registered name)");
    }

    /// What this module exists to replace, pinned so the replacement is what
    /// changed and not the dependency: if reqwest ever names these, the test
    /// above still holds and this one says why the table may be dropped.
    #[test]
    fn reqwest_alone_prints_the_phrase_this_replaces() {
        let s = reqwest::StatusCode::from_u16(520).unwrap();
        assert_eq!(s.to_string(), "520 <unknown status code>");
    }
}
