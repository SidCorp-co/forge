//! Resident terminal sessions: the tmux server, not this daemon, is the parent.
//!
//! A master used to be a `claude -p` child of the runner — killed on restart,
//! unreachable by a human, and with no reasoning that survived the pass. Here
//! it is a named tmux session instead: an operator types the command
//! [`attach_command`] builds and is looking at the same pane core
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

/// The sessions on the runner's socket whose names start with `prefix`.
///
/// The listing tmux answers is every session the server holds, so a pane
/// this daemon placed and the listing leaves out has ended, and leaves the
/// record of placed panes here, whatever the prefix asked for (ISS-1265
/// round 6).
pub async fn names_with_prefix(prefix: &str) -> Vec<String> {
    let asked = std::time::Instant::now();
    let Ok(out) = tmux(&["list-sessions", "-F", "#{session_name}"]).await else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let listed = String::from_utf8_lossy(&out.stdout);
    let every: std::collections::BTreeSet<&str> = listed.lines().map(str::trim).collect();
    missing_socket::listed(&socket_path(), asked, &every);
    every
        .into_iter()
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

#[expect(
    clippy::disallowed_methods,
    reason = "the tmux socket's dir, a writer owed its move to config::base_dir: docs/proposals/the-tmux-socket-dir-resolves-through-the-reader.md"
)]
fn session_config_dir() -> Option<std::path::PathBuf> {
    crate::config::Config::path()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
}

#[expect(
    clippy::disallowed_methods,
    reason = "the config dir with no XDG override, compared against the socket's to name the unit; a read"
)]
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

/// The command a person types to open the pane `name` on the tmux server this
/// box places panes on. Without `-S` it reaches the default server, which holds
/// no master, and says only that no such session exists (ISS-1306 round 2).
pub fn attach_command(name: &str) -> String {
    attach_command_for(socket_path().as_deref(), name)
}

fn attach_command_for(socket: Option<&std::path::Path>, name: &str) -> String {
    match socket {
        Some(p) => format!(
            "tmux -S {} attach -t {name}",
            shell_word(&p.to_string_lossy())
        ),
        None => format!("tmux attach -t {name}"),
    }
}

/// `word` as one shell word: as is where it holds nothing a shell reads, else
/// single-quoted.
fn shell_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+:@%=,".contains(c));
    if plain {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

fn fits_a_unix_socket(path: &str) -> bool {
    path.len() <= 100
}

fn socket_args() -> Vec<String> {
    socket_args_for(socket_path().as_deref())
}

fn socket_args_for(socket: Option<&std::path::Path>) -> Vec<String> {
    match socket {
        Some(p) => vec!["-S".into(), p.to_string_lossy().into_owned()],
        None => Vec::new(),
    }
}

/// What a test said systemd answers in its place; never anything in a build
/// that is not a test's. The test build's twin is `testing::systemd_stand_in`.
#[cfg(not(test))]
fn systemd_stand_in() -> Option<Placement> {
    None
}

/// Whether a test said the kernel's listing cannot be read; never in a build
/// that is not a test's. The test build's twin is `testing::listing_unread`.
#[cfg(all(not(test), target_os = "linux"))]
fn listing_unread() -> bool {
    false
}

/// The one place a tmux process is built, so a test build can hand the
/// transport a tmux of its own without moving the process's `PATH`, which
/// every other test's spawn by bare name resolves through (ISS-1312). The test
/// build's twin is `testing::tmux_command`.
#[cfg(not(test))]
fn tmux_command() -> Command {
    Command::new("tmux")
}

pub(super) async fn tmux(args: &[&str]) -> Result<std::process::Output> {
    tmux_with_path(args, None).await
}

/// `tmux`, run as a client whose own `PATH` is `path` where one is given.
///
/// A call that exits zero was answered by a server on the socket, so a missing
/// socket file said before is said again if it goes missing again.
async fn tmux_with_path(args: &[&str], path: Option<&str>) -> Result<std::process::Output> {
    let socket = socket_path();
    let mut all = socket_args_for(socket.as_deref());
    all.extend(args.iter().map(|a| (*a).to_string()));
    let out = tmux_command()
        .args(&all)
        .envs(path.map(|p| ("PATH", p)))
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| Error::Other(format!("tmux {}: {e}", args.first().copied().unwrap_or(""))))?;
    if out.status.success() {
        missing_socket::answered(socket);
    }
    Ok(out)
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
/// own words on stderr: no session by that name on the runner's socket, and a
/// question it could not answer at all. [`alive`] folds both into `false`,
/// which is right for a caller deciding whether to bother doing something and
/// wrong for one about to tell core that a session ended — only the middle
/// value here is an ending, and reporting the last one as an ending invents the
/// answer (`VISION: state-never-lies`, ISS-1265).
///
/// No server on the socket is absence, not an unanswered question: tmux 3.6
/// takes its server down with the last session, so a master that was the last
/// pane reads `no server running` once it has ended, and reading that as
/// unknown left its messages and its run open for ever wherever no keepalive
/// held the server up (ISS-1265 round 3).
///
/// A socket FILE that is not there is the opposite case. tmux answers
/// `error connecting to <sock> (No such file or directory)` for a socket never
/// made and, word for word, for one moved or deleted from under a server that
/// is still running every session it ran (judge-51, ISS-1265 round 4). Nothing
/// in the answer parts the two, and the runner places its panes on that socket
/// before it asks about them, so the master's ruling of 2026-10-19 reads it as
/// a question nobody answered, never as an ending.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Presence {
    Present,
    Absent,
    Unaskable,
}

/// tmux's own wording for a session it does not hold: a server that answered
/// without it, and a socket file whose server has exited (`ECONNREFUSED`).
/// Anything else it says, `Permission denied`, `server exited unexpectedly`
/// and a socket file that is not there among them, is not an answer about the
/// session, and an unread answer is not an ending.
const NO_SUCH_SESSION: [&str; 3] = [
    "can't find session",
    "session not found",
    "no server running on",
];

/// tmux's wording for a socket file that is not there, in `strerror`'s English.
fn says_no_socket_file(lower: &str) -> bool {
    lower.contains("error connecting to") && lower.contains("(no such file or directory)")
}

pub(crate) async fn has_session(name: &str) -> Presence {
    let target = session_target(name);
    let asked = std::time::Instant::now();
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
    if says_no_socket_file(&lower) {
        missing_socket::say(name, &said);
        return Presence::Unaskable;
    }
    if NO_SUCH_SESSION
        .iter()
        .any(|wording| lower.contains(wording))
    {
        let socket = socket_path();
        // No server on the socket ended every pane on it; otherwise only this
        // one is known to have ended (ISS-1265 round 6).
        let only = (!lower.contains("no server running on")).then_some(name);
        missing_socket::ended(&socket, only, asked);
        missing_socket::answered(socket);
        return Presence::Absent;
    }
    tracing::warn!(
        "[terminal] {name}: tmux answered `has-session` with \u{ab}{}\u{bb}, which is not its wording for a session it does not hold, so this box has not established that the session ended",
        said.trim()
    );
    Presence::Unaskable
}

/// What this daemon knows about the socket its panes are on, for the one line
/// a missing socket file earns.
///
/// The line names the panes `ensure` placed there, because those are the
/// sessions a server nobody can reach may still be running. It is said once
/// per episode rather than per ask: recovery and the sweeps ask every few
/// seconds, and an episode ends at the first tmux call a server on that socket
/// answers, whichever caller made it.
///
/// The record is never the reason a server is said to run. Whether one still
/// runs on the path is asked of the kernel's listing and of the process table
/// each time it matters, because a record of panes outlives the server that ran
/// them: judge-64 stopped that server and removed its file, and round 5's guard
/// refused every placement from then on, saying a server still ran panes that
/// nothing ran (ISS-1265 round 6).
mod missing_socket {
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    type Socket = Option<PathBuf>;

    /// Each pane this daemon placed on a socket and has not seen end, with
    /// when it was placed: a drop is taken only for a pane placed before the
    /// question that found it ended was asked, so a listing taken while a pane
    /// was being placed cannot forget it.
    static PLACED: Mutex<BTreeMap<Socket, BTreeMap<String, Instant>>> = Mutex::new(BTreeMap::new());
    static SAID: Mutex<BTreeSet<Socket>> = Mutex::new(BTreeSet::new());
    /// When a refused placement on each socket was last said.
    static REFUSED: Mutex<BTreeMap<Socket, Instant>> = Mutex::new(BTreeMap::new());

    /// How long a refusal that keeps being made goes unsaid before it is said
    /// again at warning level: once at error level and then only at debug left
    /// a box that never placed again with one line and then silence (judge-64).
    pub(super) const REPEAT_EVERY: Duration = if cfg!(test) {
        Duration::from_millis(500)
    } else {
        Duration::from_secs(60)
    };

    /// The default server as it answered when this daemon last placed a pane
    /// on it: with no socket resolved there is no path to check for, and no
    /// `-S` in its argv to find it by (consult F1).
    #[derive(Clone)]
    struct Served {
        path: PathBuf,
        pid: u32,
        /// `ps -o lstart=` for that pid when it answered, so a pid the kernel
        /// has since handed to another process is not read as the server
        /// (round 6, consult F1).
        started: Option<String>,
    }

    static DEFAULT_SERVED: Mutex<Option<Served>> = Mutex::new(None);

    pub(super) fn default_served(served: Option<(PathBuf, u32)>) {
        let served = served.map(|(path, pid)| {
            let started = super::process_start(pid);
            (path, pid, started)
        });
        default_served_as(served);
    }

    /// The same, with the start given rather than read.
    pub(super) fn default_served_as(served: Option<(PathBuf, u32, Option<String>)>) {
        *DEFAULT_SERVED.lock().unwrap_or_else(|e| e.into_inner()) =
            served.map(|(path, pid, started)| Served { path, pid, started });
    }

