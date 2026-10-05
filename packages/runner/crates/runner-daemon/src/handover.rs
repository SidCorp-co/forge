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
pub const LISTENER_ENV: &str = runner_platform::exe::HANDOVER_LISTENER_ENV;

/// Why a handover is refused where this platform has no exec to replace an
/// image by. Windows is the one such platform this builds for, and there
/// `forge-runner service` installs no service manager to start a new process,
/// so exiting for one would leave the box offline; the daemon goes on serving
/// and says so instead.
pub const NO_HANDOVER_HERE: &str = "this platform has no exec to replace the running image by, and no service manager is installed to start a fresh process, so the daemon does not restart itself here";

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
