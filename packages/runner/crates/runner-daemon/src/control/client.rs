use super::*;

/// Declare a run from a pane, over the control socket.
#[cfg(unix)]
pub async fn request_run_declare(
    path: &std::path::Path,
    token: &str,
    project_id: &str,
    issue_keys: &[String],
    worktree_path: &str,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({
            "op": "run_declare", "token": token, "projectId": project_id,
            "issueKeys": issue_keys, "worktreePath": worktree_path
        }),
    )
    .await
}

#[cfg(unix)]
pub async fn request_run_choice(
    path: &std::path::Path,
    token: &str,
    run_id: &str,
    choice: &str,
    why: &str,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({
            "op": "run_choice", "token": token, "runId": run_id,
            "choice": choice, "why": why
        }),
    )
    .await
}

/// Close a declared run from a pane, over the control socket.
#[cfg(unix)]
pub async fn request_run_close(
    path: &std::path::Path,
    token: &str,
    run_id: &str,
    reason: Option<&str>,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({ "op": "run_close", "token": token, "runId": run_id, "reason": reason }),
    )
    .await
}

#[cfg(not(unix))]
pub async fn request_run_declare(
    _path: &std::path::Path,
    _token: &str,
    _project_id: &str,
    _issue_keys: &[String],
    _worktree_path: &str,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

#[cfg(not(unix))]
pub async fn request_run_choice(
    _path: &std::path::Path,
    _token: &str,
    _run_id: &str,
    _choice: &str,
    _why: &str,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

#[cfg(not(unix))]
pub async fn request_run_close(
    _path: &std::path::Path,
    _token: &str,
    _run_id: &str,
    _reason: Option<&str>,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

#[cfg(not(unix))]
pub async fn request_agent_event(
    _path: &std::path::Path,
    _token: &str,
    _event: &str,
    _names: &HookNames,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

#[cfg(not(unix))]
pub async fn request_dispatch_gate(
    _path: &std::path::Path,
    _token: &str,
    _d: &runner_core::dispatch_gate::Dispatch,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

#[cfg(not(unix))]
pub(crate) fn no_socket() -> std::io::Error {
    std::io::Error::other(
        "the control socket needs a unix socket; this platform cannot report a turn boundary",
    )
}

/// Tell a running daemon what this session's hooks just reported.
#[cfg(unix)]
pub async fn request_agent_event(
    path: &std::path::Path,
    token: &str,
    event: &str,
    names: &HookNames,
) -> std::io::Result<ClaimReply> {
    ask(path, agent_event_frame(token, event, names)).await
}

/// The frame the pane's hook puts on the socket for one event, built where a
/// test can decode it into `Request` without a socket.
pub fn agent_event_frame(token: &str, event: &str, names: &HookNames) -> serde_json::Value {
    serde_json::json!({
        "op": "agent_event", "token": token, "event": event,
        "agentId": names.agent_id, "conversationId": names.conversation_id,
        "agentType": names.agent_type, "transcriptPath": names.transcript_path
    })
}

/// The frame the pane's hook puts on the socket, built where a test can decode it
/// into `Request` without a socket — a hand-written copy of it is a second wire
/// contract that parts from this one in silence.
pub fn dispatch_gate_frame(
    token: &str,
    d: &runner_core::dispatch_gate::Dispatch,
) -> serde_json::Value {
    serde_json::json!({
        "op": "dispatch_gate", "token": token,
        "agentId": d.agent_id, "subagentType": d.subagent_type,
        "toolUseId": d.tool_use_id
    })
}

/// Ask whether the work about to be handed out has been declared.
#[cfg(unix)]
pub async fn request_dispatch_gate(
    path: &std::path::Path,
    token: &str,
    d: &runner_core::dispatch_gate::Dispatch,
) -> std::io::Result<ClaimReply> {
    ask(path, dispatch_gate_frame(token, d)).await
}

#[cfg(unix)]
pub(crate) async fn ask(
    path: &std::path::Path,
    body: serde_json::Value,
) -> std::io::Result<ClaimReply> {
    let stream = UnixStream::connect(path).await?;
    let mut reader = BufReader::new(stream);
    let mut line = serde_json::to_string(&body)?;
    line.push('\n');
    reader.get_mut().write_all(line.as_bytes()).await?;
    let mut resp = String::new();
    reader.read_line(&mut resp).await?;
    serde_json::from_str(&resp)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))
}
