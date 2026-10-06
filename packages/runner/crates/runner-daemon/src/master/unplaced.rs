use super::*;

#[derive(Default, Clone, PartialEq, Eq)]
pub(crate) enum Served {
    /// No sweep has read the list yet.
    #[default]
    Unread,
    /// The last read failed, and this is what it said.
    Unreadable(String),
    /// The project ids core last answered for this device.
    Read(Vec<String>),
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum Unplaced {
    /// The runner row refuses new work, so this sweep placed no pane for it.
    Draining {
        status: String,
    },
    /// This daemon is inside a handover's closing window, so it admits no new
    /// work for any project for the seconds that takes (ISS-1379).
    Restarting {
        cause: String,
    },
    /// Core serves this project to this box but nothing here says where the
    /// checkout is.
    NoRepoPath,
    /// This box has no terminal multiplexer, so it can host no master at all.
    NoTerminal,
    /// Core refused the registration this pane's identity comes from.
    RegisterFailed {
        detail: String,
    },
    /// The pane could not be given the skill it runs on, so none was started.
    SkillMissing {
        detail: String,
    },
    NothingAdmissible,
    /// An owner stood this project's master down, so this box places none
    /// until somebody stands it up again (ISS-1118).
    ///
    /// `pane` is the session running against that stand-down, where one is.
    /// It is part of the value rather than a second map because the two states
    /// are two different things to tell an operator, and a value that cannot
    /// tell them apart cannot report the move from one to the other either.
    StoodDown {
        by: String,
        why: Option<String>,
        slug: String,
        pane: Option<String>,
    },
    /// This box could not read whether its owner stood this project down, so
    /// it placed nothing rather than deciding it was driving.
    StandingUnreadable {
        detail: String,
    },
    /// A pane is up for this project and this box cannot hear it: the
    /// capability it holds names a session core has since replaced, so every
    /// declaration it makes is refused (ISS-1099).
    ///
    /// The pane is placed and the project still has no working master, which is
    /// why this is an `Unplaced` reason and not a state of the pane. The record
    /// exists so the sweep that learns it does not leave the registry saying
    /// nothing: the landed change cleared this map on exactly this path, at the
    /// moment the daemon found out.
    ///
    /// Its one reader is `run_declare`, so the only thing that ever sees this
    /// sentence is the pane itself — which is inside tmux and reaches the
    /// runner's own server through `$TMUX`. That is why a bare `tmux
    /// kill-session` is the right remedy HERE and the wrong one on
    /// `forge-runner master status`, where the reader is an operator in a shell
    /// of their own and the runner's socket is not the default server.
    StaleCapability {
        session: String,
        pane: String,
    },
    /// Core could not be asked which MCP servers this project declares, so no
    /// pane was started: one started now would carry none of them and no
    /// record would say why (ISS-1235). `detail` names the route and what it
    /// met.
    ServersUnreadable {
        detail: String,
    },
    /// The project declares MCP servers and the file handing them to a pane
    /// could not be written into `dir`, so no pane was started for the same
    /// reason. `dir` is what an operator has to make writable.
    ServersUnwritable {
        detail: String,
        dir: std::path::PathBuf,
    },
    /// Everything before the pane was in place and the capability it would
    /// carry could not be minted, so no pane was started: one without it has
    /// every declaration refused.
    CapabilityUnminted {
        detail: String,
    },
    /// Everything was in place and tmux did not start the pane.
    PaneUnstarted {
        detail: String,
    },
    /// The pane last placed for this project resumed its conversation and
    /// exited, printing that Claude Code runs that conversation as a
    /// background session under the id `short`; `pid` is a process on this
    /// box naming it now. A pane placed again would exit the same way
    /// (ISS-1312, F1).
    ConversationElsewhere {
        conversation: String,
        short: Option<String>,
        pid: u32,
    },
    /// As [`Unplaced::ConversationElsewhere`], where this box could not read
    /// its process table to tell whether a process still names that
    /// conversation. Not knowing is not its end (ISS-1312, F1).
    ConversationUnaskable {
        conversation: String,
        short: Option<String>,
    },
    /// Core withheld a pane for a reason this build has no record of its own
    /// for, said as core said it (ADR 0009, What core takes over: Placement).
    Withheld {
        reason: String,
        because: String,
    },
    /// Core could not be asked what to do about this project's master, so the
    /// box placed, ended and nudged nothing: it holds no answer of its own.
    VerdictUnanswered {
        detail: String,
    },
}

impl std::fmt::Display for Unplaced {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Draining { status } => write!(
                f,
                "this box's runner for it is `{status}`, so it starts no work and places no master until that changes"
            ),
            Self::Restarting { cause } => write!(
                f,
                "this box is handing over to a new build ({cause}), so it starts no work and places no master for any project for the seconds that takes; the new build does"
            ),
            Self::NoRepoPath => write!(
                f,
                "core serves it to this box but nothing here says where its checkout is — bind it, or set the runner's repo_path"
            ),
            Self::NoTerminal => write!(
                f,
                "this box has no tmux, so it can host no master pane for any project"
            ),
            Self::RegisterFailed { detail } => write!(
                f,
                "core refused this box's master registration for it: {detail}"
            ),
            Self::SkillMissing { detail } => write!(
                f,
                "the forge-master skill could not be installed into its checkout: {detail}"
            ),
            Self::NothingAdmissible => write!(
                f,
                "it has nothing claimable and no pane of its own running, so this box started none"
            ),
            Self::StoodDown {
                by,
                why,
                slug,
                pane,
            } => stood_down_said(f, by, why.as_deref(), slug, pane.as_deref()),
            Self::StandingUnreadable { detail } => write!(
                f,
                "this box cannot read whether its owner stood this project down ({detail}), so it places no master rather than deciding it is driving. A box that cannot tell a stood-down project from a driving one must not decide it is driving"
            ),
            Self::ServersUnreadable { detail } => write!(
                f,
                "this box could not read which MCP servers this project declares ({detail}), so it started no master rather than one carrying none of them. The next sweep whose read succeeds places one"
            ),
            Self::ServersUnwritable { detail, dir } => write!(
                f,
                "it declares MCP servers and the file that hands them to a pane could not be written into {} ({detail}), so this box started no master rather than one carrying none of them. Make {} writable and the next sweep starts one",
                dir.display(),
                dir.display()
            ),
            Self::CapabilityUnminted { detail } => write!(
                f,
                "the control capability its pane would carry could not be minted ({detail}), so this box started no master rather than one whose every declaration is refused"
            ),
            Self::PaneUnstarted { detail } => write!(
                f,
                "everything it needs was in place and the pane itself did not start ({detail})"
            ),
            Self::ConversationElsewhere {
                conversation,
                short,
                pid,
            } => write!(
                f,
                "the pane this box last placed for it resumed conversation {conversation} and exited, printing that Claude Code runs that conversation as a background session{}, and process {pid} on this box names it now. A pane placed again would exit the same way, so none is placed while a process names that conversation. {WAITS_NOT_FORKS} {}, and once no process names it a pane resuming it is placed on the next sweep whose other gates admit one",
                short_said(short.as_deref()),
                pane_exit::remedy(conversation, short.as_deref())
            ),
            Self::ConversationUnaskable {
                conversation,
                short,
            } => write!(
                f,
                "the pane this box last placed for it resumed conversation {conversation} and exited, printing that Claude Code runs that conversation as a background session{}, and this box cannot read its process table to tell whether one still does. A pane placed again would exit the same way while it does, so none is placed until a sweep reads the whole table and finds no process naming it, or this daemon restarts and forgets the exit. {WAITS_NOT_FORKS} {}",
                short_said(short.as_deref()),
                pane_exit::remedy(conversation, short.as_deref())
            ),
            Self::Withheld { reason, because } => write!(
                f,
                "core withheld a master for it ({reason}): {because}"
            ),
            Self::VerdictUnanswered { detail } => write!(
                f,
                "core could not be asked what to do about its master ({detail}), so this box placed, ended and nudged nothing — it decides none of that itself. The next sweep whose verdict reads acts on it"
            ),
            Self::StaleCapability { session, pane } => write!(
                f,
                "its pane {pane} is up but this box cannot hear it — the capability that pane holds names a session core has since replaced, core's session for it is now {session}, and a running pane cannot be handed a new capability. Every declaration it makes is refused and it is not being nudged while it stands like this. `tmux kill-session -t {pane}` ends it, which is what lets a master carrying the current capability be placed — placement itself still answers to the same gates as any other"
            ),
        }
    }
}

