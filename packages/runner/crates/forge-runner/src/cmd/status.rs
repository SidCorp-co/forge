use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::daemon::degraded::{Condition, Last, Verdict, RECENT_WITHIN_MS};
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
    println!(
        "register   {}",
        if cfg.runner.register_enabled {
            "on"
        } else {
            "off (device-room)"
        }
    );
    print_gate(&cfg);
    print_pool(&cfg);
    let now = forge_runner_core::daemon::agent_activity::now_ms();
    for line in skill_lines(
        forge_runner_core::daemon::control::config_dir().as_deref(),
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
    let Some(dir) = forge_runner_core::daemon::control::config_dir() else {
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
    let dir = forge_runner_core::daemon::control::config_dir()?;
    serving::version_note(
        &serving::read(&dir),
        &serving::Probe::this_box(),
        forge_runner_core::update::CURRENT_VERSION,
        forge_runner_core::update::BUILD_COMMIT,
    )
}

fn print_gate(cfg: &Config) {
    let _ = cfg;
    let Some(dir) = forge_runner_core::daemon::control::config_dir() else {
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
    let Some(dir) = forge_runner_core::daemon::control::config_dir() else {
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
    record: &Result<Vec<pool_reads::Condition>, pool_reads::Unreadable>,
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
            pool_reads::Verdict::Blind => format!(
                "  {who}  BLIND — cannot read the pool for {} ({} consecutive failed read(s), {count} in the last {}); {newest}",
                span((now - c.unread_since.unwrap_or(c.last_failure.at)).max(0)),
                c.consecutive,
                span(c.window_ms)
            ),
            pool_reads::Verdict::Intermittent => format!(
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

#[cfg(test)]
mod tests {
    use super::*;

    // ---- ISS-1357: the skill lines ----

    mod skill {
        use super::super::*;
        use forge_runner_core::daemon::master_skill::{
            record, record_path, Entry, Merge, Outcome, Point,
        };
        use forge_runner_core::test_scratch::Scratch;

        const NOW: i64 = 1_790_236_800_000;

        /// Where the skill of a checkout at `repo` is printed, one separator
        /// throughout: the platform's own (CI run 36746604361, Windows).
        fn at(repo: &str) -> String {
            let s = std::path::MAIN_SEPARATOR;
            format!("{repo}{s}.claude{s}skills{s}forge-master{s}SKILL.md")
        }

        fn bound(slugs: &[(&str, &str)]) -> Config {
            let mut cfg = Config::default();
            for (slug, path) in slugs {
                cfg.bindings.insert(
                    (*slug).into(),
                    forge_runner_core::config::Binding {
                        repo_path: (*path).into(),
                        branch: None,
                        project_id: None,
                    },
                );
            }
            cfg
        }

        fn entry(slug: &str, path: Option<&str>, point: Point, outcome: Outcome) -> Entry {
            Entry {
                slug: slug.into(),
                path: path.map(Into::into),
                at_ms: NOW - 180_000,
                point,
                build: "0.17.66 (abc1234)".into(),
                outcome,
            }
        }

        #[test]
        fn each_recorded_project_is_named_with_its_path_its_outcome_and_the_build() {
            let s = Scratch::new("status-skill");
            record(
                s.path(),
                vec![
                    entry("anhome", Some("/p/anhome"), Point::Start, Outcome::Written),
                    entry("forge-dev", Some("/p/core"), Point::Start, Outcome::Current),
                    entry(
                        "forge-plugin",
                        Some("/p/plugin"),
                        Point::Start,
                        Outcome::NotIgnored {
                            exclude: "/p/plugin/.git/info/exclude".into(),
                        },
                    ),
                    entry("ghost", None, Point::Start, Outcome::NoCheckout),
                    entry(
                        "ro",
                        Some("/p/ro"),
                        Point::Bind,
                        Outcome::Failed {
                            detail: "/p/ro/.claude/skills/forge-master/SKILL.md: Permission denied"
                                .into(),
                        },
                    ),
                ],
                Merge::Upsert,
            )
            .unwrap();
            let text =
                skill_lines(Some(s.path()), &bound(&[("anhome", "/p/anhome")]), NOW).join("\n");

            assert!(
                text.contains(&format!(
                    "anhome  at daemon start 3m ago: written by 0.17.66 (abc1234) ← {}",
                    at("/p/anhome")
                )),
                "{text}"
            );
            assert!(
                text.contains(
                    "forge-dev  at daemon start 3m ago: already the asset of 0.17.66 (abc1234)"
                ),
                "{text}"
            );
            assert!(
                !text
                    .lines()
                    .find(|l| l.contains("forge-dev"))
                    .unwrap()
                    .contains("written by"),
                "{text}"
            );
            assert!(text.contains("forge-plugin  at daemon start 3m ago: NOT WRITTEN — /p/plugin/.git/info/exclude holds `.claude/` and that checkout's git still does not ignore"), "{text}");
            assert!(text.contains(&at("/p/plugin")), "{text}");
            assert!(text.contains("ghost  at daemon start 3m ago: NOT WRITTEN — assigned to this box and names a checkout on neither side"), "{text}");
            assert!(text.contains("ro  at bind 3m ago: NOT WRITTEN — /p/ro/.claude/skills/forge-master/SKILL.md: Permission denied"), "{text}");
        }

        #[test]
        fn a_binding_the_record_does_not_name_says_so() {
            let s = Scratch::new("status-skill-unnamed");
            record(
                s.path(),
                vec![entry("a", Some("/p/a"), Point::Start, Outcome::Written)],
                Merge::Upsert,
            )
            .unwrap();
            let text = skill_lines(
                Some(s.path()),
                &bound(&[("a", "/p/a"), ("late", "/p/late")]),
                NOW,
            )
            .join("\n");
            assert!(
                text.contains("late  no install recorded for this binding"),
                "{text}"
            );
            assert!(text.contains(&at("/p/late")), "{text}");
        }

        #[test]
        fn no_record_names_each_binding_and_what_cannot_be_named() {
            let s = Scratch::new("status-skill-none");
            let text = skill_lines(Some(s.path()), &bound(&[("a", "/p/a")]), NOW).join("\n");
            assert!(text.contains("no install record at"), "{text}");
            assert!(
                text.contains(
                    "a project assigned to this box only on the server cannot be named here"
                ),
                "{text}"
            );
            assert!(
                text.contains(&format!("  a  no install recorded ← {}", at("/p/a"))),
                "{text}"
            );
        }

        #[test]
        fn a_record_that_cannot_be_read_or_is_another_version_is_unreadable_naming_it() {
            let s = Scratch::new("status-skill-bad");
            let p = record_path(s.path());
            std::fs::write(&p, "{ torn").unwrap();
            let text = skill_lines(Some(s.path()), &bound(&[]), NOW).join("\n");
            assert!(
                text.starts_with("skill      UNREADABLE — ")
                    && text.contains(&p.display().to_string()),
                "{text}"
            );

            std::fs::write(&p, r#"{"version":9,"entries":[]}"#).unwrap();
            let text = skill_lines(Some(s.path()), &bound(&[]), NOW).join("\n");
            assert!(
                text.contains("UNREADABLE")
                    && text.contains("version 9, which this build does not read"),
                "{text}"
            );
        }
    }

    // ---- ISS-1355, ISS-1352: the runs no master answers for ----

    use forge_runner_core::runner::ledger::{CheckoutReturn, NewRun};
    use forge_runner_core::test_scratch::Scratch;

    /// A ledger on disk holding sid-desk's abandoned judge of its ISS-496 (its
    /// checkout gone, its session over, its lease still out), a closed run of
    /// forge-dev's replaced master, and forge-dev's current master's own run.
    fn planted(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("ledger.sqlite");
        let mut led = Ledger::open(&path).unwrap();
        for (run, project, master, key) in [
            (
                "d87c1f79-judge",
                "sid-desk-id",
                "655c2532-before",
                "ISS-496",
            ),
            (
                "forge-orphan",
                "forge-dev-id",
                "1a2b3c4d-before",
                "ISS-1246",
            ),
            ("forge-own", "forge-dev-id", "b0ce4b6c-now", "ISS-1355"),
        ] {
            led.create_run_group(NewRun {
                run_id: run.into(),
                project_id: project.into(),
                master_session_id: master.into(),
                worktree_path: dir.join(run),
                boot_id: "boot-a".into(),
                issue_keys: vec![key.into()],
            })
            .unwrap();
            led.bind_agent(run, &format!("agent-{run}")).unwrap();
            led.mark_session_terminal_observed(run).unwrap();
            led.mark_checkout_returned_observed(run, CheckoutReturn::Gone)
                .unwrap();
            if run != "d87c1f79-judge" {
                led.mark_lease_returned_observed(run, key).unwrap();
            }
        }
        led.note_master(
            "forge-dev-id",
            "forge-master-forge-dev",
            None,
            Some("b0ce4b6c-now"),
            "boot-a",
        )
        .unwrap();
        path
    }

    /// ISS-1355 criterion 12 and ISS-1352 criterion 5.
    #[test]
    fn status_names_every_run_no_master_answers_for_and_what_ends_it() {
        let s = Scratch::new("status-runs");
        let path = planted(s.path());
        let mut cfg = cfg_binding("sid-desk", "sid-desk-id");
        cfg.bindings.insert(
            "forge-dev".into(),
            forge_runner_core::config::Binding {
                repo_path: "/tmp/y".into(),
                branch: None,
                project_id: Some("forge-dev-id".into()),
            },
        );
        let out = unanswered_runs(&path, &cfg);
        assert_eq!(
            out[0],
            "runs       2 no master on this box answers for — `run close` refuses each as another master's"
        );
        assert_eq!(
            out[1],
            "  d87c1f79-judge  sid-desk  ISS-496  declared under 655c2532 — its checkout is back and its session over; recovery is still reading its lease on ISS-496 back"
        );
        assert_eq!(
            out[2],
            "  forge-orphan  forge-dev  ISS-1246  declared under 1a2b3c4d — its marks close it, so the next recovery sweep ends it"
        );
        assert_eq!(
            out.len(),
            3,
            "the current master's own run is not named: {out:?}"
        );
    }

    /// ISS-1355 criterion 12: a project this box does not bind is named by its id.
    #[test]
    fn status_names_an_unbound_project_by_its_id() {
        let s = Scratch::new("status-runs-id");
        let path = planted(s.path());
        let out = unanswered_runs(&path, &Config::default());
        assert!(out[1].contains("  sid-desk-id  ISS-496  "), "{out:?}");
    }

    /// ISS-1355 criterion 13.
    #[test]
    fn status_says_when_no_run_is_unanswered_for() {
        let s = Scratch::new("status-runs-none");
        let path = s.path().join("ledger.sqlite");
        drop(Ledger::open(&path).unwrap());
        assert_eq!(
            unanswered_runs(&path, &Config::default()),
            ["runs       none that no master on this box answers for"]
        );
    }

    /// ISS-1355 criterion 16: a ledger that cannot be read is named with its
    /// error, and a missing one is named as missing — neither reads as none.
    #[test]
    fn status_names_a_ledger_it_cannot_read() {
        let s = Scratch::new("status-runs-bad");
        let path = s.path().join("ledger.sqlite");
        std::fs::write(
            &path,
            b"this is not a database, and it is long enough to say so",
        )
        .unwrap();
        let out = unanswered_runs(&path, &Config::default());
        assert_eq!(out.len(), 1);
        assert!(
            out[0].starts_with(&format!("runs       UNREADABLE — {}: ", path.display())),
            "{out:?}"
        );
        assert!(
            out[0].contains("not a database"),
            "the error is SQLite's own: {out:?}"
        );
        let missing = s.path().join("absent.sqlite");
        assert_eq!(
            unanswered_runs(&missing, &Config::default()),
            [format!(
                "runs       no ledger at {} — a daemon creates it at its first start, so no run can be read",
                missing.display()
            )]
        );
        assert!(!missing.exists(), "reading never creates the file");
    }

    // ---- ISS-1234: the pool lines ----

    const NOW: i64 = 1_790_236_800_000;

    fn cfg_binding(slug: &str, project: &str) -> Config {
        let mut cfg = Config::default();
        cfg.bindings.insert(
            slug.into(),
            forge_runner_core::config::Binding {
                repo_path: "/tmp/x".into(),
                branch: None,
                project_id: Some(project.into()),
            },
        );
        cfg
    }

    fn cond(
        verdict: pool_reads::Verdict,
        failures: usize,
        floor: bool,
        status: Option<u16>,
        what: &str,
    ) -> pool_reads::Condition {
        let blind = verdict == pool_reads::Verdict::Blind;
        pool_reads::Condition {
            project_id: "p-1".into(),
            verdict,
            failures,
            count_is_floor: floor,
            window_ms: pool_reads::WINDOW_MS,
            unread_since: blind.then_some(NOW - 5 * 60_000),
            consecutive: if blind { 30 } else { 0 },
            recovered_at: (!blind).then_some(NOW - 60 * 60_000),
            last_failure: pool_reads::WireFailure {
                at: NOW - 10_000,
                status,
                what: what.into(),
                reason: format!("pool {what}"),
            },
        }
    }

    /// Criterion 10.
    #[test]
    fn a_blind_project_is_named_with_its_streak_and_its_newest_status() {
        let c = cond(
            pool_reads::Verdict::Blind,
            30,
            false,
            Some(520),
            "520 (gateway: the origin returned an unknown error)",
        );
        let out = pool_lines(&Ok(vec![c]), &cfg_binding("sid-desk", "p-1"), NOW).join("\n");
        assert!(out.contains("sid-desk  BLIND"), "{out}");
        assert!(out.contains("for 5m"), "{out}");
        assert!(out.contains("30 consecutive"), "{out}");
        assert!(out.contains("30 in the last 24h"), "{out}");
        assert!(
            out.contains("newest 10s ago: 520 (gateway: the origin returned an unknown error)"),
            "{out}"
        );
    }

    /// Criterion 10, the floor and the missing status.
    #[test]
    fn a_floor_says_at_least_and_a_failure_with_no_status_says_the_transports_reason() {
        let c = cond(
            pool_reads::Verdict::Intermittent,
            200,
            true,
            None,
            "pool request: operation timed out",
        );
        let out = pool_lines(&Ok(vec![c]), &Config::default(), NOW).join("\n");
        assert!(
            out.contains("p-1  intermittent"),
            "an unbound project is named by id: {out}"
        );
        assert!(
            out.contains("at least 200 failed read(s) in the last 24h"),
            "{out}"
        );
        assert!(out.contains("pool request: operation timed out"), "{out}");
        assert!(out.contains("reading again for 1h"), "{out}");
        assert!(!out.contains("None"), "{out}");
    }

    /// Criterion 11. Nothing recorded is said as that and no more.
    #[test]
    fn an_empty_record_claims_no_successful_read() {
        let out = pool_lines(&Ok(vec![]), &Config::default(), NOW);
        assert_eq!(
            out,
            vec!["pool       no failed pool read recorded in the last 24h".to_string()]
        );
        let line = &out[0];
        for claim in ["clean", "succeeded", "ok", "healthy", "every project"] {
            assert!(
                !line.contains(claim),
                "`{claim}` claims a read nobody saw: {line}"
            );
        }
    }

    /// An unreadable record is named with its path and reason, and is never
    /// the "nothing recorded" line an absent one earns.
    #[test]
    fn an_unreadable_record_says_so_and_what_it_costs() {
        let e = pool_reads::Unreadable {
            path: "/etc/forge-runner/pool-reads.json".into(),
            reason: "does not parse: EOF while parsing an object at line 1 column 9".into(),
        };
        let out = pool_lines(&Err(e), &Config::default(), NOW).join("\n");
        assert!(out.contains("UNREADABLE"), "{out}");
        assert!(out.contains("/etc/forge-runner/pool-reads.json"), "{out}");
        assert!(out.contains("does not parse: EOF"), "{out}");
        assert!(out.contains("core keeps the last one it stored"), "{out}");
        assert!(!out.contains("no failed pool read recorded"), "{out}");
    }

    const DAY: i64 = 24 * 60 * 60 * 1000;

    fn condition(count: usize, detail: &str) -> Condition {
        forge_runner_core::daemon::degraded::condition(
            &forge_runner_core::daemon::degraded::Tally {
                count,
                by_reason: std::collections::BTreeMap::new(),
                last: Some(Last {
                    detail: detail.into(),
                    ..Last::default()
                }),
                last_at: Some(DAY),
                first_at: Some(0),
                trimmed: false,
            },
            DAY,
        )
    }

    /// Criterion 27. A number and what it is made of are different facts, and
    /// one reason standing for a whole count is the one worth acting on.
    #[test]
    fn the_reasons_behind_the_count_are_named_with_their_shares() {
        let mut c = condition(279, "nothing could be asked");
        c.by_reason = vec![
            forge_runner_core::daemon::degraded::ReasonCount {
                reason: "this pane carries no control capability".into(),
                count: 277,
            },
            forge_runner_core::daemon::degraded::ReasonCount {
                reason: "the daemon did not answer within the bound".into(),
                count: 2,
            },
        ];
        let out = gate_lines(&c, &Condition::none()).join("\n");
        assert!(
            out.contains("277 × this pane carries no control capability"),
            "{out}"
        );
        assert!(
            out.contains("2 × the daemon did not answer within the bound"),
            "{out}"
        );
    }

    /// Criteria 19, 26. Both numbers, never summed.
    #[test]
    fn the_two_gate_numbers_are_printed_apart() {
        let out = gate_lines(
            &condition(3, "roles unreadable"),
            &condition(2, "child c1 as runner"),
        )
        .join("\n");
        assert!(out.contains("undeclared 2"), "{out}");
        assert!(out.contains("degraded   3"), "{out}");
        assert!(out.contains("child c1 as runner"), "{out}");
        assert!(!out.contains('5'), "the two must never be summed: {out}");
    }

    #[test]
    fn a_capped_count_says_it_is_what_was_kept_and_not_a_total() {
        let mut c = condition(250, "roles unreadable");
        c.trimmed = true;
        let out = gate_lines(&c, &Condition::none()).join("\n");
        assert!(
            out.contains("kept") && out.contains("may have been dropped"),
            "a trimmed count read as a lifetime total says the box is recovering: {out}"
        );
    }

    /// Criterion 1. The count as a rate over a window a person can read.
    #[test]
    fn the_line_states_a_rate_and_a_window_rather_than_two_epoch_stamps() {
        let out = gate_lines(
            &condition(75, "the daemon did not answer"),
            &Condition::none(),
        )
        .join("\n");
        assert!(out.contains("75/day over 24h"), "{out}");
        assert!(
            !out.contains("epoch+"),
            "a window stated in epoch seconds is a window nobody reads: {out}"
        );
    }

    /// Criterion 2. An open wound and a closed one must not read alike.
    #[test]
    fn a_climbing_counter_and_a_finished_one_read_differently() {
        let climbing = gate_lines(&condition(75, "x"), &Condition::none()).join("\n");
        assert!(climbing.contains("still climbing"), "{climbing}");

        let stale = forge_runner_core::daemon::degraded::condition(
            &forge_runner_core::daemon::degraded::Tally {
                count: 75,
                by_reason: std::collections::BTreeMap::new(),
                last: None,
                last_at: Some(DAY),
                first_at: Some(0),
                trimmed: false,
            },
            DAY + 7 * DAY,
        );
        let out = gate_lines(&stale, &Condition::none()).join("\n");
        assert!(out.contains("nothing since"), "{out}");
        assert!(!out.contains("still climbing"), "{out}");
    }

    /// Criterion 8, at the surface. A sustained rate is named as a fault rather
    /// than left for the reader to compute.
    #[test]
    fn a_gate_failing_open_says_so_in_the_line_itself() {
        let out = gate_lines(&condition(75, "x"), &Condition::none()).join("\n");
        assert!(out.contains("FAILING OPEN"), "{out}");
        let under = gate_lines(&condition(11, "x"), &Condition::none()).join("\n");
        assert!(
            !under.contains("FAILING OPEN"),
            "eleven a day is on the record and is not a fault: {under}"
        );
    }

    /// Criteria 3, 5, 6. What the newest mark admitted reaches the operator, so
    /// the reason is read as the statement it is rather than one about a pane.
    #[test]
    fn the_line_says_what_the_newest_mark_let_through() {
        let mut c = condition(3, "nothing could be asked");
        c.last = Some(Last {
            detail: "nothing could be asked".into(),
            source: Some("hook".into()),
            run_unknown: Some("the hook holds no registry".into()),
            agent: Some("agent-7".into()),
            role: Some("forge:runner".into()),
            tool_use: Some("toolu_09".into()),
            ..Last::default()
        });
        let out = gate_lines(&c, &Condition::none()).join("\n");
        assert!(out.contains("role `forge:runner`"), "{out}");
        assert!(out.contains("agent agent-7"), "{out}");
        assert!(out.contains("toolu_09"), "{out}");
        assert!(out.contains("no run — the hook holds no registry"), "{out}");
        assert!(out.contains("marked by the hook"), "{out}");
    }

    #[test]
    fn a_box_whose_gate_is_working_owes_no_line_at_all() {
        assert!(gate_lines(&Condition::none(), &Condition::none()).is_empty());
    }

    #[test]
    fn a_span_reads_as_a_duration_at_every_scale() {
        assert_eq!(span(45_000), "45s");
        assert_eq!(span(45 * 60_000), "45m");
        assert_eq!(span(3 * 3_600_000 + 30 * 60_000), "3h 30m");
        assert_eq!(span(3 * DAY + 17 * 3_600_000), "3d 17h");
    }

    // ---- ISS-1341: the gate reading says what it could not read ----

    /// Criterion 23. A marks file that cannot be read is said to be, where
    /// `degraded::tally` reads it as no mark and `status` printed nothing.
    #[test]
    fn a_marks_file_that_cannot_be_read_is_unreadable_and_never_silent() {
        let s = forge_runner_core::test_scratch::Scratch::new("gate-unreadable");
        std::fs::create_dir_all(forge_runner_core::daemon::degraded::marks_path(s.path())).unwrap();
        let out = gate_reading(s.path(), NOW).join("\n");
        assert!(out.contains("gate       UNREADABLE"), "{out}");
        assert!(out.contains("gate-marks.jsonl"), "{out}");
    }

    #[test]
    fn a_mark_that_does_not_parse_is_counted_aloud_beside_the_rest() {
        let s = forge_runner_core::test_scratch::Scratch::new("gate-unparsed");
        std::fs::write(
            forge_runner_core::daemon::degraded::marks_path(s.path()),
            "{\"kind\":\"degraded\",\"detail\":\"x\",\"at\":1790236700000}\n{half\n",
        )
        .unwrap();
        let out = gate_reading(s.path(), NOW).join("\n");
        assert!(out.contains("degraded   1"), "{out}");
        assert!(
            out.contains("1 line(s)") && out.contains("do not parse"),
            "{out}"
        );
    }

    #[test]
    fn no_marks_file_is_still_a_gate_that_never_failed_open() {
        let s = forge_runner_core::test_scratch::Scratch::new("gate-none");
        assert!(gate_reading(s.path(), NOW).is_empty());
    }
}
