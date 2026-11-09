//! A channel pane's first turn handed in, and the running cost it is measured from (ISS-1172):
//! a new session's runs as its launch prompt from a baseline of nothing spent; a resumed one's is
//! typed in once the status line the launched session writes has given its baseline.

use std::path::Path;

use super::pane::READ_EVERY;
use super::pane_turn::status_cost;
use super::*;
use crate::pane_launch::SessionStart;
use runner_core::chat_pane_events::{self, STATUS_LINE};
use runner_workspace::terminal;

/// How long a resumed pane's first turn waits after the launch for the status line its cost is
/// measured from, before it is typed in without one. Measured on 2.1.319, a launched session's
/// first status line comes 3.3–3.5 s after the launch, before any prompt.
const BASELINE_WITHIN: Duration = Duration::from_secs(10);

/// The pane's first turn, handed in: a new session's ran as its launch prompt; a resumed one's is
/// typed in once its baseline is read. Answers the running cost the turn is measured from. Where
/// the turn cannot be typed the pane is ended with what was made for it, and the turn runs
/// headless.
pub(super) async fn first_turn(
    id: &str,
    pane: &str,
    (session, prompt): (&SessionStart, &str),
    events: &Path,
    (mcp_path, bearer_dir, events_dir): (&Path, Option<&Path>, &Path),
) -> Result<Option<f64>> {
    let base = first_turn_base(session, events, BASELINE_WITHIN).await;
    if launch_prompt(session, prompt).is_some() {
        return Ok(base);
    }
    let Err(why) = terminal::brief_new_pane(pane, prompt).await else {
        return Ok(base);
    };
    if let Err(e) = terminal::kill(pane).await {
        tracing::error!("[chat {id}] {pane}: {e}");
    }
    let _ = std::fs::remove_file(mcp_path);
    if let Some(dir) = bearer_dir {
        let _ = std::fs::remove_dir_all(dir);
    }
    let _ = std::fs::remove_dir_all(events_dir);
    Err(Error::Other(format!("[CHAT_PANE_NOT_TYPED] {why}")))
}

/// The first turn as the pane's launch prompt: a new session's. A resumed session's is typed in
/// once its baseline is read, since a launch prompt would run before any status line stood.
pub(super) fn launch_prompt<'a>(session: &SessionStart, prompt: &'a str) -> Option<&'a str> {
    matches!(session, SessionStart::New(_)).then_some(prompt)
}

/// The running cost the pane's first turn is measured from. A session the box just named has
/// spent nothing. A resumed one restores its earlier running cost (2.1.319 reads it back from the
/// transcript's `cost-state`), so it is read from the first status line the launched session
/// writes to `events`, waited for at most `within`; with none, there is no baseline.
pub(super) async fn first_turn_base(
    session: &SessionStart,
    events: &Path,
    within: Duration,
) -> Option<f64> {
    if matches!(session, SessionStart::New(_)) {
        return Some(0.0);
    }
    let until = tokio::time::Instant::now() + within;
    let mut at = 0u64;
    loop {
        if let Ok((lines, next)) = chat_pane_events::read_from(events, at) {
            at = next;
            let costs = lines.iter().filter(|l| l.event == STATUS_LINE);
            if let Some(c) = costs.filter_map(|l| status_cost(&l.payload)).next() {
                return Some(c);
            }
        }
        if tokio::time::Instant::now() >= until {
            return None;
        }
        tokio::time::sleep(READ_EVERY).await;
    }
}
