//! A browser box: one agent-browser session driving the system Chrome (a downloaded Chrome fails
//! under AppArmor), its socket in a short directory of its own (a socket path holds at most 103
//! bytes), its daemon's idle timeout pinned so it never restarts under a live box unasked.
//!
//! agent-browser's stream WebSocket is the view and takes input too: a server-side client with no
//! Origin connects. The daemon writes the port to `<dir>/<session>.stream`, which is read again
//! for every viewer: a daemon that restarted comes back on a new port, and a port that is gone
//! is `STREAM_LOST`, said loudly, never a stale port quietly refused.

use std::path::{Path, PathBuf};
use std::time::Duration;

use runner_platform::box_settings::BoxSettings;

use crate::{act, proc};

/// The longest socket path the platform takes (`sockaddr_un`, less its terminator).
pub const SOCKET_PATH_MAX: usize = 103;
/// The session's name inside its own directory: one letter keeps the path short.
const SESSION: &str = "b";
pub const DEFAULT_VIEWPORT: (u32, u32) = (1280, 720);

pub struct Browser {
    box_id: String,
    bin: PathBuf,
    chrome: PathBuf,
    dir: PathBuf,
    idle_ms: u64,
    pub size: (u32, u32),
    pub recording: PathBuf,
}

/// The stream is gone: the daemon is not running, or runs with no stream port.
#[derive(Debug, Clone, PartialEq)]
pub struct StreamLost(pub String);

/// The directory a box's socket goes in, refused by name where its socket would be too long.
pub fn socket_dir(root: &Path, box_id: &str) -> Result<PathBuf, String> {
    let short: String = box_id
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .take(8)
        .collect();
    let dir = root.join(short);
    let sock = dir.join(format!("{SESSION}.sock"));
    let len = sock.as_os_str().len();
    if len > SOCKET_PATH_MAX {
        return Err(format!(
            "agent-browser's socket {} is {len} bytes, over the {SOCKET_PATH_MAX} a socket path holds: set [box] socket_root shorter",
            sock.display()
        ));
    }
    Ok(dir)
}

impl Browser {
    pub fn new(
        box_id: &str,
        bin: PathBuf,
        s: &BoxSettings,
        size: Option<(u32, u32)>,
        recording: PathBuf,
    ) -> Result<Self, String> {
        Ok(Self {
            box_id: box_id.to_string(),
            bin,
            chrome: s.chrome.clone(),
            dir: socket_dir(&s.socket_root, box_id)?,
            idle_ms: s.browser_idle_timeout_secs.saturating_mul(1000),
            size: size.unwrap_or(DEFAULT_VIEWPORT),
            recording,
        })
    }

    /// agent-browser with this box's session, marked as the box's.
    pub fn driver(&self, args: &[String]) -> tokio::process::Command {
        let mut cmd = proc::command(&self.bin, &self.box_id);
        cmd.args(args)
            .env("AGENT_BROWSER_EXECUTABLE_PATH", &self.chrome)
            .env("AGENT_BROWSER_NO_VERSION_CHECK", "1")
            .env("AGENT_BROWSER_SESSION", SESSION)
            .env("AGENT_BROWSER_SOCKET_DIR", &self.dir)
            .env("AGENT_BROWSER_IDLE_TIMEOUT_MS", self.idle_ms.to_string());
        cmd
    }

    async fn must(&self, args: &[&str], within: Duration) -> Result<String, String> {
        let argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let o = act::run(self.driver(&argv), within).await;
        if o.exit_code == 0 {
            Ok(o.stdout)
        } else {
            Err(format!(
                "`agent-browser {}` exited {}: {}{}",
                args.join(" "),
                o.exit_code,
                o.stderr.trim(),
                o.stdout.trim()
            ))
        }
    }

