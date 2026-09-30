//! A frame, as the lines a person reads.
//!
//! Every line that says a source is fine ends `← <what was read>`, so a quiet
//! row names the read that made it quiet (the issue's Rules: counts by status
//! are no health signal on their own). A source that could not be read prints
//! its `Unreadable` and nothing that could be taken for an answer.

use std::collections::BTreeMap;

use forge_runner_core::daemon::terminal;

use super::cli_slug::Slug;
use super::gather::{Project, Snapshot};
use super::ledger_ro::{self, short, Run};
use super::people::ProjectCore;
use super::skill::Skill;
use super::source::{ago, span};
use super::tree_age::TreeAge;

const I1: &str = "  ";
const I2: &str = "    ";
const I3: &str = "      ";
/// How long after a pane started a skill write counts as a rewrite.
pub const REWRITE_AFTER_MS: i64 = 60_000;

pub fn frame(s: &Snapshot, interval_secs: Option<u64>) -> Vec<String> {
    let mut out = vec![header(interval_secs), String::new(), "BINARY".into()];
    out.extend(s.binary.iter().map(|l| format!("{I1}{l}")));
    out.push(String::new());
    projects(s, &mut out);
    out.push(String::new());
    waiting(s, &mut out);
    out.push(String::new());
    health(s, &mut out);
    out
}

fn header(interval_secs: Option<u64>) -> String {
    let host = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|h| h.trim().to_string())
        .unwrap_or_else(|_| "this box".into());
    let when = match interval_secs {
        Some(n) => format!("redrawn every {n}s, Ctrl-C ends it"),
        None => "one frame".into(),
    };
    format!(
        "forge-runner top — {host}, read-only (no dispatch, claim, kill, release or keystroke), {when}"
    )
}

fn projects(s: &Snapshot, out: &mut Vec<String>) {
    let bound = s.config.as_ref().map(|c| c.bindings.len()).unwrap_or(0);
    out.push(match (&s.config, &s.discovery) {
        (Err(e), _) => format!("PROJECTS  {e}"),
        (Ok(_), Ok(served)) => format!(
            "PROJECTS  {bound} bound ← {}; {} served to this box{} ← GET /api/devices/me/runners",
            s.config_path,
            served.len(),
            asked(s.now_ms, s.discovery_at)
        ),
        (Ok(_), Err(e)) => format!(
            "PROJECTS  {e}. Listed are only the {bound} project(s) bound in {}; any core serves this box beyond them cannot be seen",
            s.config_path
        ),
    });
    if s.projects.is_empty() {
        out.push(match (&s.config, &s.discovery) {
            (Ok(_), Ok(_)) => format!("{I1}no project is bound here or served to this box"),
            (Ok(_), Err(_)) => format!(
                "{I1}none bound here — PARTIAL: whether core serves this box any cannot be seen, above"
            ),
            (Err(_), _) => format!(
                "{I1}no project can be listed — PARTIAL: the bindings cannot be read, above"
            ),
        });
    }
    let runs = runs_by_project(s);
    for p in &s.projects {
        // A binding with no project id owns no run: the key "" is the stray
        // bucket below, never a project's.
        project(
            s,
            p,
            p.project_id.as_deref().and_then(|id| runs.get(id)),
            out,
        );
    }
    if let Some(stray) = runs.get("") {
        out.push(format!("{I1}(runs naming no project this box knows)"));
        for r in stray {
            run_line(s, r, out);
        }
    }
    if let Err(e) = &s.ledger {
        out.push(format!("{I1}runs   {e}"));
    }
}

fn runs_by_project(s: &Snapshot) -> BTreeMap<String, Vec<&Run>> {
    let mut by: BTreeMap<String, Vec<&Run>> = BTreeMap::new();
    let Ok(view) = &s.ledger else { return by };
    for r in view.runs.iter().filter(|r| !r.held_keys().is_empty()) {
        let known = r.project_id.as_deref().filter(|id| {
            s.projects
                .iter()
                .any(|p| p.project_id.as_deref() == Some(*id))
        });
        by.entry(known.unwrap_or("").to_string())
            .or_default()
            .push(r);
    }
    by
}

