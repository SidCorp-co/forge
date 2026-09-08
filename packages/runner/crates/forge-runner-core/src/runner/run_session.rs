//! Creating a run session (ISS-933 step 2).
//!
//! A run is a worktree, a group of issues and a terminal session — and the
//! order those three come into being in is the whole of this module. The
//! ledger row is committed FIRST, before git is touched and long before a
//! process exists, so every later reader is answering from a record that was
//! written when nothing could yet have gone wrong.
//!
//! The inverse order is the one that looks natural and is wrong: spawn, then
//! record. A crash in that window leaves a live agent writing a worktree that
//! nothing on the box knows about, which is how two sessions ended up in one
//! tree (pids 334254 and 335001, same cwd).

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::runner::ledger::{Ledger, NewRun, Run};

/// How a run's terminal session is started. Production is tmux; a test
/// supplies one that fails, so the crash-between-steps case is reachable.
#[async_trait::async_trait]
pub trait Spawner: Send + Sync {
    async fn spawn(&self, session_name: &str, cwd: &Path, argv: &[String]) -> Result<u32>;
}

/// How core is told a run session exists. Returns the session id core minted.
// cm:edge contract -> packages/core/src/devices/run-session.ts — `openRunSession` is the other half, and the group of issues travels in that one call: core records membership on the run's metadata because `pipeline_runs.issue_id` is one column and a run carries many.
#[async_trait::async_trait]
pub trait CoreSessions: Send + Sync {
    /// Answers `(agent session id, pipeline run id)` — the run id is what every
    /// phase endpoint takes as a path segment.
    async fn open(
        &self,
        run_id: &str,
        issue_keys: &[String],
        name: &str,
    ) -> Result<(String, String)>;
}

/// What the master decided: a group, a branch, and where the repo is.
pub struct RunRequest {
    pub run_id: String,
    pub master_session_id: String,
    pub boot_id: String,
    pub issue_keys: Vec<String>,
    pub repo: String,
    pub branch: String,
    pub start_point: Option<String>,
    pub argv: Vec<String>,
}

/// What a run session is told, once, when its pane starts.
// cm:guard the run id MUST be in the brief — every phase endpoint takes it as a path segment, and the agent has no other way to learn its own run without spending a call on the pipeline-runs list route.
// cm:guard the phase example IS the phase vocabulary: `phase_journal.phase` is free-form and no gate reads it, so whatever name this literal shows is what lands in the table. It read `phase-1` until ISS-921 and 542 rows landed named `phase-0`..`phase-8`, which no reader can interpret and which do not mean the same step run to run. Keep a descriptive name and never reintroduce an ordinal.
// cm:guard name EVERY issue the run carries. This text moved here from core when a run stopped being one job over one issue (ISS-933); a brief that named only the first would have the agent close one issue and abandon the rest in a worktree it then deletes.
// cm:guard CROSS-REPO coupling, so no `cm:edge` can hold it: the other side is `guides/skills/issue-flow/guide.md` in github.com/SidCorp-co/forge-plugin, which the agent reads via `forge guide issue-flow`. That guide and this brief are read in one context and must name ONE way to reach Forge and ONE status vocabulary. They disagreed until 2026-09-02 and the agent believed the prompt — 4,806 `forge_step_start` calls on autonomous projects. Nothing here can gate the pair; this line is the only record of it.
fn brief(issue_keys: &[String], pipeline_run_id: &str) -> String {
    let issues = issue_keys.join(", ");
    format!(
        "Drive {issues} to completion with the `issue-flow` skill. This run carries ALL of them: \
they share this worktree and this branch, and none of them is done until you have finished the \
group.\n\nYou reach Forge over the CLI — `forge-runner api <path>`, authenticated by `$FORGE_PAT`, \
which the runner has already exported. Read each issue and this project's `projectFacts` before \
Phase 1; the skill is installed as a plugin and knows nothing about this repo.\n\nYour run is \
{pipeline_run_id}. Declare every phase before you begin it, and close it when it ends. The \
declaration is your resume point: a session that dies restarts from the last phase you declared, \
so read the resume point FIRST — if it returns a phase, you are a resumed session and that is \
where you continue.\n\n    forge-runner api pipeline-runs/{pipeline_run_id}/resume-point\n    \
forge-runner api pipeline-runs/{pipeline_run_id}/phases -X POST -d '{{\"phase\":\"understand\"}}'\n\n\
Name the phase for the step it is, in words, never by its number: nothing can say what a row named \
`phase-4` was, and two runs need not have meant the same step by it. Reuse the name an earlier run \
used for the same step so the two aggregate — `understand`, `plan`, `code`, `review`, `ship` are \
already in the journal."
    )
}

