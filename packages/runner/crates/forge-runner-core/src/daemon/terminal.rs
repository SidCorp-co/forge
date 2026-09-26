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

use super::composer;
use crate::error::{Error, Result};

pub const MASTER_PREFIX: &str = "forge-master";

pub const RUN_PREFIX: &str = "forge-run";

pub const JOB_PREFIX: &str = "forge-job";

pub async fn names_with_prefix(prefix: &str) -> Vec<String> {
    let Ok(out) = tmux(&["list-sessions", "-F", "#{session_name}"]).await else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|n| n.starts_with(prefix))
        .map(str::to_string)
        .collect()
}

pub fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| which::which("tmux").is_ok())
}

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

fn session_config_dir() -> Option<std::path::PathBuf> {
    crate::config::Config::path()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
}

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

pub fn socket_path() -> Option<std::path::PathBuf> {
    SessionIdentity::current().map(|id| id.socket)
}

fn fits_a_unix_socket(path: &str) -> bool {
    path.len() <= 100
}

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

fn session_target(name: &str) -> String {
    format!("={name}")
}

fn pane_target(name: &str) -> String {
    format!("={name}:")
}

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

/// Which incarnation of the session named `name` is running, as an opaque
/// string that is equal only to itself.
///
/// A master pane's name is derived from the project slug, so every incarnation
/// of it carries the same name and a name alone identifies nothing. Anything
/// recorded ABOUT a pane — a verdict on the capability it holds, say — has to
/// be able to tell the pane it was recorded about from the one that took its
/// name afterwards, or an operator who has just replaced a pane is shown the
/// verdict that made them replace it (ISS-1099).
///
/// Three parts, because no one of them is an identity. `session_created` is
/// whole seconds, so a pane replaced inside one second reads as the pane it
/// replaced. `session_id` is unique within a server's life and never reused,
/// but it restarts at `$0` when the server does — and the pane does not have to
/// survive that for the confusion to bite, because the VERDICT does: a server
/// killed and restarted inside one second yields `<same second>:$0` twice over,
/// measured. The server's own pid separates those, and a pid reused inside one
/// second by a kernel that has just handed it out is not a case this reaches.
///
/// `None` where tmux cannot be asked, or the session is gone, or it answers
/// something empty. None of those is "it has just started", so a caller that
/// cannot get this answer says so rather than assuming either way.
pub async fn incarnation(name: &str) -> Option<String> {
    // `pane_target` and not `session_target`: `display-message -t` takes a PANE
    // target, and an exact session name with no `:` after it resolves to no
    // pane. tmux answers that with an empty line and exit 0 rather than an
    // error, so the wrong target here fails as "this box cannot ask tmux" on
    // every pane forever, and says nothing about why.
    let target = pane_target(name);
    let out = tmux(&[
        "display-message",
        "-p",
        "-t",
        &target,
        "#{session_created}:#{session_id}:#{pid}",
    ])
    .await
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let said = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // A target tmux cannot resolve is answered with exit 0 and the fields left
    // empty — and `#{pid}` is the SERVER's, so a session that is gone on a
    // server that is up still answers `::1636537`. Compared against the same
    // shape for another dead pane, that says two different panes are one, which
    // is the whole thing this exists to prevent. The session's own two fields
    // have to be there or there is no answer.
    let mut parts = said.splitn(3, ':');
    let created = parts.next().unwrap_or_default();
    let session = parts.next().unwrap_or_default();
    if created.is_empty() || session.is_empty() {
        return None;
    }
    Some(said)
}

const SESSION_UNIT: &str = "forge-sessions";

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

const KEEPALIVE: &str = "forge-session-host";

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

enum Placement {
    Accepted,
    Unavailable(String),
}

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

async fn server_answers() -> bool {
    tmux(&["list-sessions"])
        .await
        .is_ok_and(|o| o.status.success())
}

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

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub const PANE_BRIEF_DELAY: Duration = Duration::from_secs(5);

pub async fn brief_new_pane(name: &str, text: &str) -> Result<()> {
    if !alive(name).await {
        return Err(Error::Other(format!("no session named {name}")));
    }
    tokio::time::sleep(PANE_BRIEF_DELAY).await;
    send_line(name, text).await.map(|_| ())
}

