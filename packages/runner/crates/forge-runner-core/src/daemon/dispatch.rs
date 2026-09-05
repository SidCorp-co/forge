//! Handle one CLAIMED job: resolve the repo, run it via the runner, and map
//! the normalized [`RunnerEvent`] stream onto core's job-event + lifecycle API.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc;

use crate::config::Config;
use crate::daemon::repo_lock::RepoLocks;
use crate::daemon::{preflight, setup_agent};
use crate::error::{Error, Result};
use crate::runner::claude_code::ClaudeCodeRunner;
use crate::runner::{JobSpec, Runner, RunnerEvent, ToolPhase};
use crate::transport::events::{self, post_job_events, JobEventInput};
use crate::transport::pool::ClaimedJob;
use crate::transport::runners::{self, MeRunner};
use crate::transport::{lifecycle, CoreClient};
use crate::workspace::{provision, refresh, salvage, skill_sync};

/// Resolved working dir for one assigned project. The server (`/me/runners`)
/// is the source of truth for `repo_path`; `config.toml` is only a local
/// fallback/cache when the server has no path set yet (ISS-271).
#[derive(Debug)]
pub(crate) struct Resolved {
    pub slug: String,
    pub repo_path: PathBuf,
    /// The project's base branch per the server, when it has one. Only the
    /// refresh reads it — the fast-forward target must be the base, not
    /// whatever the folder currently sits on.
    pub base_branch: Option<String>,
    /// The project's shape per the server (`standard` / `website`). Decides
    /// whether the git preflight applies at all.
    pub kind: Option<String>,
    /// The server-side runner row for this (device × project). Only re-provisioning
    /// needs it — that call addresses a runner, not a project.
    pub runner_id: Option<String>,
    /// `projects.workspace_setup` — prose the setup agent follows instead of
    /// deriving the repo's setup procedure for itself.
    pub workspace_setup: Option<String>,
}

/// Merge server assignments with local config bindings for one project id.
/// Returns `Ok(None)` when the project is assigned but has no usable path on
/// either side (caller emits a `bind` hint), and `Err` only never (kept simple).
pub(crate) fn resolve_repo(
    server: &[MeRunner],
    cfg: &Config,
    project_id: &str,
) -> std::result::Result<Resolved, String> {
    let server_match = server.iter().find(|r| r.project_id == project_id);
    let config_match = cfg
        .bindings
        .iter()
        .find(|(_, b)| b.project_id.as_deref() == Some(project_id));

    // Slug: prefer the server's authoritative slug, else the local config key.
    let slug = server_match
        .map(|r| r.slug.clone())
        .or_else(|| config_match.map(|(slug, _)| slug.clone()))
        .unwrap_or_else(|| project_id.to_string());

    // Repo path: server first (non-empty), then local config binding.
    let server_path = server_match
        .and_then(|r| r.repo_path.as_deref())
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);
    let repo_path = server_path.or_else(|| config_match.map(|(_, b)| b.repo_path.clone()));

    let base_branch = server_match
        .and_then(|r| r.base_branch.as_deref())
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);

    let kind = server_match
        .and_then(|r| r.kind.as_deref())
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string);

    let runner_id = server_match.map(|r| r.runner_id.clone());
    let workspace_setup = server_match
        .and_then(|r| r.workspace_setup.as_deref())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);

    match repo_path {
        Some(repo_path) => Ok(Resolved {
            slug,
            repo_path,
            base_branch,
            kind,
            runner_id,
            workspace_setup,
        }),
        None => Err(slug),
    }
}

/// Whether this job must pass the git preflight (work tree / origin remote /
/// reachability) before the runner claims it.
///
/// Two independent reasons it may not apply:
///   - the JOB never touches git — `reconcile`/`verify_skill` edit a skill body
///     over MCP (ISS-808);
///   - the PROJECT has no git repo by design — a `website` project is an
///     Epodsystem storefront whose deliverable is store content, not commits.
// cm:guard fail CLOSED on anything unrecognised, and `None` is unrecognised. A missing or unknown `kind` must REQUIRE the preflight — that is what keeps a normal project from losing its git checks because a field was dropped from `/me/runners` or a core predates it. Only the explicit string `website` skips.
// cm:guard `website` was declared by ISS-387 (schema.ts: "a git repo is optional") and read by NOTHING for two months — ISS-808 then closed the reconcile half and put the pipeline half out of scope on the premise that storefront projects "already do not" run git-based stages. mowment received a `triage` job on 2026-08-14 and held on `preflight_failed: origin_remote`, so that premise was false. This function is the wire those two issues each left to the other.
fn requires_preflight(job_type: &str, project_kind: Option<&str>) -> bool {
    if matches!(job_type, "reconcile" | "verify_skill") {
        return false;
    }
    project_kind != Some("website")
}

/// Blocking preflight failures that re-provisioning could plausibly fix: there
/// is no folder, or the folder is not a checkout. Everything else (no `origin`,
/// dead push credentials) survives a re-clone and stays a failure.
// cm:guard match on the PREFIX, not the whole string — the detail carries a path and git's own stderr. And keep this list to faults `classify_workspace` can actually act on: sending an unreachable-remote job into a re-clone just spends 20s per attempt to fail the same way, and re-queues the runner's provision row for nothing.
fn is_reprovisionable(err: &str) -> bool {
    err.starts_with("repo_path:") || err.starts_with("work_tree:")
}

/// One measurement of the workspace: `Err` is blocking, `Ok` carries the
/// repairable findings plus the git state the caller needs for the start-point.
///
/// `owns_root` is false for a stage that gets its own worktree (`code`/`fix`).
/// Those run in a tree cut from `origin/<base>`, so the ROOT's branch is not
/// theirs to fix — but a repo-level fault like `core.hooksPath` is inherited by
/// every worktree and stays a finding for them too.
async fn measure(
    repo_path: &Path,
    base_branch: Option<&str>,
    owns_root: bool,
) -> std::result::Result<(Vec<String>, refresh::WorkspaceGit), String> {
    let mut findings = preflight::preflight(repo_path).await?.lines;
    let git_state = refresh::refresh(repo_path, base_branch).await;
    if refresh_is_repairable(&git_state, owns_root) {
        findings.push(refresh::describe(&git_state));
    }
    Ok((findings, git_state))
}

