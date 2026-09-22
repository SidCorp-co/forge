//! `run` — what a master calls to declare the work it is about to hand out.
//!
//! This is not a claim and not a dispatcher. `run declare` writes a row in this
//! box's own registry saying which issues the master is about to give a
//! subagent, and answers that row's id; the master then dispatches the subagent
//! exactly as it does today, inside its own session. `run close` says the row is
//! finished, including when the subagent it was declared for never started.
//!
//! The whole of why it exists: before ISS-1050 nothing wrote that row, so a
//! master dying took its issues with it — they stayed marked as being worked on
//! with no process behind them, and nothing on disk said what to put back.
//!
//! Unlike `hook`, this verb DOES fail loudly. A hook must never break the agent
//! that runs it, so it swallows everything; a declaration that was refused and
//! reported success would let the master dispatch believing its work is
//! recorded when nothing is, which is the exact silence this issue exists to end.

use clap::{Args as ClapArgs, Subcommand};
use forge_runner_core::config::Config;
use forge_runner_core::daemon::{control, session_tokens};
use forge_runner_core::runner::ledger::Ledger;

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub cmd: Command,
}

#[derive(Subcommand)]
pub enum Command {
    Declare(DeclareArgs),
    Choice(ChoiceArgs),
    /// Say a declared run is finished, or never started.
    Close(CloseArgs),
    /// Have the next sweep try again to release a run whose release this box
    /// gave up on.
    Release(ReleaseArgs),
}

#[derive(ClapArgs)]
pub struct DeclareArgs {
    /// The project this run is for. Refused unless this pane is its master.
    #[arg(long)]
    pub project: String,
    /// The issues the subagent is being given, repeated or comma-separated.
    #[arg(long, value_delimiter = ',', required = true)]
    pub issue: Vec<String>,
    /// The worktree the subagent will work in.
    #[arg(long)]
    pub worktree: String,
}

#[derive(ClapArgs)]
pub struct ChoiceArgs {
    /// The run id this pane inherited, as the refusal names it.
    pub run_id: String,
    /// `continue`, `restart` or `leave`, and nothing else.
    pub choice: String,
    /// Why, in your own words. Required: the record is what the next reader has.
    #[arg(long)]
    pub reason: String,
}

#[derive(ClapArgs)]
pub struct CloseArgs {
    /// The run id `run declare` answered.
    pub run_id: String,
    /// Why it is over — kept on the row for whoever reads it next.
    #[arg(long)]
    pub reason: Option<String>,
}

#[derive(ClapArgs)]
pub struct ReleaseArgs {
    /// The run id the refusal named.
    pub run_id: String,
}

/// The way back from a release this box decided it could not make.
///
/// A release refused for longer than the grace window is not retried: its
/// leases go back, its run ends, and its checkout stays where it is. Before
/// ISS-1188 there was nothing to do about the state that left — and nothing to
/// do about the loop it replaced either, which is why the only routes out were
/// editing `ledger.sqlite` or editing git state by hand, both of them somebody
/// working around a safety check.
///
/// This verb does not release anything itself. The sweep is the one writer of a
/// release, and a second process removing the same checkout is the race the
/// ledger exists to stop. What it does is retract the decision, so the daemon
/// tries again once the operator has fixed what the refusal named.
fn release(run_id: &str) -> anyhow::Result<()> {
    let mut led = Ledger::open(&Ledger::default_path()?)?;
    println!("{}", retract(&mut led, run_id)?);
    Ok(())
}

/// The whole of the decision, split from opening the ledger so every refusal it
/// makes is readable without one on disk.
fn retract(led: &mut Ledger, run_id: &str) -> anyhow::Result<String> {
    let Some(run) = led.run(run_id)? else {
        anyhow::bail!(
            "no run {run_id} on this box — `forge-runner status` lists the runs this ledger holds"
        );
    };
    let Some(why) = run.release_refusal.clone() else {
        anyhow::bail!(
            "run {run_id} carries no refused release, so there is nothing here to retract — this \
             box last recorded it as {:?} with its checkout at {}",
            run.incarnation,
            run.worktree_path.display()
        );
    };
    if run.release_terminal_at.is_none() {
        anyhow::bail!(
            "run {run_id}'s release is refused but not given up on — this box is still trying it \
             every sweep, and the refusal it is standing on is: {why}"
        );
    }
    if !led.clear_release_refusal(run_id)? {
        anyhow::bail!("run {run_id}'s refusal could not be retracted — nothing was written");
    }
    Ok(format!(
        "run {run_id}: the refusal is retracted and the next sweep will try the release again.\n\
         It was given up on over: {why}"
    ))
}

fn socket() -> anyhow::Result<std::path::PathBuf> {
    let cfg = Config::path()?;
    let path = cfg.with_file_name("control.sock");
    if !path.exists() {
        anyhow::bail!(
            "no control socket at {} — this pane was not started by a running forge-runner daemon",
            path.display()
        );
    }
    Ok(path)
}

