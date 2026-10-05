//! The masters registry one image hands to the image its exec starts.
//!
//! A handover keeps the process and every pane, and loses everything the old
//! image held in memory. The registry of master panes is what a declaration is
//! checked against, so the new image refused every master's `run declare` with
//! "this box has not yet read which projects it serves" until its first sweep
//! refilled it: about five seconds where the websocket's catch-up swept, thirty
//! where it did not (ISS-1379, judge r2). The old image writes what it served
//! just before the exec, and the new one starts serving those panes at once.
//!
//! The file is believed only by the process that wrote it: the same pid in the
//! same boot, within [`FRESH_FOR`] of the write. An exec keeps the pid, so a
//! file naming another one is a leftover of some earlier process that never
//! reached its exec, and is removed unread.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const FILE: &str = "masters-handed.json";

/// How old a handed registry may be when the next image reads it. The exec
/// and the new image's start take well under a second; anything older is not
/// the registry of the moment the panes were last served.
pub const FRESH_FOR_MS: i64 = 120_000;

/// One master pane the old image served, as a declaration is checked against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandedMaster {
    pub project_id: String,
    pub session_id: String,
    pub pane: String,
}

/// What the old image wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handed {
    pub pid: u32,
    pub boot_id: Option<String>,
    pub written_at_ms: i64,
    /// The projects core last answered for this device, where it had.
    pub served: Option<Vec<String>>,
    pub masters: Vec<HandedMaster>,
}

/// What a starting image found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Taken {
    /// No registry was handed on: this image fills its own on its first sweep.
    Nothing,
    /// The registry the image before this one served.
    Handed(Handed),
    /// A file was there and is not this process's to believe, with why. It
    /// has been removed.
    Refused(String),
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

/// Write `handed` for the image the coming exec starts, beside and renamed
/// over so that image never reads half of it.
pub fn write(dir: &Path, handed: &Handed) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let body = serde_json::to_vec(handed).map_err(std::io::Error::other)?;
    let tmp = dir.join(format!("{FILE}.{}.tmp", handed.pid));
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path(dir))
}

/// Remove what [`write`] left, where the exec it was written for did not happen.
pub fn withdraw(dir: &Path) {
    let _ = std::fs::remove_file(path(dir));
}

/// Read and remove the registry handed to `pid` in `boot`, at `now_ms`.
pub fn take(dir: &Path, pid: u32, boot: Option<&str>, now_ms: i64) -> Taken {
    let at = path(dir);
    let text = match std::fs::read_to_string(&at) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Taken::Nothing,
        Err(e) => {
            let _ = std::fs::remove_file(&at);
            return Taken::Refused(format!("{} could not be read: {e}", at.display()));
        }
    };
    let _ = std::fs::remove_file(&at);
    let handed: Handed = match serde_json::from_str(&text) {
        Ok(h) => h,
        Err(e) => return Taken::Refused(format!("{} is not a handed registry: {e}", at.display())),
    };
    if handed.pid != pid {
        return Taken::Refused(format!(
            "{} was written by pid {}, and an exec keeps its pid, so it is no handover into this process (pid {pid})",
            at.display(),
            handed.pid
        ));
    }
    // Both named, and the same: a pid is reused across a reboot, so a boot
    // neither side can name proves nothing about which process wrote it.
    match (handed.boot_id.as_deref(), boot) {
        (Some(was), Some(now)) if was == now => {}
        (Some(_), Some(_)) => {
            return Taken::Refused(format!(
                "{} was written in another boot of this machine",
                at.display()
            ))
        }
        _ => {
            return Taken::Refused(format!(
                "{} names no boot both it and this process can read, and a pid alone is reused across a reboot",
                at.display()
            ))
        }
    }
    let age = now_ms.checked_sub(handed.written_at_ms);
    if let Some(age) = age.filter(|a| !(0..=FRESH_FOR_MS).contains(a)) {
        return Taken::Refused(format!(
            "{} was written {}s before this image read it, and a handover's exec takes under a second",
            at.display(),
            age / 1000
        ));
    }
    if age.is_none() {
        return Taken::Refused(format!(
            "{} names a write time no clock reading can be measured against",
            at.display()
        ));
    }
    Taken::Handed(handed)
}
