//! A project's issues by status, as five lanes of one pipeline, and what moved
//! between two of core's readings.
//!
//! The counts are core's `buckets.byStatus` (`issues/search.ts:countBuckets`),
//! keyed by kernel status. A lane is a stage an operator reads at a glance:
//! MOV is being worked, HAND is done and waiting on the next hand, QUE is
//! admitted and not started, BLK rests on a person or a pause, DRF is parked
//! before admission. `closed` and `dropped` are in no lane.

use std::collections::BTreeMap;

use super::source::Read;

/// Issue counts by kernel status, as core wrote them.
pub type Counts = BTreeMap<String, u64>;

pub const LANES: [(&str, &[&str]); 5] = [
    ("MOV", &["in_progress", "testing", "releasing"]),
    ("HAND", &["developed", "tested", "awaiting_release"]),
    ("QUE", &["open", "confirmed", "clarified", "approved"]),
    ("BLK", &["needs_info", "waiting", "on_hold", "reopen"]),
    ("DRF", &["draft"]),
];

/// The label CHANGE writes for each status, in the order it writes them: the
/// lanes' statuses first, lane by lane, then the two terminal ones.
pub const LABELS: [(&str, &str); 17] = [
    ("in_progress", "prog"),
    ("testing", "test"),
    ("releasing", "rlsg"),
    ("developed", "dev"),
    ("tested", "tstd"),
    ("awaiting_release", "await"),
    ("open", "open"),
    ("confirmed", "conf"),
    ("clarified", "clar"),
    ("approved", "appr"),
    ("needs_info", "info"),
    ("waiting", "wait"),
    ("on_hold", "hold"),
    ("reopen", "reop"),
    ("draft", "drft"),
    ("closed", "clsd"),
    ("dropped", "drop"),
];

/// The five lane sums of one project's counts.
pub fn sums(c: &Counts) -> [u64; 5] {
    LANES.map(|(_, statuses)| statuses.iter().filter_map(|s| c.get(*s)).sum())
}

/// Issues in the four lanes before draft: admitted and not yet finished.
pub fn live(c: &Counts) -> u64 {
    sums(c)[..4].iter().sum()
}

/// Statuses core counted that belong to no lane and are not terminal: a
/// status core added since this list was written, shown by name so no count
/// is dropped from the detail.
pub fn outside(c: &Counts) -> Vec<(&str, u64)> {
    c.iter()
        .filter(|(k, _)| !LABELS.iter().any(|(s, _)| s == k))
        .map(|(k, n)| (k.as_str(), *n))
        .collect()
}

/// One lane summed over several projects: the sum over those read, and how
/// many were and were not read.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Summed {
    pub sum: u64,
    pub read: usize,
    pub unread: usize,
}

impl Summed {
    /// `?` where no project was read, the sum and `?` where some were not,
    /// the sum alone where every one was.
    pub fn cell(&self) -> String {
        match (self.read, self.unread) {
            (0, _) => "?".into(),
            (_, 0) => self.sum.to_string(),
            _ => format!("{}?", self.sum),
        }
    }
}

/// Each lane summed over every project's reading.
pub fn summed<'a>(all: impl IntoIterator<Item = &'a Read<Counts>>) -> [Summed; 5] {
    let mut out = [Summed::default(); 5];
    for one in all {
        match one {
            Ok(c) => {
                for (lane, n) in out.iter_mut().zip(sums(c)) {
                    lane.sum += n;
                    lane.read += 1;
                }
            }
            Err(_) => out.iter_mut().for_each(|l| l.unread += 1),
        }
    }
    out
}

/// Every status whose count moved from `before` to `now`, as `<label>±n` in
/// `LABELS` order, then any other status by its own name; empty where none
/// moved.
pub fn change(before: &Counts, now: &Counts) -> String {
    let moved = |status: &str| {
        let d = now.get(status).copied().unwrap_or(0) as i64
            - before.get(status).copied().unwrap_or(0) as i64;
        (d != 0).then_some(d)
    };
    let mut out: Vec<String> = LABELS
        .iter()
        .filter_map(|(status, label)| moved(status).map(|d| format!("{label}{d:+}")))
        .collect();
    let mut others: Vec<&str> = before
        .keys()
        .chain(now.keys())
        .map(String::as_str)
        .filter(|k| !LABELS.iter().any(|(s, _)| s == k))
        .collect();
    others.sort_unstable();
    others.dedup();
    out.extend(
        others
            .into_iter()
            .filter_map(|k| moved(k).map(|d| format!("{k}{d:+}"))),
    );
    out.join(" ")
}

