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

/// How far from now a decisive record may sit and still describe the account.
///
/// Derived rather than chosen: `LIMITED_POLL_INTERVAL` is the widest this box
/// spaces its sweeps once a limit stands, and `NUDGE_REFRESH` is the longest a
/// master may go un-prompted while the pool is unchanged — so their sum is the
/// longest gap between two chances to observe a refusal, and the same again is
/// the margin. Moving either constant moves this one.
// cm:guard this bound exists because the ledger's stored conversation id lags a COLD START by a turn: `note_master` learns the new id from the first hook event, so a sweep in between resolves the PREDECESSOR pane's file. Without a freshness bound the box would stamp today off yesterday's refusal, and — worse in the other direction — clear a limit the job lane had just stamped for real, off a success that happened before the pane was replaced.
// cm:why the boundary is INCLUSIVE — a record exactly `FRESH_WITHIN` old is still fresh — because the failure it guards is a record from another pane's lifetime, which is orders of magnitude older, and a strict comparison would make a test at the exact edge assert arithmetic rather than behaviour.
pub(crate) const FRESH_WITHIN: Duration =
    Duration::from_secs(2 * (LIMITED_POLL_INTERVAL.as_secs() + NUDGE_REFRESH.as_secs()));

/// How near to now a successful turn must sit before it may LIFT a limit.
///
/// Tighter than [`FRESH_WITHIN`], and the asymmetry is the point.
// cm:guard reporting a cap and lifting one are not equally safe, so they do not get the same bound. A late report costs a few wasted turns; a late CLEAR re-opens this box to dispatch against an account that is still refusing. The box cannot see WHEN core's stamp was written — `/me/runners` carries the remaining seconds and not the instant — so a stamp the job lane made two minutes ago is indistinguishable here from one made an hour ago, and a success older than it would lift it.
// cm:hack ISS-1060 until:`/me/runners` carries the instant a limit was stamped — the residual race is priced rather than closed. A job-lane or chat-lane stamp written inside the last `CLEAR_WITHIN` can still be lifted by a master turn that succeeded just before it, and what that costs is up to one nudge period of dispatch into a capped account before either lane observes the refusal again and re-stamps. Closing it properly means a new field on core's runner row and a conditional `clearMasterLimit`, which is the job lane this issue puts out of scope. This bound is what keeps the window at one nudge period instead of `FRESH_WITHIN`'s twenty minutes.
// cm:why `NUDGE_REFRESH` exactly: it is the longest a live master may go un-prompted, so a success inside it is one the pane is still producing, and anything older is a pane that has stopped answering rather than an account that has recovered.
pub(crate) const CLEAR_WITHIN: Duration = NUDGE_REFRESH;

/// How much of a conversation's tail one sweep reads.
// cm:why bounded and read from the END because a master's conversation reaches hundreds of megabytes over a pane's life, and the scan below parses BACKWARDS and stops at the first record that classifies — so the common sweep parses one line and this is a ceiling on the pathological one, not the usual cost.
pub(crate) const TAIL_BYTES: u64 = 512 * 1024;

/// Longest `detail` core's route accepts, in UTF-16 units — `z.string().max(200)`
/// counts what JavaScript counts, not what Rust does.
// cm:edge contract -> packages/core/src/devices/pool-routes.ts — `masterLimitSchema` is the validator this bound answers to; a body over it is refused whole, so the box would report nothing rather than report a long reason.
const DETAIL_MAX_UTF16: usize = 200;

/// Why the account refused, in core's own vocabulary.
// cm:edge contract -> packages/core/src/db/schema.ts — `runnerLimitReasons` is the enum these three strings must stay a subset of; a member added there that this never sends is a cap the master can see and cannot report, and a string sent from here that is not there is a 400 on every report.
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
    /// The only constructor, because the one pairing core refuses by name is
    /// dropped HERE rather than at each call site.
    // cm:guard `auth` carries NO reset, and this is where that is enforced rather than in the classifier's arms. Core answers `AUTH_LIMIT_HAS_NO_RESET` 400 to the pair, so a caller that built one by hand would silently report nothing at all; and an auth limit given a reset would hand an auth-dead box a self-healing window it does not have.
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
    /// An API error this binary has not been taught to read.
    // cm:guard this is a DECISIVE answer and not a skip. A scan that walked past it would reach an older refusal and report that instead — a stale classification wearing a fresh one's clothes, and a Claude Code release that renamed a field would show up as a box quietly reporting yesterday's cap rather than as a named line in the log.
    Unreadable(String),
}

