//! What this box can see about one project's master, gathered for core's
//! verdict (ADR 0009, What core takes over: Placement and Retirement).
//!
//! Every function here reads; none decides. The rules that turn these facts
//! into place, keep, leave, replace, retire or withhold are core's
//! `masters/verdict.ts`, and the box acts on the answer in `obey.rs`.

use super::*;
use runner_transport::master_verdict as wire;

/// The facts that need local detail kept beside them, so the box can say what
/// core decided in the words its own records use.
pub(crate) struct Seen {
    pub(crate) standing: StandingRead,
    pub(crate) pane_name: String,
    pub(crate) pane_alive: bool,
    pub(crate) stored_conversation: Option<String>,
    pub(crate) elsewhere: Option<(String, Option<String>, subagent_host::Running)>,
    /// The pane up for this project, as this box serves it: `None` where none is up.
    pub(crate) adopted: Option<Adopted>,
    /// Read only where a pane is up; a placement reads its own.
    pub(crate) servers: Option<ServersRead>,
    pub(crate) restarting: Option<String>,
    pub(crate) last_said: Option<master_limit::Decisive>,
    pub(crate) digest: u64,
}

/// A pane found up, registered with core, and what this box can say about
/// whether it can hear it.
pub(crate) struct Adopted {
    pub(crate) session: master_api::MasterSession,
    pub(crate) capability: Capability,
    pub(crate) incarnation: Option<String>,
}

pub(crate) fn standing_wire(read: &StandingRead) -> &'static str {
    match read {
        StandingRead::Unreadable(_) => "unreadable",
        StandingRead::Known(s) if s.as_ref().is_some_and(MasterStanding::stands) => "stood_down",
        StandingRead::Known(_) => "proceed",
    }
}

impl Capability {
    pub(crate) fn wire(&self) -> &'static str {
        match self {
            Capability::Current => "current",
            Capability::Stale => "stale",
            Capability::Unknown(_) => "unknown",
        }
    }
}

impl SinceNudge {
    pub(crate) fn wire(self) -> &'static str {
        match self {
            SinceNudge::Unreported => "unreported",
            SinceNudge::NoTurn => "no_turn",
            SinceNudge::Working => "working",
            SinceNudge::AwaitingPermission => "awaiting_permission",
            SinceNudge::Failed => "failed",
            SinceNudge::Ran => "ran",
        }
    }
}

/// Whether the transcript of `conversation`, run in `repo`, is where Claude
/// Code keeps one under `home` (this user's own where `None`).
pub(crate) fn transcript_wire(
    home: Option<&std::path::Path>,
    repo: &std::path::Path,
    conversation: Option<&str>,
) -> &'static str {
    match conversation
        .filter(|c| !c.is_empty())
        .map(|id| transcript_at(home, repo, id))
    {
        Some(Some(path)) if path.is_file() => "present",
        Some(None) => "unlocatable",
        _ => "absent",
    }
}

/// The conversation a pane last exited over, still running as a background
/// session, where it is the one this project would resume. A process table
/// that reads it gone clears the record, so the next placement may resume it.
pub(crate) fn elsewhere_of(
    masters: &Masters,
    project_id: &str,
    stored: Option<&str>,
    hosts: &dyn subagent_host::Hosts,
) -> Option<(String, Option<String>, subagent_host::Running)> {
    let conversation = masters
        .elsewhere(project_id)
        .filter(|c| stored == Some(c.as_str()))?;
    let short = masters.elsewhere_short(project_id);
    match hosts.running(&conversation) {
        subagent_host::Running::Absent => {
            tracing::info!(
                "[master] {project_id}: no process on this box names conversation {conversation} any more, so its background session has ended"
            );
            masters.clear_elsewhere(project_id);
            None
        }
        running => Some((conversation, short, running)),
    }
}

fn elsewhere_wire(seen: &Seen) -> &'static str {
    match seen.elsewhere.as_ref().map(|(_, _, r)| r) {
        None | Some(subagent_host::Running::Absent) => "none",
        Some(subagent_host::Running::Found(_)) => "running",
        Some(subagent_host::Running::Unreadable) => "unreadable",
    }
}

