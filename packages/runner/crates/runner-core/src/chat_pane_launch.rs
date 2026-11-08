//! The launch file a channel agent's pane command reads (ISS-946): the confined command the box
//! built for the session, with the environment it sets. tmux, not the daemon, is the pane's
//! parent, so the environment travels in this file, readable by this user alone and removed by
//! `forge-runner chat-pane-exec` once read, rather than on a command line every process can see.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The confined command a pane runs, as `chat-pane-exec` execs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    pub cwd: PathBuf,
}

impl Launch {
    /// The launch `cmd` would run: its program, arguments, working directory and the environment
    /// it sets. A command built with `env_clear` runs with exactly that environment.
    pub fn of(cmd: &std::process::Command, fallback_cwd: &Path) -> Self {
        Self {
            program: PathBuf::from(cmd.get_program()),
            args: cmd.get_args().map(OsString::from).collect(),
            env: cmd
                .get_envs()
                .filter_map(|(k, v)| v.map(|v| (k.to_os_string(), v.to_os_string())))
                .collect(),
            cwd: cmd
                .get_current_dir()
                .map_or_else(|| fallback_cwd.to_path_buf(), Path::to_path_buf),
        }
    }
}

/// Write `launch` to `path`, readable by this user alone.
pub fn write(path: &Path, launch: &Launch) -> std::io::Result<()> {
    let text = serde_json::to_vec(launch).map_err(std::io::Error::other)?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    use std::io::Write as _;
    opts.open(path)?.write_all(&text)
}

/// The launch at `path`, removed once read: it holds the session's environment.
pub fn read_and_remove(path: &Path) -> Result<Launch, String> {
    let text = std::fs::read(path).map_err(|e| {
        format!(
            "[CHAT_PANE_LAUNCH_UNREAD] the pane's launch {} could not be read, so no session was started: {e}",
            path.display()
        )
    })?;
    let _ = std::fs::remove_file(path);
    serde_json::from_slice(&text).map_err(|e| {
        format!(
            "[CHAT_PANE_LAUNCH_UNREAD] the pane's launch {} is not one the box wrote: {e}",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_launch_is_written_for_this_user_alone_and_gone_once_read() {
        let dir = std::env::temp_dir().join(format!("pane-launch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("l.json");
        let mut cmd = std::process::Command::new("bwrap");
        cmd.args(["--", "claude"]).env_clear().env("HOME", "/h").current_dir("/w");
        let launch = Launch::of(&cmd, Path::new("/x"));
        write(&path, &launch).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let back = read_and_remove(&path).unwrap();
        assert_eq!(back, launch);
        assert_eq!(back.env, vec![("HOME".into(), "/h".into())]);
        assert_eq!(back.cwd, PathBuf::from("/w"));
        assert!(!path.exists(), "the launch, which holds the environment, was left behind");
        assert!(read_and_remove(&path)
            .unwrap_err()
            .starts_with("[CHAT_PANE_LAUNCH_UNREAD]"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
