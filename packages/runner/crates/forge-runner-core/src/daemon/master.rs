//! What starts work now that nothing pushes it, and what keeps it alive.
//!
//! Core keeps jobs `queued` and offers them; this loop is the only thing on the
//! box that notices. It asks core which projects this device serves, reads each
//! one's pool, and keeps one RESIDENT master per project — a Claude session
//! running the `forge-master` skill, which decides order and batch size and
//! claims through the control socket.
//!
//! Resident, and parented by tmux rather than by this daemon (ISS-919). What
//! that buys: a human can `tmux attach` to the same pane core addresses, the
//! master survives a `forge-runner` restart, its reasoning appends to one
//! transcript instead of being truncated per pass, and every pass after the
//! first starts from context it already has. What it costs is that a dead
//! master no longer drops a socket, so the detector is here — `supervise`
//! below — and the ceiling that used to be a per-pass kill is now a bound on
//! silence after a prompt.
//!
//! The daemon deliberately makes NO routing decision. It answers one question
//! per project, "is there anything at all", and hands the rest to judgement.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::daemon::dispatch::resolve_repo;
use crate::daemon::terminal;
use crate::runner::process::{mcp_tool_timeout_default, resolve_claude_bin};
use crate::transport::{master as master_api, pool, runners, CoreClient};

/// How often the box asks whether any work exists.
// cm:why this interval IS the latency from an issue opening to an agent touching it, and it is the whole budget: nothing pushes any more, so a job queued one tick after a poll waits a full interval before anything looks. 30s was chosen against the old push path's measured dispatch lag on epodsystem (queue→dispatch of 17m, 23m, 46m and 2h08 on 2026-09-04) — an order of magnitude of headroom, at one cheap request per project per half minute.
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// How long a prompted master may print NOTHING before it is treated as hung.
///
/// The replacement B4 owes for `SESSION_IDLE_TIMEOUT`, which stopped governing
/// a process this daemon does not parent.
// cm:guard this bounds SILENCE AFTER A PROMPT, never residency, and the difference is the whole point. The old ceiling killed a master for still being alive, which is why §6 of the proposal had to design the master as a ticking loop; a resident master that is between passes is idle on purpose and must not be reaped for it. Sized against the same dev1 measurement 2026-09-05 that set the old 600s: passes weighing 1-2 jobs took 30-88s and 3-4 jobs took 75-112s, all of them printing throughout, so ten minutes of total silence is not a slow pass — it is a process that stopped.
// cm:guard what this must NOT go back to claiming is that core reclaims anything when it fires: since `fd1265751` a claim ends its own hold in the statement that stamps, so a killed master leaves nothing behind to reclaim — the jobs it started keep running and report for themselves. What the kill DOES owe is the hold on anything prepared and not started, which `supervise` releases on the same path.
const MASTER_SILENCE_CEILING: Duration = Duration::from_secs(600);

/// How quiet a master must be before the next pass prompt is typed at it.
// cm:guard a resident master shares ONE composer with the pass prompts, so a prompt sent while it is mid-turn queues behind the turn and the two run back to back on a stale pool read. Transcript growth is the only progress signal available through a tmux pane — there is no structured stdout to parse here, by design — so quiet-for-a-while is what "idle" means, and it is deliberately shorter than a pass so a finished master is prompted on the next sweep rather than the one after.
const MASTER_QUIET_BEFORE_PROMPT: Duration = Duration::from_secs(15);

