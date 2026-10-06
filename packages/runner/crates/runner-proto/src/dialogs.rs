//! The permission dialogs this box answered for the panes it placed, exactly as
//! they ride on the heartbeat inside the gate report.

use serde::Serialize;

/// The most projects one beat names. A box serves a handful; past this the
/// projects answered longest ago are left on the box, and core refuses a
/// longer list by name (`devices/gate-report.ts:WIRE_DIALOG_PROJECTS`).
pub const WIRE_PROJECTS: usize = 32;

/// One project's answered dialogs, as the box's record still holds them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answered {
    /// The project whose pane asked. `None` where the pane's environment named none.
    pub project_id: Option<String>,
    /// Dialogs answered; a floor where `count_is_floor`, never a lifetime total.
    pub count: usize,
    pub count_is_floor: bool,
    pub first_at: Option<i64>,
    pub last_at: Option<i64>,
    /// The newest answer, as said to the person: `denied Bash: <command>`.
    pub last: Option<String>,
    /// The subagent that asked last, `None` where the pane's lead asked.
    pub last_agent: Option<String>,
}
