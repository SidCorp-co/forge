use super::*;

/// Write the skill where the session about to start will look for it, under
/// the rule every other write point keeps: a checkout the install leaves
/// unwritten gets no skill, and so no pane (ISS-1357). `dir` is where the
/// outcome is recorded for `forge-runner status`.
pub(crate) fn install_skill(
    repo: &std::path::Path,
    slug: &str,
    dir: Option<&std::path::Path>,
) -> Result<(), String> {
    use runner_workspace::master_skill::{install_and_record, Point};
    let outcome = install_and_record(slug, repo, Point::Placement, dir);
    if outcome.installed() {
        return Ok(());
    }
    Err(outcome.says(Some(repo), runner_update::CURRENT_VERSION))
}

pub(crate) fn install_hooks_logged(repo: &std::path::Path, slug: &str) {
    install_hooks_from(repo, slug, runner_platform::exe::own());
}

/// The same with the resolution handed in, because both of its arms have to be
/// reachable from a test and this process's own binary is there while one runs.
pub(crate) fn install_hooks_from(
    repo: &std::path::Path,
    slug: &str,
    own: runner_platform::error::Result<runner_platform::exe::OwnExe>,
) {
    let exe = match own {
        Ok(exe) => exe,
        Err(e) => {
            tracing::warn!(
                "[master] {slug}: {e} — starting without hooks rather than installing commands that die at every call, so this session reports no turn boundaries and its dispatches reach no gate"
            );
            return;
        }
    };
    if let Some(was) = &exe.replaced_from {
        tracing::warn!(
            "[master] {slug}: the binary this daemon started on ({}) was replaced while it ran — its hooks name {}, the build standing there now",
            was.display(),
            exe.path.display()
        );
    }
    match runner_workspace::hook_install::install(repo, &exe.path) {
        Ok(path) => tracing::info!("[master] {slug}: hooks registered in {}", path.display()),
        Err(e) => tracing::warn!(
            "[master] {slug}: could not register hooks in {}: {e} — starting anyway, blind to this session's turn boundaries",
            repo.display()
        ),
    }
}

/// What telling core about a resume choice needs of it.
#[allow(async_fn_in_trait)]
pub trait ChoiceReporter {
    async fn report(
        &self,
        session_id: &str,
        run_id: &str,
        choice: &str,
        why: &str,
    ) -> runner_platform::error::Result<()>;
}

/// The live implementation, over this box's device credential.
pub struct CoreChoice<'a>(pub &'a CoreClient);

impl ChoiceReporter for CoreChoice<'_> {
    async fn report(
        &self,
        session_id: &str,
        run_id: &str,
        choice: &str,
        why: &str,
    ) -> runner_platform::error::Result<()> {
        runner_transport::run_sessions::report_resume_choice(
            self.0,
            session_id,
            serde_json::json!({ "runId": run_id, "choice": choice, "why": why }),
        )
        .await
    }
}

pub(crate) async fn say_resume_choices(
    reporter: &impl ChoiceReporter,
    ledger: &mut Option<Ledger>,
    boot_id: &str,
) -> usize {
    if boot_id.is_empty() {
        return 0;
    }
    let owed = {
        let Some(led) = ledger.as_ref() else { return 0 };
        match led.choices_awaiting_report(boot_id) {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("[master] cannot read recorded resume choices: {e}");
                return 0;
            }
        }
    };
    let mut said = 0;
    for run in owed {
        let Some(choice) = run.resume_choice.clone() else {
            continue;
        };
        let Some(session_id) = run.session_id.clone() else {
            tracing::warn!(
                "[master] run {}: this pane chose to {choice} and the choice cannot reach its issue — the run has no core session, which is what a run whose subagent never started looks like. It stands in the box ledger and nowhere a reader will find it",
                run.run_id
            );
            continue;
        };
        let why = run.resume_choice_why.clone().unwrap_or_default();
        match reporter.report(&session_id, &run.run_id, &choice, &why).await {
            Ok(()) => {
                if let Some(led) = ledger.as_mut() {
                    if let Err(e) = led.mark_resume_choice_said(&run.run_id) {
                        tracing::warn!(
                            "[master] run {}: core has the choice and the mark did not land: {e} — it will be said again",
                            run.run_id
                        );
                        continue;
                    }
                }
                said += 1;
            }
            Err(e) => tracing::warn!(
                "[master] run {}: core would not take the resume choice ({e}) — the next sweep tries again",
                run.run_id
            ),
        }
    }
    said
}

