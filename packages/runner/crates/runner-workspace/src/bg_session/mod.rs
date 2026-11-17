//! Resident sessions as Claude Code background sessions (ISS-1268 B): masters and room agents run
//! as `claude --bg`, parented by Claude Code's own background service, and take messages over the
//! session's peer socket. No tmux pane holds them and nothing is typed into a composer.
//!
//! - [`roster`]: what `claude agents --json` lists, and the session that serves a project
//!   ([`session_for`]). The permission watcher reads this seam only.
//! - [`peer`]: one message written to a session's peer socket, delivered only once its `msg_id`
//!   stands in the session's transcript.
//! - [`launch`]: the `claude --bg` a session is started or resumed with, the settings file it
//!   reads, and `stop` / `respawn` / `attach` by its short id.
//! - [`version`]: the Claude Code version this box is pinned to, refused by name where the
//!   installed one differs.
//!
//! Measured on Claude Code 2.1.322 (ISS-1268 comments d2ebdae2, f095f341): a session survives the
//! background service's death; a respawn keeps the conversation under a new pid, socket and key,
//! so the socket is resolved by `sessionId` on every send; `crossSessionInbound: "accept"` is what
//! lets a bypass session take a socket message without a dialog.

pub mod canary;
pub mod launch;
pub mod peer;
pub mod prompt;
pub mod relay;
pub mod resident;
pub mod roster;
pub mod version;

pub use launch::{BgLaunch, Started};
pub use peer::{Priority, Receipt, Refused};
pub use roster::{find, list, list_all, session_for, BgSession, RosterError};

/// Which resident a background session is, and so the name it carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A project's resident master.
    Master,
    /// A channel's room agent.
    Chat,
}

impl Kind {
    pub fn prefix(self) -> &'static str {
        match self {
            Kind::Master => crate::terminal::MASTER_PREFIX,
            Kind::Chat => crate::terminal::CHAT_PREFIX,
        }
    }
}

/// The name a project's session of `kind` runs under (`claude --bg --name`), which
/// [`session_for`] finds it by: `forge-master-<slug>` or `forge-chat-<slug>`, the names the panes
/// carried, so the ledger's rows keyed on them still name the same resident.
pub fn session_name(kind: Kind, slug: &str) -> String {
    crate::terminal::session_name(kind.prefix(), slug)
}

/// Claude Code's config directory, where its session records, keys and transcripts are.
pub fn claude_dir() -> Option<std::path::PathBuf> {
    crate::plugin_sync::claude_config_dir()
}
