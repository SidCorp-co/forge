//! An HTTP status as a reader can act on it.
//!
//! `reqwest::StatusCode`'s `Display` prints `520 <unknown status code>` for
//! every code outside the IANA registry, which is exactly the family a gateway
//! in front of core answers with. 520, 522 and 525 are three different faults —
//! the origin erred, the origin never answered, the TLS handshake with it
//! failed — and all three printed under that one phrase, which labels as
//! unknown a code the message is already carrying (ISS-1234).

use reqwest::{RequestBuilder, Response};
use runner_platform::error::{Error, Result};
use serde::de::DeserializeOwned;

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

/// A response body as one short line. A gateway answers with a whole HTML page
/// whose markup says nothing the status has not, so a page is said as what it
/// is — its title, or its size where it has none — rather than pasted.
pub(crate) fn body_line(text: &str) -> String {
    html_page(text).unwrap_or_else(|| one_line(text))
}

/// `Some` where `text` is an HTML document: past any leading comments it opens
/// with a doctype or an `<html` element. Case is ignored, and a mention of
/// `<html` anywhere else — inside a comment, after other text — is not one.
fn html_page(text: &str) -> Option<String> {
    let page = text.trim_start();
    // ASCII lowercasing keeps every byte where it was, so an offset found in
    // `lower` indexes `page` too.
    let lower = page.to_ascii_lowercase();
    if !opens_a_document(&lower) {
        return None;
    }
    let title = lower
        .find("<title")
        .and_then(|open| {
            let start = open + lower[open..].find('>')? + 1;
            let end = start + lower[start..].find("</title")?;
            Some(one_line(&page[start..end]))
        })
        .filter(|t| !t.is_empty());
    Some(match title {
        Some(t) => format!("an HTML page titled \"{t}\""),
        None => format!("an HTML page ({} bytes)", text.len()),
    })
}

fn opens_a_document(lower: &str) -> bool {
    let mut rest = lower.trim_start();
    while let Some(comment) = rest.strip_prefix("<!--") {
        let Some(end) = comment.find("-->") else {
            return false;
        };
        rest = comment[end + 3..].trim_start();
    }
    rest.starts_with("<!doctype")
        || rest.strip_prefix("<html").is_some_and(|after| {
            after
                .chars()
                .next()
                .is_some_and(|c| c == '>' || c == '/' || c.is_whitespace())
        })
}

/// Whitespace collapsed and cut at 200 characters.
fn one_line(text: &str) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = one.chars();
    let head: String = chars.by_ref().take(200).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// The code a refusal names. Core's problem body carries it at the top level
/// and under `error.code`, the two always equal
/// (`contracts/src/refusal.ts:ProblemBody`); either is read, so a core from
/// before or after that envelope answers. Anything else (a proxy's HTML 502,
/// an empty body) yields `None` and the caller decides by status alone.
pub(crate) fn refusal_code(body: &str) -> Option<String> {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok()?;
    parsed
        .get("code")
        .or_else(|| parsed.pointer("/error/code"))?
        .as_str()
        .map(str::to_string)
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

/// `req` sent; a call that got no answer is `<what>: <the transport's words>`.
pub(crate) async fn sent(req: RequestBuilder, what: &str) -> Result<Response> {
    req.send()
        .await
        .map_err(|e| Error::Other(format!("{what}: {e}")))
}

/// `req` sent within `deadline` and [`checked`]; one that got no answer is
/// `<what> request: <what went wrong>`, as [`unanswered`] names it.
pub(crate) async fn send_within(
    req: RequestBuilder,
    what: &str,
    deadline: std::time::Duration,
) -> Result<Response> {
    let resp = req
        .timeout(deadline)
        .send()
        .await
        .map_err(|e| Error::Other(format!("{what} request: {}", unanswered(&e, deadline))))?;
    checked(resp, what).await
}

/// A `401` as [`Error::Unauthorized`], any other non-2xx as the sentence
/// [`refused`] composes, and a 2xx handed back to be read.
pub(crate) async fn checked(resp: Response, what: &str) -> Result<Response> {
    let code = resp.status().as_u16();
    if code == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(refused(what, code, &text)));
    }
    Ok(resp)
}

/// A 2xx body read as `T`, or `<what> decode: <why not>`.
pub(crate) async fn decode<T: DeserializeOwned>(resp: Response, what: &str) -> Result<T> {
    resp.json()
        .await
        .map_err(|e| Error::Other(format!("{what} decode: {e}")))
}

/// Send, check and decode, every failure named by `what`.
pub(crate) async fn fetch<T: DeserializeOwned>(req: RequestBuilder, what: &str) -> Result<T> {
    let resp = checked(sent(req, &format!("{what} request")).await?, what).await?;
    decode(resp, what).await
}

/// [`fetch`] within `deadline`.
pub(crate) async fn fetch_within<T: DeserializeOwned>(
    req: RequestBuilder,
    what: &str,
    deadline: std::time::Duration,
) -> Result<T> {
    decode(send_within(req, what, deadline).await?, what).await
}

