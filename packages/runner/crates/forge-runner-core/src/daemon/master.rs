//! What starts work now that nothing pushes it.
//!
//! Core keeps jobs `queued` and offers them; this loop is the only thing on the
//! box that notices. When the pool is not empty it spawns a master — one Claude
//! session running the `forge-master` skill — which reads the pool, decides
//! order and batch size, and claims through the control socket.
//!
//! The daemon deliberately makes NO routing decision here. It answers one
//! question, "is there anything at all", and hands the rest to judgement.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::config::Config;
use crate::runner::process::build_command;
use crate::transport::{pool, CoreClient};

/// How often the box asks whether any work exists.
// cm:why this interval IS the latency from an issue opening to an agent touching it, and it is the whole budget: nothing pushes any more, so a job queued one tick after a poll waits a full interval before anything looks. 30s was chosen against the old push path's measured dispatch lag on epodsystem (queue→dispatch of 17m, 23m, 46m and 2h08 on 2026-09-04) — an order of magnitude of headroom, at one cheap request per box per half minute.
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// A master that stops writing is a master that has died with holds.
// cm:guard this MUST stay under core's `MASTER_HOLD_TIMEOUT_MS` (3 min), which reaps a hold whose master went quiet. A master allowed to run longer than core waits gets its claims taken back underneath it, and then claims them again next pass — an issue that ping-pongs instead of progressing.
const MASTER_MAX_RUNTIME: Duration = Duration::from_secs(150);

/// The prompt that starts a pass. Deliberately thin: the skill is the process.
// cm:guard name the skill and STOP. Restating its rules here creates a second copy of the master's process that drifts from `.claude/skills/forge-master/SKILL.md` in silence, and the skill is the half that ships independently of this binary.
fn pass_prompt(issue_keys: &[String]) -> String {
    let mut out = String::from(
        "Use the `forge-master` skill. You are the master for this box: read the pool, decide what \
runs and how much, claim through `forge-runner pool claim`, and end the pass by releasing \
anything you claimed but did not start.\n\nIssues with claimable work right now:\n",
    );
    for id in issue_keys {
        out.push_str("- ");
        out.push_str(id);
        out.push('\n');
    }
    out.push_str(
        "\nThis pass is time-boxed. Finish inside two minutes: claim what you are confident \
about, report, and let the next pass take the rest.\n",
    );
    out
}

/// True while a master process is alive, so a slow pass is never doubled.
// cm:guard one master per box at a time. Two masters read the same pool and both claim: core's L1 refuses the second for the same ISSUE, but two jobs on two issues sharing a repo would both start and collide on the same checkout, which the repo lock then serialises into a stall neither master understands.
pub struct MasterGate(Arc<AtomicBool>);

impl MasterGate {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    fn try_enter(&self) -> Option<MasterRun> {
        if self.0.swap(true, Ordering::AcqRel) {
            return None;
        }
        Some(MasterRun(self.0.clone()))
    }
}

impl Default for MasterGate {
    fn default() -> Self {
        Self::new()
    }
}

struct MasterRun(Arc<AtomicBool>);

impl Drop for MasterRun {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Poll the pool until `cancel` flips, spawning a master whenever work exists.
pub async fn run(
    client: CoreClient,
    cfg: Config,
    gate: Arc<MasterGate>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) {
    let mut tick = tokio::time::interval(POLL_INTERVAL);
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if let Some(run) = gate.try_enter() {
                    let (client, cfg) = (client.clone(), cfg.clone());
                    tokio::spawn(async move {
                        let _run = run;
                        one_pass(&client, &cfg).await;
                    });
                }
            }
            _ = cancel.changed() => { if *cancel.borrow() { break; } }
        }
    }
}

async fn one_pass(client: &CoreClient, _cfg: &Config) {
    let items = match pool::pool(client, 20, None).await {
        Ok(items) => items,
        Err(e) => {
            tracing::warn!("[master] pool unreadable: {e}");
            return;
        }
    };
    if items.is_empty() {
        return;
    }

    // cm:guard list what the master can NAME back to core, not the internal ids — a pool entry carries `issueKey` and no projectId, and an entry with neither still counts. Dropping the keyless ones from the count would tell a master the pool is emptier than it is.
    let mut keys: Vec<String> = items.iter().filter_map(|i| i.issue_key.clone()).collect();
    keys.sort();
    keys.dedup();
    tracing::info!(
        "[master] {} job(s) claimable — starting a pass",
        items.len()
    );

    let Some(home) = master_home() else {
        tracing::error!("[master] cannot resolve a home for the master — no pass will run");
        return;
    };
    // cm:guard refuse the pass when the skill cannot be written, rather than spawning without it. A master with no skill still starts, still claims, and runs the whole orchestration off a four-line prompt — work that looks like it is being managed and is not.
    if let Err(e) = install_skill(&home) {
        tracing::error!(
            "[master] could not install the forge-master skill into {}: {e} — skipping this pass",
            home.display()
        );
        return;
    }
    spawn_master(&pass_prompt(&keys), &home.to_string_lossy()).await;
}