/// Sweep spacing once every project this box serves is rate-limited.
// cm:guard this is a BACKOFF, never a blackout, and the distinction is the whole design. Core clears a limit only when a job SUCCEEDS (`clearRunnerLimit`), so a master that declines to sweep while limited removes the only thing that can clear the stamp, and an operator who fixes the account out of band is left watching an idle fleet forever. Slowing down costs a few minutes of latency; stopping costs the self-heal.
const LIMITED_POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// The first thing a resident master is told, once, when its session starts.
// cm:guard name the skill and STOP. Restating its rules here creates a second copy of the master's process, and the copies drift in silence because nothing compares them — the skill file is where a reader looks and this string is what a master is actually told. The two ship together (see the include_str edge below), so there is no version where inlining the rules here is even the safer half.
// cm:guard this is the STANDING brief and the pass prompt is the pool read, and the split is what makes residency worth anything. Folding the two back together sends the whole brief every 30 seconds — the cold start this change removed, arriving as tokens instead of as a process.
fn standing_prompt(project: &str, base_branch: Option<&str>) -> String {
    let mut out = format!(
        "Use the `forge-master` skill. You are the resident master for project `{project}` on \
this box. You will be given the claimable pool repeatedly, in this same session: read it, decide \
what runs and how much, claim through `forge-runner pool claim`, and end each pass by releasing \
anything you claimed but did not start.\n"
    );
    if let Some(base) = base_branch {
        out.push_str(&format!(
            "\nYou are standing in this project's checkout, on its base branch `{base}`. Every \
agent you start works in a worktree cut from `origin/{base}`, never in this tree.\n"
        ));
    }
    out.push_str(
        "\nYou NAME every agent you start: `forge-runner pool claim <jobId> --session-id <id> \
--agent <name>`. The name becomes that agent's git branch and its worktree, so it must read as \
the work — `ISS-175` when an agent takes one issue, something like `catalog-eav` when you group \
several into one. Give two jobs the SAME name deliberately and they share one checkout and one \
branch; give them different names and they cannot see each other's work. A claim with no name is \
refused.\n",
    );
    out.push_str(
        "\nTaking a job and starting it are two acts. `forge-runner pool prepare` gives you the \
job row and its token with nothing running; `forge-runner pool start` spawns it and \
`forge-runner pool discard` hands it back. `pool claim` is those first two in order, for when \
you have already decided.\n",
    );
    out.push_str(
        "\nBetween passes you stay open. Keep what you concluded — what you grouped, what you \
deliberately did not claim and why — where the next pass can read it, and say it out loud rather \
than only thinking it: this pane is the record.\n",
    );
    out
}

/// One pass: the pool as it stands, and nothing else.
fn pass_prompt(session_id: &str, issue_keys: &[String]) -> String {
    let mut out = format!(
        "Pass. Your master session id is `{session_id}` — pass it as `--session-id`.\n\nIssues \
with claimable work right now:\n"
    );
    for id in issue_keys {
        out.push_str("- ");
        out.push_str(id);
        out.push('\n');
    }
    out.push_str(
        "\nTake the time you need to decide, then stop. Claim what you are confident about, \
report, and let the next pass take the rest.\n",
    );
    out
}

/// What this box knows about each project's resident master.
// cm:guard one master per PROJECT, and the key is the project id rather than the box. Two masters on one project read the same pool and both claim: core's L1 refuses the second for the same ISSUE, but two jobs on two issues sharing that project's checkout would both start and collide on the same tree, which the repo lock then serialises into a stall neither master understands. Two masters on DIFFERENT projects are fine and are the point — they share no tree.
// cm:guard this map is now an OPTIMISATION, not the bound. The bound moved to two places that survive this process: tmux refuses a second session under a name that exists, and core refuses a second live `agent_sessions` row for the same (device, project). It had to move, because a session parented by the multiplexer is invisible to any in-process set — which is exactly the hole ISS-919 B1 names. Never re-derive the bound from this map alone: a daemon restart empties it while every master is still running.
// cm:guard this bounds masters and NOTHING ELSE. `duplex_max_sessions` (default 3) is the box's only process ceiling and it covers duplex PIPELINE jobs alone — a master takes no permit, and neither does a one-shot job. Adding a project therefore adds a claude process with nothing counting it; measured on dev1 2026-09-05 at load 17.26 on 12 cores with CPU pressure some=52%. A box-level bound is owed and is not this map.
#[derive(Default)]
pub struct Masters(Arc<Mutex<HashMap<String, MasterState>>>);

struct MasterState {
    session_id: String,
    name: String,
    transcript: Option<std::path::PathBuf>,
    /// Transcript length last seen, and when it last differed from the one before.
    seen_len: u64,
    last_growth: Instant,
    /// True between typing a pass prompt and seeing the pane answer it.
    prompted: bool,
}

