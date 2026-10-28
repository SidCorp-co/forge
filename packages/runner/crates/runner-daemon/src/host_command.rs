//! `host.command`: core asks this box to run one command on a host a support room's grant names
//! (REQ-75 r5 BC-27), over this box's own SSH and outside any session's sandbox.
//!
//! Core decided the room may: the host is in its grant, and a command that changes the host was
//! confirmed by a confirmer the grant names. The box runs it as the daemon's own user with SSH in
//! batch mode, so a host it holds no key for fails rather than prompting, and answers with what
//! came back, cut to a size core can scrub and hand on. The command is one argument to `ssh`:
//! nothing on this box reads it as shell; the remote host's shell does, which is the point.

use std::ffi::OsStr;
use std::process::Stdio;
use std::time::{Duration, Instant};

use runner_platform::config::Config;
use runner_transport::CoreClient;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::checkout_frame::{serve, Channel, Frame};

/// The most of each stream handed back; the rest is read and dropped.
const STREAM_CAP: usize = 32 * 1024;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// The longest command this box passes on.
const MAX_COMMAND_CHARS: usize = 4_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostCommandFrame {
    request_id: String,
    project_id: String,
    host: String,
    command: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    runner_id: Option<String>,
}

impl Frame for HostCommandFrame {
    fn request_id(&self) -> &str {
        &self.request_id
    }
    fn project_id(&self) -> &str {
        &self.project_id
    }
    fn runner_id(&self) -> Option<&str> {
        self.runner_id.as_deref()
    }
}

pub(crate) async fn handle(client: &CoreClient, data: Value) {
    serve(
        client,
        Channel::HostCommand,
        data,
        async |frame: &HostCommandFrame| {
            project_bound_here(&frame.project_id)?;
            let timeout = Duration::from_millis(
                frame
                    .timeout_ms
                    .unwrap_or(DEFAULT_TIMEOUT_MS)
                    .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
            );
            let ran = run(
                OsStr::new("ssh"),
                &ssh_args(&frame.host, &frame.command)?,
                timeout,
            )
            .await?;
            Ok(ran.body(&frame.project_id, &frame.host))
        },
    )
    .await;
}

/// Whether this box binds `project_id` at all: a box runs commands only for a project it serves.
fn project_bound_here(project_id: &str) -> Result<(), String> {
    let cfg = Config::load().map_err(|e| format!("this box's config could not be read: {e}"))?;
    if cfg
        .bindings
        .values()
        .any(|b| b.project_id.as_deref() == Some(project_id))
    {
        return Ok(());
    }
    Err(format!(
        "this box binds no checkout to project {project_id}, so it runs no command for it"
    ))
}

/// Whether `host` is a name this box passes to SSH: never an option, never a user@ or a path.
pub(crate) fn host_ok(host: &str) -> bool {
    let mut chars = host.chars();
    (1..=253).contains(&host.len())
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// SSH's arguments: batch mode, a bounded connect, no terminal, then `--`, the host and the
/// command as one argument.
pub(crate) fn ssh_args(host: &str, command: &str) -> Result<Vec<String>, String> {
    if !host_ok(host) {
        return Err(format!(
            "{host:?} is not a host name this box passes to ssh: letters, digits, . _ -, starting with a letter or digit"
        ));
    }
    let command = command.trim();
    if command.is_empty() || command.chars().count() > MAX_COMMAND_CHARS {
        return Err(format!(
            "a command is 1 to {MAX_COMMAND_CHARS} characters; this one is {}",
            command.chars().count()
        ));
    }
    Ok([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-T",
        "--",
        host,
        command,
    ]
    .into_iter()
    .map(str::to_string)
    .collect())
}

/// What one command left behind.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Ran {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub timed_out: bool,
    pub duration_ms: u64,
}

impl Ran {
    fn body(&self, project_id: &str, host: &str) -> Value {
        json!({
            "projectId": project_id,
            "host": host,
            "exitCode": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "truncated": self.truncated,
            "timedOut": self.timed_out,
            "durationMs": self.duration_ms,
        })
    }
}

