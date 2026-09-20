//! `master` — look at, talk to, stand down and end this box's resident masters.
//!
//! A master is a tmux session now, so most of what an operator wants is one
//! `tmux` invocation away. What is NOT obvious from `tmux ls` is which session
//! belongs to which project and where its transcript went, and that is the gap
//! this fills.
//!
//! Two of those answers are different questions and are printed as two lines:
//! whether a pane exists, and whether this box is allowed to keep one. A box
//! whose runner is online and whose pane is alive while a human drives the
//! project is not an error, and `alive` alone cannot say it (ISS-1118).

use clap::{Args as ClapArgs, Subcommand};
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
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
        Command::Status(a) => status(a.slug.as_deref()).await?,
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
        led.forget_master_conversation(&project_id)?;
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

async fn status(slug: Option<&str>) -> anyhow::Result<()> {
    let base = Config::path()?.with_file_name("master");
    let slugs: Vec<String> = match slug {
        Some(s) => vec![s.to_string()],
        None => std::fs::read_dir(&base)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
    };
    if slugs.is_empty() {
        println!("no master transcripts under {}", base.display());
        return Ok(());
    }
    let led = open_ledger().ok();
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
        println!(
            "{:<20} standing  {}",
            "",
            standing_line(led.as_ref(), &name, &s)
        );
        if alive {
            println!("{:<20} attach: tmux attach -t {name}", "");
        }
    }
    Ok(())
}

/// The second answer, which `alive` cannot give.
///
/// A pane is a fact about tmux. Whether this box may keep a master for the
/// project is a fact about what its owner decided, and on 2026-09-20 those two
/// answers differed for nine hours with nothing here able to report it.
fn standing_line(led: Option<&Ledger>, pane: &str, slug: &str) -> String {
    let Some(led) = led else {
        return "unknown — this box's ledger could not be opened, so what its owner decided about \
this project cannot be read here"
            .into();
    };
    let row = match led.master_for_pane(pane) {
        Ok(r) => r,
        Err(e) => return format!("unknown — the ledger row for {pane} could not be read: {e}"),
    };
    let Some(row) = row else {
        return format!(
            "this box has no ledger row for {pane}, so it has never reported a master for {slug}; \
nothing is standing it down"
        );
    };
    match led.master_standing(&row.project_id) {
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
            "driving — this box places a master for {slug} whenever there is work for one. \
`forge-runner master stand-down {slug}` stops that"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
