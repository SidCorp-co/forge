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
pub const MASTER_PREFIX: &str = "forge-master";

/// A run session's pane, distinct from its master's so `alive`/`kill` cannot cross them.
pub const RUN_PREFIX: &str = "forge-run";

/// Whether this box can host a resident session at all.
pub fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| which::which("tmux").is_ok())
}

/// A tmux session name derived from `raw`, safe as an argument and a target.
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

/// The config dir this box's session server is keyed on.
///
/// One reading, because the socket and the unit are two halves of one identity
/// and a caller that resolved them separately could temp one and not the other.
fn session_config_dir() -> Option<std::path::PathBuf> {
    crate::config::Config::path()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
}

/// The config dir with no override in the environment — this box's own.
///
/// `Config::path()` answers with whatever `XDG_CONFIG_HOME` points at, so
/// telling "the box's own" from "a temp one" needs the unoverridden value, and
/// there is no way to ask `dirs_next` for it without unsetting a process-wide
/// variable under every other thread.
fn unoverridden_config_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "linux")]
    {
        dirs_next::home_dir().map(|h| h.join(".config").join("forge-runner"))
    }
    // Only Linux has the user manager this unit is placed in, and `dirs_next`
    // consults no XDG variable elsewhere, so the resolved dir IS the box's own.
    #[cfg(not(target_os = "linux"))]
    {
        dirs_next::config_dir().map(|d| d.join("forge-runner"))
    }
}

/// The socket this box's agent sessions live on.
///
/// Derived from `Config::path()` and nothing else, exactly as the control
/// socket is: dev1 runs several runner services that differ ONLY by
/// `XDG_CONFIG_HOME`, and a shared session server would let one of them address
/// another's panes.
pub fn socket_path() -> Option<std::path::PathBuf> {
    SessionIdentity::current().map(|id| id.socket)
}

/// Whether a path can be a unix socket at all on this platform.
fn fits_a_unix_socket(path: &str) -> bool {
    path.len() <= 100
}

/// `-S <socket>`, or nothing when this box cannot name its config dir.
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
fn session_target(name: &str) -> String {
    format!("={name}")
}

/// A PANE target for the same session — the trailing `:` is not optional.
fn pane_target(name: &str) -> String {
    format!("={name}:")
}

/// Whether a session by this exact name exists right now.
/// The pid of the process a pane is running, once it exists.
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
const SESSION_UNIT: &str = "forge-sessions";

/// The unit name for the config dir in force, which is what every systemd call
/// in this module names.
///
/// The box's own config dir keeps the bare `SESSION_UNIT`, so nothing about a
/// real runner changes. Any OTHER config dir — a test's temp dir, a leaked
/// `/tmp/forge-cred-*` inherited by a stray subprocess — gets a unit of its
/// own, and can no longer reach the one this box's panes run under.
fn unit_for(dir: &std::path::Path) -> String {
    let Some(own) = unoverridden_config_dir() else {
        return SESSION_UNIT.to_string();
    };
    let dir = resolved(dir);
    if dir == resolved(&own) {
        return SESSION_UNIT.to_string();
    }
    use sha2::Digest as _;
    let digest = sha2::Sha256::digest(path_bytes(&dir));
    format!("{SESSION_UNIT}-{}", &hex::encode(digest)[..16])
}

/// The socket and the unit, from ONE reading of the config dir.
///
/// Every systemd call and every tmux call on the placement path takes its half
/// from one of these rather than asking again.
struct SessionIdentity {
    socket: std::path::PathBuf,
    unit: String,
}

impl SessionIdentity {
    fn current() -> Option<Self> {
        let dir = session_config_dir()?;
        let socket = dir.join("tmux.sock");
        if !fits_a_unix_socket(&socket.to_string_lossy()) {
            return None;
        }
        Some(Self {
            unit: unit_for(&dir),
            socket,
        })
    }
}

