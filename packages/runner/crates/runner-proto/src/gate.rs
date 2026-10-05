//! The gate condition exactly as it rides on the heartbeat and a run-session open.

/// What this box says about its own gate. One definition, read by
/// `cmd/status.rs`, by the heartbeat and by the daemon's own warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// Nothing of this kind is on record.
    Clear,
    /// Marks exist, and the box will not call them a rate: too short a window,
    /// nothing recent, or under the threshold.
    Marked,
    /// A sustained rate, still running.
    FailingOpen,
}

/// A tally read as a rate over a window, which is the form the number has to
/// take to mean anything to a reader.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub verdict: Verdict,
    /// A floor where `trimmed`, never a lifetime total.
    pub count: usize,
    pub trimmed: bool,
    pub first_at: Option<i64>,
    pub last_at: Option<i64>,
    /// The span the kept marks cover, `None` where fewer than two of them do.
    pub window_ms: Option<i64>,
    pub per_day: Option<f64>,
    /// How long since the newest mark, which is what separates an open wound
    /// from a closed one.
    pub since_last_ms: Option<i64>,
    pub last: Option<Last>,
    /// What the count is made of, commonest first. A reason standing for the
    /// whole count and a genuine mixture are different facts about the same
    /// number, and only one of them is actionable.
    pub by_reason: Vec<ReasonCount>,
}

/// One reason, and how many of the kept marks carry it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasonCount {
    pub reason: String,
    pub count: usize,
}

/// The most recent mark of a kind, read back. Every field but `detail` is
/// optional, because a file an older binary wrote carries none of them and must
/// still tally.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Last {
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_unknown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use: Option<String>,
}
