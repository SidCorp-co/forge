//! A wake typed into a pane whose program reads its input the way Claude Code does, on a tmux
//! server of the test's own (ISS-1081).
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

use super::held;
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

/// What one nudge does at `pane`, as `master/nudge.rs:nudge_master` composes it: the wake typed,
/// and where the prompt refuses it for text it holds, that text read and submitted if it is a
/// runner wake at an idle prompt.
async fn nudge(
    pane: &Pane,
    left: bool,
    turn_by_hooks: bool,
) -> (
    Result<super::Prompt, super::NotTyped>,
    Option<Result<held::Held, super::NotTyped>>,
) {
    let typed = super::send_line(&pane.name, &held::marked("Pass. Run the wave.")).await;
    let again = match &typed {
        Err(super::NotTyped::Refused(_)) => {
            Some(held::submit_held_wake(&pane.name, left, turn_by_hooks).await)
        }
        _ => None,
    };
    (typed, again)
}

/// Whatever the stand-in logged within `within`: for a test asserting nothing was pressed.
fn settled(pane: &Pane, within: Duration) -> String {
    std::thread::sleep(within);
    std::fs::read_to_string(&pane.log).unwrap_or_default()
}

/// ISS-1081 round 2: sidcorp-mail and catalog-api held a wake from before the restart, and each
/// nudge after it was refused and logged while the master sat idle until a person pressed Enter.
#[tokio::test(flavor = "current_thread")]
async fn a_runner_wake_already_held_at_an_idle_prompt_is_submitted_by_the_next_nudge() {
    let test = "a_runner_wake_already_held_at_an_idle_prompt_is_submitted_by_the_next_nudge";
    let Some(pane) = stand_in_holding(test, Some(&held::marked(&wake())), "") else {
        return;
    };
    drawn(&pane).await;
    let (typed, again) = nudge(&pane, false, false).await;
    let log = logged(&pane, "SUBMITTED", Duration::from_secs(5));
    assert!(
        matches!(typed, Err(super::NotTyped::Refused(_))),
        "the nudge typed over a held wake: {typed:?}"
    );
    assert!(
        matches!(again, Some(Ok(held::Held::Submitted(_)))),
        "the held wake was not submitted (answered {again:?}); the stand-in logged: {log:?}"
    );
    assert!(
        log.contains("SUBMITTED on enter 1: Line 1 of the wake"),
        "the stand-in logged: {log:?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_held_wake_behind_a_running_turn_is_left_alone() {
    let test = "a_held_wake_behind_a_running_turn_is_left_alone";
    let Some(pane) = stand_in_holding(test, Some(&held::marked(&wake())), "--busy") else {
        return;
    };
    drawn(&pane).await;
    let read = held::pane_read(&pane.name).await;
    assert!(
        read.turn_running,
        "the stand-in's spinner was not read as a turn: {read:?}"
    );
    let (_, again) = nudge(&pane, false, false).await;
    let log = settled(&pane, Duration::from_secs(1));
    assert!(
        matches!(again, Some(Ok(held::Held::Busy(_)))),
        "a wake behind a running turn was answered {again:?}"
    );
    assert_eq!(log, "", "Enter was pressed at a busy pane");
}

#[tokio::test(flavor = "current_thread")]
async fn a_held_wake_whose_hooks_report_a_turn_is_left_alone() {
    let test = "a_held_wake_whose_hooks_report_a_turn_is_left_alone";
    // The pane draws no turn, and its hooks report one.
    let Some(pane) = stand_in_holding(test, Some(&held::marked(&wake())), "") else {
        return;
    };
    drawn(&pane).await;
    let (_, again) = nudge(&pane, false, true).await;
    let log = settled(&pane, Duration::from_secs(1));
    assert!(matches!(again, Some(Ok(held::Held::Busy(_)))), "{again:?}");
    assert_eq!(log, "", "Enter was pressed while the hooks report a turn");
}

#[tokio::test(flavor = "current_thread")]
async fn a_held_draft_that_is_no_wake_is_refused_and_never_submitted() {
    let test = "a_held_draft_that_is_no_wake_is_refused_and_never_submitted";
    let draft = "fix the login page\nand tell me when it is done";
    let Some(pane) = stand_in_holding(test, Some(draft), "") else {
        return;
    };
    drawn(&pane).await;
    let (typed, again) = nudge(&pane, true, false).await;
    let log = settled(&pane, Duration::from_secs(1));
    assert!(
        matches!(typed, Err(super::NotTyped::Refused(_))),
        "{typed:?}"
    );
    assert!(
        matches!(again, Some(Ok(held::Held::NotAWake(_)))),
        "a person's draft was answered {again:?}"
    );
    assert_eq!(log, "", "Enter was pressed at a person's draft");
}

#[tokio::test(flavor = "current_thread")]
async fn a_held_wake_whose_enter_is_always_swallowed_is_said_unsent_naming_the_pane() {
    let test = "a_held_wake_whose_enter_is_always_swallowed_is_said_unsent_naming_the_pane";
    let Some(pane) = stand_in_holding(test, Some(&held::marked(&wake())), "--never") else {
        return;
    };
    drawn(&pane).await;
    let (_, again) = nudge(&pane, false, false).await;
    let log = logged(&pane, "swallowed 3", Duration::from_secs(5));
    match again {
        Some(Err(super::NotTyped::Unsubmitted(why))) => assert!(
            why.starts_with(&format!("{}: ", pane.name)) && why.contains("unsent"),
            "{why}"
        ),
        other => panic!("a held wake that never submitted was answered {other:?}; log {log:?}"),
    }
    assert!(
        !log.contains("SUBMITTED") && !log.contains("swallowed 4"),
        "{log:?}"
    );
}

/// A wake typed as a paste shows collapsed, its mark hidden: it is this box's only where this box
/// noted leaving it there.
#[tokio::test(flavor = "current_thread")]
async fn a_collapsed_paste_is_submitted_only_where_this_box_left_its_wake() {
    let test = "a_collapsed_paste_is_submitted_only_where_this_box_left_its_wake";
    let Some(pane) = stand_in(test, "--swallow 3") else {
        return;
    };
    drawn(&pane).await;
    let typed = super::send_line(&pane.name, &held::marked(&wake())).await;
    assert!(
        matches!(typed, Err(super::NotTyped::Unsubmitted(_))),
        "{typed:?}"
    );
    let (_, unknown) = nudge(&pane, false, false).await;
    assert!(
        matches!(unknown, Some(Ok(held::Held::NotAWake(_)))),
        "a paste this box did not note was submitted: {unknown:?}"
    );
    let (_, again) = nudge(&pane, true, false).await;
    let log = logged(&pane, "SUBMITTED", Duration::from_secs(5));
    assert!(
        matches!(again, Some(Ok(held::Held::Submitted(_)))),
        "{again:?}; log {log:?}"
    );
    assert!(log.contains("SUBMITTED on enter 4"), "{log:?}");
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
    let (typed, _) = nudge(&pane, false, false).await;
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
    let (typed, again) = nudge(&pane, true, false).await;
    let log = settled(&pane, Duration::from_secs(1));
    assert_eq!(
        log, "",
        "Enter was pressed at a composer holding only a suggestion"
    );
    assert!(
        matches!(typed, Err(super::NotTyped::Unsubmitted(_))),
        "{typed:?}"
    );
    assert!(again.is_none(), "{again:?}");
    let held = held::submit_held_wake(&pane.name, true, false).await;
    assert_eq!(held.map_err(|e| e.to_string()), Ok(held::Held::Nothing));
    assert_eq!(settled(&pane, Duration::from_millis(500)), "");
}