/// Is an unrefreshed workspace something the setup agent should be asked to fix?
// cm:guard a tree holding someone else's uncommitted work is NEVER a repairable finding. A finding is what summons the setup agent, and its rules say to `git stash push -u -m forge-setup` whatever blocks it — so reporting the one back-off that exists to PRESERVE that work is what destroys it. Measured 2026-08-31 on this repo: refresh left an interactive session's 9 files alone, said so, and the saying stashed them. The agent is told instead, through the workspace notice.
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/setup_agent.rs — that agent's RULES grant the stash; this predicate is what keeps it away from a tree it must not touch
fn refresh_is_repairable(git: &refresh::WorkspaceGit, owns_root: bool) -> bool {
    !git.refreshed && owns_root && !git.foreign_work
}

/// What a stage is told about a root carrying work that is not the pipeline's.
fn foreign_work_text(detail: &str) -> String {
    format!(
        "The repo root holds uncommitted work that is not this job's: {detail}. It was left \
         alone on purpose. Do NOT `git stash`, `git checkout --`, `git reset` or `git clean` it \
         — someone is using this tree. Work on your own branch; if you cannot proceed without a \
         clean root, stop and say so rather than clearing it."
    )
}

/// What a stage is told about the workspace it is about to work in.
///
/// Three parts, any of which may be absent: what the setup agent did, what is
/// still wrong after it, and — for a worktree lane — that the root it can see is
/// not the base branch even though its own tree is.
// cm:guard whatever else changes here, keep the last line. A stale checkout makes file content and `git log` agree WITH EACH OTHER, so "I verified by reading the files, not just history" is the one check that cannot catch it, and an agent that reads a stale tree reports confident, wrong findings (session 228cdf03, ceo-dashboard: 6 of 7 claims wrong).
fn workspace_notice_text(
    findings: &[String],
    root_warning: Option<&str>,
    setup_summary: Option<&str>,
    base_branch: Option<&str>,
) -> String {
    let mut out = String::from("[workspace notice]\n");
    if let Some(summary) = setup_summary {
        out.push_str("A setup step ran in this workspace before you started. It reported:\n");
        out.push_str(summary);
        out.push_str("\n\n");
    }
    if !findings.is_empty() {
        out.push_str("Still wrong after that, and yours to deal with:\n");
        for f in findings {
            out.push_str("- ");
            out.push_str(f);
            out.push('\n');
        }
        match base_branch {
            Some(base) => out.push_str(&format!(
                "Fix what you can before starting the task. Getting onto `{base}` and fast-forwarding it to `origin/{base}` is yours to do — but never by discarding uncommitted changes that are not yours: leave them, say so, and treat every file you read as possibly not `{base}`.\n"
            )),
            None => out.push_str(
                "Work out what this checkout is on and get it onto the branch this step is supposed to run against, without discarding anyone else's uncommitted work.\n",
            ),
        }
    }
    if let Some(warning) = root_warning {
        out.push_str(warning);
        out.push('\n');
    }
    out.push_str("Until the tree is known-current, do not state what is or is not on the base branch from local files — check the remote before any such claim.");
    out
}

/// What a worktree lane is told about a root it does not own.
fn root_warning_text(described: &str, base_branch: Option<&str>) -> String {
    match base_branch {
        Some(base) => format!(
            "Your own worktree was cut from `origin/{base}` and is current. The repo ROOT is not: {described}. Work in your worktree; do not read the root as if it were `{base}`, and do not try to fix it."
        ),
        None => format!(
            "The repo ROOT is in an unknown state: {described}. Work in your worktree and do not read the root."
        ),
    }
}

/// Commit-ish a new ISS-* branch must be cut from, or `None` when the daemon
/// could not resolve one and `git worktree add` has to fall back to HEAD.
// cm:guard pass `origin/<base>` whenever it resolved, refreshed or NOT — with the hard refusal gone an unrefreshed root can sit on any branch, and `worktree add -b` with no start-point cuts the ISS-* branch from whatever that is. On anhome (2026-08-15) that root was `main`, the production branch. Gate on `base_sha`, not on `refreshed`: the sha is what proves the ref exists locally, and requiring `refreshed` would drop the start-point in exactly the case that needs it.
fn start_point_for(state: &refresh::WorkspaceGit) -> Option<String> {
    match (&state.base_sha, &state.base_branch) {
        (Some(_), Some(base)) => Some(format!("origin/{base}")),
        _ => None,
    }
}

const FLUSH_INTERVAL: Duration = Duration::from_millis(500);
/// Cadence for the per-job session heartbeat. A `POST /api/jobs/:id/events`
/// bumps `agent_sessions.lastHeartbeatAt` server-side, so emitting a tiny
/// `progress` event while the agent is silent keeps the session alive. 25s is
/// comfortably under the server's 180s session stale threshold
/// (`PIPELINE_HEARTBEAT_TIMEOUT_MS`, min 30s) and matches desktop parity
/// (`packages/dev/src/hooks/use-web-socket.ts`). See ISS-285.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(25);
/// How long a job may wait for another job on this box to finish with the repo.
// cm:guard a bounded wait, because `locks.acquire` has no deadline of its own: a leaked guard parks every later job on the box forever, and the failure names the wrong thing (a dead agent) at whatever reaper notices first.
const REPO_LOCK_WAIT: Duration = Duration::from_secs(10 * 60);

/// How long the pre-spawn phase may keep claiming progress before it goes quiet.
// cm:guard the runner must give up BEFORE core condemns, and these two numbers are what decide that — so derive them, never pick them apart. Core fails a session 180s after the last beat, so a beat budget shorter than the runner's own deadline inverts the order: the beat stops, core fails the job and routes it to retry, and THEN `locks.acquire` returns and an agent spawns under a job that is already terminal and already re-queued elsewhere. That is the two-agents-one-worktree shape, reached from the opposite direction. The budget therefore covers the whole lock wait plus a post-lock allowance for preflight, skill sync and `git worktree add`.
const PRE_SPAWN_BEAT_BUDGET: Duration = Duration::from_secs(REPO_LOCK_WAIT.as_secs() + 15 * 60);
const PRE_SPAWN_MAX_TICKS: u32 =
    (PRE_SPAWN_BEAT_BUDGET.as_secs() / HEARTBEAT_INTERVAL.as_secs()) as u32;

