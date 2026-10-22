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

/// A response body as one short line. A gateway answers with a whole HTML page
/// whose markup says nothing the status has not, so a page is said as what it
/// is — its title, or its size where it has none — rather than pasted.
fn body_line(text: &str) -> String {
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

/// The code core's not-found handler answers a route it does not serve under;
/// a missing record answers `NOT_FOUND` or a code of its own instead. Read off
/// the code, never off the sentence beside it, which is worded for a person
/// (ISS-1421 r15, r16).
pub const ROUTE_ABSENT: &str = "ROUTE_ABSENT";

/// Whether an answer is core saying it serves no such route: a `404` whose
/// JSON body carries the `ROUTE_ABSENT` code.
pub fn route_absent(status: u16, body: &str) -> bool {
    status == 404
        && serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|parsed| parsed.get("code")?.as_str().map(|c| c == ROUTE_ABSENT))
            .unwrap_or(false)
}

/// What a door says when core serves no route for it: the door, then that the
/// route is missing, which an upgrade of core or of this box settles.
pub(crate) fn absent(what: &str, text: &str) -> String {
    format!(
        "{what}: core serves no such route, so its version and this box's do not match ({})",
        body_line(text)
    )
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

/// The constraints a refusal names, where it names any.
///
/// Core validates every device body with zod and answers `z.flattenError`
/// under `details` (`devices/route-errors.ts:badRequest`), so a violated rule
/// arrives as `details.fieldErrors.<field>` or as `details.formErrors`. That is
/// a statement about the bytes that were sent and not about the moment they
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
    let details = parsed.get("details")?;
    let mut named = Vec::new();
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
    (!named.is_empty()).then_some(named)
}

/// A refused call as the error its caller acts on: `Malformed` where the answer
/// names a constraint the same bytes can never satisfy, `Other` otherwise.
/// Both print the sentence `refused` composes, so a caller that only prints it
/// reads the same line either way.
pub(crate) fn refusal(what: &str, status: u16, text: &str) -> crate::error::Error {
    let said = refused(what, status, text);
    match constraints(status, text) {
        Some(named) => crate::error::Error::Malformed { said, named },
        None => crate::error::Error::Other(said),
    }
}

/// A call core never answered, or answered with a body this box could not
/// read, said for whoever reads the box's log or its terminal: where Forge was
/// sought, why it was not reached in words, and what to check. reqwest's own
/// `error sending request for url (…)` named none of the three (ISS-1421 r20),
/// and every call that cannot reach core says it this one way (ISS-1421 r21).
pub fn not_reached(what: &str, e: &reqwest::Error) -> crate::error::Error {
    crate::error::Error::Other(not_reached_words(what, e, None))
}

/// [`not_reached`], for a call made under `deadline`, which a timeout names.
pub fn not_reached_within(
    what: &str,
    e: &reqwest::Error,
    deadline: std::time::Duration,
) -> crate::error::Error {
    crate::error::Error::Other(not_reached_words(what, e, Some(deadline)))
}

/// The sentence [`not_reached`] says, for a caller that keeps a reason rather
/// than an error.
pub fn not_reached_words(
    what: &str,
    e: &reqwest::Error,
    deadline: Option<std::time::Duration>,
) -> String {
    format!("{what}: {}", not_reached_sentence(e, deadline))
}

/// Where Forge was sought, why it was not reached and what to check, for a
/// caller that names the call itself.
pub fn not_reached_sentence(e: &reqwest::Error, deadline: Option<std::time::Duration>) -> String {
    let at = e
        .url()
        .map(origin)
        .unwrap_or_else(|| "the core address".to_string());
    let within = |d: Option<std::time::Duration>| match d {
        Some(d) => format!("within {}", span(d)),
        None => "in time".to_string(),
    };
    if e.is_decode() || e.is_body() {
        // A body's error carries no url, so the address is named only where it is known.
        let who = e
            .url()
            .map(|u| format!("Forge at {}", origin(u)))
            .unwrap_or_else(|| "Forge".to_string());
        return if e.is_timeout() {
            format!(
                "{who} answered, but the rest of its answer did not come {}.",
                within(deadline)
            )
        } else {
            format!("{who} answered, but {}.", unread_body(e))
        };
    }
    let why = if e.is_timeout() {
        format!("no answer came {}", within(deadline))
    } else {
        why_not_reached(e)
    };
    not_reached_at(&at, &why)
}

/// The one sentence for a call that reached nothing, whatever carried it: an HTTP call, or the
/// daemon's live connection, whose own error said only "Connection refused (os error 111)" with no
/// address (ISS-1421 r22).
pub fn not_reached_at(at: &str, why: &str) -> String {
    format!(
        "Forge could not be reached at {at}, as {why}. Check that core is running there and that \
         this box's core address is right."
    )
}

