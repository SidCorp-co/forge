//! Which config dir the built `forge-runner` resolves, read through the binary: a pane is handed
//! `FORGE_RUNNER_CONFIG_DIR` naming its daemon's directory while its `XDG_CONFIG_HOME` stays the
//! user's, so the runner variable has to win over the XDG rule (ISS-574).

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch() -> Scratch {
    let dir = std::env::temp_dir().join(format!("frcd-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(dir.join("home")).unwrap();
    Scratch(dir)
}

fn config_path(root: &Path, runner_var: Option<&str>) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_forge-runner"));
    cmd.args(["config", "path"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", root.join("home"))
        .env("XDG_CONFIG_HOME", root.join("user-config"));
    if let Some(v) = runner_var {
        cmd.env("FORGE_RUNNER_CONFIG_DIR", v);
    }
    cmd.output().unwrap()
}

fn said(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn the_binary_resolves_its_config_from_the_runner_variable_over_xdg() {
    let root = scratch();
    let daemon = root.0.join("daemon-xdg/forge-runner");
    let out = config_path(&root.0, Some(daemon.to_str().unwrap()));
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        PathBuf::from(said(&out)),
        daemon.join("config.toml"),
        "FORGE_RUNNER_CONFIG_DIR set: the binary resolved its config from XDG_CONFIG_HOME instead"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn without_the_runner_variable_the_binary_keeps_the_xdg_rule() {
    let root = scratch();
    let want = root.0.join("user-config/forge-runner/config.toml");
    for unset in [None, Some("")] {
        let out = config_path(&root.0, unset);
        assert!(out.status.success(), "{out:?}");
        assert_eq!(PathBuf::from(said(&out)), want, "{unset:?}");
    }
}

#[test]
fn the_binary_refuses_a_relative_runner_variable_by_name() {
    let root = scratch();
    let out = config_path(&root.0, Some("rel/forge-runner"));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        !out.status.success(),
        "a relative config dir was taken: {out:?}"
    );
    assert!(
        err.contains("FORGE_RUNNER_CONFIG_DIR") && err.contains("rel/forge-runner"),
        "{err}"
    );
}