/// The constraints a refusal names, where it names any.
///
/// Core answers a body no validator accepts with `400` in the refusal envelope,
/// one row per violated rule under `error.refusals`, each at a JSON pointer
/// into the request (`lib/refusal.ts:requestRefusals`). A core from before
/// ISS-186 answers `z.flattenError` under `details` instead, as
/// `details.fieldErrors.<field>` or `details.formErrors`, and both are read
/// until every core this runner pairs with serves the envelope. Either is a
/// statement about the bytes that were sent and not about the moment they
/// were sent in: a caller re-sending them is refused exactly as it was the
/// first time, which is how one run spent 240 attempts on one declaration
/// (ISS-1284).
///
/// The test is what the answer NAMES rather than the code it carries. A
/// refusal with no constraint in it leaves a caller nothing to print and
/// nothing to act on, so it keeps whatever retry it has rather than being
/// guessed terminal; a `409` or a `5xx` names the world instead of the payload
/// and is not asked about here at all.
pub(crate) fn constraints(status: u16, body: &str) -> Option<Vec<String>> {
    if status != 400 {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let mut named = Vec::new();
    for row in parsed
        .pointer("/error/refusals")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let Some(text) = row.get("detail").and_then(|v| v.as_str()) else {
            continue;
        };
        match row.get("path").and_then(|v| v.as_str()).unwrap_or_default() {
            "" => named.push(format!("the request itself: {text}")),
            path => named.push(format!("{}: {text}", path.trim_start_matches('/'))),
        }
    }
    if let Some(details) = parsed.get("details") {
        if let Some(fields) = details.get("fieldErrors").and_then(|v| v.as_object()) {
            for (field, said) in fields {
                for one in said.as_array().into_iter().flatten() {
                    if let Some(text) = one.as_str() {
                        named.push(format!("{field}: {text}"));
                    }
                }
            }
        }
        for one in details
            .get("formErrors")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            if let Some(text) = one.as_str() {
                named.push(format!("the request itself: {text}"));
            }
        }
    }
    (!named.is_empty()).then_some(named)
}

/// A refused call as the error its caller acts on: `Malformed` where the answer
/// names a constraint the same bytes can never satisfy, `Other` otherwise.
/// Both print the sentence `refused` composes, so a caller that only prints it
/// reads the same line either way.
pub(crate) fn refusal(what: &str, status: u16, text: &str) -> Error {
    let said = refused(what, status, text);
    if let Some(named) = constraints(status, text) {
        return Error::Malformed { said, named };
    }
    match held_code(status, text) {
        Some(code) => Error::Held { said, code },
        None => Error::Other(said),
    }
}

/// The take refusals core answers `422` for when something holds the issues a run is
/// declared over (`run-session-queued.ts:QUEUED_BEHIND`, the refusals a declared run
/// waits behind). Each lifts when the holder moves, never because the same bytes were sent again.
pub const HELD_CODES: &[&str] = &[
    "ISSUE_BLOCKED",
    "WORKFLOW_DESIGN_NOT_APPROVED",
    "CONTRACT_WAIT_UNSETTLED",
    "ISSUE_LEASE_HELD",
];

/// The held code a `422` carries, read off the envelope's own code or the first of its
/// refusals that names one.
pub(crate) fn held_code(status: u16, body: &str) -> Option<String> {
    if status != 422 {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let top = parsed.pointer("/error/code").and_then(|v| v.as_str());
    let rows = parsed
        .pointer("/error/refusals")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|r| r.get("code").and_then(|v| v.as_str()));
    top.into_iter()
        .chain(rows)
        .find(|c| HELD_CODES.contains(c))
        .map(str::to_string)
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
mod held_tests {
    use super::*;

    const BLOCKED: &str = r#"{"error":{"code":"ISSUE_BLOCKED","refusals":[{"code":"ISSUE_BLOCKED","path":"","detail":"a run session over these issues is refused. ISS-46: a live blocks edge holds it"}]}}"#;

    #[test]
    fn a_422_naming_a_hold_is_held_with_its_code() {
        match refusal("run-session open", 422, BLOCKED) {
            Error::Held { code, said } => {
                assert_eq!(code, "ISSUE_BLOCKED");
                assert!(said.contains("ISS-46"), "{said}");
            }
            other => panic!("a held refusal was read as {other:?}"),
        }
    }

    #[test]
    fn other_422s_and_other_statuses_are_not_held() {
        let other = r#"{"error":{"code":"RUN_SESSION_REFUSED","refusals":[{"code":"WHATEVER","path":"/x","detail":"d"}]}}"#;
        assert!(matches!(refusal("o", 422, other), Error::Other(_)));
        assert!(matches!(refusal("o", 503, BLOCKED), Error::Other(_)));
        assert!(matches!(refusal("o", 422, "not json"), Error::Other(_)));
    }
}
