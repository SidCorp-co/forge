use super::*;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bg-room-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_room_is_made_onboarded_and_trusted_and_names_its_sandbox_outside_its_own_view() {
    let rooms = scratch("make");
    let dirs = RoomDirs::under(&rooms, "p");
    assert!(
        !dirs.host_file.starts_with(&dirs.root),
        "the room could point the runner's nsenter at another process"
    );
    let repo = rooms.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    dirs.make(&repo).unwrap();
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dirs.claude.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(config["hasCompletedOnboarding"], true);
    let trusted = config["projects"]
        .as_object()
        .unwrap()
        .values()
        .any(|p| p["hasTrustDialogAccepted"] == true);
    assert!(trusted, "{config}");
    assert!(dirs.claude.join(".credentials.json").is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dirs.root), 0o700);
        assert_eq!(mode(&dirs.claude.join(".credentials.json")), 0o600);
    }
    // a second make keeps what the room wrote
    std::fs::write(
        dirs.claude.join(".claude.json"),
        r#"{"hasCompletedOnboarding":true,"kept":1}"#,
    )
    .unwrap();
    dirs.make(&repo).unwrap();
    let again: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dirs.claude.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(again["kept"], 1);
}

/// `forge-runner chat attach <slug>` reaches the room's sessions only through the sandbox the room
/// wrote down: none, or one whose process has ended or been replaced, is refused by name, and a
/// live one runs `claude` in that process's namespaces with that process's environment.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn attach_resolves_the_rooms_own_sandbox_and_runs_with_its_environment() {
    let rooms = scratch("attach");
    let dirs = RoomDirs::under(&rooms, "p");
    let e = Host::of_dirs(dirs.clone()).unwrap_err();
    assert!(e.starts_with("[CHAT_ROOM_UNHOSTED]"), "{e}");

    let mut holder = std::process::Command::new("sleep")
        .arg("30")
        .env_clear()
        .env("CLAUDE_CONFIG_DIR", &dirs.claude)
        .spawn()
        .unwrap();
    let pid = holder.id();
    let file = serde_json::json!({ "holder": pid, "procStart": proc_start(pid).unwrap() });
    std::fs::write(&dirs.host_file, file.to_string()).unwrap();
    let host = Host::of_dirs(dirs.clone()).expect("a live sandbox is the room's");
    assert_eq!(host.holder, pid);

    if let Ok(cmd) = host.command(&["attach".into(), "abc123".into()], &rooms) {
        let std = cmd.as_std();
        let args: Vec<String> = std
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(
            args.windows(2).any(|w| w == ["-t", &pid.to_string()]),
            "{args:?}"
        );
        assert_eq!(args[args.len() - 2..], ["attach", "abc123"]);
        let env: Vec<(String, Option<String>)> = std
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert!(
            env.contains(&(
                "CLAUDE_CONFIG_DIR".into(),
                Some(dirs.claude.to_string_lossy().into_owned())
            )),
            "the command does not run with the room's own config dir: {env:?}"
        );
    }

    let recycled = serde_json::json!({ "holder": pid, "procStart": "1" });
    std::fs::write(&dirs.host_file, recycled.to_string()).unwrap();
    let e = Host::of_dirs(dirs.clone()).unwrap_err();
    assert!(
        e.contains("has ended"),
        "a recycled pid is not the room's: {e}"
    );
    holder.kill().unwrap();
    let _ = holder.wait();
}

/// A room agent's session runs in its sandbox's pid namespace, so its record's pid is not this
/// box's. A message to it is delivered with a receipt all the same, its process found through the
/// record's `pidDomain`. Planted out (the pid read as this box's own), it is refused
/// `PEER_NO_LIVE_PROCESS`.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_room_agents_delivery_in_its_own_pid_namespace_gets_a_receipt() {
    use super::super::peer::tests::fake;
    let Ok(bwrap) = which::which("bwrap") else {
        panic!("BWRAP_UNAVAILABLE: this test needs bubblewrap to open a pid namespace");
    };
    let mut sandbox = std::process::Command::new(bwrap)
        .args(["--unshare-pid", "--dev-bind", "/", "/", "--", "sleep", "30"])
        .spawn()
        .unwrap();
    let outer = sandbox.id();
    let inner = (0..100)
        .find_map(|_| {
            std::thread::sleep(Duration::from_millis(50));
            inner_of(outer)
        })
        .expect("the sandbox's namespace");
    let ns = std::fs::read_link(format!("/proc/{inner}/ns/pid")).unwrap();
    let ns_pid = 1u32; // the namespace's first process

    let dir = scratch("ns");
    let sid = "room-sess-1";
    fake::session(&dir, sid, inner, false).await;
    let sessions = dir.join("sessions");
    let mut record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(sessions.join(format!("{inner}.json"))).unwrap())
            .unwrap();
    record["pid"] = ns_pid.into();
    record["pidDomain"] = format!("linux:test:{}", ns.display()).into();
    std::fs::remove_file(sessions.join(format!("{inner}.json"))).unwrap();
    std::fs::write(sessions.join(format!("{ns_pid}.json")), record.to_string()).unwrap();
    std::fs::rename(
        sessions.join(format!("{inner}.abc.key")),
        sessions.join(format!("{ns_pid}.abc.key")),
    )
    .unwrap();

    let receipt = peer::send_in(&dir, sid, "hello room", Priority::Next)
        .await
        .expect("delivered with a receipt");
    assert_eq!(receipt.pid, ns_pid);

    // the plant: the record read as if its pid were this box's own
    record["pidDomain"] = serde_json::Value::Null;
    std::fs::write(sessions.join(format!("{ns_pid}.json")), record.to_string()).unwrap();
    let e = peer::send_in(&dir, sid, "hello again", Priority::Next)
        .await
        .unwrap_err();
    assert!(
        e.to_string().starts_with("[PEER_NO_LIVE_PROCESS]"),
        "pid {ns_pid} on this box is not the room's session: {e}"
    );
    let _ = sandbox.kill();
    let _ = sandbox.wait();
}

/// `chat attach <slug>` opens the room's session named for `slug`, the live one before a stopped
/// copy, and refuses by name where the room lists none of that name.
#[test]
fn attach_opens_the_session_named_for_the_room() {
    let row = |id: &str, name: &str, pid: Option<u32>, started: i64| BgSession {
        id: Some(id.into()),
        session_id: format!("{id}-conv"),
        cwd: None,
        kind: Some("background".into()),
        name: Some(name.into()),
        pid,
        status: None,
        state: None,
        waiting_for: None,
        started_at: Some(started),
    };
    let roster = vec![
        row("old", "forge-chat-p", None, 9),
        row("live", "forge-chat-p", Some(92), 1),
        row("q", "forge-chat-q", Some(91), 5),
    ];
    assert_eq!(
        attach_target(&roster, "p").unwrap(),
        ("live".to_string(), "live-conv".to_string())
    );
    let e = attach_target(&roster, "other").unwrap_err();
    assert!(e.starts_with("[CHAT_ROOM_NO_SESSION]"), "{e}");
}
