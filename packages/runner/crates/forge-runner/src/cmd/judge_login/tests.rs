//! `judge-login` against a stub deployment on loopback: the sign-in it makes, the session it
//! writes, what it refuses, and the close that removes it (ISS-959). Nothing here reaches a real
//! deployment or reads a real secret.

use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

const EMAIL: &str = "qa-member@forge.test";
const PASSWORD: &str = "Corr3ct-H0rse-Battery-959";
const TOKEN: &str = "session-jwt-0b7e2c";
const COOKIE_JWT: &str = "cookie-jwt-51d0aa";
const REFRESH: &str = "refresh-7f3e19";
const RUN: &str = "53077902-cb16-408f-904c-e0e4b762a1c9";

/// A directory under `$TMPDIR`, removed when the test ends.
struct Scratch(PathBuf);
impl Scratch {
    fn new(name: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "forge-judge-login-test-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// How the stub's sign-in route answers a right password.
#[derive(Clone, Copy)]
enum Answers {
    /// `{ token }` and the cookies core sets: forge's own `/api/auth/local`.
    TokenAndCookies,
    /// Cookies alone, no token in the body.
    CookiesOnly,
    /// A `307` to another origin, which a password must never follow.
    Redirect,
}

/// One request the stub saw: its request line, its headers (lowercased names) and its body.
#[derive(Debug, Clone)]
struct Seen {
    line: String,
    headers: String,
    body: String,
}

/// A deployment on loopback: `POST /api/auth/local` signs `EMAIL` in with `PASSWORD`, and
/// `GET /api/me` answers 200 only to the session it handed out.
async fn stub(answers: Answers) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::<Seen>::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let (head, body) = loop {
                let n = sock.read(&mut chunk).await.unwrap_or(0);
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let want = head
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            k.eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    if body.len() >= want || n == 0 {
                        break (head.to_string(), body.to_string());
                    }
                } else if n == 0 {
                    break (text, String::new());
                }
            };
            let line = head.lines().next().unwrap_or("").to_string();
            let headers = head
                .lines()
                .skip(1)
                .map(|l| match l.split_once(':') {
                    Some((k, v)) => format!("{}:{}", k.to_ascii_lowercase(), v),
                    None => l.to_string(),
                })
                .collect::<Vec<_>>()
                .join("\n");
            log.lock().unwrap().push(Seen {
                line: line.clone(),
                headers: headers.clone(),
                body: body.clone(),
            });
            let resp = respond(answers, &line, &headers, &body);
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
        }
    });
    (base, seen)
}

