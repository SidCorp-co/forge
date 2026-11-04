//! The sign-in `judge-login` makes for the judge, and the session it hands back (ISS-959).
//!
//! The testing secret is read and spent inside this process: it is parsed here, sent once to the
//! sign-in route of the deployment the run judges, and dropped. What leaves is a session — a header
//! line for `curl -H @<file>` and a Playwright storage state — and no file holds the password.
//!
//! The secret is the self-describing form, a JSON object:
//! `{ "kind": "...", "signIn": "POST /api/auth/local", "email": "...", "password": "..." }`.
//! - `password` is required: a secret with none (an API key, a token) is the credential itself and is
//!   refused by name, never written to a file.
//! - The account is named by the field its sign-in route reads: exactly one of `email`, `username`
//!   or `login`, sent under that name. `account` or `user` names no field and is refused.
//! - The route is exactly one of `signIn`, `signInRoute` or `route`: `[POST ]<https URL | /path>`. A
//!   path is sent to the origin of the judged deployment that answers it (core's `deployment`, the
//!   environment's `url`, `services` and `routes`, ISS-470); a secret naming no route is refused, as
//!   the testing profile declares no sign-in route and none is guessed.
//! - `storageKey`, optional: the `localStorage` key the web app reads its token from, written into
//!   the storage state for the deployment's origin.
//!
//! The answer's `token` (or `accessToken`, `access_token`) becomes an `Authorization: Bearer` line;
//! with none, the cookies the sign-in set become a `Cookie:` line. A redirect is never followed, so
//! the password goes to the one origin named and nowhere else.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use reqwest::Url;
use serde_json::{json, Map, Value};

/// The fields an account may be named by: each is also the field the sign-in route reads.
const ACCOUNT_FIELDS: [&str; 3] = ["email", "username", "login"];
/// The keys a sign-in route may be named by.
const ROUTE_KEYS: [&str; 3] = ["signIn", "signInRoute", "route"];
/// The fields of a sign-in's answer read as its bearer token.
const TOKEN_FIELDS: [&str; 3] = ["token", "accessToken", "access_token"];

/// What the secret says about signing in. Its `Debug` never shows the account or the password.
pub(crate) struct Secret {
    field: &'static str,
    account: String,
    password: String,
    route: Target,
    storage_key: Option<String>,
}

impl Secret {
    /// Where the secret says to sign in.
    pub(crate) fn route(&self) -> &Target {
        &self.route
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Secret")
            .field("field", &self.field)
            .field("route", &self.route)
            .finish_non_exhaustive()
    }
}

/// Where the secret says to sign in.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Url(Url),
    Path(String),
}

/// The origins of the deployment the run judges, as core answered them beside the secret.
#[derive(Debug, Default)]
pub(crate) struct Deployment {
    environment: String,
    url: Option<String>,
    services: BTreeMap<String, String>,
    routes: Option<BTreeMap<String, Vec<String>>>,
}

/// One cookie as Playwright's storage state holds it.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Cookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    expires: i64,
    http_only: bool,
    secure: bool,
    same_site: &'static str,
}

/// What a sign-in handed back. Its `Debug` never shows a token or a cookie's value.
pub(crate) struct Session {
    pub(crate) at: Url,
    bearer: Option<String>,
    cookies: Vec<Cookie>,
    local_storage: Option<(String, String)>,
    origin: String,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("at", &self.at.as_str())
            .field("bearer", &self.bearer.is_some())
            .finish_non_exhaustive()
    }
}

/// The two files a session is written to.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SessionFiles {
    pub(crate) header: PathBuf,
    pub(crate) state: PathBuf,
}

