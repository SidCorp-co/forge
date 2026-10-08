//! A process that holds only what it was handed: a view of the filesystem in which the
//! directories named empty are empty, apart from the paths bound back into them, and an
//! environment holding only the variables named.
//!
//! A chat session needs this because it runs a shell as this box's user, and this box's user
//! can read every credential the box holds: the stored PAT and device token, the token written
//! into each checkout's `.mcp.json`, the `forge` CLI's account, SSH keys, `gh`'s token. A deny
//! rule or a prompt does not stop a shell that can `cat` a path, so the paths are simply not
//! there.
//!
//! A shell that holds nothing still sends whatever it can read wherever it can connect, so a
//! sandbox given an [`egress::Egress`] has a network of its own as well, and reaches only the
//! hosts its proxy was started with.
//!
//! Linux only, through bubblewrap: a mount namespace for the view, a PID namespace so no other
//! process's `/proc/<pid>/environ` or `/proc/<pid>/root` is reachable, a network namespace so no
//! connection leaves except through the egress proxy. Elsewhere, and on a Linux box where
//! bubblewrap cannot start, [`availability`] says why, so the box declares it and core refuses
//! the turn by name instead of running it unconfined.

pub mod egress;

use std::ffi::OsString;
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::sync::OnceLock;

/// One entry of the sandbox's filesystem, applied in order: a later entry wins over an
/// earlier one for the same path or a path beneath it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mount {
    /// Replaced by an empty in-memory directory.
    Empty(PathBuf),
    /// The real path, read-only.
    Read(PathBuf),
    /// The real path, writable.
    Write(PathBuf),
    /// An existing file replaced by an empty one, so a reader finds nothing in it.
    Hide(PathBuf),
}

/// What a confined process sees: everything on the box read-only, then `mounts` in order, run
/// in `cwd` with exactly `env`. With `egress`, it has no network but its proxy.
#[derive(Debug, Clone, Default)]
pub struct Sandbox {
    pub mounts: Vec<Mount>,
    pub env: Vec<(OsString, OsString)>,
    pub cwd: PathBuf,
    pub egress: Option<egress::Egress>,
}

/// Whether this box can confine a process, and if not, the reason a person can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Availability {
    Available,
    Unavailable(String),
}

/// Whether this box can confine a process, probed once per process.
pub fn availability() -> &'static Availability {
    #[cfg(target_os = "linux")]
    {
        static PROBED: OnceLock<Availability> = OnceLock::new();
        PROBED.get_or_init(probe)
    }
    #[cfg(not(target_os = "linux"))]
    {
        static UNAVAILABLE: std::sync::OnceLock<Availability> = std::sync::OnceLock::new();
        UNAVAILABLE.get_or_init(|| {
            Availability::Unavailable(format!(
                "a chat session is confined to its own credential only on Linux, through \
                 bubblewrap, and this box runs {}",
                std::env::consts::OS
            ))
        })
    }
}

