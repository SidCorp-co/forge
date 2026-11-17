#![cfg(target_os = "linux")]
//! Close reaps every process a box started, proved with `pgrep` as a person would check: a child
//! that cleared its environment, one in a session of its own, and the leader, all gone.

use super::*;

fn pgrep(pattern: &str) -> Vec<String> {
    let out = std::process::Command::new("pgrep")
        .args(["-u", &nix::unistd::getuid().to_string(), "-f", pattern])
        .output()
        .expect("pgrep runs");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(String::from)
        .collect()
}

/// Kills whatever matches `pattern` when the test ends, red or green: a test proving a leak must
/// not leak itself when the reap it proves is broken.
struct Sweep(String);

impl Drop for Sweep {
    fn drop(&mut self) {
        for pid in pgrep(&self.0) {
            if let Ok(pid) = pid.parse::<i32>() {
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(pid),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
        }
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn close_reaps_every_process_the_box_started_whatever_it_did_to_escape() {
    let id = uuid::Uuid::new_v4().to_string();
    // a unique duration per run, so pgrep sees this test's sleeps and nobody else's
    let tag = format!("73{}", std::process::id() % 10_000);
    let script = format!(
        "env -i /bin/sleep {tag}.1 & setsid /bin/sleep {tag}.2 & /bin/sleep {tag}.3 & exec /bin/sleep {tag}.4"
    );
    let mut child = command("/bin/sh", &id)
        .args(["-c", &script])
        .spawn()
        .expect("spawn");
    let pattern = format!("sleep {tag}\\.[1-4]");
    let _sweep = Sweep(pattern.clone());
    for _ in 0..50 {
        if pgrep(&pattern).len() == 4 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(pgrep(&pattern).len(), 4, "the box's four sleeps run");
    assert!(pids_of(&id).len() >= 4, "{:?}", pids_of(&id));
    assert!(marked_boxes().contains(&id));

    let reaped = reap(&id, Duration::from_secs(2)).await;
    let _ = child.wait().await;
    assert!(reaped.left.is_empty(), "left running: {:?}", reaped.left);
    assert_eq!(
        pgrep(&pattern),
        Vec::<String>::new(),
        "pgrep finds none of the box's processes after close"
    );
    assert!(!marked_boxes().contains(&id));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_process_that_ignores_term_is_killed_and_another_boxs_is_left_alone() {
    let (ours, theirs) = (
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    );
    let tag = format!("74{}", std::process::id() % 10_000);
    let _sweep = Sweep(format!("sleep {tag}\\.[12]"));
    let mut stubborn = command("/bin/sh", &ours)
        .args(["-c", &format!("trap '' TERM; /bin/sleep {tag}.1; :")])
        .spawn()
        .expect("spawn");
    let mut other = command("/bin/sleep", &theirs)
        .arg(format!("{tag}.2"))
        .spawn()
        .expect("spawn");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let reaped = reap(&ours, Duration::from_millis(500)).await;
    let _ = stubborn.wait().await;
    assert!(reaped.left.is_empty(), "{reaped:?}");
    assert!(pgrep(&format!("sleep {tag}\\.1")).is_empty());
    assert_eq!(
        pgrep(&format!("sleep {tag}\\.2")).len(),
        1,
        "the other box runs on"
    );
    reap(&theirs, Duration::from_secs(1)).await;
    let _ = other.wait().await;
    assert!(pgrep(&format!("sleep {tag}\\.2")).is_empty());
}
