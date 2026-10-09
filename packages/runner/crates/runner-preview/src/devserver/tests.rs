//! A dev server started, refused and failed as the box does it, on real processes and ports.

use super::*;

fn settings(command: &str, port: Option<u16>) -> Settings {
    Settings {
        command: command.into(),
        port,
        cwd: None,
    }
}

#[cfg(unix)]
fn no_env() -> serde_json::Map<String, serde_json::Value> {
    serde_json::Map::new()
}

#[test]
fn a_placeholder_takes_a_free_loopback_port_into_the_command() {
    let (port, command) = plan_port(&settings("vite --port {port}", None)).expect("a free port");
    assert!(port >= 1024);
    assert_eq!(command, format!("vite --port {port}"));
}

#[test]
fn a_fixed_port_another_process_holds_is_port_in_use() {
    let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = held.local_addr().unwrap().port();
    let f = plan_port(&settings("npm run dev", Some(port))).unwrap_err();
    assert_eq!(f.reason, "PORT_IN_USE");
    assert!(f.detail.contains(&port.to_string()), "{}", f.detail);
}

#[test]
fn a_command_without_port_or_placeholder_is_port_undeclared() {
    assert_eq!(
        plan_port(&settings("npm run dev", None))
            .unwrap_err()
            .reason,
        "PORT_UNDECLARED"
    );
}

#[test]
fn a_cwd_climbing_out_of_the_worktree_is_refused() {
    let dir = std::env::temp_dir();
    assert!(working_dir(&dir, Some("../etc")).is_err());
    assert!(working_dir(&dir, Some("/etc")).is_err());
    assert_eq!(working_dir(&dir, None).unwrap(), dir.join(""));
}

#[cfg(unix)]
#[tokio::test]
async fn a_server_that_answers_on_its_port_is_ready_and_listens_on_loopback_only() {
    let (port, command) = plan_port(&settings(
        "exec python3 -m http.server {port} --bind 127.0.0.1",
        None,
    ))
    .unwrap();
    let mut server = spawn(&std::env::temp_dir(), &command, port, &no_env()).expect("spawned");
    ready(&mut server, Duration::from_secs(20))
        .await
        .expect("python's http.server answers");
    let outside = std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("192.0.2.1:9")?;
            s.local_addr()
        })
        .map(|a| a.ip());
    if let Ok(ip) = outside {
        if !ip.is_loopback() {
            assert!(
                std::net::TcpStream::connect((ip, port)).is_err(),
                "the server must not answer on {ip}"
            );
        }
    }
    stop(server.child).await;
    assert!(
        connect_loopback(port).await.is_err(),
        "stopped means the port is free"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_server_that_exits_reports_its_status_and_output() {
    let mut server = spawn(
        &std::env::temp_dir(),
        "echo 'Error: Cannot find module vite'; exit 3",
        1,
        &no_env(),
    )
    .expect("spawned");
    let f = ready(&mut server, Duration::from_secs(10))
        .await
        .unwrap_err();
    assert_eq!(f.reason, "DEV_SERVER_EXITED");
    assert!(f.detail.contains("Cannot find module vite"), "{}", f.detail);
    assert!(f.detail.contains('3'), "{}", f.detail);
}

#[cfg(unix)]
#[tokio::test]
async fn a_server_that_never_answers_is_not_listening_and_is_stopped() {
    let mut server = spawn(
        &std::env::temp_dir(),
        "echo waiting; exec sleep 30",
        1,
        &no_env(),
    )
    .expect("spawned");
    let f = ready(&mut server, Duration::from_secs(1))
        .await
        .unwrap_err();
    assert_eq!(f.reason, "DEV_SERVER_NOT_LISTENING");
    assert!(f.detail.contains("waiting"), "{}", f.detail);
    stop(server.child).await;
}

#[test]
fn a_detail_keeps_the_last_characters() {
    let long = "x".repeat(DETAIL_LIMIT) + "the end";
    let kept = tail(&long, DETAIL_LIMIT);
    assert_eq!(kept.chars().count(), DETAIL_LIMIT);
    assert!(kept.ends_with("the end"));
}