/// The master's own process, versioned with this binary.
// cm:guard the skill text ships INSIDE the runner and is written to disk before every pass. Nothing else delivers it: `workspace/skill_sync.rs` writes a project's skills into that project's checkout, and the master runs in no checkout at all — so a master told to "use the forge-master skill" with nothing on disk loads nothing and improvises the one process this design depends on, silently. The price of embedding is real and is the trade: editing the master's process now needs a runner release, where a project skill needs only a push.
const MASTER_SKILL: &str = include_str!("../../../../../../.claude/skills/forge-master/SKILL.md");

/// Where the master process runs — its own directory, never a project's.
// cm:guard the master must NOT run inside a project checkout, and must NOT run in `$HOME`. A cwd inside one repo puts its reads and any stray write into a tree a job is about to be given; `$HOME` would put the skill in `~/.claude/skills`, which is the shadowing trap that made a green sync serve a stale skill on ubuntu5 (ISS-783). Its own directory is neither.
fn master_home() -> Option<std::path::PathBuf> {
    Some(Config::path().ok()?.with_file_name("master"))
}

/// Write the skill where the pass about to start will look for it.
fn install_skill(home: &std::path::Path) -> std::io::Result<()> {
    let dir = home.join(".claude/skills/forge-master");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("SKILL.md"), MASTER_SKILL)
}

async fn spawn_master(prompt: &str, cwd: &str) {
    let args: Vec<String> = vec![
        "--permission-mode".into(),
        "bypassPermissions".into(),
        "-p".into(),
        prompt.to_string(),
    ];
    let mut child = match build_command(&args, cwd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("[master] could not start: {e}");
            return;
        }
    };
    // cm:guard kill an overrunning master rather than waiting it out. Past `MASTER_HOLD_TIMEOUT_MS` core has already taken its holds back, so every further minute is a process claiming work it no longer owns — and this must never be an unbounded wait, which is the shape that wedged sidpeak job 483387d4 for 4.5 minutes into `session_lost`.
    match tokio::time::timeout(MASTER_MAX_RUNTIME, child.wait()).await {
        Ok(Ok(status)) => tracing::info!("[master] pass ended ({status})"),
        Ok(Err(e)) => tracing::warn!("[master] pass failed: {e}"),
        Err(_) => {
            tracing::warn!(
                "[master] pass exceeded {}s and was killed — core has already reclaimed its holds",
                MASTER_MAX_RUNTIME.as_secs()
            );
            crate::runner::process::graceful_kill(&mut child).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // cm:guard the two constants are a PAIR, and this is the only thing asserting the order. A poll slower than the hold timeout, or a master allowed to outlive it, both end the same way: core reaps holds from a master still working, which re-claims them next pass.
    #[test]
    fn a_master_never_outlives_the_hold_core_gives_it() {
        const CORE_MASTER_HOLD_TIMEOUT: Duration = Duration::from_secs(180);
        assert!(
            MASTER_MAX_RUNTIME < CORE_MASTER_HOLD_TIMEOUT,
            "a master must end before core reaps the holds it took"
        );
        assert!(
            POLL_INTERVAL < MASTER_MAX_RUNTIME,
            "polling slower than a pass lasts leaves the box idle between passes"
        );
    }

    #[test]
    fn only_one_master_runs_at_a_time() {
        let gate = MasterGate::new();
        let first = gate.try_enter().expect("the first pass must start");
        assert!(
            gate.try_enter().is_none(),
            "a second master must not start while one is running"
        );
        drop(first);
        assert!(
            gate.try_enter().is_some(),
            "the gate must reopen once the pass ends"
        );
    }

    // cm:guard the prompt names the skill and does not restate it. A test that only checked for non-empty prose would pass a prompt that inlined the whole process, which is the drift this guards.
    // cm:guard the embedded copy must carry the skill's actual process, not merely be non-empty — an `include_str!` that silently picked up a stub would leave every master improvising, which is the failure this whole path exists to prevent.
    #[test]
    fn the_embedded_skill_is_the_real_one() {
        assert!(MASTER_SKILL.contains("name: forge-master"));
        assert!(MASTER_SKILL.contains("forge-runner pool claim"));
        assert!(MASTER_SKILL.contains("Release anything claimed but not started"));
    }

    #[test]
    fn the_prompt_points_at_the_skill_rather_than_repeating_it() {
        let p = pass_prompt(&["ISS-901".into()]);
        assert!(p.contains("forge-master"));
        assert!(p.contains("ISS-901"));
        assert!(p.contains("releasing"));
    }
}