fn project(s: &Snapshot, p: &Project, runs: Option<&Vec<&Run>>, out: &mut Vec<String>) {
    let id = p
        .project_id
        .as_deref()
        .map(short)
        .unwrap_or("no project id");
    let repo = p
        .repo
        .as_ref()
        .map(|r| r.display().to_string())
        .unwrap_or_else(|| "no checkout on this box".into());
    out.push(format!("{I1}{}  [{id}]  {repo}", p.key));
    master(s, p, out);
    match &p.skill {
        Some(k) => out.push(format!("{I2}skill    {}", skill_line(s, p, k))),
        None => out.push(format!(
            "{I2}skill    no checkout, so no installed skill to read"
        )),
    }
    if let Some(slug) = &p.cli {
        out.push(format!("{I2}cli      {}", slug_line(slug)));
    }
    releasable(s, p, out);
    match (runs, &s.ledger) {
        (_, Err(_)) => {}
        (None, Ok(v)) => out.push(format!(
            "{I2}runs     none holding a lease ← {} runs",
            v.path.display()
        )),
        (Some(runs), Ok(_)) => {
            out.push(format!("{I2}runs     {} holding a lease", runs.len()));
            for r in runs {
                run_line(s, r, out);
            }
        }
    }
}

fn master(s: &Snapshot, p: &Project, out: &mut Vec<String>) {
    let pane = match master_pane(s, p) {
        Ok(pane) => pane,
        Err(why) => {
            out.push(format!("{I2}master   {why}"));
            return ledger_master(s, p, out);
        }
    };
    out.push(match &s.sessions {
        Err(e) => format!("{I2}master   {pane}: {e}"),
        Ok(sessions) => match sessions.get(&pane) {
            Some(created) => format!(
                "{I2}master   {pane} running, started {} ← tmux list-sessions",
                ago(s.now_ms, created * 1000)
            ),
            None => format!("{I2}master   {pane} not running ← tmux list-sessions"),
        },
    });
    ledger_master(s, p, out);
}

/// The name the daemon gives this project's master pane: `forge-master-` and
/// core's slug for it (`daemon/master.rs`, from the runner row). Where that
/// slug cannot be read, the name the ledger recorded for the pane it placed,
/// and where neither can, why — a binding's own key is not the pane's name.
fn master_pane(s: &Snapshot, p: &Project) -> Result<String, String> {
    if let Some(slug) = p.core_slug.as_deref() {
        return Ok(terminal::session_name(terminal::MASTER_PREFIX, slug));
    }
    let recorded = match (&s.ledger, p.project_id.as_deref()) {
        (Ok(v), Some(id)) => Ok(v.masters.get(id).map(|m| m.pane_name.clone())),
        (Ok(_), None) => Ok(None),
        (Err(e), _) => Err(e),
    };
    match (recorded, &s.discovery) {
        (Ok(Some(pane)), _) => Ok(pane),
        (_, Ok(_)) => Err(
            "no pane — core does not serve this project to this box, so the daemon places no master for it".into(),
        ),
        (Ok(None), Err(_)) => Err(
            "its pane cannot be named: core's slug for this project is unreadable, above, and the ledger records no master for it".into(),
        ),
        (Err(e), Err(_)) => Err(format!(
            "its pane cannot be named: core's slug for this project is unreadable, above, and the ledger, which records the pane the daemon placed, is {e}"
        )),
    }
}

fn ledger_master(s: &Snapshot, p: &Project, out: &mut Vec<String>) {
    let Some(id) = p.project_id.as_deref() else {
        return;
    };
    let view = match &s.ledger {
        Ok(v) => v,
        Err(e) => {
            return out.push(format!(
            "{I3}   ledger: {e}, so when the daemon last placed and saw this master cannot be said"
        ))
        }
    };
    if let Some(m) = view.masters.get(id) {
        out.push(format!(
            "{I3}   ledger: conversation cold-started {}, last seen {}, session {} ← masters",
            ago(s.now_ms, m.cold_started_at * 1000),
            ago(s.now_ms, m.last_seen_at * 1000),
            m.session_id.as_deref().map(short).unwrap_or("unrecorded")
        ));
    }
}

fn skill_line(s: &Snapshot, p: &Project, k: &Skill) -> String {
    match k {
        Skill::Absent { path } => format!(
            "no file at {} — no master was placed from this checkout",
            path.display()
        ),
        Skill::Unreadable(e) => e.to_string(),
        Skill::Read {
            path,
            bytes,
            written_ms,
            matches,
        } => {
            let written = match written_ms {
                Ok(w) => ago(s.now_ms, *w),
                Err(e) => format!("at a time that is {e}"),
            };
            let verdict = match matches {
                Ok(true) => "is the forge-master asset of the binary the daemon runs ← its /proc/<pid>/exe".to_string(),
                Ok(false) if pane_started_ms(s, p).is_some() => "DRIFT — is NOT the forge-master asset of the binary the daemon runs, so this pane stands on another build's skill ← its /proc/<pid>/exe".to_string(),
                // No pane stands on it, and placing one writes the asset over it.
                Ok(false) => "DRIFT — is NOT the forge-master asset of the binary the daemon runs; no running master pane is seen on it, and the daemon writes its own asset over it when it places one ← its /proc/<pid>/exe".to_string(),
                Err(e) => format!("cannot be judged: {e}"),
            };
            let mut line = format!(
                "{} ({bytes} B, written {written}) {verdict}",
                path.display()
            );
            // The daemon writes the file and starts the pane within the same
            // second or two, so only a write well after the start is a rewrite
            // the running pane may not have loaded.
            if let (Ok(w), Some(started)) = (written_ms, pane_started_ms(s, p)) {
                if *w > started + REWRITE_AFTER_MS {
                    line.push_str(&format!(
                        "; written {} AFTER its pane started {}, so the pane may hold an earlier copy",
                        ago(s.now_ms, *w),
                        ago(s.now_ms, started)
                    ));
                }
            }
            line
        }
    }
}

