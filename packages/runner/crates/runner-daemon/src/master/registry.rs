use super::*;

#[derive(Default)]
pub struct Masters(pub(crate) Arc<Mutex<Registry>>);

/// The live masters, and what this box has seen the dead ones do.
#[derive(Default)]
pub(crate) struct Registry {
    pub(crate) live: HashMap<String, MasterState>,
    /// What the last sweep read as this box's projects.
    pub(crate) served: Served,
    /// Why each project's master pane was not placed on the last sweep.
    pub(crate) unplaced: HashMap<String, Unplaced>,
    /// The last thing this box said about each project's pane, so a project
    /// stuck in one state is reported on the sweep that finds it and not on all
    /// forty-five after it.
    ///
    /// Keyed by project rather than held on `MasterState`, because every one of
    /// its callers can run for a project this daemon holds no live master for —
    /// which is every project on a daemon that has just started, since `live`
    /// is filled by `remember` and `remember` runs after the sweep's first two
    /// reports. Held on the state, the latch answered "already said" about a
    /// project nothing had said anything about, and the report was lost
    /// (ISS-1099; it is why ISS-1118's contradiction error fired only on the
    /// daemon that placed the pane).
    pub(crate) said: HashMap<String, &'static str>,
    /// The last box-level account of deaf masters this daemon gave, as the
    /// digest of the whole set and what was done about each.
    ///
    /// A digest of the set rather than a count, because four projects deaf and
    /// four others deaf in their place is not the same condition and reads
    /// identically by number. `None` once a sweep finds none, so a fleet that
    /// goes deaf a second time is news again.
    pub(crate) deaf_said: Option<String>,
    /// Per project, a session whose capability this box minted for a pane it
    /// then failed to place AND failed to withdraw.
    ///
    /// The map on disk is the detector, and a mint that could not be taken back
    /// out of it says `current` about a pane that was never replaced. Nothing
    /// on disk can correct that — the correction IS the write that failed — so
    /// the box holds what it knows here and refuses to read that entry as
    /// evidence until the withdrawal takes. The retry is the ordinary sweep:
    /// the verdict stays `stale`, the pane is ended again, and a placement that
    /// works clears this (ISS-1208, criterion 7).
    ///
    /// In this process only. A daemon restarted with an entry still unwithdrawn
    /// reads the map at face value again: a priced residual, not a closed one.
    pub(crate) unwithdrawn: HashMap<String, String>,
    /// The projects whose master pane tmux could not be asked about on the last
    /// sweep, so the account is given when the read first goes unanswered and
    /// not on every sweep it stays that way.
    pub(crate) unanswered: std::collections::HashSet<String>,
    /// When this box last placed each project's pane, and where its output is
    /// kept from, so what the pane printed is read without what earlier panes
    /// printed before it.
    pub(crate) placed: HashMap<String, PlacedPane>,
    /// The conversation a pane this box placed exited over, saying Claude Code
    /// runs it as a background session, with the short id that refusal
    /// printed. No pane resuming it is placed while a process on this box
    /// names it (ISS-1312, F1).
    pub(crate) elsewhere: HashMap<String, (String, Option<String>)>,
    /// Consecutive early exits of each project's pane for one reason, which
    /// decide only what the journal says (ISS-1343).
    pub(crate) exits: HashMap<String, pane_exit::Tally>,
    /// What this box last said about each project's outdated pane, so the
    /// account is given once per pane and reason rather than once a sweep
    /// (ISS-1379).
    pub(crate) outdated: HashMap<String, String>,
    /// Per project, the master session core last kept draining and why: a
    /// draining master is outdated, and the box admits no new run declaration
    /// from that session so what it holds runs out and core replaces it.
    pub(crate) draining: HashMap<String, (String, String)>,
    /// Per project, the master session and the dialog last reported to core
    /// for its pane, so a dialog standing for an hour is one report.
    pub(crate) dialog_said: HashMap<String, (String, Option<String>)>,
    /// Per project, the master session and its turn count when its last
    /// pass settled: a turn started past it with no pass open is one the
    /// runner did not nudge, and is recorded as an unprompted pass.
    pub(crate) turns_settled: HashMap<String, (String, u64)>,
}

