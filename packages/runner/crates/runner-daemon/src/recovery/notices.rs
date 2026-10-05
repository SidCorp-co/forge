use super::*;

/// What a sweep tmux could not answer says it did. The pane read gives no
/// end, but the Claude Code process recorded for a subagent is read from
/// `/proc` whatever tmux answers, and that process read gone is the one end
/// this sweep may still have recorded (ISS-1312 criterion 31). That end is the
/// subagent's and not the run's: the run keeps its checkout and its issues
/// until its master closes it or recovery releases it, so the line says whose
/// end it recorded rather than that it ended a run.
pub(crate) fn unanswered_line(reads: &[String], ended_by_process: &[String]) -> Option<String> {
    if reads.is_empty() {
        return None;
    }
    let ended = if ended_by_process.is_empty() {
        "no end for any of them".to_string()
    } else {
        format!(
            "no end for any of them from their pane, and the end of the subagent of {} ({}) because the Claude Code process it ran in reads gone, each such run staying open, with its checkout and its issues, until its master closes it or recovery releases it,",
            ended_by_process.len(),
            ended_by_process.join(", ")
        )
    };
    Some(format!(
        "[recovery] tmux could not be asked whether the master pane of {} run(s) is there ({}), so this sweep recorded {ended} and decided each as under a pane still standing. Until tmux answers, this box cannot tell a live master from a dead one",
        reads.len(),
        reads.join(", ")
    ))
}

/// Say, once per unchanged failure, that the fact this keep now turns on could
/// not be read. The notice shares `kept_notice` with [`say_why_kept`], and only
/// one of the two writes on a sweep, so a transport that keeps failing says
/// this once and a transport that recovers hands the latch back.
pub(crate) fn say_issue_status_unreadable(ledger: &mut Ledger, run: &Run, why: &str) {
    if !matches!(
        ledger.note_kept(&run.run_id, ISSUE_STATUS_UNREADABLE),
        Ok(true)
    ) {
        return;
    }
    tracing::warn!(
        "[recovery] run {} is kept because {why} — not because its issues are live. It ends when \
         core answers that read, and until then nothing here can tell a run still working from \
         one whose issues closed. Said once, not every sweep",
        run.run_id
    );
}

/// The `kept_notice` [`say_why_released`] latches on. Not `unanswered`, which
/// 0.17.46 wrote for a release said and 0.17.52 for a keep, so that word
/// latches neither writer: a release still owed after 0.17.46 said it is said
/// once more, rather than a release after 0.17.52's keep never being said.
pub(crate) const RELEASE_SAID: &str = "release-said";

/// The `kept_notice` [`say_issue_status_unreadable`] latches on.
pub(crate) const ISSUE_STATUS_UNREADABLE: &str = "issue-status-unreadable";