/// The newest record in a conversation that says anything, and when it said it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Decisive {
    /// Unix seconds, off the record's own `timestamp`.
    pub at: i64,
    /// The `.fff` of that same timestamp, 0 where the record carries none.
    // cm:guard ordering needs this and the freshness bounds do not, which is why it is a field beside `at` rather than a finer `at`. Two masters on one box refuse within the same second routinely — the whole failure this issue was filed for is five of six panes hitting one account at once — and without the fraction the tie-break falls to the `uuid`, which is arbitrary. A success at `.100` whose uuid sorts high would then beat a refusal at `.900` whose uuid sorts low, and the box would lift a limit off evidence it had just read something newer than.
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

/// Read one record's verdict, or `None` when it says nothing about the account.
///
/// The STATUS is read before the `error` slug, deliberately: a status is an HTTP
/// code and a slug is a name a release may change, so `401` stays `auth` under
/// any future spelling of why.
// cm:guard every field read here is read off the PARSED object's top level. The same refusal wording appears inside `message.content[].text` whenever an issue body quoting it reaches a master's pane, and a substring search over the line would classify that as a cap — which is exactly how anyone who can write an issue would hard-exclude a box from dispatch.
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

/// A 429: an account quota window when the record carries one, a bare provider
/// throttle when it does not.
// cm:why `quotaLimits.status == "rejected"` is what separates the two, and it is the same line core's own `detectRunnerLimit` draws: a 5-hour or 7-day window is `usage_limit` and carries a reset core can wait out, while a throttle with no window behind it is `rate_limit`. Reading the `rateLimitType` name instead would make every future window name an unclassified record.
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

/// Whether this record is the account answering.
// cm:guard a `<synthetic>` model is NOT an answer: Claude Code writes that on every record it generated itself, including the refusals above, so treating it as a turn would make each cap clear the limit it had just reported.
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
    // cm:guard TRIMMED here and not only in `detail_of`, because this constructor is what every arm goes through and a blank string is a body core refuses whole (`min(1)`) — a report with nothing to say would then record nothing at all rather than record the reason.
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

