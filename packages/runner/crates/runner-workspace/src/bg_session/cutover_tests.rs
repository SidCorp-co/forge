//! A master moves from its tmux pane to a background session only while the pane is idle
//! (ISS-1304 c1): judged on roster rows, and carried out on a tmux server of the test's own with a
//! fake `claude`.

use super::*;
use crate::bg_session::fake_claude::FakeClaude;
use std::cell::Cell;

const NAME: &str = "forge-master-p";

fn row(pid: u32, kind: &str, session: &str, name: &str, status: Option<&str>) -> BgSession {
    BgSession {
        id: (kind == "background").then(|| format!("{pid:x}")),
        session_id: session.into(),
        cwd: None,
        kind: Some(kind.into()),
        name: Some(name.into()),
        pid: Some(pid),
        status: status.map(str::to_string),
        state: None,
        waiting_for: None,
        started_at: None,
    }
}

fn pane(status: Option<&str>) -> Vec<BgSession> {
    vec![row(4100, "interactive", "conv-1", "core-7c", status)]
}

fn in_pane(pid: u32) -> bool {
    pid == 4100
}

fn nothing() -> Option<String> {
    None
}

/// The pane's own session busy, waiting on a prompt, or of no status: it stays in tmux, and the
/// work beyond its turn is not even read. Planted (the status taken as idle), a busy pane is
/// ended and this goes red.
#[test]
fn a_busy_pane_stays_in_tmux_and_is_never_ended() {
    let read = Cell::new(0);
    let work = || {
        read.set(read.get() + 1);
        None
    };
    for status in [Some("busy"), Some("waiting"), None] {
        let step = judge(NAME, Some("conv-1"), &pane(status), true, &in_pane, &work);
        let Step::StaysInTmux(why) = step else {
            panic!("a pane whose session is {status:?} was moved: {step:?}");
        };
        assert!(why.starts_with("[BG_CUTOVER_WAITS]"), "{why}");
    }
    assert_eq!(read.get(), 0);
}

/// Idle at its prompt with a background child or a child run open: it stays, naming what holds
/// it. Planted (the work not read), it is ended and this goes red.
#[test]
fn an_idle_pane_whose_work_runs_on_stays_naming_it() {
    let work = || Some("a background subagent a1 (3 min) has not ended".to_string());
    let step = judge(
        NAME,
        Some("conv-1"),
        &pane(Some("idle")),
        true,
        &in_pane,
        &work,
    );
    let Step::StaysInTmux(why) = step else {
        panic!("{step:?}");
    };
    assert!(why.contains("background subagent a1"), "{why}");
}

#[test]
fn an_idle_pane_holding_nothing_more_is_ended_then_resumed() {
    let step = judge(
        NAME,
        Some("conv-1"),
        &pane(Some("idle")),
        true,
        &in_pane,
        &nothing,
    );
    assert_eq!(step, Step::EndPane);
    // found by its name where the process tree says nothing
    let named = vec![row(77, "interactive", "conv-1", NAME, Some("idle"))];
    let step = judge(NAME, Some("conv-1"), &named, false, &|_| false, &nothing);
    assert_eq!(step, Step::EndPane);
}

/// No pane for the master and its conversation open in another process: nothing is resumed
/// against it, so no copy is ever started.
#[test]
fn a_conversation_held_outside_the_pane_is_never_resumed() {
    let elsewhere = vec![row(9, "interactive", "conv-1", "someone", Some("idle"))];
    let step = judge(
        NAME,
        Some("conv-1"),
        &elsewhere,
        false,
        &|_| false,
        &nothing,
    );
    let Step::Held(why) = step else {
        panic!("{step:?}");
    };
    assert!(
        why.starts_with("[BG_RESUME_HELD]") && why.contains("pid 9"),
        "{why}"
    );
    assert_eq!(
        judge(NAME, Some("conv-1"), &[], false, &|_| false, &nothing),
        Step::Clear
    );
    assert_eq!(
        judge(NAME, None, &elsewhere, false, &|_| false, &nothing),
        Step::Clear
    );
}

