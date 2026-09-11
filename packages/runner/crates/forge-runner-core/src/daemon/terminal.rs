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
use std::time::Duration;

use tokio::process::Command;

use crate::error::{Error, Result};

/// The prefix on every master's session name.
// cm:guard the name is the IDENTITY, both halves. tmux refuses a second session under a name that exists, which is what bounds one master per (box, project) now that the daemon's in-process map cannot see a session it does not parent; and the same string round-trips to core on the `agent_sessions` row so an operator reading the UI knows what to attach to. Two names for one master would leave both checks looking at something the other cannot see.
pub const MASTER_PREFIX: &str = "forge-master";

/// A run session's pane, distinct from its master's so `alive`/`kill` cannot cross them.
// cm:guard a run pane and a master pane differ ONLY by this string and share every primitive below — `ensure`, `alive`, `kill` and `send_line` all take the name a caller built from a prefix. A second copy of those primitives for runs is what this constant exists to prevent: two spawn paths drift, and the one that runs less often is the one that rots (ISS-933 criterion 1).
pub const RUN_PREFIX: &str = "forge-run";

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

/// The socket this box's agent sessions live on.
///
/// Derived from `Config::path()` and nothing else, exactly as the control
/// socket is: dev1 runs several runner services that differ ONLY by
/// `XDG_CONFIG_HOME`, and a shared session server would let one of them address
/// another's panes.
// cm:guard a socket of OUR OWN is not tidiness, it is the survival property: on the default socket the runner shares a server with whatever tmux the operator is running, so one `tmux kill-server`, or their last personal session ending, takes every agent on the box with it. Measured forge-vm 2026-09-11: `-L`/`-S` appeared zero times in this crate and 47 agent panes were sitting on the operator's own server.
pub fn socket_path() -> Option<std::path::PathBuf> {
    crate::config::Config::path()
        .ok()
        .map(|p| p.with_file_name("tmux.sock"))
        .filter(|p| fits_a_unix_socket(&p.to_string_lossy()))
}

/// Whether a path can be a unix socket at all on this platform.
// cm:guard `sockaddr_un.sun_path` is 108 bytes INCLUDING the terminator, and a path over it fails with `File name too long` — measured while writing this, on a 122-character scratch path. Without this filter every tmux call on such a box fails, which is not a degraded runner but a dead one: `XDG_CONFIG_HOME` is operator-set and dev1 already runs several runners that differ only by it.
fn fits_a_unix_socket(path: &str) -> bool {
    path.len() <= 100
}

/// `-S <socket>`, or nothing when this box cannot name its config dir.
// cm:guard falling back to the DEFAULT socket is deliberate and is the safe direction: a box that cannot resolve its config dir still runs work, it simply runs it where the old builds ran it. Refusing instead would take the whole box out over a path lookup.
fn socket_args() -> Vec<String> {
    match socket_path() {
        Some(p) => vec!["-S".into(), p.to_string_lossy().into_owned()],
        None => Vec::new(),
    }
}