pub(crate) fn inherited_runs(led: &Ledger, project_id: &str, boot_id: &str) -> Vec<InheritedRun> {
    let runs = match led.inheritable_runs(project_id, boot_id) {
        Ok(runs) => runs,
        Err(e) => {
            tracing::warn!(
                "[master] {project_id}: cannot read the runs a pane placed now would inherit: {e} — a resumed pane is told of none"
            );
            return Vec::new();
        }
    };
    runs.into_iter()
        .map(|r| InheritedRun {
            master_session_id: r.master_session_id.clone(),
            issue_keys: led
                .issues(&r.run_id)
                .map(|m| m.into_iter().map(|i| i.issue_key).collect())
                .unwrap_or_default(),
            run_id: r.run_id,
            worktree_path: r.worktree_path.display().to_string(),
            incarnation: r.incarnation.wire(),
            work: r.work.wire(),
            agent_id: r.agent_id,
            ended_by: r.ended_by,
            pid: r.pid,
            host: r.host_pid.zip(r.host_start),
        })
        .collect()
}

/// The boot a pane placed now inherits the runs of.
///
/// Read fresh, as the declarations were stamped with it. Where this sweep
/// cannot read it, the boot this daemon recorded against the project's master
/// row stands in, because an empty identity matches no run and a resumed pane
/// told of none can answer for none, with no later sweep to tell it again. Where
/// neither answers, that is said and nothing is inherited (ISS-1312).
pub(crate) fn inheritance_boot(
    read: Option<String>,
    led: &Ledger,
    project_id: &str,
    slug: &str,
) -> Option<String> {
    if let Some(boot) = read {
        return Some(boot);
    }
    match led.master_for_project(project_id) {
        Ok(Some(row)) => Some(row.boot_id),
        Ok(None) => {
            tracing::warn!(
                "[master] {slug}: this box cannot read its boot identity this sweep and holds no master row to take it from, so a pane placed now is told of no inherited run and none is marked or adopted"
            );
            None
        }
        Err(e) => {
            tracing::warn!(
                "[master] {slug}: this box cannot read its boot identity this sweep, nor its master row ({e}), so a pane placed now is told of no inherited run and none is marked or adopted"
            );
            None
        }
    }
}

/// A master pane this sweep started, in place of one that was absent, takes
/// over what the pane before it left.
///
/// A subagent runs inside the Claude Code process recorded for it, so each
/// inherited run whose process is read gone ended with it, whatever turn it
/// was in, and is marked so: that is what lets the drain and recovery stop
/// reading a dead subagent as one still in its first turn. One whose process
/// is alive, or unrecorded, is not: the pane was not where it ran. A resumed pane continues the
/// conversation that dispatched them and its brief lists them as its own, so
/// they are recorded under its master session too, and its choice, its close
/// and its next declaration match them. A cold-started pane is told of none
/// and cannot resume one, so they stay where they were, for recovery to
/// release once core calls each session over (ISS-1312).
pub(crate) fn placed_again(
    led: &mut Ledger,
    inherited: &[InheritedRun],
    successor: &str,
    resumed: bool,
    at_ms: i64,
    slug: &str,
    hosts: &dyn subagent_host::Hosts,
) {
    let mut ended = 0;
    let mut adopted = 0;
    for run in inherited {
        let marked = if run.ends_with_placement(hosts) {
            led.note_host_ended(&run.run_id, at_ms, runner_core::ledger::HOST_PANE_STARTED)
        } else {
            Ok(false)
        };
        match marked {
            Ok(true) => ended += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!(
                "[master] {slug}: run {}: cannot record that the process its subagent ran in is gone: {e} — the drain still reads it as a subagent at work",
                run.run_id
            ),
        }
        if !resumed || run.master_session_id == successor {
            continue;
        }
        match led.reparent_run(&run.run_id, successor) {
            Ok(()) => adopted += 1,
            Err(e) => tracing::warn!(
                "[master] {slug}: run {}: cannot record it under the resumed pane's session {successor}: {e} — it stays {}'s, which no pane on this box answers for",
                run.run_id,
                run.master_session_id
            ),
        }
    }
    if let Some(line) = placement_line(ended, adopted, resumed, successor) {
        tracing::info!("[master] {slug}: {line}");
    }
}

