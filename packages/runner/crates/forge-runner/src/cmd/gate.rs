//! `gate` — the pane's own `PreToolUse` hook, asking whether the work its
//! master is about to hand out has been declared, and refusing a question
//! dialog a master pane opens (`daemon::master_question`, ISS-1385).
//!
//! Sibling of `hook`, and deliberately not part of it. That verb reports and
//! must never answer anything, so it prints `{}` the moment stdin is drained;
//! this one has to read the payload, ask the daemon and then print a decision.
//! Folding them together would put a decision path inside the one verb whose
//! whole contract is that it has none.
//!
//! What it shares with `hook` is the rule that matters: no path through it may
//! fail the agent that ran it. A deliberate deny is not a failure — it is the
//! answer — but a panic, a timeout or a daemon that is down must leave the
//! agent exactly as it found it. Every uncertain outcome therefore ALLOWS, and
//! leaves a mark that says the gate was not operating (`daemon::degraded`),
//! because a gate that silently stopped gating is the defect this issue exists
//! to end, arriving from inside the fix.

use std::path::{Path, PathBuf};

use clap::Args as ClapArgs;
use forge_runner_core::daemon::degraded::{mark, Kind, Mark, Run, Source};
use forge_runner_core::daemon::dispatch_gate::Dispatch;
use forge_runner_core::daemon::master_question::{self, Caller as DialogCaller, Verdict};
use forge_runner_core::daemon::{control, session_tokens};

const ANSWER_WITHIN: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(ClapArgs)]
pub struct Args {
    /// The Claude Code hook event name. `PreToolUse` is the only one served.
    #[arg(long)]
    pub event: String,
}

fn drain() -> Vec<u8> {
    use std::io::Read;
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
    sink
}

pub enum Payload {
    /// An ordinary tool call. Almost all of them; this hook runs in front of every tool.
    NotADispatch,
    /// This box could not read the payload at all.
    Malformed,
    /// A subagent is about to be dispatched, or a master is about to resume
    /// one with `SendMessage` (`Dispatch::resumes`).
    Dispatch(Dispatch),
}

/// The tool a master resumes a subagent it already started with.
const RESUME_TOOL: &str = "SendMessage";

pub fn dispatch_in(payload: &[u8]) -> Payload {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return Payload::Malformed;
    };
    if !v.is_object() {
        return Payload::Malformed;
    }
    let field = |k: &str| {
        v.get(k)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    if field("tool_name").as_deref() == Some(RESUME_TOOL) {
        let to = v
            .get("tool_input")
            .and_then(|t| t.get("to"))
            .and_then(serde_json::Value::as_str);
        return match (field("agent_id"), to) {
            (None, Some(to)) => Payload::Dispatch(Dispatch {
                resumes: Some(to.to_string()),
                tool_use_id: field("tool_use_id"),
                transcript_path: field("transcript_path"),
                ..Dispatch::default()
            }),
            _ => Payload::NotADispatch,
        };
    }
    let subagent_type = match v.get("tool_input") {
        None => return Payload::NotADispatch,
        Some(t) if !t.is_object() => return Payload::Malformed,
        Some(t) => match t.get("subagent_type") {
            None => return Payload::NotADispatch,
            Some(r) => match r.as_str() {
                None => return Payload::Malformed,
                Some(r) => r.to_string(),
            },
        },
    };
    Payload::Dispatch(Dispatch {
        agent_id: field("agent_id"),
        subagent_type: Some(subagent_type),
        tool_use_id: field("tool_use_id"),
        resumes: None,
        transcript_path: field("transcript_path"),
    })
}

fn deny(reason: &str) -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    })
    .to_string()
}

const ALLOW: &str = "{}";

/// Where this box's config, socket and marks live.
fn config_dir() -> Option<PathBuf> {
    forge_runner_core::daemon::control::config_dir()
}

/// Why a mark this process writes never names a run: the registry of declared
/// runs is the daemon's, and every path through here is one where the daemon
/// was not reached or did not decide.
const NO_RUN_HERE: &str = "the hook holds no registry of declared runs, so none was resolved here";

/// Who is asking, as far as the process this hook ran in can say.
pub enum Caller<'a> {
    /// A capability to ask the daemon with.
    Token(&'a str),
    /// None, and what the hook could establish about the process instead.
    Tokenless(Tokenless),
}

/// What a process holding no capability is (ISS-1316).
///
/// The hook is installed per checkout, so it runs in every Claude Code session
/// standing in one, and only panes the daemon placed carry a capability. The
/// two used to reach one branch that could tell nothing apart. The daemon's
/// record of each capability names the tmux session it placed the pane as, and
/// every pane it places is on its own tmux server, so the process's own `$TMUX`
/// and its session name separate them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tokenless {
    /// Not on the runner's tmux server, so not a pane the daemon placed and
    /// never the gate's subject.
    NotOurs,
    /// A pane the daemon placed for `project`, whose capability never reached
    /// its environment. `slug` is the record's, absent from one 0.17.72 wrote;
    /// `socket` is the runner tmux server the pane was found on.
    LostMint {
        pane: String,
        project: String,
        slug: Option<String>,
        socket: PathBuf,
    },
    /// On the runner's tmux server, in a session no capability names: a pane
    /// placed before capabilities carried their pane, or one this box did not
    /// place. Which, nothing here can say.
    Unrecorded { pane: String },
    /// Whether it is a pane the daemon placed could not be read, and why.
    Unknown(String),
}