/// Run `program args`, each stream kept to [`STREAM_CAP`], killed at `timeout`.
pub(crate) async fn run(
    program: &OsStr,
    args: &[String],
    timeout: Duration,
) -> Result<Ran, String> {
    let started = Instant::now();
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            format!(
                "{} could not run on this box: {e}",
                program.to_string_lossy()
            )
        })?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let out = tokio::spawn(capped(stdout));
    let err = tokio::spawn(capped(stderr));
    let (exit_code, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(e)) => return Err(format!("waiting on the command failed: {e}")),
        Err(_) => {
            let _ = child.kill().await;
            (None, true)
        }
    };
    let (stdout, cut_out) = out.await.unwrap_or_default();
    let (stderr, cut_err) = err.await.unwrap_or_default();
    Ok(Ran {
        exit_code,
        stdout,
        stderr,
        truncated: cut_out || cut_err,
        timed_out,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

/// A stream read to its end, its first [`STREAM_CAP`] bytes kept as text, and whether any was cut.
async fn capped(mut stream: impl AsyncRead + Unpin) -> (String, bool) {
    let mut kept: Vec<u8> = Vec::new();
    let mut cut = false;
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = STREAM_CAP.saturating_sub(kept.len());
                kept.extend_from_slice(&buf[..n.min(room)]);
                cut |= n > room;
            }
        }
    }
    (String::from_utf8_lossy(&kept).into_owned(), cut)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_is_a_name_never_an_option_a_user_or_a_path() {
        for ok in ["mail-01", "mta1", "67.220.215.42", "a.b_c"] {
            assert!(host_ok(ok), "{ok}");
        }
        for bad in [
            "",
            "-oProxyCommand=x",
            "root@mta1",
            "mta1;id",
            "../x",
            "mta1 x",
            ".mta",
        ] {
            assert!(!host_ok(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_command_is_one_argument_after_the_host_and_never_read_as_shell_here() {
        let args = ssh_args("mta1", "systemctl status stalwart; echo $HOME").unwrap();
        assert_eq!(
            args,
            vec![
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-T",
                "--",
                "mta1",
                "systemctl status stalwart; echo $HOME"
            ]
        );
        assert!(ssh_args("-oProxyCommand=sh", "id").is_err());
        assert!(ssh_args("mta1", "   ").is_err());
        assert!(ssh_args("mta1", &"x".repeat(MAX_COMMAND_CHARS + 1)).is_err());
    }

    /// `/bin/sh -c` stands in for ssh: the remote end is the one that reads the command as shell.
    fn sh(script: &str) -> Vec<String> {
        vec!["-c".into(), script.into()]
    }

    #[tokio::test]
    async fn what_a_command_printed_and_how_it_ended_come_back() {
        let ran = run(
            OsStr::new("/bin/sh"),
            &sh("echo out; echo err >&2; exit 3"),
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert_eq!(ran.exit_code, Some(3));
        assert_eq!(ran.stdout, "out\n");
        assert_eq!(ran.stderr, "err\n");
        assert!(!ran.truncated && !ran.timed_out);
    }

    #[tokio::test]
    async fn a_flood_of_output_is_cut_to_the_cap_and_says_so() {
        let ran = run(
            OsStr::new("/bin/sh"),
            &sh("head -c 200000 /dev/zero | tr '\\0' a"),
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert_eq!(ran.stdout.len(), STREAM_CAP);
        assert!(ran.truncated);
        assert_eq!(ran.exit_code, Some(0));
    }

    #[tokio::test]
    async fn a_command_past_its_time_is_killed_and_said_timed_out() {
        let started = Instant::now();
        let ran = run(
            OsStr::new("/bin/sh"),
            &sh("echo started; exec sleep 30"),
            Duration::from_millis(500),
        )
        .await
        .unwrap();
        assert!(ran.timed_out);
        assert_eq!(ran.exit_code, None);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "it was not killed"
        );
    }

    #[tokio::test]
    async fn a_program_this_box_lacks_is_an_error_not_an_answer() {
        let err = run(OsStr::new("/nonexistent/ssh"), &[], Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(err.contains("could not run on this box"), "{err}");
    }
}
