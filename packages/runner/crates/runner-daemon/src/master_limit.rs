//! What a resident master's account said, read where Claude Code wrote it.
//!
//! A master is on neither the job lane nor the chat lane, so when its account
//! hits a cap the fact reaches nothing unless this box carries it: the box
//! sends the newest decisive record it read, and core decides whether it is
//! fresh, new and a lifting (`devices/master-limit.ts:masterLimitAction`).
//!
//! The evidence is NOT the pane. Claude Code appends one JSON object per turn
//! to the conversation `daemon::master::conversation_transcript` already
//! resolves for `--resume`, and a refused turn carries its verdict in that
//! object's OWN top-level fields. Reading those is a statement; reading a
//! pane's byte count is an inference, which is the cluster ISS-933 deleted and
//! `nothing_here_infers_liveness_from_a_pane` still bans by name. It is also
//! what makes this safe: a pane carries issue bodies, so the same wording turns
//! up inside `message.content[].text` whenever anyone quotes it — this issue
//! does — and a parsed top-level read cannot be reached by that text.

use serde_json::Value;

pub(crate) use runner_platform::clock::{days_from_civil, now_secs as now_unix};

pub(crate) const TAIL_BYTES: u64 = 512 * 1024;

const DETAIL_MAX_UTF16: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reason {
    /// An account-level quota window: the 5-hour or 7-day limit.
    UsageLimit,
    /// A short provider throttle with no quota window behind it.
    RateLimit,
    /// A credential or an authorisation an operator must fix. No reset exists.
    Auth,
}

impl Reason {
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::UsageLimit => "usage_limit",
            Self::RateLimit => "rate_limit",
            Self::Auth => "auth",
        }
    }
}

/// One refusal, in the shape core's routes take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Refusal {
    pub reason: Reason,
    /// Seconds until the account is expected back. `None` for `auth`, which has
    /// none, and for a quota window whose record carries no reset — core then
    /// applies the same cooldown the job lane uses.
    pub resets_in_seconds: Option<u64>,
    /// Display-only, for the operator reading the runner row.
    pub detail: String,
}

impl Refusal {
    fn new(reason: Reason, resets_in_seconds: Option<u64>, detail: String) -> Self {
        Self {
            reason,
            resets_in_seconds: match reason {
                Reason::Auth => None,
                _ => resets_in_seconds,
            },
            detail: clamp_detail(&detail, reason),
        }
    }
}

/// What one conversation record says about the account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// The account refused this turn.
    Refused(Refusal),
    /// The account answered this turn, which is the only proof a window ended.
    Worked,
    Unreadable(String),
}

/// The newest record in a conversation that says anything, and when it said it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Decisive {
    /// Unix seconds, off the record's own `timestamp`.
    pub at: i64,
    pub millis: u32,
    /// The record's own `uuid` — what a report is memoised against, so one
    /// refusal is sent once however many sweeps read it.
    pub uuid: String,
    pub verdict: Verdict,
}

pub(crate) fn classify(record: &Value, now_unix: i64) -> Option<Verdict> {
    if record.get("isApiErrorMessage").and_then(Value::as_bool) != Some(true) {
        return worked(record).then_some(Verdict::Worked);
    }
    let slug = record.get("error").and_then(Value::as_str).unwrap_or("");
    let detail = detail_of(record, slug);
    let verdict = match record.get("apiErrorStatus").and_then(Value::as_i64) {
        Some(401) | Some(403) => Verdict::Refused(Refusal::new(Reason::Auth, None, detail)),
        Some(429) => Verdict::Refused(quota(record, detail, now_unix)),
        Some(_) => Verdict::Unreadable(slug.to_string()),
        None => match slug {
            "authentication_failed" | "oauth_org_not_allowed" => {
                Verdict::Refused(Refusal::new(Reason::Auth, None, detail))
            }
            _ => Verdict::Unreadable(slug.to_string()),
        },
    };
    Some(verdict)
}

fn quota(record: &Value, detail: String, now_unix: i64) -> Refusal {
    let limits = record.get("quotaLimits");
    let rejected = limits
        .and_then(|q| q.get("status"))
        .and_then(Value::as_str)
        .is_some_and(|s| s == "rejected");
    if !rejected {
        return Refusal::new(Reason::RateLimit, None, detail);
    }
    let resets = limits
        .and_then(|q| q.get("resetsAt"))
        .and_then(Value::as_i64)
        .map(|at| u64::try_from(at.saturating_sub(now_unix)).unwrap_or(0));
    Refusal::new(Reason::UsageLimit, resets, detail)
}

fn worked(record: &Value) -> bool {
    if record.get("type").and_then(Value::as_str) != Some("assistant") {
        return false;
    }
    record
        .get("message")
        .and_then(|m| m.get("model"))
        .and_then(Value::as_str)
        .is_some_and(|m| !m.is_empty() && m != "<synthetic>")
}

/// What an operator reads on the runner row: the refusal's own wording, or the
/// slug when it had none.
fn detail_of(record: &Value, slug: &str) -> String {
    let text = record
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .and_then(|b| b.get("text").and_then(Value::as_str))
        .unwrap_or("");
    if text.trim().is_empty() {
        slug.to_string()
    } else {
        text.trim().to_string()
    }
}

