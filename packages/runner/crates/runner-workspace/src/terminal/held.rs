//! A runner wake already sitting unsent at a master's prompt (ISS-1081 round 2).
//!
//! `send_line` refuses a composer that holds text, since Enter would send that
//! text glued to the new message. Round 1 stopped a wake this box types from
//! being left there; it did nothing for one already there — left by the build
//! before a restart, typed at a pane still starting — and every nudge after
//! was refused and logged while the master sat idle until a person pressed
//! Enter (sidcorp-mail, catalog-api, 2026-11-07). So a composer the refusal
//! names is read again: a runner wake held at an idle prompt is submitted, and
//! anything else held keeps the refusal.
//!
//! Which held text is a runner wake is [`is_wake`]; which prompt is idle is
//! the caller's reading of its hooks together with [`PaneRead::turn_running`].

use super::{pane_target, submit, typing, NotTyped};
use crate::composer::{self, Composer};

/// The line every wake this box types into a master's pane ends on: the brief
/// a placed pane is handed and each nudge core composes. It is the runner's
/// own mark, so a held text is told for a wake without reading its prose, and
/// it is the last line because a tall draft keeps its end in view while its
/// head scrolls out of the composer.
pub const WAKE_MARK: &str = "[forge-runner wake]";

/// How the standing prompt every master brief opens with begins
/// (`master/mod.rs:standing_prompt`): a held text opening with it is a brief
/// typed by a build from before [`WAKE_MARK`], which carries no mark.
pub const STANDING_OPENING: &str = "Use the `forge-master` skill.";

/// `text` as a wake: ending on [`WAKE_MARK`].
pub fn marked(text: &str) -> String {
    format!("{}\n\n{WAKE_MARK}", text.trim_end())
}

/// Whether the text a master's composer holds is a runner wake.
///
/// One of three, and nothing else:
/// - its last line is [`WAKE_MARK`], so nothing was typed after the wake;
/// - it opens with [`STANDING_OPENING`], a brief from a build before the mark;
/// - `left` (this box typed a wake into this pane and has not seen it go),
///   and all it holds is Claude Code's collapsed paste placeholders
///   (`[Pasted text #1 +20 lines]`), which is how a wake typed as a paste
///   shows and hides the mark inside it.
///
/// A person's or another agent's draft is none of these.
pub fn is_wake(held: &str, left: bool) -> bool {
    let last = held.lines().rev().map(str::trim).find(|l| !l.is_empty());
    if last == Some(WAKE_MARK) {
        return true;
    }
    if held.trim_start().starts_with(STANDING_OPENING) {
        return true;
    }
    left && only_pastes(held)
}

/// Whether `held` is one or more collapsed paste placeholders and nothing else.
fn only_pastes(held: &str) -> bool {
    let mut rest = held.trim();
    let mut any = false;
    while !rest.is_empty() {
        let Some(after) = rest.strip_prefix("[Pasted text #") else {
            return false;
        };
        let Some(end) = after.find(']') else {
            return false;
        };
        let inside = &after[..end];
        let (number, lines) = match inside.split_once(" +") {
            Some((n, l)) => (n, l.strip_suffix(" lines").or(l.strip_suffix(" line"))),
            None => (inside, Some("1")),
        };
        let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
        if !digits(number) || !lines.is_some_and(digits) {
            return false;
        }
        any = true;
        rest = after[end + 1..].trim_start();
    }
    any
}

/// What a pane's prompt shows, off one capture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneRead {
    pub composer: Composer,
    /// Whether the pane draws a turn running over its composer
    /// ([`composer::turn_running`]).
    pub turn_running: bool,
}

/// Read `name`'s prompt and whether a turn is drawn running over it.
pub async fn pane_read(name: &str) -> PaneRead {
    read_target(&pane_target(name)).await
}

async fn read_target(target: &str) -> PaneRead {
    match typing::capture(target).await {
        Some(drawn) => PaneRead {
            composer: composer::read(&drawn),
            turn_running: composer::turn_running(&drawn),
        },
        None => PaneRead {
            composer: Composer::Unrecognised,
            turn_running: false,
        },
    }
}

/// What [`submit_held_wake`] found at the prompt, and did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Held {
    /// The prompt holds no text.
    Nothing,
    /// It holds text that is not a runner wake; nothing was pressed.
    NotAWake(String),
    /// It holds a runner wake and a turn is running, so it waits for the turn
    /// to end; nothing was pressed.
    Busy(String),
    /// It held a runner wake at an idle prompt, and Enter submitted it.
    Submitted(String),
}

/// Submit the runner wake `name`'s prompt holds, where it holds one and no
/// turn runs.
///
/// `left` is whether this box typed a wake into this pane that it has not
/// seen go ([`is_wake`]); `turn_by_hooks` is whether the pane's hooks report a
/// turn running, which the pane's own drawing is read beside. One call is one
/// submit attempt; a wake still held after it is `NotTyped::Unsubmitted`
/// naming the pane, and a held text that is not a wake is never pressed.
pub async fn submit_held_wake(
    name: &str,
    left: bool,
    turn_by_hooks: bool,
) -> Result<Held, NotTyped> {
    let target = pane_target(name);
    let read = read_target(&target).await;
    let Composer::Holds(text) = read.composer else {
        return Ok(Held::Nothing);
    };
    if !is_wake(&text, left) {
        return Ok(Held::NotAWake(text));
    }
    if read.turn_running || turn_by_hooks {
        return Ok(Held::Busy(text));
    }
    submit::held(name, &target).await?;
    Ok(Held::Submitted(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_text_ending_on_the_mark_is_a_wake_and_one_typed_after_it_is_not() {
        let wake = marked("Pass. Run the wave.\n");
        assert!(wake.ends_with("\n\n[forge-runner wake]"), "{wake}");
        assert!(is_wake(&wake, false));
        assert!(is_wake(&format!("{wake}\n  \n"), false));
        assert!(
            !is_wake(&format!("{wake}\nand a person's line"), false),
            "text typed after the wake would be sent with it"
        );
    }

    #[test]
    fn a_brief_from_before_the_mark_is_told_by_its_opening() {
        assert!(is_wake(
            "Use the `forge-master` skill. You are the resident master for project `p`",
            false
        ));
        assert!(!is_wake("Please use the `forge-master` skill.", false));
    }

    #[test]
    fn a_collapsed_paste_is_a_wake_only_where_this_box_left_one() {
        let pasted = "[Pasted text #1 +20 lines]";
        assert!(is_wake(pasted, true));
        assert!(
            !is_wake(pasted, false),
            "a paste this box never typed was taken for its wake"
        );
        assert!(is_wake("[Pasted text #1 +20 lines] [Pasted text #2]", true));
        assert!(!is_wake("[Pasted text #1 +20 lines] and a note", true));
        assert!(!is_wake("[Pasted text #x +20 lines]", true));
        assert!(!is_wake("[Image #1]", true));
    }

    #[test]
    fn a_draft_is_never_a_wake() {
        for draft in [
            "fix the login page",
            "",
            "Pass.",
            "[forge-runner wake] then more",
        ] {
            assert!(!is_wake(draft, true), "{draft:?}");
        }
    }
}
