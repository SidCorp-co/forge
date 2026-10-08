//! Claude Code's account usage-limit choice list, standing on a master's pane.
//!
//! The list offers "Stop and wait for limit to reset" / "Wait here, then
//! continue automatically at <time>" / "Ask your admin". Left standing it froze
//! the master until a person pressed a key, and every nudge into it was refused
//! by name on every sweep. It is the ACCOUNT's, so the box tells core the limit
//! (with the printed reset where one is readable) BEFORE it presses anything,
//! then dismisses the list with Escape. Never a numbered choice: each of those
//! decides something about the account's session that is a person's.

use std::time::Duration;

use jiff::tz::{AmbiguousOffset, TimeZone};
use jiff::{Span, Timestamp};
use runner_transport::{master as master_api, CoreClient};

/// Tells core the account is capped.
#[expect(
    async_fn_in_trait,
    reason = "a test seam implemented only inside this workspace; no caller needs its future to be Send"
)]
pub trait LimitReporter {
    async fn usage_limit(
        &self,
        resets_in_seconds: Option<u64>,
        detail: &str,
    ) -> runner_platform::error::Result<()>;
}

impl LimitReporter for CoreClient {
    async fn usage_limit(
        &self,
        resets_in_seconds: Option<u64>,
        detail: &str,
    ) -> runner_platform::error::Result<()> {
        match tokio::time::timeout(
            Duration::from_secs(10),
            master_api::report_limit(self, "usage_limit", resets_in_seconds, detail),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(runner_platform::error::Error::Other(
                "core did not answer within 10s".into(),
            )),
        }
    }
}

/// The reporter of a sweep with no core to tell: refuses by name, so the list
/// is left standing rather than dismissed unreported.
pub struct NoCore;

impl LimitReporter for NoCore {
    async fn usage_limit(&self, _: Option<u64>, _: &str) -> runner_platform::error::Result<()> {
        Err(runner_platform::error::Error::Other(
            "no core client to report the limit to".into(),
        ))
    }
}

/// What the box logs once the list is on record and dismissed. Core holds this
/// box until its master's next nudge whatever the account printed (ISS-276), so
/// a printed reset is named as the account's claim and never as when work resumes.
pub fn dismissed_line(pane: &str, resets_in_seconds: Option<u64>) -> String {
    let printed = match resets_in_seconds {
        Some(s) => format!("the account printed a reset {s}s away, its claim"),
        None => "the account printed no readable reset".into(),
    };
    format!(
        "[dialog] {pane}: the account's usage-limit list was standing; core was told ({printed}) and holds this box until its next nudge; the list was dismissed with Escape — no option was chosen"
    )
}

/// Seconds from `now_unix` until `printed` (the text after "continue
/// automatically at", e.g. `3:40pm (Asia/Saigon)`), or `None` where it cannot
/// be read. A clock with no zone is read in the box's own zone.
pub fn resets_in_seconds(printed: &str, now_unix: i64) -> Option<u64> {
    let (clock, zone) = split_zone(printed)?;
    let clock = Clock::parse(&clock)?;
    let tz = match zone {
        Some(name) => TimeZone::get(&name).ok()?,
        None => TimeZone::try_system().ok()?,
    };
    next_occurrence(clock, &tz, Timestamp::from_second(now_unix).ok()?)
}

/// A printed time of day: `3:40pm`, `3:40 PM`, `3pm` or `15:40`.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Clock {
    hour: i8,
    minute: i8,
}

impl Clock {
    fn parse(text: &str) -> Option<Self> {
        let text = text.trim().to_ascii_lowercase();
        let (digits, meridiem) = match text.strip_suffix("am") {
            Some(d) => (d.trim_end(), Some(false)),
            None => match text.strip_suffix("pm") {
                Some(d) => (d.trim_end(), Some(true)),
                None => (text.as_str(), None),
            },
        };
        let (hour, minute) = match digits.split_once(':') {
            Some((h, m)) if m.len() == 2 => (h, number(m)?),
            Some(_) => return None,
            // A bare hour is a clock only with am or pm after it.
            None if meridiem.is_some() => (digits, 0),
            None => return None,
        };
        let hour = number(hour)?;
        let hour = match meridiem {
            None if hour <= 23 => hour,
            Some(pm) if (1..=12).contains(&hour) => hour % 12 + if pm { 12 } else { 0 },
            _ => return None,
        };
        (minute <= 59).then_some(Self { hour, minute })
    }
}