fn pane_started_ms(s: &Snapshot, p: &Project) -> Option<i64> {
    let pane = master_pane(s, p).ok()?;
    s.sessions.as_ref().ok()?.get(&pane).map(|c| c * 1000)
}

fn slug_line(slug: &Slug) -> String {
    match slug {
        Slug::Matches { record, slug } => format!("slug `{slug}` is core's slug for this project ← {}", record.display()),
        Slug::Drift { record, cli, core } => format!(
            "SLUG DRIFT — the forge CLI here resolves `{cli}`, and core's slug for the bound project is `{core}`, so every `forge` call from this checkout reaches another project ← {}",
            record.display()
        ),
        Slug::NoRecord { record } => format!(
            "no forge CLI project record at {}, so the CLI here resolves no project",
            record.display()
        ),
        Slug::CoreUnknown { record, cli } => format!(
            "the CLI here resolves `{cli}` ← {}; core's slug could not be read, so whether that is this project cannot be said",
            record.display()
        ),
        Slug::Unreadable(e) => e.to_string(),
    }
}

fn releasable(s: &Snapshot, p: &Project, out: &mut Vec<String>) {
    let Some(core) = project_core(s, p) else {
        return;
    };
    if let Ok(a) = &core.awaiting {
        if a.total > 0 && a.blockers.as_ref().is_ok_and(Vec::is_empty) {
            out.push(format!(
                "{I2}release  {} at awaiting_release ({}), releasable: release-readiness names no blocker ← GET /api/projects/{}/release-readiness",
                a.total,
                keys(&a.keys),
                p.project_id.as_deref().unwrap_or("")
            ));
        }
    }
}

fn project_core<'a>(s: &'a Snapshot, p: &Project) -> Option<&'a ProjectCore> {
    let (_, all) = s.core.as_ref().ok()?;
    all.get(p.project_id.as_deref()?)
}

fn run_line(s: &Snapshot, r: &Run, out: &mut Vec<String>) {
    let keys = r.held_keys().join(",");
    let tree = match s.trees.get(&r.worktree_path) {
        None => "not walked yet".to_string(),
        Some((at, age)) => tree_line(s.now_ms, *at, age),
    };
    out.push(format!(
        "{I3}{keys}  run {}  {tree} ← {}",
        short(&r.run_id),
        r.worktree_path.display()
    ));
    if let Some(notice) = &r.kept_notice {
        out.push(format!(
            "{I3}   the daemon's last word on it: `{notice}` ← runs.kept_notice"
        ));
    }
}

pub fn tree_line(now: i64, measured: i64, age: &TreeAge) -> String {
    let when = if now - measured > 1_000 {
        format!(" (walked {})", ago(now, measured))
    } else {
        String::new()
    };
    match age {
        TreeAge::Gone => "no worktree on disk at this path".to_string(),
        TreeAge::NoFiles {
            entries,
            unread: 0,
            capped: false,
            ..
        } => format!("no file under the worktree ({entries} entries read){when}"),
        TreeAge::NoFiles {
            entries,
            unread,
            first_unread,
            capped,
        } => {
            let mut l = format!("no file read under the worktree ({entries} entries)");
            if *capped {
                l.push_str(&format!(
                    " — PARTIAL: the walk stopped at {entries} entries, so a file may be unread"
                ));
            }
            if *unread > 0 {
                l.push_str(&format!(
                    " — PARTIAL: {unread} entr(ies) could not be read, so a file may be among them"
                ));
                if let Some(first) = first_unread {
                    l.push_str(&format!(" (first: UNREADABLE — {first})"));
                }
            }
            l.push_str(&when);
            l
        }
        TreeAge::Unreadable(e) => format!("worktree UNREADABLE — {e}"),
        TreeAge::Newest {
            at_ms,
            path,
            entries,
            capped,
            unread,
            first_unread,
        } => {
            let mut l = format!("newest write {}: {}", ago(now, *at_ms), path.display());
            if *capped {
                l.push_str(&format!(
                    " — PARTIAL: the walk stopped at {entries} entries, so a newer file may be unread"
                ));
            } else {
                l.push_str(&format!(" ({entries} entries)"));
            }
            if *unread > 0 {
                l.push_str(&format!(
                    " — PARTIAL: {unread} entr(ies) could not be read, so a newer file may be among them"
                ));
                if let Some(first) = first_unread {
                    l.push_str(&format!(" (first: UNREADABLE — {first})"));
                }
            }
            l.push_str(&when);
            l
        }
    }
}