/// The core address a url was derived from, as this box's configuration names it: the live
/// connection's `ws(s)://` is the core address `http(s)://` with its scheme swapped, and the person
/// reading the line compares it with the address they configured.
pub fn core_origin(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(parsed) => {
            let said = origin(&parsed);
            if let Some(rest) = said.strip_prefix("wss://") {
                format!("https://{rest}")
            } else if let Some(rest) = said.strip_prefix("ws://") {
                format!("http://{rest}")
            } else {
                said
            }
        }
        Err(_) => url.to_string(),
    }
}

/// A reason closed with one full stop, for a line that goes on after it. The not-reached sentence
/// already ends with one, and a line appending its own printed "right.. Whether" (ISS-1421 r22).
pub fn ended(reason: &str) -> String {
    let reason = reason.trim_end();
    if reason.ends_with(['.', '?', '!']) {
        reason.to_string()
    } else {
        format!("{reason}.")
    }
}

/// Why an answer that arrived could not be read, with the cause the transport gave.
fn unread_body(e: &reqwest::Error) -> String {
    let what = if e.is_decode() {
        "the body did not decode"
    } else {
        "the body did not arrive whole"
    };
    match innermost(e) {
        Some(cause) => format!("{what}: {cause}"),
        None => what.to_string(),
    }
}

/// The scheme, host and port of a url: where Forge was sought, without the
/// route or query the call carried.
fn origin(url: &reqwest::Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{}://{host}:{port}", url.scheme()),
        (Some(host), None) => format!("{}://{host}", url.scheme()),
        _ => url.to_string(),
    }
}

/// Why a call reached nothing, in words.
pub(crate) fn why_not_reached(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "no answer came in time".to_string();
    }
    reached_nothing_because(e, e.is_connect()).to_string()
}

