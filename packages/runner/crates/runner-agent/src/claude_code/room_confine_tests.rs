//! A room agent's sandbox (ISS-1268 BR) holds the room's own Claude Code config, `/tmp` and
//! runtime dir in place of the box's, so the records, keys and peer sockets of every master on the
//! box are not in its view; and it holds the confinement every chat session holds: no network but
//! its proxy, which refuses a host off its list, and no write outside its own tree.
//!
//! The box is planted as `confine_tests` plants it, with a master beside it: a session record and
//! key under the box's Claude Code config, and its peer socket listening under the box's runtime
//! dir. The sandbox then runs a shell in place of the room's holder that looks for each.

use super::super::EgressGuard;
use super::*;
use runner_workspace::bg_session::room::RoomDirs;

const MASTER_TOKEN: &str = "LEAK-master-peer-token";

struct Master {
    records: PathBuf,
    socket: PathBuf,
    _listener: std::os::unix::net::UnixListener,
}

/// A master's record, key and listening peer socket, where a box keeps them.
fn plant_master(p: &Planted, runtime: &Path) -> Master {
    let records = p.home.join(".claude/sessions");
    write(
        &records.join("77.json"),
        "{\"pid\":77,\"name\":\"forge-master-p\"}",
    );
    write(
        &records.join("77.k.key"),
        &format!("{{\"peerToken\":\"{MASTER_TOKEN}\"}}"),
    );
    let socket = runtime.join("cc-socks/77.sock");
    std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    Master {
        records,
        socket,
        _listener: listener,
    }
}

/// The room's sandbox, its holder replaced by `script`, and what it printed.
async fn run_in_room(
    p: &Planted,
    view: BoxView,
    dirs: &RoomDirs,
    script: String,
) -> (String, Option<EgressGuard>) {
    let args = vec!["-c".to_string(), script];
    let (mut cmd, egress) = SessionCommand {
        spec: &spec(p, true),
        program: std::ffi::OsStr::new("/bin/sh"),
        args: &args,
        repo: &p.repo.to_string_lossy(),
        credential: TURN,
        mcp_path: &p.mcp,
        bearer_dir: None,
        core_url: "https://core.example",
    }
    .build_with(Some(view), Some(dirs))
    .await
    .expect("the room's sandbox command is built");
    let out = cmd
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .expect("the room's sandbox ran");
    (String::from_utf8_lossy(&out.stdout).into_owned(), egress)
}

/// What the room's egress proxy answers a `CONNECT` to `host`.
fn connect_through(egress_dir: &Path, host: &str) -> String {
    use std::io::{Read as _, Write as _};
    let socket = std::fs::read_dir(egress_dir)
        .unwrap()
        .flatten()
        .map(|d| d.path().join("s"))
        .find(|s| s.exists())
        .expect("the room's egress socket");
    let mut s = std::os::unix::net::UnixStream::connect(socket).unwrap();
    s.set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    write!(s, "CONNECT {host} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
    let mut buf = [0u8; 512];
    let n = s.read(&mut buf).unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).into_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_room_agent_cannot_reach_a_master_and_its_confinement_holds() {
    if !bwrap_or_skip("a_room_agent_cannot_reach_a_master_and_its_confinement_holds") {
        return;
    }
    let p = plant();
    let runtime = p.root.join("run-user");
    let master = plant_master(&p, &runtime);
    let dirs = RoomDirs::under(&p.root.join("rooms"), "p");
    dirs.make(&p.repo).unwrap();
    let mut box_view = view(&p);
    box_view
        .inherited
        .push(("XDG_RUNTIME_DIR".into(), runtime.clone().into_os_string()));
    let outside = p.root.join("written-outside-the-room");
    let script = format!(
        "echo \"CONFIG=$CLAUDE_CONFIG_DIR\"; echo \"RUNTIME=$XDG_RUNTIME_DIR\"; \
         ls '{records}' 2>/dev/null | grep -q . && echo MASTER-RECORDS-VISIBLE; \
         cat '{records}/77.k.key' 2>/dev/null; \
         test -S '{socket}' && echo MASTER-SOCKET-VISIBLE; \
         echo x > '{outside}' 2>/dev/null; \
         echo x > /usr/room-plant 2>/dev/null && echo SYSTEM-WRITABLE; \
         echo x > '{claude}/written-by-room' && echo ROOM-WRITABLE; \
         echo x > /tmp/room-tmp && echo TMP-WRITABLE; \
         echo \"IFACES=$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | grep -vx lo | wc -l)\"; \
         true",
        records = master.records.display(),
        socket = master.socket.display(),
        outside = outside.display(),
        claude = dirs.claude.display(),
    );
    let egress_dir = box_view.egress_dir.clone();
    let (seen, egress) = run_in_room(&p, box_view, &dirs, script).await;

    for (marker, what) in [
        ("MASTER-RECORDS-VISIBLE", "the box's session records"),
        (MASTER_TOKEN, "a master's peer token"),
        ("MASTER-SOCKET-VISIBLE", "a master's peer socket"),
        ("SYSTEM-WRITABLE", "a write outside its tree"),
    ] {
        assert!(!seen.contains(marker), "the room reached {what}:\n{seen}");
    }
    assert!(
        seen.contains(&format!("CONFIG={}", dirs.claude.display())),
        "{seen}"
    );
    assert!(
        seen.contains(&format!("RUNTIME={}", dirs.run.display())),
        "{seen}"
    );
    assert!(
        seen.contains("ROOM-WRITABLE") && seen.contains("TMP-WRITABLE"),
        "{seen}"
    );
    assert!(
        seen.contains("IFACES=0"),
        "the room has a network of its own:\n{seen}"
    );
    assert!(!outside.exists(), "the room wrote outside its tree");
    assert!(dirs.claude.join("written-by-room").is_file());
    assert!(
        dirs.tmp.join("room-tmp").is_file(),
        "the room's /tmp is not its own"
    );

    let refused = connect_through(&egress_dir, "example.com:443");
    assert!(
        refused.contains("403") && refused.contains(runner_platform::confine::egress::REFUSAL),
        "the room's proxy did not refuse a host off its list: {refused}"
    );
    drop(egress);
}
