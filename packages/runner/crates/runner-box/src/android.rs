//! An android box: the emulator `-no-window -read-only` off the base AVD and its snapshot (every
//! instance sharing an AVD must be read-only, or the others refuse it), recording itself through
//! its console's `screenrecord`, adb to reach it, agent-device to drive it. The adb server is shared by every
//! android box and started unmarked, so one box's close never takes another's device away.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use crate::{act, proc, record};

/// The console ports the adb server finds emulators on by itself: 5554, 5556 … 5584.
pub const PORTS: std::ops::RangeInclusive<u16> = 5554..=5584;

/// The emulator ports this runner is between choosing and its emulator holding, and whether the
/// adb server every android box shares is one this runner started.
#[derive(Default)]
pub struct Ports(Mutex<BTreeSet<u16>>, std::sync::atomic::AtomicBool);

impl Ports {
    /// A free even console port whose adb port beside it is free too.
    pub fn pick(&self) -> Result<u16, String> {
        let mut held = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let port = PORTS
            .step_by(2)
            .find(|p| !held.contains(p) && free(*p) && free(p + 1))
            .ok_or_else(|| {
                "every emulator console port 5554..5584 is in use: the adb server finds no more emulators"
                    .to_string()
            })?;
        held.insert(port);
        Ok(port)
    }

    pub fn release(&self, port: u16) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&port);
    }

    /// Start the shared adb server, unmarked, so no one box's reap takes it; note it was ours.
    pub async fn start_adb(&self, adb: &std::path::Path) {
        let out = tokio::process::Command::new(adb)
            .arg("start-server")
            .env_remove(proc::MARK)
            .output()
            .await;
        let said = out.map(|o| {
            format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            )
        });
        if said.is_ok_and(|s| s.contains("daemon started successfully")) {
            self.1.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// The last android box closed: stop the adb server where this runner started it.
    pub async fn stop_adb_if_ours(&self, adb: &std::path::Path) {
        if self.1.swap(false, std::sync::atomic::Ordering::SeqCst) {
            let _ = tokio::process::Command::new(adb)
                .arg("kill-server")
                .env_remove(proc::MARK)
                .output()
                .await;
        }
    }
}

fn free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub struct Tools {
    pub emulator: PathBuf,
    pub adb: PathBuf,
    pub agent_device: PathBuf,
    pub sdk: PathBuf,
    pub scrcpy_server: PathBuf,
    pub scrcpy_version: String,
    /// The directory of the node agent-device runs on.
    pub node_dir: Option<PathBuf>,
    /// Where the base AVD is, as doctor found it.
    pub avd_home: Option<PathBuf>,
}

pub struct Android {
    box_id: String,
    pub tools: Tools,
    pub port: u16,
    pub serial: String,
    size: Mutex<(u32, u32)>,
    pub recording: PathBuf,
    state_dir: PathBuf,
    emulator: Mutex<Option<tokio::process::Child>>,
    rotating: tokio::sync::Mutex<()>,
}

impl Android {
    pub fn new(
        box_id: &str,
        tools: Tools,
        port: u16,
        recording: PathBuf,
        state_dir: PathBuf,
    ) -> Self {
        Self {
            box_id: box_id.to_string(),
            tools,
            port,
            serial: format!("emulator-{port}"),
            size: Mutex::new((1080, 2400)),
            recording,
            state_dir,
            emulator: Mutex::new(None),
            rotating: tokio::sync::Mutex::new(()),
        }
    }

    /// `adb -s <serial> <args>`, its output, or what it said on failing.
    pub async fn adb(&self, args: &[&str], within: Duration) -> Result<String, String> {
        let mut cmd = proc::command(&self.tools.adb, &self.box_id);
        cmd.args(["-s", &self.serial]).args(args);
        let o = act::run(cmd, within).await;
        if o.exit_code == 0 {
            Ok(o.stdout)
        } else {
            Err(format!(
                "`adb {}` exited {}: {}",
                args.join(" "),
                o.exit_code,
                o.stderr.trim()
            ))
        }
    }

    /// agent-device for this emulator, with a daemon and state of this box's own.
    pub fn driver(&self, args: &[String]) -> tokio::process::Command {
        let mut cmd = proc::command(&self.tools.agent_device, &self.box_id);
        let mut path = vec![self.tools.sdk.join("platform-tools")];
        path.extend(self.tools.node_dir.clone());
        path.extend(
            std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
                .unwrap_or_default(),
        );
        cmd.args(args)
            .args(["--platform", "android", "--serial", &self.serial])
            .env("AGENT_DEVICE_STATE_DIR", &self.state_dir)
            .env("ANDROID_HOME", &self.tools.sdk)
            .env("ANDROID_SDK_ROOT", &self.tools.sdk)
            .env("PATH", std::env::join_paths(path).unwrap_or_default());
        cmd
    }

