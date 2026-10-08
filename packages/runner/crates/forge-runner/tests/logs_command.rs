//! `forge-runner logs`, run as the binary an operator runs.
//!
//! Every held report names this command as the one that says where the box's
//! journal is read (ISS-1250), so what it prints is that, and a `--follow` it
//! would only ignore is refused rather than taken.

use std::process::{Command, Output};

use forge_runner_core::test_scratch::Scratch;

#[expect(
    clippy::disallowed_methods,
    reason = "the test hands its child this process's PATH"
)]
fn logs(args: &[&str]) -> Output {
    let home = Scratch::new("logs-cmd");
    Command::new(env!("CARGO_BIN_EXE_forge-runner"))
        .arg("logs")
        .args(args)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home.join("h"))
        .env("XDG_CONFIG_HOME", home.join("c"))
        .env("XDG_DATA_HOME", home.join("d"))
        .output()
        .expect("the binary runs")
}

#[test]
fn it_says_where_the_journal_is_read() {
    let out = logs(&[]);
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{said}");
    assert!(said.contains("journalctl --user -u forge-runner"), "{said}");
}

#[test]
fn a_follow_it_cannot_give_is_refused_by_name() {
    for flag in ["-f", "--follow"] {
        let out = logs(&[flag]);
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(!out.status.success(), "{flag} was taken and ignored");
        assert!(err.contains(flag), "the refusal names {flag}: {err}");
    }
}
