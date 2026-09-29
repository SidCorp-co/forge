//! One frame's worth of readings, from every source the view shows.
//!
//! Local sources are read every frame. The worktree walks and core's answers
//! cost more than a frame should, so each is kept with the moment it was taken
//! and shown with that age rather than silently reused.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::daemon::{dispatch, pool_jobs, serving};
use forge_runner_core::runner::ledger::Ledger;
use forge_runner_core::transport::runners::{self, MeRunner};
use forge_runner_core::transport::CoreClient;

use super::binary::{self, Daemon};
use super::cli_slug::{self, Slug};
use super::ledger_ro;
use super::panes::{self, Sessions};
use super::people::{self, Jobs, ProjectCore};
use super::skill::{self, Skill};
use super::source::{Read, Unreadable};
use super::tree_age::{self, TreeAge};
use crate::cmd::Ctx;

/// Core's answers for every project, keyed by project id, and when they were asked.
pub type CoreAnswer = Read<(i64, BTreeMap<String, ProjectCore>)>;

/// How long core's answers are shown before they are asked again.
pub const CORE_EVERY_MS: i64 = 60_000;
/// How long one worktree's walk is shown before it is taken again.
pub const WALK_EVERY_MS: i64 = 30_000;

#[derive(Debug, Clone)]
pub struct Project {
    /// The name this box knows it by: its binding key, else core's slug.
    pub key: String,
    pub project_id: Option<String>,
    pub core_slug: Option<String>,
    pub repo: Option<PathBuf>,
}

pub struct Snapshot {
    pub now_ms: i64,
    pub config_path: String,
    pub config: Read<Config>,
    pub binary: Vec<String>,
    pub discovery: Read<Vec<MeRunner>>,
    pub projects: Vec<Project>,
    pub ledger: Read<ledger_ro::View>,
    pub boot: Option<String>,
    pub sessions: Read<Sessions>,
    pub skills: HashMap<String, Skill>,
    pub slugs: HashMap<String, Slug>,
    /// Keyed by worktree path: when it was walked, and what the walk found.
    pub trees: HashMap<PathBuf, (i64, TreeAge)>,
    pub jobs: Read<Jobs>,
    /// Keyed by project id, and the moment they were asked.
    pub core: CoreAnswer,
    pub gate: Vec<String>,
    pub gate_source: String,
    pub pool: Vec<String>,
    pub pool_source: String,
}

type HeldExe = ((u32, String), Read<Arc<Vec<u8>>>);

/// What one frame keeps for the next.
#[derive(Default)]
pub struct Carry {
    discovery: Option<(i64, Read<Vec<MeRunner>>)>,
    core: Option<CoreAnswer>,
    core_at: i64,
    /// The project ids `core` was asked about: an answer is kept for these
    /// alone, so a project listed since is asked, never shown as unanswered.
    core_ids: Vec<String>,
    trees: HashMap<PathBuf, (i64, TreeAge)>,
    /// The daemon executable last read, under the pid and link it was read at.
    exe: Option<HeldExe>,
}

pub async fn frame(ctx: &Ctx, carry: &mut Carry) -> Snapshot {
    let now_ms = forge_runner_core::daemon::agent_activity::now_ms();
    let config_path = Config::path()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|e| format!("a config path this box cannot resolve ({e})"));
    let config = Config::load().map_err(|e| Unreadable::new(&config_path, e));
    let config_dir = forge_runner_core::daemon::control::config_dir();

    let record = match &config_dir {
        Some(d) => serving::read(d),
        None => Err(serving::Unreadable {
            path: PathBuf::from("serving.json"),
            reason: "no configuration directory resolves on this box".into(),
        }),
    };
    let probe = serving::Probe::this_box();
    let daemon = binary::daemon(&record, &probe);
    let binary_lines = binary::lines(&record, &probe, daemon.as_ref(), now_ms);
    let exe = daemon_exe(carry, daemon.as_ref());

    let discovery = discover(ctx, config.as_ref().ok(), carry, now_ms).await;
    let projects = projects(config.as_ref().ok(), discovery.as_ref().ok());

    let ledger = Ledger::default_path()
        .map_err(|e| Unreadable::new("ledger", e))
        .and_then(|p| ledger_ro::read(&p));
    let sessions = panes::list();

    let cli_dir = cli_slug::cli_config_dir(|k| std::env::var(k).ok(), dirs_next::home_dir());
    let mut skills = HashMap::new();
    let mut slugs = HashMap::new();
    for p in &projects {
        if let Some(repo) = &p.repo {
            skills.insert(p.key.clone(), skill::read(repo, &exe));
            slugs.insert(
                p.key.clone(),
                cli_slug::read(cli_dir.as_deref(), repo, p.core_slug.as_deref()),
            );
        }
    }

    let worktrees: Vec<PathBuf> = ledger
        .as_ref()
        .map(|v| v.runs.iter().map(|r| r.worktree_path.clone()).collect())
        .unwrap_or_default();
    walk(carry, worktrees, now_ms).await;

    let jobs = pool_jobs::FileRecords::default_dir()
        .ok_or_else(|| Unreadable::new("pool-jobs", "no configuration directory resolves"))
        .and_then(|d| people::jobs(&d));

    let core = core_reads(ctx, config.as_ref().ok(), &projects, carry, now_ms).await;

    let (gate, gate_source, pool, pool_source) = match (&config_dir, config.as_ref()) {
        (Some(d), cfg) => {
            let fallback = Config::default();
            let cfg = cfg.unwrap_or(&fallback);
            (
                crate::cmd::status::gate_reading(d, now_ms),
                forge_runner_core::daemon::degraded::marks_path(d)
                    .display()
                    .to_string(),
                crate::cmd::status::pool_lines(
                    &forge_runner_core::daemon::pool_reads::report(d, now_ms),
                    cfg,
                    now_ms,
                ),
                forge_runner_core::daemon::pool_reads::path(d)
                    .display()
                    .to_string(),
            )
        }
        (None, _) => {
            let none = "gate       UNREADABLE — no configuration directory resolves on this box"
                .to_string();
            (
                vec![none.clone()],
                String::new(),
                vec![none.replace("gate ", "pool ")],
                String::new(),
            )
        }
    };

    Snapshot {
        now_ms,
        config_path,
        config,
        binary: binary_lines,
        discovery,
        projects,
        ledger,
        boot: forge_runner_core::runner::inflight::boot_identity(),
        sessions,
        skills,
        slugs,
        trees: carry.trees.clone(),
        jobs,
        core,
        gate,
        gate_source,
        pool,
        pool_source,
    }
}

