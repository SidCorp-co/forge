use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use super::*;

/// A group like a dev server's: `sh` leading a child of its own.
fn a_group() -> Child {
    Command::new("sh")
        .args(["-c", "sleep 60 & wait"])
        .process_group(0)
        .spawn()
        .expect("sh starts")
}

/// End a test's group whole: `kill` on the child reaches `sh` and leaves its `sleep`.
fn end(mut child: Child) {
    signal(child.id() as i32, true);
    let _ = child.wait();
}

fn record() -> PathBuf {
    std::env::temp_dir().join(format!("preview-groups-{}.json", uuid::Uuid::new_v4()))
}

fn gone_within(child: &mut Child, ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn the_next_image_stops_a_dev_server_the_last_one_left() {
    let path = record();
    let mut left = a_group();
    Groups::at(Some(path.clone())).note("p-1", Some(left.id()));
    // the image that noted it is gone (an exec keeps the process, loses the handle)
    let reaped = reap_left(&path, Duration::from_secs(5));
    assert_eq!(reaped, vec![left.id() as i32]);
    assert!(
        gone_within(&mut left, 3000),
        "the left group was asked to end and did not"
    );
    assert!(!path.exists(), "the record is cleared once read");
}

#[test]
fn a_recorded_pid_now_held_by_another_process_is_never_signalled() {
    let path = record();
    let mut other = a_group();
    let stale = HashMap::from([(
        "p-2".to_string(),
        Group {
            pgid: other.id() as i32,
            started: "0".into(),
        },
    )]);
    std::fs::write(&path, serde_json::to_vec(&stale).unwrap()).unwrap();
    assert!(reap_left(&path, Duration::from_millis(10)).is_empty());
    assert!(
        !gone_within(&mut other, 300),
        "a process that only shares the pid was signalled"
    );
    end(other);
}

#[test]
fn a_stopped_server_is_struck_from_the_record() {
    let path = record();
    let server = a_group();
    let groups = Groups::at(Some(path.clone()));
    groups.note("p-3", Some(server.id()));
    groups.forget("p-3");
    assert!(reap_left(&path, Duration::from_millis(10)).is_empty());
    end(server);
}
