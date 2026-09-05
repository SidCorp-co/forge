//! What starts work now that nothing pushes it.
//!
//! Core keeps jobs `queued` and offers them; this loop is the only thing on the
//! box that notices. It asks core which projects this device serves, reads each
//! one's pool, and where a project has claimable work and no master of its own
//! it starts one — a Claude session running the `forge-master` skill, which
//! decides order and batch size and claims through the control socket.
//!
//! The daemon deliberately makes NO routing decision here. It answers one
//! question per project, "is there anything at all", and hands the rest to
//! judgement.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::config::Config;
use crate::daemon::dispatch::resolve_repo;
use crate::runner::process::build_command;
use crate::transport::{pool, runners, CoreClient};

/// How often the box asks whether any work exists.
// cm:why this interval IS the latency from an issue opening to an agent touching it, and it is the whole budget: nothing pushes any more, so a job queued one tick after a poll waits a full interval before anything looks. 30s was chosen against the old push path's measured dispatch lag on epodsystem (queue→dispatch of 17m, 23m, 46m and 2h08 on 2026-09-04) — an order of magnitude of headroom, at one cheap request per project per half minute.
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// The outer bound on one pass. Only a hung pass should ever meet it.
// cm:guard sized so a WORKING pass never reaches it, because the master's judgement is the entire value of this design and a kill truncates it mid-decision. Measured on dev1 2026-09-05 against the previous 150s: passes weighing 1-2 jobs took 30-88s and finished, passes weighing 3-4 took 75-112s, and three consecutive passes at 3-4 jobs hit 150s and were killed — the ceiling was selecting against exactly the passes with the most to decide. This is a hang-breaker, not a time-box; if a pass is genuinely taking ten minutes the fault is worth seeing rather than hiding behind a kill.
// cm:guard what this must NOT go back to claiming is that core reclaims anything when it fires: since `fd1265751` a claim ends its own hold in the statement that stamps, so a killed master leaves nothing behind to reclaim — the jobs it started keep running and report for themselves.
const MASTER_MAX_RUNTIME: Duration = Duration::from_secs(600);

/// The prompt that starts a pass. Deliberately thin: the skill is the process.
// cm:guard name the skill and STOP. Restating its rules here creates a second copy of the master's process, and the copies drift in silence because nothing compares them — the skill file is where a reader looks and this string is what a master is actually told. The two ship together (see the include_str edge below), so there is no version where inlining the rules here is even the safer half.
fn pass_prompt(project: &str, base_branch: Option<&str>, issue_keys: &[String]) -> String {
    let mut out = format!(
        "Use the `forge-master` skill. You are the master for project `{project}` on this box: \
read the pool, decide what runs and how much, claim through `forge-runner pool claim`, and end \
the pass by releasing anything you claimed but did not start.\n"
    );
    if let Some(base) = base_branch {
        out.push_str(&format!(
            "\nYou are standing in this project's checkout, on its base branch `{base}`. Every \
agent you start works in a worktree cut from `origin/{base}`, never in this tree.\n"
        ));
    }
    out.push_str("\nIssues with claimable work right now:\n");
    for id in issue_keys {
        out.push_str("- ");
        out.push_str(id);
        out.push('\n');
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
        "\nTake the time you need to decide, then stop. Claim what you are confident about, \
report, and let the next pass take the rest.\n",
    );
    out
}

/// Which projects have a master alive right now.
// cm:guard one master per PROJECT, and the key is the project id rather than the box. Two masters on one project read the same pool and both claim: core's L1 refuses the second for the same ISSUE, but two jobs on two issues sharing that project's checkout would both start and collide on the same tree, which the repo lock then serialises into a stall neither master understands. Two masters on DIFFERENT projects are fine and are the point — they share no tree.
// cm:guard this bounds masters and NOTHING ELSE. `duplex_max_sessions` (default 3) is the box's only process ceiling and it covers duplex PIPELINE jobs alone — a master takes no permit, and neither does a one-shot job. Adding a project therefore adds a claude process with nothing counting it; measured on dev1 2026-09-05 at load 17.26 on 12 cores with CPU pressure some=52%. A box-level bound is owed and is not this map.
#[derive(Default)]
pub struct MasterGate(Arc<Mutex<HashSet<String>>>);