fn daemon_exe(carry: &mut Carry, daemon: Option<&Daemon>) -> Read<Arc<Vec<u8>>> {
    let Some(d) = daemon else {
        return Err(Unreadable::new(
            "the daemon's executable",
            "no running daemon could be named, so what it ships cannot be read",
        ));
    };
    let identity = (d.pid, d.exe_link.clone().unwrap_or_default());
    if let Some((held, bytes)) = &carry.exe {
        if *held == identity {
            return bytes.clone();
        }
    }
    let bytes = binary::exe_bytes(Path::new("/proc"), d.pid);
    carry.exe = Some((identity, bytes.clone()));
    bytes
}

async fn discover(
    ctx: &Ctx,
    cfg: Option<&Config>,
    carry: &mut Carry,
    now_ms: i64,
) -> Read<Vec<MeRunner>> {
    if let Some((at, held)) = &carry.discovery {
        if now_ms - at < CORE_EVERY_MS {
            return held.clone();
        }
    }
    let route = "GET /api/devices/me/runners";
    let got = match (
        cfg.and_then(|c| ctx.resolve_core_url(c)),
        cred_store::load_device_token(),
    ) {
        (None, _) => Err(Unreadable::new(
            route,
            "no core URL is configured on this box",
        )),
        (_, Err(e)) => Err(Unreadable::new(
            route,
            format!("the device credential cannot be read ({e})"),
        )),
        (_, Ok(None)) => Err(Unreadable::new(
            route,
            "this box holds no device credential — `forge-runner login`",
        )),
        (Some(url), Ok(Some(token))) => runners::list_me(&CoreClient::new(url, token))
            .await
            .map_err(|e| Unreadable::new(route, e)),
    };
    carry.discovery = Some((now_ms, got.clone()));
    got
}