/// A key or kind as a refusal may say it: a short identifier, never a value.
fn shown(s: &str) -> Option<&str> {
    let mut chars = s.chars();
    (s.len() <= 32
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    .then_some(s)
}

fn keys_of(o: &Map<String, Value>) -> String {
    let mut keys: Vec<&str> = o.keys().filter_map(|k| shown(k)).collect();
    keys.sort_unstable();
    if keys.is_empty() {
        "no key judge-login reads".to_string()
    } else {
        format!("keys {}", keys.join(", "))
    }
}

const SHAPE: &str =
    "a JSON object naming `signIn` (`POST <https URL or /path>`), the account by the \
                     field its route reads (`email`, `username` or `login`) and `password`";

/// The one string named by exactly one of `keys`, or the line refusing none or two.
fn one_of<'a>(
    o: &'a Map<String, Value>,
    keys: &[&'static str],
) -> Result<Option<(&'static str, &'a str)>, String> {
    let found: Vec<(&'static str, &str)> = keys
        .iter()
        .filter_map(|k| o.get(*k).and_then(Value::as_str).map(|v| (*k, v.trim())))
        .filter(|(_, v)| !v.is_empty())
        .collect();
    match found.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some(*one)),
        more => Err(format!(
            "the secret names {} at once; it names one",
            more.iter()
                .map(|(k, _)| format!("`{k}`"))
                .collect::<Vec<_>>()
                .join(" and ")
        )),
    }
}

/// The secret's sign-in, or the line refusing it. A refusal names keys and the kind, never a value.
pub(crate) fn parse_secret(value: &str) -> Result<Secret, String> {
    let Ok(Value::Object(o)) = serde_json::from_str::<Value>(value) else {
        return Err(format!(
            "the secret is not the self-describing form judge-login signs in with ({SHAPE}); \
             re-write it in that form. Nothing of its value is said"
        ));
    };
    let kind = o
        .get("kind")
        .and_then(Value::as_str)
        .and_then(shown)
        .map(|k| format!(" (kind `{k}`)"))
        .unwrap_or_default();
    let Some(password) = o
        .get("password")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
    else {
        return Err(format!(
            "the secret{kind} names no `password` (it holds {}), so it is no sign-in: a key or token is \
             the credential itself, and judge-login writes no credential to a file",
            keys_of(&o)
        ));
    };
    let Some((field, account)) = one_of(&o, &ACCOUNT_FIELDS)? else {
        let vague = ["account", "user"].into_iter().find(|k| o.contains_key(*k));
        return Err(match vague {
            Some(k) => format!(
                "the secret{kind} names its account as `{k}`, which is no field a sign-in route \
                 reads; name it by the field its route reads: `email`, `username` or `login`"
            ),
            None => format!(
                "the secret{kind} names no account (it holds {}); name it by the field its sign-in \
                 route reads: `email`, `username` or `login`",
                keys_of(&o)
            ),
        });
    };
    let Some((_, route)) = one_of(&o, &ROUTE_KEYS)? else {
        return Err(format!(
            "the secret{kind} names no sign-in route (it holds {}), and a testing profile declares \
             none, so where to sign in is not known and nothing is guessed; add `signIn`, \
             `POST <https URL or /path>`",
            keys_of(&o)
        ));
    };
    let storage_key = o
        .get("storageKey")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(Secret {
        field,
        account: account.to_string(),
        password: password.to_string(),
        route: target(route)?,
        storage_key,
    })
}

/// A URL a password may be sent to: https, or http to this machine only, with no user part.
fn sendable(url: Url, said: &str) -> Result<Url, String> {
    let loopback = matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    );
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback)) {
        return Err(format!(
            "{said} is `{}://`, and a password is sent over https only (http to this machine alone)",
            url.scheme()
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!(
            "{said} carries a user part; name the account in its own field"
        ));
    }
    Ok(url)
}

/// The route a secret names: `[POST ]<https URL | /path>`. Another method is refused.
pub(crate) fn target(route: &str) -> Result<Target, String> {
    let rest = match route.split_once(' ') {
        Some((method, rest)) if method.chars().all(|c| c.is_ascii_uppercase()) => {
            if method != "POST" {
                return Err(format!(
                    "the secret's sign-in route is a `{method}`; judge-login signs in with a POST"
                ));
            }
            rest.trim()
        }
        _ => route,
    };
    if rest.starts_with('/') {
        return Ok(Target::Path(rest.to_string()));
    }
    let url = Url::parse(rest)
        .map_err(|_| "the secret's sign-in route is neither a URL nor a `/path`".to_string())?;
    sendable(url, "the secret's sign-in route").map(Target::Url)
}

