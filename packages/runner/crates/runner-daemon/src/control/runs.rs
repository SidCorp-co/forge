use super::*;
use runner_core::ledger::TreeOrigin;
use runner_transport::run_sessions::Said;

pub(crate) fn run_choice(
    ctl: &Arc<Control>,
    run_id: &str,
    choice: &str,
    why: &str,
    session_id: &str,
) -> ClaimReply {
    if !RESUME_CHOICES.contains(&choice) {
        return ClaimReply::refused(format!(
            "`{choice}` is not one of the three choices a resumed master may record: {}",
            RESUME_CHOICES.join(", ")
        ));
    }
    if why.trim().is_empty() {
        return ClaimReply::refused(
            "a choice needs its reason — say why in your own words, because the record is what the next reader has",
        );
    }
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else {
        return ClaimReply::refused("this daemon has no ledger open, so it can record nothing");
    };
    // A choice is recorded once, and core is told the one recorded: a second
    // choice answered `ok` and replaced the first with nothing said (ISS-1312).
    if let Ok(Some(run)) = led.run(run_id) {
        if let (true, Some(chosen)) = (
            run.master_session_id == session_id,
            run.resume_choice.as_deref(),
        ) {
            return ClaimReply::refused(format!(
                "run {run_id} already has `{chosen}` recorded for it: \u{ab}{}\u{bb}. A choice is recorded once, so `{choice}` changed nothing",
                run.resume_choice_why.as_deref().unwrap_or("no reason recorded")
            ));
        }
    }
    match led.record_resume_choice(run_id, session_id, choice, why) {
        Ok(true) => {
            tracing::info!("[control] run {run_id}: this master chose to {choice} — {why}");
            ClaimReply {
                ok: true,
                job_id: Some(run_id.to_string()),
                agent_session_id: Some(session_id.to_string()),
                issue_key: None,
                reason: Some(choice.to_string()),
                deny: false,
            }
        }
        Ok(false) => ClaimReply::refused(format!(
            "run {run_id} is not one this pane inherited, so it is not this pane's to answer for"
        )),
        Err(e) => ClaimReply::refused(e.to_string()),
    }
}

/// The refusal for a pane resumed holding runs it has not answered for, if it holds any.
fn unanswered_inherited(
    led: &runner_core::ledger::Ledger,
    session_id: &str,
    boot_id: &str,
) -> Option<ClaimReply> {
    match led.runs_awaiting_choice(session_id, boot_id) {
        Ok(pending) if !pending.is_empty() => {
            let names: Vec<String> = pending
                .iter()
                .map(|r| {
                    let keys = led
                        .issues(&r.run_id)
                        .map(|m| {
                            m.iter()
                                .map(|i| i.issue_key.clone())
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    format!("{} ({keys})", r.run_id)
                })
                .collect();
            Some(ClaimReply::refused(format!(
                "this pane was resumed holding {} run(s) it has not answered for yet: {}. Answer each one with `forge-runner run choice <run-id> continue|restart|leave --reason \"<why>\"` before declaring new work. Closing a run is not answering for it: the close records that the row ended, not what you decided, and a reason written there reaches no issue.",
                pending.len(),
                names.join("; ")
            )))
        }
        Ok(_) => None,
        Err(e) => Some(ClaimReply::refused(format!(
            "cannot read this pane's inherited runs: {e}"
        ))),
    }
}

/// Why core would not open a run over these issues, asked at declare time, or `None`.
///
/// A declaration is a row on this box and nothing else, so before this a run over an issue
/// a live `blocks` edge holds was accepted here, refused by core at every sweep, and
/// never reported to the master that dispatched it (HOP ISS-46, 19 refusals in 10
/// minutes). Core answers with the function the open calls, so the two cannot disagree.
///
/// Only a hold core names, or an issue at rest core names, is a refusal: the box reads no issue
/// status of its own, so what core admits is declared. A run over issues all closed, a release
/// judge, is one core admits (ISS-576). A core that cannot be reached, a box with no
/// core client, a token core will not take, and a core from before the route all leave the
/// declaration to be written as it always was, because the open at the next sweep asks the
/// same question and a master must still be able to declare while core is down. That
/// silence is logged by name, never swallowed.
pub(crate) async fn preflight_refusal(
    core: Option<&runner_transport::CoreClient>,
    project_id: &str,
    issue_keys: &[String],
    said: Said<'_>,
) -> Option<String> {
    let client = core?;
    let Said { role, requirement } = said;
    match runner_transport::run_sessions::preflight(client, project_id, issue_keys, role, requirement)
        .await
    {
        Ok(()) => None,
        Err(runner_platform::error::Error::Held { said, .. }) => Some(format!(
            "core would not open a run over these issues, so nothing was declared: {said}. A dispatch on them would be accepted by this box and refused at every sweep. Declare it once the hold named above has lifted. Nothing was recorded"
        )),
        // FB-273: a take on an issue at rest, a parked one or a closed one beside one in work.
        // Core admits a run over issues all closed (ISS-576), so a judge never meets this arm.
        Err(runner_platform::error::Error::AtRest { said }) => Some(format!(
            "core would not open a run over these issues, so nothing was declared: {said}"
        )),
        Err(e) => {
            tracing::warn!(
                "[control] {project_id}: the declaration was not checked with core ({e}); it is written, and core's open at the next sweep asks the same question"
            );
            None
        }
    }
}

/// What a master declares: the project, the issues, the tree, and the role it will dispatch.
pub(crate) struct Declaration<'a> {
    pub project_id: &'a str,
    pub issue_keys: &'a [String],
    pub worktree_path: &'a str,
    pub role: Option<&'a str>,
    /// The requirement a judge run judges at the requirement, in place of any issue (ISS-735).
    pub requirement: Option<&'a str>,
    /// The branch to cut the tree on, where the box is to cut it for the run (`--cut`). `None`
    /// adopts a tree that already stands (ISS-1016).
    pub cut: Option<super::cut::Cut<'a>>,
}

/// A graceful stop, as a CI agent drains for an upgrade: finish what is held,
/// take nothing new. Core decided it; the box only refuses by it.
fn draining_refusal(ctl: &Control, project_id: &str) -> Option<String> {
    let live = ctl.masters.get(project_id).map(|(session, _)| session)?;
    let because = ctl.masters.draining(project_id, &live)?;
    Some(format!(
        "this master is draining and declares no new run: {because}. Leave the issue unclaimed for its successor, which core places on the first sweep that finds no run this pane holds still working and it at its prompt, resuming this conversation. Nothing was recorded"
    ))
}

/// The roles that judge and move nothing, which alone may declare a run over a requirement.
const JUDGING_ROLES: [&str; 2] = ["qa", "reviewer"];

/// Why a run over `requirement` cannot be declared, or `None` (ISS-735): a judge of a shipped
/// requirement at the requirement takes no issue, so it names none beside it and is declared
/// under a judging role.
pub(crate) fn requirement_refusal(
    requirement: Option<&str>,
    issue_keys: &[String],
    role: Option<&str>,
) -> Option<String> {
    let Some(req) = requirement else {
        return issue_keys.is_empty().then(|| {
            "a run is declared over at least one issue (`--issue`), or a judge run over the requirement it judges (`--requirement REQ-n --role qa`). Nothing was recorded".to_string()
        });
    };
    let shaped = req
        .to_ascii_uppercase()
        .strip_prefix("REQ-")
        .is_some_and(|n| {
            !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) && !n.starts_with('0')
        });
    if !shaped {
        return Some(format!(
            "`{req}` is not a requirement reference — `--requirement` takes one key such as `REQ-76`. Nothing was recorded"
        ));
    }
    if !issue_keys.is_empty() {
        return Some(format!(
            "a run over {req} judges that requirement and takes no issue; declare the issues as a run of their own. Nothing was recorded"
        ));
    }
    let bare = role.map(|r| r.rsplit(':').next().unwrap_or(r));
    if !bare.is_some_and(|r| JUDGING_ROLES.contains(&r)) {
        return Some(format!(
            "a run over {req} judges it and moves nothing, so it is declared `--role qa` or `--role reviewer`; declared with {}. Nothing was recorded",
            role.map_or("no role".to_string(), |r| format!("`{r}`"))
        ));
    }
    None
}

