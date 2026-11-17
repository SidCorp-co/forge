//! A resident session by its name (`forge-master-<slug>`, `forge-chat-<slug>`): whether it runs,
//! which process, which incarnation, its end, its placement and a message into it. The questions
//! the box used to ask tmux of a pane, asked of the roster.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::launch::{self, BgLaunch, Started};
use super::peer::{self, Priority, Receipt, Refused};
use super::roster::{self, BgSession, RosterError};

/// How long a woken session's live record may take to appear before a message to it is refused.
const RECORD_WITHIN: Duration = Duration::from_secs(15);

/// What the roster says of the session named `name`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Presence {
    /// A process runs it.
    Alive(BgSession),
    /// The roster was read and no process runs a session by that name.
    Gone,
    /// The roster could not be read, so nothing here says it ended.
    Unanswered(String),
}

pub async fn presence(name: &str) -> Presence {
    match roster::list().await {
        Ok(all) => roster::named(&all, name)
            .filter(|s| s.is_live())
            .map_or(Presence::Gone, |s| Presence::Alive(s.clone())),
        Err(RosterError(why)) => Presence::Unanswered(why),
    }
}

/// Whether a process runs the session named `name`; an unread roster answers `false`.
pub async fn alive(name: &str) -> bool {
    matches!(presence(name).await, Presence::Alive(_))
}

/// The process that runs it.
pub async fn pid(name: &str) -> Option<u32> {
    match presence(name).await {
        Presence::Alive(s) => s.pid,
        _ => None,
    }
}

/// Which incarnation runs under `name`, equal only to itself: the conversation, the process
/// and when the session started. A respawn is a new incarnation of the same conversation.
pub async fn incarnation(name: &str) -> Option<String> {
    match presence(name).await {
        Presence::Alive(s) => Some(incarnation_of(&s)),
        _ => None,
    }
}

pub fn incarnation_of(s: &BgSession) -> String {
    format!(
        "{}:{}:{}",
        s.session_id,
        s.pid.unwrap_or(0),
        s.started_at.unwrap_or(0)
    )
}

/// Stop every live session named `name`, and answer for none running after: a stop that did not
/// take is said, never read as taken (ISS-1208).
pub async fn kill(name: &str) -> Result<(), String> {
    let all = roster::list().await.map_err(|e| e.to_string())?;
    let live: Vec<&BgSession> = all
        .iter()
        .filter(|s| s.is_background() && s.is_live() && s.name.as_deref() == Some(name))
        .collect();
    let mut refused = Vec::new();
    for s in live {
        if let Some(id) = s.id.as_deref() {
            if let Err(e) = launch::stop(id).await {
                refused.push(format!("{id}: {e}"));
            }
        }
    }
    match presence(name).await {
        Presence::Gone => Ok(()),
        Presence::Alive(s) => Err(format!(
            "[BG_STOP_REFUSED] {name} still runs as {} after `claude stop`{}",
            s.id.unwrap_or_default(),
            if refused.is_empty() {
                String::new()
            } else {
                format!(": {}", refused.join("; "))
            }
        )),
        Presence::Unanswered(why) => Err(format!(
            "whether {name} still runs after `claude stop` could not be read: {why}"
        )),
    }
}

/// What became of one message to the session named `name`.
#[derive(Debug)]
pub enum Delivery {
    /// Its receipt stands in the session's transcript.
    Delivered(Receipt),
    /// The roster was read and no process runs a session by that name.
    Gone,
    /// Neither: refused by name, nothing typed anywhere.
    Refused(Refused),
}

/// Send `text` into the session named `name`.
pub async fn deliver(name: &str, text: &str, priority: Priority) -> Delivery {
    let s = match presence(name).await {
        Presence::Alive(s) => s,
        Presence::Gone => return Delivery::Gone,
        Presence::Unanswered(why) => {
            return Delivery::Refused(Refused::NoLiveProcess(format!(
                "the roster could not say whether {name} runs: {why}"
            )))
        }
    };
    match peer::send(&s.session_id, text, priority).await {
        Ok(r) => Delivery::Delivered(r),
        Err(e) => Delivery::Refused(e),
    }
}

/// [`deliver`] to a conversation just woken: its live record may take a moment to be written.
pub async fn deliver_when_up(session_id: &str, text: &str, priority: Priority) -> Delivery {
    let deadline = std::time::Instant::now() + RECORD_WITHIN;
    loop {
        match peer::send(session_id, text, priority).await {
            Ok(r) => return Delivery::Delivered(r),
            Err(Refused::NoLiveProcess(_)) if std::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(e) => return Delivery::Refused(e),
        }
    }
}

