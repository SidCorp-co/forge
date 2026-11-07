//! A wake typed into a pane whose program reads its input the way Claude Code does, on a tmux
//! server of the test's own (ISS-1081).
//!
//! The stand-in is still starting for `--startup` seconds: the tty is as tmux made it (canonical,
//! echo, ICRNL), nothing is read and no composer is drawn. Then it goes raw as libuv does
//! (`TCSADRAIN`, so input already queued is kept), turns bracketed paste on and draws a composer.
//! A paste between `ESC[200~` and `ESC[201~` is one pending entry with its CRs as text; a CR
//! outside one submits; an LF (Ctrl-J) is a newline in the draft. `--swallow N` drops the first N
//! submitting Enters and `--never` every one. Each submit is written to `--log`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::tests::{tmux_or_skip, SKIP_TMUX};
use super::TEST_SOCKET;

const STAND_IN: &str = r#"
import argparse, os, sys, termios, time, tty
ap = argparse.ArgumentParser()
ap.add_argument("--startup", type=float, default=0.0)
ap.add_argument("--swallow", type=int, default=0)
ap.add_argument("--never", action="store_true")
ap.add_argument("--log", required=True)
a = ap.parse_args()
log = open(a.log, "a", buffering=1)
time.sleep(a.startup)
tty.setraw(0, termios.TCSADRAIN)
os.write(1, b"\x1b[?2004h")
draft, pastes, enters, done = "", 0, 0, []
in_paste, pbuf, pending = False, "", ""
def draw():
    w = lambda s: os.write(1, s.encode())
    w("\x1b[2J\x1b[H")
    for t in done[-5:]:
        w(t + "\r\n")
    w("\r\n" + "─" * 60 + "\r\n")
    lines = draft.split("\n")
    if draft == "":
        w("❯ \x1b[2mTry something\x1b[0m\r\n")
    else:
        w("❯ " + lines[0] + "\r\n")
        for ln in lines[1:]:
            w("  " + ln + "\r\n")
    w("─" * 60 + "\r\n  ? for shortcuts\r\n")
def enter():
    global enters, draft
    enters += 1
    if a.never or enters <= a.swallow:
        log.write("swallowed %d\n" % enters)
    elif draft:
        log.write("SUBMITTED on enter %d: %s\n" % (enters, draft.split("\n")[0]))
        done.append("submitted")
        draft = ""
draw()
while True:
    data = os.read(0, 65536)
    if not data:
        break
    s, pending, i = pending + data.decode("utf-8", "replace"), "", 0
    while i < len(s):
        if in_paste:
            end = s.find("\x1b[201~", i)
            if end < 0:
                pbuf, i = pbuf + s[i:], len(s)
                continue
            pbuf += s[i:end]
            pastes += 1
            n = pbuf.count("\r") + pbuf.count("\n")
            draft += pbuf if n == 0 else "[Pasted text #%d +%d lines]" % (pastes, n)
            pbuf, in_paste, i = "", False, end + 6
        elif s.startswith("\x1b[200~", i):
            in_paste, i = True, i + 6
        elif s[i] == "\x1b" and len(s) - i < 6:
            pending = s[i:]
            break
        else:
            c = s[i]
            if c == "\r":
                enter()
            elif c == "\n":
                draft += "\n"
            elif c >= " ":
                draft += c
            i += 1
    draw()
"#;

