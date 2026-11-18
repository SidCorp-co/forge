//! Starting, resuming, stopping and respawning a background session, and the settings file it
//! reads.
//!
//! Measured on 2.1.322 (ISS-1268, logs in `~/forge-local-docs/iss1268-chat-channels/bt/`):
//! - `claude --bg` exits 0 whatever it did; what it did is in what it printed. A started session
//!   prints `backgrounded · <id> · <name>`; an untrusted directory prints `Workspace not trusted`.
//! - `--session-id` is ignored under `--bg`: the session's id is read back from the roster.
//! - The session is claimed by a process Claude Code's background service pre-started, so it runs
//!   with the SERVICE's environment, not the launcher's. What one session needs (its project, its
//!   capability, its `PATH`) goes in its settings file's `env`, which its tools see. The launcher
//!   runs with a scrubbed environment, so a service it happens to start carries nothing of this
//!   daemon's.
//! - A stopped background session resumed WITH flags starts a copy under a new id ("keeps its own
//!   saved options"); resumed with none, it continues itself with its saved options, the settings
//!   path among them, and re-reads that file. A running one resumed starts a copy either way.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::roster;

/// What `claude --bg` and its siblings may take before the box stops waiting.
const COMMAND_WITHIN: Duration = Duration::from_secs(60);
/// How long a started session may take to appear in the roster with its full id.
const LISTED_WITHIN: Duration = Duration::from_secs(20);

/// The launcher's own environment: these and nothing else of this daemon's.
const KEPT_ENV: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "CLAUDE_CONFIG_DIR",
    "PATH",
];

/// Claude Code's own updater off, in the session's environment (C1: the runner owns the version).
pub const UPDATER_OFF: (&str, &str) = ("DISABLE_AUTOUPDATER", "1");

/// A session to start fresh: everything it is started with.
#[derive(Debug, Clone, Default)]
pub struct BgLaunch {
    pub name: String,
    /// Only the servers `mcp_config` names: a room agent's checkout `.mcp.json` would otherwise
    /// hold it on a startup dialog (measured in a room, ISS-1268 BR `a2d`).
    pub strict_mcp: bool,
    pub cwd: PathBuf,
    /// The runner-written settings file ([`write_settings`]).
    pub settings: PathBuf,
    pub permission_mode: String,
    pub model: Option<String>,
    pub mcp_config: Option<PathBuf>,
    pub plugin_dirs: Vec<PathBuf>,
    pub append_system_prompt: Option<String>,
    /// A conversation that is not a background session yet, continued under its own id: a
    /// stopped background one is woken by [`resume`] instead, which takes no flags.
    pub resume: Option<String>,
    /// Its first turn, as its own user turn.
    pub prompt: Option<String>,
}

impl BgLaunch {
    pub fn argv(&self) -> Vec<String> {
        let mut a: Vec<String> = vec![
            "--bg".into(),
            "--name".into(),
            self.name.clone(),
            "--permission-mode".into(),
            self.permission_mode.clone(),
            "--settings".into(),
            self.settings.to_string_lossy().into_owned(),
        ];
        for dir in &self.plugin_dirs {
            a.push("--plugin-dir".into());
            a.push(dir.to_string_lossy().into_owned());
        }
        if let Some(m) = self.model.as_deref().filter(|m| !m.is_empty()) {
            a.push("--model".into());
            a.push(m.into());
        }
        if let Some(p) = &self.mcp_config {
            a.push("--mcp-config".into());
            a.push(p.to_string_lossy().into_owned());
            if self.strict_mcp {
                a.push("--strict-mcp-config".into());
            }
        }
        if let Some(sp) = self
            .append_system_prompt
            .as_deref()
            .filter(|s| !s.is_empty())
        {
            a.push("--append-system-prompt".into());
            a.push(sp.into());
        }
        if let Some(id) = self.resume.as_deref().filter(|s| !s.is_empty()) {
            a.push("--resume".into());
            a.push(id.into());
        }
        if let Some(p) = self.prompt.as_deref().filter(|p| !p.is_empty()) {
            a.push("--".into());
            a.push(p.into());
        }
        a
    }

    /// Start it, and read back the session it became; a copy it started is stopped first.
    pub async fn start(&self) -> Result<Started, String> {
        let said = claude(&self.argv(), Some(&self.cwd)).await?;
        answered(&said, &self.name, self.resume.is_some())
            .await?
            .listed()
            .await
    }
}

