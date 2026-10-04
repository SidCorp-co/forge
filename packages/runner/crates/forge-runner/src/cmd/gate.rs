//! `gate` — the pane's own `PreToolUse` hook, asking whether the work its
//! master is about to hand out has been declared.
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
use runner_core::degraded::{mark, Kind, Mark, Run, Source};
use runner_core::dispatch_gate::Dispatch;
use runner_daemon::{control, session_tokens};

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
    /// A subagent is about to be dispatched.
    Dispatch(Dispatch),
}

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
    runner_platform::config::config_dir()
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

/// Classify a process from its `$TMUX`, the runner's tmux socket, and — only
/// where the two match — its tmux session name and the record naming it.
pub fn tokenless(
    tmux: Option<&str>,
    runner_socket: Option<&Path>,
    session_name: impl FnOnce(&Path) -> Result<String, String>,
    recorded_for: impl FnOnce(&str) -> Result<Option<session_tokens::Minted>, String>,
) -> Tokenless {
    let Some(tmux) = tmux.filter(|t| !t.is_empty()) else {
        return Tokenless::NotOurs;
    };
    let mut parts = tmux.rsplitn(3, ',');
    let (Some(_session), Some(_pid), Some(socket)) = (parts.next(), parts.next(), parts.next())
    else {
        return Tokenless::Unknown(format!(
            "$TMUX is `{tmux}`, which is not the `<socket>,<pid>,<session>` tmux sets"
        ));
    };
    let Some(runner) = runner_socket else {
        return Tokenless::Unknown(
            "the runner's tmux socket could not be resolved, so whether this process runs on it is unknown"
                .to_string(),
        );
    };
    if !same_file(Path::new(socket), runner) {
        return Tokenless::NotOurs;
    }
    let pane = match session_name(runner) {
        Ok(pane) => pane,
        Err(why) => return Tokenless::Unknown(why),
    };
    match recorded_for(&pane) {
        Ok(Some(minted)) => Tokenless::LostMint {
            pane,
            project: minted.project,
            slug: minted.slug,
            socket: runner.to_path_buf(),
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
    let tmux = std::env::var("TMUX").ok();
    let socket = runner_workspace::terminal::socket_path();
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
    use runner_workspace::terminal::{session_name, JOB_PREFIX, MASTER_PREFIX};
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
            Some(r) if r == runner_core::dispatch_gate::REFUSAL => deny(r),
            Some(other) => {
                open_because(&format!("the daemon refused the question itself: {other}"))
            }
            None => open_because("the daemon refused the question itself and said nothing"),
        },
    }
}

pub async fn run(args: Args) {
    let payload = drain();
    if args.event != "PreToolUse" {
        println!("{ALLOW}");
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
    let dir = config_dir();
    let caller = match token.as_deref() {
        Some(token) => Caller::Token(token),
        None => Caller::Tokenless(tokenless_here(dir.as_deref()).await),
    };
    println!("{}", answer(dir.as_deref(), caller, &d).await);
}
