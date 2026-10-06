//! A binary a pane needs that this box cannot resolve, exactly as it rides on
//! the heartbeat.

use serde::Serialize;

/// The most binaries one beat names. A box needs three, so more is a producer
/// fault, and `devices/binary-report.ts` refuses a longer list by name.
pub const WIRE_MAX: usize = 8;

/// The longest detail one entry carries, in UTF-16 code units, the unit core
/// counts in.
pub const DETAIL_UNITS: usize = 600;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Missing {
    /// The command a pane runs it by: `forge-runner`, `claude` or `node`.
    pub name: String,
    /// What was looked for and where, and what fails without it.
    pub detail: String,
}

impl Missing {
    /// `detail` clipped to [`DETAIL_UNITS`] on a character boundary.
    pub fn new(name: &str, detail: String) -> Self {
        let mut units = 0;
        let mut end = detail.len();
        for (i, c) in detail.char_indices() {
            units += c.len_utf16();
            if units > DETAIL_UNITS {
                end = i;
                break;
            }
        }
        Self {
            name: name.to_string(),
            detail: detail[..end].to_string(),
        }
    }
}
