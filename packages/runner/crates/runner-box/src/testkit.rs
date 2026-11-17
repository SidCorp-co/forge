//! A scratch directory a test owns, removed when it drops.

use std::path::{Path, PathBuf};

pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new(name: &str) -> Self {
        let d = std::env::temp_dir().join(format!("fbx-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).expect("scratch dir");
        Self(d)
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

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