    fn served_default() -> Option<Served> {
        DEFAULT_SERVED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The default socket's path as tmux last named it missing, which a daemon
    /// that restarted after the file went holds with no placement behind it.
    static DEFAULT_SAID: Mutex<Option<PathBuf>> = Mutex::new(None);

    pub(super) fn default_said(path: Option<PathBuf>) {
        *DEFAULT_SAID.lock().unwrap_or_else(|e| e.into_inner()) = path;
    }

    /// Where the default server is, by its own word or by tmux's last refusal.
    fn default_path() -> Option<PathBuf> {
        served_default().map(|s| s.path).or_else(|| {
            DEFAULT_SAID
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        })
    }

    pub(super) fn placed(socket: Socket, name: &str) {
        PLACED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(socket)
            .or_default()
            .insert(name.to_string(), Instant::now());
    }

    pub(super) fn forgotten(socket: &Socket, name: &str) {
        if let Some(names) = PLACED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(socket)
        {
            names.remove(name);
        }
    }

    /// tmux answered, from a server on `socket`, a question asked at `asked`:
    /// `name` is not a session there, or, with no name, no server runs there
    /// at all, so every pane placed before the question ended.
    pub(super) fn ended(socket: &Socket, name: Option<&str>, asked: Instant) {
        if let Some(names) = PLACED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(socket)
        {
            names.retain(|placed, at| *at > asked || name.is_some_and(|n| n != placed));
        }
    }

    /// A server on `socket` listed `names` as every session it holds, in
    /// answer to a question asked at `asked`.
    pub(super) fn listed(socket: &Socket, asked: Instant, names: &BTreeSet<&str>) {
        if let Some(placed) = PLACED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(socket)
        {
            placed.retain(|name, at| *at > asked || names.contains(name.as_str()));
        }
    }

    pub(super) fn answered(socket: Socket) {
        SAID.lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&socket);
        REFUSED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&socket);
    }

    /// Says a refused placement at error level the first time in an episode,
    /// then again at warning level whenever `REPEAT_EVERY` has passed since it
    /// was last said: every sweep that finds a master not running places it
    /// again, and a refusal that holds placement back must not go quiet.
    pub(super) fn say_refused(refused: &str) {
        let now = Instant::now();
        let mut said = REFUSED.lock().unwrap_or_else(|e| e.into_inner());
        match said.get(&super::socket_path()).copied() {
            None => {
                said.insert(super::socket_path(), now);
                tracing::error!("[terminal] {refused}");
            }
            Some(at) if now.duration_since(at) >= REPEAT_EVERY => {
                said.insert(super::socket_path(), now);
                tracing::warn!("[terminal] still refused: {refused}");
            }
            Some(_) => tracing::debug!("[terminal] {refused}"),
        }
    }

    /// The socket tmux says it tried, which is the only name for it where
    /// no socket was resolved and tmux went to its default one (consult F1).
    fn named_by(said: &str) -> Option<&str> {
        let after = said.split_once("error connecting to ")?.1;
        after.rsplit_once(" (").map(|(path, _)| path)
    }

    pub(super) fn placed_on(socket: &Socket) -> Vec<String> {
        PLACED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(socket)
            .map(|names| names.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// What the kernel's listing says about a path, where one is read.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(super) enum Listing {
        #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
        Listens,
        #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
        Silent,
        #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
        Unread(String),
        /// No kernel listing is read on this platform: every variant above is
        /// Linux's, and this one everyone else's.
        #[cfg_attr(target_os = "linux", allow(dead_code))]
        NotKept,
    }

    /// Whether a tmux server still runs on a path whose file is gone.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(super) enum Serving {
        /// It does, by the evidence `why` names, and as `pid` where the
        /// process table found it.
        Runs { pid: Option<u32>, why: String },
        /// Nothing serves the path: the panes placed on it ended with it.
        Ended(String),
        /// Neither could be established.
        Unknown(String),
    }

    const LISTENS: &str = "a tmux server still listens on that path";

    /// The reading of the two questions together. A readable listing settles
    /// it on its own: a tmux server holds its listening socket until it exits,
    /// so a listener is a server and none is no server, whatever else carries
    /// its words (consult F1). Where the listing is not read, a process started
    /// as the server is a server that runs, and off Linux a process check that
    /// ran and found none is the best there is.
    pub(super) fn serving_from(listing: Listing, process: Result<Option<u32>, String>) -> Serving {
        match (listing, process) {
            (Listing::Listens, process) => Serving::Runs {
                pid: process.ok().flatten(),
                why: LISTENS.to_string(),
            },
            (Listing::Silent, _) => {
                Serving::Ended("the kernel lists nothing listening on that path".to_string())
            }
            (_, Ok(Some(pid))) => Serving::Runs {
                pid: Some(pid),
                why: format!("the tmux server started on that path still runs as pid {pid}"),
            },
            (Listing::NotKept, Ok(None)) => Serving::Ended(
                "no process started as the tmux server on that path runs".to_string(),
            ),
            (Listing::Unread(e), Ok(None)) => Serving::Unknown(format!(
                "whether a tmux server still listens on that path could not be read ({e}), though no process started as that server was found"
            )),
            (Listing::Unread(e), Err(p)) => Serving::Unknown(format!(
                "whether a tmux server still listens on that path could not be read ({e}), nor whether a process started as that server runs ({p})"
            )),
            (Listing::NotKept, Err(p)) => Serving::Unknown(format!(
                "whether a process started as the tmux server on that path runs could not be established ({p})"
            )),
        }
    }

    /// Whether a tmux server still runs on `path`, the path of `socket` or of
    /// the default server where `socket` is `None`, with the process check's
    /// own answer, which the recovery a line hands a person is built from.
    fn serving(socket: &Socket, path: &Path) -> (Serving, Found) {
        let found = server_process(socket, path);
        (serving_from(super::listing(path), found.clone()), found)
    }

    /// What the process check answered: the pid of the process started as the
    /// server on the path, none, or why it could not be asked.
    pub(super) type Found = Result<Option<u32>, String>;

    /// The pid of the process the runner started as the tmux server on
    /// `path`, by the same command the line hands a person, so a refusal that
    /// names it names one that finds something.
    pub(super) fn server_process(socket: &Socket, path: &Path) -> Found {
        if socket.is_none() {
            let Some(served) = served_default().filter(|s| s.path == path) else {
                return Err("this daemon holds no pid for the default server".to_string());
            };
            let Some(started) = served.started else {
                return Err(format!(
                    "the start of pid {} was not read when it answered",
                    served.pid
                ));
            };
            return super::still_the_process(served.pid, &started)
                .map(|same| same.then_some(served.pid));
        }
        let pattern = server_pattern(&path.display().to_string());
        let out = std::process::Command::new("pgrep")
            .args(["-o", "-f", "--", &pattern])
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("`pgrep` could not be run: {e}"))?;
        match out.status.code() {
            Some(0) => String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .and_then(|l| l.trim().parse().ok())
                .map(Some)
                .ok_or_else(|| "`pgrep` matched and printed no pid".to_string()),
            Some(1) => Ok(None),
            code => Err(format!(
                "`pgrep` exited {code:?}: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )),
        }
    }

    /// How a person finds the server still running on `path` and has it make
    /// its socket file again (tmux(1): SIGUSR1 recreates a removed socket).
    ///
    /// Not the session unit's `MainPID`: systemd reads `0` for a `forking`
    /// unit whose tmux client exited, measured on both units of a live box.
    /// Not every process the kernel lists on the socket either: a pane being
    /// spawned holds it as a fork of the server until it execs, and SIGUSR1
    /// ends that fork. The server keeps the argv of the client that started
    /// it, which both routes here write as `tmux -S <path> new-session`, and
    /// it is older than any fork or client carrying the same words.
    pub(super) fn recovery(socket: &Socket, path: &str, found: &Found) -> String {
        if socket.is_none() {
            return match (served_default(), found) {
                (Some(_), Ok(Some(pid))) => format!(
                    "The default tmux server answered as pid {pid} when this daemon last placed a pane on it and still runs as that process; SIGUSR1 to it (`kill -USR1 {pid}`) makes it recreate the file"
                ),
                // The check ran, and the pid is no longer that server: it has
                // exited or the kernel has handed it to another process, which
                // SIGUSR1 would end (judge-68).
                (Some(Served { pid, .. }), Ok(None)) => format!(
                    "The default tmux server answered as pid {pid} when this daemon last placed a pane on it, and no tmux server holds pid {pid} now, so it is not the one to signal; `ss -xlp src {path}` names the process still listening on that path, and SIGUSR1 to that process (`kill -USR1 <its pid>`) makes it recreate the file"
                ),
                (Some(Served { pid, .. }), Err(_)) => format!(
                    "The default tmux server answered as pid {pid} when this daemon last placed a pane on it; `ps -o args= -p {pid}` shows whether it still runs, and SIGUSR1 to it (`kill -USR1 {pid}`) makes it recreate the file"
                ),
                (None, _) => "SIGUSR1 to the default tmux server still running on it makes it recreate the file; this daemon placed no pane on it since it started, so it holds no pid for it".to_string(),
            };
        }
        let finds = super::shell_quote(&server_pattern(path));
        match found {
            Ok(Some(pid)) => format!(
                "`pgrep -of -- {finds}` prints the pid of the tmux server started on that path, pid {pid} now, and SIGUSR1 to it (`kill -USR1 {pid}`) makes it recreate the file"
            ),
            _ => format!(
                "`pgrep -of -- {finds}` prints the pid of the tmux server started on that path and SIGUSR1 to it (`kill -USR1 <pid>`) makes it recreate the file"
            ),
        }
    }

    /// What `pgrep -f` matches for the server started on `path`: a command
    /// line that runs tmux and carries the argv both routes here start every
    /// server with, so a process that only mentions those words is not taken
    /// for the server (consult F1).
    fn server_pattern(path: &str) -> String {
        format!("^([^ ]*/)?tmux .*-S {} new-session", ere_literal(path))
    }

    /// `text` as a POSIX extended regular expression matching only itself,
    /// for `pgrep`, which reads its pattern as one (consult F2).
    pub(super) fn ere_literal(text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        for c in text.chars() {
            if "\\.[]()*+?{}|^$".contains(c) {
                out.push('\\');
            }
            out.push(c);
        }
        out
    }

    /// The panes placed on `socket` ended with the server at `path`, which
    /// no longer runs: they leave the record, and are said once, at error
    /// level, because each was a master or a job a person may be waiting on.
    fn ended_with_server(socket: &Socket, path: &Path, why: &str) {
        let ended = PLACED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(socket)
            .map(|names| names.into_keys().collect::<Vec<_>>())
            .unwrap_or_default();
        if !ended.is_empty() {
            tracing::error!(
                "[terminal] the tmux server this daemon placed {} on no longer runs at {} ({why}), so those panes ended with it and none of them is running; the next placement starts a fresh server on that path",
                ended.join(", "),
                path.display()
            );
        }
    }

    pub(super) fn say(name: &str, said: &str) {
        let socket = super::socket_path();
        if socket.is_none() {
            default_said(named_by(said).map(PathBuf::from));
        }
        if !SAID
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(socket.clone())
        {
            tracing::debug!("[terminal] {name}: the tmux socket file is still not there");
            return;
        }
        let path = named_by(said).map(PathBuf::from).or_else(|| socket.clone());
        let shown = path
            .as_deref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "of the default server".to_string());
        let placed = placed_on(&socket);
        if placed.is_empty() {
            tracing::warn!(
                "[terminal] {name}: the tmux socket file {shown} is not there, so no server on it could be asked whether this session is running, and nothing is read as ended. This daemon placed no pane on that socket since it started"
            );
            return;
        }
        let found = match path.as_deref().map(|p| (p, serving(&socket, p))) {
            Some((p, (Serving::Ended(why), _))) => return ended_with_server(&socket, p, &why),
            Some((_, (_, found))) => found,
            None => Ok(None),
        };
        tracing::error!(
            "[terminal] {name}: the tmux socket file {shown} is not there, so the server this daemon placed {} on could not be asked whether they are running, and none is read as ended — a socket moved or deleted under a running server still holds every session it held. {}",
            placed.join(", "),
            path.as_deref()
                .map(|p| recovery(&socket, &p.display().to_string(), &found))
                .unwrap_or_default()
        );
    }

    /// Why `name` may not be placed now: the runner's socket file is gone
    /// while a server still runs on its path, so the placement would start a
    /// second server there, which answers `can't find session` for every
    /// master the first still runs, and each would be acked `gone` (the
    /// master's ruling of 2026-10-19, ISS-1265 round 5).
    ///
    /// A server runs where the kernel lists one listening on the path, which
    /// outlives a restart of this daemon, or where the process started as it
    /// still runs. Where neither does, the panes this daemon placed there
    /// ended with it, and the placement goes ahead (round 6). A listing that
    /// cannot be read is not an empty one. With neither, a socket never made
    /// is a cold start.
    pub(super) fn placement_refused(name: &str) -> Option<String> {
        refusal(name, &super::socket_path())
    }

    /// The same, for the socket `socket` names, or for the default server's
    /// own path where none was resolved.
    pub(super) fn refusal(name: &str, socket: &Socket) -> Option<String> {
        let path = socket.clone().or_else(default_path)?;
        if !matches!(std::fs::symlink_metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        {
            return None;
        }
        let placed = placed_on(socket);
        let (serves, found) = serving(socket, &path);
        let (why, pid) = match serves {
            Serving::Ended(why) => {
                ended_with_server(socket, &path, &why);
                return None;
            }
            Serving::Unknown(_) if !cfg!(target_os = "linux") && placed.is_empty() => return None,
            Serving::Unknown(why) => (why, None),
            Serving::Runs { pid, why } => (why, pid),
        };
        let mut because = Vec::new();
        if !placed.is_empty() {
            because.push(format!("this daemon placed {} on it", placed.join(", ")));
        }
        because.push(why);
        let shown = path.display().to_string();
        let unlisted = if pid.is_none() && socket.is_some() {
            " Where it prints nothing, the server on that path was not started by this runner, and `ss -xlp src <path>` names the process holding it."
        } else {
            ""
        };
        Some(format!(
            "{name} was not placed: the tmux socket file {shown} is not there, and {}. A server started on that path now would answer that it holds no session for every pane the old one still runs, so placement waits until the socket answers again. {}.{unlisted}",
            because.join(", and "),
            recovery(socket, &shown, &found)
        ))
    }
}

/// The start of `pid` as `ps` gives it, which together with the pid names
/// one process for as long as it lives.
fn process_start(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let started = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !started.is_empty()).then_some(started)
}