fn waiting(s: &Snapshot, out: &mut Vec<String>) {
    out.push("WAITING ON A PERSON".into());
    questions(s, out);
    jobs(s, out);
    parked(s, out);
    releases(s, out);
}

fn core_age(s: &Snapshot) -> String {
    match &s.core {
        Ok((at, _)) => asked(s.now_ms, *at),
        Err(_) => String::new(),
    }
}

/// How old a kept answer is, where it is old enough to say.
fn asked(now: i64, at: i64) -> String {
    if now - at > 1_000 {
        format!(" (asked {})", ago(now, at))
    } else {
        String::new()
    }
}

fn questions(s: &Snapshot, out: &mut Vec<String>) {
    let (_, all) = match &s.core {
        Err(e) => return out.push(format!("{I1}questions  {e}")),
        Ok(c) => c,
    };
    let (mut any, mut unread) = (false, 0usize);
    for p in &s.projects {
        let core = match core_of(p, all) {
            Ok(c) => c,
            Err(why) => {
                unread += 1;
                out.push(format!("{I1}questions  {}: {why}", p.key));
                continue;
            }
        };
        match &core.questions {
            Err(e) => {
                unread += 1;
                out.push(format!("{I1}questions  {}: {e}", p.key))
            }
            Ok(q) if q.total == 0 => {}
            Ok(q) => {
                any = true;
                out.push(format!(
                    "{I1}questions  {}: {} open{} ← GET /api/questions?projectId={}&status=open",
                    p.key,
                    q.total,
                    core_age(s),
                    p.project_id.as_deref().unwrap_or("")
                ));
                for one in &q.listed {
                    let prompt = if one.prompt.is_empty() {
                        "(the question holds no step yet)"
                    } else {
                        one.prompt.as_str()
                    };
                    let age = one
                        .asked_ms
                        .map(|a| ago(s.now_ms, a))
                        .unwrap_or_else(|| "at an unreadable time".into());
                    out.push(format!(
                        "{I3}{} blocker, asked {age}, question {}: {prompt}",
                        one.blocker_kind, one.id
                    ));
                }
            }
        }
    }
    if !any && unread == 0 {
        out.push(format!(
            "{I1}questions  none open on any project listed{} ← GET /api/questions per project",
            core_age(s)
        ));
    } else if !any {
        out.push(partial(
            "questions",
            s,
            unread,
            "has an open question",
            "GET /api/questions per project",
        ));
    }
}

/// The summary under a section where some projects were not read: it opens
/// with what was not read, since a line opening "none" reads as an all-clear
/// to anyone who stops there, and a count of none read claims nothing at all.
fn partial(label: &str, s: &Snapshot, unread: usize, what: &str, route: &str) -> String {
    let listed = s.projects.len();
    let read = listed - unread;
    let tail = if read == 0 {
        "none was read, so nothing is said of any".to_string()
    } else {
        format!("of the {read} read, none {what}")
    };
    format!(
        "{I1}{label:<10} PARTIAL — {unread} of {listed} project(s) not read, named above; {tail}{} ← {route}",
        core_age(s)
    )
}

fn jobs(s: &Snapshot, out: &mut Vec<String>) {
    let jobs = match &s.jobs {
        Err(e) => return out.push(format!("{I1}job panes  {e}")),
        Ok(j) => j,
    };
    for e in &jobs.unreadable {
        out.push(format!("{I1}job panes  {e}"));
    }
    let waiting: Vec<_> = jobs
        .records
        .iter()
        .filter_map(|j| j.waiting_since().map(|at| (j, at)))
        .collect();
    if waiting.is_empty() && !jobs.unreadable.is_empty() {
        out.push(format!(
            "{I1}job panes  none of the {} readable record(s) reports waiting — PARTIAL: {} could not be read, so one may wait ← {}",
            jobs.records.len(),
            jobs.unreadable.len(),
            jobs.dir.display()
        ));
    } else if waiting.is_empty() {
        out.push(format!(
            "{I1}job panes  none reports waiting on a permission answer ← {} job record(s) in {}{}",
            jobs.records.len(),
            jobs.dir.display(),
            if jobs.absent {
                " (no such directory)"
            } else {
                ""
            }
        ));
    }
    for (j, at) in waiting {
        out.push(format!(
            "{I1}job panes  {} (job {}) has waited {} on a permission answer ← {}/{}.json",
            j.pane,
            short(&j.job_id),
            span(s.now_ms - at),
            jobs.dir.display(),
            j.job_id
        ));
    }
}