fn http(status: &str, extra: &[String], body: &str) -> String {
    let mut head = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\n");
    for h in extra {
        head.push_str(h);
        head.push_str("\r\n");
    }
    format!(
        "{head}content-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn respond(answers: Answers, line: &str, headers: &str, body: &str) -> String {
    if line.starts_with("POST /api/auth/local ") {
        let sent: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        if sent != json!({ "email": EMAIL, "password": PASSWORD }) {
            let refused =
                json!({ "code": "INVALID_CREDENTIALS", "message": "invalid credentials" });
            return http("401 Unauthorized", &[], &refused.to_string());
        }
        let cookies = vec![
            // core clears the host-only cookie before it writes the one under its domain
            "set-cookie: forge_auth=; Max-Age=0; Path=/".to_string(),
            format!("set-cookie: forge_auth={COOKIE_JWT}; Max-Age=900; Domain=forge.test; Path=/; HttpOnly; Secure; SameSite=Lax"),
            format!("set-cookie: forge_refresh={REFRESH}; Max-Age=2592000; Path=/api/auth; HttpOnly; SameSite=Strict"),
        ];
        return match answers {
            Answers::TokenAndCookies => http(
                "200 OK",
                &cookies,
                &json!({ "token": TOKEN, "user": { "email": EMAIL } }).to_string(),
            ),
            Answers::CookiesOnly => http("200 OK", &cookies, &json!({ "user": {} }).to_string()),
            Answers::Redirect => http(
                "307 Temporary Redirect",
                &["location: https://elsewhere.example/api/auth/local".to_string()],
                "{}",
            ),
        };
    }
    if line.starts_with("GET /api/me ") {
        let bearer = headers.contains(&format!("authorization: Bearer {TOKEN}"));
        let cookie = headers
            .lines()
            .any(|l| l.starts_with("cookie:") && l.contains(&format!("forge_auth={COOKIE_JWT}")));
        return if bearer || cookie {
            http("200 OK", &[], r#"{"email":"seen"}"#)
        } else {
            http("401 Unauthorized", &[], r#"{"code":"UNAUTHENTICATED"}"#)
        };
    }
    http("404 Not Found", &[], "{}")
}

fn secret(fields: Value) -> String {
    fields.to_string()
}

fn forge_secret() -> String {
    secret(json!({
        "kind": "forge-password",
        "signIn": "POST /api/auth/local",
        "email": EMAIL,
        "password": PASSWORD,
    }))
}

/// Core's answer to the read: the one secret, and the deployment the run judges, whose `/api`
/// paths are answered by the `api` service — the stub.
fn answer(api: &str, value: &str) -> Value {
    json!({
        "jobId": null,
        "environment": "dev",
        "profileId": "dev",
        "secrets": [{ "ref": "secret://dev/qa", "value": value }],
        "deployment": {
            "environment": "dev",
            "url": "https://web.forge.test",
            "services": { "api": api },
            "routes": { "api": ["/api", "/health"] },
        },
    })
}

/// Every file under `dir`, with its bytes.
fn files_in(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| (e.path(), std::fs::read(e.path()).unwrap()))
        .collect()
}

fn holds(bytes: &[u8], needle: &str) -> bool {
    bytes.windows(needle.len()).any(|w| w == needle.as_bytes())
}

#[tokio::test]
async fn no_file_judge_login_writes_holds_the_password() {
    let (api, seen) = stub(Answers::TokenAndCookies).await;
    let root = Scratch::new("nopassword");
    let dir = root.0.join(format!("forge-judge-{RUN}"));
    // the login file a judge-login from before ISS-959 left, holding the password
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("dev-actor-member.json"), forge_secret()).unwrap();

    let (files, signed_in) = login_into(&answer(&api, &forge_secret()), &dir, "dev", "member")
        .await
        .unwrap();

    // the password went to the sign-in route, inside this process, and nowhere else
    let sent = seen.lock().unwrap().clone();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert!(
        sent[0].line.starts_with("POST /api/auth/local "),
        "{sent:?}"
    );
    assert!(sent[0].body.contains(PASSWORD));

    let written = files_in(&dir);
    let names: Vec<_> = written
        .iter()
        .map(|(p, _)| p.file_name().unwrap().to_string_lossy().to_string())
        .collect();
    assert_eq!(written.len(), 2, "{names:?}");
    assert!(!dir.join("dev-actor-member.json").exists(), "{names:?}");
    for (path, bytes) in &written {
        assert!(
            !holds(bytes, PASSWORD),
            "{} holds the password",
            path.display()
        );
        assert!(!holds(bytes, EMAIL), "{} holds the account", path.display());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{}", path.display());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    // the line printed names the paths and the origin, and no value of any kind
    let line = said("dev", "member", &files, &signed_in, "recorded on run x");
    for value in [PASSWORD, EMAIL, TOKEN, COOKIE_JWT, REFRESH] {
        assert!(!line.contains(value), "{line}");
    }
    assert!(
        line.contains(&format!("curl -H @{}", files.header.display())),
        "{line}"
    );
    assert!(
        line.contains(&format!("storageState: '{}'", files.state.display())),
        "{line}"
    );
    assert!(
        line.contains(&format!(
            "signed in as actor `member` of profile `dev` at {api}/api/auth/local"
        )),
        "{line}"
    );
    assert!(line.ends_with("recorded on run x"), "{line}");
}

/// curl as a judge runs it, or — on a box with none — the header sent as curl sends a `-H @file`
/// line. Answers the status `GET <base>/api/me` got.
async fn get_me_with(header: &Path, base: &str) -> String {
    let url = format!("{base}/api/me");
    if which::which("curl").is_ok() {
        let out = tokio::process::Command::new("curl")
            .args(["-sS", "-o"])
            .arg(header.with_extension("out"))
            .args(["-w", "%{http_code}", "-H"])
            .arg(format!("@{}", header.display()))
            .arg(&url)
            .output()
            .await
            .unwrap();
        return String::from_utf8_lossy(&out.stdout).to_string();
    }
    let text = std::fs::read_to_string(header).unwrap();
    let (name, value) = text.trim_end().split_once(": ").unwrap();
    reqwest::Client::new()
        .get(&url)
        .header(name, value)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
        .to_string()
}

#[tokio::test]
async fn the_header_file_reaches_the_api_as_curl_sends_it() {
    let (api, _) = stub(Answers::TokenAndCookies).await;
    let root = Scratch::new("header");
    let dir = root.0.join(format!("forge-judge-{RUN}"));
    let (files, _) = login_into(&answer(&api, &forge_secret()), &dir, "dev", "member")
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&files.header).unwrap(),
        format!("Authorization: Bearer {TOKEN}\n")
    );
    assert_eq!(get_me_with(&files.header, &api).await, "200");

    // a sign-in answering no token hands the cookies it set as one `Cookie:` line instead
    let (cookies_only, _) = stub(Answers::CookiesOnly).await;
    let dir = root.0.join("cookies");
    let (files, _) = login_into(
        &answer(&cookies_only, &forge_secret()),
        &dir,
        "dev",
        "member",
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(&files.header).unwrap(),
        format!("Cookie: forge_auth={COOKIE_JWT}; forge_refresh={REFRESH}\n")
    );
    assert_eq!(get_me_with(&files.header, &cookies_only).await, "200");
}

