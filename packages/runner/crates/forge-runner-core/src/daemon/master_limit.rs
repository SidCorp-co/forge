//! What a resident master's account said, read where Claude Code wrote it.
//!
//! Core has held the receiving half of this since it was written for exactly
//! this case: `recordMasterLimit` / `clearMasterLimit` behind `POST` and
//! `DELETE /me/limit`. Nothing called it. A master is on neither the job lane
//! nor the chat lane, so when its account hit a cap the fact reached nothing:
//! the runner row went on reading `limitReason: null` and the box went on
//! spending a full agent pass per nudge against an account that had refused.
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

use std::time::Duration;

use serde_json::Value;

use super::master::{LIMITED_POLL_INTERVAL, NUDGE_REFRESH};

pub(crate) const FRESH_WITHIN: Duration =
    Duration::from_secs(2 * (LIMITED_POLL_INTERVAL.as_secs() + NUDGE_REFRESH.as_secs()));

pub(crate) const CLEAR_WITHIN: Duration = NUDGE_REFRESH;

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

/// One refusal, in the shape core's route takes.
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

/// What the box does about everything it read this sweep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Action {
    /// Send this refusal, and remember this record id once core has taken it.
    Report(Refusal, String),
    /// Lift the limit core is holding for this device.
    Clear,
    /// Say this in the log and send nothing.
    Unreadable(String),
    Nothing,
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

