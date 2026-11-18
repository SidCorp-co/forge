//! A desktop box: a private Xvfb on a display of its own (never :99), openbox, and AT-SPI on a
//! D-Bus session of its own (`dbus-run-session`), driven by agent-desktop. Its view is x11vnc,
//! `-viewonly -shared` on a loopback port; its recording ffmpeg x11grab; a person's input X11
//! events through xdotool. Its runtime directory is its own too, so agent-desktop's state and the
//! AT-SPI bus of one box never meet another's.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use tokio::io::{AsyncBufReadExt, BufReader};

use crate::{display, proc, record};

pub const DEFAULT_SIZE: (u32, u32) = (1280, 800);
const VIEW_FPS: u32 = 10;

pub struct Tools {
    pub xvfb: PathBuf,
    pub dbus_run_session: PathBuf,
    pub openbox: PathBuf,
    pub atspi_launcher: PathBuf,
    pub x11vnc: PathBuf,
    pub xdotool: PathBuf,
    pub ffmpeg: PathBuf,
    pub agent_desktop: PathBuf,
}

pub struct Desktop {
    box_id: String,
    pub tools: Tools,
    pub display: u32,
    pub size: (u32, u32),
    pub recording: PathBuf,
    runtime: PathBuf,
    bus: Mutex<Option<String>>,
    vnc: Mutex<Option<u16>>,
    recorder: Mutex<Option<tokio::process::Child>>,
    rotating: tokio::sync::Mutex<()>,
    held: Mutex<Vec<tokio::process::Child>>,
}

impl Desktop {
    pub fn new(
        box_id: &str,
        tools: Tools,
        display: u32,
        size: Option<(u32, u32)>,
        recording: PathBuf,
        runtime: PathBuf,
    ) -> Self {
        Self {
            box_id: box_id.to_string(),
            tools,
            display,
            size: size.unwrap_or(DEFAULT_SIZE),
            recording,
            runtime,
            bus: Mutex::new(None),
            vnc: Mutex::new(None),
            recorder: Mutex::new(None),
            rotating: tokio::sync::Mutex::new(()),
            held: Mutex::new(Vec::new()),
        }
    }

