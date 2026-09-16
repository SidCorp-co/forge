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

/// The config dir this box's session server is keyed on.
///
/// One reading, because the socket and the unit are two halves of one identity
/// and a caller that resolved them separately could temp one and not the other.
// cm:guard the SINGLE source for both `socket_path` and `session_unit`. Before ISS-1044 the socket was derived here and the unit was a literal, so a test's temp config dir moved the socket and left `systemctl --user stop forge-sessions.service` naming the one real unit hosting every pane on the box: 38 evictions in 12h, measured forge-vm 2026-09-15, each killing every master and agent pane across every project on it.
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
// cm:guard this DUPLICATES `dirs_next`'s rule for the platform, which is why `the_unoverridden_dir_is_what_the_box_resolves_with_no_override` pins the two together: the day `dirs_next` changes where it puts a Linux config dir, that test goes red rather than this silently classifying the box's own dir as an override and renaming the live unit out from under the panes.
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
// cm:guard a socket of OUR OWN is not tidiness, it is the survival property: on the default socket the runner shares a server with whatever tmux the operator is running, so one `tmux kill-server`, or their last personal session ending, takes every agent on the box with it. Measured forge-vm 2026-09-11: `-L`/`-S` appeared zero times in this crate and 47 agent panes were sitting on the operator's own server.
pub fn socket_path() -> Option<std::path::PathBuf> {
    SessionIdentity::current().map(|id| id.socket)
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

/// The unit name for the config dir in force, which is what every systemd call
/// in this module names.
///
/// The box's own config dir keeps the bare `SESSION_UNIT`, so nothing about a
/// real runner changes. Any OTHER config dir — a test's temp dir, a leaked
/// `/tmp/forge-cred-*` inherited by a stray subprocess — gets a unit of its
/// own, and can no longer reach the one this box's panes run under.
// cm:guard no systemd call may name `SESSION_UNIT` directly; `no_systemd_command_names_a_literal_unit` is the gate. That is the whole of ISS-1044: the cold-start test interpolated the const into `systemctl --user stop`, so `cargo test` on a box hosting live sessions stopped the unit every pane was in, then re-placed it bound to the test's temp socket — leaving the live unit holding a socket nothing used and the panes outside its cgroup.
// cm:guard the SUFFIX is keyed on the config dir and not on the pid, the hostname or a random value: a daemon that restarts must resolve the same unit it placed, or `ensure_server` places a second one beside the first and neither owns the panes.
// cm:guard both the comparison and the digest read `resolved`, never the path as written. `XDG_CONFIG_HOME` reaching the box's own dir through a symlink or a `..` is an operator's ordinary setup, and a lexical `==` would call it an override and rename the live unit out from under panes already inside it — the eviction this issue fixes, wearing the fix's clothes. Two spellings of one dir must also hash alike, or one directory grows two units and two servers race for one socket.
/// The unit name one config dir resolves.
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
// cm:guard one VALUE carrying both halves, not two functions that agree by convention. `ensure_server` used to read the socket and then let `ask_systemd_for_the_server` read the unit on its own; a shared source function is not one reading, and anything moving the config dir between the two hands systemd the unit for one dir and the tmux command the socket for another — the split identity ISS-1044 criterion 6 forbids, surviving the fix that was supposed to close it.
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
// cm:guard the FALLBACK is the path as written and never an error. Refusing here would take out the boxes this exists to leave alone, over a path lookup — the same reasoning as `socket_path`'s. What the fallback costs is stated where it bites: two spellings of one dir that share no existing ancestor read as two dirs, so one gets a suffixed unit. A `..` inside a path that does not exist is that case.
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
// cm:guard NOT `to_string_lossy`. A Unix path is bytes and need not be UTF-8; lossy conversion maps every invalid sequence to the same replacement character, so two config dirs with different invalid bytes would get different sockets and the same unit name.
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
    // cm:guard ONE reading for the whole placement. Everything below takes its
    // socket and its unit from this value rather than asking again, which is
    // criterion 6 made structural instead of conventional.
    let Some(id) = SessionIdentity::current() else {
        tracing::warn!(
            "[terminal] no usable session socket path — agent panes will run on the default tmux server and die with this service, as they did before"
        );
        return false;
    };
    let sock = &id.socket;
    // cm:guard `tmux -S` does NOT make the directory it is handed, so a box whose
    // config dir has never been written cannot bind here and every pane fails with
    // a message about tmux rather than about a missing directory. Until ISS-1044 no
    // test found that, because `cred_store` leaked an `XDG_CONFIG_HOME` that happened
    // to exist and every pane test bound inside it.
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

/// The most placements this process has ever had in flight at once.
// cm:guard the OVERLAP is what this process owns, and it is the only part a gate can hold anywhere. How long systemd then takes to fork tmux belongs to the host — measured 2026-09-11 on a GitHub runner, a cold user manager took over thirty seconds, and a caller that waited that out is RIGHT to ask again rather than give up on the box forever. So the count of attempts is not an invariant and the overlap is: two at once means five losers racing `new-session` against a socket nothing has bound yet.
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
// cm:guard `is-active`, never a substring of `systemd-run`'s stderr: losing the race prints `Unit forge-sessions.service already exists`, which is a translated, version-specific sentence — and the thing the caller actually needs to know is whether the unit is coming up, which systemd will answer directly.
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
// cm:guard `--strict-mcp-config` is NOT passed and adding it is a behaviour change, not a tightening: it would make this file the ONLY MCP configuration the pane has, dropping the checkout's `.mcp.json` — which is where the `forge` server itself comes from — and every server the operator configured on the box. The file this flag names carries the project's declared servers and nothing else, on purpose (ISS-1043).
// cm:guard a pane reads `--mcp-config` at STARTUP and never again, so this argument is the whole of what a master will ever have. A project whose declaration changes mid-session needs a new pane; nothing here can retrofit one.
pub fn pane_argv(mcp_config: Option<&std::path::Path>) -> Vec<String> {
    let bin = shell_quote(crate::runner::process::resolve_claude_bin());
    let mut line = format!("unset CLAUDECODE; exec {bin} --permission-mode bypassPermissions");
    if let Some(path) = mcp_config {
        line.push_str(&format!(
            " --mcp-config {}",
            shell_quote(&path.to_string_lossy())
        ));
    }
    vec!["sh".into(), "-c".into(), line]
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
    // cm:guard serialised because a cold-start test has to kill that shared server, and `cargo test` runs this module's tests concurrently by default — without the lock it takes the panes the other two tests are mid-assertion on.
    static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// A config dir of this test's own, removed however the test ends.
    ///
    /// The `forge-runner` directory inside it is made here because `tmux -S`
    /// will not make it.
    // cm:guard RAII for the same reason `ScopedVar` is. A `remove_dir_all` at the end of the body is skipped by a panic, and skipping it is how 90 `/tmp/forge-cred-*` dirs came to sit on forge-vm — the newest of them holding another module's `skills-cache` and the very `tmux.sock` the box's LIVE session unit was bound to (ISS-1044).
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
    // cm:guard RAII, and `Drop` cannot await, so this is the blocking `Command`. Without it a panic anywhere after the placement leaves a transient `forge-sessions-*.service` and its `sleep infinity` running on a box that never asked for either — the same leak `ConfigHome` closes for the directory, and the same one that put 90 dirs on forge-vm.
    // cm:guard the caller passes `session_unit()` and the socket beside it, never a name of its own: that is what keeps every stop in this module inside the config dir in force. `no_systemd_command_names_a_literal_unit` is the static half of that and the `assert_ne!` in the cold-start test is the running half.
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
        // cm:guard the `assert_ne!` is the whole safety of this type. Everything below stops a unit, so a caller that reached it with the box's own name would evict every pane on the box from inside the guard meant to prevent exactly that.
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
    // cm:guard the test's OWN dir, never "whatever dir is in force". An earlier draft of this guard read any non-default config dir as disposable and stopped it — which on a box running a SECOND runner from an overridden `XDG_CONFIG_HOME`, a setup this module exists to support, would have killed that runner's server and every pane in it. That is ISS-1044's own defect one box over, arriving inside the fix for it. Owning the dir is what makes the teardown safe; a name comparison is not.
    struct Sandbox {
        _placed: Option<PlacedUnit>,
        _xdg: ScopedVar,
        _home: ConfigHome,
    }

    impl Sandbox {
        fn new(label: &str) -> Self {
            let home = ConfigHome::new(label);
            let xdg = ScopedVar::set("XDG_CONFIG_HOME", home.path());
            // cm:guard guard only a unit whose socket is INSIDE the directory this
            // sandbox made — ownership, not a name comparison. `dirs_next` reads
            // `XDG_CONFIG_HOME` on XDG platforms only, so on macOS and Windows the
            // variable moves nothing and the dir in force is still the box's own;
            // guarding there would hand `PlacedUnit` the live unit, which is what
            // its `assert_ne!` refused when this was written the other way round.
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
        let argv = pane_argv(None);
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

    // cm:guard a project that declares no MCP servers must get NO flag rather than an empty file. An empty `--mcp-config` document is a second thing to write, sweep and compare for every project on the box that never wanted one, and the absent flag is the shape every pane had before ISS-1043.
    #[test]
    fn a_project_with_no_servers_leaves_the_pane_argv_exactly_as_it_was() {
        assert_eq!(pane_argv(None), pane_argv(None));
        assert!(!pane_argv(None)[2].contains("--mcp-config"));
    }

    // cm:guard the path is SHELL-QUOTED. tmux hands this line to a shell, and `mcp_config_dir()` sits under `$XDG_CONFIG_HOME`, which is operator-set — dev1 runs several runners that differ only by it. An unquoted space is a pane that starts without its servers and a shell error nobody reads.
    #[test]
    fn the_mcp_config_path_reaches_the_pane_quoted_and_without_strict() {
        let path =
            std::path::PathBuf::from("/home/o p/config/forge-runner/mcp/forge-master-mcp-x.json");
        let line = pane_argv(Some(&path))[2].clone();
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

    // cm:guard the unit name is what stops an operator's `systemctl --user stop forge-runner*` from taking the sessions with it, so it may not share that prefix.
    #[test]
    fn the_session_unit_is_not_matched_by_a_glob_over_the_runners_own() {
        assert!(!SESSION_UNIT.starts_with("forge-runner"));
    }

    /// Criterion 4. Nothing about a real runner changes: the box's own config
    /// dir still resolves the bare name its live panes are already inside.
    // cm:guard the SECOND half — the same dir named explicitly through `XDG_CONFIG_HOME` — is the case an operator hits, not a contrivance. A comparison made against the variable rather than against the resolved path would call that an override and rename the unit out from under every pane on the box, which is the eviction this issue fixes wearing the fix's own clothes.
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
    // cm:guard the two dirs differ ONLY in bytes `to_string_lossy` maps to the same replacement character. Hashed lossily they produce one unit name for two directories, so two runners would race `systemd-run` for the same unit while their sockets stayed apart — the "second one beside the first" failure the suffix exists to prevent, arriving through the encoding instead.
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
    // cm:guard the SYMLINK is the case a lexical `==` gets wrong, and getting it wrong renames the live unit out from under panes already inside it — the eviction this issue fixes, arriving as the fix. The `..` case below is the same alias by another spelling.
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

        // cm:guard the symlink lives INSIDE a `ConfigHome`, so its removal is the
        // directory's and survives a panic. Left at the top of `/tmp` with a line
        // at the end of the body, a failing run leaves a dangling `forge-alias-*`
        // pointing into the operator's real config root — measured while planting
        // this test's own failure.
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

    /// What the `cm:guard` on `unoverridden_config_dir` promises: the rule
    /// spelled out there and `dirs_next`'s own must agree.
    // cm:guard this is the test that goes red the day `dirs_next` moves a Linux config dir, instead of `session_unit` silently classifying the box's own dir as an override.
    #[test]
    fn the_unoverridden_dir_is_what_the_box_resolves_with_no_override() {
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _xdg = ScopedVar::unset("XDG_CONFIG_HOME");
        assert_eq!(session_config_dir(), unoverridden_config_dir());
    }

    /// Criterion 5, and the whole of what makes `cargo test` cost a box nothing:
    /// a config dir that is not this box's own cannot name this box's unit.
    // cm:guard the assertion is `!=` against the LIVE name and not a shape. A suffix scheme that produced the bare `forge-sessions` for some temp dir would satisfy every naming assertion in this module and still stop the unit hosting every master and agent pane on the box.
    // cm:guard LINUX because the property is Linux's, not because it was red elsewhere. The override this issue is about is `XDG_CONFIG_HOME`, which `dirs_next` consults on XDG platforms only — on Windows it reads `%APPDATA%` and the variable moves nothing — and the unit being protected lives in a systemd user manager, which no other platform has. Asserting it off Linux asserts a rule the platform does not have.
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
    // cm:guard BOTH halves in ONE test and never two. The defect was precisely that one half moved with the config dir and the other did not — two tests each asserting its own half would both have been green while `cargo test` evicted the box 38 times in 12 hours.
    // cm:guard the return to `a` is not tidy-up, it is the suffix's other property: it is keyed on the dir and not on a pid, a hostname or a random value, so a daemon that restarts resolves the unit it placed rather than placing a second one beside it.
    // cm:guard LINUX because the property is Linux's, not because it was red elsewhere. The override this issue is about is `XDG_CONFIG_HOME`, which `dirs_next` consults on XDG platforms only — on Windows it reads `%APPDATA%` and the variable moves nothing — and the unit being protected lives in a systemd user manager, which no other platform has. Asserting it off Linux asserts a rule the platform does not have.
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
    // cm:guard the test above this one asserts the CONST, which before ISS-1044 was the only name there was. A derived name beginning `forge-runner` would be swept up by an operator's `systemctl --user stop 'forge-runner*'` — the single thing that constant exists to prevent — and no assertion in this file would have said so.
    // cm:guard LINUX because the property is Linux's, not because it was red elsewhere. The override this issue is about is `XDG_CONFIG_HOME`, which `dirs_next` consults on XDG platforms only — on Windows it reads `%APPDATA%` and the variable moves nothing — and the unit being protected lives in a systemd user manager, which no other platform has. Asserting it off Linux asserts a rule the platform does not have.
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
    // cm:guard the scan covers the TEST half too, because the defect was in a test: the cold-start test interpolated `SESSION_UNIT` into `systemctl --user stop`, and that one line stopped the unit every master and agent pane on the box was running under, 38 times in 12 hours (forge-vm, 2026-09-15). A gate reading only the production half would have been green throughout.
    // cm:guard the needles are SPLIT across `concat!` so this test's own source does not match them. A scanner that finds itself reports on a segment it wrote and passes over a file that has drifted.
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
        // cm:guard comment lines are stripped first, because the prose around the deriver names both and must go on being allowed to. Code is what this counts.
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
    /// A sweep starts several panes at once; one placement is asked for, and no pane is lost.
    // cm:guard cold-start is the whole setup: a warm server short-circuits every caller before the lock and the case cannot happen. Without the serialization, six callers issue six `systemd-run`s, five of them lose, and each loser races `new-session` against a socket nothing has bound yet.
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
