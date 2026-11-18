//! The runner's half of a box against a stand-in for core: a lost stream port fails the box
//! loudly, a person's input reaches agent-browser's socket only while core says they hold it, and
//! an act on a box this runner does not hold is answered, never dropped.

use super::*;
use crate::browser::Browser;
use crate::testkit::Scratch;
use futures_util::StreamExt;
use runner_preview::codec::{Channel, ResetCode};
use runner_preview::tunnel::BoxEndpoints;
use tokio::io::AsyncWriteExt;

pub(super) const ID: &str = "0b8e7a52-3c4d-4e6f-8a1b-2c3d4e5f6a7b";

/// A stand-in for core: every report, and every clip uploaded (box, span, clip bytes).
#[derive(Default)]
pub(super) struct Said(
    pub(super) Mutex<Vec<(String, Value)>>,
    pub(super) Mutex<Vec<(String, String, Vec<u8>)>>,
);

impl Core for Said {
    fn report<'a>(&'a self, box_id: &'a str, body: Value) -> crate::core::Fut<'a, ()> {
        self.0.lock().unwrap().push((box_id.to_string(), body));
        Box::pin(async {})
    }
    fn clip<'a>(
        &'a self,
        box_id: &'a str,
        span_id: &'a str,
        clip: Vec<u8>,
        _: Vec<u8>,
    ) -> crate::core::Fut<'a, Result<(), String>> {
        self.1
            .lock()
            .unwrap()
            .push((box_id.into(), span_id.into(), clip));
        Box::pin(async { Ok(()) })
    }
}

impl Said {
    pub(super) fn kinds(&self) -> Vec<Value> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|(_, b)| b.clone())
            .collect()
    }
}

pub(super) fn boxes(root: &Scratch, said: Arc<Said>) -> Boxes {
    let settings = BoxSettings {
        socket_root: root.path().join("s"),
        data_dir: Some(root.path().join("data")),
        ..BoxSettings::default()
    };
    let env = modes::Env {
        path: vec![root.path().join("bin")],
        tools_dir: root.path().join("tools"),
        sdk: None,
        avd_home: None,
        kvm: root.path().join("kvm"),
        scrcpy_server: root.path().join("scrcpy-server"),
        atspi_launcher: root.path().join("at-spi"),
    };
    let ctx = Ctx {
        settings,
        env,
        data_dir: root.path().join("data"),
        x: display::XDirs::default(),
        displays: display::Taken::default(),
        emulator_ports: Default::default(),
    };
    let probe = health::Probe::of_host(root.path());
    Boxes::with(said, ctx, Some(root.path().join("held.json")), probe)
}

/// A browser box whose agent-browser daemon is this test (its pid), its stream on `port`.
fn plant_browser(b: &Boxes, root: &Scratch, port: u16) -> PathBuf {
    let browser = Browser::new(
        ID,
        root.path().join("agent-browser"),
        &b.0.ctx.settings,
        None,
        root.path().join("rec.webm"),
    )
    .unwrap();
    let dir = browser.dir().to_path_buf();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("b.pid"), std::process::id().to_string()).unwrap();
    std::fs::write(dir.join("b.stream"), port.to_string()).unwrap();
    b.slots().insert(
        ID.into(),
        Slot {
            running: Some(Arc::new(Running::Browser(browser))),
            held: watch::channel(false).0,
            clock: record::Clock::started_now(),
            recording: false,
            warm: false,
            closing: false,
            attach: None,
        },
    );
    dir
}

#[tokio::test]
async fn a_lost_stream_port_fails_the_box_stream_lost_and_closes_it() {
    let root = Scratch::new("slots");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let dir = plant_browser(&b, &root, listener.local_addr().unwrap().port());

    assert!(
        b.connect(ID, Channel::View { fps: 10 }).await.is_ok(),
        "the stream port answers"
    );
    // the daemon restarted with no stream: the next viewer finds it gone, and the box fails
    std::fs::remove_file(dir.join("b.stream")).unwrap();
    let refused = b.connect(ID, Channel::View { fps: 10 }).await.err();
    assert_eq!(refused, Some(ResetCode::ConnectRefused));
    let failed = said
        .kinds()
        .into_iter()
        .find(|k| k["state"] == "failed")
        .expect("a failed report");
    assert_eq!(failed["failure"], "STREAM_LOST");
    assert!(
        failed["detail"]
            .as_str()
            .unwrap()
            .contains("serves no stream port"),
        "{failed}"
    );
    for _ in 0..100 {
        if b.slots().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(b.slots().is_empty(), "the lost box is closed");
    assert_eq!(
        b.connect(ID, Channel::View { fps: 10 }).await.err(),
        Some(ResetCode::PreviewNotRunning)
    );
}

#[tokio::test]
async fn a_persons_input_reaches_the_browser_only_while_they_hold_the_box() {
    let root = Scratch::new("slots");
    let b = boxes(&root, Arc::new(Said::default()));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    plant_browser(&b, &root, listener.local_addr().unwrap().port());

    assert_eq!(
        b.connect(ID, Channel::Input).await.err(),
        Some(ResetCode::ConnectRefused),
        "no person holds it"
    );
    b.hold(ID, true);
    let server = tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        let mut head = vec![0u8; 2048];
        let n = sock.peek(&mut head).await.unwrap();
        let head = String::from_utf8_lossy(&head[..n]).to_ascii_lowercase();
        assert!(
            !head.contains("\r\norigin:"),
            "a server-side client sends no Origin: {head}"
        );
        let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
        let mut got = Vec::new();
        while got.len() < 3 {
            match ws.next().await {
                Some(Ok(m)) if m.is_text() => {
                    got.push(serde_json::from_str::<Value>(m.to_text().unwrap()).unwrap())
                }
                Some(Ok(_)) => {}
                _ => break,
            }
        }
        got
    });
    let Ok(mut input) = b.connect(ID, Channel::Input).await else {
        panic!("held: input opens")
    };
    input
        .write_all(b"{\"t\":\"tap\",\"x\":0.5,\"y\":0.5}\n")
        .await
        .unwrap();
    let got = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got[1]["type"], "input_mouse");
    assert_eq!(got[1]["eventType"], "mousePressed");
    assert_eq!(
        (got[1]["x"].as_i64(), got[1]["y"].as_i64()),
        (Some(640), Some(360))
    );
}

