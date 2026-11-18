//! ISS-1324: a warm box is handed out only while its device answers. A warm android box whose
//! emulator is not running is failed `BOX_DEVICE_GONE` by name, with adb's answer, and reaped,
//! never handed out; the health sweep finds it before an open does. adb is a script.

use super::tests::{boxes, Said};
use super::*;
use crate::android::{Android, Tools};
use crate::testkit::Scratch;
use std::path::Path;

const DEAD: &str = "2f6e7a52-3c4d-4e6f-8a1b-2c3d4e5f6a7b";
const LIVE: &str = "3a7e7a52-3c4d-4e6f-8a1b-2c3d4e5f6a7b";

/// adb as a script: emulator-5556 is gone, emulator-5554 is booted and answers.
#[cfg(unix)]
fn fake_adb(root: &Scratch) -> PathBuf {
    root.script(
        "bin/adb",
        r#"case "$2" in
  emulator-5556) echo "error: device 'emulator-5556' not found" >&2; exit 1;;
esac
case "$3" in
  get-state) echo device;;
  shell) echo 1;;
esac
exit 0"#,
    )
}

/// A warm android box on `port`, planted as the runner holds one after its open.
fn plant_android(b: &Boxes, root: &Scratch, id: &str, port: u16, adb: &Path) {
    let tools = Tools {
        emulator: root.path().join("bin/emulator"),
        adb: adb.to_path_buf(),
        agent_device: root.path().join("bin/agent-device"),
        sdk: root.path().join("sdk"),
        scrcpy_server: root.path().join("scrcpy-server"),
        scrcpy_version: "3.3.3".into(),
        node_dir: None,
        avd_home: None,
    };
    let dir = b.0.ctx.box_dir(id);
    let a = Android::new(
        id,
        tools,
        port,
        dir.join("session.webm"),
        dir.join("device"),
    );
    b.slots().insert(
        id.into(),
        Slot {
            running: Some(Arc::new(Running::Android(a))),
            held: watch::channel(false).0,
            clock: record::Clock::started_now(),
            recording: false,
            warm: true,
            closing: false,
            attach: None,
        },
    );
}

fn failed_of(said: &Said, id: &str) -> Option<Value> {
    said.0
        .lock()
        .unwrap()
        .iter()
        .find(|(b, k)| b == id && k["state"] == "failed")
        .map(|(_, k)| k.clone())
}

#[cfg(unix)]
#[tokio::test]
async fn a_warm_android_box_whose_emulator_is_gone_is_failed_by_name_never_handed_out() {
    let root = Scratch::new("warm");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    let adb = fake_adb(&root);
    plant_android(&b, &root, DEAD, 5556, &adb);

    b.handle(
        "box.assign",
        json!({ "boxId": DEAD, "url": null, "asPerson": false }),
    )
    .await
    .unwrap();
    assert!(
        said.kinds().iter().all(|k| k["state"] != "ready"),
        "never handed out: {:?}",
        said.kinds()
    );
    let failed = failed_of(&said, DEAD).expect("failed by name");
    assert_eq!(failed["failure"], "BOX_DEVICE_GONE");
    let detail = failed["detail"].as_str().unwrap();
    assert!(
        detail.contains("get-state") && detail.contains("not found"),
        "names the check and adb's answer: {detail}"
    );
    assert!(detail.contains("emulator log tail"), "{detail}");
    assert!(
        !b.slots().contains_key(DEAD),
        "reaped: the runner holds it no more"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn the_sweep_fails_the_dead_warm_box_and_hands_out_the_live_one() {
    let root = Scratch::new("warm");
    let said = Arc::new(Said::default());
    let b = boxes(&root, said.clone());
    let adb = fake_adb(&root);
    plant_android(&b, &root, DEAD, 5556, &adb);
    plant_android(&b, &root, LIVE, 5554, &adb);

    b.sweep_warm().await;
    assert_eq!(
        failed_of(&said, DEAD).map(|k| k["failure"].clone()),
        Some(json!("BOX_DEVICE_GONE"))
    );
    assert!(failed_of(&said, LIVE).is_none(), "{:?}", said.kinds());
    assert!(!b.slots().contains_key(DEAD) && b.slots().contains_key(LIVE));

    b.handle(
        "box.assign",
        json!({ "boxId": LIVE, "url": null, "asPerson": false }),
    )
    .await
    .unwrap();
    let ready = said
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|(id, k)| id == LIVE && k["state"] == "ready")
        .map(|(_, k)| k.clone());
    assert!(
        ready.is_some(),
        "the live one is handed out: {:?}",
        said.kinds()
    );
    assert!(
        !b.slots()[LIVE].warm,
        "handed out, the sweep leaves it to its holder"
    );
}
