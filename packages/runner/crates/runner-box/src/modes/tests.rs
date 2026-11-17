//! Doctor lists only the modes whose tools are present: a device with a browser's tools and
//! nothing else serves browser, and names for android and desktop what each lacks and the command
//! that fixes it.

use super::*;
use crate::testkit::Scratch;

fn env_in(root: &Scratch) -> Env {
    Env {
        path: vec![root.path().join("bin")],
        tools_dir: root.path().join("tools"),
        sdk: Some(root.path().join("sdk")),
        avd_home: Some(root.path().join("avd")),
        kvm: root.path().join("no-kvm"),
        scrcpy_server: root.path().join("scrcpy-server"),
        atspi_launcher: root.path().join("at-spi-bus-launcher"),
    }
}

fn settings(root: &Scratch) -> BoxSettings {
    BoxSettings {
        chrome: root.path().join("bin/google-chrome"),
        ..BoxSettings::default()
    }
}

#[cfg(unix)]
#[test]
fn doctor_lists_only_the_modes_whose_tools_are_present() {
    let root = Scratch::new("modes");
    let env = env_in(&root);
    let s = settings(&root);
    // a browser's tools: agent-browser at its pin on the path, the system Chrome, ffmpeg
    root.script("bin/agent-browser", "echo 'agent-browser 0.43.0'");
    root.script("bin/google-chrome", "exit 0");
    root.script("bin/ffmpeg", "exit 0");
    // an agent-desktop that is not the pinned version is not adopted
    root.script("bin/agent-desktop", "echo 'agent-desktop 1.2.0'");

    let all = all(&env, &s);
    let serves: Vec<&str> = all.iter().filter(|m| m.serves).map(|m| m.mode).collect();
    assert_eq!(serves, vec!["browser"], "{all:#?}");

    let android = &all[1];
    assert_eq!(android.mode, "android");
    for lack in [
        "Android emulator (SDK)",
        "base AVD forge-base-35",
        "/dev/kvm writable (kvm group and udev rule)",
        "agent-device 0.21.38 (pinned)",
    ] {
        assert!(
            android.lacks.iter().any(|l| l == lack),
            "android lacks {lack}: {:?}",
            android.lacks
        );
    }
    assert!(android
        .fix
        .as_deref()
        .unwrap()
        .starts_with("forge-runner setup"));

    let desktop = &all[2];
    assert!(
        desktop.lacks.contains(&"Xvfb (apt xvfb)".to_string()),
        "{:?}",
        desktop.lacks
    );
    assert!(desktop
        .lacks
        .contains(&"agent-desktop 1.3.1 (pinned)".to_string()));
    assert_eq!(all[3].mode, "ios");
    assert!(!all[3].serves);
    assert!(all[0].lacks.is_empty() && all[0].fix.is_none());
    assert!(
        all[1].cost.memory_mb > all[0].cost.memory_mb,
        "android costs more than browser"
    );
}

#[cfg(unix)]
#[test]
fn a_mode_lacking_only_this_users_tools_is_fixed_without_root() {
    let root = Scratch::new("modes");
    let env = env_in(&root);
    let s = settings(&root);
    root.script("bin/google-chrome", "exit 0");
    root.script("bin/ffmpeg", "exit 0");
    let b = browser(&env, &s);
    assert_eq!(b.lacks, vec!["agent-browser 0.43.0 (pinned)".to_string()]);
    assert_eq!(b.fix.as_deref(), Some("forge-runner box setup"));
    // the runner's own install of the pin is found without anything on the path
    root.script(
        "tools/agent-browser/0.43.0/node_modules/.bin/agent-browser",
        "exit 0",
    );
    assert!(browser(&env, &s).serves);
}

#[test]
fn a_version_line_names_the_pin_only_as_a_whole_word() {
    assert!(says_version("agent-browser 0.43.0", "0.43.0"));
    assert!(says_version("v0.21.38", "0.21.38"));
    assert!(!says_version("agent-browser 0.43.01", "0.43.0"));
    assert!(!says_version("agent-desktop 1.2.0", "1.3.1"));
}