#[tokio::test]
async fn the_storage_state_is_playwrights_shape() {
    let (api, _) = stub(Answers::TokenAndCookies).await;
    let root = Scratch::new("state");
    let dir = root.0.join(format!("forge-judge-{RUN}"));
    let (files, _) = login_into(&answer(&api, &forge_secret()), &dir, "dev", "member")
        .await
        .unwrap();
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(&files.state).unwrap()).unwrap();
    let top: Vec<&String> = state.as_object().unwrap().keys().collect();
    assert_eq!(top, ["cookies", "origins"]);
    let cookies = state["cookies"].as_array().unwrap();
    // the cleared host-only cookie is gone; the two core set stand, each in Playwright's fields
    assert_eq!(cookies.len(), 2, "{cookies:?}");
    for c in cookies {
        let keys: std::collections::BTreeSet<&str> =
            c.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            ["domain", "expires", "httpOnly", "name", "path", "sameSite", "secure", "value"]
                .into_iter()
                .collect()
        );
        assert!(
            c["expires"].is_i64() && c["expires"].as_i64().unwrap() > 0,
            "{c}"
        );
        assert!(
            c["httpOnly"].is_boolean() && c["secure"].is_boolean(),
            "{c}"
        );
        assert!(
            ["Strict", "Lax", "None"].contains(&c["sameSite"].as_str().unwrap()),
            "{c}"
        );
    }
    assert_eq!(cookies[0]["name"], "forge_auth");
    assert_eq!(cookies[0]["value"], COOKIE_JWT);
    assert_eq!(cookies[0]["domain"], ".forge.test");
    assert_eq!(cookies[0]["secure"], true);
    assert_eq!(cookies[1]["name"], "forge_refresh");
    assert_eq!(cookies[1]["domain"], "127.0.0.1");
    assert_eq!(cookies[1]["path"], "/api/auth");
    assert_eq!(cookies[1]["sameSite"], "Strict");
    assert_eq!(state["origins"], json!([]));

    // a secret naming the key its web app reads the token from has it stored for the web origin
    let keyed = secret(json!({
        "signIn": "POST /api/auth/local",
        "email": EMAIL,
        "password": PASSWORD,
        "storageKey": "forge.token",
    }));
    let dir = root.0.join("keyed");
    let (files, _) = login_into(&answer(&api, &keyed), &dir, "dev", "member")
        .await
        .unwrap();
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(&files.state).unwrap()).unwrap();
    assert_eq!(
        state["origins"],
        json!([{ "origin": "https://web.forge.test", "localStorage": [{ "name": "forge.token", "value": TOKEN }] }])
    );
}