/// A session `claude --bg` said it started or woke.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    /// The short id `attach`, `stop` and `respawn` take.
    pub id: String,
    /// The conversation's id; empty until [`Started::listed`] reads it from the roster.
    pub session_id: String,
    pub said: String,
}

impl Started {
    /// This session with its full id, read from the roster once it is listed.
    async fn listed(mut self) -> Result<Self, String> {
        let deadline = std::time::Instant::now() + LISTED_WITHIN;
        loop {
            if let Ok(all) = roster::list_all().await {
                if let Some(s) = all.iter().find(|s| s.id.as_deref() == Some(&self.id)) {
                    self.session_id = s.session_id.clone();
                    return Ok(self);
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err(format!(
                    "[BG_SESSION_UNLISTED] `claude --bg` said it started {}, and `claude agents` \
                     did not list it within {LISTED_WITHIN:?}",
                    self.id
                ));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}

/// What `said`, the output of a `claude --bg` for the session named `name`, says it did. A copy
/// is refused by name: two sessions would then hold one master's conversation.
pub fn started_from(said: &str, name: &str, resuming: bool) -> Result<Started, String> {
    if said.contains("started a copy") {
        return Err(format!(
            "[BG_RESUME_COPIED] Claude Code started a copy of {name}'s conversation instead of \
             continuing it: {}",
            said.trim()
        ));
    }
    let line = said
        .lines()
        .find_map(|l| l.trim().strip_prefix("backgrounded \u{b7} "));
    let Some(line) = line else {
        return Err(format!(
            "[BG_SESSION_UNSTARTED] `claude --bg{}` for {name} did not say it backgrounded a \
             session: {}",
            if resuming { " --resume" } else { "" },
            said.trim()
        ));
    };
    let id = line.split(" \u{b7} ").next().unwrap_or_default().trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!(
            "[BG_SESSION_UNSTARTED] `claude --bg` printed no session id for {name}: {}",
            said.trim()
        ));
    }
    Ok(Started {
        id: id.to_string(),
        session_id: String::new(),
        said: said.trim().to_string(),
    })
}

/// The short id of the copy `said` says Claude Code started instead of continuing a
/// conversation: `Some(None)` where it says it started one and names no id this can read.
pub fn copy_in(said: &str) -> Option<Option<String>> {
    if !said.contains("started a copy") {
        return None;
    }
    let named = said.split("started a copy as ").nth(1).map(|rest| {
        rest.chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect::<String>()
    });
    let printed = said
        .lines()
        .find_map(|l| l.trim().strip_prefix("backgrounded \u{b7} "))
        .and_then(|l| l.split(" \u{b7} ").next())
        .map(|id| id.trim().to_string());
    Some(
        named
            .into_iter()
            .chain(printed)
            .find(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric())),
    )
}

/// Stop the copy `id` with `stop`, and answer for it gone by the roster `live` reads after: a
/// stop that did not take is said, never read as taken (ISS-1208).
pub(crate) async fn stop_copy<S, L>(id: &str, stop: S, live: L) -> Result<(), String>
where
    S: std::future::Future<Output = Result<(), String>>,
    L: std::future::Future<Output = Result<Vec<roster::BgSession>, roster::RosterError>>,
{
    let stopped = stop.await;
    let said = stopped.err().map(|e| format!(" ({e})")).unwrap_or_default();
    match live.await {
        Ok(all)
            if all
                .iter()
                .any(|s| s.id.as_deref() == Some(id) && s.is_live()) =>
        {
            Err(format!("it still runs after `claude stop {id}`{said}"))
        }
        Ok(_) => Ok(()),
        Err(e) => Err(format!(
            "whether it still runs after `claude stop {id}` could not be read{said}: {e}"
        )),
    }
}

/// The refusal a copy is answered with, once the stop of it was tried: `BG_RESUME_COPIED` where
/// the copy is gone, `BG_COPY_LEFT_RUNNING` where two sessions still hold one conversation.
pub fn copy_refusal(
    said: &str,
    name: &str,
    copy: Option<&str>,
    stopped: Result<(), String>,
) -> String {
    let said = said.trim();
    match (copy, stopped) {
        (Some(id), Ok(())) => format!(
            "[BG_RESUME_COPIED] Claude Code started a copy of {name}'s conversation instead of \
             continuing it, and the copy {id} was stopped at once: {said}"
        ),
        (Some(id), Err(why)) => format!(
            "[BG_COPY_LEFT_RUNNING] Claude Code started a copy {id} of {name}'s conversation \
             instead of continuing it, and it could not be stopped: {why}. Two sessions hold one \
             conversation until `claude stop {id}` ends the copy: {said}"
        ),
        (None, _) => format!(
            "[BG_COPY_LEFT_RUNNING] Claude Code started a copy of {name}'s conversation instead \
             of continuing it and named no id this box can stop it by: {said}"
        ),
    }
}

/// What `said` says this box started, with a copy it reports stopped before it is refused.
async fn answered(said: &str, name: &str, resuming: bool) -> Result<Started, String> {
    let Some(copy) = copy_in(said) else {
        return started_from(said, name, resuming);
    };
    let stopped = match copy.as_deref() {
        Some(id) => stop_copy(id, stop(id), roster::list()).await,
        None => Err("no id".into()),
    };
    Err(copy_refusal(said, name, copy.as_deref(), stopped))
}

/// Continue the stopped background session `session_id` in `cwd`, with the options it was
/// started with: its settings file is re-read, so a caller rewrites that file first.
pub async fn resume(session_id: &str, name: &str, cwd: &Path) -> Result<Started, String> {
    let said = claude(
        &["--bg".into(), "--resume".into(), session_id.into()],
        Some(cwd),
    )
    .await?;
    let mut s = answered(&said, name, true).await?;
    s.session_id = session_id.to_string();
    Ok(s)
}

/// Stop the session `id`; its conversation is kept.
pub async fn stop(id: &str) -> Result<(), String> {
    claude(&["stop".into(), id.into()], None).await.map(drop)
}

/// Restart the session `id` on the installed Claude Code, keeping its conversation.
pub async fn respawn(id: &str) -> Result<String, String> {
    claude(&["respawn".into(), id.into()], None).await
}

/// What the session `id` printed lately (`claude logs`).
pub async fn logs(id: &str) -> Result<String, String> {
    claude(&["logs".into(), id.into()], None).await
}

/// Run `claude <args>` with the launcher's scrubbed environment, its output answered whole.
async fn claude(args: &[String], cwd: Option<&Path>) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(super::claude_bin());
    cmd.args(args)
        .env_clear()
        .envs(
            KEPT_ENV
                .iter()
                .filter_map(|k| Some((*k, std::env::var_os(k)?))),
        )
        .env(UPDATER_OFF.0, UPDATER_OFF.1)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    output(cmd, args.first().map_or("", String::as_str)).await
}