/// A pane this box adopted onto a session core re-minted keeps answering for
/// the runs it declared before (ISS-1316).
///
/// A run is this pane's where the Claude Code process recorded for it — read
/// above the process that declared it, and again above the subagent that took
/// it — still runs, beneath the pane's own process `pane_pid`. A session id
/// cannot say this, because core reuses a non-terminal row for the pane placed
/// next under the same name, and a process merely alive cannot either, since
/// nothing but its parentage ties it to this pane. So every open run of the
/// project that this box does not serve under the pane's session now, and whose
/// process runs beneath this pane, is recorded under that session, where its
/// `run close` and `run choice` act. A run whose process is gone or runs
/// elsewhere is left where it is; one that could not be placed is counted.
///
/// Nothing here reads the session the pane acted under before. The pane's own
/// frames rewrite that record the moment the registry moves, so a carry keyed
/// on it could lose to a frame and carry nothing.
pub(crate) fn carried_across(
    led: &mut Ledger,
    project_id: &str,
    pane: &str,
    successor: &str,
    pane_pid: Option<u32>,
    hosts: &dyn subagent_host::Hosts,
    slug: &str,
) -> usize {
    let runs = match led.unclosed_runs() {
        Ok(runs) => runs,
        Err(e) => {
            tracing::warn!(
                "[master] {slug}: cannot read the open runs to carry {pane}'s across to {successor} ({e}); they stay where they are this sweep"
            );
            return 0;
        }
    };
    let mut moved = 0;
    let mut unattributed = 0;
    for run in runs.iter().filter(|r| {
        r.ended_by.is_none()
            && r.project_id.as_deref() == Some(project_id)
            && r.master_session_id != successor
    }) {
        let ours = match (run.host_pid, run.host_start.as_deref(), pane_pid) {
            (Some(pid), Some(start), Some(pane)) => hosts.beneath(pid, start, pane),
            _ => subagent_host::HostRead::Unreadable,
        };
        match ours {
            subagent_host::HostRead::Alive => match led.reparent_run(&run.run_id, successor) {
                Ok(()) => moved += 1,
                Err(e) => tracing::warn!(
                    "[master] {slug}: run {}: cannot record it under {successor}: {e} — it stays {}'s, which no pane on this box answers for",
                    run.run_id,
                    run.master_session_id
                ),
            },
            subagent_host::HostRead::Gone => {}
            subagent_host::HostRead::Unreadable => unattributed += 1,
        }
    }
    if moved > 0 {
        tracing::info!(
            "[master] {slug}: {moved} open run(s) declared from a process still running in {pane} are now recorded under {successor}, the session core serves it as, so its close and its choice answer for them"
        );
    }
    if unattributed > 0 {
        tracing::warn!(
            "[master] {slug}: {unattributed} open run(s) of this project are under another session and whether their recorded process runs in {pane} could not be read, so they are left where they are"
        );
    }
    moved
}

