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
            let next = ["status::named(", "status::refused(", "status::unanswered("]
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
    #[test]
    fn every_module_that_reads_a_refusals_body_says_it_through_the_helper() {
        for (name, source) in SOURCES {
            let shipped = shipped(source);
            let bodies = shipped.matches(".text().await").count();
            if bodies == 0 {
                continue;
            }
            let said = shipped.matches("status::refused(").count();
            assert!(
                said >= bodies,
                "{name} reads {bodies} response body/bodies and says {said} of them through \
                 status::refused"
            );
        }
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
