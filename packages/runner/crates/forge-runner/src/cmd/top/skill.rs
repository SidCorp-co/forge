//! Whether a master pane stands on the skill the running daemon ships.
//!
//! The daemon writes the skill directory `assets/skills/forge-master/` into a
//! checkout's `.claude/skills/forge-master/` byte for byte at bind, at provision,
//! at every start and at pane placement (`daemon/master_skill.rs`), first
//! adding `.claude/` to a checkout's exclude file where its git does not
//! ignore that path, and refusing one where that cannot be done;
//! `forge-runner status` reads what each write did. Its asset is an `include_str!`, so it sits verbatim in
//! the daemon's executable: the installed skill is that build's exactly when
//! every file it ships, `SKILL.md` and each file it sends the model to, is
//! there and its bytes occur in the executable. A copy that differs is one the
//! daemon refused or failed to write, or one a daemon older than ISS-1357
//! left behind.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::source::{mtime_ms, Read, Unreadable};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Skill {
    /// No file at the path: a checkout the daemon refused or failed to write.
    Absent {
        path: PathBuf,
    },
    Read {
        path: PathBuf,
        bytes: usize,
        /// When the file was written. `Err` names why that could not be
        /// read, which leaves the rewrite-after-start check undecided.
        written_ms: Read<i64>,
        /// Whether the bytes are the daemon binary's asset. `Err` where the
        /// daemon's executable could not be read, which says nothing either way.
        matches: Read<bool>,
    },
    Unreadable(Unreadable),
}

pub fn read(repo: &Path, daemon_exe: &Read<Arc<Vec<u8>>>) -> Skill {
    let path = forge_runner_core::daemon::master_skill::path_in(repo);
    let installed = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Skill::Absent { path },
        Err(e) => return Skill::Unreadable(Unreadable::new(path.display().to_string(), e)),
    };
    let written_ms = written(&path, std::fs::metadata(&path));
    let matches = if installed.is_empty() {
        Ok(false)
    } else {
        daemon_exe
            .as_ref()
            .map(|exe| {
                is_the_daemons(
                    exe,
                    &installed,
                    forge_runner_core::daemon::master_skill::ASSET.as_bytes(),
                )
            })
            .map_err(Clone::clone)
            .and_then(|entry| match entry {
                true => companions_match(repo, daemon_exe),
                false => Ok(false),
            })
    };
    Skill::Read {
        path,
        bytes: installed.len(),
        written_ms,
        matches,
    }
}

/// Whether every other file the skill ships is installed and is the daemon's:
/// one that is missing or differs is drift as much as an entry file that does.
fn companions_match(repo: &Path, daemon_exe: &Read<Arc<Vec<u8>>>) -> Read<bool> {
    let dir = forge_runner_core::daemon::master_skill::dir_in(repo);
    let exe = daemon_exe.as_ref().map_err(Clone::clone)?;
    for shipped in forge_runner_core::daemon::master_skill::FILES
        .iter()
        .filter(|f| f.path != "SKILL.md")
    {
        let path = shipped.path.split('/').fold(dir.clone(), |p, c| p.join(c));
        match std::fs::read(&path) {
            Ok(bytes) if !bytes.is_empty() && is_the_daemons(exe, &bytes, shipped.bytes) => {}
            Ok(_) => return Ok(false),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(Unreadable::new(path.display().to_string(), e)),
        }
    }
    Ok(true)
}

/// Whether `installed` is the daemon's copy of the file this build ships as
/// `shipped`. Where the daemon carries this build's file, the installed one is
/// that file exactly: bytes the daemon holds elsewhere, another shipped file's
/// among them, are not it. Where it does not, the daemon is another build, whose
/// copy this one cannot name, and the installed file is judged by whether it
/// occurs in the daemon's executable at all.
fn is_the_daemons(exe: &[u8], installed: &[u8], shipped: &[u8]) -> bool {
    if contains(exe, shipped) {
        installed == shipped
    } else {
        contains(exe, installed)
    }
}

/// When the file was written, or why that cannot be read — which is never
/// the same line as a write time the view could compare against the pane.
fn written(path: &Path, meta: std::io::Result<std::fs::Metadata>) -> Read<i64> {
    let at = |e: String| Unreadable::new(path.display().to_string(), e);
    let meta = meta.map_err(|e| at(e.to_string()))?;
    mtime_ms(&meta).ok_or_else(|| at("this platform gives no modification time".into()))
}

