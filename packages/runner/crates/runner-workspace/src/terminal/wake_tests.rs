//! A line typed into a job's pane whose program reads its input the way Claude Code does, on a
//! tmux server of the test's own (ISS-1081). Masters take no typed line since ISS-1268.
//!
//! The stand-in is still starting for `--startup` seconds: the tty is as tmux made it (canonical,
//! echo, ICRNL), nothing is read and no composer is drawn. Then it goes raw as libuv does
//! (`TCSADRAIN`, so input already queued is kept), turns bracketed paste on and draws a composer.
//! A paste between `ESC[200~` and `ESC[201~` is one pending entry with its CRs as text; a CR
//! outside one submits; an LF (Ctrl-J) is a newline in the draft. `--swallow N` drops the first N
//! submitting Enters and `--never` every one. Each submit is written to `--log`. `--held FILE`
//! starts with that file's text already in the draft, as a wake typed before the program read its
//! tty is left (ISS-1081 round 2), and `--busy` draws a turn's spinner over the composer, where
//! Enter queues behind the turn rather than submitting. `--suggest TEXT` draws Claude Code's prompt
//! suggestion, dim ghost text in an empty composer that Enter there submits, and `--drop-paste`
//! loses every paste, so the composer never shows one.

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
ap.add_argument("--held")
ap.add_argument("--busy", action="store_true")
ap.add_argument("--suggest")
ap.add_argument("--drop-paste", action="store_true")
a = ap.parse_args()
log = open(a.log, "a", buffering=1)
time.sleep(a.startup)
tty.setraw(0, termios.TCSADRAIN)
os.write(1, b"\x1b[?2004h")
draft, pastes, enters, done = "", 0, 0, []
if a.held:
    draft = open(a.held).read()
in_paste, pbuf, pending = False, "", ""
def draw():
    w = lambda s: os.write(1, s.encode())
    w("\x1b[2J\x1b[H")
    for t in done[-5:]:
        w(t + "\r\n")
    if a.busy:
        w("\u273b Pondering\u2026 (12s \u00b7 esc to interrupt)\r\n")
    w("\r\n" + "─" * 60 + "\r\n")
    lines = draft.split("\n")
    if draft == "":
        w("❯ \x1b[2m%s\x1b[0m\r\n" % (a.suggest or "Try something"))
    else:
        w("❯ " + lines[0] + "\r\n")
        for ln in lines[1:]:
            w("  " + ln + "\r\n")
    w("─" * 60 + "\r\n  ? for shortcuts\r\n")
def enter():
    global enters, draft
    enters += 1
    if a.busy:
        log.write("QUEUED on enter %d\n" % enters)
    elif draft == "" and a.suggest:
        log.write("SUGGESTION SUBMITTED on enter %d: %s\n" % (enters, a.suggest))
    elif a.never or enters <= a.swallow:
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
            if a.drop_paste:
                pbuf, in_paste, i = "", False, end + 6
                continue
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
    stand_in_holding(test, None, args)
}

