//! What a pane's MCP servers ARE, as against the credential core hands them on this one call.
//!
//! Core reaches an HTTP MCP provider through its relay (REQ-21 BC-2): the server entry names a
//! Forge URL and carries a relay ticket, a JWT core signs afresh, `iat` now, on every
//! `GET /api/devices/me/mcp-servers` (`integrations/mcp-relay.ts:relayEntryFor`). Two answers about
//! one unchanged server therefore never compare equal byte for byte, and a master compared that way
//! read as outdated on every sweep and drained before it could declare a run (ISS-610).
//!
//! Only that ticket is set aside, and only down to the binding it grants: a server's name, type,
//! URL, command, arguments, and every other header or environment value still count, so a changed
//! server, or any credential that is not core's relay ticket, still reads as a change. A pane
//! cannot reload its MCP config, so the ticket it was started with is the one it keeps; how much of
//! that ticket's life is left is read separately, by [`lapsing_tickets`].

use base64::Engine;
use serde_json::Value;

/// The issuer core signs its relay tickets under (`integrations/mcp-relay.ts:ISSUER`), so they
/// verify as nothing else.
pub const RELAY_ISSUER: &str = "forge.mcp.relay";

/// What a relay ticket says about itself. Its signature is core's to check, never this box's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayTicket {
    /// The binding the ticket opens (`sub`).
    pub binding: String,
    /// When core signed it (`iat`), in Unix seconds.
    pub issued: i64,
    /// When it stops opening anything (`exp`), in Unix seconds.
    pub expires: i64,
}

/// The relay ticket a header value carries, or `None` where it carries anything else — a header
/// that is not a bearer JWT under [`RELAY_ISSUER`] naming a binding and both its times.
pub fn relay_ticket(header: &str) -> Option<RelayTicket> {
    let token = header.strip_prefix("Bearer ")?;
    let mut parts = token.split('.');
    let (_, payload, _, None) = (parts.next()?, parts.next()?, parts.next()?, parts.next()) else {
        return None;
    };
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    if claims.get("iss")?.as_str()? != RELAY_ISSUER {
        return None;
    }
    Some(RelayTicket {
        binding: claims.get("sub")?.as_str()?.to_string(),
        issued: claims.get("iat")?.as_i64()?,
        expires: claims.get("exp")?.as_i64()?,
    })
}

/// The relay tickets one server entry carries, in its `headers`.
fn tickets_of(spec: &Value) -> impl Iterator<Item = RelayTicket> + '_ {
    spec.get("headers")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|headers| headers.values())
        .filter_map(|v| v.as_str().and_then(relay_ticket))
}

/// These servers with each relay ticket reduced to the binding it grants, and nothing else
/// changed: what two answers about the same servers agree on however many tickets core signed in
/// between.
pub fn server_identity(servers: &serde_json::Map<String, Value>) -> serde_json::Map<String, Value> {
    let mut out = servers.clone();
    for spec in out.values_mut() {
        let Some(Value::Object(headers)) = spec.get_mut("headers") else {
            continue;
        };
        for value in headers.values_mut() {
            if let Some(ticket) = value.as_str().and_then(relay_ticket) {
                *value = Value::String(format!("relay ticket for binding {}", ticket.binding));
            }
        }
    }
    out
}

/// Whether `a` and `b` declare the same servers, a relay ticket's rotation aside.
pub fn same_servers(
    a: &serde_json::Map<String, Value>,
    b: &serde_json::Map<String, Value>,
) -> bool {
    server_identity(a) == server_identity(b)
}

/// The share of a ticket's life under which a pane holding it is due a fresh one. A master is
/// replaced only once nothing holds it, so it is told while a quarter of the life is still left
/// rather than at the second its relayed servers stop answering.
const LAPSING_BELOW: i64 = 4;

