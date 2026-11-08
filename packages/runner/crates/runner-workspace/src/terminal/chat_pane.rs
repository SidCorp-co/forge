//! The pane a channel agent's resident session runs in (ISS-946): `forge-chat-<slug>`, on this
//! box's own tmux socket beside `forge-master-<slug>`, so its owner watches it with the same
//! `tmux -S <socket> attach` a master takes.
//!
//! A pane on the default tmux server would be one nobody finds: the attach command printed for it
//! names this box's socket. So where the socket path does not fit a unix socket, or there is none,
//! the pane is refused by name and the session runs headless, saying why; a name tmux would have
//! to cut is refused the same way rather than cut, since core prints the name the box reports.

use std::path::{Path, PathBuf};

use super::{attach_command_on, fits_a_unix_socket, session_name};

pub const CHAT_PREFIX: &str = "forge-chat";

/// The longest session name [`session_name`] keeps whole.
const NAME_BOUND: usize = 96;

/// Where a channel agent's pane is placed, and how its owner reaches it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatPane {
    pub name: String,
    pub socket: PathBuf,
}

impl ChatPane {
    /// `tmux -S <socket> attach -t forge-chat-<slug>`.
    pub fn attach_command(&self) -> String {
        attach_command_on(Some(&self.socket), &self.name)
    }
}

/// Why no pane can be placed for a channel agent, so its session runs headless.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChatPaneRefused {
    #[error(
        "[CHAT_PANE_NO_TMUX] tmux is not installed on this box, so the channel agent's session runs headless"
    )]
    NoTmux,
    #[error(
        "[CHAT_PANE_NO_SOCKET] this runner names no config directory to hold its tmux socket, so \
         the channel agent's session runs headless"
    )]
    NoSocket,
    #[error(
        "[CHAT_PANE_SOCKET_TOO_LONG] the tmux socket {socket} is {len} characters, over the {bound} a \
         unix socket path holds, so no pane is made for the channel agent and its session runs \
         headless; move this runner's config directory to a shorter path"
    )]
    SocketTooLong {
        socket: String,
        len: usize,
        bound: usize,
    },
    #[error(
        "[CHAT_PANE_NAME_TOO_LONG] the pane name {name} is {len} characters, over the {bound} tmux \
         keeps whole, so no pane is made for the channel agent and its session runs headless"
    )]
    NameTooLong {
        name: String,
        len: usize,
        bound: usize,
    },
}

/// The pane for the channel agent of project `slug` on this box's socket, or why there is none.
pub fn chat_pane(slug: &str) -> Result<ChatPane, ChatPaneRefused> {
    if !super::available() {
        return Err(ChatPaneRefused::NoTmux);
    }
    let socket = super::session_config_dir()
        .map(|dir| dir.join("tmux.sock"))
        .ok_or(ChatPaneRefused::NoSocket)?;
    chat_pane_on(&socket, slug)
}

/// [`chat_pane`] for the socket at `socket`.
pub fn chat_pane_on(socket: &Path, slug: &str) -> Result<ChatPane, ChatPaneRefused> {
    let shown = socket.to_string_lossy();
    if !fits_a_unix_socket(&shown) {
        return Err(ChatPaneRefused::SocketTooLong {
            len: shown.len(),
            socket: shown.into_owned(),
            bound: SOCKET_BOUND,
        });
    }
    let whole = format!("{CHAT_PREFIX}-{slug}");
    let name = session_name(CHAT_PREFIX, slug);
    if whole.len() > NAME_BOUND || name.len() < whole.len() {
        return Err(ChatPaneRefused::NameTooLong {
            len: whole.len(),
            name: whole,
            bound: NAME_BOUND,
        });
    }
    Ok(ChatPane {
        name,
        socket: socket.to_path_buf(),
    })
}

/// The bound [`fits_a_unix_socket`] holds a socket path to.
const SOCKET_BOUND: usize = 100;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_socket_path_over_the_unix_bound_is_refused_by_name_not_placed_elsewhere() {
        let long = format!("/home/dev/{}/tmux.sock", "d".repeat(90));
        let refused = chat_pane_on(Path::new(&long), "orbit").expect_err("placed a pane");
        assert!(
            matches!(refused, ChatPaneRefused::SocketTooLong { len, bound: 100, .. } if len == long.len()),
            "{refused:?}"
        );
        assert!(
            refused
                .to_string()
                .starts_with("[CHAT_PANE_SOCKET_TOO_LONG]"),
            "{refused}"
        );
    }

    #[test]
    fn a_name_tmux_would_cut_is_refused_rather_than_cut() {
        let slug = "s".repeat(90);
        let refused = chat_pane_on(Path::new("/r/tmux.sock"), &slug).expect_err("cut a name");
        assert!(
            matches!(
                refused,
                ChatPaneRefused::NameTooLong {
                    len: 101,
                    bound: 96,
                    ..
                }
            ),
            "{refused:?}"
        );
    }

    #[test]
    fn a_pane_that_fits_is_named_beside_the_master_and_attached_on_the_box_socket() {
        let pane = chat_pane_on(
            Path::new("/home/dev/.forge-dev-runner/xdg/forge-runner/tmux.sock"),
            "adminhub-api",
        )
        .unwrap();
        assert_eq!(pane.name, "forge-chat-adminhub-api");
        assert_eq!(
            pane.attach_command(),
            "tmux -S '/home/dev/.forge-dev-runner/xdg/forge-runner/tmux.sock' attach -t 'forge-chat-adminhub-api'"
        );
    }
}