/// What `send_line` knew about the prompt it typed at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prompt {
    /// A Claude Code composer, read empty before the paste.
    Empty,
    /// No Claude Code composer could be read, so nothing confirmed the prompt
    /// was empty. The text was typed anyway, as it always was before a pane
    /// could be read. A choice list is no longer one of these: it is refused
    /// before the paste and so never reaches a `Prompt` at all.
    Unread,
}

/// How much scrollback the prompt read takes, so a draft taller than the
/// pane is still read from its first line.
const PROMPT_READ_LINES: &str = "-500";

async fn read_prompt(target: &str) -> composer::Composer {
    let args = [
        "capture-pane",
        "-p",
        "-e",
        "-S",
        PROMPT_READ_LINES,
        "-t",
        target,
    ];
    match tmux(&args).await {
        Ok(out) if out.status.success() => composer::read(&String::from_utf8_lossy(&out.stdout)),
        _ => composer::Composer::Unrecognised,
    }
}

/// Type `text` into a pane and submit it.
///
/// Enter submits the whole composer, so a composer already holding text is
/// refused, quoting it: typing there would send that text as part of this one.
/// A pane showing a choice list is refused for the mirror reason: there Enter
/// is a decision on the highlighted option and the pasted text is dropped, so
/// a message that cannot be delivered is said not to have been (ISS-1266).
/// The read comes a few milliseconds before the paste, and tmux has no lock
/// over a pane's input, so a keystroke landing in between is not seen.
pub async fn send_line(name: &str, text: &str) -> Result<Prompt> {
    if !alive(name).await {
        return Err(Error::Other(format!("no session named {name}")));
    }
    let target = pane_target(name);
    let prompt = match read_prompt(&target).await {
        composer::Composer::Empty => Prompt::Empty,
        composer::Composer::Holds(found) => {
            return Err(Error::Other(format!(
                "{name}: nothing was typed — its prompt already holds unsent text, and Enter \
would submit that text as part of this message. At the prompt: \u{ab}{}\u{bb}. Clear it or \
submit it at the pane, then send again.",
                composer::excerpt(&found, 400)
            )));
        }
        composer::Composer::Menu { highlighted } => {
            return Err(Error::Other(format!(
                "{name}: nothing was typed — its pane is showing a choice list with \u{ab}{}\u{bb} \
highlighted, and Enter there decides that choice instead of sending a message. Answer it at the \
pane, or wait for whatever raised it to close, then send again.",
                composer::excerpt(&highlighted, 200)
            )));
        }
        composer::Composer::Unrecognised => {
            tracing::warn!(
                "[terminal] {name}: no Claude Code composer could be read on this pane, so \
nothing confirmed its prompt was empty before typing"
            );
            Prompt::Unread
        }
    };
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
    Ok(prompt)
}

/// End a session by name, and answer for the session being gone.
///
/// Absent is success — the caller wanted it gone, and tmux exits non-zero for
/// a name it cannot find just as it does for a kill that did not take. Only
/// the server can tell those two apart, so where tmux refuses, this asks it.
///
/// The status used to be discarded, which made every caller's failure branch
/// dead code. `daemon/master.rs` then read the `Ok` as proof a deaf master was
/// gone: it recorded a replacement, minted a capability for the session core
/// now serves, and so destroyed the stale verdict that was the only sign the
/// pane was still there and still refusing every declaration it made
/// (ISS-1208). A kill this box did not manage is a thing the box has to be
/// able to say.
pub async fn kill(name: &str) -> Result<()> {
    let target = session_target(name);
    let refused = match tmux(&["kill-session", "-t", &target]).await {
        Ok(out) if out.status.success() => return Ok(()),
        Ok(out) => String::from_utf8_lossy(&out.stderr).trim().to_string(),
        Err(e) => e.to_string(),
    };
    match still_there(name).await {
        Ok(false) => Ok(()),
        Ok(true) => Err(Error::Other(format!("tmux kill-session {name}: {refused}"))),
        Err(e) => Err(Error::Other(format!(
            "tmux kill-session {name}: {refused}, and whether it is still there could not be established: {e}"
        ))),
    }
}

