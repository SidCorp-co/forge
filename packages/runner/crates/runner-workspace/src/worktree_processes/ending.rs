use super::*;

/// Why a resident is still standing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Why {
    /// This process, or one of its own ancestors. It was never signalled: a
    /// daemon whose cwd is inside a tree it is reaping means the reading is
    /// wrong, and a reaper that kills its own supervisor turns a disk sweep
    /// into an outage.
    OurOwn,
    /// The pid was handed to another process between the reading and the
    /// signal. It was never signalled: the process this box attributed is
    /// already gone, and the one holding the pid now was attributed to nothing.
    Moved,
    /// It was not in the reading this ending was taken over. It moved into the
    /// checkout, or was forked by a resident, while that resident was being
    /// ended — so every pid the ending knew about can be gone and somebody can
    /// still be living there.
    Arrived,
    /// Signalled with `SIGKILL` and still there when the grace was up.
    Survived,
    /// The kernel refused the signal, and what it said.
    Refused(String),
}

impl std::fmt::Display for Why {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Why::OurOwn => f.write_str(
                "it is this process or one of its own ancestors, which this box will not signal",
            ),
            Why::Moved => f.write_str(
                "its pid was handed to another process between the reading and the signal, so \
                 signalling it would reach something this box never attributed to anything",
            ),
            Why::Arrived => f.write_str(
                "it appeared in the checkout while this box was clearing it, so no reading this \
                 ending was taken over ever named it",
            ),
            Why::Survived => f.write_str("it was still there after SIGKILL"),
            Why::Refused(said) => write!(f, "the signal was refused: {said}"),
        }
    }
}

/// What became of the residents of a checkout about to be given back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ending {
    /// Nobody this box could ask about was living there, or everybody who was
    /// is gone.
    Clear {
        ended: Vec<Resident>,
        /// Pids this box was not allowed to ask about, carried so the line a
        /// removal writes says how complete its reading was.
        not_asked: usize,
    },
    /// This platform keeps no process table, so nothing was read and nothing
    /// signalled. The removal is no worse off than it was before this module.
    NoTable(String),
    /// The table is there and could not be read. Nothing was signalled, and
    /// nothing is claimed about who is living in the checkout.
    Unreadable(String),
    /// Residents this box could not end.
    Standing {
        standing: Vec<(Resident, Why)>,
        ended: Vec<Resident>,
        not_asked: usize,
    },
    /// Residents that run beneath a live Claude Code process: the checkout is
    /// that agent's work, whatever the ledger says about the run that held it,
    /// so nothing in it was signalled (ISS-1378).
    Live {
        /// Each such resident, and the Claude Code process it runs beneath.
        agents: Vec<(Resident, u32)>,
        /// Everybody else living there, left alone with them.
        others: Vec<Resident>,
        not_asked: usize,
    },
}

/// How loudly the line a removal owes arrives.
///
/// `warn` in this daemon's journal is where the stranded-process report lands,
/// which is the line this module exists to make readable. A level taken from
/// whether there is a line AT ALL puts every other kind there too — and
/// `not_asked` is never zero on a shared box: 837 of `sid-xeon-1`'s pids
/// belonged to another user the day this shipped, so every uneventful removal
/// warned, carrying a constant fact about the box rather than anything about
/// that removal. So the level is the verdict's own answer and turns on whether
/// anything HAPPENED, never on whether anything was said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Loud {
    /// Nothing was ended and nothing is owed a reader's attention. The line is
    /// the reading's own completeness, which is still said on every removal:
    /// a claim that a checkout is clear is only ever a claim about the pids
    /// this box was allowed to ask about.
    Routine,
    /// Something was ended, or the question could not be put on this platform
    /// at all. Both are about THIS removal, and both are what `warn` in this
    /// journal means.
    Notable,
}

/// The line a removal owes a reader, and how loudly it arrives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Say {
    pub loud: Loud,
    pub said: String,
}

impl Say {
    pub(crate) fn routine(said: String) -> Option<Self> {
        Some(Self {
            loud: Loud::Routine,
            said,
        })
    }

    pub(crate) fn notable(said: String) -> Option<Self> {
        Some(Self {
            loud: Loud::Notable,
            said,
        })
    }
}

/// What a removal may do about the checkout, and the one line it owes a reader
/// either way.
///
/// The decision is a value rather than four arms written twice, because both
/// removal routes owe the same answer and a reader has to be able to tell,
/// afterwards, which of the four a directory went or stayed under. A removal
/// taken without the reading looks in the journal exactly like one taken after
/// a clear reading, and those are not the same claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// The directory may be taken. `Some` is a line to say first, at the level
    /// it carries.
    Take(Option<Say>),
    /// It may not, and why.
    Refuse(String),
}

