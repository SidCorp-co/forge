//! Resident terminal sessions: the tmux server, not this daemon, is the parent.
//!
//! A master used to be a `claude -p` child of the runner — killed on restart,
//! unreachable by a human, and with no reasoning that survived the pass. Here
//! it is a named tmux session instead: an operator types
//! `tmux attach -t forge-master-<slug>` and is looking at the same pane core
//! addresses, the process outlives a `forge-runner` restart, and the pane is
//! piped to an append-only transcript.
//!
//! What this module does NOT do is decide anything about work. It is the
//! transport; `daemon/master.rs` is the policy.

use std::process::Stdio;
use std::sync::OnceLock;

use tokio::process::Command;

use crate::error::{Error, Result};

/// The prefix on every master's session name.
// cm:guard the name is the IDENTITY, both halves. tmux refuses a second session under a name that exists, which is what bounds one master per (box, project) now that the daemon's in-process map cannot see a session it does not parent; and the same string round-trips to core on the `agent_sessions` row so an operator reading the UI knows what to attach to. Two names for one master would leave both checks looking at something the other cannot see.
pub const MASTER_PREFIX: &str = "forge-master";

/// Whether this box can host a resident session at all.
// cm:guard REFUSE by name when tmux is missing rather than falling back to the `claude -p` pass this replaced. A box that quietly reverted would look identical in the log to one that is working, while none of B3's liveness, B5's transcript or B6's inbox exist on it — the silent substitution `CLAUDE.md` forbids, on the exact machinery that is supposed to detect silence. `forge-runner doctor` names the same missing binary before an operator finds it this way.
pub fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| which::which("tmux").is_ok())
}

/// A tmux session name derived from `raw`, safe as an argument and a target.
// cm:guard `.` and `:` are the two characters that must not survive. tmux reads `:` as a window separator inside a target and rewrites `.` in session names, so a project slug carrying either produces a session whose real name differs from the one this module later looks up — `has-session` then answers "no" forever and every sweep starts another master.
pub fn session_name(prefix: &str, raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    let body = if trimmed.is_empty() {
        "unnamed"
    } else {
        trimmed
    };
    let mut name = format!("{prefix}-{body}");
    name.truncate(96);
    name
}

async fn tmux(args: &[&str]) -> Result<std::process::Output> {
    Command::new("tmux")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| Error::Other(format!("tmux {}: {e}", args.first().copied().unwrap_or(""))))
}

/// A session target: exact name, no window or pane part.
// cm:guard the `=` prefix forces an EXACT match. Without it tmux resolves a target by prefix, so `forge-master-forge` would answer alive for `forge-master-forge-dev` — one project reporting another project's master as its own, and neither ever restarted.
fn session_target(name: &str) -> String {
    format!("={name}")
}

/// A PANE target for the same session — the trailing `:` is not optional.
// cm:guard `send-keys`, `paste-buffer` and `pipe-pane` take a target-PANE, and a bare `=name` is not one: tmux answers `can't find pane: =name` and the write is lost. The trailing colon names the session's current window, which resolves to its active pane — and it is used rather than `:0.0` because `base-index` is operator-settable and a hardcoded 0 misses the pane on any box whose tmux.conf sets it to 1.
fn pane_target(name: &str) -> String {
    format!("={name}:")
}

/// Whether a session by this exact name exists right now.
pub async fn alive(name: &str) -> bool {
    let target = session_target(name);
    matches!(tmux(&["has-session", "-t", &target]).await, Ok(o) if o.status.success())
}

