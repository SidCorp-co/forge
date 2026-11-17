//! One message into a background session over its peer socket, and the receipt that alone makes
//! it delivered.
//!
//! The wire, measured on 2.1.322 (ISS-1268 comments d2ebdae2, f095f341): the session's record
//! `<config>/sessions/<pid>.json` names `messagingSocketPath`; `<pid>.<hash>.key` holds the
//! `peerToken`. A sender writes `{"type":"auth","token":…}` then
//! `{"msgV":1,"msg_id":…,"type":"user","message":{"role":"user","content":…},"priority":…}`,
//! newline-delimited. The socket answers nothing either way; the session's transcript records the
//! message with `origin:{kind:"peer",msg_id}`, at once even mid-turn (0.38 s measured while a
//! 40 s Bash call ran), and that line is the receipt. A burst past the session's rate limit (30
//! per sender, refilling 0.5/s) is dropped with only a transcript line, `Dropped a peer message`.
//!
//! So: the socket is resolved by `sessionId` on every send (a respawn changes pid, socket and
//! key), sends to one session are paced [`PACE`] apart, an identical body is never sent twice
//! within [`SAME_BODY_WITHIN`], and a message is delivered only on its receipt within
//! [`RECEIPT_WITHIN`]. The token is read from its file into the frame and goes nowhere else.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

/// The message frame version this box writes.
pub const MSG_V: u64 = 1;
/// The `peerProtocol` a session record must carry for this box to write to it.
pub const PEER_PROTOCOL: u64 = 1;
/// How long a sent message may stand without its receipt before it is refused by name. The
/// receipt is written when the session queues the message, measured under half a second idle or
/// mid-tool-call, so 15 s is a dead session's bound, not a busy one's.
pub const RECEIPT_WITHIN: Duration = Duration::from_secs(15);
/// The least time between two sends from this box to one session (the session refills a sender
/// at 0.5 messages a second).
pub const PACE: Duration = Duration::from_secs(2);
/// A body sent to one session is not sent to it again within this: the session drops it.
pub const SAME_BODY_WITHIN: Duration = Duration::from_secs(30);
/// The transcript line a session writes for a peer message it dropped over its rate limit.
pub const DROPPED_LINE: &str = "Dropped a peer message";

/// Whether the message joins the running turn now, or waits for it to end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    /// Forge's "send now": taken into the running turn.
    Now,
    /// Forge's "after this turn": queued behind it.
    Next,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Priority::Now => "now",
            Priority::Next => "next",
        }
    }
}

/// A message the session's transcript shows it took.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub msg_id: String,
    /// The process that held the session when it took it.
    pub pid: u32,
    pub after: Duration,
}

/// Why a message is not delivered, each by name. None of them is the session ending: a session
/// whose process is gone may be mid-respawn, so only the roster says it stopped.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refused {
    #[error("[PEER_NO_LIVE_PROCESS] {0}")]
    NoLiveProcess(String),
    #[error("[PEER_PROTOCOL_UNKNOWN] {0}")]
    Protocol(String),
    #[error("[PEER_SAME_BODY] {0}")]
    SameBody(String),
    #[error("[PEER_SEND_FAILED] {0}")]
    Failed(String),
    #[error("[PEER_DELIVERY_UNCONFIRMED] {0}")]
    Unconfirmed(String),
}

/// A session's record, as far as a send reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub pid: u32,
    pub session_id: String,
    pub socket: PathBuf,
    pub cwd: Option<PathBuf>,
    pub proc_start: Option<String>,
    /// The pid namespace `pid` is in (`pidDomain`): a room agent's is its sandbox's.
    pub pid_domain: Option<String>,
    pub updated_at: i64,
}

