use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::daemon::degraded::RECENT_WITHIN_MS;
use forge_runner_core::proto_gate::{Condition, Last, Verdict};
use forge_runner_core::daemon::pool_reads;
use forge_runner_core::runner::ledger::{short_id, Ledger, Unanswered, WhatEndsIt};

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {}

pub async fn run(ctx: Ctx, _args: Args) -> anyhow::Result<()> {
    let cfg = Config::load()?;
    println!(
        "binary     {} ({}) — the file this command ran",
        forge_runner_core::update::VERSION_LINE,
        forge_runner_core::update::BUILD_TARGET
    );
    for line in daemon_lines() {
        println!("{line}");
    }
    println!(
        "core_url   {}",
        ctx.resolve_core_url(&cfg).unwrap_or_else(|| "—".into())
    );
    println!(
        "paired     {}",
        cfg.device_id
            .as_deref()
            .unwrap_or("not yet (forge-runner login)")
    );
    println!("token      {}", cred_store::active_backend());
    print_gate(&cfg);
    print_pool(&cfg);
    let now = forge_runner_core::daemon::agent_activity::now_ms();
    for line in skill_lines(
        forge_runner_core::config::config_dir().as_deref(),
        &cfg,
        now,
    ) {
        println!("{line}");
    }
    match Ledger::default_path() {
        Ok(path) => {
            for line in unanswered_runs(&path, &cfg) {
                println!("{line}");
            }
        }
        Err(e) => println!("runs       no ledger path resolves on this box: {e}"),
    }
    if cfg.bindings.is_empty() {
        println!("bindings   —");
    } else {
        println!("bindings");
        for (slug, b) in &cfg.bindings {
            println!(
                "  {slug}  →  {}  [project_id: {}]",
                b.repo_path.display(),
                b.project_id.as_deref().unwrap_or("UNSET")
            );
        }
    }
    Ok(())
}

/// What the running daemon serves, which is not what this binary is once a
/// self-update has replaced the file under it (ISS-1223).
fn daemon_lines() -> Vec<String> {
    use forge_runner_core::daemon::serving;
    let Some(dir) = forge_runner_core::config::config_dir() else {
        return vec![
            "daemon     no config directory resolves on this box, so no daemon record can be read"
                .to_string(),
        ];
    };
    serving::lines(
        &serving::read(&dir),
        &serving::Probe::this_box(),
        forge_runner_core::update::CURRENT_VERSION,
        forge_runner_core::update::BUILD_COMMIT,
        forge_runner_core::daemon::agent_activity::now_ms(),
    )
}

/// The sentence `--version` adds on stderr where a live daemon serves another
/// build than this binary's.
pub fn version_note() -> Option<String> {
    use forge_runner_core::daemon::serving;
    let dir = forge_runner_core::config::config_dir()?;
    serving::version_note(
        &serving::read(&dir),
        &serving::Probe::this_box(),
        forge_runner_core::update::CURRENT_VERSION,
        forge_runner_core::update::BUILD_COMMIT,
    )
}

fn print_gate(cfg: &Config) {
    let _ = cfg;
    let Some(dir) = forge_runner_core::config::config_dir() else {
        return;
    };
    let now = forge_runner_core::daemon::agent_activity::now_ms();
    for line in gate_reading(&dir, now) {
        println!("{line}");
    }
}

