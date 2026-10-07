//! Pressing Enter after a paste, and reading back that it submitted.
//!
//! Enter sent the instant a paste lands can be taken by Claude Code as more of
//! the paste, so the message stays in the composer unsent while tmux reported
//! both keystrokes accepted. Seen on dev 2026-10-07: a message sat typed at a
//! pane's prompt for ten minutes and the box had told core `delivered`. So the
//! paste settles before Enter, and the composer is read back: a message still
//! held there is pressed again, and one that never leaves is said, never
//! called delivered.

use std::future::Future;
use std::time::Duration;

use super::{read_prompt, tmux, NotTyped, Prompt};
use crate::composer::{self, Composer};

/// Submit what `send_line` just pasted into `name`. Only a composer read empty before the paste
/// can say the text it holds now is this message, so a pane read `Unread` gets one Enter and no
/// read-back.
pub(super) async fn after_paste(name: &str, target: &str, prompt: Prompt) -> Result<(), NotTyped> {
    let readable = prompt == Prompt::Empty;
    let enters = if readable { ENTERS } else { 1 };
    until_cleared(
        || press_enter(name, target),
        || async {
            if readable {
                read_prompt(target).await
            } else {
                Composer::Unrecognised
            }
        },
        SETTLE,
        enters,
    )
    .await
    .map_err(|why| match why {
        NotSubmitted::EnterFailed(e) => NotTyped::Failed(e),
        NotSubmitted::StillHeld(held) => NotTyped::Unsubmitted(format!(
            "{name}: the message was typed and Enter pressed {enters} times, and its prompt still \
holds it unsent: \u{ab}{held}\u{bb}. It was not delivered; submit or clear it at the pane."
        )),
    })
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
