//! `master` — look at, talk to, stand down and end this box's resident masters.
//!
//! A master is a tmux session now, so most of what an operator wants is one
//! `tmux` invocation away. What is NOT obvious from `tmux ls` is which session
//! belongs to which project and where its transcript went, and that is the gap
//! this fills.
//!
//! Four of those answers are different questions and are printed as four
//! lines: whether a pane exists, whether this box's owner stood the project
//! down, whether this box's runner row for the project takes work at all, and
//! whether this box can still be heard by the pane it has. A box whose runner
//! is online and whose pane is alive while a human drives the project is not an
//! error, and `alive` alone cannot say it (ISS-1118).
//!
//! The third line is there because the second one used to answer for it. The
//! standing line said "driving — this box places a master for <slug> whenever
//! there is work for one" off the `master_standing` table alone, and a runner
//! that is `draining` places none — which is exactly what the pool toggle in
//! the web UI sets, so the owner in ISS-1118's own story got a confident wrong
//! answer from the surface built to stop them guessing.
//!
//! The fourth is there because none of the first three can say it. A pane that
//! is alive, on a project nobody stood down, on a runner that takes work, can
//! still be one every declaration of which is refused — and on 2026-09-18 one
//! was, for four hours, with a daemon log line as the only account of it
//! (ISS-1099).

use std::time::Duration;

use clap::{Args as ClapArgs, Subcommand};
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::daemon::master::accepts_new_work;
use forge_runner_core::daemon::master_exit::{self, Holding};
use forge_runner_core::daemon::terminal;
use forge_runner_core::runner::ledger::{Ledger, MasterAuthority};
use forge_runner_core::transport::{runners, CoreClient};

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub cmd: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Whether a master pane is up, whether this box may keep one, and whether
    /// it can still be heard by the one it has.
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
    /// Required. What is being waited for, and the condition that ends it —
    /// read by whoever finds this project idle, and by the master placed after
    /// it is lifted.
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
    /// Required. The argument this lift was taken on — what made the wait the
    /// stand-down recorded safe to end.
    #[arg(long)]
    pub why: Option<String>,
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

/// The reason a standing verb was given, or `None` where it was given nothing
/// it can record.
///
/// Whitespace is the same answer as an absent flag and is refused the same way.
/// A required flag with no content check is a required flag in the help and an
/// optional one in practice, and ` ` is the shortest way past it.
fn reason(given: Option<&str>) -> Option<&str> {
    given.map(str::trim).filter(|w| !w.is_empty())
}

/// How the reason was missing, in the refusal's own first line.
///
/// Two states and not one: somebody who left the flag out has not met the
/// requirement, and somebody who passed an empty string has met it and been
/// told it is not enough. Reading the same sentence for both leaves the second
/// one hunting for a flag they already typed.
fn how_it_was_missing(given: Option<&str>) -> &'static str {
    match given {
        None => "was not given",
        Some(_) => "was given with nothing in it, which records no more than leaving it out",
    }
}

/// What a caller who stood a project down with nothing to say is told instead.
///
/// Hand-written rather than clap's `required = true`, because the refusal IS
/// the deliverable here. `error: the following required arguments were not
/// provided: --why <WHY>` teaches that a flag exists and nothing about what
/// belongs in it, and what goes in it then is `stood down` — which answers none
/// of the questions the reader who finds the project idle actually has
/// (ISS-1238).
fn no_reason_to_stand_down(given: Option<&str>, slug: &str) -> String {
    format!(
        "`--why` is required on `stand-down` and {missing}. Nothing was recorded.\n\n\
Standing {slug}'s master down stops this box driving it — no pane placed and no nudge sent, on \
every sweep and across restarts — until somebody stands it up. No check refuses that, nothing \
ages it and no run reports it, so the reason you write here is the only thing on the record that \
says what is being waited for. forge-dev's board dispatched nothing for two days behind a \
stand-down whose reason was empty, and what ended it had to be reconstructed afterwards from \
unrelated evidence.\n\n\
Write the condition that ENDS it, not a label for it:\n\n  \
forge-runner master stand-down {slug} --why \"Four writes to the release path are outstanding. \
Stand up when any of the four is done or an issue is opened.\"\n\n\
`stood down`, `see the channel` and `temporarily` each pass this check and leave the next reader \
exactly where an empty one does.",
        missing = how_it_was_missing(given)
    )
}

