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

use crate::config::{is_the_boxs_own_config_dir, resolved};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::process::Command;

use super::composer;
use crate::error::{Error, Result};

pub const MASTER_PREFIX: &str = "forge-master";

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

/// The one place a tmux process is built, so a test build can hand the
/// transport a tmux of its own without moving the process's `PATH`, which
/// every other test's spawn by bare name resolves through (ISS-1312). The test
/// build's twin is `testing::tmux_command`.
fn tmux_command() -> Command {
    Command::new("tmux")
}

async fn tmux(args: &[&str]) -> Result<std::process::Output> {
    let mut all = socket_args();
    all.extend(args.iter().map(|a| (*a).to_string()));
    tmux_command()
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

/// What tmux answered when it was asked whether it holds a session.
///
/// `has-session` exits non-zero for two different facts and says which in its
/// own words on stderr: a session this server does not hold, and a question it
/// could not answer at all. [`alive`] folds both into `false`, which is right
/// for a caller deciding whether to bother doing something and wrong for one
/// about to tell core that a session ended — only the middle value here is an
/// ending, and reporting the last one as an ending invents the answer
/// (`VISION: state-never-lies`, ISS-1265).
///
/// This is not [`still_there`], which answers `kill`'s postcondition: there a
/// server that is not running IS the outcome the caller wanted, and here it is
/// a socket this box may simply be looking at the wrong one of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Presence {
    Present,
    Absent,
    Unaskable,
}

/// tmux's own wording for a session it does not hold. Anything else it says is
/// something this code has not been taught to read, and an unread answer is
/// not an ending.
const NO_SUCH_SESSION: [&str; 2] = ["can't find session", "session not found"];

async fn has_session(name: &str) -> Presence {
    let target = session_target(name);
    let out = match tmux(&["has-session", "-t", &target]).await {
        Ok(out) => out,
        Err(e) => {
            tracing::warn!(
                "[terminal] {name}: tmux could not be run to ask whether this session is there ({e}), so nothing here says it ended"
            );
            return Presence::Unaskable;
        }
    };
    if out.status.success() {
        return Presence::Present;
    }
    let said = String::from_utf8_lossy(&out.stderr);
    let lower = said.to_lowercase();
    if NO_SUCH_SESSION
        .iter()
        .any(|wording| lower.contains(wording))
    {
        return Presence::Absent;
    }
    tracing::warn!(
        "[terminal] {name}: tmux answered `has-session` with \u{ab}{}\u{bb}, which is not its wording for a session it does not hold, so this box has not established that the session ended",
        said.trim()
    );
    Presence::Unaskable
}

pub async fn alive(name: &str) -> bool {
    has_session(name).await == Presence::Present
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
    if is_the_boxs_own_config_dir(dir) {
        return SESSION_UNIT.to_string();
    }
    let dir = resolved(dir);
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
    send_line(name, text).await.map(|_| ()).map_err(Error::from)
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

/// Why `send_line` typed nothing, for a caller whose answer to the world turns
/// on which of these it was.
///
/// Every one of these used to be an `Error::Other(String)`, and
/// `daemon/inbox.rs` folded all of them into one bit and told core `gone` —
/// the ack minted for a session that ended — about a pane it had just read
/// alive (ISS-1265). The sentences are unchanged; what is new is that a caller
/// can tell them apart without reading them, which is the same reason
/// `Error::Unauthorized` is a variant rather than a string.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NotTyped {
    /// tmux answered, in its own words, that it holds no session by this name.
    /// The only one of the three that is a session having ended.
    #[error("no session named {0}")]
    Gone(String),
    /// The pane answered alive and was read, and what is drawn on it refuses
    /// the message: a draft at the composer, or a choice list.
    #[error("{0}")]
    Refused(String),
    /// tmux could not be asked whether the session is there, or one of the
    /// calls that type the message broke. Neither establishes an ending.
    #[error("{0}")]
    Failed(String),
}

