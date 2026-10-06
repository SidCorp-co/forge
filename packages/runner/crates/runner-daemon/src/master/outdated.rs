//! What a resident master's turn and placement say, for core's judgement of
//! an outdated pane (ISS-1379; ADR 0009, What core takes over: Retirement).

use super::*;

/// Where a lead's turn stands, as far as this box can tell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TurnRead {
    /// Affirmatively over: its hooks said so, or, unheard, its transcript did.
    Ended,
    /// Not over, and what says so.
    InTurn(&'static str),
    /// Nothing could be read.
    Unknown,
}

/// A lead's turn, from its hooks where this daemon has heard them and from its
/// transcript where it has not — every pane an update handed over is unheard
/// until its next hook.
pub(crate) fn turn_of(
    seen: Option<&agent_activity::Activity>,
    transcript: Option<&std::path::Path>,
) -> TurnRead {
    use agent_activity::Doing;
    match seen.map(agent_activity::Activity::doing) {
        Some(Doing::Idle) => TurnRead::Ended,
        Some(Doing::Working) => TurnRead::InTurn("its hooks say a turn is running"),
        Some(Doing::AwaitingPermission) => TurnRead::InTurn("it is stopped on a permission prompt"),
        Some(Doing::AwaitingChildren) => {
            TurnRead::InTurn("a subagent it started has not reported its end")
        }
        None => match transcript.and_then(runner_core::transcript_age::lead_turn_ended) {
            Some(true) => TurnRead::Ended,
            Some(false) => TurnRead::InTurn(
                "this box has not heard its hooks since it started, and its transcript's newest entry is not a turn's end",
            ),
            None => TurnRead::Unknown,
        },
    }
}

/// Record that this sweep placed `pane_name` with `with`: the build, plugins
/// and inputs it was handed, which is what a later build judges it outdated
/// against. A placement that could not say what it handed records nothing,
/// and the pane is read as outdated by the next sweep.
pub(crate) fn note_placement(
    led: &Ledger,
    project_id: &str,
    pane_name: &str,
    resolved: &crate::dispatch::Resolved,
    with: Option<&master_build::Standing>,
) {
    let Some(now) = with else {
        tracing::warn!(
            "[master] {}: {pane_name} was placed and what it was handed was not kept for the ledger; the next sweep will read it as outdated",
            resolved.slug
        );
        return;
    };
    let boot = runner_core::inflight::boot_identity().unwrap_or_default();
    let inputs = now.inputs.to_record();
    if let Err(e) = led.note_master_placed(
        project_id,
        pane_name,
        &boot,
        (&now.build, now.plugins.as_deref(), &inputs),
    ) {
        tracing::warn!(
            "[master] {}: {pane_name} was placed and what it was placed with could not be recorded ({e}); the next sweep will read it as outdated",
            resolved.slug
        );
    }
}