/// Whether tmux holds a session by this name, with `could not ask` kept apart
/// from `no`.
///
/// [`alive`] answers a `bool` and collapses the two, which is right for the
/// callers asking whether to bother doing something. It is wrong for a
/// postcondition: a probe that could not run, read as `absent`, is a kill this
/// box reports as taken on the strength of a question nobody answered — the
/// same shape as the discarded status this whole path exists to stop
/// (ISS-1208).
///
/// A server that is not running is `Ok(false)`, not an error: no server holds
/// no sessions, which is the outcome the caller wanted. `Err` is this box
/// failing to run tmux at all.
async fn still_there(name: &str) -> Result<bool> {
    let target = session_target(name);
    Ok(tmux(&["has-session", "-t", &target])
        .await?
        .status
        .success())
}

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

pub fn pane_env() -> Vec<(String, String)> {
    match crate::runner::process::mcp_tool_timeout_default(
        std::env::var_os("MCP_TOOL_TIMEOUT").as_deref(),
    ) {
        Some(v) => vec![("MCP_TOOL_TIMEOUT".into(), v.into())],
        None => Vec::new(),
    }
}

/// What another module's tests need from this one: the tmux boundary, driven
/// to states a passing box does not reach on its own.
///
/// Here rather than inside `mod tests` because the states below belong to this
/// module's transport and the rules they break are `daemon/master.rs`'s. A
/// second copy over there would be a second thing to keep true.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use crate::auth::cred_store::ScopedVar;

    /// Every test that reaches a tmux server takes this first.
    ///
    /// They share one server per config dir and they move process-wide
    /// environment to choose it, so two at once are one test watching another
    /// one's pane.
    pub(crate) static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Set by a test run that installed tmux and can give a test a server of
    /// its own — CI's Linux leg. There, a tmux-reaching test that cannot run
    /// has lost its subject, and returning would pass it green having
    /// asserted nothing.
    pub(crate) const REQUIRE_TMUX: &str = "FORGE_TEST_REQUIRE_TMUX";

    /// Why a tmux-reaching test is not running. Under [`REQUIRE_TMUX`] that is
    /// a failure naming `why`; anywhere else it is printed, and the caller
    /// returns.
    pub(crate) fn cannot_run(why: &str) {
        if std::env::var_os(REQUIRE_TMUX).is_some_and(|v| !v.is_empty()) {
            panic!(
                "{why} — and {REQUIRE_TMUX} is set, so this run promised tmux and a server of this test's own; returning here would pass the test without running it"
            );
        }
        eprintln!("{why}");
    }

    /// A tmux server of this test's own, addressed the way production
    /// addresses the box's: through the config dir.
    ///
    /// The socket is `<XDG_CONFIG_HOME>/forge-runner/tmux.sock`, so pointing
    /// that variable somewhere empty is the whole isolation — and it is what
    /// keeps a test off the server this box's live masters are running on.
    pub(crate) struct IsolatedServer {
        _xdg: ScopedVar,
        dir: crate::test_scratch::Scratch,
    }

    impl IsolatedServer {
        pub(crate) fn new(label: &str) -> Self {
            // `short`: the socket is `<dir>/forge-runner/tmux.sock`, and a path past the 100-byte
            // limit resolves no socket at all, which would send tmux to the box's own server.
            let dir = crate::test_scratch::Scratch::short(&format!("iso-{label}"));
            std::fs::create_dir_all(dir.join("forge-runner")).expect("isolated config dir");
            let xdg = ScopedVar::set("XDG_CONFIG_HOME", &dir);
            Self { _xdg: xdg, dir }
        }

        /// Whether the isolation took.
        ///
        /// `XDG_CONFIG_HOME` steers the config dir, and so the socket, only
        /// where this box resolves one from it. Where it does not, the server
        /// a test would reach is the box's own — which on this machine is the
        /// one four live masters are running on — so a caller that gets
        /// `false` runs nothing rather than running it there.
        pub(crate) fn took(&self) -> bool {
            socket_path().is_some_and(|sock| sock.starts_with(&self.dir))
        }
    }

    impl Drop for IsolatedServer {
        fn drop(&mut self) {
            if let Some(sock) = socket_path() {
                if sock.starts_with(&self.dir) {
                    let _ = std::process::Command::new("tmux")
                        .args(["-S", &sock.to_string_lossy(), "kill-server"])
                        .stdin(std::process::Stdio::null())
                        .output();
                }
            }
        }
    }

    /// A tmux this box cannot run at all: every call comes back as a spawn
    /// error rather than as an answer.
    ///
    /// The state `alive` cannot represent. It answers `false` here, and a
    /// postcondition reading that as `the session is gone` reports a kill on
    /// the strength of a question nobody answered.
    pub(crate) struct UnaskableTmux {
        _path: ScopedVar,
        _dir: crate::test_scratch::Scratch,
    }

    impl UnaskableTmux {
        pub(crate) fn installed() -> Self {
            let dir = crate::test_scratch::Scratch::new("unaskable");
            // An empty PATH, so the spawn fails rather than the command
            // answering something. `available()` was resolved at startup and
            // is cached, which is the production shape of this: tmux was there
            // when the daemon started and cannot be run now.
            Self {
                _path: ScopedVar::set("PATH", &dir),
                _dir: dir,
            }
        }
    }

    /// A tmux that refuses `kill-session` and answers every other verb from the
    /// real server, for the one window `kill`'s postcondition is about.
    ///
    /// A shim rather than a stub of our own code: what `kill` reads is a tmux
    /// process's exit status and, after it, a real `has-session`. Driving those
    /// two to the pair tmux itself produces — `kill-session` exits 1, the
    /// session is still there — is the fault, not a model of it.
    pub(crate) struct RefusingKill {
        _path: ScopedVar,
        _dir: crate::test_scratch::Scratch,
    }

    impl RefusingKill {
        pub(crate) fn installed() -> Self {
            let real = which::which("tmux").expect("a real tmux to pass everything else to");
            let dir = crate::test_scratch::Scratch::new("refuse");
            let shim = dir.join("tmux");
            std::fs::write(
            &shim,
            format!(
                "#!/bin/sh\nfor a in \"$@\"; do\n  case \"$a\" in\n    -*) ;;\n    kill-session) echo 'refused' >&2; exit 1 ;;\n    *) ;;\n  esac\ndone\nexec {} \"$@\"\n",
                shim_quote(&real.to_string_lossy())
            ),
        )
        .expect("shim");
            #[cfg(unix)]
            {
                let mut perms = std::fs::metadata(&shim).expect("shim mode").permissions();
                std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
                std::fs::set_permissions(&shim, perms).expect("shim executable");
            }
            let ahead = match std::env::var_os("PATH") {
                Some(p) => format!("{}:{}", dir.to_string_lossy(), p.to_string_lossy()),
                None => dir.to_string_lossy().into_owned(),
            };
            Self {
                _path: ScopedVar::set("PATH", ahead),
                _dir: dir,
            }
        }
    }

    pub(crate) fn shim_quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{cannot_run, RefusingKill, UnaskableTmux, ONE_AT_A_TIME};
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

    struct ConfigHome(crate::test_scratch::Scratch);

    impl ConfigHome {
        fn new(label: &str) -> Self {
            // `short` for the reason `IsolatedServer::new` gives: the socket lives under it.
            let dir = crate::test_scratch::Scratch::short(label);
            std::fs::create_dir_all(dir.join("forge-runner")).expect("temp config dir");
            Self(dir)
        }

        fn path(&self) -> &std::path::Path {
            self.0.path()
        }
    }

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

    struct Sandbox {
        _placed: Option<PlacedUnit>,
        _xdg: ScopedVar,
        _home: ConfigHome,
    }

    impl Sandbox {
        /// `None` where this box cannot give the test a tmux server of its own.
        fn new(label: &str) -> Option<Self> {
            let home = ConfigHome::new(label);
            let xdg = ScopedVar::set("XDG_CONFIG_HOME", home.path());
            // A socket that does not resolve under this home means every tmux call after this
            // one reaches the box's own server, where live masters run. Off Linux the variable
            // steers nothing, so that is the platform's answer and not a fault: the caller is
            // told, and runs no tmux at all.
            let sock = socket_path().filter(|sock| sock.starts_with(home.path()))?;
            let placed = Some(PlacedUnit::guarding(session_unit(), sock));
            Some(Self {
                _placed: placed,
                _xdg: xdg,
                _home: home,
            })
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

    /// A run that promised tmux turns a skip into a failure naming both the
    /// reason and the promise; one that did not prints it and returns, which
    /// is what a developer box without tmux still gets.
    #[test]
    fn a_skip_is_a_failure_only_where_the_run_promised_tmux() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        {
            let _promised = ScopedVar::set(super::testing::REQUIRE_TMUX, "1");
            let failed = std::panic::catch_unwind(|| cannot_run("tmux is not installed here"))
                .expect_err("a promised tmux that is absent must fail the test");
            let said = failed.downcast_ref::<String>().cloned().unwrap_or_default();
            assert!(
                said.contains("tmux is not installed here")
                    && said.contains(super::testing::REQUIRE_TMUX),
                "the failure names what was missing and what promised it: {said}"
            );
        }
        {
            let _unpromised = ScopedVar::unset(super::testing::REQUIRE_TMUX);
            cannot_run("tmux is not installed here");
        }
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

    /// `incarnation` is the only thing that tells one incarnation of a master
    /// pane from the next, because the name comes from the project slug and
    /// every incarnation carries it. It is proved against tmux and not against
    /// a shape, twice over: the first version asked `display-message` for a
    /// SESSION target, which tmux answers with an empty line and exit 0, so it
    /// returned `None` for every live pane on every box and said nothing about
    /// why; the second read only `session_created`, whole seconds, so a pane
    /// replaced inside one second read as the pane it replaced; and the third
    /// added the session id, which restarts at `$0` with the server, so a
    /// server killed and restarted inside one second answered the same twice.
    /// No assertion over the source could have seen any of the three.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_pane_and_its_same_second_replacement_are_told_apart() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(_sandbox) = Sandbox::new("incarnation") else {
            cannot_run("this box gives a test no tmux server of its own — nothing runs rather than reaching its real one");
            return;
        };
        if !available() {
            cannot_run("tmux is not installed here — the transport test cannot run");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("terminal-inc");
        let name = session_name("forge-test", &format!("inc{}", std::process::id()));
        let sleep = ["sleep".to_string(), "60".to_string()];
        let _ = kill(&name).await;

        assert_eq!(
            incarnation(&name).await,
            None,
            "a session that does not exist has no incarnation, and answering one would identify a pane nothing placed"
        );

        ensure(&name, &dir, &sleep, &[], None)
            .await
            .expect("the session must start");
        let first = incarnation(&name)
            .await
            .expect("a live pane has an incarnation and tmux is the only thing that knows it");
        assert!(
            !first.is_empty() && first != ":",
            "an empty answer compared against another empty answer calls two panes one: {first:?}"
        );
        assert_eq!(
            incarnation(&name).await,
            Some(first.clone()),
            "the same pane answers the same twice, or the comparison this exists for reports a replacement on every sweep"
        );

        // Replaced as fast as this box can do it, which is the case a
        // whole-second creation time cannot see.
        kill(&name).await.expect("kill is infallible");
        ensure(&name, &dir, &sleep, &[], None)
            .await
            .expect("the replacement must start");
        let second = incarnation(&name)
            .await
            .expect("the replacement is live and has its own incarnation");
        assert_ne!(
            first, second,
            "a replacement under the same name inside one second must not read as the pane it replaced — that is what would tell an operator their new master has been refused for four hours"
        );

        // And the same again with the tmux server itself restarted, which is
        // what resets the session id to `$0`: the pane does not have to survive
        // for the confusion to bite, because the verdict recorded about it does.
        let _ = tmux(&["kill-server"]).await;
        ensure(&name, &dir, &sleep, &[], None)
            .await
            .expect("the session must start on a server of its own");
        let third = incarnation(&name)
            .await
            .expect("the pane on the restarted server has an incarnation too");
        assert!(
            third != first && third != second,
            "a restarted server hands out `$0` again inside the same second — measured — so an answer that cannot see past it reads two different panes as one: {first} / {second} / {third}"
        );

        kill(&name).await.expect("kill is infallible");
        assert_eq!(
            incarnation(&name).await,
            None,
            "and a pane that has been ended stops answering, rather than keeping what it had"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The window everything above `kill` rests on, forced rather than argued.
    ///
    /// `kill` was `let _ = tmux(["kill-session", ..]).await; Ok(())`, so a kill
    /// that did not take answered exactly as one that did. `end_deaf_pane` then
    /// read that `Ok` as proof the pane was gone, the box wrote a replacement
    /// down, minted a capability for the session core now serves, and the stale
    /// verdict that was the only sign of the fault never fired again — the
    /// alarm removed by the change that exists to make it louder (ISS-1208,
    /// criterion 7).
    ///
    /// tmux does report it: `kill-session` exits 1 while `has-session` on the
    /// same name still exits 0. That status was the one being discarded.
    #[cfg(unix)]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_kill_tmux_refused_is_never_answered_as_one_that_took() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(_sandbox) = Sandbox::new("kill-refused") else {
            cannot_run("this box gives a test no tmux server of its own — nothing runs rather than reaching its real one");
            return;
        };
        if !available() {
            cannot_run("tmux is not installed here — the transport test cannot run");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("terminal-kr");
        let name = session_name("forge-test", &format!("kr{}", std::process::id()));
        let sleep = ["sleep".to_string(), "60".to_string()];
        let _ = kill(&name).await;
        ensure(&name, &dir, &sleep, &[], None)
            .await
            .expect("the session must start");

        {
            let _refusing = RefusingKill::installed();
            let said = kill(&name).await;
            assert!(
                alive(&name).await,
                "the plant is only the plant while the session is still there: a kill that actually took proves nothing about a kill that did not"
            );
            assert!(
                said.is_err(),
                "tmux refused the kill and the session is still running; answering Ok here is what lets the box write down a replacement it never made, and then mint over the only evidence that it had not"
            );
        }

        {
            // And the state a `bool` cannot hold: not `the session is gone`,
            // but `this box could not ask`. Raised as F1 on the review of
            // ba415f04f.
            let _unaskable = UnaskableTmux::installed();
            assert!(
                !alive(&name).await,
                "this is the collapse the postcondition may not rest on: `alive` answers false for a probe that never ran, exactly as it does for a session that is gone"
            );
            assert!(
                kill(&name).await.is_err(),
                "a kill whose outcome could not be established is not a kill that took, and answering Ok here reports one on the strength of a question nobody answered"
            );
        }

        // And the two answers that must stay success, or a box that cannot end
        // a pane it has proved deaf stops ending the ones it can.
        kill(&name).await.expect("a kill tmux took is success");
        assert!(
            !alive(&name).await,
            "the session is gone once the kill took"
        );
        kill(&name)
            .await
            .expect("a session that is already absent is the outcome the caller asked for");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_pane_receives_what_is_typed_at_it_and_the_transcript_keeps_it() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(_sandbox) = Sandbox::new("panes") else {
            cannot_run("this box gives a test no tmux server of its own — nothing runs rather than reaching its real one");
            return;
        };
        if !available() {
            cannot_run("tmux is not installed here — the transport test cannot run");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("terminal");
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

        assert_eq!(
            send_line(&name, "first line\nsecond line")
                .await
                .expect("the paste must land"),
            Prompt::Unread,
            "a plain shell shows no composer, so the typing must say nothing confirmed it empty"
        );

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

    /// A pane drawn the way Claude Code draws its composer: a rule, `❯` and the
    /// draft, a rule, a footer. Each character typed joins the draft, and Enter
    /// appends the whole draft to `$OUT` as one submission.
    const FAKE_COMPOSER: &str = r#"R='────────────────'
buf=''
draw() { printf '\033[2J\033[H%s\n\342\235\257\302\240%s\n%s\n  footer\n' "$R" "$buf" "$R"; }
draw
while IFS= read -r -n1 c; do
  if [ -z "$c" ]; then printf '%s\n' "$buf" >> "$OUT"; buf=''; else buf="$buf$c"; fi
  draw
done
"#;

    async fn composer_pane(dir: &std::path::Path, tag: &str) -> (String, std::path::PathBuf) {
        let script = dir.join("composer.sh");
        std::fs::write(&script, FAKE_COMPOSER).expect("the fake composer is written");
        let out = dir.join(format!("{tag}.submitted"));
        let name = session_name("forge-test", &format!("{tag}{}", std::process::id()));
        let _ = kill(&name).await;
        ensure(
            &name,
            dir,
            &["bash".to_string(), script.to_string_lossy().into_owned()],
            &[("OUT".into(), out.to_string_lossy().into_owned())],
            None,
        )
        .await
        .expect("the composer pane must start");
        (name, out)
    }

    async fn composer_reads(name: &str, want: &composer::Composer) -> composer::Composer {
        let mut seen = composer::Composer::Unrecognised;
        for _ in 0..40 {
            seen = read_prompt(&pane_target(name)).await;
            if &seen == want {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        seen
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn text_left_at_the_prompt_is_refused_by_name_and_never_submitted_with_the_message() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(_sandbox) = Sandbox::new("dirty") else {
            cannot_run("this box gives a test no tmux server of its own — nothing runs rather than reaching its real one");
            return;
        };
        if !available() {
            cannot_run("tmux is not installed here — the transport test cannot run");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("composer");
        let (name, out) = composer_pane(&dir, "dirty").await;
        assert_eq!(
            composer_reads(&name, &composer::Composer::Empty).await,
            composer::Composer::Empty,
            "the fake must draw an empty composer before anything is typed"
        );

        // The issue's reproduction: text sits unsent at the prompt, then a message is sent.
        let typed = tmux(&[
            "send-keys",
            "-t",
            &pane_target(&name),
            "-l",
            "LEFTOVER-FROM-SOMEWHERE-ELSE ",
        ])
        .await
        .expect("tmux runs");
        assert!(typed.status.success(), "the leftover must be typed");
        let leftover = composer::Composer::Holds("LEFTOVER-FROM-SOMEWHERE-ELSE".into());
        assert_eq!(composer_reads(&name, &leftover).await, leftover);

        let refused = send_line(&name, "MY-ORCHESTRATOR-MESSAGE")
            .await
            .expect_err("a composer holding text must refuse the send");
        let said = refused.to_string();
        assert!(
            said.contains("LEFTOVER-FROM-SOMEWHERE-ELSE"),
            "the refusal must quote what was at the prompt: {said}"
        );
        assert!(
            said.contains("nothing was typed"),
            "the refusal must say nothing was typed: {said}"
        );

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert_eq!(
            read_prompt(&pane_target(&name)).await,
            leftover,
            "the draft must be left exactly as it was"
        );
        assert!(
            std::fs::read_to_string(&out).unwrap_or_default().is_empty(),
            "nothing may be submitted: {:?}",
            std::fs::read_to_string(&out)
        );
        kill(&name).await.expect("kill");

        let (name, out) = composer_pane(&dir, "clean").await;
        assert_eq!(
            composer_reads(&name, &composer::Composer::Empty).await,
            composer::Composer::Empty
        );
        assert_eq!(
            send_line(&name, "MY-ORCHESTRATOR-MESSAGE")
                .await
                .expect("an empty composer takes the message"),
            Prompt::Empty
        );
        let mut submitted = String::new();
        for _ in 0..40 {
            submitted = std::fs::read_to_string(&out).unwrap_or_default();
            if !submitted.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(
            submitted, "MY-ORCHESTRATOR-MESSAGE\n",
            "an empty composer submits exactly what the caller passed"
        );
        kill(&name).await.expect("kill");
    }

    /// A pane drawn the way Claude Code draws a choice list, recording every
    /// key it is sent — Enter as `ENTER`, anything else as `KEY <c>`. The log
    /// is what makes "no Enter was pressed" observable on its own: a refusal
    /// that sent Enter and no text would leave it holding one line.
    const FAKE_MENU: &str = r#"draw() { printf '\033[2J\033[H Do you want to proceed?\n \342\235\257 1. Yes\n   2. No\n\n Esc to cancel\n'; }
draw
while IFS= read -r -n1 c; do
  if [ -z "$c" ]; then printf 'ENTER\n' >> "$OUT"; else printf 'KEY %s\n' "$c" >> "$OUT"; fi
  draw
done
"#;

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_pane_showing_a_choice_list_is_refused_and_is_sent_no_key_at_all() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(_sandbox) = Sandbox::new("menu") else {
            cannot_run("this box gives a test no tmux server of its own — nothing runs rather than reaching its real one");
            return;
        };
        if !available() {
            cannot_run("tmux is not installed here — the transport test cannot run");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("menu");
        let script = dir.join("menu.sh");
        std::fs::write(&script, FAKE_MENU).expect("the fake menu is written");
        let keys = dir.join("menu.keys");
        let name = session_name("forge-test", &format!("menu{}", std::process::id()));
        let _ = kill(&name).await;
        ensure(
            &name,
            &dir,
            &["bash".to_string(), script.to_string_lossy().into_owned()],
            &[("OUT".into(), keys.to_string_lossy().into_owned())],
            None,
        )
        .await
        .expect("the menu pane must start");

        let menu = composer::Composer::Menu {
            highlighted: "1. Yes".into(),
        };
        assert_eq!(
            composer_reads(&name, &menu).await,
            menu,
            "the fake must draw a choice list before anything is sent"
        );

        let refused = send_line(&name, "MY-ORCHESTRATOR-MESSAGE")
            .await
            .expect_err("a pane showing a choice list must refuse the send");
        let said = refused.to_string();
        assert!(
            said.contains("1. Yes"),
            "the refusal must quote the highlighted choice: {said}"
        );
        assert!(
            said.contains("nothing was typed"),
            "the refusal must say nothing was typed: {said}"
        );

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert_eq!(
            std::fs::read_to_string(&keys).unwrap_or_default(),
            "",
            "no key may reach a pane showing a choice list — an Enter alone would read as ENTER here"
        );
        assert_eq!(
            read_prompt(&pane_target(&name)).await,
            menu,
            "the choice list must be left exactly as it was"
        );
        kill(&name).await.expect("kill");
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_restart_re_enters_the_pane_it_left_rather_than_starting_a_second_one() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(_sandbox) = Sandbox::new("panes") else {
            cannot_run("this box gives a test no tmux server of its own — nothing runs rather than reaching its real one");
            return;
        };
        if !available() {
            cannot_run("tmux is not installed here — the residency test cannot run");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("resident");
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

    #[tokio::test]
    #[ignore]
    async fn a_killed_pane_is_rebuilt_on_the_conversation_it_had() {
        let root = crate::test_scratch::Scratch::new("iss1050-step19");
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
    // cm:guard this is the amnesty's price made checkable. `#[allow(clippy::await_holding_lock)]` is sound only while these tests run on a current-thread runtime with no other task to starve; the day one of them takes `flavor = "multi_thread"`, the allow is hiding a real hazard and this goes red instead of the hazard being found by a hung suite.
    // cm:guard the needle is SPLIT across `concat!` for the same reason the systemd scan's are: written whole, this test matches its own source and fails on a file that has not drifted at all.
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

    #[cfg(all(unix, target_os = "linux"))]
    #[test]
    fn two_config_dirs_differing_only_in_invalid_utf8_get_different_units() {
        use std::os::unix::ffi::OsStringExt as _;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        // Rooted in a scratch dir rather than at a literal `/tmp` path: resolving a socket creates
        // the config dir, and a literal path is one no drop ever removes.
        let bytes_home = crate::test_scratch::Scratch::short("bytes");
        let mut units = Vec::new();
        let mut sockets = Vec::new();
        for tail in [b"\xf0".to_vec(), b"\xf1".to_vec()] {
            let mut raw = bytes_home.join("config-").into_os_string().into_vec();
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

    #[test]
    fn the_unoverridden_dir_is_what_the_box_resolves_with_no_override() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _xdg = ScopedVar::unset("XDG_CONFIG_HOME");
        assert_eq!(session_config_dir(), unoverridden_config_dir());
    }

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
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_cold_start_hit_by_several_panes_at_once_places_one_server_and_loses_no_pane() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if !available() {
            cannot_run("tmux is not installed here — the placement test cannot run");
            return;
        }
        if !can_place_a_unit().await {
            eprintln!(
                "no systemd user manager here — the placement property does not exist on this box"
            );
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

        let dir = crate::test_scratch::Scratch::new("race");
        let names: Vec<String> = (0..4)
            .map(|i| session_name("forge-test", &format!("race{}-{i}", std::process::id())))
            .collect();
        for n in &names {
            let _ = kill(n).await;
        }
        futures_util::future::join_all(names.iter().map(|n| {
            let dir = dir.to_path_buf();
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
