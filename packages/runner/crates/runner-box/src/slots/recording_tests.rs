//! ISS-1321: a box records only when asked. An open without `record` starts no recorder and writes
//! no file, a warm box never records, and a span begun with recording off records its own clip and
//! stops at its end. agent-browser and ffmpeg are scripts that write down what they were told.

use super::tests::{boxes, Said};
use super::*;
use crate::testkit::{box_id, Scratch};
use std::path::Path;

/// agent-browser as a script that logs every command, and writes the recording only on `record
/// stop` as the real one does; its daemon (this test) serves a stream for `ids`. The log's path.
fn fake_tools(root: &Scratch, b: &Boxes, ids: &[&str]) -> PathBuf {
    let log = root.path().join("agent-browser.log");
    let at = root.path().join("recording-path");
    root.script(
        "tools/agent-browser/0.43.0/node_modules/.bin/agent-browser",
        &format!(
            r#"echo "$*" >> {log}
if [ "$1" = record ] && [ "$2" = start ]; then printf %s "$3" > {at}; fi
if [ "$1" = record ] && [ "$2" = stop ]; then printf webm > "$(cat {at})"; fi
exit 0"#,
            log = log.display(),
            at = at.display()
        ),
    );
    // ffmpeg writes its last argument, the cut it was asked for
    root.script(
        "bin/ffmpeg",
        r#"for a; do last=$a; done; printf cut > "$last""#,
    );
    for id in ids {
        let dir = crate::browser::socket_dir(&b.0.ctx.settings.socket_root, id).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("b.pid"), std::process::id().to_string()).unwrap();
        std::fs::write(dir.join("b.stream"), "1").unwrap();
    }
    log
}

fn ran(log: &Path) -> String {
    std::fs::read_to_string(log).unwrap_or_default()
}

fn open(id: &str, warm: bool, record: Option<bool>) -> Value {
    let mut f = json!({ "boxId": id, "mode": "browser", "warm": warm, "viewport": null, "url": null, "openTimeoutSeconds": 30 });
    if let Some(r) = record {
        f["record"] = r.into();
    }
    f
}

fn files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[tokio::test]
async fn an_open_without_record_starts_no_recorder_and_writes_no_file() {
    let id = box_id();
    let root = Scratch::new("rec");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    let log = fake_tools(&root, &b, &[id]);

    b.handle("box.open", open(id, false, None)).await.unwrap();
    let ready = &said.kinds()[0];
    assert_eq!(ready["state"], "ready", "{ready}");
    assert!(
        ready.get("recordingStartedAt").is_none(),
        "nothing records: {ready}"
    );
    assert!(ran(&log).contains("open about:blank"), "{}", ran(&log));
    assert!(
        !ran(&log).contains("record"),
        "no recorder was started: {}",
        ran(&log)
    );
    assert!(
        files(&b.0.ctx.box_dir(id)).is_empty(),
        "no recording file: {:?}",
        files(&b.0.ctx.box_dir(id))
    );
    assert!(!b.slots()[id].recording);

    // closed, it stops no recorder it never started
    b.handle("box.close", json!({ "boxId": id, "why": "done" }))
        .await
        .unwrap();
    assert!(!ran(&log).contains("record"), "{}", ran(&log));
}

#[tokio::test]
async fn an_open_asking_record_starts_it_and_says_when() {
    let id = box_id();
    let root = Scratch::new("rec");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    let log = fake_tools(&root, &b, &[id]);

    b.handle("box.open", open(id, false, Some(true)))
        .await
        .unwrap();
    let ready = &said.kinds()[0];
    assert!(ready["recordingStartedAt"].is_string(), "{ready}");
    assert!(ran(&log).contains("record start"), "{}", ran(&log));
    assert!(b.slots()[id].recording);
    b.handle("box.close", json!({ "boxId": id, "why": "done" }))
        .await
        .unwrap();
    assert!(ran(&log).contains("record stop"), "{}", ran(&log));
}

