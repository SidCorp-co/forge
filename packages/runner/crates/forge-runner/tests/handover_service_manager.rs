//! Criterion 44 as the platform runs it: where there is no exec, a handover
//! exits for the service manager to start the build installed on disk
//! (ISS-1379).
//!
//! The daemon's non-unix handover is `handover::exit_for_service_manager`.
//! Only a process that calls it can show that it ends that process with the
//! status a service manager restarts on, and never returns into the build it
//! was meant to replace, so this file re-executes its own test binary as that
//! process. It runs on the Windows leg of the runner gate, which until now
//! compiled the branch and ran nothing of it.

#![cfg(not(unix))]

use std::path::PathBuf;
use std::process::{Command, Stdio};

use forge_runner_core::daemon::handover;

/// Where the child keeps its marks. Set only on the child; a run of the suite
/// without it makes [`image`] a no-op.
const DIR_ENV: &str = "FORGE_HANDOVER_EXIT_TEST_DIR";

/// The child: says it got there, hands over, and says so again only where the
/// handover came back.
#[test]
fn image() {
    #[expect(
        clippy::disallowed_methods,
        reason = "the directory the parent test handed this child image"
    )]
    let Some(dir) = std::env::var_os(DIR_ENV).map(PathBuf::from) else {
        return;
    };
    std::fs::write(dir.join("handing-over"), std::process::id().to_string()).unwrap();
    handover::exit_for_service_manager("update", "a planted update");
    #[allow(unreachable_code)]
    {
        std::fs::write(dir.join("returned"), "the handover returned").unwrap();
        std::process::exit(3);
    }
}

#[test]
fn the_handover_ends_the_process_for_the_service_manager_and_never_returns() {
    let dir = forge_runner_core::test_scratch::Scratch::new("handover-exit");
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["image", "--exact", "--nocapture", "--test-threads=1"])
        .env(DIR_ENV, &*dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("run the child");
    let reached = dir.join("handing-over").exists();
    let returned = std::fs::read_to_string(dir.join("returned")).ok();
    assert!(reached, "the child never reached the handover");
    assert_eq!(
        returned, None,
        "criterion 44: the handover returned into the build it was replacing"
    );
    assert_eq!(
        status.code(),
        Some(0),
        "criterion 44: the process ends with the status its service manager restarts the installed build on"
    );
}
