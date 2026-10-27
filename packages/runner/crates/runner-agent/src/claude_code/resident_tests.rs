//! A resident session closed so a turn can replace it (adminhub-free support room, dev runner,
//! 2026-10-27 03:41:12–25Z). The turn carried its own token, so the box closed the resident and
//! spawned the replacement under the same session key at once. The closed process's completion
//! task then reaped by that key: it took the replacement's child, killed it mid-turn and removed
//! its entry, and the turn failed `[NO_RESULT_EXIT] no exit code, no result event`.
//!
//! Stand-in processes play Claude Code here: a shell that ends a while after its stdin closes, as
//! a resident one does after EOF.

use super::*;

/// A stand-in session under `key`, adopted as `start` adopts a spawned Claude Code; answers its pid.
async fn stand_in(runner: &ClaudeCodeRunner, key: &str, script: &str, keep_resident: bool) -> u32 {
    let (pid, adopted) = try_stand_in(runner, key, script, keep_resident).await;
    adopted.expect("the stand-in was not adopted");
    pid
}

/// As [`stand_in`], answering what adopting it answered.
async fn try_stand_in(
    runner: &ClaudeCodeRunner,
    key: &str,
    script: &str,
    keep_resident: bool,
) -> (u32, Result<()>) {
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c")
        .arg(script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    own_session(&mut cmd);
    let mut child = cmd.spawn().expect("the stand-in did not spawn");
    let pid = child.id().expect("a spawned stand-in has a pid");
    let stdin = child.stdin.take().expect("a piped stdin");
    let (tx, mut rx) = mpsc::channel::<RunnerEvent>(64);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let adopted = runner
        .adopt(
            Spawned {
                job_id: key.to_string(),
                child,
                stdin,
                egress: None,
                mcp_path: std::env::temp_dir()
                    .join(format!("absent-{}.json", uuid::Uuid::new_v4())),
                bearer_dir: None,
                invoked_with_resume: false,
                permit: None,
                keep_resident,
                model: None,
                project_slug: None,
            },
            tx,
        )
        .await;
    (pid, adopted)
}

fn alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

async fn held_pid(runner: &ClaudeCodeRunner, key: &str) -> Option<u32> {
    let map = runner.sessions.lock().await;
    map.get(key)
        .and_then(|s| s.child.as_ref())
        .and_then(|c| c.id())
}

/// The process a turn closes ends a second after its stdin does, so its reaper finishes after the
/// replacement has spawned unless the close waits for it.
#[tokio::test]
async fn closing_a_resident_never_lets_its_reaper_touch_the_turn_that_replaces_it() {
    let runner = ClaudeCodeRunner::new("http://127.0.0.1:9", "device-token", 1);
    let old = stand_in(&runner, "s", "cat >/dev/null; sleep 1", true).await;
    runner.close(&"s".to_string()).await;
    let new = stand_in(&runner, "s", "cat >/dev/null", true).await;
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(!alive(old), "the closed resident is still running");
    assert!(
        alive(new),
        "the closed resident's reaper killed the turn that replaced it: a replacement turn shares no live state with the process it replaces"
    );
    assert_eq!(
        held_pid(&runner, "s").await,
        Some(new),
        "the closed resident's reaper took or removed the replacement's session entry"
    );
    runner.close(&"s".to_string()).await;
}

/// A resident that does not end when its stdin closes is killed once the close grace has passed,
/// and the close returns only with its key free.
#[tokio::test]
async fn a_resident_that_outlives_its_close_is_killed_and_its_key_freed() {
    let runner = ClaudeCodeRunner::new("http://127.0.0.1:9", "device-token", 1)
        .with_close_grace(Duration::from_millis(300));
    let old = stand_in(&runner, "s", "sleep 30", true).await;
    let closed =
        tokio::time::timeout(Duration::from_secs(15), runner.close(&"s".to_string())).await;
    assert!(closed.is_ok(), "the close never returned");
    assert!(
        !alive(old),
        "a resident that ignored its EOF was left running past the close grace"
    );
    assert!(
        !runner.holds(&"s".to_string()).await,
        "the close returned while the key was still held"
    );
}

/// Nothing is adopted under a key a live process still holds: the newcomer is refused by name and
/// killed, and the holder is left as it was.
#[tokio::test]
async fn a_process_spawned_under_a_held_key_is_refused_by_name_and_killed() {
    let runner = ClaudeCodeRunner::new("http://127.0.0.1:9", "device-token", 1);
    let first = stand_in(&runner, "s", "cat >/dev/null", true).await;
    let (second, adopted) = try_stand_in(&runner, "s", "cat >/dev/null", true).await;
    let err = adopted.expect_err("a second process was adopted under a key a live one holds");
    assert!(err.to_string().contains("SESSION_KEY_HELD"), "{err}");
    assert!(!alive(second), "the refused process was left running");
    assert!(alive(first), "refusing the newcomer touched the holder");
    assert_eq!(held_pid(&runner, "s").await, Some(first));
    runner.close(&"s".to_string()).await;
}

fn scratch() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("resident-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn read(path: &std::path::Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

async fn set_idle(runner: &ClaudeCodeRunner, key: &str) {
    if let Some(s) = runner.sessions.lock().await.get_mut(key) {
        s.in_turn = false;
    }
}

/// The 2026-10-27 double delivery: core handed the box a turn, then wrote the next member message
/// into "the running turn" before the box had placed it. The box wrote it into the idle resident
/// the turn was about to close, which answered it under a revoked token, and the replacement read
/// it again from the transcript it resumed. The message waits for the turn and goes into its
/// process alone.
#[tokio::test]
async fn a_message_for_a_turn_still_being_placed_goes_into_that_turn_and_never_into_the_resident_it_closes(
) {
    let dir = scratch();
    let (old_in, new_in) = (dir.join("old"), dir.join("new"));
    let runner = Arc::new(ClaudeCodeRunner::new(
        "http://127.0.0.1:9",
        "device-token",
        1,
    ));
    let key = "s".to_string();
    // the resident the box held, idle between turns, spawned without core's keepResident as the
    // box in the incident read it
    stand_in(&runner, &key, &format!("cat > {}", old_in.display()), false).await;
    set_idle(&runner, &key).await;

    let placing = runner.place_turn(&key);
    let write = tokio::spawn({
        let (runner, key) = (runner.clone(), key.clone());
        async move {
            runner
                .inject_resident(&key, "@babo Check MTA config", ("sess".into(), 1))
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !read(&old_in).contains("Check MTA config"),
        "the message was written into the resident the turn core handed over is replacing"
    );
    assert!(
        !write.is_finished(),
        "the write did not wait for the turn being placed"
    );

    runner.close(&key).await;
    stand_in(&runner, &key, &format!("cat > {}", new_in.display()), true).await;
    drop(placing);
    let wrote = tokio::time::timeout(Duration::from_secs(5), write)
        .await
        .expect("the write never ended once the turn was placed")
        .unwrap();
    assert!(
        wrote.is_ok(),
        "the placed turn refused the message: {wrote:?}"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        read(&new_in).contains("Check MTA config"),
        "the turn the message was written for never got it"
    );
    assert!(
        !read(&old_in).contains("Check MTA config"),
        "the closed resident got the message as well"
    );
    runner.close(&key).await;
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A turn that never reached a process leaves the message refused, never written into the idle
/// resident core keeps between turns: core hands it to the next turn.
#[tokio::test]
async fn a_message_for_a_turn_that_never_started_is_refused_not_written_into_the_idle_resident() {
    let dir = scratch();
    let old_in = dir.join("old");
    let runner = Arc::new(ClaudeCodeRunner::new(
        "http://127.0.0.1:9",
        "device-token",
        1,
    ));
    let key = "s".to_string();
    stand_in(&runner, &key, &format!("cat > {}", old_in.display()), true).await;
    set_idle(&runner, &key).await;
    let placing = runner.place_turn(&key);
    let write = tokio::spawn({
        let (runner, key) = (runner.clone(), key.clone());
        async move {
            runner
                .inject_resident(&key, "a member message", ("sess".into(), 1))
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    drop(placing);
    let wrote = tokio::time::timeout(Duration::from_secs(5), write)
        .await
        .unwrap()
        .unwrap();
    assert!(
        wrote.is_err(),
        "a resident with no turn in flight took the message"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!read(&old_in).contains("a member message"));
    runner.close(&key).await;
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A turn on its way to a process is a session this box holds, so an inbox write for it is not
/// left unanswered as one held nowhere.
#[tokio::test]
async fn a_session_with_a_turn_being_placed_is_held_here() {
    let runner = ClaudeCodeRunner::new("http://127.0.0.1:9", "device-token", 1);
    let key = "s".to_string();
    assert!(!runner.holds(&key).await);
    let placing = runner.place_turn(&key);
    let again = runner.place_turn(&key);
    assert!(runner.holds(&key).await);
    drop(placing);
    assert!(
        runner.holds(&key).await,
        "one of two turns placed released the hold of both"
    );
    drop(again);
    assert!(!runner.holds(&key).await);
}