impl Masters {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, project_id: &str) -> Option<(String, String, Option<std::path::PathBuf>)> {
        let live = self.0.lock().expect("masters poisoned");
        live.get(project_id)
            .map(|m| (m.session_id.clone(), m.name.clone(), m.transcript.clone()))
    }

    fn remember(&self, project_id: &str, state: MasterState) {
        let mut live = self.0.lock().expect("masters poisoned");
        live.insert(project_id.to_string(), state);
    }

    fn forget(&self, project_id: &str) -> Option<String> {
        let mut live = self.0.lock().expect("masters poisoned");
        live.remove(project_id).map(|m| m.session_id)
    }

    /// Record what the transcript looks like now, and answer what it means.
    ///
    /// `(quiet_for, prompted)` — how long the pane has printed nothing, and
    /// whether it owes an answer to a prompt already typed at it.
    fn observe(&self, project_id: &str, len: u64) -> (Duration, bool) {
        let mut live = self.0.lock().expect("masters poisoned");
        let Some(m) = live.get_mut(project_id) else {
            return (Duration::ZERO, false);
        };
        if len != m.seen_len {
            m.seen_len = len;
            m.last_growth = Instant::now();
            m.prompted = false;
        }
        (m.last_growth.elapsed(), m.prompted)
    }

    /// The pane name for a master session id, for the inbox's terminal arm.
    // cm:guard keyed by SESSION id, not project id. Core addresses a master by the `agent_sessions` row it registered, which is the only identity a `session.send` frame carries — a lookup by project would need core to know which project a session belongs to and to say so on the frame, and it does neither.
    pub fn pane_for_session(&self, session_id: &str) -> Option<String> {
        let live = self.0.lock().expect("masters poisoned");
        live.values()
            .find(|m| m.session_id == session_id)
            .map(|m| m.name.clone())
    }

    fn mark_prompted(&self, project_id: &str) {
        let mut live = self.0.lock().expect("masters poisoned");
        if let Some(m) = live.get_mut(project_id) {
            m.prompted = true;
            m.last_growth = Instant::now();
        }
    }
}

/// Poll every served project until `cancel` flips, keeping masters alive.
pub async fn run(
    client: CoreClient,
    cfg: Config,
    masters: Arc<Masters>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) {
    let mut delay = POLL_INTERVAL;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(delay) => delay = sweep(&client, &cfg, &masters).await,
            _ = cancel.changed() => { if *cancel.borrow() { break; } }
        }
    }
}

/// Whether a project's runner row on this box still wants new work.
///
/// The drain an operator reaches for when moving a project onto another box:
/// set the runner `draining` (or `disabled`), and this box stops STARTING work
/// while everything already running finishes untouched.
// cm:guard only an EXPLICIT stop counts, and `offline` deliberately does not. That status is written by the heartbeat and lags a live box by up to its interval, so gating on `online` would have a box refuse its own work over a stale row. Two statuses mean an operator decided; every other value, known or added later, keeps working.
// cm:guard this is the ONLY thing that reads the status, and until 2026-09-05 nothing did: `/me/runners` returned it, `MeRunner` parsed it, and no code looked. `retire` and every status change were therefore silent no-ops against a box that kept claiming — measured on epodsystem while moving it off dev1. Core cannot enforce this instead: `pool.ts` joins `runners` on (project, device) with no status filter, and adding one there would hide work from a master rather than let the box decline it.
fn accepts_new_work(status: &str) -> bool {
    !matches!(status, "draining" | "disabled")
}

/// How long to wait before the next sweep, given what core just reported.
///
/// Fast by default; stretched only when EVERY project that would take work is
/// rate-limited, so one limited project never slows down a healthy one.
// cm:guard the stretch requires ALL of them, and `any` here would be a throughput bug rather than a pacing one: this box serves several projects, and one account hitting its window would idle the rest for five minutes at a time.
// cm:guard `Some(0)` counts as NOT limited. An expired stamp is the normal steady state, because core only clears the column on a successful job — treating a lapsed limit as live is how a backoff becomes permanent.
fn next_poll_delay(served: &[runners::MeRunner]) -> Duration {
    let mut soonest: Option<u64> = None;
    for r in served.iter().filter(|r| accepts_new_work(&r.status)) {
        match r.rate_limited_for_seconds {
            Some(secs) if secs > 0 => {
                soonest = Some(soonest.map_or(secs, |s: u64| s.min(secs)));
            }
            _ => return POLL_INTERVAL,
        }
    }
    match soonest {
        None => POLL_INTERVAL,
        Some(secs) => Duration::from_secs(secs).clamp(POLL_INTERVAL, LIMITED_POLL_INTERVAL),
    }
}

