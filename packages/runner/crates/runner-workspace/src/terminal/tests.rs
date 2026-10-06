//! A pane started on a real tmux server, read from inside the pane.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::process::Command::new("tmux")
            .arg("-S")
            .arg(self.0.join("s"))
            .arg("kill-server")
            .output();
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn runnable(dir: &Path, name: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir).unwrap();
    let file = dir.join(name);
    std::fs::write(&file, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// The one named way a box without tmux skips a test that needs a real server.
const SKIP_TMUX: &str = "FORGE_TEST_SKIP_TMUX";

/// Whether `test` may run: tmux on PATH says yes. Without it the test fails naming tmux, so a
/// box that lacks it cannot pass having asserted nothing — unless [`SKIP_TMUX`] is `1`, which is
/// reported on stderr past the harness's capture, so the skip is seen and not mistaken for a pass.
fn tmux_or_skip(test: &str) -> bool {
    if which::which("tmux").is_ok() {
        return true;
    }
    match std::env::var(SKIP_TMUX) {
        Ok(v) if v == "1" => {
            use std::io::Write;
            let _ = writeln!(
                std::io::stderr(),
                "SKIPPED {test}: tmux is not on PATH and {SKIP_TMUX}=1 opted this run out — nothing was asserted"
            );
            false
        }
        Ok(v) => panic!(
            "TMUX_SKIP_VALUE_UNKNOWN: {test} needs tmux, which is not on PATH, and {SKIP_TMUX}={v:?} is not the opt-out — set it to 1 to skip, or install tmux"
        ),
        Err(_) => panic!(
            "TMUX_NOT_ON_PATH: {test} needs a real tmux server and tmux is not on PATH — install tmux, or set {SKIP_TMUX}=1 to skip it by name"
        ),
    }
}

/// The daemon's PATH holds another box's `forge-runner` ahead of its own, and tmux 3.x hands a
/// pane the PATH of the client that ran `new-session`, over the `-e PATH` that client passed
/// (spawn.c:spawn_pane). So the pane's own process has to be what sets it.
#[test]
fn the_pane_process_resolves_forge_runner_to_the_path_the_daemon_handed_it() {
    if !tmux_or_skip("the_pane_process_resolves_forge_runner_to_the_path_the_daemon_handed_it") {
        return;
    }
    let root = Scratch(std::env::temp_dir().join(format!("fpp-{}", uuid::Uuid::new_v4().simple())));
    let other = root.0.join("other");
    let own = root.0.join("own");
    runnable(&other, "forge-runner");
    runnable(&own, "forge-runner");
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let daemon_path = std::env::join_paths(
        std::iter::once(other.clone()).chain(std::env::split_paths(&inherited)),
    )
    .unwrap();
    let pane_path = std::env::join_paths(
        std::iter::once(own.clone()).chain(std::env::split_paths(&daemon_path)),
    )
    .unwrap()
    .to_string_lossy()
    .into_owned();
    let out = root.0.join("resolved");
    let argv = vec![
        "sh".to_string(),
        "-c".to_string(),
        format!(
            "command -v forge-runner > {}.tmp; mv {0}.tmp {0}; sleep 30",
            super::shell_quote(&out.to_string_lossy())
        ),
    ];
    let env = vec![("PATH".to_string(), pane_path)];
    let args = super::new_session_args("forge-job-path", &root.0, &argv, &env);

    let started = std::process::Command::new("tmux")
        .arg("-S")
        .arg(root.0.join("s"))
        .args(&args)
        .env("PATH", &daemon_path)
        .output()
        .unwrap();
    assert!(
        started.status.success(),
        "tmux new-session: {}",
        String::from_utf8_lossy(&started.stderr)
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !out.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let resolved = std::fs::read_to_string(&out).expect("the pane never ran its command");
    assert_eq!(
        PathBuf::from(resolved.trim()),
        own.join("forge-runner"),
        "the pane process resolves forge-runner to another box's build, not the one on the PATH the daemon handed it"
    );
}