/// A path as the filesystem sees it, resolving as much of it as exists.
///
/// `canonicalize` needs the whole path to exist, and a fresh box is exactly the
/// case where the last component does not. Resolving the deepest ancestor that
/// does exist and appending the rest as written is what makes a symlinked
/// `~/.config` still the box's own dir before the first run has made
/// `forge-runner/` inside it.
fn resolved(p: &std::path::Path) -> std::path::PathBuf {
    if let Ok(whole) = p.canonicalize() {
        return whole;
    }
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = p;
    while let (Some(parent), Some(name)) = (cursor.parent(), cursor.file_name()) {
        missing.push(name.to_os_string());
        if let Ok(base) = parent.canonicalize() {
            let mut out = base;
            for part in missing.iter().rev() {
                out.push(part);
            }
            return out;
        }
        cursor = parent;
    }
    p.to_path_buf()
}

/// A path's own bytes, for hashing.
fn path_bytes(p: &std::path::Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt as _;
        p.as_os_str().as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        p.to_string_lossy().as_bytes().to_vec()
    }
}

/// The session the server is started with, so it has one and does not exit.
const KEEPALIVE: &str = "forge-session-host";

/// Start the session server under a unit of its OWN, if it is not already up.
///
/// This is the survival property, and it is about the SERVER, not the panes.
/// tmux already gives each pane a scope of its own, but a server that dies
/// takes its panes with it — so a server forked into this service's cgroup
/// means `systemctl restart forge-runner` kills every agent on the box. That is
/// what makes an ordinary update destructive.
async fn ensure_server() -> bool {
    static PLACING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one_attempt = PLACING.lock().await;
    if server_answers().await {
        return true;
    }
    let Some(id) = SessionIdentity::current() else {
        tracing::warn!(
            "[terminal] no usable session socket path — agent panes will run on the default tmux server and die with this service, as they did before"
        );
        return false;
    };
    let sock = &id.socket;
    if let Some(parent) = sock.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!(
                "[terminal] could not make the session socket's directory {} ({e}) — panes will be killed with this service, as they were before",
                parent.display()
            );
            return false;
        }
    }
    match ask_systemd_for_the_server(&id).await {
        Placement::Accepted if server_answers_within(SERVER_READY_WITHIN).await => {
            tracing::info!(
                "[terminal] session server running as {}.service — agent panes now outlive a restart of this one",
                id.unit
            );
            true
        }
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
enum Placement {
    Accepted,
    Unavailable(String),
}

/// The most placements this process has ever had in flight at once.
static PLACEMENTS_AT_ONCE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static MOST_AT_ONCE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

struct OverlapWatch;

impl OverlapWatch {
    fn enter() -> Self {
        use std::sync::atomic::Ordering::Relaxed;
        let now = PLACEMENTS_AT_ONCE.fetch_add(1, Relaxed) + 1;
        MOST_AT_ONCE.fetch_max(now, Relaxed);
        Self
    }
}

impl Drop for OverlapWatch {
    fn drop(&mut self) {
        PLACEMENTS_AT_ONCE.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

async fn ask_systemd_for_the_server(id: &SessionIdentity) -> Placement {
    let _overlap = OverlapWatch::enter();
    let sock = id.socket.to_string_lossy().into_owned();
    let out = Command::new("systemd-run")
        .args([
            "--user",
            "--unit",
            &id.unit,
            "--service-type=forking",
            "--collect",
            "--quiet",
            "tmux",
            "-S",
            &sock,
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
            if unit_is_running(&id.unit).await {
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
async fn unit_is_running(unit: &str) -> bool {
    Command::new("systemctl")
        .args(["--user", "is-active", &format!("{unit}.service")])
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
async fn server_answers() -> bool {
    tmux(&["list-sessions"])
        .await
        .is_ok_and(|o| o.status.success())
}

/// How long a caller waits for a socket systemd has ALREADY agreed to bring up.
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
    if let Some(path) = transcript {
        pipe_pane(name, path).await;
    }
    Ok(true)
}

/// Append everything the pane prints to `path`, for as long as it lives.
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
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// How long a freshly spawned pane needs before a paste reaches its composer.
pub const PANE_BRIEF_DELAY: Duration = Duration::from_secs(5);

/// Brief a pane that has just been spawned, after giving its TUI time to draw.
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
pub async fn send_line(name: &str, text: &str) -> Result<()> {
    if !alive(name).await {
        return Err(Error::Other(format!("no session named {name}")));
    }
    let target = pane_target(name);
    let buffer = format!("forge-{}", std::process::id());

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
pub fn pane_argv(mcp_config: Option<&std::path::Path>, resume: Option<&str>) -> Vec<String> {
    let bin = shell_quote(crate::runner::process::resolve_claude_bin());
    let mut line = format!("unset CLAUDECODE; exec {bin} --permission-mode bypassPermissions");
    if let Some(path) = mcp_config {
        line.push_str(&format!(
            " --mcp-config {}",
            shell_quote(&path.to_string_lossy())
        ));
    }
    if let Some(id) = resume.filter(|s| !s.is_empty()) {
        line.push_str(&format!(" --resume {}", shell_quote(id)));
    }
    vec!["sh".into(), "-c".into(), line]
}

/// The environment a master's pane needs that a tmux session does not inherit.
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
    use crate::auth::cred_store::{ScopedVar, ENV_TEST_LOCK};

    /// The unit the config dir in force resolves.
    ///
    /// Production reads it off a [`SessionIdentity`], which is the one reading
    /// the placement path is entitled to; the tests below ask about the name on
    /// its own, and this is that question.
    fn session_unit() -> String {
        SessionIdentity::current()
            .map(|id| id.unit)
            .unwrap_or_else(|| SESSION_UNIT.to_string())
    }

    /// Every test below drives ONE server on one socket, so they run one at a time.
    static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// A config dir of this test's own, removed however the test ends.
    ///
    /// The `forge-runner` directory inside it is made here because `tmux -S`
    /// will not make it.
    struct ConfigHome(std::path::PathBuf);

    impl ConfigHome {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("forge-{label}-{}", std::process::id()));
            std::fs::create_dir_all(dir.join("forge-runner")).expect("temp config dir");
            Self(dir)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for ConfigHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The unit and server a test places, gone however the test ends.
    ///
    /// Constructing it tears down first, which is the cold start the test needs;
    /// dropping it tears down again, which is the one a panic needs.
    struct PlacedUnit {
        unit: String,
        socket: std::path::PathBuf,
    }

    impl PlacedUnit {
        /// Tears down now, for a test that needs a cold start, and again on drop.
        fn cold(unit: String, socket: std::path::PathBuf) -> Self {
            let placed = Self::guarding(unit, socket);
            placed.tear_down();
            placed
        }

        /// Tears down on drop only, for a test that places a unit as a side
        /// effect of what it is really asserting.
        fn guarding(unit: String, socket: std::path::PathBuf) -> Self {
            assert_ne!(
                unit.as_str(),
                SESSION_UNIT,
                "this guard stops the unit it is given; it may never be given the box's own"
            );
            Self { unit, socket }
        }

        fn tear_down(&self) {
            let _ = std::process::Command::new("tmux")
                .args(["-S", &self.socket.to_string_lossy(), "kill-server"])
                .stdin(std::process::Stdio::null())
                .output();
            for verb in ["stop", "reset-failed"] {
                let _ = std::process::Command::new("systemctl")
                    .args(["--user", verb, &format!("{}.service", self.unit)])
                    .stdin(std::process::Stdio::null())
                    .output();
            }
        }
    }

    impl Drop for PlacedUnit {
        fn drop(&mut self) {
            self.tear_down();
        }
    }

    /// A config dir of this test's own, the env pointed at it, and whatever unit
    /// and server the test places torn down at the end.
    ///
    /// Fields are dropped in declaration order, so the unit goes before the env
    /// is put back and before the directory is removed.
    struct Sandbox {
        _placed: Option<PlacedUnit>,
        _xdg: ScopedVar,
        _home: ConfigHome,
    }

    impl Sandbox {
        fn new(label: &str) -> Self {
            let home = ConfigHome::new(label);
            let xdg = ScopedVar::set("XDG_CONFIG_HOME", home.path());
            let placed = socket_path()
                .filter(|sock| sock.starts_with(home.path()))
                .map(|sock| PlacedUnit::guarding(session_unit(), sock));
            Self {
                _placed: placed,
                _xdg: xdg,
                _home: home,
            }
        }
    }

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

    #[test]
    fn a_pane_target_is_not_a_session_target() {
        assert_eq!(session_target("m"), "=m");
        assert_eq!(pane_target("m"), "=m:");
        assert!(
            pane_target("m").starts_with('='),
            "exact match must survive"
        );
    }

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
    // cm:hack ISS-1044 until:one of these tests asks for a runtime flavour — `await_holding_lock` is allowed here because holding `ENV_TEST_LOCK` across the body IS the point: `XDG_CONFIG_HOME` is process-global, so a guard dropped before the first await protects nothing. What is traded is clippy's warning about starving a runtime, and it costs nothing while every test here is a bare `#[tokio::test]`, which is current-thread and has no other task to starve. `the_serialised_tests_stay_on_a_current_thread_runtime` is that condition as a gate rather than as a sentence.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_pane_receives_what_is_typed_at_it_and_the_transcript_keeps_it() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _sandbox = Sandbox::new("panes");
        if !available() {
            eprintln!("tmux is not installed here — the transport test cannot run");
            return;
        }
        let dir = std::env::temp_dir().join(format!("forge-terminal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let log = dir.join("transcript.log");
        let name = session_name("forge-test", &format!("t{}", std::process::id()));
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
    // cm:hack ISS-1044 until:one of these tests asks for a runtime flavour — `await_holding_lock` is allowed here because holding `ENV_TEST_LOCK` across the body IS the point: `XDG_CONFIG_HOME` is process-global, so a guard dropped before the first await protects nothing. What is traded is clippy's warning about starving a runtime, and it costs nothing while every test here is a bare `#[tokio::test]`, which is current-thread and has no other task to starve. `the_serialised_tests_stay_on_a_current_thread_runtime` is that condition as a gate rather than as a sentence.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_restart_re_enters_the_pane_it_left_rather_than_starting_a_second_one() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _sandbox = Sandbox::new("panes");
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

    #[test]
    fn a_pane_runs_interactively_with_no_inherited_claudecode() {
        let argv = pane_argv(None, None);
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

    #[test]
    fn a_project_with_no_servers_leaves_the_pane_argv_exactly_as_it_was() {
        assert_eq!(pane_argv(None, None), pane_argv(None, None));
        assert!(!pane_argv(None, None)[2].contains("--mcp-config"));
    }

    /// ISS-1050 step 19, run by hand: `cargo test -p forge-runner-core --lib
    /// a_killed_pane_is_rebuilt_on_the_conversation_it_had -- --ignored --exact --nocapture`.
    ///
    /// Composes the three production pieces on a REAL tmux — `resume_for`'s decision, `pane_argv`'s
    /// argv, and `ensure`'s spawn — which the unit tests above each cover alone and none covers
    /// together.
    #[tokio::test]
    #[ignore]
    async fn a_killed_pane_is_rebuilt_on_the_conversation_it_had() {
        let root =
            std::env::temp_dir().join(format!("forge-iss1050-step19-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let sock = root.join("tmux");
        let bin = root.join("bin");
        let repo = root.join("repo");
        let argv_log = root.join("argv.log");
        for d in [&sock, &bin, &repo] {
            std::fs::create_dir_all(d).expect("mkdir");
        }
        std::fs::write(
            bin.join("claude"),
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {}\nsleep 300\n",
                argv_log.display()
            ),
        )
        .expect("shim");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o755))
                .expect("mode");
        }
        // Before anything resolves the binary: `resolve_claude_bin` caches in a `OnceLock`.
        std::env::set_var(
            "PATH",
            format!(
                "{}:{}",
                bin.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        );
        std::env::set_var("TMUX_TMPDIR", &sock);

        let conv = format!("conv-step19-{}", std::process::id());
        let transcript =
            crate::daemon::master::conversation_transcript(&repo, &conv).expect("a home directory");
        std::fs::create_dir_all(transcript.parent().expect("parent")).expect("mkdir");
        std::fs::write(&transcript, "{}\n").expect("transcript");

        let name = format!("forge-step19-{}", std::process::id());
        let spawn = |resume: Option<String>| {
            let name = name.clone();
            let repo = repo.clone();
            async move {
                ensure(&name, &repo, &pane_argv(None, resume.as_deref()), &[], None)
                    .await
                    .expect("spawn")
            }
        };

        // 1. a pane, resumed from the conversation this box has a transcript for
        spawn(Some(conv.clone())).await;
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        assert!(alive(&name).await, "the pane should be up");

        // 2. kill it and rebuild: the rebuilt pane carries the SAME conversation (criterion 17)
        kill(&name).await.expect("kill");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(!alive(&name).await, "the pane should be gone");
        spawn(Some(conv.clone())).await;
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        // 3. delete the transcript: the decision flips to cold (criterion 18)
        std::fs::remove_file(&transcript).expect("remove");
        let after = crate::daemon::master::resume_for("step19", &repo, Some(&conv));

        let log = std::fs::read_to_string(&argv_log).unwrap_or_default();
        let _ = kill(&name).await;
        let _ = std::fs::remove_dir_all(&root);

        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines.len(), 2, "two spawns, two recorded argvs: {log}");
        for (i, line) in lines.iter().enumerate() {
            assert!(
                line.contains(&format!("--resume {conv}")),
                "spawn {i} should carry the conversation: {line}"
            );
        }
        assert_eq!(
            after, None,
            "with the transcript gone the next spawn must be cold, not a --resume this box cannot reach"
        );
    }

    #[test]
    fn a_pane_with_nothing_to_resume_carries_no_resume_flag() {
        for none in [None, Some("")] {
            let line = pane_argv(None, none)[2].clone();
            assert!(
                !line.contains("--resume"),
                "a cold start must be the command it was before this parameter existed: {line}"
            );
        }
    }

    #[test]
    fn a_pane_given_a_conversation_resumes_it() {
        let line = pane_argv(None, Some("conv-abc"))[2].clone();
        assert!(
            line.contains("--resume 'conv-abc'") || line.contains("--resume conv-abc"),
            "the conversation must reach claude: {line}"
        );
    }

    #[test]
    fn a_conversation_id_carrying_shell_metacharacters_cannot_run_a_command() {
        let hostile = "a'; touch /tmp/forge-pwned; echo '";
        let line = pane_argv(None, Some(hostile))[2].clone();

        // The whole id, however it is spelled, must sit inside one quoted word.
        assert!(
            line.ends_with(&format!("--resume {}", shell_quote(hostile))),
            "the id must reach the shell as one quoted word: {line}"
        );
        // And the payload must never appear at the top level, where a shell would run it.
        let after = line.split("--resume ").nth(1).expect("a resume flag");
        assert!(
            !after.starts_with("a'; touch"),
            "the id is interpolated raw and would run a command: {line}"
        );
    }

    #[test]
    fn the_mcp_config_path_reaches_the_pane_quoted_and_without_strict() {
        let path =
            std::path::PathBuf::from("/home/o p/config/forge-runner/mcp/forge-master-mcp-x.json");
        let line = pane_argv(Some(&path), None)[2].clone();
        assert!(
            line.contains(
                "--mcp-config '/home/o p/config/forge-runner/mcp/forge-master-mcp-x.json'"
            ),
            "{line}"
        );
        assert!(
            !line.contains("--strict-mcp-config"),
            "strict would drop the checkout's .mcp.json, which is where `forge` itself comes from: {line}"
        );
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "printf %s {}",
                shell_quote(&path.to_string_lossy())
            ))
            .output()
            .expect("sh must run");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            path.to_string_lossy(),
            "the shell must see exactly the path"
        );
    }

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

    #[test]
    fn a_socket_path_too_long_to_bind_is_refused_before_it_is_used() {
        assert!(fits_a_unix_socket(&"a".repeat(100)));
        assert!(!fits_a_unix_socket(&"a".repeat(101)));
        assert!(!fits_a_unix_socket(&format!(
            "/home/x/{}/tmux.sock",
            "d".repeat(120)
        )));
    }

    #[test]
    fn a_refused_socket_leaves_the_args_empty_rather_than_broken() {
        let args = socket_args();
        assert!(args.is_empty() || args[0] == "-S", "{args:?}");
        if args.len() == 2 {
            assert!(fits_a_unix_socket(&args[1]));
        }
    }

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

    #[test]
    fn the_keepalive_session_is_not_mistakable_for_an_agent() {
        assert!(!KEEPALIVE.starts_with(MASTER_PREFIX));
        assert!(!KEEPALIVE.starts_with(RUN_PREFIX));
    }

    /// The condition the `cm:hack` above each serialised test ends on.
    #[test]
    fn the_serialised_tests_stay_on_a_current_thread_runtime() {
        let flavoured = concat!("tokio::", "test(");
        assert!(
            !THIS_SOURCE.contains(flavoured),
            "a test here asks for a runtime flavour; the await_holding_lock allow must be re-argued with it"
        );
    }

    #[test]
    fn the_session_unit_is_not_matched_by_a_glob_over_the_runners_own() {
        assert!(!SESSION_UNIT.starts_with("forge-runner"));
    }

    /// Criterion 4. Nothing about a real runner changes: the box's own config
    /// dir still resolves the bare name its live panes are already inside.
    #[test]
    fn the_boxs_own_config_dir_resolves_the_bare_session_unit() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _xdg = ScopedVar::unset("XDG_CONFIG_HOME");
        assert_eq!(session_unit(), SESSION_UNIT);

        // Naming the same dir explicitly is still the box's own. Linux only: see
        // the note on the tests below — off Linux this variable moves nothing, so
        // the assertion would hold for a reason that is not the one being claimed.
        #[cfg(target_os = "linux")]
        {
            let own = unoverridden_config_dir().expect("this box resolves a config dir");
            let _explicit = ScopedVar::set("XDG_CONFIG_HOME", own.parent().expect("…/.config"));
            assert_eq!(session_config_dir().as_deref(), Some(own.as_path()));
            assert_eq!(session_unit(), SESSION_UNIT);
        }
    }

    /// F2 from the ISS-1044 review: a Unix path is bytes and need not be UTF-8.
    #[cfg(all(unix, target_os = "linux"))]
    #[test]
    fn two_config_dirs_differing_only_in_invalid_utf8_get_different_units() {
        use std::os::unix::ffi::OsStringExt as _;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let mut units = Vec::new();
        let mut sockets = Vec::new();
        for tail in [b"\xf0".to_vec(), b"\xf1".to_vec()] {
            let mut raw = format!("/tmp/forge-bytes-{}-", std::process::id()).into_bytes();
            raw.extend(tail);
            let dir = std::path::PathBuf::from(std::ffi::OsString::from_vec(raw));
            let _xdg = ScopedVar::set("XDG_CONFIG_HOME", &dir);
            units.push(session_unit());
            sockets.push(socket_path().expect("a socket"));
        }

        assert_ne!(sockets[0], sockets[1], "the two dirs really are different");
        assert_ne!(
            units[0], units[1],
            "two config dirs with different sockets may not share one unit"
        );
    }

    /// F1 from the ISS-1044 review: an operator whose `XDG_CONFIG_HOME` reaches
    /// the box's own config root through a symlink must keep the bare unit.
    #[cfg(all(unix, target_os = "linux"))]
    #[test]
    fn a_config_dir_reached_through_an_alias_is_still_the_boxs_own() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let own = unoverridden_config_dir().expect("this box resolves a config dir");
        let Some(root) = own.parent().map(std::path::Path::to_path_buf) else {
            return;
        };
        if !own.exists() {
            eprintln!("this box has no config dir yet — an alias to it cannot be built");
            return;
        }

        let holder = ConfigHome::new("alias");
        let link = holder.path().join("config");
        std::os::unix::fs::symlink(&root, &link).expect("a symlink into the box's own config root");
        {
            let _xdg = ScopedVar::set("XDG_CONFIG_HOME", &link);
            assert_eq!(
                session_unit(),
                SESSION_UNIT,
                "a symlinked config root is the box's own dir, not an override"
            );

            // F1's second half: a FRESH box, where the leaf does not exist yet.
            // Whole-path canonicalization fails for both spellings there, so
            // only resolving the deepest existing ancestor keeps them equal.
            let leaf = own
                .file_name()
                .expect("the config dir is a named directory")
                .to_os_string();
            let unborn = format!("{}-unborn", leaf.to_string_lossy());
            assert!(!root.join(&unborn).exists(), "the leaf must not exist");
            assert_eq!(
                unit_for(&link.join(&unborn)),
                unit_for(&root.join(&unborn)),
                "an alias of a dir that does not exist yet is still the same dir"
            );
        }

        let dotted = root.join("..").join(
            root.file_name()
                .expect("the config root is a named directory"),
        );
        let _xdg = ScopedVar::set("XDG_CONFIG_HOME", &dotted);
        assert_eq!(
            session_unit(),
            SESSION_UNIT,
            "a `..` spelling of the box's own dir is not an override"
        );
    }

    /// `unoverridden_config_dir` and `dirs_next`'s own resolution must agree, or the
    /// override test above is comparing against a rule nothing else follows.
    #[test]
    fn the_unoverridden_dir_is_what_the_box_resolves_with_no_override() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _xdg = ScopedVar::unset("XDG_CONFIG_HOME");
        assert_eq!(session_config_dir(), unoverridden_config_dir());
    }

    /// Criterion 5, and the whole of what makes `cargo test` cost a box nothing:
    /// a config dir that is not this box's own cannot name this box's unit.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_config_dir_that_is_not_the_boxs_own_resolves_a_unit_of_its_own() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = ConfigHome::new("unit-temp");
        let _xdg = ScopedVar::set("XDG_CONFIG_HOME", dir.path());

        let unit = session_unit();
        assert_ne!(
            unit, SESSION_UNIT,
            "a temp config dir may not name the live unit"
        );
        assert!(
            unit.starts_with(&format!("{SESSION_UNIT}-")),
            "still recognisable as one of ours: {unit}"
        );
    }

    /// Criteria 6 and 7: one reading of the config dir, so the socket and the
    /// unit cannot be temped separately.
    #[cfg(target_os = "linux")]
    #[test]
    fn moving_the_config_dir_moves_the_socket_and_the_unit_together() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let a = ConfigHome::new("pair-a");
        let b = ConfigHome::new("pair-b");

        let xdg = ScopedVar::set("XDG_CONFIG_HOME", a.path());
        let (sock_a, unit_a) = (socket_path().expect("a socket"), session_unit());
        assert_eq!(
            sock_a.parent(),
            session_config_dir().as_deref(),
            "the socket is made from the same reading the unit is"
        );
        assert!(sock_a.starts_with(a.path()), "{}", sock_a.display());

        xdg.move_to(b.path());
        let (sock_b, unit_b) = (socket_path().expect("a socket"), session_unit());
        assert_ne!(sock_a, sock_b, "the socket must follow the config dir");
        assert_ne!(unit_a, unit_b, "and so must the unit");
        assert!(sock_b.starts_with(b.path()), "{}", sock_b.display());

        xdg.move_to(a.path());
        assert_eq!(session_unit(), unit_a);
        assert_eq!(socket_path().expect("a socket"), sock_a);
    }

    /// Criterion 8: the prefix guard holds for every name the override can
    /// produce, not only for the constant it is derived from.
    #[cfg(target_os = "linux")]
    #[test]
    fn no_config_dir_produces_a_unit_inside_the_runners_own_prefix() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut names = vec![{
            let _xdg = ScopedVar::unset("XDG_CONFIG_HOME");
            session_unit()
        }];
        for label in ["prefix-1", "prefix-2"] {
            let dir = ConfigHome::new(label);
            let _xdg = ScopedVar::set("XDG_CONFIG_HOME", dir.path());
            names.push(session_unit());
        }
        for n in &names {
            assert!(!n.starts_with("forge-runner"), "{n}");
            assert!(
                n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
                "a unit name, not a path: {n}"
            );
        }
    }

    /// Criteria 9 and 10, statically over this whole file.
    #[test]
    fn no_systemd_command_names_a_literal_unit() {
        let forbidden = concat!("SESSION", "_UNIT");
        let needles = [
            concat!("Command::new(\"system", "ctl\")"),
            concat!("Command::new(\"system", "d-run\")"),
        ];
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        let calls = |src: &'static str, needle: &str| -> Vec<&'static str> {
            src.split(needle)
                .skip(1)
                .map(|s| s.split(".output()").next().unwrap())
                .collect()
        };

        let mut scanned = 0usize;
        for needle in needles {
            for call in calls(THIS_SOURCE, needle) {
                scanned += 1;
                assert!(
                    !call.contains(forbidden),
                    "a systemd call naming the literal unit: {call}"
                );
            }
        }
        assert!(
            scanned >= 4,
            "the scan found {scanned} systemd calls; it must reach every one in this file"
        );

        // F4 from the ISS-1044 review, twice over. The segment scan starts at
        // `Command::new`, so `let unit = SESSION_UNIT;` — or the bare string —
        // on the line before it is a systemd call naming the live unit that no
        // segment contains. The rule that terminates is about the FUNCTION, not
        // about the call expression: an item that spawns systemd may not hold
        // the const or the literal at all, however it is spelled or aliased.
        let code: String = production
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .map(|l| format!("{l}\n"))
            .collect();
        let literal = concat!("forge-", "sessions");

        let mut items_with_systemd = 0usize;
        for item in code.split("\n}\n") {
            if !needles.iter().any(|n| item.contains(n)) {
                continue;
            }
            items_with_systemd += 1;
            assert!(
                !item.contains(forbidden),
                "an item that spawns systemd may not hold the const: {item}"
            );
            assert!(
                !item.contains(literal),
                "an item that spawns systemd may not hold the literal unit name: {item}"
            );
        }
        assert!(
            items_with_systemd >= 2,
            "{items_with_systemd} production item(s) spawn systemd; the placement and the liveness probe are both owed"
        );

        // and the literal itself exists once, where the const is declared.
        assert_eq!(
            code.matches(literal).count(),
            1,
            "the unit's name is written once in production code, as the const's value"
        );
        assert!(
            code.contains(&format!("const {forbidden}: &str = \"{literal}\";")),
            "that one writing must be the declaration"
        );
    }

    #[test]
    fn the_server_is_started_as_a_forking_service_and_never_as_a_scope() {
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        assert!(production.contains("--service-type=forking"));
        assert!(
            !production.contains("\"--scope\""),
            "a scope cannot hold a process that daemonizes"
        );
    }

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
    /// A sweep starts several panes at once; one placement is asked for, and no pane is lost.
    // cm:hack ISS-1044 until:one of these tests asks for a runtime flavour — `await_holding_lock` is allowed here because holding `ENV_TEST_LOCK` across the body IS the point: `XDG_CONFIG_HOME` is process-global, so a guard dropped before the first await protects nothing. What is traded is clippy's warning about starving a runtime, and it costs nothing while every test here is a bare `#[tokio::test]`, which is current-thread and has no other task to starve. `the_serialised_tests_stay_on_a_current_thread_runtime` is that condition as a gate rather than as a sentence.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_cold_start_hit_by_several_panes_at_once_places_one_server_and_loses_no_pane() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if !available() || !can_place_a_unit().await {
            eprintln!("no tmux or no systemd user manager here — the placement property does not exist on this box");
            return;
        }
        let home = ConfigHome::new("coldstart");
        let _xdg = ScopedVar::set("XDG_CONFIG_HOME", home.path());
        let unit = session_unit();
        assert_ne!(
            unit, SESSION_UNIT,
            "this test stops the unit it names, so it may never name the one the box serves panes from"
        );
        let Some(sock) = socket_path() else {
            eprintln!("no usable socket path here");
            return;
        };
        assert!(
            sock.starts_with(home.path()),
            "the socket must be this test's own: {}",
            sock.display()
        );
        let _placed = PlacedUnit::cold(unit, sock.clone());
        let _ = std::fs::remove_file(&sock);
        assert!(!server_answers().await, "the server must start out cold");

        MOST_AT_ONCE.store(0, std::sync::atomic::Ordering::Relaxed);
        futures_util::future::join_all((0..6).map(|_| ensure_server())).await;
        assert_eq!(
            MOST_AT_ONCE.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "six panes starting at once must never have two placements in flight together"
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
        let _ = std::fs::remove_dir_all(&dir);
    }
}