// cm:guard the ordering above is load-bearing enough to fail the BUILD rather than a review: a beat that runs out first is the ghost-agent shape, and nothing at runtime would name it.
const _: () = assert!(PRE_SPAWN_BEAT_BUDGET.as_secs() > REPO_LOCK_WAIT.as_secs());

/// Read the on-disk `.hash` markers from `<repo>/.claude/skills/*/` to build
/// the `skillsRanWith` map sent to the server at ACK time (ISS-798).
///
/// The map is keyed by skill name (directory name under `.claude/skills/`) and
/// valued by the hash stored in `<dir>/.hash`. Skills missing a `.hash` marker
/// are skipped (rather than emitting a null, which would be ambiguous).
///
/// **Limitation (shadow case):** this reads the *project-level* `.hash` markers
/// under `<repo>/.claude/skills/`, not the user-level shadow at
/// `~/.claude/skills/<name>/`. When a user shadow is active, `skillsRanWith`
/// records the project hash rather than the shadow body's hash. The
/// authoritative shadow signal for an individual device is `device_skills.shadowed_by`
/// (populated by `skill_sync.rs`); `skills_ran_with` is accurate only for the
/// common (no-shadow) path.
///
/// Returns `None` when the skills directory doesn't exist (no skills seeded)
/// or on any I/O error — the ACK is best-effort, so callers never fail a job
/// over a missing `skillsRanWith`.
fn read_skills_ran_with(repo_path: &Path) -> Option<serde_json::Value> {
    let skills_dir = repo_path.join(".claude").join("skills");
    let read_dir = std::fs::read_dir(&skills_dir).ok()?;
    let mut map = serde_json::Map::new();
    for entry in read_dir.flatten() {
        if !entry.file_type().is_ok_and(|ft| ft.is_dir()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let hash_path = entry.path().join(".hash");
        if let Ok(hash) = std::fs::read_to_string(&hash_path) {
            let hash = hash.trim().to_string();
            if !hash.is_empty() {
                map.insert(name, serde_json::Value::String(hash));
            }
        }
    }
    if map.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(map))
    }
}

/// Handle a server-pushed `skill.sync` command: resolve the project's repo on
/// this device and seed `<repo>/.claude/skills/<name>/` from the effective
/// manifest, reporting installed hashes back. This is the ONLY path that pulls
/// skills to a CLI runner — it never runs automatically at job start (that was
/// removed in 53d4ad94 because it clobbered project-local overrides). A push is
/// always operator-initiated (web Sync action or `forge_skills.push`).
pub async fn handle_skill_sync(client: &CoreClient, cfg: &Config, data: Value) -> Result<()> {
    let project_id = data
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Other("skill.sync: missing projectId".into()))?
        .to_string();

    let server = runners::list_me(client).await.unwrap_or_default();
    let resolved = match resolve_repo(&server, cfg, &project_id) {
        Ok(r) => r,
        Err(slug) => {
            tracing::warn!(
                "[skill.sync] project '{slug}' is assigned here but has no repo path — skipping"
            );
            return Ok(());
        }
    };

    match skill_sync::sync_skills(client, &project_id, &resolved.repo_path).await {
        Ok(n) => tracing::info!(
            "[skill.sync] project={project_id} synced {n} skill(s) into {}",
            resolved.repo_path.join(".claude/skills").display()
        ),
        Err(e) => {
            tracing::warn!("[skill.sync] project={project_id} sync failed: {e}");
            skill_sync::report_sync_failure(client, &project_id, &e).await;
        }
    }
    Ok(())
}