/// Create the worktree, record the run, then start it — in that order.
// cm:guard the four steps are ordered LEDGER, WORKTREE, SESSION, SPAWN and the order is the deliverable, not an implementation detail. Recording first means a crash anywhere after it leaves a row a recovery can act on; recording last means a live process nothing knows about. The ledger's own refusals also run inside step one, which is what makes criterion 12 true — a worktree path another live run holds is refused BEFORE `git worktree add` can produce the `.worktrees/<name> already exists` failure that killed ISS-593's first job.
// cm:guard SESSION strictly before SPAWN, and that ordering is what lets the close loop read a missing session id as "never started" rather than as an unknown. Reverse the two and a crash in the window leaves a live agent core cannot name, which is neither closable locally nor reapable centrally.
pub async fn start(
    ledger: &mut Ledger,
    req: RunRequest,
    spawner: &dyn Spawner,
    core: &dyn CoreSessions,
) -> Result<Run> {
    let worktree_path = crate::workspace::worktree::path(&req.repo, &req.branch);
    let issue_keys = req.issue_keys.clone();
    let run = ledger.create_run_group(NewRun {
        run_id: req.run_id.clone(),
        master_session_id: req.master_session_id,
        worktree_path: worktree_path.clone(),
        boot_id: req.boot_id,
        issue_keys: req.issue_keys,
    })?;

    let created: PathBuf =
        crate::workspace::worktree::create(&req.repo, &req.branch, req.start_point.as_deref())
            .await?;

    let name =
        crate::daemon::terminal::session_name(crate::daemon::terminal::RUN_PREFIX, &req.branch);
    let (session_id, pipeline_run_id) = core.open(&run.run_id, &issue_keys, &name).await?;
    ledger.attach_session(&run.run_id, &session_id)?;

    let pid = spawner.spawn(&name, &created, &req.argv).await?;
    ledger.attach_pid(&run.run_id, pid)?;

    // cm:guard the brief is sent AFTER the pid is on the ledger. A pane briefed before its run is
    // fully recorded is an agent working on a row recovery has not finished writing.
    if let Err(e) =
        crate::daemon::terminal::send_line(&name, &brief(&issue_keys, &pipeline_run_id)).await
    {
        tracing::warn!("run_session: {name} started but could not be briefed: {e}");
    }

    ledger
        .run(&req.run_id)?
        .ok_or_else(|| Error::Other("run_session: run vanished after start".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::terminal::{session_name, MASTER_PREFIX, RUN_PREFIX};
    use std::sync::Mutex;

    const TERMINAL_SOURCE: &str = include_str!("../daemon/terminal.rs");
    const THIS_SOURCE: &str = include_str!("run_session.rs");

    pub(super) struct Core(pub(super) Mutex<Vec<String>>);
    #[async_trait::async_trait]
    impl CoreSessions for Core {
        async fn open(
            &self,
            run_id: &str,
            issue_keys: &[String],
            _: &str,
        ) -> Result<(String, String)> {
            self.0
                .lock()
                .unwrap()
                .push(format!("{run_id}:{}", issue_keys.join(",")));
            Ok(("core-sess-1".into(), "pr-1".into()))
        }
    }

    struct Failing;

    #[async_trait::async_trait]
    impl Spawner for Failing {
        async fn spawn(&self, _: &str, _: &Path, _: &[String]) -> Result<u32> {
            Err(Error::Other("tmux refused".into()))
        }
    }

    fn req() -> RunRequest {
        RunRequest {
            run_id: "run-1".into(),
            master_session_id: "master-1".into(),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-957".into(), "ISS-963".into()],
            repo: "/repo".into(),
            branch: "grp-1".into(),
            start_point: None,
            argv: vec!["claude".into()],
        }
    }

    #[tokio::test]
    async fn the_run_is_recorded_before_anything_can_spawn_it() {
        let mut led = Ledger::open_in_memory().unwrap();
        let r = req();
        let run_id = r.run_id.clone();
        let core = Core(Mutex::new(Vec::new()));
        let _ = start(&mut led, r, &Failing, &core).await;

        let row = led
            .run(&run_id)
            .unwrap()
            .expect("a run that failed to spawn must still be ON the ledger — recording after the spawn leaves a live agent in a worktree nothing knows about (ISS-933 criterion 3)");
        assert_eq!(row.pid, None, "an unstarted run must carry no pid");
        assert_eq!(led.issues(&run_id).unwrap().len(), 2);
        assert!(
            core.0.lock().unwrap().is_empty(),
            "a run whose worktree never came into being must not have been announced to core — a session core believes in over a tree that does not exist is a run nothing local can ever close (ISS-933 criterion 16)"
        );
    }

    #[test]
    fn a_run_pane_and_a_master_pane_differ_only_by_the_prefix() {
        assert_eq!(session_name(RUN_PREFIX, "grp-1"), "forge-run-grp-1");
        assert_eq!(session_name(MASTER_PREFIX, "grp-1"), "forge-master-grp-1");
        assert_ne!(RUN_PREFIX, MASTER_PREFIX);
    }

    #[test]
    fn there_is_one_spawn_primitive_and_runs_reuse_it() {
        let ensures = TERMINAL_SOURCE
            .lines()
            .filter(|l| l.trim_start().starts_with("pub async fn ensure"))
            .count();
        assert_eq!(
            ensures, 1,
            "a second `ensure` is a second spawn path, and the one that runs less often is the one that rots (ISS-933 criterion 1)"
        );
        for verb in [
            "pub async fn alive",
            "pub async fn kill",
            "pub async fn send_line",
        ] {
            assert_eq!(
                TERMINAL_SOURCE
                    .lines()
                    .filter(|l| l.trim_start().starts_with(verb))
                    .count(),
                1,
                "`{verb}` must exist once and take the name a caller built from a prefix"
            );
        }
    }

    #[test]
    fn the_brief_names_every_issue_the_run_carries() {
        let text = brief(&["ISS-957".into(), "ISS-963".into()], "pr-1");
        for key in ["ISS-957", "ISS-963"] {
            assert!(
                text.contains(key),
                "a brief that names only the first issue has the agent close one and abandon the rest in a worktree it then deletes — this text moved here from core precisely when a run stopped being one job over one issue (ISS-933 criterion 7); brief was: {text}"
            );
        }
        assert!(
            text.contains("pr-1"),
            "the run id must be in the brief: every phase endpoint takes it as a path segment and the agent has no other way to learn its own run"
        );
    }

    // cm:guard the ordinal is what this asserts, not the wording. `phase_journal.phase` is free-form and no gate reads it, so whatever the example shows is what lands in the table — 542 rows landed named `phase-0`..`phase-8`, which no reader can interpret.
    #[test]
    fn the_phase_example_is_a_word_and_never_a_number() {
        let text = brief(&["ISS-957".into()], "pr-1");
        let example = text
            .split("\"phase\":\"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .unwrap_or_default();
        assert!(
            !example.is_empty() && example.chars().all(|c| c.is_ascii_alphabetic()),
            "the example phase name is the vocabulary — whatever this literal shows is what lands in `phase_journal.phase`, and an ordinal there is a row no reader can interpret; example was `{example}`"
        );
    }

    #[test]
    fn a_run_mints_no_credential_of_its_own() {
        let production = THIS_SOURCE
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for banned in ["mint", "job_token", "session_token", "run_token"] {
            assert!(
                !production.contains(banned),
                "a run authenticates with the box's own credential and mints nothing of its own (ISS-933 criterion 5); found `{banned}` in the production half of this module"
            );
        }
    }
}

// cm:guard the replay of the incident this issue exists to prevent (ISS-933 criterion 11), and it runs against a REAL git repo, a REAL worktree and a REAL process because the failure it reproduces was two live agents in one directory — a mocked spawn cannot be in the wrong directory, so it cannot witness this. Linux-gated for `/proc/<pid>/cwd`, which is the only way to read where a process actually IS rather than where it was told to go.
#[cfg(all(test, target_os = "linux"))]
mod replay {
    use super::tests::Core;
    use super::*;
    use crate::runner::ledger::Ledger;
    use std::process::{Child, Command};
    use std::sync::Mutex;

    struct RealSpawner {
        children: Mutex<Vec<Child>>,
    }

    #[async_trait::async_trait]
    impl Spawner for RealSpawner {
        async fn spawn(&self, _name: &str, cwd: &Path, _argv: &[String]) -> Result<u32> {
            let child = Command::new("sleep")
                .arg("30")
                .current_dir(cwd)
                .spawn()
                .map_err(|e| Error::Other(format!("spawn: {e}")))?;
            let pid = child.id();
            self.children.lock().unwrap().push(child);
            Ok(pid)
        }
    }

    fn sh(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-replay-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        sh(&dir, &["init", "-q", "-b", "main"]);
        sh(&dir, &["config", "user.email", "t@t.invalid"]);
        sh(&dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("shared.ts"), "export const a = 1;\n").unwrap();
        sh(&dir, &["add", "-A"]);
        sh(&dir, &["commit", "-qm", "base"]);
        dir
    }

    fn cwd_of(pid: u32) -> PathBuf {
        std::fs::read_link(format!("/proc/{pid}/cwd")).expect("the process must still be alive")
    }

    #[tokio::test]
    async fn the_measured_pair_is_carried_by_one_run_into_one_worktree() {
        let dir = repo();
        let repo_path = dir.to_string_lossy().to_string();
        let mut led = Ledger::open_in_memory().unwrap();
        let spawner = RealSpawner {
            children: Mutex::new(Vec::new()),
        };
        let announced = Core(Mutex::new(Vec::new()));

        let run = start(
            &mut led,
            RunRequest {
                run_id: "run-replay".into(),
                master_session_id: "master-1".into(),
                boot_id: "boot-a".into(),
                issue_keys: vec!["ISS-957".into(), "ISS-963".into()],
                repo: repo_path.clone(),
                branch: "grp-957-963".into(),
                start_point: None,
                argv: vec!["sleep".into()],
            },
            &spawner,
            &announced,
        )
        .await
        .unwrap();

        let issues = led.issues("run-replay").unwrap();
        assert_eq!(issues.len(), 2, "one run must carry the whole group");
        assert_eq!(
            run.session_id.as_deref(),
            Some("core-sess-1"),
            "the core session is opened BEFORE the spawn, and that order is what lets the close loop read a missing session id as `never started` rather than as an unknown (ISS-933 criterion 16)"
        );
        assert_eq!(
            announced.0.lock().unwrap().as_slice(),
            ["run-replay:ISS-957,ISS-963"],
            "the WHOLE group travels to core in ONE call — a run whose membership core learns one issue at a time is a run core cannot release as a group when the box is lost (ISS-933 criterion 25a)"
        );

        let first_pid = run.pid.expect("a started run records its pid");
        let live_cwd = cwd_of(first_pid);
        assert_eq!(
            live_cwd.canonicalize().unwrap(),
            run.worktree_path.canonicalize().unwrap(),
            "the session must actually BE in the run's worktree"
        );

        let before = spawner.children.lock().unwrap().len();
        let second = start(
            &mut led,
            RunRequest {
                run_id: "run-second".into(),
                master_session_id: "master-1".into(),
                boot_id: "boot-a".into(),
                issue_keys: vec!["ISS-963".into()],
                repo: repo_path,
                branch: "grp-957-963".into(),
                start_point: None,
                argv: vec!["sleep".into()],
            },
            &spawner,
            &Core(Mutex::new(Vec::new())),
        )
        .await;

        let err = second
            .expect_err("a second run over an issue the first already carries must be refused — this IS the incident: pids 334254 and 335001 in one cwd on 2026-09-08 (ISS-933 criterion 11)")
            .to_string();
        assert!(
            err.contains("ISS-963") && err.contains("run-replay"),
            "{err}"
        );
        assert_eq!(
            spawner.children.lock().unwrap().len(),
            before,
            "the refusal must happen BEFORE anything is spawned — a second process in this worktree is exactly the state being prevented"
        );
        assert_eq!(
            cwd_of(first_pid).canonicalize().unwrap(),
            run.worktree_path.canonicalize().unwrap(),
            "the first session must be untouched by the refused second"
        );

        eprintln!(
            "replay evidence — run {} carries {:?}; sole pid {} with cwd {}; second creation refused, {} process(es) spawned in total",
            run.run_id,
            issues.iter().map(|m| m.issue_key.as_str()).collect::<Vec<_>>(),
            first_pid,
            live_cwd.display(),
            spawner.children.lock().unwrap().len()
        );

        for mut c in spawner.children.into_inner().unwrap() {
            let _ = c.kill();
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
