use super::*;

pub(crate) async fn status(ctx: &Ctx, slug: Option<&str>) -> anyhow::Result<()> {
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
pub(crate) fn pane_word(presence: MasterPresence) -> &'static str {
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
pub(crate) fn presence_detail(
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
pub(crate) fn last_exit_line(slug: &str) -> String {
    let found = match runner_platform::config::master_dir(slug) {
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
pub(crate) fn listed(base: &std::path::Path, led: Option<&Ledger>) -> Vec<String> {
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
pub(crate) const ADMISSION_DEADLINE: Duration = Duration::from_secs(5);

/// This box's runner rows as core last served them, or why they could not be
/// read.
///
/// Best effort on purpose: `status` is the command an operator reaches for on
/// a box whose network may be the problem, and refusing to print the pane and
/// the standing because core is unreachable would withhold the two answers
/// that need nothing from core.
pub(crate) enum Admission {
    Read(Vec<runners::MeRunner>),
    Unreadable(String),
}

pub(crate) async fn read_admission(ctx: &Ctx) -> Admission {
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
pub(crate) fn admission_line(admission: &Admission, slug: &str) -> String {
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
pub(crate) fn standing_line(led: Option<&Ledger>, slug: &str) -> String {
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
pub(crate) fn standing_history_lines(led: Option<&Ledger>, slug: &str, now: i64) -> Vec<String> {
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

pub(crate) fn authority_line(
    led: Option<&Ledger>,
    slug: &str,
    now: i64,
    running: &Running<'_>,
) -> String {
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
pub(crate) fn judged_another_pane(
    row: &MasterAuthority,
    running: &Running<'_>,
    slug: &str,
) -> Option<String> {
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
pub(crate) fn span(secs: u64) -> String {
    match secs {
        0..=90 => format!("{secs}s"),
        91..=5400 => format!("{}m", secs / 60),
        _ => format!("{}h{:02}m", secs / 3600, (secs % 3600) / 60),
    }
}

pub(crate) fn ago(secs: i64) -> String {
    span(u64::try_from(secs).unwrap_or(0))
}
