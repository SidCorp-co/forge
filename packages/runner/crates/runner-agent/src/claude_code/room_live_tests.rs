//! The room seam end to end on this box's own Claude Code (ISS-1268 BR): the room's sandbox cut
//! by `confine::chat_sandbox`, a background session started in it, a message delivered with its
//! receipt, the roster read in the room, and the attach target named. It starts a real session
//! that spends tokens, so it runs only by name:
//!
//! `BR_ROOM_LIVE_BIN=<forge-runner binary> BR_ROOM_LIVE_DIR=<scratch dir> cargo test -p runner-agent
//! room_live -- --ignored --nocapture`
//!
//! The scratch dir holds the room, the checkout and the egress socket; nothing of the box's own
//! runner directory or Claude Code sessions is written. The session is stopped and its sandbox
//! ended before the test returns.

use super::*;
use runner_workspace::bg_session::room::attach_target;

/// A live room for the test: its dirs, checkout, MCP config and events file, and its sandbox,
/// running.
struct Live {
    dirs: RoomDirs,
    repo: PathBuf,
    mcp: PathBuf,
    events: PathBuf,
    host: Host,
    sandbox: tokio::process::Child,
    _egress: Option<EgressGuard>,
}

async fn open_live(bin: &std::path::Path, scratch: &std::path::Path) -> Live {
    let repo = scratch.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let _ = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&repo)
        .status();
    let mcp = scratch.join("mcp.json");
    std::fs::write(&mcp, r#"{"mcpServers":{}}"#).unwrap();
    let dirs = RoomDirs::under(&scratch.join("rooms"), "brlive");
    dirs.make(&repo).unwrap();
    let events = dirs.events("forge-chat-brlive");
    std::fs::create_dir_all(events.parent().unwrap()).unwrap();
    let doc = room_launch::settings(bin, &events, &[]);
    bg_session::launch::write_settings(&dirs.settings, &doc).unwrap();
    let mut view = confine::BoxView::current().unwrap();
    view.runner_exe = Some(bin.to_path_buf());
    view.egress_dir = scratch.join("egress");
    let spec = JobSpec {
        job_id: "brlive".into(),
        project_id: String::new(),
        project_slug: Some("brlive".into()),
        repo_path: repo.clone(),
        prompt: None,
        system_prompt: None,
        model: Some("sonnet".into()),
        permission_mode: None,
        mcp_servers_override: None,
        resume_id: None,
        counts_against_session_cap: false,
        credential: Some(crate::TurnCredential("live-turn".into())),
        confinement: Some(crate::Confinement::default()),
        hooks_off: false,
        keep_resident: true,
    };
    let holder: Vec<String> = HOLDER[1..].iter().map(|a| (*a).to_string()).collect();
    let (mut cmd, egress) = SessionCommand {
        spec: &spec,
        program: std::ffi::OsStr::new(HOLDER[0]),
        args: &holder,
        repo: &repo.to_string_lossy(),
        credential: "live-turn",
        mcp_path: &mcp,
        bearer_dir: None,
        core_url: "https://core.example",
    }
    .build_with(Some(view), Some(&dirs))
    .await
    .unwrap();
    cmd.stdin(std::process::Stdio::null()).kill_on_drop(true);
    let sandbox = cmd.spawn().unwrap();
    let host = Host::record(sandbox.id().unwrap(), dirs.clone())
        .await
        .unwrap();
    Live {
        dirs,
        repo,
        mcp,
        events,
        host,
        sandbox,
        _egress: egress,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "starts a real Claude Code session; run by name with BR_ROOM_LIVE_BIN and BR_ROOM_LIVE_DIR"]
async fn room_live_a_room_agent_starts_takes_a_message_with_a_receipt_and_is_found_to_attach() {
    let bin = PathBuf::from(std::env::var("BR_ROOM_LIVE_BIN").expect("BR_ROOM_LIVE_BIN"));
    let scratch = PathBuf::from(std::env::var("BR_ROOM_LIVE_DIR").expect("BR_ROOM_LIVE_DIR"));
    let Live {
        dirs,
        repo,
        mcp,
        events,
        host,
        sandbox,
        _egress,
    } = open_live(&bin, &scratch).await;
    println!("room sandbox holder {}", host.holder);

    let launch = BgLaunch {
        name: "forge-chat-brlive".into(),
        cwd: repo.clone(),
        settings: dirs.settings.clone(),
        permission_mode: room_launch::PERMISSION_MODE.into(),
        model: Some("sonnet".into()),
        mcp_config: Some(mcp.clone()),
        strict_mcp: true,
        prompt: Some("Reply with exactly the word READY.".into()),
        ..BgLaunch::default()
    };
    let started = host.start(&launch).await.unwrap();
    println!("started {} ({})", started.id, started.session_id);
    let mut taken = None;
    for _ in 0..60 {
        if host.live(&started.session_id) {
            taken = Some(
                host.send(
                    &started.session_id,
                    "Reply with exactly: ROOM-OK",
                    Priority::Next,
                )
                .await,
            );
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let receipt = taken.expect("the session's process never stood").unwrap();
    println!("receipt {} after {:?}", receipt.msg_id, receipt.after);
    let roster = host.roster().await.unwrap();
    let (id, conversation) = attach_target(&roster, "brlive").unwrap();
    assert_eq!(id, started.id);
    assert_eq!(conversation, started.session_id);
    let transcript = dirs.transcript(&repo, &started.session_id);
    let mut stop_seen = false;
    for _ in 0..90 {
        let text = std::fs::read_to_string(&events).unwrap_or_default();
        if text.contains("\"Stop\"") || text.contains("Stop") {
            stop_seen = true;
        }
        let said = std::fs::read_to_string(&transcript).unwrap_or_default();
        if said.contains("ROOM-OK") && stop_seen {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    println!(
        "events:\n{}",
        std::fs::read_to_string(&events).unwrap_or_default()
    );
    host.stop(&started.id).await.unwrap();
    host.end();
    drop(sandbox);
    assert!(
        stop_seen,
        "the session's Stop hook never reached the box from inside the room"
    );
}
