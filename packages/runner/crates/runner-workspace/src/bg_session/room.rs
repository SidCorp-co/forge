//! A room agent as a background session inside a sandbox of its own (ISS-1268 BR).
//!
//! A room agent answers strangers, so it runs confined (`runner-agent` `claude_code::confine`):
//! an empty home, `/tmp` and `/run`, its own pid, ipc and network namespaces, egress through the
//! box's allow-list proxy. A background session is claimed from Claude Code's background service,
//! so the service has to live inside that sandbox, or the session would run outside it. Measured
//! on 2.1.322 (`~/forge-local-docs/iss1268-chat-channels/br/`):
//! - the service's control socket is `/tmp/cc-daemon-<uid>/<hash of the config dir>`, and a client
//!   in another pid namespace cannot see the service's pid, so it starts a second service, which
//!   takes the socket over and ends the first (`a1`): every `claude` command for a room runs in the
//!   room's own namespaces, joined with `nsenter` ([`Host::command`]);
//! - so the sandbox is long-lived: its program holds the namespaces open ([`HOLDER`]), and the
//!   service, its sessions and their pty hosts live in it; the sandbox ending ends them, and a
//!   flagless `--resume` in a new one continues the conversation (`a3`);
//! - the room has a config dir of its own ([`RoomDirs`]), bound into the sandbox with the box's
//!   Claude login alone, so its sessions, keys, sockets and transcripts are its own and the box's
//!   `~/.claude` (every master's records) is not in its view; its built-in `ListAgents` names only
//!   the room's own sessions (`a2b`);
//! - its peer socket sits under the room's run dir at the same path inside and out, so the runner
//!   sends to it with a receipt like a master's (`a2`, 0.29 s); its record's pid is the sandbox's
//!   own, read through `pidDomain` ([`super::pidns`]).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::launch::{self, BgLaunch, Started};
use super::peer::{self, Priority, Receipt, Refused};
use super::roster::{self, BgSession, RosterError};

/// What a room's sandbox runs: a process that never exits on its own, so the namespaces stay open
/// for the service and sessions started in them, and end when the runner ends the sandbox.
pub const HOLDER: [&str; 2] = ["sleep", "infinity"];

/// How long a started session may take to appear in the room's roster.
const LISTED_WITHIN: Duration = Duration::from_secs(20);

/// A room's own directories, kept across its sessions so a later one resumes the conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomDirs {
    /// Bound writable into the sandbox at the same path.
    pub root: PathBuf,
    /// The room's `CLAUDE_CONFIG_DIR`.
    pub claude: PathBuf,
    /// The sandbox's `/tmp`, where the room's service binds its control socket.
    pub tmp: PathBuf,
    /// The room's `XDG_RUNTIME_DIR`, where its sessions' peer sockets are.
    pub run: PathBuf,
    /// The settings its session reads, rewritten before each start or resume: beside the root,
    /// bound read-only, so the session cannot widen its own allow list or hooks.
    pub settings: PathBuf,
    /// Which process holds the room's namespaces: beside the root, never inside the room's view,
    /// so nothing the room runs can point the runner's `nsenter` at another process.
    host_file: PathBuf,
}

impl RoomDirs {
    /// The room for `slug` under this runner's own directory.
    pub fn of(slug: &str) -> Result<Self, String> {
        let base = runner_platform::config::base_dir()
            .map_err(|e| format!("[CHAT_ROOM_DIR] this runner's directory: {e}"))?;
        Ok(Self::under(&base.join("rooms"), slug))
    }

    pub fn under(rooms: &Path, slug: &str) -> Self {
        let root = rooms.join(slug);
        Self {
            claude: root.join("claude"),
            tmp: root.join("tmp"),
            run: root.join("run"),
            host_file: rooms.join(format!("{slug}.host.json")),
            settings: rooms.join(format!("{slug}.settings.json")),
            root,
        }
    }

