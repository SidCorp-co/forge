//! Who is on the other end of the control socket.
//!
//! A master used to say which session it was and the daemon believed it. That
//! is not an identity, it is a claim: any process that can reach the socket can
//! make it, and every verb this issue adds — park, read a question, revive —
//! acts on a session by name (ISS-964 criteria 29-31).
//!
//! So the daemon mints a capability instead. The token goes into the pane's
//! environment at spawn, comes back on every frame, and the map from token to
//! session is the daemon's own. A frame no longer names a session at all.
//!
//! It is on disk because a daemon adopts panes it did not spawn: an in-memory
//! map is empty after a restart while every master is still running, holding a
//! token this process would then refuse.

use std::collections::HashMap;
use std::path::PathBuf;

use crate::error::{Error, Result};

/// The token-to-session map for one box, backed by a file beside the socket.
// cm:guard the map is token -> session and is read ONLY in that direction. A lookup by session id would let a caller who knows a session name reach it, which is the declared-id weakness this replaces.
pub struct SessionTokens {
    path: PathBuf,
}

/// Where the map lives: beside `control.sock`, so the config dir separates the
/// box's several runner services exactly as it separates their sockets.
// cm:edge naming -> packages/runner/crates/forge-runner-core/src/daemon/control.rs — `socket_path` picks the directory; two daemons sharing this file would hand each other's masters valid capabilities.
pub fn default_path() -> Option<PathBuf> {
    crate::daemon::control::socket_path().map(|s| s.with_file_name("control-tokens.json"))
}

/// The environment variable a pane carries its capability in.
// cm:edge contract -> packages/runner/crates/forge-runner/src/cmd/pool.rs — the CLI reads this name and puts the value on every frame; the master never sees a session id to send.
pub const TOKEN_ENV: &str = "FORGE_CONTROL_TOKEN";

/// The capability this process was spawned with, for the CLI side of the socket.
// cm:guard refuse by NAME when the variable is absent rather than sending an empty token. An empty token is refused as `unknown_token`, which reads as a revoked capability and sends a master looking at core; "not spawned by the daemon" is a different fault with a different fix.
pub fn token_from_env() -> std::io::Result<String> {
    match std::env::var(TOKEN_ENV) {
        Ok(t) if !t.trim().is_empty() => Ok(t),
        _ => Err(std::io::Error::other(format!(
            "{TOKEN_ENV} is not set — this session was not spawned by the runner daemon, and the control socket has no other way to know who is calling"
        ))),
    }
}

impl SessionTokens {
    pub fn at(path: PathBuf) -> Self {
        Self { path }
    }

    fn load(&self) -> HashMap<String, String> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    // cm:guard mode 0600 on write, and the file is created here rather than trusted to exist. A capability readable by another user on the box is not a capability, and this file is the whole of the socket's authentication.
    fn store(&self, map: &HashMap<String, String>) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| Error::Other(format!("tokens: {e}")))?;
        }
        let body = serde_json::to_string(map).map_err(|e| Error::Other(format!("tokens: {e}")))?;
        std::fs::write(&self.path, body).map_err(|e| Error::Other(format!("tokens: {e}")))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    /// Give this session a fresh capability, retiring anything it held.
    pub fn mint(&self, session_id: &str) -> Result<String> {
        let mut map = self.load();
        map.retain(|_, s| s != session_id);
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        map.insert(token.clone(), session_id.to_string());
        self.store(&map)?;
        Ok(token)
    }

    /// Which session holds this capability, if any.
    pub fn session_for(&self, token: &str) -> Option<String> {
        self.load().get(token).cloned()
    }

    /// This session is gone; its capability goes with it.
    pub fn retire(&self, session_id: &str) {
        let mut map = self.load();
        let before = map.len();
        map.retain(|_, s| s != session_id);
        if map.len() != before {
            let _ = self.store(&map);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_names_exactly_one_session() {
        let dir = std::env::temp_dir().join(format!("ft-{}", uuid::Uuid::new_v4()));
        let store = SessionTokens::at(dir.join("control-tokens.json"));
        let a = store.mint("sess-a").unwrap();
        let b = store.mint("sess-b").unwrap();
        assert_ne!(a, b);
        assert_eq!(store.session_for(&a), Some("sess-a".to_string()));
        assert_eq!(store.session_for(&b), Some("sess-b".to_string()));
        assert_eq!(store.session_for("not-a-token"), None);
    }

    #[test]
    fn a_token_survives_the_daemon_that_minted_it() {
        let dir = std::env::temp_dir().join(format!("ft-{}", uuid::Uuid::new_v4()));
        let path = dir.join("control-tokens.json");
        let token = SessionTokens::at(path.clone()).mint("sess-a").unwrap();
        assert_eq!(
            SessionTokens::at(path).session_for(&token),
            Some("sess-a".to_string()),
            "a daemon restart adopts panes it did not spawn, and their tokens live only in their env — an in-memory map would refuse every live master until it respawned (ISS-964 criterion 29)"
        );
    }

    #[test]
    fn retiring_a_session_retires_its_token() {
        let dir = std::env::temp_dir().join(format!("ft-{}", uuid::Uuid::new_v4()));
        let store = SessionTokens::at(dir.join("control-tokens.json"));
        let a = store.mint("sess-a").unwrap();
        store.retire("sess-a");
        assert_eq!(store.session_for(&a), None);
    }

    #[test]
    fn re_minting_replaces_the_previous_token_for_that_session() {
        let dir = std::env::temp_dir().join(format!("ft-{}", uuid::Uuid::new_v4()));
        let store = SessionTokens::at(dir.join("control-tokens.json"));
        let first = store.mint("sess-a").unwrap();
        let second = store.mint("sess-a").unwrap();
        assert_eq!(store.session_for(&second), Some("sess-a".to_string()));
        assert_eq!(
            store.session_for(&first),
            None,
            "a respawned master must not leave a live capability behind for a session that is gone"
        );
    }
}
