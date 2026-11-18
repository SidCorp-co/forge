//! A pool job's pane read on a real tmux server: alive while tmux holds it, ended once it does
//! not, and never ended on a tmux that could not be asked (ISS-1323).

use std::path::PathBuf;

use super::tests::tmux_or_skip;
use super::{job_pane_ended, JOB_PREFIX, TEST_SOCKET};

struct Server(PathBuf);

impl Drop for Server {
    fn drop(&mut self) {
        TEST_SOCKET.with(|s| s.borrow_mut().take());
        let _ = std::process::Command::new("tmux")
            .arg("-S")
            .arg(self.0.join("s"))
            .arg("kill-server")
            .output();
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn server_holding(name: &str) -> Server {
    let dir = std::env::temp_dir().join(format!("fjp-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let server = Server(dir);
    let started = std::process::Command::new("tmux")
        .arg("-S")
        .arg(server.0.join("s"))
        .args(["new-session", "-d", "-s", name, "sleep 600"])
        .output()
        .unwrap();
    assert!(
        started.status.success(),
        "tmux new-session: {}",
        String::from_utf8_lossy(&started.stderr)
    );
    TEST_SOCKET.with(|s| *s.borrow_mut() = Some(server.0.join("s")));
    server
}

#[tokio::test(flavor = "current_thread")]
async fn a_job_pane_tmux_holds_has_not_ended_though_no_bg_roster_lists_it() {
    if !tmux_or_skip("a_job_pane_tmux_holds_has_not_ended_though_no_bg_roster_lists_it") {
        return;
    }
    let name = format!("{JOB_PREFIX}-{}", uuid::Uuid::new_v4());
    let _server = server_holding(&name);
    assert!(
        !job_pane_ended(&name).await,
        "a live job pane read as ended: the pool would fail a running job and start it again"
    );
    let other = format!("{JOB_PREFIX}-{}", uuid::Uuid::new_v4());
    assert!(
        job_pane_ended(&other).await,
        "a pane tmux does not hold reads as ended"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_tmux_that_cannot_be_asked_ends_no_job_pane() {
    if !tmux_or_skip("a_tmux_that_cannot_be_asked_ends_no_job_pane") {
        return;
    }
    let dir = std::env::temp_dir().join(format!("fjp-{}", uuid::Uuid::new_v4().simple()));
    let _gone = Server(dir.clone());
    TEST_SOCKET.with(|s| *s.borrow_mut() = Some(dir.join("no-server")));
    let name = format!("{JOB_PREFIX}-{}", uuid::Uuid::new_v4());
    assert!(
        !job_pane_ended(&name).await,
        "a tmux with no server running is no answer, and no answer is no ending"
    );
}
