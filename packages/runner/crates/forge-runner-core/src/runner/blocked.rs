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

/// What one run is about to wait for.
// cm:guard `blocker` rides WITH the wait rather than being a separate argument, because the branch each arm takes follows from it and the two are never chosen independently — a call that could name a wait without naming who resolves it is a call that could take the wrong branch (ISS-964 criteria 4, 5).
#[derive(Debug, Clone, Copy)]
pub struct Wait<'a> {
    pub run_id: &'a str,
    pub question_id: &'a str,
    pub round: i64,
    pub blocker: BlockerKind,
    pub resume_id: Option<&'a str>,
    pub park_deadline_at: Option<i64>,
}

// cm:guard `Nobody` is refused BEFORE any write, in both arms. Refusing after `begin_question` would leave the question row criterion 6 says must not exist, and a row nobody can answer is indistinguishable from a run that is merely slow (ISS-964 criteria 3, 6).
fn refuse_nobody(blocker: BlockerKind) -> Result<()> {
    if matches!(blocker, BlockerKind::Nobody) {
        return Err(Error::Other(
            "blocked: a `nobody` blocker terminates the run with a named reason and writes no question".into(),
        ));
    }
    Ok(())
}

/// Arm a bounded wait: ask, open the door, then declare — in that order.
// cm:guard the three steps run in exactly this order and the order is the whole point: the question row and `waiting_on` land in one local transaction, THEN the door opens for reading, and only then is the run declared blocked. Declaring first would tell a ringer somebody is listening while the door is shut, and that ring lands in a gap nothing reads (ISS-964 criterion 10).
// cm:guard `?` on `listen` is load-bearing: a door that cannot be opened leaves the run UNDECLARED and the error at the caller, never a run reading `live × blocked` with no ear. `a_door_that_cannot_open_leaves_the_run_runnable` is what holds it.
// cm:edge protocol -> packages/runner/crates/forge-runner-core/src/runner/doorbell.rs — the `Listening` returned here is the run's ear and the caller owns its lifetime; drop it and the next ring meets `ENXIO`.
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
    // cm:guard `waiting_on` IS the question id, not a description of it: every reader that asks "what is this run waiting for" joins on it, and a prose value there leaves the run visibly blocked on nothing anyone can fetch (ISS-964 criterion 10).
    ledger.begin_question(question_id, run_id, round, question_id)?;
    let ear = doorbell::listen(ledger_path, run_id)?;
    let incarnation =
        ledger.declare_blocked_live(run_id, blocker, resume_id, park_deadline_at, &ear)?;
    Ok((ear, incarnation))
}