/// Why a cause chain reached nothing. The socket's own `io::ErrorKind` decides
/// where one is in the chain, so every OS reads alike: Windows words a refusal
/// as os error 10061, "No connection could be made…", where Linux says
/// "Connection refused". A name lookup or a certificate carries no kind of its
/// own, so those are read off the deepest cause's words.
pub(crate) fn reached_nothing_because(
    e: &(dyn std::error::Error + 'static),
    connect: bool,
) -> &'static str {
    use std::io::ErrorKind;
    let mut at = Some(e);
    while let Some(err) = at {
        if let Some(io) = err.downcast_ref::<std::io::Error>() {
            match io.kind() {
                ErrorKind::ConnectionRefused => return "the connection was refused",
                ErrorKind::ConnectionReset
                | ErrorKind::ConnectionAborted
                | ErrorKind::BrokenPipe => return "the connection was cut",
                ErrorKind::TimedOut => return "no answer came in time",
                _ => {}
            }
        }
        at = err.source();
    }
    let cause = innermost(e).unwrap_or_default().to_lowercase();
    if cause.contains("dns")
        || cause.contains("lookup")
        || cause.contains("name or service not known")
        || cause.contains("no such host")
        || cause.contains("nodename nor servname")
    {
        "its host name does not resolve"
    } else if cause.contains("certificate") || cause.contains("tls") || cause.contains("ssl") {
        "its certificate was not accepted"
    } else if connect {
        "no connection could be made"
    } else {
        "the request failed"
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

    /// Criterion 223: a reason that already ends a sentence is not given a second full stop.
    #[test]
    fn a_reason_is_closed_with_one_full_stop() {
        let sentence = not_reached_at("http://127.0.0.1:9", "the connection was refused");
        assert_eq!(ended(&sentence), sentence);
        assert!(!format!("{} Whether", ended(&sentence)).contains(".."));
        assert_eq!(ended("core could not be asked"), "core could not be asked.");
        assert_eq!(ended("was it asked? "), "was it asked?");
    }

    /// Criterion 214: the live connection names the core address the box configured, not the
    /// socket's scheme.
    #[test]
    fn the_live_connection_names_the_core_address() {
        assert_eq!(
            core_origin("wss://forge.example/ws"),
            "https://forge.example"
        );
        assert_eq!(core_origin("ws://127.0.0.1:9/ws"), "http://127.0.0.1:9");
        assert_eq!(
            core_origin("http://127.0.0.1:9/api/x"),
            "http://127.0.0.1:9"
        );
    }

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

    /// Criterion 19 (ISS-1235): a gateway's page is said by its title, not
    /// pasted into the line an operator reads.
    #[test]
    fn a_gateway_page_is_said_by_its_title_rather_than_pasted() {
        let page = "<!DOCTYPE html>\n<!--[if lt IE 7]> <html class=\"no-js ie6\"> <![endif]-->\n<head>\n<title>forge-beta-api.sidcorp.co | 520: Web server is returning an unknown error</title>\n<meta charset=\"UTF-8\" /></head><body>error code: 520</body></html>";
        let said = refused("me/mcp-servers", 520, page);
        assert_eq!(
            said,
            "me/mcp-servers 520 (gateway: the origin returned an unknown error): an HTML page titled \"forge-beta-api.sidcorp.co | 520: Web server is returning an unknown error\""
        );
        assert!(!said.contains('<'), "no markup reaches the line: {said}");
    }

    #[test]
    fn a_page_with_no_title_is_said_by_its_size() {
        let page = "  <HTML><body>error code: 525</body></HTML>";
        assert_eq!(
            body_line(page),
            format!("an HTML page ({} bytes)", page.len())
        );
        assert_eq!(
            body_line("<html><head><title>  </title></head></html>"),
            "an HTML page (43 bytes)",
            "a blank title is no title"
        );
    }

    /// The boundary: a body that is not a document is still carried as it
    /// was, a JSON refusal and a line that merely mentions a tag included.
    #[test]
    fn a_body_that_is_not_a_page_is_carried_as_it_was() {
        assert_eq!(
            body_line(r#"{"error":"device not bound"}"#),
            r#"{"error":"device not bound"}"#
        );
        assert_eq!(
            body_line("refused: expected <html> nowhere"),
            "refused: expected <html> nowhere"
        );
        assert_eq!(body_line("<p>not a document</p>"), "<p>not a document</p>");
        assert_eq!(
            body_line("<!-- diagnostic mentions <html --> connection refused"),
            "<!-- diagnostic mentions <html --> connection refused",
            "a comment naming the tag opens no document"
        );
        assert_eq!(
            body_line("<htmlish>refused</htmlish>"),
            "<htmlish>refused</htmlish>"
        );
    }

    #[test]
    fn a_page_behind_leading_comments_is_still_a_page() {
        assert_eq!(
            body_line("<!-- edge --> <html><head><title>Bad gateway</title></head></html>"),
            "an HTML page titled \"Bad gateway\""
        );
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

    /// Every module in `transport/`, so the guard below measures the directory
    /// and not the handful of files somebody remembered.
    ///
    /// `status` is the implementation of the rule and `fake_core` is a test
    /// double that writes wire responses, where `HTTP/1.1 {status}` is the
    /// protocol rather than a refusal a person reads.
    static SOURCES: std::sync::LazyLock<[(&str, &str); 21]> = std::sync::LazyLock::new(|| {
        [
            (
                "admissible.rs",
                crate::test_scratch::lf(include_str!("admissible.rs")),
            ),
            (
                "agent_sessions.rs",
                crate::test_scratch::lf(include_str!("agent_sessions.rs")),
            ),
            (
                "events.rs",
                crate::test_scratch::lf(include_str!("events.rs")),
            ),
            (
                "frames.rs",
                crate::test_scratch::lf(include_str!("frames.rs")),
            ),
            (
                "git_credential.rs",
                crate::test_scratch::lf(include_str!("git_credential.rs")),
            ),
            (
                "heartbeat.rs",
                crate::test_scratch::lf(include_str!("heartbeat.rs")),
            ),
            (
                "inbox.rs",
                crate::test_scratch::lf(include_str!("inbox.rs")),
            ),
            (
                "lifecycle.rs",
                crate::test_scratch::lf(include_str!("lifecycle.rs")),
            ),
            (
                "master.rs",
                crate::test_scratch::lf(include_str!("master.rs")),
            ),
            (
                "mcp_servers.rs",
                crate::test_scratch::lf(include_str!("mcp_servers.rs")),
            ),
            ("mod.rs", crate::test_scratch::lf(include_str!("mod.rs"))),
            (
                "plugins.rs",
                crate::test_scratch::lf(include_str!("plugins.rs")),
            ),
            ("pool.rs", crate::test_scratch::lf(include_str!("pool.rs"))),
            (
                "protections.rs",
                crate::test_scratch::lf(include_str!("protections.rs")),
            ),
            (
                "provision.rs",
                crate::test_scratch::lf(include_str!("provision.rs")),
            ),
            (
                "questions.rs",
                crate::test_scratch::lf(include_str!("questions.rs")),
            ),
            (
                "run_sessions.rs",
                crate::test_scratch::lf(include_str!("run_sessions.rs")),
            ),
            (
                "runners.rs",
                crate::test_scratch::lf(include_str!("runners.rs")),
            ),
            (
                "session_ledger.rs",
                crate::test_scratch::lf(include_str!("session_ledger.rs")),
            ),
            (
                "skills.rs",
                crate::test_scratch::lf(include_str!("skills.rs")),
            ),
            ("ws.rs", crate::test_scratch::lf(include_str!("ws.rs"))),
        ]
    });

    const EXEMPT: &[&str] = &["status", "fake_core"];

    /// The half of a module that runs in front of an operator: every
    /// `#[cfg(test)]` item cut out, wherever it sits.
    ///
    /// Not "everything before the first test module": a module with code after
    /// its tests would go unread, and a rule that stops at the first one it
    /// meets is a rule the next file escapes by ordering (ISS-1233 review, F1).
    fn shipped(source: &str) -> String {
        let mut out = String::with_capacity(source.len());
        let mut rest = source;
        while let Some(at) = rest.find("#[cfg(test)]") {
            out.push_str(&rest[..at]);
            let after = &rest[at..];
            // A test module's own closing brace is the first one at column
            // zero, which is where this file's items all start.
            rest = match after.find("\n}\n") {
                Some(end) => &after[end + 3..],
                None => "",
            };
        }
        out.push_str(rest);
        out
    }

    /// A statement, from a line that opens one to the line that balances it.
    ///
    /// Balanced on the code, which is why [`placeholders_only`] runs first: a
    /// `)` inside a message is not a closing paren, and counting it as one
    /// ended the statement before the argument that says the status
    /// (ISS-1233 review F2, the class).
    fn statement_at(lines: &[&str], from: usize) -> String {
        let mut said = String::new();
        for line in &lines[from..] {
            said.push(' ');
            said.push_str(line.trim());
            let code = placeholders_only(&said);
            let depth = code.matches('(').count() as i32 - code.matches(')').count() as i32;
            if depth <= 0 {
                break;
            }
        }
        said
    }

    /// Every name bound to a `reqwest::StatusCode` or to a response body — the
    /// two values a refusal is built from, whatever the binding is called and
    /// however it was narrowed.
    ///
    /// Measured on the value once the helpers' own calls are cut out of it, so
    /// `let said = status::named(r.status().as_u16())` binds what a helper
    /// answered and not a raw status. The rule this replaces dropped every
    /// value carrying `.as_u16()`, which excluded by construction the single
    /// shape every refusal site in this directory is written in — leaving only
    /// the body binding holding the line (ISS-1233, second judgement).
    fn status_and_body_bindings(shipped: &str) -> Vec<String> {
        let mut names = Vec::new();
        for line in shipped.lines() {
            let t = line.trim();
            let Some(rest) = t.strip_prefix("let ") else {
                continue;
            };
            let Some((name, value)) = rest.split_once('=') else {
                continue;
            };
            let name = name.trim().trim_start_matches("mut ");
            // `let code: u16 = …` declares `code`; the annotation is not part
            // of what the message will say, and keeping it made every typed
            // binding fail the character test below and go unread.
            let name = name.split(':').next().unwrap_or(name).trim();
            if !name.chars().all(|c| c.is_alphanumeric() || c == '_') || name.is_empty() {
                continue;
            }
            let value = outside_the_helpers(value);
            if value.contains(".status()") || value.contains(".text().await") {
                names.push(name.to_string());
            }
        }
        names.sort();
        names.dedup();
        names
    }

    /// Each `format!` call in a statement, as its own argument region. Read
    /// after [`placeholders_only`] has emptied the literals, so a `(` inside a
    /// message cannot throw the paren count.
    fn format_calls(said: &str) -> Vec<String> {
        let mut calls = Vec::new();
        let mut rest = said;
        while let Some(at) = rest.find("format!(") {
            let after = &rest[at + "format!(".len()..];
            let mut depth = 1;
            let mut end = after.len();
            for (i, c) in after.char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            end = i;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            calls.push(after[..end].to_string());
            rest = &after[end..];
        }
        calls
    }

    /// The same text with every literal's prose dropped and only its `{…}`
    /// placeholders kept, which is the difference between saying a value and
    /// spelling its name: `no code given`, two lines under `let code = …`, says
    /// nothing, and `{code}` says the status. It is also what makes a paren
    /// count answer for the code rather than for the prose.
    ///
    /// Raw strings are read as raw strings. Reading `r#"… " …"#` as an ordinary
    /// literal walks out of it at the quote in the message and back into one at
    /// its real end, swallowing the argument after it — a shape the guard this
    /// replaces did catch (ISS-1233 review F2).
    fn placeholders_only(said: &str) -> String {
        let src: Vec<char> = said.chars().collect();
        let mut out = String::with_capacity(said.len());
        let mut i = 0;
        while i < src.len() {
            if src[i] == 'r' && !opens_inside_a_word(&src, i) {
                let mut h = i + 1;
                while h < src.len() && src[h] == '#' {
                    h += 1;
                }
                if h < src.len() && src[h] == '"' {
                    i = literal(&src, h + 1, Some(h - i - 1), &mut out);
                    continue;
                }
            }
            if src[i] == '"' {
                i = literal(&src, i + 1, None, &mut out);
                continue;
            }
            out.push(src[i]);
            i += 1;
        }
        out
    }

    fn opens_inside_a_word(src: &[char], at: usize) -> bool {
        at > 0 && (src[at - 1].is_alphanumeric() || src[at - 1] == '_')
    }

    /// One literal, from just past its opening quote, keeping its `{…}`
    /// placeholders and dropping everything else. `hashes` is `Some` for a raw
    /// string, whose end is the quote followed by that many `#` and inside
    /// which nothing escapes. Answers the index just past the literal.
    fn literal(src: &[char], from: usize, hashes: Option<usize>, out: &mut String) -> usize {
        let mut i = from;
        let mut in_placeholder = false;
        out.push(' ');
        while i < src.len() {
            let c = src[i];
            if c == '\\' && hashes.is_none() {
                i += 2;
                continue;
            }
            if c == '"' {
                let closes = match hashes {
                    None => true,
                    Some(n) => src[i + 1..].iter().take(n).filter(|h| **h == '#').count() == n,
                };
                if closes {
                    out.push(' ');
                    return i + 1 + hashes.unwrap_or(0);
                }
            }
            match c {
                '{' if src.get(i + 1) == Some(&'{') => i += 1,
                '{' => {
                    in_placeholder = true;
                    out.push('{');
                }
                '}' if in_placeholder => {
                    in_placeholder = false;
                    out.push('}');
                }
                '}' if src.get(i + 1) == Some(&'}') => i += 1,
                _ if in_placeholder => out.push(c),
                _ => {}
            }
            i += 1;
        }
        out.push(' ');
        i
    }

    /// `name` as a whole word, so `me/runners decode` does not read as saying
    /// `code`.
    fn mentions(said: &str, name: &str) -> bool {
        let bytes = said.as_bytes();
        let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
        let mut from = 0;
        while let Some(at) = said[from..].find(name) {
            let start = from + at;
            let end = start + name.len();
            if (start == 0 || !word(bytes[start - 1])) && (end == bytes.len() || !word(bytes[end]))
            {
                return true;
            }
            from = end;
        }
        false
    }

    /// Every place a module's shipped half says a status or a response body in
    /// a `format!` of its own — by a binding's name, or inline with no binding
    /// at all, which is the shape `heartbeat.rs` shipped past the first guard.
    fn hand_formatted(name: &str, source: &str) -> Vec<String> {
        let mut offenders = Vec::new();
        let shipped = shipped(source);
        let bound = status_and_body_bindings(&shipped);
        let lines: Vec<&str> = shipped.lines().collect();
        for (n, line) in lines.iter().enumerate() {
            if !line.contains("format!(") {
                continue;
            }
            let statement = statement_at(&lines, n);
            let said = placeholders_only(&outside_the_helpers(&statement));
            for call in format_calls(&said) {
                let mut says: Vec<String> = Vec::new();
                if call.contains(".status()") {
                    says.push("a status, with no binding".to_string());
                }
                if call.contains(".text().await") {
                    says.push("a response body, with no binding".to_string());
                }
                for b in &bound {
                    if mentions(&call, b) {
                        says.push(format!("`{b}`"));
                    }
                }
                if !says.is_empty() {
                    offenders.push(format!(
                        "{name}:{}: {} — says {}",
                        n + 1,
                        statement.trim(),
                        says.join(", ")
                    ));
                }
            }
        }
        offenders
    }

    /// What a `format!` still says once the two helpers' own calls are taken
    /// out of it, so passing a status TO `named` is not mistaken for printing
    /// one.
    fn outside_the_helpers(said: &str) -> String {
        let mut out = String::new();
        let mut rest = said;
        loop {
            let next = [
                "status::named(",
                "status::refused(",
                "status::not_reached_words(",
                "status::not_reached_sentence(",
                "status::why_not_reached(",
            ]
            .iter()
            .filter_map(|h| rest.find(h).map(|at| (at, h.len())))
            .min_by_key(|(at, _)| *at);
            match next {
                None => {
                    out.push_str(rest);
                    return out;
                }
                Some((at, len)) => {
                    out.push_str(&rest[..at]);
                    let mut depth = 1;
                    let mut end = at + len;
                    for (i, c) in rest[at + len..].char_indices() {
                        if c == '(' {
                            depth += 1;
                        } else if c == ')' {
                            depth -= 1;
                            if depth == 0 {
                                end = at + len + i + 1;
                                break;
                            }
                        }
                    }
                    rest = &rest[end..];
                }
            }
        }
    }

    /// Criterion 11. A refusal site that says the status or the body itself is
    /// one `named` and `refused` do not reach, which is how
    /// `520 <unknown status code>` and a whole gateway page went on reaching an
    /// operator after both helpers existed (ISS-1233).
    ///
    /// Measured on what the value IS and not on what it is called: the guard
    /// this replaces matched `{status}` and `{text}`, so renaming the binding
    /// or formatting it positionally walked straight past it (review F1), and
    /// the rewrite after it walked past a status narrowed by `as_u16()` and a
    /// status formatted with no binding at all (second judgement).
    #[test]
    fn no_transport_module_formats_a_status_or_a_body_into_its_own_message() {
        let offenders: Vec<String> = SOURCES
            .iter()
            .flat_map(|(name, source)| hand_formatted(name, source))
            .collect();
        assert!(
            offenders.is_empty(),
            "a status or a body is said by status::named or status::refused, never by a \
             format! of its own:\n{}",
            offenders.join("\n")
        );
    }

    /// A refusal site as each of the five shapes one gets written in, and the
    /// three shapes that are not one. Held as source rather than as code so the
    /// guard is measured on the text it actually reads.
    const PLANTS: &[(&str, &str)] = &[
        (
            "a status and a body, both bound",
            r#"
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("me/runners failed: {code}: {text}")));
"#,
        ),
        (
            "a status bound after as_u16",
            r#"
        let code = resp.status().as_u16();
        return Err(Error::Other(format!("me/runners failed: {code}")));
"#,
        ),
        (
            "a status said with no binding at all",
            r#"
        return Err(Error::Other(format!("heartbeat failed: {}", resp.status())));
"#,
        ),
        (
            "a status renamed and printed positionally",
            r#"
        let whatever = resp.status().as_u16();
        return Err(Error::Other(format!("me/runners failed: {0}", whatever)));
"#,
        ),
        (
            "a status bound under a type annotation",
            r#"
        let code: u16 = resp.status().as_u16();
        return Err(Error::Other(format!("me/runners failed: {code}")));
"#,
        ),
        (
            "a status said from a raw string carrying a quote of its own",
            r##"
        let code = resp.status();
        return Err(Error::Other(format!(r#"heartbeat " refused: {}"#, code)));
"##,
        ),
        (
            "a status behind a message whose own `)` used to end the statement",
            r#"
        let code = resp.status().as_u16();
        let said = format!(
            "me/runners failed) the gateway answered: {}",
            code
        );
        return Err(Error::Other(said));
"#,
        ),
        (
            "a body said with no binding at all",
            r#"
        return Err(Error::Other(format!(
            "me/runners failed: {}",
            resp.text().await.unwrap_or_default()
        )));
"#,
        ),
    ];

    const NOT_A_REFUSAL_SITE: &[(&str, &str)] = &[
        (
            "the helper itself",
            r#"
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(status::refused("me/runners", code, &text)));
"#,
        ),
        (
            "a message built from what the helper answered",
            r#"
        let said = super::status::named(resp.status().as_u16());
        return Err(Error::Other(format!("ack session {said}")));
"#,
        ),
        (
            "a raw-string message naming a binding without interpolating it",
            r##"
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        if code == 404 {
            return Err(Error::Other(format!(r#"no "code" and no "text" for {url}"#)));
        }
        return Err(Error::Other(status::refused("me/runners", code, &text)));
"##,
        ),
        (
            "a message whose words merely include a binding's name",
            r#"
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        if code == 404 {
            return Err(Error::Other(format!("no text and no code given for {url}")));
        }
        return Err(Error::Other(status::refused("me/runners", code, &text)));
"#,
        ),
    ];

    /// Criterion 12, planted rather than asserted. The guard above is watched
    /// going red on every shape a refusal site gets written in — including the
    /// two it shipped blind to at `23b0d882f`, where the binding shape every
    /// site in this directory uses left all three guards green — and watched
    /// staying green on the three shapes it exists to leave alone, because a
    /// guard that fails on the helper is one somebody deletes.
    #[test]
    fn the_guard_goes_red_on_every_shape_a_refusal_site_is_written_in() {
        for (what, planted) in PLANTS {
            assert!(
                !hand_formatted("planted.rs", planted).is_empty(),
                "the guard is blind to {what}, which is how `520 <unknown status code>` went on \
                 reaching an operator:{planted}"
            );
        }
        for (what, allowed) in NOT_A_REFUSAL_SITE {
            let found = hand_formatted("planted.rs", allowed);
            assert!(
                found.is_empty(),
                "the guard refuses {what}, which is the shape it exists to leave alone: {found:?}"
            );
        }
    }

    /// The guard above reads bindings, so a module that reads a response body
    /// and never reaches `refused` is one it cannot see into. Every body read
    /// in the shipped half is answered by a call that says it.
    ///
    /// `refusal` counts as saying it: it composes the sentence with `refused`
    /// and only decides which error variant carries it, so a site that calls it
    /// prints exactly what a site calling `refused` prints (ISS-1284). `absent`
    /// says a missing route's body through the same line (ISS-1421 r16). What the
    /// guard is against is a site formatting a body by hand, and neither of
    /// these is that.
    #[test]
    fn every_module_that_reads_a_refusals_body_says_it_through_the_helper() {
        for (name, source) in SOURCES.iter() {
            let shipped = shipped(source);
            let bodies = shipped.matches(".text().await").count();
            if bodies == 0 {
                continue;
            }
            let said = shipped.matches("status::refused(").count()
                + shipped.matches("status::refusal(").count()
                + shipped.matches("status::absent(").count();
            assert!(
                said >= bodies,
                "{name} reads {bodies} response body/bodies and says {said} of them through \
                 status::refused or status::refusal"
            );
        }
    }

    /// The guard above measures every module `mod.rs` declares, so a new route
    /// cannot be added outside its reach without this failing first.
    #[test]
    fn the_guard_covers_every_module_this_directory_declares() {
        let declared: Vec<String> = crate::test_scratch::lf(include_str!("mod.rs"))
            .lines()
            .filter_map(|l| l.trim().strip_suffix(';'))
            .filter_map(|l| l.rsplit_once("mod "))
            .map(|(_, m)| m.to_string())
            .filter(|m| !EXEMPT.contains(&m.as_str()))
            .collect();
        assert!(declared.len() > 15, "mod.rs parsed as {declared:?}");
        for m in &declared {
            assert!(
                SOURCES.iter().any(|(name, _)| *name == format!("{m}.rs")),
                "{m} is declared in mod.rs and the guard does not read it"
            );
        }
        for (name, _) in SOURCES.iter() {
            let stem = name.trim_end_matches(".rs");
            assert!(
                stem == "mod" || declared.iter().any(|m| m == stem),
                "the guard reads {name} and mod.rs declares no such module"
            );
        }
    }

    /// Criterion 4. The reason an operator gets from `forge-runner master
    /// status` is the transport error itself and nothing re-derived from the
    /// response, so a refusal the lines above made legible is legible there
    /// too. Read rather than exercised: `daemon/master.rs` is not this change's
    /// to edit, and what binds the two is one expression in it.
    #[test]
    fn the_unplaced_reason_an_operator_reads_is_the_transport_error_itself() {
        let sweep = crate::test_scratch::lf(include_str!("../daemon/master.rs"));
        let at = sweep
            .find("Unplaced::RegisterFailed {")
            .expect("the sweep still reports a refused registration");
        let built: String = sweep[at..].lines().take(3).collect::<Vec<_>>().join(" ");
        assert!(
            built.contains("detail: e.to_string()"),
            "the reason an operator reads is no longer the register error itself, so what this \
             module makes legible may not be what reaches them — found: {built}"
        );
    }

    /// The body core answered on the run this issue was filed for, copied from
    /// the daemon journal on `sid-xeon-1`, 2026-09-26.
    const TWO_FIELDS: &str = r#"{"code":"BAD_REQUEST","message":"Invalid input","details":{"formErrors":[],"fieldErrors":{"issueKeys":["Too big: expected array to have <=16 items"],"name":["Too big: expected string to have <=60 characters"]}}}"#;

    /// The body the five later loops answered with: the name alone.
    const NAME_ONLY: &str = r#"{"code":"BAD_REQUEST","message":"Invalid input","details":{"formErrors":[],"fieldErrors":{"name":["Too big: expected string to have <=60 characters"]}}}"#;

    /// A zod refusal of the object rather than of any one field.
    const FORM_ONLY: &str = r#"{"code":"BAD_REQUEST","message":"Invalid input","details":{"formErrors":["Unrecognized key: \"batch\""],"fieldErrors":{}}}"#;

    /// Criteria 1 and 3. Every constraint core named reaches the caller, and
    /// each is said with the field it was about: a run ended for "the
    /// declaration was invalid" tells whoever reads the row nothing to act on.
    #[test]
    fn every_field_constraint_a_refusal_names_reaches_the_caller() {
        assert_eq!(
            constraints(400, TWO_FIELDS),
            Some(vec![
                "issueKeys: Too big: expected array to have <=16 items".to_string(),
                "name: Too big: expected string to have <=60 characters".to_string(),
            ]),
            "both violations were in the answer and both are what the payload has to satisfy"
        );
    }

    /// Criterion 17. A refusal of the request rather than of a field is as
    /// fixed as one naming a field, and reading only `fieldErrors` would leave
    /// it retried for ever — the very loop this is here to end.
    #[test]
    fn a_refusal_naming_only_the_request_is_a_constraint_too() {
        assert_eq!(
            constraints(400, FORM_ONLY),
            Some(vec![
                r#"the request itself: Unrecognized key: "batch""#.to_string()
            ])
        );
    }

    /// Criteria 5, 6 and 7. Three refusals that say nothing about the payload,
    /// each of which a later sweep may legitimately get past: a lease another
    /// box holds, core being down, and a `400` that names no constraint.
    #[test]
    fn a_refusal_that_names_no_constraint_stays_the_callers_to_retry() {
        assert_eq!(
            constraints(409, r#"{"code":"ISSUE_LEASE_HELD","message":"another box holds ISS-1"}"#),
            None,
            "a lease conflict clears on its own and was measured clearing twice on the day this was filed"
        );
        assert_eq!(constraints(503, r#"{"code":"UNAVAILABLE"}"#), None);
        assert_eq!(
            constraints(400, r#"{"code":"BAD_REQUEST","message":"Invalid input"}"#),
            None,
            "a 400 with no details names nothing a caller could print or act on"
        );
        assert_eq!(
            constraints(
                400,
                r#"{"code":"BAD_REQUEST","details":{"formErrors":[],"fieldErrors":{}}}"#
            ),
            None,
            "empty collections name no constraint either"
        );
        assert_eq!(
            constraints(400, "<!doctype html><html><title>520</title></html>"),
            None,
            "a gateway's page is not core's refusal and decides nothing about the payload"
        );
        assert_eq!(constraints(400, ""), None, "an empty body names nothing");
    }

    /// Criterion 1. The classification is what changes; the sentence an
    /// operator reads does not, so a refusal reads the same in the journal
    /// whichever variant carried it.
    #[test]
    fn a_classified_refusal_still_prints_what_it_always_printed() {
        let malformed = refusal("run-session open", 400, NAME_ONLY);
        assert!(
            matches!(malformed, crate::error::Error::Malformed { .. }),
            "a named constraint is what a caller has to stop on"
        );
        assert_eq!(
            format!("{malformed}"),
            refused("run-session open", 400, NAME_ONLY)
        );
        let other = refusal("run-session open", 503, r#"{"code":"UNAVAILABLE"}"#);
        assert!(matches!(other, crate::error::Error::Other(_)));
        assert_eq!(
            format!("{other}"),
            refused("run-session open", 503, r#"{"code":"UNAVAILABLE"}"#)
        );
    }

    /// ISS-1110. Core refuses a run-session open from a box that may not serve
    /// the project with a 403 naming the predicate. That is a state an operator
    /// changes — rebind, enable, undrain — so the sweep keeps asking rather than
    /// giving the declaration up, and the reason reaches the journal verbatim.
    #[test]
    fn a_box_not_admitted_is_retried_and_says_why() {
        let body = r#"{"code":"RUNNER_NOT_ADMITTED","message":"runner_withdrawn: this device's runner on the project is disabled or draining (project p, device d), so it may not open a run session there.","details":{"reason":"runner_withdrawn","projectId":"p","deviceId":"d"}}"#;
        let refused_open = refusal("run-session open", 403, body);
        assert!(
            matches!(refused_open, crate::error::Error::Other(_)),
            "a refusal of the moment, not of the bytes, must not be classified as malformed"
        );
        assert!(
            format!("{refused_open}").contains("runner_withdrawn"),
            "the operator reads the predicate in the journal: {refused_open}"
        );
    }
}

#[cfg(test)]
mod not_reached_words {
    use super::not_reached;

    /// A client that asks the network itself, so a proxy in the environment cannot answer for it.
    fn direct() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap()
    }

    /// ISS-1421 r20 — judge-82's `question ask` against a core that was not
    /// listening printed `error sending request for url (…)`.
    #[tokio::test]
    async fn a_refused_connection_says_where_forge_was_sought_and_why() {
        let e = direct()
            .post("http://127.0.0.1:9/api/devices/me/questions?x=1")
            .send()
            .await
            .unwrap_err();
        let said = not_reached("question ask", &e).to_string();
        assert!(
            said.starts_with(
                "question ask: Forge could not be reached at http://127.0.0.1:9, as the connection \
                 was refused. Check that core is running there"
            ),
            "{said}"
        );
        assert!(!said.contains("error sending request"), "{said}");
        assert!(!said.contains("/api/devices"), "{said}");
    }

    /// The cause a connector wraps the socket's error in, as hyper's does.
    #[derive(Debug)]
    struct Wrapped(std::io::Error);
    impl std::fmt::Display for Wrapped {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("tcp connect error")
        }
    }
    impl std::error::Error for Wrapped {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.0)
        }
    }

    /// ISS-1421 r20 — full CI's windows-latest leg: a refusal worded as
    /// Windows words it read as "no connection could be made".
    #[test]
    fn a_cause_is_read_by_its_kind_whatever_the_os_calls_it() {
        use std::io::{Error, ErrorKind};
        let windows = "No connection could be made because the target machine actively refused \
                       it. (os error 10061)";
        for (kind, words, said) in [
            (
                ErrorKind::ConnectionRefused,
                windows,
                "the connection was refused",
            ),
            (
                ErrorKind::ConnectionRefused,
                "Connection refused (os error 111)",
                "the connection was refused",
            ),
            (
                ErrorKind::ConnectionReset,
                "An existing connection was forcibly closed",
                "the connection was cut",
            ),
            (
                ErrorKind::TimedOut,
                "A connection attempt failed",
                "no answer came in time",
            ),
        ] {
            let cause = Wrapped(Error::new(kind, words));
            assert_eq!(
                super::reached_nothing_because(&cause, true),
                said,
                "{kind:?}: {words}"
            );
        }
        let unnamed = Wrapped(Error::other("something else"));
        assert_eq!(
            super::reached_nothing_because(&unnamed, true),
            "no connection could be made"
        );
    }

    #[tokio::test]
    async fn a_host_that_does_not_resolve_is_said_so() {
        let e = direct()
            .get("https://no-such-host.invalid/api")
            .send()
            .await
            .unwrap_err();
        let said = not_reached("heartbeat", &e).to_string();
        assert!(said.contains("as its host name does not resolve"), "{said}");
    }
}