/// Run one job this box has already claimed.
// cm:guard the caller must hold the claim BEFORE calling, and must release it on every path that returns without the job running. Core hands the hold back only to `releaseJobFromMaster` or the 3-minute reaper, so a preparation that reaches here and then falls out silently costs a slot until a reaper notices.
pub async fn handle(
    client: &CoreClient,
    runner: Arc<ClaudeCodeRunner>,
    cfg: &Config,
    locks: &RepoLocks,
    ja: ClaimedJob,
) -> Result<()> {
    let job_id = ja.job_id.clone();
    tracing::info!(
        "[job {job_id}] type={} project={}",
        ja.job_type,
        ja.project_id
    );

    // Resolve the working dir. The server (`/me/runners`) is the source of
    // truth for the repo path; the local config.toml binding is only a
    // fallback when the server has no path yet. Fetch per-dispatch so a
    // freshly web-set path is picked up without a daemon restart (ISS-271).
    let server = match runners::list_me(client).await {
        Ok(rows) => rows,
        Err(e) => {
            // Stay functional on a transient/old-server failure: fall back to
            // the local config bindings only.
            tracing::warn!("[job {job_id}] /me/runners unavailable ({e}) — using local config");
            Vec::new()
        }
    };

    let resolved = match resolve_repo(&server, cfg, &ja.project_id) {
        Ok(r) => r,
        Err(slug) => {
            let msg = format!(
                "project '{slug}' is assigned to this device but has no repo path — run `forge-runner bind {slug} --path <dir>`"
            );
            tracing::error!("[job {job_id}] {msg}");
            let _ = lifecycle::fail(client, &job_id, &msg).await;
            return Ok(());
        }
    };
    let slug = resolved.slug;

    // cm:guard hold the root from HERE until the session owns a tree of its own. `measure` runs `workspace::refresh` (fetch · checkout -- · merge --ff-only) on the ROOT for every job, worktree lane included, and `runner.start` adds the worktree to the root's `.git` — two jobs doing that at once write one index. This guard, not the core-side cap, is what makes a per-device cap above 1 safe.
    // cm:guard the heartbeat MUST start before this wait, not after it. Core flips a session `queued -> running` on its first job event, and the claim hop fails a session still `queued` 120s after dispatch — so a job queued behind a busy root posted nothing and was reaped as if the box were dead. Measured on epodsystem 2026-09-05: 61 sessions. The premise this guard used to carry (leave it unacked so core can re-dispatch elsewhere) died with the push dispatcher; under the pool a job is claimed by the box that will run it, and nothing re-routes it.
    let pre_spawn_beat = AbortOnDrop({
        let client = client.clone();
        let job_id = job_id.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(HEARTBEAT_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            tick.tick().await;
            for _ in 0..PRE_SPAWN_MAX_TICKS {
                tick.tick().await;
                let beat = [JobEventInput::new(
                    "progress",
                    serde_json::json!({ "heartbeat": true, "phase": "pre-spawn" }),
                )];
                if let Err(e) = post_job_events(&client, &job_id, &beat).await {
                    tracing::debug!("[job {job_id}] pre-spawn heartbeat: {e}");
                }
            }
            tracing::error!(
                "[job {job_id}] still not spawned after the pre-spawn budget — going quiet so the heartbeat reaper can judge it. The repo-lock deadline should have fired first; if it did not, setup itself is wedged."
            );
        })
    });
    if locks.is_busy(&resolved.repo_path) {
        tracing::info!(
            "[job {job_id}] waiting for the repo root {} — another job on this box holds it",
            resolved.repo_path.display()
        );
    }
    let repo_guard =
        match tokio::time::timeout(REPO_LOCK_WAIT, locks.acquire(&resolved.repo_path)).await {
            Ok(g) => g,
            Err(_) => {
                let msg = format!(
                    "repo_lock_timeout: {} is still held after {}s",
                    resolved.repo_path.display(),
                    REPO_LOCK_WAIT.as_secs()
                );
                tracing::error!("[job {job_id}] {msg}");
                let _ = lifecycle::fail(client, &job_id, &msg).await;
                return Ok(());
            }
        };

    // ISS-451 (ISS-442 C5, invariant I6): fail fast BEFORE claiming the job
    // when the repo / push credentials / hooks are broken, instead of a
    // 40-minute mid-run discovery. The `preflight_failed` prefix and its
    // `origin_remote:`/`work_tree:`/`repo_path:` sub-variants are load-bearing —
    // core's classifier (`packages/core/src/pipeline/failure-classifier.ts`)
    // pattern-matches on this exact string to pick failureKind (ISS-808).
    // cm:guard the workspace refresh below shares this gate deliberately — it fast-forwards a git checkout, so it is as meaningless on a repo-less project as the preflight is. Splitting them would send a `website` project into `git fetch` on a folder with no remote.
    // cm:guard the branch is the MASTER'S agent name, and every claimed job gets one. Core's `worktreeBranch` payload is gone: it derived the name from the issue key, which cannot express a master grouping two issues into one agent, and its merge-stage exemption had been unreachable since ISS-897 left `drive` as the only dispatched type. Never reintroduce a fallback here — an empty name means the claim gate let an unnamed agent through, and the honest answer is that bug, not a job quietly writing the repo root.
    let worktree_branch = Some(ja.agent_name.clone());
    let owns_root = false;

    let mut workspace_notice: Option<String> = None;
    let mut worktree_start_point: Option<String> = None;
    if requires_preflight(&ja.job_type, resolved.kind.as_deref()) {
        let measured = match measure(
            &resolved.repo_path,
            resolved.base_branch.as_deref(),
            owns_root,
        )
        .await
        {
            Ok(m) => Ok(m),
            // cm:guard re-provision, then MEASURE again — never trust the provision status. It reports `ready` from the runner's own view of a sweep that may have hit `needs_manual_setup` for a reason no re-run changes (an occupied folder, no repo URL), and a job that proceeded on that word would run in the same broken tree it just failed on.
            Err(err) if is_reprovisionable(&err) => match resolved.runner_id.as_deref() {
                Some(runner_id) => {
                    tracing::warn!(
                        "[job {job_id}] {err} — re-provisioning the workspace before giving up"
                    );
                    provision::reprovision(client, cfg, runner_id).await;
                    measure(
                        &resolved.repo_path,
                        resolved.base_branch.as_deref(),
                        owns_root,
                    )
                    .await
                }
                None => Err(err),
            },
            Err(err) => Err(err),
        };
        let (mut findings, mut git_state) = match measured {
            Ok(m) => m,
            Err(err) => {
                let msg = format!("preflight_failed: {err}");
                tracing::error!("[job {job_id}] {msg}");
                let _ = lifecycle::fail(client, &job_id, &msg).await;
                return Ok(());
            }
        };
        tracing::info!("[job {job_id}] {}", refresh::describe(&git_state));

        // cm:guard when the workspace is wrong the job now RUNS anyway, so this repair-then-notice pair is the only mitigation left — drop it and a stage silently judges current code against an old checkout, which is the defect refresh.rs exists for. This lane used to fail the job with `preflight_failed: workspace_refresh`; a retry cannot check out a branch, so one wrong branch on ubuntu5 (anhome, 2026-08-15) became 4 identical 7-second failures over 8h, a box quarantine and a held job.
        let mut setup_summary: Option<String> = None;
        if !findings.is_empty() {
            let outcome = setup_agent::run(
                &resolved.repo_path,
                &findings,
                git_state.base_branch.as_deref(),
                resolved.workspace_setup.as_deref(),
            )
            .await;
            tracing::info!(
                "[job {job_id}] setup agent ok={} — {}",
                outcome.ok,
                outcome.summary.lines().next().unwrap_or("")
            );
            setup_summary = Some(outcome.summary);
            // Re-measure rather than believe the summary. A setup agent that
            // broke the checkout must fail the job here, not hand a stage a tree
            // that no longer has a work tree.
            match measure(
                &resolved.repo_path,
                resolved.base_branch.as_deref(),
                owns_root,
            )
            .await
            {
                Ok((f, g)) => {
                    findings = f;
                    git_state = g;
                }
                Err(err) => {
                    let msg = format!("preflight_failed: {err}");
                    tracing::error!("[job {job_id}] after setup agent: {msg}");
                    let _ = lifecycle::fail(client, &job_id, &msg).await;
                    return Ok(());
                }
            }
        }

        // cm:guard the foreign-work branch wins over the worktree warning, and it fires whether or not this lane owns the root. Suppressing the finding without saying anything leaves a stage reading a tree it cannot explain; the point is to move the fact from a repair queue to a sentence, not to delete it.
        let root_warning = if git_state.foreign_work {
            Some(foreign_work_text(
                git_state.detail.as_deref().unwrap_or("uncommitted changes"),
            ))
        } else {
            (!owns_root && !git_state.refreshed).then(|| {
                root_warning_text(
                    &refresh::describe(&git_state),
                    git_state.base_branch.as_deref(),
                )
            })
        };
        if !findings.is_empty() || root_warning.is_some() || setup_summary.is_some() {
            workspace_notice = Some(workspace_notice_text(
                &findings,
                root_warning.as_deref(),
                setup_summary.as_deref(),
                git_state.base_branch.as_deref(),
            ));
        }
        worktree_start_point = start_point_for(&git_state);
    }

    // ISS-449 (Decision B): explicit claim ack once preflight passes.
    // Best-effort — the server falls back to treating the first job_event as
    // the ack, so an ack failure must never abort the job.
    //
    // ISS-798: read .hash markers from <repo>/.claude/skills/*/ to populate
    // skills_ran_with — the actual skill hashes this job will execute with,
    // accounting for user-level shadows already detected during sync.
    let skills_ran_with = read_skills_ran_with(&resolved.repo_path);
    if let Err(e) = lifecycle::ack(client, &job_id, skills_ran_with).await {
        tracing::warn!("[job {job_id}] ack: {e}");
    }

    // cm:guard the notice must reach the SERVER as well as the prompt. As a `failed` job this condition was impossible to miss; as a prompt line it is visible only to the agent reading it, and a stage that ran on a workspace nobody could refresh with no row anywhere is exactly the state-lies-by-omission this replaced the failure with.
    if let Some(notice) = &workspace_notice {
        let ev = [JobEventInput::new(
            "progress",
            serde_json::json!({ "workspaceNotice": notice }),
        )];
        if let Err(e) = post_job_events(client, &job_id, &ev).await {
            tracing::warn!("[job {job_id}] workspace notice event: {e}");
        }
    }

    let prompt = match (&ja.prompt_string, &workspace_notice) {
        (Some(prompt), Some(notice)) => Some(format!("{notice}\n\n{prompt}")),
        _ => ja.prompt_string.clone(),
    };

    // cm:guard salvage is offered to EVERY claimed job, and the condition it used to carry is gone on purpose. It was "only a job with an `issueKey`", because without core's `worktreeBranch` such a job ran in the root and had no branch of its own to preserve anything on. Every claim now names an agent and gets that agent's worktree, so the old test would refuse to preserve work that demonstrably exists.
    let salvage_ctx = Some(SalvageCtx {
        repo_root: resolved.repo_path.clone(),
        base_branch: resolved.base_branch.clone(),
        agent_branch: ja.agent_name.clone(),
        attempt: ja.attempts.unwrap_or(0),
    });

    let spec = JobSpec {
        job_id: job_id.clone(),
        project_id: ja.project_id.clone(),
        project_slug: Some(slug.clone()),
        issue_id: ja.issue_id.clone(),
        step: ja.job_type.clone(),
        repo_path: resolved.repo_path.clone(),
        prompt,
        system_prompt: ja.system_prompt.clone(),
        model: ja.model.clone(),
        allowed_tools: ja.allowed_tools.clone(),
        disallowed_tools: ja.disallowed_tools.clone(),
        permission_mode: ja.permission_mode.clone(),
        timeout_seconds: ja.timeout_seconds,
        mcp_servers_override: ja.mcp_servers_override.clone(),
        worktree_branch,
        worktree_start_point,
        // cm:guard OPT-IN, and the default direction is the whole safety of it: only the literal `"duplex"` flips a job, so a project that never set `pipelineConfig.sessionMode`, a core that does not send the field, and a value nobody recognises all stay print. The fleet-wide default flip is phase 5 and is bounded by a measured release, not by this line.
        duplex: ja.session_mode.as_deref() == Some("duplex"),
        counts_against_session_cap: true,
        session_residency_seconds: ja.session_residency_seconds,
        resume_id: ja.claude_session_id.clone(),
        agent_session_id: ja.agent_session_id.clone(),
        pat_token: ja.pat_token.clone(),
    };

    // cm:guard the session heartbeat loop in `consume` starts only after the process spawns, and `runner.start` can block for minutes before that — a duplex job waits on the session semaphore while parked `awaiting_input` sessions hold every permit, and `worktree::create` on a large repo is not instant. Core reaps a silent session at 3 minutes: sidpeak release job 483387d4 (2026-09-03) waited 4.5 min for a permit after ack, was killed as `session_lost` and answered the kill probe `not_found`. Beat from ack until `start` returns, or the wait is indistinguishable from a dead runner.
    let (tx, rx) = mpsc::channel::<RunnerEvent>(200);
    let started = runner.start(spec, tx).await;
    drop(pre_spawn_beat);
    // cm:guard release only for a lane that got its own worktree. `start` returning means the tree exists and the process is spawned, so this job's writes have left the root — but a stage with no `worktreeBranch` (`pm`, `interactive`) runs its whole session IN the root, and handing the root to a second job underneath it rewrites files the agent is reading.
    if !owns_root {
        drop(repo_guard);
    }
    if let Err(e) = started {
        let msg = format!("failed to start job: {e}");
        tracing::error!("[job {job_id}] {msg}");
        let _ = lifecycle::fail(client, &job_id, &msg).await;
        return Ok(());
    }

    consume(client, &job_id, rx, salvage_ctx).await;
    Ok(())
}

