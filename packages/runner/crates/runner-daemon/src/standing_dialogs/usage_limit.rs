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

/// Seconds from now until `printed` (the text after "continue automatically
/// at", e.g. `3:40pm (Asia/Saigon)`), or `None` where it cannot be read. A time
/// of day already past today is tomorrow's. Read by `date -d`, which owns the
/// time-zone database this crate does not carry; `printed` is an argument and
/// never reaches a shell.
pub async fn resets_in_seconds(printed: &str, now_unix: i64) -> Option<u64> {
    let (clock, zone) = split_zone(printed)?;
    if clock.is_empty()
        || !clock
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ':' || c == ' ')
        || !clock.chars().any(|c| c.is_ascii_digit())
    {
        return None;
    }
    let at = date_epoch(&clock, zone.as_deref(), "").await?;
    let secs = if at > now_unix {
        at - now_unix
    } else {
        // Today's has passed: the printed time is the next one.
        date_epoch(&clock, zone.as_deref(), " tomorrow").await? - now_unix
    };
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

async fn date_epoch(clock: &str, zone: Option<&str>, suffix: &str) -> Option<i64> {
    let mut cmd = tokio::process::Command::new("date");
    if let Some(z) = zone {
        cmd.env("TZ", z);
    }
    let out = tokio::time::timeout(
        Duration::from_secs(5),
        cmd.arg("-d")
            .arg(format!("{clock}{suffix}"))
            .arg("+%s")
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().parse().ok())
        .flatten()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_printed_time_of_day_is_seconds_from_now_and_never_past() {
        let now = runner_platform::clock::now_secs();
        let got = resets_in_seconds("3:40pm (UTC)", now).await.expect("read");
        assert!(got > 0 && got <= 24 * 3600, "{got}");
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

    #[tokio::test]
    async fn text_that_is_not_a_time_is_unreadable() {
        let now = runner_platform::clock::now_secs();
        for junk in ["", "soon", "$(touch x)", "3pm (a b)", "3pm (Asia/Sai;gon)"] {
            assert_eq!(resets_in_seconds(junk, now).await, None, "{junk:?}");
        }
    }
}