impl From<NotTyped> for Error {
    fn from(why: NotTyped) -> Self {
        Error::Other(why.to_string())
    }
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
pub async fn send_line(name: &str, text: &str) -> std::result::Result<Prompt, NotTyped> {
    match has_session(name).await {
        Presence::Present => {}
        Presence::Absent => return Err(NotTyped::Gone(name.to_string())),
        Presence::Unaskable => {
            return Err(NotTyped::Failed(format!(
                "{name}: nothing was typed — tmux could not be asked whether this session is there, so whether it is running is unknown rather than settled. Ask again once tmux answers."
            )))
        }
    }
    let target = pane_target(name);
    let prompt = match read_prompt(&target).await {
        composer::Composer::Empty => Prompt::Empty,
        composer::Composer::Holds(found) => {
            return Err(NotTyped::Refused(format!(
                "{name}: nothing was typed — its prompt already holds unsent text, and Enter \
would submit that text as part of this message. At the prompt: \u{ab}{}\u{bb}. Clear it or \
submit it at the pane, then send again.",
                composer::excerpt(&found, 400)
            )));
        }
        composer::Composer::Menu { highlighted } => {
            return Err(NotTyped::Refused(format!(
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
    let mut child = tmux_command()
        .args(&load)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| NotTyped::Failed(format!("tmux load-buffer: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|e| NotTyped::Failed(format!("tmux load-buffer write: {e}")))?;
        let _ = stdin.shutdown().await;
    }
    let status = child
        .wait()
        .await
        .map_err(|e| NotTyped::Failed(format!("tmux load-buffer: {e}")))?;
    if !status.success() {
        return Err(NotTyped::Failed(format!(
            "tmux load-buffer {name}: {status}"
        )));
    }

    let out = tmux(&["paste-buffer", "-p", "-d", "-b", &buffer, "-t", &target])
        .await
        .map_err(|e| NotTyped::Failed(e.to_string()))?;
    if !out.status.success() {
        return Err(NotTyped::Failed(format!(
            "tmux paste-buffer {name}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    let out = tmux(&["send-keys", "-t", &target, "Enter"])
        .await
        .map_err(|e| NotTyped::Failed(e.to_string()))?;
    if !out.status.success() {
        return Err(NotTyped::Failed(format!(
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
    job_argv(mcp_config, resume, None, &[])
}

/// [`pane_argv`] for a job: the model and the tools its policy state names.
///
/// Each denied pattern is its own argument: a pattern may hold a space (`Bash(git push:*)`), and a
/// list joined into one argument would be split by the CLI where the policy wrote one entry.
// cm:edge contract -> packages/core/src/project-config/schema.ts:TOOL_PATTERN — every entry core
// hands here passed that grammar, which is the one `--disallowed-tools` reads; `--disallowed-tools`
// narrows the tool SET even under `bypassPermissions` (claude_code.rs says where that was verified).
pub fn job_argv(
    mcp_config: Option<&std::path::Path>,
    resume: Option<&str>,
    model: Option<&str>,
    denied_tools: &[String],
) -> Vec<String> {
    let bin = shell_quote(crate::runner::process::resolve_claude_bin());
    let mut line = format!("unset CLAUDECODE; exec {bin} --permission-mode bypassPermissions");
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        line.push_str(&format!(" --model {}", shell_quote(model)));
    }
    if !denied_tools.is_empty() {
        line.push_str(" --disallowed-tools");
        for tool in denied_tools {
            line.push_str(&format!(" {}", shell_quote(tool)));
        }
    }
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
    pane_env_from(|k| std::env::var_os(k))
}

// cm:guard a pane's `forge-runner hook|gate|run` finds its daemon through the config dir; the
// session server's unit inherits none of this process's environment, so a daemon run under its
// own `XDG_CONFIG_HOME` hands it on or its panes report to the box's default daemon (ISS-10)
fn pane_env_from(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(v) =
        crate::runner::process::mcp_tool_timeout_default(var("MCP_TOOL_TIMEOUT").as_deref())
    {
        env.push(("MCP_TOOL_TIMEOUT".into(), v.into()));
    }
    if let Some(x) = var("XDG_CONFIG_HOME") {
        if std::path::Path::new(&x).is_absolute() {
            env.push(("XDG_CONFIG_HOME".into(), x.to_string_lossy().into_owned()));
        }
    }
    env
}