/// Whether `needle` occurs in `hay`, anchored on its first bytes so the common
/// case costs one pass of a byte comparison.
pub fn contains(hay: &[u8], needle: &[u8]) -> bool {
    if needle.len() > hay.len() {
        return false;
    }
    let head = &needle[..needle.len().min(32)];
    let last_start = hay.len() - needle.len();
    let mut from = 0;
    while from <= last_start {
        let Some(at) = hay[from..=last_start]
            .iter()
            .position(|b| *b == head[0])
            .map(|i| i + from)
        else {
            return false;
        };
        if hay[at..].starts_with(head) && hay[at..].starts_with(needle) {
            return true;
        }
        from = at + 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Consult whole-set F3: a file read whose write time will not come says
    /// UNREADABLE with the path, and the pane comparison is left undecided.
    #[test]
    fn a_write_time_that_cannot_be_read_is_unreadable_naming_the_file() {
        let p = Path::new("/r/.claude/skills/forge-master/SKILL.md");
        let e = written(p, Err(std::io::Error::other("permission denied"))).unwrap_err();
        assert_eq!(
            e.to_string(),
            "UNREADABLE — /r/.claude/skills/forge-master/SKILL.md: permission denied"
        );
        let here = std::fs::metadata(std::env::current_dir().unwrap());
        assert!(written(p, here).is_ok());
    }
    use forge_runner_core::test_scratch::Scratch;

    const ASSET: &str = forge_runner_core::daemon::master_skill::ASSET;

    /// A daemon executable carrying the entry file `asset` and every other file
    /// the skill ships, each as its own run of rodata.
    fn exe_holding(asset: &str) -> Read<Arc<Vec<u8>>> {
        let mut bytes = b"\x7fELF padding padding ---\n".to_vec();
        bytes.extend_from_slice(asset.as_bytes());
        bytes.extend_from_slice(b"\0more rodata\0");
        for f in forge_runner_core::daemon::master_skill::FILES
            .iter()
            .filter(|f| f.path != "SKILL.md")
        {
            bytes.extend_from_slice(f.bytes);
            bytes.extend_from_slice(b"\0more rodata\0");
        }
        Ok(Arc::new(bytes))
    }

    /// The whole shipped tree, with the entry file holding `text`.
    fn install(repo: &Path, text: &str) {
        use forge_runner_core::daemon::master_skill::{dir_in, path_in, FILES};
        for f in FILES.iter().filter(|f| f.path != "SKILL.md") {
            let at = f.path.split('/').fold(dir_in(repo), |p, c| p.join(c));
            std::fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::fs::write(at, f.bytes).unwrap();
        }
        let p = path_in(repo);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    /// Criterion 9, both answers.
    #[test]
    fn the_installed_skill_is_judged_against_the_daemon_binary() {
        let s = Scratch::new("top-skill");
        install(s.path(), ASSET);
        let Skill::Read { matches, bytes, .. } = read(s.path(), &exe_holding(ASSET)) else {
            panic!()
        };
        assert_eq!(matches, Ok(true));
        assert_eq!(bytes, ASSET.len());

        let older = ASSET.replace("forge-master", "forge-master-before");
        install(s.path(), &older);
        let Skill::Read { matches, .. } = read(s.path(), &exe_holding(ASSET)) else {
            panic!()
        };
        assert_eq!(
            matches,
            Ok(false),
            "a copy the daemon does not carry is drift"
        );
    }

    /// A file the skill sends the model to is part of the skill: one that is gone or
    /// differs from the daemon's is drift though the entry file is current.
    #[test]
    fn a_reference_file_that_is_gone_or_differs_is_drift_though_the_entry_file_is_current() {
        use forge_runner_core::daemon::master_skill::{dir_in, FILES};
        let s = Scratch::new("top-skill-reference");
        install(s.path(), ASSET);
        let reference = FILES.iter().find(|f| f.path != "SKILL.md").unwrap();
        let at = reference
            .path
            .split('/')
            .fold(dir_in(s.path()), |p, c| p.join(c));
        let judged = |repo: &Path| {
            let Skill::Read { matches, .. } = read(repo, &exe_holding(ASSET)) else {
                panic!()
            };
            matches
        };
        assert_eq!(judged(s.path()), Ok(true));

        std::fs::write(&at, "an older build's reference").unwrap();
        assert_eq!(judged(s.path()), Ok(false), "a reference that differs");

        // Bytes the daemon does carry, but not as this file: the entry file's own.
        std::fs::write(&at, ASSET).unwrap();
        assert_eq!(
            judged(s.path()),
            Ok(false),
            "a reference holding another shipped file's bytes"
        );

        std::fs::remove_file(&at).unwrap();
        assert_eq!(judged(s.path()), Ok(false), "a reference that is gone");
    }

    /// Criterion 22. An unreadable daemon file is carried as unreadable, not as
    /// a match or as drift.
    #[test]
    fn a_daemon_file_that_cannot_be_read_judges_nothing() {
        let s = Scratch::new("top-skill-noexe");
        install(s.path(), ASSET);
        let exe: Read<Arc<Vec<u8>>> = Err(Unreadable::new("/proc/9/exe", "permission denied"));
        let Skill::Read { matches, .. } = read(s.path(), &exe) else {
            panic!()
        };
        assert!(matches.is_err());
    }

    #[test]
    fn a_checkout_the_daemon_did_not_write_has_no_skill_file() {
        let s = Scratch::new("top-skill-absent");
        assert!(matches!(
            read(s.path(), &exe_holding(ASSET)),
            Skill::Absent { .. }
        ));
    }

    #[test]
    fn containment_finds_a_needle_at_every_position_and_nothing_else() {
        assert!(contains(b"abcdef", b"abc"));
        assert!(contains(b"abcdef", b"def"));
        assert!(contains(b"aaab", b"aab"));
        assert!(!contains(b"abcdef", b"abd"));
        assert!(!contains(b"ab", b"abc"));
    }
}
