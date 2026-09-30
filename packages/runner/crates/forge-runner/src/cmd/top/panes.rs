//! Which tmux sessions the daemon's server holds, asked once per frame.
//!
//! One `list-sessions` on the daemon's own socket (`terminal::socket_path`),
//! never `attach`, `send-keys` or `kill`. A server that is not running holds no
//! session and says so in its own words; any other failure is a question tmux
//! did not answer, which is unreadable and never an empty box.

use std::collections::HashMap;
use std::process::{Command, Stdio};

use super::source::{Read, Unreadable};

/// Session name → when tmux created it, in wall-clock seconds.
pub type Sessions = HashMap<String, i64>;

pub fn list() -> Read<Sessions> {
    let mut cmd = Command::new("tmux");
    let socket = forge_runner_core::daemon::terminal::socket_path();
    if let Some(s) = &socket {
        cmd.arg("-S").arg(s);
    }
    let source = match &socket {
        Some(s) => format!("tmux list-sessions on {}", s.display()),
        None => "tmux list-sessions on the default socket".to_string(),
    };
    let out = cmd
        .args(["list-sessions", "-F", "#{session_name}\t#{session_created}"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Unreadable::new(&source, format!("tmux could not be run ({e})")))?;
    parse(
        &source,
        out.status.success(),
        &String::from_utf8_lossy(&out.stdout),
        &String::from_utf8_lossy(&out.stderr),
    )
}

/// tmux's own wording for a socket no server is listening on: `no server
/// running`, or a connect refused because the socket file is not there.
fn no_server(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("no server running")
        || (lower.contains("error connecting to") && lower.contains("no such file"))
}

pub fn parse(source: &str, ok: bool, stdout: &str, stderr: &str) -> Read<Sessions> {
    if !ok {
        if no_server(stderr) {
            return Ok(Sessions::new());
        }
        return Err(Unreadable::new(source, stderr.trim()));
    }
    let mut out = Sessions::new();
    for line in stdout.lines() {
        let Some((name, created)) = line.split_once('\t') else {
            return Err(Unreadable::new(
                source,
                format!("tmux answered a line this view cannot read: {line:?}"),
            ));
        };
        let created = created
            .trim()
            .parse()
            .map_err(|_| Unreadable::new(source, format!("no creation time in {line:?}")))?;
        out.insert(name.to_string(), created);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_are_read_with_their_creation_times() {
        let got = parse(
            "t",
            true,
            "forge-master-a\t1790000000\nforge-job-j\t1790000100\n",
            "",
        )
        .unwrap();
        assert_eq!(got["forge-master-a"], 1_790_000_000);
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn a_server_that_is_not_running_holds_no_session() {
        let got = parse(
            "t",
            false,
            "",
            "error connecting to /x/tmux.sock (No such file or directory)",
        )
        .unwrap();
        assert!(got.is_empty());
        assert!(parse(
            "t",
            false,
            "",
            "no server running on /tmp/tmux-1000/default"
        )
        .unwrap()
        .is_empty());
    }

    /// Criterion 22.
    #[test]
    fn any_other_failure_is_unreadable_never_an_empty_box() {
        let e = parse(
            "t",
            false,
            "",
            "error connecting to /x/tmux.sock (Permission denied)",
        )
        .unwrap_err();
        assert!(e.reason.contains("Permission denied"), "{e}");
        assert!(parse("t", true, "garbage\n", "").is_err());
    }
}