/// The deployment core answered beside the secret, or none where it answered none.
pub(crate) fn deployment_of(answer: &Value) -> Option<Deployment> {
    let d = answer.get("deployment")?.as_object()?;
    let strings = |v: Option<&Value>| -> BTreeMap<String, String> {
        v.and_then(Value::as_object)
            .map(|o| {
                o.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    };
    let routes = d.get("routes").and_then(Value::as_object).map(|o| {
        o.iter()
            .map(|(k, v)| {
                let prefixes = v
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                (k.clone(), prefixes)
            })
            .collect()
    });
    Some(Deployment {
        environment: d
            .get("environment")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string(),
        url: d.get("url").and_then(Value::as_str).map(str::to_string),
        services: strings(d.get("services")),
        routes,
    })
}

/// Whether `prefix` claims `path`, as core's `serviceRouting` reads it (`criterion-probes.ts`).
fn claims(prefix: &str, path: &str) -> bool {
    let bare = path.split(['?', '#']).next().unwrap_or(path);
    match prefix.strip_suffix('/') {
        Some(trimmed) => bare.starts_with(prefix) || bare == trimmed,
        None => bare == prefix || bare.starts_with(&format!("{prefix}/")),
    }
}

/// The URL to sign in at: the secret's own, or its path on the origin of the judged deployment
/// that answers it — the service whose longest `routes` prefix claims it, else the `url`.
pub(crate) fn sign_in_url(target: &Target, deployment: Option<&Deployment>) -> Result<Url, String> {
    let path = match target {
        Target::Url(u) => return Ok(u.clone()),
        Target::Path(p) => p,
    };
    let Some(d) = deployment else {
        return Err(format!(
            "the secret names the sign-in path `{path}`, and core answered no deployment for the \
             environment this run judges, so which origin answers it is not known"
        ));
    };
    let env = format!("environment `{}`", d.environment);
    let origin = if d.services.is_empty() {
        d.url.clone()
    } else {
        let Some(routes) = &d.routes else {
            return Err(format!(
                "{env} declares services and no `routes`, so which origin answers `{path}` is not known"
            ));
        };
        let owner = routes
            .iter()
            .flat_map(|(s, ps)| ps.iter().map(move |p| (s, p)))
            .filter(|(_, p)| claims(p, path))
            .max_by_key(|(_, p)| p.len());
        match owner {
            Some((service, _)) => d.services.get(service).cloned(),
            None => d.url.clone(),
        }
    };
    let Some(origin) = origin else {
        return Err(format!("{env} declares no origin that answers `{path}`"));
    };
    let base = Url::parse(&origin).map_err(|_| format!("{env}'s origin is no URL"))?;
    let url = base
        .join(path)
        .map_err(|_| format!("`{path}` does not join {env}'s origin"))?;
    sendable(url, &format!("{env}'s origin"))
}

/// One `Set-Cookie` as a storage-state cookie; none where it deletes the cookie (`Max-Age<=0`).
/// A cookie with no `Max-Age` is a session cookie (`expires: -1`); `Expires` alone is not read.
pub(crate) fn parse_set_cookie(header: &str, host: &str, now: i64) -> Option<Cookie> {
    let mut parts = header.split(';');
    let (name, value) = parts.next()?.split_once('=')?;
    let mut cookie = Cookie {
        name: name.trim().to_string(),
        value: value.trim().trim_matches('"').to_string(),
        domain: host.to_string(),
        path: "/".to_string(),
        expires: -1,
        http_only: false,
        secure: false,
        same_site: "Lax",
    };
    if cookie.name.is_empty() {
        return None;
    }
    for attr in parts {
        let (k, v) = attr.split_once('=').unwrap_or((attr, ""));
        let v = v.trim();
        match k.trim().to_ascii_lowercase().as_str() {
            "domain" if !v.is_empty() => {
                cookie.domain = format!(".{}", v.trim_start_matches('.').to_ascii_lowercase());
            }
            "path" if v.starts_with('/') => cookie.path = v.to_string(),
            "max-age" => match v.parse::<i64>() {
                Ok(age) if age <= 0 => return None,
                Ok(age) => cookie.expires = now + age,
                Err(_) => {}
            },
            "httponly" => cookie.http_only = true,
            "secure" => cookie.secure = true,
            "samesite" => {
                cookie.same_site = match v.to_ascii_lowercase().as_str() {
                    "strict" => "Strict",
                    "none" => "None",
                    _ => "Lax",
                }
            }
            _ => {}
        }
    }
    Some(cookie)
}

/// Sign in at `url` with `secret`, following no redirect. The refusal names the status and the
/// code the route answered, never the body, the account or the password.
pub(crate) async fn sign_in(
    secret: &Secret,
    url: &Url,
    deployment: Option<&Deployment>,
) -> Result<Session, String> {
    let shown_at = format!("{}{}", url.origin().ascii_serialization(), url.path());
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("no HTTP client could be built ({e})"))?;
    let mut body = Map::new();
    body.insert(secret.field.to_string(), json!(secret.account));
    body.insert("password".to_string(), json!(secret.password));
    let resp = http
        .post(url.clone())
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format!(
                "the sign-in at {shown_at} could not be reached ({})",
                e.without_url()
            )
        })?;
    let status = resp.status();
    if status.is_redirection() {
        return Err(format!(
            "the sign-in at {shown_at} answered {status}, a redirect, and judge-login sends a \
             password to no second origin; name the route it redirects to"
        ));
    }
    let host = url.host_str().unwrap_or_default().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();
    let cookies: Vec<Cookie> = resp
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|v| parse_set_cookie(v, &host, now))
        .collect();
    let answer: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let code = answer
            .get("code")
            .or_else(|| answer.pointer("/error/code"))
            .and_then(Value::as_str)
            .and_then(shown)
            .map(|c| format!(" {c}"))
            .unwrap_or_default();
        return Err(format!(
            "the sign-in at {shown_at} was refused: {status}{code}; nothing was written"
        ));
    }
    let bearer = TOKEN_FIELDS
        .iter()
        .find_map(|k| answer.get(*k).and_then(Value::as_str))
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    if bearer.is_none() && cookies.is_empty() {
        return Err(format!(
            "the sign-in at {shown_at} answered {status} with no token (`token`, `accessToken` or \
             `access_token`) and set no cookie, so there is no session to hand over"
        ));
    }
    let local_storage = match (&secret.storage_key, &bearer) {
        (None, _) => None,
        (Some(k), Some(t)) => Some((k.clone(), t.clone())),
        (Some(_), None) => {
            return Err(format!(
                "the secret names a `storageKey`, and the sign-in at {shown_at} answered no token \
                 to store under it"
            ))
        }
    };
    let origin = deployment
        .and_then(|d| d.url.as_deref())
        .and_then(|u| Url::parse(u).ok())
        .unwrap_or_else(|| url.clone())
        .origin()
        .ascii_serialization();
    Ok(Session {
        at: url.clone(),
        bearer,
        cookies,
        local_storage,
        origin,
    })
}

