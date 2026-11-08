//! One pane turn read from what the pane's session writes (ISS-946): its transcript, and the
//! events its hooks append. Pure, so each rule is asserted without a pane.
//!
//! What the headless stream gave and where a pane's turn finds it, measured on Claude Code
//! 2.1.319 (`docs/proposals/rocketchat-support-session.md`, the ISS-946 section):
//! - the lines core keeps: the transcript's `assistant` and `user` lines, the same shape the
//!   stream printed, one `assistant` line per content block, each repeating its message's usage;
//! - the turn's end: the `Stop` hook, once per turn, naming the session;
//! - a message typed while a turn runs: a `queue-operation` `enqueue` in the transcript, met by a
//!   `remove` when the turn takes it or a `dequeue` when it runs as a turn of its own after the
//!   Stop, and a `UserPromptSubmit` for it either way;
//! - the tokens: each assistant message's `usage`, counted once per message id;
//! - the cost: no transcript line carries one. The status line's payload carries Claude Code's
//!   own running `cost.total_cost_usd` for the session, a fraction of a second after the Stop; the
//!   turn's cost is that figure less the one standing before the turn. Where either is missing the
//!   cost is recorded as unread, never estimated here.

use std::collections::HashMap;

use serde_json::{json, Value};

/// How long after a turn's Stop the box waits for the status line that carries its cost.
pub(crate) const COST_AFTER_STOP_MS: i64 = 3_000;

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub(crate) struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

impl Usage {
    fn of(v: &Value) -> Self {
        let n = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
        Self {
            input: n("input_tokens"),
            output: n("output_tokens"),
            cache_read: n("cache_read_input_tokens"),
            cache_creation: n("cache_creation_input_tokens"),
        }
    }
}

/// The turn's cost as the pane could read it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Cost {
    /// Claude Code's own running cost after the turn, less the one before it.
    Read(f64),
    /// Not read, and why: nothing stands in for it.
    Unread(&'static str),
}

/// Claude Code's running cost for the session, as the status line last said it, and when.
pub(crate) fn status_cost(payload: &Value) -> Option<f64> {
    payload
        .get("cost")
        .and_then(|c| c.get("total_cost_usd"))
        .and_then(Value::as_f64)
}

/// The turn's cost from the running cost before it and the first one read after its Stop.
pub(crate) fn turn_cost(before: Option<f64>, after: Option<f64>) -> Cost {
    match (before, after) {
        (_, None) => Cost::Unread("no status line came within 3 s of the turn's Stop"),
        (None, Some(_)) => Cost::Unread("no status line stood before the turn to measure from"),
        (Some(b), Some(a)) if a + 1e-9 < b => {
            Cost::Unread("the running cost read after the turn was below the one before it")
        }
        (Some(b), Some(a)) => Cost::Read(((a - b) * 1e8).round() / 1e8),
    }
}

/// What one turn's transcript said so far.
#[derive(Debug, Default)]
pub(crate) struct Tally {
    usage: HashMap<String, Usage>,
    messages: Vec<String>,
    /// Typed messages the session queued and has not yet taken: `enqueue` less `remove`/`dequeue`.
    queued: u32,
    duration_ms: Option<u64>,
    usage_limit: Option<String>,
}

impl Tally {
    /// Read one transcript line, answering it where it is one core keeps.
    pub(crate) fn read(&mut self, line: &Value) -> Option<Value> {
        match line.get("type").and_then(Value::as_str) {
            Some("queue-operation") => {
                match line.get("operation").and_then(Value::as_str) {
                    Some("enqueue") => self.queued += 1,
                    Some(_) => self.queued = self.queued.saturating_sub(1),
                    None => {}
                }
                None
            }
            Some("system") => {
                if line.get("subtype").and_then(Value::as_str) == Some("turn_duration") {
                    let d = line.get("durationMs").and_then(Value::as_u64).unwrap_or(0);
                    self.duration_ms = Some(self.duration_ms.unwrap_or(0) + d);
                }
                None
            }
            Some("assistant") if !sidechain(line) => {
                if let Some(msg) = line.get("message") {
                    if let Some(id) = msg.get("id").and_then(Value::as_str) {
                        if !self.usage.contains_key(id) {
                            self.messages.push(id.to_string());
                        }
                        if let Some(u) = msg.get("usage") {
                            self.usage.insert(id.to_string(), Usage::of(u));
                        }
                    }
                }
                if self.usage_limit.is_none() {
                    self.usage_limit = super::outcome::detect_usage_limit(line);
                }
                Some(line.clone())
            }
            Some("user") if !sidechain(line) => Some(line.clone()),
            _ => None,
        }
    }

    /// Messages typed into the turn that the session has not yet taken.
    pub(crate) fn queued(&self) -> u32 {
        self.queued
    }

    pub(crate) fn usage_limit(&self) -> Option<&str> {
        self.usage_limit.as_deref()
    }

