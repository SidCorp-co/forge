//! What a running chat turn is producing right now, on core's live-only channel (ISS-1268).
//!
//! The session asks Claude Code for partial messages (`--include-partial-messages`), so the text
//! and thinking of a reply arrive as `stream_event` deltas long before the whole `assistant` line.
//! Those deltas are never stored — the stored transcript keeps the final message — so they go to
//! `POST /api/agent-sessions/:id/live`, which core fans out to the open views and forgets. So do the
//! frames that say what the turn is doing and that no transcript reader shows while it runs: its
//! status (`system/status`), a retry (`system/api_retry`), a compaction (`system/compact_boundary`),
//! a rate limit that is not `allowed` (`rate_limit_event`), the context it fills (`usage` and the
//! result's `modelUsage`), and the next prompt it suggests (`prompt_suggestion`).
//!
//! Each item is one of the shapes core's `@forge/contracts/agent-session-live` schema names, and
//! nothing here reads a field that schema does not carry.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use runner_transport::agent_sessions;
use runner_transport::CoreClient;

/// How often a running turn's live items go to core: a few frames a second reads as streaming.
pub(crate) const LIVE_INTERVAL: Duration = Duration::from_millis(120);

/// How long, after a turn's `result`, its session may still emit the next prompt it suggests:
/// Claude Code asks the model for one after the turn ends, within 30 s.
pub(crate) const SUGGESTION_WAIT: Duration = Duration::from_secs(30);

/// Batches waiting for the one task that posts them, in order; a full queue drops the newest.
const QUEUED_BATCHES: usize = 32;

/// The live items one stream-json line carries; none for a line that carries nothing live.
pub(crate) fn live_items(line: &Value) -> Vec<Value> {
    let str_of = |k: &str| line.get(k).and_then(Value::as_str);
    match (str_of("type"), str_of("subtype")) {
        (Some("stream_event"), _) => stream_items(line),
        (Some("system"), Some("status")) => {
            vec![json!({ "kind": "status", "status": line.get("status").and_then(Value::as_str) })]
        }
        (Some("system"), Some("api_retry")) => vec![json!({
            "kind": "retry",
            "attempt": line.get("attempt").and_then(Value::as_u64).unwrap_or(0),
            "maxRetries": line.get("max_retries").and_then(Value::as_u64).unwrap_or(0),
            "delayMs": line.get("retry_delay_ms").and_then(Value::as_u64).unwrap_or(0),
            "errorStatus": line.get("error_status").and_then(Value::as_u64),
        })],
        (Some("system"), Some("compact_boundary")) => {
            let meta = line.get("compact_metadata");
            let n = |k: &str| meta.and_then(|m| m.get(k)).and_then(Value::as_u64);
            vec![json!({
                "kind": "compacted",
                "trigger": meta.and_then(|m| m.get("trigger")).and_then(Value::as_str).unwrap_or("auto"),
                "preTokens": n("pre_tokens").unwrap_or(0),
                "postTokens": n("post_tokens"),
            })]
        }
        (Some("rate_limit_event"), _) => rate_limit(line).into_iter().collect(),
        (Some("prompt_suggestion"), _) => str_of("suggestion")
            .filter(|s| !s.trim().is_empty())
            .map(|s| json!({ "kind": "suggestion", "text": s }))
            .into_iter()
            .collect(),
        (Some("result"), _) => {
            let mut out = vec![json!({ "kind": "ended", "reason": str_of("terminal_reason") })];
            out.extend(context_window(line));
            out
        }
        _ => Vec::new(),
    }
}