/// What a caller who lifted a stand-down with nothing to say is told instead.
///
/// A lift is an override of somebody's deliberate stop and is recorded with the
/// same weight as the stop. Until ISS-1238 it recorded a timestamp and nothing
/// else, which left the record able to say what was being waited for and never
/// why the wait was judged over — the half a later reader needs most.
fn no_reason_to_stand_up(given: Option<&str>, slug: &str) -> String {
    format!(
        "`--why` is required on `stand-up` and {missing}. Nothing was changed.\n\n\
Standing {slug} up overrides a stop somebody took deliberately, and this is the only place the \
argument for that override is written down. The episode already says what the box was waiting \
for; without this it can never say why that wait was judged over, and the next person reading it \
is left reconstructing your reasoning from whatever else happened that day.\n\n\
Say what changed, not that you are standing it up:\n\n  \
forge-runner master stand-up {slug} --why \"The release path the stand-down was waiting on is \
gone — ISS-1186 removed it in code, so the hazard it guarded is closed.\"\n\n\
`forge-runner master status {slug}` prints what it was stood down for, which is what this \
answers.",
        missing = how_it_was_missing(given)
    )
}

async fn stand_down(ctx: &Ctx, a: StandDownArgs) -> anyhow::Result<()> {
    // Before the ledger is opened and before core is asked anything, so a
    // refused call has touched nothing.
    let why = reason(a.why.as_deref())
        .ok_or_else(|| anyhow::anyhow!(no_reason_to_stand_down(a.why.as_deref(), &a.slug)))?;
    let led = open_ledger()?;
    let project_id = project_for_slug(ctx, &led, &a.slug).await?;
    let pane = terminal::session_name(terminal::MASTER_PREFIX, &a.slug);
    let by = whoami();

    led.stand_down_master(&project_id, &a.slug, &by, why)?;
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
    // Before anything is opened, and in particular before `--fresh` clears the
    // stored conversation: a refused lift must leave the box exactly as it
    // found it, and that clear happens before the lift itself.
    let why = reason(a.why.as_deref())
        .ok_or_else(|| anyhow::anyhow!(no_reason_to_stand_up(a.why.as_deref(), &a.slug)))?;
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
    let lifted = led.stand_up_master(&project_id, &whoami(), why)?;
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

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
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
        if slug.is_some() {
            for line in standing_history_lines(led.as_ref(), &s, now_unix()) {
                println!("{:<20} earlier   {line}", "");
            }
        }
        println!("{:<20} runner    {}", "", admission_line(&admission, &s));
        let running = Running {
            name: &name,
            incarnation: if alive {
                terminal::incarnation(&name).await
            } else {
                None
            },
            alive,
        };
        println!(
            "{:<20} authority {}",
            "",
            authority_line(led.as_ref(), &s, now_unix(), &running)
        );
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
        // And a project whose pane this box adopted rather than started, which
        // has no transcript directory here and may have no standing row either.
        // That is exactly the pane this issue is about, so leaving it out of the
        // list would put the new answer where the one project that needs it
        // cannot be asked for it (ISS-1099).
        for authority in led.authorities().unwrap_or_default() {
            if !slugs.contains(&authority.slug) {
                slugs.push(authority.slug);
            }
        }
    }
    slugs.sort();
    slugs
}

/// How long `status` waits for core before answering `unknown` for it.
///
/// A refused connection returns at once; a core that accepts and then never
/// answers returns never, and nothing under `list_me` sets a deadline. Without
/// this, the one command an operator runs when the network is the problem
/// withholds the pane and the standing — the two answers that need no network
/// at all — for as long as the socket stays open.
const ADMISSION_DEADLINE: Duration = Duration::from_secs(5);

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
    let asked = tokio::time::timeout(
        ADMISSION_DEADLINE,
        runners::list_me(&CoreClient::new(core_url, token)),
    )
    .await;
    match asked {
        Ok(Ok(rows)) => Admission::Read(rows),
        Ok(Err(e)) => Admission::Unreadable(format!("core could not be asked: {e}")),
        Err(_) => Admission::Unreadable(format!(
            "core did not answer within {}s",
            ADMISSION_DEADLINE.as_secs()
        )),
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
        Ok(Some(s)) if s.stands() => format!(
            "STOOD DOWN by {} ({}) — this box places no master for it and nudges none. \
`forge-runner master stand-up {slug}` reverses it",
            s.stood_down_by,
            s.reason()
        ),
        Ok(Some(s)) => format!(
            "not stood down — the last stand-down ({}) was lifted by {} ({}), so nothing this \
box's owner recorded withholds a master for {slug}. Whether one is placed then answers to the \
runner line below, admissible work, a repo path and tmux. \
`forge-runner master stand-down {slug}` is what withholds it",
            s.reason(),
            s.stood_up_by.as_deref().unwrap_or("somebody"),
            s.lift_reason()
                .unwrap_or("no argument was recorded — that lift predates the requirement"),
        ),
        Ok(None) => format!(
            "not stood down — nothing this box's owner recorded withholds a master for {slug}. \
Whether one is placed then answers to the runner line below, admissible work, a repo path and \
tmux. `forge-runner master stand-down {slug}` is what withholds it"
        ),
    }
}

