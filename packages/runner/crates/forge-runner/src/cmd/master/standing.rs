use super::*;

/// The reason a standing verb was given, or `None` where it was given nothing
/// it can record.
///
/// Whitespace is the same answer as an absent flag and is refused the same way.
/// A required flag with no content check is a required flag in the help and an
/// optional one in practice, and ` ` is the shortest way past it.
pub(crate) fn reason(given: Option<&str>) -> Option<&str> {
    given.map(str::trim).filter(|w| !w.is_empty())
}

/// How the reason was missing, in the refusal's own first line.
///
/// Two states and not one: somebody who left the flag out has not met the
/// requirement, and somebody who passed an empty string has met it and been
/// told it is not enough. Reading the same sentence for both leaves the second
/// one hunting for a flag they already typed.
pub(crate) fn how_it_was_missing(given: Option<&str>) -> &'static str {
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
pub(crate) fn standing_reason(cmd: &Command) -> anyhow::Result<String> {
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
pub(crate) fn no_reason_to_stand_down(given: Option<&str>, slug: &str) -> String {
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
pub(crate) fn no_reason_to_stand_up(given: Option<&str>, slug: &str) -> String {
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

pub(crate) async fn stand_down(ctx: &Ctx, a: StandDownArgs, why: &str) -> anyhow::Result<()> {
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

pub(crate) async fn stand_up(ctx: &Ctx, a: StandUpArgs, why: &str) -> anyhow::Result<()> {
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