/// Where a process stands against the runner's tmux server, read from its
/// `$TMUX`, the runner's socket and, only where the two match, its tmux
/// session name. The one reading both the capability check and the dialog
/// rule take, so the two cannot place the same process differently.
enum OnServer {
    NotOurs,
    Session { name: String, socket: PathBuf },
    Unknown(String),
}

fn on_server(
    tmux: Option<&str>,
    runner_socket: Option<&Path>,
    session_name: impl FnOnce(&Path) -> Result<String, String>,
) -> OnServer {
    let Some(tmux) = tmux.filter(|t| !t.is_empty()) else {
        return OnServer::NotOurs;
    };
    let mut parts = tmux.rsplitn(3, ',');
    let (Some(_session), Some(_pid), Some(socket)) = (parts.next(), parts.next(), parts.next())
    else {
        return OnServer::Unknown(format!(
            "$TMUX is `{tmux}`, which is not the `<socket>,<pid>,<session>` tmux sets"
        ));
    };
    let Some(runner) = runner_socket else {
        return OnServer::Unknown(
            "the runner's tmux socket could not be resolved, so whether this process runs on it is unknown"
                .to_string(),
        );
    };
    if !same_file(Path::new(socket), runner) {
        return OnServer::NotOurs;
    }
    match session_name(runner) {
        Ok(name) => OnServer::Session {
            name,
            socket: runner.to_path_buf(),
        },
        Err(why) => OnServer::Unknown(why),
    }
}

/// Classify a process from its `$TMUX`, the runner's tmux socket, and — only
/// where the two match — its tmux session name and the record naming it.
pub fn tokenless(
    tmux: Option<&str>,
    runner_socket: Option<&Path>,
    session_name: impl FnOnce(&Path) -> Result<String, String>,
    recorded_for: impl FnOnce(&str) -> Result<Option<session_tokens::Minted>, String>,
) -> Tokenless {
    let (pane, socket) = match on_server(tmux, runner_socket, session_name) {
        OnServer::NotOurs => return Tokenless::NotOurs,
        OnServer::Unknown(why) => return Tokenless::Unknown(why),
        OnServer::Session { name, socket } => (name, socket),
    };
    match recorded_for(&pane) {
        Ok(Some(minted)) => Tokenless::LostMint {
            pane,
            project: minted.project,
            slug: minted.slug,
            socket,
        },
        Ok(None) => Tokenless::Unrecorded { pane },
        Err(why) => Tokenless::Unknown(why),
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    let whole = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    whole(a) == whole(b)
}

/// The tmux session the pane `$TMUX_PANE` names belongs to, asked of the
/// runner's own server.
async fn session_of_this_pane(socket: &Path) -> Result<String, String> {
    #[expect(
        clippy::disallowed_methods,
        reason = "TMUX_PANE, the pane the hook runs in"
    )]
    let pane = std::env::var("TMUX_PANE")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| {
            "$TMUX names the runner's tmux server and $TMUX_PANE is unset".to_string()
        })?;
    let asked = tokio::process::Command::new("tmux")
        .arg("-S")
        .arg(socket)
        .args(["display-message", "-p", "-t", &pane, "#{session_name}"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    let out = match tokio::time::timeout(ANSWER_WITHIN, asked).await {
        Err(_) => {
            return Err("tmux did not say which session this pane is within the bound".into())
        }
        Ok(Err(e)) => {
            return Err(format!(
                "tmux could not be asked which session this pane is: {e}"
            ))
        }
        Ok(Ok(out)) => out,
    };
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || name.is_empty() {
        return Err(format!(
            "tmux did not say which session pane {pane} is ({})",
            out.status
        ));
    }
    Ok(name)
}

/// What the hook can establish about the process it ran in, holding no token.
async fn tokenless_here(dir: Option<&Path>) -> Tokenless {
    #[expect(
        clippy::disallowed_methods,
        reason = "TMUX, the server the hook runs under"
    )]
    let tmux = std::env::var("TMUX").ok();
    let socket = forge_runner_core::daemon::terminal::socket_path();
    let named = match (tmux.as_deref(), socket.as_deref()) {
        (Some(t), Some(sock)) if !t.is_empty() => Some(session_of_this_pane(sock).await),
        _ => None,
    };
    let tokens = dir.map(|d| session_tokens::SessionTokens::at(d.join("control-tokens.json")));
    tokenless(
        tmux.as_deref(),
        socket.as_deref(),
        |_| named.unwrap_or_else(|| Err("this process's tmux session was not asked".into())),
        |pane| {
            match tokens.as_ref() {
            None => Err("this box's config directory could not be resolved, so its capability records could not be read".into()),
            Some(store) => store
                .minted_for_pane(pane)
                .map_err(|e| e.to_string()),
        }
        },
    )
}

