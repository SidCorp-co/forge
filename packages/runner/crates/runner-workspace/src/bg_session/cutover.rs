//! Moving a master from its tmux pane to a background session (ISS-1304).
//!
//! A box whose masters ran in tmux panes (the runner before ISS-1268) still has them running when
//! this runner takes over, each holding its conversation. `claude --bg --resume` of a conversation
//! another process holds does not continue it: Claude Code starts a copy, and the copy acts beside
//! the live master. So no resume is started while a session holds the conversation. The master's
//! own pane is ended only while it is idle, and its conversation is resumed as a background
//! session in the same sweep; a busy pane stays in tmux and the next sweep reads it again.
//!
//! Idle is read where Claude Code says it and nowhere weaker: the pane's session as `claude agents
//! --json` lists it, `status` exactly `idle` (its live process: no turn in flight, no permission
//! prompt), and then the caller's own reading of the work the conversation holds beyond its turn
//! (a background child, a child run). `busy`, `waiting`, a status the roster does not send, a
//! session the roster does not list, or a read that fails all hold the pane.

use std::time::Duration;

use super::roster::{self, BgSession};

/// How long an ended pane's session may take to leave the roster before the resume is refused.
const FREED_WITHIN: Duration = Duration::from_secs(20);

/// What holds a conversation beyond its own turn, as the caller reads it: `None` where nothing.
pub type Work<'a> = dyn Fn() -> Option<String> + Sync + 'a;

/// What this sweep does before it starts or resumes the master named `name`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Nothing holds the conversation and no pane runs for the master: start it.
    Clear,
    /// The master's own tmux pane holds the conversation and is idle: end the pane, then resume.
    EndPane,
    /// The master stays in its tmux pane this sweep, and why; the next sweep reads it again.
    StaysInTmux(String),
    /// No pane runs for the master and another process holds its conversation: nothing is
    /// started against it.
    Held(String),
}

/// What to do about `conversation` (`None`: a cold start) for the master `name`, from the live
/// sessions in `roster`, whether a tmux pane runs under that name (`pane_up`), which pids run in
/// it (`in_pane`), and `work`: what holds the conversation beyond its turn, read only once the pane
/// is otherwise idle.
pub fn judge(
    name: &str,
    conversation: Option<&str>,
    roster: &[BgSession],
    pane_up: bool,
    in_pane: &dyn Fn(u32) -> bool,
    work: &dyn Fn() -> Option<String>,
) -> Step {
    let live: Vec<&BgSession> = roster.iter().filter(|s| s.is_live()).collect();
    let in_tmux: Vec<&BgSession> = live
        .iter()
        .copied()
        .filter(|s| {
            !s.is_background() && (s.name.as_deref() == Some(name) || s.pid.is_some_and(in_pane))
        })
        .collect();
    let holders: Vec<&BgSession> = conversation
        .map(|c| live.iter().copied().filter(|s| s.session_id == c).collect())
        .unwrap_or_default();
    if !pane_up && in_tmux.is_empty() {
        return match holders.first() {
            None => Step::Clear,
            Some(h) => Step::Held(held_elsewhere(name, h)),
        };
    }
    let Some(conversation) = conversation else {
        return Step::StaysInTmux(format!(
            "[BG_CUTOVER_NO_CONVERSATION] {name} still runs in a tmux pane and this placement \
             names no conversation to continue, so a background master started now would run \
             beside it; it stays in tmux"
        ));
    };
    let Some(row) = in_tmux.iter().find(|s| s.session_id == conversation) else {
        return Step::StaysInTmux(match in_tmux.first() {
            Some(other) => format!(
                "[BG_CUTOVER_CONVERSATION_MISMATCH] {name}'s tmux pane holds conversation {} and \
                 this placement continues {conversation}, so ending the pane would end a \
                 conversation nothing resumes; it stays in tmux",
                other.session_id
            ),
            None => format!(
                "[BG_CUTOVER_UNREAD] a tmux pane named {name} runs and `claude agents --json` \
                 lists no session in it, so whether it is idle cannot be read; it stays in tmux"
            ),
        });
    };
    if let Some(other) = holders.iter().find(|h| h.pid != row.pid) {
        return Step::StaysInTmux(held_elsewhere(name, other));
    }
    match row.status.as_deref() {
        Some("idle") => {}
        status => {
            return Step::StaysInTmux(format!(
                "[BG_CUTOVER_WAITS] {name}'s tmux pane holds conversation {conversation} and its \
                 session is {}; it stays in tmux and is moved on a sweep that reads it idle",
                status.map_or_else(
                    || "of no status the roster sends".into(),
                    |s| format!("`{s}`")
                )
            ))
        }
    }
    match work() {
        None => Step::EndPane,
        Some(what) => Step::StaysInTmux(format!(
            "[BG_CUTOVER_WAITS] {name}'s tmux pane holds conversation {conversation} and is at its \
             prompt, and {what}; it stays in tmux and is moved on a sweep that reads it idle"
        )),
    }
}