/// Whether `pid` is still the tmux process that started at `started`: a pid
/// that no longer runs, or one the kernel has handed to a process started at
/// another time or running something else, is not.
fn still_the_process(pid: u32, started: &str) -> std::result::Result<bool, String> {
    let out = std::process::Command::new("ps")
        .args(["-o", "lstart=", "-o", "args=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("`ps` could not be run: {e}"))?;
    if !out.status.success() {
        return Ok(false);
    }
    let row = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(row
        .strip_prefix(started)
        .is_some_and(|args| args.contains("tmux")))
}

/// What the kernel answers about `socket`: `/proc/net/unix` still lists a
/// listening socket by the path it was bound to after that file is unlinked,
/// and lists none once the server holding it has exited. A listing that
/// cannot be read is not an empty one.
#[cfg(target_os = "linux")]
fn listing(socket: &std::path::Path) -> missing_socket::Listing {
    use missing_socket::Listing;
    const TABLE: &str = "/proc/net/unix";
    let read = if listing_unread() {
        Err(format!("reading {TABLE}: a test said it cannot be read"))
    } else {
        std::fs::read_to_string(TABLE).map_err(|e| format!("reading {TABLE}: {e}"))
    };
    let resolved = resolved(socket);
    match read {
        Ok(table) => {
            if table
                .lines()
                .skip(1)
                .filter_map(listening_path)
                .any(|path| path == socket || path == resolved.as_path())
            {
                Listing::Listens
            } else {
                Listing::Silent
            }
        }
        Err(e) => Listing::Unread(e),
    }
}

/// No kernel listing is read off Linux, so the process table alone says
/// whether a server still runs there; a server on that path not started as
/// `tmux -S <path> new-session` is the case
/// `docs/proposals/a-runner-socket-moved-under-a-running-server-orphans-its-masters.md`
/// leaves open.
#[cfg(not(target_os = "linux"))]
fn listing(_: &std::path::Path) -> missing_socket::Listing {
    missing_socket::Listing::NotKept
}

/// The path of a listening socket in one `/proc/net/unix` row, laid out as
/// `Num RefCount Protocol Flags Type St Inode Path`: the inode is padded, the
/// path is the rest of the line after one space and may hold spaces, and a
/// listening socket carries `__SO_ACCEPTCON` (`0x10000`) in its flags.
#[cfg(target_os = "linux")]
fn listening_path(row: &str) -> Option<&std::path::Path> {
    let mut rest = row;
    let mut flags = "";
    for field in 0..7 {
        rest = rest.trim_start();
        let end = rest.find(' ')?;
        if field == 3 {
            flags = &rest[..end];
        }
        rest = &rest[end..];
    }
    let path = rest.strip_prefix(' ')?;
    let listening = u32::from_str_radix(flags, 16).is_ok_and(|f| f & 0x10000 != 0);
    (listening && !path.is_empty()).then(|| std::path::Path::new(path))
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
    let up = bring_up_server().await;
    if up {
        for found in super::daemon_env::reconcile_server().await {
            found.say();
        }
    }
    up
}

async fn bring_up_server() -> bool {
    if server_answers().await {
        // A server an older runner left up, or one whose keepalive was killed, holds sessions
        // and no keepalive; the master placed now would become its last session (ISS-1344 r5).
        if SessionIdentity::current().is_some() && !keepalive_is_held().await {
            hold_the_keepalive_here().await;
        }
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
            hold_the_keepalive_here().await;
            false
        }
        Placement::Unavailable(detail) => {
            tracing::warn!(
                "[terminal] the session server could not be given its own unit ({detail}) — panes will be killed with this service, as they were before"
            );
            hold_the_keepalive_here().await;
            false
        }
    }
}

/// Starts the session server here with the keepalive session, where no unit
/// holds it. Without it the server's only sessions are panes and tmux's
/// `exit-empty` takes the server with the last of them, so the next placement
/// starts it cold. A master that exits as the last pane still reads as gone:
/// [`has_session`] reads no server on the socket as no session (ISS-1344 r4,
/// ISS-1265). A shell sleeping in a loop, because BSD `sleep`
/// takes no `infinity`, and `tail -f /dev/null` gives up on a character device
/// the first time another process writes to it, which a loaded box does at once.
async fn hold_the_keepalive_here() {
    let started = tmux(&[
        "new-session",
        "-d",
        "-s",
        KEEPALIVE,
        "sh",
        "-c",
        "while :; do sleep 86400; done",
    ])
    .await;
    let refused = match &started {
        Ok(o) if o.status.success() => None,
        Ok(o) => Some(String::from_utf8_lossy(&o.stderr).trim().to_string()),
        Err(e) => Some(e.to_string()),
    };
    match refused {
        None if server_answers_within(KEEPALIVE_READY_WITHIN).await => tracing::info!(
            "[terminal] the session server holds {KEEPALIVE} here, so it outlives its last pane"
        ),
        None => tracing::warn!(
            "[terminal] {KEEPALIVE} was started here and the socket never answered within {KEEPALIVE_READY_WITHIN:?} — the server goes with its last pane and starts cold for the next"
        ),
        Some(why) => tracing::warn!(
            "[terminal] could not start {KEEPALIVE} here ({why}) — the server goes with its last pane and starts cold for the next"
        ),
    }
}

const KEEPALIVE_READY_WITHIN: Duration = Duration::from_secs(5);

async fn keepalive_is_held() -> bool {
    tmux(&["has-session", "-t", &session_target(KEEPALIVE)])
        .await
        .is_ok_and(|o| o.status.success())
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
    if let Some(said) = systemd_stand_in() {
        return said;
    }
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

/// How long a unit's server has to answer: shorter in a test build, so a test
/// standing in for a unit that never answers does not wait out the real one.
const SERVER_READY_WITHIN: Duration = if cfg!(test) {
    Duration::from_secs(10)
} else {
    Duration::from_secs(30)
};

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
    if let Some(refused) = missing_socket::placement_refused(name) {
        missing_socket::say_refused(&refused);
        return Err(Error::Other(refused));
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
    // The server's own environment is not what a pane is owed: the daemon's
    // variables go to each pane here, the one place a pane is placed (ISS-1325).
    for (k, v) in env.iter().chain(super::daemon_env::for_pane(env).iter()) {
        args.push("-e".into());
        args.push(format!("{k}={v}"));
    }
    args.push("--".into());
    args.extend(argv.iter().cloned());

    // tmux takes a new pane's PATH from the client that asks for the session,
    // not from `-e` and not from the server: measured on tmux 3.6, a pane
    // started with `-e PATH=<dirs>` still held the client's own PATH. So a
    // PATH the caller built is handed to that client too (ISS-1390).
    let path = env
        .iter()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v.as_str());
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = tmux_with_path(&borrowed, path).await?;
    if !out.status.success() {
        return Err(Error::Other(format!(
            "tmux new-session {name}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    missing_socket::placed(socket_path(), name);
    if socket_path().is_none() {
        missing_socket::default_served(served().await);
    }
    if let Some(path) = transcript {
        pipe_pane(name, path).await;
    }
    Ok(true)
}

/// The socket path and pid of the server the transport reaches, in its own
/// words, or `None` where it could not be asked.
async fn served() -> Option<(std::path::PathBuf, u32)> {
    let out = tmux(&["display-message", "-p", "#{pid} #{socket_path}"])
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let said = String::from_utf8_lossy(&out.stdout);
    let (pid, path) = said.trim().split_once(' ')?;
    Some((std::path::PathBuf::from(path), pid.parse().ok()?))
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
    present_or_not_typed(name).await?;
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

/// Why nothing may be typed at `name`, where tmux does not say it is there.
async fn present_or_not_typed(name: &str) -> std::result::Result<(), NotTyped> {
    match has_session(name).await {
        Presence::Present => Ok(()),
        Presence::Absent => Err(NotTyped::Gone(name.to_string())),
        Presence::Unaskable => Err(NotTyped::Failed(format!(
            "{name}: nothing was typed — tmux could not be asked whether this session is there, so whether it is running is unknown rather than settled. Ask again once tmux answers."
        ))),
    }
}

/// How much scrollback the prompt read takes, so a draft taller than the
/// pane is still read from its first line.
const PROMPT_READ_LINES: &str = "-500";

/// How a pane's composer reads, and the capture it was read from: escapes
/// kept, with enough scrollback to hold a tall draft. The capture is `None`
/// where tmux gave none, which reads as no composer.
async fn read_prompt(target: &str) -> (composer::Composer, Option<String>) {
    let args = [
        "capture-pane",
        "-p",
        "-e",
        "-S",
        PROMPT_READ_LINES,
        "-t",
        target,
    ];
    let capture = match tmux(&args).await {
        Ok(out) if out.status.success() => Some(String::from_utf8_lossy(&out.stdout).into_owned()),
        _ => None,
    };
    let read = capture
        .as_deref()
        .map_or(composer::Composer::Unrecognised, composer::read);
    (read, capture)
}

/// The visible screen of pane `name` as text, or `None` where tmux gave none.
pub async fn screen(name: &str) -> Option<String> {
    match tmux(&["capture-pane", "-p", "-t", &pane_target(name)]).await {
        Ok(out) if out.status.success() => Some(String::from_utf8_lossy(&out.stdout).into_owned()),
        _ => None,
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
    present_or_not_typed(name).await?;
    let target = pane_target(name);
    let (read, capture) = read_prompt(&target).await;
    let prompt = match read {
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
        // The composer reads a choice list by its layout, and a trust dialog
        // drawn in another one is no menu to it (ISS-1382 judging), so the
        // dialog's own words refuse the paste whose Enter would answer it.
        composer::Composer::Unrecognised
            if capture
                .as_deref()
                .and_then(crate::daemon::pane_exit::on_trust_dialog)
                .is_some() =>
        {
            return Err(NotTyped::Refused(format!(
                "{name}: nothing was typed — its pane is showing Claude Code's folder-trust \
dialog, and Enter there answers it instead of sending a message. Answer it at the pane, or set \
`hasTrustDialogAccepted: true` for that folder in the `.claude.json` Claude Code reads, then send again."
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
        Ok(out) if out.status.success() => {
            missing_socket::forgotten(&socket_path(), name);
            return Ok(());
        }
        Ok(out) => String::from_utf8_lossy(&out.stderr).trim().to_string(),
        Err(e) => e.to_string(),
    };
    match still_there(name).await {
        Ok(false) => {
            missing_socket::forgotten(&socket_path(), name);
            Ok(())
        }
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
/// no sessions, which is the outcome the caller wanted. `Err` is every answer
/// [`has_session`] cannot read as one about the session — tmux that could not
/// be run, a socket refusing this box, and a socket file that is not there,
/// where a server moved from under it still runs the pane this kill never
/// reached (ISS-1265 round 4).
async fn still_there(name: &str) -> Result<bool> {
    match has_session(name).await {
        Presence::Present => Ok(true),
        Presence::Absent => Ok(false),
        Presence::Unaskable => Err(Error::Other(
            "tmux could not be asked whether this session is there".into(),
        )),
    }
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

#[expect(
    clippy::disallowed_methods,
    reason = "MCP_TOOL_TIMEOUT, an operator value a pane keeps"
)]
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
use testing::{systemd_stand_in, tmux_command};

#[cfg(all(test, target_os = "linux"))]
use testing::listing_unread;

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    #[cfg(unix)]
    use crate::auth::cred_store::ScopedVar;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    /// What systemd answers in a test's place. Only the unix tests stand one in,
    /// since no other box runs a tmux server for them.
    ///
    /// A test is answered [`NoUnit`](SystemdSays::NoUnit) unless it says
    /// otherwise, so the box's own user manager is reached only by a test that
    /// holds the unit it places and stops it: a unit a test places and nobody
    /// stops outlives the test process for as long as the box is up, and 29 of
    /// them did, one per `IsolatedServer` test run that was killed or timed out
    /// before its server was (ISS-1223).
    #[derive(Clone, Copy)]
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) enum SystemdSays {
        /// No user manager to give the server a unit, as on macOS or in a container.
        NoUnit,
        /// A unit is taken and its server never answers.
        UnitNeverAnswers,
        /// This box's user manager answers, as in production: the test places a
        /// real unit and owes its stopping, through `PlacedUnit`.
        Itself,
    }

    thread_local! {
        static STAND_IN: Cell<SystemdSays> = const { Cell::new(SystemdSays::NoUnit) };
    }

    /// systemd answers `says` on this thread until dropped. A thread's, not the
    /// process's environment: a current-thread `#[tokio::test]` asks systemd
    /// from the thread that took it.
    pub(crate) struct StandIn {
        before: SystemdSays,
    }

    impl StandIn {
        pub(crate) fn here(says: SystemdSays) -> Self {
            Self {
                before: STAND_IN.with(|s| s.replace(says)),
            }
        }
    }

    impl Drop for StandIn {
        fn drop(&mut self) {
            STAND_IN.with(|s| s.set(self.before));
        }
    }

    pub(super) fn systemd_stand_in() -> Option<Placement> {
        match STAND_IN.with(Cell::get) {
            SystemdSays::NoUnit => Some(Placement::Unavailable(
                "a test said this box has no user manager".into(),
            )),
            SystemdSays::UnitNeverAnswers => Some(Placement::Accepted),
            SystemdSays::Itself => None,
        }
    }

    /// A tmux a test put in place of the real one: the program spawned, and
    /// the variables that program reads, set on its own command rather than
    /// on the process.
    struct Fake {
        program: std::path::PathBuf,
        env: Vec<(&'static str, std::ffi::OsString)>,
        built: Cell<usize>,
    }

    thread_local! {
        static FAKE: RefCell<Option<Rc<Fake>>> = const { RefCell::new(None) };
    }

    /// The test build of `tmux_command`: the fake installed on this thread,
    /// or the real tmux where none is.
    ///
    /// The fake is the installing thread's alone, as `runner/process.rs`'s
    /// `StubClaude` is. The fakes used to move `PATH` instead, and one that
    /// emptied it made every `git` spawned by name beside it fail `NotFound`:
    /// 266 of 300 loaded runs of `give_back_tests` and `runner::terminate`
    /// (ISS-1312). A test installing one reaches tmux on its own thread, as a
    /// current-thread `#[tokio::test]` does.
    pub(super) fn tmux_command() -> Command {
        FAKE.with(|f| match f.borrow().as_ref() {
            Some(fake) => {
                fake.built.set(fake.built.get() + 1);
                let mut cmd = Command::new(&fake.program);
                cmd.envs(fake.env.iter().map(|(k, v)| (*k, v)));
                cmd
            }
            None => Command::new("tmux"),
        })
    }

    /// Holds a fake in place until dropped, then puts back whatever fake stood
    /// before it, so a guard taken inside another hands the outer one back.
    struct Installed {
        fake: Rc<Fake>,
        before: Option<Rc<Fake>>,
    }

    impl Installed {
        fn new(program: std::path::PathBuf, env: Vec<(&'static str, std::ffi::OsString)>) -> Self {
            let fake = Rc::new(Fake {
                program,
                env,
                built: Cell::new(0),
            });
            let before = FAKE.with(|f| f.borrow_mut().replace(Rc::clone(&fake)));
            Self { fake, before }
        }

        fn built(&self) -> usize {
            self.fake.built.get()
        }
    }

    impl Drop for Installed {
        fn drop(&mut self) {
            let before = self.before.take();
            FAKE.with(|f| *f.borrow_mut() = before);
        }
    }

    #[cfg(unix)]
    pub(crate) fn executable(path: &std::path::Path) {
        let mut perms = std::fs::metadata(path).expect("shim mode").permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
        std::fs::set_permissions(path, perms).expect("shim executable");
    }

    /// The first line of every shim here: asked this, it answers from its own
    /// code and runs nothing else.
    #[cfg(unix)]
    pub(crate) const SHIM_PROBE: &str = "--forge-shim-probe";
    const PROBE_LINE: &str = "[ \"$1\" = --forge-shim-probe ] && exit 0\n";

    /// The one way a shim here is made: `script` must open with the probe, and
    /// the file is handed back only once a probe of it has run.
    pub(crate) fn write_shim(shim: &std::path::Path, script: &str) {
        assert!(
            script.starts_with(&format!("#!/bin/sh\n{PROBE_LINE}")),
            "{} does not open with the probe, so nothing can tell when it is safe to run",
            shim.display()
        );
        std::fs::write(shim, script).expect("the shim is written");
        #[cfg(unix)]
        {
            executable(shim);
            until_it_runs(shim);
        }
    }

    /// Wait until `shim` runs, and only then hand it out.
    ///
    /// A sibling test thread that forked while the shim's write was open holds
    /// that descriptor until its own exec, and until then the kernel refuses to
    /// run the file (`ETXTBSY`). Through `posix_spawn` that refusal is no error:
    /// the child exits 127, so a tmux call answers as a tmux that failed, and
    /// `a_kill_tmux_refused_is_never_answered_as_one_that_took` read that as
    /// its session gone, once in 1200 runs (ISS-1312, F3). One run of the
    /// probe says no writer is left, and none can appear: the descriptor was
    /// closed before the probe ran.
    #[cfg(unix)]
    pub(crate) fn until_it_runs(shim: &std::path::Path) {
        for _ in 0..100 {
            let ran = std::process::Command::new(shim)
                .arg(SHIM_PROBE)
                .stdin(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success());
            if ran {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!(
            "{} never ran its own code, so no tmux call may be handed it",
            shim.display()
        );
    }

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
        #[expect(
            clippy::disallowed_methods,
            reason = "FORGE_TEST_REQUIRE_TMUX, whether this test run promised a tmux; test only"
        )]
        if std::env::var_os(REQUIRE_TMUX).is_some_and(|v| !v.is_empty()) {
            panic!(
                "{why} — and {REQUIRE_TMUX} is set, so this run promised tmux and a server of this test's own; returning here would pass the test without running it"
            );
        }
        eprintln!("{why}");
    }

    #[cfg(unix)]
    /// A tmux server of this test's own, addressed the way production
    /// addresses the box's: through the config dir.
    ///
    /// The socket is `<XDG_CONFIG_HOME>/forge-runner/tmux.sock`, so pointing
    /// that variable somewhere empty is the whole isolation — and it is what
    /// keeps a test off the server this box's live masters are running on.
    pub(crate) struct IsolatedServer {
        // Dropped after this struct's own drop has asked the server to end
        // through its socket, and before the directory goes.
        _servers: crate::test_scratch::TmuxServers,
        _xdg: ScopedVar,
        dir: crate::test_scratch::Scratch,
    }

    #[cfg(unix)]
    impl IsolatedServer {
        pub(crate) fn new(label: &str) -> Self {
            // `short`: the socket is `<dir>/forge-runner/tmux.sock`, and a path past the 100-byte
            // limit resolves no socket at all, which would send tmux to the box's own server.
            let dir = crate::test_scratch::Scratch::short(&format!("iso-{label}"));
            std::fs::create_dir_all(dir.join("forge-runner")).expect("isolated config dir");
            let xdg = ScopedVar::set("XDG_CONFIG_HOME", &dir);
            Self {
                _servers: crate::test_scratch::TmuxServers::under(&dir),
                _xdg: xdg,
                dir,
            }
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

    #[cfg(unix)]
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

    #[cfg(unix)]
    /// Ends `name` as its server's last session, and returns once tmux says no
    /// server runs on the socket: a client asking in the moment the server is
    /// going is told `server exited unexpectedly`, which is not the answer
    /// under test. Panics where it never says so, so a test resting on this
    /// cannot pass on a server that stayed up.
    pub(crate) async fn end_the_last_session(name: &str) {
        let ended = super::tmux(&["kill-session", "-t", &super::session_target(name)])
            .await
            .expect("tmux runs");
        assert!(ended.status.success(), "{name} must end");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let listed = super::tmux(&["list-sessions"]).await.expect("tmux runs");
            let said = String::from_utf8_lossy(&listed.stderr).into_owned();
            if said.contains("no server running on") {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the server never went with its last session; tmux last said: {said}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    /// Stops the test's own server from outside the daemon, as a person
    /// stopping an orphaned server does, then removes the file tmux leaves
    /// behind: tmux 3.6 unlinks it on none of `kill-server`, SIGTERM or the
    /// last session's exit (judge-64).
    #[cfg(unix)]
    pub(crate) async fn stop_the_server_and_remove_its_file() {
        let socket = socket_path().expect("a socket of the test's own");
        let stopped = super::tmux(&["kill-server"]).await.expect("tmux runs");
        assert!(stopped.status.success(), "the server must stop");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let listed = super::tmux(&["list-sessions"]).await.expect("tmux runs");
            let said = String::from_utf8_lossy(&listed.stderr).into_owned();
            if said.contains("no server running on") {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the server never stopped; tmux last said: {said}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        std::fs::remove_file(&socket).expect("the stale socket file is removed");
    }

    #[cfg(unix)]
    /// The runner's socket file moved aside while its server keeps running,
    /// and moved back when this drops: the state judge-51 found, where tmux 3.6
    /// answers `error connecting to <sock> (No such file or directory)` about a
    /// server that holds every session it held (ISS-1265 round 4). Put back on
    /// drop because `IsolatedServer` ends its server through that path.
    pub(crate) struct MovedSocket {
        socket: std::path::PathBuf,
        aside: std::path::PathBuf,
    }

    #[cfg(unix)]
    impl MovedSocket {
        pub(crate) fn aside() -> Self {
            let socket = socket_path().expect("a socket of the test's own");
            let aside = socket.with_extension("aside");
            std::fs::rename(&socket, &aside).expect("the socket file moves aside");
            Self { socket, aside }
        }

        pub(crate) fn socket(&self) -> &std::path::Path {
            &self.socket
        }

        pub(crate) fn put_back(&self) {
            if self.aside.exists() {
                std::fs::rename(&self.aside, &self.socket).expect("the socket file goes back");
            }
        }

        /// Moves it aside again, for a second episode.
        pub(crate) fn again(&self) {
            std::fs::rename(&self.socket, &self.aside).expect("the socket file moves aside again");
        }

        /// Drops the file set aside, for a server that has made its socket
        /// again: putting the old file back would cover the one it answers on.
        pub(crate) fn discard_aside(&self) {
            std::fs::remove_file(&self.aside).expect("the file set aside is removed");
        }
    }

    #[cfg(target_os = "linux")]
    thread_local! {
        static UNREAD_LISTING: Cell<bool> = const { Cell::new(false) };
    }

    /// The kernel's listing of listening sockets cannot be read on this thread
    /// until dropped, as on a box whose `/proc` hides it.
    #[cfg(target_os = "linux")]
    pub(crate) struct UnreadListing;

    #[cfg(target_os = "linux")]
    impl UnreadListing {
        pub(crate) fn here() -> Self {
            UNREAD_LISTING.with(|u| u.set(true));
            Self
        }
    }

    #[cfg(target_os = "linux")]
    impl Drop for UnreadListing {
        fn drop(&mut self) {
            UNREAD_LISTING.with(|u| u.set(false));
        }
    }

    #[cfg(target_os = "linux")]
    pub(super) fn listing_unread() -> bool {
        UNREAD_LISTING.with(Cell::get)
    }

    #[cfg(unix)]
    impl Drop for MovedSocket {
        fn drop(&mut self) {
            self.put_back();
        }
    }

    /// A tmux this box cannot run at all: every call comes back as a spawn
    /// error rather than as an answer.
    ///
    /// The state `alive` cannot represent. It answers `false` here, and a
    /// postcondition reading that as `the session is gone` reports a kill on
    /// the strength of a question nobody answered.
    pub(crate) struct UnaskableTmux {
        installed: Installed,
        _dir: crate::test_scratch::Scratch,
    }

    impl UnaskableTmux {
        pub(crate) fn installed() -> Self {
            let dir = crate::test_scratch::Scratch::new("unaskable");
            // A program that is not there, so the spawn fails `NotFound` as it
            // does for a tmux gone from `PATH`. `available()` was resolved at
            // startup and is cached, which is the production shape of this:
            // tmux was there when the daemon started and cannot be run now.
            Self {
                installed: Installed::new(dir.join("tmux"), Vec::new()),
                _dir: dir,
            }
        }

        /// How many tmux commands were built on this fake, counted before
        /// each spawn: the fake never starts, so nothing it runs could count.
        /// A test asserts it is not zero, or it would pass on a tmux call that
        /// went somewhere else.
        pub(crate) fn asked(&self) -> usize {
            self.installed.built()
        }
    }

    #[cfg(unix)]
    /// A tmux that refuses `kill-session` and answers every other verb from the
    /// real server, for the one window `kill`'s postcondition is about.
    ///
    /// A shim rather than a stub of our own code: what `kill` reads is a tmux
    /// process's exit status and, after it, a real `has-session`. Driving those
    /// two to the pair tmux itself produces — `kill-session` exits 1, the
    /// session is still there — is the fault, not a model of it.
    pub(crate) struct RefusingKill {
        _installed: Installed,
        _dir: crate::test_scratch::Scratch,
    }

    #[cfg(unix)]
    impl RefusingKill {
        pub(crate) fn installed() -> Self {
            let (_installed, _dir) = refusing("kill-session");
            Self { _installed, _dir }
        }
    }

    #[cfg(target_os = "linux")]
    /// A tmux that refuses `set-environment`, the verb the daemon reconciles the
    /// session server's environment with, and answers every other from the real
    /// server (ISS-1325).
    pub(crate) struct RefusingSetEnvironment {
        _installed: Installed,
        _dir: crate::test_scratch::Scratch,
    }

    #[cfg(target_os = "linux")]
    impl RefusingSetEnvironment {
        pub(crate) fn installed() -> Self {
            let (_installed, _dir) = refusing("set-environment");
            Self { _installed, _dir }
        }
    }

    #[cfg(unix)]
    fn refusing(verb: &str) -> (Installed, crate::test_scratch::Scratch) {
        let real = which::which("tmux").expect("a real tmux to pass everything else to");
        let dir = crate::test_scratch::Scratch::new("refuse");
        let shim = dir.join("tmux");
        write_shim(
            &shim,
            &format!(
                "#!/bin/sh\n{PROBE_LINE}for a in \"$@\"; do\n  case \"$a\" in\n    -*) ;;\n    {verb}) echo 'refused' >&2; exit 1 ;;\n    *) ;;\n  esac\ndone\nexec {} \"$@\"\n",
                shim_quote(&real.to_string_lossy())
            ),
        );
        (Installed::new(shim, Vec::new()), dir)
    }

    /// The environment of `name`'s pane process once its program is the one
    /// started: read before the exec it is still the server's.
    #[cfg(target_os = "linux")]
    pub(crate) async fn environ_once_running(
        name: &str,
        marker: &str,
    ) -> std::collections::HashMap<String, String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            if let Some(pid) = super::pane_pid(name).await {
                let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
                if String::from_utf8_lossy(&cmdline).contains(marker) {
                    let raw = std::fs::read(format!("/proc/{pid}/environ")).expect("environ");
                    return raw
                        .split(|b| *b == 0)
                        .filter_map(|kv| {
                            let kv = String::from_utf8_lossy(kv).into_owned();
                            kv.split_once('=')
                                .map(|(k, v)| (k.to_string(), v.to_string()))
                        })
                        .collect();
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "{name} never ran {marker}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    #[cfg(unix)]
    /// What a shim tmux answers when it is asked whether a session is there.
    ///
    /// tmux exits non-zero for every one but the first and says which in its
    /// own words on stderr, each sentence here the one tmux 3.6 prints. That
    /// sentence is the only thing parting a session this box does not hold
    /// from a server this box cannot reach, so a test that cannot produce each
    /// of them cannot reach the answers [`super::has_session`] gives.
    #[derive(Debug, Clone, Copy)]
    pub(crate) enum Asked {
        Present,
        /// A server that answered and holds no session by that name.
        Absent,
        /// A socket whose server exited with its last session: nothing listens.
        NoServer,
        /// A socket file that is not there: never made, or moved from under a
        /// server still running. tmux says the same words for both.
        NoSocket,
        /// A socket this box may not connect to: nobody was asked.
        Forbidden,
    }

    #[cfg(unix)]
    impl Asked {
        fn as_env(self) -> &'static str {
            match self {
                Asked::Present => "present",
                Asked::Absent => "absent",
                Asked::NoServer => "no-server",
                Asked::NoSocket => "no-socket",
                Asked::Forbidden => "forbidden",
            }
        }
    }

    #[cfg(unix)]
    /// A tmux that answers out of what the test set rather than out of a server.
    ///
    /// `RefusingKill` above hands everything it does not care about to the real
    /// tmux. This one hands over nothing, because the states it holds — a
    /// composer with a draft in it, a `capture-pane` that answers and a
    /// `paste-buffer` that does not, a server that cannot be reached — are
    /// states no real server on this box reaches on request. It journals every
    /// verb it is asked for, which is how a test reads back that nothing was
    /// typed at a pane after the capture refused the message.
    pub(crate) struct ShimTmux {
        _installed: Installed,
        log: std::path::PathBuf,
        _dir: crate::test_scratch::Scratch,
    }

    #[cfg(unix)]
    const SHIM: &str = r#"#!/bin/sh
[ "$1" = --forge-shim-probe ] && exit 0
verb=''
for a in "$@"; do
  case "$a" in
    has-session|capture-pane|load-buffer|paste-buffer|send-keys|kill-session|list-panes|display-message)
      verb="$a"; break ;;
  esac
done
printf '%s\n' "$verb" >> "$FORGE_TEST_TMUX_LOG"
if [ "$verb" = load-buffer ]; then cat > /dev/null 2>/dev/null; fi
if [ -n "$FORGE_TEST_TMUX_FAIL" ] && [ "$verb" = "$FORGE_TEST_TMUX_FAIL" ]; then
  echo "shim: tmux $verb was made to fail" >&2
  exit 1
fi
case "$verb" in
  has-session)
    case "$FORGE_TEST_TMUX_ASKED" in
      present) exit 0 ;;
      absent) echo "can't find session: shim" >&2; exit 1 ;;
      no-server) echo "no server running on /shim/tmux.sock" >&2; exit 1 ;;
      no-socket) echo "error connecting to /shim/tmux.sock (No such file or directory)" >&2; exit 1 ;;
      *) echo "error connecting to /shim/tmux.sock (Permission denied)" >&2; exit 1 ;;
    esac ;;
  capture-pane) cat "$FORGE_TEST_TMUX_CAPTURE"; exit 0 ;;
esac
exit 0
"#;

    #[cfg(unix)]
    impl ShimTmux {
        /// `fail` names the one verb the shim refuses, for the failures that
        /// happen after a pane has already answered alive and been read.
        pub(crate) fn installed(asked: Asked, capture: &str, fail: Option<&str>) -> Self {
            let dir = crate::test_scratch::Scratch::new("shim-tmux");
            let shim = dir.join("tmux");
            write_shim(&shim, SHIM);
            let capture_at = dir.join("capture.txt");
            std::fs::write(&capture_at, capture).expect("the capture is written");
            let log = dir.join("verbs.log");
            std::fs::write(&log, "").expect("the journal starts empty");
            let env = vec![
                ("FORGE_TEST_TMUX_ASKED", asked.as_env().into()),
                ("FORGE_TEST_TMUX_CAPTURE", capture_at.into_os_string()),
                ("FORGE_TEST_TMUX_FAIL", fail.unwrap_or("").into()),
                ("FORGE_TEST_TMUX_LOG", log.clone().into_os_string()),
            ];
            Self {
                _installed: Installed::new(shim, env),
                log,
                _dir: dir,
            }
        }

        /// Every verb the shim was asked for, in the order it was asked.
        pub(crate) fn verbs(&self) -> Vec<String> {
            std::fs::read_to_string(&self.log)
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }
    }

    #[cfg(unix)]
    pub(crate) fn shim_quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{cannot_run, UnaskableTmux, ONE_AT_A_TIME};
    #[cfg(unix)]
    use super::testing::{Asked, RefusingKill, ShimTmux};

    /// ISS-1306 round 2, criteria 13 and 15: the attach command names the
    /// socket master panes run on, quoted where the path needs it.
    #[test]
    fn the_attach_command_names_the_socket_panes_run_on() {
        let at = std::path::Path::new("/home/op/.config/forge-runner/tmux.sock");
        assert_eq!(
            super::attach_command_for(Some(at), "forge-master-p"),
            "tmux -S /home/op/.config/forge-runner/tmux.sock attach -t forge-master-p"
        );
        let spaced = std::path::Path::new("/home/o p/it's/tmux.sock");
        assert_eq!(
            super::attach_command_for(Some(spaced), "forge-master-p"),
            r"tmux -S '/home/o p/it'\''s/tmux.sock' attach -t forge-master-p"
        );
        assert_eq!(
            super::attach_command_for(None, "forge-master-p"),
            "tmux attach -t forge-master-p"
        );
    }

    /// Criterion 13 through the command the callers use (judge-109: dropping
    /// the socket from `attach_command` itself left every test green): where
    /// this box resolves the masters' socket, the command names it.
    #[cfg(unix)]
    #[test]
    fn the_attach_command_callers_use_carries_the_resolved_socket() {
        let _env = crate::auth::cred_store::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let iso = super::testing::IsolatedServer::new("attachcmd");
        if !iso.took() {
            super::testing::cannot_run(
                "this box does not resolve its tmux socket from the config dir, so there is no socket of the test's own to see named",
            );
            return;
        }
        let sock = super::socket_path().expect("the isolated socket");
        let said = super::attach_command("forge-master-p");
        assert_eq!(
            said,
            format!("tmux -S {} attach -t forge-master-p", sock.display()),
            "the command names the socket the masters' server listens on"
        );
    }

    /// Criterion 15: every place that tells a person how to open a master
    /// pane builds the command here, so none can drop the socket.
    #[test]
    fn no_attach_command_is_spelled_by_hand() {
        for (file, source) in [
            ("daemon/master.rs", include_str!("master.rs")),
            ("daemon/master_ask.rs", include_str!("master_ask.rs")),
            (
                "forge-runner/src/cmd/master.rs",
                include_str!("../../../forge-runner/src/cmd/master.rs"),
            ),
        ] {
            let production = source.split("#[cfg(test)]").next().unwrap_or(source);
            assert!(
                !production.contains("tmux attach -t"),
                "{file} spells an attach command by hand"
            );
        }
    }

    /// ISS-1312 criteria 67 and 68: a shim is handed to no tmux call while
    /// anything can still write it. A sibling thread's fork holds the write
    /// descriptor it inherited until that fork execs; the test holds one open
    /// itself, which is the same state for as long as it chooses.
    #[cfg(unix)]
    #[test]
    fn a_shim_is_handed_out_only_once_nothing_can_still_write_it() {
        use super::testing::{executable, until_it_runs, SHIM_PROBE};
        let dir = crate::test_scratch::Scratch::new("shim-busy");
        let shim = dir.join("tmux");
        std::fs::write(
            &shim,
            "#!/bin/sh\n[ \"$1\" = --forge-shim-probe ] && exit 0\nexit 0\n",
        )
        .unwrap();
        executable(&shim);
        let runs = || {
            std::process::Command::new(&shim)
                .arg(SHIM_PROBE)
                .status()
                .is_ok_and(|s| s.success())
        };
        let writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&shim)
            .unwrap();
        if cfg!(target_os = "linux") {
            assert!(
                !runs(),
                "the control: Linux refuses to run a file something can still write, and a tmux call handed it now answers 127"
            );
        }
        let held = std::time::Duration::from_millis(300);
        let letting_go = std::thread::spawn(move || {
            std::thread::sleep(held);
            drop(writer);
        });
        let asked = std::time::Instant::now();
        until_it_runs(&shim);
        if cfg!(target_os = "linux") {
            assert!(
                asked.elapsed() >= held,
                "criterion 67: handed out after {:?}, before the writer let go",
                asked.elapsed()
            );
        }
        letting_go.join().unwrap();
        assert!(runs(), "and once handed out it runs");
    }

    /// Criterion 67 for every shim here: none is made but through the writer,
    /// and the writer makes none that does not open with the probe. A shim
    /// added later is held to it by the writer, with no count to update.
    #[test]
    fn a_shim_that_does_not_open_with_the_probe_is_never_made() {
        use super::testing::write_shim;
        let dir = crate::test_scratch::Scratch::new("shim-unprobed");
        let shim = dir.join("tmux");
        let refused = std::panic::catch_unwind(|| write_shim(&shim, "#!/bin/sh\nexit 0\n"));
        assert!(
            refused.is_err(),
            "a shim with no probe was made, and nothing can tell when it is safe to run"
        );
        assert!(!shim.exists(), "and nothing was written");
        write_shim(
            &shim,
            "#!/bin/sh\n[ \"$1\" = --forge-shim-probe ] && exit 0\nexit 3\n",
        );
        #[cfg(unix)]
        {
            use super::testing::SHIM_PROBE;
            assert!(
                std::process::Command::new(&shim)
                    .arg(SHIM_PROBE)
                    .status()
                    .is_ok_and(|s| s.success()),
                "the probe is answered from the shim's own first line"
            );
        }
        let testing = THIS_SOURCE
            .split("pub(crate) mod testing")
            .nth(1)
            .and_then(|rest| rest.split("\nmod tests {").next())
            .expect("the module");
        assert!(
            !testing.contains("fs::write(&shim"),
            "a shim here is written past the writer that checks it"
        );
    }
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
        _stand_in: testing::StandIn,
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
                _stand_in: testing::StandIn::here(testing::SystemdSays::Itself),
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

    /// ISS-1223 criterion 42, as a property of the test build: a test is
    /// answered "no user manager" until it asks for this box's own, which only
    /// a test that holds the unit it places does.
    #[test]
    fn a_test_is_answered_no_unit_until_it_asks_for_the_boxs_own_manager() {
        assert!(
            matches!(systemd_stand_in(), Some(Placement::Unavailable(_))),
            "a test that said nothing about systemd must not reach it"
        );
        #[cfg(unix)]
        {
            let _own = testing::StandIn::here(testing::SystemdSays::Itself);
            assert!(
                systemd_stand_in().is_none(),
                "a test that holds its unit is answered by the box's manager"
            );
        }
        assert!(
            matches!(systemd_stand_in(), Some(Placement::Unavailable(_))),
            "and the answer goes back when it is done"
        );
    }

    /// ISS-1223 criterion 42, where it bit: an `IsolatedServer` test starts its
    /// server through `ensure`, and that must place no unit on this box. The
    /// unit it would place is stopped here either way, so a red run leaves
    /// nothing behind.
    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn an_isolated_test_server_is_placed_without_a_unit() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("nounitdefault");
        if !available() {
            testing::cannot_run("tmux is not installed here");
            return;
        }
        if !iso.took() {
            testing::cannot_run("this box does not resolve its tmux socket from the config dir");
            return;
        }
        let sock = socket_path().expect("the isolated socket");
        let unit = session_unit();
        let _stops_it = PlacedUnit::guarding(unit.clone(), sock);
        ensure_server().await;
        assert!(
            !unit_is_running(&unit).await,
            "{unit}.service was placed on this box's user manager by a test that asked for none"
        );
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
            let unaskable = UnaskableTmux::installed();
            assert!(
                !alive(&name).await,
                "this is the collapse the postcondition may not rest on: `alive` answers false for a probe that never ran, exactly as it does for a session that is gone"
            );
            assert!(
                kill(&name).await.is_err(),
                "a kill whose outcome could not be established is not a kill that took, and answering Ok here reports one on the strength of a question nobody answered"
            );
            assert!(unaskable.asked() > 0, "the questions went to the fake tmux");
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
            seen = read_prompt(&pane_target(name)).await.0;
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
            read_prompt(&pane_target(&name)).await.0,
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

    /// The same pane in the shape Claude Code's Rewind picker draws: the rows
    /// parted by blank lines, and the highlighted one alone between two of
    /// them. Under the immediate-neighbour reading this pane took the Enter
    /// and the message was lost (ISS-1272).
    const FAKE_REWIND: &str = r#"draw() { printf '\033[2J\033[H   Rewind\n\n     an earlier turn\n     No code changes\n\n   \342\235\257 (current)\n\n\n   Enter to continue \302\267 Esc to cancel\n'; }
draw
while IFS= read -r -n1 c; do
  if [ -z "$c" ]; then printf 'ENTER\n' >> "$OUT"; else printf 'KEY %s\n' "$c" >> "$OUT"; fi
  draw
done
"#;

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_choice_row_standing_between_blank_lines_is_refused_and_is_sent_no_key_at_all() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(_sandbox) = Sandbox::new("rewind") else {
            cannot_run("this box gives a test no tmux server of its own — nothing runs rather than reaching its real one");
            return;
        };
        if !available() {
            cannot_run("tmux is not installed here — the transport test cannot run");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("rewind");
        let script = dir.join("rewind.sh");
        std::fs::write(&script, FAKE_REWIND).expect("the fake picker is written");
        let keys = dir.join("rewind.keys");
        let name = session_name("forge-test", &format!("rewind{}", std::process::id()));
        let _ = kill(&name).await;
        ensure(
            &name,
            &dir,
            &["bash".to_string(), script.to_string_lossy().into_owned()],
            &[("OUT".into(), keys.to_string_lossy().into_owned())],
            None,
        )
        .await
        .expect("the picker pane must start");

        let picker = composer::Composer::Menu {
            highlighted: "(current)".into(),
        };
        assert_eq!(
            composer_reads(&name, &picker).await,
            picker,
            "the fake must draw the picker before anything is sent"
        );

        let refused = send_line(&name, "REWIND-MESSAGE")
            .await
            .expect_err("a row standing between blank lines is still a choice list");
        assert!(
            refused.to_string().contains("(current)"),
            "the refusal must quote the row that stood between the blanks: {refused}"
        );

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert_eq!(
            std::fs::read_to_string(&keys).unwrap_or_default(),
            "",
            "no key may reach it — the Enter this defect sent answered the picker"
        );
        kill(&name).await.expect("kill");
    }

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
            read_prompt(&pane_target(&name)).await.0,
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
        #[expect(
            clippy::disallowed_methods,
            reason = "the test puts its fake claude ahead of the PATH it read"
        )]
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

    /// ISS-1382's judge, carried into ISS-1344 r4 (criteria 26 and 27). With no
    /// unit for the session server — macOS, a container, no user manager — the
    /// daemon still holds the keepalive session, so the server outlives a
    /// master that was its only pane and the sweep reads that master as gone
    /// rather than as a tmux nobody could ask.
    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn with_no_unit_for_the_server_a_master_that_exits_reads_as_gone() {
        a_master_that_exits_reads_as_gone_when_systemd(testing::SystemdSays::NoUnit, false).await;
    }

    /// The same where systemd takes the unit and its server never answers.
    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn with_a_unit_that_never_answers_a_master_that_exits_reads_as_gone() {
        a_master_that_exits_reads_as_gone_when_systemd(
            testing::SystemdSays::UnitNeverAnswers,
            false,
        )
        .await;
    }

    /// ISS-1344 r5, from judge j6 (criterion 26). The upgrade path: an older
    /// runner left the session server up holding a session of its own and no
    /// keepalive. The master placed now outlives that session, so without the
    /// keepalive it is the server's last session and its exit takes the server.
    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn with_a_server_already_up_without_the_keepalive_a_master_that_exits_reads_as_gone() {
        a_master_that_exits_reads_as_gone_when_systemd(testing::SystemdSays::NoUnit, true).await;
    }

    #[cfg(unix)]
    #[allow(clippy::await_holding_lock)]
    async fn a_master_that_exits_reads_as_gone_when_systemd(
        says: testing::SystemdSays,
        already_up: bool,
    ) {
        use crate::daemon::recovery::MasterPresence;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("nounit");
        if !available() {
            testing::cannot_run("tmux is not installed here");
            return;
        }
        if !iso.took() {
            testing::cannot_run("this box does not resolve its tmux socket from the config dir");
            return;
        }
        let _stand_in = testing::StandIn::here(says);
        let cwd = crate::test_scratch::Scratch::new("nounit-cwd");
        let name = session_name(MASTER_PREFIX, &format!("nounit-{}", std::process::id()));
        // The older session outlives the placement and is ended after it, so the server is up
        // when the master is placed and the master is the last one standing when it exits.
        let older = session_name(RUN_PREFIX, &format!("older-{}", std::process::id()));
        if already_up {
            let up = tmux(&["new-session", "-d", "-s", &older, "sh", "-c", "sleep 60"])
                .await
                .expect("the older runner's session is started");
            assert!(up.status.success(), "the server is up before the daemon");
            assert!(
                !names_with_prefix("").await.contains(&KEEPALIVE.to_string()),
                "the server an older runner left holds no keepalive"
            );
        }
        let argv = ["sh", "-c", "sleep 2"].map(String::from);
        ensure(&name, cwd.path(), &argv, &[], None)
            .await
            .expect("the master is placed");
        if already_up {
            let ended = tmux(&["kill-session", "-t", &session_target(&older)])
                .await
                .expect("the older session is ended");
            assert!(ended.status.success(), "the older session was still there");
        }
        let held = names_with_prefix("").await.contains(&KEEPALIVE.to_string());
        // Read as the sweep reads, until the master's exit is read as one: a tmux slow to answer
        // under a loaded test run reads `Unanswered` for a moment, and only a server that is
        // gone reads it for the whole wait.
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let read = loop {
            let read = crate::daemon::recovery_ports::pane_presence(&name).await;
            if read == MasterPresence::Gone || std::time::Instant::now() >= deadline {
                break read;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        assert!(
            held && read == MasterPresence::Gone,
            "the keepalive is held: {held}; a master that exited reads {read:?}, not Gone"
        );
    }

    /// ISS-1390 criterion 2: a pane whose daemon runs on a PATH without the
    /// runner's directory resolves `forge-runner` only when handed the PATH
    /// this box builds, which `-e` alone does not deliver.
    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn a_pane_handed_a_built_path_resolves_the_runner_its_daemon_cannot() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("panepath");
        if !available() {
            testing::cannot_run("tmux is not installed here");
            return;
        }
        if !iso.took() {
            testing::cannot_run("this box does not resolve its tmux socket from the config dir");
            return;
        }
        let home = crate::test_scratch::Scratch::new("panepath-home");
        let bin = home.join(".local").join("bin");
        std::fs::create_dir_all(&bin).expect("bin");
        std::fs::write(bin.join("forge-runner"), "#!/bin/sh\nexit 0\n")
            .expect("the planted runner");
        testing::executable(&bin.join("forge-runner"));
        #[expect(
            clippy::disallowed_methods,
            reason = "the test reads its own PATH to show it does not reach the planted HOME"
        )]
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        assert!(
            which::which_in("forge-runner", Some(&inherited), "/")
                .map_or(true, |p| !p.starts_with(home.path())),
            "this process's own PATH does not reach the planted HOME"
        );
        let built =
            crate::daemon::pane_path::build(None, None, Some(home.path()), Some(&inherited));
        let out = home.join("probe.out");
        let probe = |label: &str| {
            vec![
                "sh".to_string(),
                "-c".to_string(),
                format!(
                    "command -v forge-runner > '{0}.{1}.part'; echo rc=$? >> '{0}.{1}.part'; mv '{0}.{1}.part' '{0}.{1}'",
                    out.display(),
                    label
                ),
            ]
        };
        let read = |label: &str| {
            let path = std::path::PathBuf::from(format!("{}.{label}", out.display()));
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            loop {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    return text;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "the pane wrote nothing"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        let pair = vec![("PATH".to_string(), built.to_string_lossy().into_owned())];
        ensure(
            "forge-job-panepath-built",
            home.path(),
            &probe("built"),
            &pair,
            None,
        )
        .await
        .expect("the pane starts");
        let handed = read("built");
        assert!(
            handed.contains(&bin.join("forge-runner").display().to_string())
                && handed.contains("rc=0"),
            "the pane handed the built PATH resolves the runner: {handed}"
        );
        let _ = kill("forge-job-panepath-built").await;
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
    #[expect(
        clippy::disallowed_methods,
        reason = "the test reads whether an operator set MCP_TOOL_TIMEOUT"
    )]
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
    /// This file as its tests read it, with a Windows checkout's CRLF made LF,
    /// so a needle spanning a line break matches on all three OSes (ISS-1274).
    static THIS_SOURCE: std::sync::LazyLock<String> =
        std::sync::LazyLock::new(|| include_str!("terminal.rs").replace("\r\n", "\n"));

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
            1,
            "one constructor builds every tmux, which is what lets a test put its own in place without moving PATH"
        );
        let spawns: Vec<&str> = production
            .split("tmux_command()\n        .args(")
            .skip(1)
            .collect();
        assert_eq!(
            spawns.len(),
            2,
            "the wrapper and load-buffer are the only two, and both take the socket's args"
        );
        assert!(
            production.contains("let mut all = socket_args_for(socket.as_deref());")
                && spawns[0].starts_with("&all)"),
            "the wrapper builds its args from the socket and passes them"
        );
        assert!(
            production.contains("let mut load = socket_args();") && spawns[1].starts_with("&load)"),
            "load-buffer builds its args from the socket and passes them"
        );
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
            for call in calls(&THIS_SOURCE, needle) {
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
        let _stand_in = testing::StandIn::here(testing::SystemdSays::Itself);
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

    const SHIM_PANE: &str = "forge-test-shim";

    // cm:guard not on Windows: `shim_composer` feeds only the two tests below it, both gated
    // off Windows for the same reason those tests carry on their own `cfg` — see there.
    #[cfg(not(windows))]
    /// A capture drawn the way Claude Code draws its composer, holding `body`.
    fn shim_composer(body: &str) -> String {
        let rule = "\u{2500}".repeat(12);
        format!("\u{25cf} earlier output\n{rule}\n\u{276f}\u{a0}{body}\n{rule}\n  footer\n")
    }

    /// The refusals `send_line` mints, each one now a variant and each one
    /// still the sentence it was before ISS-1265 typed them.
    ///
    /// A shim tmux rather than a real one: `Presence::Unaskable` is a server
    /// this box cannot reach, which no real server reaches on request, and the
    /// wording that parts it from an absent session is the whole subject.
    // cm:guard not on Windows: the shim is a `#!/bin/sh` script Windows cannot spawn, so no
    // state it answers is reachable there; priced in full beside `shim_tmux` in `inbox.rs`.
    #[cfg(not(windows))]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn every_refusal_carries_the_sentence_it_always_carried() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        {
            let _tmux = ShimTmux::installed(Asked::Absent, &shim_composer(""), None);
            let why = send_line(SHIM_PANE, "MESSAGE")
                .await
                .expect_err("tmux said it holds no such session");
            assert_eq!(why, NotTyped::Gone(SHIM_PANE.to_string()));
            assert_eq!(
                why.to_string(),
                format!("no session named {SHIM_PANE}"),
                "the sentence a caller reads is unchanged"
            );
        }

        {
            let _tmux = ShimTmux::installed(Asked::NoServer, &shim_composer(""), None);
            let why = send_line(SHIM_PANE, "MESSAGE")
                .await
                .expect_err("no server runs on the socket, so no session does");
            assert_eq!(
                why,
                NotTyped::Gone(SHIM_PANE.to_string()),
                "tmux said no server runs on the runner's own socket, and a server that is not running holds no session"
            );
        }

        for asked in [Asked::Forbidden, Asked::NoSocket] {
            let _tmux = ShimTmux::installed(asked, &shim_composer(""), None);
            let why = send_line(SHIM_PANE, "MESSAGE")
                .await
                .expect_err("tmux could not reach a server, so nothing was typed");
            assert!(
                matches!(why, NotTyped::Failed(_)),
                "a server this box could not reach ({asked:?}) is not a session that ended: {why:?}"
            );
            assert!(
                why.to_string().contains("could not be asked"),
                "and it says so rather than naming an absent session: {why}"
            );
        }

        {
            let _tmux = ShimTmux::installed(
                Asked::Present,
                &shim_composer("LEFTOVER-FROM-SOMEWHERE-ELSE"),
                None,
            );
            let why = send_line(SHIM_PANE, "MESSAGE")
                .await
                .expect_err("a composer holding text refuses the send");
            assert!(matches!(why, NotTyped::Refused(_)), "{why:?}");
            let said = why.to_string();
            assert!(
                said.contains("nothing was typed") && said.contains("LEFTOVER-FROM-SOMEWHERE-ELSE"),
                "the refusal still quotes what was at the prompt: {said}"
            );
        }

        {
            let menu = " Do you want to proceed?\n   1. Yes\n \u{276f} 2. No\n\n Esc to cancel";
            let _tmux = ShimTmux::installed(Asked::Present, menu, None);
            let why = send_line(SHIM_PANE, "MESSAGE")
                .await
                .expect_err("a choice list refuses the send");
            assert!(matches!(why, NotTyped::Refused(_)), "{why:?}");
            assert!(
                why.to_string().contains("choice list"),
                "the refusal still names the list: {why}"
            );
        }

        for verb in ["load-buffer", "paste-buffer", "send-keys"] {
            let _tmux = ShimTmux::installed(Asked::Present, &shim_composer(""), Some(verb));
            let why = send_line(SHIM_PANE, "MESSAGE")
                .await
                .expect_err("the verb the shim refuses stops the typing");
            assert!(
                matches!(why, NotTyped::Failed(_)),
                "tmux broke at {verb} after the pane answered alive, which is no ending: {why:?}"
            );
        }
    }

    /// ISS-1382 judging: the older trust dialog, drawn with its marker at
    /// column zero as judge j4's stub drew it, is no choice list to the
    /// composer, and the send path typed the brief into it. Its own words
    /// refuse the paste, and nothing reaches the pane.
    // cm:guard not on Windows: the shim is a `#!/bin/sh` script Windows cannot spawn; see above.
    #[cfg(not(windows))]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_trust_dialog_the_composer_cannot_read_is_still_not_typed_into() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let older = "\x1b[1mDo you trust the files in this folder?\x1b[0m\n\n/tmp/j8e45/repo\n\nClaude Code may read files in this folder.\n\n\x1b[36m\u{276f} 1. Yes, proceed\x1b[0m\n  2. No, exit\n\nEnter to confirm \u{b7} Esc to exit\n\n\n";
        assert_eq!(
            composer::read(older),
            composer::Composer::Unrecognised,
            "the control: the composer reads no menu on this screen"
        );
        let tmux = ShimTmux::installed(Asked::Present, older, None);
        let why = send_line(SHIM_PANE, "MESSAGE")
            .await
            .expect_err("a trust dialog refuses the send");
        assert!(matches!(why, NotTyped::Refused(_)), "{why:?}");
        let said = why.to_string();
        assert!(
            said.contains("nothing was typed")
                && said.contains("folder-trust dialog")
                && said.contains("hasTrustDialogAccepted"),
            "{said}"
        );
        let verbs = tmux.verbs();
        assert!(
            !verbs
                .iter()
                .any(|v| v == "load-buffer" || v == "paste-buffer" || v == "send-keys"),
            "nothing was handed to the pane: {verbs:?}"
        );
    }

    /// The branch the shim cannot reach: tmux is not runnable at all, so the
    /// spawn fails and no process ever answers. What the inbox does with the
    /// classification is proved three other ways in `daemon/inbox.rs`.
    #[tokio::test]
    async fn a_tmux_that_cannot_be_run_at_all_is_not_a_session_that_ended() {
        let no_tmux = UnaskableTmux::installed();
        let why = send_line(SHIM_PANE, "MESSAGE")
            .await
            .expect_err("nothing could be asked, so nothing was typed");
        assert!(no_tmux.asked() > 0, "the question went to the fake tmux");
        assert!(
            matches!(why, NotTyped::Failed(_)),
            "a question nobody answered is not a session that ended: {why:?}"
        );
        assert!(
            !why.to_string().contains("no session named"),
            "and it may not borrow the sentence minted for one: {why}"
        );
    }

    /// ISS-1312: the fakes of tmux used to move `PATH`, and the one that
    /// emptied it failed every `git` spawned by name beside it.
    #[test]
    fn a_fake_tmux_leaves_the_process_environment_as_it_found_it() {
        // `pane_path`'s tests replace PATH under this lock; read without it, theirs is read.
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        #[expect(
            clippy::disallowed_methods,
            reason = "the test reads the fake tmux's variables to see them put back"
        )]
        let read = || {
            [
                "PATH",
                "FORGE_TEST_TMUX_ASKED",
                "FORGE_TEST_TMUX_CAPTURE",
                "FORGE_TEST_TMUX_FAIL",
                "FORGE_TEST_TMUX_LOG",
            ]
            .map(std::env::var_os)
        };
        let before = read();
        let _unaskable = UnaskableTmux::installed();
        #[cfg(not(windows))]
        let _shim = ShimTmux::installed(Asked::Present, "", Some("send-keys"));
        assert_eq!(
            read(),
            before,
            "a fake tmux is the installing thread's, never a change to the process"
        );
    }

    #[test]
    fn a_fake_tmux_is_not_what_another_thread_spawns() {
        let _unaskable = UnaskableTmux::installed();
        let here = tmux_command().as_std().get_program().to_os_string();
        let there = std::thread::spawn(|| tmux_command().as_std().get_program().to_os_string())
            .join()
            .unwrap();
        assert_ne!(here, "tmux", "this thread spawns the fake");
        assert_eq!(
            there, "tmux",
            "a test spawning tmux beside this one would reach the fake"
        );
    }

    #[test]
    fn a_fake_tmux_taken_inside_another_gives_the_outer_one_back() {
        let outer = UnaskableTmux::installed();
        let outer_program = tmux_command().as_std().get_program().to_os_string();
        {
            let _inner = UnaskableTmux::installed();
            assert_ne!(tmux_command().as_std().get_program(), outer_program);
        }
        assert_eq!(tmux_command().as_std().get_program(), outer_program);
        drop(outer);
        assert_eq!(tmux_command().as_std().get_program(), "tmux");
    }

    /// `alive` answers exactly what it answered before `has_session` was split
    /// out under it: true only where tmux exited zero.
    // cm:guard not on Windows: same shim, same reason as `every_refusal_carries_the_sentence_
    // it_always_carried` above — its `cfg` doc-comments the trade in full.
    #[cfg(not(windows))]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn alive_still_collapses_the_two_answers_that_are_not_present() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for (asked, want) in [
            (Asked::Present, true),
            (Asked::Absent, false),
            (Asked::NoServer, false),
            (Asked::NoSocket, false),
            (Asked::Forbidden, false),
        ] {
            let _tmux = ShimTmux::installed(asked, &shim_composer(""), None);
            assert_eq!(
                alive(SHIM_PANE).await,
                want,
                "alive on {asked:?} must not move: every other caller reads this bool"
            );
        }
    }

    /// What tmux itself answers `has-session` on a socket of the test's own,
    /// read raw: the plant the two tests below rest on.
    #[cfg(unix)]
    async fn tmux_said(name: &str) -> String {
        let out = tmux(&["has-session", "-t", &session_target(name)])
            .await
            .expect("tmux runs");
        String::from_utf8_lossy(&out.stderr).trim().to_string()
    }

    /// ISS-1265 round 3, F3: tmux 3.6 answers `no server running on <sock>`
    /// for a session that ended as its server's last, because `exit-empty`
    /// takes the server with it. Read on a real server, not a shim, since what
    /// tmux prints there is the whole subject.
    #[cfg(unix)]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_session_that_ended_as_its_servers_last_is_absent() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("lastgone");
        if !available() {
            cannot_run("tmux is not installed here — the read this rests on cannot run");
            return;
        }
        if !iso.took() {
            cannot_run("this box does not resolve its tmux socket from the config dir, so the only server here is its own — not ending a session on it");
            return;
        }
        let name = session_name(MASTER_PREFIX, "lastgone");
        let started = tmux(&["new-session", "-d", "-s", &name, "sleep 60"])
            .await
            .expect("tmux runs");
        assert!(started.status.success(), "the session must start");
        assert_eq!(has_session(&name).await, Presence::Present);
        testing::end_the_last_session(&name).await;
        let said = tmux_said(&name).await;
        assert!(
            said.contains("no server running on"),
            "the plant: the server went with its last session, so tmux says no server runs there: {said}"
        );
        assert_eq!(
            has_session(&name).await,
            Presence::Absent,
            "a server that is not running on the runner's own socket holds no session by any name"
        );
        assert_eq!(
            send_line(&name, "MESSAGE").await,
            Err(NotTyped::Gone(name.clone())),
            "and a message to it is refused as a session that ended"
        );
    }

    /// Consult F1: where no socket was resolved, tmux goes to its default one,
    /// and the line names the path tmux said rather than no path at all.
    #[test]
    fn the_missing_socket_line_names_the_socket_tmux_tried() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let said = logged_while_missing(
            "error connecting to /tmp/tmux-1000/default (No such file or directory)\n",
        );
        assert!(
            said.contains("/tmp/tmux-1000/default"),
            "the socket tmux tried is named: {said}"
        );
    }

    /// What `missing_socket::say` logs for `said`, from a fresh episode.
    fn logged_while_missing(said: &str) -> String {
        missing_socket::answered(socket_path());
        let logged =
            crate::log_capture::logged_while(|| missing_socket::say("forge-test-named", said));
        missing_socket::answered(socket_path());
        logged
    }

    /// ISS-1265 round 4, the master's ruling of 2026-10-19: tmux says the same
    /// words for a socket never made as for one moved from under a running
    /// server, so neither is read as absence.
    #[cfg(unix)]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_socket_no_server_ever_made_is_a_question_nobody_answered() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("neverserved");
        if !available() {
            cannot_run("tmux is not installed here — the read this rests on cannot run");
            return;
        }
        if !iso.took() {
            cannot_run("this box does not resolve its tmux socket from the config dir, so the only server here is its own — not asking it");
            return;
        }
        let name = session_name(MASTER_PREFIX, "neverserved");
        let said = tmux_said(&name).await;
        assert!(
            said.contains("No such file or directory"),
            "the plant: no server ever made this socket: {said}"
        );
        assert_eq!(has_session(&name).await, Presence::Unaskable);
    }

    /// ISS-1265 round 4, judge-51's finding: a server keeps running after its
    /// socket file is moved, and tmux answers every client as it would for a
    /// socket never made. A running master read there as absent is acked
    /// `gone`, briefed `no session named …` and killed on paper.
    #[cfg(unix)]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_running_session_whose_socket_file_was_moved_is_unaskable() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("moved");
        if !available() {
            cannot_run("tmux is not installed here — the read this rests on cannot run");
            return;
        }
        if !iso.took() {
            cannot_run("this box does not resolve its tmux socket from the config dir, so the only server here is its own — not moving its socket");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("terminal-moved");
        let name = session_name(MASTER_PREFIX, "moved");
        ensure(
            &name,
            &dir,
            &["sleep".to_string(), "60".to_string()],
            &[],
            None,
        )
        .await
        .expect("the master pane must start");
        assert_eq!(has_session(&name).await, Presence::Present);

        let moved = testing::MovedSocket::aside();
        let said = tmux_said(&name).await;
        assert!(
            said.contains("No such file or directory"),
            "the plant: the server runs and its socket file is not there: {said}"
        );
        assert_eq!(
            has_session(&name).await,
            Presence::Unaskable,
            "the server still holds this session; nobody could ask it"
        );
        let typed = send_line(&name, "MESSAGE").await;
        assert!(
            matches!(&typed, Err(NotTyped::Failed(said)) if said.contains("could not be asked")),
            "a message to a running master whose socket moved is not a session that ended: {typed:?}"
        );
        let briefed = brief_new_pane(&name, "BRIEF")
            .await
            .expect_err("nothing could be asked, so nothing was typed")
            .to_string();
        assert!(
            briefed.contains("could not be asked") && !briefed.contains("no session named"),
            "the brief says the question went unanswered: {briefed}"
        );
        let killed = kill(&name).await;
        assert!(
            killed.is_err(),
            "a kill tmux could not deliver is not a kill that took: {killed:?}"
        );

        moved.put_back();
        assert_eq!(
            has_session(&name).await,
            Presence::Present,
            "the socket is back and the session it never lost answers"
        );
    }

    /// ISS-1265 round 5, judge-56: the line names exactly the panes placed on
    /// the missing socket and not ended, so a fixed list, or one read across
    /// sockets, does not pass here.
    #[cfg(unix)]
    #[test]
    fn the_missing_socket_line_names_exactly_the_panes_placed_on_that_socket() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _iso = testing::IsolatedServer::new("c31list");
        let socket = socket_path();
        let elsewhere = Some(std::path::PathBuf::from("/nonexistent/forge-c31/tmux.sock"));
        // Named for this process, so no list fixed in the code can match them.
        let [a, b, ended, other] = ["c31-a", "c31-b", "c31-ended", "c31-other"]
            .map(|n| session_name(MASTER_PREFIX, &format!("{n}-{}", std::process::id())));
        for name in [&b, &a, &ended] {
            missing_socket::placed(socket.clone(), name);
        }
        missing_socket::placed(elsewhere.clone(), &other);
        missing_socket::forgotten(&socket, &ended);
        let shown = socket
            .as_deref()
            .expect("a socket of the test's own")
            .display()
            .to_string();
        let said = logged_while_missing(&format!(
            "error connecting to {shown} (No such file or directory)\n"
        ));
        for name in [&a, &b] {
            missing_socket::forgotten(&socket, name);
        }
        missing_socket::forgotten(&elsewhere, &other);
        assert!(
            said.contains(&format!("placed {a}, {b} on")),
            "exactly the two panes still placed on that socket: {said}"
        );
        assert!(
            !said.contains(&ended) && !said.contains(&other),
            "never a pane ended since, nor one placed on another socket: {said}"
        );
    }

    /// `/proc/net/unix` rows as Linux writes them: a padded inode, a path
    /// holding a space, a connected socket bound to the same path, and an
    /// unbound one.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_listening_row_names_its_path_and_no_other_row_does() {
        let rows = [
            "0000000000000000: 00000002 00000000 00010000 0001 01   996 /x/a b/tmux.sock",
            "0000000000000000: 00000003 00000000 00000000 0001 03 39320 /x/a b/tmux.sock",
            "0000000000000000: 00000003 00000000 00000000 0001 03 39321",
        ];
        let read: Vec<_> = rows.iter().map(|r| listening_path(r)).collect();
        assert_eq!(
            read,
            [Some(std::path::Path::new("/x/a b/tmux.sock")), None, None]
        );
    }

    /// Starts a master pane named for `tag` on the test's own server.
    #[cfg(unix)]
    async fn placed_master(tag: &str, dir: &std::path::Path) -> String {
        let name = session_name(MASTER_PREFIX, tag);
        ensure(
            &name,
            dir,
            &["sleep".to_string(), "60".to_string()],
            &[],
            None,
        )
        .await
        .expect("the master pane must start");
        name
    }

    /// A placement of `tag` on the test's own server, with the error it met.
    #[cfg(unix)]
    async fn placing(tag: &str, dir: &std::path::Path) -> (String, Result<bool>) {
        let name = session_name(MASTER_PREFIX, tag);
        let placed = ensure(
            &name,
            dir,
            &["sleep".to_string(), "60".to_string()],
            &[],
            None,
        )
        .await;
        (name, placed)
    }

    /// ISS-1265 round 5, judge-56: the missing-socket line names how to find
    /// the server it asks a person to signal. Run as written, on a real tmux
    /// server whose file was moved, the command prints that server's pid, and
    /// SIGUSR1 to it makes tmux put its socket back.
    #[cfg(unix)]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn the_missing_socket_line_names_the_command_that_finds_the_server() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("sigusr");
        if !available() {
            cannot_run("tmux is not installed here — the read this rests on cannot run");
            return;
        }
        if !iso.took() {
            cannot_run("this box does not resolve its tmux socket from the config dir, so the only server here is its own — not moving its socket");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("terminal-sigusr");
        let name = placed_master("sigusr", &dir).await;
        let (_, server) = served().await.expect("the server says which pid it is");
        let moved = testing::MovedSocket::aside();
        let socket = moved.socket().display().to_string();
        let (said, _logs) = crate::log_capture::capturing();
        assert_eq!(has_session(&name).await, Presence::Unaskable);
        let log = said.said();
        let line = log
            .lines()
            .find(|l| l.contains("ERROR") && l.contains(&socket))
            .unwrap_or_else(|| panic!("an error-level line names the missing socket: {log}"));
        assert!(line.contains("SIGUSR1"), "{line}");
        assert!(
            line.contains(&format!("(`kill -USR1 {server}`)")),
            "the line signals the server's own pid, not a placeholder: {line}"
        );
        let command = line
            .split('`')
            .find(|part| part.starts_with("pgrep "))
            .unwrap_or_else(|| panic!("the line names the command that finds the server: {line}"));
        let out = std::process::Command::new("sh")
            .args(["-c", command])
            .output()
            .expect("sh runs");
        let printed = String::from_utf8_lossy(&out.stdout).into_owned();
        let pid: i32 = printed
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("`{command}` prints one pid, the server's: {printed}"));
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid),
            nix::sys::signal::Signal::SIGUSR1,
        )
        .expect("the server takes SIGUSR1");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !moved.socket().exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "SIGUSR1 to pid {pid} never made the socket file again"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        moved.discard_aside();
        assert_eq!(
            has_session(&name).await,
            Presence::Present,
            "the server that was signalled is the one running the master"
        );
    }

    /// ISS-1265 round 5, the master's ruling on the placement residual: with
    /// the socket file gone and panes placed on it, a placement would start a
    /// second server on that path, which answers `can't find session` for every
    /// master the first still runs. It is refused instead, and starts nothing;
    /// once the file is back, the same placement goes ahead.
    #[cfg(unix)]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_placement_on_a_gone_socket_with_panes_placed_is_refused_and_starts_nothing() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("placemoved");
        if !available() {
            cannot_run("tmux is not installed here — the read this rests on cannot run");
            return;
        }
        if !iso.took() {
            cannot_run("this box does not resolve its tmux socket from the config dir, so the only server here is its own — not moving its socket");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("terminal-placemoved");
        let first = placed_master("placemoved", &dir).await;
        let (_, server) = served().await.expect("the server says which pid it is");
        let moved = testing::MovedSocket::aside();
        let socket = moved.socket().display().to_string();
        let (said, _logs) = crate::log_capture::capturing();
        let (next, placed) = placing("placemoved-next", &dir).await;
        let socket_made = moved.socket().exists();
        let why = placed
            .expect_err("a second server on that path would orphan the first one's masters")
            .to_string();
        assert!(
            why.contains(&socket) && why.contains(&first) && why.contains("SIGUSR1"),
            "the refusal names the socket, the pane placed on it and the recovery: {why}"
        );
        assert!(
            why.contains(&format!("(`kill -USR1 {server}`)")),
            "the recovery signals that server's own pid: {why}"
        );
        let (_, twice) = placing("placemoved-next", &dir).await;
        assert!(twice.is_err(), "still refused while the file stays gone");
        let log = said.said();
        let refusals: Vec<&str> = log
            .lines()
            .filter(|l| l.contains("ERROR") && l.contains("was not placed"))
            .collect();
        assert!(
            refusals.len() == 1 && refusals[0].contains(&next) && refusals[0].contains(&first),
            "the refusal is said at error level, once while the file stays gone: {log}"
        );
        assert!(
            !socket_made,
            "no server was started on that path, so no socket file was made there"
        );
        moved.put_back();
        assert_eq!(
            has_session(&first).await,
            Presence::Present,
            "the server whose file was moved still runs what it ran"
        );
        assert_eq!(has_session(&next).await, Presence::Absent);
        let (_, again) = placing("placemoved-next", &dir).await;
        assert!(
            again.expect("the socket answers again, so the placement goes ahead"),
            "and it places the pane"
        );
        assert_eq!(has_session(&next).await, Presence::Present);
    }

    /// ISS-1265 round 5: a daemon that restarted while the file was gone holds
    /// no record of what it placed, and the kernel still lists the old server
    /// listening on that path, which is enough to refuse.
    #[cfg(target_os = "linux")]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_placement_with_no_record_is_refused_while_a_server_still_listens_on_the_path() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("placelisten");
        if !available() {
            cannot_run("tmux is not installed here — the read this rests on cannot run");
            return;
        }
        if !iso.took() {
            cannot_run("this box does not resolve its tmux socket from the config dir, so the only server here is its own — not moving its socket");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("terminal-placelisten");
        let first = placed_master("placelisten", &dir).await;
        let moved = testing::MovedSocket::aside();
        missing_socket::forgotten(&socket_path(), &first);
        let socket = moved.socket().display().to_string();
        let (_, placed) = placing("placelisten-next", &dir).await;
        let socket_made = moved.socket().exists();
        let why = placed
            .expect_err("the kernel still lists a server on that path")
            .to_string();
        assert!(
            why.contains(&socket) && why.contains("still listens"),
            "the refusal names the socket and the server still listening on it: {why}"
        );
        assert!(!socket_made, "no server was started on that path");
    }

    /// ISS-1265 round 5, consult F1: a listing that cannot be read is not an
    /// empty one, so with the file gone the placement is refused naming the
    /// read that failed.
    #[cfg(target_os = "linux")]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_placement_on_a_gone_socket_is_refused_where_the_listing_cannot_be_read() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("placeunread");
        if !available() {
            cannot_run("tmux is not installed here — the read this rests on cannot run");
            return;
        }
        if !iso.took() {
            cannot_run("this box does not resolve its tmux socket from the config dir, so the only server here is its own — not asking it");
            return;
        }
        let socket = socket_path().expect("a socket of the test's own");
        let dir = crate::test_scratch::Scratch::new("terminal-placeunread");
        let _unread = testing::UnreadListing::here();
        let (_, placed) = placing("placeunread", &dir).await;
        let socket_made = socket.exists();
        let why = placed
            .expect_err("whether a server still listens there was not read")
            .to_string();
        assert!(
            why.contains("/proc/net/unix") && why.contains(&socket.display().to_string()),
            "the refusal names the read that failed and the socket: {why}"
        );
        assert!(!socket_made, "no server was started on that path");
    }

    /// ISS-1265 round 5, the ruling's other half: a socket file never made,
    /// with no pane placed on it and no server listening there, is a cold
    /// start, and the placement starts the server.
    #[cfg(unix)]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_placement_on_a_socket_never_made_starts_the_server() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("placefresh");
        if !available() {
            cannot_run("tmux is not installed here — the read this rests on cannot run");
            return;
        }
        if !iso.took() {
            cannot_run("this box does not resolve its tmux socket from the config dir, so the only server here is its own — not placing on it");
            return;
        }
        let socket = socket_path().expect("a socket of the test's own");
        assert!(!socket.exists(), "the plant: no socket file was ever made");
        let dir = crate::test_scratch::Scratch::new("terminal-placefresh");
        let (name, placed) = placing("placefresh", &dir).await;
        assert!(placed.expect("a cold start places"), "and places the pane");
        assert_eq!(has_session(&name).await, Presence::Present);
        let (path, pid) = served().await.expect("the server says where it serves");
        assert_eq!(
            path, socket,
            "in its own words, the socket it was started on"
        );
        assert!(pid > 1, "and as which pid: {pid}");
    }

    /// A process standing in for a tmux server: `ps` shows `tmux` in its argv.
    #[cfg(unix)]
    fn a_tmux_stand_in() -> std::process::Child {
        std::process::Command::new("sh")
            .args(["-c", "sleep 30; :", "tmux-stand-in"])
            .spawn()
            .expect("sh runs")
    }

    /// ISS-1265 round 5, consult F1: with no socket resolved the panes go to
    /// tmux's default server, and its file going missing refuses a placement
    /// just the same, at the path and pid that server last gave, while that
    /// pid is still the process that gave it (round 6).
    #[cfg(unix)]
    #[test]
    fn a_placement_on_the_default_server_whose_file_is_gone_is_refused() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let gone = crate::test_scratch::Scratch::new("default-gone");
        let path = gone.join("tmux-1000").join("default");
        let pane = session_name(MASTER_PREFIX, &format!("defgone-{}", std::process::id()));
        assert_eq!(
            missing_socket::refusal("forge-next", &None),
            None,
            "nothing is known of the default server before a pane is placed on it"
        );
        // The server still listens where its file was, as a running one does.
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("its directory");
        let listener =
            std::os::unix::net::UnixListener::bind(&path).expect("a listener of the test's own");
        std::fs::remove_file(&path).expect("its file goes");
        let mut server = a_tmux_stand_in();
        let pid = server.id();
        missing_socket::default_served(Some((path.clone(), pid)));
        missing_socket::placed(None, &pane);
        let refused = missing_socket::refusal("forge-next", &None);
        missing_socket::forgotten(&None, &pane);
        missing_socket::default_served(None);
        drop(listener);
        let _ = server.kill();
        let _ = server.wait();
        let refused = refused.expect("a second default server would orphan the first's panes");
        assert!(
            refused.contains(&path.display().to_string())
                && refused.contains(&pane)
                && refused.contains(&format!("kill -USR1 {pid}")),
            "names the default socket, the pane on it and the pid it answered as: {refused}"
        );
    }

    /// ISS-1265 round 6, consult F1: a pid is a server only while the process
    /// holding it started when the server did; the kernel hands a freed pid
    /// to the next process that asks.
    #[cfg(unix)]
    #[test]
    fn a_default_server_pid_now_held_by_another_process_holds_nothing_back() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let gone = crate::test_scratch::Scratch::new("default-reused");
        let path = gone.join("tmux-1000").join("default");
        let pane = session_name(MASTER_PREFIX, &format!("defreuse-{}", std::process::id()));
        let mut other = a_tmux_stand_in();
        missing_socket::default_served_as(Some((
            path.clone(),
            other.id(),
            Some("Thu Jan  1 00:00:00 1970".to_string()),
        )));
        missing_socket::placed(None, &pane);
        let reused = missing_socket::server_process(&None, &path);
        let refused = missing_socket::refusal("forge-next", &None);
        missing_socket::forgotten(&None, &pane);
        missing_socket::default_served(Some((path.clone(), other.id())));
        let same = missing_socket::server_process(&None, &path);
        missing_socket::default_served(None);
        let _ = other.kill();
        let _ = other.wait();
        assert_eq!(
            reused,
            Ok(None),
            "the pid runs, but not as the process that gave it"
        );
        assert_eq!(
            same,
            Ok(Some(other.id())),
            "the plant: the same pid read with its own start is the server"
        );
        assert_eq!(refused, None, "so nothing waits on that server");
    }

    /// ISS-1265 round 6: a server runs where the kernel lists a listener or
    /// the process started as it runs; a readable listing with neither, or
    /// off Linux a process check that found none, is a server that ended;
    /// anything less is not known.
    #[test]
    fn a_server_is_read_from_the_listing_and_the_process_together() {
        use missing_socket::{serving_from, Listing, Serving};
        let unread = || Listing::Unread("reading /proc/net/unix: denied".to_string());
        let failed = || Err::<Option<u32>, _>("`pgrep` could not be run".to_string());
        let runs = |s: &Serving| matches!(s, Serving::Runs { .. });
        let ended = |s: &Serving| matches!(s, Serving::Ended(_));
        let unknown = |s: &Serving| matches!(s, Serving::Unknown(_));
        for process in [Ok(Some(7)), Ok(None), failed()] {
            assert!(runs(&serving_from(Listing::Listens, process)));
        }
        assert!(
            ended(&serving_from(Listing::Silent, Ok(Some(7)))),
            "a readable listing with no listener settles it, whatever else carries the argv"
        );
        for listing in [unread(), Listing::NotKept] {
            assert_eq!(
                serving_from(listing, Ok(Some(7))),
                Serving::Runs {
                    pid: Some(7),
                    why: "the tmux server started on that path still runs as pid 7".to_string()
                }
            );
        }
        assert!(ended(&serving_from(Listing::Silent, Ok(None))));
        assert!(ended(&serving_from(Listing::Silent, failed())));
        assert!(ended(&serving_from(Listing::NotKept, Ok(None))));
        assert!(unknown(&serving_from(unread(), Ok(None))));
        assert!(unknown(&serving_from(unread(), failed())));
        assert!(unknown(&serving_from(Listing::NotKept, failed())));
        assert_eq!(
            serving_from(Listing::Listens, Ok(Some(9))),
            Serving::Runs {
                pid: Some(9),
                why: "a tmux server still listens on that path".to_string()
            },
            "a listener found by its process too names that process's pid"
        );
    }

    /// ISS-1265 round 6: a record taken while a listing was in flight is not
    /// a pane that listing left out.
    #[test]
    fn a_pane_placed_after_a_listing_was_asked_is_kept() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let socket = Some(std::path::PathBuf::from(format!(
            "/nonexistent/forge-listed-{}/tmux.sock",
            std::process::id()
        )));
        let [before, after] = ["before", "after"].map(|n| format!("forge-master-{n}"));
        missing_socket::placed(socket.clone(), &before);
        let asked = std::time::Instant::now();
        std::thread::sleep(Duration::from_millis(2));
        missing_socket::placed(socket.clone(), &after);
        missing_socket::listed(&socket, asked, &std::collections::BTreeSet::new());
        let still = missing_socket::placed_on(&socket);
        missing_socket::ended(&socket, None, std::time::Instant::now());
        assert_eq!(
            still,
            vec![after],
            "the pane placed before the listing was asked, and absent from it, ended"
        );
        assert!(
            missing_socket::placed_on(&socket).is_empty(),
            "no server on the socket ends every pane on it"
        );
    }

    /// Returns once the kernel lists nothing listening at `path`. A sibling
    /// test that forked while this process held the listener keeps a copy of
    /// it until that fork execs, so the listing can outlive the drop, and a
    /// placement refused then is right to be (judge-68, ISS-1265 round 7).
    #[cfg(target_os = "linux")]
    fn until_nothing_listens(path: &std::path::Path) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            match listing(path) {
                missing_socket::Listing::Silent => return,
                other => assert!(
                    std::time::Instant::now() < deadline,
                    "the kernel still reads {} as {other:?} 10s after the test closed its listener",
                    path.display()
                ),
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// ISS-1265 round 5, the second read's F1: a daemon restarted on Linux
    /// with no socket resolved holds no placement on the default server, and
    /// the path tmux names missing is enough to ask the kernel whether that
    /// server still listens there.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_restarted_daemon_refuses_a_default_server_still_listening_where_its_file_was() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let scratch = crate::test_scratch::Scratch::short("dflisten");
        let _xdg = ScopedVar::set("XDG_CONFIG_HOME", scratch.join("d".repeat(100)));
        assert_eq!(
            socket_path(),
            None,
            "the plant: no socket resolves, so panes go to the default server"
        );
        let path = scratch.join("default");
        let listener =
            std::os::unix::net::UnixListener::bind(&path).expect("a listener of the test's own");
        std::fs::remove_file(&path).expect("its file goes, as a cleaner of /tmp removes it");
        missing_socket::answered(None);
        missing_socket::say(
            "forge-asked",
            &format!(
                "error connecting to {} (No such file or directory)\n",
                path.display()
            ),
        );
        let refused = missing_socket::placement_refused("forge-next");
        drop(listener);
        until_nothing_listens(&path);
        let after = missing_socket::placement_refused("forge-next");
        missing_socket::default_said(None);
        missing_socket::answered(None);
        let refused = refused.expect("a server still listens where the default file was");
        assert!(
            refused.contains(&path.display().to_string()) && refused.contains("still listens"),
            "names the default socket and the server still on it: {refused}"
        );
        assert_eq!(
            after, None,
            "with nothing listening there, a cold start places"
        );
    }

    /// ISS-1265 round 7, judge-68: a refusal on the runner's own socket said
    /// "pid N now" and then `kill -USR1 <pid>`, so a person carried the number
    /// across by hand. The process the check found is the one the command names.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_refusal_on_the_runners_socket_signals_the_pid_it_found() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let gone = crate::test_scratch::Scratch::short("foundpid");
        let path = gone.join("tmux.sock");
        let socket = Some(path.clone());
        let pane = session_name(MASTER_PREFIX, &format!("foundpid-{}", std::process::id()));
        let listener =
            std::os::unix::net::UnixListener::bind(&path).expect("a listener of the test's own");
        std::fs::remove_file(&path).expect("its file goes");
        let tmux = a_shell_named_tmux();
        let mut server = std::process::Command::new(&tmux.1)
            .args([
                "-c",
                "sleep 30; :",
                "-S",
                &path.display().to_string(),
                "new-session",
            ])
            .spawn()
            .expect("the shell runs");
        missing_socket::placed(socket.clone(), &pane);
        let refused = missing_socket::refusal("forge-next", &socket);
        missing_socket::forgotten(&socket, &pane);
        drop(listener);
        let _ = server.kill();
        let _ = server.wait();
        let refused = refused.expect("a server still listens there");
        assert!(
            refused.contains(&format!("(`kill -USR1 {}`)", server.id()))
                && !refused.contains("<pid>"),
            "the command signals the pid the check found, not a placeholder: {refused}"
        );
    }

    /// ISS-1265 round 7: where no process started as the server was found,
    /// the line still hands a person the `pgrep` that finds one and the
    /// command to run on what it prints.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_refusal_that_found_no_server_process_keeps_the_command_that_finds_one() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let gone = crate::test_scratch::Scratch::short("nopid");
        let path = gone.join("tmux.sock");
        let socket = Some(path.clone());
        let pane = session_name(MASTER_PREFIX, &format!("nopid-{}", std::process::id()));
        let listener =
            std::os::unix::net::UnixListener::bind(&path).expect("a listener of the test's own");
        std::fs::remove_file(&path).expect("its file goes");
        missing_socket::placed(socket.clone(), &pane);
        let refused = missing_socket::refusal("forge-next", &socket);
        missing_socket::forgotten(&socket, &pane);
        drop(listener);
        let refused = refused.expect("a server still listens there");
        assert!(
            refused.contains("`pgrep -of -- ") && refused.contains("(`kill -USR1 <pid>`)"),
            "the pgrep that finds the server, then the command for what it prints: {refused}"
        );
    }

    /// ISS-1265 round 7, judge-68: the default server's line named the pid it
    /// gave at placement even where the check had just found that pid held by
    /// a process started at another time, and told a person to signal it.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_default_server_pid_now_held_by_another_process_is_never_named_to_signal() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let gone = crate::test_scratch::Scratch::new("default-renamed");
        let path = gone.join("tmux-1000").join("default");
        let pane = session_name(MASTER_PREFIX, &format!("defrename-{}", std::process::id()));
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("its directory");
        let listener =
            std::os::unix::net::UnixListener::bind(&path).expect("a listener of the test's own");
        std::fs::remove_file(&path).expect("its file goes");
        let mut other = a_tmux_stand_in();
        let pid = other.id();
        missing_socket::default_served_as(Some((
            path.clone(),
            pid,
            Some("Thu Jan  1 00:00:00 1970".to_string()),
        )));
        missing_socket::placed(None, &pane);
        let refused = missing_socket::refusal("forge-next", &None);
        missing_socket::forgotten(&None, &pane);
        missing_socket::default_served(None);
        drop(listener);
        let _ = other.kill();
        let _ = other.wait();
        let refused = refused.expect("a server still listens where the default file was");
        assert!(
            !refused.contains(&format!("kill -USR1 {pid}")),
            "the pid is not the server's now, so no line says to signal it: {refused}"
        );
        assert!(
            refused.contains(&format!("no tmux server holds pid {pid} now")),
            "and the line says so: {refused}"
        );
        assert!(
            refused.contains(&format!("`ss -xlp src {}`", path.display())),
            "and names what finds the process still listening there: {refused}"
        );
    }

    /// A copy of `sh` called `tmux`, so a process can run as tmux with any
    /// argv a test needs, and the directory that holds it.
    #[cfg(unix)]
    fn a_shell_named_tmux() -> (crate::test_scratch::Scratch, std::path::PathBuf) {
        let dir = crate::test_scratch::Scratch::short("shtmux");
        let named = dir.join("tmux");
        std::fs::copy(which::which("sh").expect("sh is on PATH"), &named).expect("sh is copied");
        // As `testing::until_it_runs` does for a shim: a sibling thread that
        // forked while the copy's descriptor was open keeps the kernel from
        // running it (`ETXTBSY`) until that fork execs, so it is handed out
        // only once it has run.
        let runs = || {
            std::process::Command::new(&named)
                .args(["-c", ":"])
                .stdin(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !runs() {
            assert!(
                std::time::Instant::now() < deadline,
                "{} never ran",
                named.display()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        (dir, named)
    }

    /// ISS-1265 round 6, consult F1: a process that only mentions the
    /// server's argv, with nothing listening on the path, is not a server, so
    /// it holds no placement back and is never named as the one to signal.
    #[cfg(unix)]
    #[test]
    fn a_process_that_only_mentions_the_servers_argv_holds_nothing_back() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let gone = crate::test_scratch::Scratch::short("mention");
        let path = gone.join("tmux.sock");
        let socket = Some(path.clone());
        let pane = session_name(MASTER_PREFIX, &format!("mention-{}", std::process::id()));
        let mut mention = std::process::Command::new("sh")
            .args([
                "-c",
                "sleep 30; :",
                &format!("-S {} new-session", path.display()),
            ])
            .spawn()
            .expect("sh runs");
        missing_socket::placed(socket.clone(), &pane);
        let refused = missing_socket::refusal("forge-next", &socket);
        missing_socket::forgotten(&socket, &pane);
        let _ = mention.kill();
        let _ = mention.wait();
        assert_eq!(
            refused, None,
            "nothing listens there and nothing runs as tmux on it, so the placement goes ahead"
        );
    }

    /// ISS-1265 round 5, consult F2: `pgrep` reads its pattern as a regular
    /// expression, so a path holding `[1]` named the server of `…1…`, an older
    /// process, instead of its own.
    #[cfg(unix)]
    #[test]
    fn the_recovery_command_finds_its_own_path_and_not_one_its_pattern_also_matches() {
        let tag = std::process::id();
        let path = format!("/nonexistent/forge-f[1]-{tag}/tmux.sock");
        let decoy = format!("/nonexistent/forge-f1-{tag}/tmux.sock");
        let tmux = a_shell_named_tmux();
        let holding = |p: &str| {
            std::process::Command::new(&tmux.1)
                .args(["-c", "sleep 30; :", "-S", p, "new-session"])
                .spawn()
                .expect("the shell runs")
        };
        let mut older = holding(&decoy);
        std::thread::sleep(Duration::from_millis(1100));
        let mut own = holding(&path);
        let said =
            missing_socket::recovery(&Some(std::path::PathBuf::from(&path)), &path, &Ok(None));
        let command = said
            .split('`')
            .find(|part| part.starts_with("pgrep "))
            .unwrap_or_else(|| panic!("the line names a pgrep: {said}"))
            .to_string();
        let out = std::process::Command::new("sh")
            .args(["-c", &command])
            .output()
            .expect("sh runs");
        let _ = older.kill();
        let _ = own.kill();
        let _ = older.wait();
        let _ = own.wait();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            own.id().to_string(),
            "`{command}` names the process started on that path"
        );
    }

    /// ISS-1265 round 6, judge-64: the server the record names was stopped
    /// outside the daemon and its stale file removed, so nothing runs the
    /// panes the record holds. Round 5 refused every placement from then on;
    /// the panes ended with their server, and the placement starts a fresh one.
    #[cfg(unix)]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_placement_after_its_server_stopped_with_its_file_gone_starts_a_fresh_one() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("deadsrv");
        if !available() {
            cannot_run("tmux is not installed here — the read this rests on cannot run");
            return;
        }
        if !iso.took() {
            cannot_run("this box does not resolve its tmux socket from the config dir, so the only server here is its own — not stopping it");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("terminal-deadsrv");
        let first = placed_master("deadsrv-old", &dir).await;
        testing::stop_the_server_and_remove_its_file().await;
        let socket = socket_path().expect("a socket of the test's own");
        let (said, _logs) = crate::log_capture::capturing();
        let (next, placed) = placing("deadsrv-next", &dir).await;
        let log = said.said();
        assert!(
            matches!(placed, Ok(true)),
            "no server runs on that path, so nothing can be orphaned and the placement goes ahead: {placed:?}\n{log}"
        );
        assert_eq!(has_session(&next).await, Presence::Present);
        assert_eq!(
            has_session(&first).await,
            Presence::Absent,
            "the fresh server holds no pane the stopped one ran"
        );
        let shown = socket.display().to_string();
        let ended: Vec<&str> = log
            .lines()
            .filter(|l| l.contains("ERROR") && l.contains(&first) && l.contains("ended"))
            .collect();
        assert!(
            ended.len() == 1 && ended[0].contains(&shown),
            "the panes on the stopped server are said, once and at error level, to have ended with it, naming the socket: {log}"
        );
        assert!(
            !log.contains("still runs")
                && !log.contains("still holds")
                && !log.contains("still listens"),
            "nothing says a server still runs where none does: {log}"
        );
        let moved = testing::MovedSocket::aside();
        let (_, refused) = placing("deadsrv-third", &dir).await;
        moved.put_back();
        let why = refused
            .expect_err("the fresh server runs, so its file going refuses again")
            .to_string();
        assert!(
            why.contains(&next) && !why.contains(&first),
            "the refusal names the pane the fresh server runs and never one that ended with the old: {why}"
        );
    }

    /// ISS-1265 round 6, judge-64: a pane that exited by itself, which tmux
    /// then reported absent, stayed in the record, so a later refusal named it
    /// among the panes a server "still runs".
    #[cfg(unix)]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_pane_that_ended_by_itself_is_not_named_placed() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("selfend");
        if !available() {
            cannot_run("tmux is not installed here — the read this rests on cannot run");
            return;
        }
        if !iso.took() {
            cannot_run("this box does not resolve its tmux socket from the config dir, so the only server here is its own — not moving its socket");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("terminal-selfend");
        let keep = placed_master("selfend-keep", &dir).await;
        let short = session_name(MASTER_PREFIX, "selfend-short");
        ensure(
            &short,
            &dir,
            &["sleep".to_string(), "1".to_string()],
            &[],
            None,
        )
        .await
        .expect("the short pane starts");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while has_session(&short).await != Presence::Absent {
            assert!(
                std::time::Instant::now() < deadline,
                "the short pane never ended"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let moved = testing::MovedSocket::aside();
        let (_, placed) = placing("selfend-next", &dir).await;
        moved.put_back();
        let why = placed
            .expect_err("the server still runs the kept pane")
            .to_string();
        assert!(
            why.contains(&keep) && !why.contains(&short),
            "the refusal names the pane still running and not the one tmux reported ended: {why}"
        );
    }

    /// ISS-1265 round 6: a full listing of the sessions a server on the socket
    /// answered is a path that learns a pane ended, as `has_session` is.
    #[cfg(unix)]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_pane_a_full_listing_leaves_out_is_not_named_placed() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("listed");
        if !available() {
            cannot_run("tmux is not installed here — the read this rests on cannot run");
            return;
        }
        if !iso.took() {
            cannot_run("this box does not resolve its tmux socket from the config dir, so the only server here is its own — not listing it");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("terminal-listed");
        let keep = placed_master("listed-keep", &dir).await;
        let ghost = session_name(MASTER_PREFIX, "listed-ghost");
        missing_socket::placed(socket_path(), &ghost);
        let listed = names_with_prefix(JOB_PREFIX).await;
        assert!(listed.is_empty(), "no job pane runs here: {listed:?}");
        let shown = socket_path()
            .expect("a socket of the test's own")
            .display()
            .to_string();
        let said = logged_while_missing(&format!(
            "error connecting to {shown} (No such file or directory)\n"
        ));
        missing_socket::forgotten(&socket_path(), &ghost);
        assert!(
            said.contains(&keep) && !said.contains(&ghost),
            "the line names the pane the listing holds and not the one it left out: {said}"
        );
    }

    /// ISS-1265 round 6, judge-64: a refusal said once at error level and then
    /// only at debug left a box that never placed again with one line and then
    /// silence. It is said again at warning level once the interval has passed.
    #[cfg(unix)]
    #[test]
    fn a_refusal_repeated_past_the_interval_is_said_again_at_warning_level() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _iso = testing::IsolatedServer::new("repeat");
        missing_socket::answered(socket_path());
        let (said, logs) = crate::log_capture::capturing();
        missing_socket::say_refused("forge-x was not placed: first");
        missing_socket::say_refused("forge-x was not placed: at once");
        let soon = said.said();
        std::thread::sleep(missing_socket::REPEAT_EVERY + Duration::from_millis(100));
        missing_socket::say_refused("forge-x was not placed: later");
        drop(logs);
        missing_socket::answered(socket_path());
        let log = said.said();
        assert!(
            soon.lines().filter(|l| l.contains("ERROR")).count() == 1 && !soon.contains("WARN"),
            "said once at error level, and not again before the interval: {soon}"
        );
        assert!(
            log.lines()
                .any(|l| l.contains("WARN") && l.contains("later")),
            "said again at warning level once it has passed: {log}"
        );
        assert!(
            log.lines().filter(|l| l.contains("ERROR")).count() == 1,
            "and never again at error level while the file stays gone: {log}"
        );
    }

    /// ISS-1265 round 6: the default server's pid no longer runs and nothing
    /// listens on its path, so the panes placed on it ended with it, and the
    /// placement goes ahead rather than waiting on a server that is not there.
    #[cfg(unix)]
    #[test]
    fn a_placement_on_the_default_server_after_it_stopped_goes_ahead() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let gone = crate::test_scratch::Scratch::new("default-stopped");
        let path = gone.join("tmux-1000").join("default");
        let pane = session_name(MASTER_PREFIX, &format!("defstop-{}", std::process::id()));
        let mut server = a_tmux_stand_in();
        missing_socket::default_served(Some((path.clone(), server.id())));
        let _ = server.kill();
        let _ = server.wait();
        missing_socket::placed(None, &pane);
        let (said, logs) = crate::log_capture::capturing();
        let refused = missing_socket::refusal("forge-next", &None);
        let again = missing_socket::refusal("forge-next", &None);
        drop(logs);
        missing_socket::forgotten(&None, &pane);
        missing_socket::default_served(None);
        let log = said.said();
        assert_eq!(
            refused, None,
            "no default server runs there, so nothing waits on one"
        );
        assert_eq!(again, None);
        assert!(
            log.lines()
                .filter(|l| l.contains("ERROR") && l.contains(&pane) && l.contains("ended"))
                .count()
                == 1,
            "its pane is said once to have ended with it: {log}"
        );
    }

    /// ISS-1265 round 6, the coordinator's repair: judge-64's run left three
    /// servers on test sockets for ever. A second server started while the
    /// first one's file was aside, then covered by that file put back, cannot
    /// be reached through the socket; the isolation still ends it, by pid.
    #[cfg(unix)]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_server_its_socket_cannot_reach_is_ended_with_its_isolation() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let iso = testing::IsolatedServer::new("orphan");
        if !available() {
            cannot_run("tmux is not installed here — the read this rests on cannot run");
            return;
        }
        if !iso.took() {
            cannot_run("this box does not resolve its tmux socket from the config dir, so the only server here is its own — not touching it");
            return;
        }
        let socket = socket_path().expect("a socket of the test's own");
        let under = socket
            .parent()
            .and_then(std::path::Path::parent)
            .expect("the isolation's own directory")
            .to_path_buf();
        let dir = crate::test_scratch::Scratch::new("terminal-orphan");
        placed_master("orphan-first", &dir).await;
        let moved = testing::MovedSocket::aside();
        let second = tmux(&["new-session", "-d", "-s", "orphan-second", "sleep", "60"])
            .await
            .expect("tmux runs");
        assert!(second.status.success(), "a second server takes the path");
        moved.put_back();
        drop(moved);
        let before = crate::test_scratch::TmuxServers::running_under(&under)
            .expect("the process table is read");
        drop(iso);
        let left = crate::test_scratch::TmuxServers::running_under(&under)
            .expect("the process table is read");
        assert!(
            before.len() >= 2,
            "the plant: two servers ran under the isolation: {before:?}"
        );
        assert!(
            left.is_empty(),
            "every server the test started ended with its isolation, the one its socket cannot reach too: {left:?}"
        );
    }

    /// ISS-1265 round 6, review F1 of the leak repair: a teardown that could
    /// not read the process table has not checked anything, so it fails the
    /// test rather than reading an unread table as one with no server in it.
    #[cfg(unix)]
    #[test]
    fn a_teardown_that_cannot_read_the_process_table_fails_the_test() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let under = crate::test_scratch::Scratch::short("unread");
        let empty = crate::test_scratch::Scratch::new("no-pgrep");
        let refusing = crate::test_scratch::Scratch::new("pgrep-fails");
        testing::write_shim(
            &refusing.join("pgrep"),
            "#!/bin/sh\n[ \"$1\" = --forge-shim-probe ] && exit 0\necho 'pgrep: cannot read the table' >&2\nexit 3\n",
        );
        let mut read = Vec::new();
        for pgrep in [empty.join("pgrep"), refusing.join("pgrep")] {
            let listed = crate::test_scratch::TmuxServers::read_with(&under, &pgrep);
            let dropped = std::panic::catch_unwind(|| {
                drop(crate::test_scratch::TmuxServers::reading_with(
                    &under, &pgrep,
                ));
            });
            read.push((listed, dropped.is_err()));
        }
        let (unrun, unrun_failed) = &read[0];
        let (refused, refused_failed) = &read[1];
        assert!(
            matches!(unrun, Err(e) if e.contains("could not be run")),
            "a pgrep that cannot be run is not a table with no server: {unrun:?}"
        );
        assert!(
            matches!(refused, Err(e) if e.contains("Some(3)") && e.contains("cannot read")),
            "an error exit is not the no-match exit: {refused:?}"
        );
        assert!(
            *unrun_failed && *refused_failed,
            "and either way the teardown fails the test rather than certifying it"
        );
        assert_eq!(
            crate::test_scratch::TmuxServers::running_under(&under),
            Ok(Vec::new()),
            "with pgrep back, no match is an empty table"
        );
    }

    /// ISS-1265 round 3, F5: `brief_new_pane` minted `no session named …` from
    /// `alive`'s `false`, which a tmux nobody could run also answers.
    #[tokio::test]
    async fn a_brief_to_a_pane_tmux_could_not_be_asked_about_says_so() {
        let no_tmux = UnaskableTmux::installed();
        let why = brief_new_pane(SHIM_PANE, "BRIEF")
            .await
            .expect_err("nothing could be asked, so nothing was typed")
            .to_string();
        assert!(no_tmux.asked() > 0, "the question went to the fake tmux");
        assert!(
            why.contains("could not be asked"),
            "the sentence says the question went unanswered: {why}"
        );
        assert!(
            !why.contains("no session named"),
            "and never borrows the one minted for a session tmux said it does not hold: {why}"
        );
    }
}