/// The one header line `curl -H @<file>` sends: the bearer, or else the cookies.
pub(crate) fn header_line(session: &Session) -> String {
    match &session.bearer {
        Some(t) => format!("Authorization: Bearer {t}\n"),
        None => format!(
            "Cookie: {}\n",
            session
                .cookies
                .iter()
                .map(|c| format!("{}={}", c.name, c.value))
                .collect::<Vec<_>>()
                .join("; ")
        ),
    }
}

/// The session as Playwright's `storageState`: `{ cookies, origins }`.
pub(crate) fn storage_state(session: &Session) -> Value {
    let cookies: Vec<Value> = session
        .cookies
        .iter()
        .map(|c| {
            json!({
                "name": c.name,
                "value": c.value,
                "domain": c.domain,
                "path": c.path,
                "expires": c.expires,
                "httpOnly": c.http_only,
                "secure": c.secure,
                "sameSite": c.same_site,
            })
        })
        .collect();
    let origins: Vec<Value> = session
        .local_storage
        .iter()
        .map(|(name, value)| {
            json!({
                "origin": session.origin,
                "localStorage": [{ "name": name, "value": value }],
            })
        })
        .collect();
    json!({ "cookies": cookies, "origins": origins })
}

/// What the browser file holds, said without a value or a count.
pub(crate) fn state_says(session: &Session) -> &'static str {
    match (session.cookies.is_empty(), session.local_storage.is_some()) {
        (false, true) => {
            "the cookies the sign-in set, and the token under the secret's `storageKey`"
        }
        (false, false) => "the cookies the sign-in set",
        (true, true) => "the token under the secret's `storageKey`",
        (true, false) => {
            "nothing a browser signs in with: the sign-in set no cookie and the secret names no \
             `storageKey`, so drive the browser through its own login form"
        }
    }
}