#[tokio::test]
async fn a_warm_box_never_records_and_its_hand_out_records_only_when_asked() {
    let id = box_id();
    let warm = box_id();
    let root = Scratch::new("rec");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    let log = fake_tools(&root, &b, &[id, warm]);

    // a warm box asked to record (no core sends that) still records nothing
    b.handle("box.open", open(warm, true, Some(true)))
        .await
        .unwrap();
    b.handle("box.open", open(id, true, None)).await.unwrap();
    assert!(!ran(&log).contains("record"), "{}", ran(&log));
    assert!(said
        .kinds()
        .iter()
        .all(|k| k.get("recordingStartedAt").is_none()));

    b.handle(
        "box.assign",
        json!({ "boxId": id, "url": null, "asPerson": false }),
    )
    .await
    .unwrap();
    assert!(
        !ran(&log).contains("record"),
        "handed out unasked: {}",
        ran(&log)
    );
    assert!(said.kinds()[2].get("recordingStartedAt").is_none());

    b.handle(
        "box.assign",
        json!({ "boxId": warm, "url": null, "asPerson": false, "record": true }),
    )
    .await
    .unwrap();
    assert_eq!(ran(&log).matches("record start").count(), 1);
    let ready = said.kinds()[3].clone();
    assert!(
        ready["recordingStartedAt"].is_string(),
        "the hand-out that asked records from there: {ready}"
    );
}

#[tokio::test]
async fn a_span_begun_with_recording_off_records_its_clip_and_stops_at_its_end() {
    let id = box_id();
    let root = Scratch::new("rec");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    let log = fake_tools(&root, &b, &[id]);
    b.handle("box.open", open(id, false, None)).await.unwrap();
    let span = "7e1c7a52-3c4d-4e6f-8a1b-2c3d4e5f6a7b";
    let mark = |edge: &str, recording: &str| json!({ "boxId": id, "spanId": span, "criterion": 2, "edge": edge, "recording": recording });

    b.handle("box.span.mark", mark("start", "start"))
        .await
        .unwrap();
    let k = said.kinds();
    assert_eq!(
        (k[1]["kind"].as_str(), k[1]["state"].as_str()),
        (Some("recording"), Some("on")),
        "{k:?}"
    );
    assert_eq!(
        k[2]["kind"], "mark",
        "the mark lands after the recording began"
    );
    assert!(b.slots()[id].recording);

    b.handle("box.span.mark", mark("end", "stop"))
        .await
        .unwrap();
    let k = said.kinds();
    assert_eq!(k[3]["kind"], "mark");
    assert_eq!(
        (k[4]["kind"].as_str(), k[4]["state"].as_str()),
        (Some("recording"), Some("off")),
        "{k:?}"
    );
    assert!(!b.slots()[id].recording, "the span's end stopped it");
    let dir = b.0.ctx.box_dir(id);
    let names = files(&dir);
    assert!(
        names
            .iter()
            .any(|n| n.starts_with("seg-") && n.ends_with(".webm"))
            && !names.contains(&"session.webm".to_string()),
        "the span's recording is closed into a segment: {names:?}"
    );

    let from = k[2]["offsetMs"].as_u64().unwrap();
    b.handle("box.recording.fetch", json!({ "boxId": id, "spanId": span, "fromMs": from, "toMs": from + 1000, "maxSeconds": 20, "maxBytes": 1_000_000 }))
        .await
        .unwrap();
    let clips = said.1.lock().unwrap().clone();
    assert_eq!(
        clips,
        vec![(id.to_string(), span.to_string(), b"cut".to_vec())],
        "{:?}",
        said.kinds()
    );
    assert_eq!(
        ran(&log).matches("record start").count(),
        1,
        "a stopped recording is cut as it is, never started again: {}",
        ran(&log)
    );
}

#[tokio::test]
async fn a_recording_set_on_and_off_is_reported_and_never_started_twice() {
    let id = box_id();
    let root = Scratch::new("rec");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    let log = fake_tools(&root, &b, &[id]);
    b.handle("box.open", open(id, false, None)).await.unwrap();
    for on in [true, true, false, false] {
        b.handle("box.recording.set", json!({ "boxId": id, "on": on }))
            .await
            .unwrap();
    }
    let states: Vec<String> = said.kinds()[1..]
        .iter()
        .map(|k| format!("{}:{}", k["kind"], k["state"]))
        .collect();
    assert_eq!(
        states,
        [
            "\"recording\":\"on\"",
            "\"recording\":\"on\"",
            "\"recording\":\"off\"",
            "\"recording\":\"off\""
        ]
    );
    assert_eq!(ran(&log).matches("record start").count(), 1);
    assert_eq!(ran(&log).matches("record stop").count(), 1);

    let gone = box_id();
    b.handle("box.recording.set", json!({ "boxId": gone, "on": true }))
        .await
        .unwrap();
    let last = said.kinds().pop().unwrap();
    assert_eq!(last["state"], "failed");
    assert!(last["detail"].as_str().unwrap().contains("not running"));
}