/// What the pane's build, its runs and its turn say, read off the ledger and
/// its hooks: `None` where the pane is current or cannot be judged. The
/// ledger's `outdated` column is written to match either way.
pub(crate) fn outdated_facts(
    led: &Ledger,
    masters: &Masters,
    activity: &agent_activity::Activities,
    pane_name: &str,
    resolved: &crate::dispatch::Resolved,
    project_id: &str,
) -> Option<(String, wire::Holding, wire::Turn)> {
    let slug = &resolved.slug;
    let row = match led.master_for_project(project_id) {
        Ok(row) => row,
        Err(e) => {
            tracing::warn!(
                "[master] {slug}: cannot read {pane_name}'s placement back from the ledger ({e}), so whether it is outdated is not judged this sweep"
            );
            return None;
        }
    };
    let now = master_build::Standing::this_box(&resolved.repo_path);
    let why = match master_build::judge(row.as_ref(), &now) {
        Judged::Current => {
            if row.as_ref().is_some_and(|r| r.outdated.is_some()) {
                let _ = led.note_master_outdated(project_id, None);
            }
            masters.note_outdated(project_id, None);
            return None;
        }
        Judged::Outdated(why) => why,
    };
    if row.as_ref().and_then(|r| r.outdated.as_deref()) != Some(why.as_str()) {
        if let Err(e) = led.note_master_outdated(project_id, Some(&why)) {
            tracing::warn!(
                "[master] {slug}: {pane_name} is outdated ({why}) and the verdict could not be written for `forge-runner master status`: {e}"
            );
        }
    }
    let served = masters.get(project_id).map(|(session, _)| session);
    let recorded = row.as_ref().and_then(|r| r.session_id.clone());
    let holding = match (served.as_deref(), recorded.as_deref()) {
        (Some(served), Some(recorded)) if served != recorded => Holding::Unknown(format!(
            "its ledger row names session {recorded} and this box serves it as {served}, so the runs either one names are not all it holds; the sweep writes the row before it judges again"
        )),
        _ => master_exit::holding(led, row.as_ref()).unwrap_or_else(|e| {
            Holding::Unknown(format!(
                "the ledger could not be read ({e}), so which runs it holds is not known"
            ))
        }),
    };
    let seen = served.or(recorded).and_then(|s| activity.get(&s));
    let transcript = seen
        .as_ref()
        .and_then(|a| a.transcript.clone())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            row.as_ref()
                .and_then(|r| r.conversation_id.as_deref())
                .and_then(|c| conversation_transcript(&resolved.repo_path, c))
        });
    Some((
        why,
        holding_wire(&holding),
        turn_wire(turn_of(seen.as_ref(), transcript.as_deref())),
    ))
}

fn holding_wire(holding: &Holding) -> wire::Holding {
    let name = |r: &master_exit::HeldRun| format!("{} ({})", r.run_id, r.issues.join(", "));
    match holding {
        Holding::Nothing => wire::Holding::Nothing,
        Holding::Unknown(why) => wire::Holding::Unknown { why: why.clone() },
        Holding::These(runs) => wire::Holding::These {
            runs: runs
                .iter()
                .map(|r| wire::HeldRun {
                    name: name(r),
                    subagent: r.subagent.wire().into(),
                })
                .collect(),
        },
    }
}

fn turn_wire(turn: TurnRead) -> wire::Turn {
    match turn {
        TurnRead::Ended => wire::Turn::Ended,
        TurnRead::InTurn(what) => wire::Turn::InTurn {
            what: what.to_string(),
        },
        TurnRead::Unknown => wire::Turn::Unknown,
    }
}

/// How long the project has had no work, what its pane last reported, and
/// what became of the runs it declared.
pub(crate) fn idle_facts(
    ledger: Option<&Ledger>,
    masters: &Masters,
    activity: &agent_activity::Activities,
    project_id: &str,
) -> wire::Idle {
    let now_ms = agent_activity::now_ms();
    let ago = |at_ms: i64| u64::try_from(now_ms.saturating_sub(at_ms) / 1000).unwrap_or(0);
    let session = masters.get(project_id).map(|(s, _)| s);
    let pane = session
        .as_deref()
        .and_then(|s| activity.get(s))
        .map(|a| wire::IdlePane {
            doing: a.doing().wire(),
            last_event: a.last_event.wire().to_string(),
            last_event_ago_seconds: ago(a.last_event_at),
        });
    let children = match (ledger, session.as_deref()) {
        (Some(led), Some(s)) => master_exit::children(led, s).unwrap_or_else(|e| {
            tracing::warn!(
                "[master] {project_id}: ledger unreadable ({e}) — its runs are reported unfinished"
            );
            vec![master_exit::Child {
                run_id: format!("unreadable ledger: {e}"),
                closed: false,
                closed_at: None,
            }]
        }),
        _ => Vec::new(),
    };
    wire::Idle {
        no_work_for_seconds: ledger
            .and(masters.idle_for(project_id))
            .map(|d| d.as_secs()),
        pane,
        children: wire::Children {
            total: children.len(),
            unfinished: children
                .iter()
                .filter(|c| !c.closed)
                .map(|c| c.run_id.clone())
                .collect(),
            last_closed_ago_seconds: children
                .iter()
                .filter_map(|c| c.closed_at)
                .max()
                .map(|at| ago(at.saturating_mul(1000))),
        },
    }
}

/// The box's own record of its last nudge, and what the pane did after it.
pub(crate) fn nudge_facts(
    masters: &Masters,
    project_id: &str,
    digest: u64,
    seen: Option<&agent_activity::Activity>,
) -> wire::NudgeFacts {
    let last = masters.last_nudge(project_id);
    wire::NudgeFacts {
        digest: digest.to_string(),
        last: last.map(|n| wire::LastNudge {
            digest: n.digest.to_string(),
            ago_seconds: n.at.elapsed().as_secs(),
        }),
        since: since_nudge(seen, last.and_then(|n| n.prompts)).wire(),
    }
}

