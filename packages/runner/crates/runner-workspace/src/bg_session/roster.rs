//! The roster: every session Claude Code's `claude agents --json` lists, read as it says it.
//!
//! Measured on 2.1.322 (ISS-1268 comment f095f341): `status` follows the live process (`idle`,
//! `busy`, `waiting`) and `state` goes stale; a stopped session is listed only with `--all`, with
//! no pid; one killed outright keeps a stale `working` for about 12 s and is then restarted under a
//! new pid. An interactive session (a terminal's own `claude`) is listed too, with no short `id`.

use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;

use super::{session_name, Kind};

/// How long `claude agents --json` may take before the roster counts as unread.
const LIST_WITHIN: Duration = Duration::from_secs(20);

/// One session as `claude agents --json` lists it. Every field but `sessionId` is optional: the
/// roster's own shape differs between interactive and background sessions, and a field it stops
/// sending is read as absent rather than failing the whole roster.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgSession {
    /// The short id `claude attach`, `stop`, `logs` and `respawn` take; background sessions only.
    #[serde(default)]
    pub id: Option<String>,
    pub session_id: String,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    /// `background` or `interactive`.
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// Absent once the process is gone (a stopped session under `--all`).
    #[serde(default)]
    pub pid: Option<u32>,
    /// `idle`, `busy` or `waiting`: the live process's own.
    #[serde(default)]
    pub status: Option<String>,
    /// `working`, `blocked`, `done`, ...: can lag the process.
    #[serde(default)]
    pub state: Option<String>,
    /// What a `waiting` session waits on, e.g. `permission prompt`.
    #[serde(default)]
    pub waiting_for: Option<String>,
    #[serde(default)]
    pub started_at: Option<i64>,
}

impl BgSession {
    pub fn is_background(&self) -> bool {
        self.kind.as_deref() == Some("background")
    }

    /// Whether a process runs it now.
    pub fn is_live(&self) -> bool {
        self.pid.is_some()
    }

    /// What it waits on, where it waits on a person: `waitingFor`, or `waiting` with none named.
    pub fn waiting(&self) -> Option<&str> {
        match (self.waiting_for.as_deref(), self.status.as_deref()) {
            (Some(w), _) if !w.is_empty() => Some(w),
            (_, Some("waiting")) => Some("an unnamed wait"),
            _ => None,
        }
    }
}

/// Why the roster could not be read: never the same answer as an empty roster.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("[BG_ROSTER_UNREAD] `claude agents --json` {0}")]
pub struct RosterError(pub String);

/// The roster as `text` holds it.
pub fn parse(text: &str) -> Result<Vec<BgSession>, RosterError> {
    serde_json::from_str(text.trim()).map_err(|e| {
        RosterError(format!(
            "printed what is not a list of sessions ({e}): {}",
            text.chars().take(200).collect::<String>()
        ))
    })
}

/// The live sessions.
pub async fn list() -> Result<Vec<BgSession>, RosterError> {
    read(&["agents", "--json"]).await
}

/// The live sessions and the stopped background ones.
pub async fn list_all() -> Result<Vec<BgSession>, RosterError> {
    read(&["agents", "--json", "--all"]).await
}

async fn read(args: &[&str]) -> Result<Vec<BgSession>, RosterError> {
    let mut cmd = tokio::process::Command::new(runner_platform::process::resolve_claude_bin());
    cmd.args(args)
        .env_remove("CLAUDECODE")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(LIST_WITHIN, cmd.output())
        .await
        .map_err(|_| RosterError(format!("did not answer within {LIST_WITHIN:?}")))?
        .map_err(|e| RosterError(format!("could not be run: {e}")))?;
    if !out.status.success() {
        return Err(RosterError(format!(
            "exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    parse(&String::from_utf8_lossy(&out.stdout))
}

/// The background session named for `slug`'s `kind` in `roster`: a live one before a stopped
/// one, the newest of each.
pub fn find<'a>(roster: &'a [BgSession], kind: Kind, slug: &str) -> Option<&'a BgSession> {
    named(roster, &session_name(kind, slug))
}

/// [`find`] by the session's name itself.
pub fn named<'a>(roster: &'a [BgSession], name: &str) -> Option<&'a BgSession> {
    roster
        .iter()
        .filter(|s| s.is_background() && s.name.as_deref() == Some(name))
        .max_by_key(|s| (s.is_live(), s.started_at.unwrap_or(0)))
}

/// The background session serving `slug`'s `kind`, live or stopped; `Ok(None)` where the roster
/// holds none, `Err` where it could not be read.
pub async fn session_for(kind: Kind, slug: &str) -> Result<Option<BgSession>, RosterError> {
    Ok(find(&list_all().await?, kind, slug).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rows as 2.1.322 printed them on this box (ISS-1268 probe), one of each shape.
    const ROSTER: &str = r#"[
      {"pid":433427,"cwd":"/p/core","kind":"interactive","startedAt":1,"sessionId":"i-1","name":"core-7c","status":"idle"},
      {"id":"aaaa1111","cwd":"/p/a","kind":"background","startedAt":5,"sessionId":"aaaa1111-x","name":"forge-master-a","state":"done"},
      {"pid":10,"id":"bbbb2222","cwd":"/p/a","kind":"background","startedAt":3,"sessionId":"bbbb2222-x","name":"forge-master-a","status":"busy","state":"working"},
      {"pid":11,"id":"cccc3333","cwd":"/p/b","kind":"background","startedAt":4,"sessionId":"cccc3333-x","name":"forge-chat-b","status":"waiting","state":"blocked","waitingFor":"permission prompt"},
      {"pid":12,"cwd":"/p/c","kind":"interactive","sessionId":"i-2","name":"forge-master-c","status":"busy","someFieldLater":true}
    ]"#;

    #[test]
    fn the_live_background_session_named_for_the_project_is_the_one_found() {
        let roster = parse(ROSTER).unwrap();
        let a = find(&roster, Kind::Master, "a").unwrap();
        assert_eq!(a.id.as_deref(), Some("bbbb2222"), "a stopped newer one won");
        let b = find(&roster, Kind::Chat, "b").unwrap();
        assert_eq!(b.waiting(), Some("permission prompt"));
        assert!(find(&roster, Kind::Chat, "a").is_none());
        assert!(
            find(&roster, Kind::Master, "c").is_none(),
            "an interactive session by the name is no background master"
        );
    }

    #[test]
    fn a_roster_that_is_not_a_list_is_refused_by_name_never_read_as_empty() {
        let e = parse("Starting background service…").unwrap_err();
        assert!(e.to_string().starts_with("[BG_ROSTER_UNREAD]"), "{e}");
        assert!(parse("[]").unwrap().is_empty());
    }

    #[test]
    fn a_waiting_session_with_no_reason_still_reads_as_waiting() {
        let s: BgSession = serde_json::from_str(r#"{"sessionId":"s","status":"waiting"}"#).unwrap();
        assert_eq!(s.waiting(), Some("an unnamed wait"));
        let idle: BgSession = serde_json::from_str(r#"{"sessionId":"s","status":"idle"}"#).unwrap();
        assert_eq!(idle.waiting(), None);
    }
}
