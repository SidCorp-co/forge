//! The browser session a secret describes (ISS-1145): the `localStorage` an app restores its
//! session from, each value read from the sign-in's answer. epod's admin restores one only from
//! five keys together (`auth_token`, `auth_token_expires_at`, `user`, `organization`,
//! `organization_id`), so one token under one key is not enough.
//!
//! - `storage`: a map from a `localStorage` key to a JSON pointer into the sign-in's answer. A
//!   string is written as it is; an object, an array, a number or a boolean as JSON text. A pointer
//!   the answer does not hold (or holds `null` at) is refused, naming the key and the pointer.
//! - `storageKey`: shorthand for `{<key>: <the bearer token>}`.
//!
//! Every value is written to the storage state for the app's origin and nowhere else: a refusal
//! and the line judge-login prints name keys and pointers, never a value.

use serde_json::{Map, Value};

use super::described::path_said;
use super::Session;

/// The keys a secret describes the browser session with. Core reads the same keys
/// (`project-config/actor-sign-in.ts`: `STORAGE_KEYS`), held equal by its test.
pub(super) const STORAGE_KEYS: [&str; 2] = ["storageKey", "storage"];
/// The most keys a `storage` map names.
const MOST: usize = 32;

/// Where one `localStorage` value comes from.
pub(crate) enum Source {
    /// The bearer token the sign-in answered (`storageKey`).
    Token,
    /// The value at this JSON pointer into the sign-in's answer (`storage`).
    At(String),
}

/// One `localStorage` key and where its value comes from.
pub(crate) struct Entry {
    key: String,
    from: Source,
}

/// A `localStorage` key as a line may say it: in backticks when it is short and plain, else
/// "a key".
pub(crate) fn key_said(k: &str) -> String {
    let plain = !k.is_empty()
        && k.len() <= 64
        && k.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'));
    if plain {
        format!("`{k}`")
    } else {
        "a key".to_string()
    }
}

fn is_pointer(p: &str) -> bool {
    p.len() <= 256
        && p.starts_with('/')
        && p[1..]
            .split('/')
            .all(|s| !s.is_empty() && !s.contains(char::is_whitespace))
}

/// Why `v` is no `storageKey`; none where it is one.
pub(crate) fn storage_key_refusal(v: &Value) -> Option<String> {
    let ok = v
        .as_str()
        .is_some_and(|k| !k.is_empty() && k.len() <= 128 && k.trim() == k);
    (!ok).then(|| {
        "`storageKey` is the localStorage key the app reads its bearer token from, a non-empty \
         string"
            .to_string()
    })
}

/// Why `v` is no `storage` map; none where it is one. Names keys, never a value.
pub(crate) fn storage_refusal(v: &Value) -> Option<String> {
    let Some(map) = v.as_object().filter(|m| !m.is_empty() && m.len() <= MOST) else {
        return Some(format!(
            "`storage` is a JSON object of 1 to {MOST} localStorage keys, each a JSON pointer into \
             the sign-in's answer, such as {{\"auth_token\":\"/data/login/access_token\"}}"
        ));
    };
    map.iter().find_map(|(k, p)| {
        if k.is_empty() || k.len() > 128 {
            return Some("`storage` names a key that is empty or over 128 characters".to_string());
        }
        (!p.as_str().is_some_and(is_pointer)).then(|| {
            format!(
                "`storage` at {} is no JSON pointer into the sign-in's answer, such as \
                 `/data/login/user`",
                key_said(k)
            )
        })
    })
}

/// The entries `storageKey` and `storage` describe, or the line refusing them. A key named by
/// both is refused: which of the two values the app should read is not guessed.
pub(crate) fn entries_of(o: &Map<String, Value>) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    if let Some(v) = o.get(STORAGE_KEYS[0]) {
        if let Some(why) = storage_key_refusal(v) {
            return Err(why);
        }
        let key = v.as_str().unwrap_or_default().to_string();
        out.push(Entry {
            key,
            from: Source::Token,
        });
    }
    if let Some(v) = o.get(STORAGE_KEYS[1]) {
        if let Some(why) = storage_refusal(v) {
            return Err(why);
        }
        for (key, p) in v.as_object().into_iter().flatten() {
            if out.iter().any(|e| e.key == *key) {
                return Err(format!(
                    "`storageKey` and `storage` both name {}; name it in `storage` alone",
                    key_said(key)
                ));
            }
            let at = p.as_str().unwrap_or_default().to_string();
            out.push(Entry {
                key: key.clone(),
                from: Source::At(at),
            });
        }
    }
    Ok(out)
}

/// Each entry's key and value, read from the sign-in's `answer` and its `bearer`, or the line
/// refusing the first it cannot fill: the key and the pointer, never a value.
pub(crate) fn values_of(
    entries: &[Entry],
    answer: &Value,
    bearer: Option<&str>,
    shown_at: &str,
    status: reqwest::StatusCode,
) -> Result<Vec<(String, String)>, String> {
    entries
        .iter()
        .map(|e| {
            let value = match &e.from {
                Source::Token => bearer.map(str::to_string).ok_or_else(|| {
                    format!(
                        "the secret names a `storageKey`, and the sign-in at {shown_at} answered no \
                         token to store under it"
                    )
                })?,
                Source::At(p) => match answer.pointer(p) {
                    None | Some(Value::Null) => {
                        return Err(format!(
                            "the sign-in at {shown_at} answered {status} with nothing at {} for the \
                             storage key {}, so the browser session the secret describes cannot be \
                             written; nothing was written",
                            path_said(p),
                            key_said(&e.key)
                        ))
                    }
                    Some(Value::String(s)) => s.clone(),
                    Some(other) => other.to_string(),
                },
            };
            Ok((e.key.clone(), value))
        })
        .collect()
}

/// What the browser file holds, said by its keys, never a value or a count.
pub(crate) fn state_says(session: &Session) -> String {
    let keys = session
        .local_storage
        .iter()
        .map(|(k, _)| key_said(k))
        .collect::<Vec<_>>()
        .join(", ");
    match (session.cookies.is_empty(), keys.is_empty()) {
        (false, false) => {
            format!("the cookies the sign-in set, and localStorage {keys} for the app's origin")
        }
        (false, true) => "the cookies the sign-in set".to_string(),
        (true, false) => format!("localStorage {keys} for the app's origin"),
        (true, true) => {
            "nothing a browser signs in with: the sign-in set no cookie and the secret \
             names no `storage`; add the localStorage keys the app restores its session from, each \
             a JSON pointer into the sign-in's answer, without retyping the value: PATCH \
             /api/projects/<id>/secrets/<scope>/<name> \
             {\"set\":{\"storage\":{\"<key>\":\"/data/login/access_token\"}}}"
                .to_string()
        }
    }
}
