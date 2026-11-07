//! Typing a message into a pane and seeing it submitted: the read before the
//! paste that refuses a draft or a choice list, the paste itself, and the wait
//! for a pane just started to draw its composer. The read-back after the paste
//! is `submit.rs`.

use std::process::Stdio;
use std::time::Duration;

use runner_platform::error::Error;

use super::{alive, has_session, pane_target, socket_args, submit, tmux, tmux_command, Presence};
use crate::composer;

/// How long a pane just started may take to draw its composer before its
/// brief is typed regardless, and how often it is looked at meanwhile.
pub const PANE_READY_WITHIN: Duration = Duration::from_secs(60);
const PANE_READY_POLL: Duration = Duration::from_millis(250);

/// Hand a pane just started its brief, once its program draws something to
/// take it.
///
/// This used to sleep five seconds and type. A resumed Claude Code takes
/// longer than that to draw its composer, and until it makes its tty raw what
/// is typed lands in the line discipline, which turns Enter's CR into an LF:
/// a newline in the draft, not a submit. Every master resumed on 2026-11-07
/// was typed at blind, and five sat with their brief unsent until somebody
/// pressed Enter (ISS-1081). So the pane is read until it shows a composer or
/// a dialog, and only then typed into. One that shows neither within
/// [`PANE_READY_WITHIN`] is typed into regardless and said so, since a brief
/// never typed is lost; `send_line` reads that pane back once its composer
/// shows the message, and answers `Unread` where it never does.
pub async fn brief_new_pane(name: &str, text: &str) -> std::result::Result<Prompt, NotTyped> {
    if !alive(name).await {
        return Err(NotTyped::Gone(name.to_string()));
    }
    let target = pane_target(name);
    let polls = (PANE_READY_WITHIN.as_millis() / PANE_READY_POLL.as_millis()) as usize;
    let drawn = submit::until_read(
        &mut || read_prompt(&target),
        |c| *c != composer::Composer::Unrecognised,
        PANE_READY_POLL,
        polls,
    )
    .await;
    if drawn.is_none() {
        tracing::warn!(
            "[terminal] {name}: drew no Claude Code composer within {PANE_READY_WITHIN:?} of \
starting, so its brief is typed into a program that may not be reading yet"
        );
    }
    send_line(name, text).await
}

/// What `send_line` knew about the prompt it typed at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prompt {
    /// A Claude Code composer, read empty before the paste.
    Empty,
    /// No Claude Code composer could be read, so nothing confirmed the prompt
    /// was empty. The text was typed anyway, as it always was before a pane
    /// could be read. A choice list is no longer one of these: it is refused
    /// before the paste and so never reaches a `Prompt` at all.
    Unread,
}

/// Why `send_line` did not deliver, for a caller whose answer to the world
/// turns on which of these it was.
///
/// Every one of these used to be an `Error::Other(String)`, and
/// `daemon/inbox.rs` folded all of them into one bit and told core `gone` —
/// the ack minted for a session that ended — about a pane it had just read
/// alive (ISS-1265). The sentences are unchanged; what is new is that a caller
/// can tell them apart without reading them, which is the same reason
/// `Error::Unauthorized` is a variant rather than a string.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NotTyped {
    /// tmux answered, in its own words, that it holds no session by this name.
    /// The only one of these that is a session having ended.
    #[error("no session named {0}")]
    Gone(String),
    /// The pane answered alive and was read, and what is drawn on it refuses
    /// the message: a draft at the composer, or a choice list.
    #[error("{0}")]
    Refused(String),
    /// tmux could not be asked whether the session is there, or one of the
    /// calls that type the message broke. Neither establishes an ending.
    #[error("{0}")]
    Failed(String),
    /// The message was typed and every Enter was taken, and the composer read
    /// back still holds it: it sits at the prompt unsent. Not a delivery, and
    /// not an ending — the pane is alive and holding the text.
    #[error("{0}")]
    Unsubmitted(String),
}

impl From<NotTyped> for Error {
    fn from(why: NotTyped) -> Self {
        Error::Other(why.to_string())
    }
}

/// How much scrollback the prompt read takes, so a draft taller than the
/// pane is still read from its first line.
const PROMPT_READ_LINES: &str = "-500";