impl MasterGate {
    pub fn new() -> Self {
        Self::default()
    }

    fn try_enter(&self, project_id: &str) -> Option<MasterRun> {
        let mut live = self.0.lock().expect("master gate poisoned");
        if !live.insert(project_id.to_string()) {
            return None;
        }
        Some(MasterRun {
            gate: self.0.clone(),
            project_id: project_id.to_string(),
        })
    }
}

struct MasterRun {
    gate: Arc<Mutex<HashSet<String>>>,
    project_id: String,
}

impl Drop for MasterRun {
    fn drop(&mut self) {
        if let Ok(mut live) = self.gate.lock() {
            live.remove(&self.project_id);
        }
    }
}

/// Poll every served project until `cancel` flips, starting masters as needed.
pub async fn run(
    client: CoreClient,
    cfg: Config,
    gate: Arc<MasterGate>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) {
    let mut tick = tokio::time::interval(POLL_INTERVAL);
    loop {
        tokio::select! {
            _ = tick.tick() => sweep(&client, &cfg, &gate).await,
            _ = cancel.changed() => { if *cancel.borrow() { break; } }
        }
    }
}

/// One look at every project this device serves.
// cm:guard the project list comes from `/me/runners`, NEVER from `config.toml` bindings. Core is the source of truth for what a device serves and for where the checkout lives (`resolve_repo` reads the local binding only as a fallback), and the two disagree in practice: dev1 serves epodsystem-core with no local binding for it at all, so a sweep driven by the config file would leave that project's pool unread forever with nothing reporting why.
async fn sweep(client: &CoreClient, cfg: &Config, gate: &Arc<MasterGate>) {
    let served = match runners::list_me(client).await {
        Ok(rs) => rs,
        Err(e) => {
            tracing::warn!("[master] cannot read this box's projects: {e}");
            return;
        }
    };

    for runner in &served {
        let project_id = runner.project_id.clone();
        let Some(run) = gate.try_enter(&project_id) else {
            continue;
        };

        let items = match pool::pool(client, 20, Some(&project_id)).await {
            Ok(items) => items,
            Err(e) => {
                tracing::warn!("[master] pool unreadable for {}: {e}", runner.slug);
                continue;
            }
        };
        if items.is_empty() {
            continue;
        }

        let resolved = match resolve_repo(&served, cfg, &project_id) {
            Ok(r) => r,
            Err(slug) => {
                // cm:guard refuse by NAME rather than falling back to some other directory. A master started in the wrong tree reads one repo and claims work for another, and every diff it produces lands where nobody looks — the silent substitution this repo forbids, and unrecoverable by the time anyone notices.
                tracing::error!(
                    "[master] {slug} has claimable work but no repo path on this box — no master will run for it; bind it or set the runner's repo_path"
                );
                continue;
            }
        };

        // cm:guard list what the master can NAME back to core, not the internal ids — a pool entry carries `issueKey` and no projectId, and an entry with neither still counts. Dropping the keyless ones from the count would tell a master the pool is emptier than it is.
        let mut keys: Vec<String> = items.iter().filter_map(|i| i.issue_key.clone()).collect();
        keys.sort();
        keys.dedup();

        let prompt = pass_prompt(&resolved.slug, resolved.base_branch.as_deref(), &keys);
        let cwd = resolved.repo_path.clone();
        let slug = resolved.slug.clone();
        tracing::info!(
            "[master] {slug}: {} job(s) claimable — starting a pass in {}",
            items.len(),
            cwd.display()
        );
        tokio::spawn(async move {
            let _run = run;
            spawn_master(&prompt, &cwd, &slug).await;
        });
    }
}