/// The newest refusal in the pane's own conversation, and what its hooks say
/// against it: whether it holds the pane is core's (`masters/verdict.ts:limitHeld`).
pub(crate) fn limit_facts(
    newest: Option<&master_limit::Decisive>,
    conversation: Option<&str>,
    seen: Option<&agent_activity::Activity>,
    now_ms: i64,
) -> wire::Limit {
    let ago = |at_ms: i64| u64::try_from(now_ms.saturating_sub(at_ms)).unwrap_or(0);
    let refusal = newest.and_then(|d| match &d.verdict {
        master_limit::Verdict::Refused(r) => Some(wire::LimitRefusal {
            reason: r.reason.wire(),
            ago_ms: ago(d.at.saturating_mul(1000) + i64::from(d.millis)),
        }),
        _ => None,
    });
    let heard = seen.and_then(|s| s.conversation.as_deref());
    let hooks = match (heard, conversation) {
        (Some(heard), Some(read)) if heard != read => "other",
        (Some(_), Some(_)) => "same",
        _ => "unheard",
    };
    wire::Limit {
        refusal,
        hooks,
        turn_started_ago_ms: seen.and_then(|s| s.turn_started_at).map(ago),
    }
}

/// The work core answered this box this sweep, counted.
pub(crate) struct Answered<'a> {
    pub(crate) admissible: &'a [AdmissibleIssue],
    pub(crate) inbox: &'a [UnansweredDocument],
    pub(crate) pool_waits: bool,
    pub(crate) job_panes: usize,
}

/// Every fact core's verdict reads, as one request body.
pub(crate) fn facts_of(
    seen: &Seen,
    answered: &Answered<'_>,
    judged: Option<(String, wire::Holding, wire::Turn)>,
    idle: wire::Idle,
    limit: wire::Limit,
    nudge: wire::NudgeFacts,
    repo: &std::path::Path,
) -> wire::Facts {
    let (outdated, holding, turn) = match judged {
        Some((why, holding, turn)) => (Some(why), holding, turn),
        None => (None, wire::Holding::Nothing, wire::Turn::Unknown),
    };
    wire::Facts {
        restarting: seen.restarting.clone(),
        terminal: terminal::available(),
        standing: standing_wire(&seen.standing),
        pane: if seen.pane_alive { "alive" } else { "absent" },
        capability: seen.adopted.as_ref().map(|a| a.capability.wire()),
        servers_readable: seen.servers.as_ref().map(std::result::Result::is_ok),
        work: wire::Work {
            admissible: answered.admissible.len(),
            owed: answered.inbox.len(),
            pool_waits: answered.pool_waits,
            job_panes: answered.job_panes,
        },
        conversation: wire::Conversation {
            id: seen.stored_conversation.clone(),
            transcript: transcript_wire(None, repo, seen.stored_conversation.as_deref()),
            elsewhere: elsewhere_wire(seen),
        },
        outdated,
        holding,
        turn,
        idle,
        limit,
        nudge,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runner_core::agent_activity::{Activities, Event, Report};

    const T0: i64 = 1_791_280_800;

    fn refused_at(at: i64, millis: u32) -> master_limit::Decisive {
        let line = format!(
            r#"{{"type":"assistant","isApiErrorMessage":true,"apiErrorStatus":429,"error":"rate_limit","timestamp":"2026-10-06T10:00:00.{millis:03}Z","uuid":"r","message":{{"model":"<synthetic>","content":[]}},"quotaLimits":{{"status":"rejected","resetsAt":{}}}}}"#,
            at + 3600
        );
        master_limit::newest_record(&line, at).expect("a refusal record reads")
    }

    /// The box reports the refusal and the hooks raw; whether they hold the
    /// pane is `masters/verdict.ts:limitHeld`.
    #[test]
    fn a_refusal_is_reported_with_its_age_and_whose_conversation_the_hooks_name() {
        let newest = refused_at(T0, 250);
        let a = Activities::new();
        let seen = a.record(
            "s",
            Report {
                event: Event::PromptSubmitted,
                at: (T0 + 10) * 1000,
                subject: None,
                conversation: Some("c1"),
                transcript: None,
            },
        );
        let now = (T0 + 60) * 1000;
        let limit = limit_facts(Some(&newest), Some("c1"), Some(&seen), now);
        let refusal = limit.refusal.expect("the refusal was not reported");
        assert_eq!(refusal.reason, "usage_limit");
        assert_eq!(refusal.ago_ms, 59_750);
        assert_eq!(limit.hooks, "same");
        assert_eq!(limit.turn_started_ago_ms, Some(50_000));
        assert_eq!(
            limit_facts(Some(&newest), Some("c2"), Some(&seen), now).hooks,
            "other"
        );
        assert_eq!(limit_facts(None, None, None, now).hooks, "unheard");
    }
}
