//! The one shape every read the view makes fails into.
//!
//! A source the view cannot read is printed as unreadable with its reason, and
//! never as the empty or healthy answer the same code would print for a source
//! that was read and held nothing (ISS-1341). Carrying the failure as a value
//! all the way to the renderer is what makes that impossible to forget: there is
//! no `unwrap_or_default` between a read and its line.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreadable {
    /// What was being read: a path, a table, a route.
    pub source: String,
    pub reason: String,
}

impl Unreadable {
    pub fn new(source: impl Into<String>, reason: impl fmt::Display) -> Self {
        Self {
            source: source.into(),
            reason: reason.to_string(),
        }
    }
}

impl fmt::Display for Unreadable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "UNREADABLE — {}: {}", self.source, self.reason)
    }
}

pub type Read<T> = Result<T, Unreadable>;

/// A duration a person reads without arithmetic.
pub fn span(ms: i64) -> String {
    let secs = ms.max(0) / 1000;
    if secs < 60 {
        return format!("{secs}s");
    }
    let mins = secs / 60;
    if mins < 60 {
        return format!("{mins}m");
    }
    let (hours, rest) = (mins / 60, mins % 60);
    if hours < 48 {
        return if rest == 0 {
            format!("{hours}h")
        } else {
            format!("{hours}h {rest}m")
        };
    }
    let (days, rest_hours) = (hours / 24, hours % 24);
    if rest_hours == 0 {
        format!("{days}d")
    } else {
        format!("{days}d {rest_hours}h")
    }
}

/// `span` of `now - then`, as "… ago".
pub fn ago(now_ms: i64, then_ms: i64) -> String {
    format!("{} ago", span(now_ms - then_ms))
}

/// A modification time in wall-clock ms, where the platform can give one.
pub fn mtime_ms(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreadable_source_says_so_with_its_source_and_reason() {
        let u = Unreadable::new("/x/ledger.sqlite", "no such table: runs");
        assert_eq!(
            u.to_string(),
            "UNREADABLE — /x/ledger.sqlite: no such table: runs"
        );
    }

    #[test]
    fn a_span_reads_at_every_scale() {
        assert_eq!(span(45_000), "45s");
        assert_eq!(span(45 * 60_000), "45m");
        assert_eq!(span(102 * 60_000), "1h 42m");
        assert_eq!(span(3 * 86_400_000 + 3_600_000), "3d 1h");
        assert_eq!(span(-5), "0s");
    }
}