/// What [`placed_again`] says it did. A run is called ended with the pane only
/// where its end was recorded: a line that says so of runs whose process
/// still reads alive tells the operator the opposite of what the box did
/// (ISS-1312 criterion 72, the eighth judge's J3).
pub(crate) fn placement_line(
    ended: usize,
    adopted: usize,
    resumed: bool,
    successor: &str,
) -> Option<String> {
    if ended == 0 && adopted == 0 {
        return None;
    }
    let what_ended = if ended == 0 {
        "no run it inherits ended with it, since no Claude Code process recorded for their subagents was read gone".to_string()
    } else {
        format!("the Claude Code process the subagents of {ended} run(s) it inherits ran in is gone too, so they ended with it")
    };
    let whose = if resumed {
        format!("{adopted} run(s) it inherits declared under a master session this placement replaced are now recorded under this pane's session {successor}, so its choice, its close and its next declaration answer for them")
    } else {
        "a cold-started pane cannot resume any of them, so each stays with the session that declared it and is released once core calls its session over".to_string()
    };
    Some(format!(
        "this pane was started in place of one that is gone, and {what_ended}; {whose}"
    ))
}

pub(crate) struct InheritedRun {
    pub run_id: String,
    /// The master session that declared it, which a placement may have
    /// replaced.
    pub master_session_id: String,
    pub issue_keys: Vec<String>,
    pub worktree_path: String,
    pub incarnation: &'static str,
    pub work: &'static str,
    pub agent_id: Option<String>,
    pub ended_by: Option<String>,
    pub pid: Option<u32>,
    /// The Claude Code process recorded for its subagent, and its start time.
    pub host: Option<(u32, String)>,
}

impl InheritedRun {
    /// A run with no process of its own is a subagent's, living inside the
    /// Claude Code process recorded for it. A pane started in place of its
    /// master's is its end only where that process is read gone: the
    /// conversation can run as a background session outside any pane, and
    /// its subagents with it (ISS-1312, run e67c08e0). The one predicate
    /// [`placed_again`] records and [`resumed_brief`] states.
    pub(crate) fn ends_with_placement(&self, hosts: &dyn subagent_host::Hosts) -> bool {
        self.pid.is_none()
            && self.ended_by.is_none()
            && self.host.as_ref().is_some_and(|(pid, start)| {
                hosts.read(*pid, start) == subagent_host::HostRead::Gone
            })
    }
}

/// What a pane placed after a stand-down was lifted is told about the gap.
///
/// The brief's first line asserts the reader is this project's master, and a
/// resumed conversation carries a transcript that ends mid-work. Without this,
/// a master stood down for nine hours wakes believing it was driving the whole
/// time (ISS-1118).
///
/// The two reasons are here because the interval alone tells a master that
/// something happened and nothing about what. A pane that knows the box was
/// waiting on four outstanding writes, and that the wait ended because one of
/// them landed, can read the board knowing what it is looking for (ISS-1238).
pub(crate) fn stood_up_brief(lifted: &Lifted) -> String {
    let mins = lifted.held_for.as_secs() / 60;
    let span = if mins >= 120 {
        format!("{} hours", mins / 60)
    } else if mins >= 1 {
        format!("{mins} minutes")
    } else {
        format!("{} seconds", lifted.held_for.as_secs())
    };
    let mut out = format!(
        "\nThis project was STOOD DOWN for {span} and has just been stood up again. This box \
placed no master for it over that interval and nudged none, so nothing you remember doing \
happened during it — whatever was decided about this project in that time was decided by \
somebody else, and the tracker is where it is written rather than in anything you recall. Read \
the board before you act on any intention you are carrying from before the gap.\n"
    );
    out.push_str(&format!(
        "\nIt was stood down because: {}\n",
        lifted.why.as_deref().unwrap_or(MasterStanding::NO_REASON)
    ));
    out.push_str(&match lifted.lifted_on.as_deref() {
        Some(on) => format!("It was stood up because: {on}\n"),
        None => "No argument was recorded for standing it up — that episode predates the \
requirement, so what ended the wait is not on this box's record.\n"
            .to_string(),
    });
    out
}

