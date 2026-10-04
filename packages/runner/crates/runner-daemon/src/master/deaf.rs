use super::*;

/// What the box did about one pane it found deaf, for the single record the
/// sweep makes about the fleet.
///
/// Separate from `Authority`: that one says what a pane's capability IS and
/// goes to the ledger for every project on every sweep, while this says what
/// was DONE about it and exists only for the projects where there was
/// something to do. A pane replaced ends the sweep recorded `current`, so the
/// authority row alone cannot afterwards say the box found it deaf at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Deaf {
    pub(crate) slug: String,
    pub(crate) pane: String,
    pub(crate) acted: DeafAct,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeafAct {
    /// Ended, and its replacement placed in the same pass.
    Replaced,
    /// Ended, and the placement that was to follow did not finish — the mint,
    /// the skill install, the MCP config or tmux itself refused, each of which
    /// already says so on its own.
    ///
    /// Not the same as leaving it standing and not the same as replacing it:
    /// the project has no pane at all until the next sweep, which is a third
    /// thing to tell a reader. This is what `end_deaf_pane` records, because
    /// ending is all it did; the placement path below it is what upgrades the
    /// answer once a pane is actually up.
    EndedUnplaced,
    /// Left running, with the reason the box did not end it.
    LeftStanding(String),
}

/// Where `ensure_master` leaves that, for the sweep to gather across projects.
#[derive(Default)]
pub(crate) struct DeafSink(pub(crate) Mutex<Option<Deaf>>);

impl DeafSink {
    pub(crate) fn set(&self, slug: &str, pane: &str, acted: DeafAct) {
        *self.0.lock().expect("deaf sink poisoned") = Some(Deaf {
            slug: slug.to_string(),
            pane: pane.to_string(),
            acted,
        });
    }

    /// A pane is up where one was ended, so what the box did is a replacement
    /// after all.
    ///
    /// Only over `EndedUnplaced`: a placement that followed no kill leaves the
    /// sink empty and this a no-op, and one that answered `LeftStanding`
    /// killed nothing to replace.
    pub(crate) fn placed(&self) {
        let mut held = self.0.lock().expect("deaf sink poisoned");
        if let Some(d) = held.as_mut() {
            if d.acted == DeafAct::EndedUnplaced {
                d.acted = DeafAct::Replaced;
            }
        }
    }

    pub(crate) fn take(&self) -> Option<Deaf> {
        self.0.lock().expect("deaf sink poisoned").take()
    }
}

/// What the box does about the capability a resident pane turned out to hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CapabilityAct {
    /// Nothing: the pane can be heard, or this box cannot say that it cannot.
    Keep,
    /// End it and place one that carries a capability for the session core
    /// serves now.
    Replace,
    /// It cannot be heard and the box still leaves it running, for this reason.
    LeaveDeaf(&'static str),
}

/// The three conditions ISS-1208 puts on acting, read off the two facts that
/// carry them.
///
/// **The condition is precise.** Only `Stale` is evidence about a pane.
/// `Unknown` is evidence about this box's own capability map and says nothing
/// about any pane, so a map that could not be read never ends one — which is
/// the whole reason `capability_of` keeps three answers rather than two.
///
/// **A replacement would be placed.** `AdoptOrStart` is the sweep's own reading
/// that this project has admissible work; under `AdoptOnly` the placement path
/// below the adopt branch refuses to start anything, so ending the pane would
/// buy an empty project instead of a working master.
///
/// The other two of the three are already true wherever this is reached:
/// `ensure_master` returned early if tmux is absent, the sweep's stand-down
/// gate ran before it, and the command that resolves the condition is the one
/// the daemon has been printing for an operator to type since ISS-1099.
pub(crate) fn capability_act(verdict: &Capability, placement: Placement) -> CapabilityAct {
    match (verdict, placement) {
        (Capability::Stale, Placement::AdoptOrStart) => CapabilityAct::Replace,
        (Capability::Stale, Placement::AdoptOnly) => CapabilityAct::LeaveDeaf(
            "this project has no admissible work, so no replacement would be placed in its stead",
        ),
        (Capability::Current | Capability::Unknown(_), _) => CapabilityAct::Keep,
    }
}

/// The capability map's answer, overruled where this box knows that answer came
/// from a mint it could not take back.
///
/// `capability_of` reads the map, and the map is the only durable evidence
/// there is. Where a placement minted an entry and then placed no pane, the
/// withdrawal is what puts the map right — and a withdrawal that could not be
/// written leaves `Current` standing about a pane that was never replaced. The
/// box would then stop reporting the project deaf and go on nudging a pane that
/// refuses every declaration it makes, which is this issue's own incident with
/// the alarm taken out. Criterion 7 asks that the verdict STAY stale, which is
/// a claim about every later sweep and not only the one that found it.
///
/// `Unknown` is never overruled. A map this box could not read is not evidence
/// about any pane in either direction, and the rule that an unreadable map ends
/// nothing is older than this one.
pub(crate) fn verdict_over_unwithdrawn(
    verdict: Capability,
    unwithdrawn: Option<&str>,
    session_id: &str,
) -> Capability {
    match (&verdict, unwithdrawn) {
        (Capability::Current, Some(held)) if held == session_id => Capability::Stale,
        _ => verdict,
    }
}