/// Latch [`RELEASE_SAID`] for `run` and, on the sweep that first owes the
/// release line, the issue keys it holds joined for that line. `None` when it
/// was already said, or the latch could not be written (said here instead).
fn release_owed(ledger: &Ledger, run: &Run) -> Option<String> {
    match ledger.note_standing(&run.run_id, RELEASE_SAID) {
        Ok(true) => {}
        Ok(false) => return None,
        Err(e) => {
            tracing::warn!(
                "[recovery] run {}: cannot record why it is being released: {e}",
                run.run_id
            );
            return None;
        }
    }
    Some(
        ledger
            .issues(&run.run_id)
            .map(|m| {
                m.iter()
                    .map(|i| i.issue_key.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default(),
    )
}

/// Say, on the sweep that first owes it, why a run nobody here answers for is
/// being released and what it holds. Said once, on the row as well as in the
/// journal: a release that cannot even start — a project with no repo path on
/// this box — is owed again every sweep, and the reason it is owed is not news
/// the second time.
pub(crate) fn say_why_released(ledger: &Ledger, run: &Run, over_ms: i64) {
    let Some(issues) = release_owed(ledger, run) else {
        return;
    };
    // What the silence rests on, said as it is: a transcript nobody could read
    // decided nothing, and the line must not read as if it had.
    let silence = silence_evidence(run);
    tracing::warn!(
        "[recovery] run {} ({issues}): no master on this box answers for it (it answered to {}), \
         core has called its session over for {}m and {silence} — releasing {} now. Its commits \
         are kept before the checkout goes; a release that refuses says why next, and is decided \
         after {}s",
        run.run_id,
        run.master_session_id,
        over_ms / 60_000,
        run.worktree_path.display(),
        runner_workspace::terminate::RELEASE_GRACE_SECS
    );
}

/// Say once, on the sweep that first owes it, that a subagent run is being
/// released because the master pane it ran in ended, and which way that was
/// seen. Latched on the same word as [`say_why_released`], since the two never
/// both speak for one release.
pub(crate) fn say_why_released_host(ledger: &Ledger, run: &Run, how: HostEnd) {
    let Some(issues) = release_owed(ledger, run) else {
        return;
    };
    tracing::warn!("{}", host_release_line(run, &issues, how, now_ms()));
}

/// The line [`say_why_released_host`] says, naming the process and how the
/// master pane was seen when it was read gone.
pub(crate) fn host_release_line(run: &Run, issues: &str, how: HostEnd, now: i64) -> String {
    let ago = run
        .host_ended_at_ms
        .map_or(0, |at| now.saturating_sub(at) / 60_000);
    let pane = match how {
        HostEnd::PaneGone => "its master's pane is gone too",
        HostEnd::PaneStarted => "a new master pane was started for its project in its place",
        HostEnd::ProcessGone => "its master's pane was read neither gone nor started again",
    };
    let host = run.host_pid.map_or_else(
        || "its recorded process".to_string(),
        |pid| format!("pid {pid}"),
    );
    format!(
        "[recovery] run {} ({issues}): the Claude Code process its subagent ran in ({host}) was \
         read gone {ago}m ago and {pane}, and nothing has been heard from its subagent since, so it \
         ended with that process (it answered to {}); core has called its session over — \
         releasing {} now. Its commits are kept before the checkout goes; a release that refuses \
         says why next, and is decided after {}s",
        run.run_id,
        run.master_session_id,
        run.worktree_path.display(),
        runner_workspace::terminate::RELEASE_GRACE_SECS
    )
}

/// Why an orphaned run nothing can close this sweep is still standing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Standing {
    /// No master here answers for it and nothing on this sweep can close it:
    /// its session still open at core, its bound not yet run out, or only its
    /// leases left to be taken back.
    Unanswered,
    /// Declared under another boot, which nothing on this one may reclaim.
    ForeignBoot,
    /// Its release was decided terminal and its checkout stays by decision;
    /// only its leases are still being chased.
    Decided,
    /// Every mark it has left is one core sets — a session core has not called
    /// over, or a lease core has not handed back — and this box is asking core
    /// for it on every sweep. Reaching this arm with the session still open
    /// means `ended_by` is set and `session_terminal_at` is not, which is
    /// exactly the population `run_record::close_ended_runs` retries; reaching
    /// it with the session over means the checkout is back and only leases are
    /// left, which `close_loop::close` asks for on every pass. So the run is
    /// waiting on an answer, not on a keystroke.
    AwaitingCore,
}

/// The `kept_notice` [`say_standing`] latches on for a run standing this way.
pub(crate) fn standing_notice(standing: Standing, state: &CloseState) -> &'static str {
    match standing {
        Standing::Unanswered if !state.session_terminal => "awaiting-session",
        Standing::Unanswered if !state.checkout_returned => "awaiting",
        Standing::Unanswered => "awaiting-leases",
        Standing::ForeignBoot => "foreign-boot",
        Standing::Decided => "decided",
        Standing::AwaitingCore if !state.session_terminal => "core-awaiting-session",
        Standing::AwaitingCore => "core-awaiting-leases",
    }
}

/// Say once, in the journal and on the row, why this run stands and what ends
/// it. Answers whether it has been said, now or on an earlier sweep, so the
/// sweep's own per-sweep line can stand down; a notice that could not be
/// recorded answers `false` and leaves that line to speak.
#[expect(
    clippy::too_many_lines,
    reason = "one notice per recovery outcome, in order (ISS-218 amnesty)"
)]
pub(crate) fn say_standing(
    ledger: &Ledger,
    run: &Run,
    boot_id: &str,
    state: &CloseState,
    standing: Standing,
) -> bool {
    match ledger.note_standing(&run.run_id, standing_notice(standing, state)) {
        Ok(false) => return true,
        Ok(true) => {}
        Err(e) => {
            tracing::warn!(
                "[recovery] run {}: cannot record why it stands: {e}",
                run.run_id
            );
            return false;
        }
    }
    let issues = ledger
        .issues(&run.run_id)
        .map(|m| {
            m.iter()
                .map(|i| i.issue_key.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let holds = format!(
        "session_terminal={} checkout_returned={} leases={}/{}",
        state.session_terminal, state.checkout_returned, state.leases_returned, state.leases_total
    );
    match standing {
        Standing::Unanswered => {
            let what_ends_it = if !state.session_terminal {
                format!(
                    "core still holds its session open, and the bound of {}m starts when core \
                     calls it over",
                    UNANSWERED_RELEASE_AFTER.as_secs() / 60
                )
            } else if !state.checkout_returned {
                format!(
                    "its checkout {} is released once core has called its session over for {}m \
                     ({}, now)",
                    run.worktree_path.display(),
                    UNANSWERED_RELEASE_AFTER.as_secs() / 60,
                    silence_evidence(run)
                )
            } else {
                format!(
                    "its checkout is back and only its leases ({}/{} returned) are still being \
                     asked back",
                    state.leases_returned, state.leases_total
                )
            };
            tracing::warn!(
                "[recovery] run {} ({issues}) is partially closed ({holds}): no master on this box \
                 answers for it (it answered to {}), so {what_ends_it}. Said once; what ends it \
                 says itself when it comes",
                run.run_id,
                run.master_session_id
            )
        }
        Standing::ForeignBoot => {
            let left = if state.checkout_returned {
                format!(
                    "Its checkout is back, {}/{} of its leases are back and the rest stay held",
                    state.leases_returned, state.leases_total
                )
            } else {
                format!("Its checkout {} is still held", run.worktree_path.display())
            };
            tracing::error!(
                "[recovery] run {} ({issues}) is partially closed ({holds}) and will stay so: it \
                 was declared under boot {} and this box is boot {}, and a run from another boot \
                 is never reclaimed here, because its process and its pane cannot be read from \
                 this one. {left}. Said once, not every sweep",
                run.run_id,
                run.boot_id,
                boot_id
            )
        }
        Standing::Decided => {
            tracing::warn!(
            "[recovery] run {} ({issues}) is partially closed ({holds}): its release was decided \
             terminal ({}), so its checkout {} stays on disk by decision and only its leases are \
             still being asked back. `forge-runner run release {}` has the next sweep try the \
             release again. Said once, not every sweep",
            run.run_id,
            run.release_refusal.as_deref().unwrap_or("no refusal was recorded"),
            run.worktree_path.display(),
            run.run_id
        )
        }
        Standing::AwaitingCore => {
            // The two marks this box cannot set itself, said apart: a session
            // core still holds open and a lease core has not handed back are
            // different facts and a line covering both names no act (ISS-1239).
            //
            // Neither says an ask has stopped, so neither names a verb that
            // restarts one. `forge-runner run release` is the `Decided` arm's
            // act and is correct there because that arm's condition is
            // `release_terminal_at` SET; this arm is only reached while it is
            // NULL, which is the very condition `cmd/run.rs::retract` bails on
            // — so naming it here names an act nobody can take, and an
            // operator who takes it once, on a line said once, is told nothing
            // again. What the reader is pointed at instead is the ask that is
            // running and the line that carries core's refusal, which repeats
            // on every sweep and so is still there when they look. That the
            // ask is in the sweep at all is held by `master.rs`'s own
            // `depth_of_call_in_sweep("run_record::close_ended_runs(")`.
            let what_ends_it = if !state.session_terminal {
                format!(
                    "core's session row for {} is not over yet, and this box asks core to close \
                     it again on every sweep, so the run ends within a sweep of core taking that \
                     close; where core refuses, `[run-record] run {}: core would not take the \
                     close` carries the reason, every sweep",
                    run.session_id.as_deref().unwrap_or("this run"),
                    run.run_id,
                )
            } else {
                format!(
                    "its checkout is back and {}/{} of its leases are, and this box asks core for \
                     the rest on every sweep, so the run ends within a sweep of core handing them \
                     back; where core refuses, `[close] run={} <issue>: lease release refused` \
                     carries the reason, every sweep",
                    state.leases_returned, state.leases_total, run.run_id,
                )
            };
            tracing::warn!(
                "[recovery] run {} ({issues}) is partially closed ({holds}): every mark it has \
                 left is core's to set and this box is still asking — {what_ends_it}. There is no \
                 act for an operator here and no command to run: wait a sweep. Where core keeps \
                 refusing, the act is whatever that refusal names — a 401 is this box's pairing, \
                 which `forge-runner login` restores. Not `run release`: this run carries no \
                 release this box gave up on, and that verb refuses it by name. Said once, not \
                 every sweep",
                run.run_id,
            )
        }
    }
    true
}

/// Say once, in the journal and on the row, why a subagent run that looks
/// finished or cannot be read is still being kept, and what ends it.
pub(crate) fn say_why_kept(ledger: &mut Ledger, run: &Run, now: i64) {
    let path = run.agent_transcript.as_deref();
    let evidence = subagent_end::of_run(run, now);
    let Some(notice) = subagent_end::notice(evidence) else {
        return;
    };
    match ledger.note_kept(&run.run_id, notice) {
        Ok(true) => {}
        Ok(false) => return,
        Err(e) => {
            tracing::warn!(
                "[recovery] run {}: cannot record why it is kept: {e}",
                run.run_id
            );
            return;
        }
    }
    let issues = ledger
        .issues(&run.run_id)
        .map(|m| {
            m.iter()
                .map(|i| i.issue_key.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let observed = match evidence {
        subagent_end::Evidence::Quiet { silent_ms } => format!(
            "its subagent ended a turn {}m ago and has written nothing since",
            silent_ms / 60_000
        ),
        subagent_end::Evidence::Unanswered { .. } | subagent_end::Evidence::HostEnded { .. } => {
            subagent_end::held_because(evidence, path)
        }
        _ => format!(
            "its subagent ended a turn and this box cannot read its transcript ({}), so it cannot tell whether it resumed",
            path.unwrap_or("no path was recorded")
        ),
    };
    tracing::warn!(
        "[recovery] run {} ({issues}): {observed}. Its tree and leases are kept, because a finished subagent can still be resumed. Once it will not be, `forge-runner run close {}` gives them back",
        run.run_id,
        run.run_id
    );
}
