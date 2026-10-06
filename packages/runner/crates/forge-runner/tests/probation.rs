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
use forge_runner_core::update::{kept_path, probation, BUILD_TARGET, CURRENT_VERSION};

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
    let rejected = probation::rejected(&exe)
        .expect("readable")
        .expect("criterion 15: the put-back records the build that would not stay up");
    assert_eq!(rejected.version, CURRENT_VERSION);
    assert_eq!(rejected.starts, probation::LIMIT);
}

/// A release server of the test's own: `latest.json` answers the manifest it
/// is handed, `asset` the build, and every request for the build is counted.
struct Releases {
    url: String,
    asset_fetches: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

fn serve_release(version: &str, commit: &str) -> Releases {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let asset = format!("#!/bin/sh\necho 'forge-runner {version} ({commit})'\n");
    let manifest = serde_json::json!({
        "version": version,
        "commit": commit,
        "assets": { BUILD_TARGET: { "url": format!("{url}/asset") } },
    })
    .to_string();
    let fetches = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = fetches.clone();
    std::thread::spawn(move || {
        for sock in listener.incoming() {
            let Ok(mut sock) = sock else { return };
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).into_owned();
            let body = if head.starts_with("GET /asset") {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                asset.clone()
            } else {
                manifest.clone()
            };
            let _ = write!(
                sock,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    Releases {
        url,
        asset_fetches: fetches,
    }
}

/// A box whose install path holds this crate's own binary, and whose config
/// reads its releases from `releases`.
fn an_updating_box(scratch: &Scratch, releases: &Releases) -> (PathBuf, PathBuf) {
    let bin = scratch.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("forge-runner");
    std::fs::copy(env!("CARGO_BIN_EXE_forge-runner"), &exe).unwrap();
    let home = scratch.join("home");
    let config = home.join(".config").join("forge-runner");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("config.toml"),
        format!(
            "[update]\nmanifest_url = \"{}/latest.json\"\n",
            releases.url
        ),
    )
    .unwrap();
    (exe, home)
}

/// `forge-runner update`, by hand, with nothing of this machine's.
fn update_by_hand(exe: &Path, home: &Path) -> String {
    let out = Command::new(exe)
        .arg("update")
        .env_clear()
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("PATH", "/usr/bin:/bin")
        .output()
        .expect("the build runs");
    String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr)
}

/// A version newer than this build's, so the release is one an update installs.
fn newer(by: u64) -> String {
    let mut parts = CURRENT_VERSION
        .split('-')
        .next()
        .unwrap()
        .split('.')
        .map(|p| p.parse::<u64>().unwrap());
    let major = parts.next().unwrap();
    format!("{}.0.{by}", major + 1)
}

/// ISS-1378 criterion 14, by the route `status` itself names: a hand update
/// keeps the build it replaced and starts the one it installed on probation.
#[test]
fn a_hand_update_keeps_the_build_it_replaced_and_starts_the_new_one_on_probation() {
    let scratch = Scratch::new("probation-hand");
    let version = newer(1);
    let releases = serve_release(&version, "c0ffee0");
    let (exe, home) = an_updating_box(&scratch, &releases);
    let served = std::fs::read(&exe).unwrap();

    let said = update_by_hand(&exe, &home);
    assert!(said.contains(&format!("→ {version}")), "installed: {said}");
    // The probation is a condition on what has not happened yet, and the line
    // says it as one rather than as a failure already met (ISS-1378 judging,
    // 8012bc54 #3).
    assert!(
        said.contains(&format!(
            "serves on probation: if it starts {} times without staying up {}s, it is put back to",
            probation::LIMIT,
            probation::PERIOD.as_secs()
        )),
        "{said}"
    );
    assert!(
        std::fs::read_to_string(&exe)
            .unwrap()
            .contains(&format!("forge-runner {version}")),
        "the release stands at the install path: {said}"
    );
    assert_eq!(
        std::fs::read(kept_path(&exe)).expect("criterion 14: the build it replaced is kept"),
        served,
        "{said}"
    );
    assert_eq!(
        probation::enter(&exe, &version),
        probation::Entered::Counted { starts: 1 },
        "criterion 14: the build a hand update installed serves on probation"
    );
}

/// ISS-1378 criterion 15: the build a probation put back is not installed
/// again by an update, which does not even download it, and a release other
/// than it is installed and lifts the hold.
#[test]
fn an_update_skips_the_build_a_probation_put_back_until_another_release_is_offered() {
    let scratch = Scratch::new("probation-held");
    let rejected_version = newer(1);
    let releases = serve_release(&rejected_version, "badbad0");
    let (exe, home) = an_updating_box(&scratch, &releases);
    let served = std::fs::read(&exe).unwrap();
    probation::reject(
        &exe,
        &probation::Rejected {
            version: rejected_version.clone(),
            commit: Some("badbad0".into()),
            starts: probation::LIMIT,
            at_ms: 1,
        },
    )
    .unwrap();

    let said = update_by_hand(&exe, &home);
    assert!(
        said.contains(&format!("{rejected_version} is held back")),
        "criterion 15: {said}"
    );
    assert_eq!(
        std::fs::read(&exe).unwrap(),
        served,
        "nothing installed: {said}"
    );
    assert_eq!(
        releases
            .asset_fetches
            .load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the build held back is not downloaded"
    );
    assert!(
        !probation::path(&exe).exists(),
        "and nothing is on probation"
    );

    std::fs::write(probation::rejected_path(&exe), "{").unwrap();
    let said = update_by_hand(&exe, &home);
    assert!(
        said.contains("not installed") && said.contains(".rejected"),
        "an unreadable hold refuses rather than reading as absent: {said}"
    );
    assert_eq!(
        std::fs::read(&exe).unwrap(),
        served,
        "nothing installed: {said}"
    );
    assert_eq!(
        releases
            .asset_fetches
            .load(std::sync::atomic::Ordering::SeqCst),
        0,
        "nor downloaded"
    );
    probation::reject(
        &exe,
        &probation::Rejected {
            version: rejected_version.clone(),
            commit: Some("badbad0".into()),
            starts: probation::LIMIT,
            at_ms: 1,
        },
    )
    .unwrap();

    let other = newer(2);
    let next = serve_release(&other, "c0ffee0");
    let elsewhere = Scratch::new("probation-held-next");
    let (_, home) = an_updating_box(&elsewhere, &next);
    let said = update_by_hand(&exe, &home);
    assert!(
        said.contains(&format!("→ {other}")),
        "another release goes in: {said}"
    );
    assert!(
        probation::rejected(&exe).unwrap().is_none(),
        "and the hold is lifted with it: {said}"
    );
}
