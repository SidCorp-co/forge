//! `forge-runner master status`, run as the binary an operator runs, for a
//! project whose master the daemon refused to place (ISS-1390 criterion 6).
//!
//! The daemon's sweep keeps why it placed no pane beside the project's
//! transcript; this command runs in a process of its own and asks the daemon
//! nothing, so that record is the only way the refusal reaches it.

use std::process::{Command, Output};

use forge_runner_core::daemon::pane_path::Unresolved;
use forge_runner_core::daemon::unplaced_record::{self, Record};
use forge_runner_core::test_scratch::Scratch;

fn status(home: &Scratch, slug: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_forge-runner"))
        .args(["master", "status", slug])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home.join("h"))
        .env("XDG_CONFIG_HOME", home.join("c"))
        .env("XDG_DATA_HOME", home.join("d"))
        .output()
        .expect("the binary runs")
}

#[test]
fn a_master_refused_for_its_path_is_said_on_status_naming_each_binary_and_the_path() {
    let home = Scratch::short("mst-refused");
    let dir = home
        .join("c")
        .join("forge-runner")
        .join("master")
        .join("plantslug");
    let before = status(&home, "plantslug");
    let said = String::from_utf8_lossy(&before.stdout);
    assert!(
        !said.contains(" unplaced  "),
        "nothing recorded, nothing said: {said}"
    );

    let detail = Unresolved {
        missing: vec!["forge-runner".into(), "node".into()],
        path: "/usr/local/bin:/usr/bin".into(),
    }
    .to_string();
    unplaced_record::write(
        &dir,
        &Record {
            since: 0,
            pid: 4242,
            lead: "no master pane placed".into(),
            why: detail,
        },
    )
    .unwrap();
    let out = status(&home, "plantslug");
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{said}");
    let line = said
        .lines()
        .find(|l| l.contains(" unplaced  "))
        .unwrap_or_else(|| panic!("master status says why no pane was placed: {said}"));
    for named in [
        "no master pane placed",
        "`forge-runner`, `node`",
        "(/usr/local/bin:/usr/bin)",
        "pid 4242",
    ] {
        assert!(line.contains(named), "the line names {named}: {line}");
    }

    unplaced_record::clear(&dir).unwrap();
    let after = status(&home, "plantslug");
    assert!(
        !String::from_utf8_lossy(&after.stdout).contains(" unplaced  "),
        "a placement that cleared the record leaves nothing said"
    );
}