#[tokio::test]
async fn an_act_on_a_box_not_held_here_is_answered_and_a_frame_naming_no_uuid_is_refused() {
    let root = Scratch::new("slots");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    let act_id = "1c9e7a52-3c4d-4e6f-8a1b-2c3d4e5f6a7b";
    b.handle(
        "box.act",
        json!({ "boxId": ID, "actId": act_id, "command": ["snapshot"], "kind": "read" }),
    )
    .await
    .unwrap();
    let k = said.kinds();
    assert_eq!(k[0]["kind"], "act");
    assert_eq!(k[0]["actId"], act_id);
    assert_eq!(k[0]["exitCode"], -1);
    assert!(k[0]["stderr"]
        .as_str()
        .unwrap()
        .contains("not running on this device"));
    let err = b
        .handle("box.close", json!({ "boxId": "../etc" }))
        .await
        .unwrap_err();
    assert!(err.contains("not a uuid"), "{err}");
}

#[tokio::test]
async fn a_box_that_fails_to_start_is_reported_start_failed_and_leaves_nothing_held() {
    let root = Scratch::new("slots");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    b.handle("box.open", json!({ "boxId": ID, "mode": "browser", "warm": false, "viewport": null, "url": null, "openTimeoutSeconds": 30 }))
        .await
        .unwrap();
    let k = said.kinds();
    assert_eq!(k[0]["state"], "failed");
    assert_eq!(k[0]["failure"], "START_FAILED");
    assert!(
        k[0]["detail"]
            .as_str()
            .unwrap()
            .contains("lacks agent-browser"),
        "{}",
        k[0]
    );
    assert!(b.slots().is_empty());
    let held: Vec<String> =
        serde_json::from_slice(&std::fs::read(root.path().join("held.json")).unwrap()).unwrap();
    assert!(held.is_empty());
}

/// A WebSocket server standing in for agent-browser's stream, accepting one client.
fn accept_one(listener: tokio::net::TcpListener) -> tokio::task::JoinHandle<bool> {
    tokio::spawn(async move {
        let Ok((sock, _)) = listener.accept().await else {
            return false;
        };
        tokio_tungstenite::accept_async(sock).await.is_ok()
    })
}

#[cfg(unix)]
#[tokio::test]
async fn a_box_opened_for_a_person_admits_their_input_stream_from_the_open() {
    let root = Scratch::new("slots");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    // agent-browser that answers every command, its daemon (this test) serving a stream port
    root.script(
        "tools/agent-browser/0.43.0/node_modules/.bin/agent-browser",
        "exit 0",
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let dir = crate::browser::socket_dir(&b.0.ctx.settings.socket_root, ID).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("b.pid"), std::process::id().to_string()).unwrap();
    let port = listener.local_addr().unwrap().port();
    std::fs::write(dir.join("b.stream"), port.to_string()).unwrap();

    b.handle("box.open", json!({ "boxId": ID, "mode": "browser", "warm": false, "viewport": null, "url": null, "openTimeoutSeconds": 30, "asPerson": true }))
        .await
        .unwrap();
    assert_eq!(said.kinds()[0]["state"], "ready", "{:?}", said.kinds());
    let server = accept_one(listener);
    let started = std::time::Instant::now();
    assert!(
        b.connect(ID, Channel::Input).await.is_ok(),
        "the person holds it from the open: their input is admitted"
    );
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "admitted at once, not after a hold frame"
    );
    assert!(
        server.await.unwrap(),
        "the input reached agent-browser's socket"
    );
}

#[tokio::test]
async fn a_warm_box_handed_to_a_person_admits_their_input_and_one_handed_to_the_agent_does_not() {
    let root = Scratch::new("slots");
    let b = boxes(&root, Arc::new(Said::default()));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    plant_browser(&b, &root, listener.local_addr().unwrap().port());

    b.handle(
        "box.assign",
        json!({ "boxId": ID, "url": null, "asPerson": false }),
    )
    .await
    .unwrap();
    assert_eq!(
        b.connect(ID, Channel::Input).await.err(),
        Some(ResetCode::ConnectRefused),
        "handed to the agent: no person holds it"
    );
    b.handle(
        "box.assign",
        json!({ "boxId": ID, "url": null, "asPerson": true }),
    )
    .await
    .unwrap();
    let server = accept_one(listener);
    assert!(b.connect(ID, Channel::Input).await.is_ok());
    assert!(server.await.unwrap());
}
