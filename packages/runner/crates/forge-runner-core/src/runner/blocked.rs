/*
 * The two ways a run stops being runnable, and the order each is armed in.
 *
 * A bounded wait keeps the process and gets a door (ISS-964 criteria 4, 5, 10);
 * an unbounded human wait releases the box and gets none, because the answer
 * reaches it through a revival rather than a ring. `nobody` reaches neither: it
 * is a failure with a name and it writes no question at all (criterion 6).
 */

use std::path::Path;

use crate::error::{Error, Result};
use crate::runner::doorbell::{self, Listening};
use crate::runner::ledger::{BlockerKind, Incarnation, Ledger};

#[derive(Debug, Clone, Copy)]
pub struct Wait<'a> {
    pub run_id: &'a str,
    pub question_id: &'a str,
    pub round: i64,
    pub blocker: BlockerKind,
    pub resume_id: Option<&'a str>,
    pub park_deadline_at: Option<i64>,
}

fn refuse_nobody(blocker: BlockerKind) -> Result<()> {
    if matches!(blocker, BlockerKind::Nobody) {
        return Err(Error::Other(
            "blocked: a `nobody` blocker terminates the run with a named reason and writes no question".into(),
        ));
    }
    Ok(())
}

pub fn arm_bounded(
    ledger: &mut Ledger,
    ledger_path: &Path,
    what: Wait<'_>,
) -> Result<(Listening, Incarnation)> {
    let Wait {
        run_id,
        question_id,
        round,
        blocker,
        resume_id,
        park_deadline_at,
    } = what;
    refuse_nobody(blocker)?;
    if matches!(blocker, BlockerKind::Human) {
        return Err(Error::Other(
            "blocked: a human wait is unbounded and releases the box — use `park_for_human`".into(),
        ));
    }
    ledger.begin_question(question_id, run_id, round, question_id)?;
    let ear = doorbell::listen(ledger_path, run_id)?;
    let incarnation =
        ledger.declare_blocked_live(run_id, blocker, resume_id, park_deadline_at, &ear)?;
    Ok((ear, incarnation))
}

pub const PROTECTIONS_FROM_CORE: [&str; 3] = [
    "park-exempt-residency",
    "park-exempt-oneshot",
    "answer-resume-park",
];

pub const PROTECTIONS_FROM_THIS_BUILD: [&str; 2] = ["worktree-reap-ledger", "recovery-park-exempt"];

#[derive(Debug)]
pub struct ParkPermit {
    granted: Vec<String>,
}

impl ParkPermit {
    pub fn from_advertisement(advertised: &[String]) -> Result<Self> {
        let missing: Vec<&str> = PROTECTIONS_FROM_CORE
            .iter()
            .copied()
            .filter(|name| !advertised.iter().any(|a| a == name))
            .collect();
        if !missing.is_empty() {
            return Err(Error::Other(format!(
                "park refused: core advertises no park protections [missing: {}] — the run keeps its process until it does",
                missing.join(", ")
            )));
        }
        let mut granted: Vec<String> = PROTECTIONS_FROM_CORE
            .iter()
            .map(|s| s.to_string())
            .collect();
        granted.extend(PROTECTIONS_FROM_THIS_BUILD.iter().map(|s| (*s).to_string()));
        Ok(Self { granted })
    }

    pub fn protections(&self) -> &[String] {
        &self.granted
    }
}

pub fn park_for_human(
    ledger: &mut Ledger,
    what: Wait<'_>,
    _permit: &ParkPermit,
) -> Result<Incarnation> {
    let Wait {
        run_id,
        question_id,
        round,
        blocker,
        resume_id,
        park_deadline_at,
    } = what;
    refuse_nobody(blocker)?;
    if !matches!(blocker, BlockerKind::Human) {
        return Err(Error::Other(format!(
            "blocked: `{blocker:?}` is a bounded wait that keeps the box — use `arm_bounded`"
        )));
    }
    ledger.begin_question(question_id, run_id, round, question_id)?;
    ledger.declare_parked_human(run_id, resume_id, park_deadline_at)
}