/// The servers, by name and sorted, whose relay ticket has less than a quarter of its life left at
/// `now` (Unix seconds), or is already past it.
pub fn lapsing_tickets(servers: &serde_json::Map<String, Value>, now: i64) -> Vec<String> {
    let mut names: Vec<String> = servers
        .iter()
        .filter(|(_, spec)| {
            tickets_of(spec).any(|t| {
                let life = t.expires - t.issued;
                life <= 0 || (t.expires - now) * LAPSING_BELOW < life
            })
        })
        .map(|(name, _)| name.clone())
        .collect();
    names.sort();
    names
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn ticket_with(claims: Value) -> String {
        let b64 = |v: Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
        format!(
            "{}.{}.c2lnbmF0dXJl",
            b64(serde_json::json!({ "alg": "HS256" })),
            b64(claims)
        )
    }

    pub(crate) fn ticket(binding: &str, iat: i64, exp: i64) -> String {
        ticket_with(serde_json::json!({
            "pid": "p", "iss": RELAY_ISSUER, "sub": binding, "iat": iat, "exp": exp
        }))
    }

    pub(crate) fn server(url: &str, kind: &str, auth: &str) -> Value {
        serde_json::json!({
            "type": kind,
            "url": url,
            "headers": { "Authorization": format!("Bearer {auth}") },
            "enabled": true,
        })
    }

    fn servers(entries: &[(&str, Value)]) -> serde_json::Map<String, Value> {
        entries
            .iter()
            .map(|(n, v)| ((*n).to_string(), v.clone()))
            .collect()
    }

    const URL: &str = "https://forge.example/api/mcp-relay/b1";

    #[test]
    fn a_relay_ticket_is_read_and_anything_else_is_not() {
        let t = relay_ticket(&format!("Bearer {}", ticket("b1", 10, 20))).expect("a relay ticket");
        assert_eq!(
            t,
            RelayTicket {
                binding: "b1".into(),
                issued: 10,
                expires: 20
            }
        );
        let other_issuer = ticket_with(serde_json::json!({
            "iss": "someone.else", "sub": "b1", "iat": 10, "exp": 20
        }));
        for header in [
            format!("Bearer {other_issuer}"),
            ticket("b1", 10, 20),
            "Bearer not-a-jwt".to_string(),
            "Bearer a.b.c.d".to_string(),
            "Bearer sk-live-static-key".to_string(),
        ] {
            assert_eq!(
                relay_ticket(&header),
                None,
                "{header} read as a relay ticket"
            );
        }
    }

    #[test]
    fn a_fresh_relay_ticket_alone_is_the_same_servers() {
        let a = servers(&[("autoflow", server(URL, "http", &ticket("b1", 0, 86_400)))]);
        let b = servers(&[("autoflow", server(URL, "http", &ticket("b1", 60, 86_460)))]);
        assert_ne!(a, b);
        assert!(same_servers(&a, &b));
    }

    #[test]
    fn a_server_added_removed_or_changed_is_not_the_same_servers() {
        let t = ticket("b1", 0, 86_400);
        let fresh = ticket("b1", 60, 86_460);
        let placed = servers(&[("autoflow", server(URL, "http", &t))]);
        let cases = [
            (
                "added",
                servers(&[
                    ("autoflow", server(URL, "http", &fresh)),
                    (
                        "shop",
                        server("https://forge.example/api/mcp-relay/b2", "http", &fresh),
                    ),
                ]),
            ),
            ("removed", servers(&[])),
            (
                "url changed",
                servers(&[(
                    "autoflow",
                    server("https://other.example/relay/b1", "http", &fresh),
                )]),
            ),
            (
                "type changed",
                servers(&[("autoflow", server(URL, "sse", &fresh))]),
            ),
            (
                "renamed",
                servers(&[("autoflow_production", server(URL, "http", &fresh))]),
            ),
            (
                "another binding's ticket",
                servers(&[("autoflow", server(URL, "http", &ticket("b9", 60, 86_460)))]),
            ),
        ];
        for (what, now) in cases {
            assert!(
                !same_servers(&placed, &now),
                "{what} read as the same servers"
            );
        }
    }

    #[test]
    fn a_credential_that_is_not_a_relay_ticket_still_counts() {
        let a = servers(&[("x", server("https://x.example/mcp", "http", "sk-one"))]);
        let b = servers(&[("x", server("https://x.example/mcp", "http", "sk-two"))]);
        assert!(!same_servers(&a, &b));
    }

    #[test]
    fn a_ticket_is_lapsing_once_under_a_quarter_of_its_life_is_left() {
        let s = servers(&[
            ("autoflow", server(URL, "http", &ticket("b1", 0, 400))),
            ("plain", serde_json::json!({ "command": "x" })),
        ]);
        assert!(lapsing_tickets(&s, 0).is_empty());
        assert!(
            lapsing_tickets(&s, 300).is_empty(),
            "a quarter left exactly is not under it"
        );
        assert_eq!(lapsing_tickets(&s, 301), vec!["autoflow".to_string()]);
        assert_eq!(lapsing_tickets(&s, 500), vec!["autoflow".to_string()]);
        let broken = servers(&[("autoflow", server(URL, "http", &ticket("b1", 400, 400)))]);
        assert_eq!(lapsing_tickets(&broken, 0), vec!["autoflow".to_string()]);
    }
}