/// ffmpeg as a script that writes its last argument and keeps the concat list it was handed.
fn ffmpeg_keeping_its_list(root: &Scratch) -> PathBuf {
    let kept = root.path().join("concat-list");
    root.script(
        "bin/ffmpeg",
        &format!(
            r#"prev=; for a; do if [ "$prev" = -i ] && [ "${{a%.txt}}" != "$a" ]; then cp "$a" {kept}; fi; prev=$a; last=$a; done
printf cut > "$last""#,
            kept = kept.display()
        ),
    );
    kept
}

/// ISS-1338: a recording a person asked for, kept as segments and the live file the close left, is
/// sent whole, in the order it was recorded, through the span clip's upload with `session` in the
/// span's place.
#[tokio::test]
async fn a_kept_recording_is_sent_whole_through_the_clip_upload_once_its_box_closed() {
    let sent = box_id();
    let root = Scratch::new("rec");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    fake_tools(&root, &b, &[sent]);
    let kept = ffmpeg_keeping_its_list(&root);
    b.handle("box.open", open(sent, false, Some(true)))
        .await
        .unwrap();
    for on in [false, true] {
        b.handle("box.recording.set", json!({ "boxId": sent, "on": on }))
            .await
            .unwrap();
    }
    b.handle("box.close", json!({ "boxId": sent, "why": "done" }))
        .await
        .unwrap();
    let dir = b.0.ctx.box_dir(sent);
    b.handle(
        "box.recording.upload",
        json!({ "boxId": sent, "maxBytes": 1_000_000 }),
    )
    .await
    .unwrap();

    let clips = said.1.lock().unwrap().clone();
    assert_eq!(
        clips,
        vec![(sent.to_string(), "session".to_string(), b"cut".to_vec())],
        "{:?}",
        said.kinds()
    );
    let list = std::fs::read_to_string(&kept).unwrap();
    let named: Vec<&str> = list.lines().collect();
    assert_eq!(named.len(), 2, "the segment and the live file: {list}");
    assert!(
        named[0].contains(&format!("{}/seg-", dir.display())),
        "the closed segment first: {list}"
    );
    assert!(
        named[1].ends_with("session.webm'"),
        "the live file the close left, last: {list}"
    );
    assert!(
        !dir.join("cuts").join("session").exists(),
        "the encode's work is cleared: {:?}",
        files(&dir)
    );
    assert!(said.kinds().iter().all(|k| k["kind"] != "session_failed"));
}

#[tokio::test]
async fn a_recording_past_the_ceiling_is_said_too_large_and_never_sent() {
    let large = box_id();
    let root = Scratch::new("rec");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    fake_tools(&root, &b, &[large]);
    b.handle("box.open", open(large, false, Some(true)))
        .await
        .unwrap();
    b.handle("box.close", json!({ "boxId": large, "why": "done" }))
        .await
        .unwrap();
    b.handle(
        "box.recording.upload",
        json!({ "boxId": large, "maxBytes": 2 }),
    )
    .await
    .unwrap();
    assert!(said.1.lock().unwrap().is_empty(), "nothing sent");
    let failed = said.kinds().pop().unwrap();
    assert_eq!(
        (failed["kind"].as_str(), failed["fault"].as_str()),
        (Some("session_failed"), Some("TOO_LARGE")),
        "{failed}"
    );
    assert!(
        failed["detail"].as_str().unwrap().contains("over the 2"),
        "{failed}"
    );
}

#[tokio::test]
async fn a_recording_no_longer_on_the_device_is_said_gone() {
    let gone = box_id();
    let root = Scratch::new("rec");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    fake_tools(&root, &b, &[]);
    b.handle(
        "box.recording.upload",
        json!({ "boxId": gone, "maxBytes": 1_000_000 }),
    )
    .await
    .unwrap();
    assert!(said.1.lock().unwrap().is_empty());
    let failed = said.kinds().pop().unwrap();
    assert_eq!(
        (failed["kind"].as_str(), failed["fault"].as_str()),
        (Some("session_failed"), Some("DEVICE_GONE")),
        "{failed}"
    );
}