/// What `ensure_master` is given to consult and to answer into: this box's own
/// capability map, the sink the verdict about it goes to, and the sink for what
/// was done where the verdict earned an act.
///
/// One struct rather than three parameters because `ensure_master` sits at
/// exactly the argument count `clippy::too_many_arguments` allows.
pub(crate) struct CapabilityPorts<'a> {
    pub(crate) tokens: Option<&'a session_tokens::SessionTokens>,
    pub(crate) authority: &'a AuthoritySink,
    pub(crate) deaf: &'a DeafSink,
}

/// What this box can say about the capability the resident master pane holds.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Capability {
    /// A capability this box minted answers for the pane: a record naming its
    /// project and pane, or any entry naming the session core serves it now.
    Current,
    /// None does, so the pane is running on a capability minted before the
    /// record for a session that is gone, and every declaration it makes will
    /// be refused.
    Stale,
    /// This box cannot read its own map, so it says nothing about any pane.
    Unknown(String),
}

/// Judge a resident pane's capability from this box's own record of what it
/// minted.
///
/// The pane's token lives in its environment and is out of reach here, but the
/// map is not: `mint` leaves exactly one entry per pane, naming the project and
/// pane it was placed as (ISS-1316). A record for this project and pane answers
/// whatever session core has since moved the pane to. A map holding neither
/// that nor anything for the session core now gives us is a pane holding a
/// capability minted before the record, adopted onto a row core replaced —
/// whether at this call or at one three restarts ago.
///
/// `session.created` answers only the first of those, which is why one project
/// of seven was reported on 2026-09-18 and the one that was actually stuck was
/// not (ISS-1099).
pub(crate) fn capability_of(
    tokens: Option<&session_tokens::SessionTokens>,
    session_id: &str,
    project_id: &str,
    pane: &str,
) -> Capability {
    let Some(store) = tokens else {
        return Capability::Unknown(
            "this box could not resolve where its capability map lives".to_string(),
        );
    };
    match store.answers_for(session_id, project_id, pane) {
        Ok(true) => Capability::Current,
        Ok(false) => Capability::Stale,
        Err(e) => Capability::Unknown(e.to_string()),
    }
}

/// End a pane this box has proved it can never hear again, and say so.
///
/// `false` where tmux refused: the caller then takes the branch that leaves the
/// pane standing and records `stale` about it, so a kill that did not happen is
/// never written down as one that did.
///
/// The report is an error rather than a warning, and says what ends with the
/// pane. Whatever that master had running is a subagent of its own session and
/// dies with it; the box is choosing that over a project that can never take
/// work again, and a reader who is not told which of the two they got cannot
/// tell this line from a crash.
pub(crate) async fn end_deaf_pane(
    name: &str,
    slug: &str,
    session_id: &str,
    deaf: &DeafSink,
) -> bool {
    if let Err(e) = terminal::kill(name).await {
        tracing::error!(
            "[master] {slug}: {name} holds a capability for a session this box no longer has and could not be ended: {e}. It stays up and stays deaf — every declaration it makes is refused — and `forge-runner master kill {slug}` is the same act by hand."
        );
        deaf.set(
            slug,
            name,
            DeafAct::LeftStanding(format!("this box could not end it: {e}")),
        );
        return false;
    }
    tracing::error!(
        "[master] {slug}: ended the resident session {name} — it held a capability for a session this box no longer has, core's session for it is {session_id}, and a running pane cannot be handed a new one, so every declaration it made was refused. This is `forge-runner master kill {slug}` taken by the box instead of by a person, and it is taken only where a replacement would be placed in its stead, which this pass is about to do. Whatever that pane was running ended with it; the replacement resumes the same conversation."
    );
    // `EndedUnplaced` and not `Replaced`: this function ended a pane and that
    // is the whole of what it knows. The placement below can still refuse —
    // the mint, the skill, the MCP config, tmux — and an account that said
    // `replaced` here would be telling a reader a pane is up that is not.
    deaf.set(slug, name, DeafAct::EndedUnplaced);
    true
}

