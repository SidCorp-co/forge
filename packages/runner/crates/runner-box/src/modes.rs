//! Which modes this device can serve, from the tools it finds, with what each lacks, the command
//! that fixes it, what a box of it costs and the pinned versions it runs (`boxModeReportSchema`).
//! `forge-runner doctor` prints the same report core receives on the heartbeat. `ios` is reported
//! unserved by name: a Linux device has no iOS Simulator.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use runner_platform::box_settings::BoxSettings;
use serde::Serialize;

/// What one box of a mode costs while it runs.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    pub memory_mb: u64,
    pub disk_mb: u64,
    pub cpu_cores: f64,
}

/// The costs measured on sid-xeon-1 (2026-11-17): an emulator 3.7 GB and 3-4 cores while driven,
/// its read-only overlay on disk; Chrome with one page and the desktop's Xvfb stack far less.
/// A heavier box seen running raises its mode's memory cost ([`Observed`]).
pub fn base_cost(mode: &str) -> Cost {
    match mode {
        "android" => Cost {
            memory_mb: 3_800,
            disk_mb: 2_048,
            cpu_cores: 3.5,
        },
        "browser" => Cost {
            memory_mb: 700,
            disk_mb: 300,
            cpu_cores: 1.0,
        },
        "desktop" => Cost {
            memory_mb: 500,
            disk_mb: 300,
            cpu_cores: 1.0,
        },
        _ => Cost {
            memory_mb: 0,
            disk_mb: 0,
            cpu_cores: 0.0,
        },
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModeReport {
    pub mode: &'static str,
    pub serves: bool,
    pub lacks: Vec<String>,
    pub fix: Option<String>,
    pub cost: Cost,
    pub versions: BTreeMap<String, String>,
}

/// Where this device's tools are looked for.
#[derive(Debug, Clone)]
pub struct Env {
    pub path: Vec<PathBuf>,
    /// Where `forge-runner box install` puts the pinned tools: `<tool>/<version>/`.
    pub tools_dir: PathBuf,
    pub sdk: Option<PathBuf>,
    pub avd_home: Option<PathBuf>,
    pub kvm: PathBuf,
    pub scrcpy_server: PathBuf,
    pub atspi_launcher: PathBuf,
}

impl Env {
    /// This host as it stands.
    pub fn of_host(settings: &BoxSettings, data_dir: &Path) -> Self {
        let path = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        let avd_home = std::env::var_os("ANDROID_AVD_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs_next::home_dir().map(|h| h.join(".android").join("avd")));
        Self {
            path,
            tools_dir: data_dir.join("tools"),
            sdk: settings.android_sdk(),
            avd_home,
            kvm: PathBuf::from("/dev/kvm"),
            scrcpy_server: PathBuf::from("/usr/share/scrcpy/scrcpy-server"),
            atspi_launcher: PathBuf::from("/usr/libexec/at-spi-bus-launcher"),
        }
    }

    /// An executable named `name` on the path.
    pub fn which(&self, name: &str) -> Option<PathBuf> {
        self.path
            .iter()
            .map(|d| d.join(name))
            .find(|p| executable(p))
    }

    /// A pinned npm tool: `forge-runner box install`'s copy of exactly `version`, else one on the
    /// path that says it is `version` (this device's own install, adopted where it stands).
    pub fn pinned(&self, tool: &str, version: &str) -> Option<PathBuf> {
        let installed = self
            .tools_dir
            .join(tool)
            .join(version)
            .join("node_modules")
            .join(".bin")
            .join(tool);
        if executable(&installed) {
            return Some(installed);
        }
        self.which(tool)
            .filter(|p| version_of(p).is_some_and(|v| says_version(&v, version)))
    }

    /// The SDK's own binary at `rel`, e.g. `emulator/emulator`.
    pub fn sdk_bin(&self, rel: &str) -> Option<PathBuf> {
        self.sdk
            .as_ref()
            .map(|s| s.join(rel))
            .filter(|p| executable(p))
    }

    pub fn adb(&self) -> Option<PathBuf> {
        self.sdk_bin("platform-tools/adb")
            .or_else(|| self.which("adb"))
    }

    /// The base AVD's ini, and its snapshot directory.
    pub fn avd(&self, settings: &BoxSettings) -> (Option<PathBuf>, Option<PathBuf>) {
        let Some(home) = &self.avd_home else {
            return (None, None);
        };
        let ini = home.join(format!("{}.ini", settings.android_avd));
        let snap = home
            .join(format!("{}.avd", settings.android_avd))
            .join("snapshots")
            .join(&settings.android_snapshot);
        (ini.is_file().then_some(ini), snap.is_dir().then_some(snap))
    }

    /// The system image's directory in the SDK.
    pub fn image_dir(&self, settings: &BoxSettings) -> Option<PathBuf> {
        let dir = self
            .sdk
            .as_ref()?
            .join(settings.android_image.replace(';', "/"));
        dir.join("system.img").is_file().then_some(dir)
    }
}

/// Whether `version_line` (a tool's `--version`) names exactly `version`.
fn says_version(version_line: &str, version: &str) -> bool {
    version_line
        .split(|c: char| c.is_whitespace() || c == 'v')
        .any(|w| w == version)
}

#[cfg(unix)]
pub fn executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
pub fn executable(p: &Path) -> bool {
    p.is_file()
}

/// `<bin> --version`, cached by the binary's path and modification time.
fn version_of(bin: &Path) -> Option<String> {
    static CACHE: Mutex<BTreeMap<PathBuf, (std::time::SystemTime, String)>> =
        Mutex::new(BTreeMap::new());
    let mtime = std::fs::metadata(bin).ok()?.modified().ok()?;
    if let Some((at, v)) = CACHE.lock().ok()?.get(bin) {
        if *at == mtime {
            return Some(v.clone());
        }
    }
    let v = run_within(bin, &["--version"], Duration::from_secs(5))?;
    CACHE
        .lock()
        .ok()?
        .insert(bin.to_path_buf(), (mtime, v.clone()));
    Some(v)
}

/// A short command's stdout, or None where it failed or outran `within`.
pub fn run_within(bin: &Path, args: &[&str], within: Duration) -> Option<String> {
    let mut child = std::process::Command::new(bin)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let until = std::time::Instant::now() + within;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if std::time::Instant::now() >= until => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    Some(out.trim().to_string())
}

/// One thing a mode needs, and whether `forge-runner setup` (root, asked once) or
/// `forge-runner box setup` (this user) provides it.
struct Need {
    what: String,
    root: bool,
}

fn root(what: &str) -> Need {
    Need {
        what: what.into(),
        root: true,
    }
}

fn user(what: String) -> Need {
    Need { what, root: false }
}

fn report(
    mode: &'static str,
    needs: Vec<Need>,
    versions: BTreeMap<String, String>,
    cost: Cost,
) -> ModeReport {
    let fix = if needs.is_empty() {
        None
    } else if needs.iter().any(|n| n.root) {
        Some("forge-runner setup (asks once for sudo, then installs this user's tools)".into())
    } else {
        Some("forge-runner box setup".into())
    };
    ModeReport {
        mode,
        serves: needs.is_empty(),
        lacks: needs.into_iter().map(|n| n.what).collect(),
        fix,
        cost,
        versions,
    }
}

fn need_bin(env: &Env, needs: &mut Vec<Need>, bin: &str, package: &str) {
    if env.which(bin).is_none() {
        needs.push(root(&format!("{bin} (apt {package})")));
    }
}

fn need_pinned(env: &Env, needs: &mut Vec<Need>, tool: &str, version: &str) {
    if env.pinned(tool, version).is_none() {
        needs.push(user(format!("{tool} {version} (pinned)")));
    }
}

pub fn browser(env: &Env, s: &BoxSettings) -> ModeReport {
    let mut needs = Vec::new();
    need_pinned(env, &mut needs, "agent-browser", &s.agent_browser);
    if !executable(&s.chrome) {
        needs.push(root(&format!("system Chrome at {}", s.chrome.display())));
    }
    need_bin(env, &mut needs, "ffmpeg", "ffmpeg");
    let versions = BTreeMap::from([("agent-browser".to_string(), s.agent_browser.clone())]);
    report("browser", needs, versions, base_cost("browser"))
}

pub fn android(env: &Env, s: &BoxSettings) -> ModeReport {
    let mut needs = Vec::new();
    if env.sdk_bin("emulator/emulator").is_none() {
        needs.push(user("Android emulator (SDK)".into()));
    }
    if env.adb().is_none() {
        needs.push(user("adb (SDK platform-tools)".into()));
    }
    if env.image_dir(s).is_none() {
        needs.push(user(format!("system image {}", s.android_image)));
    }
    match env.avd(s) {
        (None, _) => needs.push(user(format!("base AVD {}", s.android_avd))),
        (Some(_), None) => needs.push(user(format!(
            "snapshot {} of the base AVD {}",
            s.android_snapshot, s.android_avd
        ))),
        _ => {}
    }
    if !kvm_writable(&env.kvm) {
        needs.push(root("/dev/kvm writable (kvm group and udev rule)"));
    }
    if !env.scrcpy_server.is_file() {
        needs.push(root("scrcpy-server (apt scrcpy)"));
    }
    need_pinned(env, &mut needs, "agent-device", &s.agent_device);
    if env.which("node").is_none() {
        needs.push(root("node (agent-device runs on it)"));
    }
    need_bin(env, &mut needs, "ffmpeg", "ffmpeg");
    let versions = BTreeMap::from([
        ("agent-device".to_string(), s.agent_device.clone()),
        ("android-image".to_string(), s.android_image.clone()),
    ]);
    report("android", needs, versions, base_cost("android"))
}

pub fn desktop(env: &Env, s: &BoxSettings) -> ModeReport {
    let mut needs = Vec::new();
    for (bin, pkg) in [
        ("Xvfb", "xvfb"),
        ("openbox", "openbox"),
        ("dbus-run-session", "dbus"),
        ("x11vnc", "x11vnc"),
        ("xdotool", "xdotool"),
        ("ffmpeg", "ffmpeg"),
    ] {
        need_bin(env, &mut needs, bin, pkg);
    }
    if !executable(&env.atspi_launcher) {
        needs.push(root("at-spi-bus-launcher (apt at-spi2-core)"));
    }
    need_pinned(env, &mut needs, "agent-desktop", &s.agent_desktop);
    let versions = BTreeMap::from([("agent-desktop".to_string(), s.agent_desktop.clone())]);
    report("desktop", needs, versions, base_cost("desktop"))
}

pub fn ios() -> ModeReport {
    ModeReport {
        mode: "ios",
        serves: false,
        lacks: vec!["a macOS host with the iOS Simulator".into()],
        fix: None,
        cost: base_cost("ios"),
        versions: BTreeMap::new(),
    }
}

/// Every mode, served or not, in the order the contract names them.
pub fn all(env: &Env, s: &BoxSettings) -> Vec<ModeReport> {
    vec![browser(env, s), android(env, s), desktop(env, s), ios()]
}

#[cfg(unix)]
pub fn kvm_writable(path: &Path) -> bool {
    use nix::unistd::{access, AccessFlags};
    access(path, AccessFlags::R_OK | AccessFlags::W_OK).is_ok()
}

#[cfg(not(unix))]
pub fn kvm_writable(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests;