/// One pane this box placed: when, and where its output begins.
pub(crate) struct PlacedPane {
    pub(crate) at: Instant,
    /// The transcript and its length when the pane started; `None` where the
    /// pane was placed with no transcript.
    pub(crate) output: Option<(std::path::PathBuf, u64)>,
}

pub(crate) struct MasterState {
    pub(crate) session_id: String,
    pub(crate) name: String,
    /// When this project's pool last held anything at all.
    pub(crate) last_work: Instant,
    /// The work this master was last nudged about, when, and what its own hooks
    /// had reported by then.
    pub(crate) last_nudge: Option<Nudge>,
    pub(crate) mcp_stale_reported: bool,
}

impl Masters {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn live_for_project(&self, project_id: &str) -> Option<(String, String)> {
        self.get(project_id)
    }

    pub(crate) fn get(&self, project_id: &str) -> Option<(String, String)> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .get(project_id)
            .map(|m| (m.session_id.clone(), m.name.clone()))
    }

    pub(crate) fn remember(&self, project_id: &str, state: MasterState) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.live.insert(project_id.to_string(), state);
    }

    /// `f` over the session this box serves `pane` under as `project_id`'s
    /// master, with the registry held so no adoption moves it meanwhile, or
    /// `None` where `pane` is not that master.
    pub fn while_live<R>(
        &self,
        project_id: &str,
        pane: &str,
        f: impl FnOnce(&str) -> R,
    ) -> Option<R> {
        let reg = self.0.lock().expect("masters poisoned");
        let m = reg.live.get(project_id).filter(|m| m.name == pane)?;
        Some(f(&m.session_id))
    }

    /// Serve the live pane for this project under `session_id`, keeping
    /// everything else this box knows about it, and answer the session it
    /// was served under before where that differs.
    pub(crate) fn readopt(&self, project_id: &str, session_id: &str) -> Option<String> {
        let mut reg = self.0.lock().expect("masters poisoned");
        let m = reg.live.get_mut(project_id)?;
        if m.session_id == session_id {
            return None;
        }
        Some(std::mem::replace(&mut m.session_id, session_id.to_string()))
    }

    /// This project's pool held something; the idle clock restarts.
    pub(crate) fn note_work(&self, project_id: &str) {
        let mut reg = self.0.lock().expect("masters poisoned");
        if let Some(m) = reg.live.get_mut(project_id) {
            m.last_work = Instant::now();
        }
    }

    /// True the first time a project's live pane is found behind its config,
    /// and false every sweep after, until the pane matches again.
    pub(crate) fn claim_mcp_stale(&self, project_id: &str) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let Some(m) = reg.live.get_mut(project_id) else {
            // Not in this process's registry — a pane it did not start, and one
            // it has therefore never reported. Say it.
            return true;
        };
        if m.mcp_stale_reported {
            return false;
        }
        m.mcp_stale_reported = true;
        true
    }

    /// The pane matches again; the next mismatch is worth saying.
    pub(crate) fn clear_mcp_stale(&self, project_id: &str) {
        let mut reg = self.0.lock().expect("masters poisoned");
        if let Some(m) = reg.live.get_mut(project_id) {
            m.mcp_stale_reported = false;
        }
    }

    /// Record what this box now says about a pane's capability, and answer
    /// whether that is a change from what it last said.
    ///
    /// Answers `true` for a project it has said nothing about yet, whether or
    /// not this daemon holds a live master for it: a project absent from the
    /// registry is one nothing here has ever reported, so the first thing said
    /// about it is a change.
    ///
    /// The latch used to live on the `reg.live` entry, which `remember` fills
    /// and which is empty for every project on a daemon that has just started.
    /// A caller reached before the pane was adopted therefore asked a latch that
    /// answered "already said" about a project nothing had said anything about,
    /// and the report was lost. ISS-1118's two reports route through
    /// `note_unplaced` for a reason of their own — they are about a project
    /// that reaches no pane at all — and that stands whichever way this answers.
    /// Hold, or release, the knowledge that this project's capability map
    /// names a session for a pane that was never placed.
    pub(crate) fn note_unwithdrawn(&self, project_id: &str, session_id: Option<&str>) {
        let mut reg = self.0.lock().expect("masters poisoned");
        match session_id {
            Some(id) => reg
                .unwithdrawn
                .insert(project_id.to_string(), id.to_string()),
            None => reg.unwithdrawn.remove(project_id),
        };
    }

    pub(crate) fn unwithdrawn_for(&self, project_id: &str) -> Option<String> {
        self.0
            .lock()
            .expect("masters poisoned")
            .unwithdrawn
            .get(project_id)
            .cloned()
    }

    /// Record whether this sweep's read of the project's pane went unanswered,
    /// and answer whether that is a change from the last sweep's.
    pub(crate) fn note_unanswered(&self, project_id: &str, unanswered: bool) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        if unanswered {
            reg.unanswered.insert(project_id.to_string())
        } else {
            reg.unanswered.remove(project_id)
        }
    }

    /// Whether what this sweep found about the project's outdated pane is news,
    /// and remember it either way. `None` is a pane that is current or gone.
    pub(crate) fn note_outdated(&self, project_id: &str, said: Option<String>) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        match said {
            Some(said) => reg.outdated.insert(project_id.to_string(), said.clone()) != Some(said),
            None => reg.outdated.remove(project_id).is_some(),
        }
    }

    /// Remember whether core keeps `session` draining (`None`: it does not),
    /// answering whether that is news since the last sweep.
    pub(crate) fn note_draining(
        &self,
        project_id: &str,
        session: &str,
        because: Option<String>,
    ) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        match because {
            Some(because) => {
                let now = (session.to_string(), because);
                reg.draining.insert(project_id.to_string(), now.clone()) != Some(now)
            }
            None => reg.draining.remove(project_id).is_some(),
        }
    }

    /// Why `session` may declare no new run for the project, where core's
    /// last verdict kept that very session draining. A successor's session
    /// is never the drained one, so a replacement declares at once. Read only
    /// by the control socket, which is unix's.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn draining(&self, project_id: &str, session: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.draining
            .get(project_id)
            .filter(|(drained, _)| drained == session)
            .map(|(_, because)| because.clone())
    }

    /// Whether `dialog` on `session`'s pane is news to core, and remember it.
    pub(crate) fn claim_dialog_report(
        &self,
        project_id: &str,
        session: &str,
        dialog: Option<&str>,
    ) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let now = (session.to_string(), dialog.map(str::to_string));
        reg.dialog_said.insert(project_id.to_string(), now.clone()) != Some(now)
    }

    /// Forget the dialog report, so the next sweep sends it again.
    pub(crate) fn forget_dialog_report(&self, project_id: &str) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.dialog_said.remove(project_id);
    }

    pub(crate) fn note_turns_settled(&self, project_id: &str, session: &str, turns: u64) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.turns_settled
            .insert(project_id.to_string(), (session.to_string(), turns));
    }

    /// The turn count `session`'s last pass settled at, `None` where none
    /// settled under that session in this process.
    pub(crate) fn turns_settled(&self, project_id: &str, session: &str) -> Option<u64> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.turns_settled
            .get(project_id)
            .filter(|(s, _)| s == session)
            .map(|(_, n)| *n)
    }

    /// Every project this box serves a live master for, with its session.
    pub(crate) fn live_sessions(&self) -> Vec<(String, String)> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .iter()
            .map(|(p, m)| (p.clone(), m.session_id.clone()))
            .collect()
    }

    pub(crate) fn note_capability(&self, project_id: &str, said: &'static str) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let changed = reg.said.get(project_id) != Some(&said);
        reg.said.insert(project_id.to_string(), said);
        changed
    }

    /// Whether the box-level account of deaf masters this sweep reached is
    /// news, and remember it either way.
    ///
    /// `None` is a sweep that found none: it clears the latch and answers
    /// `false`, because a fleet that is well is not a thing to announce. The
    /// latch is the same rule `note_capability` holds for one project, moved up
    /// to the box — a condition that persists is stated on the sweep that
    /// reaches it and not on all forty-five after it.
    pub(crate) fn claim_deaf_report(&self, digest: Option<String>) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let news = digest.is_some() && reg.deaf_said != digest;
        reg.deaf_said = digest;
        news
    }

    /// The box's own record of its last nudge to this project's master.
    pub(crate) fn last_nudge(&self, project_id: &str) -> Option<Nudge> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live.get(project_id).and_then(|m| m.last_nudge.clone())
    }

    /// Record a nudge core asked for: the work it was about, now, and the
    /// prompt count its pane had reported by then.
    pub(crate) fn note_nudged(&self, project_id: &str, digest: &str, prompts: Option<u64>) {
        let mut reg = self.0.lock().expect("masters poisoned");
        if let Some(m) = reg.live.get_mut(project_id) {
            m.last_nudge = Some(Nudge {
                digest: digest.to_string(),
                at: Instant::now(),
                prompts,
            });
        }
    }

    /// How long this project has had nothing, or `None` if it has no master.
    pub(crate) fn idle_for(&self, project_id: &str) -> Option<Duration> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live.get(project_id).map(|m| m.last_work.elapsed())
    }

    pub(crate) fn forget(&self, project_id: &str) -> Option<String> {
        let mut reg = self.0.lock().expect("masters poisoned");
        // The unwithdrawn marker goes with it. It says one thing — this
        // project's capability map names a session no pane holds — and a
        // project this box is no longer tracking has no pane for it to be
        // about. Left behind, it is a session id waiting to be matched by
        // whatever core hands out next (ISS-1208).
        reg.unwithdrawn.remove(project_id);
        reg.live.remove(project_id).map(|m| m.session_id)
    }

    pub fn project_for_session(&self, session_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .iter()
            .find(|(_, m)| m.session_id == session_id)
            .map(|(project_id, _)| project_id.clone())
    }

    /// Record what core just answered for this device, or why it could not be
    /// read.
    pub(crate) fn note_served(&self, served: Served) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.served = served;
    }

    /// What this registry serves, for the image a handover's exec starts.
    /// Unix only, where a handover is an exec.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn hand_on(&self) -> (Option<Vec<String>>, Vec<master_handed::HandedMaster>) {
        let reg = self.0.lock().expect("masters poisoned");
        let served = match &reg.served {
            Served::Read(ids) => Some(ids.clone()),
            Served::Unread | Served::Unreadable(_) => None,
        };
        let mut masters: Vec<_> = reg
            .live
            .iter()
            .map(|(project_id, m)| master_handed::HandedMaster {
                project_id: project_id.clone(),
                session_id: m.session_id.clone(),
                pane: m.name.clone(),
            })
            .collect();
        masters.sort_by(|a, b| a.project_id.cmp(&b.project_id));
        (served, masters)
    }

    /// Serve the panes the image before this one served, as it served them,
    /// until this image's first sweep reads them for itself. Answers how many.
    pub(crate) fn take_handed(&self, handed: master_handed::Handed) -> usize {
        let mut reg = self.0.lock().expect("masters poisoned");
        if let Some(ids) = handed.served {
            reg.served = Served::Read(ids);
        }
        let n = handed.masters.len();
        for m in handed.masters {
            reg.live.insert(
                m.project_id,
                MasterState {
                    session_id: m.session_id,
                    name: m.pane,
                    last_work: Instant::now(),
                    last_nudge: None,
                    mcp_stale_reported: false,
                },
            );
        }
        n
    }

    pub(crate) fn note_unplaced(&self, project_id: &str, why: Unplaced) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let changed = reg.unplaced.get(project_id) != Some(&why);
        reg.unplaced.insert(project_id.to_string(), why);
        changed
    }

    pub(crate) fn note_placed(&self, project_id: &str, output: Option<(std::path::PathBuf, u64)>) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.placed.insert(
            project_id.to_string(),
            PlacedPane {
                at: Instant::now(),
                output,
            },
        );
    }

    pub(crate) fn take_placed(&self, project_id: &str) -> Option<PlacedPane> {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.placed.remove(project_id)
    }

    /// Count an exit into this project's run of early exits, answering its
    /// place in it and the named run it ended, if any.
    pub(crate) fn count_exit(
        &self,
        project_id: &str,
        lived: Option<Duration>,
        exit: &pane_exit::Exit,
    ) -> pane_exit::Counted {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.exits
            .entry(project_id.to_string())
            .or_default()
            .count(lived, exit)
    }

    /// This project's pane was read up past the early window after its
    /// placement: ends its run of early exits, answering the run's length
    /// where it had been named as a condition.
    pub(crate) fn outlived(&self, project_id: &str) -> Option<u32> {
        let mut reg = self.0.lock().expect("masters poisoned");
        let past = reg
            .placed
            .get(project_id)
            .is_some_and(|p| p.at.elapsed() >= pane_exit::EARLY_EXIT);
        if !past {
            return None;
        }
        reg.exits
            .get_mut(project_id)
            .and_then(pane_exit::Tally::outlived)
    }

    pub(crate) fn note_elsewhere(
        &self,
        project_id: &str,
        conversation: String,
        short: Option<String>,
    ) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.elsewhere
            .insert(project_id.to_string(), (conversation, short));
    }

    pub(crate) fn elsewhere(&self, project_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.elsewhere.get(project_id).map(|(c, _)| c.clone())
    }

    pub(crate) fn elsewhere_short(&self, project_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.elsewhere.get(project_id).and_then(|(_, s)| s.clone())
    }

    pub(crate) fn clear_elsewhere(&self, project_id: &str) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.elsewhere.remove(project_id);
    }

    /// This project's pane was placed; nothing stands against it any more.
    pub(crate) fn clear_unplaced(&self, project_id: &str) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.unplaced.remove(project_id);
    }

    pub fn why_unplaced(&self, project_id: &str) -> String {
        let reg = self.0.lock().expect("masters poisoned");
        if let Some(m) = reg.live.get(project_id) {
            return format!(
                "this box's master for {project_id} is session {} in pane {}, and your capability names a different session — it was minted for a session core has since replaced, so this pane's capability is stale and nothing this daemon does will place it. A pane cannot be handed a new capability: end this one, and a fresh master starts for {project_id} in its place",
                m.session_id, m.name
            );
        }
        match &reg.served {
            Served::Unread => format!(
                "this box has not yet read which projects it serves, so it cannot say whether it serves {project_id} at all — nothing here has an answer for you yet"
            ),
            Served::Unreadable(why) => format!(
                "this box could not read which projects it serves ({why}), so it cannot say whether it serves {project_id} at all — nothing here has an answer for you yet"
            ),
            Served::Read(ids) if !ids.iter().any(|id| id == project_id) => format!(
                "this box does not serve {project_id} — core's last answer for this device named {} project(s) and that was not one of them, so no sweep here will place a master for it",
                ids.len()
            ),
            Served::Read(_) => match reg.unplaced.get(project_id) {
                Some(why) => format!(
                    "this daemon has placed no master for {project_id}: {why}. That is the state its last sweep found, and the next sweep finds the same until it changes"
                ),
                None => format!(
                    "this daemon does not yet hold a master session for {project_id}; its next sweep places one, and a declaration made after that is served"
                ),
            },
        }
    }

    pub fn pane_for_session(&self, session_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .values()
            .find(|m| m.session_id == session_id)
            .map(|m| m.name.clone())
    }
}

#[cfg(test)]
mod draining_tests {
    use super::*;

    #[test]
    fn a_drained_session_is_refused_and_its_successor_is_not() {
        let masters = Masters::new();
        assert!(masters.note_draining("p", "s1", Some("outdated".into())));
        assert!(
            !masters.note_draining("p", "s1", Some("outdated".into())),
            "the same drain said twice is not news"
        );
        assert_eq!(masters.draining("p", "s1").as_deref(), Some("outdated"));
        assert_eq!(
            masters.draining("p", "s2"),
            None,
            "a successor's session was refused for its predecessor's drain"
        );
        assert_eq!(masters.draining("q", "s1"), None);
        assert!(masters.note_draining("p", "s1", None));
        assert_eq!(masters.draining("p", "s1"), None);
    }
}