/// Whether a record is recent enough to speak for the account now — the one
/// test the report to core applies to what `newest_record` read.
pub(crate) fn is_fresh(d: &Decisive, now_unix: i64) -> bool {
    now_unix.saturating_sub(d.at).unsigned_abs() <= FRESH_WITHIN.as_secs()
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

/// The quota refusal a record carries, and nothing for any other verdict.
///
/// A usage window or a provider throttle is capacity, which an operator can
/// restore out of band and only a turn that tries can see restored. A
/// credential refusal is not capacity and is not answered by asking again.
pub(crate) fn quota_refusal(d: &Decisive) -> Option<&Refusal> {
    match &d.verdict {
        Verdict::Refused(r) if matches!(r.reason, Reason::UsageLimit | Reason::RateLimit) => {
            Some(r)
        }
        _ => None,
    }
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

pub(crate) fn decide(
    seen: &[Decisive],
    core_limited: bool,
    already_sent: Option<&str>,
    now_unix: i64,
) -> Action {
    let Some(newest) = seen
        .iter()
        .max_by_key(|d| (d.at, d.millis, d.uuid.as_str()))
    else {
        return Action::Nothing;
    };
    match &newest.verdict {
        Verdict::Unreadable(slug) => Action::Unreadable(slug.clone()),
        Verdict::Refused(r) => {
            if already_sent == Some(newest.uuid.as_str()) {
                Action::Nothing
            } else {
                Action::Report(r.clone(), newest.uuid.clone())
            }
        }
        Verdict::Worked => {
            let age = now_unix.saturating_sub(newest.at);
            let fresh = (0..=CLEAR_WITHIN.as_secs() as i64).contains(&age);
            if core_limited && fresh {
                Action::Clear
            } else {
                Action::Nothing
            }
        }
    }
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

/// Days between 1970-01-01 and a proleptic-Gregorian date.
///
/// Howard Hinnant's `days_from_civil`, which is exact for every year this will
/// ever see and needs no table.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// This box's clock, as the records are written against.
pub(crate) fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECORDS: &str = include_str!("../../assets/master-limit-records.jsonl");

    /// What the report to core reads from a tail: `newest_record` filtered by
    /// `is_fresh`, the composition `sweep` makes.
    fn newest_decisive(tail: &str, now_unix: i64) -> Option<Decisive> {
        newest_record(tail, now_unix).filter(|d| is_fresh(d, now_unix))
    }

    fn header() -> Value {
        serde_json::from_str(RECORDS.lines().next().unwrap()).unwrap()
    }

    /// One captured record, by the label its fixture header gives it.
    fn record(label: &str) -> Value {
        let uuid = header()["_labels"][label]
            .as_str()
            .unwrap_or_else(|| panic!("fixture has no record labelled {label}"))
            .to_string();
        for line in RECORDS.lines().skip(1) {
            let v: Value = serde_json::from_str(line).unwrap();
            if v["uuid"].as_str() == Some(uuid.as_str()) {
                return v;
            }
        }
        panic!("fixture labels {label} as a record id that is not in the file below it")
    }

    fn line_of(label: &str) -> String {
        serde_json::to_string(&record(label)).unwrap()
    }

    fn at(label: &str) -> i64 {
        unix_seconds(record(label)["timestamp"].as_str().unwrap()).unwrap()
    }

    fn refused(v: Option<Verdict>) -> Refusal {
        match v {
            Some(Verdict::Refused(r)) => r,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn every_fixture_line_is_one_record_the_classifier_can_read() {
        let lines: Vec<&str> = RECORDS.lines().collect();
        assert!(lines.len() > 6, "the fixture lost its records");
        for line in &lines {
            let v: Value =
                serde_json::from_str(line).expect("every fixture line is one JSON object");
            assert!(v.is_object());
        }
        let labels = header()["_labels"].as_object().unwrap().clone();
        assert_eq!(
            labels.len(),
            lines.len() - 1,
            "every record after the header is labelled, and every label names one"
        );
        for label in labels.keys() {
            record(label);
        }
    }

    // ---- what one record says -------------------------------------------------

    #[test]
    fn a_five_hour_window_is_a_usage_limit_with_the_reset_the_record_carries() {
        let r = record("429_five_hour");
        let resets = r["quotaLimits"]["resetsAt"].as_i64().unwrap();
        let now = resets - 900;
        let out = refused(classify(&r, now));
        assert_eq!(out.reason, Reason::UsageLimit);
        assert_eq!(out.resets_in_seconds, Some(900));
    }

    #[test]
    fn a_seven_day_window_is_a_usage_limit_too() {
        let r = record("429_seven_day");
        assert_eq!(
            refused(classify(&r, 0)).reason,
            Reason::UsageLimit,
            "a 7-day window is an account quota window exactly as a 5-hour one is; reading the rateLimitType NAME would make every future window unclassified"
        );
    }

    #[test]
    fn a_reset_already_past_reports_zero_rather_than_wrapping() {
        let r = record("429_five_hour");
        let resets = r["quotaLimits"]["resetsAt"].as_i64().unwrap();
        assert_eq!(
            refused(classify(&r, resets + 10_000)).resets_in_seconds,
            Some(0)
        );
    }

    #[test]
    fn a_429_with_no_quota_window_behind_it_is_a_bare_rate_limit() {
        let mut r = record("429_five_hour");
        r.as_object_mut().unwrap().remove("quotaLimits");
        let out = refused(classify(&r, 0));
        assert_eq!(out.reason, Reason::RateLimit);
        assert_eq!(out.resets_in_seconds, None);
    }

    #[test]
    fn a_403_is_auth_and_carries_the_wording_an_operator_reads() {
        let out = refused(classify(&record("403_oauth_org_not_allowed"), 0));
        assert_eq!(out.reason, Reason::Auth);
        assert!(
            out.detail.contains("organization"),
            "detail: {}",
            out.detail
        );
    }

    #[test]
    fn a_refusal_with_no_status_is_auth_by_the_slug_it_carries() {
        assert_eq!(
            refused(classify(&record("authentication_failed"), 0)).reason,
            Reason::Auth
        );
    }

    #[test]
    fn a_401_is_auth_however_the_release_spells_its_error() {
        assert_eq!(
            refused(classify(&record("auth_status_with_renamed_error"), 0)).reason,
            Reason::Auth
        );
    }

    #[test]
    fn an_auth_refusal_carries_no_reset_even_when_one_is_offered() {
        let built = Refusal::new(Reason::Auth, Some(900), "x".into());
        assert_eq!(
            built.resets_in_seconds, None,
            "core answers AUTH_LIMIT_HAS_NO_RESET to the pair, so a report carrying it records NOTHING"
        );
    }

    #[test]
    fn a_status_this_binary_has_not_been_taught_is_unreadable_and_named() {
        match classify(&record("unrecognised_protocol"), 0) {
            Some(Verdict::Unreadable(slug)) => {
                assert_eq!(slug, "a_slug_no_release_has_shipped")
            }
            other => panic!("expected an unreadable verdict, got {other:?}"),
        }
    }

    #[test]
    fn a_successful_turn_is_the_account_working() {
        assert_eq!(
            classify(&record("successful_turn"), 0),
            Some(Verdict::Worked)
        );
    }

    #[test]
    fn the_banner_quoted_inside_a_records_text_says_nothing_about_the_account() {
        let r = record("banner_in_text_only");
        assert!(
            serde_json::to_string(&r)
                .unwrap()
                .contains("hit your session limit"),
            "this fixture only tests anything while it still carries the wording"
        );
        assert_eq!(classify(&r, 0), None);
    }

    #[test]
    fn a_synthetic_model_is_not_a_turn_that_worked() {
        assert!(!worked(&record("429_five_hour")));
    }

    #[test]
    fn the_detail_is_cut_to_what_cores_validator_takes() {
        let long: String = "é".repeat(500);
        let out = Refusal::new(Reason::RateLimit, None, long);
        assert!(out.detail.chars().count() <= DETAIL_MAX_UTF16);
        assert!(!out.detail.is_empty());
    }

    #[test]
    fn a_refusal_with_nothing_to_say_still_says_its_reason() {
        assert_eq!(
            Refusal::new(Reason::Auth, None, "   ".into()).detail,
            "auth",
            "core refuses an empty detail, so a report with no wording must carry something"
        );
    }

    #[test]
    fn the_three_reasons_are_the_three_core_stores() {
        let mut got: Vec<&str> = [Reason::UsageLimit, Reason::RateLimit, Reason::Auth]
            .iter()
            .map(|r| r.wire())
            .collect();
        got.sort_unstable();
        assert_eq!(got, ["auth", "rate_limit", "usage_limit"]);
    }

    // ---- scanning a tail ------------------------------------------------------

    fn tail(labels: &[&str]) -> String {
        labels
            .iter()
            .map(|l| line_of(l))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_newest_record_that_says_anything_is_the_one_read() {
        let t = tail(&["429_five_hour", "successful_turn"]);
        let d = newest_decisive(&t, at("successful_turn")).unwrap();
        assert_eq!(d.verdict, Verdict::Worked);
    }

    #[test]
    fn a_record_that_says_nothing_is_scanned_past() {
        let t = tail(&["429_five_hour", "banner_in_text_only"]);
        let d = newest_decisive(&t, at("429_five_hour")).unwrap();
        assert!(matches!(d.verdict, Verdict::Refused(_)));
    }

    #[test]
    fn an_unreadable_record_stops_the_scan_over_an_older_refusal() {
        let t = tail(&["429_five_hour", "unrecognised_protocol"]);
        let now = at("unrecognised_protocol");
        assert!(
            now.saturating_sub(at("429_five_hour")).unsigned_abs() <= FRESH_WITHIN.as_secs(),
            "the refusal underneath is itself in window, so walking past would REPORT it rather than answer nothing — which is what makes this assertion distinguish the two"
        );
        match newest_decisive(&t, now).unwrap().verdict {
            Verdict::Unreadable(slug) => assert_eq!(slug, "a_slug_no_release_has_shipped"),
            other => panic!("expected the scan to stop unreadable, got {other:?}"),
        }
    }

    #[test]
    fn a_record_from_another_panes_lifetime_says_nothing_now() {
        let t = tail(&["429_five_hour"]);
        let stale = at("429_five_hour") + FRESH_WITHIN.as_secs() as i64 + 1;
        assert_eq!(newest_decisive(&t, stale), None);
    }

    #[test]
    fn a_record_exactly_at_the_window_is_still_fresh() {
        let t = tail(&["429_five_hour"]);
        let edge = at("429_five_hour") + FRESH_WITHIN.as_secs() as i64;
        assert!(newest_decisive(&t, edge).is_some());
    }

    #[test]
    fn lifting_a_limit_is_held_to_a_tighter_clock_than_reporting_one() {
        assert_eq!(
            CLEAR_WITHIN, NUDGE_REFRESH,
            "the bound is one nudge period, not merely something smaller than FRESH_WITHIN: widened to anything else, the age-relative tests below derive their own inputs from it and stay green while the race they bound gets longer"
        );
        assert!(CLEAR_WITHIN < FRESH_WITHIN);
    }

    #[test]
    fn a_record_one_second_inside_the_window_is_fresh() {
        let t = tail(&["429_five_hour"]);
        let inside = at("429_five_hour") + FRESH_WITHIN.as_secs() as i64 - 1;
        assert!(newest_decisive(&t, inside).is_some());
    }

    #[test]
    fn the_freshness_window_is_derived_from_the_intervals_that_bound_observation() {
        assert_eq!(
            FRESH_WITHIN,
            Duration::from_secs(2 * (LIMITED_POLL_INTERVAL.as_secs() + NUDGE_REFRESH.as_secs()))
        );
        assert!(FRESH_WITHIN > LIMITED_POLL_INTERVAL + NUDGE_REFRESH);
    }

    #[test]
    fn a_partial_first_line_is_dropped_rather_than_parsed() {
        let dir = crate::test_scratch::Scratch::new("tail");

        let path = dir.join("c.jsonl");
        std::fs::write(
            &path,
            format!("{}\n{}\n", "x".repeat(10), line_of("successful_turn")),
        )
        .unwrap();
        let text = read_tail(&path).unwrap();
        assert!(newest_decisive(&text, at("successful_turn")).is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_conversation_this_box_has_no_file_for_reads_as_nothing() {
        assert_eq!(
            read_tail(std::path::Path::new("/nope/not/here.jsonl")),
            None
        );
    }

    #[test]
    fn a_refusal_this_box_cannot_date_reports_nothing_rather_than_guessing_now() {
        let mut r = record("429_five_hour");
        r.as_object_mut().unwrap().remove("timestamp");
        let t = serde_json::to_string(&r).unwrap();
        assert!(
            classify(&r, 0).is_some(),
            "the record still classifies; it is the SCAN that must refuse it"
        );
        assert_eq!(newest_decisive(&t, 0), None);
    }

    #[test]
    fn a_tail_holding_nothing_decisive_answers_nothing() {
        assert_eq!(newest_decisive("", 0), None);
        assert_eq!(newest_decisive("not json at all\n{}", 0), None);
    }

    // ---- one decision for the device -----------------------------------------

    fn seen(label: &str, at_unix: i64, uuid: &str) -> Decisive {
        Decisive {
            at: at_unix,
            millis: 0,
            uuid: uuid.to_string(),
            verdict: classify(&record(label), at_unix).unwrap(),
        }
    }

    #[test]
    fn a_refusal_is_reported_once_and_not_again_on_the_next_sweep() {
        let d = vec![seen("429_five_hour", 100, "u1")];
        match decide(&d, false, None, 100) {
            Action::Report(_, uuid) => assert_eq!(uuid, "u1"),
            other => panic!("expected a report, got {other:?}"),
        }
        assert_eq!(decide(&d, true, Some("u1"), 100), Action::Nothing);
    }

    #[test]
    fn one_record_read_at_two_sweep_times_is_reported_once() {
        let t1 = at("429_five_hour") + 30;
        let t2 = t1 + 30;
        let line = line_of("429_five_hour");
        let first = newest_decisive(&line, t1).unwrap();
        let second = newest_decisive(&line, t2).unwrap();

        let Action::Report(a, uuid) = decide(&[first], false, None, t1) else {
            panic!("the first sweep reports it")
        };
        let Action::Report(b, _) = decide(std::slice::from_ref(&second), false, None, t2) else {
            panic!("and it would report it again if nothing were remembered")
        };
        assert_ne!(
            a.resets_in_seconds, b.resets_in_seconds,
            "this test proves nothing unless the two readings really do differ"
        );
        assert_eq!(
            decide(&[second], true, Some(&uuid), t2),
            Action::Nothing,
            "the second sweep has the id the first sent and says nothing"
        );
    }

    #[test]
    fn a_refusal_core_never_took_is_sent_again() {
        let d = vec![seen("429_five_hour", 100, "u1")];
        assert!(matches!(
            decide(&d, false, Some("older"), 100),
            Action::Report(..)
        ));
    }

    #[test]
    fn a_turn_that_worked_clears_only_what_core_says_it_is_holding() {
        let d = vec![seen("successful_turn", 100, "u2")];
        assert_eq!(decide(&d, true, None, 100), Action::Clear);
        assert_eq!(decide(&d, false, None, 100), Action::Nothing);
    }

    #[test]
    fn an_older_success_on_one_project_cannot_lift_a_newer_refusal_on_another() {
        let older = seen("successful_turn", 100, "u-worked");
        let newer = seen("429_five_hour", 200, "u-refused");
        for order in [
            vec![older.clone(), newer.clone()],
            vec![newer.clone(), older.clone()],
        ] {
            match decide(&order, true, None, 200) {
                Action::Report(_, uuid) => assert_eq!(uuid, "u-refused"),
                other => panic!("expected the newer refusal to win, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_newer_success_does_lift_an_older_refusal() {
        let older = seen("429_five_hour", 100, "u-refused");
        let newer = seen("successful_turn", 200, "u-worked");
        for order in [
            vec![older.clone(), newer.clone()],
            vec![newer.clone(), older.clone()],
        ] {
            assert_eq!(decide(&order, true, None, 200), Action::Clear);
        }
    }

    #[test]
    fn two_verdicts_at_the_same_instant_resolve_the_same_way_in_either_order() {
        let a = seen("successful_turn", 100, "aaa");
        let b = seen("429_five_hour", 100, "bbb");
        assert_eq!(
            decide(&[a.clone(), b.clone()], true, None, 100),
            decide(&[b, a], true, None, 100)
        );
    }

    #[test]
    fn a_success_too_old_to_speak_for_now_lifts_nothing() {
        let d = vec![seen("successful_turn", 100, "u2")];
        let stale = 100 + CLEAR_WITHIN.as_secs() as i64 + 1;
        assert_eq!(decide(&d, true, None, stale), Action::Nothing);
        assert_eq!(
            decide(&d, true, None, 100 + CLEAR_WITHIN.as_secs() as i64),
            Action::Clear,
            "and one exactly at the bound still lifts it"
        );
    }

    #[test]
    fn a_refusal_older_than_the_clear_bound_is_still_reported() {
        let d = vec![seen("429_five_hour", 100, "u1")];
        let old = 100 + CLEAR_WITHIN.as_secs() as i64 + 1;
        assert!(
            matches!(decide(&d, false, None, old), Action::Report(..)),
            "a late report costs wasted turns; a late clear costs dispatch into a capped account"
        );
    }

    #[test]
    fn a_newer_unreadable_record_on_one_project_silences_an_older_refusal_on_another() {
        let older = seen("429_five_hour", 100, "u-refused");
        let newer = seen("unrecognised_protocol", 200, "u-unknown");
        for order in [
            vec![older.clone(), newer.clone()],
            vec![newer.clone(), older.clone()],
        ] {
            assert_eq!(
                decide(&order, true, None, 200),
                Action::Unreadable("a_slug_no_release_has_shipped".into())
            );
        }
    }

    #[test]
    fn an_unreadable_verdict_sends_nothing_and_hands_its_slug_to_the_log() {
        let d = vec![Decisive {
            at: 100,
            millis: 0,
            uuid: "u3".into(),
            verdict: Verdict::Unreadable("moved".into()),
        }];
        assert_eq!(
            decide(&d, true, None, 100),
            Action::Unreadable("moved".into())
        );
    }

    #[test]
    fn a_box_that_read_nothing_decides_nothing() {
        assert_eq!(decide(&[], true, None, 100), Action::Nothing);
    }

    // ---- the seam, on one artifact both languages read ------------------------

    /// Every reason this binary can send, as the file core's own suite reads.
    const REASONS: &str = include_str!("../../assets/master-limit-reasons.json");

    /// The body the chain below produces from the captured `429_five_hour`
    /// record, as the file `pool-routes.test.ts` drives through the mounted
    /// route.
    const WIRE: &str = include_str!("../../assets/master-limit-wire.json");

    #[test]
    fn the_reasons_this_binary_sends_are_the_set_both_sides_read() {
        let declared: Value = serde_json::from_str(REASONS).unwrap();
        let mut want: Vec<String> = declared["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_str().unwrap().to_string())
            .collect();
        want.sort();
        let mut got: Vec<String> = [Reason::UsageLimit, Reason::RateLimit, Reason::Auth]
            .iter()
            .map(|r| r.wire().to_string())
            .collect();
        got.sort();
        assert_eq!(got, want);
    }

    /// One request, captured whole, answered with `status`.
    async fn capture(status: &'static str) -> (String, tokio::sync::oneshot::Receiver<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
            let _ = tx.send(req);
        });
        (format!("http://{addr}"), rx)
    }

    fn core(url: String) -> crate::transport::CoreClient {
        crate::transport::CoreClient::new(url, String::from("tok"))
    }

    /// A minute after the captured refusal: inside the freshness window, and a
    /// fixed distance from that record's own reset, so the body below is a fixed
    /// set of bytes rather than a function of when this suite runs.
    fn wire_now() -> i64 {
        at("429_five_hour") + 60
    }

    #[tokio::test]
    async fn a_captured_refusal_reaches_core_as_the_bytes_both_languages_read() {
        let d = newest_decisive(&line_of("429_five_hour"), wire_now()).expect("a fresh refusal");
        let Action::Report(r, _) = decide(&[d], false, None, wire_now()) else {
            panic!("a fresh refusal nobody has reported is a report")
        };
        let (url, rx) = capture("200 OK").await;
        crate::transport::master::report_limit(
            &core(url),
            r.reason.wire(),
            r.resets_in_seconds,
            &r.detail,
        )
        .await
        .expect("core answered 200");
        let req = rx.await.unwrap();
        let body = req.split("\r\n\r\n").nth(1).unwrap_or("");
        assert_eq!(
            body,
            WIRE.trim(),
            "the body this box sends and the file the receiving suite reads have parted"
        );
    }

    #[tokio::test]
    async fn a_captured_successful_turn_reaches_core_as_the_delete_that_lifts_it() {
        let d = newest_decisive(&line_of("successful_turn"), at("successful_turn") + 60)
            .expect("a fresh successful turn");
        assert_eq!(
            decide(
                &[d],
                true,
                Some("an-earlier-refusal"),
                at("successful_turn") + 60
            ),
            Action::Clear
        );
        let (url, rx) = capture("200 OK").await;
        crate::transport::master::clear_limit(&core(url))
            .await
            .expect("core answered 200");
        assert!(
            rx.await
                .unwrap()
                .starts_with("DELETE /api/devices/me/limit "),
            "the clear is a DELETE on the path the report used"
        );
    }

    #[test]
    fn the_wire_fixture_is_the_shape_cores_validator_takes() {
        let body: Value = serde_json::from_str(WIRE).unwrap();
        let declared: Value = serde_json::from_str(REASONS).unwrap();
        assert!(declared["reasons"]
            .as_array()
            .unwrap()
            .contains(&body["reason"]));
        assert!(body["resetsInSeconds"].as_u64().is_some_and(|s| s > 0));
        let detail = body["detail"].as_str().unwrap();
        assert!(!detail.is_empty() && detail.encode_utf16().count() <= DETAIL_MAX_UTF16);
    }

    // ---- the clock ------------------------------------------------------------

    #[test]
    fn the_timestamp_parser_agrees_with_a_known_instant() {
        assert_eq!(unix_seconds("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            unix_seconds("2026-09-16T12:27:43.357Z"),
            Some(1_789_561_663)
        );
        assert_eq!(
            unix_seconds("2024-02-29T00:00:00.000Z"),
            Some(1_709_164_800)
        );
    }

    #[test]
    fn the_fraction_is_read_at_whatever_width_the_record_writes_it() {
        assert_eq!(subsecond_millis("2026-09-16T12:27:43.357Z"), 357);
        assert_eq!(subsecond_millis("2026-09-16T12:27:43.35Z"), 350);
        assert_eq!(subsecond_millis("2026-09-16T12:27:43.3Z"), 300);
        assert_eq!(subsecond_millis("2026-09-16T12:27:43.357999Z"), 357);
        assert_eq!(subsecond_millis("2026-09-16T12:27:43Z"), 0);
        assert_eq!(subsecond_millis("2026-09-16T12:27:43.Z"), 0);
        assert_eq!(subsecond_millis(""), 0);
    }

    #[test]
    fn the_scan_carries_the_records_own_fraction() {
        let d = newest_decisive(&tail(&["successful_turn"]), at("successful_turn")).unwrap();
        assert_eq!(d.millis, 357, "the captured record's timestamp ends .357Z");
    }

    #[test]
    fn a_timestamp_in_any_other_shape_is_refused_rather_than_guessed() {
        for bad in ["", "yesterday", "2026-09-16", "16/09/2026 12:00:00Z"] {
            assert_eq!(unix_seconds(bad), None, "parsed {bad:?}");
        }
    }

    #[test]
    fn an_impossible_date_or_clock_reading_is_refused_rather_than_normalised() {
        for bad in [
            "2026-02-31T00:00:00.000Z",
            "2025-02-29T00:00:00.000Z",
            "2026-04-31T00:00:00.000Z",
            "2026-09-16T24:00:00.000Z",
            "2026-09-16T12:60:00.000Z",
            "2026-09-16T12:00:60.000Z",
            "2026-09-16T12-00-00.000Z",
            "-123-01-01T00:00:00.000Z",
            "+026-09-16T12:00:00.000Z",
            "2026-09-16T+2:00:00.000Z",
            "2026-09-16T12:00:00+07:00",
            "2026-09-16T12:00:00",
            "2026-09-16T12:00:00.000",
            "2026-09-16T12:00:00.00zZ",
        ] {
            assert_eq!(unix_seconds(bad), None, "parsed {bad:?}");
        }
    }

    #[test]
    fn the_last_day_of_every_month_still_parses() {
        for good in [
            "2026-01-31T23:59:59.000Z",
            "2026-02-28T00:00:00.000Z",
            "2024-02-29T00:00:00.000Z",
            "2026-04-30T00:00:00.000Z",
            "2000-02-29T00:00:00.000Z",
            "2026-12-31T00:00:00.000Z",
        ] {
            assert!(unix_seconds(good).is_some(), "refused {good:?}");
        }
    }

    #[test]
    fn a_record_dated_ahead_of_this_box_cannot_lift_a_limit() {
        let ahead = seen("successful_turn", 10_000, "u-ahead");
        assert_eq!(
            decide(&[ahead], true, None, 100),
            Action::Nothing,
            "a success dated an age ahead of now is not a success this box just watched happen"
        );
        let t = tail(&["successful_turn"]);
        let behind = at("successful_turn") - FRESH_WITHIN.as_secs() as i64 - 1;
        assert_eq!(newest_decisive(&t, behind), None);
    }

    #[test]
    fn a_refusal_later_in_the_same_second_beats_a_success_whose_uuid_sorts_higher() {
        let worked = Decisive {
            at: 100,
            millis: 100,
            uuid: "fffffff0-0000-4000-8000-000000000000".into(),
            verdict: classify(&record("successful_turn"), 100).unwrap(),
        };
        let refused = Decisive {
            at: 100,
            millis: 900,
            uuid: "00000000-0000-4000-8000-000000000000".into(),
            verdict: classify(&record("429_five_hour"), 100).unwrap(),
        };
        for order in [
            vec![worked.clone(), refused.clone()],
            vec![refused.clone(), worked.clone()],
        ] {
            match decide(&order, true, None, 100) {
                Action::Report(_, uuid) => assert_eq!(uuid, refused.uuid),
                other => panic!("the later refusal in the same second must win, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_success_one_second_ahead_of_now_does_not_clear() {
        let ahead = seen("successful_turn", 101, "u-ahead-1s");
        assert_eq!(decide(&[ahead], true, None, 100), Action::Nothing);
        let same = seen("successful_turn", 100, "u-same-second");
        assert_eq!(
            decide(&[same], true, None, 100),
            Action::Clear,
            "the same second is not the future: `now_unix` truncates, so a success written this second reads as equal"
        );
    }

    // ---- the pane a refusal parked (ISS-1248) ---------------------------------

    const WAIT: &str = include_str!("../../assets/master-limit-wait.jsonl");

    fn wait_record(label: &str) -> Value {
        let header: Value = serde_json::from_str(WAIT.lines().next().unwrap()).unwrap();
        let uuid = header["_labels"][label]
            .as_str()
            .unwrap_or_else(|| panic!("the wait fixture has no record labelled {label}"))
            .to_string();
        WAIT.lines()
            .skip(1)
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .find(|v| v["uuid"].as_str() == Some(uuid.as_str()))
            .unwrap_or_else(|| panic!("{label} names a record id that is not in the file"))
    }

    fn wait_at(label: &str) -> i64 {
        unix_seconds(wait_record(label)["timestamp"].as_str().unwrap()).unwrap()
    }

    fn wait_tail() -> String {
        WAIT.lines().skip(1).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn every_line_of_the_wait_fixture_is_labelled_and_in_file_order() {
        let header: Value = serde_json::from_str(WAIT.lines().next().unwrap()).unwrap();
        let labels = header["_labels"].as_object().unwrap();
        assert_eq!(labels.len(), WAIT.lines().count() - 1);
        let stamps: Vec<i64> = WAIT
            .lines()
            .skip(1)
            .map(|l| {
                let v: Value = serde_json::from_str(l).unwrap();
                assert!(labels.values().any(|u| u == &v["uuid"]));
                unix_seconds(v["timestamp"].as_str().unwrap()).unwrap()
            })
            .collect();
        assert_eq!(
            stamps.len(),
            6,
            "the six captured records, and nothing else"
        );
        assert!(
            stamps.windows(2).all(|w| w[0] <= w[1]),
            "a scan from the end reads the newest first only if the file is in the order it was written"
        );
    }

    #[test]
    fn a_refusal_hours_old_is_still_the_last_thing_the_pane_was_told() {
        let tail = wait_tail();
        let later = wait_at("refused_second") + 3 * 3600;
        assert_eq!(
            newest_decisive(&tail, later),
            None,
            "past FRESH_WITHIN the refusal may no longer speak for the account — the report to core stays as it was"
        );
        let last = newest_record(&tail, later).expect("the refusal is still in the file");
        assert_eq!(
            last.uuid,
            wait_record("refused_second")["uuid"].as_str().unwrap(),
            "the scan walks past the operator's cancel and the turn-duration record to the refusal under them"
        );
        let r = quota_refusal(&last).expect("a five-hour window is capacity");
        assert_eq!(r.reason, Reason::UsageLimit);
    }

    #[test]
    fn the_freshness_filter_is_the_only_difference_between_the_two_reads() {
        let tail = wait_tail();
        let inside = wait_at("refused_second") + FRESH_WITHIN.as_secs() as i64;
        assert_eq!(newest_decisive(&tail, inside), newest_record(&tail, inside));
        let outside = inside + 1;
        assert_eq!(newest_decisive(&tail, outside), None);
        assert!(newest_record(&tail, outside).is_some());
    }

    #[test]
    fn a_throttle_is_capacity_and_a_credential_is_not() {
        let now = at("429_five_hour");
        let usage = seen("429_five_hour", now, "u-usage");
        assert_eq!(
            quota_refusal(&usage).map(|r| r.reason),
            Some(Reason::UsageLimit)
        );

        let mut throttle = record("429_five_hour");
        throttle["quotaLimits"]["status"] = Value::from("allowed_warning");
        let throttle = Decisive {
            at: now,
            millis: 0,
            uuid: "u-throttle".into(),
            verdict: classify(&throttle, now).unwrap(),
        };
        assert_eq!(
            quota_refusal(&throttle).map(|r| r.reason),
            Some(Reason::RateLimit)
        );

        for label in ["authentication_failed", "403_oauth_org_not_allowed"] {
            let auth = seen(label, now, "u-auth");
            assert!(matches!(auth.verdict, Verdict::Refused(ref r) if r.reason == Reason::Auth));
            assert_eq!(
                quota_refusal(&auth),
                None,
                "{label}: a credential is fixed by a person, not by asking again"
            );
        }
        assert_eq!(quota_refusal(&seen("successful_turn", now, "u-ok")), None);
    }

    #[test]
    fn a_refusal_after_a_reask_is_reported_to_core_as_a_new_one() {
        let first = wait_at("refused_first");
        let second = wait_at("refused_second");
        let first_uuid = wait_record("refused_first")["uuid"]
            .as_str()
            .unwrap()
            .to_string();
        let d = vec![Decisive {
            at: second,
            millis: 0,
            uuid: wait_record("refused_second")["uuid"]
                .as_str()
                .unwrap()
                .to_string(),
            verdict: classify(&wait_record("refused_second"), second).unwrap(),
        }];
        assert!(second > first);
        match decide(&d, true, Some(&first_uuid), second) {
            Action::Report(r, uuid) => {
                assert_eq!(r.reason, Reason::UsageLimit);
                assert_ne!(uuid, first_uuid, "the memo is per record, not per window");
            }
            other => panic!("a second refusal is news to core, got {other:?}"),
        }
    }
}
