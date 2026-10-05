use super::*;

/// What a job pane is started with beyond where it runs and what it is told: the project's
/// declared servers, and the model and denied tools of the policy state core prepared it under.
pub struct Launch<'a> {
    pub servers: &'a serde_json::Map<String, serde_json::Value>,
    pub model: &'a str,
    pub denied_tools: &'a [String],
}

pub(crate) const HEARTBEAT_KIND: &str = "progress";

/// One job this box is running, the pane it is running in, what this box may
/// conclude from that pane's silence, and what the last sweep read of its
/// agent.
///
/// `seen` is on the record rather than only in memory because `Activities` is
/// in memory: after a restart a pane that went quiet BEFORE it never reports
/// again, and without the snapshot it reads as a session that has said nothing
/// — kept for the rest of its life by the rule meant to protect a pane that is
/// mid-turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Live {
    pub job_id: String,
    pub pane: String,
    pub watch: Watch,
    pub seen: Option<job_exit::Reported>,
    /// Where the pane's conversation is written, as its hooks last named it.
    /// On the record for the same reason `seen` is: a pane whose `Stop` was
    /// lost across a restart never speaks to the next daemon, and this path is
    /// the only thing that daemon can age it by (ISS-1244).
    pub transcript: Option<String>,
    /// When this box opened the pane, which is when the slot was taken. On the
    /// record so the age a person reads survives the daemon that counted it;
    /// `None` on a record a daemon before this field wrote.
    pub opened_at: Option<i64>,
}

/// A slot this box is holding, for the one line an operator reads when it can
/// take no more work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holding {
    pub job_id: String,
    pub pane: String,
    /// What this box may conclude from the pane's silence, which is also where
    /// the session its hooks report under is read from.
    pub watch: Watch,
    /// What the last sweep read of this agent, which is what `job_exit` will
    /// answer on where the session has said nothing in THIS daemon. A reader
    /// told a pane has reported nothing, while the next sweep is about to
    /// conclude it finished, has been handed two answers to one question.
    pub seen: Option<job_exit::Reported>,
    /// Where the pane's conversation is written, which the line reads the
    /// last write of exactly as the sweep does.
    pub transcript: Option<String>,
    /// When this daemon began counting the pane — the adoption, for one it
    /// adopted, and never the pane's own start. It is the only instant this
    /// box's own silence can be measured from, which is what `job_unheard`
    /// reads it for. A reading that wants the slot's age ACROSS a restart
    /// wants `opened_at`, since this carried across would conclude an adopted
    /// pane the instant it was adopted.
    pub noted_at: i64,
    /// When this box opened the pane, where its record says; the age of the
    /// slot across any restart.
    pub opened_at: Option<i64>,
}

pub struct JobPanes {
    pub(crate) inner: Mutex<HashMap<String, Holding>>,
    pub(crate) swept_at: Mutex<Option<i64>>,
    /// Which set of jobs this box has already said is holding every slot, so
    /// the condition is stated on its edges rather than on every pass. It
    /// lives here because it is a fact about this registry and nothing else
    /// reads it.
    pub(crate) said_at_bound: Mutex<Option<String>>,
    /// The projects this box has said it holds no master session for, so the
    /// condition is stated on its edges rather than on every pass.
    pub(crate) unsessioned: Mutex<std::collections::HashSet<String>>,
    /// The project each job this daemon took was taken for. A pane adopted
    /// across a restart has none, and is counted for every project.
    pub(crate) projects: Mutex<HashMap<String, String>>,
}

impl Default for JobPanes {
    fn default() -> Self {
        Self::new()
    }
}

