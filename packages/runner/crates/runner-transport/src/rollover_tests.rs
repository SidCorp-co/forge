//! A core on a loopback port that answers a script, one reply per connection, and records each
//! request it read: what a deploy's rollover looks like to the runner (ISS-1022).

use super::*;
use crate::CoreClient;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const DRAINING: &str = r#"{"code":"CORE_DRAINING","error":{"code":"CORE_DRAINING","message":"core is shutting down"}}"#;
const NO_CONNECTION: &str =
    r#"{"code":"DB_CONNECTIONS_EXHAUSTED","error":{"code":"DB_CONNECTIONS_EXHAUSTED"}}"#;
const TRAEFIK: &str = "no available server";

/// Fast enough for a test, the same shape as [`ROLLOVER`].
const QUICK: Rollover = Rollover {
    budget: Duration::from_secs(5),
    first_pause: Duration::from_millis(10),
    longest_pause: Duration::from_millis(40),
};

#[derive(Clone)]
struct Reply {
    status: &'static str,
    headers: &'static str,
    body: &'static str,
}

fn reply(status: &'static str, body: &'static str) -> Reply {
    Reply {
        status,
        headers: "",
        body,
    }
}

/// Answers `script` in order and its last reply from then on; hands back each request as read.
async fn scripted(script: Vec<Reply>) -> (CoreClient, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    tokio::spawn(async move {
        let mut n = 0usize;
        while let Ok((mut sock, _)) = listener.accept().await {
            let one = script[n.min(script.len() - 1)].clone();
            n += 1;
            let request = read_request(&mut sock).await;
            record.lock().unwrap().push(request);
            let answer = format!(
                "HTTP/1.1 {}\r\n{}content-length: {}\r\nconnection: close\r\n\r\n{}",
                one.status,
                one.headers,
                one.body.len(),
                one.body
            );
            let _ = sock.write_all(answer.as_bytes()).await;
        }
    });
    let client = CoreClient::new(format!("http://{addr}"), "device-token").with_rollover(QUICK);
    (client, seen)
}

/// The head and as much body as its content-length names.
async fn read_request(sock: &mut tokio::net::TcpStream) -> String {
    let mut seen = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let text = String::from_utf8_lossy(&seen).to_string();
        if let Some(end) = text.find("\r\n\r\n") {
            let length = text[..end]
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            if seen.len() >= end + 4 + length {
                return text;
            }
        }
        let n = sock.read(&mut buf).await.unwrap_or(0);
        if n == 0 {
            return String::from_utf8_lossy(&seen).to_string();
        }
        seen.extend_from_slice(&buf[..n]);
    }
}