/// What `status` and `top` both print about the gate. `degraded::tally` reads
/// a marks file it cannot open, and a line it cannot parse, as no mark at all,
/// and a box with no marks prints nothing — so an unreadable record would read
/// as a gate that never failed open. That is said here instead (ISS-1341).
pub(crate) fn gate_reading(dir: &std::path::Path, now: i64) -> Vec<String> {
    let path = forge_runner_core::daemon::degraded::marks_path(dir);
    let unparsed = match std::fs::read_to_string(&path) {
        Ok(body) => body
            .lines()
            .filter(|l| serde_json::from_str::<serde_json::Value>(l).is_err())
            .count(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => {
            return vec![format!(
                "gate       UNREADABLE — {}: {e}. How many dispatches went through undecided cannot be said",
                path.display()
            )]
        }
    };
    let report = forge_runner_core::daemon::degraded::report(dir, now);
    let mut out = gate_lines(&report.degraded, &report.undeclared);
    if unparsed > 0 {
        out.push(format!(
            "gate       {unparsed} line(s) of {} do not parse and are not in the counts above",
            path.display()
        ));
    }
    out
}

fn print_pool(cfg: &Config) {
    let Some(dir) = forge_runner_core::config::config_dir() else {
        return;
    };
    let now = forge_runner_core::daemon::agent_activity::now_ms();
    for line in pool_lines(&pool_reads::report(&dir, now), cfg, now) {
        println!("{line}");
    }
}

/// The name an operator knows a project by where this box binds it, else its id.
fn project_label(cfg: &Config, project_id: &str) -> String {
    cfg.bindings
        .iter()
        .find(|(_, b)| b.project_id.as_deref() == Some(project_id))
        .map(|(slug, _)| slug.clone())
        .unwrap_or_else(|| project_id.to_string())
}

/// The runs no master on this box answers for, read without writing the
/// ledger. Every pane's `run close` refuses such a run as another master's, so
/// this is where an operator is told of it, and of what will end it
/// (ISS-1355). A ledger that cannot be read says so rather than reading as
/// none.
fn unanswered_runs(path: &std::path::Path, cfg: &Config) -> Vec<String> {
    if !path.exists() {
        return vec![format!(
            "runs       no ledger at {} — a daemon creates it at its first start, so no run can be read",
            path.display()
        )];
    }
    let read = Ledger::open_read_only(path).and_then(|led| led.runs_no_master_answers_for());
    match read {
        Ok(runs) => unanswered_lines(&runs, cfg),
        Err(e) => vec![format!(
            "runs       UNREADABLE — {}: {e}. Which runs no master answers for cannot be said",
            path.display()
        )],
    }
}

fn unanswered_lines(runs: &[Unanswered], cfg: &Config) -> Vec<String> {
    if runs.is_empty() {
        return vec!["runs       none that no master on this box answers for".to_string()];
    }
    let mut out = vec![format!(
        "runs       {} no master on this box answers for — `run close` refuses each as another master's",
        runs.len()
    )];
    for u in runs {
        let project = u
            .run
            .project_id
            .as_deref()
            .map(|p| project_label(cfg, p))
            .unwrap_or_else(|| "no project".to_string());
        let keys = u
            .issues
            .iter()
            .map(|m| m.issue_key.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        out.push(format!(
            "  {}  {project}  {keys}  declared under {} — {}",
            u.run.run_id,
            short_id(&u.run.master_session_id),
            what_ends(u)
        ));
    }
    out
}

fn what_ends(u: &Unanswered) -> String {
    match u.what_ends_it() {
        WhatEndsIt::NextSweep => "its marks close it, so the next recovery sweep ends it".into(),
        WhatEndsIt::SessionOver => {
            "core has not called its session over; recovery releases it once it does".into()
        }
        WhatEndsIt::OperatorRelease => format!(
            "its release was given up on; `forge-runner run release {}` has the next sweep try again",
            u.run.run_id
        ),
        WhatEndsIt::CheckoutRelease => "recovery still owes its checkout back".into(),
        WhatEndsIt::LeasesBack(keys) => format!(
            "its checkout is back and its session over; recovery is still reading its lease on {} back",
            keys.join(", ")
        ),
        WhatEndsIt::NothingNoProject => {
            "nothing on this box: its row records no project, so no sweep can tie it to a master"
                .into()
        }
        WhatEndsIt::NothingMasterUnknown => format!(
            "only its project's master pane, whose session this ledger does not record: `forge-runner run close {}` from that pane, if it declared it",
            u.run.run_id
        ),
    }
}

/// What `status` and `doctor` both print about this box's pool reads. An empty
/// record says no failure is recorded and claims nothing more: a box that never
/// read a pool has no failures either (ISS-1234). An unreadable one says so,
/// and what it costs while it stands.
pub fn pool_lines(
    record: &Result<Vec<forge_runner_core::proto_pool::Condition>, pool_reads::Unreadable>,
    cfg: &Config,
    now: i64,
) -> Vec<String> {
    let conditions = match record {
        Ok(conditions) => conditions,
        Err(e) => {
            return vec![format!(
            "pool       UNREADABLE — {e}. The heartbeat carries no pool report while it stands, \
                 so core keeps the last one it stored, and no failed read is recorded; \
                 remove the file to start a fresh record"
        )]
        }
    };
    if conditions.is_empty() {
        return vec![format!(
            "pool       no failed pool read recorded in the last {}",
            span(pool_reads::WINDOW_MS)
        )];
    }
    let mut out = vec!["pool".to_string()];
    for c in conditions {
        let who = project_label(cfg, &c.project_id);
        let newest = format!(
            "newest {} ago: {}",
            span((now - c.last_failure.at).max(0)),
            c.last_failure.what
        );
        let count = if c.count_is_floor {
            format!("at least {}", c.failures)
        } else {
            c.failures.to_string()
        };
        out.push(match c.verdict {
            forge_runner_core::proto_pool::Verdict::Blind => format!(
                "  {who}  BLIND — cannot read the pool for {} ({} consecutive failed read(s), {count} in the last {}); {newest}",
                span((now - c.unread_since.unwrap_or(c.last_failure.at)).max(0)),
                c.consecutive,
                span(c.window_ms)
            ),
            forge_runner_core::proto_pool::Verdict::Intermittent => format!(
                "  {who}  intermittent — {count} failed read(s) in the last {}; {newest}; reading again for {}",
                span(c.window_ms),
                c.recovered_at
                    .map(|r| span((now - r).max(0)))
                    .unwrap_or_else(|| "an unrecorded time".into())
            ),
        });
    }
    out
}

/// The lines, separated from the printing so what is claimed can be asserted.
fn gate_lines(degraded: &Condition, undeclared: &Condition) -> Vec<String> {
    if degraded.count == 0 && undeclared.count == 0 {
        return Vec::new();
    }
    let mut out = vec!["gate".to_string()];
    out.extend(kind_lines(
        "undeclared",
        "hand-off(s) reached a subagent with nothing declared for them",
        undeclared,
    ));
    out.extend(kind_lines(
        "degraded  ",
        "dispatch(es) went through because the gate could not decide",
        degraded,
    ));
    out
}

const INDENT: &str = "             ";

fn kind_lines(label: &str, what: &str, c: &Condition) -> Vec<String> {
    if c.count == 0 {
        return Vec::new();
    }
    let verdict = match c.verdict {
        Verdict::FailingOpen => " — FAILING OPEN",
        _ => "",
    };
    let mut out = vec![
        format!("  {label} {} {what}{verdict}", c.count),
        format!("{INDENT}{}", rate_line(c)),
    ];
    for r in &c.by_reason {
        out.push(format!("{INDENT}{:>5} × {}", r.count, r.reason));
    }
    if let Some(last) = c.last.as_ref() {
        // Where one reason stands for the whole count, the line above has
        // already said it, and saying it twice is noise in the place a reader
        // is trying to see what changed.
        let already_said = c.by_reason.len() == 1 && c.by_reason[0].reason == last.detail;
        if !already_said {
            out.push(format!("{INDENT}newest: {}", last.detail));
        }
        if let Some(about) = admitted(last) {
            out.push(format!("{INDENT}it admitted: {about}"));
        }
    }
    out
}

/// The number as a rate over a window, which is the only form it means
/// anything in. `278` alone reads as history; `75/day over 3d 17h, last 4m ago`
/// reads as what it is (ISS-1192).
fn rate_line(c: &Condition) -> String {
    let mut parts = Vec::new();
    match (c.per_day, c.window_ms) {
        (Some(rate), Some(window)) => parts.push(format!("{rate:.0}/day over {}", span(window))),
        _ => parts.push("over too short a window to state a rate".to_string()),
    }
    if c.trimmed {
        // What the flag knows is that the file stands at its cap, not that
        // anything was actually dropped. Stating the stronger thing would make
        // the count read as a lifetime total that went down.
        parts.push(
            "of what is kept — the file is at its cap, so older marks may have been dropped"
                .to_string(),
        );
    }
    if let Some(since) = c.since_last_ms {
        parts.push(if since <= RECENT_WITHIN_MS {
            format!("last {} ago, still climbing", span(since))
        } else {
            format!("last {} ago, nothing since", span(since))
        });
    }
    parts.join("; ")
}

/// What the newest mark let through, where the process that wrote it knew.
fn admitted(l: &Last) -> Option<String> {
    let mut bits = Vec::new();
    if let Some(role) = l.role.as_deref() {
        bits.push(format!("role `{role}`"));
    }
    if let Some(agent) = l.agent.as_deref() {
        bits.push(format!("agent {agent}"));
    }
    if let Some(tool) = l.tool_use.as_deref() {
        bits.push(format!("tool call {tool}"));
    }
    match (l.run.as_deref(), l.run_unknown.as_deref()) {
        (Some(run), _) => bits.push(format!("run {run}")),
        (None, Some(why)) => bits.push(format!("no run — {why}")),
        (None, None) => {}
    }
    if let Some(source) = l.source.as_deref() {
        bits.push(format!("marked by the {source}"));
    }
    if bits.is_empty() {
        None
    } else {
        Some(bits.join(", "))
    }
}

/// What the forge-master install did in each bound checkout, as the daemon,
/// `bind` or a provision last recorded it (ISS-1357). The record is the only
/// source that knows the server's assignments without asking core, so where it
/// is absent the bindings `config.toml` names are all this can list.
pub(crate) fn skill_lines(dir: Option<&std::path::Path>, cfg: &Config, now: i64) -> Vec<String> {
    use forge_runner_core::daemon::master_skill::{self, path_in, Read};
    let Some(dir) = dir else {
        return vec![
            "skill      no config directory resolves on this box, so no install record can be read"
                .into(),
        ];
    };
    let path = master_skill::record_path(dir);
    let entries = match master_skill::read(dir) {
        Read::Unreadable(why) => {
            return vec![format!(
                "skill      UNREADABLE — {why}, so what the forge-master install did in each checkout cannot be said"
            )]
        }
        Read::Absent => {
            let mut out = vec![format!(
                "skill      no install record at {} — the daemon writes one at every start, and a daemon older than this build writes none; a project assigned to this box only on the server cannot be named here until it does",
                path.display()
            )];
            for (slug, b) in &cfg.bindings {
                out.push(format!(
                    "  {slug}  no install recorded ← {}",
                    path_in(&b.repo_path).display()
                ));
            }
            return out;
        }
        Read::Record(r) => r.entries,
    };
    let mut out = vec![format!(
        "skill      the forge-master skill in each bound checkout, as last installed ← {}",
        path.display()
    )];
    for e in &entries {
        out.push(format!(
            "  {}  {} {} ago: {}",
            e.slug,
            e.point.word(),
            span(now.saturating_sub(e.at_ms).max(0)),
            e.outcome.says(e.path.as_deref(), &e.build)
        ));
    }
    for (slug, b) in &cfg.bindings {
        if !entries.iter().any(|e| &e.slug == slug) {
            out.push(format!(
                "  {slug}  no install recorded for this binding since the record was last written — the next daemon start writes it ← {}",
                path_in(&b.repo_path).display()
            ));
        }
    }
    out
}

/// A duration a person reads without arithmetic. The stamps this replaced were
/// `epoch+1789906979s`, which states a window in a unit nobody carries.
fn span(ms: i64) -> String {
    let secs = ms / 1000;
    if secs < 60 {
        return format!("{secs}s");
    }
    let mins = secs / 60;
    if mins < 60 {
        return format!("{mins}m");
    }
    let (hours, rest_mins) = (mins / 60, mins % 60);
    if hours < 48 {
        return if rest_mins == 0 {
            format!("{hours}h")
        } else {
            format!("{hours}h {rest_mins}m")
        };
    }
    let (days, rest_hours) = (hours / 24, hours % 24);
    if rest_hours == 0 {
        format!("{days}d")
    } else {
        format!("{days}d {rest_hours}h")
    }
}