/// Why these issue references cannot be declared as one run, or `None`.
fn keys_refusal(issue_keys: &[String]) -> Option<String> {
    if let Some(bad) = issue_keys.iter().find(|k| !is_issue_key(k)) {
        return Some(format!(
            "`{bad}` is not an issue reference — a declaration takes one per issue the subagent is being given, each a display id such as `ISS-42` or your project's own prefix, or the bare number. Nothing was recorded"
        ));
    }
    // Refused here rather than trimmed to fit: the keys are what the caller
    // declared and dropping the seventeenth would be this box deciding which
    // issue the run is not about. Refused here rather than downstream because
    // core's refusal arrives at a sweep and not at this pane — one declaration
    // of 27 keys was answered `400` every twenty seconds for an hour and
    // forty-seven minutes, and the master that built it never saw one of them
    // (ISS-1284).
    let cap = runner_transport::run_sessions::MAX_ISSUE_KEYS;
    (issue_keys.len() > cap).then(|| format!(
        "a run carries at most {cap} issues and this declaration names {}. Core refuses more by name and the refusal reaches this box's sweep rather than this pane, so the run would be opened nowhere and retried for ever. Declare the work in groups of {cap} or fewer. Nothing was recorded",
        issue_keys.len()
    ))
}

pub(crate) async fn run_declare_as(
    ctl: &Arc<Control>,
    holder: &Holder,
    declared: Declaration<'_>,
    session_id: &str,
    peer: Option<u32>,
) -> ClaimReply {
    let Declaration {
        project_id,
        issue_keys,
        worktree_path,
        role,
        requirement,
        cut,
    } = declared;
    // First, before anything is read or written: a drain that admits a run is
    // waiting on a queue it keeps refilling (ISS-1223). The permit is held to
    // the end of this function, past the ledger write, so a drain that begins
    // meanwhile waits for this row rather than reading the box idle without it.
    let _admitted = match ctl.drain.admit() {
        Ok(permit) => permit,
        Err(closed) => return ClaimReply::refused(closed.refusal),
    };
    let serves = match declaring_project(&ctl.masters, holder, project_id, session_id) {
        Ok(serves) => serves,
        Err(why) => return ClaimReply::refused(why),
    };
    // A record was matched by id or slug in `declaring_project`; a capability
    // minted before the record names an id or nothing.
    if !matches!(holder, Holder::Minted(_)) && serves != project_id {
        return ClaimReply::refused(format!(
            "this pane is the master for {serves} and cannot declare a run for {project_id}"
        ));
    }
    // Every row below is keyed by the project's id, never by the slug it was named by.
    let project_id = serves.as_str();
    if let Some(refused) = draining_refusal(ctl, project_id) {
        return ClaimReply::refused(refused);
    }
    if let Some(refused) =
        requirement_refusal(requirement, issue_keys, role).or_else(|| keys_refusal(issue_keys))
    {
        return ClaimReply::refused(refused);
    }
    // The master's own checkout: the working directory of the Claude Code
    // process above whatever made this declaration, which is where the box
    // started the master pane. Unread off Linux, and then only the tree itself
    // is checked.
    let checkout = peer
        .and_then(|p| ctl.hosts.above(p))
        .and_then(|host| ctl.hosts.cwd(host.pid));
    // A tree to be cut must not stand yet; any other must already be a tree of this checkout.
    let refused = match cut {
        Some(_) => super::cut::cut_refusal(worktree_path, checkout.as_deref()),
        None => tree_refusal(worktree_path, checkout.as_deref()).await,
    };
    if let Some(refused) = refused {
        return ClaimReply::refused(refused);
    }
    let said = Said { role, requirement };
    if let Some(refused) =
        preflight_refusal(ctl.core.as_deref(), project_id, issue_keys, said).await
    {
        return ClaimReply::refused(refused);
    }
    // Cut last, once every refusal that needs no tree has been taken, so a refused declaration
    // leaves nothing behind; one the ledger then refuses has its tree taken back below.
    let cut_from = cut.zip(checkout.as_deref());
    if let Some((c, from)) = cut_from {
        if let Err(why) = super::cut::cut_tree(from, worktree_path, c).await {
            return ClaimReply::refused(why);
        }
    }
    let template = runner_core::ledger::NewRun {
        run_id: uuid::Uuid::new_v4().to_string(),
        project_id: project_id.to_string(),
        master_session_id: session_id.to_string(),
        worktree_path: std::path::PathBuf::from(worktree_path),
        boot_id: ctl.boot_id.clone(),
        issue_keys: issue_keys.to_vec(),
        role: role.map(str::to_string),
        requirement: requirement.map(str::to_string),
        worktree_origin: match cut_from {
            Some(_) => TreeOrigin::Created,
            None => TreeOrigin::Adopted,
        },
    };
    let reply = record_declaration(ctl, holder, template, session_id, peer);
    if let (false, Some((c, from))) = (reply.ok, cut_from) {
        super::cut::uncut_tree(from, worktree_path, c.branch).await;
    }
    reply
}

