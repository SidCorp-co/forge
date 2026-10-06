//! What the filesystems a box writes its runs' scratch into have left, exactly
//! as it rides on the heartbeat. The box reads; core judges: the thresholds and
//! the verdict live in `devices/disk-report.ts` (ADR 0009).

use serde::Serialize;

/// The most roots one beat names. A box reads two at most (its configured
/// temp directory and `/tmp` where that is a filesystem of its own), so more is
/// a producer fault, and core refuses a longer list by name.
pub const WIRE_ROOTS: usize = 4;

/// The longest root path or refusal one entry carries, in UTF-16 code units,
/// the unit core counts in.
pub const TEXT_UNITS: usize = 400;

/// One scratch root and what its filesystem answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Root {
    pub root: String,
    #[serde(flatten)]
    pub reading: Reading,
}

/// Both axes or the reason there is no reading. Kept apart from a reading of
/// zero on purpose: once either is a number the two are indistinguishable, and
/// only one of them is a full disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Reading {
    #[serde(rename_all = "camelCase")]
    Took {
        bytes_free: u64,
        bytes_total: u64,
        inodes_free: u64,
        inodes_total: u64,
    },
    Refused {
        refused: String,
    },
}

impl Root {
    /// `root` and any refusal clipped to [`TEXT_UNITS`] on a character boundary.
    pub fn new(root: &str, reading: Reading) -> Self {
        let reading = match reading {
            Reading::Refused { refused } => Reading::Refused {
                refused: clipped(&refused),
            },
            took => took,
        };
        Self {
            root: clipped(root),
            reading,
        }
    }
}

fn clipped(text: &str) -> String {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        units += c.len_utf16();
        if units > TEXT_UNITS {
            return text[..i].to_string();
        }
    }
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reading_and_a_refusal_ride_in_the_shape_core_reads() {
        let took = Root::new(
            "/tmp",
            Reading::Took {
                bytes_free: 1,
                bytes_total: 2,
                inodes_free: 3,
                inodes_total: 4,
            },
        );
        assert_eq!(
            serde_json::to_value(&took).unwrap(),
            serde_json::json!({ "root": "/tmp", "bytesFree": 1, "bytesTotal": 2,
                "inodesFree": 3, "inodesTotal": 4 })
        );
        let refused = Root::new(
            "/x",
            Reading::Refused {
                refused: "é".repeat(TEXT_UNITS + 3),
            },
        );
        assert_eq!(
            serde_json::to_value(&refused).unwrap(),
            serde_json::json!({ "root": "/x", "refused": "é".repeat(TEXT_UNITS) })
        );
    }
}