async fn tmux(args: &[&str]) -> Result<std::process::Output> {
    let mut all = socket_args();
    all.extend(args.iter().map(|a| (*a).to_string()));
    Command::new("tmux")
        .args(&all)
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
/// The pid of the process a pane is running, once it exists.
// cm:guard read from tmux rather than remembered from the spawn: `ensure` adopts a session that already exists as readily as it creates one, so a pid captured only on creation is absent for every adoption — which is the daemon restart the residency design exists to survive.
pub async fn pane_pid(name: &str) -> Option<u32> {
    let target = session_target(name);
    let out = tmux(&["list-panes", "-t", &target, "-F", "#{pane_pid}"])
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .trim()
        .parse()
        .ok()
}

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
/// The unit the session server runs as, when this box can give it one.
// cm:edge naming -> packages/runner/crates/forge-runner/src/cmd/service.rs — the runner's own unit is `forge-runner*`; this one must NOT share that prefix, or an operator's `systemctl --user stop forge-runner*` takes the sessions this exists to spare.
const SESSION_UNIT: &str = "forge-sessions";

/// The session the server is started with, so it has one and does not exit.
// cm:guard named OUTSIDE both `MASTER_PREFIX` and `RUN_PREFIX`, because every reader on this box classifies a session by that prefix and would otherwise adopt the keep-alive as a master with no project.
const KEEPALIVE: &str = "forge-session-host";

/// Start the session server under a unit of its OWN, if it is not already up.
///
/// This is the survival property, and it is about the SERVER, not the panes.
/// tmux already gives each pane a scope of its own, but a server that dies
/// takes its panes with it — so a server forked into this service's cgroup
/// means `systemctl restart forge-runner` kills every agent on the box. That is
/// what makes an ordinary update destructive.
// cm:guard a transient SERVICE with `--service-type=forking`, never `--scope`: measured 2026-09-11, `tmux start-server` daemonizes, so the process a scope tracks exits immediately, the scope is collected, and the server it was supposed to hold ends up in the caller's cgroup after all. The scope form looks right and places nothing.
// cm:guard the server is started WITH a session (`new-session`), never bare (`start-server`): a tmux server with no sessions exits on the spot — `exit-empty` is on by default — so the bare form leaves the unit inactive and no server at all. Measured the same day, twice.
// cm:guard a box with no `systemd-run` (macOS, a container) is NOT refused. It runs exactly as every build before this one did, and says so by name once — the property is unavailable there, the work is not.
// cm:guard idempotent under CONCURRENCY, not just repetition: a master sweep starts several panes at once, so the attempt is serialized in-process and a caller that loses the race waits for the winner's socket instead of reporting a failure. Across processes systemd itself is the lock, and `already exists` is the same loss.
// cm:guard the caller is never refused. `ensure` proceeds either way — a box with no `systemd-run` runs exactly as every build before this one did, and says so by name once.
async fn ensure_server() -> bool {
    static PLACING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one_attempt = PLACING.lock().await;
    if server_answers().await {
        return true;
    }
    let Some(sock) = socket_path() else {
        tracing::warn!(
            "[terminal] no usable session socket path — agent panes will run on the default tmux server and die with this service, as they did before"
        );
        return false;
    };
    match ask_systemd_for_the_server(&sock.to_string_lossy()).await {
        Placement::Accepted if server_answers_within(SERVER_READY_WITHIN).await => {
            tracing::info!(
                "[terminal] session server running as {SESSION_UNIT}.service — agent panes now outlive a restart of this one"
            );
            true
        }
        // cm:guard name the CONSEQUENCE, never just the failed command: the operator reading this line is being told that the next update kills every agent on the box, which is the only part of it they can act on.
        Placement::Accepted => {
            tracing::warn!(
                "[terminal] systemd took the session server but its socket never answered within {SERVER_READY_WITHIN:?} — panes will be killed with this service, as they were before"
            );
            false
        }
        Placement::Unavailable(detail) => {
            tracing::warn!(
                "[terminal] the session server could not be given its own unit ({detail}) — panes will be killed with this service, as they were before"
            );
            false
        }
    }
}

/// What systemd did with the request, which is NOT the same as whether our own call won.
// cm:guard the two outcomes carry different WAITS, and conflating them is what CI caught on 2026-09-11: a cold machine took longer than the bound to fork tmux, three callers in a row declared the placement impossible, and each one would have gone on to start an implicit server inside this service's cgroup — the destructive shape, back silently, on exactly the slow box that can least afford it. A box that HAS no systemd must not pay that wait either, so `Unavailable` returns at once.
enum Placement {
    Accepted,
    Unavailable(String),
}

async fn ask_systemd_for_the_server(sock: &str) -> Placement {
    let out = Command::new("systemd-run")
        .args([
            "--user",
            "--unit",
            SESSION_UNIT,
            "--service-type=forking",
            "--collect",
            "--quiet",
            "tmux",
            "-S",
            sock,
            "new-session",
            "-d",
            "-s",
            KEEPALIVE,
            "sleep",
            "infinity",
        ])
        .stdin(Stdio::null())
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => Placement::Accepted,
        other => {
            if unit_is_running().await {
                return Placement::Accepted;
            }
            Placement::Unavailable(match &other {
                Ok(o) => String::from_utf8_lossy(&o.stderr).trim().to_string(),
                Err(e) => e.to_string(),
            })
        }
    }
}

