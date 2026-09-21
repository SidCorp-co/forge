//! `master` — look at, talk to, stand down and end this box's resident masters.
//!
//! A master is a tmux session now, so most of what an operator wants is one
//! `tmux` invocation away. What is NOT obvious from `tmux ls` is which session
//! belongs to which project and where its transcript went, and that is the gap
//! this fills.
//!
//! Three of those answers are different questions and are printed as three
//! lines: whether a pane exists, whether this box's owner stood the project
//! down, and whether this box's runner row for the project takes work at all.
//! A box whose runner is online and whose pane is alive while a human drives
//! the project is not an error, and `alive` alone cannot say it (ISS-1118).
//!
//! The third line is there because the second one used to answer for it. The
//! standing line said "driving — this box places a master for <slug> whenever
//! there is work for one" off the `master_standing` table alone, and a runner
//! that is `draining` places none — which is exactly what the pool toggle in
//! the web UI sets, so the owner in ISS-1118's own story got a confident wrong
//! answer from the surface built to stop them guessing.

use clap::{Args as ClapArgs, Subcommand};
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::daemon::master::accepts_new_work;
use forge_runner_core::daemon::master_exit::{self, Holding};
use forge_runner_core::daemon::terminal;
use forge_runner_core::runner::ledger::Ledger;
use forge_runner_core::transport::{runners, CoreClient};

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub cmd: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Whether a master pane is up, and whether this box may keep one.
    Status(ProjectArgs),
    /// Where the master's transcript is, and its last lines.
    Log(LogArgs),
    /// Type a line into a master's pane, as a human at the keyboard would.
    Say(SayArgs),
    /// End a master's pane. It comes back, resuming the same conversation, the
    /// next time this box places one — `stand-down` is what keeps it stopped.
    Kill(ProjectArgs),
    /// Stop this box driving a project, and keep it stopped across sweeps and
    /// restarts until `stand-up`.
    StandDown(StandDownArgs),
    /// Let this box drive the project again, on the same terms as any other.
    StandUp(StandUpArgs),
}

#[derive(ClapArgs)]
pub struct ProjectArgs {
    /// Project slug. Omit on `status` to list every master on the box.
    pub slug: Option<String>,
}

#[derive(ClapArgs)]
pub struct StandDownArgs {
    /// Project slug.
    pub slug: String,
    /// What to tell whoever reads the runner log, and the master placed after
    /// this is lifted.
    #[arg(long)]
    pub why: Option<String>,
    /// End the pane even where the runs it holds could not be accounted for.
    #[arg(long)]
    pub force: bool,
}

#[derive(ClapArgs)]
pub struct StandUpArgs {
    /// Project slug.
    pub slug: String,
    /// Forget the conversation the next pane would resume, so it cold-starts.
    #[arg(long)]
    pub fresh: bool,
}

#[derive(ClapArgs)]
pub struct LogArgs {
    pub slug: String,
    #[arg(long, default_value_t = 40)]
    pub lines: usize,
}

#[derive(ClapArgs)]
pub struct SayArgs {
    pub slug: String,
    /// The text to type. Multi-line is fine — it arrives as one paste.
    pub text: String,
}

fn transcript(slug: &str) -> anyhow::Result<std::path::PathBuf> {
    let base = Config::path()?.with_file_name("master").join(slug);
    Ok(base.join("transcript.log"))
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    if !terminal::available() {
        anyhow::bail!("tmux is not installed on this box, so it hosts no masters");
    }
    match args.cmd {
        Command::Status(a) => status(&ctx, a.slug.as_deref()).await?,
        Command::Log(a) => {
            let path = transcript(&a.slug)?;
            println!("{}", path.display());
            let body = std::fs::read_to_string(&path).unwrap_or_default();
            let lines: Vec<&str> = body.lines().collect();
            for line in lines.iter().skip(lines.len().saturating_sub(a.lines)) {
                println!("{line}");
            }
        }
        Command::Say(a) => {
            let name = terminal::session_name(terminal::MASTER_PREFIX, &a.slug);
            terminal::send_line(&name, &a.text).await?;
            println!("typed into {name}");
        }
        Command::Kill(a) => {
            let Some(slug) = a.slug else {
                anyhow::bail!("name the project whose master should end");
            };
            let name = terminal::session_name(terminal::MASTER_PREFIX, &slug);
            terminal::kill(&name).await?;
            println!("killed {name}; its runs died with it and their leases lapse.");
            println!("{}", kill_aftermath(&slug));
        }
        Command::StandDown(a) => stand_down(&ctx, a).await?,
        Command::StandUp(a) => stand_up(&ctx, a).await?,
    }
    Ok(())
}

