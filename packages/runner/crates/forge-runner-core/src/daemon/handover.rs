//! Replacing this daemon's image with the build installed on disk.
//!
//! An exec keeps the process — its pid, its service unit, its children — and
//! changes only the program it runs, so the old build and the new one are
//! never two daemons at once and nothing the old one started is signalled
//! (ISS-1379). Before it, an update ended the process and the service manager
//! started another five seconds later; that gap refused every hook and control
//! call the box's panes made, and on a box whose tmux server lived in the
//! daemon's own cgroup it took the panes with it.
//!
//! The control listener is the one thing carried across on purpose: its
//! descriptor is left open over the exec and named in [`LISTENER_ENV`], so a
//! hook that connects while the image is being replaced waits in the
//! listener's backlog and is answered by the new build.

#[cfg(unix)]
use std::ffi::OsString;
#[cfg(unix)]
use std::path::Path;

/// The variable naming the control listener a replaced image hands on.
pub const LISTENER_ENV: &str = "FORGE_RUNNER_CONTROL_FD";

/// Replace this process's image with `exe`, run with `args`, carrying
/// `listener`. Returns only where the exec did not happen, with why, and with
/// this process as it was before the call: the listener closed-on-exec again
/// and the thread's signal mask restored.
///
/// `execve` on the path itself, never `execvp`, which `std`'s
/// `Command::exec` is: on a file the kernel refuses to run (`ENOEXEC`) that
/// one runs it under `/bin/sh` in place of returning, so a build on disk that
/// is no executable of this platform ended the daemon and never reached the
/// line saying the handover did not happen. `Command::exec` also leaves
/// SIGPIPE at its default when the exec fails, and this daemon lives by
/// ignoring it; nothing here touches a disposition, and the image that starts
/// sets its own as the Rust runtime always does.
#[cfg(unix)]
pub fn replace_image(exe: &Path, args: &[OsString], listener: Option<i64>) -> std::io::Error {
    use nix::sys::signal::{pthread_sigmask, SigSet, SigmaskHow};

    let fd = listener.and_then(|fd| i32::try_from(fd).ok());
    let (path, argv, mut envp) = match exec_vectors(exe, args) {
        Ok(v) => v,
        Err(e) => return e,
    };
    if let Some(fd) = fd {
        if let Err(e) = set_close_on_exec(fd, false) {
            return std::io::Error::other(format!(
                "the control listener (descriptor {fd}) could not be left open across the exec: {e}"
            ));
        }
        envp.push(
            std::ffi::CString::new(format!("{LISTENER_ENV}={fd}"))
                .expect("a variable name and a number hold no NUL"),
        );
    }
    // The image starts with no signal blocked, as one a service manager
    // starts does; the mask this thread had is put back if it never starts.
    let mut held = SigSet::empty();
    let cleared = pthread_sigmask(
        SigmaskHow::SIG_SETMASK,
        Some(&SigSet::empty()),
        Some(&mut held),
    )
    .is_ok();
    let err = match nix::unistd::execve(&path, &argv, &envp) {
        Err(errno) => std::io::Error::from(errno),
        Ok(never) => match never {},
    };
    if cleared {
        let _ = pthread_sigmask(SigmaskHow::SIG_SETMASK, Some(&held), None);
    }
    if let Some(fd) = fd {
        let _ = set_close_on_exec(fd, true);
    }
    err
}

/// The path, the arguments and this process's environment as `execve` takes
/// them — the arguments after the path itself, as `argv[0]`, and the
/// environment without any [`LISTENER_ENV`] this process was handed, which
/// names only what the caller passes on.
#[cfg(unix)]
#[allow(clippy::type_complexity)]
fn exec_vectors(
    exe: &Path,
    args: &[OsString],
) -> std::io::Result<(
    std::ffi::CString,
    Vec<std::ffi::CString>,
    Vec<std::ffi::CString>,
)> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c = |bytes: &[u8], what: &str| {
        CString::new(bytes).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{what} holds a NUL byte, which no exec can pass"),
            )
        })
    };
    let path = c(exe.as_os_str().as_bytes(), "the path of the build on disk")?;
    let mut argv = vec![path.clone()];
    for a in args {
        argv.push(c(
            a.as_bytes(),
            "an argument this process was started with",
        )?);
    }
    let mut envp = Vec::new();
    for (k, v) in std::env::vars_os() {
        if k == LISTENER_ENV {
            continue;
        }
        let mut kv = k.as_bytes().to_vec();
        kv.push(b'=');
        kv.extend_from_slice(v.as_bytes());
        envp.push(c(&kv, "a variable of this process's environment")?);
    }
    Ok((path, argv, envp))
}

