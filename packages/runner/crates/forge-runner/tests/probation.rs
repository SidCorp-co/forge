//! A build that passes `--version` and dies at daemon start, as the real
//! binary meets it (ISS-1378, carrying ISS-1379 judge 3's plant A6).
//!
//! The build under test is this crate's own binary, copied to a box of the
//! test's own with a home that holds no login, so every `start` dies the way
//! A6's did: after `--version` would have answered, before a daemon serves.
//! The build it replaced is a shell script that writes down that it ran. The
//! probation is what an update's install writes beside the build it installs.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use forge_runner_core::test_scratch::Scratch;
use forge_runner_core::update::{kept_path, probation, CURRENT_VERSION};

/// A box: the build under test at `bin/forge-runner`, the build it replaced
/// kept beside it, and a home holding nothing.
fn a_box(scratch: &Scratch) -> (PathBuf, PathBuf) {
    let bin = scratch.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("forge-runner");
    std::fs::copy(env!("CARGO_BIN_EXE_forge-runner"), &exe).unwrap();
    let marker = scratch.join("the-build-it-replaced-ran");
    let kept = kept_path(&exe);
    std::fs::write(
        &kept,
        format!("#!/bin/sh\necho \"$@\" > {}\n", marker.display()),
    )
    .unwrap();
    std::fs::set_permissions(&kept, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::create_dir_all(scratch.join("home")).unwrap();
    probation::begin(&exe, CURRENT_VERSION).unwrap();
    (exe, marker)
}

/// `start`, as the service manager runs it, with nothing of this machine's:
/// the environment is cleared, so every directory it reads is under `home`.
fn start(exe: &Path, home: &Path) -> std::process::Output {
    Command::new(exe)
        .arg("start")
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/usr/bin:/bin")
        .output()
        .expect("the build runs")
}

#[test]
fn a_build_that_dies_at_start_is_put_back_to_the_one_it_replaced_past_its_limit() {
    let scratch = Scratch::new("probation-a6");
    let (exe, marker) = a_box(&scratch);
    let home = scratch.join("home");
    let installed = std::fs::read(&exe).unwrap();

    for n in 1..=probation::LIMIT {
        let out = start(&exe, &home);
        let said = String::from_utf8_lossy(&out.stderr).into_owned()
            + &String::from_utf8_lossy(&out.stdout);
        assert!(
            !out.status.success(),
            "the build dies at start, or this test measures nothing: {said}"
        );
        assert!(
            said.contains(&format!(
                "serves on probation, start {n} of {}",
                probation::LIMIT
            )),
            "start {n} is counted before what it dies of: {said}"
        );
        assert_eq!(
            std::fs::read(&exe).unwrap(),
            installed,
            "start {n} is its own"
        );
        assert!(!marker.exists(), "nothing was put back at start {n}");
    }

    let out = start(&exe, &home);
    let said = String::from_utf8_lossy(&out.stderr).into_owned();
    assert!(
        marker.exists(),
        "past the limit the build it replaced runs in its place: {said}"
    );
    assert_eq!(
        std::fs::read_to_string(&marker).unwrap().trim(),
        "start",
        "with the same arguments"
    );
    assert!(
        std::fs::read_to_string(&exe)
            .unwrap()
            .contains("the-build-it-replaced-ran"),
        "and it stands at the install path, so the service manager's next start is it too"
    );
    assert!(
        !probation::path(&exe).exists(),
        "the probation ended with it"
    );
    assert!(
        !kept_path(&exe).exists(),
        "the kept build is the installed one now"
    );
}