fn parked(s: &Snapshot, out: &mut Vec<String>) {
    let Ok(view) = &s.ledger else {
        return out.push(format!(
            "{I1}parked     {}",
            s.ledger
                .as_ref()
                .err()
                .map(ToString::to_string)
                .unwrap_or_default()
        ));
    };
    let parked: Vec<&Run> = view
        .runs
        .iter()
        .filter(|r| r.parked_on_a_person())
        .collect();
    if parked.is_empty() {
        out.push(format!(
            "{I1}parked     no run is parked on a person ← {} runs",
            view.path.display()
        ));
    }
    for r in parked {
        let keys: Vec<&str> = r.issues.iter().map(|(k, _)| k.as_str()).collect();
        out.push(format!(
            "{I1}parked     {} run {} waits on {} ← runs",
            keys.join(","),
            short(&r.run_id),
            r.waiting_on
                .as_deref()
                .unwrap_or("an answer it did not record")
        ));
    }
}

fn releases(s: &Snapshot, out: &mut Vec<String>) {
    let (_, all) = match &s.core {
        Err(e) => return out.push(format!("{I1}releases   {e}")),
        Ok(c) => c,
    };
    let (mut any, mut unread) = (false, 0usize);
    for p in &s.projects {
        let core = match core_of(p, all) {
            Ok(c) => c,
            Err(why) => {
                unread += 1;
                out.push(format!("{I1}releases   {}: {why}", p.key));
                continue;
            }
        };
        let id = p.project_id.as_deref().unwrap_or("");
        match &core.awaiting {
            Err(e) => {
                unread += 1;
                out.push(format!("{I1}releases   {}: {e}", p.key))
            }
            Ok(a) if a.total == 0 => {}
            Ok(a) => match &a.blockers {
                Err(e) => {
                    any = true;
                    out.push(format!(
                        "{I1}releases   {}: {} at awaiting_release ({}), and whether a release can start: {e}",
                        p.key,
                        a.total,
                        keys(&a.keys)
                    ));
                }
                Ok(b) if b.is_empty() => {}
                Ok(b) => {
                    any = true;
                    out.push(format!(
                        "{I1}releases   {}: {} at awaiting_release ({}) with no release path: {} — {}{} ← GET /api/projects/{id}/release-readiness",
                        p.key,
                        a.total,
                        keys(&a.keys),
                        b[0].code,
                        b[0].message,
                        core_age(s)
                    ));
                    if b.len() > 1 {
                        let codes: Vec<&str> = b[1..].iter().map(|x| x.code.as_str()).collect();
                        out.push(format!(
                            "{I3}and {} more blocker(s): {}",
                            b.len() - 1,
                            codes.join(", ")
                        ));
                    }
                }
            },
        }
    }
    if !any && unread == 0 {
        out.push(format!(
            "{I1}releases   no issue rests at awaiting_release without a release path{} ← GET /api/projects/:id/issues?status=awaiting_release per project",
            core_age(s)
        ));
    } else if !any {
        out.push(partial(
            "releases",
            s,
            unread,
            "rests at awaiting_release without a release path",
            "GET /api/projects/:id/issues?status=awaiting_release per project",
        ));
    }
}

/// Core's answer for one project, or why there is none to show: a binding
/// with no project id is never asked, and an id core's reads did not answer
/// is a read that did not finish. Neither is a project with nothing waiting.
fn core_of<'a>(
    p: &Project,
    all: &'a BTreeMap<String, ProjectCore>,
) -> Result<&'a ProjectCore, String> {
    let Some(id) = p.project_id.as_deref() else {
        return Err(
            "not asked — its binding names no project id, so core cannot be asked about it".into(),
        );
    };
    all.get(id)
        .ok_or_else(|| format!("UNREADABLE — core's reads for project {id} did not finish"))
}

fn health(s: &Snapshot, out: &mut Vec<String>) {
    out.push("HEALTH".into());
    if s.gate.is_empty() {
        out.push(format!(
            "{I1}gate       no degraded or undeclared dispatch recorded ← {}",
            s.gate_source
        ));
    } else {
        out.extend(s.gate.iter().map(|l| format!("{I1}{l}")));
        out.push(format!("{I1}           ← {}", s.gate_source));
    }
    out.extend(s.pool.iter().map(|l| format!("{I1}{l}")));
    if !s.pool_source.is_empty() {
        out.push(format!("{I1}           ← {}", s.pool_source));
    }
    abandoned(s, out);
}