/// The episodes behind the one `standing_line` printed, oldest last.
///
/// The current standing says what is being waited for now. These say what the
/// box was waiting for the last few times and what ended each wait, which is
/// the question nobody could answer about forge-dev's two idle days because the
/// row holding it had been overwritten and then deleted (ISS-1238).
///
/// Printed only where a slug was named. A bare `status` answers for every
/// project on the box, and a history under each of them buries the four lines
/// an operator came for.
fn standing_history_lines(led: Option<&Ledger>, slug: &str, now: i64) -> Vec<String> {
    let Some(led) = led else {
        return Vec::new();
    };
    let episodes = match led.standing_history(slug) {
        Ok(rows) => rows,
        Err(e) => return vec![format!("the episodes behind it could not be read: {e}")],
    };
    episodes
        .iter()
        .skip(1)
        .map(|s| {
            let held = match s.stood_up_at {
                Some(up) => span(u64::try_from(up - s.stood_down_at).unwrap_or(0)),
                None => "still standing".to_string(),
            };
            format!(
                "{} ago, by {}, held {held} — {} · lifted by {} ({})",
                ago(now - s.stood_down_at),
                s.stood_down_by,
                s.reason(),
                s.stood_up_by.as_deref().unwrap_or("somebody"),
                s.lift_reason()
                    .unwrap_or("no argument was recorded — that lift predates the requirement"),
            )
        })
        .collect()
}

/// The third answer, which neither of the other two gives.
///
/// A pane is a fact about tmux and a standing is a fact about what the owner
/// decided. Whether this box can still be heard by the pane it has is a third,
/// and on 2026-09-18 a project stood still for four hours with `alive` and
/// `driving` both saying yes while every declaration that pane made was
/// refused. The only account of it was a daemon log line, which is what this
/// issue's Outcome says nobody should have to read (ISS-1099).
///
/// Suppressed where the pane is not running: a verdict about a pane that is
/// gone is not an answer about anything, and printing the last one would tell
/// an operator who has just killed a stale pane that the kill did nothing.
/// What the pane running under this name is, as far as this command can tell
/// it from the one that ran before it.
pub(crate) struct Running<'a> {
    pub name: &'a str,
    /// Which incarnation of that name is up, as tmux's own opaque answer.
    /// `None` where no pane is up, or tmux could not be asked. Those are not
    /// the same and the line says which.
    pub incarnation: Option<String>,
    pub alive: bool,
}

fn authority_line(led: Option<&Ledger>, slug: &str, now: i64, running: &Running<'_>) -> String {
    let pane = running.name;
    if !running.alive {
        return format!(
            "not asked — no pane is running for {slug}, and whether this box could be heard by one \
is only a question about a pane that exists"
        );
    }
    let Some(led) = led else {
        return "unknown — this box's ledger could not be opened, so what its own sweep \
established about this pane cannot be read here"
            .into();
    };
    let row = match led.master_authority_for_slug(slug) {
        Err(e) => {
            return format!("unknown — the authority verdict for {slug} could not be read: {e}")
        }
        Ok(None) => {
            return format!(
                "not yet established — no sweep has judged {pane} since this box's ledger was \
written. The daemon judges it on the sweep that adopts or places the pane"
            )
        }
        Ok(Some(r)) => r,
    };
    if let Some(mismatch) = judged_another_pane(&row, running, slug) {
        return mismatch;
    }
    // Every sentence below is about an observation a sweep made, not about the
    // state of the pane right now. The daemon can have stopped, or its last
    // pass can have failed before it reached this project, and the row would
    // read exactly the same — so the age of the observation is part of the
    // answer rather than a detail under it (ISS-1099).
    let seen = ago(now.saturating_sub(row.seen_at));
    let held = span(row.held_for().as_secs());
    let stood = format!("last confirmed {seen} ago, after {held} of the same answer");
    match row.verdict.as_str() {
        MasterAuthority::STALE => format!(
            "STALE — {stood}. {pane} is up and this box cannot hear it: the capability that pane \
holds names a session core has since replaced, and a running pane cannot be handed a new one. Every \
declaration it makes is refused and the daemon stopped nudging it. \
`forge-runner master kill {slug}` ends it — a bare `tmux kill-session` reaches a different tmux \
server than the one masters run on. Whether a replacement is then placed is the standing and \
runner lines' answer and needs work for one to do; ending this pane is what makes a replacement \
possible, not what makes it happen"
        ),
        MasterAuthority::UNKNOWN => format!(
            "unknown — {stood}. This box could not read its own capability map ({}), so it says \
nothing about {pane} rather than calling it stale. An unreadable map is not evidence about any pane",
            row.detail.as_deref().unwrap_or("no reason recorded")
        ),
        MasterAuthority::CURRENT => format!(
            "current — {stood}. A capability this box minted named the session core gave it, which \
is what this sweep looked at and all of it: whether any one declaration {pane} made was served \
turns on what it asked for"
        ),
        other => format!(
            "unrecognised verdict `{other}` — {stood}. This ledger was written by a build this one \
does not know, and nothing here will guess what it meant"
        ),
    }
}

