//! Pressing Enter after a paste, and reading back that it submitted.
//!
//! Enter sent the instant a paste lands can be taken by Claude Code as more of
//! the paste, so the message stays in the composer unsent while tmux reported
//! both keystrokes accepted. Seen on dev 2026-10-07: a message sat typed at a
//! pane's prompt for ten minutes and the box had told core `delivered`. So
//! Enter waits until the composer shows the paste, and the composer is read
//! back: a message still held there is pressed again, and one that never
//! leaves is said, never called delivered.
//!
//! A pane whose composer could not be read before the paste used to get one
//! Enter and no read-back. That is a pane still starting, and what is typed
//! there lands in a tty the program has not yet made raw: the line discipline
//! turns Enter's CR into an LF, which Claude Code reads as a newline in the
//! draft (ISS-1081, seen five times on 2026-11-07). So such a pane is read
//! back too, once its composer shows the message.
//!
//! Enter is pressed only at a composer read holding typed text. Claude Code
//! draws a prompt suggestion as dim ghost text in an empty composer, and Enter
//! there sends the suggestion: a master would act on an instruction the model
//! invented. `composer::read` leaves dim text out (`composer.rs:framed` reads
//! each line's `visible` part), so such a composer reads `Empty`; a paste that
//! never shows used to be pressed regardless, which is that Enter. It is now
//! said unsent instead (ISS-1081 round 2).

use std::future::Future;
use std::time::Duration;

use super::{read_prompt, tmux, NotTyped};
use crate::composer::{self, Composer};

/// Submit what `send_line` just pasted into `name`.
///
/// Enter waits until the composer shows the paste, and goes as a key event of
/// its own. A composer read empty before the paste holds only this message,
/// and so does one that could not be read before and shows text now: nothing
/// was there to read. Either is read back after each Enter. A pane whose
/// composer never shows the paste gets no Enter at all and is said unsent:
/// what it shows, if anything, is not this message, and may be a suggestion.
pub(super) async fn after_paste(name: &str, target: &str) -> Result<(), NotTyped> {
    submit(
        name,
        || press_enter(name, target),
        || read_prompt(target),
        Pace::LIVE,
    )
    .await
}

/// Submit the wake `name`'s composer was just read holding (ISS-1081 round 2):
/// Enter and a read-back, pressed again while it still holds text, as
/// [`after_paste`] does once a paste shows. One call is one attempt, at most
/// [`ENTERS`] presses, and a wake still held after them is said unsent.
pub(super) async fn held(name: &str, target: &str) -> Result<(), NotTyped> {
    until_cleared(
        || press_enter(name, target),
        || read_prompt(target),
        SETTLE,
        ENTERS,
    )
    .await
    .map_err(|why| match why {
        NotSubmitted::EnterFailed(e) => NotTyped::Failed(e),
        NotSubmitted::StillHeld(held) => NotTyped::Unsubmitted(format!(
            "{name}: a runner wake sat unsent at its prompt and Enter was pressed {ENTERS} times, \
and the prompt still holds it: \u{ab}{held}\u{bb}. It was not delivered; submit or clear it at \
the pane."
        )),
    })
}

/// How a submit is paced: the poll for the paste to show, and the settle
/// either side of each Enter.
#[derive(Debug, Clone, Copy)]
struct Pace {
    poll: Duration,
    polls: usize,
    settle: Duration,
}

impl Pace {
    /// The paste is looked for every 50 ms for five seconds.
    const LIVE: Pace = Pace {
        poll: Duration::from_millis(50),
        polls: 100,
        settle: SETTLE,
    };
}

async fn submit<E, EF, R, RF>(name: &str, enter: E, mut read: R, pace: Pace) -> Result<(), NotTyped>
where
    E: FnMut() -> EF,
    EF: Future<Output = Result<(), String>>,
    R: FnMut() -> RF,
    RF: Future<Output = Composer>,
{
    let shown = until_read(
        &mut read,
        |c| matches!(c, Composer::Holds(_)),
        pace.poll,
        pace.polls,
    )
    .await
    .is_some();
    if !shown {
        return Err(NotTyped::Unsubmitted(format!(
            "{name}: the message was pasted and its prompt never showed it within {:?}, so no \
Enter was pressed — Enter at a composer showing no typed text would send Claude Code's dim prompt \
suggestion instead. It was not delivered; submit or clear it at the pane.",
            pace.poll * pace.polls as u32
        )));
    }
    until_cleared(enter, read, pace.settle, ENTERS)
        .await
        .map_err(|why| match why {
            NotSubmitted::EnterFailed(e) => NotTyped::Failed(e),
            NotSubmitted::StillHeld(held) => NotTyped::Unsubmitted(format!(
                "{name}: the message was typed and Enter pressed {ENTERS} times, and its prompt \
still holds it unsent: \u{ab}{held}\u{bb}. It was not delivered; submit or clear it at the pane."
            )),
        })
}