/// What a pass that ended a deaf pane may conclude from what `terminal::ensure`
/// then answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Replacement {
    /// A pane was started where the deaf one had been.
    Placed,
    /// `ensure` started nothing, because a session of that name was ALREADY
    /// alive. On a pass that ended a pane moments earlier, that session is the
    /// pane this box thought it had ended.
    DeafPaneSurvived,
    /// This pass ended nothing, so a pane already up is the ordinary case and
    /// says nothing about any deaf one.
    NoDeafPane,
}

/// The second reading of whether a deaf pane is gone, taken from the one thing
/// that looked afterwards.
///
/// `terminal::kill` now answers for the session being gone, so this is a
/// guard and not the detector. It costs nothing: `terminal::ensure` already
/// asks whether a session of that name is alive, and `Ok(false)` IS that
/// answer — it was being discarded at the call (ISS-1208). The two readings
/// fail independently, and the one that is left is what decides whether the
/// box writes down a replacement.
pub(crate) fn replacement_of(ended_a_deaf_pane: bool, started: bool) -> Replacement {
    match (ended_a_deaf_pane, started) {
        (false, _) => Replacement::NoDeafPane,
        (true, true) => Replacement::Placed,
        (true, false) => Replacement::DeafPaneSurvived,
    }
}

/// Take back a capability minted for a pane that was never started, and answer
/// for it having gone.
///
/// `retire` cannot answer for itself: it logs and returns on both a map it
/// could not read and a map it could not write, which is the right shape for a
/// caller that is tidying up after a session that has already ended. Here it is
/// a rollback, and a rollback nobody checked is what leaves the session core now
/// serves sitting in the map as proof of a replacement this box did not make —
/// `capability_of` then answers `Current` about a deaf pane for ever (ISS-1208).
///
/// So the map is read back. `Err` carries what stopped it in words a caller can
/// put in front of a person.
pub(crate) fn withdraw_unplaced_mint(
    tokens: Option<&session_tokens::SessionTokens>,
    session_id: &str,
) -> std::result::Result<(), String> {
    let Some(store) = tokens else {
        // Not reachable from the placement path, which returns `Absent` rather
        // than reaching a pane with no map to mint from. Stated rather than
        // assumed, because what it would mean is a mint nothing can take back.
        return Err("this box has no capability map to withdraw from".to_string());
    };
    store.retire(session_id);
    match store.holds_session(session_id) {
        Ok(false) => Ok(()),
        Ok(true) => Err("the map still names that session after the withdrawal, so the map could not be written".to_string()),
        Err(e) => Err(format!("the map could not be read back, so whether the withdrawal took is unknown: {e}")),
    }
}

/// A pane this box ended, that is still there — and the capability it minted on
/// the way, withdrawn.
///
/// The mint is the part that cannot be left. It runs before anything looks at
/// whether a pane was replaced, because the token has to be in the environment
/// the pane is started with; so by the time this is known, the session core now
/// serves is already in this box's capability map. Leave it there and
/// `capability_of` answers `Current` on every later sweep about a pane still
/// holding the old token: the stale arm never fires again, the operator is
/// never told, and the box nudges a master that refuses every declaration it
/// makes — this issue's own incident with the alarm taken out. Retiring it puts
/// the verdict back to `stale`, which is what is true, and the next sweep tries
/// the kill again.
///
/// Nothing holds the retired token: `ensure` started no pane, so it was never
/// handed to one.
///
/// And the withdrawal is READ BACK, by the same rule the rest of this change
/// is: `retire` is best-effort by design — it declines to rewrite a map it
/// could not read, and a map it could not write leaves the entry live — so
/// taking it as done is the assumption this whole issue is about. Where it
/// cannot be established, the box says which of the two it got and what an
/// operator has to do, rather than reporting a rollback it did not make.
pub(crate) async fn deaf_pane_outlived_its_kill(
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
    name: &str,
    session_id: &str,
    ports: &CapabilityPorts<'_>,
) -> PaneState {
    let withdrawn = withdraw_unplaced_mint(ports.tokens, session_id);
    // Held across sweeps where it failed, released where it took. This is what
    // makes the verdict STAY stale: the map still says `current`, and nothing
    // that could correct the map is available to a box that could not write it.
    masters.note_unwithdrawn(project_id, withdrawn.as_ref().err().map(|_| session_id));
    match &withdrawn {
        Ok(()) => tracing::error!(
            "[master] {slug}: {name} was ended as a deaf pane and tmux still holds a session of that name, so nothing was replaced — the capability minted for {session_id} has been withdrawn rather than left standing as proof of a replacement this box did not make. The pane is still deaf and every declaration it makes is refused: `forge-runner master kill {slug}` is the same act by hand."
        ),
        Err(why) => tracing::error!(
            "[master] {slug}: {name} was ended as a deaf pane and is still running, and the capability minted for {session_id} could NOT be withdrawn: {why}. The map on disk now names a session no pane holds, so this daemon holds that fact itself and goes on reading {slug} as stale — it will report this and try the pane again every sweep, and a placement that works clears it. What it cannot survive is its own restart, which would read the map at face value again: fix whatever stopped this box writing its capability map, or `forge-runner master kill {slug}` and let the replacement mint cleanly."
        ),
    }
    ports.deaf.set(
        slug,
        name,
        DeafAct::LeftStanding(match &withdrawn {
            Ok(()) => "this box ended it and tmux still holds a session of that name".to_string(),
            Err(why) => format!(
                "this box ended it, tmux still holds a session of that name, and the capability minted for the replacement could not be withdrawn ({why}) — held in this daemon and retried every sweep, but not across a restart of it"
            ),
        }),
    );
    // As in the stale arm of the adopt branch, and for the same reason: the
    // project has no working master, so the registry may not be cleared.
    masters.note_unplaced(
        project_id,
        Unplaced::StaleCapability {
            session: session_id.to_string(),
            pane: name.to_string(),
        },
    );
    masters.note_capability(project_id, MasterAuthority::STALE);
    ports.authority.set(
        name,
        terminal::incarnation(name).await,
        MasterAuthority::STALE,
        None,
    );
    PaneState::StaleCapability
}

