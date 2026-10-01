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
/// `listener`. Returns only where the exec did not happen, with why; the
/// listener is then closed-on-exec again, as it was.
#[cfg(unix)]
pub fn replace_image(exe: &Path, args: &[OsString], listener: Option<i64>) -> std::io::Error {
    use std::os::unix::process::CommandExt;

    let mut cmd = std::process::Command::new(exe);
    cmd.args(args);
    let fd = listener.and_then(|fd| i32::try_from(fd).ok());
    match fd {
        Some(fd) => {
            if let Err(e) = set_close_on_exec(fd, false) {
                return std::io::Error::other(format!(
                    "the control listener (descriptor {fd}) could not be left open across the exec: {e}"
                ));
            }
            cmd.env(LISTENER_ENV, fd.to_string());
        }
        None => {
            cmd.env_remove(LISTENER_ENV);
        }
    }
    let err = cmd.exec();
    if let Some(fd) = fd {
        let _ = set_close_on_exec(fd, true);
    }
    err
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
        let dir = crate::test_scratch::Scratch::new("handover-take");
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
        let dir = crate::test_scratch::Scratch::new("handover-elsewhere");
        let bound = std::os::unix::net::UnixListener::bind(dir.join("other.sock")).unwrap();
        let why = take_listener(bound.as_raw_fd(), &sock_in(&dir))
            .err()
            .expect("refused");
        assert!(why.contains("other.sock"), "{why}");
        assert!(
            bound.local_addr().is_ok(),
            "a refused descriptor is not closed by the refusal"
        );
    }

    #[test]
    fn a_descriptor_that_is_not_a_socket_is_refused_and_left_open() {
        use std::os::fd::AsRawFd;
        let dir = crate::test_scratch::Scratch::new("handover-file");
        let file = std::fs::File::create(dir.join("plain")).unwrap();
        let why = take_listener(file.as_raw_fd(), &sock_in(&dir))
            .err()
            .expect("refused");
        assert!(why.contains("is not a socket"), "{why}");
        assert!(file.metadata().is_ok(), "the file is still open");
    }

    #[test]
    fn a_descriptor_that_is_not_open_is_refused() {
        let dir = crate::test_scratch::Scratch::new("handover-closed");
        let why = take_listener(987_654, &sock_in(&dir))
            .err()
            .expect("refused");
        assert!(why.contains("is not open"), "{why}");
    }
}
