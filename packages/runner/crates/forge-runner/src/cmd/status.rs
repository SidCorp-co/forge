use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::daemon::degraded::Tally;

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
        forge_runner_core::update::CURRENT_VERSION,
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

/// What the declaration gate has and has not been able to do on this box.
// cm:guard BOTH numbers are printed whenever either is non-zero, and neither is printed when both are. A box where the gate is working owes an operator no line; a box where it is not owes one they cannot miss, and printing `gate ok` every time is how the line that matters gets skipped past.
// cm:guard `degraded` and `undeclared` are NEVER summed. The first says the gate could not decide, the second says a hand-off got past it — one is a box to fix and the other is a master to correct, and an operator reading one total cannot tell which they have.
fn print_gate(cfg: &Config) {
    let _ = cfg;
    let Some(dir) = forge_runner_core::daemon::control::config_dir() else {
        return;
    };
    let (degraded, undeclared) = forge_runner_core::daemon::degraded::tally(&dir);
    for line in gate_lines(&degraded, &undeclared) {
        println!("{line}");
    }
}

/// The lines, separated from the printing so what is claimed can be asserted.
fn gate_lines(degraded: &Tally, undeclared: &Tally) -> Vec<String> {
    if degraded.count == 0 && undeclared.count == 0 {
        return Vec::new();
    }
    let mut out = vec!["gate".to_string()];
    if undeclared.count > 0 {
        out.push(format!(
            "  undeclared {} hand-off(s) reached a subagent with nothing declared for them{}",
            undeclared.count,
            since(undeclared)
        ));
        if let Some(last) = undeclared.last.as_deref() {
            out.push(format!("             last: {last}"));
        }
    }
    if degraded.count > 0 {
        out.push(format!(
            "  degraded   {} dispatch(es) went through because the gate could not decide{}",
            degraded.count,
            since(degraded)
        ));
        if let Some(last) = degraded.last.as_deref() {
            out.push(format!("             last: {last}"));
        }
    }
    out
}

/// The window a count covers, and whether it is a floor rather than a total.
// cm:guard the word "kept" is load-bearing. The marks file is capped, so past the cap the number goes DOWN while the failures continue, and an operator reading a lifetime total would read that as the box recovering (ISS-1094, review F7).
fn since(t: &Tally) -> String {
    let when = t
        .first_at
        .map(|ms| format!(" since {}", stamp(ms)))
        .unwrap_or_default();
    if t.trimmed {
        format!(" kept{when}, older ones dropped")
    } else {
        when
    }
}

fn stamp(ms: i64) -> String {
    let secs = ms / 1000;
    format!("epoch+{secs}s")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tally(count: usize, last: &str) -> Tally {
        Tally {
            count,
            last: Some(last.into()),
            last_at: Some(0),
            first_at: Some(0),
            trimmed: false,
        }
    }

    /// Criteria 19, 26. Both numbers, never summed.
    #[test]
    fn the_two_gate_numbers_are_printed_apart() {
        let out = gate_lines(
            &tally(3, "roles unreadable"),
            &tally(2, "child c1 as runner"),
        )
        .join("\n");
        assert!(out.contains("undeclared 2"), "{out}");
        assert!(out.contains("degraded   3"), "{out}");
        assert!(out.contains("child c1 as runner"), "{out}");
        assert!(!out.contains('5'), "the two must never be summed: {out}");
    }

    /// Criterion 19, the half an operator would otherwise misread.
    // cm:guard a falling number must not read as a recovering box. The file is capped, so a box degrading steadily shows fewer marks than it did an hour ago; the line has to say the count is what was kept.
    #[test]
    fn a_capped_count_says_it_is_what_was_kept_and_not_a_total() {
        let mut t = tally(250, "roles unreadable");
        t.trimmed = true;
        let out = gate_lines(&t, &Tally::default()).join("\n");
        assert!(
            out.contains("kept") && out.contains("older ones dropped"),
            "a trimmed count read as a lifetime total says the box is recovering: {out}"
        );
    }

    // cm:guard a working gate prints NOTHING. A reassuring row on every box is a row an operator learns to skip past, including on the box where it later matters — the same reason `doctor` prints nothing for a project that declares no MCP servers.
    #[test]
    fn a_box_whose_gate_is_working_owes_no_line_at_all() {
        assert!(gate_lines(&Tally::default(), &Tally::default()).is_empty());
    }
}