/// Read the composer every `poll` until `want` holds of what it shows, at
/// most `polls` times; what it showed then, or `None`.
pub(super) async fn until_read<R, RF>(
    read: &mut R,
    want: impl Fn(&Composer) -> bool,
    poll: Duration,
    polls: usize,
) -> Option<Composer>
where
    R: FnMut() -> RF,
    RF: Future<Output = Composer>,
{
    for i in 0..polls.max(1) {
        if i > 0 {
            tokio::time::sleep(poll).await;
        }
        let seen = read().await;
        if want(&seen) {
            return Some(seen);
        }
    }
    None
}

async fn press_enter(name: &str, target: &str) -> Result<(), String> {
    let out = tmux(&["send-keys", "-t", target, "Enter"])
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "tmux send-keys {name}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// How long a paste settles before Enter, and Enter before the read-back.
const SETTLE: Duration = Duration::from_millis(200);

/// How many times Enter is pressed at a composer still holding the message.
const ENTERS: usize = 3;

/// Why a pasted message was not seen to submit.
#[derive(Debug, Clone, PartialEq, Eq)]
enum NotSubmitted {
    /// tmux refused or could not run the Enter keystroke.
    EnterFailed(String),
    /// Every Enter was taken and the composer still holds this text.
    StillHeld(String),
}

/// Press Enter until the composer no longer holds the message.
///
/// `enter` sends one Enter; `read` reads the composer. A read that shows no
/// held text — empty, a turn drawn over it, or nothing recognisable — is the
/// message gone from the input, which is all a pane can show of a submit.
async fn until_cleared<E, EF, R, RF>(
    mut enter: E,
    mut read: R,
    settle: Duration,
    enters: usize,
) -> Result<(), NotSubmitted>
where
    E: FnMut() -> EF,
    EF: Future<Output = Result<(), String>>,
    R: FnMut() -> RF,
    RF: Future<Output = Composer>,
{
    let mut held = String::new();
    for _ in 0..enters.max(1) {
        tokio::time::sleep(settle).await;
        enter().await.map_err(NotSubmitted::EnterFailed)?;
        tokio::time::sleep(settle).await;
        match read().await {
            Composer::Holds(text) => held = text,
            _ => return Ok(()),
        }
    }
    Err(NotSubmitted::StillHeld(composer::excerpt(&held, 400)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// A composer that keeps the message until the `clears_on`th Enter.
    async fn run(clears_on: usize, enters: usize) -> (Result<(), NotSubmitted>, usize) {
        let pressed = Cell::new(0usize);
        let out = until_cleared(
            || {
                pressed.set(pressed.get() + 1);
                async { Ok(()) }
            },
            || {
                let now = if pressed.get() >= clears_on {
                    Composer::Empty
                } else {
                    Composer::Holds("[Pasted text #1 +3 lines]".into())
                };
                async move { now }
            },
            Duration::ZERO,
            enters,
        )
        .await;
        (out, pressed.get())
    }

    #[tokio::test]
    async fn a_paste_that_swallowed_the_first_enter_is_pressed_again_and_submits() {
        let (out, pressed) = run(2, ENTERS).await;
        assert_eq!(out, Ok(()), "the message was left at the prompt");
        assert_eq!(pressed, 2, "Enter was pressed past a cleared composer");
    }

    #[tokio::test]
    async fn a_composer_that_clears_on_the_first_enter_takes_one() {
        assert_eq!(run(1, ENTERS).await, (Ok(()), 1));
    }

    #[tokio::test]
    async fn a_message_still_held_after_every_enter_is_said_not_submitted() {
        let (out, pressed) = run(usize::MAX, ENTERS).await;
        assert_eq!(
            out,
            Err(NotSubmitted::StillHeld("[Pasted text #1 +3 lines]".into()))
        );
        assert_eq!(pressed, ENTERS);
    }

    /// What `submit` did at a composer that shows the paste on its `shows_on`th
    /// read and keeps it until the `clears_on`th Enter: the answer, and each
    /// event in order, `E` an Enter and `H`/`-` a read holding the message or not.
    async fn submitted(
        shows_on: Option<usize>,
        clears_on: usize,
    ) -> (Result<(), NotTyped>, String) {
        let events = std::cell::RefCell::new(String::new());
        let (reads, pressed) = (Cell::new(0usize), Cell::new(0usize));
        let out = submit(
            "forge-master-p",
            || {
                pressed.set(pressed.get() + 1);
                events.borrow_mut().push('E');
                async { Ok(()) }
            },
            || {
                reads.set(reads.get() + 1);
                let shown = shows_on.is_some_and(|n| reads.get() >= n);
                let now = if shown && pressed.get() < clears_on {
                    Composer::Holds("[Pasted text #1 +20 lines]".into())
                } else if shows_on.is_some() {
                    Composer::Empty
                } else {
                    Composer::Unrecognised
                };
                events
                    .borrow_mut()
                    .push(if matches!(now, Composer::Holds(_)) {
                        'H'
                    } else {
                        '-'
                    });
                async move { now }
            },
            Pace {
                poll: Duration::ZERO,
                polls: 5,
                settle: Duration::ZERO,
            },
        )
        .await;
        (out, events.into_inner())
    }

    #[tokio::test]
    async fn enter_waits_until_the_composer_shows_the_paste() {
        let (out, events) = submitted(Some(3), 1).await;
        assert_eq!(out.map_err(|e| e.to_string()), Ok(()));
        assert_eq!(
            events, "--HE-",
            "Enter was pressed before the composer showed the paste, or never"
        );
    }

    /// ISS-1081: a pane read before the paste as no composer at all was given
    /// one Enter and never read back, and its wake sat unsent.
    #[tokio::test]
    async fn a_pane_unread_before_the_paste_that_shows_it_after_is_read_back_and_pressed_again() {
        let (out, events) = submitted(Some(1), 2).await;
        assert_eq!(out.map_err(|e| e.to_string()), Ok(()));
        assert_eq!(
            events, "HEHE-",
            "the unread pane's wake was not pressed again"
        );
    }

    /// ISS-1081 round 2: a composer that never shows the paste was pressed
    /// once regardless, and an empty one showing Claude Code's dim prompt
    /// suggestion sends the suggestion on Enter.
    #[tokio::test]
    async fn a_paste_that_never_shows_gets_no_enter_and_is_said_unsent() {
        for shows in [None, Some(usize::MAX)] {
            let (out, events) = submitted(shows, 1).await;
            assert_eq!(
                events, "-----",
                "Enter was pressed at a composer showing no typed text"
            );
            match out {
                Err(NotTyped::Unsubmitted(why)) => assert!(
                    why.starts_with("forge-master-p: ") && why.contains("no Enter"),
                    "{why}"
                ),
                other => panic!("a paste that never showed was answered {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn a_wake_still_held_after_every_enter_is_said_unsent_naming_the_pane() {
        let (out, events) = submitted(Some(1), usize::MAX).await;
        assert_eq!(events, "HEHEHEH", "the Enters were not bounded at {ENTERS}");
        match out {
            Err(NotTyped::Unsubmitted(why)) => assert!(
                why.starts_with("forge-master-p: ") && why.contains("unsent"),
                "{why}"
            ),
            other => panic!("a wake left at the prompt was answered {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_read_for_a_paste_is_bounded() {
        let reads = Cell::new(0usize);
        let mut read = || {
            reads.set(reads.get() + 1);
            async { Composer::Empty }
        };
        let seen = until_read(&mut read, |c| *c != Composer::Empty, Duration::ZERO, 4).await;
        assert_eq!((seen, reads.get()), (None, 4));
    }

    #[tokio::test]
    async fn an_enter_tmux_refused_is_a_failure_not_a_submit() {
        let out = until_cleared(
            || async { Err("send-keys: no server".to_string()) },
            || async { Composer::Empty },
            Duration::ZERO,
            ENTERS,
        )
        .await;
        assert_eq!(
            out,
            Err(NotSubmitted::EnterFailed("send-keys: no server".into()))
        );
    }
}