/// Every project this box binds or core serves it, each once, resolved to its
/// checkout by the rule the daemon places a master with.
pub fn projects(cfg: Option<&Config>, served: Option<&Vec<MeRunner>>) -> Vec<Project> {
    let empty = Vec::new();
    let served = served.unwrap_or(&empty);
    let fallback = Config::default();
    let cfg_ref = cfg.unwrap_or(&fallback);
    let mut out: Vec<Project> = Vec::new();
    for (key, b) in &cfg_ref.bindings {
        let core_slug = b
            .project_id
            .as_deref()
            .and_then(|id| served.iter().find(|r| r.project_id == id))
            .map(|r| r.slug.clone());
        let repo = match b.project_id.as_deref() {
            Some(id) => dispatch::resolve_repo(served, cfg_ref, id)
                .ok()
                .map(|r| r.repo_path),
            None => Some(b.repo_path.clone()),
        };
        out.push(Project {
            key: key.clone(),
            project_id: b.project_id.clone(),
            core_slug,
            repo,
        });
    }
    for r in served {
        if out
            .iter()
            .any(|p| p.project_id.as_deref() == Some(r.project_id.as_str()))
        {
            continue;
        }
        out.push(Project {
            key: r.slug.clone(),
            project_id: Some(r.project_id.clone()),
            core_slug: Some(r.slug.clone()),
            repo: dispatch::resolve_repo(served, cfg_ref, &r.project_id)
                .ok()
                .map(|x| x.repo_path),
        });
    }
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

async fn walk(carry: &mut Carry, worktrees: Vec<PathBuf>, now_ms: i64) {
    let due: Vec<PathBuf> = worktrees
        .iter()
        .filter(|w| {
            carry
                .trees
                .get(*w)
                .is_none_or(|(at, _)| now_ms - at >= WALK_EVERY_MS)
        })
        .cloned()
        .collect();
    carry.trees.retain(|k, _| worktrees.contains(k));
    // One thread per tree: the walks are independent and each is bound by
    // the stat calls of its own tree.
    let walked = tokio::task::spawn_blocking(move || {
        std::thread::scope(|scope| {
            let handles: Vec<_> = due
                .iter()
                .map(|w| scope.spawn(move || tree_age::newest(w, tree_age::ENTRY_CAP)))
                .collect();
            due.iter()
                .cloned()
                .zip(handles)
                .map(|(w, h)| {
                    let age = h
                        .join()
                        .unwrap_or_else(|_| TreeAge::Unreadable("the walk panicked".into()));
                    (w, age)
                })
                .collect::<Vec<_>>()
        })
    })
    .await
    .unwrap_or_default();
    for (w, age) in walked {
        carry.trees.insert(w, (now_ms, age));
    }
}

async fn core_reads(
    ctx: &Ctx,
    cfg: Option<&Config>,
    projects: &[Project],
    carry: &mut Carry,
    now_ms: i64,
) -> CoreAnswer {
    let ids = project_ids(projects);
    if let Some(held) = held_core(carry, &ids, now_ms) {
        return held;
    }
    let got = ask_core(ctx, cfg, projects, now_ms).await;
    carry.core = Some(got.clone());
    carry.core_at = now_ms;
    carry.core_ids = ids;
    got
}

fn project_ids(projects: &[Project]) -> Vec<String> {
    let mut ids: Vec<String> = projects
        .iter()
        .filter_map(|p| p.project_id.clone())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// The answer kept from an earlier frame, where it is young enough and was
/// asked about exactly these projects.
fn held_core(carry: &Carry, ids: &[String], now_ms: i64) -> Option<CoreAnswer> {
    let held = carry.core.as_ref()?;
    (now_ms - carry.core_at < CORE_EVERY_MS && carry.core_ids == ids).then(|| held.clone())
}

async fn ask_core(
    ctx: &Ctx,
    cfg: Option<&Config>,
    projects: &[Project],
    now_ms: i64,
) -> CoreAnswer {
    let source = "open questions and awaiting_release rows (core)";
    let url = cfg
        .and_then(|c| ctx.resolve_core_url(c))
        .ok_or_else(|| Unreadable::new(source, "no core URL is configured on this box"))?;
    let pat = match cred_store::load_pat() {
        Ok(Some(t)) => t,
        Ok(None) => return Err(Unreadable::new(
            source,
            "no personal access token on this box, and core answers these routes to one alone — \
                 `forge-runner login --pat <token>`, or FORGE_PAT",
        )),
        Err(e) => {
            return Err(Unreadable::new(
                source,
                format!("the personal access token cannot be read ({e})"),
            ))
        }
    };
    let client = CoreClient::new(url, pat);
    let mut asks = tokio::task::JoinSet::new();
    for id in projects.iter().filter_map(|p| p.project_id.clone()) {
        let client = client.clone();
        asks.spawn(async move {
            let core = people::project_core(&client, &id).await;
            (id, core)
        });
    }
    let mut out = BTreeMap::new();
    while let Some(done) = asks.join_next().await {
        // A read whose task failed leaves its id out, which `render::core_of`
        // names as a read that did not finish rather than an empty project.
        if let Ok((id, core)) = done {
            out.insert(id, core);
        }
    }
    Ok((now_ms, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str) -> Project {
        Project {
            key: id.into(),
            project_id: Some(id.into()),
            core_slug: None,
            repo: None,
        }
    }

    /// Whole-set consult at 6698e5c, F1: an answer is kept only for the
    /// projects it was asked about, so one listed since is asked in its turn.
    #[test]
    fn a_kept_answer_is_for_the_projects_it_was_asked_about() {
        let mut carry = Carry::default();
        let alpha = project_ids(&[project("alpha")]);
        carry.core = Some(Ok((1_000, BTreeMap::new())));
        carry.core_at = 1_000;
        carry.core_ids = alpha.clone();
        assert!(
            held_core(&carry, &alpha, 2_000).is_some(),
            "young, same set"
        );
        let both = project_ids(&[project("beta"), project("alpha")]);
        assert!(
            held_core(&carry, &both, 2_000).is_none(),
            "a project listed since"
        );
        assert!(
            held_core(&carry, &alpha, 1_000 + CORE_EVERY_MS).is_none(),
            "old"
        );
        assert_eq!(both, vec!["alpha".to_string(), "beta".to_string()]);
    }
}
