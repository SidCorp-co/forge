//! Bringing a device to serving boxes: what it lacks, split by who may install it.
//!
//! Root parts (apt packages, the kvm group and its udev rule) are only ever *listed* here: the CLI
//! asks a person once, at a terminal, and runs them (`forge-runner setup`). The daemon never runs
//! them. User-space parts (the pinned npm tools, the SDK's packages, the base AVD and its
//! snapshot) the runner installs itself, into this user's own directories; what already stands
//! (a hand-installed SDK, a tool on the path at its pin) is adopted, never installed again.

use std::path::{Path, PathBuf};
use std::time::Duration;

use runner_platform::box_settings::BoxSettings;

use crate::modes::{self, Env};
use crate::{act, proc};

/// The apt packages the modes need, and the binary that shows each is there.
pub const APT: [(&str, &str); 10] = [
    ("ffmpeg", "ffmpeg"),
    ("openjdk-17-jdk-headless", "java"),
    ("scrcpy", "scrcpy"),
    ("scrot", "scrot"),
    ("xvfb", "Xvfb"),
    ("openbox", "openbox"),
    ("x11vnc", "x11vnc"),
    ("xdotool", "xdotool"),
    ("unzip", "unzip"),
    ("at-spi2-core", "at-spi-bus-launcher"),
];

/// The udev rule that keeps `/dev/kvm` this group's: a plain setfacl is reset by udev in minutes.
pub const UDEV_RULE_PATH: &str = "/etc/udev/rules.d/99-forge-kvm.rules";
pub const UDEV_RULE: &str = "KERNEL==\"kvm\", GROUP=\"kvm\", MODE=\"0660\"\n";

/// What needs root on this device, for a person to agree to once.
#[derive(Debug, Default, PartialEq)]
pub struct RootPlan {
    pub apt: Vec<String>,
    /// This user is not in the kvm group.
    pub kvm_group: bool,
    /// The udev rule is absent.
    pub udev_rule: bool,
}

impl RootPlan {
    pub fn is_empty(&self) -> bool {
        self.apt.is_empty() && !self.kvm_group && !self.udev_rule
    }
}

/// Read what root parts are missing. `udev_dir` is `/etc/udev/rules.d` on a real host.
pub fn root_plan(env: &Env, groups: &[String], udev_rule: &Path) -> RootPlan {
    let present = |bin: &str| match bin {
        "at-spi-bus-launcher" => modes::executable(&env.atspi_launcher),
        "scrcpy" => env.which("scrcpy").is_some() && env.scrcpy_server.is_file(),
        b => env.which(b).is_some(),
    };
    RootPlan {
        apt: APT
            .iter()
            .filter(|(_, bin)| !present(bin))
            .map(|(pkg, _)| pkg.to_string())
            .collect(),
        kvm_group: !groups.iter().any(|g| g == "kvm"),
        udev_rule: !udev_rule.is_file(),
    }
}

/// This user's groups as the kernel holds them now.
pub fn my_groups() -> Vec<String> {
    let id = PathBuf::from("/usr/bin/id");
    modes::run_within(&id, &["-nG"], Duration::from_secs(5))
        .map(|g| g.split_whitespace().map(String::from).collect())
        .unwrap_or_default()
}

/// One user-space step and what it said.
#[derive(Debug)]
pub struct Step {
    pub what: String,
    pub done: Result<String, String>,
}

/// Install `tool` at `version` into `<tools>/<tool>/<version>` with npm. The pin does not move.
pub async fn install_npm(env: &Env, tool: &str, version: &str) -> Result<PathBuf, String> {
    let npm = env
        .which("npm")
        .ok_or("npm is not on the path: install node first")?;
    let prefix = env.tools_dir.join(tool).join(version);
    std::fs::create_dir_all(&prefix)
        .map_err(|e| format!("cannot make {}: {e}", prefix.display()))?;
    let mut cmd = tokio::process::Command::new(npm);
    cmd.args(["install", "--no-audit", "--no-fund", "--prefix"])
        .arg(&prefix)
        .arg(format!("{tool}@{version}"))
        .kill_on_drop(true);
    let o = act::run(cmd, Duration::from_secs(600)).await;
    if o.exit_code != 0 {
        return Err(format!(
            "npm install {tool}@{version} exited {}: {}",
            o.exit_code,
            o.stderr.trim()
        ));
    }
    env.pinned(tool, version).ok_or_else(|| {
        format!(
            "npm installed {tool}@{version} but {} has no runnable {tool}",
            prefix.display()
        )
    })
}