/// What actually happens after a kill.
///
/// The sentence this replaces said "the daemon's next sweep starts a fresh
/// master". Fresh is the part that was false: the conversation id lives on the
/// `masters` row, which a kill never touches, so the replacement resumes the
/// same transcript. It is not a promise of a pane either — placement still
/// answers to admissible work, a runner that accepts work, a repo path and a
/// terminal (ISS-1118 criterion 9).
fn kill_aftermath(slug: &str) -> String {
    format!(
        "This does NOT keep it stopped. The conversation id lives on this box's `masters` row and \
a kill does not touch it, so whenever this box next places a master for {slug} — which still \
depends on admissible work, a runner that accepts work, a repo path and tmux — the pane it starts \
RESUMES the same conversation, carrying its whole transcript and its whole cost.\n\
To keep it stopped: `forge-runner master stand-down {slug}`. To have the next pane start cold \
rather than resume: `forge-runner master stand-up {slug} --fresh`."
    )
}

fn open_ledger() -> anyhow::Result<Ledger> {
    let path = Ledger::default_path()?;
    Ok(Ledger::open(&path)?)
}

/// Resolve a slug to the project id this box knows it by: the ledger's own
/// master row first, because that answer needs no network, and core second.
///
/// A slug neither can place is refused by name and writes nothing — guessing a
/// project id here would record a stand-down against a project that does not
/// exist, which reads afterwards exactly like one that was never honoured.
async fn project_for_slug(ctx: &Ctx, led: &Ledger, slug: &str) -> anyhow::Result<String> {
    let pane = terminal::session_name(terminal::MASTER_PREFIX, slug);
    if let Some(row) = led.master_for_pane(&pane)? {
        return Ok(row.project_id);
    }
    let cfg = Config::load()?;
    let (Some(core_url), Some(token)) =
        (ctx.resolve_core_url(&cfg), cred_store::load_device_token()?)
    else {
        anyhow::bail!(
            "this box holds no master row for `{slug}` (no pane named {pane} has ever reported \
here) and it is not logged in, so core cannot be asked either. Nothing was recorded. Either run \
`forge-runner login`, or check the slug against `forge-runner master status`."
        );
    };
    let served = runners::list_me(&CoreClient::new(core_url, token))
        .await
        .map_err(|e| {
            anyhow::anyhow!(
                "this box holds no master row for `{slug}`, and core could not be asked which \
projects it serves: {e}. Nothing was recorded."
            )
        })?;
    match served.iter().find(|r| r.slug == slug) {
        Some(r) => Ok(r.project_id.clone()),
        None => anyhow::bail!(
            "no project `{slug}` on this box: it has no master row named {pane}, and core serves \
this device {}. Nothing was recorded.",
            if served.is_empty() {
                "no projects at all".to_string()
            } else {
                served
                    .iter()
                    .map(|r| r.slug.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        ),
    }
}

async fn stand_down(ctx: &Ctx, a: StandDownArgs) -> anyhow::Result<()> {
    let led = open_ledger()?;
    let project_id = project_for_slug(ctx, &led, &a.slug).await?;
    let pane = terminal::session_name(terminal::MASTER_PREFIX, &a.slug);
    let by = whoami();

    led.stand_down_master(&project_id, &a.slug, &by, a.why.as_deref())?;
    println!(
        "{} is stood down: this box places no master for it and nudges none, on every sweep and \
across restarts, until `forge-runner master stand-up {}`.",
        a.slug, a.slug
    );

    if !terminal::alive(&pane).await {
        println!("No pane was running for it, so nothing was ended.");
        return Ok(());
    }

    let row = led.master_for_project(&project_id)?;
    match master_exit::holding(&led, row.as_ref())? {
        Holding::Nothing => {
            terminal::kill(&pane).await?;
            println!("Ended {pane}; it held no open run.");
        }
        Holding::These(runs) if !a.force => {
            println!(
                "{pane} is STILL RUNNING and was not ended: it holds {} open run(s), and killing \
it would take them with it and lapse their leases.",
                runs.len()
            );
            for r in &runs {
                println!(
                    "  {} (master session {}){}",
                    r.run_id,
                    r.master_session_id,
                    if r.issues.is_empty() {
                        String::new()
                    } else {
                        format!(" — {}", r.issues.join(", "))
                    }
                );
            }
            println!(
                "The stand-down IS recorded, so no replacement will be placed once this pane goes. \
Let those runs finish, or `forge-runner master stand-down {} --force` to end it now.",
                a.slug
            );
        }
        Holding::These(runs) => {
            terminal::kill(&pane).await?;
            println!(
                "Ended {pane} under --force; {} open run(s) died with it and their leases lapse.",
                runs.len()
            );
        }
        Holding::Unknown(why) if !a.force => {
            println!("{pane} is STILL RUNNING and was not ended: {why}.");
            println!(
                "That is not the same as holding nothing, and this box will not end a pane whose \
work it cannot account for. The stand-down IS recorded, so no replacement will be placed once \
this pane goes. `forge-runner master stand-down {} --force` ends it anyway.",
                a.slug
            );
        }
        Holding::Unknown(why) => {
            terminal::kill(&pane).await?;
            println!("Ended {pane} under --force, without establishing what it held: {why}.");
        }
    }
    Ok(())
}

async fn stand_up(ctx: &Ctx, a: StandUpArgs) -> anyhow::Result<()> {
    let led = open_ledger()?;
    let project_id = project_for_slug(ctx, &led, &a.slug).await?;
    // Clear the conversation BEFORE lifting, never after. While the
    // stand-down stands no pane is placed, so a sweep that sees the lift
    // already sees the cleared conversation; the other order leaves a window
    // in which a pane is placed resuming exactly the conversation the operator
    // asked not to resume — and leaves the veto lifted if the clear fails.
    if a.fresh {
        led.forget_master_conversation(&project_id)?;
    }
    let lifted = led.stand_up_master(&project_id)?;
    if lifted {
        println!(
            "{} is stood up. It is placed again on the same terms as any other project — \
admissible work, a runner that accepts work, a repo path and tmux — rather than immediately.",
            a.slug
        );
    } else {
        println!("{} was not stood down; nothing changed.", a.slug);
    }
    if a.fresh {
        println!("Its stored conversation is forgotten, so the next pane cold-starts.");
    } else if let Some(conv) = led
        .master_for_project(&project_id)?
        .and_then(|r| r.conversation_id)
    {
        println!(
            "The next pane RESUMES conversation {conv}, carrying its transcript and its cost. \
`--fresh` clears it."
        );
    }
    Ok(())
}

fn whoami() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_else(|_| "an operator at this box".into())
}

async fn status(ctx: &Ctx, slug: Option<&str>) -> anyhow::Result<()> {
    let base = Config::path()?.with_file_name("master");
    let led = open_ledger().ok();
    let admission = read_admission(ctx).await;
    let slugs: Vec<String> = match slug {
        Some(s) => vec![s.to_string()],
        None => listed(&base, led.as_ref()),
    };
    if slugs.is_empty() {
        println!("no master transcripts under {}", base.display());
        return Ok(());
    }
    for s in slugs {
        let name = terminal::session_name(terminal::MASTER_PREFIX, &s);
        let alive = terminal::alive(&name).await;
        let path = transcript(&s)?;
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        println!(
            "{s:<20} pane      {:<8} {name}  transcript {}KB  ({})",
            if alive { "alive" } else { "gone" },
            size / 1024,
            path.display()
        );
        println!("{:<20} standing  {}", "", standing_line(led.as_ref(), &s));
        println!("{:<20} runner    {}", "", admission_line(&admission, &s));
        if alive {
            println!("{:<20} attach: tmux attach -t {name}", "");
        }
    }
    Ok(())
}

/// Which projects a bare `status` answers for.
///
/// Transcript directories alone would miss a project stood down before this
/// box ever placed a master for it — which is a project whose standing is the
/// only thing there is to say about it, and the one an owner is most likely to
/// be looking for.
fn listed(base: &std::path::Path, led: Option<&Ledger>) -> Vec<String> {
    let mut slugs: Vec<String> = std::fs::read_dir(base)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    if let Some(led) = led {
        for standing in led.standings().unwrap_or_default() {
            if !slugs.contains(&standing.slug) {
                slugs.push(standing.slug);
            }
        }
    }
    slugs.sort();
    slugs
}

/// This box's runner rows as core last served them, or why they could not be
/// read.
///
/// Best effort on purpose: `status` is the command an operator reaches for on
/// a box whose network may be the problem, and refusing to print the pane and
/// the standing because core is unreachable would withhold the two answers
/// that need nothing from core.
enum Admission {
    Read(Vec<runners::MeRunner>),
    Unreadable(String),
}

async fn read_admission(ctx: &Ctx) -> Admission {
    let Ok(cfg) = Config::load() else {
        return Admission::Unreadable("this box's config could not be read".into());
    };
    let token = match cred_store::load_device_token() {
        Ok(Some(t)) => t,
        Ok(None) => {
            return Admission::Unreadable(
                "this box is not logged in, so core cannot be asked — `forge-runner login`".into(),
            )
        }
        Err(e) => return Admission::Unreadable(format!("the device token could not be read: {e}")),
    };
    let Some(core_url) = ctx.resolve_core_url(&cfg) else {
        return Admission::Unreadable("this box has no core URL configured".into());
    };
    match runners::list_me(&CoreClient::new(core_url, token)).await {
        Ok(rows) => Admission::Read(rows),
        Err(e) => Admission::Unreadable(format!("core could not be asked: {e}")),
    }
}

/// The third answer: whether this box's runner row for the project takes work
/// at all.
///
/// An unreadable answer is printed rather than omitted. An omitted line reads
/// as no impediment, and the impediment this line exists to show — a runner
/// left `draining` by the web toggle — is invisible on the box in every other
/// place an operator looks.
fn admission_line(admission: &Admission, slug: &str) -> String {
    match admission {
        Admission::Unreadable(why) => format!(
            "unknown — {why}. Whether this box would place a master for {slug} also depends on this answer"
        ),
        Admission::Read(rows) => match rows.iter().find(|r| r.slug == slug) {
            None => format!(
                "core serves no runner for {slug} to this box, so this box places no master for it whatever its standing says"
            ),
            Some(r) if accepts_new_work(&r.status) => format!(
                "`{}` — this box takes work for {slug}, so nothing here withholds a master beyond the standing above",
                r.status
            ),
            Some(r) => format!(
                "`{}` — this box takes NO new work for {slug}, so it places no master for it whatever the standing above says. That is the `Takes jobs from the pool` control in the web UI, not a stand-down, and turning it back on is what reverses it",
                r.status
            ),
        },
    }
}

/// The second answer, which `alive` cannot give.
///
/// A pane is a fact about tmux. Whether this box's OWNER stood the project
/// down is a fact about what they decided, and on 2026-09-20 those two answers
/// differed for nine hours with nothing here able to report it.
/// Read by slug rather than through the `masters` row: a project can be stood
/// down before this box has ever placed a master for it, and a lookup that
/// needs a pane row would answer "nothing is standing it down" about a project
/// that is standing down right there in the ledger.
///
/// It answers for the ledger and for nothing else. The arm below used to say
/// "driving — this box places a master for {slug} whenever there is work for
/// one", which is a claim about placement that this function's one input
/// cannot support: a `draining` runner places none. The placement answer is
/// `admission_line`'s.
fn standing_line(led: Option<&Ledger>, slug: &str) -> String {
    let Some(led) = led else {
        return "unknown — this box's ledger could not be opened, so what its owner decided about \
this project cannot be read here"
            .into();
    };
    match led.master_standing_for_slug(slug) {
        Err(e) => format!("unknown — the standing for {slug} could not be read: {e}"),
        Ok(Some(s)) if s.stood_up_at.is_none() => format!(
            "STOOD DOWN by {}{} — this box places no master for it and nudges none. \
`forge-runner master stand-up {slug}` reverses it",
            s.stood_down_by,
            s.why
                .as_deref()
                .map(|w| format!(" ({w})"))
                .unwrap_or_default()
        ),
        Ok(_) => format!(
            "not stood down — nothing this box's owner recorded withholds a master for {slug}. \
Whether one is placed then answers to the runner line below, admissible work, a repo path and \
tmux. `forge-runner master stand-down {slug}` is what withholds it"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = include_str!("master.rs");

    /// The sentence this replaces — "End a master. The next sweep starts a
    /// fresh one" — was false in the one word that mattered. An owner who read
    /// it and killed the pane got the same conversation back, and concluded
    /// the command does not work (ISS-1118 criterion 9).
    #[test]
    fn kill_says_what_actually_happens_next_and_names_the_control_that_stops_it() {
        let said = kill_aftermath("forge-dev");
        assert!(
            said.contains("RESUMES the same conversation"),
            "a replacement master is not fresh: the conversation id survives the kill on the `masters` row: {said}"
        );
        assert!(
            !said.to_lowercase().contains("fresh master")
                && !said.to_lowercase().contains("starts a fresh"),
            "the word this sentence exists to retire must not come back: {said}"
        );
        assert!(
            said.contains("stand-down forge-dev"),
            "the one control that keeps a master stopped is named here or the owner goes on guessing: {said}"
        );
        assert!(
            said.contains("admissible work"),
            "and it promises no pane either — placement still answers to the gates it always did: {said}"
        );
    }

    #[test]
    fn the_kill_help_and_the_printed_result_agree_with_each_other() {
        let help = <Command as clap::Subcommand>::augment_subcommands(clap::Command::new("t"))
            .find_subcommand("kill")
            .expect("kill is still a subcommand")
            .get_about()
            .map(|s| s.to_string())
            .unwrap_or_default();
        assert!(
            help.contains("resuming the same conversation"),
            "the help an owner reads BEFORE running it makes the same claim the result does: {help}"
        );
        assert!(
            help.contains("stand-down"),
            "and names the control that keeps it stopped: {help}"
        );
    }

    /// F2 from the ISS-1118 review. While the stand-down stands, no pane is
    /// placed; so clearing the conversation FIRST means any sweep that can see
    /// the lift already sees the cleared conversation. The other order leaves
    /// a window in which a pane resumes exactly what `--fresh` asked it not to.
    #[test]
    fn stand_up_fresh_clears_the_conversation_before_it_lifts_the_veto() {
        let body = SOURCE
            .split("async fn stand_up(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .and_then(|r| r.split("\nfn ").next())
            .expect("stand_up must be findable");
        let clears = body
            .find("forget_master_conversation(")
            .expect("--fresh must clear the stored conversation");
        let lifts = body
            .find("stand_up_master(")
            .expect("stand-up must lift the stand-down");
        assert!(
            clears < lifts,
            "lifting first opens a window in which a sweep places a pane resuming the conversation `--fresh` asked it not to, and leaves the veto lifted if the clear then fails"
        );
    }

    /// F4 from the review. A project can be stood down before this box has
    /// ever placed a master for it.
    #[test]
    fn the_standing_is_read_by_slug_and_not_through_a_pane_row() {
        let body = SOURCE
            .split("fn standing_line(")
            .nth(1)
            .and_then(|r| r.split("\nfn ").next())
            .expect("standing_line must be findable");
        assert!(
            body.contains("master_standing_for_slug("),
            "reading the standing through the `masters` row answers `nothing is standing it down` about a project whose stand-down is right there in the ledger, which is this issue's own defect in miniature"
        );
        assert!(
            !body.contains("master_for_pane("),
            "and it needs no pane row to answer, because a stood-down project may never have had one"
        );
    }

    fn online(slug: &str, status: &str) -> runners::MeRunner {
        runners::MeRunner {
            project_id: "proj-1".into(),
            runner_id: "r-1".into(),
            slug: slug.into(),
            base_branch: None,
            repo_path: None,
            branch: None,
            status: status.into(),
            workspace_setup: None,
            master_policy: None,
            rate_limited_for_seconds: None,
            limit_reason: None,
        }
    }

    /// Criterion 21, and Finding B of the independent judgement.
    ///
    /// Reproduced on a scratch box: with the runner served as `draining` and
    /// no stand-down anywhere, the daemon logged "runner is draining — taking
    /// no new work" and `master status` said `driving` in the same minute. The
    /// owner in this issue's story reached for that toggle first.
    #[test]
    fn the_standing_line_never_claims_this_box_places_a_master() {
        let said = standing_line(None, "judgeproj");
        assert!(
            !said.contains("places a master"),
            "the standing line reads one table and cannot answer for placement; a `draining` runner places none: {said}"
        );
        let led = Ledger::open_in_memory().expect("an in-memory ledger opens");
        let clean = standing_line(Some(&led), "judgeproj");
        assert!(
            !clean.contains("driving") && !clean.contains("places a master"),
            "a project nobody stood down is not thereby being driven: {clean}"
        );
        assert!(
            clean.contains("stand-down judgeproj"),
            "and it still names the act that withholds one: {clean}"
        );
    }

    /// Criterion 22. The third answer is printed whatever happens, because an
    /// omitted line reads as no impediment.
    #[test]
    fn the_runner_line_answers_or_says_why_it_could_not() {
        let draining = Admission::Read(vec![online("judgeproj", "draining")]);
        let said = admission_line(&draining, "judgeproj");
        assert!(
            said.contains("NO new work") && said.contains("places no master"),
            "a box that places no master because its runner takes no work has to say so where an owner is looking for the reason: {said}"
        );
        assert!(
            said.contains("Takes jobs from the pool"),
            "and it names the control that set it, which is the guessing this issue exists to end: {said}"
        );
        let up = admission_line(
            &Admission::Read(vec![online("judgeproj", "online")]),
            "judgeproj",
        );
        assert!(
            !up.contains("NO new work"),
            "an online runner withholds nothing: {up}"
        );
        let blind = admission_line(
            &Admission::Unreadable("core could not be asked: connection refused".into()),
            "judgeproj",
        );
        assert!(
            blind.starts_with("unknown") && blind.contains("connection refused"),
            "an answer this box could not get is printed as unknown with what stopped it — omitting the line would read as nothing standing in the way: {blind}"
        );
        let unbound = admission_line(&Admission::Read(vec![]), "judgeproj");
        assert!(
            unbound.contains("no runner"),
            "a project core serves this box no runner for gets no master either, and that is not a stand-down: {unbound}"
        );
    }

    /// The rule the third line states IS the rule the daemon runs — the same
    /// function, not a copy of it, so a change to the daemon's gate cannot
    /// leave this surface asserting the old one.
    #[test]
    fn the_status_gate_is_the_daemons_gate() {
        for withheld in ["draining", "disabled"] {
            assert!(
                !accepts_new_work(withheld),
                "`{withheld}` takes the no-new-work branch the sweep runs and places no master; saying otherwise here is the surface disagreeing with the box"
            );
        }
        assert!(accepts_new_work("online"));
        assert!(accepts_new_work("offline"));
        assert!(
            !SOURCE.contains(concat!("fn ", "accepts_new_work(")),
            "a second copy of the daemon's admission rule in this crate is a box that says one thing and does another; call `forge_runner_core::daemon::master::accepts_new_work`"
        );
    }

    #[test]
    fn stand_down_and_stand_up_are_both_reachable_verbs() {
        let cmd = <Command as clap::Subcommand>::augment_subcommands(clap::Command::new("t"));
        for verb in ["stand-down", "stand-up"] {
            assert!(
                cmd.find_subcommand(verb).is_some(),
                "`{verb}` is how an owner stops and restarts a resident master; without it the only lever is `kill`, which does not keep it stopped"
            );
        }
    }
}