/// A partial message's text, thinking, start and end; a top-level start also says the context.
fn stream_items(line: &Value) -> Vec<Value> {
    let parent = line.get("parent_tool_use_id").and_then(Value::as_str);
    let Some(event) = line.get("event") else {
        return Vec::new();
    };
    let message_id = line.get("api_message_id").and_then(Value::as_str);
    match event.get("type").and_then(Value::as_str) {
        Some("message_start") => {
            let id = event
                .pointer("/message/id")
                .and_then(Value::as_str)
                .or(message_id);
            let mut out = vec![json!({ "kind": "message", "id": id, "parent": parent })];
            if parent.is_none() {
                if let Some(used) = event.pointer("/message/usage").and_then(context_used) {
                    out.push(json!({ "kind": "context", "used": used, "window": null }));
                }
            }
            out
        }
        Some("message_stop") => {
            vec![json!({ "kind": "messageEnd", "id": message_id, "parent": parent })]
        }
        Some("content_block_delta") => {
            let delta = event.get("delta");
            let piece = |k: &str| delta.and_then(|d| d.get(k)).and_then(Value::as_str);
            match delta.and_then(|d| d.get("type")).and_then(Value::as_str) {
                Some("text_delta") => piece("text")
                    .filter(|t| !t.is_empty())
                    .map(|t| vec![json!({ "kind": "text", "text": t, "parent": parent })])
                    .unwrap_or_default(),
                Some("thinking_delta") => piece("thinking")
                    .filter(|t| !t.is_empty())
                    .map(|t| vec![json!({ "kind": "thinking", "text": t, "parent": parent })])
                    .unwrap_or_default(),
                _ => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}

/// The tokens a request put in the context: what it sent fresh plus what it read and wrote cached.
fn context_used(usage: &Value) -> Option<u64> {
    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    let used = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
    (used > 0).then_some(used)
}

/// The context a turn's result says its main model holds: the largest window `modelUsage` names.
fn context_window(result: &Value) -> Option<Value> {
    let window = result
        .get("modelUsage")
        .and_then(Value::as_object)?
        .values()
        .filter_map(|m| m.get("contextWindow").and_then(Value::as_u64))
        .max()?;
    Some(json!({ "kind": "context", "used": null, "window": window }))
}

/// A rate limit that holds the session back; an `allowed` one says nothing a person acts on.
fn rate_limit(line: &Value) -> Option<Value> {
    let info = line.get("rate_limit_info")?;
    let status = info.get("status").and_then(Value::as_str)?;
    (status != "allowed").then(|| {
        json!({
            "kind": "rateLimit",
            "status": status,
            "resetsAt": info.get("resetsAt").and_then(Value::as_u64),
            "limit": info.get("rateLimitType").and_then(Value::as_str),
        })
    })
}

/// Live items gathered between two sends; consecutive text or thinking of one message joined.
#[derive(Default)]
pub(crate) struct LiveBatch {
    items: Vec<Value>,
}

impl LiveBatch {
    pub(crate) fn push(&mut self, item: Value) {
        if let (Some(last), Some(kind)) = (
            self.items.last_mut(),
            item.get("kind").and_then(Value::as_str),
        ) {
            let joins = matches!(kind, "text" | "thinking")
                && last.get("kind") == item.get("kind")
                && last.get("parent") == item.get("parent");
            if joins {
                let more = item.get("text").and_then(Value::as_str).unwrap_or_default();
                let joined = format!(
                    "{}{more}",
                    last.get("text").and_then(Value::as_str).unwrap_or_default()
                );
                last["text"] = Value::String(joined);
                return;
            }
        }
        self.items.push(item);
    }

    pub(crate) fn take(&mut self) -> Option<Vec<Value>> {
        (!self.items.is_empty()).then(|| std::mem::take(&mut self.items))
    }
}

/// The one task that posts a session's live batches to core, in the order they were taken.
#[derive(Clone)]
pub(crate) struct LiveSender {
    tx: mpsc::Sender<Vec<Value>>,
}

impl LiveSender {
    pub(crate) fn start(client: &CoreClient, session_id: &str) -> Self {
        let (tx, mut rx) = mpsc::channel::<Vec<Value>>(QUEUED_BATCHES);
        let (client, session_id) = (client.clone(), session_id.to_string());
        tokio::spawn(async move {
            while let Some(items) = rx.recv().await {
                if let Err(e) = agent_sessions::post_live(&client, &session_id, &items).await {
                    tracing::debug!("[chat {session_id}] live items not shown: {e}");
                }
            }
        });
        Self { tx }
    }

    /// Hand `batch` to the posting task; a queue that is full drops it, as a late item is no use.
    pub(crate) fn send(&self, batch: &mut LiveBatch) {
        if let Some(items) = batch.take() {
            if self.tx.try_send(items).is_err() {
                tracing::debug!("[chat] live queue full — a batch of live items was dropped");
            }
        }
    }
}

/// After a turn ends, keep reading its session's lines for the next prompt it suggests, which
/// Claude Code emits after the `result`; ends at the suggestion, when the session's next turn takes
/// the sink, or after [`SUGGESTION_WAIT`].
pub(crate) fn watch_suggestion(live: LiveSender, mut rx: mpsc::Receiver<crate::RunnerEvent>) {
    tokio::spawn(async move {
        let wait = tokio::time::sleep(SUGGESTION_WAIT);
        tokio::pin!(wait);
        loop {
            tokio::select! {
                _ = &mut wait => return,
                ev = rx.recv() => match ev {
                    Some(crate::RunnerEvent::Stdout(line)) if line.get("type").and_then(Value::as_str) == Some("prompt_suggestion") => {
                        let mut batch = LiveBatch::default();
                        live_items(&line).into_iter().for_each(|i| batch.push(i));
                        live.send(&mut batch);
                        return;
                    }
                    Some(_) => {}
                    None => return,
                },
            }
        }
    });
}

#[cfg(test)]
#[path = "chat_live_tests.rs"]
mod tests;
