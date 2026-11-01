//! What a resident master's turn and placement say, for core's judgement of
//! an outdated pane (ISS-1379; ADR 0009, What core takes over: Retirement).

use super::*;

/// Where a lead's turn stands, as far as this box can tell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TurnRead {
    /// Affirmatively over, and nothing it started in the background is still
    /// running: its hooks said so, or, unheard, its transcript did.
    Ended,
    /// Not over, and what says so.
    InTurn(String),
    /// Nothing could be read.
    Unknown,
}

/// How long a background child whose end this box has not read is waited on
/// before its pane may be replaced anyway (ISS-858). A child's start and end
/// both reach its lead's transcript, so a child with no end there is running,
/// or its end was lost; only time tells those apart. Three hours outlasts the
/// builds and gates a direct-mode master runs in the background, which are
/// what a replacement kills, and bounds a lost end to one afternoon's drain.
pub(crate) const BACKGROUND_END_CEILING: std::time::Duration =
    std::time::Duration::from_secs(3 * 60 * 60);

/// The most children a turn read names; the rest are counted.
const NAMED_CHILDREN: usize = 5;

/// One read of the background children a lead started, from its transcript:
/// the children it opened and ended, or why it could not be read.
pub(crate) type BackgroundRead = Result<background_tasks::Tasks, String>;

/// The process-wide reader of master transcripts, which keeps where it
/// stopped in each so a sweep reads only what was written since the last.
pub(crate) fn background_of(transcript: Option<&std::path::Path>) -> BackgroundRead {
    static READER: std::sync::LazyLock<background_tasks::Reader> =
        std::sync::LazyLock::new(background_tasks::Reader::new);
    match transcript {
        Some(path) => READER.read(path),
        None => Err("no transcript is known for its conversation".into()),
    }
}

/// A lead's turn, from its hooks where this daemon has heard them and from its
/// transcript where it has not — every pane an update handed over is unheard
/// until its next hook — and, once the lead's own turn is over, whether a
/// background agent, shell or monitor it started is still running: those die
/// with the pane as surely as a turn does (ISS-858).
pub(crate) fn turn_of(
    seen: Option<&agent_activity::Activity>,
    transcript: Option<&std::path::Path>,
    background: &BackgroundRead,
    now_ms: i64,
) -> TurnRead {
    use agent_activity::Doing;
    match seen.map(agent_activity::Activity::doing) {
        Some(Doing::Idle | Doing::AwaitingChildren) => {}
        Some(Doing::Working) => return TurnRead::InTurn("its hooks say a turn is running".into()),
        Some(Doing::AwaitingPermission) => {
            return TurnRead::InTurn("it is stopped on a permission prompt".into())
        }
        None => match transcript.and_then(runner_core::transcript_age::lead_turn_ended) {
            Some(true) => {}
            Some(false) => return TurnRead::InTurn(
                "this box has not heard its hooks since it started, and its transcript's newest entry is not a turn's end".into(),
            ),
            None => return TurnRead::Unknown,
        },
    }
    match background_held(seen, background, now_ms) {
        Some(what) => TurnRead::InTurn(what),
        None => TurnRead::Ended,
    }
}