/// `s` as one single-quoted shell word, so a printed command runs as printed
/// whatever the path under it holds.
fn shell_word(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The refusal a pane that lost its capability is given: which pane, which
/// project, and the one command that ends it, with nothing left to fill in.
///
/// A master pane is one whose record's slug names it — the pane
/// `forge-runner master kill <slug>` reaches. Every other pane, a job's or a
/// master's whose record carries no slug, is ended on the runner's own tmux
/// server by name, since a bare `tmux` reaches the operator's default server
/// instead.
pub fn lost_mint_reason(pane: &str, project: &str, slug: Option<&str>, socket: &Path) -> String {
    use forge_runner_core::daemon::terminal::{session_name, JOB_PREFIX, MASTER_PREFIX};
    let placed = match slug {
        Some(slug) => format!("project {slug} ({project})"),
        None => format!(
            "project {project} (its record, written by forge-runner 0.17.72, names no slug)"
        ),
    };
    let by_name = format!(
        "`tmux -S {} kill-session -t {}` ends it on the runner's own tmux server",
        shell_word(&socket.to_string_lossy()),
        // `=`: tmux matches a bare target by prefix, and this names one pane.
        shell_word(&format!("={pane}"))
    );
    let (what, fix) = match slug.filter(|s| session_name(MASTER_PREFIX, s) == pane) {
        Some(slug) => (
            "the master pane",
            format!(
                "`forge-runner master kill {slug}` ends it, and the next master this box places \
                 for {slug} carries its capability"
            ),
        ),
        None if pane.starts_with(&format!("{JOB_PREFIX}-")) => (
            "a job pane",
            format!("{by_name}; this box then reports the job to core as having lost its pane"),
        ),
        None => ("a pane", by_name),
    };
    format!(
        "this process runs in {pane}, which the runner daemon placed as {what} for {placed}, and \
         the control capability it minted for it never reached this process \
         (FORGE_CONTROL_TOKEN is unset). Without it no run can be declared, so this hand-off \
         would be undeclared work. {fix}"
    )
}

async fn answer(dir: Option<&Path>, caller: Caller<'_>, d: &Dispatch) -> String {
    let open_because = |why: &str| -> String {
        if let Some(dir) = dir {
            mark(
                dir,
                &Mark::new(Kind::Degraded, Source::Hook, why, Run::Unknown(NO_RUN_HERE)).about(d),
            );
        }
        ALLOW.to_string()
    };
    // Said of the process this hook ran in, which is the only thing it can
    // see. Worded as a claim about "this pane" it was read on ISS-1192 as a
    // statement about the master, from a master whose own token was set.
    let token = match caller {
        Caller::Token(token) => token,
        Caller::Tokenless(Tokenless::NotOurs) => return ALLOW.to_string(),
        Caller::Tokenless(Tokenless::LostMint {
            pane,
            project,
            slug,
            socket,
        }) => {
            return deny(&lost_mint_reason(&pane, &project, slug.as_deref(), &socket));
        }
        Caller::Tokenless(Tokenless::Unrecorded { pane }) => {
            return open_because(&format!(
                "the process this hook ran in carries no control capability (FORGE_CONTROL_TOKEN \
                 is unset) and runs in {pane} on the runner's tmux server, which no capability \
                 record on this box names — a pane placed before capabilities named their pane, \
                 or one this box did not place — so nothing could be asked"
            ));
        }
        Caller::Tokenless(Tokenless::Unknown(why)) => {
            return open_because(&format!(
                "the process this hook ran in carries no control capability (FORGE_CONTROL_TOKEN \
                 is unset), and whether it runs in a pane this box placed could not be read \
                 ({why}), so nothing could be asked"
            ));
        }
    };
    let Some(sock) = dir.map(|d| d.join("control.sock")) else {
        return open_because("the control socket path could not be resolved");
    };
    if !sock.exists() {
        return open_because("the daemon's control socket is not there");
    }
    let asked = tokio::time::timeout(
        ANSWER_WITHIN,
        control::request_dispatch_gate(&sock, token, d),
    )
    .await;
    match asked {
        Err(_) => open_because("the daemon did not answer within the bound"),
        Ok(Err(e)) => open_because(&format!("the daemon could not be reached: {e}")),
        Ok(Ok(reply)) if reply.ok => ALLOW.to_string(),
        Ok(Ok(reply)) => match reply.reason.as_deref() {
            Some(r) if r == forge_runner_core::daemon::dispatch_gate::REFUSAL => deny(r),
            Some(other) => {
                open_because(&format!("the daemon refused the question itself: {other}"))
            }
            None => open_because("the daemon refused the question itself and said nothing"),
        },
    }
}

/// The tool a payload names, where it names one.
pub fn tool_named(payload: &[u8]) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(payload)
        .ok()?
        .get("tool_name")?
        .as_str()
        .map(str::to_string)
}

/// Which pane a call came from, from its `$TMUX`, the runner's tmux socket,
/// and — only where the two match — its tmux session name. Read at the call,
/// never from anything written at placement, so a master placed by an earlier
/// build is this rule's subject as soon as its box serves this one.
pub fn dialog_caller(
    tmux: Option<&str>,
    runner_socket: Option<&Path>,
    session_name: impl FnOnce(&Path) -> Result<String, String>,
) -> DialogCaller {
    match on_server(tmux, runner_socket, session_name) {
        OnServer::NotOurs => DialogCaller::NotOurs,
        OnServer::Session { name, .. } => DialogCaller::Session(name),
        OnServer::Unknown(why) => DialogCaller::Unknown(why),
    }
}

