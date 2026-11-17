//! A pinned tool moves only on a passing canary, as `claude_version` does (ISS-1268): open a
//! throwaway box of the mode the tool serves with the candidate version, drive it, close it, and
//! prove every process it started is gone. A failure keeps the pin and says which check failed.

use std::path::Path;
use std::time::Duration;

use runner_platform::box_settings::BoxSettings;

use crate::mode::{Ctx, Running, Spec};
use crate::{act, display, modes, proc};

/// One check and what it found.
pub struct Check {
    pub name: &'static str,
    pub passed: bool,
    pub detail: String,
}

/// The mode a pinned tool serves.
pub fn mode_of(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "agent-browser" => "browser",
        "agent-desktop" => "desktop",
        "agent-device" | "android-image" => "android",
        _ => return None,
    })
}

/// The canary's page: a counter a click moves.
const PAGE: &str =
    "data:text/html,<button id=c onclick=\"this.textContent=+this.textContent+1\">0</button>";

/// Run the canary for `tool` at `version`, its box's state under `scratch`.
pub async fn run(base: &BoxSettings, tool: &str, version: &str, scratch: &Path) -> Vec<Check> {
    let Some(mode) = mode_of(tool) else {
        return vec![Check {
            name: "tool",
            passed: false,
            detail: format!("`{tool}` is not a pinned box tool"),
        }];
    };
    let mut s = base.clone();
    s.set_pin(tool, version);
    s.data_dir = Some(scratch.to_path_buf());
    let ctx = Ctx {
        env: modes::Env::of_host(&s, &base.data_dir()),
        settings: s,
        data_dir: scratch.to_path_buf(),
        x: display::XDirs::default(),
        displays: display::Taken::default(),
        emulator_ports: Default::default(),
    };
    let box_id = uuid::Uuid::new_v4().to_string();
    let spec = Spec {
        box_id: box_id.clone(),
        mode: mode.into(),
        viewport: None,
        url: (mode == "browser").then(|| PAGE.to_string()),
        within: Duration::from_secs(240),
    };
    let mut checks = Vec::new();
    let opened = Running::open(&ctx, &spec).await;
    checks.push(Check {
        name: "open",
        passed: opened.is_ok(),
        detail: opened
            .as_ref()
            .err()
            .cloned()
            .unwrap_or_else(|| format!("a {mode} box opened")),
    });
    if let Ok(running) = &opened {
        for (name, argv, expect) in smoke(mode) {
            let o = act::run(running.driver(&argv), Duration::from_secs(60)).await;
            let passed = o.exit_code == 0 && expect.is_none_or(|e| o.stdout.contains(e));
            checks.push(Check {
                name,
                passed,
                detail: format!("exit {}: {}", o.exit_code, first_line(&o.stdout, &o.stderr)),
            });
        }
        let recorded = running.record_on().await;
        checks.push(Check {
            name: "record",
            passed: recorded.is_ok(),
            detail: recorded
                .as_ref()
                .err()
                .cloned()
                .unwrap_or_else(|| "the recording started".into()),
        });
        running.stop(recorded.is_ok()).await;
    }
    let reaped = proc::reap(&box_id, Duration::from_secs(10)).await;
    checks.push(Check {
        name: "reaped",
        passed: reaped.left.is_empty(),
        detail: format!(
            "{} process(es) stopped, {:?} left",
            reaped.signalled.len(),
            reaped.left
        ),
    });
    checks
}

fn smoke(mode: &str) -> Vec<(&'static str, Vec<String>, Option<&'static str>)> {
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match mode {
        "browser" => vec![
            ("click", v(&["click", "#c"]), None),
            ("read back", v(&["get", "text", "#c"]), Some("1")),
        ],
        "desktop" => vec![("displays", v(&["list-displays"]), None)],
        _ => vec![("snapshot", v(&["snapshot"]), None)],
    }
}

fn first_line(out: &str, err: &str) -> String {
    let text = if out.trim().is_empty() { err } else { out };
    text.lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(160)
        .collect()
}