/// A stand-down, said with who took it, why, and what an operator does about
/// the pane running against it where one is.
fn stood_down_said(
    f: &mut std::fmt::Formatter<'_>,
    by: &str,
    why: Option<&str>,
    slug: &str,
    pane: Option<&str>,
) -> std::fmt::Result {
    // Always a reason in parentheses, never an absent one. A line
    // that says only who stood it down reads as a stand-down whose
    // reason the reader has not found yet, rather than one that was
    // never recorded — and telling those two apart is the whole of
    // ISS-1238.
    write!(
        f,
        "its master was stood down by {by} ({})",
        why.unwrap_or(MasterStanding::NO_REASON)
    )?;
    match pane {
                    None => write!(
                        f,
                        " — this box places none for it and nudges none. `forge-runner master stand-up {slug}` is the one act that lets it be placed again"
                    ),
                    Some(pane) => write!(
                        f,
                        " — nothing here adopts it as this box's master, nudges it or ends it. Either `tmux kill-session -t {pane}` to make the box's two answers agree, or `forge-runner master stand-up {slug}` to put the project back under this box's authority"
                    ),
                }
}

/// Why a held conversation is waited out rather than forked, said wherever
/// the wait is.
// the deliberate choice ISS-1343 asks to be named. `--fork-session` would start a pane at once, and as a second conversation for this project while the first still runs as a background session that can still claim, dispatch and write; two masters for one project is the failure this box is built to prevent, so it waits and says so.
pub(crate) const WAITS_NOT_FORKS: &str = "This box waits for that session to end rather than starting a pane with `--fork-session`: a fork is a second conversation for this project while the first still runs and can still act.";