/// The gate's answer to a question dialog, marking an allowance it could not
/// decide.
async fn answer_dialog(dir: Option<&Path>) -> String {
    #[expect(
        clippy::disallowed_methods,
        reason = "TMUX, the server the hook runs under"
    )]
    let tmux = std::env::var("TMUX").ok();
    let socket = forge_runner_core::daemon::terminal::socket_path();
    let named = match (tmux.as_deref(), socket.as_deref()) {
        (Some(t), Some(sock)) if !t.is_empty() => Some(session_of_this_pane(sock).await),
        _ => None,
    };
    let caller = dialog_caller(tmux.as_deref(), socket.as_deref(), |_| {
        named.unwrap_or_else(|| Err("this process's tmux session was not asked".into()))
    });
    match master_question::decide(master_question::DIALOG_TOOL, &caller) {
        Verdict::Allow => ALLOW.to_string(),
        Verdict::Deny(why) => deny(&why),
        Verdict::AllowUndecided(why) => {
            if let Some(dir) = dir {
                mark(
                    dir,
                    &Mark::new(
                        Kind::Degraded,
                        Source::Hook,
                        &why,
                        Run::Unknown(NO_RUN_HERE),
                    ),
                );
            }
            ALLOW.to_string()
        }
    }
}

pub async fn run(args: Args) {
    let payload = drain();
    if args.event != "PreToolUse" {
        println!("{ALLOW}");
        return;
    }
    if tool_named(&payload).as_deref() == Some(master_question::DIALOG_TOOL) {
        println!("{}", answer_dialog(config_dir().as_deref()).await);
        return;
    }
    let d = match dispatch_in(&payload) {
        Payload::Dispatch(d) => d,
        Payload::NotADispatch => {
            println!("{ALLOW}");
            return;
        }
        Payload::Malformed => {
            if let Some(dir) = config_dir().as_deref() {
                mark(
                    dir,
                    &Mark::new(
                        Kind::Degraded,
                        Source::Hook,
                        "a PreToolUse payload this box could not read at all",
                        Run::Unknown(
                            "the payload named no dispatch this box could read, so nothing was \
                             resolved",
                        ),
                    ),
                );
            }
            println!("{ALLOW}");
            return;
        }
    };
    let token = session_tokens::token_from_env().ok();
    // A resume is never refused, so a process with no capability to bind it
    // with has nothing to ask.
    if d.resumes.is_some() && token.is_none() {
        println!("{ALLOW}");
        return;
    }
    let dir = config_dir();
    let caller = match token.as_deref() {
        Some(token) => Caller::Token(token),
        None => Caller::Tokenless(tokenless_here(dir.as_deref()).await),
    };
    println!("{}", answer(dir.as_deref(), caller, &d).await);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of this test's own, by the idiom this crate already uses
    /// (`daemon/held_report.rs`): keyed on pid and thread so two `cargo test`
    /// runs on one box cannot take each other's, and removed on the way out.
    struct Scratch(forge_runner_core::test_scratch::Scratch);

    /// The `sockaddr_un.sun_path` budget: 104 bytes on macOS against 108 on Linux.
    const SUN_LEN: usize = 104;

    impl Scratch {
        /// `name` is for the reader of the test: the shared counter is what keeps two apart.
        fn new(_name: &str) -> Self {
            let p = forge_runner_core::test_scratch::Scratch::short("gg");
            assert!(
                p.join("control.sock").as_os_str().len() < SUN_LEN,
                "a socket under this scratch would not fit in sun_path ({SUN_LEN}): {}",
                p.display()
            );
            Self(p)
        }
        fn path(&self) -> &std::path::Path {
            self.0.path()
        }
    }

    static SOURCE: std::sync::LazyLock<&str> =
        std::sync::LazyLock::new(|| forge_runner_core::test_scratch::lf(include_str!("gate.rs")));

    /// Criteria 11-16, at the source, because a behavioural test would have to
    /// reproduce four different outages separately and still would not catch
    /// the next early return somebody adds.
    #[test]
    fn no_path_through_this_verb_can_fail_the_agent_that_ran_it() {
        let body = SOURCE
            .split("pub async fn run(args: Args) {")
            .nth(1)
            .expect("the verb's body")
            .split("\n}")
            .next()
            .expect("its closing brace");
        assert!(
            !body.contains('?'),
            "a `?` here propagates a failure into the agent's hook exit code"
        );
        assert!(
            !body.contains("unwrap()") && !body.contains("expect("),
            "a panic in a hook is a non-zero exit in the agent's critical path"
        );
        assert!(
            body.trim_start().starts_with("let payload = drain();"),
            "stdin must be drained before ANY early return, or the agent takes a broken pipe"
        );
    }

    const DISPATCH: &str = r#"{"session_id":"d5953edb-97bc-42b8-891d-206e105903d7","cwd":"/tmp/x","permission_mode":"bypassPermissions","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"description":"Run echo command","prompt":"Run exactly this shell command","subagent_type":"general-purpose","run_in_background":false},"tool_use_id":"toolu_01WFynvjwEmYFcgyKTMn4J91"}"#;
    const INSIDE_A_CHILD: &str = r#"{"session_id":"d5953edb-97bc-42b8-891d-206e105903d7","agent_id":"acf9b1721de184fa7","agent_type":"general-purpose","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hi"},"tool_use_id":"toolu_02"}"#;
    const AN_ORDINARY_TOOL_CALL: &str = r#"{"session_id":"d5953edb","hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/x"},"tool_use_id":"toolu_03"}"#;

    const A_RESUME: &str = r#"{"session_id":"d5953edb","transcript_path":"/h/.claude/projects/p/d5953edb.jsonl","hook_event_name":"PreToolUse","tool_name":"SendMessage","tool_input":{"to":"a4301aac9619978a0","summary":"go on","message":"carry on"},"tool_use_id":"toolu_05"}"#;
    const A_RESUME_INSIDE_A_CHILD: &str = r#"{"session_id":"d5953edb","agent_id":"acf9b1721de184fa7","hook_event_name":"PreToolUse","tool_name":"SendMessage","tool_input":{"to":"a4301aac9619978a0","message":"hi"},"tool_use_id":"toolu_06"}"#;

    /// A master's `SendMessage` names the subagent it resumes and the
    /// transcript beside which that subagent's own is kept; one sent from
    /// inside a subagent is not a master's resume.
    #[test]
    fn a_master_resuming_a_subagent_is_read_as_naming_it() {
        let d = as_dispatch(A_RESUME);
        assert_eq!(d.resumes.as_deref(), Some("a4301aac9619978a0"));
        assert_eq!(
            d.transcript_path.as_deref(),
            Some("/h/.claude/projects/p/d5953edb.jsonl")
        );
        assert_eq!(d.subagent_type, None);
        assert!(matches!(
            dispatch_in(A_RESUME_INSIDE_A_CHILD.as_bytes()),
            Payload::NotADispatch
        ));
    }

    fn as_dispatch(payload: &str) -> Dispatch {
        match dispatch_in(payload.as_bytes()) {
            Payload::Dispatch(d) => d,
            _ => panic!("expected a dispatch"),
        }
    }

    #[test]
    fn a_dispatch_is_recognised_by_its_input_and_not_by_the_tools_name() {
        let d = as_dispatch(DISPATCH);
        assert_eq!(d.subagent_type.as_deref(), Some("general-purpose"));
        assert_eq!(
            d.tool_use_id.as_deref(),
            Some("toolu_01WFynvjwEmYFcgyKTMn4J91")
        );
        assert_eq!(
            d.agent_id, None,
            "the master's own dispatch carries no agent_id; that absence is the discriminator"
        );
    }

    #[test]
    fn a_tool_call_that_is_not_a_dispatch_never_reaches_the_socket() {
        assert!(matches!(
            dispatch_in(AN_ORDINARY_TOOL_CALL.as_bytes()),
            Payload::NotADispatch
        ));
    }

    #[test]
    fn a_tool_call_raised_inside_a_child_carries_the_childs_id() {
        // It is not a dispatch either, so it stops one step earlier — but when a
        // child DOES dispatch, the id is what tells the gate whose call it is.
        assert!(matches!(
            dispatch_in(INSIDE_A_CHILD.as_bytes()),
            Payload::NotADispatch
        ));
        let v: serde_json::Value = serde_json::from_str(INSIDE_A_CHILD).expect("json");
        assert!(v.get("agent_id").is_some());
    }

    #[test]
    fn a_payload_that_will_not_parse_is_malformed_and_not_merely_not_a_dispatch() {
        assert!(matches!(
            dispatch_in(b"not json at all"),
            Payload::Malformed
        ));
        assert!(matches!(dispatch_in(b""), Payload::Malformed));
        assert!(
            matches!(
                dispatch_in(AN_ORDINARY_TOOL_CALL.as_bytes()),
                Payload::NotADispatch
            ),
            "an ordinary tool call is not a failure and must leave no mark"
        );
    }

    #[test]
    fn a_payload_that_parses_but_whose_role_cannot_be_read_is_malformed_too() {
        // The shapes a harness change actually produces. Each one parses as JSON, so the
        // serde check alone lets all four through as "ordinary" and the gate goes quiet across
        // the fleet with the degraded count at zero.
        for p in [
            r#"{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"prompt":"go","subagent_type":null},"tool_use_id":"toolu_1"}"#,
            r#"{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":{"name":"runner"}},"tool_use_id":"toolu_1"}"#,
            r#"{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":"{\"subagent_type\":\"runner\"}"}"#,
            "null",
            "[]",
        ] {
            assert!(
                matches!(dispatch_in(p.as_bytes()), Payload::Malformed),
                "a payload this box cannot read the role out of is not an ordinary tool call: {p}"
            );
        }
    }

    #[test]
    fn the_ordinary_shapes_stay_silent_so_the_marks_keep_meaning_something() {
        // The other side of the same rule. If these ever start marking, `degraded` counts every
        // tool call on the box and the number stops being evidence of anything.
        for p in [
            AN_ORDINARY_TOOL_CALL,
            r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}"#,
            r#"{"hook_event_name":"PreToolUse","tool_name":"Bash"}"#,
        ] {
            assert!(
                matches!(dispatch_in(p.as_bytes()), Payload::NotADispatch),
                "an understood, ordinary tool call must leave no mark: {p}"
            );
        }
    }

    /// Criterion 2. The deny that reaches the model carries the way forward.
    #[test]
    fn the_deny_shape_is_the_one_claude_reads_and_carries_the_refusal() {
        let out = deny(forge_runner_core::daemon::dispatch_gate::REFUSAL);
        let v: serde_json::Value = serde_json::from_str(&out).expect("json");
        assert_eq!(
            v["hookSpecificOutput"]["permissionDecision"]
                .as_str()
                .unwrap_or_default(),
            "deny"
        );
        assert!(v["hookSpecificOutput"]["permissionDecisionReason"]
            .as_str()
            .unwrap_or_default()
            .contains("forge-runner run declare"));
    }

    /// The capability a pane the daemon spawned carries. Passed explicitly by
    /// every test that means to reach the socket, because taking it from the
    /// environment made these tests assert one thing locally and another on CI.
    const TOKEN: &str = "a-token-the-daemon-minted";

    /// Criteria 13, 17, 18. No socket on the box: the dispatch goes through and
    /// the mark that says so lands anyway.
    #[tokio::test]
    async fn no_control_socket_opens_the_gate_and_leaves_a_mark() {
        let dir = Scratch::new("gateverb-1");
        let d = as_dispatch(DISPATCH);
        assert_eq!(
            answer(Some(dir.path()), Caller::Token(TOKEN), &d).await,
            ALLOW
        );
        let (degraded, _) = forge_runner_core::daemon::degraded::tally(dir.path());
        assert_eq!(
            degraded.count, 1,
            "a gate that opened without deciding must say so: {degraded:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_daemon_that_never_answers_opens_the_gate_within_the_bound() {
        let dir = Scratch::new("gateverb-2");
        let sock = dir.path().join("control.sock");
        let listener = tokio::net::UnixListener::bind(&sock).expect("listener");
        // Accept and then say nothing at all, for as long as the test lives.
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                std::mem::forget(stream);
            }
        });
        let d = as_dispatch(DISPATCH);
        let began = std::time::Instant::now();
        assert_eq!(
            answer(Some(dir.path()), Caller::Token(TOKEN), &d).await,
            ALLOW
        );
        assert!(
            began.elapsed() < ANSWER_WITHIN * 3,
            "a silent daemon must not hold the master longer than the bound: {:?}",
            began.elapsed()
        );
        assert_eq!(
            forge_runner_core::daemon::degraded::tally(dir.path())
                .0
                .count,
            1
        );
    }

    /// Criterion 13, where nothing at all is resolvable. (This carried the label
    /// `Criterion 12` until ISS-1094's re-judge: it exercises an absent config
    /// directory, never an absent token, and C12 is the test directly below.)
    #[tokio::test]
    async fn a_pane_with_no_config_directory_still_opens_the_gate() {
        let d = as_dispatch(DISPATCH);
        assert_eq!(answer(None, Caller::Token(TOKEN), &d).await, ALLOW);
    }
    /// ISS-1316 criterion 18.
    #[tokio::test]
    async fn a_process_with_no_token_that_cannot_be_placed_opens_the_gate_and_leaves_a_mark() {
        let dir = Scratch::new("gateverb-3");
        let d = as_dispatch(DISPATCH);
        assert_eq!(
            answer(
                Some(dir.path()),
                Caller::Tokenless(Tokenless::Unknown(
                    "tmux could not be asked which session this pane is".into()
                )),
                &d
            )
            .await,
            ALLOW,
            "a pane that cannot authenticate to its own daemon still hands out work"
        );
        let (degraded, _) = forge_runner_core::daemon::degraded::tally(dir.path());
        assert_eq!(degraded.count, 1, "the box says the gate was not operating");
        let said = degraded.last.clone().unwrap_or_default();
        assert!(
            said.detail.contains("no control capability")
                && said
                    .detail
                    .contains("tmux could not be asked which session this pane is"),
            "the mark must name the CAPABILITY as what was missing, or it cannot be told from \
             the socket simply not being there, and what could not be read: {said:?}"
        );
        assert_eq!(
            said.source.as_deref(),
            Some("hook"),
            "the message is about the process that wrote it, and a mark that does not say which \
             process that was gets read as a statement about the master pane (ISS-1192): {said:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_daemon_that_refuses_the_question_itself_opens_the_gate_and_leaves_a_mark() {
        let dir = Scratch::new("gateverb-4");
        let sock = dir.path().join("control.sock");
        let listener = tokio::net::UnixListener::bind(&sock).expect("listener");
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            while let Ok((stream, _)) = listener.accept().await {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                let _ = reader.read_line(&mut line).await;
                let reply = serde_json::json!({
                    "ok": false,
                    "reason": "unknown session token"
                })
                .to_string();
                let _ = reader
                    .get_mut()
                    .write_all(format!("{reply}\n").as_bytes())
                    .await;
            }
        });
        let d = as_dispatch(DISPATCH);
        assert_eq!(
            answer(Some(dir.path()), Caller::Token(TOKEN), &d).await,
            ALLOW,
            "only the declaration's own refusal denies; every other ok:false is uncertainty"
        );
        let (degraded, _) = forge_runner_core::daemon::degraded::tally(dir.path());
        assert_eq!(
            degraded.count, 1,
            "an allowance the gate did not decide leaves a mark"
        );
        let why = degraded.last.clone().unwrap_or_default().detail;
        assert!(
            why.contains("refused the question itself"),
            "the daemon ANSWERED and its answer was a refusal of the question; a mark that does \
             not say so cannot be told from one the daemon never received: {why:?}"
        );
        assert!(
            why.contains("unknown session token"),
            "and the daemon's own words are carried through, so an operator learns WHY it \
             refused rather than only that it did: {why:?}"
        );
    }

    /// ISS-1316 criterion 17: a session the daemon never placed is not the
    /// gate's subject, so it is let through and nothing is recorded against it.
    #[tokio::test]
    async fn a_process_off_the_runners_tmux_server_is_let_through_unmarked() {
        let dir = Scratch::new("gateverb-notours");
        let d = as_dispatch(DISPATCH);
        assert_eq!(
            answer(Some(dir.path()), Caller::Tokenless(Tokenless::NotOurs), &d).await,
            ALLOW
        );
        let (degraded, undeclared) = forge_runner_core::daemon::degraded::tally(dir.path());
        assert_eq!(
            (degraded.count, undeclared.count),
            (0, 0),
            "not a pane that lost anything, so not a mark saying the gate stopped gating"
        );
    }

    /// ISS-1316 criteria 16 and 21.
    #[tokio::test]
    async fn a_placed_pane_whose_capability_never_arrived_is_refused_by_name() {
        let dir = Scratch::new("gateverb-lost");
        let d = as_dispatch(DISPATCH);
        let said = answer(
            Some(dir.path()),
            Caller::Tokenless(Tokenless::LostMint {
                pane: "forge-master-forge-dev".into(),
                project: "da368b0a".into(),
                slug: Some("forge-dev".into()),
                socket: RUNNER_SOCK.into(),
            }),
            &d,
        )
        .await;
        let v: serde_json::Value = serde_json::from_str(&said).expect("the deny shape");
        let out = &v["hookSpecificOutput"];
        assert_eq!(out["permissionDecision"], "deny", "{said}");
        let why = out["permissionDecisionReason"].as_str().unwrap_or("");
        assert!(
            why.contains("forge-master-forge-dev") && why.contains("project forge-dev"),
            "the refusal names the pane, and its project by slug: {why}"
        );
        assert!(
            why.contains("`forge-runner master kill forge-dev`") && !why.contains('<'),
            "and the command that ends it, filled in: {why}"
        );
        let (degraded, _) = forge_runner_core::daemon::degraded::tally(dir.path());
        assert_eq!(
            degraded.count, 0,
            "a refusal lets nothing through, so it is no admission"
        );
    }

    /// ISS-1316 criterion 19.
    #[tokio::test]
    async fn a_runner_pane_no_record_names_opens_the_gate_and_names_the_session() {
        let dir = Scratch::new("gateverb-unrec");
        let d = as_dispatch(DISPATCH);
        assert_eq!(
            answer(
                Some(dir.path()),
                Caller::Tokenless(Tokenless::Unrecorded {
                    pane: "forge-master-sidpeak".into()
                }),
                &d
            )
            .await,
            ALLOW
        );
        let (degraded, _) = forge_runner_core::daemon::degraded::tally(dir.path());
        assert_eq!(degraded.count, 1);
        let said = degraded.last.clone().unwrap_or_default();
        assert!(said.detail.contains("forge-master-sidpeak"), "{said:?}");
    }

    const RUNNER_SOCK: &str = "/home/u/.config/forge-runner/tmux.sock";

    fn record(project: &str, slug: Option<&str>, pane: &str) -> session_tokens::Minted {
        session_tokens::Minted {
            session: "sess-a".into(),
            project: project.into(),
            slug: slug.map(str::to_string),
            pane: pane.into(),
        }
    }

    /// `None` for a read the classification must not reach, which panics if it does.
    fn classify(
        tmux: Option<&str>,
        runner: Option<&str>,
        name: Option<Result<&str, &str>>,
        record: Option<Result<Option<session_tokens::Minted>, &str>>,
    ) -> Tokenless {
        tokenless(
            tmux,
            runner.map(Path::new),
            |_| {
                name.expect("the session name is asked only of a process on the runner's server")
                    .map(str::to_string)
                    .map_err(str::to_string)
            },
            |_| {
                record
                    .expect("the record is read only for a session name tmux gave")
                    .map_err(str::to_string)
            },
        )
    }

    #[test]
    fn a_process_outside_any_tmux_or_on_another_server_is_not_ours() {
        assert_eq!(
            classify(None, Some(RUNNER_SOCK), None, None),
            Tokenless::NotOurs
        );
        assert_eq!(
            classify(Some(""), Some(RUNNER_SOCK), None, None),
            Tokenless::NotOurs
        );
        assert_eq!(
            classify(
                Some("/tmp/tmux-1000/default,4242,0"),
                Some(RUNNER_SOCK),
                None,
                None
            ),
            Tokenless::NotOurs,
            "the operator's own tmux is not the runner's"
        );
    }

    #[test]
    fn a_process_on_the_runners_server_is_placed_by_its_session_name() {
        let on = Some("/home/u/.config/forge-runner/tmux.sock,4242,3");
        assert_eq!(
            classify(
                on,
                Some(RUNNER_SOCK),
                Some(Ok("forge-master-a")),
                Some(Ok(Some(record("proj-a", Some("a"), "forge-master-a"))))
            ),
            Tokenless::LostMint {
                pane: "forge-master-a".into(),
                project: "proj-a".into(),
                slug: Some("a".into()),
                socket: RUNNER_SOCK.into(),
            }
        );
        assert_eq!(
            classify(
                on,
                Some(RUNNER_SOCK),
                Some(Ok("forge-master-a")),
                Some(Ok(None))
            ),
            Tokenless::Unrecorded {
                pane: "forge-master-a".into()
            }
        );
    }

    #[test]
    fn a_process_that_cannot_be_placed_says_what_could_not_be_read() {
        let on = Some("/home/u/.config/forge-runner/tmux.sock,4242,3");
        for (got, want) in [
            (
                classify(on, None, None, None),
                "socket could not be resolved",
            ),
            (
                classify(on, Some(RUNNER_SOCK), Some(Err("tmux did not say")), None),
                "tmux did not say",
            ),
            (
                classify(
                    on,
                    Some(RUNNER_SOCK),
                    Some(Ok("forge-master-a")),
                    Some(Err("map torn")),
                ),
                "map torn",
            ),
            (
                classify(Some("garbage"), Some(RUNNER_SOCK), None, None),
                "garbage",
            ),
        ] {
            match got {
                Tokenless::Unknown(why) => assert!(why.contains(want), "{why}"),
                other => panic!("expected an unknown naming {want}, got {other:?}"),
            }
        }
    }

    /// ISS-1316 criterion 22: a job pane has no `master kill`, so it is given
    /// the command that reaches its pane on the runner's own server.
    #[test]
    fn a_job_pane_is_given_the_command_that_ends_it_on_the_runners_server() {
        let why = lost_mint_reason(
            "forge-job-j42",
            "proj-a",
            Some("sidpeak"),
            Path::new(RUNNER_SOCK),
        );
        assert!(
            why.contains(&format!(
                "`tmux -S '{RUNNER_SOCK}' kill-session -t '=forge-job-j42'`"
            )) && why.contains("a job pane")
                && why.contains("project sidpeak (proj-a)")
                && why.contains("lost its pane"),
            "{why}"
        );
        assert!(!why.contains("master kill") && !why.contains('<'), "{why}");
    }

    /// ISS-1316 criterion 23: a record 0.17.72 wrote carries no slug, so the
    /// project is named by id and the pane is ended by name.
    #[test]
    fn a_record_with_no_slug_names_the_project_by_id_and_a_command_needing_none() {
        let why = lost_mint_reason("forge-master-a", "proj-a", None, Path::new(RUNNER_SOCK));
        assert!(
            why.contains("project proj-a")
                && why.contains(&format!(
                    "`tmux -S '{RUNNER_SOCK}' kill-session -t '=forge-master-a'`"
                ))
                && !why.contains('<')
                && !why.contains("master kill"),
            "{why}"
        );
    }

    /// Criterion 21's boundary: a slug whose master pane is not this pane does
    /// not earn `master kill`, which would end a different pane.
    #[test]
    fn a_slug_that_names_another_pane_is_not_given_master_kill() {
        let why = lost_mint_reason(
            "forge-master-a-2",
            "proj-a",
            Some("a"),
            Path::new(RUNNER_SOCK),
        );
        assert!(
            !why.contains("master kill") && why.contains("kill-session -t '=forge-master-a-2'"),
            "{why}"
        );
    }

    const ASK: &str = r#"{"session_id":"d5953edb","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Merge PR #836?","header":"PR","options":[{"label":"yes"},{"label":"no"}],"multiSelect":false}]},"tool_use_id":"toolu_04"}"#;

    #[test]
    fn a_dialog_is_recognised_by_the_tool_it_names() {
        assert_eq!(
            tool_named(ASK.as_bytes()).as_deref(),
            Some("AskUserQuestion")
        );
        assert_eq!(
            tool_named(AN_ORDINARY_TOOL_CALL.as_bytes()).as_deref(),
            Some("Read")
        );
        assert_eq!(tool_named(b"not json"), None);
        assert!(
            matches!(dispatch_in(ASK.as_bytes()), Payload::NotADispatch),
            "a dialog is no dispatch, so the declaration check never sees it"
        );
    }

    fn caller(
        tmux: Option<&str>,
        runner: Option<&str>,
        name: Option<Result<&str, &str>>,
    ) -> DialogCaller {
        dialog_caller(tmux, runner.map(Path::new), |_| {
            name.expect("the session is asked only of a process on the runner's server")
                .map(str::to_string)
                .map_err(str::to_string)
        })
    }

    /// ISS-1385 criteria 1, 6, 7 and 8, at the classification.
    #[test]
    fn a_dialog_caller_is_placed_by_its_server_and_its_session_name() {
        let on = Some("/home/u/.config/forge-runner/tmux.sock,4242,3");
        assert_eq!(
            caller(on, Some(RUNNER_SOCK), Some(Ok("forge-master-a"))),
            DialogCaller::Session("forge-master-a".into())
        );
        assert_eq!(caller(None, Some(RUNNER_SOCK), None), DialogCaller::NotOurs);
        assert_eq!(
            caller(Some("/tmp/tmux-1000/default,1,0"), Some(RUNNER_SOCK), None),
            DialogCaller::NotOurs,
            "the operator's own tmux is not the runner's"
        );
        for (got, want) in [
            (caller(on, None, None), "socket could not be resolved"),
            (caller(Some("garbage"), Some(RUNNER_SOCK), None), "garbage"),
            (
                caller(on, Some(RUNNER_SOCK), Some(Err("tmux did not say"))),
                "tmux did not say",
            ),
        ] {
            match got {
                DialogCaller::Unknown(why) => assert!(why.contains(want), "{why}"),
                other => panic!("expected unknown naming {want}: {other:?}"),
            }
        }
    }

    /// ISS-1385 criterion 9: the dialog path is taken for that one tool alone.
    #[test]
    fn only_the_dialog_tool_takes_the_dialog_path() {
        let body = SOURCE
            .split("pub async fn run(args: Args) {")
            .nth(1)
            .expect("the verb's body");
        assert!(
            body.contains(
                "if tool_named(&payload).as_deref() == Some(master_question::DIALOG_TOOL)"
            ),
            "the dialog path is guarded by the tool's name"
        );
    }

    #[test]
    fn a_socket_path_holding_a_quote_is_still_one_shell_word() {
        assert_eq!(shell_word("/a b/it's"), r"'/a b/it'\''s'");
    }
}
