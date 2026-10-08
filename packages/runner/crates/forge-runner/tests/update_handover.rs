//! The handover as the kernel performs it: one process replacing its own image
//! while a client waits on the control socket it serves (ISS-1379).
//!
//! The daemon's handover is `handover::replace_image` with the control
//! listener carried across, and `handover::inherited_listener` taking it in the
//! image that starts. Unit tests prove each half against a descriptor; only a
//! real exec proves the two meet — that the pid stays, that the descriptor
//! survives the exec, and that a connection made before it is answered after
//! it. This file re-executes its own test binary as the "old" and the "new"
//! image, which is the same exec the daemon makes of the build on disk.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use forge_runner_core::daemon::handover::{self, Inherited};

/// Where a child run of this binary keeps its socket and its marks. Set only
/// on the child; a run of the suite without it makes [`image`] a no-op.
const DIR_ENV: &str = "FORGE_HANDOVER_TEST_DIR";

/// The file the old image replaces itself with, where it is not this binary.
const INTO_ENV: &str = "FORGE_HANDOVER_TEST_INTO";

fn image_args() -> Vec<std::ffi::OsString> {
    ["image", "--exact", "--nocapture", "--test-threads=1"]
        .iter()
        .map(Into::into)
        .collect()
}

fn wait_for(path: &Path, what: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(said) = std::fs::read_to_string(path) {
            if !said.is_empty() {
                return said;
            }
        }
        assert!(Instant::now() < deadline, "no {what} within 30s");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The child: the old image where nothing was handed on, the new one where
/// the listener was.
#[test]
fn image() {
    #[expect(
        clippy::disallowed_methods,
        reason = "the directory the parent test handed this child image"
    )]
    let Some(dir) = std::env::var_os(DIR_ENV).map(PathBuf::from) else {
        return;
    };
    let sock = dir.join("control.sock");
    #[expect(
        clippy::disallowed_methods,
        reason = "whether this image was handed a listener"
    )]
    if std::env::var_os(handover::LISTENER_ENV).is_none() {
        let listener = std::os::unix::net::UnixListener::bind(&sock).expect("bind");
        std::fs::write(dir.join("ready"), std::process::id().to_string()).unwrap();
        wait_for(&dir.join("connected"), "connection");
        #[expect(
            clippy::disallowed_methods,
            reason = "the image the parent test hands over into"
        )]
        let exe = std::env::var_os(INTO_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_exe().expect("this binary"));
        let err = handover::replace_image(&exe, &image_args(), Some(listener.as_raw_fd() as i64));
        std::fs::write(
            dir.join("failed"),
            format!("could not exec {}: {err} ({:?})", exe.display(), err.kind()),
        )
        .unwrap();
        // Still the old image, serving the listener it kept.
        answer(&listener, "old");
        return;
    }
    let listener = match handover::inherited_listener(&sock) {
        Inherited::Taken(l) => l,
        Inherited::None => panic!("nothing handed on"),
        Inherited::Refused(why) => {
            std::fs::write(dir.join("failed"), &why).unwrap();
            panic!("{why}")
        }
    };
    answer(&listener, "new");
}

fn answer(listener: &std::os::unix::net::UnixListener, image: &str) {
    listener.set_nonblocking(false).unwrap();
    let (stream, _) = listener.accept().expect("accept");
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).unwrap();
    writeln!(
        &stream,
        "answered by {}, image {image}, read {}",
        std::process::id(),
        line.trim()
    )
    .unwrap();
}

/// Start the old image, connect to it, and read who answers.
fn hand_over_from(dir: &Path, into: Option<&Path>) -> (u32, String, String) {
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.args(image_args())
        .env(DIR_ENV, dir)
        .env_remove(handover::LISTENER_ENV)
        .env_remove(INTO_ENV)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(into) = into {
        cmd.env(INTO_ENV, into);
    }
    let mut child = cmd.spawn().expect("spawn the old image");
    let old_pid: u32 = wait_for(&dir.join("ready"), "old image").parse().unwrap();
    assert_eq!(old_pid, child.id());

    let mut client = UnixStream::connect(dir.join("control.sock")).expect("connect");
    client
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    writeln!(client, "hello").unwrap();
    std::fs::write(dir.join("connected"), "1").unwrap();

    let mut answer = String::new();
    let read = BufReader::new(&client).read_line(&mut answer);
    let failed = std::fs::read_to_string(dir.join("failed")).unwrap_or_default();
    let _ = child.kill();
    let status = child.wait().unwrap();
    read.unwrap_or_else(|e| {
        panic!("no answer ({e}); the child said: {failed:?}, ended {status:?}")
    });
    assert!(
        status.success() || status.code().is_none(),
        "the image ended {status:?}; it said: {failed:?}"
    );
    (old_pid, answer.trim().to_string(), failed)
}

/// Criteria 12 and 13 where the kernel refuses the file (ENOEXEC): a build on
/// disk that is no executable of this platform. The exec must come back with
/// that refusal, named with the path, and the old image go on answering on the
/// listener it kept — never be run as a shell script in its place, which is
/// what the shell fallback of `execvp` does with such a file.
#[test]
fn an_image_the_kernel_will_not_run_leaves_the_old_one_answering_and_says_why() {
    use std::os::unix::fs::PermissionsExt;
    let dir = forge_runner_core::test_scratch::Scratch::short("noexec");
    let into = dir.join("forge-runner");
    std::fs::write(&into, b"\x00\x01\x02\x03 no executable of any platform\n").unwrap();
    std::fs::set_permissions(&into, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (old_pid, answer, failed) = hand_over_from(&dir, Some(&into));
    assert_eq!(
        answer,
        format!("answered by {old_pid}, image old, read hello"),
        "the child said: {failed:?}"
    );
    assert!(failed.contains(&into.display().to_string()), "{failed}");
    assert!(
        failed.contains("ENOEXEC") || failed.contains("Exec format error"),
        "{failed}"
    );
}

/// The same where there is no file to run at all (ENOENT).
#[test]
fn an_image_that_is_not_there_leaves_the_old_one_answering_and_says_why() {
    let dir = forge_runner_core::test_scratch::Scratch::short("noent");
    let into = dir.join("forge-runner");
    let (old_pid, answer, failed) = hand_over_from(&dir, Some(&into));
    assert_eq!(
        answer,
        format!("answered by {old_pid}, image old, read hello"),
        "the child said: {failed:?}"
    );
    assert!(failed.contains(&into.display().to_string()), "{failed}");
    assert!(failed.contains("NotFound"), "{failed}");
}

/// Criteria 6, 7 and 9: the image is replaced in the same process, so no
/// second process ever serves the socket, and a client that connected to the
/// old image while it was handing over is answered by the new one.
#[test]
fn a_connection_made_before_the_exec_is_answered_by_the_new_image_in_the_same_process() {
    let dir = forge_runner_core::test_scratch::Scratch::short("handover");
    let (old_pid, answer, failed) = hand_over_from(&dir, None);
    assert_eq!(
        answer,
        format!("answered by {old_pid}, image new, read hello"),
        "the child said: {failed:?}"
    );
    assert!(failed.is_empty(), "{failed}");
}