/// Write `body` to `path`, 0600, replacing any earlier copy.
fn write_private(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let _ = std::fs::remove_file(path);
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    open.open(path)?.write_all(body)
}

/// Write the session into `dir` (0700): `<profile>-actor-<actor>.header` and
/// `<profile>-actor-<actor>.storage-state.json`, each 0600. The login file a judge-login from before
/// ISS-959 left there, `<profile>-actor-<actor>.json`, which held the password, is removed.
pub(crate) fn write_session(
    dir: &Path,
    profile: &str,
    actor: &str,
    session: &Session,
) -> std::io::Result<SessionFiles> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let stem = format!("{profile}-actor-{actor}");
    let _ = std::fs::remove_file(dir.join(format!("{stem}.json")));
    let files = SessionFiles {
        header: dir.join(format!("{stem}.header")),
        state: dir.join(format!("{stem}.storage-state.json")),
    };
    write_private(&files.header, header_line(session).as_bytes())?;
    let state = serde_json::to_string_pretty(&storage_state(session))?;
    if let Err(e) = write_private(&files.state, format!("{state}\n").as_bytes()) {
        let _ = std::fs::remove_file(&files.header);
        return Err(e);
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deployment(routes: Option<Value>) -> Deployment {
        deployment_of(&json!({ "deployment": {
            "environment": "dev",
            "url": "https://web.forge.test",
            "services": { "api": "https://api.forge.test", "auth": "https://auth.forge.test" },
            "routes": routes,
        }}))
        .unwrap()
    }

    #[test]
    fn a_path_signs_in_at_the_origin_whose_longest_route_claims_it() {
        let d = deployment(Some(json!({ "api": ["/api"], "auth": ["/api/auth"] })));
        let at = |p: &str| sign_in_url(&Target::Path(p.into()), Some(&d)).map(|u| u.to_string());
        assert_eq!(
            at("/api/auth/local"),
            Ok("https://auth.forge.test/api/auth/local".into())
        );
        assert_eq!(
            at("/api/session"),
            Ok("https://api.forge.test/api/session".into())
        );
        // `/apiary` is no path under `/api`; the environment's own url answers it
        assert_eq!(
            at("/apiary/login"),
            Ok("https://web.forge.test/apiary/login".into())
        );
        // a URL the secret names is its own, whatever the deployment routes
        let own = target("https://login.forge.test/session").unwrap();
        assert_eq!(
            sign_in_url(&own, Some(&d)).unwrap().as_str(),
            "https://login.forge.test/session"
        );
        assert_eq!(
            target("POST /api/auth/local"),
            Ok(Target::Path("/api/auth/local".into()))
        );
    }

    #[test]
    fn a_cleared_cookie_is_dropped_and_a_kept_one_reads_as_playwright_writes_it() {
        assert!(parse_set_cookie("forge_auth=; Max-Age=0; Path=/", "h", 100).is_none());
        let c = parse_set_cookie(
            "forge_auth=\"v\"; Max-Age=60; Domain=.Forge.test; Path=/x; HttpOnly; Secure; SameSite=None",
            "h",
            100,
        )
        .unwrap();
        assert_eq!(
            (
                c.value.as_str(),
                c.domain.as_str(),
                c.path.as_str(),
                c.expires
            ),
            ("v", ".forge.test", "/x", 160)
        );
        assert!(c.http_only && c.secure && c.same_site == "None");
        // no Max-Age is a session cookie, host-only, at `/`
        let s = parse_set_cookie("a=b", "api.forge.test", 100).unwrap();
        assert_eq!(
            (s.domain.as_str(), s.path.as_str(), s.expires, s.same_site),
            ("api.forge.test", "/", -1, "Lax")
        );
    }

    #[test]
    fn neither_debug_shows_a_value() {
        let secret = parse_secret(
            &json!({ "signIn": "/api/auth/local", "email": "e@x.test", "password": "pw-959-secret" })
                .to_string(),
        )
        .unwrap();
        let shown = format!("{secret:?}");
        assert!(
            !shown.contains("pw-959-secret") && !shown.contains("e@x.test"),
            "{shown}"
        );
    }
}