    fn env(&self, cmd: &mut tokio::process::Command) {
        cmd.env("DISPLAY", format!(":{}", self.display))
            .env("XDG_RUNTIME_DIR", &self.runtime)
            .env("GDK_BACKEND", "x11")
            .env("GTK_A11Y", "atspi")
            .env("NO_AT_BRIDGE", "0")
            .env("GSK_RENDERER", "cairo")
            .env("LIBGL_ALWAYS_SOFTWARE", "1")
            .env("GTK_USE_PORTAL", "0")
            .env("GDK_DEBUG", "no-portals")
            .env("GIO_USE_VFS", "local");
        if let Some(bus) = self.bus.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            cmd.env("DBUS_SESSION_BUS_ADDRESS", bus);
        }
    }

    fn marked(&self, program: &Path) -> tokio::process::Command {
        let mut cmd = proc::command(program, &self.box_id);
        self.env(&mut cmd);
        cmd
    }

    /// agent-desktop on this box's display and session bus.
    pub fn driver(&self, args: &[String]) -> tokio::process::Command {
        let mut cmd = self.marked(&self.tools.agent_desktop);
        cmd.args(args);
        cmd
    }

    /// xdotool on this box's display.
    pub fn xdotool(&self, args: &[String]) -> tokio::process::Command {
        let mut cmd = self.marked(&self.tools.xdotool);
        cmd.args(args);
        cmd
    }

    fn keep(&self, child: tokio::process::Child) {
        self.held
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(child);
    }

    /// Start the display, the session, AT-SPI and the view. Nothing records until asked
    /// (`start_recording`, ISS-1321).
    pub async fn open(&self, x: &display::XDirs) -> Result<(), String> {
        for dir in [Some(self.runtime.as_path()), self.recording.parent()]
            .into_iter()
            .flatten()
        {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.runtime, std::fs::Permissions::from_mode(0o700));
        }
        let (w, h) = self.size;
        let mut xvfb = self.marked(&self.tools.xvfb);
        xvfb.arg(format!(":{}", self.display))
            .args(["-screen", "0", &format!("{w}x{h}x24"), "-nolisten", "tcp"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        self.keep(
            xvfb.spawn()
                .map_err(|e| format!("Xvfb did not start: {e}"))?,
        );
        wait_for(Duration::from_secs(10), || display::is_up(x, self.display))
            .await
            .map_err(|_| format!("Xvfb :{} made no socket in 10 s", self.display))?;
        self.start_session().await?;
        let mut atspi = self.marked(&self.tools.atspi_launcher);
        atspi
            .arg("--launch-immediately")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        self.keep(
            atspi
                .spawn()
                .map_err(|e| format!("at-spi-bus-launcher did not start: {e}"))?,
        );
        self.start_view().await
    }

    /// `dbus-run-session` running openbox, the session's address read from its first line.
    async fn start_session(&self) -> Result<(), String> {
        let mut session = self.marked(&self.tools.dbus_run_session);
        session
            .args([
                "--",
                "/bin/sh",
                "-c",
                "printf '%s\\n' \"$DBUS_SESSION_BUS_ADDRESS\"; exec \"$0\"",
            ])
            .arg(&self.tools.openbox)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let mut child = session
            .spawn()
            .map_err(|e| format!("dbus-run-session did not start: {e}"))?;
        let out = child
            .stdout
            .take()
            .ok_or("dbus-run-session gave no stdout")?;
        let mut line = String::new();
        tokio::time::timeout(
            Duration::from_secs(10),
            BufReader::new(out).read_line(&mut line),
        )
        .await
        .map_err(|_| "dbus-run-session named no bus address in 10 s".to_string())?
        .map_err(|e| format!("dbus-run-session: {e}"))?;
        let bus = line.trim().to_string();
        if !bus.contains('=') {
            return Err(format!("dbus-run-session named no bus address: {bus:?}"));
        }
        *self.bus.lock().unwrap_or_else(|p| p.into_inner()) = Some(bus);
        self.keep(child);
        Ok(())
    }

    async fn start_view(&self) -> Result<(), String> {
        let port = free_port().ok_or("no free loopback port for the box's view")?;
        let mut vnc = self.marked(&self.tools.x11vnc);
        vnc.args([
            "-display",
            &format!(":{}", self.display),
            "-rfbport",
            &port.to_string(),
        ])
        .args([
            "-localhost",
            "-viewonly",
            "-shared",
            "-forever",
            "-nopw",
            "-quiet",
            "-noxdamage",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
        self.keep(
            vnc.spawn()
                .map_err(|e| format!("x11vnc did not start: {e}"))?,
        );
        wait_for(Duration::from_secs(10), || {
            std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
        })
        .await
        .map_err(|_| format!("x11vnc did not listen on {port} in 10 s"))?;
        *self.vnc.lock().unwrap_or_else(|p| p.into_inner()) = Some(port);
        Ok(())
    }

    /// Start recording the display into the live file (ISS-1321).
    pub async fn record_on(&self) -> Result<(), String> {
        let _one = self.rotating.lock().await;
        self.start_recording()
    }

    /// Stop recording, closing the live file into a segment named for `file_start`.
    pub async fn record_off(&self, file_start: SystemTime) -> Result<(), String> {
        let _one = self.rotating.lock().await;
        self.end_recording().await;
        record::seal(&self.recording, file_start).map(|_| ())
    }

    fn start_recording(&self) -> Result<(), String> {
        let (w, h) = self.size;
        let mut ff = self.marked(&self.tools.ffmpeg);
        ff.args([
            "-loglevel",
            "error",
            "-f",
            "x11grab",
            "-video_size",
            &format!("{w}x{h}"),
        ])
        .args([
            "-framerate",
            &VIEW_FPS.to_string(),
            "-i",
            &format!(":{}", self.display),
        ])
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-f",
            "matroska",
        ])
        .arg(&self.recording)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
        let child = ff
            .spawn()
            .map_err(|e| format!("ffmpeg x11grab did not start: {e}"))?;
        *self.recorder.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
        Ok(())
    }

    /// The view's loopback port.
    pub fn view_port(&self) -> Option<u16> {
        *self.vnc.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Close the recording so far into a segment and start the next: ffmpeg's matroska is
    /// buffered, and a cut reads only what it has written.
    pub async fn rotate(&self, file_start: SystemTime) -> Result<SystemTime, String> {
        let _one = self.rotating.lock().await;
        self.end_recording().await;
        record::seal(&self.recording, file_start)?;
        let next = SystemTime::now();
        self.start_recording()?;
        Ok(next)
    }

    /// End the recording with `q`, so it closes as a whole file; one that will not is killed.
    async fn end_recording(&self) {
        let child = self
            .recorder
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(mut ff) = child {
            if let Some(mut stdin) = ff.stdin.take() {
                let _ = tokio::io::AsyncWriteExt::write_all(&mut stdin, b"q").await;
            }
            if tokio::time::timeout(Duration::from_secs(10), ff.wait())
                .await
                .is_err()
            {
                tracing::warn!("[box] {}: ffmpeg ignored `q`; killed", self.box_id);
                let _ = ff.kill().await;
            }
        }
    }

    /// End a running recording as a whole file. The reap follows.
    pub async fn stop(&self) {
        self.end_recording().await;
    }
}

async fn wait_for(within: Duration, ready: impl Fn() -> bool) -> Result<(), ()> {
    let until = tokio::time::Instant::now() + within;
    while !ready() {
        if tokio::time::Instant::now() >= until {
            return Err(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

/// A loopback port free now.
pub fn free_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()?
        .local_addr()
        .ok()
        .map(|a| a.port())
}