/// Fit the detail to what core's validator takes, never empty and never over.
fn clamp_detail(detail: &str, reason: Reason) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for c in detail.trim().chars() {
        let w = c.len_utf16();
        if units + w > DETAIL_MAX_UTF16 {
            break;
        }
        units += w;
        out.push(c);
    }
    if out.is_empty() {
        reason.wire().to_string()
    } else {
        out
    }
}

/// The newest record that says anything, however old.
///
/// Age decides whether a record may speak for the ACCOUNT, which other panes
/// share and an operator can fix at any moment. It does not decide what the
/// pane that wrote it is sitting behind: a refusal with nothing after it is the
/// last thing that pane's account said to it, however long ago (ISS-1248).
pub(crate) fn newest_record(tail: &str, now_unix: i64) -> Option<Decisive> {
    for line in tail.lines().rev() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(verdict) = classify(&record, now_unix) else {
            continue;
        };
        let at = record
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(unix_seconds)?;
        let uuid = record
            .get("uuid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let millis = subsecond_millis(
            record
                .get("timestamp")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        return Some(Decisive {
            at,
            millis,
            uuid,
            verdict,
        });
    }
    None
}

pub(crate) fn read_tail(path: &std::path::Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let from = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::with_capacity(TAIL_BYTES as usize);
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if from == 0 {
        return Some(text);
    }
    match text.find('\n') {
        Some(i) => Some(text[i + 1..].to_string()),
        None => Some(String::new()),
    }
}

/// The newest of `seen`, as the record core judges: what it said and how long
/// ago, by this box's clock. `None` where nothing was read.
pub(crate) fn newest_wire(
    seen: &[Decisive],
    now_unix: i64,
) -> Option<runner_transport::master::LimitRecord> {
    use runner_transport::master::LimitRecord;
    let newest = seen
        .iter()
        .max_by_key(|d| (d.at, d.millis, d.uuid.as_str()))?;
    let ago_seconds = now_unix.saturating_sub(newest.at);
    Some(match &newest.verdict {
        Verdict::Refused(r) => LimitRecord::Refused {
            ago_seconds,
            reason: r.reason.wire(),
            resets_in_seconds: r.resets_in_seconds,
            detail: r.detail.clone(),
        },
        Verdict::Worked => LimitRecord::Worked { ago_seconds },
        Verdict::Unreadable(slug) => LimitRecord::Unreadable { slug: slug.clone() },
    })
}

fn unix_seconds(ts: &str) -> Option<i64> {
    let bytes = ts.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let num = |a: usize, b: usize| {
        let field = ts.get(a..b)?;
        field
            .bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| field.parse::<i64>().ok())?
    };
    let (y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hh, mm, ss) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    if hh > 23 || mm > 59 || ss > 59 {
        return None;
    }
    let frac = ts.get(19..).and_then(|rest| rest.strip_suffix('Z'))?;
    if !frac.is_empty() {
        let digits = frac.strip_prefix('.')?;
        if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
    }
    Some(days_from_civil(y, m, d) * 86_400 + hh * 3_600 + mm * 60 + ss)
}

fn subsecond_millis(ts: &str) -> u32 {
    let Some(frac) = ts.get(19..).and_then(|rest| rest.strip_prefix('.')) else {
        return 0;
    };
    let digits: String = frac
        .chars()
        .take_while(char::is_ascii_digit)
        .take(3)
        .collect();
    if digits.is_empty() {
        return 0;
    }
    let scale = 10u32.pow(3 - digits.len() as u32);
    digits.parse::<u32>().unwrap_or(0) * scale
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runner_transport::master::LimitRecord;

    fn record(ts: &str, uuid: &str, body: &str, now: i64) -> Decisive {
        let line = format!(r#"{{"timestamp":"{ts}","uuid":"{uuid}",{body}}}"#);
        newest_record(&line, now).expect("a decisive record reads")
    }

    const REFUSED: &str = r#""type":"assistant","isApiErrorMessage":true,"apiErrorStatus":429,"error":"rate_limit","message":{"model":"<synthetic>","content":[]}"#;
    const WORKED: &str = r#""type":"assistant","message":{"model":"claude-x","content":[]}"#;

    /// Freshness is core's: a refusal hours old is still sent, with its age.
    #[test]
    fn the_newest_record_is_sent_whatever_its_age_and_core_judges_it() {
        let now = unix_seconds("2026-10-07T12:00:00Z").unwrap();
        let old = record("2026-10-07T08:00:00.000Z", "a", REFUSED, now);
        let sent = newest_wire(&[old], now).expect("sent");
        assert_eq!(
            sent,
            LimitRecord::Refused {
                ago_seconds: 4 * 3600,
                reason: "rate_limit",
                resets_in_seconds: None,
                detail: "rate_limit".into(),
            }
        );
    }

    #[test]
    fn a_turn_after_the_refusal_is_what_is_sent() {
        let now = unix_seconds("2026-10-07T12:00:00Z").unwrap();
        let refused = record("2026-10-07T11:50:00.000Z", "a", REFUSED, now);
        let worked = record("2026-10-07T11:58:00.000Z", "b", WORKED, now);
        assert_eq!(
            newest_wire(&[refused, worked], now),
            Some(LimitRecord::Worked { ago_seconds: 120 })
        );
        assert_eq!(newest_wire(&[], now), None);
    }
}
