//! The forge-runner crate's tests link `forge-runner-core` with `test-support`
//! rather than `cfg(test)`, and the refusal to resolve a config or data dir
//! that is not a test's own scratch has to hold here too, and in the binary
//! these tests spawn (ISS-1344).
//!
//! Only the first test moves this process's environment; the others hand a
//! spawned child one of its own.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use forge_runner_core::daemon::{control, pool_reads};
use forge_runner_core::runner::ledger::Ledger;
use forge_runner_core::test_scratch::Scratch;

#[test]
fn this_crates_tests_write_under_no_config_dir_but_their_own_scratch() {
    let users_own = if cfg!(windows) {
        r"C:\iss-1344-nobody\AppData\Roaming"
    } else {
        "/iss-1344-nobody/.config"
    };
    let own = Scratch::new("config-isolation");
    // Strictly under the temp dir and named like no scratch.
    let under_temp = own.path().parent().unwrap().join("iss-1344-not-a-scratch");
    for refused in [Path::new(users_own), &under_temp] {
        std::env::set_var("XDG_CONFIG_HOME", refused);
        std::env::set_var("XDG_DATA_HOME", refused);
        assert_eq!(control::config_dir(), None, "no dir for pool-reads.json");
        assert!(forge_runner_core::config::base_dir().is_err());
        let ledger = Ledger::default_path().expect_err("no ledger outside a scratch");
        assert!(ledger.to_string().contains("is not one"), "{ledger}");
    }

    std::env::set_var("XDG_CONFIG_HOME", own.path());
    std::env::set_var("XDG_DATA_HOME", own.path().join("data"));
    let dir = control::config_dir().expect("a test's own scratch");
    assert_eq!(dir, own.path().join("forge-runner"));
    assert_eq!(pool_reads::path(&dir).parent(), Some(dir.as_path()));
    assert_eq!(
        Ledger::default_path().unwrap(),
        own.path()
            .join("data")
            .join("forge-runner")
            .join("ledger.sqlite")
    );
}

/// `forge-runner status`, spawned as the binary an operator runs, with only
/// what `env` names and the temp dir the child resolves its scratch against.
fn status(env: &[(&str, &Path)]) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_forge-runner"));
    cmd.env_clear();
    // `env_clear` leaves Windows no TMP or TEMP, and the child's temp dir
    // decides what reads as a scratch there.
    for var in ["TMPDIR", "TMP", "TEMP"] {
        #[expect(
            clippy::disallowed_methods,
            reason = "the temp-dir variables it passes to the child, read by name"
        )]
        if let Some(value) = std::env::var_os(var) {
            cmd.env(var, value);
        }
    }
    for (name, value) in env {
        cmd.env(name, value);
    }
    cmd.arg("status")
        .env("FORGE_RUNNER_CRED_STORE", "file")
        .output()
        .expect("the binary runs")
}

/// ISS-1344 criterion 14. The binary a test spawns is a test build too: with
/// a data dir that is not a scratch it resolves no ledger and says why, where
/// a release build would open the invoking user's.
#[test]
fn a_spawned_forge_runner_resolves_no_ledger_outside_a_scratch() {
    let home = Scratch::new("ledger-refused");
    let nobody = PathBuf::from(if cfg!(windows) {
        r"C:\iss-1344-nobody"
    } else {
        "/iss-1344-nobody"
    });
    let users_data = nobody.join(".local").join("share");
    let out = status(&[
        ("PATH", &home.join("bin")),
        ("HOME", &nobody),
        ("XDG_CONFIG_HOME", &home.join("c")),
        ("XDG_DATA_HOME", &users_data),
    ]);
    let said = String::from_utf8_lossy(&out.stdout);
    let runs = said
        .lines()
        .find(|l| l.starts_with("runs "))
        .unwrap_or_else(|| panic!("status prints its runs line: {said}"));
    assert!(
        runs.contains("no ledger path resolves") && runs.contains("is not one"),
        "the child refused the ledger outside its scratch: {runs}"
    );
    #[cfg(target_os = "linux")]
    assert!(
        runs.contains(&users_data.display().to_string()),
        "the refusal names the directory: {runs}"
    );
}

/// ISS-1344 criterion 19. A log line goes to stderr, uncoloured when stderr
/// is not a terminal, so what `status` prints on stdout is the status alone.
#[test]
fn a_piped_status_carries_no_log_line_on_stdout() {
    let home = Scratch::new("status-stdout");
    let config = home.join("c");
    let dir = config.join("forge-runner");
    std::fs::create_dir_all(&dir).unwrap();
    // A key core refuses, which `pool_reads::report` warns about on every read.
    std::fs::write(
        pool_reads::path(&dir),
        r#"{"projects":{"proj-u":{"failures":[]}}}"#,
    )
    .unwrap();
    let out = status(&[
        ("PATH", &home.join("bin")),
        ("HOME", &home.join("h")),
        ("XDG_CONFIG_HOME", &config),
        ("XDG_DATA_HOME", &home.join("d")),
    ]);
    let (said, logged) = (
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    assert!(
        logged.contains("WARN") && logged.contains("proj-u"),
        "the warning is logged, on stderr: {logged}"
    );
    assert!(
        !logged.contains('\x1b'),
        "a piped stderr carries no colour codes: {logged:?}"
    );
    assert!(
        !said.contains("WARN") && !said.contains("proj-u") && !said.contains('\x1b'),
        "stdout carries the status alone: {said:?}"
    );
    assert!(said.contains("runs "), "the status is printed: {said}");
}