/// What a master is placed with.
pub struct Place<'a> {
    pub name: &'a str,
    pub cwd: &'a Path,
    /// Its own environment, which its settings file carries.
    pub env: &'a [(String, String)],
    pub mcp_config: Option<&'a Path>,
    pub plugin_dirs: &'a [PathBuf],
    pub plugins_off: &'a [String],
    /// The conversation it continues, where it has one.
    pub resume: Option<&'a str>,
    /// What it is told first: its launch prompt, or the first message of a woken conversation.
    pub brief: &'a str,
    /// What holds its conversation beyond its own turn, read before a tmux pane holding it is
    /// ended ([`super::cutover`]).
    pub work: &'a super::cutover::Work<'a>,
}

/// What [`place`] did.
#[derive(Debug)]
pub enum Placed {
    /// A session by the name already runs; nothing was started.
    AlreadyUp,
    /// A session was started, its brief its first turn.
    Started(Started),
    /// A stopped conversation was woken, and its brief sent as a message.
    Woken(Started, Delivery),
}

/// Place the master `p.name`: the pinned version checked, its settings written, and a stopped
/// background conversation woken where it has one, else a session started (resuming the
/// conversation where one is named).
pub async fn place(p: &Place<'_>) -> Result<Placed, String> {
    match presence(p.name).await {
        Presence::Alive(_) => return Ok(Placed::AlreadyUp),
        Presence::Unanswered(why) => {
            return Err(format!(
                "whether {} already runs could not be read, so none is started beside it: {why}",
                p.name
            ))
        }
        Presence::Gone => {}
    }
    super::version::ensure_pinned().await?;
    let settings = launch::settings_path(p.name)?;
    let hooks = super::relay::relay_hooks().ok_or_else(|| {
        format!(
            "[PERMISSION_RELAY_UNINSTALLABLE] this runner cannot name its own binary, so {} would \
             start with no permission relay and a prompt there would wait on nobody; it is not started",
            p.name
        )
    })?;
    let doc = launch::settings_doc(p.env, p.plugins_off, Some(hooks));
    launch::write_settings(&settings, &doc)?;
    // the last step before a start: a pane ended here is resumed now, never left ended (ISS-1304)
    super::cutover::make_way(p.name, p.resume, p.work).await?;
    let stopped_bg = match p.resume {
        Some(id) => roster::list_all()
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .any(|s| s.is_background() && s.session_id == id),
        None => false,
    };
    if let (Some(id), true) = (p.resume, stopped_bg) {
        let woke = launch::resume(id, p.name, p.cwd).await?;
        let told = deliver_when_up(id, p.brief, Priority::Next).await;
        return Ok(Placed::Woken(woke, told));
    }
    let mut launch = BgLaunch {
        name: p.name.to_string(),
        cwd: p.cwd.to_path_buf(),
        settings,
        permission_mode: "bypassPermissions".into(),
        mcp_config: p.mcp_config.map(Path::to_path_buf),
        plugin_dirs: p.plugin_dirs.to_vec(),
        prompt: Some(p.brief.to_string()),
        // what makes the owner's relayed word the owner's, and a teammate's "approved" nothing (B4)
        append_system_prompt: Some(super::relay::SESSION_AUTHORITY.to_string()),
        ..BgLaunch::default()
    };
    launch.resume = p.resume.map(str::to_string);
    launch.start().await.map(Placed::Started)
}

/// `claude logs <id>` of the latest session named `name`, live or stopped, written to `path`:
/// what it printed, for the account of why it ended.
pub async fn keep_logs(name: &str, path: &Path) -> Result<(), String> {
    let all = roster::list_all().await.map_err(|e| e.to_string())?;
    let id = roster::named(&all, name)
        .and_then(|s| s.id.clone())
        .ok_or_else(|| format!("the roster holds no background session named {name}"))?;
    let said = launch::logs(&id).await?;
    std::fs::write(path, said).map_err(|e| format!("{}: {e}", path.display()))
}

/// Whether this box can host a resident session at all: a `claude` it can run.
pub fn host_available() -> bool {
    let bin = runner_platform::process::resolve_claude_bin();
    std::path::Path::new(bin).is_file() || which::which(bin).is_ok()
}

/// The launch a master is started with, as its placement inputs digest it: what changes it is
/// what makes a running master outdated.
pub fn launch_identity(
    mcp_config: Option<&Path>,
    plugin_dirs: &[PathBuf],
    plugins_off: &[String],
) -> Vec<String> {
    let mut argv = BgLaunch {
        permission_mode: "bypassPermissions".into(),
        mcp_config: mcp_config.map(Path::to_path_buf),
        plugin_dirs: plugin_dirs.to_vec(),
        ..BgLaunch::default()
    }
    .argv();
    argv.extend(plugins_off.iter().map(|p| format!("off:{p}")));
    argv.push(format!("crossSessionInbound:{}", "accept"));
    argv
}
