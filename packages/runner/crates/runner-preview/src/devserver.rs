//! The dev server a preview runs (BC-2, BC-10, BC-12): the project's own command, started in the
//! run's worktree and bound to loopback, watched until it answers on its port, exits, or never
//! answers. The box decides nothing about the setting; core sent it. What it reports is the outcome
//! and, on failure, the tail of the server's own output.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};

/// The most of the dev server's output a failure keeps, in characters (`PREVIEW_LIMITS.detail`).
pub const DETAIL_LIMIT: usize = 2000;
const PLACEHOLDER: &str = "{port}";
const READY_POLL: Duration = Duration::from_millis(250);
pub const STOP_GRACE: Duration = Duration::from_secs(5);

/// `previewSettingsSchema` as core sends it on `preview.start`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Settings {
    pub command: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Why a dev server is not serving, in the contract's words (`PREVIEW_FAILURE_REASONS`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub reason: &'static str,
    pub detail: String,
}

impl Failure {
    fn new(reason: &'static str, detail: impl Into<String>) -> Self {
        Self {
            reason,
            detail: tail(&detail.into(), DETAIL_LIMIT),
        }
    }
}

/// The last `limit` characters of `text`.
pub fn tail(text: &str, limit: usize) -> String {
    let n = text.chars().count();
    text.chars().skip(n.saturating_sub(limit)).collect()
}

/// The directory the command runs in: inside the worktree, never above it.
pub fn working_dir(worktree: &Path, cwd: Option<&str>) -> Result<PathBuf, Failure> {
    let rel = cwd.unwrap_or("").trim();
    if rel.starts_with('/') || rel.split('/').any(|seg| seg == "..") {
        return Err(Failure::new(
            "WORKTREE_GONE",
            format!("preview.cwd {rel} is not a directory inside the worktree"),
        ));
    }
    let dir = worktree.join(rel);
    if !dir.is_dir() {
        return Err(Failure::new(
            "WORKTREE_GONE",
            format!("{} is not a directory in the run's worktree", dir.display()),
        ));
    }
    Ok(dir)
}

/// The port the server listens on and the command that makes it: a free loopback port for a
/// command holding `{port}`, else the setting's fixed one, refused when something already holds it.
pub fn plan_port(settings: &Settings) -> Result<(u16, String), Failure> {
    if settings.command.contains(PLACEHOLDER) {
        let port = free_port().map_err(|e| {
            Failure::new(
                "PORT_IN_USE",
                format!("no free loopback port could be taken: {e}"),
            )
        })?;
        return Ok((
            port,
            settings.command.replace(PLACEHOLDER, &port.to_string()),
        ));
    }
    let Some(port) = settings.port else {
        return Err(Failure::new(
            "PORT_UNDECLARED",
            "the setting names neither a port nor a command holding {port}",
        ));
    };
    if std::net::TcpListener::bind(("127.0.0.1", port)).is_err() {
        return Err(Failure::new(
            "PORT_IN_USE",
            format!("port {port} is already held by another process on this box; free it, or set a command holding {{port}}"),
        ));
    }
    Ok((port, settings.command.clone()))
}

/// A connection to `port` on this box's loopback, IPv4 first, then IPv6: a dev server bound to
/// `localhost` listens on whichever the resolver named first. Never any other interface.
pub async fn connect_loopback(port: u16) -> std::io::Result<tokio::net::TcpStream> {
    match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
        Ok(s) => Ok(s),
        Err(v4) => tokio::net::TcpStream::connect(("::1", port))
            .await
            .map_err(|_| v4),
    }
}

fn free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/// The tail of what the server printed, both streams interleaved as they arrived.
#[derive(Clone, Default)]
pub struct Output(Arc<Mutex<VecDeque<char>>>);

impl Output {
    fn push(&self, text: &str) {
        let mut buf = self.0.lock().unwrap_or_else(|p| p.into_inner());
        buf.extend(text.chars());
        while buf.len() > DETAIL_LIMIT {
            buf.pop_front();
        }
    }

    pub fn text(&self) -> String {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .collect()
    }
}

fn collect(stream: Option<impl AsyncRead + Unpin + Send + 'static>, out: Output) {
    let Some(mut stream) = stream else { return };
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        while let Ok(n) = stream.read(&mut buf).await {
            if n == 0 {
                break;
            }
            out.push(&String::from_utf8_lossy(&buf[..n]));
        }
    });
}

/// A running dev server: its process (the leader of its own group on unix) and its output.
pub struct Server {
    pub child: Child,
    pub port: u16,
    pub output: Output,
}

/// Start `command` in `dir` with the environment core sent, bound to loopback.
pub fn spawn(
    dir: &Path,
    command: &str,
    port: u16,
    env: &serde_json::Map<String, serde_json::Value>,
) -> Result<Server, Failure> {
    let mut cmd = shell(command);
    cmd.current_dir(dir)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .env("BROWSER", "none")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in env {
        if let Some(v) = v.as_str() {
            cmd.env(k, v);
        }
    }
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(|e| {
        Failure::new(
            "DEV_SERVER_EXITED",
            format!("`{command}` could not start in {}: {e}", dir.display()),
        )
    })?;
    let output = Output::default();
    collect(child.stdout.take(), output.clone());
    collect(child.stderr.take(), output.clone());
    Ok(Server {
        child,
        port,
        output,
    })
}

fn shell(command: &str) -> Command {
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    }
}

/// Wait until the server answers on its loopback port, exits, or the ready timeout passes.
pub async fn ready(server: &mut Server, timeout: Duration) -> Result<(), Failure> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Ok(Some(status)) = server.child.try_wait() {
            tokio::time::sleep(Duration::from_millis(100)).await;
            return Err(Failure::new(
                "DEV_SERVER_EXITED",
                format!(
                    "the dev server exited ({status}):\n{}",
                    server.output.text()
                ),
            ));
        }
        if connect_loopback(server.port).await.is_ok() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(Failure::new(
                "DEV_SERVER_NOT_LISTENING",
                format!(
                    "the dev server kept running and never answered on 127.0.0.1:{} within {}s:\n{}",
                    server.port,
                    timeout.as_secs(),
                    server.output.text()
                ),
            ));
        }
        tokio::time::sleep(READY_POLL).await;
    }
}

/// Stop the server and everything it started: its group is asked to end, then killed.
pub async fn stop(mut child: Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        use nix::sys::signal::{killpg, Signal};
        use nix::unistd::Pid;
        let group = Pid::from_raw(pid as i32);
        let _ = killpg(group, Signal::SIGTERM);
        if tokio::time::timeout(STOP_GRACE, child.wait()).await.is_ok() {
            let _ = killpg(group, Signal::SIGKILL);
            return;
        }
        let _ = killpg(group, Signal::SIGKILL);
    }
    let _ = child.kill().await;
}

#[cfg(test)]
mod tests;