/// The wake a master is handed: long and many lines, as a real brief is.
fn wake() -> String {
    (1..=20)
        .map(|i| format!("Line {i} of the wake, long enough that the text is a real paste."))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A tmux server of the test's own, with one pane running the stand-in. Dropping it ends that
/// server by its socket and removes its directory.
struct Pane {
    dir: PathBuf,
    name: String,
    log: PathBuf,
}

impl Drop for Pane {
    fn drop(&mut self) {
        TEST_SOCKET.with(|s| s.borrow_mut().take());
        let _ = std::process::Command::new("tmux")
            .arg("-S")
            .arg(self.dir.join("s"))
            .arg("kill-server")
            .output();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Start the stand-in with `args`, or `None` where the box opted out of tests needing tmux.
fn stand_in(test: &str, args: &str) -> Option<Pane> {
    if !tmux_or_skip(test) {
        return None;
    }
    if which::which("python3").is_err() {
        if std::env::var(SKIP_TMUX).as_deref() == Ok("1") {
            eprintln!("SKIPPED {test}: python3 is not on PATH and {SKIP_TMUX}=1 opted this run out — nothing was asserted");
            return None;
        }
        panic!("PYTHON3_NOT_ON_PATH: {test} runs a stand-in for Claude Code's composer in python3, which is not on PATH — install it, or set {SKIP_TMUX}=1 to skip it by name");
    }
    let dir = std::env::temp_dir().join(format!(
        "fwk-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("stand_in.py");
    std::fs::write(&script, STAND_IN).unwrap();
    let log = dir.join("log");
    std::fs::write(&log, "").unwrap();
    let pane = Pane {
        name: "forge-master-wake".to_string(),
        log: log.clone(),
        dir,
    };
    let command = format!(
        "python3 {} --log {} {args}",
        super::shell_quote(&script.to_string_lossy()),
        super::shell_quote(&log.to_string_lossy())
    );
    let started = std::process::Command::new("tmux")
        .arg("-S")
        .arg(pane.dir.join("s"))
        .args([
            "new-session",
            "-d",
            "-x",
            "120",
            "-y",
            "50",
            "-s",
            &pane.name,
            &command,
        ])
        .output()
        .unwrap();
    assert!(
        started.status.success(),
        "tmux new-session: {}",
        String::from_utf8_lossy(&started.stderr)
    );
    TEST_SOCKET.with(|s| *s.borrow_mut() = Some(pane.dir.join("s")));
    Some(pane)
}

/// What the stand-in logged, once it has logged `want` or `within` has passed.
fn logged(pane: &Pane, want: &str, within: Duration) -> String {
    let deadline = Instant::now() + within;
    loop {
        let seen = std::fs::read_to_string(&pane.log).unwrap_or_default();
        if seen.contains(want) || Instant::now() >= deadline {
            return seen;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The live failure: a resumed pane takes longer than the old fixed delay to draw its composer.
/// The wake typed before the program reads lands in a canonical tty, which turns its Enter into an
/// LF, a newline in the draft, so the wake sat at the prompt while the box read it delivered.
#[tokio::test(flavor = "current_thread")]
async fn a_wake_typed_while_the_pane_is_still_starting_is_submitted_once_it_draws_its_composer() {
    let test =
        "a_wake_typed_while_the_pane_is_still_starting_is_submitted_once_it_draws_its_composer";
    let Some(pane) = stand_in(test, "--startup 7") else {
        return;
    };
    let typed = super::brief_new_pane(&pane.name, &wake()).await;
    let log = logged(&pane, "SUBMITTED", Duration::from_secs(10));
    assert!(
        log.contains("SUBMITTED on enter 1"),
        "the wake was left unsubmitted at the prompt of a pane still starting (typed: {typed:?}); the stand-in logged: {log:?}"
    );
    assert!(
        typed.is_ok(),
        "a submitted wake was said not delivered: {typed:?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_wake_whose_first_enter_is_swallowed_is_pressed_again_and_submits() {
    let test = "a_wake_whose_first_enter_is_swallowed_is_pressed_again_and_submits";
    let Some(pane) = stand_in(test, "--swallow 1") else {
        return;
    };
    let typed = super::brief_new_pane(&pane.name, &wake()).await;
    let log = logged(&pane, "SUBMITTED", Duration::from_secs(5));
    assert!(
        log.contains("SUBMITTED on enter 2"),
        "a wake whose first Enter was swallowed was not pressed again (typed: {typed:?}); the stand-in logged: {log:?}"
    );
    assert!(
        typed.is_ok(),
        "a submitted wake was said not delivered: {typed:?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_wake_that_never_submits_is_said_unsent_naming_the_pane() {
    let test = "a_wake_that_never_submits_is_said_unsent_naming_the_pane";
    let Some(pane) = stand_in(test, "--never") else {
        return;
    };
    let typed = super::brief_new_pane(&pane.name, &wake()).await;
    let log = logged(&pane, "swallowed 3", Duration::from_secs(5));
    let said = match &typed {
        Err(e) => e.to_string(),
        Ok(_) => {
            panic!("a wake the pane never took was said delivered; the stand-in logged: {log:?}")
        }
    };
    assert!(
        said.contains(&pane.name) && said.contains("unsent"),
        "the refusal does not name the pane and the wake sitting unsent: {said}"
    );
    assert!(
        !log.contains("SUBMITTED"),
        "the stand-in submitted, so this plants nothing: {log:?}"
    );
}