    /// Boot the emulator, wait for Android, push scrcpy's server, open `url` where one is named.
    /// Nothing records until asked (`start_recording`, ISS-1321).
    pub async fn open(
        &self,
        avd: &str,
        snapshot: &str,
        url: Option<&str>,
        within: Duration,
    ) -> Result<(), String> {
        let until = tokio::time::Instant::now() + within;
        for dir in [self.recording.parent(), Some(self.state_dir.as_path())]
            .into_iter()
            .flatten()
        {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
        }
        let log = std::fs::File::create(self.state_dir.join("emulator.log"))
            .map_err(|e| format!("emulator log: {e}"))?;
        let mut emu = proc::command(&self.tools.emulator, &self.box_id);
        emu.args([
            "-avd",
            avd,
            "-read-only",
            "-no-window",
            "-no-audio",
            "-no-boot-anim",
        ])
        .args([
            "-port",
            &self.port.to_string(),
            "-snapshot",
            snapshot,
            "-no-snapshot-save",
        ])
        .args(["-gpu", "swiftshader_indirect"])
        .env("ANDROID_HOME", &self.tools.sdk)
        .env("ANDROID_SDK_ROOT", &self.tools.sdk)
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
        if let Some(home) = &self.tools.avd_home {
            emu.env("ANDROID_AVD_HOME", home);
        }
        let child = emu
            .spawn()
            .map_err(|e| format!("the emulator did not start: {e}"))?;
        *self.emulator.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
        self.wait_booted(until).await?;
        let server = self.tools.scrcpy_server.to_string_lossy().into_owned();
        self.adb(
            &["push", &server, crate::scrcpy::DEVICE_JAR],
            Duration::from_secs(60),
        )
        .await?;
        if let Some(url) = url {
            self.navigate(url).await?;
        }
        Ok(())
    }

    /// Start recording the screen into the live file (ISS-1321).
    pub async fn start_recording(&self) -> Result<(), String> {
        let _one = self.rotating.lock().await;
        self.record("start").await
    }

    /// Stop recording, closing the live file into a segment named for `file_start`.
    pub async fn stop_recording(&self, file_start: SystemTime) -> Result<(), String> {
        let _one = self.rotating.lock().await;
        self.record("stop").await?;
        record::seal(&self.recording, file_start).map(|_| ())
    }

    /// The emulator console's screen recorder: `-record-session` is never finalised by `emu kill`
    /// and starts at launch, where `screenrecord stop` closes a whole file.
    async fn record(&self, verb: &str) -> Result<(), String> {
        let rec = self.recording.to_string_lossy().into_owned();
        let mut args = vec!["emu", "screenrecord", verb];
        if verb == "start" {
            args.push(&rec);
        }
        let said = self.adb(&args, Duration::from_secs(20)).await?;
        if said.lines().any(|l| l.starts_with("KO")) {
            return Err(format!(
                "`adb emu screenrecord {verb}` said: {}",
                said.trim()
            ));
        }
        Ok(())
    }

    /// Close the recording so far into a segment and start the next (see `record`).
    pub async fn rotate(&self, file_start: SystemTime) -> Result<SystemTime, String> {
        let _one = self.rotating.lock().await;
        self.record("stop").await?;
        record::seal(&self.recording, file_start)?;
        let next = SystemTime::now();
        self.record("start").await?;
        Ok(next)
    }

    async fn wait_booted(&self, until: tokio::time::Instant) -> Result<(), String> {
        loop {
            if let Some(status) = self.exited() {
                let tail = std::fs::read_to_string(self.state_dir.join("emulator.log"))
                    .unwrap_or_default();
                let tail: String = tail
                    .chars()
                    .rev()
                    .take(1500)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                return Err(format!(
                    "the emulator exited {status} before Android booted: {tail}"
                ));
            }
            let booted = self
                .adb(
                    &["shell", "getprop", "sys.boot_completed"],
                    Duration::from_secs(5),
                )
                .await
                .is_ok_and(|v| v.trim() == "1");
            if booted {
                if let Ok(size) = self
                    .adb(&["shell", "wm", "size"], Duration::from_secs(5))
                    .await
                {
                    self.size_from(&size);
                }
                return Ok(());
            }
            if tokio::time::Instant::now() >= until {
                return Err(format!(
                    "Android on {} did not finish booting in time",
                    self.serial
                ));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    fn size_from(&self, wm: &str) {
        let pick = |prefix: &str| {
            wm.lines()
                .find_map(|l| l.trim().strip_prefix(prefix))
                .and_then(|v| v.trim().split_once('x'))
                .and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?)))
        };
        if let Some(size) = pick("Override size:").or_else(|| pick("Physical size:")) {
            *self.size.lock().unwrap_or_else(|p| p.into_inner()) = size;
        }
    }

    /// The screen's size as `wm size` said it while the box opened.
    pub fn size(&self) -> (u32, u32) {
        *self.size.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn exited(&self) -> Option<String> {
        let mut guard = self.emulator.lock().unwrap_or_else(|p| p.into_inner());
        let child = guard.as_mut()?;
        child.try_wait().ok().flatten().map(|s| s.to_string())
    }

    /// Open `url` in Android's handler for it (a browser, or an Expo dev build's own scheme).
    pub async fn navigate(&self, url: &str) -> Result<(), String> {
        self.adb(
            &[
                "shell",
                "am",
                "start",
                "-a",
                "android.intent.action.VIEW",
                "-d",
                url,
            ],
            Duration::from_secs(30),
        )
        .await
        .map(|_| ())
    }

    /// End a running recording as a whole file, then stop the emulator through its console.
    pub async fn stop(&self, recording: bool) {
        if recording {
            if let Err(e) = self.record("stop").await {
                tracing::warn!("[box] {}: {e}", self.box_id);
            }
        }
        let _ = self.adb(&["emu", "kill"], Duration::from_secs(10)).await;
        let child = self
            .emulator
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(mut child) = child {
            if tokio::time::timeout(Duration::from_secs(20), child.wait())
                .await
                .is_err()
            {
                tracing::warn!(
                    "[box] {}: the emulator outlived `emu kill`; the reap stops it",
                    self.box_id
                );
            }
        }
    }
}