/// The base AVD made from the pinned image, where it is not there already.
pub async fn ensure_avd(env: &Env, s: &BoxSettings) -> Result<String, String> {
    if env.avd(s).0.is_some() {
        return Ok(format!(
            "base AVD {} adopted where it stands",
            s.android_avd
        ));
    }
    if env.image_dir(s).is_none() {
        return Err(format!(
            "system image {} is not in the SDK: run sdkmanager for it first",
            s.android_image
        ));
    }
    let avdmanager = env
        .sdk_bin("cmdline-tools/latest/bin/avdmanager")
        .ok_or("the SDK has no cmdline-tools/latest/bin/avdmanager")?;
    // avdmanager falls back to the user's own AVD home when the named one does not exist yet, so
    // it is made first and the AVD's directory is named outright
    let home = env
        .avd_home
        .clone()
        .ok_or("no AVD home to make the base AVD in")?;
    std::fs::create_dir_all(&home).map_err(|e| format!("cannot make {}: {e}", home.display()))?;
    let avd_dir = home.join(format!("{}.avd", s.android_avd));
    let mut cmd = tokio::process::Command::new(avdmanager);
    cmd.arg("create")
        .arg("avd")
        .arg("-p")
        .arg(&avd_dir)
        .args([
            "-n",
            &s.android_avd,
            "-k",
            &s.android_image,
            "-d",
            "pixel_6",
        ])
        .env("ANDROID_HOME", env.sdk.clone().unwrap_or_default())
        .env("ANDROID_AVD_HOME", &home)
        .stdin(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("avdmanager: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        // "Do you wish to create a custom hardware profile? [no]"
        let _ = tokio::io::AsyncWriteExt::write_all(&mut stdin, b"no\n").await;
    }
    let out = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output())
        .await
        .map_err(|_| "avdmanager ran past 120 s".to_string())?
        .map_err(|e| format!("avdmanager: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "avdmanager exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    if env.avd(s).0.is_none() {
        return Err(format!(
            "avdmanager made no {}.ini in {}: it wrote the AVD somewhere this runner does not read",
            s.android_avd,
            home.display()
        ));
    }
    Ok(format!(
        "base AVD {} made from {}",
        s.android_avd, s.android_image
    ))
}

/// Boot the base AVD writable once, cold, and save the snapshot every box boots from.
pub async fn ensure_snapshot(env: &Env, s: &BoxSettings) -> Result<String, String> {
    if env.avd(s).1.is_some() {
        return Ok(format!(
            "snapshot {} adopted where it stands",
            s.android_snapshot
        ));
    }
    let emulator = env
        .sdk_bin("emulator/emulator")
        .ok_or("the SDK has no emulator")?;
    let adb = env.adb().ok_or("no adb")?;
    let mark = format!("setup-{}", uuid::Uuid::new_v4());
    let port = crate::android::Ports::default().pick()?;
    let serial = format!("emulator-{port}");
    let mut emu = proc::command(&emulator, &mark);
    emu.args([
        "-avd",
        &s.android_avd,
        "-no-window",
        "-no-audio",
        "-no-boot-anim",
        "-no-snapshot-load",
    ])
    .args(["-port", &port.to_string(), "-gpu", "swiftshader_indirect"])
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null());
    if let Some(home) = &env.avd_home {
        emu.env("ANDROID_AVD_HOME", home);
    }
    let _child = emu
        .spawn()
        .map_err(|e| format!("the emulator did not start: {e}"))?;
    let done = snapshot_once(&adb, &serial, &mark, &s.android_snapshot).await;
    let r = proc::reap(&mark, Duration::from_secs(20)).await;
    if !r.left.is_empty() {
        return Err(format!(
            "the setup emulator outlived its reap: {:?}",
            r.left
        ));
    }
    done.map(|()| format!("snapshot {} saved from a cold boot", s.android_snapshot))
}

async fn snapshot_once(adb: &Path, serial: &str, mark: &str, name: &str) -> Result<(), String> {
    let run = |args: Vec<String>| {
        let mut c = proc::command(adb, mark);
        c.arg("-s").arg(serial).args(args);
        act::run(c, Duration::from_secs(60))
    };
    let until = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let o = run(vec![
            "shell".into(),
            "getprop".into(),
            "sys.boot_completed".into(),
        ])
        .await;
        if o.exit_code == 0 && o.stdout.trim() == "1" {
            break;
        }
        if tokio::time::Instant::now() >= until {
            return Err("Android did not boot within 300 s for the snapshot".into());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    tokio::time::sleep(Duration::from_secs(10)).await;
    let o = run(["emu", "avd", "snapshot", "save", name]
        .map(String::from)
        .to_vec())
    .await;
    let _ = run(vec!["emu".into(), "kill".into()]).await;
    if o.exit_code == 0 && !o.stdout.contains("KO") {
        Ok(())
    } else {
        Err(format!(
            "snapshot save said: {} {}",
            o.stdout.trim(),
            o.stderr.trim()
        ))
    }
}

/// Every user-space step for `s`, each adopting what already stands.
pub async fn user_space(env: &Env, s: &BoxSettings) -> Vec<Step> {
    let mut steps = Vec::new();
    for tool in ["agent-browser", "agent-desktop", "agent-device"] {
        let version = s.pin(tool).unwrap_or_default().to_string();
        let done = match env.pinned(tool, &version) {
            Some(p) => Ok(format!("adopted {}", p.display())),
            None => install_npm(env, tool, &version)
                .await
                .map(|p| format!("installed {}", p.display())),
        };
        steps.push(Step {
            what: format!("{tool} {version}"),
            done,
        });
    }
    let sdk_ready = env.sdk_bin("emulator/emulator").is_some()
        && env.adb().is_some()
        && env.image_dir(s).is_some();
    steps.push(Step {
        what: "Android SDK".into(),
        done: if sdk_ready {
            Ok(format!("adopted {}", env.sdk.clone().unwrap_or_default().display()))
        } else {
            Err(format!(
                "the SDK at {} lacks the emulator, platform-tools or {}: run its sdkmanager for them",
                env.sdk.clone().unwrap_or_default().display(),
                s.android_image
            ))
        },
    });
    if sdk_ready {
        let avd = ensure_avd(env, s).await;
        let snap_ok = avd.is_ok();
        steps.push(Step {
            what: format!("base AVD {}", s.android_avd),
            done: avd,
        });
        if snap_ok {
            steps.push(Step {
                what: format!("snapshot {}", s.android_snapshot),
                done: ensure_snapshot(env, s).await,
            });
        }
    }
    steps
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::testkit::Scratch;

    #[test]
    fn the_root_plan_lists_only_what_is_missing() {
        let root = Scratch::new("setup");
        let env = Env {
            path: vec![root.path().join("bin")],
            tools_dir: root.path().join("tools"),
            sdk: None,
            avd_home: None,
            kvm: root.path().join("kvm"),
            scrcpy_server: root.path().join("scrcpy-server"),
            atspi_launcher: root.path().join("at-spi-bus-launcher"),
        };
        for b in [
            "ffmpeg", "java", "scrot", "Xvfb", "openbox", "x11vnc", "xdotool", "unzip",
        ] {
            root.script(&format!("bin/{b}"), "exit 0");
        }
        let rule = root.path().join("99-forge-kvm.rules");
        let plan = root_plan(&env, &["dev".into(), "kvm".into()], &rule);
        assert_eq!(plan.apt, vec!["scrcpy", "at-spi2-core"]);
        assert!(!plan.kvm_group);
        assert!(plan.udev_rule);
        root.script("bin/scrcpy", "exit 0");
        std::fs::write(&env.scrcpy_server, b"jar").unwrap();
        root.script("at-spi-bus-launcher", "exit 0");
        std::fs::write(&rule, UDEV_RULE).unwrap();
        assert!(root_plan(&env, &["kvm".into()], &rule).is_empty());
    }
}