pub async fn run(_ctx: super::Ctx, args: Args) -> anyhow::Result<()> {
    // Not a pane's verb and not the daemon's: an operator types this one at a
    // shell, so it reads the ledger directly rather than asking for a control
    // capability no shell was issued.
    if let Command::Release(o) = &args.cmd {
        return release(&o.run_id);
    }
    let sock = socket()?;
    let token = session_tokens::token_from_env().map_err(|e| {
        anyhow::anyhow!("this pane carries no control capability: {e} — only a pane the daemon spawned can declare a run")
    })?;
    let reply = match &args.cmd {
        Command::Declare(o) => {
            control::request_run_declare(&sock, &token, &o.project, &o.issue, &o.worktree).await?
        }
        Command::Choice(c) => {
            control::request_run_choice(&sock, &token, &c.run_id, &c.choice, &c.reason).await?
        }
        Command::Close(c) => {
            control::request_run_close(&sock, &token, &c.run_id, c.reason.as_deref()).await?
        }
        Command::Release(_) => unreachable!("answered above, before the socket is opened"),
    };
    if !reply.ok {
        anyhow::bail!(
            "{}",
            reply
                .reason
                .unwrap_or_else(|| "refused, with no reason given".into())
        );
    }
    match args.cmd {
        Command::Declare(_) => println!("{}", declared_id(reply.job_id)?),
        Command::Choice(c) => println!("run {} recorded as {}", c.run_id, c.choice),
        Command::Close(c) => println!("run {} closed", c.run_id),
        Command::Release(_) => unreachable!("answered above, before the socket is opened"),
    }
    Ok(())
}

fn declared_id(job_id: Option<String>) -> anyhow::Result<String> {
    job_id.ok_or_else(|| {
        anyhow::anyhow!(
            "the daemon accepted the declaration and named no run id — nothing can be closed or \
             resumed against it, so treat the run as undeclared and look in the daemon's journal \
             for what it recorded"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{declared_id, retract};
    use forge_runner_core::runner::ledger::{Ledger, NewRun};
    use std::path::PathBuf;

    fn led_with_a_run() -> Ledger {
        let mut led = Ledger::open_in_memory().expect("an in-memory ledger opens");
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "m".into(),
            worktree_path: PathBuf::from("/tmp/a-checkout-nobody-removed"),
            boot_id: "boot-1".into(),
            issue_keys: vec!["ISS-1".into()],
        })
        .expect("the run is declared");
        led
    }

    #[test]
    fn a_run_this_box_never_had_is_refused_by_name() {
        let mut led = led_with_a_run();
        let err = format!(
            "{}",
            retract(&mut led, "run-nobody-declared").expect_err("there is no such run")
        );
        assert!(err.contains("run-nobody-declared"), "{err}");
        assert!(
            err.contains("forge-runner status"),
            "a refusal that names no way to find the right id leaves an operator guessing: {err}"
        );
    }

    #[test]
    fn a_run_carrying_no_refusal_is_told_what_it_carries_instead() {
        let mut led = led_with_a_run();
        let err = format!(
            "{}",
            retract(&mut led, "run-1").expect_err("there is nothing here to retract")
        );
        assert!(err.contains("no refused release"), "{err}");
        assert!(
            err.contains("/tmp/a-checkout-nobody-removed"),
            "and it says what the row DOES hold, so the operator can tell a wrong id from a \
             wrong expectation: {err}"
        );
    }

    #[test]
    fn a_refusal_still_being_retried_is_not_one_to_retract() {
        let mut led = led_with_a_run();
        led.note_release_refusal("run-1", "could not reach git", 1_790_000_000)
            .unwrap();
        let err = format!(
            "{}",
            retract(&mut led, "run-1").expect_err("this box has not given up on it yet")
        );
        assert!(err.contains("not given up on"), "{err}");
        assert!(
            err.contains("could not reach git"),
            "and it carries the refusal being stood on, which is what the operator has to fix: {err}"
        );
    }

    #[test]
    fn retracting_a_decided_refusal_puts_the_run_back_in_front_of_the_sweep() {
        let mut led = led_with_a_run();
        led.note_release_refusal("run-1", "the diff was not preserved", 1_790_000_000)
            .unwrap();
        led.conclude_release_refusal(
            "run-1",
            1_790_000_300,
            "recovery",
            "the diff was not preserved",
        )
        .unwrap();

        let said = retract(&mut led, "run-1").expect("a decided refusal is retractable");
        assert!(said.contains("the next sweep"), "{said}");
        assert!(
            said.contains("the diff was not preserved"),
            "the operator is told what it was given up on over, not just that it is undone: {said}"
        );

        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(run.release_terminal_at, None);
        assert_eq!(run.release_refused_at, None);
        assert!(
            retract(&mut led, "run-1").is_err(),
            "and a second retraction has nothing to retract, rather than quietly saying it did"
        );
    }

    #[test]
    fn an_accepted_declaration_with_no_id_is_an_error_and_not_a_line_of_prose() {
        let err = declared_id(None).expect_err("a declaration with no id is not a success");
        let said = format!("{err}");
        assert!(
            said.contains("named no run id"),
            "the refusal must say what is missing: {said}"
        );
        assert!(
            !said.starts_with("the daemon recorded the run"),
            "and it must not read as the id itself, which is what a caller captures from stdout"
        );
    }

    #[test]
    fn an_id_is_answered_unchanged() {
        assert_eq!(declared_id(Some("run-7".into())).unwrap(), "run-7");
    }
}
