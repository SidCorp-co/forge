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
//!
//! Where the pane is gone, a line between the first and the second says why
//! the pane this box last placed exited, off the record the daemon keeps
//! beside its transcript, and for a conversation a Claude Code background
//! session holds, which process holds it now. `gone` alone left sid-desk
//! without a master for four and a half hours with nothing on the box saying
//! why (ISS-1343).

use std::time::Duration;

use clap::{Args as ClapArgs, Subcommand};
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::daemon::master::accepts_new_work;
use forge_runner_core::daemon::master_exit::{self, Holding};
use forge_runner_core::daemon::pane_exit;
use forge_runner_core::daemon::recovery::MasterPresence;
use forge_runner_core::daemon::recovery_ports;
use forge_runner_core::daemon::subagent_host::ProcHosts;
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
    // The reason is checked before tmux is. A box without tmux would otherwise
    // answer a standing verb given no reason with "tmux is not installed" — a
    // true sentence about something else, which hides the requirement entirely
    // and sends the caller after the wrong next step. It also keeps the check
    // ahead of everything that could write: the ledger, the core lookup and
    // `--fresh`'s clear of the stored conversation, all of which are below.
    let standing_reason = standing_reason(&args.cmd)?;
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
            match terminal::send_line(&name, &a.text).await? {
                terminal::Prompt::Empty => println!("typed into {name}"),
                terminal::Prompt::Unread => println!(
                    "typed into {name}, but no Claude Code composer could be read there, so \
nothing confirmed its prompt was empty: what was already at it, if anything, went with this"
                ),
            }
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
        Command::StandDown(a) => stand_down(&ctx, a, &standing_reason).await?,
        Command::StandUp(a) => stand_up(&ctx, a, &standing_reason).await?,
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

/// The reason a standing verb carries, refused here where it carries none.
///
/// Taken off the parsed command rather than from inside each verb, so the
/// refusal is reached before the terminal preflight `run` opens with — and
/// before the ledger, the core lookup and `--fresh`'s clear, all of which are
/// further in still. Empty for every verb that asks for no reason.
fn standing_reason(cmd: &Command) -> anyhow::Result<String> {
    let (given, slug, refuse): (_, _, fn(Option<&str>, &str) -> String) = match cmd {
        Command::StandDown(a) => (a.why.as_deref(), a.slug.as_str(), no_reason_to_stand_down),
        Command::StandUp(a) => (a.why.as_deref(), a.slug.as_str(), no_reason_to_stand_up),
        _ => return Ok(String::new()),
    };
    match reason(given) {
        Some(why) => Ok(why.to_string()),
        None => anyhow::bail!(refuse(given, slug)),
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

async fn stand_down(ctx: &Ctx, a: StandDownArgs, why: &str) -> anyhow::Result<()> {
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

async fn stand_up(ctx: &Ctx, a: StandUpArgs, why: &str) -> anyhow::Result<()> {
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
        // The daemon's own three-valued reading: `terminal::alive` folds a tmux
        // nobody could ask into `false`, which printed `gone` for a pane that
        // may be running, and a `last exit` line under it (ISS-1343).
        let presence = recovery_ports::pane_presence(&name).await;
        let alive = presence == MasterPresence::Alive;
        let path = transcript(&s)?;
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        println!(
            "{s:<20} pane      {:<8} {name}  transcript {}KB  ({})",
            pane_word(presence),
            size / 1024,
            path.display()
        );
        if let Some(line) = presence_detail(presence, &name, || last_exit_line(&s)) {
            println!("{:<20} {line}", "");
        }
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

/// The pane column: `unknown` where tmux could not be asked, never `gone`.
fn pane_word(presence: MasterPresence) -> &'static str {
    match presence {
        MasterPresence::Alive => "alive",
        MasterPresence::Gone => "gone",
        MasterPresence::Unanswered | MasterPresence::Unknown => "unknown",
    }
}

/// The line `status` prints under the pane line: why the pane exited where it
/// was read gone, that nothing is known where tmux could not be asked, and
/// nothing for a live pane. `last_exit` is asked only for a pane read gone, so
/// no exit is ever reported under a pane that may be running.
fn presence_detail(
    presence: MasterPresence,
    name: &str,
    last_exit: impl FnOnce() -> String,
) -> Option<String> {
    match presence {
        MasterPresence::Gone => Some(format!("last exit {}", last_exit())),
        MasterPresence::Unanswered | MasterPresence::Unknown => Some(format!(
            "pane: tmux could not be asked about {name}, so whether it runs is not known here and no exit is reported for it"
        )),
        MasterPresence::Alive => None,
    }
}

/// Why the pane this box last placed for `slug` exited, off the record the
/// daemon keeps beside its transcript, with who holds a held conversation read
/// from this box's process table now (ISS-1343).
fn last_exit_line(slug: &str) -> String {
    let found = match forge_runner_core::config::master_dir(slug) {
        Ok(dir) => pane_exit::read(&dir),
        Err(e) => pane_exit::Found::Unavailable(format!(
            "this box's config directory cannot be resolved: {e}"
        )),
    };
    pane_exit::status_line(&found, now_unix(), &ProcHosts::system())
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