/// How a reading that could not ask about every pid says so.
///
/// Never omitted where the count is not zero: a line saying a checkout is clear
/// is a claim about every process on the box, and this reading is only ever a
/// claim about the ones the kernel would answer for.
pub(crate) fn unasked(n: usize) -> String {
    format!(
        "{n} pid(s) belong to another user, whose working directory this box is not allowed to \
         read and whose processes it could not signal either"
    )
}

/// The same, as a clause appended to a line that says something else first.
pub(crate) fn also(n: usize) -> String {
    match n {
        0 => String::new(),
        n => format!(" Also: {}.", unasked(n)),
    }
}

impl Ending {
    /// One sentence naming everything still standing, for the refusal that
    /// carries it.
    pub fn said(standing: &[(Resident, Why)]) -> String {
        standing
            .iter()
            .map(|(r, why)| format!("{r} — {why}"))
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// Whether the checkout at `at` may be taken now.
    pub fn verdict(&self, at: &Path) -> Verdict {
        match self {
            // Nothing was ended, and the directory goes: the uneventful case,
            // which on a shared box is every case. The reading's completeness
            // is still owed — a run of this box could not have started
            // another user's process, but a line saying the checkout is clear
            // is a claim about the whole table and this one asked part of it —
            // so it is said, and said where a routine fact belongs.
            Ending::Clear { ended, not_asked } if ended.is_empty() => match not_asked {
                0 => Verdict::Take(None),
                n => Verdict::Take(Say::routine(format!(
                    "nobody this box may ask about is living in {}, and {}",
                    at.display(),
                    unasked(*n)
                ))),
            },
            Ending::Clear { ended, not_asked } => Verdict::Take(Say::notable(format!(
                "ended {} process(es) living in {} before taking it — {}{}",
                ended.len(),
                at.display(),
                ended
                    .iter()
                    .map(Resident::to_string)
                    .collect::<Vec<_>>()
                    .join("; "),
                also(*not_asked)
            ))),
            Ending::NoTable(said) => Verdict::Take(Say::notable(format!(
                "who is living in {} cannot be asked on this platform ({said}) — the directory is \
                 taken anyway, and a process left standing in it would keep its port and its \
                 connections with nothing on this box naming it",
                at.display()
            ))),
            Ending::Unreadable(said) => Verdict::Refuse(format!(
                "who is living in {} could not be read ({said}) — the directory stays, because \
                 not knowing is not the same as knowing nobody is in it",
                at.display()
            )),
            Ending::Live {
                agents,
                others,
                not_asked,
            } => Verdict::Refuse(format!(
                "{} process(es) living in {} run beneath a live Claude Code process — {} — so the \
                 checkout is a live agent's work whatever the ledger says about the run that held \
                 it. Nothing in it was signalled, and the directory stays for as long as that \
                 agent lives{}{}",
                agents.len(),
                at.display(),
                agents
                    .iter()
                    .map(|(r, agent)| format!("{r}, beneath Claude Code pid {agent}"))
                    .collect::<Vec<_>>()
                    .join("; "),
                match others.as_slice() {
                    [] => ".".to_string(),
                    rest => format!(
                        ". Also living in it, and left alone with them: {}.",
                        rest.iter()
                            .map(Resident::to_string)
                            .collect::<Vec<_>>()
                            .join("; ")
                    ),
                },
                also(*not_asked)
            )),
            // What was ended is named here too, and not only what stands. A
            // refusal that printed the survivors alone would leave the
            // processes this box really did signal in no line anywhere, which
            // is the same silence the whole change exists to end (consult
            // 8064e5 F2).
            Ending::Standing {
                standing,
                ended,
                not_asked,
            } => Verdict::Refuse(format!(
                "{} process(es) are still running in {} — {}. {}{} The directory stays: it is the \
                 only thing left naming them",
                standing.len(),
                at.display(),
                Ending::said(standing),
                match ended.is_empty() {
                    true => "Nothing in it was ended.".to_string(),
                    false => format!(
                        "{} was ended first: {}.",
                        match ended.len() {
                            1 => "One process".to_string(),
                            n => format!("{n} processes"),
                        },
                        ended
                            .iter()
                            .map(Resident::to_string)
                            .collect::<Vec<_>>()
                            .join("; ")
                    ),
                },
                also(*not_asked)
            )),
        }
    }
}