#[cfg(unix)]
fn set_close_on_exec(fd: i32, close: bool) -> nix::Result<()> {
    use nix::fcntl::{fcntl, FcntlArg, FdFlag};
    // SAFETY: only ever called on the descriptor `control::serve` published,
    // which its listener holds open for the life of this process.
    let borrowed = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) };
    let mut flags = FdFlag::from_bits_truncate(fcntl(borrowed, FcntlArg::F_GETFD)?);
    flags.set(FdFlag::FD_CLOEXEC, close);
    fcntl(borrowed, FcntlArg::F_SETFD(flags)).map(|_| ())
}

/// What a starting daemon found in [`LISTENER_ENV`].
#[cfg(unix)]
pub enum Inherited {
    /// Nothing was handed on: this process binds its own socket.
    None,
    /// The listener the image before this one served, bound where this one
    /// would bind.
    Taken(std::os::unix::net::UnixListener),
    /// Something was named that this process will not take, and why. The
    /// descriptor is left exactly as it was: it may be anything this process
    /// has opened since, and closing it would close that.
    Refused(String),
}

/// The listener a replaced image handed on, where it is one bound at `path`.
#[cfg(unix)]
pub fn inherited_listener(path: &Path) -> Inherited {
    let Some(raw) = std::env::var_os(LISTENER_ENV) else {
        return Inherited::None;
    };
    let Some(fd) = raw.to_str().and_then(|s| s.trim().parse::<i32>().ok()) else {
        return Inherited::Refused(format!(
            "{LISTENER_ENV}={} is not a descriptor number",
            raw.to_string_lossy()
        ));
    };
    match take_listener(fd, path) {
        Ok(listener) => Inherited::Taken(listener),
        Err(why) => Inherited::Refused(why),
    }
}

