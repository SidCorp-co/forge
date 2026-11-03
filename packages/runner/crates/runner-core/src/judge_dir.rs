//! Where `forge-runner judge-login` leaves a run's test login, and the one removal of it when the
//! run ends (ISS-920).
//!
//! `judge-login` writes the testing profile's credential to `$TMPDIR/forge-judge-<run>/`. Deleting
//! it was left to the judge's brief, and on 2026-11-03 two closed runs' logins were still on disk.
//! Every place that names the directory — the write, `run close`, the daemon's close loop — names it
//! through [`dir`], rooted at [`root`], so there is one rule for where it is and never two copies.

use std::path::{Path, PathBuf};

/// The directory name's prefix; the run id follows it.
pub const PREFIX: &str = "forge-judge-";

/// The temp root a judge login is written under: `$TMPDIR`, as the standard library resolves it
/// (`/tmp` when unset). Read in the process that writes or removes, so a `run close` typed in the
/// pane the judge ran in reads the same root the judge's `judge-login` did.
pub fn root() -> PathBuf {
    std::env::temp_dir()
}

/// A run id as this box mints one: a lowercase or uppercase uuid, hyphens at 8, 13, 18 and 23.
/// Nothing else names a directory here, so no `..`, `/` or other separator can reach the path.
pub fn is_run_id(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `<root>/forge-judge-<run_id>`, or the line refusing an id that is not a run id's shape.
pub fn dir(root: &Path, run_id: &str) -> Result<PathBuf, String> {
    if !is_run_id(run_id) {
        return Err(format!(
            "`{run_id}` is no run id (a uuid), so it names no {PREFIX}<run> directory and nothing \
             was removed"
        ));
    }
    Ok(root.join(format!("{PREFIX}{run_id}")))
}

/// What one removal came to.
#[derive(Debug)]
pub enum Removal {
    /// No directory: the run never logged in, or it was already removed. Not an error.
    Absent,
    /// The directory and everything in it are gone. A symlink standing at the path is removed as a
    /// link; what it points at is never touched.
    Removed(PathBuf),
    /// The run id is not a run id's shape; nothing was looked at or removed.
    Refused(String),
    /// The removal failed; the path and the OS error say where and why.
    Failed {
        path: PathBuf,
        error: std::io::Error,
    },
}

/// Remove `<root>/forge-judge-<run_id>` and everything in it.
///
/// Only that one entry is touched. `remove_dir_all` does not follow a symlink inside the
/// directory, and a symlink standing at the path itself is unlinked rather than followed, so no
/// removal reaches outside `root`.
pub fn remove(root: &Path, run_id: &str) -> Removal {
    let path = match dir(root, run_id) {
        Ok(p) => p,
        Err(why) => return Removal::Refused(why),
    };
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Removal::Absent,
        Err(error) => return Removal::Failed { path, error },
    };
    let done = if meta.is_dir() {
        std::fs::remove_dir_all(&path)
    } else {
        std::fs::remove_file(&path)
    };
    match done {
        Ok(()) => Removal::Removed(path),
        Err(error) => Removal::Failed { path, error },
    }
}