/// A pane that cannot be read, holds another conversation or is placed cold stays in tmux by
/// name: a background master started beside it would be a second one.
#[test]
fn a_pane_this_box_cannot_match_to_the_placement_stays_by_name() {
    let unlisted = judge(NAME, Some("conv-1"), &[], true, &in_pane, &nothing);
    assert!(matches!(&unlisted, Step::StaysInTmux(w) if w.starts_with("[BG_CUTOVER_UNREAD]")));
    let other = vec![row(4100, "interactive", "conv-2", NAME, Some("idle"))];
    let mismatch = judge(NAME, Some("conv-1"), &other, true, &in_pane, &nothing);
    assert!(
        matches!(&mismatch, Step::StaysInTmux(w) if w.starts_with("[BG_CUTOVER_CONVERSATION_MISMATCH]"))
    );
    let cold = judge(NAME, None, &pane(Some("idle")), true, &in_pane, &nothing);
    assert!(matches!(&cold, Step::StaysInTmux(w) if w.starts_with("[BG_CUTOVER_NO_CONVERSATION]")));
}

/// A tmux server of the test's own, holding one pane named for the master.
struct OwnServer {
    dir: std::path::PathBuf,
}

impl Drop for OwnServer {
    fn drop(&mut self) {
        crate::terminal::TEST_SOCKET.with(|s| s.borrow_mut().take());
        let _ = std::process::Command::new("tmux")
            .arg("-S")
            .arg(self.dir.join("s"))
            .arg("kill-server")
            .output();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn own_server(test: &str) -> Option<OwnServer> {
    if !crate::terminal::tests::tmux_or_skip(test) {
        return None;
    }
    let dir = std::env::temp_dir().join(format!(
        "fcut-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let server = OwnServer { dir };
    let started = std::process::Command::new("tmux")
        .arg("-S")
        .arg(server.dir.join("s"))
        .args(["new-session", "-d", "-s", NAME, "sleep 300"])
        .output()
        .unwrap();
    assert!(
        started.status.success(),
        "tmux new-session: {}",
        String::from_utf8_lossy(&started.stderr)
    );
    crate::terminal::TEST_SOCKET.with(|s| *s.borrow_mut() = Some(server.dir.join("s")));
    Some(server)
}

fn listed(pid: u32, status: &str) -> String {
    format!(
        r#"[{{"pid":{pid},"cwd":"/p","kind":"interactive","startedAt":1,"sessionId":"conv-1","name":"{NAME}","status":"{status}"}}]"#
    )
}

/// The whole cutover on a pane of its own: busy, it stays; idle with work open, it stays; idle,
/// the pane is ended, the conversation leaves the roster, and it is resumed as a background
/// session under the same session id, in the same call.
#[tokio::test]
async fn a_pane_is_moved_to_a_background_session_only_once_it_is_idle() {
    let Some(_server) = own_server("a_pane_is_moved_to_a_background_session_only_once_it_is_idle")
    else {
        return;
    };
    let pid = crate::terminal::pane_pid(NAME)
        .await
        .expect("the pane's pid");
    let fake = FakeClaude::new("cutover", &listed(pid, "busy"));
    fake.freed_when_gone(pid, "[]");

    let e = make_way(NAME, Some("conv-1"), &nothing).await.unwrap_err();
    assert!(
        e.starts_with("[BG_CUTOVER_WAITS]") && e.contains("`busy`"),
        "{e}"
    );
    assert!(crate::terminal::alive(NAME).await, "a busy pane was ended");

    fake.roster(&listed(pid, "idle"));
    let open = || Some("its child run r-1 (pid 5) is still running".to_string());
    let e = make_way(NAME, Some("conv-1"), &open).await.unwrap_err();
    assert!(e.contains("child run r-1"), "{e}");
    assert!(
        crate::terminal::alive(NAME).await,
        "a pane holding a child run was ended"
    );

    make_way(NAME, Some("conv-1"), &nothing).await.unwrap();
    assert!(
        !crate::terminal::alive(NAME).await,
        "the idle pane was left running"
    );

    let bg = format!(
        r#"[{{"pid":4300,"id":"b0b0b0b0","cwd":"/p","kind":"background","startedAt":2,"sessionId":"conv-1","name":"{NAME}","status":"idle"}}]"#
    );
    fake.on_bg(
        "backgrounded \u{b7} b0b0b0b0 \u{b7} forge-master-p\n",
        Some(&bg),
    );
    let started = crate::bg_session::BgLaunch {
        name: NAME.into(),
        cwd: fake.dir.clone(),
        settings: fake.dir.join("s.json"),
        permission_mode: "bypassPermissions".into(),
        resume: Some("conv-1".into()),
        ..Default::default()
    }
    .start()
    .await
    .unwrap();
    assert_eq!(started.session_id, "conv-1", "resumed under another id");
    assert!(fake.calls("launches").contains("--resume conv-1"));
}