impl JobPanes {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            swept_at: Mutex::new(None),
            said_at_bound: Mutex::new(None),
            unsessioned: Mutex::new(std::collections::HashSet::new()),
            projects: Mutex::new(HashMap::new()),
        }
    }

    /// Whether `project_id` has a master session to take pool jobs under,
    /// answering `true` where that differs from what this box last said.
    pub fn note_master_session(&self, project_id: &str, held: bool) -> bool {
        let Ok(mut unsessioned) = self.unsessioned.lock() else {
            return false;
        };
        if held {
            unsessioned.remove(project_id)
        } else {
            unsessioned.insert(project_id.to_string())
        }
    }

    /// The same, carrying what a previous daemon's sweep read of this agent,
    /// where its conversation is written and when the pane was opened, where
    /// anything knows.
    pub fn hold(
        &self,
        job_id: &str,
        pane: &str,
        watch: Watch,
        seen: Option<job_exit::Reported>,
        transcript: Option<String>,
        opened_at: Option<i64>,
    ) {
        let Ok(mut map) = self.inner.lock() else {
            return;
        };
        let now = now_ms();
        map.entry(job_id.to_string())
            .and_modify(|h| {
                h.pane = pane.to_string();
                h.watch = watch.clone();
                h.seen = seen;
                h.transcript = transcript.clone();
                h.opened_at = h.opened_at.or(opened_at);
            })
            .or_insert_with(|| Holding {
                job_id: job_id.to_string(),
                pane: pane.to_string(),
                watch,
                seen,
                transcript,
                noted_at: now,
                opened_at,
            });
    }

    /// That a supervision sweep ran to the end. Read where the box is refusing
    /// work, because the slot's return depends on this sweep and a design that
    /// leans on a sweep has to say when the sweep last ran.
    pub fn swept(&self) {
        if let Ok(mut at) = self.swept_at.lock() {
            *at = Some(now_ms());
        }
    }

    pub fn last_swept(&self) -> Option<i64> {
        self.swept_at.lock().ok().and_then(|at| *at)
    }

    /// What this box last said was holding every one of its slots, and what it
    /// is saying now. `None` in, `None` out clears the memo.
    pub fn said_at_bound(&self, now: Option<String>) -> Option<String> {
        let Ok(mut said) = self.said_at_bound.lock() else {
            return None;
        };
        std::mem::replace(&mut said, now)
    }

    /// What is holding this box's slots right now.
    pub fn holding(&self) -> Vec<Holding> {
        let Ok(map) = self.inner.lock() else {
            return Vec::new();
        };
        let mut out: Vec<Holding> = map.values().cloned().collect();
        out.sort_by(|a, b| a.job_id.cmp(&b.job_id));
        out
    }

    pub fn forget(&self, job_id: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(job_id);
        }
        if let Ok(mut projects) = self.projects.lock() {
            projects.remove(job_id);
        }
    }

    /// Which project a job this daemon took belongs to.
    pub fn note_project(&self, job_id: &str, project_id: &str) {
        if let Ok(mut projects) = self.projects.lock() {
            projects.insert(job_id.to_string(), project_id.to_string());
        }
    }

    /// The job panes held that may belong to `project_id`: its own, and every
    /// adopted one whose project this daemon never learned. A master is not
    /// idle while one runs, because core holds a pool job under the master's
    /// session and closes the job's session with it.
    pub fn holds_for(&self, project_id: &str) -> usize {
        let (Ok(map), Ok(projects)) = (self.inner.lock(), self.projects.lock()) else {
            return 0;
        };
        map.keys()
            .filter(|job| projects.get(*job).is_none_or(|p| p == project_id))
            .count()
    }

    pub fn live(&self) -> Vec<Live> {
        let Ok(map) = self.inner.lock() else {
            return Vec::new();
        };
        let mut out: Vec<Live> = map
            .values()
            .map(|h| Live {
                job_id: h.job_id.clone(),
                pane: h.pane.clone(),
                watch: h.watch.clone(),
                seen: h.seen,
                transcript: h.transcript.clone(),
                opened_at: h.opened_at,
            })
            .collect();
        out.sort_by(|a, b| a.job_id.cmp(&b.job_id));
        out
    }

    pub fn count(&self) -> usize {
        self.inner.lock().map(|m| m.len()).unwrap_or(0)
    }

    /// When this daemon began counting one job's pane. `None` once the slot is
    /// back, which a caller reads as a pane there is nothing left to conclude.
    pub fn noted_at(&self, job_id: &str) -> Option<i64> {
        let map = self.inner.lock().ok()?;
        map.get(job_id).map(|h| h.noted_at)
    }
}

