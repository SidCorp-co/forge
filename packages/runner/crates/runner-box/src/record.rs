//! A box's recording as evidence: where a span's mark lands on it, and the clip and opening still
//! cut from it at core's order (`box.recording.fetch`), on this device where ffmpeg is. Core chose
//! the span and the ceiling; a cut over the ceiling is said, never sent.
//!
//! The recording runs from the box's start. A warm box assigned to work restarts the evidence
//! there: its offsets count from the assignment, and the minutes before it are never cut.

use std::path::Path;
use std::time::{Duration, SystemTime};

use crate::act;

/// When the file began, and when the evidence did (the open, or the assignment of a warm box).
#[derive(Debug, Clone, Copy)]
pub struct Clock {
    pub file_start: SystemTime,
    pub evidence_start: SystemTime,
}

impl Clock {
    pub fn started_now() -> Self {
        let now = SystemTime::now();
        Self {
            file_start: now,
            evidence_start: now,
        }
    }

    /// The offset a mark made now lands at, from the evidence's start.
    pub fn mark_now(&self) -> u64 {
        SystemTime::now()
            .duration_since(self.evidence_start)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Where an evidence offset is in the file.
    pub fn in_file(&self, evidence_ms: u64) -> Duration {
        let shift = self
            .evidence_start
            .duration_since(self.file_start)
            .unwrap_or_default();
        shift + Duration::from_millis(evidence_ms)
    }
}

/// An ISO-8601 instant in UTC with milliseconds, as core reads one.
pub fn iso(t: SystemTime) -> String {
    let ms = t
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    jiff::Timestamp::from_millisecond(ms)
        .map(|ts| ts.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

pub struct Cut {
    pub clip: Vec<u8>,
    pub still: Vec<u8>,
}

/// The span `from..to` (evidence offsets) cut to an mp4 of at most `max_seconds` and `max_bytes`,
/// and its opening frame as a png. A cut over the byte ceiling is tried once more smaller.
pub async fn cut(
    ffmpeg: &Path,
    recording: &Path,
    clock: &Clock,
    (from_ms, to_ms): (u64, u64),
    (max_seconds, max_bytes): (u64, u64),
    work: &Path,
) -> Result<Cut, String> {
    if to_ms <= from_ms {
        return Err(format!(
            "the span ends at {to_ms} ms, before its start at {from_ms} ms"
        ));
    }
    if !recording.is_file() {
        return Err(format!(
            "the box's recording {} is gone",
            recording.display()
        ));
    }
    std::fs::create_dir_all(work).map_err(|e| format!("cannot make {}: {e}", work.display()))?;
    let start = clock.in_file(from_ms);
    let length = Duration::from_millis(to_ms - from_ms).min(Duration::from_secs(max_seconds));
    let (clip_path, still_path) = (work.join("clip.mp4"), work.join("still.png"));
    let mut clip = Vec::new();
    for (crf, scale) in [
        ("28", "scale='min(1280,iw)':-2"),
        ("36", "scale='min(720,iw)':-2"),
    ] {
        ffmpeg_run(
            ffmpeg,
            &[
                "-ss",
                &secs(start),
                "-i",
                &recording.to_string_lossy(),
                "-t",
                &secs(length),
                "-an",
                "-vf",
                scale,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                crf,
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                &clip_path.to_string_lossy(),
            ],
        )
        .await?;
        clip = std::fs::read(&clip_path).map_err(|e| format!("the cut clip: {e}"))?;
        if (clip.len() as u64) <= max_bytes {
            break;
        }
    }
    if clip.len() as u64 > max_bytes {
        return Err(format!(
            "the clip is {} bytes at its smallest, over the {max_bytes} the release page takes",
            clip.len()
        ));
    }
    ffmpeg_run(
        ffmpeg,
        &[
            "-ss",
            &secs(start),
            "-i",
            &recording.to_string_lossy(),
            "-frames:v",
            "1",
            &still_path.to_string_lossy(),
        ],
    )
    .await?;
    let still = std::fs::read(&still_path).map_err(|e| format!("the cut still: {e}"))?;
    Ok(Cut { clip, still })
}

fn secs(d: Duration) -> String {
    format!("{:.3}", d.as_secs_f64())
}

async fn ffmpeg_run(ffmpeg: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-y", "-nostdin", "-loglevel", "error"])
        .args(args)
        .kill_on_drop(true);
    let o = act::run(cmd, Duration::from_secs(180)).await;
    if o.exit_code == 0 {
        Ok(())
    } else {
        Err(format!(
            "ffmpeg exited {}: {}",
            o.exit_code,
            o.stderr.trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_warm_boxs_evidence_counts_from_its_assignment_not_its_file() {
        let file_start = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        let clock = Clock {
            file_start,
            evidence_start: file_start + Duration::from_secs(90),
        };
        assert_eq!(clock.in_file(2_500), Duration::from_millis(92_500));
        assert_eq!(iso(file_start), "1970-01-01T00:16:40.000Z");
    }
}