/// The master's own process, versioned with this binary.
// cm:guard the skill text ships INSIDE the runner and is written to the project checkout before every pass. Nothing else delivers it — `skill_sync` seeds only what a project's manifest lists — and a master told to "use the forge-master skill" with nothing on disk loads nothing and improvises the one process this design depends on, silently. It SURVIVES `skill_sync`'s converge-on-delete only because `find_prunable` skips a directory with no `.hash` marker and this writes none; seed it through `write_skill_tree` and the next sync deletes it as an unmanifested skill. The price of embedding is real and is the trade: editing the master's process now needs a runner release, where a project skill needs only a push.
// cm:edge lockstep -> .claude/skills/forge-master/SKILL.md — that file is SOURCE for this binary, not local config: it is un-ignored in .gitignore for this one path and is named in ci.yml's `runner` path filter, because a skill-only PR that skipped the runner job would ship an unbuilt master through a green `ci-passed`.
const MASTER_SKILL: &str = include_str!("../../../../../../.claude/skills/forge-master/SKILL.md");

/// Write the skill where the pass about to start will look for it.
fn install_skill(repo: &std::path::Path) -> std::io::Result<()> {
    let dir = repo.join(".claude/skills/forge-master");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("SKILL.md"), MASTER_SKILL)
}

/// Where a project's master keeps what only it can say.
// cm:guard per PROJECT, never one file for the box. Masters on two projects run at the same time by design, and a single log would interleave two passes into a transcript that reads as one confused master.
fn pass_log_path(slug: &str) -> Option<std::path::PathBuf> {
    let dir = Config::path().ok()?.with_file_name("master").join(slug);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("last-pass.log"))
}

/// The one place a master's own account of a pass survives.
// cm:guard a master writes NO `agent_sessions` row — it invents its own session id and core has no record of it — so discarding its stdout leaves the whole judgement layer unobservable: measured 2026-09-05, five consecutive passes claimed 1-2 jobs each and then spent 135s doing something nobody could name, and the only honest answer to "is it stuck or thinking" was that the evidence had been thrown away. Truncated per pass rather than appended: the question is always about the pass that just ran.
fn pass_log(slug: &str) -> std::process::Stdio {
    match pass_log_path(slug).and_then(|p| std::fs::File::create(p).ok()) {
        Some(f) => std::process::Stdio::from(f),
        None => std::process::Stdio::null(),
    }
}