/// Where a session's conversation is written. What this daemon has heard wins
/// outright, a path it holds none of included: a session heard here that names
/// no transcript has moved to a conversation the record's path does not belong
/// to, or never named one. Only a session this daemon has heard nothing from
/// is answered off the record a previous daemon left.
pub fn transcript_of(said: Option<&Activity>, recorded: Option<&str>) -> Option<String> {
    match said {
        Some(a) => a.transcript.clone(),
        None => recorded.map(str::to_string),
    }
}

/// The newest write to that transcript. `None` where there is no path or
/// nothing under it can be read — no evidence, never silence.
pub fn written_at(said: Option<&Activity>, recorded: Option<&str>) -> Option<i64> {
    let path = transcript_of(said, recorded)?;
    transcript_age::last_written(Path::new(&path))
}

/// The pane name a job runs under, and the only shape `adopt` can read back.
pub fn pane_name(job_id: &str) -> String {
    terminal::session_name(terminal::JOB_PREFIX, job_id)
}

pub(crate) fn job_id_of(pane: &str) -> Option<String> {
    let suffix = pane.strip_prefix(terminal::JOB_PREFIX)?.strip_prefix('-')?;
    (!suffix.is_empty()).then(|| suffix.to_string())
}

/// What a restart found: the jobs still running here, and the ones that died with
/// the daemon.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Adopted {
    /// Panes that outlived the last daemon and are now supervised again.
    pub alive: usize,
    /// Jobs this box had started whose pane is gone, reported to core by name.
    pub buried: usize,
}

pub async fn adopt(
    panes: &dyn Panes,
    report: &dyn Report,
    records: &dyn Records,
    registry: &JobPanes,
) -> Adopted {
    let mut out = Adopted::default();
    let recorded = records.all().await;
    let live: Vec<String> = panes.names().await;

    for rec in &recorded {
        if live.contains(&rec.pane) {
            continue;
        }
        let reason = format!(
            "the job's pane `{}` did not survive a restart of the runner daemon",
            rec.pane
        );
        match report.fail(&rec.job_id, &reason).await {
            Ok(_) => {
                panes.released(&rec.pane).await;
                records.forget(&rec.job_id).await;
                out.buried += 1;
                tracing::warn!(
                    "[pool] job {} did not survive the restart — reported to core",
                    rec.job_id
                );
            }
            Err(e) => {
                registry.hold(
                    &rec.job_id,
                    &rec.pane,
                    Watch::Unhooked,
                    None,
                    None,
                    rec.opened_at,
                );
                tracing::warn!(
                    "[pool] job {} did not survive the restart and core could not be told: {e} — the supervisor will keep sending it",
                    rec.job_id
                );
            }
        }
    }

    for name in live {
        let Some(job_id) = job_id_of(&name) else {
            continue;
        };
        // What the last daemon's sweep left on this job's record is the whole
        // of what this one knows about its agent until the pane's own hooks
        // speak again.
        let held = recorded.iter().find(|r| r.job_id == job_id);
        let watch = match held.and_then(|r| r.watch.session_id()) {
            Some(session) => Watch::Adopted {
                session_id: session.to_string(),
            },
            None => Watch::Unhooked,
        };
        let seen = held.and_then(|r| r.seen);
        let adopted = Live {
            job_id,
            pane: name,
            watch,
            seen,
            transcript: held.and_then(|r| r.transcript.clone()),
            opened_at: held.and_then(|r| r.opened_at),
        };
        registry.hold(
            &adopted.job_id,
            &adopted.pane,
            adopted.watch.clone(),
            adopted.seen,
            adopted.transcript.clone(),
            adopted.opened_at,
        );
        records.note(&adopted).await;
        out.alive += 1;
    }

    if out.alive > 0 || out.buried > 0 {
        tracing::info!(
            "[pool] restart: {} job pane(s) adopted, {} job(s) reported dead",
            out.alive,
            out.buried
        );
    }
    out
}
