//! Real boxes on this device, run once by hand: `cargo test -p runner-box --test live -- --ignored
//! --nocapture --test-threads 1`, with `FORGE_RUNNER_CONFIG_DIR` naming a scratch config whose
//! `[box]` points at scratch directories and the tools `forge-runner box setup` installed there.
//! Each test opens a box through the same frames core sends, drives it, watches it through the
//! tunnel endpoint, takes and hands back its input, cuts a clip, closes it, and proves with pgrep
//! that every process it started is gone. It prints what it measured.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use runner_box::core::{Core, Fut};
use runner_box::Boxes;
use runner_preview::codec::Channel;
use runner_preview::tunnel::BoxEndpoints;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct Said {
    reports: Mutex<Vec<Value>>,
    clips: Mutex<Vec<(usize, usize)>>,
}

impl Core for Said {
    fn report<'a>(&'a self, _: &'a str, body: Value) -> Fut<'a, ()> {
        println!("  report {body}");
        self.reports.lock().unwrap().push(body);
        Box::pin(async {})
    }
    fn clip<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        clip: Vec<u8>,
        still: Vec<u8>,
    ) -> Fut<'a, Result<(), String>> {
        self.clips.lock().unwrap().push((clip.len(), still.len()));
        Box::pin(async { Ok(()) })
    }
}

impl Said {
    async fn wait(&self, pred: impl Fn(&Value) -> bool, within: Duration) -> Value {
        let until = Instant::now() + within;
        loop {
            if let Some(v) = self
                .reports
                .lock()
                .unwrap()
                .iter()
                .find(|v| pred(v))
                .cloned()
            {
                return v;
            }
            assert!(
                Instant::now() < until,
                "no such report in {within:?}: {:?}",
                self.reports.lock().unwrap()
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

fn boxes() -> (Boxes, Arc<Said>) {
    let cfg = runner_platform::config::Config::load().expect("the scratch config");
    assert!(
        std::env::var("FORGE_RUNNER_CONFIG_DIR").is_ok_and(|d| d.contains("forge-scratch")),
        "the live test runs only against a scratch config"
    );
    let said = Arc::new(Said::default());
    let record = cfg
        .boxes
        .data_dir()
        .expect("a data dir")
        .join("live-held.json");
    (Boxes::start(said.clone(), cfg.boxes, Some(record)), said)
}

/// Reaps the box if the test panics on its way, so a failed run leaves nothing of its own behind.
struct ReapOnPanic(String);

impl Drop for ReapOnPanic {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            return;
        }
        let id = self.0.clone();
        let reaped = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(runner_box::proc::reap(&id, Duration::from_secs(5)))
        })
        .join();
        eprintln!(
            "  the panicked test's box {} reaped: {:?}",
            self.0,
            reaped.map(|r| r.left)
        );
    }
}

/// `pgrep -f`, its pattern anchored at the command's start so the shell running this test never
/// matches its own command line.
fn pgrep(pattern: &str) -> Vec<String> {
    let out = std::process::Command::new("pgrep")
        .args(["-u", "dev", "-a", "-f", pattern])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(String::from)
        .collect()
}

async fn open(
    b: &Boxes,
    said: &Said,
    id: &str,
    mode: &str,
    url: Option<&str>,
    viewport: Value,
) -> Duration {
    let t = Instant::now();
    b.on_frame("box.open", json!({ "boxId": id, "mode": mode, "warm": false, "viewport": viewport, "url": url, "openTimeoutSeconds": 180 }));
    let r = said
        .wait(
            |v| v["kind"] == "state" && v["state"] != "gone",
            Duration::from_secs(200),
        )
        .await;
    assert_eq!(r["state"], "ready", "{r}");
    t.elapsed()
}

/// The heartbeat names the box among those held from the moment it is ready; the health it
/// reports is printed for a check against core's schema.
fn print_health_naming(b: &Boxes, id: &str) {
    let health = b.health().expect("this device measures its box health");
    assert!(
        health["held"].as_array().unwrap().iter().any(|h| h == id),
        "{health}"
    );
    println!("BOX_HEALTH {health}");
}

async fn act(b: &Boxes, said: &Said, id: &str, cmd: &[&str]) -> Value {
    let act_id = uuid::Uuid::new_v4().to_string();
    b.on_frame(
        "box.act",
        json!({ "boxId": id, "actId": act_id, "command": cmd, "kind": "write" }),
    );
    said.wait(
        |v| v["kind"] == "act" && v["actId"] == act_id.as_str(),
        Duration::from_secs(120),
    )
    .await
}