/// Write the declared run, under the master session the pane holds at the moment of writing, and
/// answer the reply the pane is told.
fn record_declaration(
    ctl: &Arc<Control>,
    holder: &Holder,
    template: runner_core::ledger::NewRun,
    session_id: &str,
    peer: Option<u32>,
) -> ClaimReply {
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else {
        return ClaimReply::refused("this daemon has no ledger open, so it can record nothing");
    };
    if let Some(refused) = unanswered_inherited(led, session_id, &ctl.boot_id) {
        return refused;
    }
    let new_run = |session: &str| runner_core::ledger::NewRun {
        master_session_id: session.to_string(),
        ..template.clone()
    };
    // A record's run is written while the registry is held, under the session
    // it names for the pane at that moment: an adoption between the bound
    // above and this write would otherwise leave the row under the session it
    // replaced, or let a pane that had just stopped being the master declare.
    let (recorded, written) = match holder {
        Holder::Minted(m) => {
            let under = ctl.masters.while_live(&m.project, &m.pane, |live| {
                (live.to_string(), led.create_run_group(new_run(live)))
            });
            match under {
                Some(w) => w,
                None => {
                    return ClaimReply::refused(format!(
                        "pane {} stopped being this box's master for {} while the declaration was being written. Nothing was recorded",
                        m.pane, m.project
                    ))
                }
            }
        }
        Holder::Legacy { .. } => (
            session_id.to_string(),
            led.create_run_group(new_run(session_id)),
        ),
    };
    match written {
        Ok(run) => {
            tracing::info!(
                "[control] {}: run {} declared over {:?}, its tree {} ({})",
                template.project_id,
                run.run_id,
                template.issue_keys,
                run.worktree_path.display(),
                run.worktree_origin.wire()
            );
            note_host(ctl, led, &run.run_id, peer);
            ClaimReply {
                ok: true,
                job_id: Some(run.run_id),
                agent_session_id: Some(recorded),
                issue_key: template.issue_keys.first().cloned(),
                reason: None,
                deny: false,
            }
        }
        Err(e) => ClaimReply::refused(e.to_string()),
    }
}

/// Why `worktree` is no tree a run can be declared over, or `None`.
///
/// A declaration names the tree its subagent works in, and the brief, the
/// held-tree readings and the release all read that tree later. Accepted
/// unread, a path a close had just given back was declared again and only the
/// plugin's brief noticed it was gone (orbit-forge, 2026-10-29). Git is asked
/// at the path itself: a linked worktree or a repository's main working tree
/// is a tree; anything else is refused naming the path and how to cut one.
/// Where `checkout`, the declaring master's own checkout, was read, the tree
/// must be of the same repository. Where it was not — off Linux, or a peer
/// whose process could not be read — the comparison is not made and that is
/// logged, not refused: the box failing to read its own process table is no
/// fault of the declaration.
pub(crate) async fn tree_refusal(worktree: &str, checkout: Option<&Path>) -> Option<String> {
    use runner_workspace::worktree::{kind_at, repository_of, Kind};
    let cut = format!(
        "Declare again with `--cut <branch>` to have this box cut it there for the run, or cut it \
         with `git worktree add {worktree} <branch>` from this project's checkout and declare \
         again to adopt it. Nothing was recorded"
    );
    let path = Path::new(worktree);
    if !path.is_absolute() {
        return Some(format!(
            "`{worktree}` is not an absolute path, and the tree a run works in is named by one: the \
             brief and the release read it from any directory. Nothing was recorded"
        ));
    }
    let what = match kind_at(path).await {
        Kind::Linked | Kind::MainWorkingTree => None,
        Kind::NotAWorktree if !path.exists() => Some(format!(
            "{worktree} does not exist, so no subagent can work in it — a closed run's worktree is \
             removed when the close gives it back"
        )),
        Kind::NotAWorktree => Some(format!("{worktree} is no git worktree")),
        Kind::Enclosed(top) => Some(format!(
            "{worktree} is a directory inside the checkout at {}, not a worktree's top level",
            top.display()
        )),
        Kind::Unknown => Some(format!(
            "git could not be asked what {worktree} is, so it cannot be taken for a worktree"
        )),
    };
    if let Some(what) = what {
        return Some(format!("{what}. {cut}"));
    }
    let Some(checkout) = checkout else {
        tracing::warn!(
            "[control] the declaring master's checkout could not be read, so the repository of {worktree} was not compared with it"
        );
        return None;
    };
    match (repository_of(path).await, repository_of(checkout).await) {
        (Ok(tree), Ok(project)) if tree != project => Some(format!(
            "{worktree} is a worktree of the repository at {}, and this project's master works in \
             {}, a checkout of {}. A run works in a tree of its own project's repository: {cut}",
            tree.display(),
            checkout.display(),
            project.display()
        )),
        (Ok(_), Ok(_)) => None,
        (tree, project) => {
            tracing::warn!(
                "[control] the repository of {worktree} was not compared with the master's checkout {}: {:?} / {:?}",
                checkout.display(),
                tree.err(),
                project.err()
            );
            None
        }
    }
}