/// The newest record in this tail that says anything, or nothing at all.
///
/// Backwards from the end, stopping at the first record that classifies — so the
/// usual sweep parses one line. A record that is `Unreadable` stops the scan
/// with that answer, and one [`FRESH_WITHIN`] away from now in EITHER direction
/// stops it with none.
// cm:why the window is a distance and not an age. Older than the bound stops the scan because everything before it is older still; dated AHEAD of it stops the scan because a clock that ran forward is not one this box may then trust backwards either, and the safe half is to answer nothing and keep sweeping. Read as a signed age instead, a future record is not merely fresh but fresher than anything real, and it wins every ranking `decide` makes.
pub(crate) fn newest_decisive(tail: &str, now_unix: i64) -> Option<Decisive> {
    for line in tail.lines().rev() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(verdict) = classify(&record, now_unix) else {
            continue;
        };
        // cm:guard the timestamp and the freshness bound are read for EVERY verdict, the unreadable one included, and it carries the record's own instant rather than `now`. Across a box the decision is taken on the newest verdict of ALL projects, so an unreadable record stamped `now` would outrank every real refusal on the box, while one dated `0` would rank under every one of them and let a project whose protocol moved be answered by another project's older classification.
        // cm:guard a record this cannot DATE ends the scan with nothing, and does not fall through to the record below it. Everything here rests on knowing when a thing was said: an undatable refusal cannot be tested for freshness and cannot be ranked against another project's, so reporting it would be a claim about now made from a record with no now in it. Answering nothing is the safe half — the box stays unstamped and keeps sweeping.
        let at = record
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(unix_seconds)?;
        if now_unix.saturating_sub(at).unsigned_abs() > FRESH_WITHIN.as_secs() {
            return None;
        }
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

/// The last `TAIL_BYTES` of a file, from the first whole line in them.
///
/// `None` for a path that is not there, which is the normal state of a pane
/// whose first hook event has not landed yet.
// cm:guard the leading partial line is DROPPED rather than parsed. A read that starts mid-line hands `serde_json` a fragment, and a fragment that happens to parse is a record with most of its fields missing — which classifies as nothing, quietly, exactly where a refusal was.
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

/// What the box does this sweep, from every project's verdict at once.
///
/// One decision for the device, not one per project, because both sides of
/// core's route fan out to every runner binding of the device.
// cm:guard the newest verdict wins across ALL projects and the tie-break is total, because `recordMasterLimit` and `clearMasterLimit` are device-wide: decided per project, an older success on one would delete the stamp a newer refusal on another had just written, and which one won would depend on the order `/me/runners` happened to return the rows in. The `(at, uuid)` key is what makes the answer the same in every order.
// cm:guard the CLEAR is gated on what core reports, never on a memo of our own. A memo is empty after a daemon restart and core's column is not, so a box whose account recovered while it was being deployed would otherwise sit stamped until an operator lifted it by hand.
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
        // cm:guard the CLEAR carries its own, tighter bound, and the report does not. See `CLEAR_WITHIN`: this box cannot see when core's stamp was written, so the only thing standing between a stale success and a limit another lane wrote seconds ago is how near to now the success itself sits.
        // cm:why the age must be NON-NEGATIVE as well as small, and the scan's wider bound is a symmetric distance while this one is not. Read as a bare age, a success dated ahead of this box is negative and so inside every upper bound written as `<=` — it would be the one verdict that always clears. The forward half is refused outright rather than merely bounded because nothing legitimate needs it: `now_unix` truncates to whole seconds, so a turn that succeeded this instant reads as EQUAL, and a record claiming to be later than that is a clock this box will not lift a limit on.
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

/// Seconds since the epoch for one `YYYY-MM-DDTHH:MM:SS[.fff]Z` instant.
///
/// Claude Code writes exactly this shape and nothing else.
// cm:guard hand-parsed rather than by a datetime crate, and that is a standing position rather than an oversight: `me-runners.ts` sends the runner REMAINING SECONDS instead of an instant precisely so this binary needs neither a parser nor a skew correction on the pacing path. This one parser exists because the freshness bound and the across-project ordering both need the record's own clock, and it is total over the WHOLE shape — the separators, every field as digits, the calendar, the clock ranges and the trailing `Z` — because three defects on this issue each lived in a case this sentence claimed was covered and was not.
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
    // cm:guard every field is read as DIGITS ONLY, because `parse::<i64>` accepts a leading sign and the shape does not: `-123-01-01T00:00:00Z` lines its separators up exactly where this expects them, and would otherwise answer a real instant for a year no conversation has.
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
    // cm:guard the TAIL is checked too, so the shape this reads is the whole shape it declares. Without it `2026-09-16T12:00:00+07:00` parses, and the offset is silently dropped rather than applied — seven hours of error on a record that reads as perfectly well formed. Safe only by accident today, because `FRESH_WITHIN` is twenty minutes and every real offset is larger; a zone half an hour out would land inside the window and be believed.
    let frac = ts.get(19..).and_then(|rest| rest.strip_suffix('Z'))?;
    if !frac.is_empty() {
        let digits = frac.strip_prefix('.')?;
        if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
    }
    Some(days_from_civil(y, m, d) * 86_400 + hh * 3_600 + mm * 60 + ss)
}

/// The `.fff` of one instant, in milliseconds, or 0 where there is none.
///
/// Separate from [`unix_seconds`] because the two answer different questions:
/// that one decides whether a record may be read at all, this one only orders
/// two that both may.
// cm:guard a fraction this cannot read answers 0 rather than refusing the record, and that asymmetry is deliberate. A record whose SECOND is unreadable cannot be dated at all and ends the scan; a record whose fraction is unreadable is still dated to the second, and dropping it would lose a real refusal over a cosmetic field. Ordering degrades to the uuid tie-break for that one record, which is exactly where this started.
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