async fn span_and_clip(b: &Boxes, said: &Said, id: &str, hold: Duration) {
    let span = uuid::Uuid::new_v4().to_string();
    b.on_frame(
        "box.span.mark",
        json!({ "boxId": id, "spanId": span, "criterion": 1, "edge": "start" }),
    );
    let s = said
        .wait(
            |v| v["kind"] == "mark" && v["edge"] == "start",
            Duration::from_secs(10),
        )
        .await;
    tokio::time::sleep(hold).await;
    b.on_frame(
        "box.span.mark",
        json!({ "boxId": id, "spanId": span, "criterion": 1, "edge": "end" }),
    );
    let e = said
        .wait(
            |v| v["kind"] == "mark" && v["edge"] == "end",
            Duration::from_secs(10),
        )
        .await;
    let t = Instant::now();
    b.on_frame(
        "box.recording.fetch",
        json!({ "boxId": id, "spanId": span,
        "fromMs": s["offsetMs"], "toMs": e["offsetMs"], "maxSeconds": 30, "maxBytes": 8_000_000 }),
    );
    let until = Instant::now() + Duration::from_secs(120);
    while said.clips.lock().unwrap().is_empty() {
        if let Some(f) = said
            .reports
            .lock()
            .unwrap()
            .iter()
            .find(|v| v["kind"] == "clip_failed")
        {
            panic!("the clip failed: {f}");
        }
        assert!(Instant::now() < until, "no clip in 120 s");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let (clip, still) = said.clips.lock().unwrap()[0];
    println!(
        "MEASURED clip of {} ms cut in {:?}: {clip} bytes mp4, {still} bytes png",
        e["offsetMs"].as_u64().unwrap() - s["offsetMs"].as_u64().unwrap(),
        t.elapsed()
    );
    assert!(clip > 1000 && still > 1000);
}

async fn close_and_prove_reaped(b: &Boxes, said: &Said, id: &str, patterns: &[String]) {
    let t = Instant::now();
    b.on_frame("box.close", json!({ "boxId": id, "why": "done" }));
    let gone = said
        .wait(|v| v["state"] == "gone", Duration::from_secs(60))
        .await;
    assert!(gone.get("detail").is_none(), "{gone}");
    println!("MEASURED close and reap took {:?}", t.elapsed());
    assert!(
        runner_box::proc::pids_of(id).is_empty(),
        "the box's processes: {:?}",
        runner_box::proc::pids_of(id)
    );
    for p in patterns {
        assert_eq!(pgrep(p), Vec::<String>::new(), "pgrep -f {p} after close");
    }
}

#[tokio::test]
#[ignore = "opens a real browser box on this device; run by hand"]
async fn a_real_browser_box_is_driven_watched_taken_recorded_and_reaped() {
    let (b, said) = boxes();
    let id = uuid::Uuid::new_v4().to_string();
    let _reap = ReapOnPanic(id.clone());
    let page = "data:text/html,<button id=c style='width:100%;height:100%;font-size:80px' onclick=\"this.textContent=+this.textContent+1\">0</button>";
    let ready = open(
        &b,
        &said,
        &id,
        "browser",
        Some(page),
        json!({ "width": 390, "height": 844 }),
    )
    .await;
    println!("MEASURED browser box ready in {ready:?}");
    print_health_naming(&b, &id);
    let rss = runner_box::proc::rss_mb(&runner_box::proc::pids_of(&id));
    println!(
        "MEASURED browser box resident memory {rss} MB over {} processes",
        runner_box::proc::pids_of(&id).len()
    );

    let a = act(&b, &said, &id, &["click", "#c"]).await;
    println!("MEASURED agent click took {} ms", a["durationMs"]);
    assert_eq!(
        act(&b, &said, &id, &["get", "text", "#c"]).await["stdout"]
            .as_str()
            .unwrap()
            .trim(),
        "1"
    );

    // the view: a WebSocket through the tunnel endpoint, as core's proxy speaks it
    let t = Instant::now();
    let Ok(conn) = b.connect(&id, Channel::View { fps: 10 }).await else {
        panic!("a view")
    };
    let (mut ws, _) = tokio_tungstenite::client_async("ws://127.0.0.1/", conn)
        .await
        .expect("the stream socket");
    let _ = act(&b, &said, &id, &["click", "#c"]).await;
    let first = loop {
        let m = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("a frame in 10 s")
            .unwrap()
            .unwrap();
        if let Ok(v) = serde_json::from_str::<Value>(m.to_text().unwrap_or("{}")) {
            if v["type"] == "frame" {
                break v;
            }
        }
    };
    println!(
        "MEASURED first view frame {:?} after connect, {} base64 chars",
        t.elapsed(),
        first["data"].as_str().unwrap().len()
    );

    // a person's input, refused until core says they hold the box, then reaching the page
    assert!(
        b.connect(&id, Channel::Input).await.is_err(),
        "input before box.take"
    );
    b.on_frame(
        "box.take",
        json!({ "boxId": id, "userId": "u", "name": "Owner" }),
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    let Ok(mut input) = b.connect(&id, Channel::Input).await else {
        panic!("input once held")
    };
    let t = Instant::now();
    input
        .write_all(b"{\"t\":\"tap\",\"x\":0.5,\"y\":0.5}\n")
        .await
        .unwrap();
    let mut text = String::new();
    for _ in 0..50 {
        text = act(&b, &said, &id, &["get", "text", "#c"]).await["stdout"]
            .as_str()
            .unwrap()
            .trim()
            .to_string();
        if text == "3" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(text, "3", "two agent clicks and the person's tap");
    println!(
        "MEASURED a person's tap reached the page within {:?}",
        t.elapsed()
    );
    b.on_frame("box.release", json!({ "boxId": id, "why": "released" }));
    drop(input);
    drop(ws);

    span_and_clip(&b, &said, &id, Duration::from_secs(3)).await;
    close_and_prove_reaped(&b, &said, &id, &["/tmp/fbxr/".to_string() + &id[..8]]).await;
}

#[tokio::test]
#[ignore = "opens a real android emulator box on this device; run by hand"]
async fn a_real_android_box_boots_from_its_snapshot_streams_h264_and_is_reaped() {
    let (b, said) = boxes();
    let id = uuid::Uuid::new_v4().to_string();
    let _reap = ReapOnPanic(id.clone());
    let ready = open(&b, &said, &id, "android", None, Value::Null).await;
    println!("MEASURED android box ready in {ready:?} (snapshot boot, read-only)");
    let pids = runner_box::proc::pids_of(&id);
    println!(
        "MEASURED android box resident memory {} MB over {} processes",
        runner_box::proc::rss_mb(&pids),
        pids.len()
    );

    let a = act(&b, &said, &id, &["snapshot"]).await;
    println!(
        "MEASURED agent-device snapshot exit {} in {} ms: {}",
        a["exitCode"],
        a["durationMs"],
        a["stdout"]
            .as_str()
            .unwrap_or("")
            .lines()
            .next()
            .unwrap_or("")
    );

    let t = Instant::now();
    let Ok(mut view) = b.connect(&id, Channel::View { fps: 15 }).await else {
        panic!("a view")
    };
    let mut meta = [0u8; 12];
    tokio::time::timeout(Duration::from_secs(20), view.read_exact(&mut meta))
        .await
        .expect("codec header in 20 s")
        .unwrap();
    assert_eq!(&meta[..4], b"h264", "{meta:?}");
    let (w, h) = (
        u32::from_be_bytes(meta[4..8].try_into().unwrap()),
        u32::from_be_bytes(meta[8..12].try_into().unwrap()),
    );
    let mut packet = [0u8; 12];
    view.read_exact(&mut packet).await.unwrap();
    println!(
        "MEASURED scrcpy view {w}x{h}: codec header and first packet {:?} after connect",
        t.elapsed()
    );
    drop(view);

    b.on_frame(
        "box.take",
        json!({ "boxId": id, "userId": "u", "name": "Owner" }),
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    let Ok(mut input) = b.connect(&id, Channel::Input).await else {
        panic!("input once held")
    };
    input.write_all(b"{\"t\":\"key\",\"key\":\"GoHome\",\"action\":\"press\"}\n{\"t\":\"tap\",\"x\":0.5,\"y\":0.5}\n").await.unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    b.on_frame("box.release", json!({ "boxId": id, "why": "released" }));
    drop(input);

    span_and_clip(&b, &said, &id, Duration::from_secs(4)).await;
    close_and_prove_reaped(
        &b,
        &said,
        &id,
        &["^[^ ]*qemu-system".into(), "^[^ ]*emulator -avd".into()],
    )
    .await;
}

#[tokio::test]
#[ignore = "opens a real desktop box on this device; run by hand"]
async fn a_real_desktop_box_takes_a_display_other_than_99_and_is_reaped() {
    let (b, said) = boxes();
    let id = uuid::Uuid::new_v4().to_string();
    let _reap = ReapOnPanic(id.clone());
    let ready = open(&b, &said, &id, "desktop", None, Value::Null).await;
    println!("MEASURED desktop box ready in {ready:?}");
    let xvfb = pgrep("^Xvfb :1[0-9][0-9] ");
    println!("  {xvfb:?}");
    assert!(xvfb.iter().all(|l| !l.contains(" :99 ")));
    let a = act(&b, &said, &id, &["list-displays"]).await;
    println!(
        "MEASURED agent-desktop list-displays exit {}: {}",
        a["exitCode"],
        a["stdout"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(120)
            .collect::<String>()
    );
    let Ok(mut view) = b.connect(&id, Channel::View { fps: 10 }).await else {
        panic!("a view")
    };
    let mut hello = [0u8; 12];
    view.read_exact(&mut hello).await.unwrap();
    assert_eq!(&hello[..4], b"RFB ", "{hello:?}");
    drop(view);
    span_and_clip(&b, &said, &id, Duration::from_secs(3)).await;
    close_and_prove_reaped(
        &b,
        &said,
        &id,
        &[
            "^Xvfb :1[0-9][0-9] ".into(),
            "^[^ ]*x11vnc -display :1[0-9][0-9] ".into(),
        ],
    )
    .await;
    assert!(
        !pgrep("^Xvfb :99 ").is_empty(),
        "the person's display :99 is untouched"
    );
}
