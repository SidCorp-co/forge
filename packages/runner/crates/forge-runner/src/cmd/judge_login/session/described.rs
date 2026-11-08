//! The sign-in a secret describes when it is no `{<account field>, password}` POST (ISS-1141,
//! epod's GraphQL mutation): `loginBody`, the JSON object sent as the body with each whole leaf
//! `$account` or `$password` replaced, and `tokenPath`, the JSON pointer the token is read at; and
//! the read of a 2xx answer's bearer, which refuses a GraphQL `errors` array without reading it.

use serde_json::{json, Map, Value};

use super::{shown, Secret, TOKEN_PATHS};

/// The keys a secret describes a sign-in with beyond its route (ISS-1141). Core reads the same keys
/// (`project-config/actor-sign-in.ts`: `SIGN_IN_KEYS`), held equal by its test.
pub(super) const SIGN_IN_KEYS: [&str; 2] = ["loginBody", "tokenPath"];
/// The merge that describes a GraphQL sign-in, as a refusal naming the door shows it. Core names the
/// same (`actor-sign-in.ts`: `GRAPHQL_SET`), held equal by its test.
pub(super) const GRAPHQL_SET: &str = r#"{"set":{"loginRoute":"https://<host>/graphql","loginBody":{"query":"mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { access_token } }","variables":{"email":"$account","password":"$password"}},"tokenPath":"/data/login/access_token"}}"#;

/// A segment of a pointer as a refusal may say it: a key or an index, never a value.
fn segment_said(k: &str) -> &str {
    shown(k)
        .or_else(|| {
            (!k.is_empty() && k.len() <= 4 && k.bytes().all(|b| b.is_ascii_digit())).then_some(k)
        })
        .unwrap_or("…")
}

/// Each string leaf of `v`, with the keys leading to it.
fn leaves_of<'a>(v: &'a Value, at: &mut Vec<String>, out: &mut Vec<(String, &'a str)>) {
    match v {
        Value::String(s) => out.push((
            at.iter()
                .map(|k| segment_said(k))
                .collect::<Vec<_>>()
                .join("/"),
            s,
        )),
        Value::Array(a) => {
            for (i, inner) in a.iter().enumerate() {
                at.push(i.to_string());
                leaves_of(inner, at, out);
                at.pop();
            }
        }
        Value::Object(o) => {
            for (k, inner) in o {
                at.push(k.clone());
                leaves_of(inner, at, out);
                at.pop();
            }
        }
        _ => {}
    }
}

/// Why `body` is no `loginBody` a sign-in can send; none where it is one. Names keys, never a value.
pub(crate) fn login_body_refusal(body: &Value) -> Option<String> {
    if !body.is_object() {
        return Some(
            "`loginBody` is a JSON object sent as the sign-in's body, whose string leaves that are \
             exactly `$account` or `$password` become the account and password"
                .to_string(),
        );
    }
    let mut leaves = Vec::new();
    leaves_of(body, &mut Vec::new(), &mut leaves);
    for (at, leaf) in &leaves {
        let Some(word) = leaf.strip_prefix('$') else {
            continue;
        };
        let mut chars = word.chars();
        let is_word = chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !is_word || matches!(*leaf, "$account" | "$password") {
            continue;
        }
        let said = shown(word).map_or("a `$`-word".to_string(), |w| format!("`${w}`"));
        return Some(format!(
            "`loginBody` at /{at} is {said}, and a leaf is replaced only when it is exactly \
             `$account` or `$password`"
        ));
    }
    (!leaves.iter().any(|(_, l)| *l == "$password")).then(|| {
        "`loginBody` has no leaf that is exactly `$password`, so the sign-in would send no password"
            .to_string()
    })
}

/// Why `path` is no `tokenPath`; none where it is a JSON pointer.
pub(crate) fn token_path_refusal(path: &Value) -> Option<String> {
    let ok = path.as_str().is_some_and(|p| {
        p.len() <= 256
            && p.starts_with('/')
            && p[1..]
                .split('/')
                .all(|s| !s.is_empty() && !s.contains(char::is_whitespace))
    });
    (!ok).then(|| {
        "`tokenPath` is a JSON pointer to the token in the sign-in's answer, such as \
         `/data/login/access_token`"
            .to_string()
    })
}

/// The body a sign-in POSTs: the secret's `loginBody` with each whole leaf `$account` or
/// `$password` replaced, else the account under its field and the password.
pub(crate) fn sign_in_body(secret: &Secret) -> Value {
    fn fill(v: &Value, secret: &Secret) -> Value {
        match v {
            Value::String(s) if s == "$account" => json!(secret.account),
            Value::String(s) if s == "$password" => json!(secret.password),
            Value::Array(a) => Value::Array(a.iter().map(|i| fill(i, secret)).collect()),
            Value::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, i)| (k.clone(), fill(i, secret)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
    match &secret.body {
        Some(template) => fill(template, secret),
        None => {
            let mut body = Map::new();
            body.insert(secret.field.to_string(), json!(secret.account));
            body.insert("password".to_string(), json!(secret.password));
            Value::Object(body)
        }
    }
}

/// A `tokenPath` as a refusal may say it: a pointer of short keys, else "the secret's `tokenPath`".
fn path_said(path: &str) -> String {
    let short = path.len() > 1
        && path[1..].split('/').count() <= 8
        && path[1..].split('/').all(|s| shown(s).is_some());
    if short {
        format!("`{path}`")
    } else {
        "the secret's `tokenPath`".to_string()
    }
}

/// The bearer token a 2xx sign-in answered: at the secret's `tokenPath` where it names one (and
/// refused where none is there), else at the first of `TOKEN_PATHS`. An answer carrying a GraphQL
/// `errors` array is refused, and its text is never read: it can echo the account.
pub(super) fn bearer_of(
    answer: &Value,
    token_path: Option<&str>,
    shown_at: &str,
    status: reqwest::StatusCode,
) -> Result<Option<String>, String> {
    if answer
        .get("errors")
        .and_then(Value::as_array)
        .is_some_and(|e| !e.is_empty())
    {
        return Err(format!(
            "the sign-in at {shown_at} answered {status} with a GraphQL `errors` array, so it \
             signed nobody in; nothing was written"
        ));
    }
    let token_at = |p: &str| {
        answer
            .pointer(p)
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
    };
    match token_path {
        Some(p) => token_at(p).map(Some).ok_or_else(|| {
            format!(
                "the sign-in at {shown_at} answered {status} with no token at {}, so there is no \
                 session to hand over; nothing was written",
                path_said(p)
            )
        }),
        None => Ok(TOKEN_PATHS.iter().find_map(|p| token_at(p))),
    }
}