/// What `cmd`, a `claude <verb> …`, printed, answered whole once it exits 0 within
/// [`COMMAND_WITHIN`].
pub(crate) async fn output(mut cmd: tokio::process::Command, verb: &str) -> Result<String, String> {
    let out = tokio::time::timeout(COMMAND_WITHIN, cmd.output())
        .await
        .map_err(|_| format!("`claude {verb}` did not end within {COMMAND_WITHIN:?}"))?
        .map_err(|e| format!("`claude {verb}` could not be run: {e}"))?;
    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    if !out.status.success() {
        return Err(format!(
            "`claude {verb}` exited {}: {}",
            out.status,
            said.trim()
        ));
    }
    Ok(said)
}

/// The settings a background session reads, as the runner writes them: peer messages taken
/// under bypass, no worktree isolation, the plugins this launch turns off, the permission relay
/// hooks ([`super::relay`]), and the session's own environment.
pub fn settings_doc(
    env: &[(String, String)],
    plugins_off: &[String],
    relay_hooks: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut env_map: serde_json::Map<String, serde_json::Value> = env
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
        .collect();
    env_map.insert(UPDATER_OFF.0.into(), UPDATER_OFF.1.into());
    let mut doc = serde_json::json!({
        "crossSessionInbound": "accept",
        "worktree": { "bgIsolation": "none" },
        "env": env_map,
    });
    if !plugins_off.is_empty() {
        doc["enabledPlugins"] = plugins_off
            .iter()
            .map(|id| (id.clone(), serde_json::Value::Bool(false)))
            .collect::<serde_json::Map<_, _>>()
            .into();
    }
    if let Some(hooks) = relay_hooks {
        doc["hooks"] = hooks;
        // the checkout-wide PermissionRequest hook then answers nothing beside the relay (ISS-1268 B3)
        let (key, on) = super::relay::RELAY_ENV;
        doc["env"][key] = on.into();
    }
    doc
}