/// Whether the verdict on the record is about some pane other than the one
/// running now, and what to say if it is.
///
/// A master pane's name comes from the slug, so a replacement carries the name
/// of the pane it replaced. Reading the old verdict onto the new pane tells an
/// operator who has just killed a stale master that the kill did nothing —
/// which is the same lie this issue is about, pointing the other way.
fn judged_another_pane(row: &MasterAuthority, running: &Running<'_>, slug: &str) -> Option<String> {
    if row.pane_name != running.name {
        return Some(format!(
            "not asked — the last verdict this box reached was about {}, and the pane running for \
{slug} now is {}. The next sweep judges this one",
            row.pane_name, running.name
        ));
    }
    match (row.pane_incarnation.as_deref(), running.incarnation.as_deref()) {
        (Some(judged), Some(up)) if judged != up => Some(
            "not asked — the verdict this box holds was reached about the pane that ran under this \
name before the one up now. The next sweep judges this one"
                .to_string(),
        ),
        (None, _) | (_, None) => Some(format!(
            "unknown — this box cannot ask tmux which pane is running as {}, so it cannot tell the \
one its verdict was about from the one up now, and it will not read the verdict onto either",
            running.name
        )),
        _ => None,
    }
}

/// A duration in the coarsest unit that still says it.
fn span(secs: u64) -> String {
    match secs {
        0..=90 => format!("{secs}s"),
        91..=5400 => format!("{}m", secs / 60),
        _ => format!("{}h{:02}m", secs / 3600, (secs % 3600) / 60),
    }
}

