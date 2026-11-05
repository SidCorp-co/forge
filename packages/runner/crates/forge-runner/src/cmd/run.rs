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

mod brief;

use clap::{Args as ClapArgs, Subcommand};
use runner_core::judge_dir;
use runner_core::ledger::{Ledger, Named, SHORT_ID_CHARS};
use runner_daemon::{control, session_tokens};
use runner_platform::config::Config;

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
    /// Print the brief to dispatch a declared run with: its issues, project,
    /// base branch, tree, what the other trees hold, and the method it reads.
    Brief(BriefArgs),
}

#[derive(ClapArgs)]
pub struct BriefArgs {
    /// The run id `run declare` answered.
    pub run_id: String,
}

#[derive(ClapArgs)]
pub struct DeclareArgs {
    /// The project this run is for. Refused unless this pane is its master.
    #[arg(long)]
    pub project: String,
    /// The issues the subagent is being given, repeated or comma-separated.
    #[arg(long, value_delimiter = ',', required_unless_present = "requirement")]
    pub issue: Vec<String>,
    /// The requirement a judge run judges at the requirement, in place of any issue (a shipped
    /// requirement owes no verifying issue). Only with `--role qa` or `--role reviewer`.
    #[arg(long, conflicts_with = "issue")]
    pub requirement: Option<String>,
    /// The worktree the subagent will work in.
    #[arg(long)]
    pub worktree: String,
    /// The role the subagent for this run is dispatched as (e.g. qa). A qa or reviewer run may be declared over closed issues to judge them; any other role is refused a closed issue.
    #[arg(long)]
    pub role: Option<String>,
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
/// tries again once the operator has fixed what the refusal named — or, where
/// the checkout was recorded returned and the refusal only settled, clears it
/// with nothing left to try, which is what it then says.
fn release(run_id: &str) -> anyhow::Result<()> {
    let mut led = Ledger::open(&Ledger::default_path()?)?;
    let run_id = full_id(&led, run_id)?;
    println!("{}", retract(&mut led, &run_id)?);
    Ok(())
}

/// The whole id of the run `typed` names — itself, or the one run whose id it
/// begins — or the refusal saying why it names none. An id that names nothing
/// is handed on as typed, so each verb refuses it exactly as it always has.
pub(crate) fn full_id(led: &Ledger, typed: &str) -> anyhow::Result<String> {
    Ok(match led.run_named(typed)? {
        Named::Whole(id) | Named::Start(id) => id,
        Named::Nothing => typed.to_string(),
        Named::Ambiguous(ids) => anyhow::bail!(
            "`{typed}` begins {} runs on this box: {} — give enough of the id to name one",
            ids.len(),
            ids.join(", ")
        ),
        Named::TooShort(ids) => anyhow::bail!(
            "`{typed}` is shorter than the {SHORT_ID_CHARS} characters this box names a run by, \
             so it is not taken as {} — give the run's first {SHORT_ID_CHARS} characters or its whole id",
            ids.join(" or ")
        ),
    })
}

/// [`full_id`] against this box's ledger, read-only, for a verb the daemon
/// answers. A ledger this pane cannot open leaves the id as typed, for the
/// daemon to refuse by name if it names nothing.
fn named_on_this_box(typed: &str) -> anyhow::Result<String> {
    match Ledger::default_path().and_then(|p| Ledger::open_read_only(&p)) {
        Ok(led) => full_id(&led, typed),
        Err(_) => Ok(typed.to_string()),
    }
}

/// The whole of the decision, split from opening the ledger so every refusal it
/// makes is readable without one on disk.
fn retract(led: &mut Ledger, run_id: &str) -> anyhow::Result<String> {
    let Some(run) = led.run(run_id)? else {
        anyhow::bail!(
            "no run {run_id} on this box — `forge-runner status` shows the runs no master answers for"
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
    if !led.retract_release_refusal(run_id)? {
        anyhow::bail!("run {run_id}'s refusal could not be retracted — nothing was written");
    }
    let Some(after) = led.run(run_id)? else {
        anyhow::bail!(
            "run {run_id}'s refusal was retracted, and then the run could not be read back"
        );
    };
    // What happens next is what the sweep selects, read from the ledger the
    // sweep reads, never promised: a settled refusal's checkout is already
    // recorded returned, and no sweep takes such a row up again (ISS-1312
    // judge, finding L3).
    let swept = led.unclosed_runs()?.iter().any(|r| r.run_id == run_id);
    let next = match (after.released_as.as_deref(), swept) {
        (None, true) => "the next sweep will try the release again".to_string(),
        (None, false) => "no sweep selects it, so nothing will try the release again".to_string(),
        (Some(how), true) => format!(
            "there is no release left to try: its checkout is already recorded returned \
             ({how}); the next sweep still takes the run up to close what it holds open, its \
             session or its leases"
        ),
        (Some(how), false) => format!(
            "no sweep will take it up: its checkout is already recorded returned ({how}), so \
             nothing is left to release, and only the refusal is cleared from the row"
        ),
    };
    let ending = match (&run.ended_by, &after.ended_by) {
        (Some(_), None) => {
            "The ending that decision wrote is taken back, so the run is open again.".to_string()
        }
        (Some(_), Some(by)) => format!(
            "Its ending was not that decision's and is kept: ended by {by}, {}.",
            after
                .ended_reason
                .as_deref()
                .unwrap_or("no reason recorded")
        ),
        (None, _) => "It carried no ending, and carries none now.".to_string(),
    };
    Ok(format!(
        "run {run_id}: the refusal is retracted, and {next}.\n{ending}\n\
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

pub async fn run(ctx: super::Ctx, args: Args) -> anyhow::Result<()> {
    // Not a pane's verb and not the daemon's: an operator types this one at a
    // shell, so it reads the ledger directly rather than asking for a control
    // capability no shell was issued.
    if let Command::Release(o) = &args.cmd {
        return release(&o.run_id);
    }
    // A read of the ledger, core and git, made as the person: no control capability is asked for,
    // and nothing is written anywhere.
    if let Command::Brief(o) = &args.cmd {
        let client = match super::api::rest_client(&ctx)? {
            Ok(c) => c,
            Err(why) => anyhow::bail!("{why}"),
        };
        println!("{}", brief::brief(&client, &o.run_id).await?);
        return Ok(());
    }
    let sock = socket()?;
    let token = session_tokens::token_from_env().map_err(|e| {
        anyhow::anyhow!("this pane carries no control capability: {e} — only a pane the daemon spawned can declare a run")
    })?;
    let reply = match &args.cmd {
        Command::Declare(o) => {
            control::request_run_declare(
                &sock,
                &token,
                &o.project,
                &o.issue,
                &o.worktree,
                o.role.as_deref(),
                o.requirement.as_deref(),
            )
            .await?
        }
        Command::Choice(c) => {
            let run_id = named_on_this_box(&c.run_id)?;
            control::request_run_choice(&sock, &token, &run_id, &c.choice, &c.reason).await?
        }
        Command::Close(c) => {
            let run_id = named_on_this_box(&c.run_id)?;
            control::request_run_close(&sock, &token, &run_id, c.reason.as_deref()).await?
        }
        Command::Release(_) | Command::Brief(_) => {
            unreachable!("answered above, before the socket is opened")
        }
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
        Command::Choice(c) => println!(
            "run {} recorded as {}",
            reply.job_id.as_deref().unwrap_or(&c.run_id),
            c.choice
        ),
        Command::Close(c) => {
            let run_id = reply.job_id.as_deref().unwrap_or(&c.run_id);
            println!(
                "{}",
                closed(recorded_logins(run_id), &judge_dir::root(), run_id)
            );
            // What core did with the run's session, as the daemon's close found it (ISS-929):
            // `closed` is this box's record, and the session's own line says whether core's is.
            if let Some(at_core) = reply.reason.as_deref() {
                println!("at core: {at_core}");
            }
        }
        Command::Release(_) | Command::Brief(_) => {
            unreachable!("answered above, before the socket is opened")
        }
    }
    Ok(())
}

/// The judge logins `judge-login` recorded on `run_id` in this box's ledger, or why they could
/// not be read.
fn recorded_logins(run_id: &str) -> Result<Vec<std::path::PathBuf>, String> {
    Ledger::default_path()
        .and_then(|p| Ledger::open_read_only(&p))
        .and_then(|led| led.judge_dirs(run_id))
        .map_err(|e| e.to_string())
}

/// What `run close` says once the daemon has ended the run: that it is closed, and what became of
/// each test login `judge-login` recorded on it — or, for a run with none recorded, of
/// `forge-judge-<run>` under `root` (ISS-920). The run is closed whatever the removal came to; a
/// refused or failed removal is said beside it, naming the path and the error, and a run that
/// never logged in has nothing said about it.
fn closed(
    recorded: Result<Vec<std::path::PathBuf>, String>,
    root: &std::path::Path,
    run_id: &str,
) -> String {
    let mut said = format!("run {run_id} closed");
    for removal in judge_dir::remove_for_run(recorded, root, run_id) {
        if let Some(line) = removal.said() {
            said.push('\n');
            said.push_str(&line);
        }
    }
    said
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
    use super::*;

    /// A test ledger whose directory goes with it: before ISS-920 each run of these tests left a
    /// `forge-run-named-*` directory in `$TMPDIR` for good.
    struct HeldLedger(Ledger, std::path::PathBuf);
    impl std::ops::Deref for HeldLedger {
        type Target = Ledger;
        fn deref(&self) -> &Ledger {
            &self.0
        }
    }
    impl Drop for HeldLedger {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.1);
        }
    }

    fn ledger_with(name: &str, ids: &[&str]) -> HeldLedger {
        let dir =
            std::env::temp_dir().join(format!("forge-run-named-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut led = Ledger::open(&dir.join("ledger.sqlite")).unwrap();
        for (n, id) in ids.iter().enumerate() {
            led.create_run_group(runner_core::ledger::NewRun {
                run_id: (*id).into(),
                project_id: "p".into(),
                master_session_id: format!("m{n}"),
                worktree_path: format!("/r/w{n}").into(),
                boot_id: "b".into(),
                issue_keys: vec![format!("ISS-{n}")],
                role: None,
                requirement: None,
                worktree_origin: runner_core::ledger::TreeOrigin::Created,
            })
            .unwrap();
        }
        HeldLedger(led, dir)
    }

    #[test]
    fn a_run_is_named_by_its_whole_id_or_the_first_eight_characters_of_one() {
        let led = ledger_with(
            "one",
            &[
                "296f5496-870e-428f-b386-d1c6007bfd9c",
                "70d69d6e-1111-4222-8333-944455556666",
            ],
        );
        assert_eq!(
            full_id(&led, "296f5496").unwrap(),
            "296f5496-870e-428f-b386-d1c6007bfd9c"
        );
        assert_eq!(
            full_id(&led, "296f5496-870e").unwrap(),
            "296f5496-870e-428f-b386-d1c6007bfd9c"
        );
        assert_eq!(
            full_id(&led, "70d69d6e-1111-4222-8333-944455556666").unwrap(),
            "70d69d6e-1111-4222-8333-944455556666"
        );
        // An id that names nothing goes on as typed, and its verb refuses it as before.
        assert_eq!(full_id(&led, "deadbeef").unwrap(), "deadbeef");
        assert_eq!(full_id(&led, "no-such-run").unwrap(), "no-such-run");
        let short = full_id(&led, "296f").unwrap_err().to_string();
        assert!(short.contains("shorter than the 8 characters"), "{short}");
        assert!(
            short.contains("296f5496-870e-428f-b386-d1c6007bfd9c"),
            "{short}"
        );
    }

    #[test]
    fn a_start_that_begins_two_runs_is_refused_naming_both() {
        let led = ledger_with(
            "two",
            &[
                "296f5496-aaaa-4000-8000-000000000001",
                "296f5496-bbbb-4000-8000-000000000002",
            ],
        );
        let why = full_id(&led, "296f5496").unwrap_err().to_string();
        assert!(why.contains("begins 2 runs"), "{why}");
        assert!(
            why.contains("296f5496-aaaa-4000-8000-000000000001")
                && why.contains("296f5496-bbbb-4000-8000-000000000002"),
            "{why}"
        );
        assert_eq!(
            full_id(&led, "296f5496-b").unwrap(),
            "296f5496-bbbb-4000-8000-000000000002"
        );
    }
    /// A `$TMPDIR` of the test's own, under the one the code reads, removed when it ends.
    struct TmpRoot(std::path::PathBuf);
    impl TmpRoot {
        fn new(name: &str) -> Self {
            let p =
                judge_dir::root().join(format!("forge-run-close-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        /// What `judge-login` leaves for `run`: its directory with one file in it.
        fn plant(&self, run: &str) -> std::path::PathBuf {
            let d = judge_dir::dir(&self.0, run).unwrap();
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("x.json"), "{}").unwrap();
            d
        }
    }
    impl Drop for TmpRoot {
        fn drop(&mut self) {
            #[cfg(unix)]
            for entry in std::fs::read_dir(&self.0).into_iter().flatten().flatten() {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    std::fs::set_permissions(entry.path(), std::fs::Permissions::from_mode(0o700));
            }
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const JUDGED: &str = "f1b18bd5-870e-428f-b386-d1c6007bfd9c";
    const NEIGHBOUR: &str = "cbfc71ed-1111-4222-8333-944455556666";

    #[test]
    fn closing_a_declared_run_removes_its_judge_login_and_says_so() {
        let led = ledger_with("judged", &[JUDGED, NEIGHBOUR]);
        let root = TmpRoot::new("judged");
        let mine = root.plant(JUDGED);
        let theirs = root.plant(NEIGHBOUR);
        // closed by the short id a master types, named whole as the daemon answers it
        let run_id = full_id(&led, "f1b18bd5").unwrap();
        let said = closed(Ok(vec![]), &root.0, &run_id);
        assert!(!mine.exists(), "{said}");
        assert_eq!(
            said,
            format!(
                "run {JUDGED} closed\nremoved {}: the test session its judge was handed",
                mine.display()
            )
        );
        // another run's login is its own close's to remove
        assert!(theirs.join("x.json").exists());
    }

    #[test]
    fn a_run_that_never_logged_in_closes_with_nothing_said_about_it() {
        let root = TmpRoot::new("never");
        assert_eq!(
            closed(Ok(vec![]), &root.0, JUDGED),
            format!("run {JUDGED} closed")
        );
    }

    #[test]
    fn a_hostile_run_id_is_refused_and_removes_nothing() {
        let root = TmpRoot::new("hostile");
        let inner = root.0.join("inner");
        let kept = judge_dir::dir(&inner, JUDGED).unwrap();
        std::fs::create_dir_all(&kept).unwrap();
        std::fs::write(kept.join("x.json"), "{}").unwrap();
        let outside = root.0.join("forge-judge-x");
        std::fs::create_dir_all(&outside).unwrap();
        for hostile in [
            "../forge-judge-x",
            "..",
            "x/../..",
            "/etc",
            &format!("{JUDGED}/.."),
        ] {
            let said = closed(Ok(vec![]), &inner, hostile);
            assert!(
                said.starts_with(&format!("run {hostile} closed\n")),
                "{said}"
            );
            assert!(said.contains("is no run id"), "{said}");
        }
        assert!(kept.join("x.json").exists());
        assert!(outside.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_removal_that_fails_still_closes_and_names_the_path_and_the_error() {
        use std::os::unix::fs::PermissionsExt;
        let root = TmpRoot::new("readonly");
        let d = root.plant(JUDGED);
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o500)).unwrap();
        if std::fs::write(d.join("probe"), "").is_ok() {
            // root ignores the mode, so there is no failure to plant here
            return;
        }
        let said = closed(Ok(vec![]), &root.0, JUDGED);
        let mut lines = said.lines();
        assert_eq!(lines.next(), Some(format!("run {JUDGED} closed").as_str()));
        let why = lines.next().unwrap();
        assert!(why.contains(&d.display().to_string()), "{why}");
        assert!(why.contains("Permission denied"), "{why}");
        assert!(d.join("x.json").exists());
    }
    /// The login a judge's pane wrote under its own `$TMPDIR` and recorded on the run is the one
    /// `run close` removes, whatever `$TMPDIR` the close is typed under (ISS-920).
    #[test]
    fn closing_removes_the_recorded_login_wherever_the_pane_wrote_it() {
        let led = ledger_with("recorded", &[JUDGED]);
        let pane = TmpRoot::new("pane");
        let closer = TmpRoot::new("closer");
        let login = pane.plant(JUDGED);
        let recorded = judge_dir::record(&led, JUDGED, &login).unwrap();
        let said = closed(
            led.judge_dirs(JUDGED).map_err(|e| e.to_string()),
            &closer.0,
            JUDGED,
        );
        assert!(!login.exists(), "{said}");
        assert_eq!(
            said,
            format!(
                "run {JUDGED} closed\nremoved {}: the test session its judge was handed",
                recorded.display()
            )
        );
        // a record that breaks the rule is refused by name and removes nothing
        let other = pane.plant(NEIGHBOUR);
        let said = closed(Ok(vec![other.clone()]), &closer.0, JUDGED);
        assert!(said.contains("is not named forge-judge-"), "{said}");
        assert!(other.join("x.json").exists());
    }
}
