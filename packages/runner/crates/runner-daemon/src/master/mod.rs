//! What starts work now that nothing pushes it, and what ends it.
//!
//! Core wakes this box and keeps jobs `queued`; this loop is the only thing on
//! the box that notices. It asks core which projects this device serves, reads
//! each pool, and keeps one RESIDENT master per project — a Claude session
//! running the `forge-master` skill, which decides order and batch size and
//! claims through the control socket.
//!
//! Resident, and parented by tmux rather than by this daemon (ISS-919): an
//! attachable pane, a master that survives a `forge-runner` restart.
//!
//! Nothing here supervises that master any more (ISS-933). A pane's byte count
//! cannot tell a master idle on purpose from one that has stopped, so the
//! silence ceiling, the quiet gate, the transcript reads and the crashloop
//! breaker are gone — leaving one detector, the pane exists or it does not,
//! and one exit the master earns for itself out of the ledger.
//!
//! The daemon deliberately makes NO routing decision. It answers one question
//! per project, "is there anything at all", and hands the rest to judgement.
//!

mod unplaced;
use unplaced::*;
mod registry;
pub use registry::*;
mod nudge;
use nudge::*;
mod sweep;
pub use sweep::*;
mod pool_take;
use pool_take::*;
mod account_limit;
use account_limit::*;
mod runs;
use runs::*;
mod inherit;
pub use inherit::*;
mod outdated;
use outdated::*;
mod deaf;
use deaf::*;
mod mcp;
use mcp::*;
mod place;
use place::*;
mod exit;
use exit::*;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::dispatch::resolve_repo;
use crate::master_build::{self, Judged};
use crate::master_exit::{self, Holding, Verdict};
use crate::master_handed;
use crate::master_inbox::{self, WakeSource};
use crate::master_limit;
use crate::master_pass;
use crate::pool_jobs::{self, JobPanes, Records};
use crate::pool_reads;
use crate::recovery;
use crate::recovery_ports::{self, CoreBeat, CoreRunState, PaneMasters, SignalProbe};
use crate::run_record;
use crate::session_tokens;
use runner_core::agent_activity;
use runner_core::checkpoint;
use runner_core::job_exit;
use runner_core::job_unheard;
use runner_core::ledger::{Ledger, MasterAuthority, MasterStanding, Run};
use runner_core::pane_exit;
use runner_core::run_exit;
use runner_platform::config::Config;
use runner_platform::subagent_host;
use runner_transport::admissible::{self, AdmissibleIssue, DISPATCH_GATING_KIND};
use runner_transport::channel_inbox::{self, UnansweredDocument};
use runner_transport::comment_inbox;
use runner_transport::{master as master_api, mcp_servers, runners, CoreClient};
use runner_workspace::close_loop;
use runner_workspace::held_report;
use runner_workspace::terminal;
use runner_workspace::terminate;
use tokio::sync::mpsc;

const POLL_INTERVAL: Duration = Duration::from_secs(30);

const WAKE_FLOOR: Duration = Duration::from_secs(5);

pub(crate) const NUDGE_REFRESH: Duration = Duration::from_secs(5 * 60);

pub(crate) const LIMITED_POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);

fn standing_prompt(
    project: &str,
    base_branch: Option<&str>,
    master_policy: Option<&str>,
    reach: &runner_workspace::mcp::config::PaneReach,
) -> String {
    let mut out = format!(
        "Use the `forge-master` skill. You are the resident master for project `{project}` on \
this box, and you will be woken again in this same session rather than started fresh.\n"
    );
    if let Some(base) = base_branch {
        out.push_str(&format!(
            "\nYou are standing in this project's checkout, on its base branch `{base}`.\n"
        ));
    }
    out.push_str(&reach.brief());
    if let Some(policy) = master_policy {
        out.push_str(
            "\n## The project owner's standing policy\n\nThis is the owner's own instruction for \
this project, and it OUTRANKS the `forge-master` skill wherever the two differ — the skill holds \
the defaults for a project that has set none. It is set as this project's `master-policy` fact and \
is re-sent to every master this box starts, so it survives this session.\n\n",
        );
        out.push_str(policy);
        out.push('\n');
    }
    out
}
