//! One project's pool-read condition exactly as it rides on the heartbeat.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// The newest read failed: the box cannot see this project's queue now.
    Blind,
    /// The newest read succeeded, and one inside the window did not.
    Intermittent,
}

/// One project's condition, exactly as it rides on the heartbeat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub project_id: String,
    pub verdict: Verdict,
    /// Failed reads inside the window; a floor where `count_is_floor`.
    pub failures: usize,
    pub count_is_floor: bool,
    pub window_ms: i64,
    pub unread_since: Option<i64>,
    pub consecutive: u64,
    pub recovered_at: Option<i64>,
    pub last_failure: WireFailure,
}

/// The newest failure as it travels: `what` is [`what_failed`], so every
/// surface names the status the same way without a table of its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFailure {
    pub at: i64,
    pub status: Option<u16>,
    pub what: String,
    pub reason: String,
}
