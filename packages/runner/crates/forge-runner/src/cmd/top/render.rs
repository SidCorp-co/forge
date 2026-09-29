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
            "PROJECTS  {bound} bound ← {}; {} served to this box ← GET /api/devices/me/runners",
            s.config_path,
            served.len()
        ),
        (Ok(_), Err(e)) => format!(
            "PROJECTS  {e}. Listed are only the {bound} project(s) bound in {}; any core serves this box beyond them cannot be seen",
            s.config_path
        ),
    });
    if s.projects.is_empty() {
        out.push(format!(
            "{I1}no project is bound here or served to this box"
        ));
    }
    let runs = runs_by_project(s);
    for p in &s.projects {
        project(s, p, runs.get(p.project_id.as_deref().unwrap_or("")), out);
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
    match s.skills.get(&p.key) {
        Some(k) => out.push(format!("{I2}skill    {}", skill_line(s, p, k))),
        None => out.push(format!(
            "{I2}skill    no checkout, so no installed skill to read"
        )),
    }
    if let Some(slug) = s.slugs.get(&p.key) {
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
    let slug = p.core_slug.as_deref().unwrap_or(&p.key);
    let pane = terminal::session_name(terminal::MASTER_PREFIX, slug);
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
    let Ok(view) = &s.ledger else { return };
    let Some(id) = p.project_id.as_deref() else {
        return;
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
                Ok(false) => "DRIFT — is NOT the forge-master asset of the binary the daemon runs, so this pane stands on another build's skill ← its /proc/<pid>/exe".to_string(),
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
    let slug = p.core_slug.as_deref().unwrap_or(&p.key);
    let pane = terminal::session_name(terminal::MASTER_PREFIX, slug);
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
        TreeAge::NoFiles { entries, unread: 0 } => {
            format!("no file under the worktree ({entries} entries read){when}")
        }
        TreeAge::NoFiles { entries, unread } => format!(
            "no file read under the worktree ({entries} entries) — PARTIAL: {unread} entr(ies) could not be read, so a file may be among them{when}"
        ),
        TreeAge::Unreadable(e) => format!("worktree UNREADABLE — {e}"),
        TreeAge::Newest {
            at_ms,
            path,
            entries,
            capped,
            unread,
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
        Ok((at, _)) if s.now_ms - at > 1_000 => format!(" (asked {})", ago(s.now_ms, *at)),
        _ => String::new(),
    }
}

fn questions(s: &Snapshot, out: &mut Vec<String>) {
    let (_, all) = match &s.core {
        Err(e) => return out.push(format!("{I1}questions  {e}")),
        Ok(c) => c,
    };
    let mut any = false;
    for p in &s.projects {
        let Some(core) = p.project_id.as_deref().and_then(|id| all.get(id)) else {
            continue;
        };
        match &core.questions {
            Err(e) => out.push(format!("{I1}questions  {}: {e}", p.key)),
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
                        "(the question holds no step yet)".to_string()
                    } else {
                        clip(&one.prompt, 110)
                    };
                    let age = one
                        .asked_ms
                        .map(|a| ago(s.now_ms, a))
                        .unwrap_or_else(|| "at an unreadable time".into());
                    out.push(format!(
                        "{I3}{} blocker, asked {age}: {}",
                        one.blocker_kind, prompt
                    ));
                }
            }
        }
    }
    if !any {
        out.push(format!(
            "{I1}questions  none open on any project listed{} ← GET /api/questions per project",
            core_age(s)
        ));
    }
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
    let mut any = false;
    for p in &s.projects {
        let Some(core) = p.project_id.as_deref().and_then(|id| all.get(id)) else {
            continue;
        };
        let id = p.project_id.as_deref().unwrap_or("");
        match &core.awaiting {
            Err(e) => out.push(format!("{I1}releases   {}: {e}", p.key)),
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
                        clip(&b[0].message, 160),
                        core_age(s)
                    ));
                    if b.len() > 1 {
                        out.push(format!("{I3}and {} more blocker(s)", b.len() - 1));
                    }
                }
            },
        }
    }
    if !any {
        out.push(format!(
            "{I1}releases   no issue rests at awaiting_release without a release path{} ← GET /api/projects/:id/issues?status=awaiting_release per project",
            core_age(s)
        ));
    }
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

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
    out.push('…');
    out
}