pub(crate) fn is_issue_key(s: &str) -> bool {
    let body = match s.split_once('-') {
        Some((prefix, rest)) => {
            let len = prefix.chars().count();
            if !(2..=6).contains(&len) || !prefix.chars().all(|c| c.is_ascii_alphanumeric()) {
                return false;
            }
            if !prefix
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
            {
                return false;
            }
            rest
        }
        None => s,
    };
    !body.is_empty() && body.len() <= 10 && body.chars().all(|c| c.is_ascii_digit())
}

/// A master's close: the run is ended on this box, and then its core session is closed through
/// the closer the sweep uses (`run_record::send_close`), so the lease it holds goes before the
/// close answers rather than a sweep later (ISS-929). The reply's `reason` says what core did: a
/// close core did not take now is owed, recorded the way the sweep records it, and the next
/// sweep sends it again.
pub(crate) async fn run_close(
    ctl: &Arc<Control>,
    run_id: &str,
    reason: Option<&str>,
    session_id: &str,
) -> ClaimReply {
    match ctl.core.as_deref() {
        Some(core) => {
            run_close_with(
                ctl,
                run_id,
                reason,
                session_id,
                Some(&crate::run_record::CoreSessions(core)),
            )
            .await
        }
        None => {
            run_close_with::<crate::run_record::CoreSessions<'_>>(
                ctl, run_id, reason, session_id, None,
            )
            .await
        }
    }
}

pub(crate) async fn run_close_with<C: crate::run_record::SessionCloser>(
    ctl: &Arc<Control>,
    run_id: &str,
    reason: Option<&str>,
    session_id: &str,
    closer: Option<&C>,
) -> ClaimReply {
    let (run, standing) = match end_by_master(ctl, run_id, reason, session_id) {
        Ok(ended) => ended,
        Err(refused) => return refused,
    };
    let at_core = close_at_core_now(ctl, closer, &run, standing.as_deref()).await;
    ClaimReply {
        ok: true,
        job_id: Some(run_id.to_string()),
        agent_session_id: Some(session_id.to_string()),
        issue_key: None,
        reason: Some(at_core),
        deny: false,
    }
}

/// End the run on this box as its master's close, answering the row as it now reads and the run
/// standing in its tree, if any; or the refusal the pane is told.
fn end_by_master(
    ctl: &Arc<Control>,
    run_id: &str,
    reason: Option<&str>,
    session_id: &str,
) -> Result<(runner_core::ledger::Run, Option<String>), ClaimReply> {
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else {
        return Err(ClaimReply::refused(
            "this daemon has no ledger open, so it can record nothing",
        ));
    };
    match led.run(run_id) {
        Ok(Some(run)) if run.master_session_id == session_id => {
            // An ending is recorded once. A second close answered `ok` and
            // wrote its own reason over the first, so the row said whatever
            // the last caller typed (ISS-1312).
            if let Some(by) = run.ended_by.as_deref() {
                return Err(ClaimReply::refused(format!(
                    "run {run_id} is already ended by {by}: \u{ab}{}\u{bb}. An ending is recorded once, so this close changed nothing",
                    run.ended_reason.as_deref().unwrap_or("no reason recorded")
                )));
            }
            // The id its claims were taken under, read before anything else
            // can stand in its tree: the next run's brief writes its own
            // there, and the sweep's close would give back that one (ISS-787).
            if let Some(holder) = crate::run_record::tree_claim_holder(&run.worktree_path) {
                if let Err(e) = led.note_claim_holder(run_id, &holder) {
                    tracing::warn!("[control] run {run_id}: the id its claims were taken under could not be kept ({e}); its close reads its tree instead");
                }
            }
            if let Err(e) = led.end_run(run_id, "master", reason.unwrap_or("the master said so")) {
                return Err(ClaimReply::refused(e.to_string()));
            }
            tracing::info!("[control] run {run_id} closed by its master");
            let ended = match led.run(run_id) {
                Ok(Some(ended)) => ended,
                _ => run,
            };
            let standing = led
                .open_run_at_tree(&ended.worktree_path)
                .ok()
                .flatten()
                .map(|next| next.run_id)
                .filter(|next| next != run_id);
            Ok((ended, standing))
        }
        Ok(Some(_)) => Err(ClaimReply::refused(format!(
            "run {run_id} belongs to another master"
        ))),
        Ok(None) => Err(ClaimReply::refused(format!("no run {run_id} on this box"))),
        Err(e) => Err(ClaimReply::refused(e.to_string())),
    }
}