/// Start a session under `name` if there is not one already.
///
/// Returns whether this call created it. Idempotent by construction: the
/// liveness check and tmux's own refusal to duplicate a name are both in play,
/// so a race between two sweeps costs a log line and not a second master.
// cm:guard `-x`/`-y` are not cosmetic. A detached tmux session defaults to 80x24, and Claude Code's TUI reflows its input box to the pane width — at 80 columns a pasted pass prompt wraps into the composer and a human attaching later reads a mangled transcript. The numbers only need to be generous; they are not a layout.
pub async fn ensure(
    name: &str,
    cwd: &std::path::Path,
    argv: &[String],
    env: &[(String, String)],
    transcript: Option<&std::path::Path>,
) -> Result<bool> {
    if !available() {
        return Err(Error::Other(
            "tmux is not installed on this box, and a resident session needs it".into(),
        ));
    }
    if alive(name).await {
        return Ok(false);
    }
    let cwd = cwd.to_string_lossy().to_string();
    let mut args: Vec<String> = vec![
        "new-session".into(),
        "-d".into(),
        "-s".into(),
        name.into(),
        "-c".into(),
        cwd,
        "-x".into(),
        "220".into(),
        "-y".into(),
        "60".into(),
    ];
    for (k, v) in env {
        args.push("-e".into());
        args.push(format!("{k}={v}"));
    }
    args.push("--".into());
    args.extend(argv.iter().cloned());

    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = tmux(&borrowed).await?;
    if !out.status.success() {
        return Err(Error::Other(format!(
            "tmux new-session {name}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    // cm:guard `pipe-pane` can only attach to a pane that already exists, so anything the process prints in the milliseconds before this line is NOT in the transcript. That is the startup banner and nothing a master decides, and it is stated here rather than left for a reader to discover from a transcript that begins mid-sentence.
    if let Some(path) = transcript {
        pipe_pane(name, path).await;
    }
    Ok(true)
}

/// Append everything the pane prints to `path`, for as long as it lives.
// cm:guard `>>` and never `>`. The transcript is the master's only account of what it decided, and B5 exists because the file this replaces was truncated once per pass — measured 2026-09-05, the master's reasoning about ISS-917 was gone three minutes later, overwritten by the next pass. Appending is the whole fix; a redirect that clobbers is the bug wearing a new path.
// cm:guard best-effort, and deliberately not fatal. A session that runs with no transcript is worse than one with a transcript, but a session that never starts because the log directory is unwritable is worse than both — the work stops, and B5 is a record, not a precondition.
async fn pipe_pane(name: &str, path: &std::path::Path) {
    let target = pane_target(name);
    let shell = format!("cat >> {}", shell_quote(&path.to_string_lossy()));
    match tmux(&["pipe-pane", "-o", "-t", &target, &shell]).await {
        Ok(o) if o.status.success() => {}
        Ok(o) => tracing::warn!(
            "[terminal] {name}: no transcript ({})",
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Err(e) => tracing::warn!("[terminal] {name}: no transcript ({e})"),
    }
}

/// Single-quote a string for a `sh -c` line.
// cm:guard tmux hands this string to a shell, so a path with a space or a quote in it is a command injection and not merely a broken log. `$XDG_CONFIG_HOME` is operator-set and dev1 runs several runners that differ only by it.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Type `text` into the session and submit it.
///
/// Multi-line text goes through a tmux buffer with bracketed paste rather than
/// `send-keys`, so the TUI receives one paste and one Enter.
// cm:guard bracketed paste (`paste-buffer -p`) is mandatory for anything with a newline in it. `send-keys -l` types the text a character at a time, and every embedded newline is an Enter — a five-line pass prompt submitted as five turns, the first four of them fragments. Measured against Claude Code's composer, which is what a master is looking at.
pub async fn send_line(name: &str, text: &str) -> Result<()> {
    if !alive(name).await {
        return Err(Error::Other(format!("no session named {name}")));
    }
    let target = pane_target(name);
    let buffer = format!("forge-{}", std::process::id());

    let mut child = Command::new("tmux")
        .args(["load-buffer", "-b", &buffer, "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| Error::Other(format!("tmux load-buffer: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|e| Error::Other(format!("tmux load-buffer write: {e}")))?;
        let _ = stdin.shutdown().await;
    }
    let status = child
        .wait()
        .await
        .map_err(|e| Error::Other(format!("tmux load-buffer: {e}")))?;
    if !status.success() {
        return Err(Error::Other(format!("tmux load-buffer {name}: {status}")));
    }

    let out = tmux(&["paste-buffer", "-p", "-d", "-b", &buffer, "-t", &target]).await?;
    if !out.status.success() {
        return Err(Error::Other(format!(
            "tmux paste-buffer {name}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    // cm:guard the Enter is a SEPARATE call after the paste, never a newline inside the buffer. A trailing newline inside a bracketed paste is pasted as text by the composer and submits nothing, so the master would sit holding a prompt it was never asked to answer — alive, silent, and indistinguishable from hung.
    let out = tmux(&["send-keys", "-t", &target, "Enter"]).await?;
    if !out.status.success() {
        return Err(Error::Other(format!(
            "tmux send-keys {name}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// End a session by name. Absent is success — the caller wanted it gone.
pub async fn kill(name: &str) -> Result<()> {
    let target = session_target(name);
    let _ = tmux(&["kill-session", "-t", &target]).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // cm:guard a bare `=name` is a SESSION target and not a pane target, and the two are not interchangeable: tmux answers `can't find pane: =name` and every write is silently lost. Measured against tmux 3.4 while building this.
    #[test]
    fn a_pane_target_is_not_a_session_target() {
        assert_eq!(session_target("m"), "=m");
        assert_eq!(pane_target("m"), "=m:");
        assert!(
            pane_target("m").starts_with('='),
            "exact match must survive"
        );
    }

    // cm:guard `.` and `:` must both go. tmux rewrites `.` in a session name and reads `:` as a window separator in a target, so either one produces a session whose real name is not the one `alive` later asks about — and a master that can never be found is a master started again every sweep.
    #[test]
    fn a_name_that_tmux_would_rewrite_is_cleaned_first() {
        assert_eq!(
            session_name(MASTER_PREFIX, "forge-dev"),
            "forge-master-forge-dev"
        );
        assert_eq!(
            session_name(MASTER_PREFIX, "epod.system"),
            "forge-master-epod-system"
        );
        assert_eq!(session_name(MASTER_PREFIX, "a:b"), "forge-master-a-b");
        assert_eq!(session_name(MASTER_PREFIX, "  "), "forge-master-unnamed");
        assert!(session_name(MASTER_PREFIX, &"x".repeat(300)).len() <= 96);
    }

    // cm:guard a trailing dash would make the name end in the separator and read as a truncated slug in every log line and every `tmux ls`; a leading one is worse, because tmux takes a leading dash as a flag.
    #[test]
    fn the_derived_name_never_starts_or_ends_with_the_separator() {
        for raw in ["-lead", "trail-", "--both--", "///"] {
            let n = session_name(MASTER_PREFIX, raw);
            assert!(n.starts_with("forge-master-"), "{n}");
            assert!(!n.ends_with('-'), "{n}");
        }
    }

    /// The whole transport, against a real tmux server.
    ///
    /// Everything above it is string handling; this is the only assertion that
    /// the pane actually receives what a master is typed.
    // cm:guard the body is MULTI-LINE on purpose, because that is the case `send-keys -l` gets wrong and bracketed paste gets right: every embedded newline would otherwise be an Enter, and a five-line pass prompt would arrive as five turns, the first four of them fragments. A single-line body here would pass against the bug.
    // cm:guard skipped rather than failed when tmux is absent, and the daemon refuses to start a master on such a box — so the skip cannot hide a broken transport in production, only on a developer machine that could never have run one.
    #[tokio::test]
    async fn a_pane_receives_what_is_typed_at_it_and_the_transcript_keeps_it() {
        if !available() {
            eprintln!("tmux is not installed here — the transport test cannot run");
            return;
        }
        let dir = std::env::temp_dir().join(format!("forge-terminal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let log = dir.join("transcript.log");
        let name = session_name("forge-test", &format!("t{}", std::process::id()));
        // cm:guard kill FIRST as well as last. A panic anywhere below leaves a live tmux session behind on a shared box — measured while building this, three of them survived failing runs — and tmux refuses to create a name that already exists, so the leak turns the next run red for a reason that has nothing to do with the code.
        let _ = kill(&name).await;

        let created = ensure(
            &name,
            &dir,
            &[
                "sh".to_string(),
                "-c".to_string(),
                // Echo each line back WITH the env value, rather than printing it
                // at startup: `pipe-pane` attaches after the process is running.
                "while IFS= read -r l; do printf '%s env=%s\\n' \"$l\" \"$FORGE_TERMINAL_TEST\"; done"
                    .to_string(),
            ],
            &[("FORGE_TERMINAL_TEST".into(), "carried".into())],
            Some(&log),
        )
        .await
        .expect("the session must start");
        assert!(created, "a fresh name must create a session");
        assert!(alive(&name).await, "it must be findable by its exact name");
        assert!(
            !ensure(&name, &dir, &["true".to_string()], &[], Some(&log))
                .await
                .expect("a second ensure must succeed"),
            "ensure is idempotent: the second call creates nothing"
        );

        send_line(&name, "first line\nsecond line")
            .await
            .expect("the paste must land");

        let mut seen = String::new();
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            seen = std::fs::read_to_string(&log).unwrap_or_default();
            if seen.contains("second line") {
                break;
            }
        }
        // cm:guard the env assertion is not incidental: a tmux session inherits the CLIENT environment and `-e` is the only way to set one on it, so a dropped `-e` would leave the master running with the daemon's `CLAUDECODE` and without `MCP_TOOL_TIMEOUT` — both silent, both changing how it behaves.
        assert!(
            seen.contains("env=carried"),
            "the -e value must reach the pane: {seen:?}"
        );
        assert!(seen.contains("first line"), "transcript was: {seen:?}");
        assert!(
            seen.contains("second line"),
            "a newline inside the body must not submit early; transcript was: {seen:?}"
        );

        kill(&name).await.expect("kill is infallible");
        assert!(!alive(&name).await, "a killed session must stop answering");
        assert!(
            kill(&name).await.is_ok(),
            "killing what is already gone is what the caller asked for"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // cm:guard tmux runs the `pipe-pane` string through a shell, so this is an injection boundary and not a formatting nicety. The assertion runs the quoted form through a REAL shell rather than pattern-matching the escape, because the escape `'\''` legitimately contains every character a pattern would look for — a string test here passes on correct output and on a hole alike.
    #[test]
    fn a_transcript_path_survives_the_shell_tmux_runs_it_through() {
        for hostile in [
            "/tmp/a b/log",
            "/tmp/it's",
            "/tmp/x'; rm -rf /; echo '",
            "/tmp/$(touch pwned)",
            "/tmp/`id`",
        ] {
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!("printf %s {}", shell_quote(hostile)))
                .output()
                .expect("sh must run");
            assert_eq!(
                String::from_utf8_lossy(&out.stdout),
                hostile,
                "the shell must see exactly the path, and nothing else"
            );
        }
    }
}
