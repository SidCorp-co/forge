//! A subagent at work in a checkout, which no reading of the process table
//! can see.
//!
//! The release already refuses a checkout a live agent's process is living in
//! (`worktree_processes`, ISS-1378): residence by `cwd`. A subagent has no
//! process of its own. It runs inside its master's Claude Code process, whose
//! working directory is the master's checkout, and each of its tool calls is a
//! child that lives as long as that one call. Between two of them nothing on
//! the box has its `cwd` in the subagent's tree, so the reading answers
//! "nobody is here" and the directory goes. That is how a reclaim on this box
//! removed the checkout of a subagent that had bound a minute earlier and was
//! working in it (FB-273, 2026-10-23).
//!
//! So the ledger's own evidence is read as well: a run bound to a subagent
//! that is in a turn, heard from inside the silence a lead is allowed, whose
//! host process has not been read gone, is a live agent in its checkout.
//!
//! **Priced amnesty: a turn whose stop hook was lost reads as in progress.**
//! Its checkout and leases stay out until the subagent has been silent for
//! [`SILENT_BEFORE_ABANDONED`] or its host goes, where removing it under a
//! working subagent would lose the turn. Ends at the first such hold measured
//! outliving the silence bound.

use runner_core::job_exit::SILENT_BEFORE_ABANDONED;
use runner_core::ledger::Run;
use runner_core::subagent_end::{self, Evidence};
use runner_platform::subagent_host::{HostRead, Hosts};
use std::path::Path;

/// Why `run`'s checkout is a working subagent's, or `None` where it is not.
pub(super) fn working_subagent(run: &Run, hosts: &dyn Hosts, now_ms: i64) -> Option<String> {
    // A run with a process of its own is read by residence, as before.
    if run.pid.is_some() {
        return None;
    }
    let agent = run.agent_id.as_deref()?;
    let evidence = subagent_end::of_run(run, now_ms);
    if !matches!(
        evidence,
        Evidence::NoTurnEnd { .. } | Evidence::Resumed { .. } | Evidence::AwaitingReply { .. }
    ) {
        return None;
    }
    let written = run
        .agent_transcript
        .as_deref()
        .and_then(|t| runner_core::transcript_age::written_at(Path::new(t)));
    let heard = written
        .max(run.turn_ended_at_ms)
        .unwrap_or(0)
        .max(run.created_at.saturating_mul(1000));
    let silent_ms = now_ms.saturating_sub(heard);
    if silent_ms >= SILENT_BEFORE_ABANDONED.as_millis() as i64 {
        return None;
    }
    let host = match (run.host_pid, run.host_start.as_deref()) {
        (Some(pid), Some(start)) => match hosts.read(pid, start) {
            HostRead::Gone => return None,
            HostRead::Alive => format!("Claude Code pid {pid}, which is alive"),
            HostRead::Unreadable => {
                format!("Claude Code pid {pid}, which this box could not read")
            }
        },
        _ => "a Claude Code process this box never recorded".to_string(),
    };
    Some(format!(
        "subagent {agent} is in a turn ({}), heard from {}s ago, inside {host}. A subagent has \
         no process of its own, so between two of its tool calls no working directory shows it \
         in the checkout, and the checkout is its work whatever ended the run. Nothing was \
         preserved, committed or removed; the release is tried again until the subagent ends \
         its turn, its host goes, or it is silent for {}m",
        evidence.wire().0,
        silent_ms / 1000,
        SILENT_BEFORE_ABANDONED.as_secs() / 60
    ))
}