#[cfg(unix)]
fn take_listener(fd: i32, path: &Path) -> Result<std::os::unix::net::UnixListener, String> {
    use nix::sys::stat::{fstat, SFlag};
    use std::mem::ManuallyDrop;
    use std::os::fd::FromRawFd;

    // SAFETY: fstat on a descriptor that is not open answers EBADF and touches
    // nothing; one that is open is only read.
    let borrowed = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) };
    let stat = fstat(borrowed)
        .map_err(|e| format!("descriptor {fd} is not open in this process ({e})"))?;
    let kind = SFlag::from_bits_truncate(stat.st_mode as nix::libc::mode_t) & SFlag::S_IFMT;
    if kind != SFlag::S_IFSOCK {
        return Err(format!("descriptor {fd} is not a socket"));
    }
    // SAFETY: a socket, checked above. Held in `ManuallyDrop` so that one this
    // process will not take is never closed by being refused.
    let listener = ManuallyDrop::new(unsafe { std::os::unix::net::UnixListener::from_raw_fd(fd) });
    let bound = listener.local_addr().map_err(|e| {
        format!("descriptor {fd} is a socket with no address this process can read ({e})")
    })?;
    match bound.as_pathname() {
        Some(at) if at == path => {}
        Some(at) => {
            return Err(format!(
                "descriptor {fd} is bound at {}, not at {}",
                at.display(),
                path.display()
            ))
        }
        None => return Err(format!("descriptor {fd} is not bound to a path")),
    }
    set_close_on_exec(fd, true)
        .map_err(|e| format!("descriptor {fd} could not be closed-on-exec again ({e})"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("descriptor {fd} could not be made non-blocking ({e})"))?;
    Ok(ManuallyDrop::into_inner(listener))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sock_in(dir: &Path) -> std::path::PathBuf {
        dir.join("control.sock")
    }

    #[test]
    fn a_listener_bound_where_this_process_binds_is_taken() {
        use std::os::fd::AsRawFd;
        let dir = crate::test_scratch::Scratch::short("handover-take");
        let path = sock_in(&dir);
        let bound = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let fd = bound.as_raw_fd();
        let taken = take_listener(fd, &path).expect("taken");
        assert_eq!(taken.as_raw_fd(), fd);
        std::mem::forget(bound);
    }

    #[test]
    fn a_listener_bound_elsewhere_is_refused_by_where_it_is_bound_and_left_open() {
        use std::os::fd::AsRawFd;
        let dir = crate::test_scratch::Scratch::short("handover-elsewhere");
        let bound = std::os::unix::net::UnixListener::bind(dir.join("other.sock")).unwrap();
        let why = take_listener(bound.as_raw_fd(), &sock_in(&dir)).expect_err("refused");
        assert!(why.contains("other.sock"), "{why}");
        assert!(
            bound.local_addr().is_ok(),
            "a refused descriptor is not closed by the refusal"
        );
    }

    #[test]
    fn a_descriptor_that_is_not_a_socket_is_refused_and_left_open() {
        use std::os::fd::AsRawFd;
        let dir = crate::test_scratch::Scratch::short("handover-file");
        let file = std::fs::File::create(dir.join("plain")).unwrap();
        let why = take_listener(file.as_raw_fd(), &sock_in(&dir)).expect_err("refused");
        assert!(why.contains("is not a socket"), "{why}");
        assert!(file.metadata().is_ok(), "the file is still open");
    }

    #[test]
    fn a_descriptor_that_is_not_open_is_refused() {
        let dir = crate::test_scratch::Scratch::short("handover-closed");
        let why = take_listener(987_654, &sock_in(&dir)).expect_err("refused");
        assert!(why.contains("is not open"), "{why}");
    }

    /// Criteria 12 and 13 at this layer: an exec that cannot happen returns
    /// why, naming the path, and leaves the listener as it was — open, bound
    /// and closed-on-exec — so the old build goes on serving it.
    #[test]
    fn an_exec_that_cannot_happen_returns_why_and_leaves_the_listener_serving() {
        use nix::fcntl::{fcntl, FcntlArg, FdFlag};
        use std::os::fd::AsRawFd;
        let dir = crate::test_scratch::Scratch::short("handover-noexec");
        let path = sock_in(&dir);
        let bound = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let missing = dir.join("no-such-build");
        let err = replace_image(&missing, &[], Some(bound.as_raw_fd() as i64));
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound, "{err}");
        let flags = FdFlag::from_bits_truncate(fcntl(&bound, FcntlArg::F_GETFD).unwrap());
        assert!(flags.contains(FdFlag::FD_CLOEXEC), "closed-on-exec again");
        let client = std::os::unix::net::UnixStream::connect(&path).expect("still bound");
        drop(client);
        assert!(bound.accept().is_ok(), "and still accepting");
    }

    /// The thread's signal mask, which the exec clears for the image it
    /// starts, is this thread's again when that image never starts.
    #[test]
    fn an_exec_that_cannot_happen_gives_the_thread_its_signal_mask_back() {
        use nix::sys::signal::{pthread_sigmask, SigSet, SigmaskHow, Signal};
        let dir = crate::test_scratch::Scratch::short("handover-mask");
        let mut blocked = SigSet::empty();
        blocked.add(Signal::SIGUSR2);
        let mut before = SigSet::empty();
        pthread_sigmask(SigmaskHow::SIG_BLOCK, Some(&blocked), Some(&mut before)).unwrap();
        let err = replace_image(&dir.join("no-such-build"), &[], None);
        let mut after = SigSet::empty();
        pthread_sigmask(SigmaskHow::SIG_SETMASK, Some(&before), Some(&mut after)).unwrap();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound, "{err}");
        assert!(after.contains(Signal::SIGUSR2), "the mask was left cleared");
    }

    /// The disposition `signal` has in this process now.
    fn disposition(signal: nix::libc::c_int) -> nix::libc::sighandler_t {
        // SAFETY: a query: no handler is installed, the old one is only read.
        unsafe {
            let mut old: nix::libc::sigaction = std::mem::zeroed();
            assert_eq!(nix::libc::sigaction(signal, std::ptr::null(), &mut old), 0);
            old.sa_sigaction
        }
    }

    /// Criterion 12: an old build left serving is left as it was serving. The
    /// runtime ignores SIGPIPE, which is what lets a hook that hangs up
    /// mid-reply cost this daemon a write error rather than its life; an exec
    /// that did not happen must not have put the default back.
    #[test]
    fn an_exec_that_cannot_happen_leaves_this_process_ignoring_sigpipe() {
        let dir = crate::test_scratch::Scratch::short("handover-pipe");
        assert_eq!(
            disposition(nix::libc::SIGPIPE),
            nix::libc::SIG_IGN,
            "as the runtime set it"
        );
        let err = replace_image(&dir.join("no-such-build"), &[], None);
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound, "{err}");
        assert_eq!(
            disposition(nix::libc::SIGPIPE),
            nix::libc::SIG_IGN,
            "a failed exec put SIGPIPE back to its default, so the next hook that hangs up mid-reply ends the daemon"
        );
    }
}
