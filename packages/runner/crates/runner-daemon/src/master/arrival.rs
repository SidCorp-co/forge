//! Whether a pane this box placed has been heard from since (ISS-859).
//!
//! A pane that came up dead sends no hook and writes no transcript turn, so its
//! turn reads `unknown` for ever: neither nudged nor replaced, and its project
//! has no working master. The deaf path covers a pane whose capability is
//! stale, not one that never reported at all. The box reports what it heard
//! since the placement; whether that is dead on arrival is core's
//! (`masters/verdict.ts:deadOnArrival`), and so is the window.

use super::*;
use runner_transport::master_verdict as wire;

/// What this box heard from a pane after placing it at `placed_at_ms`: any
/// hook its session reported, or any write to its conversation's transcript.
pub(crate) fn heard_since(
    placed_at_ms: i64,
    seen: Option<&agent_activity::Activity>,
    transcript: Option<&std::path::Path>,
) -> bool {
    let hooked = seen.is_some_and(|a| a.last_event_at >= placed_at_ms);
    let written = transcript
        .and_then(runner_core::transcript_age::last_written)
        .is_some_and(|at| at >= placed_at_ms);
    hooked || written
}

/// The arrival facts for the pane up for `project_id`, where this daemon
/// placed it. `None` for a pane it did not place, which it cannot date: a
/// pane adopted after a restart is judged as before.
pub(crate) fn arrival_facts(
    masters: &Masters,
    activity: &agent_activity::Activities,
    project_id: &str,
    pane_name: &str,
    transcript: Option<&std::path::Path>,
    now_ms: i64,
) -> Option<wire::Arrival> {
    let placed_at_ms = masters.placed_at_ms(project_id)?;
    let seen = masters
        .get(project_id)
        .and_then(|(session, _)| activity.get(&session));
    let heard = heard_since(placed_at_ms, seen.as_ref(), transcript);
    if heard {
        masters.note_arrival_heard(project_id);
    }
    Some(wire::Arrival {
        pane: pane_name.to_string(),
        placed_ago_seconds: u64::try_from(now_ms.saturating_sub(placed_at_ms) / 1000).unwrap_or(0),
        heard,
        dead_before: masters.dead_before(project_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_activity::{Activities, Event, Report};

    const PLACED: i64 = 1_793_498_400_000;

    #[test]
    fn a_pane_with_no_hook_and_no_transcript_write_since_its_placement_is_unheard() {
        assert!(!heard_since(PLACED, None, None));
        // A hook heard before the placement is the pane it replaced.
        let a = Activities::new();
        let before = a.record(
            "s",
            Report {
                event: Event::Stopped,
                at: PLACED - 1,
                subject: None,
                conversation: Some("c"),
                transcript: None,
            },
        );
        assert!(!heard_since(PLACED, Some(&before), None));
        let after = a.record(
            "s",
            Report {
                event: Event::PromptSubmitted,
                at: PLACED + 5_000,
                subject: None,
                conversation: Some("c"),
                transcript: None,
            },
        );
        assert!(heard_since(PLACED, Some(&after), None));
    }

    #[test]
    fn a_transcript_written_after_the_placement_is_heard() {
        let path = std::env::temp_dir().join(format!("forge-arrival-{}.jsonl", std::process::id()));
        std::fs::write(&path, "{}\n").unwrap();
        let written = runner_core::transcript_age::written_at(&path).unwrap();
        assert!(heard_since(written - 1, None, Some(&path)));
        assert!(!heard_since(written + 1, None, Some(&path)));
        std::fs::remove_file(&path).unwrap();
    }

    /// The plant: a pane placed and never heard is reported unheard with its
    /// age; ended dead and placed again, its successor carries `dead_before`
    /// until it is heard.
    #[test]
    fn a_dead_arrival_is_reported_and_carried_to_the_next_placement_until_heard() {
        let masters = Masters::default();
        let a = Activities::new();
        masters.note_placed_at("p", None, PLACED);
        let first = arrival_facts(&masters, &a, "p", "forge-master-p", None, PLACED + 301_000)
            .expect("a pane this box placed had no arrival");
        assert!(!first.heard && !first.dead_before);
        assert_eq!(first.placed_ago_seconds, 301);

        masters.note_dead_arrival("p");
        masters.note_placed_at("p", None, PLACED + 400_000);
        let second =
            arrival_facts(&masters, &a, "p", "forge-master-p", None, PLACED + 500_000).unwrap();
        assert!(
            second.dead_before,
            "the second dead arrival was not said as one"
        );

        remember_session(&masters, "p", "s2");
        a.record(
            "s2",
            Report {
                event: Event::PromptSubmitted,
                at: PLACED + 410_000,
                subject: None,
                conversation: Some("c"),
                transcript: None,
            },
        );
        let heard =
            arrival_facts(&masters, &a, "p", "forge-master-p", None, PLACED + 500_000).unwrap();
        assert!(heard.heard);
        assert!(
            !masters.dead_before("p"),
            "a heard pane left its project marked dead"
        );
        assert!(arrival_facts(&masters, &a, "other", "x", None, PLACED).is_none());
    }

    fn remember_session(masters: &Masters, project_id: &str, session: &str) {
        masters.remember(
            project_id,
            MasterState {
                session_id: session.into(),
                name: "forge-master-p".into(),
                last_work: Instant::now(),
                last_nudge: None,
                mcp_stale_reported: false,
            },
        );
    }
}