fn held_elsewhere(name: &str, holder: &BgSession) -> String {
    format!(
        "[BG_RESUME_HELD] conversation {} is open in another Claude Code process ({} session, pid \
         {}) that is not {name}'s pane, so no resume is started against it: Claude Code would only \
         start a copy beside it",
        holder.session_id,
        holder.kind.as_deref().unwrap_or("unnamed"),
        holder.pid.unwrap_or_default()
    )
}

/// [`judge`] on what this box reads now: the roster, and its tmux server's pane named `name`.
pub async fn step(name: &str, conversation: Option<&str>, work: &Work<'_>) -> Result<Step, String> {
    let roster = roster::list().await.map_err(|e| {
        format!(
            "whether a session already holds {name}'s conversation could not be read, so none is \
             started beside it: {e}"
        )
    })?;
    let pane = crate::terminal::pane_pid(name).await;
    let proc_root = std::path::Path::new("/proc");
    let in_pane = |pid: u32| {
        pane.is_some_and(|root| {
            runner_platform::subagent_host::descends_at(proc_root, pid, root)
                == runner_platform::subagent_host::HostRead::Alive
        })
    };
    Ok(judge(
        name,
        conversation,
        &roster,
        pane.is_some(),
        &in_pane,
        work,
    ))
}

/// Make way for `name`'s start: `Ok` where nothing holds its conversation, or where its idle
/// tmux pane was ended and the conversation is free; the refusal otherwise, nothing started.
pub async fn make_way(
    name: &str,
    conversation: Option<&str>,
    work: &Work<'_>,
) -> Result<(), String> {
    match step(name, conversation, work).await? {
        Step::Clear => Ok(()),
        Step::StaysInTmux(why) | Step::Held(why) => Err(why),
        Step::EndPane => {
            let conversation = conversation.unwrap_or_default();
            crate::terminal::kill(name).await.map_err(|e| {
                format!(
                    "[BG_CUTOVER_UNENDED] {name}'s tmux pane was idle and could not be ended, so \
                     conversation {conversation} is not resumed beside it: {e}"
                )
            })?;
            freed(name, conversation, FREED_WITHIN).await?;
            tracing::info!(
                "[master] {name}: its tmux pane was idle and is ended; conversation {conversation} \
                 is resumed as a background session in this sweep"
            );
            Ok(())
        }
    }
}

/// Wait until no live session holds `conversation`, up to `within`.
pub async fn freed(name: &str, conversation: &str, within: Duration) -> Result<(), String> {
    let deadline = std::time::Instant::now() + within;
    loop {
        let held = match roster::list().await {
            Ok(all) => all
                .iter()
                .find(|s| s.is_live() && s.session_id == conversation)
                .map(|s| format!("pid {}", s.pid.unwrap_or_default())),
            Err(e) => Some(e.to_string()),
        };
        let Some(held) = held else {
            return Ok(());
        };
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "[BG_CUTOVER_UNFREED] {name}'s tmux pane was ended and conversation {conversation} \
                 is still held ({held}) after {within:?}, so it is not resumed beside it"
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[cfg(all(test, unix))]
#[path = "cutover_tests.rs"]
mod tests;