/// Close an ended run's core session now, the ledger unlocked while core answers, and say what
/// came of it in a line the pane prints under `closed`.
async fn close_at_core_now<C: crate::run_record::SessionCloser>(
    ctl: &Arc<Control>,
    closer: Option<&C>,
    run: &runner_core::ledger::Run,
    standing: Option<&str>,
) -> String {
    use crate::run_record::CloseAtCore;
    let Some(session) = run.session_id.as_deref() else {
        return "it never opened a session at core, so no core session holds its issues".into();
    };
    let Some(closer) = closer else {
        return format!(
            "its core session {session} is still open: this daemon has no core client, so the sweep sends its close"
        );
    };
    let sent = crate::run_record::send_close(closer, run, standing).await;
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else {
        return format!(
            "its core session {session} is still open: the ledger closed under this close, so the sweep sends it again"
        );
    };
    match crate::run_record::record_close(led, &run.run_id, sent) {
        CloseAtCore::Closed => {
            format!("its core session {session} is closed, and the issue leases it held with it")
        }
        CloseAtCore::Owed(why) => format!(
            "its core session {session} is still open: core did not take the close ({why}). The next sweep sends it again; until core takes it, the session holds its issue leases"
        ),
        CloseAtCore::Refused(why) => format!(
            "its core session {session} is still open: core refused the close as malformed ({why}) and will refuse it again unchanged, so it stays open until core reaps it"
        ),
        CloseAtCore::NoSession => {
            "it never opened a session at core, so no core session holds its issues".into()
        }
    }
}

/// A subagent started: it takes the run its master declared for it.
///
/// A start is also the subagent heard from, in a process that is running now,
/// so an end recorded for the pane it ran in before no longer speaks for it,
/// and where the lead's hook names its transcript the run keeps that path from
/// its first turn rather than from its first stop (ISS-1312).
pub(crate) fn bind_declared(
    ctl: &Arc<Control>,
    agent_id: Option<&str>,
    agent_type: Option<&str>,
    session_id: &str,
    at_ms: i64,
    lead: Option<&str>,
) {
    let Some(child) = agent_id else { return };
    let transcript = lead
        .map(Path::new)
        .filter(|p| p.is_absolute())
        .and_then(|p| runner_core::transcript_age::child_transcript(p, child))
        .map(|p| p.to_string_lossy().into_owned());
    let roles = ctl
        .config_dir
        .as_deref()
        .and_then(runner_core::dispatch_gate::shipped_roles);
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else { return };
    let heard = |led: &runner_core::ledger::Ledger, run_id: &str| {
        if let Err(e) = led.note_subagent_started(run_id, at_ms, transcript.as_deref()) {
            tracing::warn!("[control] run {run_id}: cannot note that {child} started: {e}");
        }
    };
    let pending = match led.unbound_run_for_master(session_id, &ctl.boot_id) {
        Ok(pending) => pending,
        Err(e) => {
            tracing::warn!("[control] cannot read declared runs: {e}");
            return;
        }
    };
    // A start is a subagent's first, or a resume of one its master already
    // ran: Claude Code fires `SubagentStart` for both. Either takes the run
    // its master declared where it is of the role that run was declared for.
    let mut turned_away: Option<(String, String)> = None;
    if let Some(run) = pending {
        let promised_role = ctl
            .promises
            .lock()
            .expect("promises poisoned")
            .promised
            .get(&run.run_id)
            .and_then(|p| p.role.clone());
        match runner_core::dispatch_gate::claims_the_run(
            agent_type,
            roles.as_ref(),
            promised_role.as_deref(),
        ) {
            Ok(()) => {
                match led.bind_agent(&run.run_id, child) {
                    Ok(true) => {
                        heard(led, &run.run_id);
                        ctl.promises
                            .lock()
                            .expect("promises poisoned")
                            .promised
                            .remove(&run.run_id);
                        tracing::info!("[control] run {} is subagent {child}", run.run_id)
                    }
                    Ok(false) => match led.run_for_agent(child) {
                        Ok(Some(holder)) => {
                            heard(led, &holder.run_id);
                            tracing::warn!(
                                "[control] subagent {child} started under master session {session_id} and still answers to open run {}, so run {} stays unbound: a subagent answers to one open run, and the master closes the one it is done with",
                                holder.run_id,
                                run.run_id
                            )
                        }
                        _ => tracing::debug!(
                            "[control] run {} was already bound when {child} started",
                            run.run_id
                        ),
                    },
                    Err(e) => tracing::warn!("[control] cannot bind {child}: {e}"),
                }
                return;
            }
            Err(why) => {
                tracing::info!(
                    "[control] subagent {child} started under master session {session_id} and is not run {}'s: {why}. The run stays unbound for the subagent dispatched for it",
                    run.run_id
                );
                turned_away = Some((run.run_id, why));
            }
        }
    }
    match classify_start(
        led.run_for_agent(child)
            .map(|r| r.map(|run| run.run_id))
            .map_err(|e| e.to_string()),
    ) {
        StartKind::Replay(run_id) => {
            heard(led, &run_id);
            tracing::debug!(
                "[control] subagent {child} is already run {run_id}, so its start is a replay"
            )
        }
        StartKind::Undeclared => undeclared_child(ctl, child, agent_type, turned_away.as_ref()),
        StartKind::Unreadable(e) => unreadable_ledger(ctl, child, &e),
    }
}

#[cfg(test)]
mod preflight_tests {
    use super::*;

    fn keys() -> Vec<String> {
        vec!["ISS-46".to_string()]
    }