/// `raw`, one `sessions/<pid>.json`, read as a record this box can write to, or why not.
pub fn check_record(raw: &Value) -> Result<Record, Refused> {
    let field = |k: &str| raw.get(k);
    let protocol = field("peerProtocol").and_then(Value::as_u64);
    if protocol != Some(PEER_PROTOCOL) {
        return Err(Refused::Protocol(format!(
            "the session record says peerProtocol {}, and this box writes protocol {PEER_PROTOCOL} \
             (msgV {MSG_V}); Claude Code {} is not the version this transport was built against",
            field("peerProtocol").map_or("(none)".into(), Value::to_string),
            field("version").and_then(Value::as_str).unwrap_or("(unnamed)")
        )));
    }
    let missing = |k: &str| {
        Refused::Protocol(format!(
            "the session record has no `{k}`, which a peer send needs"
        ))
    };
    Ok(Record {
        pid: field("pid")
            .and_then(Value::as_u64)
            .and_then(|p| u32::try_from(p).ok())
            .ok_or_else(|| missing("pid"))?,
        session_id: field("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| missing("sessionId"))?
            .to_string(),
        socket: field("messagingSocketPath")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| missing("messagingSocketPath"))?,
        cwd: field("cwd").and_then(Value::as_str).map(PathBuf::from),
        proc_start: field("procStart")
            .and_then(Value::as_str)
            .map(str::to_string),
        pid_domain: field("pidDomain")
            .and_then(Value::as_str)
            .map(str::to_string),
        updated_at: field("updatedAt").and_then(Value::as_i64).unwrap_or(0),
    })
}

/// Whether the record's process runs now, in whichever pid namespace it names, and is the process
/// the record was written by.
fn alive(rec: &Record) -> bool {
    super::pidns::host_pid(rec.pid, rec.pid_domain.as_deref())
        .is_some_and(|pid| alive_here(pid, rec.proc_start.as_deref()))
}

/// Whether `pid`, a pid of this box's, runs now and is the process that started at `proc_start`.
fn alive_here(pid: u32, proc_start: Option<&str>) -> bool {
    #[cfg(target_os = "linux")]
    {
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        let start = stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().nth(19));
        proc_start.is_none_or(|want| start == Some(want))
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let _ = proc_start;
        i32::try_from(pid)
            .is_ok_and(|p| nix::sys::signal::kill(nix::unistd::Pid::from_raw(p), None).is_ok())
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, proc_start);
        false
    }
}

/// The live record for `session_id` under `sessions`: the newest one whose process runs.
pub fn resolve_in(sessions: &Path, session_id: &str) -> Result<Record, Refused> {
    let entries = std::fs::read_dir(sessions).map_err(|e| {
        Refused::NoLiveProcess(format!("{} cannot be read: {e}", sessions.display()))
    })?;
    let mut found: Vec<Record> = Vec::new();
    let mut unknown: Option<Refused> = None;
    for path in entries.flatten().map(|e| e.path()) {
        if path.extension().is_none_or(|x| x != "json") {
            continue;
        }
        let Ok(raw) = std::fs::read(&path) else {
            continue;
        };
        let Ok(raw) = serde_json::from_slice::<Value>(&raw) else {
            continue;
        };
        if raw.get("sessionId").and_then(Value::as_str) != Some(session_id) {
            continue;
        }
        match check_record(&raw) {
            Ok(r) if alive(&r) => found.push(r),
            Ok(_) => {}
            Err(e) => unknown = Some(e),
        }
    }
    if let Some(live) = found.into_iter().max_by_key(|r| r.updated_at) {
        return Ok(live);
    }
    Err(unknown.unwrap_or_else(|| {
        Refused::NoLiveProcess(format!(
            "no record under {} names session {session_id} with its process running: stopped, or \
             mid-respawn",
            sessions.display()
        ))
    }))
}

/// The session's transcript: under the directory its working directory names, else wherever one
/// by its id is.
pub fn transcript_of(claude_dir: &Path, rec: &Record) -> Option<PathBuf> {
    let projects = claude_dir.join("projects");
    let file = format!("{}.jsonl", rec.session_id);
    if let Some(cwd) = &rec.cwd {
        let p = projects
            .join(runner_core::claude_paths::project_dir_name(cwd))
            .join(&file);
        if p.is_file() {
            return Some(p);
        }
    }
    std::fs::read_dir(&projects)
        .ok()?
        .flatten()
        .map(|d| d.path().join(&file))
        .find(|p| p.is_file())
}

/// What the transcript `text` (read from where the send started) says of `msg_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seen {
    Taken,
    Dropped(String),
    NotYet,
}

