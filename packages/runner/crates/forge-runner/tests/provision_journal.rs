//! What an operator reads in the journal while the control plane refuses this
//! box's provision poll, driven through the sweep the daemon actually calls.
//!
//! This exists because every unit test behind it can be green while the
//! journal is unchanged. `Streak` proves the policy and `pull_pending` proves
//! the subject, and neither proves that `run_pending` — the one function the
//! daemon's 90-second tick calls — routes its error through either of them.
//! ISS-1206 is that gap in the other direction: the sweep logged 685 identical
//! `provisions failed: 500 Internal Server Error` lines in a day on
//! `sid-xeon-1`, naming neither the endpoint nor the body, and nothing between
//! the transport and the tick was wrong enough to notice.
//!
//! One test, not several: the streak is one per process by design, so two
//! tests in this binary would race each other through it. What that costs is
//! that the file fails as a whole; what it buys is that the sequence asserted
//! here is the sequence one box lives through.

use std::sync::{Arc, Mutex};

use forge_runner_core::config::Config;
use forge_runner_core::transport::CoreClient;
use forge_runner_core::workspace::provision::run_pending;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A core whose answer the test changes under the sweep's feet, the way a
/// control plane recovers under a daemon that never stopped polling.
async fn serve_switchable(first: (&str, &str)) -> (String, Arc<Mutex<(String, String)>>) {
    let answer = Arc::new(Mutex::new((first.0.to_string(), first.1.to_string())));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let served = answer.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let served = served.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let (status, body) = served.lock().unwrap().clone();
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    (format!("http://{addr}"), answer)
}

#[derive(Clone)]
struct Journal(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Journal {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Journal {
    fn read(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap().clone()).into_owned()
    }
}

#[tokio::test]
async fn the_sweep_reports_a_refusal_once_escalates_once_and_says_when_it_clears() {
    let journal = Journal(Arc::new(Mutex::new(Vec::new())));
    let writer = journal.clone();
    tracing::subscriber::set_global_default(
        tracing_subscriber::fmt()
            .with_writer(move || writer.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .finish(),
    )
    .expect("no other subscriber in this test binary");

    let (base, answer) = serve_switchable((
        "500 Internal Server Error",
        r#"{"error":"provision rows could not be listed"}"#,
    ))
    .await;
    let client = CoreClient::new(&base, "device-token");
    let cfg = Config::default();

    for _ in 0..7 {
        run_pending(&client, &cfg).await;
    }

    let refusing = journal.read();
    let lines: Vec<&str> = refusing
        .lines()
        .filter(|l| l.contains("[provision]"))
        .collect();
    assert_eq!(
        lines.len(),
        2,
        "seven refusals owe one warning and one escalation, not seven lines:\n{refusing}"
    );

    // The first: attributable on its own, which is the whole of ISS-1206's
    // first half. Endpoint, status and body, in the line a person greps.
    assert!(lines[0].contains("WARN"), "{:?}", lines[0]);
    assert!(
        lines[0].contains(&format!("GET {base}/api/devices/me/provisions")),
        "{:?}",
        lines[0]
    );
    assert!(
        lines[0].contains("500 Internal Server Error"),
        "{:?}",
        lines[0]
    );
    assert!(
        lines[0].contains(r#"{"error":"provision rows could not be listed"}"#),
        "{:?}",
        lines[0]
    );

    // The second: the condition has stopped being a warning, said once.
    assert!(lines[1].contains("ERROR"), "{:?}", lines[1]);
    assert!(lines[1].contains("5 consecutive times"), "{:?}", lines[1]);
    assert!(
        lines[1].contains(&format!("GET {base}/api/devices/me/provisions")),
        "{:?}",
        lines[1]
    );

    // Then core comes back, and the sweep says so rather than going quiet
    // about an incident it spent an hour reporting.
    *answer.lock().unwrap() = ("200 OK".to_string(), "[]".to_string());
    run_pending(&client, &cfg).await;

    let whole = journal.read();
    let after: Vec<&str> = whole
        .lines()
        .filter(|l| l.contains("[provision]"))
        .skip(2)
        .collect();
    assert_eq!(
        after.len(),
        1,
        "the recovery is one line:\n{}",
        &whole[refusing.len()..]
    );
    assert!(after[0].contains("INFO"), "{:?}", after[0]);
    assert!(
        after[0].contains("recovered after 7 consecutive refusal(s)"),
        "{:?}",
        after[0]
    );
    assert!(
        after[0].contains(&format!("GET {base}/api/devices/me/provisions")),
        "{:?}",
        after[0]
    );

    // And a quiet sweep stays quiet: nothing is added for a success with
    // nothing standing.
    run_pending(&client, &cfg).await;
    assert_eq!(
        journal
            .read()
            .lines()
            .filter(|l| l.contains("[provision]"))
            .count(),
        3,
        "a success with no streak standing writes nothing"
    );
}