    pub(crate) fn usage(&self) -> Usage {
        self.usage.values().fold(Usage::default(), |t, u| Usage {
            input: t.input + u.input,
            output: t.output + u.output,
            cache_read: t.cache_read + u.cache_read,
            cache_creation: t.cache_creation + u.cache_creation,
        })
    }

    /// The `result` line the headless stream ended a turn with, made from what the transcript and
    /// the status line said, and naming where each figure came from.
    pub(crate) fn result_line(&self, session_id: &str, cost: &Cost) -> Value {
        let u = self.usage();
        let mut line = json!({
            "type": "result",
            "subtype": if self.usage_limit.is_some() { "error_during_execution" } else { "success" },
            "is_error": self.usage_limit.is_some(),
            "session_id": session_id,
            "num_turns": self.messages.len(),
            "usage": {
                "input_tokens": u.input,
                "output_tokens": u.output,
                "cache_read_input_tokens": u.cache_read,
                "cache_creation_input_tokens": u.cache_creation,
            },
            "forge_pane": {
                "tokens": "transcript: each assistant message's usage, once per message id",
                "cost": match cost {
                    Cost::Read(_) => json!("status line: Claude Code's running total_cost_usd after the turn's Stop, less the one before the turn"),
                    Cost::Unread(why) => json!({ "unread": why }),
                },
            },
        });
        if let Some(d) = self.duration_ms {
            line["duration_ms"] = d.into();
        }
        if let Cost::Read(usd) = cost {
            line["total_cost_usd"] = (*usd).into();
        }
        line
    }

    /// Start the next turn: a message still queued is carried, everything else is this turn's.
    pub(crate) fn next_turn(&mut self) {
        let queued = self.queued;
        *self = Self {
            queued,
            ..Self::default()
        };
    }
}

fn sidechain(line: &Value) -> bool {
    line.get("isSidechain").and_then(Value::as_bool) == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant(id: &str, block: &str, out: u64) -> Value {
        json!({"type":"assistant","isSidechain":false,"message":{"id":id,"content":[{"type":block}],
            "usage":{"input_tokens":2,"output_tokens":out,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}})
    }

    #[test]
    fn tokens_are_counted_once_per_message_though_each_block_repeats_them() {
        let mut t = Tally::default();
        assert!(t.read(&assistant("m1", "thinking", 189)).is_some());
        assert!(t.read(&assistant("m1", "tool_use", 189)).is_some());
        assert!(t
            .read(&json!({"type":"user","message":{"content":[{"type":"tool_result"}]}}))
            .is_some());
        assert!(t.read(&assistant("m2", "text", 13)).is_some());
        assert!(t.read(&json!({"type":"attachment"})).is_none());
        assert!(t
            .read(&json!({"type":"system","subtype":"turn_duration","durationMs":18885}))
            .is_none());
        let line = t.result_line("s", &Cost::Read(0.0012));
        assert_eq!(line["usage"]["output_tokens"], 202, "{line}");
        assert_eq!(line["usage"]["input_tokens"], 4);
        assert_eq!(line["usage"]["cache_read_input_tokens"], 20);
        assert_eq!(line["num_turns"], 2);
        assert_eq!(line["duration_ms"], 18885);
        assert_eq!(line["total_cost_usd"], 0.0012);
        assert_eq!(line["is_error"], false);
    }

    #[test]
    fn an_unread_cost_is_said_and_never_written_as_a_figure() {
        let t = Tally::default();
        let line = t.result_line("s", &turn_cost(Some(0.01), None));
        assert!(line.get("total_cost_usd").is_none(), "{line}");
        assert_eq!(
            line["forge_pane"]["cost"]["unread"],
            "no status line came within 3 s of the turn's Stop"
        );
        assert_eq!(
            turn_cost(None, Some(0.02)),
            Cost::Unread("no status line stood before the turn to measure from")
        );
        assert_eq!(
            turn_cost(Some(0.01334112), Some(0.01430154)),
            Cost::Read(0.00096042)
        );
    }

    #[test]
    fn a_message_queued_after_the_last_text_holds_the_turn_until_it_is_taken() {
        let mut t = Tally::default();
        t.read(&json!({"type":"queue-operation","operation":"enqueue","content":"HOTEL"}));
        assert_eq!(t.queued(), 1);
        t.next_turn();
        assert_eq!(t.queued(), 1, "a queued message was dropped between Stops");
        t.read(&json!({"type":"queue-operation","operation":"dequeue"}));
        assert_eq!(t.queued(), 0);
        t.read(&json!({"type":"queue-operation","operation":"enqueue"}));
        t.read(
            &json!({"type":"queue-operation","operation":"remove","reason":"absorbed_mid_turn"}),
        );
        assert_eq!(t.queued(), 0);
    }

    #[test]
    fn a_status_line_s_running_cost_is_read_from_its_payload() {
        let p =
            json!({"session_id":"s","cost":{"total_cost_usd":0.00801877,"total_duration_ms":1}});
        assert_eq!(status_cost(&p), Some(0.00801877));
        assert_eq!(status_cost(&json!({})), None);
    }
}
