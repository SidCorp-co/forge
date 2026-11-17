//! `[box]` in `config.toml`: what this device runs its Forge Boxes with (ISS-1276, ADR 0015).
//!
//! The tool versions are pins, as `claude_version` is: moved only by a passing canary
//! (`forge-runner box canary`), never by an install. The reserves and the pressure ceiling are the
//! device's own resource limits, as `max_job_panes` is; the heartbeat reports them beside what it
//! measured and core decides. There is no count of boxes here: capacity is what is measured.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The X display nobody's box may take: `~/agent-display` serves a person's live desktop on it.
pub const FORBIDDEN_DISPLAY: u32 = 99;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BoxSettings {
    /// agent-browser, the browser mode's driver and stream.
    pub agent_browser: String,
    /// agent-desktop, the desktop mode's driver.
    pub agent_desktop: String,
    /// agent-device, the android mode's driver.
    pub agent_device: String,
    /// The Android system image the base AVD is made from (an `sdkmanager` package path).
    pub android_image: String,
    /// The base AVD every android box boots read-only from, and its snapshot.
    pub android_avd: String,
    pub android_snapshot: String,
    /// The Android SDK; unset, `$ANDROID_HOME`, then `~/Android/Sdk` (adopted where it stands).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub android_sdk: Option<PathBuf>,
    /// The system Chrome agent-browser drives: a downloaded one fails under AppArmor.
    pub chrome: PathBuf,
    /// Memory left free for everything else on the device; a box starts only above it.
    pub memory_reserve_mb: u64,
    /// Disk left free under the box data directory.
    pub disk_reserve_mb: u64,
    /// `/proc/pressure/cpu` `some avg10`, percent, above which nothing new starts.
    pub cpu_pressure_ceiling: f64,
    /// agent-browser's daemon idle timeout, pinned: its restart comes back on a new stream port.
    pub browser_idle_timeout_secs: u64,
    /// The X displays a desktop box picks from, first to last. :99 is never one of them.
    pub display_first: u32,
    pub display_last: u32,
    /// Where agent-browser's sockets go: short, because a socket path holds at most 103 bytes.
    pub socket_root: PathBuf,
    /// Recordings, cut clips and the tools this runner installs; unset, the user's data dir.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<PathBuf>,
}

impl Default for BoxSettings {
    fn default() -> Self {
        Self {
            agent_browser: "0.43.0".into(),
            agent_desktop: "1.3.1".into(),
            agent_device: "0.21.38".into(),
            android_image: "system-images;android-35;google_apis;x86_64".into(),
            android_avd: "forge-base-35".into(),
            android_snapshot: "forge-ready".into(),
            android_sdk: None,
            chrome: PathBuf::from("/usr/bin/google-chrome"),
            memory_reserve_mb: 16_384,
            disk_reserve_mb: 20_480,
            cpu_pressure_ceiling: 60.0,
            browser_idle_timeout_secs: 21_600,
            display_first: 100,
            display_last: 199,
            socket_root: PathBuf::from("/tmp/fbx"),
            data_dir: None,
        }
    }
}

impl BoxSettings {
    /// The data directory: the one named, else `<data dir>/forge-runner/box`, else (a user with no
    /// data dir) `<temp>/forge-runner-box`. One answer for the daemon, setup, doctor and the canary,
    /// so the tools setup installs are the ones a box runs.
    pub fn data_dir(&self) -> PathBuf {
        self.data_dir
            .clone()
            .or_else(|| dirs_next::data_local_dir().map(|d| d.join("forge-runner").join("box")))
            .unwrap_or_else(|| std::env::temp_dir().join("forge-runner-box"))
    }

    /// The SDK this device's android boxes run from.
    pub fn android_sdk(&self) -> Option<PathBuf> {
        self.android_sdk
            .clone()
            .or_else(|| std::env::var_os("ANDROID_HOME").map(PathBuf::from))
            .or_else(|| dirs_next::home_dir().map(|h| h.join("Android").join("Sdk")))
    }

    /// The pin of the tool named, as `forge-runner box install|canary <tool>` names it.
    pub fn pin(&self, tool: &str) -> Option<&str> {
        Some(match tool {
            "agent-browser" => &self.agent_browser,
            "agent-desktop" => &self.agent_desktop,
            "agent-device" => &self.agent_device,
            "android-image" => &self.android_image,
            _ => return None,
        })
    }

    /// Move the pin of the tool named; `false` where no such tool is pinned.
    pub fn set_pin(&mut self, tool: &str, version: &str) -> bool {
        let slot = match tool {
            "agent-browser" => &mut self.agent_browser,
            "agent-desktop" => &mut self.agent_desktop,
            "agent-device" => &mut self.agent_device,
            "android-image" => &mut self.android_image,
            _ => return false,
        };
        *slot = version.to_string();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_box_section_reads_as_the_defaults_and_a_pin_round_trips() {
        let cfg: BoxSettings = toml::from_str("").unwrap();
        assert_eq!(cfg, BoxSettings::default());
        let cfg: BoxSettings = toml::from_str("agent_browser = \"0.44.0\"").unwrap();
        assert_eq!(cfg.pin("agent-browser"), Some("0.44.0"));
        assert_eq!(cfg.agent_desktop, "1.3.1");
        let mut cfg = cfg;
        assert!(cfg.set_pin("agent-device", "0.22.0"));
        assert!(!cfg.set_pin("claude", "2.0.0"));
        let back: BoxSettings = toml::from_str(&toml::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(back, cfg);
    }
}