/// A message the session took between turns is a `user` line carrying it as its `origin`; one it
/// took mid-turn (measured on 2.1.322, ISS-1268 B4 plant, `b4wire/`) is only a `queued_command`
/// attachment carrying it as `attachment.origin`, and no later line names it. Either is its receipt.
pub fn seen_in(text: &str, msg_id: &str) -> Seen {
    for line in text.lines() {
        if line.contains(msg_id) {
            let origin = serde_json::from_str::<Value>(line).ok().and_then(|v| {
                let origin = v
                    .get("origin")
                    .or_else(|| v.get("attachment")?.get("origin"))?;
                origin.get("msg_id")?.as_str().map(str::to_string)
            });
            if origin.as_deref() == Some(msg_id) {
                return Seen::Taken;
            }
        }
        if line.contains(DROPPED_LINE) {
            return Seen::Dropped(line.chars().take(300).collect());
        }
    }
    Seen::NotYet
}

/// When this box last wrote to each session, and the bodies it wrote there lately.
static SENT: Mutex<Option<HashMap<String, Sent>>> = Mutex::new(None);

#[derive(Default)]
struct Sent {
    last: Option<Instant>,
    bodies: Vec<(u64, Instant)>,
}

fn body_hash(body: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    body.hash(&mut h);
    h.finish()
}

/// How long to wait before writing `body` to `session_id`, or a refusal for a body sent there
/// within [`SAME_BODY_WITHIN`]. Records the send as made.
fn take_turn(session_id: &str, body: &str) -> Result<Duration, Refused> {
    let mut g = SENT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let sent = g.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    let s = sent.entry(session_id.to_string()).or_default();
    s.bodies
        .retain(|(_, at)| now.duration_since(*at) < SAME_BODY_WITHIN);
    let hash = body_hash(body);
    if s.bodies.iter().any(|(h, _)| *h == hash) {
        return Err(Refused::SameBody(format!(
            "this box sent session {session_id} the same text under {}s ago, and the session drops \
             a repeated body; it is not sent again",
            SAME_BODY_WITHIN.as_secs()
        )));
    }
    let wait = s.last.map_or(Duration::ZERO, |l| {
        PACE.saturating_sub(now.duration_since(l))
    });
    s.last = Some(now + wait);
    s.bodies.push((hash, now + wait));
    Ok(wait)
}

/// Send `body` to `session_id` and wait for its receipt.
pub async fn send(session_id: &str, body: &str, priority: Priority) -> Result<Receipt, Refused> {
    let claude_dir = super::claude_dir()
        .ok_or_else(|| Refused::Failed("no Claude Code config directory can be named".into()))?;
    send_in(&claude_dir, session_id, body, priority).await
}

/// [`send`] against the Claude Code config directory `claude_dir`.
pub async fn send_in(
    claude_dir: &Path,
    session_id: &str,
    body: &str,
    priority: Priority,
) -> Result<Receipt, Refused> {
    send_bounded(claude_dir, session_id, body, priority, RECEIPT_WITHIN).await
}

async fn send_bounded(
    claude_dir: &Path,
    session_id: &str,
    body: &str,
    priority: Priority,
    within: Duration,
) -> Result<Receipt, Refused> {
    let wait = take_turn(session_id, body)?;
    tokio::time::sleep(wait).await;
    let rec = resolve_in(&claude_dir.join("sessions"), session_id)?;
    let transcript = transcript_of(claude_dir, &rec);
    let from = transcript
        .as_deref()
        .and_then(|p| std::fs::metadata(p).ok())
        .map_or(0, |m| m.len());
    let msg_id = uuid::Uuid::new_v4().to_string();
    let frame = serde_json::json!({
        "msgV": MSG_V,
        "msg_id": msg_id,
        "type": "user",
        "message": { "role": "user", "content": body },
        "priority": priority.as_str(),
    });
    let started = Instant::now();
    write(claude_dir, &rec, &frame).await?;
    let at = Sending {
        rec: &rec,
        from,
        msg_id: &msg_id,
        started,
        within,
    };
    at.wait_receipt(claude_dir, transcript).await
}

/// One write's place in the session's transcript, waited on for its receipt.
struct Sending<'a> {
    rec: &'a Record,
    from: u64,
    msg_id: &'a str,
    started: Instant,
    within: Duration,
}

