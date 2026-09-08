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

/// The protections the box cannot observe about core, and must be told.
// cm:edge contract -> packages/core/src/questions/protections.ts — the names are that file's `PARK_PROTECTIONS`, verbatim. A rename on either side shuts the park on every box, silently, because a missing name is indistinguishable from an old core by design.
pub const PROTECTIONS_FROM_CORE: [&str; 3] = [
    "park-exempt-residency",
    "park-exempt-oneshot",
    "answer-resume-park",
];

/// The protections that are this binary's own sweeps, not core's.
// cm:guard asserted from THIS build rather than read from core, and that split is deliberate: core cannot observe which runner is asking, so advertising these would be core promising something it has no way to know. The two tests naming them are what keep the claims honest.
pub const PROTECTIONS_FROM_THIS_BUILD: [&str; 2] = ["worktree-reap-ledger", "recovery-park-exempt"];

/// Proof that all three park protections are in place.
// cm:guard the ONLY constructor is `from_advertisement`, and that is the whole mechanism: `park_for_human` takes a `&ParkPermit`, so a park produced without having asked core is not something a caller can write. A boolean parameter here would make the unprotected park one typo away (ISS-964 criterion 27).
#[derive(Debug)]
pub struct ParkPermit {
    granted: Vec<String>,
}

impl ParkPermit {
    /// Read core's advertisement and require every name, or refuse.
    // cm:guard ALL of the named set, never any-of and never a count: one flag cannot represent a core running two protections out of three, and a park is only safe when every one of them is up. An empty advertisement — which is what an old core, an unreachable core and a starting core all produce — refuses here.
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

/// Park for a human: ask, then declare the process gone. No door.
// cm:guard the `ParkPermit` is a PRECONDITION expressed in the type and is not read inside: what it proves is that core's protections were asked for and granted BEFORE the process was released, and a park without one is unwritable rather than merely discouraged (ISS-964 criterion 27).
// cm:guard NO door is opened here, and adding one would be a lie the ledger then publishes: the process is about to exit, so the read fd dies with it and every ring after that meets `ENXIO` anyway. The human answer arrives by revival, not by ring (ISS-964 criteria 5, 7, 8).
// cm:guard `blocker` is READ here and anything but `Human` is refused before any write, because `declare_parked_human` hard-codes `Human` into the row: a machine wait parked through this arm releases the box for a wait measured in seconds AND publishes a blocker kind that names the wrong resolver (ISS-964 criteria 4, 5).
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

    /// A permit granted by an advertisement carrying everything core owes.
    fn permit() -> ParkPermit {
        let advertised: Vec<String> = PROTECTIONS_FROM_CORE
            .iter()
            .map(|s| s.to_string())
            .collect();
        ParkPermit::from_advertisement(&advertised).unwrap()
    }

    // cm:guard the falsifying case for the new-runner-on-old-core leg of criterion 27's matrix: an old core has no protections route, so `park_protections` answers with an empty list, and this is where the box declines to release its process. The refusal names what is missing — an operator mid-deploy needs to read which half has not landed.
    #[test]
    fn an_old_core_advertising_nothing_grants_no_permit() {
        let err =
            ParkPermit::from_advertisement(&[]).expect_err("no advertisement must grant no permit");
        let text = format!("{err}");
        assert!(text.contains("park refused"), "{text}");
        for name in PROTECTIONS_FROM_CORE {
            assert!(text.contains(name), "{name} unnamed in: {text}");
        }
    }

    // cm:guard ALL-of, never any-of: a core running two protections out of three reaps or double-answers the park through the one it is missing, so a partial advertisement must refuse exactly as an empty one does — and the refusal must name the missing member alone, not the whole set.
    #[test]
    fn a_core_running_only_some_of_them_grants_no_permit() {
        for held_back in PROTECTIONS_FROM_CORE {
            let advertised: Vec<String> = PROTECTIONS_FROM_CORE
                .iter()
                .filter(|n| **n != held_back)
                .map(|s| s.to_string())
                .collect();
            let err = ParkPermit::from_advertisement(&advertised)
                .expect_err("a partial advertisement must refuse");
            let text = format!("{err}");
            assert!(text.contains(held_back), "{held_back} unnamed in: {text}");
        }
    }

    // cm:guard the granted set is core's advertisement PLUS one, and the plus-one is this build's own reaper — asserted as a length relative to `PROTECTIONS_FROM_CORE` so adding a core-side protection cannot silently drop the runner's from the count. Core never advertises that one, by design.
    #[test]
    fn a_granted_permit_counts_the_runners_own_sweeps_as_well_as_cores() {
        let p = permit();
        assert_eq!(
            p.protections().len(),
            PROTECTIONS_FROM_CORE.len() + PROTECTIONS_FROM_THIS_BUILD.len(),
            "{:?}",
            p.protections()
        );
        assert!(p
            .protections()
            .iter()
            .any(|n| n == PROTECTIONS_FROM_THIS_BUILD[1]));
    }