/// One look at every project this device serves.
// cm:guard the project list comes from `/me/runners`, NEVER from `config.toml` bindings. Core is the source of truth for what a device serves and for where the checkout lives (`resolve_repo` reads the local binding only as a fallback), and the two disagree in practice: dev1 serves epodsystem-core with no local binding for it at all, so a sweep driven by the config file would leave that project's pool unread forever with nothing reporting why.
async fn sweep(client: &CoreClient, cfg: &Config, masters: &Arc<Masters>) -> Duration {
    let served = match runners::list_me(client).await {
        Ok(rs) => rs,
        Err(e) => {
            tracing::warn!("[master] cannot read this box's projects: {e}");
            return POLL_INTERVAL;
        }
    };
    let delay = next_poll_delay(&served);
    if delay > POLL_INTERVAL {
        for r in served.iter().filter(|r| accepts_new_work(&r.status)) {
            tracing::info!(
                "[master] {}: rate-limited ({}) — still sweeping, next pass in {}s",
                r.slug,
                r.limit_reason.as_deref().unwrap_or("unknown"),
                delay.as_secs()
            );
        }
    }

    for runner in &served {
        if !accepts_new_work(&runner.status) {
            tracing::info!(
                "[master] {}: runner is {} — taking no new work; anything already running finishes",
                runner.slug,
                runner.status
            );
            // cm:guard a drained runner still gets `supervise`, and only the START of new work is skipped. A master already running on a project being moved off this box must still be watched and still give its holds back when it dies — a drain that stopped watching would leave a dead master's work unclaimable with nothing reporting why, which is the drain doing damage rather than nothing.
            supervise(client, masters, &runner.project_id, &runner.slug).await;
            continue;
        }
        supervise(client, masters, &runner.project_id, &runner.slug).await;

        let items = match pool::pool(client, 20, Some(&runner.project_id)).await {
            Ok(items) => items,
            Err(e) => {
                tracing::warn!("[master] pool unreadable for {}: {e}", runner.slug);
                continue;
            }
        };
        // cm:guard an EMPTY pool starts no master, and that bound survives residency. A resident session is a `claude` process that lives until something ends it, and nothing counts it — `duplex_max_sessions` covers duplex pipeline jobs alone, so a box serving six projects would carry six permanent processes for however many of them never have work. A master that already exists is kept and still supervised; residency is for a project doing something, not for every row `/me/runners` returns.
        if items.is_empty() && masters.get(&runner.project_id).is_none() {
            continue;
        }

        let resolved = match resolve_repo(&served, cfg, &runner.project_id) {
            Ok(r) => r,
            Err(slug) => {
                // cm:guard refuse by NAME rather than falling back to some other directory. A master started in the wrong tree reads one repo and claims work for another, and every diff it produces lands where nobody looks — the silent substitution this repo forbids, and unrecoverable by the time anyone notices.
                tracing::error!(
                    "[master] {slug} has claimable work but no repo path on this box — no master will run for it; bind it or set the runner's repo_path"
                );
                continue;
            }
        };

        let Some(session) = ensure_master(client, masters, &runner.project_id, &resolved).await
        else {
            continue;
        };

        if items.is_empty() {
            continue;
        }

        // cm:guard list what the master can NAME back to core, not the internal ids — a pool entry carries `issueKey` and no projectId, and an entry with neither still counts. Dropping the keyless ones from the count would tell a master the pool is emptier than it is.
        let mut keys: Vec<String> = items.iter().filter_map(|i| i.issue_key.clone()).collect();
        keys.sort();
        keys.dedup();

        prompt_pass(
            masters,
            &runner.project_id,
            &resolved.slug,
            &session,
            &keys,
            items.len(),
        )
        .await;
    }
    delay
}

/// The master's own process, versioned with this binary.
// cm:guard the skill text ships INSIDE the runner and is written to the project checkout before every session starts. Nothing else delivers it — `skill_sync` seeds only what a project's manifest lists — and a master told to "use the forge-master skill" with nothing on disk loads nothing and improvises the one process this design depends on, silently. It SURVIVES `skill_sync`'s converge-on-delete only because `find_prunable` skips a directory with no `.hash` marker and this writes none; seed it through `write_skill_tree` and the next sync deletes it as an unmanifested skill. The price of embedding is real and is the trade: editing the master's process now needs a runner release, where a project skill needs only a push.
// cm:edge lockstep -> .claude/skills/forge-master/SKILL.md — that file is SOURCE for this binary, not local config: it is un-ignored in .gitignore for this one path and is named in ci.yml's `runner` path filter, because a skill-only PR that skipped the runner job would ship an unbuilt master through a green `ci-passed`.
const MASTER_SKILL: &str = include_str!("../../../../../../.claude/skills/forge-master/SKILL.md");