/// Every project's moves added together, status by status.
pub fn added(changes: impl IntoIterator<Item = (Counts, Counts)>) -> (Counts, Counts) {
    let (mut before, mut now) = (Counts::new(), Counts::new());
    for (b, n) in changes {
        for (k, v) in b {
            *before.entry(k).or_default() += v;
        }
        for (k, v) in n {
            *now.entry(k).or_default() += v;
        }
    }
    (before, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd::top::source::Unreadable;

    fn counts(pairs: &[(&str, u64)]) -> Counts {
        pairs.iter().map(|(k, n)| (k.to_string(), *n)).collect()
    }

    /// Criterion 3: each lane is the sum of exactly its statuses, and the two
    /// terminal statuses are in none.
    #[test]
    fn each_lane_sums_its_own_statuses() {
        let c = counts(&[
            ("in_progress", 1),
            ("testing", 2),
            ("releasing", 4),
            ("developed", 8),
            ("tested", 16),
            ("awaiting_release", 32),
            ("open", 64),
            ("confirmed", 128),
            ("clarified", 256),
            ("approved", 512),
            ("needs_info", 1024),
            ("waiting", 2048),
            ("on_hold", 4096),
            ("reopen", 8192),
            ("draft", 16384),
            ("closed", 1 << 20),
            ("dropped", 1 << 21),
        ]);
        assert_eq!(sums(&c), [7, 56, 960, 15360, 16384]);
        assert_eq!(live(&c), 7 + 56 + 960 + 15360);
        assert!(outside(&c).is_empty());
        assert_eq!(
            outside(&counts(&[("parked_by_owner", 3), ("open", 1)])),
            vec![("parked_by_owner", 3)]
        );
    }

    /// Criterion 4: labels in their fixed order, signed, and a status core
    /// adds later by its own name after them; criterion 5: nothing moved is
    /// blank.
    #[test]
    fn a_change_names_what_moved_in_a_fixed_order() {
        let before = counts(&[("open", 5), ("in_progress", 1), ("closed", 10)]);
        let now = counts(&[("open", 3), ("in_progress", 2), ("closed", 11), ("zeta", 1)]);
        assert_eq!(change(&before, &now), "prog+1 open-2 clsd+1 zeta+1");
        assert_eq!(change(&now, &now), "");
        assert_eq!(change(&Counts::new(), &Counts::new()), "");
        // A status that left the answer entirely moved to zero.
        assert_eq!(change(&counts(&[("draft", 2)]), &Counts::new()), "drft-2");
    }

    /// Criterion 8: a summed lane says `?` when nothing was read and marks a
    /// partial sum, and never shows a sum of nothing as 0.
    #[test]
    fn a_summed_lane_marks_what_it_could_not_read() {
        let read: Read<Counts> = Ok(counts(&[("open", 2), ("draft", 1)]));
        let unread: Read<Counts> = Err(Unreadable::new("GET x", "503"));
        let all = summed([&read, &unread]);
        assert_eq!(all[2].cell(), "2?");
        assert_eq!(all[4].cell(), "1?");
        assert_eq!(all[0].cell(), "0?");
        assert_eq!(summed([&unread])[2].cell(), "?");
        assert_eq!(summed([&read, &read])[2].cell(), "4");
        assert_eq!(summed(std::iter::empty())[2].cell(), "?");
    }

    #[test]
    fn moves_add_across_projects() {
        let (b, n) = added([
            (counts(&[("open", 1)]), counts(&[("open", 2)])),
            (counts(&[("open", 3)]), counts(&[("open", 1), ("draft", 1)])),
        ]);
        assert_eq!(change(&b, &n), "open-1 drft+1");
    }
}
