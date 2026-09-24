use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::daemon::degraded::{Condition, Last, Verdict, RECENT_WITHIN_MS};

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// (planned M4) live view.
    #[arg(long)]
    pub watch: bool,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    if args.watch {
        println!("⏳ --watch (live TUI) not implemented yet (M4) — printing static status:\n");
    }
    let cfg = Config::load()?;
    println!(
        "version    {} ({})",
        forge_runner_core::update::VERSION_LINE,
        forge_runner_core::update::BUILD_TARGET
    );
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

fn print_gate(cfg: &Config) {
    let _ = cfg;
    let Some(dir) = forge_runner_core::daemon::control::config_dir() else {
        return;
    };
    let now = forge_runner_core::daemon::agent_activity::now_ms();
    let report = forge_runner_core::daemon::degraded::report(&dir, now);
    for line in gate_lines(&report.degraded, &report.undeclared) {
        println!("{line}");
    }
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
}