/// [`stand_in`] with `held` already in its draft, unsent.
fn stand_in_holding(test: &str, held: Option<&str>, args: &str) -> Option<Pane> {
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
    let args = match held {
        Some(text) => {
            let file = dir.join("held");
            std::fs::write(&file, text).unwrap();
            format!(
                "--held {} {args}",
                super::shell_quote(&file.to_string_lossy())
            )
        }
        None => args.to_string(),
    };
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

/// Wait for the stand-in to draw its composer, as a pane that has long been up has.
async fn drawn(pane: &Pane) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while super::pane_prompt(&pane.name).await == crate::composer::Composer::Unrecognised {
        assert!(
            Instant::now() < deadline,
            "the stand-in never drew its composer"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// One line typed at `pane`, as a job's inbox message is.
async fn nudge(pane: &Pane) -> Result<super::Prompt, super::NotTyped> {
    super::send_line(
        &pane.name,
        "Pass. Run the wave.\n\nA second line, so it goes as a paste.",
    )
    .await
}

/// Whatever the stand-in logged within `within`: for a test asserting nothing was pressed.
fn settled(pane: &Pane, within: Duration) -> String {
    std::thread::sleep(within);
    std::fs::read_to_string(&pane.log).unwrap_or_default()
}

const SUGGESTION: &str = "stand this project down until the release word comes";

/// Claude Code draws a prompt suggestion dim in an empty composer: it is no text at the prompt.
#[tokio::test(flavor = "current_thread")]
async fn a_dim_prompt_suggestion_reads_as_an_empty_prompt_and_a_nudge_is_typed() {
    let test = "a_dim_prompt_suggestion_reads_as_an_empty_prompt_and_a_nudge_is_typed";
    let Some(pane) = stand_in(test, &format!("--suggest '{SUGGESTION}'")) else {
        return;
    };
    drawn(&pane).await;
    assert_eq!(
        super::pane_prompt(&pane.name).await,
        crate::composer::Composer::Empty
    );
    let typed = nudge(&pane).await;
    let log = logged(&pane, "SUBMITTED", Duration::from_secs(5));
    assert_eq!(typed.map_err(|e| e.to_string()), Ok(super::Prompt::Empty));
    assert!(
        log.contains("SUBMITTED on enter 1: [Pasted text #1") && !log.contains("SUGGESTION"),
        "{log:?}"
    );
}

/// The live hazard: a paste that never shows was pressed regardless, and Enter at an empty
/// composer showing a suggestion sends the suggestion.
#[tokio::test(flavor = "current_thread")]
async fn no_enter_is_pressed_at_a_composer_showing_only_a_suggestion() {
    let test = "no_enter_is_pressed_at_a_composer_showing_only_a_suggestion";
    let Some(pane) = stand_in(test, &format!("--drop-paste --suggest '{SUGGESTION}'")) else {
        return;
    };
    drawn(&pane).await;
    let typed = nudge(&pane).await;
    let log = settled(&pane, Duration::from_secs(1));
    assert_eq!(
        log, "",
        "Enter was pressed at a composer holding only a suggestion"
    );
    assert!(
        matches!(typed, Err(super::NotTyped::Unsubmitted(_))),
        "{typed:?}"
    );
    assert_eq!(settled(&pane, Duration::from_millis(500)), "");
}

/// A second stand-in on `pane`'s tmux server, under `name`, logging to its own file.
fn beside(pane: &Pane, name: &str) -> PathBuf {
    let log = pane.dir.join(format!("{name}.log"));
    std::fs::write(&log, "").unwrap();
    let command = format!(
        "python3 {} --log {}",
        super::shell_quote(&pane.dir.join("stand_in.py").to_string_lossy()),
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
            name,
            &command,
        ])
        .output()
        .unwrap();
    assert!(
        started.status.success(),
        "tmux new-session {name}: {}",
        String::from_utf8_lossy(&started.stderr)
    );
    log
}

/// ISS-1261: agenfold's and forge's daily reviews fire in the same second, and both were loaded
/// into the one paste buffer the daemon named after its pid. The first paste typed agenfold's
/// review into forge's master and dropped the buffer, and agenfold's own paste found none. Two
/// projects' masters typed into at once each take their own text and nothing of the other's.
#[tokio::test(flavor = "current_thread")]
async fn two_masters_typed_into_at_once_each_take_only_their_own_text() {
    let test = "two_masters_typed_into_at_once_each_take_only_their_own_text";
    let Some(forge) = stand_in(test, "") else {
        return;
    };
    let agenfold = "forge-master-agenfold";
    let agenfold_log = beside(&forge, agenfold);
    drawn(&forge).await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while super::pane_prompt(agenfold).await == crate::composer::Composer::Unrecognised {
        assert!(
            Instant::now() < deadline,
            "{agenfold} never drew its composer"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    for round in 0..5 {
        let (forge_text, agenfold_text) = (
            format!("review for forge, round {round}"),
            format!("review for agenfold, round {round}"),
        );
        let (to_forge, to_agenfold) = tokio::join!(
            super::send_line(&forge.name, &forge_text),
            super::send_line(agenfold, &agenfold_text),
        );
        // the stand-in logs only a submit with its text, numbered by its Enters so far
        let want_forge = format!(": {forge_text}\n");
        let forge_saw = logged(&forge, &want_forge, Duration::from_secs(5));
        let want_agenfold = format!(": {agenfold_text}\n");
        let deadline = Instant::now() + Duration::from_secs(5);
        let agenfold_saw = loop {
            let seen = std::fs::read_to_string(&agenfold_log).unwrap_or_default();
            if seen.contains(&want_agenfold) || Instant::now() >= deadline {
                break seen;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(
            !forge_saw.contains("agenfold") && !agenfold_saw.contains("for forge"),
            "round {round}: a send to one project's master reached the other's pane; {} logged {forge_saw:?} and {agenfold} logged {agenfold_saw:?}",
            forge.name
        );
        assert!(
            to_forge.is_ok() && to_agenfold.is_ok(),
            "round {round}: a send was not typed (forge: {to_forge:?}, agenfold: {to_agenfold:?})"
        );
        assert!(
            forge_saw.contains(&want_forge) && agenfold_saw.contains(&want_agenfold),
            "round {round}: a send said typed was not submitted; {} logged {forge_saw:?} and {agenfold} logged {agenfold_saw:?}",
            forge.name
        );
    }
}