/// Write the skill where the session about to start will look for it.
fn install_skill(repo: &std::path::Path) -> std::io::Result<()> {
    let dir = repo.join(".claude/skills/forge-master");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("SKILL.md"), MASTER_SKILL)
}

/// Where a project's master keeps what only it can say.
// cm:guard per PROJECT, never one file for the box. Masters on two projects run at the same time by design, and a single log would interleave two sessions into a transcript that reads as one confused master.
// cm:guard APPEND, and the filename says so. This used to be `last-pass.log`, truncated on every spawn — measured 2026-09-05, the master's account of why it claimed ISS-917 was gone three minutes later, overwritten by the ISS-918 pass. B5 is that fix: a pane piped with `>>` into one file per project, so the judgement layer this design calls its entire value outlives the pass that produced it.
fn transcript_path(slug: &str) -> Option<std::path::PathBuf> {
    let dir = Config::path().ok()?.with_file_name("master").join(slug);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("transcript.log"))
}

fn transcript_len(path: Option<&std::path::Path>) -> u64 {
    path.and_then(|p| std::fs::metadata(p).ok())
        .map_or(0, |m| m.len())
}

/// The argv a master's pane runs.
// cm:guard `unset CLAUDECODE` through a shell rather than tmux's `-e`. A tmux session inherits the client environment and `-e` can only SET a variable, so the daemon's own `CLAUDECODE` would reach the pane and the master would believe it is nested inside another Claude session. `build_command` removes it for every other spawn on this box; this is the same removal on the one path that does not go through it.
// cm:guard no `-p`. The whole change is that this process reads from a terminal instead of taking one prompt and exiting, so `-p` here would restore the per-pass process with a tmux session wrapped uselessly around it.
fn master_argv() -> Vec<String> {
    let bin = terminal::shell_quote(resolve_claude_bin());
    vec![
        "sh".into(),
        "-c".into(),
        format!("unset CLAUDECODE; exec {bin} --permission-mode bypassPermissions"),
    ]
}

/// The environment a master's pane needs that a tmux session does not inherit.
// cm:guard `MCP_TOOL_TIMEOUT` must be carried here explicitly. Every other spawn on this box gets it from `build_command`, which a tmux session does not go through — and Claude Code's own default is ~28h, so one hung MCP call would wedge a master's turn for the rest of the day with the silence ceiling reading it as a healthy pause it cannot distinguish. The operator's own value wins, exactly as it does on the other path.
fn master_env() -> Vec<(String, String)> {
    match mcp_tool_timeout_default(std::env::var_os("MCP_TOOL_TIMEOUT").as_deref()) {
        Some(v) => vec![("MCP_TOOL_TIMEOUT".into(), v.into())],
        None => Vec::new(),
    }
}