    /// Start the browser on `url`, size it, start recording, and find its stream.
    pub async fn open(&self, url: Option<&str>, within: Duration) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("cannot make {}: {e}", self.dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700));
        }
        if let Some(parent) = self.recording.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot make {}: {e}", parent.display()))?;
        }
        self.must(&["open", url.unwrap_or("about:blank")], within)
            .await?;
        let (w, h) = (self.size.0.to_string(), self.size.1.to_string());
        self.must(&["set", "viewport", &w, &h], within).await?;
        let rec = self.recording.to_string_lossy().into_owned();
        self.must(&["record", "start", &rec], within).await?;
        if self.stream_port().is_err() {
            self.must(&["stream", "enable"], within).await?;
        }
        self.stream_port().map(|_| ()).map_err(|l| l.0)
    }

    pub async fn navigate(&self, url: &str) -> Result<(), String> {
        self.must(&["open", url], Duration::from_secs(60))
            .await
            .map(|_| ())
    }

    /// The stream's port as the daemon wrote it now, read again on every call.
    pub fn stream_port(&self) -> Result<u16, StreamLost> {
        read_stream_port(&self.dir)
    }

    /// End the recording so it is a whole file, and close the browser. The reap follows.
    pub async fn stop(&self) {
        let within = Duration::from_secs(20);
        if let Err(e) = self.must(&["record", "stop"], within).await {
            tracing::warn!("[box] {}: {e}", self.box_id);
        }
        let _ = self.must(&["close"], within).await;
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// The port in `<dir>/b.stream`, and the daemon in `<dir>/b.pid` still running to serve it.
pub fn read_stream_port(dir: &Path) -> Result<u16, StreamLost> {
    let pid_file = dir.join(format!("{SESSION}.pid"));
    let pid: i32 = std::fs::read_to_string(&pid_file)
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .ok_or_else(|| {
            StreamLost(format!(
                "agent-browser's daemon is gone: {} names no running daemon",
                pid_file.display()
            ))
        })?;
    if !alive(pid) {
        return Err(StreamLost(format!(
            "agent-browser's daemon (pid {pid}) is no longer running"
        )));
    }
    let stream_file = dir.join(format!("{SESSION}.stream"));
    std::fs::read_to_string(&stream_file)
        .ok()
        .and_then(|p| p.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .ok_or_else(|| {
            StreamLost(format!(
                "agent-browser's daemon (pid {pid}) serves no stream port: {} is missing or empty",
                stream_file.display()
            ))
        })
}

#[cfg(unix)]
fn alive(pid: i32) -> bool {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
}

#[cfg(not(unix))]
fn alive(_pid: i32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Scratch;

    #[test]
    fn a_socket_root_too_long_for_a_socket_path_is_refused_by_name() {
        let id = "0b8e7a52-3c4d-4e6f-8a1b-2c3d4e5f6a7b";
        assert_eq!(
            socket_dir(Path::new("/tmp/fbx"), id).unwrap(),
            PathBuf::from("/tmp/fbx/0b8e7a52")
        );
        let long = PathBuf::from(format!("/tmp/{}", "d".repeat(90)));
        let err = socket_dir(&long, id).unwrap_err();
        assert!(err.contains("over the 103"), "{err}");
    }

    #[test]
    fn the_stream_port_is_read_again_each_time_and_a_lost_one_fails_loudly() {
        let dir = Scratch::new("stream");
        let lost = read_stream_port(dir.path()).unwrap_err();
        assert!(lost.0.contains("daemon is gone"), "{lost:?}");

        std::fs::write(dir.path().join("b.pid"), std::process::id().to_string()).unwrap();
        std::fs::write(dir.path().join("b.stream"), "35779\n").unwrap();
        assert_eq!(read_stream_port(dir.path()), Ok(35779));
        // the daemon restarted on a new port: the next read names the new one
        std::fs::write(dir.path().join("b.stream"), "41003").unwrap();
        assert_eq!(read_stream_port(dir.path()), Ok(41003));
        // a daemon with no stream port is lost, said by name
        std::fs::remove_file(dir.path().join("b.stream")).unwrap();
        let lost = read_stream_port(dir.path()).unwrap_err();
        assert!(lost.0.contains("serves no stream port"), "{lost:?}");
        // a daemon that died leaves its port behind: lost too, never the stale port
        std::fs::write(dir.path().join("b.stream"), "41003").unwrap();
        std::fs::write(dir.path().join("b.pid"), "2147483646").unwrap();
        let lost = read_stream_port(dir.path()).unwrap_err();
        assert!(lost.0.contains("no longer running"), "{lost:?}");
    }
}
