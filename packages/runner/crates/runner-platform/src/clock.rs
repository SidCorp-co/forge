//! The box clock, as the ledger and the logs read it.

/// Seconds since the Unix epoch; 0 on a clock before it.
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Days from 1970-01-01 to the proleptic Gregorian date `y-m-d`.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `2026-09-08T16:04:05Z` or `2026-09-08T16:04:05.123Z`, as core and GitHub
/// write a UTC instant, to milliseconds since the epoch. Anything else —
/// another zone, a missing field — is `None`, never a guess.
pub fn rfc3339_ms(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let time = rest.strip_suffix('Z')?;
    let mut d = date.split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let mo: i64 = d.next()?.parse().ok()?;
    let da: i64 = d.next()?.parse().ok()?;
    if d.next().is_some() {
        return None;
    }
    let mut t = time.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let mi: i64 = t.next()?.parse().ok()?;
    let seconds = t.next()?;
    if t.next().is_some() {
        return None;
    }
    let (se, frac) = seconds.split_once('.').unwrap_or((seconds, ""));
    let se: i64 = se.parse().ok()?;
    if !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // Milliseconds are the first three digits, padded: `.5` is 500.
    let ms = frac
        .bytes()
        .chain(std::iter::repeat(b'0'))
        .take(3)
        .fold(0_i64, |acc, b| acc * 10 + i64::from(b - b'0'));
    Some((days_from_civil(y, mo, da) * 86_400 + h * 3600 + mi * 60 + se) * 1000 + ms)
}

#[cfg(test)]
mod rfc3339_tests {
    use super::rfc3339_ms;

    #[test]
    fn a_utc_instant_reads_to_the_millisecond_and_anything_else_is_none() {
        assert_eq!(rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            rfc3339_ms("2026-10-06T23:21:19.185Z"),
            Some(1_791_328_879_185)
        );
        assert_eq!(
            rfc3339_ms("2026-10-06T23:21:19.5Z"),
            Some(1_791_328_879_500)
        );
        assert_eq!(rfc3339_ms("2026-10-06T23:21:19Z"), Some(1_791_328_879_000));
        for bad in [
            "2026-10-06T23:21:19+07:00",
            "2026-10-06 23:21:19Z",
            "2026-10-06T23:21Z",
            "2026-10-06T23:21:19.x5Z",
            "",
        ] {
            assert_eq!(rfc3339_ms(bad), None, "{bad}");
        }
    }
}
