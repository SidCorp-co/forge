//! The box's half of moving a master from its tmux pane to a background session (ISS-1304):
//! what holds the pane's conversation beyond its own turn, and the read that keeps a busy pane in
//! tmux before any session is registered for its successor. The judgement itself is
//! `runner_workspace::bg_session::cutover`'s.

use super::*;
use runner_workspace::bg_session::cutover::{self, Step};

/// What holds `conversation`, run in `repo`, beyond its own turn: a child run in a process of its
/// own still running, or what its transcript says is open (its turn, or a background agent, shell
/// or monitor it started, as `outdated.rs:turn_of` reads them for a replacement). `None` only
/// where both say nothing holds it; a transcript that cannot be read holds it.
pub(crate) fn work_held(
    repo: &std::path::Path,
    conversation: Option<&str>,
    inherited: &[InheritedRun],
) -> Option<String> {
    if let Some(run) = inherited
        .iter()
        .find(|r| r.ended_by.is_none() && r.pid.is_some_and(pid_runs))
    {
        return Some(format!(
            "its child run {} (pid {}) is still running",
            run.run_id,
            run.pid.unwrap_or_default()
        ));
    }
    let transcript = conversation_transcript(repo, conversation?);
    let background = background_of(transcript.as_deref());
    match turn_of(
        None,
        transcript.as_deref(),
        &background,
        agent_activity::now_ms(),
    ) {
        TurnRead::Ended => None,
        TurnRead::InTurn(what) => Some(what),
        TurnRead::Unknown => Some(
            "its transcript cannot be read, so whether its turn and its background work are over \
             is not known"
                .into(),
        ),
    }
}

fn pid_runs(pid: u32) -> bool {
    std::path::Path::new("/proc").join(pid.to_string()).exists()
}

/// Whether the master core placed stays where it is this sweep: its tmux pane busy, or its
/// conversation held by another process. Said once per change of reason, and read before a
/// session is registered for a successor that would not start.
pub(crate) async fn stays(
    t: &Turn<'_>,
    conversation: Option<&str>,
    inherited: &[InheritedRun],
) -> bool {
    let name = t.seen.pane_name.as_str();
    let work = || work_held(&t.resolved.repo_path, conversation, inherited);
    let (why, pane) = match cutover::step(name, conversation, &work).await {
        Ok(Step::Clear | Step::EndPane) => return false,
        Ok(Step::StaysInTmux(why)) => (why, Some(name.to_string())),
        Ok(Step::Held(why)) | Err(why) => (why, None),
    };
    say_unplaced(
        t.sw.shared.masters,
        &t.runner.project_id,
        &t.resolved.slug,
        Unplaced::CutoverWaits { detail: why, pane },
    );
    true
}
