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

    /// An executable script at `name` printing `out`, exiting `code`.
    #[cfg(unix)]
    pub fn script(&self, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = self.0.join(name);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("script dir");
        }
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).expect("script");
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        p
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