impl Sending<'_> {
    async fn wait_receipt(
        &self,
        claude_dir: &Path,
        mut transcript: Option<PathBuf>,
    ) -> Result<Receipt, Refused> {
        let Self {
            rec,
            from,
            msg_id,
            started,
            within,
        } = *self;
        loop {
            if transcript.is_none() {
                transcript = transcript_of(claude_dir, rec);
            }
            if let Some(text) = transcript.as_deref().and_then(|p| read_from(p, from)) {
                match seen_in(&text, msg_id) {
                    Seen::Taken => {
                        return Ok(Receipt {
                            msg_id: msg_id.to_string(),
                            pid: rec.pid,
                            after: started.elapsed(),
                        })
                    }
                    Seen::Dropped(line) => {
                        return Err(Refused::Unconfirmed(format!(
                            "session {} dropped message {msg_id} over its peer rate limit: {line}",
                            rec.session_id
                        )))
                    }
                    Seen::NotYet => {}
                }
            }
            if started.elapsed() >= within {
                return Err(Refused::Unconfirmed(format!(
                "message {msg_id} to session {} (pid {}) stood {}s with no line in {} naming it",
                rec.session_id,
                rec.pid,
                within.as_secs(),
                transcript.map_or_else(
                    || "a transcript the box could not find".to_string(),
                    |p| p.display().to_string()
                )
            )));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

fn read_from(path: &Path, from: u64) -> Option<String> {
    use std::io::{Read as _, Seek as _};
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(std::io::SeekFrom::Start(from)).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

/// The `peerToken` for `pid`, read from its one key file; never logged, never returned past the
/// frame it goes into.
fn token_for(sessions: &Path, pid: u32) -> Result<String, Refused> {
    let prefix = format!("{pid}.");
    let keys: Vec<PathBuf> = std::fs::read_dir(sessions)
        .map_err(|e| Refused::Failed(format!("{}: {e}", sessions.display())))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|x| x == "key")
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(&prefix))
        })
        .collect();
    let [key] = keys.as_slice() else {
        return Err(Refused::Protocol(format!(
            "expected one key file for pid {pid} under {}, found {}",
            sessions.display(),
            keys.len()
        )));
    };
    let raw: Value = std::fs::read(key)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| Refused::Protocol(format!("the key file for pid {pid} is not JSON")))?;
    raw.get("peerToken")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| Refused::Protocol(format!("the key file for pid {pid} has no peerToken")))
}

#[cfg(unix)]
async fn write(claude_dir: &Path, rec: &Record, frame: &Value) -> Result<(), Refused> {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let token = token_for(&claude_dir.join("sessions"), rec.pid)?;
    let mut wire = serde_json::json!({ "type": "auth", "token": token }).to_string();
    wire.push('\n');
    wire.push_str(&frame.to_string());
    wire.push('\n');
    let failed = |what: &str, e: std::io::Error| {
        Refused::Failed(format!("{what} {}: {e}", rec.socket.display()))
    };
    let io = async {
        let mut s = tokio::net::UnixStream::connect(&rec.socket)
            .await
            .map_err(|e| failed("connect", e))?;
        s.write_all(wire.as_bytes())
            .await
            .map_err(|e| failed("write", e))?;
        s.shutdown().await.map_err(|e| failed("shutdown", e))?;
        let mut reply = Vec::new();
        let _ = s.read_to_end(&mut reply).await;
        Ok::<_, Refused>(reply)
    };
    let reply = tokio::time::timeout(Duration::from_secs(5), io)
        .await
        .map_err(|_| {
            Refused::Failed(format!("{} did not close within 5s", rec.socket.display()))
        })??;
    if !reply.is_empty() {
        tracing::info!(
            "[bg] session {} answered a peer write: {}",
            rec.session_id,
            String::from_utf8_lossy(&reply)
                .chars()
                .take(300)
                .collect::<String>()
        );
    }
    Ok(())
}

#[cfg(not(unix))]
async fn write(_: &Path, rec: &Record, _: &Value) -> Result<(), Refused> {
    Err(Refused::Failed(format!(
        "{}: a peer socket is a unix socket, which this platform has no writer for",
        rec.socket.display()
    )))
}

#[cfg(test)]
#[path = "peer_tests.rs"]
pub(super) mod tests;