/// A background task that must not outlive the scope that started it.
// cm:guard this exists because the pre-spawn heartbeat now starts BEFORE the repo lock, and every `preflight_failed` path between there and `runner.start` returns early. A bare `JoinHandle` leaks a task that keeps posting `phase: pre-spawn` events for a job that already failed — which reads on the timeline as a dead job still making progress.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// What a failed job needs before its working copy can be preserved.
struct SalvageCtx {
    repo_root: PathBuf,
    base_branch: Option<String>,
    agent_branch: String,
    attempt: u32,
}

/// Drain runner events, batching job events and posting on a 500ms cadence,
/// then call complete/fail on the terminal event.
async fn consume(
    client: &CoreClient,
    job_id: &str,
    mut rx: mpsc::Receiver<RunnerEvent>,
    salvage_ctx: Option<SalvageCtx>,
) {
    let mut buf: Vec<JobEventInput> = Vec::new();
    let mut flush = tokio::time::interval(FLUSH_INTERVAL);
    flush.tick().await;

    // Independent per-job session heartbeat (ISS-285). Posts a tiny `progress`
    // event every 25s only when no real batch was posted in the window, so the
    // server keeps `lastHeartbeatAt` fresh through long silent steps (docker
    // build / E2E) without false `heartbeat_timeout`, yet active jobs emit no
    // extra rows.
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    // Skip (don't burst-catch-up) missed ticks: if a slow `post_job_events`
    // retry/backoff stalls the loop past a tick, fire once on the next tick
    // rather than back-to-back. The heartbeat only needs to land within the
    // 180s window, not recover every elapsed interval.
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    heartbeat.tick().await;
    let mut posted_since_beat = false;

    enum Terminal {
        Done(i32),
        Failed(String),
        /// Core says this job is not this box's any more.
        Disowned(String),
    }
    let mut terminal: Option<Terminal> = None;

    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Some(RunnerEvent::Done { exit_code }) => { terminal = Some(Terminal::Done(exit_code)); break; }
                Some(RunnerEvent::Failed { error, .. }) => { terminal = Some(Terminal::Failed(error)); break; }
                Some(ev) => { if let Some(e) = map_event(ev) { buf.push(e); } }
                None => break,
            },
            _ = flush.tick() => {
                if !buf.is_empty() {
                    let batch = std::mem::take(&mut buf);
                    match post_job_events(client, job_id, &batch).await {
                        Ok(_) => posted_since_beat = true,
                        // cm:guard STOP on a disowned job, never keep posting. Every later batch answers the same way, and the loop that only logged turned that into 2 requests a second forever — measured on epodsystem 2026-09-05, two jobs whose stamp had been unwound underneath them. There is nothing to salvage-and-report either: the report itself is a call to a route that 403s.
                        Err(e) if events::is_disowned(&e) => {
                            terminal = Some(Terminal::Disowned(e.to_string()));
                            break;
                        }
                        Err(e) => tracing::warn!("[job {job_id}] post events: {e}"),
                    }
                }
            }
            _ = heartbeat.tick() => {
                if !posted_since_beat {
                    let beat = [JobEventInput::new("progress", serde_json::json!({ "heartbeat": true }))];
                    match post_job_events(client, job_id, &beat).await {
                        Ok(_) => {}
                        Err(e) if events::is_disowned(&e) => {
                            terminal = Some(Terminal::Disowned(e.to_string()));
                            break;
                        }
                        Err(e) => tracing::debug!("[job {job_id}] heartbeat: {e}"),
                    }
                }
                posted_since_beat = false;
            }
        }
    }

    if !buf.is_empty() && !matches!(terminal, Some(Terminal::Disowned(_))) {
        if let Err(e) = post_job_events(client, job_id, &buf).await {
            tracing::warn!("[job {job_id}] final post events: {e}");
        }
    }

    match terminal {
        Some(Terminal::Done(code)) => {
            if let Err(e) = lifecycle::complete(client, job_id, code, None).await {
                tracing::warn!("[job {job_id}] complete: {e}");
            } else {
                tracing::info!("[job {job_id}] done");
            }
        }
        Some(Terminal::Failed(err)) => {
            let salvage = salvage_for(salvage_ctx.as_ref(), job_id, &err).await;
            if let Err(e) = lifecycle::fail_with_salvage(client, job_id, &err, salvage).await {
                tracing::warn!("[job {job_id}] fail: {e}");
            } else {
                tracing::info!("[job {job_id}] failed: {err}");
            }
        }
        // cm:guard say it at ERROR and say what it means, because this is the one outcome the box cannot repair. The agent process is still running and is left to exit on its own — it is a one-shot child, not a resident session `close` can reach — so its slot reads free while a claude is still on the box. That is a bounded inaccuracy and it is strictly better than what it replaces: a slot held forever behind an endless 403 loop. No CODE on this box can kill it: the daemon spawns the job and drops the child, and the master claims through the daemon and never sees the process. The lever that exists is a person or the master doing it by hand — `forge-master` SKILL.md documents finding the agent by the worktree in its `/proc/<pid>/cwd` — which is why this line says what it means rather than pointing at a command. Closing it properly means keeping the child handle in the in-flight map; nothing does that yet.
        Some(Terminal::Disowned(why)) => {
            tracing::error!(
                "[job {job_id}] core no longer routes this job to this box ({why}) — abandoning it; the agent process is left to exit on its own"
            );
        }
        None => {
            // cm:guard this arm salvages too, and it is the one that matters most: a runner that dies mid-stream leaves the LARGEST uncommitted diff, having neither committed nor reported. Skipping it because the error string is generic loses exactly the work worth keeping.
            let err = "runner ended without a result";
            let salvage = salvage_for(salvage_ctx.as_ref(), job_id, err).await;
            let _ = lifecycle::fail_with_salvage(client, job_id, err, salvage).await;
        }
    }
}