/// Whether systemd already holds the unit, asked structurally rather than by reading a message.
// cm:guard `is-active`, never a substring of `systemd-run`'s stderr: losing the race prints `Unit forge-sessions.service already exists`, which is a translated, version-specific sentence — and the thing the caller actually needs to know is whether the unit is coming up, which systemd will answer directly.
async fn unit_is_running() -> bool {
    Command::new("systemctl")
        .args(["--user", "is-active", &format!("{SESSION_UNIT}.service")])
        .stdin(Stdio::null())
        .output()
        .await
        .is_ok_and(|o| {
            matches!(
                String::from_utf8_lossy(&o.stdout).trim(),
                "active" | "activating" | "reloading"
            )
        })
}

/// Whether a server is listening on our socket right now.
// cm:guard a tmux server with no sessions cannot exist (`exit-empty` is on by default), so an exit-0 listing is the whole liveness probe — there is no "up but empty" state to distinguish.
async fn server_answers() -> bool {
    tmux(&["list-sessions"])
        .await
        .is_ok_and(|o| o.status.success())
}

/// How long a caller waits for a socket systemd has ALREADY agreed to bring up.
// cm:guard generous on purpose, and it costs nothing in steady state: a running server short-circuits every call before this, so the wait is paid once per box and only while the server is genuinely starting. Five seconds was not enough on a cold CI machine (measured 2026-09-11, three callers timed out in a row), and the price of being too short is silent — a false "could not place it" followed by an implicit server in this service's cgroup.
const SERVER_READY_WITHIN: Duration = Duration::from_secs(30);