    /// Its directories, owner-only; a placeholder the box's login is bound over; and its config,
    /// onboarded, with `repo` trusted, so the session meets no first-run screen or trust dialog.
    pub fn make(&self, repo: &Path) -> Result<(), String> {
        let failed = |p: &Path, e: std::io::Error| format!("[CHAT_ROOM_DIR] {}: {e}", p.display());
        for dir in [&self.root, &self.claude, &self.tmp, &self.run] {
            std::fs::create_dir_all(dir).map_err(|e| failed(dir, e))?;
            owner_only(dir, 0o700).map_err(|e| failed(dir, e))?;
        }
        let login = self.claude.join(".credentials.json");
        if !login.exists() {
            std::fs::write(&login, b"").map_err(|e| failed(&login, e))?;
        }
        owner_only(&login, 0o600).map_err(|e| failed(&login, e))?;
        let config = self.claude.join(".claude.json");
        let mut doc: serde_json::Value = std::fs::read(&config)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if doc.get("hasCompletedOnboarding").is_none() {
            doc["hasCompletedOnboarding"] = true.into();
            std::fs::write(&config, doc.to_string()).map_err(|e| failed(&config, e))?;
        }
        crate::trust::pre_trust_in(&self.claude, repo).map(drop)
    }

    /// Where the session named `name` appends its hook events: in the room's config dir, which
    /// the sandbox already writes.
    pub fn events(&self, name: &str) -> PathBuf {
        self.claude
            .join("forge-chat-events")
            .join(format!("{name}.jsonl"))
    }

    /// The transcript of `session_id` started in `repo`.
    pub fn transcript(&self, repo: &Path, session_id: &str) -> PathBuf {
        self.claude
            .join("projects")
            .join(runner_core::claude_paths::project_dir_name(repo))
            .join(format!("{session_id}.jsonl"))
    }
}

