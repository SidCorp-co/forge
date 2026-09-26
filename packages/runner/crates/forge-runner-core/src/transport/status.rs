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
    const SOURCES: &[(&str, &str)] = &[
        ("admissible.rs", include_str!("admissible.rs")),
        ("agent_sessions.rs", include_str!("agent_sessions.rs")),
        ("events.rs", include_str!("events.rs")),
        ("frames.rs", include_str!("frames.rs")),
        ("git_credential.rs", include_str!("git_credential.rs")),
        ("heartbeat.rs", include_str!("heartbeat.rs")),
        ("inbox.rs", include_str!("inbox.rs")),
        ("lifecycle.rs", include_str!("lifecycle.rs")),
        ("master.rs", include_str!("master.rs")),
        ("mcp_servers.rs", include_str!("mcp_servers.rs")),
        ("mod.rs", include_str!("mod.rs")),
        ("plugins.rs", include_str!("plugins.rs")),
        ("pool.rs", include_str!("pool.rs")),
        ("protections.rs", include_str!("protections.rs")),
        ("provision.rs", include_str!("provision.rs")),
        ("questions.rs", include_str!("questions.rs")),
        ("run_sessions.rs", include_str!("run_sessions.rs")),
        ("runners.rs", include_str!("runners.rs")),
        ("session_ledger.rs", include_str!("session_ledger.rs")),
        ("skills.rs", include_str!("skills.rs")),
        ("ws.rs", include_str!("ws.rs")),
    ];

    const EXEMPT: &[&str] = &["status", "fake_core"];

    /// Everything before the file's own test module, which is the half that
    /// runs in front of an operator.
    fn shipped(source: &str) -> &str {
        match source.find("\n#[cfg(test)]") {
            Some(at) => &source[..at],
            None => source,
        }
    }

    /// Criterion 11. A refusal site that interpolates the status or the body
    /// into its own message is one `named` and `refused` do not reach, which is
    /// how `520 <unknown status code>` and a whole gateway page went on
    /// reaching an operator after both existed (ISS-1233).
    #[test]
    fn no_transport_module_formats_a_status_or_a_body_into_its_own_message() {
        let mut offenders = Vec::new();
        for (name, source) in SOURCES {
            for (n, line) in shipped(source).lines().enumerate() {
                if line.contains("{status}") || line.contains("{text}") {
                    offenders.push(format!("{name}:{}: {}", n + 1, line.trim()));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "say it with status::named or status::refused instead:\n{}",
            offenders.join("\n")
        );
    }

    /// The guard above measures every module `mod.rs` declares, so a new route
    /// cannot be added outside its reach without this failing first.
    #[test]
    fn the_guard_covers_every_module_this_directory_declares() {
        let declared: Vec<String> = include_str!("mod.rs")
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
        for (name, _) in SOURCES {
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
        let sweep = include_str!("../daemon/master.rs");
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
}