/// What background work holds a lead whose own turn is over, or `None` where
/// nothing does. A child is held from its start until its end is read, or
/// until [`BACKGROUND_END_CEILING`] has passed since it started; a transcript
/// that cannot be read holds the pane the same ceiling past its turn's end,
/// since a background shell or monitor is heard nowhere else.
fn background_held(
    seen: Option<&agent_activity::Activity>,
    background: &BackgroundRead,
    now_ms: i64,
) -> Option<String> {
    let ceiling_ms = i64::try_from(BACKGROUND_END_CEILING.as_millis()).unwrap_or(i64::MAX);
    let ceiling = format!(
        "BACKGROUND_END_CEILING, {}h",
        BACKGROUND_END_CEILING.as_secs() / 3600
    );
    let minutes = |since: i64| now_ms.saturating_sub(since) / 60_000;
    let tasks = match background {
        Ok(tasks) => tasks,
        Err(why) => {
            let since = seen.and_then(|a| a.lead_ended_at().or(Some(a.last_event_at)))?;
            if now_ms.saturating_sub(since) >= ceiling_ms {
                tracing::warn!(
                    "[master] its transcript cannot be read ({why}) and its turn ended {} min ago, past {ceiling}: whether a background child it started still runs was never read",
                    minutes(since)
                );
                return None;
            }
            return Some(format!(
                "cannot read whether a background agent, shell or monitor it started has ended ({why}); waiting up to {ceiling} after its turn ended {} min ago",
                minutes(since)
            ));
        }
    };
    let mut open: std::collections::BTreeMap<String, (&'static str, Option<i64>)> = tasks
        .open()
        .map(|o| (o.id.clone(), (o.kind.word(), o.since_ms)))
        .collect();
    for (id, at) in seen.map(|a| &a.background).into_iter().flatten() {
        if !tasks.ended(id) {
            open.entry(id.clone()).or_insert(("subagent", Some(*at)));
        }
    }
    let (held, past): (Vec<_>, Vec<_>) = open
        .into_iter()
        .partition(|(_, (_, since))| since.is_none_or(|at| now_ms.saturating_sub(at) < ceiling_ms));
    for (id, (kind, since)) in &past {
        tracing::warn!(
            "[master] background {kind} {id} started {} min ago and its end was never read; past {ceiling} it no longer holds its pane",
            since.map(minutes).unwrap_or_default()
        );
    }
    if held.is_empty() {
        return None;
    }
    let named: Vec<String> = held
        .iter()
        .take(NAMED_CHILDREN)
        .map(|(id, (kind, since))| match since {
            Some(at) => format!("{kind} {id} ({} min)", minutes(*at)),
            None => format!("{kind} {id}"),
        })
        .collect();
    let more = held.len().saturating_sub(NAMED_CHILDREN);
    let rest = if more > 0 {
        format!(" and {more} more")
    } else {
        String::new()
    };
    Some(format!(
        "{} background child(ren) it started have not ended: {}{rest}; each is waited on up to {ceiling} from its start",
        held.len(),
        named.join(", ")
    ))
}

/// Record that this sweep placed `pane_name` with `with`: the inputs it was
/// handed, which is what core judges it outdated against. A placement that could not say what it handed records nothing,
/// and the pane is read as outdated by the next sweep.
pub(crate) fn note_placement(
    led: &Ledger,
    project_id: &str,
    pane_name: &str,
    resolved: &crate::dispatch::Resolved,
    with: Option<&master_build::Inputs>,
) {
    let Some(now) = with else {
        tracing::warn!(
            "[master] {}: {pane_name} was placed and what it was handed was not kept for the ledger; the next sweep will read it as outdated",
            resolved.slug
        );
        return;
    };
    let boot = runner_core::inflight::boot_identity().unwrap_or_default();
    let inputs = now.to_record();
    if let Err(e) = led.note_master_placed(project_id, pane_name, &boot, &inputs) {
        tracing::warn!(
            "[master] {}: {pane_name} was placed and what it was placed with could not be recorded ({e}); the next sweep will read it as outdated",
            resolved.slug
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_activity::{Activities, Event, Report};
    use serde_json::json;

    fn transcript(name: &str, entries: &[serde_json::Value]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-iss858-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("lead.jsonl");
        let text: String = entries.iter().map(|e| format!("{e}\n")).collect();
        std::fs::write(&path, text).unwrap();
        path
    }

    fn hook(
        a: &Activities,
        event: Event,
        at: i64,
        subject: Option<&str>,
    ) -> agent_activity::Activity {
        a.record(
            "master",
            Report {
                event,
                at,
                subject,
                conversation: Some("c"),
                transcript: None,
            },
        )
    }

    const MIN: i64 = 60_000;
    const T0: i64 = 1_793_498_400_000; // 2026-11-01T02:00:00Z

    fn started(at: &str, result: serde_json::Value) -> serde_json::Value {
        json!({"type": "user", "timestamp": at, "toolUseResult": result})
    }

    fn ended(id: &str) -> serde_json::Value {
        json!({"type": "user", "message": {"content": format!(
            "<task-notification>\n<task-id>{id}</task-id>\n<status>completed</status>\n</task-notification>"
        )}})
    }

    /// The pane as its hooks left it: a nudge turn ran after the turn that
    /// started the background builder, which strips `children`.
    fn nudged_master() -> agent_activity::Activity {
        let a = Activities::new();
        hook(&a, Event::PromptSubmitted, T0, None);
        hook(&a, Event::SubagentStarted, T0 + 100, Some("a0builder"));
        hook(&a, Event::Stopped, T0 + 2 * MIN, None);
        hook(&a, Event::PromptSubmitted, T0 + 3 * MIN, None);
        hook(&a, Event::Stopped, T0 + 4 * MIN, None)
    }

    fn launches() -> Vec<serde_json::Value> {
        vec![
            started(
                "2026-11-01T02:00:00.000Z",
                json!({"isAsync": true, "status": "async_launched", "agentId": "a0builder"}),
            ),
            started(
                "2026-11-01T02:00:01.000Z",
                json!({"stdout": "", "backgroundTaskId": "b4gate"}),
            ),
            json!({"type": "system", "subtype": "turn_duration"}),
        ]
    }

    fn read(seen: Option<&agent_activity::Activity>, path: &std::path::Path, now: i64) -> TurnRead {
        turn_of(seen, Some(path), &background_of(Some(path)), now)
    }

    /// ISS-858's plant: a direct-mode master starts a background builder and a
    /// background shell, ends its turn, is nudged into a second turn that ends
    /// too. Both children are still running, so its turn is not over; once
    /// both have ended, it is.
    #[test]
    fn a_master_whose_background_children_run_is_not_read_as_ended() {
        let seen = nudged_master();
        assert_eq!(seen.doing(), agent_activity::Doing::Idle);
        let mut entries = launches();
        let path = transcript("running", &entries);
        let held = read(Some(&seen), &path, T0 + 10 * MIN);
        let TurnRead::InTurn(what) = &held else {
            panic!("a master with a background builder and a background shell running was read {held:?}");
        };
        assert!(
            what.contains("agent a0builder") && what.contains("shell b4gate"),
            "{what}"
        );

        entries.push(ended("b4gate"));
        let path = transcript("running", &entries);
        let held = read(Some(&seen), &path, T0 + 11 * MIN);
        assert!(
            matches!(&held, TurnRead::InTurn(w) if w.starts_with("1 background") && w.contains("a0builder")),
            "{held:?}"
        );

        entries.push(ended("a0builder"));
        let path = transcript("running", &entries);
        assert_eq!(read(Some(&seen), &path, T0 + 12 * MIN), TurnRead::Ended);
    }

    /// A pane unheard since this daemon started reads its children from its
    /// transcript alone, as it reads its turn.
    #[test]
    fn an_unheard_pane_is_held_by_the_children_its_transcript_names() {
        let path = transcript("unheard", &launches());
        assert!(matches!(read(None, &path, T0 + MIN), TurnRead::InTurn(_)));
    }

    /// A child whose end was never read holds its pane up to the ceiling from
    /// its start, and no further.
    #[test]
    fn a_child_whose_end_is_never_read_holds_until_the_ceiling_and_then_not() {
        let seen = nudged_master();
        let path = transcript("ceiling", &launches());
        let ceiling = i64::try_from(BACKGROUND_END_CEILING.as_millis()).unwrap();
        assert!(matches!(
            read(Some(&seen), &path, T0 + ceiling - MIN),
            TurnRead::InTurn(w) if w.contains("BACKGROUND_END_CEILING")
        ));
        assert_eq!(
            read(Some(&seen), &path, T0 + 2 * MIN + ceiling),
            TurnRead::Ended
        );
    }

    /// A transcript that cannot be read is no evidence that nothing runs:
    /// the pane is held, said as unreadable, up to the ceiling past its turn.
    #[test]
    fn an_unreadable_transcript_holds_the_pane_said_as_unread_up_to_the_ceiling() {
        let seen = nudged_master();
        let gone: BackgroundRead = Err("lead.jsonl: No such file or directory".into());
        let after_turn = T0 + 4 * MIN;
        let held = turn_of(Some(&seen), None, &gone, after_turn + MIN);
        assert!(
            matches!(&held, TurnRead::InTurn(w) if w.starts_with("cannot read whether")),
            "{held:?}"
        );
        let ceiling = i64::try_from(BACKGROUND_END_CEILING.as_millis()).unwrap();
        assert_eq!(
            turn_of(Some(&seen), None, &gone, after_turn + ceiling),
            TurnRead::Ended
        );
    }

    /// The hooks' own child, with no transcript line naming it, holds too;
    /// a transcript end for it releases it.
    #[test]
    fn a_hook_child_holds_until_its_transcript_says_it_ended() {
        let seen = nudged_master();
        let path = transcript(
            "hookchild",
            &[json!({"type": "system", "subtype": "turn_duration"})],
        );
        assert!(
            matches!(read(Some(&seen), &path, T0 + 5 * MIN), TurnRead::InTurn(w) if w.contains("subagent a0builder"))
        );
        // Appended, as Claude Code writes it.
        let turn_end = json!({"type": "system", "subtype": "turn_duration"});
        let path = transcript("hookchild", &[turn_end, ended("a0builder")]);
        assert_eq!(read(Some(&seen), &path, T0 + 6 * MIN), TurnRead::Ended);
    }
}