/// Length of one month, so a day past the end of it is refused not absorbed.
// cm:why spelled out rather than taken from a crate for the same reason `days_from_civil` is: this file's whole datetime surface is these two functions, and both are exact for every year a conversation record can carry.
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

    /// Refusal and success records captured verbatim off `forge-vm`, plus the two
    /// counterexamples no box has produced. Its first line names which is which.
    // cm:guard a FILE rather than strings in this test, because a string written here to make an assertion pass proves only that the assertion and the string agree. These are what Claude Code actually wrote, and the header line says where each came from.
    const RECORDS: &str = include_str!("../../assets/master-limit-records.jsonl");

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
        panic!("fixture labels {label} as {uuid} and holds no such record")
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

    // cm:guard the STATUS beats the slug, and this is the test that says so. A release renaming `authentication_failed` must not turn a 401 into an unclassified record — the box would then report nothing at all for a credential an operator has to fix.
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

    // cm:guard the refusal wording inside a record's TEXT is not a refusal. This fixture line is a real tool result carrying this issue's own body, which quotes the banner verbatim — so a substring search over the line would classify it as a cap, and anyone who can write an issue could hard-exclude a box from dispatch.
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

    // cm:guard the unreadable record STOPS the scan. Walking past it reaches the older refusal below it and reports that — a cap this binary no longer understands, announced as one it does, with nothing in the log saying the protocol moved.
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

    // cm:guard the two bounds must not converge. The moment `CLEAR_WITHIN` reaches `FRESH_WITHIN` the asymmetry is gone and every success the scan will look at may also lift a stamp — which is the state this change deliberately left behind.
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

    // cm:guard the window is DERIVED from the two constants that bound how long a box can go without a chance to see a refusal. A literal here would keep its value while someone widened `LIMITED_POLL_INTERVAL`, and every real cap would age out unseen.
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
        let dir = std::env::temp_dir().join(format!("forge-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
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

    // cm:guard the memo is keyed on the RECORD's own id and never on the refusal it produced. The
    // same line classified at two sweep times gives two different `resetsInSeconds`, because the
    // reset is counted against the clock — so a memo keyed on the value would read each sweep's
    // arithmetic as a new cap and POST the same refusal every thirty seconds forever.
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

    // cm:guard a refusal core did NOT take is not memoised, so this is what makes the next sweep send it again. The caller records the id only after the POST succeeds; passing `None` here is that state, and it must still produce a report.
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

    // cm:guard BOTH orders, because this is the whole reason the decision is device-wide. Core's route fans out to every binding of the device, so a per-project decision would let the older success below delete the stamp the newer refusal had just written — and which one won would depend on the order `/me/runners` returned the rows in.
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

    // cm:guard the clear's own bound, which the report does not share. A success older than `CLEAR_WITHIN` is a pane that stopped answering, not an account that recovered — and lifting a stamp off it re-opens this box to dispatch against an account that may still be refusing, including one the job lane stamped seconds ago out of evidence this box cannot see.
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

    // cm:guard a REFUSAL keeps the wider bound, which is what makes the asymmetry real rather than a constant nobody reads: the same age that refuses to clear still reports.
    #[test]
    fn a_refusal_older_than_the_clear_bound_is_still_reported() {
        let d = vec![seen("429_five_hour", 100, "u1")];
        let old = 100 + CLEAR_WITHIN.as_secs() as i64 + 1;
        assert!(
            matches!(decide(&d, false, None, old), Action::Report(..)),
            "a late report costs wasted turns; a late clear costs dispatch into a capped account"
        );
    }

    // cm:guard one project's unreadable record silences the WHOLE box while it is the newest thing said, in either sweep order. Without it, a project whose protocol moved is answered by another project's older classification — a cap reported under a name this binary no longer understands, with nothing in the log saying so.
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

    // cm:guard the set is compared WHOLE rather than "each of these is in there", because the failure this catches is a reason that exists on one side and not the other — in either direction. Core's own suite reads the same file against `runnerLimitReasons`, so a rename on either side stops matching one artifact instead of failing on a live box.
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

    // cm:guard this is the WHOLE producing chain — the captured record, the scan, the decision and the transport — landing on a file the receiving side reads off disk. Asserting the classifier and the serializer separately leaves every one of them green while the body core is handed is something neither test ever saw.
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

    // cm:guard the OTHER direction, replayed the same way. Without it the refusal wire test, the decision test and the route test can all be green while a successful turn stops classifying as one, the stamp never lifts, and the box paces itself at five minutes forever.
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

    // cm:guard the scan carries the record's OWN fraction through, rather than leaving every verdict at 0 and quietly restoring the uuid tie-break this exists to replace.
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

    // cm:guard a date or clock reading that cannot exist is REFUSED, never normalised into the neighbouring one. Arithmetic on `2026-02-31T25:61:61Z` lands days and an hour past where the string reads, which is how a record dates itself AHEAD of this box — and a verdict dated in the future outranks every real refusal on the box and passes both freshness bounds, because the age it computes is negative.
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

    // cm:guard a record dated AHEAD of this box is out of the window exactly as an old one is, in both the scan and the decision. Read as a signed age it is not merely fresh but fresher than anything real, so a success from a clock that ran forward would lift a limit another lane had stamped seconds earlier.
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

    // cm:guard the CLEAR takes no forward tolerance at all, not even the one the scan takes. A whole-second `now` admits a record written in the same second as EQUAL, so nothing legitimate needs the future half — and anything that does need it is a clock this box should not be lifting a limit on.
    // cm:guard the ordering must survive two records in the SAME SECOND, because the uuid tie-break is arbitrary by design and a second is an eternity when five masters hit one account at once. A success at `.100` whose uuid sorts high would otherwise beat a refusal at `.900` whose uuid sorts low, and the box would DELETE a limit off evidence it had just read a newer refusal than.
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
}