/// Start an empty sandbox and read whether it ran.
#[cfg(target_os = "linux")]
fn probe() -> Availability {
    let Ok(bwrap) = which::which("bwrap") else {
        return Availability::Unavailable(
            "bubblewrap (`bwrap`) is not installed on this box; install it (`apt install \
             bubblewrap`, `dnf install bubblewrap`)"
                .to_string(),
        );
    };
    let probe = Sandbox {
        cwd: PathBuf::from("/"),
        ..Sandbox::default()
    };
    let mut args: Vec<OsString> = vec!["--unshare-net".into()];
    args.extend(probe.bwrap_args());
    args.push("true".into());
    match std::process::Command::new(&bwrap)
        .args(&args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(std::process::Stdio::null())
        .output()
    {
        Ok(out) if out.status.success() => Availability::Available,
        Ok(out) => Availability::Unavailable(format!(
            "bubblewrap could not start a sandbox on this box ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        Err(e) => Availability::Unavailable(format!(
            "bubblewrap at {} could not be run: {e}",
            bwrap.display()
        )),
    }
}

impl Sandbox {
    /// The bubblewrap arguments up to and including `--`; the program and its arguments follow.
    ///
    /// The whole tree is bound read-only first, so nothing not named is writable. `/dev` and
    /// `/proc` are fresh, and the PID namespace makes this process tree the only one `/proc`
    /// shows. With egress the network namespace is new too, and the proxy's socket directory and
    /// the bridge binary are bound back last, so no emptied directory covers them. `--die-with-parent` ends the tree with the runner's child, and no `--new-session`,
    /// so the runner's kill of the process group still reaches every process inside.
    #[cfg(target_os = "linux")]
    pub fn bwrap_args(&self) -> Vec<OsString> {
        let mut args: Vec<OsString> = [
            "--die-with-parent",
            "--unshare-pid",
            "--unshare-ipc",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        for mount in &self.mounts {
            let (flag, source, target) = match mount {
                Mount::Empty(p) => ("--tmpfs", None, p),
                Mount::Read(p) => ("--ro-bind", Some(p.as_os_str()), p),
                Mount::Write(p) => ("--bind", Some(p.as_os_str()), p),
                Mount::Hide(p) => ("--ro-bind", Some(std::ffi::OsStr::new("/dev/null")), p),
            };
            args.push(flag.into());
            if let Some(source) = source {
                args.push(source.to_os_string());
            }
            args.push(target.as_os_str().to_os_string());
        }
        if let Some(egress) = &self.egress {
            args.insert(0, "--unshare-net".into());
            let dir = egress.socket.parent().unwrap_or(&egress.socket);
            for path in [dir, egress.bridge.as_path()] {
                args.push("--ro-bind".into());
                args.push(path.as_os_str().to_os_string());
                args.push(path.as_os_str().to_os_string());
            }
        }
        args.push("--chdir".into());
        args.push(self.cwd.as_os_str().to_os_string());
        args.push("--".into());
        args
    }

    /// `program args` inside this sandbox, its environment exactly [`Sandbox::env`] — with
    /// egress, the proxy variables replaced by the bridge's, and the bridge running the program.
    /// Refused, naming why, where [`availability`] says this box cannot confine.
    pub fn command(
        &self,
        program: &std::ffi::OsStr,
        args: &[String],
    ) -> crate::Result<tokio::process::Command> {
        if let Availability::Unavailable(why) = availability() {
            return Err(crate::Error::Other(format!(
                "[CHAT_CONFINEMENT_UNAVAILABLE] this session must hold only its own credential, \
                 and this box cannot confine it: {why}"
            )));
        }
        #[cfg(target_os = "linux")]
        {
            let mut cmd = tokio::process::Command::new("bwrap");
            cmd.args(self.bwrap_args());
            let mut env = self.env.clone();
            match &self.egress {
                Some(egress) => {
                    let (bridge, wrapped) = egress.wrap(program, args);
                    cmd.arg(bridge).args(wrapped);
                    env.retain(|(k, _)| !egress::Egress::sets(k));
                    env.extend(egress::Egress::env());
                }
                None => {
                    cmd.arg(program).args(args);
                }
            }
            cmd.env_clear().envs(env);
            cmd.current_dir(&self.cwd);
            Ok(cmd)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (program, args);
            Err(crate::Error::Other(
                "[CHAT_CONFINEMENT_UNAVAILABLE] confinement is Linux-only".into(),
            ))
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn mounts_are_applied_in_the_order_named_after_the_read_only_root() {
        let sandbox = Sandbox {
            mounts: vec![
                Mount::Empty("/home/u".into()),
                Mount::Write("/home/u/repo".into()),
                Mount::Hide("/home/u/repo/.mcp.json".into()),
            ],
            env: vec![],
            cwd: "/home/u/repo".into(),
            egress: None,
        };
        let args: Vec<String> = sandbox
            .bwrap_args()
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let root = args.iter().position(|a| a == "--ro-bind").unwrap();
        let home = args.iter().position(|a| a == "/home/u").unwrap();
        let repo = args.iter().position(|a| a == "--bind").unwrap();
        let hide = args.iter().position(|a| a == "/dev/null").unwrap();
        assert!(
            root < home && home < repo && repo < hide,
            "a later mount must come later, or the home's emptying would cover the checkout: {args:?}"
        );
        assert_eq!(args.last().map(String::as_str), Some("--"));
        assert!(
            !args.iter().any(|a| a == "--new-session"),
            "a new session would put the tree outside the process group the runner kills: {args:?}"
        );
    }

    #[test]
    fn with_egress_the_network_is_new_and_the_proxy_and_bridge_are_bound_back_last() {
        let sandbox = Sandbox {
            mounts: vec![Mount::Empty("/home/u".into())],
            env: vec![("HTTPS_PROXY".into(), "http://box-proxy:3128".into())],
            cwd: "/home/u/repo".into(),
            egress: Some(egress::Egress {
                socket: "/home/u/.config/forge-runner/egress/s1/proxy.sock".into(),
                bridge: "/home/u/.local/bin/forge-runner".into(),
            }),
        };
        let args: Vec<String> = sandbox
            .bwrap_args()
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.iter().any(|a| a == "--unshare-net"), "{args:?}");
        let home = args.iter().position(|a| a == "/home/u").unwrap();
        let dir = args
            .iter()
            .position(|a| a == "/home/u/.config/forge-runner/egress/s1")
            .expect("the proxy's socket directory is bound into the sandbox");
        let bridge = args
            .iter()
            .position(|a| a == "/home/u/.local/bin/forge-runner")
            .expect("the bridge binary is bound into the sandbox");
        assert!(
            home < dir && home < bridge,
            "the emptied home would cover the socket and the bridge: {args:?}"
        );
    }
}