/// Poll the socket until it answers, or `within` elapses.
async fn server_answers_within(within: Duration) -> bool {
    let deadline = std::time::Instant::now() + within;
    loop {
        if server_answers().await {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

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
    // cm:guard BEFORE `new-session`, always: the implicit server `new-session` would start is forked by this process into this service's cgroup, and once it is there nothing can move it — cgroup membership is inherited at fork and the pane is already inside it.
    ensure_server().await;
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

/// How long a freshly spawned pane needs before a paste reaches its composer.
// cm:guard a paste that lands before Claude Code has drawn its composer is dropped on the floor with NO error anywhere — the text goes to the terminal as raw output and the Enter submits nothing, so the pane sits alive, briefed on screen, and having run no turn at all. Measured on forge-vm 2026-09-09: 4 of 4 sidpeak runs and 6 of 16 overall spent $0.00 for six hours, while the beat kept them out of core's reaper forever.
pub const PANE_BRIEF_DELAY: Duration = Duration::from_secs(5);

/// Brief a pane that has just been spawned, after giving its TUI time to draw.
// cm:guard EVERY freshly spawned pane is briefed through here, master and run alike — the run path pasted immediately and lost the race under load while the master path slept, which is exactly the drift `SESSION_PREFIXES` exists to prevent. A caller that reaches for `send_line` on a pane it just created has reintroduced the bug.
// cm:guard the liveness check comes BEFORE the wait, not after: it makes an absent session fail at once instead of costing five seconds, which is what keeps this callable from a test that has no tmux.
pub async fn brief_new_pane(name: &str, text: &str) -> Result<()> {
    if !alive(name).await {
        return Err(Error::Other(format!("no session named {name}")));
    }
    tokio::time::sleep(PANE_BRIEF_DELAY).await;
    send_line(name, text).await
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

    // cm:guard the SECOND spawn site, and it needs the socket as much as the wrapper does: a buffer loaded on the default server is invisible to a `paste-buffer` on ours, so the paste finds no buffer and the pane is briefed with nothing while every call reports success.
    let mut load = socket_args();
    load.extend(
        ["load-buffer", "-b", &buffer, "-"]
            .iter()
            .map(|a| (*a).to_string()),
    );
    let mut child = Command::new("tmux")
        .args(&load)
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

/// The argv every pane this daemon opens runs — a master's and a run's alike.
// cm:guard ONE argv for both, because a run pane and a master pane differ only by their session prefix (ISS-933 criterion 1). A second list here is how the two drift into different permission modes with nothing comparing them.
// cm:guard `unset CLAUDECODE` through a shell rather than tmux's `-e`. A tmux session inherits the client environment and `-e` can only SET a variable, so the daemon's own `CLAUDECODE` would reach the pane and the master would believe it is nested inside another Claude session. `build_command` removes it for every other spawn on this box; this is the same removal on the one path that does not go through it.
// cm:guard no `-p`. The whole change is that this process reads from a terminal instead of taking one prompt and exiting, so `-p` here would restore the per-pass process with a tmux session wrapped uselessly around it.
pub fn pane_argv() -> Vec<String> {
    let bin = shell_quote(crate::runner::process::resolve_claude_bin());
    vec![
        "sh".into(),
        "-c".into(),
        format!("unset CLAUDECODE; exec {bin} --permission-mode bypassPermissions"),
    ]
}

/// The environment a master's pane needs that a tmux session does not inherit.
// cm:guard `MCP_TOOL_TIMEOUT` must be carried here explicitly. Every other spawn on this box gets it from `build_command`, which a tmux session does not go through — and Claude Code's own default is ~28h, so one hung MCP call would wedge a master's turn for the rest of the day with the silence ceiling reading it as a healthy pause it cannot distinguish. The operator's own value wins, exactly as it does on the other path.
pub fn pane_env() -> Vec<(String, String)> {
    match crate::runner::process::mcp_tool_timeout_default(
        std::env::var_os("MCP_TOOL_TIMEOUT").as_deref(),
    ) {
        Some(v) => vec![("MCP_TOOL_TIMEOUT".into(), v.into())],
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every test below drives ONE server on one socket, so they run one at a time.
    // cm:guard serialised because a cold-start test has to kill that shared server, and `cargo test` runs this module's tests concurrently by default — without the lock it takes the panes the other two tests are mid-assertion on.
    static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Whether this box can place a unit at all; where it cannot, the property does not exist.
    async fn can_place_a_unit() -> bool {
        which::which("systemd-run").is_ok()
            && Command::new("systemctl")
                .args(["--user", "is-system-running"])
                .stdin(Stdio::null())
                .output()
                .await
                .is_ok_and(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
    }

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
        let _serialised = ONE_AT_A_TIME.lock().await;
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

    /// The residency claim itself: the pane's parent is the tmux server, so a
    /// daemon restart re-enters the session it left rather than replacing it.
    // cm:guard the PID comparison is the assertion, not `created == false`. A second `ensure` that killed the pane and started a fresh one would also report "created nothing" while the master lost every word of the pass it was in the middle of — the two are indistinguishable from the return value alone.
    // cm:guard the second `ensure` passes a DIFFERENT argv on purpose, because that is what a restarted daemon carrying a new build sends. A reuse path that read the argv would relaunch here and the test would catch it; one that matched on the name alone is what the design needs.
    #[tokio::test]
    async fn a_restart_re_enters_the_pane_it_left_rather_than_starting_a_second_one() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        if !available() {
            eprintln!("tmux is not installed here — the residency test cannot run");
            return;
        }
        let dir = std::env::temp_dir().join(format!("forge-resident-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let name = session_name("forge-test", &format!("r{}", std::process::id()));
        let _ = kill(&name).await;

        let pane_pid = || async {
            let out = tmux(&[
                "display-message",
                "-p",
                "-t",
                &pane_target(&name),
                "#{pane_pid}",
            ])
            .await
            .expect("tmux must answer");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };

        assert!(
            ensure(
                &name,
                &dir,
                &["sleep".to_string(), "300".to_string()],
                &[],
                None
            )
            .await
            .expect("the session must start"),
            "a fresh name creates the session"
        );
        let before = pane_pid().await;
        assert!(!before.is_empty(), "the pane must report a pid");

        assert!(
            !ensure(
                &name,
                &dir,
                &["sleep".to_string(), "600".to_string()],
                &[],
                None
            )
            .await
            .expect("the restart must find it"),
            "a live name starts no second process"
        );
        assert_eq!(
            before,
            pane_pid().await,
            "the process a master is running must survive the daemon that started it"
        );

        kill(&name).await.expect("kill is infallible");
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

    // cm:guard `-p` must never come back, and neither may `CLAUDECODE`. The first would restore the per-pass process ISS-919 removed, with a tmux session wrapped uselessly around it; the second makes the master believe it is nested inside another Claude session, which changes its behaviour with nothing in any log naming why.
    #[test]
    fn a_pane_runs_interactively_with_no_inherited_claudecode() {
        let argv = pane_argv();
        assert_eq!(argv[0], "sh");
        let line = &argv[2];
        assert!(line.contains("unset CLAUDECODE"), "{line}");
        assert!(
            line.contains("--permission-mode bypassPermissions"),
            "{line}"
        );
        assert!(
            !line.contains(" -p "),
            "a resident pane takes no -p: {line}"
        );
    }

    // cm:guard a tmux session inherits the client environment and `-e` can only SET, never unset — so every variable a pane needs that `build_command` would have given it has to be listed here, and the ones it must NOT have are removed by the `sh` line instead. Dropping either half is silent: the master runs, and behaves differently.
    #[test]
    fn the_pane_carries_the_mcp_timeout_and_respects_an_operator_override() {
        let env = pane_env();
        match std::env::var_os("MCP_TOOL_TIMEOUT") {
            Some(v) if !v.is_empty() => assert!(env.is_empty(), "an operator value must win"),
            _ => {
                assert_eq!(env.len(), 1);
                assert_eq!(env[0].0, "MCP_TOOL_TIMEOUT");
                assert!(env[0].1.parse::<u64>().is_ok(), "{:?}", env[0].1);
            }
        }
    }
    const THIS_SOURCE: &str = include_str!("terminal.rs");

    // cm:guard the boundary is the box-killer: one character over and EVERY tmux call on that box fails with `File name too long`, which is not a degraded runner but a dead one. Measured 2026-09-11 on a 122-character path.
    #[test]
    fn a_socket_path_too_long_to_bind_is_refused_before_it_is_used() {
        assert!(fits_a_unix_socket(&"a".repeat(100)));
        assert!(!fits_a_unix_socket(&"a".repeat(101)));
        assert!(!fits_a_unix_socket(&format!(
            "/home/x/{}/tmux.sock",
            "d".repeat(120)
        )));
    }

    // cm:guard a refused path falls back to the DEFAULT socket rather than to nothing: `socket_args` empty means "run where the old builds ran", which is degraded and alive, where a bad `-S` is neither.
    #[test]
    fn a_refused_socket_leaves_the_args_empty_rather_than_broken() {
        let args = socket_args();
        assert!(args.is_empty() || args[0] == "-S", "{args:?}");
        if args.len() == 2 {
            assert!(fits_a_unix_socket(&args[1]));
        }
    }

    // cm:guard EVERY tmux invocation has to carry the socket, so the count of raw spawns is the assertion: a third `Command::new("tmux")` added without the socket would talk to the operator's default server, and the failure is silent — a buffer loaded there is simply invisible to a paste on ours.
    #[test]
    fn nothing_spawns_tmux_without_the_socket() {
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        assert_eq!(
            production.matches("Command::new(\"tmux\")").count(),
            2,
            "the wrapper and load-buffer are the only two, and both take `socket_args()`"
        );
        let load = production
            .split("Command::new(\"tmux\")")
            .nth(2)
            .expect("the load-buffer spawn");
        assert!(
            production.contains("let mut load = socket_args();"),
            "load-buffer builds its args from the socket"
        );
        assert!(load.contains("&load"), "and passes them");
    }

    // cm:guard the ORDER is the property: cgroup membership is inherited at fork and cannot be changed afterwards, so a server started implicitly by `new-session` is already inside this service's cgroup by the time anything could move it.
    #[test]
    fn the_server_is_placed_before_the_first_session_is_created() {
        let body = THIS_SOURCE
            .split("pub async fn ensure(")
            .nth(1)
            .expect("ensure")
            .split("\n}")
            .next()
            .unwrap();
        let placed = body.find("ensure_server().await").expect("placement");
        let created = body.find("\"new-session\"").expect("the session");
        assert!(
            placed < created,
            "the server must be placed before the first session, not after"
        );
    }

    // cm:guard the keep-alive is not an agent pane and must never be read as one — every reader on this box classifies a session by these two prefixes.
    #[test]
    fn the_keepalive_session_is_not_mistakable_for_an_agent() {
        assert!(!KEEPALIVE.starts_with(MASTER_PREFIX));
        assert!(!KEEPALIVE.starts_with(RUN_PREFIX));
    }

    // cm:guard the unit name is what stops an operator's `systemctl --user stop forge-runner*` from taking the sessions with it, so it may not share that prefix.
    #[test]
    fn the_session_unit_is_not_matched_by_a_glob_over_the_runners_own() {
        assert!(!SESSION_UNIT.starts_with("forge-runner"));
    }

    // cm:guard `--scope` places NOTHING here and the source must not drift back to it: `tmux` daemonizes, so the tracked process exits, the scope is collected, and the server lands in the caller's cgroup. Measured 2026-09-11 — the scope form looked correct and left the server in `org.gnome.Shell@x11.service`.
    #[test]
    fn the_server_is_started_as_a_forking_service_and_never_as_a_scope() {
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        assert!(production.contains("--service-type=forking"));
        assert!(
            !production.contains("\"--scope\""),
            "a scope cannot hold a process that daemonizes"
        );
    }

    // cm:guard started WITH a session, never bare: a tmux server with no sessions exits immediately (`exit-empty` defaults on), so `start-server` alone leaves the unit inactive and no server at all.
    #[test]
    fn the_server_is_started_holding_a_session_rather_than_empty() {
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        let call = production
            .split("Command::new(\"systemd-run\")")
            .nth(1)
            .expect("the placement");
        let call = call.split("await").next().unwrap();
        assert!(call.contains("\"new-session\""), "must carry a session");
        assert!(
            !call.contains("\"start-server\""),
            "a bare server exits on the spot"
        );
    }
    /// A sweep starts several panes at once; the server must be placed exactly once and they must all land.
    // cm:guard this is the regression for the race the wait fixes: cold-start, then N callers at once. Without `server_answers_within`, every caller but the winner gets `Unit forge-sessions.service already exists` — a non-zero exit that is NOT a failure — reports false, and races `new-session` against a socket nothing has bound yet.
    #[tokio::test]
    async fn a_cold_start_hit_by_several_panes_at_once_places_one_server_and_loses_no_pane() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        if !available() || !can_place_a_unit().await {
            eprintln!("no tmux or no systemd user manager here — the placement property does not exist on this box");
            return;
        }
        let Some(sock) = socket_path() else {
            eprintln!("no usable socket path here");
            return;
        };
        let _ = tmux(&["kill-server"]).await;
        let _ = Command::new("systemctl")
            .args(["--user", "stop", &format!("{SESSION_UNIT}.service")])
            .stdin(Stdio::null())
            .output()
            .await;
        let _ = Command::new("systemctl")
            .args(["--user", "reset-failed", &format!("{SESSION_UNIT}.service")])
            .stdin(Stdio::null())
            .output()
            .await;
        let _ = std::fs::remove_file(&sock);
        assert!(!server_answers().await, "the server must start out cold");

        let placed: Vec<bool> =
            futures_util::future::join_all((0..6).map(|_| ensure_server())).await;
        assert!(
            placed.iter().all(|p| *p),
            "every concurrent caller must report the server placed, including the ones that lost the race: {placed:?}"
        );

        let dir = std::env::temp_dir().join(format!("forge-race-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let names: Vec<String> = (0..4)
            .map(|i| session_name("forge-test", &format!("race{}-{i}", std::process::id())))
            .collect();
        for n in &names {
            let _ = kill(n).await;
        }
        futures_util::future::join_all(names.iter().map(|n| {
            let dir = dir.clone();
            async move {
                ensure(n, &dir, &["sleep".to_string(), "60".to_string()], &[], None)
                    .await
                    .expect("the pane must start")
            }
        }))
        .await;
        for n in &names {
            assert!(alive(n).await, "{n} must be findable by its exact name");
            let _ = kill(n).await;
        }
    }
}