fn abandoned(s: &Snapshot, out: &mut Vec<String>) {
    let view = match &s.ledger {
        Err(e) => return out.push(format!("{I1}abandoned  {e}")),
        Ok(v) => v,
    };
    let found: Vec<(&Run, String)> = view
        .runs
        .iter()
        .filter_map(|r| {
            ledger_ro::abandoned_because(r, view, s.boot.as_deref()).map(|why| (r, why))
        })
        .collect();
    if found.is_empty() {
        let boot = if s.boot.is_some() {
            " on this boot"
        } else {
            " (this boot cannot be read, so boots were not compared)"
        };
        out.push(format!(
            "{I1}abandoned  none — every run holding a lease answers to its project's current master{boot} ← {} runs × masters",
            view.path.display()
        ));
    }
    for (r, why) in found {
        out.push(format!(
            "{I1}abandoned  {} run {} still holds its lease(s): {why} ← runs × masters",
            r.held_keys().join(","),
            short(&r.run_id)
        ));
    }
}

/// Every issue key: a row that waits is listed, never summarised.
fn keys(all: &[String]) -> String {
    all.join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd::top::gather::Project;
    use crate::cmd::top::source::Unreadable;
    use forge_runner_core::config::Config;

    const NOW: i64 = 1_790_726_400_000;

    fn snap(projects: Vec<Project>) -> Snapshot {
        let no = || Unreadable::new("test", "not planted");
        Snapshot {
            now_ms: NOW,
            config_path: "/c/config.toml".into(),
            config: Ok(Config::default()),
            binary: Vec::new(),
            discovery: Ok(Vec::new()),
            discovery_at: NOW,
            projects,
            ledger: Err(no()),
            boot: None,
            sessions: Err(no()),
            trees: Default::default(),
            jobs: Err(no()),
            core: Err(no()),
            gate: Vec::new(),
            gate_source: "/c/gate-marks.jsonl".into(),
            pool: Vec::new(),
            pool_source: String::new(),
        }
    }

    fn row(key: &str, id: &str, skill_at: &str) -> Project {
        Project {
            key: key.into(),
            project_id: Some(id.into()),
            core_slug: Some(key.into()),
            repo: Some(skill_at.into()),
            skill: Some(Skill::Absent {
                path: std::path::PathBuf::from(skill_at).join("SKILL.md"),
            }),
            cli: None,
        }
    }

    use crate::cmd::top::people::{AwaitingRelease, Blocker, Question, Questions};

    fn core_for(id: &str, questions: Vec<Question>, awaiting: AwaitingRelease) -> Snapshot {
        let mut s = snap(vec![row("alpha", id, "/repo/a")]);
        let mut all = BTreeMap::new();
        all.insert(
            id.to_string(),
            ProjectCore {
                questions: Ok(Questions {
                    total: questions.len() as u64,
                    listed: questions,
                }),
                awaiting: Ok(awaiting),
            },
        );
        s.core = Ok((NOW, all));
        s
    }

    fn nothing_awaiting() -> AwaitingRelease {
        AwaitingRelease {
            total: 0,
            keys: Vec::new(),
            blockers: Ok(Vec::new()),
        }
    }

    /// Criterion 14, as the judge planted it at d7da543: a first line of 245
    /// characters ending in the issue it waits for is shown whole, beside the
    /// id of the question it is.
    #[test]
    fn a_question_row_carries_its_whole_first_line_and_its_id() {
        let prompt = format!("{} waiting for ISS-45", "Ship it? ".repeat(25));
        assert!(prompt.chars().count() > 240);
        let s = core_for(
            "id-a",
            vec![Question {
                id: "0f9727e5-1111-4111-8111-111111111111".into(),
                blocker_kind: "human".into(),
                asked_ms: Some(NOW - 3_600_000),
                prompt: prompt.clone(),
            }],
            nothing_awaiting(),
        );
        let text = frame(&s, None).join("\n");
        assert!(
            text.contains(&format!(
                "human blocker, asked 1h ago, question 0f9727e5-1111-4111-8111-111111111111: {prompt}"
            )),
            "{text}"
        );
        assert!(!text.contains('…'), "nothing is clipped: {text}");
    }

    /// Criterion 17, as the judge planted it: the blocker's message is shown
    /// to its last sentence, where core says what is owed, and every other
    /// blocker is named by its code.
    #[test]
    fn a_release_blocker_is_shown_whole_and_the_rest_by_code() {
        let message = format!(
            "{}Owed: ISS-2 criteria 3 and 4.",
            "Every issue on the roster still owes a judging verdict. ".repeat(4)
        );
        assert!(message.chars().count() > 160);
        let s = core_for(
            "id-a",
            Vec::new(),
            AwaitingRelease {
                total: 1,
                keys: vec!["ISS-2".into()],
                blockers: Ok(vec![
                    Blocker {
                        code: "RELEASE_CRITERIA_UNEARNED".into(),
                        message: message.clone(),
                    },
                    Blocker {
                        code: "NO_RUNNER_ONLINE".into(),
                        message: "m".into(),
                    },
                ]),
            },
        );
        let text = frame(&s, None).join("\n");
        assert!(
            text.contains(&format!("RELEASE_CRITERIA_UNEARNED — {message}")),
            "{text}"
        );
        assert!(
            text.contains("and 1 more blocker(s): NO_RUNNER_ONLINE"),
            "{text}"
        );
    }

    /// Criterion 22, as the judge planted it: with core's slug and the ledger
    /// both unread, the master line says the ledger could not be read, never
    /// that it records no master.
    #[test]
    fn an_unread_ledger_is_never_said_to_record_no_master() {
        let mut s = snap(vec![Project {
            core_slug: None,
            ..row("alpha", "id-a", "/repo/a")
        }]);
        s.discovery = Err(Unreadable::new("GET /api/devices/me/runners", "401"));
        s.ledger = Err(Unreadable::new(
            "/d/ledger.sqlite",
            "unable to open database file",
        ));
        let text = frame(&s, None).join("\n");
        assert!(!text.contains("records no master"), "{text}");
        assert!(
            text.contains("and the ledger, which records the pane the daemon placed, is UNREADABLE — /d/ledger.sqlite: unable to open database file"),
            "{text}"
        );
        assert!(
            text.contains("ledger: UNREADABLE — /d/ledger.sqlite"),
            "{text}"
        );
    }

    /// Criterion 22, the other shape: core names the pane and the ledger is
    /// unread. The ledger line says so rather than dropping out unexplained.
    #[test]
    fn an_unread_ledger_leaves_a_line_under_a_named_master() {
        let mut s = snap(vec![row("alpha", "id-a", "/repo/a")]);
        s.ledger = Err(Unreadable::new("/d/ledger.sqlite", "not a database"));
        s.sessions = Ok(Default::default());
        let text = frame(&s, None).join("\n");
        assert!(
            text.contains("master   forge-master-alpha not running"),
            "{text}"
        );
        assert!(
            text.contains("ledger: UNREADABLE — /d/ledger.sqlite: not a database, so when the daemon last placed and saw this master cannot be said"),
            "{text}"
        );
    }

    /// The judge's finding on criterion 22: where no project's questions or
    /// roster could be read, the summary opens with that, not with "none".
    #[test]
    fn a_section_no_project_answered_does_not_open_with_none() {
        let mut s = snap(vec![
            row("alpha", "id-a", "/repo/a"),
            row("beta", "id-b", "/repo/b"),
        ]);
        s.core = Ok((NOW, BTreeMap::new()));
        let text = frame(&s, None).join("\n");
        let waiting = text.split("WAITING ON A PERSON").nth(1).unwrap();
        assert!(
            waiting.contains("questions  PARTIAL — 2 of 2 project(s) not read, named above; none was read, so nothing is said of any"),
            "{waiting}"
        );
        assert!(
            waiting.contains(
                "releases   PARTIAL — 2 of 2 project(s) not read, named above; none was read"
            ),
            "{waiting}"
        );
        assert!(!waiting.contains("questions  none"), "{waiting}");
        assert!(!waiting.contains("releases   none"), "{waiting}");
    }

    /// The judge's finding on criterion 9: a drifted skill with no pane
    /// running on it is not said to have a pane standing on it.
    #[test]
    fn a_drifted_skill_with_no_pane_names_no_pane() {
        let drifted = |running: bool| {
            let mut s = snap(vec![Project {
                skill: Some(Skill::Read {
                    path: "/repo/a/SKILL.md".into(),
                    bytes: 9,
                    written_ms: Ok(NOW - 60_000),
                    matches: Ok(false),
                }),
                ..row("alpha", "id-a", "/repo/a")
            }]);
            let mut panes = crate::cmd::top::panes::Sessions::new();
            if running {
                panes.insert("forge-master-alpha".into(), NOW / 1000 - 30);
            }
            s.sessions = Ok(panes);
            frame(&s, None).join("\n")
        };
        let idle = drifted(false);
        assert!(
            idle.contains("DRIFT — is NOT the forge-master asset"),
            "{idle}"
        );
        assert!(!idle.contains("this pane stands"), "{idle}");
        assert!(
            idle.contains("no running master pane is seen on it"),
            "{idle}"
        );
        let live = drifted(true);
        assert!(
            live.contains("so this pane stands on another build's skill"),
            "{live}"
        );
    }

    /// Whole-set consult at 6fdc929, F1: a run naming no project this box
    /// knows is listed once, as a stray, and never under a binding that names
    /// no project id.
    #[test]
    fn a_stray_run_is_not_attributed_to_a_binding_with_no_project_id() {
        let mut s = snap(vec![Project {
            key: "loose".into(),
            project_id: None,
            core_slug: None,
            repo: None,
            skill: None,
            cli: None,
        }]);
        s.ledger = Ok(ledger_ro::View {
            path: "/l/ledger.sqlite".into(),
            runs: vec![Run {
                run_id: "run-stray1".into(),
                project_id: Some("id-nobody-knows".into()),
                master_session_id: "m".into(),
                boot_id: "b".into(),
                worktree_path: "/w/stray".into(),
                worktree_gone_at: None,
                released_as: None,
                ended_by: None,
                kept_notice: None,
                incarnation: "live".into(),
                work: "runnable".into(),
                blocker_kind: None,
                waiting_on: None,
                created_at: 0,
                issues: vec![("ISS-9".into(), true)],
            }],
            masters: Default::default(),
        });
        let text = frame(&s, None).join("\n");
        let projects = text.split("WAITING ON A PERSON").next().unwrap();
        assert_eq!(projects.matches("run-stra").count(), 1, "{projects}");
        let stray = projects
            .find("(runs naming no project this box knows)")
            .expect("stray heading");
        assert!(projects[stray..].contains("run-stra"), "{projects}");
        assert!(
            projects.contains("runs     none holding a lease"),
            "the binding holds none: {projects}"
        );
    }

    /// Whole-set consult at 4505806, F1: an answer kept from an earlier frame
    /// says how old it is.
    #[test]
    fn a_kept_project_list_says_how_old_it_is() {
        let mut s = snap(Vec::new());
        let head = |s: &Snapshot| frame(s, None).join("\n");
        assert!(!head(&s).contains("(asked"), "{}", head(&s));
        s.discovery_at = NOW - 30_000;
        assert!(
            head(&s).contains("0 served to this box (asked 30s ago) ← GET /api/devices/me/runners"),
            "{}",
            head(&s)
        );
    }

    /// Whole-set consult at 4505806, F2: two rows sharing a display key each
    /// show their own reading, never the other's.
    #[test]
    fn rows_that_share_a_key_keep_their_own_readings() {
        let s = snap(vec![
            row("alpha", "id-a", "/repo/a"),
            row("alpha", "id-b", "/repo/b"),
        ]);
        let text = frame(&s, None).join("\n");
        assert!(
            ["/repo/a", "/repo/b"]
                .iter()
                .all(|r| text.contains(&format!(
                    "no file at {}",
                    std::path::PathBuf::from(r).join("SKILL.md").display()
                ))),
            "{text}"
        );
    }

    /// Criterion 7: a walk that did not see the whole tree says PARTIAL even
    /// where it met no file, and a whole walk with no file says so plainly.
    #[test]
    fn a_walk_that_met_no_file_says_partial_when_it_did_not_see_everything() {
        let line = |capped, unread| {
            tree_line(
                0,
                0,
                &TreeAge::NoFiles {
                    entries: 7,
                    unread,
                    first_unread: (unread > 0).then(|| "a/b: Permission denied".to_string()),
                    capped,
                },
            )
        };
        assert_eq!(
            line(false, 0),
            "no file under the worktree (7 entries read)"
        );
        assert!(line(true, 0).contains("PARTIAL: the walk stopped at 7 entries"));
        assert!(line(false, 2).contains("PARTIAL: 2 entr(ies) could not be read"));
        assert!(
            line(false, 2).contains("(first: UNREADABLE — a/b: Permission denied)"),
            "{}",
            line(false, 2)
        );
        assert!(!line(true, 0).starts_with("no file under the worktree"));
    }

    /// Consult f10906 F1: a walk that found a newest file and could not read
    /// some entries names the first of them with its reason.
    #[test]
    fn a_partial_walk_with_a_newest_file_names_what_it_could_not_read() {
        let l = tree_line(
            0,
            0,
            &TreeAge::Newest {
                at_ms: 0,
                path: "src/a.rs".into(),
                entries: 9,
                capped: false,
                unread: 3,
                first_unread: Some("node_modules/x: Permission denied".into()),
            },
        );
        assert!(
            l.contains("PARTIAL: 3 entr(ies) could not be read")
                && l.contains("(first: UNREADABLE — node_modules/x: Permission denied)"),
            "{l}"
        );
    }
}