pub(super) async fn read_prompt(target: &str) -> composer::Composer {
    let args = [
        "capture-pane",
        "-p",
        "-e",
        "-S",
        PROMPT_READ_LINES,
        "-t",
        target,
    ];
    match tmux(&args).await {
        Ok(out) if out.status.success() => composer::read(&String::from_utf8_lossy(&out.stdout)),
        _ => composer::Composer::Unrecognised,
    }
}

/// What `name`'s pane shows at its prompt: a composer, empty or holding text,
/// a choice list, or nothing readable. A choice list is a dialog only a person
/// answers: Enter there decides it, so no nudge reaches the pane.
pub async fn pane_prompt(name: &str) -> composer::Composer {
    read_prompt(&pane_target(name)).await
}

/// Type `text` into a pane and submit it.
///
/// Enter submits the whole composer, so a composer already holding text is
/// refused, quoting it: typing there would send that text as part of this one.
/// A pane showing a choice list is refused for the mirror reason: there Enter
/// is a decision on the highlighted option and the pasted text is dropped, so
/// a message that cannot be delivered is said not to have been (ISS-1266).
/// The read comes a few milliseconds before the paste, and tmux has no lock
/// over a pane's input, so a keystroke landing in between is not seen. After
/// the paste the composer is read back, and a message it still holds is
/// pressed again and, failing that, answered `Unsubmitted` rather than typed.
pub async fn send_line(name: &str, text: &str) -> std::result::Result<Prompt, NotTyped> {
    match has_session(name).await {
        Presence::Present => {}
        Presence::Absent => return Err(NotTyped::Gone(name.to_string())),
        Presence::Unaskable => {
            return Err(NotTyped::Failed(format!(
                "{name}: nothing was typed — tmux could not be asked whether this session is there, so whether it is running is unknown rather than settled. Ask again once tmux answers."
            )))
        }
    }
    let target = pane_target(name);
    let prompt = match read_prompt(&target).await {
        composer::Composer::Empty => Prompt::Empty,
        composer::Composer::Holds(found) => {
            return Err(NotTyped::Refused(format!(
                "{name}: nothing was typed — its prompt already holds unsent text, and Enter \
would submit that text as part of this message. At the prompt: \u{ab}{}\u{bb}. Clear it or \
submit it at the pane, then send again.",
                composer::excerpt(&found, 400)
            )));
        }
        composer::Composer::Menu { highlighted } => {
            return Err(NotTyped::Refused(format!(
                "{name}: nothing was typed — its pane is showing a choice list with \u{ab}{}\u{bb} \
highlighted, and Enter there decides that choice instead of sending a message. Answer it at the \
pane, or wait for whatever raised it to close, then send again.",
                composer::excerpt(&highlighted, 200)
            )));
        }
        composer::Composer::Unrecognised => {
            tracing::warn!(
                "[terminal] {name}: no Claude Code composer could be read on this pane, so \
nothing confirmed its prompt was empty before typing"
            );
            Prompt::Unread
        }
    };
    let buffer = format!("forge-{}", std::process::id());

    let mut load = socket_args();
    load.extend(
        ["load-buffer", "-b", &buffer, "-"]
            .iter()
            .map(|a| (*a).to_string()),
    );
    let mut child = tmux_command()
        .args(&load)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| NotTyped::Failed(format!("tmux load-buffer: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|e| NotTyped::Failed(format!("tmux load-buffer write: {e}")))?;
        let _ = stdin.shutdown().await;
    }
    let status = child
        .wait()
        .await
        .map_err(|e| NotTyped::Failed(format!("tmux load-buffer: {e}")))?;
    if !status.success() {
        return Err(NotTyped::Failed(format!(
            "tmux load-buffer {name}: {status}"
        )));
    }

    let out = tmux(&["paste-buffer", "-p", "-d", "-b", &buffer, "-t", &target])
        .await
        .map_err(|e| NotTyped::Failed(e.to_string()))?;
    if !out.status.success() {
        return Err(NotTyped::Failed(format!(
            "tmux paste-buffer {name}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    submit::after_paste(name, &target, prompt).await?;
    Ok(prompt)
}