/// Make sure this project has a live, registered master, and return its id.
// cm:guard register with core on EVERY sweep, not only when the pane is created. The row is what `jobs.held_by` carries, so a cached id would keep claiming onto a session core had already reaped — holds nobody can see, under an identity nobody is beating for. `ensureMasterSession` is idempotent precisely so this can be unconditional.
async fn ensure_master(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    resolved: &crate::daemon::dispatch::Resolved,
) -> Option<master_api::MasterSession> {
    let name = terminal::session_name(terminal::MASTER_PREFIX, &resolved.slug);
    // cm:guard refuse by name when tmux is missing rather than falling back to the per-pass `claude -p` this replaced. A box that quietly reverted would look identical in the log to one that is working, while none of the liveness, the transcript or the addressable pane exist on it.
    if !terminal::available() {
        tracing::error!(
            "[master] {}: tmux is not installed on this box — no master will run for it; install tmux (`forge-runner doctor` checks for it)",
            resolved.slug
        );
        return None;
    }

    let session = match master_api::register(client, project_id, &name).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("[master] {}: cannot register with core: {e}", resolved.slug);
            return None;
        }
    };

    if terminal::alive(&name).await {
        if masters.get(project_id).is_none() {
            // cm:guard adopt a pane this daemon did not create rather than killing it. The master survives a `forge-runner` restart by design, and a daemon that started by clearing what it does not remember would make every deploy an outage for every project on the box.
            tracing::info!(
                "[master] {}: adopting the resident session {name}",
                resolved.slug
            );
            remember(masters, project_id, &session, &resolved.slug);
        }
        return Some(session);
    }

    // cm:guard refuse to start when the skill cannot be written, rather than starting without it. A master with no skill still starts, still claims, and runs the whole orchestration off a four-line prompt — work that looks like it is being managed and is not.
    if let Err(e) = install_skill(&resolved.repo_path) {
        tracing::error!(
            "[master] {}: could not install the forge-master skill into {}: {e} — not starting a master",
            resolved.slug,
            resolved.repo_path.display()
        );
        return None;
    }

    let transcript = transcript_path(&resolved.slug);
    match terminal::ensure(
        &name,
        &resolved.repo_path,
        &master_argv(),
        &master_env(),
        transcript.as_deref(),
    )
    .await
    {
        Ok(_) => {}
        Err(e) => {
            tracing::error!("[master] {}: could not start {name}: {e}", resolved.slug);
            return None;
        }
    }
    tracing::info!(
        "[master] {}: resident session {name} started in {} — `tmux attach -t {name}` to watch it",
        resolved.slug,
        resolved.repo_path.display()
    );
    remember(masters, project_id, &session, &resolved.slug);

    // cm:guard the standing brief is typed ONCE, into a pane that has just started, and the sleep is not decoration: Claude Code draws its composer after a startup that takes a second or two, and a paste that lands before it is dropped on the floor with no error anywhere. The next sweep would then prompt a master that was never briefed.
    tokio::time::sleep(Duration::from_secs(5)).await;
    let brief = standing_prompt(&resolved.slug, resolved.base_branch.as_deref());
    if let Err(e) = terminal::send_line(&name, &brief).await {
        tracing::warn!("[master] {}: could not brief {name}: {e}", resolved.slug);
    }
    Some(session)
}

fn remember(
    masters: &Arc<Masters>,
    project_id: &str,
    session: &master_api::MasterSession,
    slug: &str,
) {
    let transcript = transcript_path(slug);
    masters.remember(
        project_id,
        MasterState {
            session_id: session.session_id.clone(),
            name: session.name.clone(),
            seen_len: transcript_len(transcript.as_deref()),
            transcript,
            last_growth: Instant::now(),
            prompted: false,
        },
    );
}

/// Type one pass at a master that is idle enough to read it.
async fn prompt_pass(
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
    session: &master_api::MasterSession,
    keys: &[String],
    claimable: usize,
) {
    let Some((_, name, transcript)) = masters.get(project_id) else {
        return;
    };
    let (quiet_for, _) = masters.observe(project_id, transcript_len(transcript.as_deref()));
    if quiet_for < MASTER_QUIET_BEFORE_PROMPT {
        tracing::debug!("[master] {slug}: still working — not prompting this sweep");
        return;
    }
    tracing::info!("[master] {slug}: {claimable} job(s) claimable — prompting {name}");
    match terminal::send_line(&name, &pass_prompt(&session.session_id, keys)).await {
        Ok(()) => masters.mark_prompted(project_id),
        Err(e) => tracing::warn!("[master] {slug}: could not prompt {name}: {e}"),
    }
}

/// The dead-master detector, re-homed from the control socket to the pane.
///
/// B3: the daemon is no longer the master's parent, so a dead master drops no
/// socket. What it does do is stop existing as a tmux session, and this is the
/// thing that notices — one sweep, not the three minutes core's reaper costs.
// cm:guard the holds come back on BOTH arms, and that is the load-bearing half. A master that dies holding a preparation parks claimable work until core's reaper notices; `pool::release` with no job id is the same "everything this session holds" call the socket-drop path used to make, and losing it would leave the fast detector detecting and not repairing.
// cm:guard close the row AFTER releasing, never before. Core's reaper reads a terminal status as reason enough to sweep, so a close that landed with the release still to come would race the reaper for the same rows — harmless twice over, but only in that order; the reverse leaves a live row with no holds and nothing to say why.
async fn supervise(client: &CoreClient, masters: &Arc<Masters>, project_id: &str, slug: &str) {
    let Some((session_id, name, transcript)) = masters.get(project_id) else {
        return;
    };

    if !terminal::alive(&name).await {
        tracing::warn!("[master] {slug}: resident session {name} is gone — returning its holds");
        end_master(
            client,
            masters,
            project_id,
            &session_id,
            "terminal session vanished",
        )
        .await;
        return;
    }

    let (quiet_for, prompted) = masters.observe(project_id, transcript_len(transcript.as_deref()));
    // cm:guard `prompted` is half the condition and dropping it inverts the rule. A resident master between passes is idle on purpose and prints nothing for as long as the pool stays empty; only silence that follows a prompt it was given is evidence of a hang.
    if prompted && quiet_for >= MASTER_SILENCE_CEILING {
        tracing::error!(
            "[master] {slug}: {name} has printed nothing for {}s since it was prompted — killing it and returning its holds",
            quiet_for.as_secs()
        );
        let _ = terminal::kill(&name).await;
        end_master(
            client,
            masters,
            project_id,
            &session_id,
            "silent past the ceiling",
        )
        .await;
    }
}