#[tokio::test]
async fn a_profile_it_cannot_sign_in_for_is_refused_by_name_and_nothing_is_written() {
    let (api, _) = stub(Answers::TokenAndCookies).await;
    let (redirecting, _) = stub(Answers::Redirect).await;
    let root = Scratch::new("refused");
    let with = |extra: Value| {
        let mut o =
            json!({ "signIn": "POST /api/auth/local", "email": EMAIL, "password": PASSWORD });
        for (k, v) in extra.as_object().unwrap() {
            if v.is_null() {
                o.as_object_mut().unwrap().remove(k);
            } else {
                o[k] = v.clone();
            }
        }
        o.to_string()
    };
    let unrouted = {
        let mut a = answer(&api, &forge_secret());
        a["deployment"]["routes"] = Value::Null;
        a
    };
    let undeployed = {
        let mut a = answer(&api, &forge_secret());
        a.as_object_mut().unwrap().remove("deployment");
        a
    };
    let cases: Vec<(&str, Value, &str)> = vec![
        (
            "a plain account:password value",
            answer(&api, &format!("{EMAIL}:{PASSWORD}")),
            "is not the self-describing form",
        ),
        (
            "a key with no password",
            answer(&api, &secret(json!({ "kind": "api-key", "key": PASSWORD }))),
            "(kind `api-key`) names no `password`",
        ),
        (
            "an account under no field a route reads",
            answer(&api, &with(json!({ "email": null, "account": EMAIL }))),
            "names its account as `account`",
        ),
        (
            "two accounts",
            answer(&api, &with(json!({ "login": EMAIL }))),
            "names `email` and `login` at once",
        ),
        (
            "no sign-in route",
            answer(&api, &with(json!({ "signIn": null }))),
            "names no sign-in route",
        ),
        (
            "a GET route",
            answer(&api, &with(json!({ "signIn": "GET /api/auth/local" }))),
            "is a `GET`",
        ),
        (
            "a plain-http route off this machine",
            answer(
                &api,
                &with(json!({ "signIn": "http://forge.test/api/auth/local" })),
            ),
            "over https only",
        ),
        (
            "a route with a user part",
            answer(
                &api,
                &with(json!({ "signIn": "https://u:p@forge.test/api/auth/local" })),
            ),
            "carries a user part",
        ),
        (
            "a wrong password",
            answer(&api, &with(json!({ "password": "not-the-password" }))),
            "was refused: 401 Unauthorized INVALID_CREDENTIALS; nothing was written",
        ),
        (
            "a redirect",
            answer(&redirecting, &forge_secret()),
            "a redirect, and judge-login sends a password to no second origin",
        ),
        (
            "services and no routes",
            unrouted,
            "declares services and no `routes`",
        ),
        (
            "no deployment from core",
            undeployed,
            "core answered no deployment",
        ),
    ];
    for (i, (case, answered, says)) in cases.into_iter().enumerate() {
        let dir = root.0.join(format!("case-{i}"));
        let err = login_into(&answered, &dir, "dev", "member")
            .await
            .unwrap_err();
        assert!(err.contains(says), "{case}: {err}");
        assert!(
            !err.contains(PASSWORD) && !err.contains(EMAIL),
            "{case}: {err}"
        );
        assert!(
            !dir.exists(),
            "{case}: something was written into {}",
            dir.display()
        );
    }

    // a service is refused before anything is read
    let service = named("dev", None, Some("store"), "self").unwrap_err();
    assert!(
        service.contains("--service `store` names a service's credential"),
        "{service}"
    );
    assert!(service.contains("Nothing was read or written"), "{service}");
}

#[tokio::test]
async fn the_runs_close_removes_the_session_files() {
    let (api, _) = stub(Answers::TokenAndCookies).await;
    let root = Scratch::new("close");
    let (dir, run) = where_to_write(None, RUN, &json!({ "jobId": null }));
    assert_eq!(run, Ok(RUN.to_string()));
    // where judge-login writes is the run's directory under the root a close reads
    assert_eq!(dir, judge_dir::dir(&judge_dir::root(), RUN).unwrap());
    let dir = judge_dir::dir(&root.0, RUN).unwrap();
    let (files, _) = login_into(&answer(&api, &forge_secret()), &dir, "dev", "member")
        .await
        .unwrap();
    assert!(files.header.starts_with(&dir) && files.state.starts_with(&dir));
    assert!(files.header.exists() && files.state.exists());

    let removals = judge_dir::remove_for_run(Ok(vec![]), &root.0, RUN);
    assert!(
        matches!(removals.as_slice(), [judge_dir::Removal::Removed(p)] if *p == dir),
        "{removals:?}"
    );
    assert!(!files.header.exists() && !files.state.exists());
    assert!(!dir.exists());
    let line = removals[0].said().unwrap();
    assert!(
        line.contains("the test session its judge was handed"),
        "{line}"
    );
}