    #[tokio::test]
    async fn a_hold_core_names_refuses_the_declaration_by_name_and_sends_the_issues() {
        let (client, seen) = crate::test_core::fake_core(|_| {
            (
                422,
                r#"{"error":{"code":"ISSUE_BLOCKED","refusals":[{"code":"ISSUE_BLOCKED","path":"","detail":"a run session over these issues is refused. ISS-46: a live blocks edge holds it, ISS-44 is at in_progress"}]}}"#,
            )
        })
        .await;
        let why = preflight_refusal(Some(&client), "proj-1", &keys(), Said::default())
            .await
            .expect("a blocked issue is refused at declare");
        assert!(why.contains("ISS-46") && why.contains("ISS-44"), "{why}");
        assert!(why.contains("Nothing was recorded"), "{why}");
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, "/api/devices/me/run-sessions/preflight");
        assert!(seen[0].1.contains("ISS-46") && seen[0].1.contains("proj-1"));
    }

    /// FB-273: core refuses a take on an issue at rest by name, and that refusal is the pane's,
    /// not a core this box reads as unable to answer.
    #[tokio::test]
    async fn an_issue_at_rest_refuses_the_declaration_by_name() {
        let (client, _) = crate::test_core::fake_core(|_| {
            (
                422,
                r#"{"error":{"code":"ISSUE_AT_REST","refusals":[{"code":"ISSUE_AT_REST","path":"","detail":"a run session over these issues is refused. ISS-23 is at `needs_info` (Needs info), which is at rest. Return it from its park first (answer what it waits on), then declare again. Nothing was recorded."}]}}"#,
            )
        })
        .await;
        let why = preflight_refusal(Some(&client), "proj-1", &keys(), Said::default())
            .await
            .expect("a declaration over a parked issue was accepted; an issue at rest is refused at declare");
        assert!(
            why.contains("ISS-23") && why.contains("`needs_info`"),
            "{why}"
        );
        assert!(why.contains("Return it from its park"), "{why}");
        assert!(why.contains("Nothing was recorded"), "{why}");
    }

    /// ISS-576: a release judge is declared over the issues its release closed. Core admits a run
    /// over issues all closed, and the box holds no status rule of its own to refuse it with, so
    /// the declare-time answer and core's open agree: it is declared, and core was asked.
    #[tokio::test]
    async fn a_judge_over_closed_issues_core_admits_is_declared() {
        let (client, seen) = crate::test_core::fake_core(|_| (200, r#"{"ok":true}"#)).await;
        let judged = vec!["ISS-575".to_string(), "ISS-576".to_string()];
        assert_eq!(
            preflight_refusal(Some(&client), "proj-1", &judged, Said::default()).await,
            None,
            "a judge over closed issues core admits was refused at declare"
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "the declaration was not checked with core");
        assert_eq!(seen[0].0, "/api/devices/me/run-sessions/preflight");
        assert!(seen[0].1.contains("ISS-575") && seen[0].1.contains("ISS-576"));
    }

    #[tokio::test]
    async fn the_role_rides_the_preflight_body_only_when_given() {
        let (client, seen) = crate::test_core::fake_core(|_| (200, r#"{"ok":true}"#)).await;
        assert_eq!(
            preflight_refusal(
                Some(&client),
                "proj-1",
                &keys(),
                Said {
                    role: Some("qa"),
                    requirement: None
                }
            )
            .await,
            None
        );
        assert_eq!(
            preflight_refusal(Some(&client), "proj-1", &keys(), Said::default()).await,
            None
        );
        let seen = seen.lock().unwrap();
        let with: serde_json::Value = serde_json::from_str(&seen[0].1).unwrap();
        let without: serde_json::Value = serde_json::from_str(&seen[1].1).unwrap();
        assert_eq!(with["role"], "qa");
        assert!(
            without.get("role").is_none(),
            "an absent role was sent: {without}"
        );
    }

    #[tokio::test]
    async fn the_role_rides_the_open_body_only_when_given() {
        let (client, seen) =
            crate::test_core::fake_core(|_| (200, r#"{"sessionId":"s","runId":"r"}"#)).await;
        let keys = keys();
        runner_transport::run_sessions::open(
            &client,
            "p",
            "r",
            &keys,
            "n",
            None,
            runner_transport::run_sessions::Said {
                role: Some("qa"),
                requirement: None,
            },
        )
        .await
        .unwrap();
        runner_transport::run_sessions::open(
            &client,
            "p",
            "r",
            &keys,
            "n",
            None,
            runner_transport::run_sessions::Said::default(),
        )
        .await
        .unwrap();
        let seen = seen.lock().unwrap();
        let with: serde_json::Value = serde_json::from_str(&seen[0].1).unwrap();
        let without: serde_json::Value = serde_json::from_str(&seen[1].1).unwrap();
        assert_eq!(with["role"], "qa");
        assert!(without.get("role").is_none(), "{without}");
    }

    #[tokio::test]
    async fn an_unblocked_issue_is_declared_as_before() {
        let (client, _) = crate::test_core::fake_core(|_| (200, r#"{"ok":true}"#)).await;
        assert!(
            preflight_refusal(Some(&client), "p", &keys(), Said::default())
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_core_that_cannot_answer_leaves_the_declaration_to_the_open() {
        for status in [404u16, 401, 500, 503] {
            let (client, _) = match status {
                404 => crate::test_core::fake_core(|_| (404, "{}")).await,
                401 => crate::test_core::fake_core(|_| (401, "{}")).await,
                500 => crate::test_core::fake_core(|_| (500, "{}")).await,
                _ => crate::test_core::fake_core(|_| (503, "{}")).await,
            };
            assert!(
                preflight_refusal(Some(&client), "p", &keys(), Said::default())
                    .await
                    .is_none(),
                "status {status} refused a declaration core had not held"
            );
        }
        assert!(preflight_refusal(None, "p", &keys(), Said::default())
            .await
            .is_none());
    }
}

/// What `run declare` takes as the tree a subagent works in (ISS-737, seen on
/// orbit-forge 2026-10-29: a close removed the run's worktree and the next
/// declaration over that same path was accepted).
#[cfg(test)]
mod tree_tests {
    use super::*;

    const MASTER: &str = "sess-a";
    const PROJECT: &str = "proj-1";

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-declare-tree-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A repository with one commit, and a linked worktree of it at `<repo>/.claude/worktrees/iss-1`.
    fn repo_with_tree(at: &Path) -> (PathBuf, PathBuf) {
        let repo = at.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(
            &repo,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "one",
            ],
        );
        let tree = repo.join(".claude/worktrees/iss-1");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "iss-1",
                tree.to_str().unwrap(),
            ],
        );
        (repo, tree)
    }

    fn ctl(dir: &Path) -> Arc<Control> {
        ctl_with(dir, None)
    }

    fn ctl_with(dir: &Path, core: Option<runner_transport::CoreClient>) -> Arc<Control> {
        let masters = Arc::new(crate::master::Masters::default());
        masters.remember(
            PROJECT,
            crate::master::MasterState {
                session_id: MASTER.into(),
                name: "forge-master-proj".into(),
                last_work: std::time::Instant::now(),
                last_nudge: None,
                mcp_stale_reported: false,
            },
        );
        Arc::new(Control {
            tokens: crate::session_tokens::SessionTokens::at(dir.join("tokens.json")),
            activity: Arc::new(runner_core::agent_activity::Activities::new()),
            masters,
            ledger: Arc::new(std::sync::Mutex::new(Some(
                runner_core::ledger::Ledger::open(&dir.join("ledger.db")).unwrap(),
            ))),
            boot_id: "boot-1".into(),
            config_dir: Some(dir.to_path_buf()),
            promises: std::sync::Mutex::new(GateMemory::default()),
            drain: Arc::new(crate::drain::Drain::new(None)),
            hosts: Arc::new(runner_platform::subagent_host::ProcHosts::system()),
            core: core.map(Arc::new),
        })
    }

    async fn declare(ctl: &Arc<Control>, tree: &Path) -> ClaimReply {
        run_declare_as(
            ctl,
            &Holder::Legacy {
                session: MASTER.into(),
            },
            Declaration {
                project_id: PROJECT,
                issue_keys: &["ISS-1".to_string()],
                worktree_path: &tree.to_string_lossy(),
                role: None,
                requirement: None,
                cut: None,
            },
            MASTER,
            None,
        )
        .await
    }

    #[tokio::test]
    async fn a_tree_that_is_gone_is_refused_naming_the_path_and_the_way_to_cut_it() {
        let dir = scratch();
        let (repo, tree) = repo_with_tree(&dir);
        let ctl = ctl(&dir);
        let first = declare(&ctl, &tree).await;
        assert!(first.ok, "a live worktree was refused: {first:?}");
        // The master closes the run, and the close gives its worktree back.
        let run_id = first.job_id.unwrap();
        assert!(run_close(&ctl, &run_id, Some("done"), MASTER).await.ok);
        git(&repo, &["worktree", "remove", tree.to_str().unwrap()]);
        let reply = declare(&ctl, &tree).await;
        assert!(
            !reply.ok,
            "a declaration over a removed worktree was accepted: {reply:?}"
        );
        let why = reply.reason.unwrap_or_default();
        assert!(why.contains(&*tree.to_string_lossy()), "{why}");
        assert!(why.contains("git worktree add"), "{why}");
        assert!(why.contains("Nothing was recorded"), "{why}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The master works in its project's checkout; a tree of another
    /// repository is refused, and one of its own, main or linked, is taken.
    #[tokio::test]
    async fn a_tree_of_another_repository_is_refused_naming_both() {
        let dir = scratch();
        let (repo, tree) = repo_with_tree(&dir);
        let other = dir.join("other");
        std::fs::create_dir_all(&other).unwrap();
        let (_, foreign) = repo_with_tree(&other);
        assert_eq!(
            tree_refusal(&tree.to_string_lossy(), Some(&repo)).await,
            None
        );
        assert_eq!(
            tree_refusal(&repo.to_string_lossy(), Some(&tree)).await,
            None
        );
        let why = tree_refusal(&foreign.to_string_lossy(), Some(&repo))
            .await
            .expect("a worktree of another repository was taken for this project's");
        assert!(why.contains(&*foreign.to_string_lossy()), "{why}");
        assert!(why.contains(&*repo.to_string_lossy()), "{why}");
        assert!(why.contains("git worktree add"), "{why}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_directory_that_is_no_worktree_is_refused() {
        let dir = scratch();
        let (_repo, tree) = repo_with_tree(&dir);
        let ctl = ctl(&dir);
        let plain = dir.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let inside = tree.join("src");
        std::fs::create_dir_all(&inside).unwrap();
        for path in [plain, inside, PathBuf::from("relative/tree")] {
            let reply = declare(&ctl, &path).await;
            assert!(
                !reply.ok,
                "{} was declared as a worktree: {reply:?}",
                path.display()
            );
            let why = reply.reason.unwrap_or_default();
            assert!(why.contains(&*path.to_string_lossy()), "{why}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// ISS-735: a judge of a shipped requirement is declared over the
    /// requirement, with no issue, under a judging role; anything else naming a
    /// requirement, and a declaration with neither, is refused by name.
    #[test]
    fn a_requirement_run_is_a_judges_and_takes_no_issue() {
        let none: Vec<String> = Vec::new();
        let keys = || vec!["ISS-1".to_string()];
        assert_eq!(requirement_refusal(Some("REQ-76"), &none, Some("qa")), None);
        assert_eq!(
            requirement_refusal(Some("req-76"), &none, Some("forge:reviewer")),
            None
        );
        assert_eq!(requirement_refusal(None, &keys(), None), None);
        let why = |r: Option<&str>, k: &[String], role: Option<&str>| {
            requirement_refusal(r, k, role).expect("refused")
        };
        assert!(why(Some("REQ-76"), &none, Some("runner")).contains("`--role qa`"));
        assert!(why(Some("REQ-76"), &none, None).contains("no role"));
        assert!(why(Some("REQ-76"), &keys(), Some("qa")).contains("takes no issue"));
        assert!(why(Some("ISS-76"), &none, Some("qa")).contains("not a requirement reference"));
        assert!(why(Some("REQ-0"), &none, Some("qa")).contains("not a requirement reference"));
        assert!(why(None, &none, Some("qa")).contains("--requirement REQ-n"));
    }

    /// A core that answers every close with `answer`, counting them.
    struct Closer {
        sent: std::sync::atomic::AtomicUsize,
        answer: fn() -> runner_platform::error::Result<()>,
    }

    impl crate::run_record::SessionCloser for Closer {
        async fn close(
            &self,
            _session_id: &str,
            _detail: &str,
            _checkpoint: Option<serde_json::Value>,
            _claim_holders: &[String],
        ) -> runner_platform::error::Result<()> {
            self.sent.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            (self.answer)()
        }
    }

    /// A run declared over ISS-1 and opened at core as `session-1`.
    async fn opened_run(ctl: &Arc<Control>, tree: &Path) -> String {
        let run_id = declare(ctl, tree).await.job_id.expect("declared");
        let held = ctl.ledger.lock().unwrap();
        held.as_ref()
            .unwrap()
            .attach_session(&run_id, "session-1")
            .unwrap();
        run_id
    }

    fn row(ctl: &Arc<Control>, run_id: &str) -> runner_core::ledger::Run {
        let held = ctl.ledger.lock().unwrap();
        held.as_ref().unwrap().run(run_id).unwrap().unwrap()
    }

    /// ISS-929 (d): `run close` closes the run's core session itself, through the closer the
    /// sweep uses, and says so; the lease goes before the close answers, not a sweep later.
    #[tokio::test]
    async fn a_close_closes_its_core_session_and_says_so() {
        let dir = scratch();
        let (_repo, tree) = repo_with_tree(&dir);
        let ctl = ctl(&dir);
        let run_id = opened_run(&ctl, &tree).await;
        let core = Closer {
            sent: 0.into(),
            answer: || Ok(()),
        };
        let reply = run_close_with(&ctl, &run_id, Some("done"), MASTER, Some(&core)).await;
        assert!(reply.ok, "{reply:?}");
        assert_eq!(core.sent.load(std::sync::atomic::Ordering::SeqCst), 1);
        let said = reply.reason.unwrap_or_default();
        assert!(said.contains("session-1 is closed"), "{said}");
        let run = row(&ctl, &run_id);
        assert_eq!(run.ended_by.as_deref(), Some("master"));
        assert!(
            run.session_terminal_at.is_some(),
            "a close core took was not recorded, so the sweep sends it again"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// ISS-929 (d): a core answering 503 leaves the run ended on this box and its session owed:
    /// the close says the session is still open and why, never only `closed`, and the row is
    /// left for the sweep's close leg to send again.
    #[tokio::test]
    async fn a_close_core_cannot_take_says_the_session_is_still_open_and_leaves_it_to_the_sweep() {
        let dir = scratch();
        let (_repo, tree) = repo_with_tree(&dir);
        let ctl = ctl(&dir);
        let run_id = opened_run(&ctl, &tree).await;
        let core = Closer {
            sent: 0.into(),
            answer: || {
                Err(runner_platform::error::Error::Other(
                    "run-session close 503 Service Unavailable: no available server".into(),
                ))
            },
        };
        let reply = run_close_with(&ctl, &run_id, Some("done"), MASTER, Some(&core)).await;
        assert!(
            reply.ok,
            "the box's ending is recorded whatever core said: {reply:?}"
        );
        let said = reply.reason.unwrap_or_default();
        assert!(said.contains("session-1 is still open"), "{said}");
        assert!(said.contains("503"), "{said}");
        assert!(said.contains("next sweep sends it again"), "{said}");
        let run = row(&ctl, &run_id);
        assert_eq!(run.ended_by.as_deref(), Some("master"));
        assert!(run.session_terminal_at.is_none());
        let owed = {
            let held = ctl.ledger.lock().unwrap();
            held.as_ref()
                .unwrap()
                .ended_with_open_session("boot-1")
                .unwrap()
        };
        assert_eq!(
            owed.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>(),
            vec![run_id.as_str()],
            "the sweep's close leg does not see the close it owes"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The same over the wire: the daemon's own core client meets a 503 from the close route,
    /// and the pane is told the session is still open and owed to the sweep.
    #[tokio::test]
    async fn a_close_over_the_wire_meeting_a_503_is_owed_not_closed() {
        let dir = scratch();
        let (_repo, tree) = repo_with_tree(&dir);
        let (client, seen) = crate::test_core::fake_core(|_| (503, "no available server")).await;
        let ctl = ctl_with(&dir, Some(client));
        let run_id = opened_run(&ctl, &tree).await;
        let reply = run_close(&ctl, &run_id, Some("done"), MASTER).await;
        assert!(reply.ok, "{reply:?}");
        let said = reply.reason.unwrap_or_default();
        assert!(said.contains("session-1 is still open"), "{said}");
        assert!(said.contains("503"), "{said}");
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|(p, _)| p == "/api/devices/me/run-sessions/session-1/close"),
            "the close was never sent to core"
        );
        assert!(row(&ctl, &run_id).session_terminal_at.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A run that never opened at core has no session there to close, and the close says so
    /// rather than sending anything.
    #[tokio::test]
    async fn a_close_of_a_run_core_never_opened_sends_nothing() {
        let dir = scratch();
        let (_repo, tree) = repo_with_tree(&dir);
        let ctl = ctl(&dir);
        let run_id = declare(&ctl, &tree).await.job_id.expect("declared");
        let core = Closer {
            sent: 0.into(),
            answer: || Ok(()),
        };
        let reply = run_close_with(&ctl, &run_id, None, MASTER, Some(&core)).await;
        assert!(reply.ok);
        assert_eq!(core.sent.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(reply
            .reason
            .unwrap_or_default()
            .contains("never opened a session at core"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