async fn spawn_master(prompt: &str, cwd: &std::path::Path, slug: &str) {
    // cm:guard refuse the pass when the skill cannot be written, rather than spawning without it. A master with no skill still starts, still claims, and runs the whole orchestration off a four-line prompt — work that looks like it is being managed and is not.
    if let Err(e) = install_skill(cwd) {
        tracing::error!(
            "[master] {slug}: could not install the forge-master skill into {}: {e} — skipping this pass",
            cwd.display()
        );
        return;
    }

    let args: Vec<String> = vec![
        "--permission-mode".into(),
        "bypassPermissions".into(),
        "-p".into(),
        prompt.to_string(),
    ];
    let mut child = match build_command(&args, &cwd.to_string_lossy())
        .stdout(pass_log(slug))
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("[master] {slug}: could not start: {e}");
            return;
        }
    };
    // cm:guard kill an overrunning pass rather than waiting it out, and this must never be an unbounded wait — that is the shape that wedged sidpeak job 483387d4 for 4.5 minutes into `session_lost`. The jobs it already started are NOT affected: they hold no hold to lose and report to core for themselves.
    match tokio::time::timeout(MASTER_MAX_RUNTIME, child.wait()).await {
        Ok(Ok(status)) => tracing::info!("[master] {slug}: pass ended ({status})"),
        Ok(Err(e)) => tracing::warn!("[master] {slug}: pass failed: {e}"),
        Err(_) => {
            tracing::warn!(
                "[master] {slug}: pass exceeded {}s and was killed — anything it already started keeps running",
                MASTER_MAX_RUNTIME.as_secs()
            );
            crate::runner::process::graceful_kill(&mut child).await;
        }
    }
    if let Some(p) = pass_log_path(slug) {
        tracing::info!("[master] {slug}: pass transcript: {}", p.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pass_ends_before_the_poll_that_would_start_the_next_one_is_useful() {
        assert!(
            POLL_INTERVAL < MASTER_MAX_RUNTIME,
            "polling slower than a pass lasts leaves the box idle between passes"
        );
    }

    // cm:guard the gate is per PROJECT, and the second assertion is the whole test: a gate that merely blocked a second entry would pass with a box-wide flag, and every project after the first would then go unserved for as long as any one master ran.
    #[test]
    fn one_master_per_project_and_projects_do_not_block_each_other() {
        let gate = MasterGate::new();
        let first = gate.try_enter("p1").expect("the first pass must start");
        assert!(
            gate.try_enter("p1").is_none(),
            "a second master must not start for a project that already has one"
        );
        let other = gate.try_enter("p2");
        assert!(
            other.is_some(),
            "another project must not wait behind an unrelated master"
        );
        drop(first);
        assert!(
            gate.try_enter("p1").is_some(),
            "the gate must reopen for a project once its pass ends"
        );
        drop(other);
    }

    // cm:guard the skill dir must contain SKILL.md and NOTHING ELSE, because `skill_sync::find_prunable` deletes any directory under `.claude/skills/` that carries a `.hash` marker and is not in the project's manifest. `forge-master` is in no manifest — it ships in this binary — so the absence of that marker is the only thing keeping the next skill sync from removing the master's own process. A future edit that seeds it through `write_skill_tree` for tidiness would break masters on the first sync, silently and on every project at once.
    #[test]
    fn the_installed_skill_carries_no_hash_marker_for_a_sync_to_prune_on() {
        let dir = std::env::temp_dir().join(format!("forge-master-skill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp repo");
        install_skill(&dir).expect("the skill must install");

        let skill_dir = dir.join(".claude/skills/forge-master");
        let names: Vec<String> = std::fs::read_dir(&skill_dir)
            .expect("skill dir")
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        assert_eq!(names, vec!["SKILL.md".to_string()], "{names:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // cm:guard the embedded copy must carry the skill's actual process, not merely be non-empty — an `include_str!` that silently picked up a stub would leave every master improvising, which is the failure this whole path exists to prevent.
    #[test]
    fn the_embedded_skill_is_the_real_one() {
        assert!(MASTER_SKILL.contains("name: forge-master"));
        assert!(MASTER_SKILL.contains("forge-runner pool claim"));
        assert!(MASTER_SKILL.contains("Release anything you claimed and did not start"));
        // cm:guard the skill must still tell a master that ending a pass costs the work nothing. Without it a master reads its own time-box as a threat to the jobs it started and hoards the pass, which is the behaviour `fd1265751` made unnecessary and this file's prompt no longer warns about.
        assert!(MASTER_SKILL.contains("parks nothing"));
    }

    // cm:guard the prompt names the skill and does not restate it. A test that only checked for non-empty prose would pass a prompt that inlined the whole process, which is the drift this guards.
    #[test]
    fn the_prompt_points_at_the_skill_rather_than_repeating_it() {
        let p = pass_prompt("forge-dev", Some("main"), &["ISS-901".into()]);
        assert!(p.contains("forge-master"));
        assert!(p.contains("ISS-901"));
        assert!(p.contains("releasing"));
    }

    // cm:guard a master must be told which project it is and which branch its agents cut from, because it stands in a checkout that looks identical whatever project it belongs to. Without the base branch a master has to guess a start point, and `worktree::create` documents what guessing costs: a branch cut from whatever the tree happened to sit on, anhome 2026-08-15.
    #[test]
    fn the_prompt_names_the_project_and_its_base_branch() {
        let p = pass_prompt("epodsystem-core", Some("develop"), &[]);
        assert!(p.contains("epodsystem-core"));
        assert!(p.contains("origin/develop"));
    }

    #[test]
    fn a_project_with_no_base_branch_still_gets_a_usable_prompt() {
        let p = pass_prompt("some-site", None, &["ISS-1".into()]);
        assert!(p.contains("some-site"));
        assert!(!p.contains("origin/"));
    }
}