impl Removal {
    /// The line a close says about it, or `None` where there was nothing to say.
    pub fn said(&self) -> Option<String> {
        match self {
            Removal::Absent => None,
            Removal::Removed(p) => Some(format!(
                "removed {}: the test login its judge was handed",
                p.display()
            )),
            Removal::Refused(why) => Some(format!("no judge login removed: {why}")),
            Removal::Failed { path, error } => Some(format!(
                "could not remove {} ({error}): the run is closed, and the test login in it is \
                 still on disk — delete that directory by hand",
                path.display()
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUN: &str = "f1b18bd5-3044-4f91-9375-a00bc8397786";
    const OTHER: &str = "cbfc71ed-1111-4222-8333-944455556666";

    /// A root under `$TMPDIR`, removed when the test ends.
    struct Root(PathBuf);
    impl Root {
        fn new(name: &str) -> Self {
            let p = root().join(format!("forge-judge-dir-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn plant(&self, run: &str) -> PathBuf {
            let d = self.0.join(format!("{PREFIX}{run}"));
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("x.json"), "{}").unwrap();
            d
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                for entry in std::fs::read_dir(&self.0).into_iter().flatten().flatten() {
                    let _ = std::fs::set_permissions(
                        entry.path(),
                        std::fs::Permissions::from_mode(0o700),
                    );
                }
            }
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_run_id_is_a_uuid_and_nothing_else() {
        assert!(is_run_id(RUN));
        assert!(is_run_id(&RUN.to_uppercase()));
        for bad in [
            "",
            "self",
            "f1b18bd5",
            "../../../../../../../../../../etc/x",
            "f1b18bd5-3044-4f91-9375-a00bc83977/6",
            "f1b18bd5-3044-4f91-9375-a00bc83977..",
            "f1b18bd5/3044-4f91-9375-a00bc8397786",
            "f1b18bd5-3044-4f91-9375-a00bc8397786/",
            "g1b18bd5-3044-4f91-9375-a00bc8397786",
        ] {
            assert!(!is_run_id(bad), "{bad}");
            assert!(dir(Path::new("/r"), bad).is_err(), "{bad}");
        }
        assert_eq!(
            dir(Path::new("/r"), RUN).unwrap(),
            PathBuf::from(format!("/r/forge-judge-{RUN}"))
        );
    }

    #[test]
    fn the_runs_directory_goes_and_another_runs_stays() {
        let r = Root::new("one");
        let mine = r.plant(RUN);
        let theirs = r.plant(OTHER);
        let gone = remove(&r.0, RUN);
        assert!(
            matches!(&gone, Removal::Removed(p) if *p == mine),
            "{gone:?}"
        );
        assert!(!mine.exists());
        assert!(theirs.join("x.json").exists());
        let line = gone.said().unwrap();
        assert!(line.contains(&mine.display().to_string()), "{line}");
        assert!(line.starts_with("removed "), "{line}");
    }

    #[test]
    fn an_absent_directory_is_said_nothing_about() {
        let r = Root::new("absent");
        let none = remove(&r.0, RUN);
        assert!(matches!(none, Removal::Absent), "{none:?}");
        assert_eq!(none.said(), None);
    }

    #[test]
    fn a_hostile_id_is_refused_and_removes_nothing() {
        let r = Root::new("hostile");
        let inner = r.0.join("inner");
        let victim = inner.join(format!("{PREFIX}x"));
        std::fs::create_dir_all(&victim).unwrap();
        std::fs::write(victim.join("keep.json"), "{}").unwrap();
        let planted = r.plant(RUN);
        for hostile in [
            "../inner/forge-judge-x",
            "x/../../inner",
            "/etc",
            "..",
            &format!("{RUN}/.."),
        ] {
            let refused = remove(&inner, hostile);
            assert!(
                matches!(refused, Removal::Refused(_)),
                "{hostile}: {refused:?}"
            );
            assert!(refused.said().unwrap().contains("no run id"), "{hostile}");
        }
        assert!(victim.join("keep.json").exists());
        assert!(planted.join("x.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_never_followed_out_of_the_root() {
        let r = Root::new("link");
        let outside = Root::new("outside");
        std::fs::write(outside.0.join("keep.json"), "{}").unwrap();
        // the run's directory itself a link out
        let at = r.0.join(format!("{PREFIX}{RUN}"));
        std::os::unix::fs::symlink(&outside.0, &at).unwrap();
        assert!(matches!(remove(&r.0, RUN), Removal::Removed(_)));
        assert!(std::fs::symlink_metadata(&at).is_err());
        assert!(outside.0.join("keep.json").exists());
        // a link inside the run's directory
        let d = r.plant(OTHER);
        std::os::unix::fs::symlink(&outside.0, d.join("out")).unwrap();
        assert!(matches!(remove(&r.0, OTHER), Removal::Removed(_)));
        assert!(!d.exists());
        assert!(outside.0.join("keep.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_removal_that_fails_names_the_path_and_the_error() {
        use std::os::unix::fs::PermissionsExt;
        let r = Root::new("fails");
        let d = r.plant(RUN);
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o500)).unwrap();
        if std::fs::write(d.join("probe"), "").is_ok() {
            // root ignores the mode, so there is no failure to plant here
            return;
        }
        let failed = remove(&r.0, RUN);
        let Removal::Failed { path, error } = &failed else {
            panic!("expected a failure, got {failed:?}");
        };
        assert_eq!(*path, d);
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        let line = failed.said().unwrap();
        assert!(line.contains(&d.display().to_string()), "{line}");
        assert!(line.contains("ermission denied"), "{line}");
        assert!(line.contains("the run is closed"), "{line}");
    }
}