fn number(text: &str) -> Option<i8> {
    if text.is_empty() || text.len() > 2 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Seconds from `now` to the first instant after it at which `tz`'s wall
/// clock reads `clock`: today's if still ahead, otherwise tomorrow's. Across a
/// daylight-saving shift the rule is the same wall clock, never a count of
/// hours: a time the spring-forward gap skips never shows that day, so it is
/// the next day's; a time the fall-back fold shows twice is the first of the
/// two still ahead.
fn next_occurrence(clock: Clock, tz: &TimeZone, now: Timestamp) -> Option<u64> {
    let today = now.to_zoned(tz.clone()).date();
    let at = (0..=7)
        .filter_map(|day| today.checked_add(Span::new().days(day)).ok())
        .flat_map(|date| {
            let wall = date.at(clock.hour, clock.minute, 0, 0);
            let offsets = match tz.to_ambiguous_timestamp(wall).offset() {
                AmbiguousOffset::Unambiguous { offset } => vec![offset],
                AmbiguousOffset::Gap { .. } => vec![],
                AmbiguousOffset::Fold { before, after } => vec![before, after],
            };
            offsets
                .into_iter()
                .filter_map(move |offset| offset.to_timestamp(wall).ok())
        })
        .find(|at| *at > now)?;
    let secs = at.as_second() - now.as_second();
    // A reset further off than a week is a misread, not a window.
    (0 < secs && secs <= 7 * 24 * 3600).then_some(secs as u64)
}

/// `3:40pm (Asia/Saigon)` as (`3:40pm`, Some(`Asia/Saigon`)).
fn split_zone(printed: &str) -> Option<(String, Option<String>)> {
    let printed = printed.trim();
    match printed.split_once('(') {
        None => Some((printed.to_string(), None)),
        Some((clock, rest)) => {
            let zone = rest.strip_suffix(')')?.trim();
            let ok = !zone.is_empty()
                && zone
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '+' | '-'));
            ok.then(|| (clock.trim().to_string(), Some(zone.to_string())))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `2026-06-15T12:00:00Z` — 19:00 in Ho Chi Minh City, which keeps +07 all year.
    const NOON_UTC: i64 = 1_781_524_800;

    #[test]
    fn a_printed_time_of_day_is_seconds_from_now_and_never_past() {
        let got = resets_in_seconds("3:40pm (UTC)", NOON_UTC);
        assert_eq!(got, Some(3 * 3600 + 40 * 60));
    }

    #[test]
    fn every_printed_shape_is_read_in_the_zone_it_names() {
        for (printed, want) in [
            ("3:40pm (UTC)", 13_200),
            ("15:40 (UTC)", 13_200),
            ("3pm (UTC)", 10_800),
            ("3:40 PM (UTC)", 13_200),
            ("12pm (UTC)", 86_400),
            ("12am (UTC)", 43_200),
            // 19:00 there now, so 21:30 is 2h30m off and 6am is tomorrow's.
            ("9:30pm (Asia/Ho_Chi_Minh)", 9_000),
            ("6am (Asia/Ho_Chi_Minh)", 39_600),
        ] {
            assert_eq!(
                resets_in_seconds(printed, NOON_UTC),
                Some(want),
                "{printed}"
            );
        }
    }

    #[test]
    fn a_time_already_past_today_is_tomorrows() {
        assert_eq!(resets_in_seconds("11:40am (UTC)", NOON_UTC), Some(85_200));
        // The printed minute itself is not ahead, so it is tomorrow's.
        assert_eq!(resets_in_seconds("12:00 (UTC)", NOON_UTC), Some(86_400));
        assert_eq!(
            resets_in_seconds("7pm (Asia/Ho_Chi_Minh)", NOON_UTC),
            Some(86_400)
        );
    }

    #[test]
    fn no_zone_is_the_box_zone() {
        let tz = jiff::tz::TimeZone::try_system().expect("this box names its zone");
        let now = jiff::Timestamp::from_second(NOON_UTC).unwrap();
        let clock = Clock::parse("3:40pm").unwrap();
        assert_eq!(
            resets_in_seconds("3:40pm", NOON_UTC),
            next_occurrence(clock, &tz, now)
        );
        assert!(resets_in_seconds("3:40pm", NOON_UTC).is_some());
    }

    /// New York springs forward at 2am on 2026-03-08 and falls back at 2am on
    /// 2026-11-01.
    #[test]
    fn a_daylight_saving_shift_moves_the_reset_by_the_clock_not_by_the_hours() {
        // 01:00 EST: 3:30am is 1h30m off, not 2h30m, the hour from 2 to 3 never shows.
        let spring = 1_772_949_600;
        assert_eq!(
            resets_in_seconds("3:30am (America/New_York)", spring),
            Some(5_400)
        );
        // 2:30am never shows that day, so the next time the clock reads it is
        // 2026-03-09 02:30 EDT.
        assert_eq!(
            resets_in_seconds("2:30am (America/New_York)", spring),
            Some(88_200)
        );
        // 00:30 EDT: 1:30am shows twice; the first is 1h off.
        let fall = 1_793_507_400;
        assert_eq!(
            resets_in_seconds("1:30am (America/New_York)", fall),
            Some(3_600)
        );
        // 01:45 EDT: the first 1:30 has passed, the second (EST) is 45m off.
        assert_eq!(
            resets_in_seconds("1:30am (America/New_York)", fall + 4_500),
            Some(2_700)
        );
    }

    #[test]
    fn the_dismissed_line_says_core_holds_until_the_next_nudge_and_names_a_printed_reset_as_a_claim(
    ) {
        let printed = dismissed_line("%3", Some(10_800));
        assert!(
            printed.contains("the account printed a reset 10800s away, its claim"),
            "{printed}"
        );
        assert!(
            printed.contains("holds this box until its next nudge"),
            "{printed}"
        );
        let none = dismissed_line("%3", None);
        assert!(
            none.contains("the account printed no readable reset"),
            "{none}"
        );
        assert!(
            none.contains("holds this box until its next nudge"),
            "{none}"
        );
        for line in [printed, none] {
            assert!(!line.contains("resets in"), "{line}");
            assert!(!line.contains("its own cooldown"), "{line}");
        }
    }

    #[test]
    fn text_that_is_not_a_time_is_unreadable() {
        let now = NOON_UTC;
        for junk in [
            "",
            "soon",
            "$(touch x)",
            "3pm (a b)",
            "3pm (Asia/Sai;gon)",
            "3pm (Mars/Olympus_Mons)",
            "3pm (UTC",
            "13pm (UTC)",
            "0am (UTC)",
            "24:00 (UTC)",
            "15:60 (UTC)",
            "15:4 (UTC)",
            "15 (UTC)",
            "3:40pmx (UTC)",
            "3:40:10pm (UTC)",
            "next tuesday (UTC)",
        ] {
            assert_eq!(resets_in_seconds(junk, now), None, "{junk:?}");
        }
    }
}