/// Preserve the failed job's working copy, best-effort. Never propagates a
/// failure of its own: `lifecycle::fail` must run whatever happened here.
async fn salvage_for(
    ctx: Option<&SalvageCtx>,
    job_id: &str,
    err: &str,
) -> Option<serde_json::Value> {
    let ctx = ctx?;
    let s = salvage::salvage_wip(salvage::SalvageInput {
        repo_root: &ctx.repo_root,
        base_branch: ctx.base_branch.as_deref(),
        agent_branch: &ctx.agent_branch,
        job_id,
        attempt: ctx.attempt,
        failure: err,
    })
    .await;
    tracing::info!("[job {job_id}] salvage: {s:?}");
    Some(s.to_json())
}

fn map_event(ev: RunnerEvent) -> Option<JobEventInput> {
    match ev {
        // cm:edge lockstep -> packages/core/src/jobs/events-routes.ts — core reads `data.runtimeState` to decide whether the batch counts as a heartbeat, and a park must NOT. Renaming this key silently turns every park on the pipeline path back into activity, which is the exact rule phase 2 wrote into agent-sessions/routes.ts.
        // cm:guard the session's runtime state is reported over PATCH /agent-sessions (transport/agent_sessions.rs) and that PATCH is the authority — this row is the job TIMELINE copy. Dropping it is how an operator reading job events sees an unexplained gap where the session was parked on a human.
        RunnerEvent::StateChanged(state) => Some(JobEventInput::new(
            "progress",
            serde_json::json!({ "runtimeState": state }),
        )),
        RunnerEvent::Stdout(json) => Some(JobEventInput::new(
            "stdout",
            serde_json::json!({ "line": json }),
        )),
        RunnerEvent::Tool { name, phase } => {
            let kind = match phase {
                ToolPhase::Call => "tool_call",
                ToolPhase::Result => "tool_result",
            };
            Some(JobEventInput::new(
                kind,
                serde_json::json!({ "name": name }),
            ))
        }
        RunnerEvent::Usage {
            input,
            output,
            cache_read,
            cache_write,
        } => Some(JobEventInput::new(
            "progress",
            serde_json::json!({ "usage": {
                "input": input, "output": output,
                "cacheRead": cache_read, "cacheWrite": cache_write
            }}),
        )),
        RunnerEvent::ClaudeSessionId(sid) => Some(JobEventInput::new(
            "progress",
            serde_json::json!({ "claudeSessionId": sid }),
        )),
        RunnerEvent::Done { .. } | RunnerEvent::Failed { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Binding;

    fn frame(session_mode: Option<&str>) -> ClaimedJob {
        let prepared: crate::transport::pool::Prepared =
            serde_json::from_value(serde_json::json!({
                "jobId": "j1", "projectId": "p1", "type": "code",
                "sessionMode": session_mode,
            }))
            .expect("a preparation must parse");
        prepared.into_claimed(None, None, "test-agent".into())
    }

    fn unrefreshed(foreign_work: bool) -> refresh::WorkspaceGit {
        refresh::WorkspaceGit {
            head_sha: Some("aaaaaaaa".into()),
            base_branch: Some("main".into()),
            base_sha: Some("bbbbbbbb".into()),
            refreshed: false,
            detail: Some(
                "tree has uncommitted changes outside the Forge-owned paths (a.ts) — left alone"
                    .into(),
            ),
            foreign_work,
        }
    }

    // cm:guard this is the assertion that keeps the setup agent off a tree someone is using. A finding is what runs that agent, and its rules permit `git stash push -u -m forge-setup` on whatever blocks it. Delete the `!git.foreign_work` term and this goes red.
    #[test]
    fn someone_elses_uncommitted_work_is_never_handed_to_the_repair_agent() {
        for owns_root in [true, false] {
            assert!(
                !refresh_is_repairable(&unrefreshed(true), owns_root),
                "owns_root={owns_root}: a tree holding foreign work must not become a finding"
            );
        }
    }

    #[test]
    fn an_ordinary_stale_root_is_still_repairable_when_this_lane_owns_it() {
        assert!(
            refresh_is_repairable(&unrefreshed(false), true),
            "suppressing every unrefreshed root would leave a stale checkout unrepaired — the defect refresh.rs exists for"
        );
        assert!(
            !refresh_is_repairable(&unrefreshed(false), false),
            "a lane that does not own the root never had this finding"
        );
    }

    #[test]
    fn the_notice_forbids_every_verb_that_would_clear_the_tree() {
        let text = foreign_work_text("(a.ts) — left alone");
        for verb in ["git stash", "git checkout --", "git reset", "git clean"] {
            assert!(
                text.contains(verb),
                "the notice must name `{verb}` as forbidden"
            );
        }
        assert!(
            text.contains("stop and say so"),
            "the alternative to clearing must be stated"
        );
    }

    // cm:guard opt-in, and the DEFAULT direction is the safety. A core that does not send the field, a project that never set it, and a value nobody recognises must all stay print — the fleet-wide flip is phase 5 and is bounded by a measured release.
    #[test]
    fn only_the_literal_duplex_opts_a_job_in() {
        assert!(frame(Some("duplex")).session_mode.as_deref() == Some("duplex"));
        for m in [None, Some("print"), Some("Duplex"), Some("stream-json")] {
            assert!(
                frame(m).session_mode.as_deref() != Some("duplex"),
                "{m:?} must not flip a job to duplex"
            );
        }
    }

    // cm:guard a frame carrying a mode this runner has never heard of must still PARSE — deserialising into an enum would make every job undeliverable to a runner that predates a new mode, which is a fleet outage caused by a field it did not need.
    #[test]
    fn an_unknown_mode_still_parses_the_frame() {
        assert_eq!(frame(Some("telepathy")).job_id, "j1");
    }

    // cm:guard the KEY is the contract, not the presence of a row — core reads `data.runtimeState` by that exact name to decide the batch is not a heartbeat (`jobs/events-routes.ts`). Asserting only that map_event returned Some would pass a rename that silently makes every park count as activity.
    #[test]
    fn state_change_becomes_a_progress_row_carrying_the_state() {
        let ev = map_event(RunnerEvent::StateChanged("awaiting_input"))
            .expect("a state change must reach core, not be dropped");
        assert_eq!(ev.kind, "progress");
        assert_eq!(ev.data["runtimeState"], "awaiting_input");
    }

    #[test]
    fn every_declared_state_survives_the_mapping() {
        for state in [
            "starting",
            "working",
            "awaiting_input",
            "checkpointing",
            "closed",
        ] {
            let ev = map_event(RunnerEvent::StateChanged(state)).expect(state);
            assert_eq!(ev.data["runtimeState"], state);
        }
    }

    // cm:guard the two terminal events stay UNMAPPED. `consume` breaks its loop on them and calls lifecycle::complete/fail; a row here as well would post an event for a job core has already finalized, which is a 409 on a terminal job.
    #[test]
    fn terminal_events_are_not_job_event_rows() {
        assert!(map_event(RunnerEvent::Done { exit_code: 0 }).is_none());
        assert!(map_event(RunnerEvent::Failed {
            error: "x".into(),
            kind: crate::runner::FailureKind::Transient
        })
        .is_none());
    }

    fn me(project_id: &str, slug: &str, repo_path: Option<&str>) -> MeRunner {
        MeRunner {
            project_id: project_id.into(),
            runner_id: "run-1".into(),
            slug: slug.into(),
            base_branch: Some("main".into()),
            repo_path: repo_path.map(str::to_string),
            branch: None,
            status: "online".into(),
            kind: Some("standard".into()),
            workspace_setup: None,
            rate_limited_for_seconds: None,
            limit_reason: None,
        }
    }

    fn cfg_with_binding(slug: &str, project_id: Option<&str>, repo_path: &str) -> Config {
        let mut cfg = Config::default();
        cfg.bindings.insert(
            slug.into(),
            Binding {
                repo_path: PathBuf::from(repo_path),
                branch: None,
                project_id: project_id.map(str::to_string),
            },
        );
        cfg
    }

    #[test]
    fn prefers_server_path_over_config() {
        let server = vec![me("p-1", "app", Some("/srv/app"))];
        let cfg = cfg_with_binding("app", Some("p-1"), "/local/app");
        let r = resolve_repo(&server, &cfg, "p-1").expect("resolves");
        assert_eq!(r.repo_path, PathBuf::from("/srv/app"));
        assert_eq!(r.slug, "app");
    }

    #[test]
    fn falls_back_to_config_when_server_path_empty() {
        let server = vec![me("p-1", "app", Some("   "))];
        let cfg = cfg_with_binding("app", Some("p-1"), "/local/app");
        let r = resolve_repo(&server, &cfg, "p-1").expect("resolves");
        assert_eq!(r.repo_path, PathBuf::from("/local/app"));
    }

    #[test]
    fn falls_back_to_config_when_not_on_server() {
        let server = vec![];
        let cfg = cfg_with_binding("app", Some("p-1"), "/local/app");
        let r = resolve_repo(&server, &cfg, "p-1").expect("resolves");
        assert_eq!(r.repo_path, PathBuf::from("/local/app"));
    }

    #[test]
    fn errs_with_slug_when_no_path_anywhere() {
        let server = vec![me("p-1", "app", None)];
        let cfg = Config::default();
        let err = resolve_repo(&server, &cfg, "p-1").unwrap_err();
        assert_eq!(err, "app");
    }

    #[test]
    fn preflight_skipped_for_reconcile_and_verify_skill() {
        assert!(!requires_preflight("reconcile", Some("standard")));
        assert!(!requires_preflight("verify_skill", Some("standard")));
    }

    /// A `website` project has no git repo by design, so no job type preflights.
    #[test]
    fn preflight_skipped_for_every_job_type_on_a_website_project() {
        for job_type in ["triage", "plan", "code", "fix", "review", "release"] {
            assert!(
                !requires_preflight(job_type, Some("website")),
                "{job_type} must not preflight on a storefront"
            );
        }
    }

    /// An absent or unknown kind must FAIL CLOSED — a dropped field can never
    /// cost a normal project its git checks.
    #[test]
    fn preflight_required_when_the_kind_is_missing_or_unknown() {
        assert!(requires_preflight("code", None));
        assert!(requires_preflight("code", Some("")));
        assert!(requires_preflight("code", Some("Website")));
        assert!(requires_preflight("code", Some("something-new")));
    }

    #[test]
    fn preflight_required_for_pipeline_job_types() {
        for job_type in ["triage", "plan", "code", "fix", "review"] {
            assert!(
                requires_preflight(job_type, Some("standard")),
                "{job_type} should preflight"
            );
        }
    }

    /// The anhome regression: root on `main` while the base is `release/stg`.
    /// The refresh is refused, the job runs anyway, and the ISS-* branch must
    /// still be cut from the base — not from whatever the root sits on.
    #[test]
    fn start_point_is_the_base_even_when_the_refresh_was_refused() {
        let state = refresh::WorkspaceGit {
            head_sha: Some("deadbeef".into()),
            base_branch: Some("release/stg".into()),
            base_sha: Some("cafe1234".into()),
            refreshed: false,
            detail: Some("checked out main , not the base branch release/stg — left alone".into()),
            foreign_work: false,
        };
        assert_eq!(
            start_point_for(&state).as_deref(),
            Some("origin/release/stg")
        );
    }

    /// No `base_sha` means the fetch never landed, so `origin/<base>` may not
    /// exist locally — naming it would fail the worktree instead of creating it.
    #[test]
    fn no_start_point_when_the_base_ref_did_not_resolve() {
        let state = refresh::WorkspaceGit {
            base_branch: Some("release/stg".into()),
            detail: Some("fetch timed out after 20s".into()),
            ..Default::default()
        };
        assert_eq!(start_point_for(&state), None);
    }

    #[test]
    fn the_notice_tells_the_stage_to_check_the_base_branch_out() {
        let text = workspace_notice_text(
            &["workspace NOT refreshed (checked out main , not the base branch release/stg — left alone): HEAD dead, origin/release/stg cafe".into()],
            None,
            None,
            Some("release/stg"),
        );
        assert!(
            text.contains("checked out main"),
            "keeps the observed state"
        );
        assert!(
            text.contains("`release/stg`"),
            "names the branch to move to"
        );
        assert!(
            text.contains("check the remote before any such claim"),
            "still forbids claiming what is on the base from local files"
        );
    }

    /// With no base resolvable there is nothing to name, but the ban on
    /// claiming base-branch content from local files must survive.
    #[test]
    fn the_notice_still_bans_base_branch_claims_with_no_base() {
        let text = workspace_notice_text(
            &["workspace NOT refreshed (detached HEAD)".into()],
            None,
            None,
            None,
        );
        assert!(text.contains("check the remote before any such claim"));
    }

    /// The setup agent ran and cleared everything: the stage is told what
    /// happened to its workspace but given nothing to do about it. Silence here
    /// would be the state-lies-by-omission this whole path replaced a failure
    /// with — a tree someone else changed, and no record the stage ever saw it.
    #[test]
    fn a_repaired_workspace_reports_the_repair_and_asks_for_nothing() {
        let text = workspace_notice_text(
            &[],
            None,
            Some("ran pnpm install; hooks restored"),
            Some("main"),
        );
        assert!(text.contains("ran pnpm install"));
        assert!(!text.contains("yours to deal with"));
    }

    /// A worktree lane must be told the root is stale and told NOT to fix it —
    /// its own tree was cut from `origin/<base>` and is already correct, so a
    /// stage that "helpfully" fast-forwards the root is doing unrelated work on
    /// a branch another job may be using.
    #[test]
    fn a_worktree_lane_is_warned_off_the_root_instead_of_asked_to_fix_it() {
        let warning = root_warning_text("workspace NOT refreshed (dirty tree)", Some("develop"));
        let text = workspace_notice_text(&[], Some(&warning), None, Some("develop"));
        assert!(text.contains("do not try to fix it"));
        assert!(!text.contains("yours to do"));
    }

    /// The two faults a re-clone can fix, and the two it cannot.
    #[test]
    fn only_a_missing_folder_or_a_non_checkout_is_worth_reprovisioning() {
        assert!(is_reprovisionable(
            "repo_path: not a directory: /home/forge/projects/anhome"
        ));
        assert!(is_reprovisionable("work_tree: fatal: not a git repository"));
        assert!(!is_reprovisionable(
            "origin_remote: no 'origin' remote configured"
        ));
        assert!(!is_reprovisionable(
            "push_credentials: ls-remote timed out after 20s"
        ));
    }
}