/// Where the settings of the session named `name` are kept: this runner's own directory, read
/// by this user alone, at one path for the session's life, since a resume re-reads it there.
pub fn settings_path(name: &str) -> Result<PathBuf, String> {
    let dir = runner_platform::config::base_dir()
        .map_err(|e| format!("this runner's directory: {e}"))?
        .join("bg-sessions");
    Ok(dir.join(format!("{name}.settings.json")))
}

/// Write `doc` to `path`, owner-only: it carries the session's capability.
pub fn write_settings(path: &Path, doc: &serde_json::Value) -> Result<(), String> {
    let dir = path.parent().ok_or("a settings path with no directory")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.write_all(&body)
            .map_err(|e| format!("{}: {e}", tmp.display()))?;
    }
    #[cfg(not(unix))]
    std::fs::write(&tmp, &body).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_started_session_is_read_from_what_claude_printed_and_a_refusal_by_its_words() {
        let said = "Starting background service…\nbackgrounded \u{b7} a1afa5a5 \u{b7} forge-master-p\n  claude agents             list sessions\n";
        assert_eq!(
            started_from(said, "forge-master-p", false).unwrap().id,
            "a1afa5a5"
        );
        let woke = "note: woke session a1afa5a5 with its saved options (--name).\nbackgrounded \u{b7} a1afa5a5 \u{b7} forge-master-p (idle \u{2014} send a prompt to start)\n";
        assert_eq!(
            started_from(woke, "forge-master-p", true).unwrap().id,
            "a1afa5a5"
        );
        let untrusted = "Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.\n";
        let e = started_from(untrusted, "forge-master-p", false).unwrap_err();
        assert!(
            e.starts_with("[BG_SESSION_UNSTARTED]") && e.contains("not trusted"),
            "{e}"
        );
        let copy = "note: session a1afa5a5 is already running in the background, so this started a copy as 0eb283e6.\nbackgrounded \u{b7} 0eb283e6 \u{b7} forge-master-p\n";
        let e = started_from(copy, "forge-master-p", true).unwrap_err();
        assert!(e.starts_with("[BG_RESUME_COPIED]"), "{e}");
    }

    #[test]
    fn the_settings_carry_inbound_peer_messages_the_session_env_and_the_updater_off() {
        let doc = settings_doc(
            &[("FORGE_PROJECT_ID".into(), "p1".into())],
            &["forge@forge-local".into()],
            None,
        );
        assert_eq!(doc["crossSessionInbound"], "accept");
        assert_eq!(doc["worktree"]["bgIsolation"], "none");
        assert_eq!(doc["env"]["FORGE_PROJECT_ID"], "p1");
        assert_eq!(doc["env"]["DISABLE_AUTOUPDATER"], "1");
        assert_eq!(doc["enabledPlugins"]["forge@forge-local"], false);
        assert!(doc.get("hooks").is_none());
        assert!(doc["env"].get("FORGE_PERMISSION_RELAY").is_none());
        let relayed = settings_doc(
            &[],
            &[],
            Some(serde_json::json!({ "PermissionRequest": [] })),
        );
        assert_eq!(
            relayed["env"]["FORGE_PERMISSION_RELAY"], "1",
            "a relayed session's checkout-wide hook would deny beside its relay"
        );
    }

    #[test]
    fn a_launch_names_the_session_and_ends_its_flags_before_the_prompt() {
        let l = BgLaunch {
            name: "forge-master-p".into(),
            cwd: "/co".into(),
            settings: "/r/s.json".into(),
            permission_mode: "bypassPermissions".into(),
            model: Some("opus".into()),
            plugin_dirs: vec!["/plug".into()],
            prompt: Some("--not-a-flag brief".into()),
            ..BgLaunch::default()
        };
        let a = l.argv();
        assert_eq!(&a[..3], ["--bg", "--name", "forge-master-p"]);
        assert!(a.windows(2).any(|w| w == ["--plugin-dir", "/plug"]));
        assert_eq!(&a[a.len() - 2..], ["--", "--not-a-flag brief"]);
    }
}

#[cfg(all(test, unix))]
#[path = "copy_tests.rs"]
mod copy_tests;
