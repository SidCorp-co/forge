//! A scratch directory a test owns, removed when it drops.

use std::path::{Path, PathBuf};

pub struct Scratch(PathBuf);

impl Scratch {
    /// `fbx-<name>-<8 hex>` under the temp dir. The suffix is short because a box's socket sits
    /// under it and must fit [`crate::browser::SOCKET_PATH_MAX`], and macOS's temp dir alone is
    /// about 49 bytes; a name already taken is drawn again, never shared.
    pub fn new(name: &str) -> Self {
        loop {
            let suffix = uuid::Uuid::new_v4().simple().to_string();
            let d = std::env::temp_dir().join(format!("fbx-{name}-{}", &suffix[..8]));
            match std::fs::create_dir(&d) {
                Ok(()) => return Self(d),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => panic!("scratch dir {}: {e}", d.display()),
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// An executable `sh` script at `name` (parents made) running `body`.
    #[cfg(unix)]
    pub fn script(&self, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = self.0.join(name);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("script dir");
        }
        std::fs::write(
            &p,
            format!("#!/bin/sh\n[ \"$1\" = {PROBE} ] && exit 0\n{body}\n"),
        )
        .expect("script");
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        runnable(&p);
        p
    }
}

/// The argument a [`Scratch::script`] answers by exiting 0 and doing nothing else.
#[cfg(unix)]
const PROBE: &str = "__fbx_probe__";

/// Wait until `p` can be executed. Another test thread that forked while this one held the script
/// open for writing keeps that descriptor until its child execs, and until then an exec of `p`
/// fails ETXTBSY ("Text file busy"). Once one exec of it succeeds, no such child is left: any fork
/// after the write closed cannot hold it.
#[cfg(unix)]
fn runnable(p: &Path) {
    const ETXTBSY: i32 = 26;
    for _ in 0..200 {
        match std::process::Command::new(p).arg(PROBE).status() {
            Ok(_) => return,
            Err(e) if e.raw_os_error() == Some(ETXTBSY) => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => panic!("script {} cannot run: {e}", p.display()),
        }
    }
    panic!("script {} stayed busy (ETXTBSY) for 2 s", p.display());
}

/// A box id this test alone uses. A box's close reaps every process naming its id, in any test
/// running beside it (`proc::reap`), so a test that shares one can kill another's processes. The
/// id is kept for the rest of the test binary's life.
pub fn box_id() -> &'static str {
    Box::leak(uuid::Uuid::new_v4().to_string().into_boxed_str())
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// macOS's temp dir is long (`/var/folders/<2>/<28>/T/`, 49 bytes), and a box's socket under a
/// scratch there must still fit: the whole-suite macOS leg refused every browser box test when the
/// scratch carried a whole uuid (cleanup 21284cd0).
#[test]
fn a_box_socket_under_a_scratch_fits_under_macos_long_temp_dir() {
    let mac_tmp = Path::new("/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/");
    let scratch = Scratch::new("display"); // the longest name a test here takes
    let root = mac_tmp.join(scratch.path().file_name().unwrap()).join("s");
    let dir = crate::browser::socket_dir(&root, box_id());
    assert!(dir.is_ok(), "{dir:?}");
}
