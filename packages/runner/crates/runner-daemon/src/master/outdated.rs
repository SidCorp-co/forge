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

/// Record that this sweep placed `pane_name` under this box's build and
/// plugins, which is what a later build judges it outdated against.
pub(crate) fn note_placement(
    led: &Ledger,
    project_id: &str,
    pane_name: &str,
    resolved: &crate::dispatch::Resolved,
) {
    let now = master_build::Standing::this_box(&resolved.repo_path);
    let boot = runner_core::inflight::boot_identity().unwrap_or_default();
    if let Err(e) = led.note_master_placed(
        project_id,
        pane_name,
        &boot,
        &now.build,
        now.plugins.as_deref(),
    ) {
        tracing::warn!(
            "[master] {}: {pane_name} was placed and the build it was placed under could not be recorded ({e}); the next build will read it as outdated",
            resolved.slug
        );
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_a_subagent_read_as_over_is_over() {
        use runner_core::subagent_end::Evidence;
        let over = [
            Evidence::HostEnded { silent_ms: 1 },
            Evidence::Quiet {
                silent_ms: 4_000_000,
            },
            Evidence::Unanswered {
                silent_ms: 4_000_000,
            },
        ];
        for e in over {
            assert!(
                crate::master_exit::subagent_over(e, None).is_some(),
                "{e:?}"
            );
        }
        let live = [
            Evidence::NoTurnEnd { since_ms: 1 },
            Evidence::Resumed { silent_ms: 1 },
            Evidence::AwaitingReply { silent_ms: 1 },
            Evidence::Recent { silent_ms: 1 },
            Evidence::Unreadable,
            Evidence::TailUnreadable { silent_ms: 1 },
        ];
        for e in live {
            assert!(
                crate::master_exit::subagent_over(e, None).is_none(),
                "{e:?}"
            );
        }
    }
}