/// The one record a sweep makes about deaf masters on this box.
///
/// A fleet whose panes were all minted against sessions one event replaced is a
/// condition of the BOX, and four per-project lines is four readers each
/// finding a quarter of it (ISS-1208). `None` where this sweep found none, or
/// where it found the same ones it found last time.
pub(crate) fn deaf_fleet_report(found: &[Deaf]) -> Option<(bool, String)> {
    if found.is_empty() {
        return None;
    }
    let mut replaced: Vec<&str> = Vec::new();
    let mut unplaced: Vec<&str> = Vec::new();
    let mut standing: Vec<String> = Vec::new();
    for d in found {
        match &d.acted {
            DeafAct::Replaced => replaced.push(&d.slug),
            DeafAct::EndedUnplaced => unplaced.push(&d.slug),
            DeafAct::LeftStanding(why) => standing.push(format!("{} ({why})", d.slug)),
        }
    }
    let mut out = format!(
        "[master] {} master pane(s) on this box hold a capability for a session core has replaced, which is what one event under a live fleet does to every pane at once: {}.",
        found.len(),
        found.iter().map(|d| d.pane.as_str()).collect::<Vec<_>>().join(", ")
    );
    if !replaced.is_empty() {
        out.push_str(&format!(
            " Ended and replaced by this box, carrying the capability core serves now: {}.",
            replaced.join(", ")
        ));
    }
    if !unplaced.is_empty() {
        out.push_str(&format!(
            " Ended, and the pane that was to take their place did not start this pass — the line above this one says which step refused, and the next sweep tries again from no pane at all: {}.",
            unplaced.join(", ")
        ));
    }
    if !standing.is_empty() {
        out.push_str(&format!(
            " Still running and still deaf, which no sweep will change: {}. `forge-runner master kill <slug>` is what ends each, and `forge-runner master status` says the same without this log.",
            standing.join("; ")
        ));
    }
    Some((!standing.is_empty() || !unplaced.is_empty(), out))
}

/// What the latch is keyed on: which panes, and what was done about each.
///
/// Length-prefixed rather than joined on a separator, because one of the parts
/// is a `LeftStanding` reason and that is an error string this code did not
/// write — tmux's, or an io error's. A plain separator lets one pane carrying a
/// reason that happens to contain the separator produce the same digest as two
/// panes do, and a latch keyed on a colliding digest stays silent about a
/// condition it has never reported. The length is what makes the encoding
/// unambiguous whatever the reason says.
pub(crate) fn deaf_digest(found: &[Deaf]) -> String {
    let mut parts: Vec<String> = found
        .iter()
        .map(|d| {
            let act = match &d.acted {
                DeafAct::Replaced => "replaced".to_string(),
                DeafAct::EndedUnplaced => "ended-unplaced".to_string(),
                DeafAct::LeftStanding(why) => format!("standing:{why}"),
            };
            let part = format!("{}={act}", d.pane);
            format!("{}:{part}", part.len())
        })
        .collect();
    parts.sort();
    parts.concat()
}

/// Say it, once per change of the set.
pub(crate) fn report_deaf_fleet(masters: &Arc<Masters>, found: &[Deaf]) {
    let digest = (!found.is_empty()).then(|| deaf_digest(found));
    if !masters.claim_deaf_report(digest) {
        return;
    }
    let Some((needs_a_person, said)) = deaf_fleet_report(found) else {
        return;
    };
    if needs_a_person {
        tracing::error!("{said}");
    } else {
        tracing::warn!("{said}");
    }
}