/// Park for a human: ask, then declare the process gone. No door.
// cm:guard NO door is opened here, and adding one would be a lie the ledger then publishes: the process is about to exit, so the read fd dies with it and every ring after that meets `ENXIO` anyway. The human answer arrives by revival, not by ring (ISS-964 criteria 5, 7, 8).
pub fn park_for_human(ledger: &mut Ledger, what: Wait<'_>) -> Result<Incarnation> {
    let Wait {
        run_id,
        question_id,
        round,
        resume_id,
        park_deadline_at,
        ..
    } = what;
    ledger.begin_question(question_id, run_id, round, question_id)?;
    ledger.declare_parked_human(run_id, resume_id, park_deadline_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::doorbell::{ring, Ring};
    use crate::runner::ledger::{NewRun, Work};

    fn dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("blk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn run_on(led: &mut Ledger) {
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "p-1".into(),
            master_session_id: "master-1".into(),
            boot_id: "boot-a".into(),
            worktree_path: std::path::PathBuf::from("/tmp/wt"),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
    }

    // cm:guard THE falsifying case for criterion 10. Swap the open and the declaration in `arm_bounded` and this goes red: the run reads `live × blocked` while its door was never opened, so the next ring lands in a gap nothing reads and the answer is lost with the run still claiming to wait for it.
    #[test]
    fn a_door_that_cannot_open_leaves_the_run_runnable() {
        let d = dir();
        // a FILE where the doors directory must go, so `listen` cannot succeed
        std::fs::write(d.join("doors"), b"not a directory").unwrap();
        let mut led = Ledger::open_in_memory().unwrap();
        run_on(&mut led);

        let err = arm_bounded(
            &mut led,
            &d.join("ledger.sqlite"),
            Wait {
                run_id: "run-1",
                question_id: "q-1",
                round: 1,
                blocker: BlockerKind::Machine,
                resume_id: None,
                park_deadline_at: None,
            },
        )
        .expect_err("a door that cannot open must fail the arm");
        assert!(format!("{err}").contains("doorbell"), "{err}");

        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(
            (run.incarnation, run.work),
            (Incarnation::Live, Work::Runnable),
            "the run must not be declared blocked when nothing can hear it"
        );
        assert_eq!(run.blocker_kind, None);
    }

    // cm:guard the happy path asserts the THREE effects together, because any one alone passes against a broken order: the row says `live × blocked`, `waiting_on` names the question, and the door actually answers a ring. The last is the only one that proves the ear outlived the arm.
    #[test]
    fn a_bounded_arm_declares_live_blocked_and_the_door_answers() {
        let d = dir();
        let p = d.join("ledger.sqlite");
        let mut led = Ledger::open_in_memory().unwrap();
        run_on(&mut led);

        let (_ear, inc) = arm_bounded(
            &mut led,
            &p,
            Wait {
                run_id: "run-1",
                question_id: "q-77",
                round: 2,
                blocker: BlockerKind::MasterOrPeer,
                resume_id: Some("resume-9"),
                park_deadline_at: Some(4242),
            },
        )
        .unwrap();

        assert_eq!(inc, Incarnation::Live);
        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(
            (run.incarnation, run.work),
            (Incarnation::Live, Work::Blocked)
        );
        assert_eq!(run.blocker_kind, Some(BlockerKind::MasterOrPeer));
        assert_eq!(run.waiting_on.as_deref(), Some("q-77"));
        assert_eq!(run.resume_id.as_deref(), Some("resume-9"));
        assert_eq!(
            led.questions_for("run-1").unwrap(),
            vec![("q-77".to_string(), 2)]
        );
        assert_eq!(ring(&p, "run-1").unwrap(), Ring::Heard);
    }

    // cm:guard the human branch opens NO door, and this asserts the absence rather than trusting the code path: an ear here would be closed by the exit a moment later, and every ring after that meets `ENXIO` while the ledger says a listener was armed.
    #[test]
    fn the_human_park_exits_and_leaves_no_door_behind() {
        let d = dir();
        let p = d.join("ledger.sqlite");
        let mut led = Ledger::open_in_memory().unwrap();
        run_on(&mut led);

        let inc = park_for_human(
            &mut led,
            Wait {
                run_id: "run-1",
                question_id: "q-5",
                round: 1,
                blocker: BlockerKind::Human,
                resume_id: Some("r-5"),
                park_deadline_at: None,
            },
        )
        .unwrap();
        assert_eq!(inc, Incarnation::Exited);
        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(
            (run.incarnation, run.work),
            (Incarnation::Exited, Work::Blocked)
        );
        assert_eq!(run.waiting_on.as_deref(), Some("q-5"));
        assert!(!crate::runner::doorbell::path_for(&p, "run-1").exists());
        assert_eq!(ring(&p, "run-1").unwrap(), Ring::NoListener);
    }

    // cm:guard the declaration takes a `&Listening` and this scans for it, because the claim is about what CANNOT be written: a signature that dropped the parameter still compiles and passes every behavioural test above while making the order optional again (ISS-964 criterion 10).
    #[test]
    fn the_live_declaration_cannot_be_written_without_an_ear() {
        let src = include_str!("ledger.rs");
        let sig = src
            .split("pub fn declare_blocked_live(")
            .nth(1)
            .and_then(|s| s.split(") -> Result<Incarnation>").next())
            .expect("declare_blocked_live must be findable");
        assert!(
            sig.contains("doorbell::Listening"),
            "the open door must be a parameter of the declaration, not a convention: {sig}"
        );
    }
}