fn ago(secs: i64) -> String {
    span(u64::try_from(secs).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_runner_core::runner::ledger::MasterStanding;

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

    /// F1 from the whole-set review. `status` is the command an operator runs
    /// when the network is what is wrong, and the two answers that need no
    /// network must not wait on the one that does.
    #[tokio::test]
    async fn a_core_that_accepts_and_never_answers_does_not_hold_the_local_answers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port");
        let addr = listener.local_addr().expect("the bound address");
        // Accept and then hold the connection open, answering nothing. A
        // refused connection returns at once and proves nothing about this.
        let held = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("the request arrives");
            tokio::time::sleep(Duration::from_secs(120)).await;
            drop(stream);
        });

        let client = CoreClient::new(format!("http://{addr}"), "scratch-token".to_string());
        let began = std::time::Instant::now();
        let asked = tokio::time::timeout(ADMISSION_DEADLINE, runners::list_me(&client)).await;
        let waited = began.elapsed();

        assert!(
            asked.is_err(),
            "a core that never answers has to expire rather than return, or `read_admission` awaits it forever"
        );
        assert!(
            waited < ADMISSION_DEADLINE + Duration::from_secs(2),
            "the wait is bounded by the deadline and not by the socket: waited {waited:?}"
        );
        let said = admission_line(
            &Admission::Unreadable(format!(
                "core did not answer within {}s",
                ADMISSION_DEADLINE.as_secs()
            )),
            "judgeproj",
        );
        assert!(
            said.starts_with("unknown") && said.contains("did not answer"),
            "and the expiry reads as an answer this box could not get, never as no impediment: {said}"
        );
        held.abort();
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

    const PANE: &str = "forge-master-sidpeak";
    /// tmux's own answer for one incarnation: when it was created, and the
    /// session id that is unique within the server's life.
    const UP: &str = "1700000000:$1";

    /// A ledger holding one verdict, so the line can be read as an operator
    /// reads it rather than as a source scan.
    fn led_saying(verdict: &'static str, detail: Option<&str>) -> Ledger {
        let led = Ledger::open_in_memory().unwrap();
        led.note_master_authority("proj-1", "sidpeak", (PANE, Some(UP)), verdict, detail)
            .unwrap();
        led
    }

    /// The pane the verdict was reached about, still running.
    fn same_pane() -> Running<'static> {
        Running {
            name: PANE,
            incarnation: Some(UP.to_string()),
            alive: true,
        }
    }

    /// `now` for a reading taken a few seconds after the sweep that wrote it.
    fn shortly_after(led: &Ledger) -> i64 {
        led.master_authority_for_slug("sidpeak")
            .unwrap()
            .unwrap()
            .seen_at
            + 4
    }

    /// The third answer. On 2026-09-18 a project stood still for four hours
    /// while the two lines above this one both said yes: the pane was `alive`
    /// and nothing had stood the project down, and every declaration that pane
    /// made was refused. The only account of it was a daemon log line
    /// (ISS-1099 criteria 11 and 12).
    #[test]
    fn a_pane_this_box_cannot_hear_says_so_and_names_the_act_that_ends_it() {
        let led = led_saying(MasterAuthority::STALE, None);
        let line = authority_line(Some(&led), "sidpeak", shortly_after(&led), &same_pane());
        assert!(
            line.contains("STALE"),
            "an operator scanning three lines for the one that is wrong has to be able to see it: {line}"
        );
        assert!(
            line.contains("forge-runner master kill sidpeak"),
            "and the act that ends it, because no sweep resolves this state and waiting is what cost four hours: {line}"
        );
        let standing = standing_line(Some(&led), "sidpeak");
        assert!(
            !standing.contains("master kill"),
            "the standing line answers a different question and must not be mistaken for this one: {standing}"
        );
    }

    /// F2 from the whole-set read at the replayed head. Ending the pane is
    /// what makes a replacement POSSIBLE; whether one is placed answers to the
    /// standing, the runner row and whether there is work for it — the three
    /// questions the other lines exist for. A line that promises the sweep will
    /// place one is this surface making a promise the box does not keep, which
    /// is the defect it was built to stop.
    #[test]
    fn ending_a_refused_pane_is_not_promised_to_produce_a_replacement() {
        let led = led_saying(MasterAuthority::STALE, None);
        let line = authority_line(Some(&led), "sidpeak", shortly_after(&led), &same_pane());
        assert!(
            !line.contains("the next sweep places"),
            "a stood-down project, a draining runner or nothing claimable each place no master, and this line can see none of the three: {line}"
        );
        assert!(
            line.contains("standing and runner lines"),
            "so it sends the reader to the answers that can: {line}"
        );
    }

    /// F1 from the whole-set read at the replayed head. The sweep looks at the
    /// capability and at nothing else. A declaration can still be refused for
    /// its own reasons — an inherited run awaiting a choice, an issue key that
    /// is not one — and a line claiming the pane's declarations were served is
    /// asserting something no sweep looked at.
    #[test]
    fn a_current_capability_is_not_reported_as_a_declaration_that_was_served() {
        let led = led_saying(MasterAuthority::CURRENT, None);
        let line = authority_line(Some(&led), "sidpeak", shortly_after(&led), &same_pane());
        assert!(
            !line.contains("declared then was served"),
            "run_declare refuses a pane holding a current capability for reasons of its own — an inherited run awaiting a choice, an issue key that is not one — and this sweep looked at none of them: {line}"
        );
        assert!(
            line.contains("turns on what it asked for"),
            "so the line says what it looked at, that that is the whole of it, and what the rest turns on: {line}"
        );
    }

    /// F2 from the review of this change. Masters run on a tmux server of the
    /// runner's own, at a socket under its config directory. A bare
    /// `tmux kill-session` typed into an ordinary shell reaches the DEFAULT
    /// server, so the remedy either does nothing or kills a same-named session
    /// belonging to something else — and the line that prints it is the one
    /// surface an operator reaches for when a project has stopped.
    #[test]
    fn the_remedy_named_is_one_that_reaches_the_server_masters_actually_run_on() {
        let led = led_saying(MasterAuthority::STALE, None);
        let line = authority_line(Some(&led), "sidpeak", shortly_after(&led), &same_pane());
        assert!(
            !line.contains("tmux kill-session -t forge-master-sidpeak"),
            "this is the command that does not work from an operator's own shell, and printing it spends their ten minutes: {line}"
        );
        assert!(
            line.contains("forge-runner master kill sidpeak"),
            "the verb that goes through the runner's own socket is the one to name: {line}"
        );
    }

    /// Three verdicts stay three on the surface too. Reporting an unreadable
    /// map as `stale` would tell an operator to kill every pane on the box.
    #[test]
    fn a_map_this_box_could_not_read_is_neither_current_nor_stale_on_the_line() {
        let led = led_saying(MasterAuthority::UNKNOWN, Some("the map is not valid JSON"));
        let line = authority_line(Some(&led), "sidpeak", shortly_after(&led), &same_pane());
        assert!(
            !line.contains("STALE") && !line.starts_with("current"),
            "an unreadable map is evidence about the map and about no pane: {line}"
        );
        assert!(
            line.contains("the map is not valid JSON"),
            "and it says which map and why, or `unknown` is a shrug: {line}"
        );
        assert!(
            !line.contains("master kill"),
            "telling an operator to end a pane on evidence this box has not got is the substitution this verdict exists to refuse: {line}"
        );
    }

    /// A verdict about a pane that is gone is not an answer about anything,
    /// and printing the last one tells an operator who has just killed a stale
    /// pane that the kill did nothing (ISS-1099 criterion 15).
    #[test]
    fn a_dead_pane_is_given_no_verdict_however_recent_the_last_one_was() {
        let led = led_saying(MasterAuthority::STALE, None);
        let gone = Running {
            name: PANE,
            incarnation: None,
            alive: false,
        };
        let line = authority_line(Some(&led), "sidpeak", shortly_after(&led), &gone);
        assert!(
            !line.contains("STALE") && !line.contains("master kill"),
            "the row still says stale; the pane it was about is gone: {line}"
        );
        assert!(
            line.contains("no pane is running"),
            "and the line says why it is not answering rather than going quiet: {line}"
        );
    }

    /// F1 from the review of this change. A master pane's name comes from the
    /// slug, so a replacement carries the name of the pane it replaced. Only
    /// the moment tmux created it tells the two apart, and without that an
    /// operator who has just ended a stale master is told their replacement is
    /// stale too — the same lie, pointing the other way.
    #[test]
    fn a_same_second_replacement_under_the_same_name_is_not_given_the_old_panes_verdict() {
        let led = led_saying(MasterAuthority::STALE, None);
        // Same name, same second, a different tmux session id — which is the
        // case a whole-second creation time could not see.
        let replacement = Running {
            name: PANE,
            incarnation: Some("1700000000:$2".to_string()),
            alive: true,
        };
        let line = authority_line(Some(&led), "sidpeak", shortly_after(&led), &replacement);
        assert!(
            !line.contains("STALE") && !line.contains("master kill"),
            "this pane has not been judged; telling its operator to end it would cost them the master they just placed: {line}"
        );
        assert!(
            line.contains("before the one up now") && line.contains("next sweep"),
            "and it says which pane the verdict it holds was about, and when this one gets judged: {line}"
        );
    }

    #[test]
    fn a_pane_under_a_different_name_entirely_is_not_given_the_old_verdict() {
        let led = led_saying(MasterAuthority::STALE, None);
        let other = Running {
            name: "forge-master-sidpeak-2",
            incarnation: Some(UP.to_string()),
            alive: true,
        };
        let line = authority_line(Some(&led), "sidpeak", shortly_after(&led), &other);
        assert!(
            !line.contains("STALE"),
            "this is a pane no sweep has judged yet: {line}"
        );
        assert!(
            line.contains(PANE) && line.contains("next sweep"),
            "and it names the pane the verdict was about: {line}"
        );
    }

    /// Where tmux cannot be asked which incarnation is up, the box says it
    /// cannot tell. It does not read the verdict on either assumption: one
    /// direction ends a working master, the other hides a refused one.
    #[test]
    fn a_pane_this_box_cannot_identify_is_answered_with_that_and_not_with_a_guess() {
        let led = led_saying(MasterAuthority::STALE, None);
        let unidentifiable = Running {
            name: PANE,
            incarnation: None,
            alive: true,
        };
        let line = authority_line(Some(&led), "sidpeak", shortly_after(&led), &unidentifiable);
        assert!(
            !line.contains("STALE") && !line.contains("master kill"),
            "an answer this box cannot stand behind is not an answer: {line}"
        );
        assert!(
            line.contains("cannot ask tmux"),
            "and it says what it could not do, rather than going quiet: {line}"
        );
    }

    #[test]
    fn a_project_no_sweep_has_judged_is_not_reported_as_working() {
        let led = Ledger::open_in_memory().unwrap();
        let line = authority_line(Some(&led), "sidpeak", 1_700_000_000, &same_pane());
        assert!(
            !line.starts_with("current"),
            "no verdict is not the same answer as a good one — that equivalence is what let a refused pane read as healthy for four hours: {line}"
        );
        assert!(
            line.contains("not yet established"),
            "and an absent verdict says so in its own words: {line}"
        );
    }

    /// F3 from the review of this change. Every verdict on the record is an
    /// observation a sweep made. The daemon can have stopped, or its last pass
    /// can have failed before it reached this project, and the row would read
    /// exactly the same — so a line that asserts a present state from a past
    /// reading is the surface lying in the way this issue is about.
    #[test]
    fn the_line_says_when_the_verdict_was_last_confirmed_and_not_only_that_it_holds() {
        let led = led_saying(MasterAuthority::CURRENT, None);
        let row = led.master_authority_for_slug("sidpeak").unwrap().unwrap();
        let hours_later = row.seen_at + 9 * 3600;
        let line = authority_line(Some(&led), "sidpeak", hours_later, &same_pane());
        assert!(
            line.contains("last confirmed 9h00m ago"),
            "an observation nine hours old is not a statement about now, and the reader is owed its age: {line}"
        );
        assert!(
            !line.contains("is served"),
            "nor may the sentence claim the present tense off a nine-hour-old row: {line}"
        );
    }

    #[test]
    fn a_span_reads_in_the_coarsest_unit_that_still_says_it() {
        assert_eq!(span(5), "5s");
        assert_eq!(span(600), "10m");
        assert_eq!(span(4 * 3600 + 12 * 60), "4h12m");
        assert_eq!(ago(-1), "0s", "a clock that went backwards says nothing");
    }

    /// Criteria 1-5. The refusal is the deliverable: a caller who is told only
    /// that a required argument was not provided writes `stood down` in it, and
    /// the record is no better than the empty one this issue was filed from.
    #[test]
    fn a_stand_down_with_nothing_to_say_is_refused_and_told_what_to_write() {
        let said = no_reason_to_stand_down(None, "forge-dev");
        assert!(
            said.contains("`--why`"),
            "the flag a caller has to reach for is named, not implied: {said}"
        );
        assert!(
            said.contains("the only thing on the record that says what is being waited for"),
            "and what the text is read FOR, or the next caller writes a label: {said}"
        );
        assert!(
            said.contains("Stand up when any of the four is done or an issue is opened"),
            "and an example carrying the condition that ENDS the stand-down, which is the shape one recorded row already had and the empty one did not: {said}"
        );
        assert!(
            said.contains("Nothing was recorded"),
            "a caller who has just been refused has to know the box did not half-do it: {said}"
        );
        assert!(
            said.contains("stand-down forge-dev --why"),
            "and the whole invocation, with the project already in it: {said}"
        );
    }

    /// Criterion 5, and the boundary that makes the rule mean anything. A
    /// required flag with no content check is required in the help and optional
    /// in practice.
    #[test]
    fn a_reason_made_of_whitespace_is_the_same_answer_as_no_reason_at_all() {
        assert_eq!(
            reason(Some("  waiting on a deploy  ")),
            Some("waiting on a deploy")
        );
        assert_eq!(reason(Some("   ")), None, "spaces record nothing");
        assert_eq!(reason(Some("\t\n")), None, "nor does a tab and a newline");
        assert_eq!(reason(Some("")), None);
        assert_eq!(reason(None), None);
        let blank = no_reason_to_stand_down(Some("   "), "forge-dev");
        assert!(
            blank.contains("was given with nothing in it"),
            "somebody who typed the flag is not told they left it out — they are told it is empty: {blank}"
        );
        assert!(
            no_reason_to_stand_down(None, "forge-dev").contains("was not given"),
            "and somebody who left it out is told that instead"
        );
    }

    /// Criteria 7-11. A lift is an override of somebody's deliberate stop and
    /// is recorded with the same weight as the stop.
    #[test]
    fn a_lift_with_nothing_to_say_is_refused_and_told_what_to_write() {
        let said = no_reason_to_stand_up(None, "forge-dev");
        assert!(said.contains("`--why`"), "the flag is named: {said}");
        assert!(
            said.contains("why that wait was judged over"),
            "and what the argument is read for — the half a later reader needs most, which the record could never say: {said}"
        );
        assert!(
            said.contains("stand-up forge-dev --why"),
            "and the whole invocation: {said}"
        );
        assert!(
            said.contains("ISS-1186"),
            "with an example that is an argument about the world rather than a restatement of the act: {said}"
        );
        assert!(
            said.contains("Nothing was changed"),
            "and it says the box is as it was: {said}"
        );
        assert!(
            no_reason_to_stand_up(Some(" "), "forge-dev").contains("was given with nothing in it"),
            "whitespace is refused on the same terms here as on stand-down"
        );
    }

    /// Criterion 6. The check runs before the ledger is opened, so a refused
    /// stand-down cannot have written one.
    #[test]
    fn a_refused_stand_down_has_not_opened_the_ledger_or_asked_core_anything() {
        let body = SOURCE
            .split("async fn stand_down(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .expect("stand_down must be findable");
        let refuses = body
            .find("no_reason_to_stand_down(")
            .expect("stand_down must refuse a missing reason");
        for after in [
            "open_ledger(",
            "project_for_slug(",
            "stand_down_master(",
            "whoami(",
        ] {
            let at = body
                .find(after)
                .unwrap_or_else(|| panic!("`{after}` must still be in stand_down"));
            assert!(
                refuses < at,
                "`{after}` runs before the reason is checked, so a call refused for having nothing to say has already touched the box"
            );
        }
    }

    /// Criteria 12 and 13. `--fresh` clears the stored conversation BEFORE the
    /// lift, deliberately (ISS-1118 F2) — so a reason check placed after it
    /// would refuse the lift having already thrown away the conversation the
    /// caller never got to keep.
    #[test]
    fn a_refused_lift_has_not_cleared_the_conversation_or_touched_the_standing() {
        let body = SOURCE
            .split("async fn stand_up(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .and_then(|r| r.split("\nfn ").next())
            .expect("stand_up must be findable");
        let refuses = body
            .find("no_reason_to_stand_up(")
            .expect("stand_up must refuse a missing reason");
        for after in [
            "open_ledger(",
            "project_for_slug(",
            "forget_master_conversation(",
            "stand_up_master(",
        ] {
            let at = body
                .find(after)
                .unwrap_or_else(|| panic!("`{after}` must still be in stand_up"));
            assert!(
                refuses < at,
                "`{after}` runs before the reason is checked: a lift refused for having nothing to say would have done it anyway"
            );
        }
    }

    /// Criteria 14 and 22. The reason reaches the surface an operator actually
    /// runs, and an episode that never recorded one says so in as many words
    /// rather than printing an empty pair of brackets or nothing at all.
    #[test]
    fn the_standing_line_carries_the_reason_and_names_the_absence_of_one() {
        let led = Ledger::open_in_memory().expect("an in-memory ledger opens");
        led.stand_down_master("proj-1", "forge-dev", "dev", "four writes outstanding")
            .expect("a stand-down is recorded");
        let said = standing_line(Some(&led), "forge-dev");
        assert!(
            said.contains("four writes outstanding"),
            "the reason is readable the moment the stand-down is taken, not only once a second one has replaced it: {said}"
        );
        assert!(
            said.contains("STOOD DOWN by dev"),
            "and who took it: {said}"
        );

        // An episode whose reason is NULL cannot be planted from this crate —
        // nothing outside the ledger module writes that table, which is the
        // point — so the two halves are proved where each of them lives. That
        // `reason()` answers `NO_REASON` for a NULL is `ledger.rs`'s own test,
        // planted through the migration from the pre-ISS-1238 shape; that this
        // line asks `reason()` rather than reading `why` is this one's.
        let body = SOURCE
            .split("fn standing_line(")
            .nth(1)
            .and_then(|r| r.split("\n/// ").next())
            .expect("standing_line must be findable");
        assert!(
            body.contains("s.reason()"),
            "reading `why` here would print nothing at all for an episode nobody gave a reason, and a blank is what a reader cannot tell from a reason they have not found yet: {body}"
        );
        assert!(
            !body.contains("unwrap_or_default()"),
            "which is the shape that used to print an empty string into the line: {body}"
        );
        assert_eq!(
            MasterStanding::NO_REASON,
            "no reason was recorded — this predates the requirement",
            "one wording, in one place, because the daemon's unplaced reason has to say the same thing"
        );
    }

    /// Criterion 23. The argument that ended the wait is the half a later
    /// reader needs most, and `master status` is where they look for it.
    #[test]
    fn the_standing_line_says_what_ended_the_last_stand_down() {
        let led = Ledger::open_in_memory().expect("an in-memory ledger opens");
        led.stand_down_master("proj-1", "forge-dev", "dev", "four writes outstanding")
            .unwrap();
        led.stand_up_master("proj-1", "dev", "ISS-1186 removed the path it guarded")
            .unwrap();
        let said = standing_line(Some(&led), "forge-dev");
        assert!(
            said.contains("not stood down"),
            "it does not withhold a pane: {said}"
        );
        assert!(
            said.contains("ISS-1186 removed the path it guarded"),
            "and the record says why the stop was judged safe to reverse: {said}"
        );
        assert!(
            said.contains("four writes outstanding"),
            "beside what was being waited for, because one without the other is half an account: {said}"
        );
    }

    /// What the append-only table buys a person: the episodes behind the
    /// current one, which a single overwritten row could not hold.
    #[test]
    fn the_episodes_behind_the_current_standing_are_printed_under_it() {
        let led = Ledger::open_in_memory().expect("an in-memory ledger opens");
        led.stand_down_master("proj-1", "forge-dev", "dev", "the first wait")
            .unwrap();
        led.stand_up_master("proj-1", "dev", "the first wait ended")
            .unwrap();
        led.stand_down_master("proj-1", "forge-dev", "dev", "the second wait")
            .unwrap();
        let lines = standing_history_lines(Some(&led), "forge-dev", now_unix());
        assert_eq!(
            lines.len(),
            1,
            "one line per episode behind the current one: {lines:?}"
        );
        assert!(
            lines[0].contains("the first wait") && lines[0].contains("the first wait ended"),
            "each carries both halves — what was waited for and what ended it: {lines:?}"
        );
        assert!(
            standing_history_lines(None, "forge-dev", now_unix()).is_empty(),
            "a box whose ledger will not open prints no history rather than a wrong one"
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
