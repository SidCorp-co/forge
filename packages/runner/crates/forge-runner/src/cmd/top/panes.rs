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
    asked(cmd, &source)
}

/// `list-sessions` asked of the tmux `cmd` names, its socket already given.
fn asked(mut cmd: Command, source: &str) -> Read<Sessions> {
    let out = cmd
        .args(["list-sessions", "-F", "#{session_created}:#{session_name}"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Unreadable::new(source, format!("tmux could not be run ({e})")))?;
    parse(
        source,
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
    // The creation time first and a colon after it: a tmux client with no
    // UTF-8 locale writes a tab in a format as `_`, and a colon it passes
    // through under any locale, as `daemon::terminal` reads a session too.
    // The time is digits, so the first colon ends it whatever the name holds.
    let mut out = Sessions::new();
    for line in stdout.lines() {
        let Some((created, name)) = line.split_once(':') else {
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
            "1790000000:forge-master-a\n1790000100:forge-job-j\n",
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
    /// Judge iss-1341+1375-cd92ac72, finding 2: a tmux client with no UTF-8
    /// locale writes a control character in a format as `_`, so a tab
    /// between the fields reached this view as `_` and every master pane read
    /// UNREADABLE. Asked of a real server, under no LANG and under LC_ALL=C.
    #[test]
    fn sessions_are_read_under_any_locale() {
        if !cfg!(unix) || Command::new("tmux").arg("-V").output().is_err() {
            assert!(
                !std::env::var_os("FORGE_TEST_REQUIRE_TMUX").is_some_and(|v| !v.is_empty()),
                "tmux is not installed here, and FORGE_TEST_REQUIRE_TMUX promised this run one"
            );
            eprintln!("skipped: tmux is not installed here");
            return;
        }
        let scratch = forge_runner_core::test_scratch::Scratch::short("tp");
        let dir = scratch.path();
        let sock = dir.join("t.sock");
        let tmux = |locale: Option<&str>| {
            let mut c = Command::new("tmux");
            c.env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap_or_default())
                .env("HOME", dir)
                .arg("-S")
                .arg(&sock);
            if let Some(l) = locale {
                c.env("LC_ALL", l);
            }
            c
        };
        let started = tmux(None)
            .args(["new-session", "-d", "-s", "forge-master-locale", "sleep 60"])
            .status()
            .unwrap();
        let read = [None, Some("C")].map(|l| asked(tmux(l), "t"));
        let _ = tmux(None).arg("kill-server").status();
        assert!(started.success(), "a server of the test's own");
        for (locale, got) in ["no LANG", "LC_ALL=C"].iter().zip(read) {
            let got = got.unwrap_or_else(|e| panic!("{locale}: {e}"));
            assert!(
                got.get("forge-master-locale")
                    .is_some_and(|t| *t > 1_600_000_000),
                "{locale}: {got:?}"
            );
        }
    }
}