#[cfg(unix)]
fn owner_only(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn owner_only(_: &Path, _: u32) -> std::io::Result<()> {
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostFile {
    holder: u32,
    proc_start: String,
}

/// A room's sandbox, running: the process whose namespaces every `claude` command for the room
/// joins.
#[derive(Debug, Clone)]
pub struct Host {
    pub holder: u32,
    pub dirs: RoomDirs,
    proc_start: String,
}

impl Host {
    /// The sandbox whose outermost `bwrap` is `outer`, once its namespace's first process stands;
    /// written down for `forge-runner chat attach`.
    pub async fn record(outer: u32, dirs: RoomDirs) -> Result<Self, String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let holder = loop {
            if let Some(h) = inner_of(outer) {
                break h;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!(
                    "[CHAT_ROOM_UNHOSTED] the room's sandbox (bwrap {outer}) opened no namespace \
                     within 10s"
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        let proc_start = proc_start(holder).ok_or_else(|| {
            format!("[CHAT_ROOM_UNHOSTED] the room's sandbox process {holder} ended at once")
        })?;
        let file = HostFile {
            holder,
            proc_start: proc_start.clone(),
        };
        let body = serde_json::to_vec(&file).map_err(|e| e.to_string())?;
        std::fs::write(&dirs.host_file, body)
            .and_then(|()| owner_only(&dirs.host_file, 0o600))
            .map_err(|e| format!("[CHAT_ROOM_DIR] {}: {e}", dirs.host_file.display()))?;
        Ok(Self {
            holder,
            dirs,
            proc_start,
        })
    }

    /// The running sandbox of `slug`'s room, refused by name where none runs.
    pub fn of(slug: &str) -> Result<Self, String> {
        Self::of_dirs(RoomDirs::of(slug)?)
    }

    pub fn of_dirs(dirs: RoomDirs) -> Result<Self, String> {
        let unhosted = |why: String| format!("[CHAT_ROOM_UNHOSTED] {why}");
        let raw = std::fs::read(&dirs.host_file).map_err(|e| {
            unhosted(format!(
                "no room agent runs there ({}: {e})",
                dirs.host_file.display()
            ))
        })?;
        let file: HostFile = serde_json::from_slice(&raw)
            .map_err(|e| unhosted(format!("{}: {e}", dirs.host_file.display())))?;
        let host = Self {
            holder: file.holder,
            dirs,
            proc_start: file.proc_start,
        };
        if host.alive() {
            Ok(host)
        } else {
            Err(unhosted(format!(
                "its sandbox (process {}) has ended",
                host.holder
            )))
        }
    }

    /// Every room whose sandbox runs on this box.
    pub fn all() -> Vec<Self> {
        let Ok(base) = runner_platform::config::base_dir() else {
            return Vec::new();
        };
        let rooms = base.join("rooms");
        let Ok(entries) = std::fs::read_dir(&rooms) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter(|e| e.path().is_dir())
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter_map(|slug| Self::of_dirs(RoomDirs::under(&rooms, &slug)).ok())
            .collect()
    }

    /// Whether the holder is still the process that was written down.
    pub fn alive(&self) -> bool {
        proc_start(self.holder).as_deref() == Some(self.proc_start.as_str())
    }

    /// `claude <args>` in the room's namespaces, in `cwd`, with the sandbox's own environment and
    /// nothing of this process's. Refused by name where `nsenter` is not on this box.
    pub fn command(&self, args: &[String], cwd: &Path) -> Result<tokio::process::Command, String> {
        let nsenter = which::which("nsenter").map_err(|_| {
            "[CHAT_ROOM_NSENTER_MISSING] `nsenter` (util-linux) is not on this box, and a room \
             agent's session is reached only inside its sandbox"
                .to_string()
        })?;
        let env = environ(self.holder).ok_or_else(|| {
            format!(
                "[CHAT_ROOM_UNHOSTED] the room's sandbox process {} cannot be read",
                self.holder
            )
        })?;
        let mut cmd = tokio::process::Command::new(nsenter);
        cmd.arg("-t")
            .arg(self.holder.to_string())
            .args(["-U", "-m", "-p", "-n", "-i", "--preserve-credentials"])
            .arg(format!("--wd={}", cwd.display()))
            .arg("--")
            .arg(runner_platform::process::resolve_claude_bin())
            .args(args)
            .env_clear()
            .envs(env)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        Ok(cmd)
    }

    /// `claude <args>` in the room, its output answered whole.
    pub async fn claude(&self, args: &[String], cwd: &Path) -> Result<String, String> {
        let cmd = self.command(args, cwd)?;
        launch::output(cmd, args.first().map_or("", String::as_str)).await
    }

    /// The room's roster, stopped sessions included.
    pub async fn roster(&self) -> Result<Vec<BgSession>, RosterError> {
        let args = ["agents", "--json", "--all"].map(String::from);
        let said = self
            .claude(&args, &self.dirs.root)
            .await
            .map_err(RosterError)?;
        roster::parse(&said)
    }

    /// Start `l` in the room, and read back the session it became.
    pub async fn start(&self, l: &BgLaunch) -> Result<Started, String> {
        let said = self.claude(&l.argv(), &l.cwd).await?;
        let started = self.answered(&said, &l.name, l.resume.is_some()).await?;
        self.listed(started).await
    }

    /// Continue the stopped session `session_id` with its saved options, in a sandbox new to it.
    pub async fn resume(
        &self,
        session_id: &str,
        name: &str,
        cwd: &Path,
    ) -> Result<Started, String> {
        let args = ["--bg", "--resume", session_id].map(String::from);
        let said = self.claude(&args, cwd).await?;
        let mut s = self.answered(&said, name, true).await?;
        s.session_id = session_id.to_string();
        Ok(s)
    }

    /// What `said` says the room started, with a copy it reports stopped in the room first.
    async fn answered(&self, said: &str, name: &str, resuming: bool) -> Result<Started, String> {
        let Some(copy) = launch::copy_in(said) else {
            return launch::started_from(said, name, resuming);
        };
        let stopped = match copy.as_deref() {
            Some(id) => {
                let stop = ["stop", id].map(String::from);
                let stop = async { self.claude(&stop, &self.dirs.root).await.map(drop) };
                launch::stop_copy(id, stop, self.roster()).await
            }
            None => Err("no id".into()),
        };
        Err(launch::copy_refusal(said, name, copy.as_deref(), stopped))
    }

    async fn listed(&self, mut s: Started) -> Result<Started, String> {
        let deadline = tokio::time::Instant::now() + LISTED_WITHIN;
        loop {
            if let Ok(all) = self.roster().await {
                if let Some(found) = all.iter().find(|r| r.id.as_deref() == Some(&s.id)) {
                    s.session_id = found.session_id.clone();
                    return Ok(s);
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!(
                    "[BG_SESSION_UNLISTED] the room said it started {}, and its roster did not \
                     list it within {LISTED_WITHIN:?}",
                    s.id
                ));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// Stop the session `id`; its conversation is kept in the room.
    pub async fn stop(&self, id: &str) -> Result<(), String> {
        let args = ["stop", id].map(String::from);
        self.claude(&args, &self.dirs.root).await.map(drop)
    }

    /// Restart the session `id` on the installed Claude Code, keeping its conversation.
    pub async fn respawn(&self, id: &str) -> Result<String, String> {
        let args = ["respawn", id].map(String::from);
        self.claude(&args, &self.dirs.root).await
    }

    /// One message into `session_id`, delivered only on its receipt.
    pub async fn send(
        &self,
        session_id: &str,
        body: &str,
        priority: Priority,
    ) -> Result<Receipt, Refused> {
        peer::send_in(&self.dirs.claude, session_id, body, priority).await
    }

    /// Whether a process of the room runs `session_id` now.
    pub fn live(&self, session_id: &str) -> bool {
        peer::resolve_in(&self.dirs.claude.join("sessions"), session_id).is_ok()
    }

    /// Forget the sandbox: it is ending.
    pub fn forget(&self) {
        let _ = std::fs::remove_file(&self.dirs.host_file);
    }

    /// End a sandbox this runner no longer holds, and everything in its namespaces with it: the
    /// first process of a pid namespace ending ends the rest.
    pub fn end(&self) {
        #[cfg(unix)]
        if self.alive() {
            if let Ok(pid) = i32::try_from(self.holder) {
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(pid),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
        }
        self.forget();
    }
}

/// The session `forge-runner chat attach <slug>` opens: the room's own background session named
/// for `slug`, by its short id and conversation, read from that room's roster alone.
pub fn attach_target(roster: &[BgSession], slug: &str) -> Result<(String, String), String> {
    let name = super::session_name(super::Kind::Chat, slug);
    let s = roster::named(roster, &name).ok_or_else(|| {
        format!("[CHAT_ROOM_NO_SESSION] the room of {slug} lists no session named {name}")
    })?;
    let id =
        s.id.clone()
            .ok_or_else(|| format!("{name} is listed with no short id to open it by"))?;
    Ok((id, s.session_id.clone()))
}

/// The first process of the namespaces the `bwrap` `outer` opened: its child in another pid
/// namespace.
fn inner_of(outer: u32) -> Option<u32> {
    let own = std::fs::read_link("/proc/self/ns/pid").ok()?;
    let children = std::fs::read_to_string(format!("/proc/{outer}/task/{outer}/children")).ok()?;
    children
        .split_whitespace()
        .filter_map(|c| c.parse::<u32>().ok())
        .find(|c| std::fs::read_link(format!("/proc/{c}/ns/pid")).is_ok_and(|ns| ns != own))
}

fn proc_start(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(')')
        .and_then(|(_, rest)| rest.split_whitespace().nth(19))
        .map(str::to_string)
}

/// The environment `pid` was started with: the room's sandbox's, as the runner built it.
fn environ(pid: u32) -> Option<Vec<(std::ffi::OsString, std::ffi::OsString)>> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt as _;
        let raw = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
        Some(
            raw.split(|b| *b == 0)
                .filter_map(|kv| {
                    let at = kv.iter().position(|b| *b == b'=')?;
                    Some((
                        std::ffi::OsStr::from_bytes(&kv[..at]).to_os_string(),
                        std::ffi::OsStr::from_bytes(&kv[at + 1..]).to_os_string(),
                    ))
                })
                .collect(),
        )
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

#[cfg(test)]
#[path = "room_tests.rs"]
mod tests;