async fn end_master(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    session_id: &str,
    reason: &str,
) {
    match pool::release(client, None, session_id).await {
        Ok(n) if n > 0 => tracing::info!("[master] returned {n} hold(s) to the pool"),
        Ok(_) => {}
        Err(e) => tracing::warn!("[master] could not return holds for {session_id}: {e}"),
    }
    if let Err(e) = master_api::close(client, session_id, reason).await {
        tracing::warn!("[master] could not close session {session_id}: {e}");
    }
    masters.forget(project_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn served(entries: &[(&str, Option<u64>)]) -> Vec<runners::MeRunner> {
        entries
            .iter()
            .map(|(status, limited)| runners::MeRunner {
                project_id: "p".into(),
                runner_id: "r".into(),
                slug: "s".into(),
                base_branch: None,
                repo_path: None,
                branch: None,
                status: (*status).into(),
                kind: None,
                workspace_setup: None,
                rate_limited_for_seconds: *limited,
                limit_reason: None,
            })
            .collect()
    }

    // cm:guard this is the test that has to fail if anyone turns the backoff into a skip. A limited fleet must still be swept, because core clears the limit only on a job that SUCCEEDS — the delay may grow, but it is bounded and the sweep always happens.
    #[test]
    fn a_limited_fleet_is_slowed_down_and_never_stopped() {
        let d = next_poll_delay(&served(&[("online", Some(3600))]));
        assert!(d > POLL_INTERVAL, "a limited fleet should back off");
        assert!(
            d <= LIMITED_POLL_INTERVAL,
            "the backoff must stay bounded: {d:?}"
        );
    }

    // cm:guard one limited project must not slow down a healthy sibling — this box serves several, and `any` in place of `all` would idle the rest five minutes at a time.
    #[test]
    fn one_limited_project_does_not_slow_a_healthy_one() {
        let mixed = served(&[("online", Some(3600)), ("online", None)]);
        assert_eq!(next_poll_delay(&mixed), POLL_INTERVAL);
    }

    // cm:guard an EXPIRED stamp is the normal steady state, not a live limit: core clears the column only on a successful job, so reading a lapsed limit as live turns the backoff permanent.
    #[test]
    fn an_expired_limit_polls_at_full_speed() {
        assert_eq!(
            next_poll_delay(&served(&[("online", Some(0))])),
            POLL_INTERVAL
        );
    }

    // cm:guard an older core sends no field at all, and absent must mean "poll normally" — the permissive direction, opposite to `kind`. A cautious default here would idle every box talking to a core that predates the field.
    #[test]
    fn a_core_that_does_not_report_limits_polls_at_full_speed() {
        assert_eq!(next_poll_delay(&served(&[("online", None)])), POLL_INTERVAL);
    }

    // cm:guard a drained runner must not hold the whole box at full speed, nor drag it into a backoff: it is not a candidate for work at all, so it is excluded before the decision.
    #[test]
    fn a_drained_runner_is_not_counted_either_way() {
        let mix = served(&[("draining", None), ("online", Some(3600))]);
        assert!(next_poll_delay(&mix) > POLL_INTERVAL);
    }

    // cm:guard the registry is per PROJECT, and the second assertion is the whole test: a box-wide flag would leave every project after the first unserved for as long as any one master lived.
    #[test]
    fn one_master_per_project_and_projects_do_not_block_each_other() {
        let masters = Masters::new();
        let session = master_api::MasterSession {
            session_id: "s1".into(),
            name: "forge-master-p1".into(),
            created: true,
        };
        let masters = Arc::new(masters);
        remember(&masters, "p1", &session, "p1");
        assert_eq!(masters.get("p1").map(|m| m.0), Some("s1".into()));
        assert!(
            masters.get("p2").is_none(),
            "one project's master is not another's"
        );
        assert_eq!(masters.forget("p1"), Some("s1".into()));
        assert!(masters.get("p1").is_none());
    }

    // cm:guard silence only counts AFTER a prompt. A resident master between passes prints nothing for as long as the pool stays empty, so a ceiling that ignored `prompted` would kill every idle master on a quiet project — the exact failure `SESSION_IDLE_TIMEOUT` produced, rebuilt on new machinery.
    #[test]
    fn silence_is_only_evidence_of_a_hang_once_the_master_has_been_prompted() {
        let masters = Arc::new(Masters::new());
        let session = master_api::MasterSession {
            session_id: "s1".into(),
            name: "forge-master-p1".into(),
            created: true,
        };
        remember(&masters, "p1", &session, "p1");

        let (_, prompted) = masters.observe("p1", 0);
        assert!(!prompted, "an idle master owes nothing");

        masters.mark_prompted("p1");
        let (_, prompted) = masters.observe("p1", 0);
        assert!(prompted, "a prompted master owes an answer");

        // Any growth in the transcript is the answer arriving.
        let (quiet, prompted) = masters.observe("p1", 42);
        assert!(!prompted, "output clears the debt");
        assert!(quiet < MASTER_QUIET_BEFORE_PROMPT);
    }

    // cm:guard the prompt gate must be SHORTER than the hang ceiling, or a master is killed for being silent before it is ever prompted again — the two bounds would then race, and the loser is always the healthy master.
    #[test]
    fn the_quiet_gate_is_shorter_than_the_hang_ceiling() {
        assert!(MASTER_QUIET_BEFORE_PROMPT < MASTER_SILENCE_CEILING);
        assert!(POLL_INTERVAL < MASTER_SILENCE_CEILING);
    }

    // cm:guard `-p` must never come back, and neither may `CLAUDECODE`. The first would restore the per-pass process this change removed, with a tmux session wrapped uselessly around it; the second makes the master believe it is nested inside another Claude session, which changes its behaviour with nothing in any log naming why.
    #[test]
    fn the_master_runs_interactively_with_no_inherited_claudecode() {
        let argv = master_argv();
        assert_eq!(argv[0], "sh");
        let line = &argv[2];
        assert!(line.contains("unset CLAUDECODE"), "{line}");
        assert!(
            line.contains("--permission-mode bypassPermissions"),
            "{line}"
        );
        assert!(
            !line.contains(" -p "),
            "a resident master takes no -p: {line}"
        );
    }

    // cm:guard a tmux session inherits the client environment and `-e` can only SET, never unset — so every variable the master needs that `build_command` would have given it has to be listed here, and the ones it must NOT have are removed by the `sh` line instead. Dropping either half is silent: the master runs, and behaves differently.
    #[test]
    fn the_pane_carries_the_mcp_timeout_and_respects_an_operator_override() {
        let env = master_env();
        match std::env::var_os("MCP_TOOL_TIMEOUT") {
            Some(v) if !v.is_empty() => assert!(env.is_empty(), "an operator value must win"),
            _ => {
                assert_eq!(env.len(), 1);
                assert_eq!(env[0].0, "MCP_TOOL_TIMEOUT");
                assert!(env[0].1.parse::<u64>().is_ok(), "{:?}", env[0].1);
            }
        }
    }

    // cm:guard the standing brief and the pass prompt must stay SEPARATE, and this is the assertion that fails if they are folded back together: re-sending the brief every 30 seconds is the cold start this change removed, arriving as tokens instead of as a process.
    #[test]
    fn the_pass_prompt_carries_the_pool_and_not_the_brief() {
        let brief = standing_prompt("forge-dev", Some("main"));
        assert!(brief.contains("forge-master"));
        assert!(brief.contains("origin/main"));

        let pass = pass_prompt("sess-1", &["ISS-1".into(), "ISS-2".into()]);
        assert!(
            pass.contains("sess-1"),
            "the master needs its own session id: {pass}"
        );
        assert!(pass.contains("ISS-1") && pass.contains("ISS-2"));
        assert!(
            !pass.contains("forge-master skill"),
            "the brief must not repeat: {pass}"
        );
    }
}
