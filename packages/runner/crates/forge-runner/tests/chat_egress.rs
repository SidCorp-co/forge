//! A confined chat session reaches the hosts its egress proxy was started with and nothing
//! else, through this build's own `forge-runner egress-bridge`.
//!
//! The sandbox runs a shell that tries every way out a prompt-injected chat would: `curl` to a
//! host off the list through the proxy, and `curl` around the proxy to an address. An allowed
//! host — a one-request server on the box's loopback — is reached through the proxy both as a
//! plain request and as a `CONNECT` tunnel. No real network is used: the refused host is refused
//! before any lookup, and the bypass fails for want of an interface.
#![cfg(target_os = "linux")]

use std::path::PathBuf;

use runner_platform::confine::egress::{Egress, Host, Proxy, REFUSAL};
use runner_platform::confine::{availability, Availability, Sandbox};

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn bwrap_or_skip(test: &str) -> bool {
    match availability() {
        Availability::Available => true,
        Availability::Unavailable(why) => match std::env::var("FORGE_TEST_SKIP_BWRAP") {
            Ok(v) if v == "1" => {
                eprintln!(
                    "SKIPPED {test}: this box cannot confine ({why}) and FORGE_TEST_SKIP_BWRAP=1 \
                     opted this run out — nothing was asserted"
                );
                false
            }
            _ => panic!(
                "BWRAP_UNAVAILABLE: {test} needs bubblewrap to start a sandbox ({why}) — install \
                 it, or set FORGE_TEST_SKIP_BWRAP=1 to skip it by name"
            ),
        },
    }
}

/// A server on the box's loopback answering every request with `ALLOWED-REACHED`.
async fn allowed_server() -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut conn, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let _ = conn.read(&mut buf).await;
                let body = "ALLOWED-REACHED";
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = conn.write_all(reply.as_bytes()).await;
            });
        }
    });
    port
}

#[tokio::test]
async fn a_confined_shell_reaches_only_the_allowed_host_and_curl_elsewhere_is_refused() {
    if !bwrap_or_skip("a_confined_shell_reaches_only_the_allowed_host") {
        return;
    }
    assert!(
        which::which("curl").is_ok(),
        "CURL_UNAVAILABLE: this test drives the sandbox's network with curl"
    );
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let scratch =
        Scratch(std::env::temp_dir().join(format!("egress-{}-{nanos}", std::process::id())));
    std::fs::create_dir_all(&scratch.0).unwrap();
    let socket = scratch.0.join("e").join("s");
    let port = allowed_server().await;
    let allowed = Host::parse(&format!("127.0.0.1:{port}")).unwrap();
    let _proxy = Proxy::start(&socket, vec![allowed], None).expect("the egress proxy listens");

    let script = format!(
        "curl -sS -o /dev/null -w 'REFUSED=%{{http_connect}}\\n' --max-time 10 https://example.com/ 2>&1; \
         echo \"REFUSED_RC=$?\"; \
         echo \"PLAIN_REFUSED=$(curl -sS --max-time 10 http://example.com/)\"; \
         curl -sS --max-time 5 --noproxy '*' -o /dev/null http://1.1.1.1/ 2>/dev/null; \
         echo \"BYPASS_RC=$?\"; \
         echo \"PLAIN=$(curl -sS --max-time 10 --noproxy '' -x \"$HTTP_PROXY\" http://127.0.0.1:{port}/)\"; \
         echo \"TUNNEL=$(curl -sS --max-time 10 --noproxy '' -x \"$HTTP_PROXY\" -p http://127.0.0.1:{port}/)\"; \
         exit 7"
    );
    let sandbox = Sandbox {
        mounts: vec![],
        env: vec![("PATH".into(), "/usr/bin:/bin".into())],
        cwd: "/".into(),
        egress: Some(Egress {
            socket: socket.clone(),
            bridge: PathBuf::from(env!("CARGO_BIN_EXE_forge-runner")),
        }),
        offline: false,
    };
    let out = sandbox
        .command(std::ffi::OsStr::new("/bin/sh"), &["-c".into(), script])
        .expect("the sandbox command is built")
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .expect("the sandbox ran");
    let seen = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let line = |key: &str| {
        seen.lines()
            .find_map(|l| l.strip_prefix(&format!("{key}=")))
            .unwrap_or_else(|| panic!("the probe printed no {key}: {seen} / {stderr}"))
            .to_string()
    };
    assert!(
        line("REFUSED") == "403" && line("REFUSED_RC") != "0",
        "curl to a host off the list was not refused by the proxy: {seen}"
    );
    assert!(
        line("PLAIN_REFUSED").contains(REFUSAL) && line("PLAIN_REFUSED").contains("example.com:80"),
        "a plain request off the list was not refused naming itself and the host: {seen}"
    );
    assert_ne!(
        line("BYPASS_RC"),
        "0",
        "curl around the proxy reached an address, so the sandbox has a network of its own: {seen}"
    );
    assert_eq!(
        line("PLAIN"),
        "ALLOWED-REACHED",
        "a plain request to the allowed host failed: {seen} / {stderr}"
    );
    assert_eq!(
        line("TUNNEL"),
        "ALLOWED-REACHED",
        "a tunnel to the allowed host failed: {seen} / {stderr}"
    );
    assert_eq!(
        out.status.code(),
        Some(7),
        "the bridge did not hand back the program's exit code"
    );
}