    // cm:guard an unknown extra name must not be read as a substitute for a missing required one, which is what a length or count check would do.
    #[test]
    fn an_advertisement_of_other_names_grants_no_permit() {
        ParkPermit::from_advertisement(&["something-else".to_string(), "and-another".to_string()])
            .expect_err("unrelated names must not grant a permit");
    }

    // cm:guard the last two protections are claims about THIS binary, so they are asserted from this binary's source. Both sweeps judge on shape, and shape is exactly what a park cannot be told from: `worktree_reap.rs` sees a tree nothing is running in, `recovery.rs` sees a run whose process is gone and whose master may be too. A permit that keeps claiming a sweep after its exemption was deleted is an advertisement with nothing behind it.
    #[test]
    fn the_box_side_sweeps_this_permit_claims_are_in_this_build() {
        let reap = include_str!("../workspace/worktree_reap.rs");
        assert!(
            reap.contains("held_by.holder(&p)"),
            "the worktree reaper no longer consults the ledger, so `{}` is a false claim",
            PROTECTIONS_FROM_THIS_BUILD[0]
        );
        let recovery = include_str!("../daemon/recovery.rs");
        assert!(
            recovery.contains("if run.is_parked_on_human() {"),
            "reconcile no longer exempts a park, so a dead master or a reboot closes it and `{}` is a false claim",
            PROTECTIONS_FROM_THIS_BUILD[1]
        );
    }

    // cm:guard the OTHER half of the two-arm refusal, and the falsifying case for it: `declare_parked_human` hard-codes `Human`, so a machine wait accepted here does not merely take the wrong branch — it writes a row claiming a person owes the answer, and the run is then waited on by nobody.
    #[test]
    fn the_human_park_refuses_a_bounded_blocker_and_writes_nothing() {
        for blocker in [BlockerKind::Machine, BlockerKind::MasterOrPeer] {
            let mut led = Ledger::open_in_memory().unwrap();
            run_on(&mut led);

            let err = park_for_human(
                &mut led,
                Wait {
                    run_id: "run-1",
                    question_id: "q-1",
                    round: 1,
                    blocker,
                    resume_id: None,
                    park_deadline_at: None,
                },
                &permit(),
            )
            .expect_err("a bounded blocker must not park for a human");
            assert!(format!("{err}").contains("arm_bounded"), "{err}");

            assert!(
                led.questions_for("run-1").unwrap().is_empty(),
                "{blocker:?} left a question row behind"
            );
            let run = led.run("run-1").unwrap().unwrap();
            assert_eq!(run.work, Work::Runnable, "{blocker:?} left the run blocked");
            assert_eq!(run.blocker_kind, None, "{blocker:?} named a resolver");
        }
    }

    // cm:guard `Nobody` must be refused in THIS arm too, not only in `arm_bounded`: the run terminates with a named reason and writes no question, so a `Nobody` that reached `begin_question` here would leave exactly the unanswerable row criterion 6 forbids.
    #[test]
    fn the_human_park_refuses_nobody_before_writing_the_question() {
        let mut led = Ledger::open_in_memory().unwrap();
        run_on(&mut led);

        let err = park_for_human(
            &mut led,
            Wait {
                run_id: "run-1",
                question_id: "q-1",
                round: 1,
                blocker: BlockerKind::Nobody,
                resume_id: None,
                park_deadline_at: None,
            },
            &permit(),
        )
        .expect_err("`nobody` must never park");
        assert!(format!("{err}").contains("writes no question"), "{err}");
        assert!(led.questions_for("run-1").unwrap().is_empty());
    }

    // cm:guard THE falsifying case for criterion 10. Swap the open and the declaration in `arm_bounded` and this goes red: the run reads `live × blocked` while its door was never opened, so the next ring lands in a gap nothing reads and the answer is lost with the run still claiming to wait for it.
    // cm:why unix-only, and NOT because the arm is: the fixture is a real FIFO, so on a platform selecting `doorbell_no_fifo.rs` this would go green off the stub's refusal and prove nothing about the order it exists to hold.
    #[cfg(unix)]
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
    // cm:why unix-only, and NOT because the arm is: the fixture is a real FIFO, so on a platform selecting `doorbell_no_fifo.rs` this would go green off the stub's refusal and prove nothing about the order it exists to hold.
    #[cfg(unix)]
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
    // cm:why unix-only for the same reason: the ABSENCE of a door is asserted by ringing it, which needs a platform that has one.
    #[cfg(unix)]
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
            &permit(),
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

    // cm:guard the gate is the SIGNATURE, so this asserts the signature: with the permit a parameter, an unprotected park does not compile, and with it read from a boolean or a global it is one typo away. Every behavioural test here would pass on that weaker shape, which is why this one reads the source (ISS-964 criterion 27).
    #[test]
    fn the_human_park_cannot_be_written_without_a_permit() {
        let src = include_str!("blocked.rs");
        let sig = src
            .split("pub fn park_for_human(")
            .nth(1)
            .and_then(|s| s.split(") -> Result<Incarnation>").next())
            .expect("park_for_human must be findable");
        assert!(
            sig.contains("&ParkPermit"),
            "the permit must be a parameter of the park, not a convention: {sig}"
        );
    }
}