#[tokio::test]
async fn a_post_through_a_draining_core_and_traefik_with_no_backend_lands_once_core_is_back() {
    let (client, seen) = scripted(vec![
        reply("503 Service Unavailable", DRAINING),
        reply("503 Service Unavailable", TRAEFIK),
        reply("200 OK", r#"{"ok":true}"#),
    ])
    .await;
    let resp = client
        .post("/api/jobs/j1/ack")
        .json(&serde_json::json!({ "n": 1 }))
        .send()
        .await
        .expect("a rollover's 503s were not waited out");
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(resp.text().await.unwrap(), r#"{"ok":true}"#);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 3, "{seen:?}");
    for request in seen.iter() {
        assert!(request.starts_with("POST /api/jobs/j1/ack "), "{request}");
        assert!(
            request.ends_with(r#"{"n":1}"#),
            "the body was not sent again: {request}"
        );
    }
}

#[tokio::test]
async fn a_500_is_handed_back_at_once_and_never_sent_again() {
    let (client, seen) = scripted(vec![
        reply("500 Internal Server Error", r#"{"code":"INTERNAL"}"#),
        reply("200 OK", "{}"),
    ])
    .await;
    let resp = client.get("/api/x").send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 500);
    assert_eq!(seen.lock().unwrap().len(), 1, "a 500 was retried");
}

#[tokio::test]
async fn a_503_naming_another_code_is_handed_back_whole_and_never_sent_again() {
    let other = r#"{"code":"SOMETHING_ELSE"}"#;
    let (client, seen) = scripted(vec![
        reply("503 Service Unavailable", other),
        reply("200 OK", "{}"),
    ])
    .await;
    let resp = client.get("/api/x?y=1").send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 503);
    assert_eq!(
        resp.url().path(),
        "/api/x",
        "the rebuilt answer lost its url"
    );
    assert_eq!(resp.text().await.unwrap(), other);
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_core_unready_past_the_budget_gives_up_naming_its_code_the_attempts_and_the_time() {
    let (client, seen) = scripted(vec![reply("503 Service Unavailable", DRAINING)]).await;
    let client = client.with_rollover(Rollover {
        budget: Duration::from_millis(300),
        ..QUICK
    });
    let err = client.get("/api/x").send().await.unwrap_err();
    let SendError::RolledOver(gave_up) = &err else {
        panic!("a core draining past the budget read as {err:?}");
    };
    assert_eq!(gave_up.last, Unready::Draining);
    assert!(gave_up.elapsed >= Duration::from_millis(300), "{gave_up:?}");
    assert_eq!(gave_up.attempts as usize, seen.lock().unwrap().len());
    assert!(gave_up.attempts >= 3, "{gave_up:?}");
    let said = err.to_string();
    assert!(said.contains("503 CORE_DRAINING"), "{said}");
    assert!(
        said.contains(&format!("{} attempts", gave_up.attempts)),
        "{said}"
    );
}

#[tokio::test]
async fn traefik_with_no_backend_past_the_budget_is_named_as_such() {
    let (client, _) = scripted(vec![reply("503 Service Unavailable", TRAEFIK)]).await;
    let client = client.with_rollover(Rollover {
        budget: Duration::from_millis(100),
        ..QUICK
    });
    let err = client.delete("/api/x").send().await.unwrap_err();
    assert!(err.to_string().contains("503 NO_AVAILABLE_SERVER"), "{err}");
}

#[tokio::test]
async fn a_post_refused_for_want_of_a_connection_is_handed_back_since_it_reached_a_handler() {
    let (client, seen) = scripted(vec![
        reply("503 Service Unavailable", NO_CONNECTION),
        reply("200 OK", "{}"),
    ])
    .await;
    let resp = client.post("/api/x").send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 503);
    assert_eq!(resp.text().await.unwrap(), NO_CONNECTION);
    assert_eq!(
        seen.lock().unwrap().len(),
        1,
        "a POST that reached a handler was sent again"
    );
}

#[tokio::test]
async fn a_get_refused_for_want_of_a_connection_waits_the_retry_after_core_names() {
    let (client, seen) = scripted(vec![
        Reply {
            status: "503 Service Unavailable",
            headers: "retry-after: 1\r\n",
            body: NO_CONNECTION,
        },
        reply("200 OK", "{}"),
    ])
    .await;
    let started = Instant::now();
    let resp = client.get("/api/x").send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(seen.lock().unwrap().len(), 2);
    assert!(
        started.elapsed() >= Duration::from_secs(1),
        "Retry-After: 1 was not waited: {:?}",
        started.elapsed()
    );
}

/// Every caller's own sentence carries the give-up, through the helpers most routes use.
#[tokio::test]
async fn a_route_through_the_status_helpers_fails_naming_the_rollover() {
    let (client, _) = scripted(vec![reply("503 Service Unavailable", DRAINING)]).await;
    let client = client.with_rollover(Rollover {
        budget: Duration::from_millis(100),
        ..QUICK
    });
    let err = crate::status::fetch::<serde_json::Value>(client.get("/api/x"), "x read")
        .await
        .unwrap_err()
        .to_string();
    assert!(
        err.starts_with("x read request: core answered 503 CORE_DRAINING"),
        "{err}"
    );
}

/// `forge-runner api` exits as the 503 it kept getting, by its code, never as a transport fault.
#[tokio::test]
async fn forge_runner_api_gives_up_as_the_503_by_its_code() {
    let (client, _) = scripted(vec![reply("503 Service Unavailable", DRAINING)]).await;
    let client = client.with_rollover(Rollover {
        budget: Duration::from_millis(100),
        ..QUICK
    });
    let req = crate::api::Request {
        method: "POST".into(),
        path: "/issues".into(),
        body: None,
        project_slug: None,
        headers: Vec::new(),
        include_headers: false,
    };
    let out = crate::api::run(&client, &req).await;
    assert_eq!(out.outcome.code, "CORE_DRAINING");
    assert_eq!(out.outcome.exit_code, 8);
    assert!(out.stderr.contains("attempts over"), "{}", out.stderr);
}

#[test]
fn only_the_three_rollover_answers_are_unready() {
    let unavailable = StatusCode::SERVICE_UNAVAILABLE;
    assert_eq!(Unready::of(unavailable, DRAINING), Some(Unready::Draining));
    assert_eq!(
        Unready::of(unavailable, NO_CONNECTION),
        Some(Unready::NoConnection)
    );
    assert_eq!(
        Unready::of(unavailable, "no available server\n"),
        Some(Unready::NoServer)
    );
    assert_eq!(Unready::of(StatusCode::BAD_GATEWAY, TRAEFIK), None);
    assert_eq!(
        Unready::of(StatusCode::INTERNAL_SERVER_ERROR, DRAINING),
        None
    );
    assert_eq!(Unready::of(unavailable, ""), None);
    assert_eq!(
        Unready::of(unavailable, "<html><title>503</title></html>"),
        None
    );
}