/// `placed` is whether this pane was started in place of an absent one, which
/// [`placed_again`] records as the end of every inherited run's subagent the
/// brief must then not state as live (ISS-1312).
pub(crate) fn resumed_brief(
    conversation: &str,
    runs: &[InheritedRun],
    placed: bool,
    hosts: &dyn subagent_host::Hosts,
) -> String {
    let mut out = format!(
        "\nThis pane was RESUMED, not started fresh: it is continuing conversation `{conversation}`, \
so what you remember of this project may be from before the interruption that ended the last pane.\n"
    );
    if runs.is_empty() {
        out.push_str(
            "\nNo run rows were left open under this master, so there is nothing to decide before \
you carry on.\n",
        );
        return out;
    }
    out.push_str(&format!(
        "\n{} run(s) were left open under this master. For EACH of them, before you declare any new \
work, record one of `continue`, `restart` or `leave` with your reason — the declaration will be \
refused until you have. These are the fields this box can state about each. It states them and \
judges none of them; the judgement is yours:\n",
        runs.len()
    ));
    for r in runs {
        let incarnation = if placed && r.ends_with_placement(hosts) {
            "not running: its subagent ended with the pane this one was started in place of, \
and the Claude Code process it ran in is gone"
                .to_string()
        } else {
            r.incarnation.to_string()
        };
        out.push_str(&format!(
            "\n- run `{}`\n  issues: {}\n  worktree: {}\n  incarnation: {}\n  work: {}\n  subagent: {}\n  ended: {}\n",
            r.run_id,
            if r.issue_keys.is_empty() { "none recorded".to_string() } else { r.issue_keys.join(", ") },
            r.worktree_path,
            incarnation,
            r.work,
            r.agent_id.as_deref().unwrap_or("never bound"),
            r.ended_by.as_deref().unwrap_or("not ended"),
        ));
    }
    out.push_str(
        "\nRead the worktree and the issue before you choose. `continue` means the work stands and \
you will carry it on; `restart` means it does not and you will cut it again; `leave` means it is \
somebody else's to settle and you will touch neither. Whichever you pick, say why in your own \
words: the record is what the next reader has.\n",
    );
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PaneState {
    /// No master is up for this project and none could be started.
    Absent,
    /// A pane was already running and this daemon adopted it.
    Adopted,
    /// A pane was started with no conversation behind it.
    ColdStarted,
    /// A pane was started on the conversation its predecessor had.
    Resumed,
    /// A pane was already running and this daemon adopted it, but the
    /// capability it holds names a session this box no longer has. It is up and
    /// it is refused, so it is not worth a nudge.
    StaleCapability,
}

pub(crate) fn conversation_transcript(
    cwd: &std::path::Path,
    conversation_id: &str,
) -> Option<std::path::PathBuf> {
    let encoded: String = cwd
        .to_string_lossy()
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    Some(
        dirs_next::home_dir()?
            .join(".claude")
            .join("projects")
            .join(encoded)
            .join(format!("{conversation_id}.jsonl")),
    )
}

pub(crate) fn resume_for(
    slug: &str,
    repo: &std::path::Path,
    stored: Option<&str>,
) -> Option<String> {
    let id = stored.filter(|s| !s.is_empty())?;
    let Some(path) = conversation_transcript(repo, id) else {
        tracing::warn!(
            "[master] {slug}: conversation {id} is recorded for this project but this box cannot say where a transcript for it would live — it has no home directory to look under. Starting cold, so this pane begins with no memory of what its predecessor was doing"
        );
        return None;
    };
    if path.is_file() {
        tracing::info!("[master] {slug}: resuming conversation {id}");
        return Some(id.to_string());
    }
    tracing::warn!(
        "[master] {slug}: conversation {id} is recorded for this project but this box has no transcript for it at {} — starting cold, so this pane begins with no memory of what its predecessor was doing",
        path.display()
    );
    None
}

pub(crate) fn transcript_path(slug: &str) -> Option<std::path::PathBuf> {
    let dir = runner_platform::config::base_dir()
        .ok()?
        .join("master")
        .join(slug);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("transcript.log"))
}