#[test]
fn a_read_names_one_actor_and_never_the_whole_profile() {
    assert_eq!(
        named("stg", Some("admin"), None, "self"),
        Ok("admin".into())
    );
    let none = named("stg", None, None, "self").unwrap_err();
    assert!(none.contains("never handed the whole profile"), "{none}");
    for (profile, actor, run) in [
        ("stg", "admin&service=store", "self"),
        ("stg/../x", "admin", "self"),
        ("stg", "admin", "not-a-run"),
    ] {
        assert!(
            named(profile, Some(actor), None, run).is_err(),
            "{profile} {actor} {run}"
        );
    }
}

#[test]
fn the_path_asks_for_the_one_actor_as_self_or_the_run() {
    assert_eq!(
        secret_path("stg", "self", "admin"),
        "/api/jobs/self/testing-profiles/stg/secrets?actor=admin"
    );
    assert_eq!(
        secret_path("stg", RUN, "admin"),
        format!("/api/jobs/{RUN}/testing-profiles/stg/secrets?actor=admin")
    );
}

#[test]
fn one_secret_is_read_and_more_than_one_is_refused() {
    let one = answer("http://127.0.0.1:1", &forge_secret());
    assert_eq!(secret_of(&one), Ok(forge_secret().as_str()));
    let mut two = one.clone();
    two["secrets"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "ref": "secret://dev/other", "value": PASSWORD }));
    let err = secret_of(&two).unwrap_err();
    assert!(
        err.contains("2 secrets for one name") && !err.contains(PASSWORD),
        "{err}"
    );
}

#[test]
fn the_session_is_written_where_its_runs_close_removes_it() {
    let root = judge_dir::root();
    let none = json!({ "jobId": null });
    let ours = || Ok(RUN.to_string());
    assert_eq!(
        where_to_write(None, RUN, &none),
        (judge_dir::dir(&root, RUN).unwrap(), ours())
    );
    // a `self` this checkout could not name is the run core answered for
    let core = json!({ "jobId": RUN });
    assert_eq!(
        where_to_write(None, "self", &core),
        (judge_dir::dir(&root, RUN).unwrap(), ours())
    );
    // a read naming no run is nobody's close to remove, and says why
    let (unnamed, by) = where_to_write(None, "self", &none);
    assert_eq!(unnamed, root.join("forge-judge-self"));
    assert!(by.unwrap_err().contains("named no run"));
    // an --out-dir named for the run is recorded on it; any other is not, and says why
    let named = PathBuf::from(format!("/somewhere/forge-judge-{RUN}"));
    assert_eq!(
        where_to_write(Some(named.clone()), RUN, &core),
        (named, ours())
    );
    let asked = PathBuf::from("/somewhere/else");
    let (d, by) = where_to_write(Some(asked.clone()), RUN, &core);
    assert_eq!(d, asked);
    assert!(by.unwrap_err().contains("is not named forge-judge-"));
}

#[test]
fn the_line_says_where_the_session_is_recorded_or_why_it_is_not() {
    let dir = PathBuf::from(format!("/t/forge-judge-{RUN}"));
    let recorded = who_removes(&dir, Ok(RUN), |_, d| Ok(d.to_path_buf()));
    assert_eq!(
        recorded,
        format!(
            "recorded on run {RUN}, whose close removes {}",
            dir.display()
        )
    );
    let unrecorded = who_removes(&dir, Ok(RUN), |_, _| Err("no ledger".into()));
    assert!(unrecorded.contains("not recorded on run") && unrecorded.contains("no ledger"));
    let nobody = who_removes(&dir, Err("no run"), |_, _| unreachable!());
    assert!(
        nobody.contains("no run's close removes it (no run)"),
        "{nobody}"
    );
}
