//! The open at core of a run just declared (ISS-1036), apart from the declaration it follows.

use std::sync::Arc;

use super::Control;

/// Open the run just declared at core before the declaration answers, and say what core holds.
///
/// Core holds a declared run only once its session is opened there, and the sweep that opened it
/// came up to thirty seconds later (five minutes while rate-limited). A master that posted a
/// verdict naming the run it had just declared was refused as if no run had been declared
/// (adminhub-fe ISS-119, FB-508, ISS-1036). Not opened here, the run stands on the row and the
/// sweep opens it as before. The ledger is not held while core answers.
pub(crate) async fn open_at_declare(
    ctl: &Arc<Control>,
    opener: &Option<impl crate::run_record::SessionOpener>,
    run_id: &str,
) -> String {
    let Some(opener) = opener else {
        return format!(
            "this daemon has no core client, so core holds no session for run {run_id} until a sweep opens it"
        );
    };
    let read = {
        let held = ctl.ledger.lock().expect("ledger poisoned");
        held.as_ref().and_then(|led| match led.run(run_id) {
            Ok(Some(run)) => crate::run_record::open_of(led, &run).map(|open| (run, open)),
            _ => None,
        })
    };
    let Some((run, open)) = read else {
        return format!(
            "run {run_id} could not be read back off this box's registry, so core holds no session for it until a sweep opens it"
        );
    };
    let now = runner_core::agent_activity::now_ms();
    let gate = ctl
        .config_dir
        .as_deref()
        .map(|dir| runner_core::degraded::report(dir, now).degraded);
    let answer = opener
        .open(
            &open.project_id,
            run_id,
            &open.keys,
            &open.name,
            gate.as_ref(),
            crate::run_record::said_of(&run),
        )
        .await;
    let held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_ref() else {
        return format!(
            "this daemon's registry closed while core answered, so run {run_id}'s session is written back by a sweep"
        );
    };
    match crate::run_record::settle_open(led, &run, &open.keys, &ctl.boot_id, answer, now) {
        crate::run_record::Settled::Opened(session) => format!(
            "session {session} is open, so a call naming run {run_id} is this run's from now"
        ),
        crate::run_record::Settled::Not(why) => {
            format!("core holds no open session for run {run_id} yet: {why}")
        }
    }
}