/// The short id a background-session refusal printed, as a parenthesis.
pub(crate) fn short_said(short: Option<&str>) -> String {
    short.map(|s| format!(" ({s})")).unwrap_or_default()
}

impl Unplaced {
    /// What to say before the reason.
    ///
    /// Every reason but one is a report that no pane was placed. The
    /// contradiction is a report that one IS running and this box will not
    /// drive it, and leading that with "no master pane placed" states the
    /// opposite of what an operator finds on the box (ISS-1118 criterion 20).
    pub(crate) fn lead(&self) -> String {
        match self {
            Self::StoodDown {
                pane: Some(pane), ..
            } => format!("{pane} is RUNNING and this box is not driving it"),
            Self::StaleCapability { pane, .. } => {
                format!("{pane} is RUNNING and this box cannot be heard by it")
            }
            _ => "no master pane placed".to_string(),
        }
    }

    /// Whether this is a state an operator has to act on before the box's two
    /// answers agree.
    ///
    /// A pane running against a stand-down is the nine-hour silence ISS-1118
    /// was filed over; a standing this box could not read is a box that cannot
    /// say what it is doing; a pane whose capability is stale is the four-hour
    /// silence ISS-1099 was filed over, and no sweep resolves it. The four that
    /// refuse a start the project wanted — its servers unreadable or
    /// unwritable, its capability unminted, its pane unstarted — leave it with
    /// no master for a fault on this box. Everything else here is a pane absent
    /// for a reason the box is content with.
    pub(crate) fn is_error(&self) -> bool {
        matches!(
            self,
            Self::StoodDown { pane: Some(_), .. }
                | Self::StandingUnreadable { .. }
                | Self::StaleCapability { .. }
                | Self::ServersUnreadable { .. }
                | Self::ServersUnwritable { .. }
                | Self::CapabilityUnminted { .. }
                | Self::PaneUnstarted { .. }
                | Self::ConversationElsewhere { .. }
                | Self::ConversationUnaskable { .. }
                | Self::VerdictUnanswered { .. }
        )
    }
}

/// What this sweep could establish about one project's standing.
///
/// Three values and not two. Folding "the ledger could not be asked" into "no
/// stand-down" is what would let a box whose ledger is unreadable place the
/// very pane its owner withheld, and it would do it in silence.
pub(crate) enum StandingRead {
    /// The ledger answered, with a row or with nothing.
    Known(Option<MasterStanding>),
    /// It could not be asked, or it refused, and this is what to say.
    Unreadable(String),
}

pub(crate) fn read_standing(ledger: Option<&Ledger>, project_id: &str) -> StandingRead {
    let Some(led) = ledger else {
        return StandingRead::Unreadable(
            "this box's ledger could not be opened at all, so nothing here can say what its owner decided about this project".into(),
        );
    };
    match led.master_standing(project_id) {
        Ok(row) => StandingRead::Known(row),
        Err(e) => StandingRead::Unreadable(format!("the standing could not be read: {e}")),
    }
}

/// A stand-down, said with who took it and why, and the pane running against
/// it where one is.
pub(crate) fn stood_down_reason(
    standing: Option<&MasterStanding>,
    slug: &str,
    pane: Option<&str>,
) -> Unplaced {
    Unplaced::StoodDown {
        by: standing.map_or_else(|| "somebody".to_string(), |s| s.stood_down_by.clone()),
        why: standing.and_then(|s| s.why.clone()),
        slug: slug.to_string(),
        pane: pane.map(str::to_string),
    }
}

/// What a pane placed after a lifted stand-down is told about the episode it
/// is following.
///
/// The interval alone was what this carried until ISS-1238, and an interval
/// says a gap happened without saying what the gap was for. The two reasons
/// travel with it because the pane is the one reader who was not there.
pub(crate) struct Lifted {
    /// Which episode this is, so the one a pane is told about is the one
    /// stamped told and no other.
    pub episode: i64,
    pub held_for: Duration,
    /// The reason recorded on the way down, or `None` on an episode written
    /// before a reason was required.
    pub why: Option<String>,
    /// The argument the lift was taken on, or `None` on an episode lifted
    /// before one was required.
    pub lifted_on: Option<String>,
}

/// The lifted episode a pane placed now has to be told about, where there is
/// one.
///
/// `None` while it still stands, `None` once a pane has been told — being told
/// is what spends it, and telling the next pane the same gap again is the same
/// defect as never telling the first — and `None` on a row whose two stamps
/// cannot make an interval, because a clock that went backwards is not a fact
/// to tell a master.
pub(crate) fn lifted_from(standing: &MasterStanding) -> Option<Lifted> {
    if standing.told_at.is_some() {
        return None;
    }
    let up = standing.stood_up_at?;
    let held_for = u64::try_from(up - standing.stood_down_at)
        .ok()
        .map(Duration::from_secs)?;
    Some(Lifted {
        episode: standing.episode,
        held_for,
        why: standing.why.clone(),
        lifted_on: standing.stood_up_why.clone(),
    })
}
