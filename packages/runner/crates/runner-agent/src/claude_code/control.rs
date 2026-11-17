//! What a person does to a running headless turn through the session's own stdin (ISS-1268): Stop
//! writes the stream-json `interrupt` control request, and a message sent while the turn runs is a
//! `user` line carrying its `priority` — `now` steers the turn (Claude Code ends the running reply
//! and answers it at once), `next` waits for the turn to end. The process stays alive either way:
//! the next message continues the same session. Measured on 2.1.322: an interrupt is answered
//! `control_response success` and the turn's `result` follows within 20 ms, `terminal_reason`
//! `aborted_streaming`.

use super::*;

/// When a message sent into a running turn is taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    /// Now: the running reply ends and this message is answered next.
    Now,
    /// After the running turn ends.
    Next,
}

impl Priority {
    /// The wire's word, or the refusal naming the one it did not know.
    pub fn parse(word: &str) -> Result<Self> {
        match word {
            "now" => Ok(Self::Now),
            "next" => Ok(Self::Next),
            other => Err(Error::Other(format!(
                "[STEER_PRIORITY_UNKNOWN] priority `{other}` is neither `now` nor `next`"
            ))),
        }
    }

    fn word(self) -> &'static str {
        match self {
            Self::Now => "now",
            Self::Next => "next",
        }
    }
}

/// The `interrupt` control request, as one stdin line.
pub(crate) fn interrupt_line(request_id: &str) -> String {
    let req = serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "interrupt" },
    });
    format!("{req}\n")
}

/// A user message for a running turn, as one stdin line carrying its priority.
pub(crate) fn steer_line(text: &str, priority: Priority) -> String {
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
        "priority": priority.word(),
    });
    format!("{msg}\n")
}

/// Whether a `result` ends a turn that an interrupt (or a message sent `now`) stopped: Claude Code
/// marks it `error_during_execution` with `is_error`, and names why in `terminal_reason`.
pub(crate) fn was_interrupted(result: &Value) -> bool {
    result.get("terminal_reason").and_then(Value::as_str) == Some("aborted_streaming")
}

impl ClaudeCodeRunner {
    /// Write the `interrupt` control request into `id`'s running turn. Refused by name where this
    /// box holds no headless process for `id`, or holds one with no turn running: there is nothing
    /// a control request could reach, and a kill is not what was asked.
    pub async fn interrupt(&self, id: &SessionId) -> Result<()> {
        if self.holds_pane(id).await {
            return Err(Error::Other(format!(
                "[INTERRUPT_NOT_HEADLESS] session {id} runs in a terminal pane, which reads no control request"
            )));
        }
        let mut map = self.sessions.lock().await;
        let sess = running(&mut map, id, "INTERRUPT")?;
        let line = interrupt_line(&format!("interrupt-{}", sess.turns + 1));
        write_line(sess, &line, "interrupt").await
    }

    /// Write `text` into `id`'s running turn with `priority`. The running turn's own sink takes
    /// what follows: Claude Code replays the message, and the turn ends with the `result` after
    /// which no written message is still queued.
    pub async fn steer(&self, id: &SessionId, text: &str, priority: Priority) -> Result<()> {
        let mut map = self.sessions.lock().await;
        let sess = running(&mut map, id, "STEER")?;
        write_line(sess, &steer_line(text, priority), "message").await?;
        sess.unreplayed += 1;
        Ok(())
    }
}

/// The session `id` with a turn running in a process whose stdin this box holds, or the refusal
/// naming which of those it lacks, under `what`'s code.
fn running<'a>(
    map: &'a mut HashMap<String, Session>,
    id: &str,
    what: &str,
) -> Result<&'a mut Session> {
    let sess = map.get_mut(id).ok_or_else(|| {
        Error::Other(format!(
            "[{what}_NO_SESSION] this box holds no process for session {id}"
        ))
    })?;
    if sess.stdin.is_none() {
        return Err(Error::Other(format!(
            "[{what}_NO_SESSION] session {id}'s process is closing and reads no more input"
        )));
    }
    if !sess.in_turn {
        return Err(Error::Other(format!(
            "[{what}_NO_TURN] session {id} has no turn running"
        )));
    }
    Ok(sess)
}

async fn write_line(sess: &mut Session, line: &str, what: &str) -> Result<()> {
    let stdin = sess
        .stdin
        .as_mut()
        .ok_or_else(|| Error::Other(format!("no stdin to write the {what} to")))?;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| Error::Other(format!("failed to write the {what}: {e}")))?;
    stdin
        .flush()
        .await
        .map_err(|e| Error::Other(format!("failed to flush the {what}: {e}")))
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
